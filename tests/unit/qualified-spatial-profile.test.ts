import { afterEach, describe, expect, it, vi } from 'vitest'
import { calibrationSchema } from '../../src/contracts/calibration'
import type { Calibration } from '../../src/contracts/calibration'
import { diagnosticJobSchema } from '../../src/contracts/inference'
import { profileSchema } from '../../src/contracts/model'
import { DICTIONARY_NODES } from '../../src/contracts/response-dictionary'
import type { FitEvidence } from '../../src/detection/hypotheses'
import { ANCHOR_IDS, MAX_CD_AREA_M2 } from '../../src/detection/optimizer'
import { annotateExactRegions } from '../../src/detection/profile'
import { calculateProfileExclusions, loadQualifiedSpatialEnvelope } from '../../src/detection/qualified-spatial-profile'
import { prefixResponseRange, prefixSurrogateLowerScore } from '../../src/detection/spatial-surrogate'
import { loadResponseDictionary, prepareResponse, unitResponse } from '../../src/detection/screening'
import type { ResponseTrace, ScreeningRow } from '../../src/detection/screening'
import { initialize } from '../../src/physics/initialize'
import { createNumericalMemoryLedger } from '../../src/runtime/numerical-memory'
import { loadReservedSpatialEnvelope } from '../../src/runtime/spatial-envelope-runtime'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { createCheckpointAnchor, makeCheckpoint } from '../../src/twin/checkpoint'
import { bankProfiles } from '../../src/twin/predict'

