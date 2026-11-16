import { z } from 'zod'
import { diagnosticResultSchema } from '../../../src/contracts/inference'
import { inferenceAuditSchema, MAX_AUDITED_JOBS } from '../../../src/contracts/inference-audit'
import type { InferenceAuditJob } from '../../../src/contracts/inference-audit'
import { CHALLENGE_WARMUP_US } from '../../../src/contracts/model'
import { ADVERSE_MAX_DELIVERY_DELAY_US, PRESSURE_PERIOD_US } from '../../../src/contracts/public'
import { assessWithdrawalFit } from '../../../src/detection/hypothesis-decision'
import { readPacedPageTimings, readPacedSchedule } from './paced-lifecycle'
import type { PageTiming } from './paced-lifecycle'
import { pacedDecisionTraceSchema } from './paced-matrix-report'
import { summarizePacedWorkload } from './paced-workload'
import type { PacedRequest } from './paced-workload'
import { CROSS_CONTEXT_CLOCK_SKEW_MS } from './provisional-timing'

const clock = z.number().int().nonnegative()
const pressureTime = clock.multipleOf(PRESSURE_PERIOD_US)
const jobId = z.string().min(1).max(96)
const optionalMs = z.number().nonnegative().nullable()
const nullableScore = z.number().nonnegative().nullable()
const decisionShape = diagnosticResultSchema.unwrap().shape
const stopReason = decisionShape.stopReason
const statistic = z.object({ improvement: z.number(), separation: z.number(), absoluteFit: z.number().nonnegative() })
const detectorTraceSchema = z.object({
  status: z.enum(['observed', 'unavailable', 'uncalibrated', 'warming-up', 'incomplete', 'failed']),
  deliveredThroughUs: pressureTime.nullable(), observedThroughUs: pressureTime.nullable(),
  availableUs: pressureTime, processedChallengeCohorts: clock,
  exposure: z.array(z.object({
    firstCohortUs: pressureTime, lastCohortUs: pressureTime, ready: z.boolean(), canLocalize: z.boolean(),
  })).max(33_001),
  episodes: z.array(z.object({
    openedAtUs: pressureTime, openingCohortUs: pressureTime,
    closedAtUs: pressureTime.nullable(), closingCohortUs: pressureTime.nullable(),
  })).max(150),
})
const budgetSchema = z.object({
  jobId, stopReason, closure: z.literal('discarded').nullable(),
  wallRoundTripMs: optionalMs, provisionalMs: optionalMs, finalPageMs: optionalMs,
  finalDisposition: z.enum(['committed', 'discarded']).nullable(),
})
export const fitSchema = z.object({
  jobId, windowStartUs: clock, windowEndUs: clock, deliveredThroughUs: clock, observationPairCount: clock.nullable(),
  J0: nullableScore, JL: nullableScore, JB: nullableScore, JS: nullableScore,
  stopReason, closure: z.literal('discarded').nullable(),
  availability: decisionShape.availability.nullable(), searchComplete: z.boolean().nullable(), statistics: statistic.nullable(),
})
const observationSchema = z.object({
  timeUs: clock, phase: z.enum(['completed', 'invalid', 'error']), closureEvidenceMissing: z.boolean(),
  failure: z.unknown().optional(),
  detectorTrace: z.unknown().optional(), alarmTimesUs: z.unknown().optional(), policyAudit: z.unknown().optional(),
  timeline: z.unknown().optional(), budgets: z.unknown().optional(), fitEvidence: z.unknown().optional(),
  publicDiagnosticTrace: z.unknown().optional(), provisionalByJob: z.unknown().optional(),
})
type Observation = z.infer<typeof observationSchema>
type DetectorTrace = z.infer<typeof detectorTraceSchema>
type Fit = z.infer<typeof fitSchema>

export interface PacedObservationBindings {
  readonly terminalUs: number
  readonly phase: Observation['phase']
  readonly sensor: 'nominal' | 'adverse'
  readonly inferenceAvailable?: boolean
  readonly calibrationId?: string
  readonly policySha256: string
  readonly dictionarySha256?: string
  readonly includeFitInputs?: boolean
  readonly spatialEvaluationSha256?: string | null
}

function cusumFailure(status: 'missing' | 'invalid' | 'unavailable') {
  return { cusum: { status, availableUs: null, alarmTimesUs: null }, alarmEpisodes: null } as const
}

