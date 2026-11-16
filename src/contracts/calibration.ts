import { z } from 'zod';
import {
  bankVersionSchema,
  modelVersionSchema,
  profileIdSchema,
  schemaVersionSchema,
  sensorProfileIdSchema,
} from './model';
import { parseBoundedJson } from './scenario';

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const releaseScopeSchema = z.enum(['passive', 'full']);

const noiseChannelSchema = z.strictObject({
  sigmaSI: z.number().positive(),
  rho: z.number().gt(-1).lt(1),
}).readonly();

const noiseSchema = z.strictObject({
  P1: noiseChannelSchema,
  P2: noiseChannelSchema,
  P3: noiseChannelSchema,
  Qin: noiseChannelSchema,
}).readonly();

export const calibrationHashesSchema = z.strictObject({
  model: sha256Schema,
  profile: sha256Schema,
  bank: sha256Schema,
  sensor: sha256Schema,
  policy: sha256Schema,
  dictionary: sha256Schema,
  fit: sha256Schema,
  calibration: sha256Schema,
  development: sha256Schema,
}).readonly();

const cusumThreshold = z.number().int().min(2).max(200);

export const calibrationSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  calibrationId: sha256Schema,
  modelVersion: modelVersionSchema,
  profileId: profileIdSchema,
  bankVersion: bankVersionSchema,
  sensorProfileId: sensorProfileIdSchema.exclude(['none']),
  hashes: calibrationHashesSchema,
  releaseScope: releaseScopeSchema,
  noise: noiseSchema,
  thresholds: z.strictObject({
    cusumFast: cusumThreshold,
    cusumSlow: cusumThreshold,
    improvement: z.number(),
    separation: z.number(),
    absoluteFit: z.number().nonnegative(),
    profile: z.number().nonnegative(),
    envelope: z.number().nonnegative(),
  }).readonly(),
  errorEnvelope: z.strictObject({
    numericalFloor: z.number().nonnegative(),
    multiplier: z.literal([1, 1.25, 1.5, 2, 3, 4]),
    qualified: z.boolean(),
    spatialArtifactSha256: sha256Schema.optional(),
  }).readonly(),
  qualification: z.strictObject({
    quantitative: z.boolean(),
    active: z.boolean(),
  }).readonly(),
  reportHash: sha256Schema,
}).refine((artifact) => !artifact.qualification.active || (
  artifact.releaseScope === 'full' && artifact.qualification.quantitative
  && artifact.errorEnvelope.qualified
), { message: 'Active qualification requires a qualified full release and error envelope' })
  .refine((artifact) => artifact.errorEnvelope.spatialArtifactSha256 === undefined
    || (artifact.errorEnvelope.qualified && artifact.qualification.quantitative),
  { message: 'Pinned spatial envelope requires quantitative and envelope qualification' }).readonly();

export type Calibration = z.infer<typeof calibrationSchema>;

export function parseCalibration(text: string): Calibration {
  return calibrationSchema.parse(parseBoundedJson(text));
}
