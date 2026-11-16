import { z } from 'zod'
import { sha256Schema } from '../contracts/calibration'
import { inferenceAuditSchema } from '../contracts/inference-audit'
import { CHALLENGE_HORIZON_US, CHALLENGE_WARMUP_US, modelTimeSchema, modelVersionSchema, sensorProfileIdSchema } from '../contracts/model'
import { idSchema, PRESSURE_PERIOD_US, pulseSchema, sensorIdSchema } from '../contracts/public'

export const replaySensorFaultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bias'), offsetSI: z.number().min(-10_000).max(10_000) }),
  z.strictObject({ kind: z.enum(['dropout', 'stuck-zero', 'clear']) }),
]).readonly()

export const replayBackendSchema = z.discriminatedUnion('solver', [
  z.strictObject({ solver: z.literal('typescript-f64') }),
  z.strictObject({ solver: z.literal('wasm-f64'), variant: z.enum(['scalar', 'simd']), artifactSha256: sha256Schema }),
]).readonly()

export const replaySensorLayoutSchema = sensorProfileIdSchema.exclude(['none'])

const eventTime = modelTimeSchema.min(CHALLENGE_WARMUP_US + 5000).max(CHALLENGE_HORIZON_US).multipleOf(5000)
const pulseEventSchema = z.strictObject({
  kind: z.literal('active-pulse'), timeUs: eventTime, commandId: idSchema, proposalId: idSchema, pulse: pulseSchema,
})
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('leak'), timeUs: eventTime, positionM: z.number().min(5).max(995).multipleOf(5),
    cdAreaM2: z.number().gt(0).max(4e-5), openingUs: modelTimeSchema.max(20_000_000),
  }),
  z.strictObject({
    kind: z.literal('control'), timeUs: eventTime, outletFlowM3s: z.number().positive(),
  }),
  pulseEventSchema,
  z.strictObject({
    kind: z.literal('sensor-fault'), timeUs: eventTime, sensorId: sensorIdSchema, fault: replaySensorFaultSchema,
  }).refine((event) => event.sensorId !== 'Qin' || event.fault.kind !== 'bias' || Math.abs(event.fault.offsetSI) <= 0.001),
]).readonly()

const activeAbortSchema = z.strictObject({
  attemptedThroughUs: modelTimeSchema.max(CHALLENGE_HORIZON_US),
  code: z.enum(['outside-model-domain', 'uncertain-flow-regime', 'unsupported-physics']),
  pendingPulse: pulseEventSchema.readonly().optional(),
}).readonly()

function validTerminalClock(
  endUs: number, appliedPulse: z.infer<typeof pulseEventSchema> | undefined, abort: z.infer<typeof activeAbortSchema> | undefined,
): boolean {
  const pending = abort?.pendingPulse
  if (appliedPulse && pending) return false
  const pulse = appliedPulse ?? pending
  if (!pulse) return !abort && endUs % PRESSURE_PERIOD_US === 0
  const rampEnd = pulse.timeUs + pulse.pulse.rampUs
  const holdEnd = rampEnd + pulse.pulse.holdUs
  const pulseEnd = holdEnd + pulse.pulse.returnUs
  const knots = [pulse.timeUs, rampEnd, holdEnd, pulseEnd]
  if (pulseEnd + 3_000_000 > CHALLENGE_HORIZON_US) return false
  if (endUs % PRESSURE_PERIOD_US !== 0 && !knots.includes(endUs)) return false
  if (!abort) return true
  if (endUs >= pulseEnd + 3_000_000) return false
  if (pending && (pending.timeUs <= endUs || pending.timeUs !== (Math.floor(endUs / 5000) + 1) * 5000)) return false
  const nextSample = (Math.floor(endUs / PRESSURE_PERIOD_US) + 1) * PRESSURE_PERIOD_US
  const nextRequested = Math.min(nextSample, ...knots.filter((timeUs) => timeUs > endUs))
  return abort.attemptedThroughUs === nextRequested
}

export const replaySchema = z.strictObject({
  schemaVersion: z.literal(1),
  modelVersion: modelVersionSchema,
  profileId: z.literal('synthetic-oil-turbulent-v1'),
  randomVersion: z.literal('xoshiro128ss-v1/splitmix32-v1'),
  seed: z.number().int().min(0).max(4_294_967_295),
  hydraulicBackend: replayBackendSchema.optional(),
  sensorProfileId: replaySensorLayoutSchema.optional(),
  endedAtUs: modelTimeSchema.min(CHALLENGE_WARMUP_US).max(CHALLENGE_HORIZON_US),
  events: z.array(eventSchema).max(258).readonly(),
  activeAbort: activeAbortSchema.optional(),
  inferenceAudit: inferenceAuditSchema.optional(),
}).refine((record) => {
  if (record.events.filter((event) => event.kind === 'leak').length > 1) return false
  if (record.events.filter((event) => event.kind === 'control').length > 128
    || record.events.filter((event) => event.kind === 'sensor-fault').length > 128) return false
  const pulses = record.events.filter((event) => event.kind === 'active-pulse')
  if (pulses.length > 1) return false
  const pulse = pulses[0]
  if (!validTerminalClock(record.endedAtUs, pulse, record.activeAbort)) return false
  const pulseEnd = pulse ? pulse.timeUs + pulse.pulse.rampUs + pulse.pulse.holdUs + pulse.pulse.returnUs : 0
  const controlTimes = new Set<number>()
  if (record.inferenceAudit?.jobs.some((job) => job.finishedAtUs > record.endedAtUs
    || job.closure && job.finishedAtUs !== record.endedAtUs)) return false
  if (record.inferenceAudit?.transitions?.some((event) => event[2] > record.endedAtUs
    || event[2] % PRESSURE_PERIOD_US !== 0
      && (event[0] !== 'cancelled' || !record.activeAbort || event[2] !== record.endedAtUs))) return false
  return record.events.every((event, index) => {
    if (event.timeUs > record.endedAtUs || (index > 0 && event.timeUs < record.events[index - 1]!.timeUs)) return false
    if (pulse && event.kind !== 'active-pulse' && event.timeUs >= pulse.timeUs && event.timeUs < pulseEnd) return false
    if (event.kind === 'control') {
      if (controlTimes.has(event.timeUs)) return false
      controlTimes.add(event.timeUs)
    }
    return true
  })
}, { message: 'Invalid replay event order or count' }).readonly()

export type ReplayRecord = z.infer<typeof replaySchema>
export type ReplayEvent = ReplayRecord['events'][number]
export type ReplaySensorFault = z.infer<typeof replaySensorFaultSchema>
