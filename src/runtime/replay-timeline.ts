import { PRESSURE_PERIOD_US } from '../contracts/public'
import type { InferenceAuditJob, InferenceAuditTransition } from '../contracts/inference-audit'

export interface ReplayTimeline {
  readonly jobs: readonly InferenceAuditJob[]
  readonly byEvidenceEnd: ReadonlyMap<number, readonly InferenceAuditJob[]>
  readonly transitionsByTime: ReadonlyMap<number, readonly InferenceAuditTransition[]> | null
  readonly index: number
  readonly stage: 'scheduled' | 'dispatched' | 'matched' | 'diverged'
  readonly provisionalPublished?: boolean
}

export interface ReplayAction {
  readonly kind: 'freeze' | 'dispatch' | 'wait' | 'provisional' | 'commit' | 'divergence'
  readonly job: InferenceAuditJob
}

export function createReplayTimeline(jobs: readonly InferenceAuditJob[], transitions?: readonly InferenceAuditTransition[]): ReplayTimeline {
  const byEvidenceEnd = new Map<number, readonly InferenceAuditJob[]>()
  let previousFinish = -1
  const ids = new Set<string>()
  for (const job of jobs) {
    const duration = job.endUs - job.startUs
    if (ids.has(job.jobId) || (duration !== 4_000_000 && duration !== 30_000_000)
      || job.startUs < 3_000_000 || job.endUs > job.startedAtUs
      || job.startedAtUs < previousFinish || job.finishedAtUs < job.startedAtUs
      || [job.endUs, job.startedAtUs].some((time) => time % PRESSURE_PERIOD_US !== 0)
      || job.finishedAtUs % (job.closure ? PRESSURE_PERIOD_US / 2 : PRESSURE_PERIOD_US) !== 0) {
      throw new RangeError('Invalid recorded inference timeline')
    }
    ids.add(job.jobId)
    previousFinish = job.finishedAtUs
    byEvidenceEnd.set(job.endUs, [...(byEvidenceEnd.get(job.endUs) ?? []), job])
  }
  const transitionsByTime = transitions ? new Map<number, readonly InferenceAuditTransition[]>() : null
  if (transitionsByTime && transitions) {
    for (const transition of transitions) {
      const at = transition[2]
      transitionsByTime.set(at, [...(transitionsByTime.get(at) ?? []), transition])
    }
  }
  return { jobs: [...jobs], byEvidenceEnd, transitionsByTime, index: 0, stage: 'scheduled' }
}

export function replayActions(state: ReplayTimeline, timeUs: number): readonly ReplayAction[] {
  const job = state.jobs[state.index]
  if (!job) return []
  const actions: ReplayAction[] = (state.byEvidenceEnd.get(timeUs) ?? [])
    .filter((entry) => entry.jobId === job.jobId ? state.stage === 'scheduled' : state.jobs.indexOf(entry) > state.index)
    .map((entry) => ({ kind: 'freeze', job: entry }))
  if (state.stage === 'scheduled' && timeUs >= job.startedAtUs) {
    return [...actions, { kind: timeUs === job.startedAtUs ? 'dispatch' : 'divergence', job }]
  }
  const provisionalAt = job.provisional?.publishedAtUs
  if (!state.provisionalPublished && provisionalAt !== undefined && timeUs >= provisionalAt) {
    const kind = timeUs > provisionalAt || state.stage === 'diverged' ? 'divergence'
      : state.stage === 'matched' ? 'provisional' : 'wait'
    return [...actions, { kind, job }]
  }
  if (timeUs < job.finishedAtUs) return actions
  const kind = timeUs > job.finishedAtUs || state.stage === 'diverged' ? 'divergence'
    : state.stage === 'matched' ? 'commit' : 'wait'
  return [...actions, { kind, job }]
}

export function markReplayDispatched(state: ReplayTimeline, jobId: string): ReplayTimeline {
  return state.stage === 'scheduled' && state.jobs[state.index]?.jobId === jobId
    ? { ...state, stage: 'dispatched' } : state
}

export function markReplayVerified(state: ReplayTimeline, jobId: string, matched: boolean): ReplayTimeline {
  return state.stage === 'dispatched' && state.jobs[state.index]?.jobId === jobId
    ? { ...state, stage: matched ? 'matched' : 'diverged' } : state
}

export function commitReplayJob(state: ReplayTimeline, jobId: string): ReplayTimeline {
  return state.stage === 'matched' && state.jobs[state.index]?.jobId === jobId
    ? { ...state, index: state.index + 1, stage: 'scheduled', provisionalPublished: undefined } : state
}
