import { z } from 'zod'
import { calibrationHashesSchema, calibrationSchema } from '../contracts/calibration'
import { diagnosticResultSchema, provisionalDiagnosticSchema } from '../contracts/inference'
import { modelTimeSchema, profileIdSchema } from '../contracts/model'
import { idSchema, publicSampleSchema, sensorIdSchema } from '../contracts/public'
import { responseDictionaryPackageSchema } from '../contracts/response-dictionary'
import { replaySchema, replaySensorFaultSchema } from './replay-schema'
import { inferenceMemorySnapshotSchema } from './inference-port'

const paceSchema = z.literal([1, 4])
const identity = { schemaVersion: z.literal(1), runId: idSchema }
const command = { ...identity, seq: z.number().int().nonnegative() }

export const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...command, kind: z.literal('start'), profileId: profileIdSchema, port: z.instanceof(MessagePort), pace: paceSchema,
    replay: replaySchema.optional(),
    diagnosticRelease: z.strictObject({
      calibration: calibrationSchema, expectedHashes: calibrationHashesSchema, dictionary: responseDictionaryPackageSchema.optional(),
    }).optional(),
  }),
  z.strictObject({ ...command, kind: z.literal('leak'), positionM: z.number().min(0).max(1000), cdAreaM2: z.number().gt(0).max(4e-5), openingUs: modelTimeSchema.max(20_000_000) }),
  z.strictObject({ ...command, kind: z.literal('outlet'), outletFlowM3s: z.number().positive() }),
  z.strictObject({ ...command, kind: z.literal('sensor-fault'), sensorId: sensorIdSchema, fault: replaySensorFaultSchema }),
  z.strictObject({ ...command, kind: z.literal('pace'), pace: paceSchema }),
  z.strictObject({ ...command, kind: z.literal('accept-experiment'), proposalId: idSchema }),
  z.strictObject({ ...command, kind: z.enum(['pause', 'resume', 'reveal']) }),
])
export type Command = z.infer<typeof commandSchema>
export type Control = Command extends infer C ? C extends Command ? Omit<C, keyof typeof command> : never : never

const leakReportSchema = z.strictObject({
  positionM: z.number(), cdAreaM2: z.number(), openingUs: modelTimeSchema, timeUs: modelTimeSchema,
}).readonly()

export const runSnapshotSchema = z.strictObject({
  profileId: profileIdSchema,
  phase: z.enum(['warming-up', 'running', 'paused', 'replay-wait', 'finalizing', 'completed', 'invalid', 'error']),
  timeUs: modelTimeSchema,
  armedAtUs: modelTimeSchema.nullable(),
  samples: z.array(publicSampleSchema).max(4).readonly(),
  prediction: z.array(z.number()).max(4).readonly(),
  residualPa: z.array(z.number().nullable()).max(3).readonly(),
  residualTimeUs: modelTimeSchema.nullable(),
  temperatures: z.strictObject({ oilInK: z.number(), oilOutK: z.number(), wallOutK: z.number() }).readonly(),
  message: z.string().max(500).nullable(),
  appliedTimeUs: modelTimeSchema.nullable(),
  leakStatus: z.enum(['idle', 'pending', 'applied', 'rejected']),
  diagnostic: z.strictObject({
    availability: z.enum(['insufficient-history', 'available', 'missing']),
    explanation: z.string().max(500),
    qualified: z.boolean().optional(),
    alarmAtUs: modelTimeSchema.nullable().optional(),
    alarmOpen: z.boolean().optional(),
    historical: z.boolean().optional(),
    result: diagnosticResultSchema.nullable().optional(),
    provisional: provisionalDiagnosticSchema.optional(),
    provisionalHistorical: z.boolean().optional(),
  }).readonly().nullable(),
  numericalMemory: z.strictObject({
    limitBytes: modelTimeSchema,
    reservedBytes: modelTimeSchema,
    highWaterBytes: modelTimeSchema,
  }).refine(({ limitBytes, reservedBytes, highWaterBytes }) =>
    reservedBytes <= highWaterBytes && highWaterBytes <= limitBytes).readonly().optional(),
  inferenceNumericalMemory: inferenceMemorySnapshotSchema.optional(),
  truth: leakReportSchema.nullable(),
  replay: replaySchema.nullable(),
  replaying: z.boolean(),
  replayVerification: z.enum(['simulation-only', 'pending', 'verified', 'partial', 'diverged']).optional(),
}).readonly()

export type RunSnapshot = z.infer<typeof runSnapshotSchema>

export const snapshotMessageSchema = z.strictObject({
  ...identity, seq: z.number().int().nonnegative(), snapshot: runSnapshotSchema,
})