function exactExposure(trace: DetectorTrace, deliveredUs: number, delay: number): boolean {
  const first = CHALLENGE_WARMUP_US + PRESSURE_PERIOD_US
  let next = first
  let availableUs = 0
  for (const span of trace.exposure) {
    if (span.firstCohortUs !== next || span.lastCohortUs < next || (span.canLocalize && !span.ready)) return false
    next = span.lastCohortUs + PRESSURE_PERIOD_US
    if (span.ready) availableUs += next - span.firstCohortUs
  }
  const observedThrough = deliveredUs - delay
  return trace.deliveredThroughUs === deliveredUs && trace.observedThroughUs === observedThrough && next - PRESSURE_PERIOD_US === observedThrough
    && trace.processedChallengeCohorts === (observedThrough - CHALLENGE_WARMUP_US) / PRESSURE_PERIOD_US
    && trace.availableUs === availableUs
}

function exactEpisodes(trace: DetectorTrace, terminalUs: number, delay: number): boolean {
  let nextAfter = CHALLENGE_WARMUP_US
  return trace.episodes.every(({ openedAtUs, openingCohortUs, closedAtUs, closingCohortUs }) => {
    if (openedAtUs <= nextAfter || openingCohortUs <= CHALLENGE_WARMUP_US
      || openedAtUs !== openingCohortUs + delay || openedAtUs > terminalUs
      || !trace.exposure.some(({ ready, firstCohortUs, lastCohortUs }) => ready
        && firstCohortUs <= openingCohortUs && openingCohortUs <= lastCohortUs)) return false
    if (closedAtUs === null || closingCohortUs === null) {
      nextAfter = terminalUs
      return closedAtUs === null && closingCohortUs === null
    }
    nextAfter = closedAtUs
    return closedAtUs === closingCohortUs + delay && closedAtUs > openedAtUs && closedAtUs <= terminalUs
  })
}

function extractCusum(raw: Observation, { sensor, terminalUs, phase }: PacedObservationBindings) {
  if (raw.detectorTrace == null) return cusumFailure('missing')
  const parsed = detectorTraceSchema.safeParse(raw.detectorTrace)
  if (!parsed.success) return cusumFailure('invalid')
  const trace = parsed.data
  const physicalPrefix = trace.status === 'failed' && phase === 'invalid'
    && (raw.failure === 'outside-model-domain' || raw.failure === 'uncertain-flow-regime')
  if (!physicalPrefix && trace.status !== 'observed') return cusumFailure('unavailable')
  const deliveredThroughUs = physicalPrefix ? trace.deliveredThroughUs : terminalUs
  if (deliveredThroughUs === null) return cusumFailure('unavailable')
  const delay = sensor === 'adverse' ? ADVERSE_MAX_DELIVERY_DELAY_US : 0
  if (physicalPrefix && deliveredThroughUs <= terminalUs && deliveredThroughUs - delay <= CHALLENGE_WARMUP_US
    && trace.availableUs === 0 && trace.processedChallengeCohorts === 0 && !trace.exposure.length && !trace.episodes.length) {
    return cusumFailure('unavailable')
  }
  const alarmTimesUs = trace.episodes.map(({ openedAtUs }) => openedAtUs)
  if ((!physicalPrefix && (phase !== 'completed' || trace.availableUs === 0)) || deliveredThroughUs > terminalUs
    || !exactExposure(trace, deliveredThroughUs, delay) || !exactEpisodes(trace, deliveredThroughUs, delay)
    || (raw.alarmTimesUs !== undefined && JSON.stringify(raw.alarmTimesUs) !== JSON.stringify(alarmTimesUs))) return cusumFailure('invalid')
  const observation = { availableUs: trace.availableUs, alarmTimesUs }
  const cusum = physicalPrefix
    ? { status: 'observed-prefix' as const, deliveredThroughUs, observedThroughUs: deliveredThroughUs - delay, ...observation }
    : { status: 'observed' as const, ...observation }
  return { cusum, alarmEpisodes: trace.episodes }
}

