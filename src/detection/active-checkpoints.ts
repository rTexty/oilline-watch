import { predictionCheckpointSchema } from '../contracts/inference'
import type { PublicPredictionCheckpoint } from '../contracts/inference'
import { profileSchema } from '../contracts/model'
import type { AnchorId, FluidProfile } from '../contracts/model'
import { appliedControlSchema, PRESSURE_PERIOD_US } from '../contracts/public'
import type { AppliedControl } from '../contracts/public'
import { advanceTo } from '../physics/advance-to'
import { PhysicsDomainError } from '../physics/guards'
import { initialize } from '../physics/initialize'
import { step } from '../physics/moc'
import type { HydraulicState } from '../physics/state'
import { createCheckpointAnchor, makeCheckpoint, restoreCheckpoint } from '../twin/checkpoint'
import type { CheckpointAnchor } from '../twin/checkpoint'
import { bankProfiles } from '../twin/predict'

const MAX_CONTROLS = 128
const MAX_FORWARD_STEPS = 2_000_000
const YIELD_STEPS = 128

export interface ActiveCheckpointPair {
  readonly anchorId: AnchorId
  readonly grid200: PublicPredictionCheckpoint
  readonly grid400: PublicPredictionCheckpoint
}

declare const fineResumeBrand: unique symbol

/** Local resume handle for a checkpoint reconstructed by this provider. */
export interface FineCheckpointResume {
  readonly [fineResumeBrand]: true
}

interface ResumeRecord {
  readonly checkpoint: PublicPredictionCheckpoint
  readonly controlPrefix: string
}

const resumeRecords = new WeakMap<FineCheckpointResume, ResumeRecord>()

interface RebuildRequest {
  readonly profile: FluidProfile
  readonly coarseCheckpoints: readonly PublicPredictionCheckpoint[]
  readonly appliedControls: readonly AppliedControl[]
  readonly earlierFineCheckpoints?: readonly FineCheckpointResume[]
}

interface RebuildOptions {
  readonly maxForwardSteps?: number
  readonly shouldCancel?: () => boolean
  readonly yieldTask?: () => Promise<void>
}

type RebuildFailure = 'invalid-input' | 'checkpoint-mismatch' | 'control-history' | 'unsupported-control'
  | 'invalid-model' | 'cancelled' | 'resource-limit'

type RebuildResult =
  | {
    readonly ok: true
    readonly checkpointPairs: readonly ActiveCheckpointPair[]
    readonly fineCheckpointCache: readonly FineCheckpointResume[]
    readonly forwardSteps: number
  }
  | { readonly ok: false; readonly reason: RebuildFailure }

export function copyActiveCheckpoint(raw: PublicPredictionCheckpoint): PublicPredictionCheckpoint | null {
  const parsed = predictionCheckpointSchema.safeParse(raw)
  if (!parsed.success || parsed.data.memory.kind !== 'none') return null
  const checkpoint = parsed.data
  const flow = checkpoint.thermalFlow
  return {
    ...checkpoint,
    pressurePa: checkpoint.pressurePa.slice(),
    leftFlowM3s: checkpoint.leftFlowM3s.slice(),
    rightFlowM3s: checkpoint.rightFlowM3s.slice(),
    oilTemperatureK: checkpoint.oilTemperatureK.slice(),
    wallTemperatureK: checkpoint.wallTemperatureK.slice(),
    thermalFlow: {
      elapsedUs: flow.elapsedUs, leftPositiveM3: flow.leftPositiveM3.slice(), leftNegativeM3: flow.leftNegativeM3.slice(),
      rightPositiveM3: flow.rightPositiveM3.slice(), rightNegativeM3: flow.rightNegativeM3.slice(),
    },
  }
}

export function activeFineBankProfiles(profile: FluidProfile): readonly FluidProfile[] {
  return bankProfiles({ ...profile, grid: { segments: 400, nominalStepUs: 2500 } })
}

function checkpointMap(input: readonly PublicPredictionCheckpoint[]): ReadonlyMap<AnchorId, PublicPredictionCheckpoint> | null {
  if (input.length > 9) return null
  const result = new Map<AnchorId, PublicPredictionCheckpoint>()
  for (const raw of input) {
    const checkpoint = copyActiveCheckpoint(raw)
    if (!checkpoint || checkpoint.grid.cellCount !== 200 || result.has(checkpoint.anchorId)) return null
    result.set(checkpoint.anchorId, checkpoint)
  }
  return result
}

