import type { InferenceAuditTransition } from '../contracts/inference-audit'
import type { DiagnosticWindow } from './inference-schedule'
import { preservePendingWindow } from './inference-schedule'

interface QueuedJob {
  readonly jobId: string
  readonly priority: DiagnosticWindow['priority']
  readonly durationUs: DiagnosticWindow['durationUs']
}

interface ReplayQueue {
  readonly active: QueuedJob | null
  readonly pending: QueuedJob | null
}

export const emptyReplayQueue: ReplayQueue = { active: null, pending: null }

export function verifyReplayQueue(
  previous: ReplayQueue, windows: readonly DiagnosticWindow[], transitions: readonly InferenceAuditTransition[],
  timeUs: number, horizonUs: number,
): ReplayQueue {
  let { active, pending } = previous
  let index = 0
  const fail = () => new Error('replay-divergence: diagnostic queue differs')
  const expect = (kind: InferenceAuditTransition[0], jobId: string) => {
    const next = transitions[index++]
    if (next?.[0] !== kind || next[1] !== jobId) throw fail()
  }

  for (const window of windows) {
    const requested = transitions[index++]
    if (requested?.[0] !== 'requested' || requested[3] !== window.startUs) throw fail()
    const jobId = requested[1]
    const queued = { jobId, priority: window.priority, durationUs: window.durationUs }
    if (preservePendingWindow(pending ?? undefined, window, active?.durationUs)) expect('superseded', jobId)
    else if (active === null) {
      expect('admitted', jobId)
      active = queued
    } else {
      if (pending) expect('superseded', pending.jobId)
      pending = queued
    }
  }
  while (active !== null && transitions[index]?.[0] === 'finished') {
    expect('finished', active.jobId)
    expect('committed', active.jobId)
    active = pending
    if (active) expect('admitted', active.jobId)
    pending = null
  }
  if (timeUs === horizonUs) {
    if (active) expect('cancelled', active.jobId)
    if (pending) expect('cancelled', pending.jobId)
    active = null
    pending = null
  }
  if (index !== transitions.length) throw fail()
  return active === previous.active && pending === previous.pending ? previous : { active, pending }
}
