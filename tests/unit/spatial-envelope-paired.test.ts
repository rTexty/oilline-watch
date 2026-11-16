import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anchorIdSchema, profileSchema } from '../../src/contracts/model'
import type { AnchorId, FluidProfile } from '../../src/contracts/model'
import { PRESSURE_PERIOD_US } from '../../src/contracts/public'
import { DICTIONARY_CHANNELS, DICTIONARY_NODES, responseDictionaryManifestSchema } from '../../src/contracts/response-dictionary'
import type { ResponseDictionary } from '../../src/detection/screening'
import {
  ENVELOPE_DURATION_US, measureSpatialCell, measureSpatialCellForLayouts, prepareEnvelopeAnchor, spatialEnvelopeCases,
} from '../../src/detection/spatial-envelope'
import type { EnvelopeNoise } from '../../src/detection/spatial-envelope'
import { initialize } from '../../src/physics/initialize'
import type { LeakLaw } from '../../src/physics/leak'
import type { HydraulicInputs, HydraulicState, PhysicsResult } from '../../src/physics/state'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { bankProfiles } from '../../src/twin/predict'
import { assertPairedSpatialInputs, preparePairedSpatialOutputs } from '../../tools/calibration/spatial-envelope-pair'

const forecastCalls = vi.hoisted(() => ({ leakCases: [] as LeakLaw[] }))

vi.mock('../../src/physics/advance-to', () => ({
  advanceTo(state: HydraulicState, timeUs: number, inputs?: HydraulicInputs): PhysicsResult {
    if (inputs?.leak) forecastCalls.leakCases.push(inputs.leak)
    return { ok: true, value: { ...state, timeUs, inputs: inputs ?? state.inputs } }
  },
}))

vi.mock('../../src/twin/predict', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/twin/predict')>(),
  predict({ timeUs, inputs, profile }: HydraulicState, anchorId: AnchorId) {
    const leak = inputs.leak
    const fraction = leak ? Math.min(1, Math.max(0, timeUs - leak.onsetUs) / Math.max(1, leak.rampUs)) : 0
    const change = leak ? fraction * leak.cdA * (1 + timeUs / 33_000_000) : 0
    return {
      sampleTimeUs: timeUs, anchorId, bankVersion: '1', modelVersion: '1', profileId: profile.definition.profileId,
      pressurePa: [1.5e6 - 9e7 * change, 1.2e6 - 5e7 * change, 1e6 - 2e7 * change], inletFlowM3s: 0.03 + change,
    }
  },
}))

const nominalProfile = profileSchema.parse(rawProfile)
const adverseProfile = profileSchema.parse({ ...rawProfile, sensorProfileId: 'synthetic-oil-adverse-v1' })
const sampleCount = ENVELOPE_DURATION_US / PRESSURE_PERIOD_US + 1
const traces = Array.from({ length: 9 }, (_, index) => anchorIdSchema.parse(index)).flatMap((anchorId) => [
  ...DICTIONARY_NODES.map((node) => ({ model: 'ML' as const, anchorId, node, sampleCount })),
  { model: 'MB' as const, anchorId, sampleCount },
])
const manifest = responseDictionaryManifestSchema.parse({
  schemaVersion: 1, samplePeriodUs: PRESSURE_PERIOD_US, profileId: nominalProfile.profileId, modelVersion: '1', bankVersion: '1',
  anchorParameterHashes: Array(9).fill('a'.repeat(64)), dataSha256: 'c'.repeat(64), traces,
})

function initialStates(profile: FluidProfile) {
  return bankProfiles(profile).map((definition) => {
    const initialized = initialize(definition)
    if (!initialized.ok) throw initialized.error
    return initialized.value
  })
}

const nominal = { profile: nominalProfile, initialStates: initialStates(nominalProfile), manifest }
const adverse = {
  profile: adverseProfile, initialStates: initialStates(adverseProfile),
  manifest: { ...manifest, anchorParameterHashes: Array<string>(9).fill('b'.repeat(64)) },
}

const nominalNoise: EnvelopeNoise = {
  P1: { sigmaSI: 500, rho: 0.6 }, P2: { sigmaSI: 500, rho: 0.6 }, P3: { sigmaSI: 500, rho: 0.6 },
  Qin: { sigmaSI: 5e-5, rho: 0.3 },
}
const adverseNoise: EnvelopeNoise = {
  P1: { sigmaSI: 1000, rho: 0.85 }, P2: { sigmaSI: 1000, rho: 0.85 }, P3: { sigmaSI: 1000, rho: 0.85 },
  Qin: { sigmaSI: 1e-4, rho: 0.6 },
}

function preparedAnchor() {
  const dictionary: ResponseDictionary = {
    profileId: manifest.profileId, modelVersion: manifest.modelVersion, bankVersion: manifest.bankVersion,
    anchorParameterHashes: manifest.anchorParameterHashes,
    traces: DICTIONARY_NODES.map((node) => {
      const channels = [-(node + 1) * 1e6, -2e7, -3e7, 2]
      return { model: 'ML', anchorId: 0, node,
        stepResponse: Float64Array.from({ length: sampleCount * DICTIONARY_CHANNELS }, (_, index) => channels[index % DICTIONARY_CHANNELS]!) }
    }),
  }
  return prepareEnvelopeAnchor(nominal.initialStates[0]!, 0, dictionary)
}