function resumeMap(input: readonly FineCheckpointResume[]): ReadonlyMap<AnchorId, ResumeRecord> | null {
  if (input.length > 9) return null
  const result = new Map<AnchorId, ResumeRecord>()
  for (const handle of input) {
    const record = resumeRecords.get(handle)
    if (!record || result.has(record.checkpoint.anchorId)) return null
    result.set(record.checkpoint.anchorId, record)
  }
  return result
}

type StepControl = Extract<AppliedControl, { kind: 'outlet-flow' }>

function readControls(
  input: readonly AppliedControl[], profile: FluidProfile, cutoffUs: number,
): readonly StepControl[] | 'control-history' | 'unsupported-control' {
  if (input.length > MAX_CONTROLS) return 'control-history'
  const output: StepControl[] = []
  const ids = new Set<string>()
  const nominal = profile.initialPublicControls.outletFlowM3s
  let prior: AppliedControl | undefined
  for (const raw of input) {
    const parsed = appliedControlSchema.safeParse(raw)
    if (!parsed.success) return 'control-history'
    const control = parsed.data
    if (ids.has(control.commandId) || control.controlRevision !== (prior?.controlRevision ?? 0) + 1
      || control.appliedTimeUs < profile.warmupUs || control.appliedTimeUs % profile.grid.nominalStepUs !== 0
      || control.appliedTimeUs > profile.horizonUs
      || (prior && (control.eventOrdinal <= prior.eventOrdinal || control.appliedTimeUs < prior.appliedTimeUs))) {
      return 'control-history'
    }
    ids.add(control.commandId)
    prior = control
    if (control.appliedTimeUs > cutoffUs) continue
    if (control.kind !== 'outlet-flow' || control.rampUs !== 0) return 'unsupported-control'
    if (control.valueSI < 0.9 * nominal || control.valueSI > 1.1 * nominal) return 'control-history'
    output.push(control)
  }
  return output
}

function matchingHistory(checkpoint: PublicPredictionCheckpoint, controls: readonly StepControl[], profile: FluidProfile): boolean {
  const prefix = controls.filter(({ appliedTimeUs }) => appliedTimeUs <= checkpoint.timeUs)
  const { inletPressurePa, outletFlowM3s, inletTemperatureK, ambientTemperatureK } = profile.initialPublicControls
  const { pinPa, qoutM3s, tinK, ambientK } = checkpoint.boundaries
  return checkpoint.controlRevision === prefix.length && checkpoint.eventCursor === prefix.length
    && (qoutM3s ?? outletFlowM3s) === (prefix.at(-1)?.valueSI ?? outletFlowM3s)
    && (pinPa ?? inletPressurePa) === inletPressurePa
    && (tinK ?? inletTemperatureK) === inletTemperatureK
    && (ambientK ?? ambientTemperatureK) === ambientTemperatureK
}

function controlPrefix(controls: readonly StepControl[], timeUs: number): string {
  return JSON.stringify(controls.filter(({ appliedTimeUs }) => appliedTimeUs <= timeUs))
}

function resumable(prior: PublicPredictionCheckpoint, target: PublicPredictionCheckpoint, controls: readonly StepControl[]): boolean {
  if (prior.timeUs === target.timeUs) return true
  return prior.timeUs < target.timeUs && (prior.timeUs % PRESSURE_PERIOD_US === 0
    || prior.lastThermalTimeUs === prior.timeUs || controls.some(({ appliedTimeUs }) => appliedTimeUs === prior.timeUs))
}

function rememberFine(state: HydraulicState, anchor: CheckpointAnchor, revision: number, controls: readonly StepControl[]): FineCheckpointResume {
  const handle = Object.freeze({}) as FineCheckpointResume
  const checkpoint = makeCheckpoint(state, anchor, revision)
  resumeRecords.set(handle, { checkpoint, controlPrefix: controlPrefix(controls, state.timeUs) })
  return handle
}

class RebuildStopped extends Error {
  constructor(readonly reason: 'cancelled' | 'resource-limit') { super(reason) }
}