const hash = 'a'.repeat(64)
const anchorHashes = ANCHOR_IDS.map((id) => String(id).repeat(64))
const digest = async (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
const thresholds = { absoluteFit: 1, profile: 2 }
const trial = { candidate: { model: 'ML', anchorId: 8, node: 1, cdAreaM2: 2e-5, onsetUs: 4_000_000, openingUs: 0 }, score: 0.5 } as const

function calibration(dictionary: string): Calibration {
  const noise = { sigmaSI: 1, rho: 0 }
  return {
    schemaVersion: 1, calibrationId: hash, profileId: 'synthetic-oil-turbulent-v1', modelVersion: '1',
    bankVersion: '1', sensorProfileId: 'synthetic-oil-nominal-v1', releaseScope: 'passive',
    hashes: { profile: hash, model: hash, bank: hash, sensor: hash, policy: hash, dictionary,
      fit: hash, calibration: hash, development: hash },
    reportHash: hash, thresholds: { ...thresholds, cusumFast: 10, cusumSlow: 10, improvement: 1, separation: 1, envelope: 1 },
    noise: { P1: noise, P2: noise, P3: noise, Qin: noise },
    errorEnvelope: { qualified: true, multiplier: 1, numericalFloor: 0.2 },
    qualification: { quantitative: true, active: false },
  }
}

function manifest(cal: Calibration, hashes = anchorHashes) {
  return {
    schemaVersion: 1, controlFamily: 'steady-outlet', solver: 'typescript-f64',
    calibrationId: cal.calibrationId, hashes: cal.hashes, reportHash: cal.reportHash,
    coverage: { guardUs: 3_000_000, openingUs: [0, 1_000_000, 20_000_000], maximumCdAreaM2: 4e-5,
      windowUs: [4_000_000, 30_000_000], interiorCells: 199, cellWidthM: 5,
      steadyPressureTolerancePa: 1e-4, steadyFlowToleranceM3s: 1e-12, steadyTemperatureToleranceK: 1e-8 },
    anchorParameterHashes: hashes,
    discrepancyNorms: Array.from({ length: 9 * 199 }, (_, index) => index === 8 * 199 + 19 ? 20 : 0),
  }
}

async function qualified(cal: Calibration, body: ReturnType<typeof manifest>) {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const pinned = calibrationSchema.parse({
    ...cal, errorEnvelope: { ...cal.errorEnvelope, spatialArtifactSha256: await digest(bytes.buffer) },
  })
  return { bytes, pinned, envelope: await loadQualifiedSpatialEnvelope(bytes, pinned) }
}

const stepTrace = (node: number, values: readonly number[]): ResponseTrace => ({
  model: 'ML', anchorId: 0, node, stepResponse: Float64Array.from(values.flatMap((value) => [value, 0, 0, 0])),
})

afterEach(() => vi.unstubAllGlobals())

describe('qualified spatial exclusions', () => {
  it('bounds all sampled amplitudes, ramps and off-grid onsets from below under signed whitening', () => {
    const lower = stepTrace(1, [1000, -100_000, 60_000, 10_000])
    const upper = stepTrace(6, [-1200, 20_000, 80_000, -10_000])
    const lowerResponse = prepareResponse(lower)
    const upperResponse = prepareResponse(upper)
    const rows: readonly ScreeningRow[] = [
      { sensorId: 'P1', previousTimeUs: 5000, currentTimeUs: 15_000, rho: -0.3, scale: 2, residual: 7 },
      { sensorId: 'P1', previousTimeUs: 18_000, currentTimeUs: 28_000, rho: 0.85, scale: 1, residual: -6 },
    ]
    const fraction = 0.4
    const bound = prefixSurrogateLowerScore(prefixResponseRange(lower), prefixResponseRange(upper), fraction, rows, 4000)
    expect(bound).toBeGreaterThan(0)
    for (const onset of [4000, 5001, 9999, 15_000, 17_501, 28_000]) {
      for (const opening of [0, 1_000_000, 20_000_000]) {
        for (const amplitude of [0, 1e-6, 1.7e-5, MAX_CD_AREA_M2]) {
          const exact = rows.reduce((sum, row) => {
            const response = (time: number) => (1 - fraction) * unitResponse(lowerResponse, row.sensorId, time, onset, opening)
              + fraction * unitResponse(upperResponse, row.sensorId, time, onset, opening)
            const weight = (response(row.currentTimeUs) - row.rho * response(row.previousTimeUs)) / row.scale
            return sum + (row.residual - amplitude * weight) ** 2
          }, 0)
          expect(bound).toBeLessThanOrEqual(exact)
        }
      }
    }
  })

  it('requires a calibrated pin, exact artifact bytes, lineage and complete canonical coverage', async () => {
    const cal = calibration(hash)
    const body = manifest(cal)
    const { bytes, pinned, envelope } = await qualified(cal, body)
    expect(envelope).not.toBeNull()
    expect(await loadQualifiedSpatialEnvelope(bytes, cal)).toBeNull()
    expect(await loadQualifiedSpatialEnvelope(new Uint8Array([...bytes, 32]), pinned)).toBeNull()
    expect(await loadQualifiedSpatialEnvelope(bytes, { ...pinned, hashes: { ...pinned.hashes, development: 'b'.repeat(64) } })).toBeNull()
    expect((await qualified(cal, { ...body, discrepancyNorms: body.discrepancyNorms.slice(1) })).envelope).toBeNull()
    expect((await qualified(cal, { ...body, coverage: { ...body.coverage, windowUs: [4_000_000] } })).envelope).toBeNull()
  })

  it('reserves the bounded decoding workspace and holds only the numerical norms after loading', async () => {
    const cal = calibration(hash)
    const { bytes, pinned } = await qualified(cal, manifest(cal))
    vi.stubGlobal('location', new URL('http://127.0.0.1:1234'))
    const fetchAsset = vi.fn(async () => new Response(bytes))
    vi.stubGlobal('fetch', fetchAsset)
    const memory = createNumericalMemoryLedger('inference')
    expect(await loadReservedSpatialEnvelope(cal, memory)).toBeNull()
    expect(await loadReservedSpatialEnvelope(pinned, createNumericalMemoryLedger(1024))).toBeNull()
    expect(fetchAsset).not.toHaveBeenCalled()
    const asset = await loadReservedSpatialEnvelope(pinned, memory)
    expect(asset?.envelope.discrepancyNorms).toHaveLength(9 * 199)
    expect(memory.snapshot().reservedBytes).toBe(9 * 199 * Float64Array.BYTES_PER_ELEMENT)
    asset?.reservation.release()
    expect(memory.snapshot().reservedBytes).toBe(0)
  })

  it('requires every anchor to clear the cutoff and retains the exact compatible cell', async () => {
    const profiles = bankProfiles(profileSchema.parse(rawProfile))
    const anchors = await Promise.all(ANCHOR_IDS.map((id) => createCheckpointAnchor(id, profiles[id]!)))
    const checkpointHashes = anchors.map(({ parameterHash }) => parameterHash)
    const sampleCount = 701
    const traces = ANCHOR_IDS.flatMap((anchorId) => [
      ...DICTIONARY_NODES.map((node) => ({ model: 'ML', anchorId, node, sampleCount })),
      { model: 'MB', anchorId, sampleCount },
    ])
    const data = new Float64Array(traces.length * sampleCount * 4)
    const withdrawal = traces.findIndex((trace) => trace.anchorId === 8 && 'node' in trace && trace.node === 1)
    for (let sample = 0; sample < sampleCount; sample++) data[(withdrawal * sampleCount + sample) * 4] = 500_000
    const dataSha256 = await digest(data.buffer)
    const cal = calibration(dataSha256)
    const { pinned, envelope } = await qualified(cal, manifest(cal, checkpointHashes))
    const dictionary = await loadResponseDictionary({
      schemaVersion: 1, profileId: cal.profileId, modelVersion: cal.modelVersion, bankVersion: cal.bankVersion,
      anchorParameterHashes: checkpointHashes, samplePeriodUs: 10_000, dataSha256, traces,
    }, data.buffer, dataSha256, { prepareSpatialProfile: true })
    if (!envelope || !dictionary) throw new Error('Fixture qualification failed')
    expect(data.byteLength).toBe(0)
    const job = diagnosticJobSchema.parse({
      profileId: cal.profileId, modelVersion: cal.modelVersion, bankVersion: cal.bankVersion, calibrationId: cal.calibrationId,
      windowStartUs: 4_000_000, windowEndUs: 8_000_000, controlRevision: 0, appliedControls: [],
      jobId: '230dc176-69f8-47df-96b4-1a3d75d7c43e', requestedAtUs: 8_000_000, deliveredThroughUs: 8_000_000,
      searchBudget: { quantumEvaluations: 64, evaluationLimit: 512, wallLimitMs: 5000 }, observations: [],
      frozenBaselines: ANCHOR_IDS.map((anchorId) => ({ anchorId, meanResidualSI: { P1: 0, P2: 0, P3: 0, Qin: 0 } })),
      checkpointsByAnchor: anchors.map((anchor) => {
        const initial = initialize(anchor.definition)
        if (!initial.ok) throw initial.error
        return makeCheckpoint(initial.value, anchor)
      }),
    })
    const evidence: FitEvidence = { pairs: [{
      sensorId: 'P1', previousTimeUs: 4_000_000, currentTimeUs: 4_010_000, previousSI: 10, currentSI: 10,
      baselineSI: 0, innovationScaleSI: 1, rho: 0,
    }] }
    const nominal = new Map(ANCHOR_IDS.map((id) => [id, { evidence, prediction: () => 0 }]))
    const poll = async () => true
    const exclusions = await calculateProfileExclusions(job, dictionary, envelope, pinned, anchors, nominal, [trial], poll)
    expect(exclusions?.has(1)).toBe(false)
    expect(exclusions?.has(20)).toBe(false)
    expect(exclusions?.has(21)).toBe(true)
    const regions = annotateExactRegions(1000, 200, [trial], 1, thresholds, exclusions ?? undefined)
    expect(regions[0]).toEqual({ startM: 2.5, endM: 7.5, status: 'compatible' })
    expect(regions.some(({ startM, endM }) => startM <= 105 && endM >= 105)).toBe(false)
    expect(await calculateProfileExclusions({ ...job, controlRevision: 1 }, dictionary, envelope, pinned, anchors, nominal, [trial], poll)).toBeNull()
    expect(await calculateProfileExclusions(job, { ...dictionary }, envelope, pinned, anchors, nominal, [trial], poll)).toBeNull()
    expect(await calculateProfileExclusions(job, dictionary, envelope, pinned, anchors, nominal, [trial], async () => false)).toBeNull()
    const contradicted = { ...trial, candidate: { ...trial.candidate, node: 21 }, score: 10 } as const
    expect(await calculateProfileExclusions(job, dictionary, envelope, pinned, anchors, nominal, [trial, contradicted], poll)).toBeNull()
    const checkpoint = job.checkpointsByAnchor[0]!
    const unsteadyPressure = checkpoint.pressurePa.map((value, index) => value + (index === 50 ? 20 : 0))
    const unsteady = { ...job, checkpointsByAnchor: [{ ...checkpoint, pressurePa: unsteadyPressure }, ...job.checkpointsByAnchor.slice(1)] }
    expect(await calculateProfileExclusions(unsteady, dictionary, envelope, pinned, anchors, nominal, [trial], poll)).toBeNull()
    dictionary.traces[withdrawal]!.stepResponse.fill(0)
    expect(await calculateProfileExclusions(job, dictionary, envelope, pinned, anchors, nominal, [trial], poll)).toEqual(exclusions)
  })
})