describe('paired spatial envelope measurements', () => {
  it('shares one exact forecast per case and matches both separate noise calculations bit for bit', () => {
    const anchor = preparedAnchor()
    const before = forecastCalls.leakCases.length
    const paired = measureSpatialCellForLayouts(anchor, 2, [nominalNoise, adverseNoise])
    expect(forecastCalls.leakCases.slice(before)).toEqual(spatialEnvelopeCases(2).map(({ node, cdAreaM2, openingUs, onsetUs }) =>
      ({ node, cdA: cdAreaM2, rampUs: openingUs, onsetUs })))
    expect(paired).toHaveLength(2)
    expect(paired.map((values) => values.length)).toEqual([48, 48])
    expect(paired[0]).toEqual(measureSpatialCell(anchor, 2, nominalNoise))
    expect(paired[1]).toEqual(measureSpatialCell(anchor, 2, adverseNoise))
    expect(paired[0]).not.toEqual(paired[1])
    expect(paired.flat().every((value) => Number.isFinite(value) && value > 0)).toBe(true)
  })

  it('rejects an empty layout list without running any leak case', () => {
    const anchor = preparedAnchor()
    const before = forecastCalls.leakCases.length
    expect(() => measureSpatialCellForLayouts(anchor, 2, [])).toThrow()
    expect(forecastCalls.leakCases).toHaveLength(before)
  })
})

describe('paired spatial envelope inputs', () => {
  it('accepts opposite layouts in either order with their own anchor parameter digests', () => {
    expect(nominal.manifest.anchorParameterHashes).not.toEqual(adverse.manifest.anchorParameterHashes)
    expect(() => assertPairedSpatialInputs(nominal, adverse)).not.toThrow()
    expect(() => assertPairedSpatialInputs(adverse, nominal)).not.toThrow()
  })

  it('rejects same-layout profiles and a non-sensor profile difference', () => {
    expect(() => assertPairedSpatialInputs(nominal, nominal)).toThrow(/sensor|layout/i)
    const profile = { ...adverse.profile, geometry: { ...adverse.profile.geometry, roughnessM: adverse.profile.geometry.roughnessM * 1.01 } }
    expect(() => assertPairedSpatialInputs(nominal, { ...adverse, profile })).toThrow(/profile/i)
  })

  it('requires matching order and full hydraulic state across all nine anchors', () => {
    for (const initialStates of [adverse.initialStates.slice(1), adverse.initialStates.toReversed()]) {
      expect(() => assertPairedSpatialInputs(nominal, { ...adverse, initialStates })).toThrow(/state|anchor/i)
    }
    const last = adverse.initialStates.at(-1)!
    const changed = { ...last, p: Float64Array.from(last.p, (value, index) => index === 0 ? value + 1 : value) }
    expect(() => assertPairedSpatialInputs(nominal, { ...adverse, initialStates: [...adverse.initialStates.slice(0, -1), changed] }))
      .toThrow(/state|anchor/i)
  })

  it('requires identical dictionary data digests and ordered trace descriptors', () => {
    const differentData = { ...adverse.manifest, dataSha256: 'd'.repeat(64) }
    const reordered = { ...adverse.manifest, traces: adverse.manifest.traces.toReversed() }
    for (const manifest of [differentData, reordered]) {
      expect(() => assertPairedSpatialInputs(nominal, { ...adverse, manifest })).toThrow(/dictionary/i)
    }
  })
})

describe('paired spatial envelope output paths', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'spatial-paired-out-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('creates independent cell directories and returns canonical output paths', async () => {
    const left = join(root, 'nominal')
    const right = join(root, 'adverse')
    const outputs = await preparePairedSpatialOutputs(left, right)
    expect(outputs).toEqual(await Promise.all([realpath(left), realpath(right)]))
    const cells = await Promise.all(outputs.map((path) => stat(join(path, 'cells'))))
    expect(cells.every((entry) => entry.isDirectory())).toBe(true)
  })

  it('rejects identical and nested destinations', async () => {
    const left = join(root, 'nominal')
    await expect(preparePairedSpatialOutputs(left, left)).rejects.toThrow(/distinct|disjoint/i)
    await expect(preparePairedSpatialOutputs(left, join(left, 'nested'))).rejects.toThrow(/distinct|disjoint/i)
  })

  it.skipIf(process.platform === 'win32')('rejects different paths that resolve to the same output directory', async () => {
    const left = join(root, 'nominal')
    const alias = join(root, 'adverse')
    await mkdir(left)
    await symlink(left, alias, 'dir')
    await expect(preparePairedSpatialOutputs(left, alias)).rejects.toThrow(/distinct|disjoint|same location/i)
  })

  it.skipIf(process.platform === 'win32')('rejects disjoint outputs whose cell directories alias each other', async () => {
    const left = join(root, 'nominal')
    const right = join(root, 'adverse')
    await Promise.all([mkdir(left), mkdir(join(right, 'cells'), { recursive: true })])
    await symlink(join(right, 'cells'), join(left, 'cells'), 'dir')
    await expect(preparePairedSpatialOutputs(left, right)).rejects.toThrow(/cells.*alias/i)
  })
})
