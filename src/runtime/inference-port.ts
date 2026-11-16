import { z } from 'zod'
import { calibrationSchema } from '../contracts/calibration'
import { cpuTrialSchema, inverseDecisionReplaySchema, inverseProvisionalAuditSchema, inverseTimingSchema, provisionalCheckpointSchema } from '../contracts/inference-audit'
import { diagnosticJobSchema, diagnosticResultSchema } from '../contracts/inference'
import { modelTimeSchema, profileSchema } from '../contracts/model'
import { idSchema } from '../contracts/public'
import { responseDictionaryPackageSchema } from '../contracts/response-dictionary'
import { NUMERICAL_MEMORY_QUOTAS } from './numerical-memory'

const identity = { schemaVersion: z.literal(1), runId: idSchema }

export const inferenceConnectionSchema = z.strictObject({ ...identity, port: z.instanceof(MessagePort) })

export const inverseRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...identity, kind: z.literal('configure'), profile: profileSchema, calibration: calibrationSchema,
    dictionary: responseDictionaryPackageSchema.optional(),
  }),
  z.strictObject({
    ...identity, kind: z.literal('inverse'), job: diagnosticJobSchema, deadlineMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ...identity, kind: z.literal('replay-inverse'), job: diagnosticJobSchema,
    trials: z.array(cpuTrialSchema).max(512).readonly(),
    decisionReplay: inverseDecisionReplaySchema.optional(),
    provisional: inverseProvisionalAuditSchema.optional(),
  }),
  z.strictObject({ ...identity, kind: z.literal('cancel-inverse'), jobId: idSchema.optional() }),
])

export type InferenceConfigure = Extract<z.output<typeof inverseRequestSchema>, { kind: 'configure' }>

const inferenceMemoryBytes = modelTimeSchema.max(NUMERICAL_MEMORY_QUOTAS.inference)
export const inferenceMemorySnapshotSchema = z.strictObject({
  limitBytes: inferenceMemoryBytes,
  reservedBytes: inferenceMemoryBytes,
  highWaterBytes: inferenceMemoryBytes,
}).refine(({ limitBytes, reservedBytes, highWaterBytes }) =>
  reservedBytes <= highWaterBytes && highWaterBytes <= limitBytes).readonly()

export const inferenceMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...identity, kind: z.literal('residual'), timeUs: modelTimeSchema,
    residualPa: z.array(z.number().nullable()).length(3).readonly(),
  }),
  z.strictObject({
    ...identity, kind: z.literal('replay-inverse-result'), jobId: idSchema, matched: z.boolean(),
    decision: diagnosticResultSchema.optional(),
    provisional: inverseProvisionalAuditSchema.optional(),
  }),
  z.strictObject({ ...identity, kind: z.literal('inverse-provisional'), checkpoint: provisionalCheckpointSchema }),
  z.strictObject({ ...identity, kind: z.literal('dictionary-unavailable'), jobId: idSchema.optional() }),
  z.strictObject({ ...identity, kind: z.literal('spatial-envelope-unavailable'), jobId: idSchema }),
  z.strictObject({ ...identity, kind: z.literal('dictionary-ready') }),
  z.strictObject({ ...identity, kind: z.literal('resource-limit'), jobId: idSchema.optional() }),
  z.strictObject({ ...identity, kind: z.literal('numerical-memory'), memory: inferenceMemorySnapshotSchema }),
  z.strictObject({
    ...identity, kind: z.literal('inverse-result'), result: diagnosticResultSchema,
    trials: z.array(cpuTrialSchema).max(512).readonly(),
    timing: inverseTimingSchema.optional(),
  }),
  z.strictObject({ ...identity, kind: z.literal('invalid-public-batch') }),
])
