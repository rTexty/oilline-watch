import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import type { AnchorId } from '../../src/contracts/model'
import type { AppliedControl } from '../../src/contracts/public'
import { rebuildActiveCheckpointPairs } from '../../src/detection/active-checkpoints'
import type { FineCheckpointResume } from '../../src/detection/active-checkpoints'
import { advanceTo } from '../../src/physics/advance-to'
import { initialize } from '../../src/physics/initialize'
import profileJson from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { createCheckpointAnchor, makeCheckpoint } from '../../src/twin/checkpoint'
import { bankProfiles } from '../../src/twin/predict'

const profile = profileSchema.parse(profileJson)
const coarse = bankProfiles(profile)
const fine = bankProfiles({ ...profile, grid: { segments: 400, nominalStepUs: 2500 } })
const flow = profile.initialPublicControls.outletFlowM3s * 0.98
const eventUs = profile.warmupUs + 5_000
const command: AppliedControl = {
  kind: 'outlet-flow', eventOrdinal: 9, commandId: '230dc176-69f8-47df-96b4-1a3d75d7c440',
  appliedTimeUs: eventUs, controlRevision: 1, valueSI: flow, rampUs: 0,
}

async function checkpoint(definitions: typeof coarse, id: AnchorId, timeUs: number, controls: readonly AppliedControl[] = [], perturb = false) {
  const anchor = await createCheckpointAnchor(id, definitions[id]!)
  const initial = initialize(anchor.definition)
  if (!initial.ok) throw initial.error
  let state = initial.value
  while (state.timeUs < timeUs) {
    const deadline = Math.min(timeUs, (Math.floor(state.timeUs / 10_000) + 1) * 10_000)
    const applied = controls.flatMap((event) => event.kind === 'outlet-flow'
      && event.appliedTimeUs > state.timeUs && event.appliedTimeUs <= deadline
      ? [{ timeUs: event.appliedTimeUs, inputs: { qoutM3s: event.valueSI } }] : [])
    const advanced = advanceTo(state, deadline, undefined, applied)
    if (!advanced.ok) throw advanced.error
    state = advanced.value
  }
  const p = state.p.slice()
  if (perturb) p[100] = p[100]! + 300
  return makeCheckpoint({ ...state, p }, anchor, controls.length)
}

