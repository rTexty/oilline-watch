import type { InferenceAuditJob } from '../../../src/contracts/inference-audit'

export const SHORT_WINDOW_US = 4_000_000
export const LONG_WINDOW_US = 30_000_000
const COMPLETION_LIMIT_MS = 5_000

export interface PacedRequest {
  readonly jobId: string
  readonly windowStartUs: number
  readonly windowEndUs: number
  readonly admittedAtUs: number | null
  readonly terminalAtUs: number
  readonly disposition: 'committed' | 'discarded' | 'cancelled' | 'superseded'
}

interface PacedJobTiming {
  readonly jobId: string
  readonly stopReason: InferenceAuditJob['stopReason']
  readonly finalPageMs: number | null
  readonly provisionalMs: number | null
  readonly provisionalAudit?: 'verified' | 'unverified' | null
  readonly wallRoundTripMs: number | null
}

type RequestWithJob = PacedRequest & { readonly job: PacedJobTiming | null }

function joinRequests(schedule: readonly PacedRequest[], jobs: readonly PacedJobTiming[]): RequestWithJob[] {
  const byId = new Map(jobs.map((job) => [job.jobId, job]))
  if (byId.size !== jobs.length || new Set(schedule.map(({ jobId }) => jobId)).size !== schedule.length) {
    throw new Error('Duplicate paced workload job ID.')
  }
  const requests = schedule.map((request) => {
    const { jobId, windowStartUs, windowEndUs, admittedAtUs, terminalAtUs, disposition } = request
    const job = byId.get(jobId) ?? null
    const admitted = admittedAtUs !== null
    if (![SHORT_WINDOW_US, LONG_WINDOW_US].includes(windowEndUs - windowStartUs)
      || terminalAtUs < windowEndUs || admitted && (admittedAtUs < windowEndUs || terminalAtUs < admittedAtUs)
      || admitted !== (job !== null) || admitted && disposition === 'superseded'
      || !admitted && (disposition === 'committed' || disposition === 'discarded')) {
      throw new Error(`Invalid paced workload lifecycle for ${jobId}.`)
    }
    byId.delete(jobId)
    return { ...request, job }
  })
  if (byId.size > 0) throw new Error('Paced workload job has no admitted request.')
  return requests
}

function p95(values: readonly number[]): number | null {
  const value = values.toSorted((a, b) => a - b)[Math.ceil(0.95 * values.length) - 1]
  return value !== undefined && Number.isFinite(value) ? value : null
}

function summarize(requests: readonly RequestWithJob[]) {
  const admitted = requests.flatMap(({ disposition, job }) => job ? [{ disposition, ...job }] : [])
  const committed = admitted.filter(({ disposition }) => disposition === 'committed')
  const complete = committed.filter(({ stopReason }) => stopReason === 'complete')
  const roundTrips = admitted.flatMap(({ wallRoundTripMs }) => wallRoundTripMs === null ? [] : [wallRoundTripMs])
  const finalPage = admitted.flatMap(({ finalPageMs }) => finalPageMs === null ? [] : [finalPageMs])
  const provisional = admitted.flatMap(({ provisionalMs }) => provisionalMs === null ? [] : [provisionalMs])
  const missing = admitted.filter(({ disposition, stopReason, provisionalMs }) =>
    provisionalMs === null && (disposition !== 'committed' || stopReason !== 'complete')).length
  const stopReasons = new Map<InferenceAuditJob['stopReason'], number>()
  for (const { stopReason } of admitted) stopReasons.set(stopReason, (stopReasons.get(stopReason) ?? 0) + 1)
  return {
    requested: requests.length, admitted: admitted.length,
    superseded: requests.filter(({ disposition }) => disposition === 'superseded').length,
    cancelledBeforeAdmission: requests.filter(({ disposition, job }) => disposition === 'cancelled' && job === null).length,
    committed: committed.length, discarded: admitted.filter(({ disposition }) => disposition === 'discarded').length,
    cancelledAfterAdmission: admitted.filter(({ disposition }) => disposition === 'cancelled').length,
    committedComplete: complete.length,
    completedWithin5s: complete.filter(({ wallRoundTripMs }) => wallRoundTripMs !== null && wallRoundTripMs <= COMPLETION_LIMIT_MS).length,
    committedFinalWithin5s: committed.filter(({ finalPageMs }) => finalPageMs !== null && finalPageMs <= COMPLETION_LIMIT_MS).length,
    observedRoundTrip: { delivered: roundTrips.length, p95Ms: p95(roundTrips) },
    observedFinalPage: { delivered: finalPage.length, p95Ms: p95(finalPage) },
    observedProvisional: { delivered: provisional.length, p95Ms: p95(provisional) },
    unverifiedProvisionalReceipts: admitted.filter(({ provisionalAudit }) => provisionalAudit === 'unverified').length,
    provisionalIncludingMissing: {
      requiredOrDelivered: provisional.length + missing, missing,
      p95Ms: p95([...provisional, ...Array<number>(missing).fill(Infinity)]),
    },
    stopReasons: Object.fromEntries(stopReasons),
  }
}

export function summarizePacedWorkload(schedule: readonly PacedRequest[], jobs: readonly PacedJobTiming[]) {
  const requests = joinRequests(schedule, jobs)
  return {
    all: summarize(requests),
    short: summarize(requests.filter(({ windowEndUs, windowStartUs }) => windowEndUs - windowStartUs === SHORT_WINDOW_US)),
    long: summarize(requests.filter(({ windowEndUs, windowStartUs }) => windowEndUs - windowStartUs === LONG_WINDOW_US)),
  }
}
