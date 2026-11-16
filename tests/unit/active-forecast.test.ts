import { describe, expect, it } from 'vitest'
import { calibrationSchema } from '../../src/contracts/calibration'
import { profileSchema } from '../../src/contracts/model'
import { rebuildActiveCheckpointPairs } from '../../src/detection/active-checkpoints'
import { evaluateActiveForecast, hashActiveCheckpointPair } from '../../src/detection/active-forecast'
import type { ActiveForecastInput } from '../../src/detection/active-forecast'
import { initialExperimentState, proposeExperiment } from '../../src/detection/active-experiment'
import type { ExperimentContext } from '../../src/detection/active-experiment'
import { initialize } from '../../src/physics/initialize'
import profileJson from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { createCheckpointAnchor, makeCheckpoint } from '../../src/twin/checkpoint'

const profile = profileSchema.parse(profileJson)
const timeUs = 30_000_000
const nominalFlow = profile.initialPublicControls.outletFlowM3s
const hash = 'a'.repeat(64)
const proposalId = '230dc176-69f8-47df-96b4-1a3d75d7c440'
const calibration = calibrationSchema.parse({
  schemaVersion: 1, calibrationId: hash, modelVersion: '1', profileId: profile.profileId,
  bankVersion: '1', sensorProfileId: profile.sensorProfileId,
  hashes: Object.fromEntries(['model', 'profile', 'bank', 'sensor', 'policy', 'dictionary',
    'fit', 'calibration', 'development'].map((name) => [name, hash])),
  releaseScope: 'full',
  noise: { P1: { sigmaSI: 2000, rho: 0.2 }, P2: { sigmaSI: 2000, rho: 0.2 },
    P3: { sigmaSI: 2000, rho: 0.2 }, Qin: { sigmaSI: 0.0001, rho: 0.1 } },
  thresholds: { cusumFast: 3, cusumSlow: 3, improvement: 1, separation: 1, absoluteFit: 1, profile: 1, envelope: 1 },
  errorEnvelope: { numericalFloor: 1, multiplier: 1, qualified: true },
  qualification: { quantitative: true, active: true }, reportHash: hash,
})

async function fixture(unsafe = false): Promise<{ context: ExperimentContext; input: ActiveForecastInput }> {
  const grid400 = { ...profile, grid: { segments: 400, nominalStepUs: 2500 } }
  const checkpointAt = async (definition: typeof profile) => {
    const initial = initialize(definition)
    if (!initial.ok) throw initial.error
    const anchor = await createCheckpointAnchor(0, definition)
    // The steady fixture starts on an exact acoustic/thermal boundary.
    const pressure = initial.value.p.slice()
    if (unsafe) pressure[1] = 250_500
    return makeCheckpoint({ ...initial.value, p: pressure, timeUs, lastThermalTimeUs: timeUs }, anchor)
  }
  const pair = { anchorId: 0 as const, grid200: await checkpointAt(profile), grid400: await checkpointAt(grid400) }
  const checkpointHash = await hashActiveCheckpointPair(pair)
  const context: ExperimentContext = {
    calibration, runId: '230dc176-69f8-47df-96b4-1a3d75d7c43e', profileId: profile.profileId,
    sensorProfileId: calibration.sensorProfileId, modelVersion: profile.modelVersion, bankVersion: '1',
    timeUs, horizonUs: profile.horizonUs, controlRevision: 0, phase: 'running', inPhysicalDomain: true,
    pendingDisturbance: false, nominalOutletFlowM3s: nominalFlow, outletFlowM3s: nominalFlow,
    pulseHash: hash, forecast: null,
    evidence: {
      jobId: '230dc176-69f8-47df-96b4-1a3d75d7c43f', sourceSampleSeq: 3000, evidenceEndUs: timeUs,
      searchComplete: true, assessment: 'ambiguous', unresolved: false,
      sensorsAvailable: { P1: true, P2: true, P3: true, Qin: true },
      candidates: [{ id: 4, cause: 'MB', checkpointHash, closures: ['qs'] },
        { id: 6, cause: 'MS', checkpointHash, closures: ['qs'] }],
    },
  }
  const input: ActiveForecastInput = {
    profile, checkpointPairs: [pair], publicControlsAfterCheckpoint: [],
    cells: (['lower', 'upper'] as const).flatMap((boundary) => [
      { candidateId: 4, boundary, anchorId: 0 as const,
        hypothesis: { cause: 'MB' as const, amplitudeM3s: boundary === 'lower' ? -1e-7 : 1e-7,
          onsetUs: timeUs, openingUs: 0 as const } },
      { candidateId: 6, boundary, anchorId: 0 as const,
        hypothesis: { cause: 'MS' as const, sensorId: 'P2' as const, biasSI: boundary === 'lower' ? 2500 : 2700,
          onsetUs: timeUs, openingUs: 0 as const } },
    ]),
  }
  return { context, input }
}