describe('independent public fine checkpoints', () => {
  it('rebuilds from zero at exact N200 clock for a nonnominal anchor without reading coarse fields', async () => {
    const target = await checkpoint(coarse, 1, 37_000, [], true)
    const expected = await checkpoint(fine, 1, 37_000)
    const result = await rebuildActiveCheckpointPairs({ profile, coarseCheckpoints: [target], appliedControls: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.checkpointPairs[0]?.grid400).toEqual(expected)
    expect(result.checkpointPairs[0]?.grid200.pressurePa).toEqual(target.pressurePa)
    expect(result.checkpointPairs[0]?.grid200.pressurePa).not.toBe(target.pressurePa)
    expect(result.checkpointPairs[0]?.grid400.pressurePa[200]).not.toBe(target.pressurePa[100])
    expect(result.forwardSteps).toBeGreaterThan(14)
  })

  it('resumes a native fine checkpoint and installs a coincident control without recomputing pressure or flux', async () => {
    const [prior, target, unchanged] = await Promise.all([
      checkpoint(coarse, 0, profile.warmupUs),
      checkpoint(coarse, 0, eventUs, [command]),
      checkpoint(fine, 0, eventUs),
    ])
    const native = await rebuildActiveCheckpointPairs({ profile, coarseCheckpoints: [prior], appliedControls: [] })
    if (!native.ok) throw new Error(native.reason)
    const result = await rebuildActiveCheckpointPairs({
      profile, coarseCheckpoints: [target], earlierFineCheckpoints: native.fineCheckpointCache, appliedControls: [command],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const grid400 = result.checkpointPairs[0]!.grid400
    expect(result.forwardSteps).toBe(2)
    expect(grid400).toMatchObject({ timeUs: eventUs, eventCursor: 1, controlRevision: 1, boundaries: { qoutM3s: flow } })
    expect(grid400.pressurePa).toEqual(unchanged.pressurePa)
    expect(grid400.rightFlowM3s).toEqual(unchanged.rightFlowM3s)

    const fromZero = await rebuildActiveCheckpointPairs({ profile, coarseCheckpoints: [target], appliedControls: [command] })
    expect(fromZero).toMatchObject({ ok: true, checkpointPairs: [{ grid400 }] })
    if (fromZero.ok) expect(fromZero.forwardSteps).toBe(12_002)
    expect(await rebuildActiveCheckpointPairs({ profile, coarseCheckpoints: [target], appliedControls: [] }))
      .toEqual({ ok: false, reason: 'control-history' })
    expect(await rebuildActiveCheckpointPairs({
      profile, coarseCheckpoints: [target], earlierFineCheckpoints: native.fineCheckpointCache,
      appliedControls: [{ ...command, rampUs: 1_000_000 }],
    })).toEqual({ ok: false, reason: 'unsupported-control' })
  }, 60_000)

  it('bounds work, cancels after a cooperative yield, and rejects an earlier checkpoint for the wrong grid', async () => {
    const target = await checkpoint(coarse, 0, 400_000)
    const request = { profile, coarseCheckpoints: [target], appliedControls: [] }
    expect(await rebuildActiveCheckpointPairs(request, { maxForwardSteps: 1 }))
      .toEqual({ ok: false, reason: 'resource-limit' })
    let cancelled = false
    expect(await rebuildActiveCheckpointPairs(request, {
      shouldCancel: () => cancelled, yieldTask: () => { cancelled = true; return Promise.resolve() },
    })).toEqual({ ok: false, reason: 'cancelled' })
    expect(await rebuildActiveCheckpointPairs({
      ...request, earlierFineCheckpoints: [target as unknown as FineCheckpointResume],
    }))
      .toEqual({ ok: false, reason: 'checkpoint-mismatch' })
  })

  it('ignores later public laws without tolerating reordered or duplicate controls', async () => {
    const target = await checkpoint(coarse, 0, 10_000)
    const request = { profile, coarseCheckpoints: [target] }
    const future = { ...command, rampUs: 1_000_000 }
    expect(await rebuildActiveCheckpointPairs({ ...request, appliedControls: [future] }))
      .toEqual(await rebuildActiveCheckpointPairs({ ...request, appliedControls: [] }))
    expect(await rebuildActiveCheckpointPairs({ ...request, appliedControls: [future, future] }))
      .toEqual({ ok: false, reason: 'control-history' })
  })

  it('rejects a resume state built from a different public prefix with the same cursor and final outlet flow', async () => {
    const second: AppliedControl = {
      ...command, eventOrdinal: 10, commandId: '230dc176-69f8-47df-96b4-1a3d75d7c441', controlRevision: 2,
      appliedTimeUs: eventUs + 5000, valueSI: profile.initialPublicControls.outletFlowM3s,
    }
    const original = [command, second]
    const other = [{ ...command, valueSI: profile.initialPublicControls.outletFlowM3s * 1.02 }, second]
    const [target, prior] = await Promise.all([
      checkpoint(coarse, 0, eventUs + 20_000, original),
      checkpoint(coarse, 0, eventUs + 5000, other),
    ])
    const native = await rebuildActiveCheckpointPairs({ profile, coarseCheckpoints: [prior], appliedControls: other })
    if (!native.ok) throw new Error(native.reason)
    expect(await rebuildActiveCheckpointPairs({
      profile, coarseCheckpoints: [target], appliedControls: original, earlierFineCheckpoints: native.fineCheckpointCache,
    })).toEqual({ ok: false, reason: 'control-history' })
  }, 60_000)

  it('refuses a partial solver boundary for continuation but can reuse it as the final target', async () => {
    const [prior, target] = await Promise.all([checkpoint(coarse, 1, 23_000), checkpoint(coarse, 1, 40_000)])
    const native = await rebuildActiveCheckpointPairs({ profile, coarseCheckpoints: [prior], appliedControls: [] })
    if (!native.ok) throw new Error(native.reason)
    const request = { profile, appliedControls: [], earlierFineCheckpoints: native.fineCheckpointCache }
    expect(await rebuildActiveCheckpointPairs({ ...request, coarseCheckpoints: [target] }))
      .toEqual({ ok: false, reason: 'checkpoint-mismatch' })
    expect(await rebuildActiveCheckpointPairs({ ...request, coarseCheckpoints: [prior] }))
      .toMatchObject({ ok: true, checkpointPairs: native.checkpointPairs, forwardSteps: 0 })
  })
})
