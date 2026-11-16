import type { DiagnosticJob } from '../contracts/inference'
import { PRESSURE_PERIOD_US } from '../contracts/public'
import type { AppliedControl, PublicPrediction } from '../contracts/public'
import { advanceTo } from '../physics/advance-to'
import { outletPulseEnd } from '../physics/outlet-pulse'
import type { OutletPulseLaw } from '../physics/outlet-pulse'
import type { HydraulicState } from '../physics/state'
import { restoreCheckpoint } from '../twin/checkpoint'
import type { CheckpointAnchor } from '../twin/checkpoint'
import { predict } from '../twin/predict'
import type { CandidatePrediction } from './hypotheses'
import type { ForwardPrefixCache } from './forward-prefix-cache'
import { MAX_CD_AREA_M2, MAX_OUTLET_FRACTION, OPENINGS_US } from './optimizer'
import type { HydraulicCandidate } from './optimizer'

export { createForwardPrefixCache, forwardPrefixCacheBytes } from './forward-prefix-cache'
export type { ForwardPrefixCache } from './forward-prefix-cache'

interface FlowSegment {
  readonly startUs: number
  readonly endUs: number
  readonly first: number
  readonly last: number
}

interface PreparedAnchor {
  readonly state: HydraulicState
  readonly initialFlow: number
  readonly flow: readonly FlowSegment[]
  readonly pulse: OutletPulseLaw | null
}

export interface ForwardContext {
  readonly job: DiagnosticJob
  readonly anchors: readonly PreparedAnchor[]
}

function value(segment: FlowSegment, timeUs: number): number {
  if (timeUs >= segment.endUs) return segment.last
  if (timeUs <= segment.startUs) return segment.first
  return segment.first + (segment.last - segment.first) * (timeUs - segment.startUs) / (segment.endUs - segment.startUs)
}

function knownFlow(
  controls: readonly AppliedControl[],
  initialFlow: number,
  checkpointUs: number,
  controlRevision: number,
): Pick<PreparedAnchor, 'flow' | 'pulse'> | null {
  const segments: FlowSegment[] = []
  let pulse: OutletPulseLaw | null = null
  let lastEndUs = -1
  const ordered = [...controls].sort((left, right) => left.appliedTimeUs - right.appliedTimeUs
    || left.eventOrdinal - right.eventOrdinal)

  for (const control of ordered) {
    const startUs = control.appliedTimeUs
    const durationUs = control.kind === 'outlet-flow' ? control.rampUs
      : control.pulse.rampUs + control.pulse.holdUs + control.pulse.returnUs
    const endUs = startUs + durationUs
    if (!Number.isSafeInteger(endUs) || lastEndUs > startUs) return null
    lastEndUs = endUs
    if (startUs < checkpointUs || (startUs === checkpointUs && control.controlRevision <= controlRevision)) {
      if (endUs > checkpointUs) return null
      continue
    }
    const preceding = segments.at(-1)
    const first = preceding ? value(preceding, startUs) : initialFlow
    if (control.kind === 'outlet-flow') {
      segments.push({ startUs, endUs, first, last: control.valueSI })
    } else {
      if (pulse) return null
      pulse = { startUs, pulse: control.pulse }
    }
  }
  return { flow: segments, pulse }
}

export function prepareForwardContext(job: DiagnosticJob, anchors: readonly CheckpointAnchor[]): ForwardContext | null {
  if (anchors.length !== job.checkpointsByAnchor.length) return null
  const prepared = job.checkpointsByAnchor.map((checkpoint, index) => {
    const anchor = anchors[index]
    if (!anchor || anchor.anchorId !== checkpoint.anchorId || anchor.definition.mode !== 'turbulent') return null
    const restored = restoreCheckpoint(checkpoint, anchor)
    if (!restored.ok) return null
    const state = restored.value
    const initialFlow = state.inputs.qoutM3s ?? anchor.definition.initialPublicControls.outletFlowM3s
    const flow = knownFlow(job.appliedControls, initialFlow, state.timeUs, checkpoint.controlRevision)
    return flow && { state, initialFlow, ...flow }
  })
  if (prepared.some((anchor) => anchor === null)) return null
  return { job, anchors: prepared.filter((anchor) => anchor !== null) }
}