describe('active forecast numerical evidence', () => {
  it('measures both grids and cell endpoints, preserving inputs and withholding empirical qualification', async () => {
    const { context, input } = await fixture()
    const rebuilt = await rebuildActiveCheckpointPairs({
      profile, coarseCheckpoints: [input.checkpointPairs[0]!.grid200], appliedControls: [],
    })
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) throw new Error(rebuilt.reason)
    const pair = rebuilt.checkpointPairs[0]!
    const before = await hashActiveCheckpointPair(pair)
    const evidence = { ...context.evidence!,
      candidates: context.evidence!.candidates.map((item) => ({ ...item, checkpointHash: before })) }
    const admitted = { ...context, evidence }
    const admittedRunId = context.runId
    const result = await evaluateActiveForecast(admitted, { ...input, checkpointPairs: rebuilt.checkpointPairs }, {
      yieldTask: () => {
        Object.assign(admitted, { runId: proposalId, controlRevision: 7 })
        return Promise.resolve()
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.forecast).toMatchObject({
      firstStartUs: timeUs + 5000, lastStartUs: timeUs + 5000, qualifiedThroughUs: timeUs + 4_005_000,
      empiricalQualification: false, runId: admittedRunId, controlRevision: 0,
    })
    expect(result.forecast.cells).toHaveLength(4)
    expect(result.forecast.passiveSeparationRms).toBeGreaterThan(0)
    expect(Number.isFinite(result.forecast.activeSeparationRms)).toBe(true)
    for (const cell of result.forecast.cells) {
      expect(cell.grid200.maximumOutletFlowRatio).toBeGreaterThan(1)
      expect(cell.grid400.minimumRe).toBeGreaterThan(4050)
      expect(cell.maxPressureDifferencePa).toBeLessThanOrEqual(500)
    }
    expect(await hashActiveCheckpointPair(pair)).toBe(before)
    expect(proposeExperiment(initialExperimentState(), {
      ...context, evidence, forecast: result.forecast,
    }, proposalId))
      .toEqual({ ok: false, reason: 'unverified-envelope' })
  }, 60_000)

  it('refuses absent endpoints, a second closure without public checkpoints, and a substituted checkpoint pair', async () => {
    const { context, input } = await fixture()
    expect(await evaluateActiveForecast(context, { ...input, cells: input.cells.slice(1) }))
      .toEqual({ ok: false, reason: 'incomplete-cells' })
    expect(await evaluateActiveForecast({ ...context, evidence: { ...context.evidence!,
      candidates: [{ ...context.evidence!.candidates[0]!, closures: ['qs', 'vardy-brown'] }, context.evidence!.candidates[1]!],
    } }, input)).toEqual({ ok: false, reason: 'unsupported-closure' })
    const pair = input.checkpointPairs[0]!
    const pressure = pair.grid400.pressurePa.slice()
    pressure[1] = pressure[1]! + 1
    expect(await evaluateActiveForecast(context, { ...input, checkpointPairs: [
      { ...pair, grid400: { ...pair.grid400, pressurePa: pressure } },
    ] })).toEqual({ ok: false, reason: 'checkpoint-mismatch' })
  })

  it('rejects unsafe pressure and respects cancellation and shared step limits', async () => {
    const unsafe = await fixture(true)
    expect(await evaluateActiveForecast(unsafe.context, unsafe.input)).toEqual({ ok: false, reason: 'physical-guard' })
    const { context, input } = await fixture()
    expect(await evaluateActiveForecast(context, input, { shouldCancel: () => true })).toEqual({ ok: false, reason: 'cancelled' })
    expect(await evaluateActiveForecast(context, input, { maxForwardSteps: 1 })).toEqual({ ok: false, reason: 'resource-limit' })
  })

  it('refuses a sharp step that exceeds the full-grid refinement budget', async () => {
    const { context, input } = await fixture()
    const cells = input.cells.map((cell) => cell.hypothesis.cause === 'MB'
      ? { ...cell, hypothesis: { ...cell.hypothesis, amplitudeM3s: 0.04 * nominalFlow } }
      : cell)
    expect(await evaluateActiveForecast(context, { ...input, cells })).toEqual({ ok: false, reason: 'refinement-budget' })
  })

  it('detects refinement error on fine nodes between coarse grid nodes', async () => {
    const { context, input } = await fixture()
    const pair = input.checkpointPairs[0]!
    const pressurePa = pair.grid400.pressurePa.slice()
    pressurePa[1] = pressurePa[1]! + 1000
    const offset = { ...pair, grid400: { ...pair.grid400, pressurePa } }
    const checkpointHash = await hashActiveCheckpointPair(offset)
    const evidence = { ...context.evidence!,
      candidates: context.evidence!.candidates.map((item) => ({ ...item, checkpointHash })) }
    expect(await evaluateActiveForecast({ ...context, evidence }, { ...input, checkpointPairs: [offset] }))
      .toEqual({ ok: false, reason: 'refinement-budget' })
  })

  it('rejects cancellation during a cooperative yield', async () => {
    const { context, input } = await fixture()
    let cancelled = false
    expect(await evaluateActiveForecast(context, input, {
      shouldCancel: () => cancelled, yieldTask: () => { cancelled = true; return Promise.resolve() },
    })).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('refuses candidates beyond the evidence clock and changed public controls', async () => {
    const { context, input } = await fixture()
    const cell = input.cells[0]!
    const future = { ...cell, hypothesis: { ...cell.hypothesis, onsetUs: timeUs + 10_000 } }
    expect(await evaluateActiveForecast({ ...context, timeUs: timeUs + 20_000 }, {
      ...input, cells: [future, ...input.cells.slice(1)],
    })).toEqual({ ok: false, reason: 'invalid-input' })
    expect(await evaluateActiveForecast(context, { ...input, publicControlsAfterCheckpoint: [{
      kind: 'outlet-flow', eventOrdinal: 1, commandId: proposalId, appliedTimeUs: timeUs,
      controlRevision: 1, valueSI: nominalFlow, rampUs: 0,
    }] })).toEqual({ ok: false, reason: 'unsupported-controls' })
  })

  it('refuses to continue a paired checkpoint at an artificial partial-step boundary', async () => {
    const { context, input } = await fixture()
    const pair = input.checkpointPairs[0]!
    const shift = 1000
    const partial = (checkpoint: typeof pair.grid200) => ({
      ...checkpoint, timeUs: timeUs + shift, thermalFlow: { ...checkpoint.thermalFlow, elapsedUs: shift },
    })
    const offset = { ...pair, grid200: partial(pair.grid200), grid400: partial(pair.grid400) }
    const checkpointHash = await hashActiveCheckpointPair(offset)
    const evidence = { ...context.evidence!,
      candidates: context.evidence!.candidates.map((item) => ({ ...item, checkpointHash })) }
    expect(await evaluateActiveForecast({ ...context, evidence, timeUs: timeUs + shift }, {
      ...input, checkpointPairs: [offset],
    })).toEqual({ ok: false, reason: 'checkpoint-mismatch' })
  })
})
