import { z } from 'zod';
import { anchorIdSchema, bankVersionSchema, modelTimeSchema, modelVersionSchema, profileIdSchema } from './model';

export const PRESSURE_PERIOD_US = 10_000;
export const FLOW_PERIOD_US = 50_000;
export const ADVERSE_MAX_DELIVERY_DELAY_US = 20_000;

export const sensorIdSchema = z.enum(['P1', 'P2', 'P3', 'Qin']);
export const idSchema = z.uuid();
export const counterSchema = z.number().int().nonnegative();
export const dataAvailabilitySchema = z.enum([
  'available', 'insufficient-history', 'missing', 'stale', 'out-of-domain',
]);

export const publicSampleSchema = z.strictObject({
  sensorId: sensorIdSchema,
  sampleSeq: counterSchema,
  sampleTimeUs: modelTimeSchema,
  deliveredTimeUs: modelTimeSchema,
  valueSI: z.number().nullable(),
  quality: z.enum(['valid', 'missing', 'out-of-range', 'stuck', 'late']),
}).refine((sample) => sample.deliveredTimeUs >= sample.sampleTimeUs, {
  path: ['deliveredTimeUs'],
  message: 'Delivery cannot precede measurement',
}).refine((sample) => sample.quality === 'missing' ? sample.valueSI === null
  : sample.quality !== 'valid' || sample.valueSI !== null, {
  path: ['valueSI'],
  message: 'Missing and valid samples require null and numeric values respectively',
}).readonly();

export const publicPredictionSchema = z.strictObject({
  sampleTimeUs: modelTimeSchema,
  anchorId: anchorIdSchema,
  bankVersion: bankVersionSchema,
  pressurePa: z.tuple([z.number(), z.number(), z.number()]).readonly(),
  inletFlowM3s: z.number(),
  modelVersion: modelVersionSchema,
  profileId: profileIdSchema,
}).readonly();

export const publicBatchSchema = z.strictObject({
  sampleTimeUs: modelTimeSchema,
  measurements: z.array(publicSampleSchema).max(16).readonly(),
  predictions: z.array(publicPredictionSchema).max(9).readonly(),
}).refine((batch) => batch.predictions.every((prediction) => prediction.sampleTimeUs === batch.sampleTimeUs)
  && new Set(batch.predictions.map((prediction) => prediction.anchorId)).size === batch.predictions.length
  && batch.measurements.every((sample) => sample.deliveredTimeUs <= batch.sampleTimeUs), {
  message: 'A batch cannot contain undelivered measurements or repeated or mismatched predictions',
}).readonly();

export const pulseSchema = z.strictObject({
  deltaOutletFlowM3s: z.number().positive(),
  rampUs: z.literal(200_000),
  holdUs: z.literal(600_000),
  returnUs: z.literal(200_000),
}).readonly();

const controlMetadata = {
  eventOrdinal: counterSchema,
  commandId: idSchema,
  appliedTimeUs: modelTimeSchema,
  controlRevision: counterSchema,
};

export const appliedControlSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...controlMetadata,
    kind: z.literal('outlet-flow'),
    valueSI: z.number().positive(),
    rampUs: modelTimeSchema,
  }),
  z.strictObject({
    ...controlMetadata,
    kind: z.literal('active-pulse'),
    pulse: pulseSchema,
  }),
]).readonly();

export const commandMetaSchema = z.strictObject({
  commandId: idSchema,
  issuedWallEpochMs: z.number().nonnegative(),
}).readonly();

export type SensorId = z.infer<typeof sensorIdSchema>;
export type Measurement = z.infer<typeof publicSampleSchema>;
export type PublicPrediction = z.infer<typeof publicPredictionSchema>;
export type PublicBatch = z.infer<typeof publicBatchSchema>;
export type AppliedControl = z.infer<typeof appliedControlSchema>;