function validCandidate(candidate: HydraulicCandidate, initial: PreparedAnchor, job: DiagnosticJob): boolean {
  if (candidate.model === 'M0') return true
  const eventValid = Number.isSafeInteger(candidate.onsetUs)
    && candidate.onsetUs >= job.windowStartUs - 3_000_000 && candidate.onsetUs <= job.windowEndUs
    && OPENINGS_US.includes(candidate.openingUs)
  if (!eventValid) return false
  const definition = initial.state.profile.definition
  if (candidate.model === 'MB') {
    return Math.abs(candidate.amplitudeM3s) <= MAX_OUTLET_FRACTION * definition.initialPublicControls.outletFlowM3s
  }
  return Number.isSafeInteger(candidate.node) && candidate.node >= 1 && candidate.node < definition.grid.segments
    && candidate.cdAreaM2 >= 0 && candidate.cdAreaM2 <= MAX_CD_AREA_M2
}

export function candidateAllowed(context: ForwardContext, candidate: HydraulicCandidate): boolean {
  const initial = context.anchors[candidate.anchorId]
  return initial !== undefined && validCandidate(candidate, initial, context.job)
}

export interface ForwardTrial {
  readonly status: 'complete'
  readonly prediction: CandidatePrediction
  readonly trace: ReadonlyMap<number, PublicPrediction>
}

export interface InterruptedTrial {
  readonly status: 'interrupted' | 'invalid-model'
}

function boundarySegment(candidate: HydraulicCandidate): FlowSegment | null {
  return candidate.model === 'MB' && candidate.amplitudeM3s !== 0
    ? { startUs: candidate.onsetUs, endUs: candidate.onsetUs + candidate.openingUs, first: 0, last: candidate.amplitudeM3s }
    : null
}

function controlsAt(
  prepared: PreparedAnchor,
  candidateFlow: FlowSegment | null,
  timeUs: number,
  firstFutureIndex: number,
) {
  let index = firstFutureIndex
  while (index < prepared.flow.length && prepared.flow[index]!.startUs <= timeUs) index++
  const latest = prepared.flow[index - 1]
  const next = prepared.flow[index]
  const variable = (segment: FlowSegment | null | undefined) => segment && segment.first !== segment.last
    && timeUs >= segment.startUs && timeUs < segment.endUs
  const nextKnot = (segment: FlowSegment | null | undefined) => !segment ? Infinity
    : timeUs < segment.startUs ? segment.startUs : timeUs < segment.endUs ? segment.endUs : Infinity
  const flow = (latest ? value(latest, timeUs) : prepared.initialFlow)
    + (candidateFlow && timeUs >= candidateFlow.startUs ? value(candidateFlow, timeUs) : 0)
  return {
    index, flow, changes: Boolean(variable(latest) || variable(candidateFlow)),
    deadline: Math.min(next?.startUs ?? Infinity, nextKnot(latest), nextKnot(candidateFlow)),
  }
}

const PRESSURE_INDEX = { P1: 0, P2: 1, P3: 2 } as const
const FORWARD_POLL_STRIDE = 32

