import { z } from 'zod';
import {
  CHALLENGE_HORIZON_US,
  CHALLENGE_WARMUP_US,
  modelTimeSchema,
  modelVersionSchema,
  profileIdSchema,
  schemaVersionSchema,
} from './model';
import { counterSchema, sensorIdSchema } from './public';
import { parseBoundedJson } from './scenario';

export const randomVersionSchema = z.literal('xoshiro128ss-v1');

const seedWordSchema = z.number().int().min(0).max(0xffff_ffff);
export const seedSchema = z.tuple([seedWordSchema, seedWordSchema, seedWordSchema, seedWordSchema])
  .refine((state) => state.some((word) => word !== 0), { message: 'All-zero PRNG state is invalid' })
  .readonly();

const sensorSeedsSchema = z.strictObject({
  P1: seedSchema,
  P2: seedSchema,
  P3: seedSchema,
  Qin: seedSchema,
}).readonly();

const eventFields = {
  timeUs: modelTimeSchema.min(CHALLENGE_WARMUP_US).max(CHALLENGE_HORIZON_US),
  eventOrdinal: counterSchema,
};

export const leakEventSchema = z.strictObject({
  ...eventFields,
  kind: z.literal('leak'),
  positionM: z.number().positive().lt(1000),
  cdAreaM2: z.number().min(0).max(4e-5),
  openingUs: modelTimeSchema.max(20_000_000),
}).readonly();

const biasEventSchema = z.strictObject({
  ...eventFields,
  kind: z.literal('sensor-bias'),
  sensorId: sensorIdSchema,
  offsetSI: z.number(),
});

const sensorStateEventSchema = z.strictObject({
  ...eventFields,
  kind: z.enum(['sensor-dropout', 'sensor-stuck-zero', 'sensor-clear']),
  sensorId: sensorIdSchema,
});

export const privateEventSchema = z.discriminatedUnion('kind', [
  leakEventSchema,
  biasEventSchema,
  sensorStateEventSchema,
]).readonly();

export const privateScenarioSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  profileId: profileIdSchema,
  modelVersion: modelVersionSchema,
  randomVersion: randomVersionSchema,
  seeds: z.strictObject({ plant: seedSchema, scenario: seedSchema, sensors: sensorSeedsSchema }).readonly(),
  events: z.array(privateEventSchema).max(1000).readonly(),
}).refine((scenario) => scenario.profileId === 'synthetic-oil-turbulent-v1' || scenario.events.length === 0, {
  path: ['events'],
  message: 'Hidden events are restricted to the turbulent challenge',
}).refine((scenario) => scenario.events.filter((event) => event.kind === 'leak').length <= 1, {
  path: ['events'],
  message: 'At most one internal withdrawal is supported',
}).refine((scenario) => scenario.events.every((event, index, events) => {
  const previous = events[index - 1];
  return previous === undefined
    || (event.timeUs >= previous.timeUs && event.eventOrdinal > previous.eventOrdinal);
}), {
  path: ['events'],
  message: 'Events must be ordered by model time and increasing event ordinal',
}).readonly();

export type PrivateSeed = z.infer<typeof seedSchema>;
export type PrivateEvent = z.infer<typeof privateEventSchema>;
export type PrivateScenario = z.infer<typeof privateScenarioSchema>;

export function parsePrivateScenario(text: string): PrivateScenario {
  return privateScenarioSchema.parse(parseBoundedJson(text));
}
