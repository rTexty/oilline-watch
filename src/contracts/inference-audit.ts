import { z } from 'zod'
import { sha256Schema } from './calibration'
import { diagnosticResultSchema, provisionalDiagnosticSchema, stopReasonSchema } from './inference'
import { anchorIdSchema, modelTimeSchema } from './model'
import { idSchema, PRESSURE_PERIOD_US } from './public'

const score = z.number().nonnegative().nullable()
const opening = z.literal([0, 1_000_000, 20_000_000])

export const cpuTrialSchema = z.union([
  z.tuple([z.literal('M0'), anchorIdSchema, score]).readonly(),
  z.tuple([z.literal('ML'), anchorIdSchema, z.number().int().min(1).max(399),
    z.number().min(0).max(4e-5), modelTimeSchema, opening, score]).readonly(),
  z.tuple([z.literal('MB'), anchorIdSchema, z.number(), modelTimeSchema, opening, score]).readonly(),
])

export type CpuTrial = z.infer<typeof cpuTrialSchema>

export const MAX_AUDITED_TRIALS = 65_536
export const MAX_AUDITED_JOBS = 1000
export const MAX_AUDIT_TRANSITIONS = 4096

export const inverseTimingSchema = z.strictObject({
  wallStopCheck: z.number().int().positive().max(1_000_000).nullable(),
  cancelStopCheck: z.number().int().positive().max(1_000_000).nullable().optional(),
  incompleteTrialOrdinal: z.number().int().min(0).max(511).nullable().optional(),
  dictionaryLoaded: z.boolean(),
  spatialEnvelopeSha256: sha256Schema.optional(),
  nominalCacheHits: z.number().int().min(0).max(9).optional(),
}).readonly()

export const inverseDecisionReplaySchema = inverseTimingSchema.unwrap().extend({
  result: diagnosticResultSchema,
}).readonly()

export type InverseDecisionReplay = z.infer<typeof inverseDecisionReplaySchema>

const pressureTimeSchema = modelTimeSchema.multipleOf(PRESSURE_PERIOD_US)
const closureTimeSchema = modelTimeSchema.multipleOf(PRESSURE_PERIOD_US / 2)
export const provisionalCheckpointSchema = z.strictObject({
  check: z.number().int().positive().max(1_000_000),
  result: provisionalDiagnosticSchema,
}).readonly()

export const inverseProvisionalAuditSchema = provisionalCheckpointSchema.unwrap().extend({
  publishedAtUs: pressureTimeSchema,
}).readonly()
export type InverseProvisionalAudit = z.infer<typeof inverseProvisionalAuditSchema>

function validProvisional(job: {
  readonly jobId: string; readonly startUs: number; readonly endUs: number; readonly startedAtUs: number; readonly finishedAtUs: number
  readonly completedEvaluations: number; readonly decisionReplay?: InverseDecisionReplay
  readonly provisional?: InverseProvisionalAudit
}) {
  const { provisional, decisionReplay } = job
  if (!provisional) return true
  if (!decisionReplay) return false
  const { check, publishedAtUs, result } = provisional
  const terminal = decisionReplay.result
  return publishedAtUs >= job.startedAtUs && publishedAtUs <= job.finishedAtUs
    && check < (decisionReplay.wallStopCheck ?? Infinity) && check < (decisionReplay.cancelStopCheck ?? Infinity)
    && result.jobId === job.jobId && result.observedThroughUs === job.endUs
    && result.completedEvaluations <= job.completedEvaluations
    && result.modelVersion === terminal.modelVersion && result.profileId === terminal.profileId
    && result.bankVersion === terminal.bankVersion && result.calibrationId === terminal.calibrationId
    && result.controlRevision === terminal.controlRevision
}