function fitMatchesAudit(fit: Fit, job: InferenceAuditJob): boolean {
  const result = job.decisionReplay?.result
  const hypotheses = result?.hypotheses ?? []
  const score = (model: string) => hypotheses.find((hypothesis) => hypothesis.model === model)?.score ?? null
  const scores = { M0: score('M0'), ML: score('ML'), MB: score('MB'), MS: score('MS') }
  const { statistics } = assessWithdrawalFit({
    scores, observations: fit.observationPairCount ?? 0,
    completed: !job.closure && job.stopReason === 'complete' && result?.searchComplete === true
      && ['M0', 'MS'].every((model) => hypotheses.some((entry) => entry.model === model && entry.completed)),
    available: result?.availability === 'available', positiveWithdrawal: false, profileQualified: false,
  }, null)
  return fit.windowStartUs === job.startUs && fit.windowEndUs === job.endUs
    && fit.deliveredThroughUs === (result?.observedThroughUs ?? job.endUs)
    && fit.stopReason === job.stopReason && fit.closure === (job.closure ?? null)
    && fit.availability === (result?.availability ?? null) && fit.searchComplete === (result?.searchComplete ?? null)
    && fit.J0 === scores.M0 && fit.JL === scores.ML && fit.JB === scores.MB && fit.JS === scores.MS
    && JSON.stringify(fit.statistics) === JSON.stringify(statistics)
}

function indexRows<T extends { jobId: string }>(rows: readonly T[], accepted: ReadonlyMap<string, InferenceAuditJob>) {
  const byId = new Map(rows.map((row) => [row.jobId, row]))
  return byId.size === rows.length && rows.every(({ jobId }) => accepted.has(jobId)) ? byId : null
}

type Audit = {
  readonly audited: ReadonlyMap<string, InferenceAuditJob>
  readonly committed: ReadonlySet<string>
} | null

function spatialEnvelopeApplied(job: InferenceAuditJob, pin: string): boolean {
  const replay = job.decisionReplay
  return replay?.spatialEnvelopeSha256 === pin && replay.result.controlRevision === 0 && replay.result.searchComplete
    && replay.result.assumptions.includes('qualified-spatial-envelope')
}

function summarizeSpatialEvaluation(audit: NonNullable<Audit>, pin?: string | null) {
  const { audited, committed } = audit
  for (const job of audited.values()) {
    const replay = job.decisionReplay
    if (replay?.spatialEnvelopeSha256 !== undefined && replay.spatialEnvelopeSha256 !== pin) return null
    if (replay?.result.assumptions.includes('qualified-spatial-envelope') && (!pin || !spatialEnvelopeApplied(job, pin))) return null
  }
  if (!pin) return undefined
  const committedJobs = committed.size
  const loaded = [...committed].map((id) => audited.get(id)!).filter((job) => job.decisionReplay?.spatialEnvelopeSha256 === pin)
  const status = committedJobs === 0 ? 'not-exercised' : loaded.length === committedJobs ? 'worker-verified' : 'incomplete-worker-evidence'
  return { status, committedJobs, loadedJobs: loaded.length, appliedJobs: loaded.filter((job) => spatialEnvelopeApplied(job, pin)).length }
}

function missingFitReason(fit: Fit) {
  if (fit.stopReason !== 'complete' || fit.searchComplete !== true) return 'search-incomplete'
  if (fit.availability !== 'available') return 'decision-unavailable'
  if (fit.observationPairCount === null) return 'pair-count-not-recorded'
  if (fit.observationPairCount === 0) return 'no-innovation-pairs'
  return 'required-scores-unavailable'
}

function projectFitInput(disposition: PacedRequest['disposition'], fit?: Fit) {
  const record = fit ? {
    deliveredThroughUs: fit.deliveredThroughUs, observationPairCount: fit.observationPairCount,
    J0: fit.J0, JL: fit.JL, JB: fit.JB, JS: fit.JS, availability: fit.availability, searchComplete: fit.searchComplete,
  } : null
  if (disposition === 'discarded' || disposition === 'cancelled') {
    return { status: 'unavailable' as const, reason: disposition, record }
  }
  if (!fit || !record) return { status: 'missing' as const, reason: 'fit-not-recorded' as const, record: null }
  if (fit.statistics === null) return { status: 'unavailable' as const, reason: missingFitReason(fit), record }
  return { status: 'measured' as const, reason: null, record }
}

function extractJob(
  request: PacedRequest, admittedAtUs: number, job?: InferenceAuditJob, timing?: z.infer<typeof budgetSchema>,
  pageTiming?: PageTiming, fit?: Fit, includeFitInputs?: boolean,
) {
  const { jobId, disposition, windowStartUs, windowEndUs } = request
  const provisionalMs = pageTiming?.provisionalMs ?? timing?.provisionalMs ?? null
  return {
    jobId, admittedAtUs, disposition, stopReason: job?.stopReason ?? 'cancelled' as const,
    finishedAtUs: job?.finishedAtUs ?? null, windowStartUs, windowEndUs, completedEvaluations: job?.completedEvaluations ?? null,
    provisionalMs, provisionalAudit: provisionalMs === null ? null : job ? 'verified' as const : 'unverified' as const,
    provisionalPublishedAtUs: provisionalMs === null ? null : pageTiming?.publishedAtUs ?? job?.provisional?.publishedAtUs ?? null,
    provisionalSubmittedMs: pageTiming?.submittedMs ?? null, finalPageMs: pageTiming?.finalPageMs ?? timing?.finalPageMs ?? null,
    wallRoundTripMs: timing?.wallRoundTripMs ?? null, statistics: fit?.statistics ?? null,
    ...(includeFitInputs ? { fitInput: projectFitInput(disposition, fit) } : {}),
  }
}

