import { z } from 'zod'
import { MAX_AUDITED_JOBS } from '../../../src/contracts/inference-audit'
import type { InferenceAuditJob, InferenceAuditTransition } from '../../../src/contracts/inference-audit'
import { PRESSURE_PERIOD_US } from '../../../src/contracts/public'
import { LONG_WINDOW_US, SHORT_WINDOW_US } from './paced-workload'
import type { PacedRequest } from './paced-workload'
import { CROSS_CONTEXT_CLOCK_SKEW_MS } from './provisional-timing'

const pageTimingSchema = z.object({
  jobId: z.string().min(1).max(96), publishedAtUs: z.number().int().nonnegative().multipleOf(PRESSURE_PERIOD_US).nullable(),
  submittedMs: z.number().nonnegative().nullable(), provisionalMs: z.number().nonnegative().nullable(),
  finalPageMs: z.number().nonnegative().nullable(), finalDisposition: z.enum(['committed', 'discarded']).nullable(),
})
export type PageTiming = z.infer<typeof pageTimingSchema>
type BudgetTiming = Pick<PageTiming, 'provisionalMs' | 'finalPageMs' | 'finalDisposition'>

export function readPacedSchedule(
  transitions: readonly InferenceAuditTransition[], audited: ReadonlyMap<string, InferenceAuditJob>,
): PacedRequest[] | null {
  const requests = new Map<string, Pick<PacedRequest, 'jobId' | 'windowStartUs' | 'windowEndUs'>>()
  const admissions = new Map<string, number>()
  const closed = new Map<string, Pick<PacedRequest, 'terminalAtUs' | 'disposition'>>()
  for (const transition of transitions) {
    const [kind, jobId, atUs] = transition
    if (kind === 'requested') {
      const start = transition[3]
      if (![SHORT_WINDOW_US, LONG_WINDOW_US].includes(atUs - start)) return null
      requests.set(jobId, { jobId, windowStartUs: start, windowEndUs: atUs })
    } else if (kind === 'admitted') {
      admissions.set(jobId, atUs)
    } else if (kind !== 'finished') {
      const disposition = kind === 'cancelled' && audited.get(jobId)?.closure === 'discarded' ? 'discarded' : kind
      closed.set(jobId, { terminalAtUs: atUs, disposition })
    }
  }
  return [...requests.values()].map((request) => ({
    ...request, admittedAtUs: admissions.get(request.jobId) ?? null, ...closed.get(request.jobId)!,
  }))
}

function timingMatchesRequest(row: PageTiming, request: PacedRequest, job?: InferenceAuditJob): boolean {
  const { publishedAtUs, submittedMs, provisionalMs, finalPageMs, finalDisposition } = row
  if ((finalPageMs === null) !== (finalDisposition === null)
    || finalDisposition !== null && (!job || finalDisposition !== request.disposition)) return false
  if (publishedAtUs === null) return submittedMs === null && provisionalMs === null
  if (submittedMs === null || provisionalMs === null || submittedMs - provisionalMs > CROSS_CONTEXT_CLOCK_SKEW_MS
    || (finalPageMs !== null && provisionalMs > finalPageMs)) return false
  return publishedAtUs >= request.admittedAtUs! && publishedAtUs <= request.terminalAtUs
    && (job ? publishedAtUs === job.provisional?.publishedAtUs : request.disposition === 'cancelled')
}

export function readPacedPageTimings(
  raw: unknown, schedule: readonly PacedRequest[], audited: ReadonlyMap<string, InferenceAuditJob>,
  budgets: ReadonlyMap<string, BudgetTiming>,
): ReadonlyMap<string, PageTiming> | null {
  if (raw === undefined) return new Map()
  const parsed = z.array(pageTimingSchema).max(MAX_AUDITED_JOBS + 1).safeParse(raw)
  if (!parsed.success) return null
  const admitted = new Map(schedule.filter(({ admittedAtUs }) => admittedAtUs !== null).map((request) => [request.jobId, request]))
  const timings = new Map(parsed.data.map((row) => [row.jobId, row]))
  if (timings.size !== parsed.data.length || timings.size !== admitted.size) return null
  for (const [jobId, row] of timings) {
    const request = admitted.get(jobId)
    const budget = budgets.get(jobId)
    if (!request || !timingMatchesRequest(row, request, audited.get(jobId))
      || budget && (row.provisionalMs !== budget.provisionalMs || row.finalPageMs !== budget.finalPageMs
        || row.finalDisposition !== budget.finalDisposition)) return null
  }
  return timings
}
