import { z } from 'zod';
import { calibrationSchema } from './calibration';
import {
  diagnosticJobSchema,
  diagnosticResultSchema,
  experimentProposalSchema,
} from './inference';
import {
  modeSchema,
  modelTimeSchema,
  profileSchema,
  schemaVersionSchema,
} from './model';
import {
  commandMetaSchema,
  counterSchema,
  dataAvailabilitySchema,
  idSchema,
  publicBatchSchema,
  sensorIdSchema,
} from './public';

const emptySchema = z.strictObject({}).readonly();
const reasonCodeSchema = z.string().min(1).max(120).regex(/^[a-z][a-z0-9-]*$/);

export function envelopeSchema<const Kind extends string, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload,
) {
  return z.strictObject({
    schemaVersion: schemaVersionSchema,
    runId: idSchema,
    transportSeq: counterSchema,
    kind: z.literal(kind),
    payload,
  }).readonly();
}

const modelInitSchema = z.strictObject({
  profile: profileSchema,
  calibration: calibrationSchema.nullable(),
}).readonly();

const scheduledCommandSchema = commandMetaSchema.unwrap().extend({
  expectedControlRevision: counterSchema,
});

const leakParameters = {
  positionM: z.number().positive(),
  cdAreaM2: z.number().min(0).max(4e-5),
  openingUs: modelTimeSchema.max(20_000_000),
};

const sensorFaultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bias'), offsetSI: z.number() }),
  z.strictObject({ kind: z.enum(['dropout', 'stuck-zero', 'clear']) }),
]).readonly();

export const simulationCommandSchema = z.discriminatedUnion('kind', [
  envelopeSchema('init', modelInitSchema),
  envelopeSchema('start', commandMetaSchema),
  envelopeSchema('pause', commandMetaSchema),
  envelopeSchema('set-control', scheduledCommandSchema.extend({
    kind: z.literal('outlet-flow'),
    valueSI: z.number().positive(),
    rampUs: modelTimeSchema,
  }).readonly()),
  envelopeSchema('inject-leak', scheduledCommandSchema.extend(leakParameters).readonly()),
  envelopeSchema('set-sensor-fault', scheduledCommandSchema.extend({
    sensorId: sensorIdSchema,
    fault: sensorFaultSchema,
  }).readonly()),
  envelopeSchema('accept-experiment', scheduledCommandSchema.extend({ proposalId: idSchema }).readonly()),
  envelopeSchema('request-frame', z.strictObject({ previousFrameSeq: counterSchema.nullable() }).readonly()),
  envelopeSchema('export', commandMetaSchema),
  envelopeSchema('reveal', commandMetaSchema),
]);

export const runStatusSchema = z.strictObject({
  phase: z.enum([
    'initializing', 'ready', 'warming-up', 'running', 'paused',
    'replay-wait', 'finalizing', 'completed', 'invalid', 'error',
  ]),
  mode: modeSchema,
  timeUs: modelTimeSchema,
  armedAtUs: modelTimeSchema.nullable(),
  challengeElapsedUs: modelTimeSchema,
  pacing: z.number().positive(),
  lagMs: z.number().nonnegative(),
  dataAvailability: dataAvailabilitySchema,
}).refine((status) => status.challengeElapsedUs === (status.armedAtUs === null
  ? 0 : Math.max(0, status.timeUs - status.armedAtUs)), {
  path: ['challengeElapsedUs'],
  message: 'Challenge clock must derive from model time and arming time',
}).readonly();

export const commandAckSchema = z.strictObject({
  commandId: idSchema,
  status: z.enum(['accepted', 'rejected']),
  appliedTimeUs: modelTimeSchema.nullable(),
  reasonCode: reasonCodeSchema,
  controlRevision: counterSchema,
}).refine((ack) => ack.status !== 'rejected' || ack.appliedTimeUs === null, {
  path: ['appliedTimeUs'],
  message: 'Rejected commands cannot apply',
}).readonly();

const fieldBuffer = z.instanceof(Float64Array).refine(
  (values) => values.length >= 2 && values.length <= 401 && values.every(Number.isFinite),
);
const fieldFrameSchema = z.strictObject({
  timeUs: modelTimeSchema,
  frameSeq: counterSchema,
  pressurePa: fieldBuffer,
  oilTemperatureK: fieldBuffer,
  wallTemperatureK: fieldBuffer,
}).refine((frame) => frame.pressurePa.length === frame.oilTemperatureK.length + 1
  && frame.oilTemperatureK.length === frame.wallTemperatureK.length).readonly();

const errorSchema = z.strictObject({
  reasonCode: reasonCodeSchema,
  message: z.string().min(1).max(512),
}).readonly();

const reportSchema = z.strictObject({
  timeUs: modelTimeSchema,
  reveal: z.boolean(),
  revealedLeak: z.strictObject({ ...leakParameters, appliedTimeUs: modelTimeSchema }).readonly().nullable(),
}).refine((report) => report.reveal || report.revealedLeak === null, {
  path: ['revealedLeak'],
  message: 'Truth requires explicit reveal',
}).readonly();

export const simulationMessageSchema = z.discriminatedUnion('kind', [
  envelopeSchema('ready', runStatusSchema),
  envelopeSchema('ack', commandAckSchema),
  envelopeSchema('public-summary', publicBatchSchema),
  envelopeSchema('field-frame', fieldFrameSchema),
  envelopeSchema('alarm', z.strictObject({ timeUs: modelTimeSchema, status: z.enum(['open', 'closed']) }).readonly()),
  envelopeSchema('diagnosis', diagnosticResultSchema),
  envelopeSchema('proposal', experimentProposalSchema),
  envelopeSchema('report', reportSchema),
  envelopeSchema('status', runStatusSchema),
  envelopeSchema('error', errorSchema),
  envelopeSchema('heartbeat', z.strictObject({ timeUs: modelTimeSchema }).readonly()),
]);

const messagePortSchema = z.custom<MessagePort>(
  (value) => typeof MessagePort !== 'undefined' && value instanceof MessagePort,
);
export const inferenceInitSchema = z.discriminatedUnion('kind', [
  envelopeSchema('init-public', modelInitSchema),
  envelopeSchema('connect-port', z.strictObject({ port: messagePortSchema }).readonly()),
]);

const jobReferenceSchema = z.strictObject({ jobId: idSchema }).readonly();
export const inferenceRequestSchema = z.discriminatedUnion('kind', [
  envelopeSchema('diagnostic-job', diagnosticJobSchema),
  envelopeSchema('continue', jobReferenceSchema),
  envelopeSchema('cancel', jobReferenceSchema),
  envelopeSchema('close', emptySchema),
]);

export const inferenceResponseSchema = z.discriminatedUnion('kind', [
  envelopeSchema('diagnostic-progress', jobReferenceSchema.unwrap().extend({
    completedEvaluations: z.number().int().min(0).max(512),
  }).readonly()),
  envelopeSchema('diagnostic-result', diagnosticResultSchema),
  envelopeSchema('experiment-proposal', experimentProposalSchema),
  envelopeSchema('error', errorSchema),
]);

export type SimulationCommand = z.infer<typeof simulationCommandSchema>;
export type SimulationMessage = z.infer<typeof simulationMessageSchema>;
export type InferenceInit = z.infer<typeof inferenceInitSchema>;
export type InferenceRequest = z.infer<typeof inferenceRequestSchema>;
export type InferenceResponse = z.infer<typeof inferenceResponseSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