function extractAudit(raw: Observation, bindings: PacedObservationBindings) {
  const unavailable = (status: 'missing' | 'invalid' | 'unavailable', audit: Audit = null) => ({
    inference: { status, jobs: null }, audit,
  }) as const
  if (bindings.inferenceAvailable === false) return unavailable('unavailable')
  if (raw.policyAudit == null || !bindings.calibrationId || !bindings.dictionarySha256) return unavailable('missing')
  const payload = z.object({ jobs: z.unknown(), resourceLimited: z.boolean(), warmup: z.unknown().optional() }).safeParse(raw.policyAudit)
  if (!payload.success || !Array.isArray(raw.timeline)) return unavailable('invalid')
  const checked = inferenceAuditSchema.safeParse({
    version: 1, solver: 'typescript-f64', calibrationId: bindings.calibrationId, policySha256: bindings.policySha256,
    dictionarySha256: bindings.dictionarySha256, jobs: payload.data.jobs, resourceLimited: payload.data.resourceLimited,
    warmup: payload.data.warmup ?? undefined, transitions: raw.timeline, closureEvidenceMissing: raw.closureEvidenceMissing,
  })
  if (!checked.success || !checked.data.transitions) return unavailable('invalid')
  const { jobs, transitions, resourceLimited } = checked.data
  if (transitions.some(([, , timeUs]) => timeUs > bindings.terminalUs) || jobs.some((job) =>
    job.decisionReplay && job.decisionReplay.result.calibrationId !== bindings.calibrationId)) return unavailable('invalid')
  const audited = new Map(jobs.map((job) => [job.jobId, job]))
  const committed = new Set(transitions.filter(([kind]) => kind === 'committed').map(([, jobId]) => jobId))
  const audit = { audited, committed }
  const spatialEvaluation = summarizeSpatialEvaluation(audit, bindings.spatialEvaluationSha256)
  if (spatialEvaluation === null) return unavailable('invalid')
  const budgets = z.array(budgetSchema).max(MAX_AUDITED_JOBS).safeParse(raw.budgets ?? [])
  const fit = z.array(fitSchema).max(MAX_AUDITED_JOBS).safeParse(raw.fitEvidence ?? [])
  if (!budgets.success || !fit.success) return unavailable('invalid', audit)
  const budgetById = indexRows(budgets.data, audited)
  const fitById = indexRows(fit.data, audited)
  if (!budgetById || !fitById || fit.data.some((entry) => !fitMatchesAudit(entry, audited.get(entry.jobId)!))
    || budgets.data.some((row) => !timingMatchesAudit(row, audited.get(row.jobId)!))) return unavailable('invalid', audit)
  const schedule = readPacedSchedule(transitions, audited)
  if (!schedule) return unavailable('invalid', audit)
  const pageTimings = readPacedPageTimings(raw.provisionalByJob, schedule, audited, budgetById)
  if (!pageTimings) return unavailable('invalid', audit)
  const requestsById = new Map(schedule.map((request) => [request.jobId, request]))
  const rows = transitions.flatMap(([kind, jobId, atUs]) => kind === 'admitted'
    ? [extractJob(requestsById.get(jobId)!, atUs, audited.get(jobId), budgetById.get(jobId),
      pageTimings.get(jobId), fitById.get(jobId), bindings.includeFitInputs)]
    : [])
  return { inference: { status: 'observed' as const, jobs: rows, resourceLimited: resourceLimited ?? false,
    closureEvidenceMissing: raw.closureEvidenceMissing, schedule, workload: summarizePacedWorkload(schedule, rows),
    ...(spatialEvaluation ? { spatialEvaluation } : {}) }, audit }
}