export const inferenceAuditJobSchema = z.strictObject({
  jobId: idSchema, startUs: pressureTimeSchema, endUs: pressureTimeSchema,
  startedAtUs: pressureTimeSchema, finishedAtUs: closureTimeSchema,
  wallLimitMs: z.number().positive().max(5000),
  evaluationLimit: z.number().int().positive().max(512),
  stopReason: stopReasonSchema,
  closure: z.literal('discarded').optional(),
  completedEvaluations: z.number().int().min(0).max(512),
  trials: z.array(cpuTrialSchema).max(512).readonly(),
  decisionReplay: inverseDecisionReplaySchema.optional(),
  provisional: inverseProvisionalAuditSchema.optional(),
}).refine((job) => validProvisional(job) && job.startUs >= 3_000_000 && [4_000_000, 30_000_000].includes(job.endUs - job.startUs)
  && job.endUs <= job.startedAtUs && job.startedAtUs <= job.finishedAtUs
  && (job.closure !== undefined || job.finishedAtUs % PRESSURE_PERIOD_US === 0)
  && job.completedEvaluations <= job.trials.length && job.trials.length <= job.evaluationLimit
  && (!job.closure || job.decisionReplay && (job.decisionReplay.cancelStopCheck != null) === (job.stopReason === 'cancelled'))
  && (!job.decisionReplay || (job.decisionReplay.wallStopCheck !== null) === (job.stopReason === 'wall-limit')
    && (job.decisionReplay.cancelStopCheck == null || job.closure === 'discarded' && job.stopReason === 'cancelled')
    && (job.decisionReplay.spatialEnvelopeSha256 === undefined || job.decisionReplay.dictionaryLoaded)
    && (job.decisionReplay.nominalCacheHits === undefined
      || job.trials.every(([model]) => model !== 'M0') && (job.decisionReplay.nominalCacheHits === 9 || job.trials.length === 0))
    && (job.decisionReplay.incompleteTrialOrdinal == null || job.decisionReplay.incompleteTrialOrdinal === job.trials.length
      && job.trials.length < job.evaluationLimit && (job.stopReason === 'wall-limit' || job.stopReason === 'cancelled'))
    && job.decisionReplay.result.jobId === job.jobId && job.decisionReplay.result.finishedAtUs === job.finishedAtUs
    && job.decisionReplay.result.observedThroughUs === job.endUs && job.decisionReplay.result.stopReason === job.stopReason
    && job.decisionReplay.result.completedEvaluations === job.completedEvaluations)).readonly()

export type InferenceAuditJob = z.infer<typeof inferenceAuditJobSchema>

const transitionSchema = z.union([
  z.tuple([z.literal('requested'), idSchema, pressureTimeSchema, pressureTimeSchema]).readonly(),
  z.tuple([z.enum(['admitted', 'superseded', 'finished', 'committed']), idSchema, pressureTimeSchema]).readonly(),
  z.tuple([z.literal('cancelled'), idSchema, closureTimeSchema]).readonly(),
])
export type InferenceAuditTransition = z.infer<typeof transitionSchema>

const warmupReplaySchema = z.strictObject({
  anchorId: anchorIdSchema,
  frozenBaselines: z.array(z.strictObject({
    anchorId: anchorIdSchema,
    meanBySensor: z.strictObject({ P1: z.number(), P2: z.number(), P3: z.number(), Qin: z.number() }).readonly(),
  }).readonly()).length(9).readonly(),
}).refine(({ frozenBaselines }) => frozenBaselines.every((baseline, index) => baseline.anchorId === index)).readonly()
export type WarmupReplay = z.infer<typeof warmupReplaySchema>

