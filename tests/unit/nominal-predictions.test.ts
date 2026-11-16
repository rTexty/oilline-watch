import { describe, expect, it } from 'vitest'
import { NOMINAL_PREDICTION_CACHE_VERSION, nominalControlKey, nominalPredictionCacheBytes } from '../../src/contracts/nominal-predictions'
import type { NominalPredictionCache, NominalPredictionJobIdentity } from '../../src/contracts/nominal-predictions'
import type { AnchorId } from '../../src/contracts/model'
import { prepareNominalPredictionCache } from '../../src/detection/nominal-predictions'

const startUs = 4_010_000
const endUs = 8_010_000
const appliedControls = [{
  kind: 'outlet-flow', eventOrdinal: 0, commandId: '00000000-0000-4000-8000-000000000000',
  appliedTimeUs: 5_000_000, controlRevision: 1, valueSI: 0.025, rampUs: 0,
}] as const

function fixture() {
  const checkpointsByAnchor = Array.from({ length: 9 }, (_, index) => ({
    anchorId: index as AnchorId, timeUs: 1_000_000, controlRevision: 0, parameterHash: String(index).repeat(64),
  }))
  const identity = {
    modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1',
    windowStartUs: startUs, windowEndUs: endUs, controlRevision: 1, appliedControls, checkpointsByAnchor,
  } satisfies NominalPredictionJobIdentity
  const pressurePa = Float64Array.from({ length: 401 * 9 * 3 }, (_, index) => index)
  const inletFlowM3s = Float64Array.from({ length: 80 * 9 }, (_, index) => index / 100_000)
  const nominalPredictionCache: NominalPredictionCache = {
    version: NOMINAL_PREDICTION_CACHE_VERSION,
    modelVersion: identity.modelVersion, profileId: identity.profileId, bankVersion: identity.bankVersion,
    windowStartUs: startUs, windowEndUs: endUs, checkpointTimeUs: 1_000_000, checkpointControlRevision: 0,
    controlRevision: 1, controlKey: nominalControlKey(identity.appliedControls),
    parameterHashes: checkpointsByAnchor.map(({ parameterHash }) => parameterHash),
    pressurePa, inletFlowM3s,
  }
  return { ...identity, nominalPredictionCache }
}

describe('native nominal prediction cache', () => {
  it('looks up exact Float64 pressure and flow at their own clocks', () => {
    const job = fixture()
    const lookup = prepareNominalPredictionCache(job)?.(8)
    expect(lookup?.('P1', startUs)).toBe(24)
    expect(lookup?.('P3', endUs)).toBe(401 * 27 - 1)
    expect(lookup?.('Qin', startUs)).toBeUndefined()
    expect(lookup?.('Qin', 4_050_000)).toBe(8 / 100_000)
    expect(lookup?.('Qin', 8_000_000)).toBe((80 * 9 - 1) / 100_000)
    expect(lookup?.('P2', startUs + 1)).toBeUndefined()
    expect(lookup?.('P3', endUs + 10_000)).toBeUndefined()
    expect(nominalPredictionCacheBytes(job.nominalPredictionCache)).toBe(92_376)
  })

  it('fails closed for changed causal metadata or incomplete numerical buffers', () => {
    const job = fixture()
    const changedControl = [{ ...appliedControls[0], valueSI: 0.026 }]
    const changedAnchor = [...job.checkpointsByAnchor]
    changedAnchor[0] = { ...changedAnchor[0]!, parameterHash: 'a'.repeat(64) }
    expect(prepareNominalPredictionCache({ ...job, appliedControls: changedControl })).toBeNull()
    expect(prepareNominalPredictionCache({ ...job, checkpointsByAnchor: changedAnchor })).toBeNull()
    expect(prepareNominalPredictionCache({ ...job, controlRevision: 2 })).toBeNull()
    expect(prepareNominalPredictionCache({ ...job, windowEndUs: endUs + 10_000 })).toBeNull()
    const cache = job.nominalPredictionCache
    expect(prepareNominalPredictionCache({ ...job, nominalPredictionCache: {
      ...cache, pressurePa: cache.pressurePa.subarray(1),
    } })).toBeNull()
    const invalid = cache.inletFlowM3s.slice()
    invalid[1] = NaN
    expect(prepareNominalPredictionCache({ ...job, nominalPredictionCache: { ...cache, inletFlowM3s: invalid } })).toBeNull()
  })
})