function timingMatchesAudit(row: z.infer<typeof budgetSchema>, job: InferenceAuditJob): boolean {
  return row.stopReason === job.stopReason && row.closure === (job.closure ?? null)
    && (row.finalPageMs === null) === (row.finalDisposition === null)
    && (row.finalDisposition === null || row.finalDisposition === (job.closure ?? 'committed'))
    && (row.wallRoundTripMs === null || row.finalPageMs === null
      || row.wallRoundTripMs - row.finalPageMs <= CROSS_CONTEXT_CLOCK_SKEW_MS)
    && (row.provisionalMs === null || job.provisional !== undefined)
    && (row.provisionalMs === null || row.finalPageMs === null || row.provisionalMs <= row.finalPageMs)
}

type Trace = z.infer<typeof pacedDecisionTraceSchema>

function matchesClock(row: { jobId: string; observedThroughUs: number; finishedAtUs: number; controlRevision: number }, job: InferenceAuditJob) {
  const result = job.decisionReplay?.result
  return result && row.jobId === result.jobId && row.observedThroughUs === result.observedThroughUs
    && row.finishedAtUs === result.finishedAtUs && row.controlRevision === result.controlRevision
}

function validatePublications(trace: Trace, audit: Audit, spatialPin?: string | null): boolean {
  const first = new Map<string, Trace['transitions'][number]>()
  let lastSeq = -1
  let lastTime = -1
  for (const transition of trace.transitions) {
    const { seq, publicationUs, status, visible, phase, result, provisionalJobId } = transition
    if (seq <= lastSeq || publicationUs < lastTime) return false
    lastSeq = seq
    lastTime = publicationUs
    if (result) {
      const job = audit?.audited.get(result.jobId)
      if (!job || !audit?.committed.has(result.jobId) || !matchesClock(result, job) || publicationUs < result.finishedAtUs) return false
    }
    if (status !== 'supported') continue
    if (!result || !visible || !['running', 'paused', 'completed'].includes(phase) || provisionalJobId !== null) return false
    if (!first.has(result.jobId)) first.set(result.jobId, transition)
  }
  return first.size === trace.firstVisibleSupports.length && new Set(trace.firstVisibleSupports.map(({ jobId }) => jobId)).size === first.size
    && trace.firstVisibleSupports.every((support) => {
      const transition = first.get(support.jobId)
      const job = audit?.audited.get(support.jobId)
      const result = job?.decisionReplay?.result
      return transition?.seq === support.seq && transition.publicationUs === support.publicationUs && job && matchesClock(support, job)
        && (spatialPin === undefined || spatialPin !== null && spatialEnvelopeApplied(job, spatialPin))
        && result?.searchComplete && result.fitQuality === 'good' && result.availability === 'available'
        && result.hypotheses.some(({ model, completed, support }) => model === 'ML' && completed && support === 'compatible')
        && JSON.stringify(result.compatibleRegions) === JSON.stringify(support.regions)
    })
}

function extractPublications(raw: Observation, bindings: PacedObservationBindings, audit: Audit) {
  const unavailable = (status: Exclude<Trace['status'], 'observed'> | 'missing' | 'invalid') => ({
    publications: { status, firstVisibleSupports: null }, publicStatusTransitions: null,
  }) as const
  if (raw.publicDiagnosticTrace == null) return unavailable('missing')
  const parsed = pacedDecisionTraceSchema.safeParse(raw.publicDiagnosticTrace)
  if (!parsed.success) return unavailable('invalid')
  const trace = parsed.data
  if (trace.status !== 'observed') return unavailable(trace.status)
  if (trace.terminalSnapshot?.phase !== bindings.phase || trace.terminalSnapshot.timeUs !== bindings.terminalUs
    || !validatePublications(trace, audit, bindings.spatialEvaluationSha256)) return unavailable('invalid')
  return { publications: { status: 'observed' as const, firstVisibleSupports: trace.firstVisibleSupports },
    publicStatusTransitions: trace.transitions }
}

export function extractPacedObservation(value: unknown, bindings: PacedObservationBindings) {
  const parsed = observationSchema.safeParse(value)
  if (!parsed.success || parsed.data.phase !== bindings.phase || parsed.data.timeUs !== bindings.terminalUs) return {
    ...cusumFailure('invalid'), inference: { status: 'invalid' as const, jobs: null },
    publications: { status: 'invalid' as const, firstVisibleSupports: null }, publicStatusTransitions: null,
  }
  const observation = parsed.data
  const { inference, audit } = extractAudit(observation, bindings)
  return {
    ...extractCusum(observation, bindings), inference, ...extractPublications(observation, bindings, audit),
  }
}