function hasLegalTransitions(jobs: readonly InferenceAuditJob[], transitions: readonly InferenceAuditTransition[]): boolean {
  const ledger = new Map<string, { kind: InferenceAuditTransition[0]; startUs?: number; endUs: number; admittedUs?: number }>()
  const byId = new Map(jobs.map((job) => [job.jobId, job]))
  let previousTime = -1
  let accounted = 0
  let active: string | null = null
  for (const transition of transitions) {
    const [kind, id, timeUs] = transition
    if (timeUs < previousTime) return false
    previousTime = timeUs
    const before = ledger.get(id)
    if (kind === 'requested') {
      if (before || transition[3] >= timeUs) return false
      ledger.set(id, { kind, endUs: timeUs, startUs: transition[3] })
      continue
    }
    if (!before) return false
    if (kind === 'admitted' && before.kind === 'requested' && active === null) {
      active = id
      ledger.set(id, { ...before, kind, admittedUs: timeUs })
    } else if (kind === 'superseded' && before.kind === 'requested'
      || kind === 'cancelled' && (before.kind === 'requested' || before.kind === 'admitted')) {
      const job = byId.get(id)
      if (job) {
        if (kind !== 'cancelled' || job.closure !== 'discarded' || active !== id || before.kind !== 'admitted'
          || job.startUs !== before.startUs || job.endUs !== before.endUs
          || job.startedAtUs !== before.admittedUs || job.finishedAtUs !== timeUs) return false
        accounted++
      }
      if (active === id) active = null
      ledger.set(id, { ...before, kind })
    } else if (active === id && (kind === 'finished' && before.kind === 'admitted' || kind === 'committed' && before.kind === 'finished')) {
      const job = byId.get(id)
      if (!job || job.closure || job.startUs !== before.startUs || job.endUs !== before.endUs
        || job.startedAtUs !== before.admittedUs || job.finishedAtUs !== timeUs) return false
      ledger.set(id, { ...before, kind })
      if (kind === 'committed') { accounted++; active = null }
    } else return false
  }
  return accounted === jobs.length && [...ledger.values()].every(({ kind }) =>
    kind === 'committed' || kind === 'cancelled' || kind === 'superseded')
}

export const inferenceAuditSchema = z.strictObject({
  version: z.literal(1),
  solver: z.literal('typescript-f64'),
  calibrationId: sha256Schema,
  policySha256: sha256Schema,
  dictionarySha256: sha256Schema,
  jobs: z.array(inferenceAuditJobSchema).max(MAX_AUDITED_JOBS).readonly(),
  transitions: z.array(transitionSchema).max(MAX_AUDIT_TRANSITIONS).readonly().optional(),
  resourceLimited: z.boolean().optional(),
  closureEvidenceMissing: z.boolean().optional(),
  unverifiedProvisional: inverseProvisionalAuditSchema.optional(),
  warmup: warmupReplaySchema.optional(),
}).refine(({ jobs, transitions, closureEvidenceMissing, unverifiedProvisional, calibrationId }) =>
  (!unverifiedProvisional || Boolean(closureEvidenceMissing && transitions
    && unverifiedProvisional.result.calibrationId === calibrationId
    && !jobs.some((job) => job.jobId === unverifiedProvisional.result.jobId)
    && transitions.some(([kind, id, at]) => kind === 'requested' && id === unverifiedProvisional.result.jobId
      && at === unverifiedProvisional.result.observedThroughUs)
    && transitions.some(([kind, id, at]) => kind === 'admitted' && id === unverifiedProvisional.result.jobId
      && at <= unverifiedProvisional.publishedAtUs)
    && transitions.some(([kind, id, at]) => kind === 'cancelled' && id === unverifiedProvisional.result.jobId
      && at >= unverifiedProvisional.publishedAtUs)))
  && new Set(jobs.map((job) => job.jobId)).size === jobs.length
  && jobs.every((job, index) => !job.closure || transitions !== undefined && index === jobs.length - 1)
  && jobs.reduce((sum, job) => sum + job.trials.length, 0) <= MAX_AUDITED_TRIALS
  && jobs.every((job, index) => index === 0 || jobs[index - 1]!.finishedAtUs <= job.startedAtUs)
  && (!transitions || hasLegalTransitions(jobs, transitions))).readonly()