async function advanceFine(
  initial: HydraulicState, targetUs: number, controls: readonly StepControl[], takeStep: () => Promise<void> | undefined,
): Promise<HydraulicState> {
  let state = initial
  for (;;) {
    const event = controls[state.eventCursor]
    if (event?.appliedTimeUs === state.timeUs) {
      const installed = advanceTo(state, state.timeUs, undefined, [{ timeUs: state.timeUs, inputs: { qoutM3s: event.valueSI } }])
      if (!installed.ok) throw installed.error
      state = installed.value
      continue
    }
    if (state.timeUs === targetUs) return state
    const waiting = takeStep()
    if (waiting) await waiting
    const sample = (Math.floor(state.timeUs / PRESSURE_PERIOD_US) + 1) * PRESSURE_PERIOD_US
    const thermalUs = state.profile.definition.thermal.stepUs - state.thermalFlow.elapsedUs
    const dtUs = Math.min(state.profile.stepUs, thermalUs, sample - state.timeUs, targetUs - state.timeUs,
      (event?.appliedTimeUs ?? Infinity) - state.timeUs)
    state = step(state, { dtUs })
  }
}

async function anchors(
  id: AnchorId, coarse: readonly FluidProfile[], fine: readonly FluidProfile[],
): Promise<readonly [CheckpointAnchor, CheckpointAnchor]> {
  return Promise.all([createCheckpointAnchor(id, coarse[id]!), createCheckpointAnchor(id, fine[id]!)])
}

/** Builds public N400 fields from their own initial/reference state and public outlet steps. */
export async function rebuildActiveCheckpointPairs(request: RebuildRequest, options: RebuildOptions = {}): Promise<RebuildResult> {
  const profile = profileSchema.safeParse(request.profile)
  const limit = options.maxForwardSteps ?? MAX_FORWARD_STEPS
  if (!profile.success || profile.data.mode !== 'turbulent' || profile.data.grid.segments !== 200
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FORWARD_STEPS) return { ok: false, reason: 'invalid-input' }
  const shouldCancel = options.shouldCancel
  if (shouldCancel?.()) return { ok: false, reason: 'cancelled' }
  const coarse = checkpointMap(request.coarseCheckpoints)
  const earlier = resumeMap(request.earlierFineCheckpoints ?? [])
  if (!coarse?.size || !earlier || [...earlier.keys()].some((id) => !coarse.has(id))) {
    return { ok: false, reason: 'checkpoint-mismatch' }
  }
  const latest = Math.max(...Array.from(coarse.values(), ({ timeUs }) => timeUs))
  const controls = readControls(request.appliedControls, profile.data, latest)
  if (typeof controls === 'string') return { ok: false, reason: controls }
  const coarseProfiles = bankProfiles(profile.data)
  const fineProfiles = activeFineBankProfiles(profile.data)
  const checkpointPairs: ActiveCheckpointPair[] = []
  const fineCheckpointCache: FineCheckpointResume[] = []
  const yieldTask = options.yieldTask ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  let forwardSteps = 0
  const checkCancellation = () => { if (shouldCancel?.()) throw new RebuildStopped('cancelled') }
  const takeStep = () => {
    checkCancellation()
    if (forwardSteps >= limit) throw new RebuildStopped('resource-limit')
    forwardSteps++
    if (forwardSteps % YIELD_STEPS === 0) return yieldTask().then(checkCancellation)
  }

  try {
    for (const [id, target] of coarse) {
      const record = earlier.get(id)
      const prior = record?.checkpoint
      if (prior && !resumable(prior, target, controls)) return { ok: false, reason: 'checkpoint-mismatch' }
      if (!matchingHistory(target, controls, profile.data)
        || (record && record.controlPrefix !== controlPrefix(controls, record.checkpoint.timeUs))) {
        return { ok: false, reason: 'control-history' }
      }
      const [coarseAnchor, fineAnchor] = await anchors(id, coarseProfiles, fineProfiles)
      checkCancellation()
      if (!restoreCheckpoint(target, coarseAnchor).ok) return { ok: false, reason: 'checkpoint-mismatch' }
      const initial = prior ? restoreCheckpoint(prior, fineAnchor) : initialize(fineAnchor.definition)
      if (!initial.ok) return { ok: false, reason: prior ? 'checkpoint-mismatch' : 'invalid-model' }
      const state = await advanceFine(initial.value, target.timeUs, controls, takeStep)
      checkpointPairs.push({ anchorId: id, grid200: target, grid400: makeCheckpoint(state, fineAnchor, target.controlRevision) })
      fineCheckpointCache.push(rememberFine(state, fineAnchor, target.controlRevision, controls))
    }
    checkCancellation()
  } catch (error) {
    if (error instanceof RebuildStopped) return { ok: false, reason: error.reason }
    if (error instanceof PhysicsDomainError) return { ok: false, reason: 'invalid-model' }
    throw error
  }
  return { ok: true, checkpointPairs, fineCheckpointCache, forwardSteps }
}