export async function forwardTrial(
  context: ForwardContext,
  candidate: HydraulicCandidate,
  continueTrial: () => Promise<boolean>,
  prefixCache?: ForwardPrefixCache,
): Promise<ForwardTrial | InterruptedTrial> {
  const initial = context.anchors[candidate.anchorId]
  if (!initial || !validCandidate(candidate, initial, context.job)) return { status: 'invalid-model' }

  let state = initial.state
  const { windowStartUs, windowEndUs } = context.job
  const trace = new Map<number, PublicPrediction>()
  const candidateFlow = boundarySegment(candidate)
  const leak = candidate.model === 'ML' && candidate.cdAreaM2 !== 0
    ? { node: candidate.node, cdA: candidate.cdAreaM2, onsetUs: candidate.onsetUs, rampUs: candidate.openingUs }
    : undefined
  let controlIndex = 0
  let iterations = 0
  const prefix = prefixCache?.forAnchor(context, candidate.anchorId)
  const cutoffUs = leak?.onsetUs ?? candidateFlow?.startUs ?? windowEndUs
  const saved = prefix?.find(cutoffUs)
  if (prefix && saved) {
    // Preserve every skipped continuation check, including the ordinal that may cancel this trial.
    for (let pollIndex = 0; pollIndex < saved.iterations; pollIndex += FORWARD_POLL_STRIDE) {
      if (!await continueTrial()) return { status: 'interrupted' }
    }
    prefix.fillTrace(trace, saved, candidate.anchorId)
    prefixCache?.recordHit(saved.state.timeUs - initial.state.timeUs)
    // The donor may have installed its future leak law. The recipient installs its own below.
    state = { ...saved.state, inputs: initial.state.inputs }
    iterations = saved.iterations
  }

  while (state.timeUs <= windowEndUs) {
    const timeUs = state.timeUs
    const prediction = timeUs >= windowStartUs && timeUs % PRESSURE_PERIOD_US === 0
      ? predict(state, candidate.anchorId) : undefined
    if (prediction) trace.set(timeUs, prediction)
    if (prefix && timeUs <= cutoffUs) prefix.record(state, iterations, prediction)
    if (timeUs === windowEndUs) break
    if (iterations++ % FORWARD_POLL_STRIDE === 0 && !await continueTrial()) return { status: 'interrupted' }

    const control = controlsAt(initial, candidateFlow, timeUs, controlIndex)
    controlIndex = control.index
    const nextSampleUs = (Math.floor(timeUs / PRESSURE_PERIOD_US) + 1) * PRESSURE_PERIOD_US
    const thermalRemainingUs = state.profile.definition.thermal.stepUs - state.thermalFlow.elapsedUs
    const varyingFlowDeadline = control.changes ? timeUs + Math.min(state.profile.stepUs, thermalRemainingUs) : Infinity
    const leakKnot = !leak || !control.changes ? Infinity : timeUs < leak.onsetUs ? leak.onsetUs
      : timeUs < leak.onsetUs + leak.rampUs ? leak.onsetUs + leak.rampUs : Infinity
    const pulse = initial.pulse
    const pulseStartUs = pulse && timeUs < pulse.startUs ? pulse.startUs : Infinity
    const deadline = Math.min(nextSampleUs, windowEndUs, control.deadline, varyingFlowDeadline, leakKnot, pulseStartUs)
    const installPulse = pulse && !state.inputs.outletPulse && timeUs >= pulse.startUs && timeUs < outletPulseEnd(pulse)
    const flowChanged = control.flow !== (state.inputs.qoutM3s ?? initial.initialFlow)
    const changes = flowChanged || installPulse || leak !== undefined && state.inputs.leak === undefined
      ? { ...(flowChanged ? { qoutM3s: control.flow } : {}), ...(leak ? { leak } : {}),
          ...(installPulse ? { outletPulse: pulse } : {}) }
      : undefined
    const moved = advanceTo(state, deadline, changes)
    if (!moved.ok) return { status: 'invalid-model' }
    state = moved.value
  }

  const prediction: CandidatePrediction = (sensor, timeUs) => {
    const item = trace.get(timeUs)
    return sensor === 'Qin' ? item?.inletFlowM3s : item?.pressurePa[PRESSURE_INDEX[sensor]]
  }
  return { status: 'complete', trace, prediction }
}
