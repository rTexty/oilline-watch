import { z } from 'zod'
import { sha256Schema } from './calibration'
import { bankVersionSchema, modelTimeSchema, modelVersionSchema, profileIdSchema } from './model'
import type { AnchorId, BANK_VERSION, FluidProfile, MODEL_VERSION } from './model'
import { counterSchema, FLOW_PERIOD_US, PRESSURE_PERIOD_US } from './public'
import type { AppliedControl } from './public'

export const NOMINAL_PREDICTION_CACHE_VERSION = 'typescript-f64/native-v1'
export const NOMINAL_ANCHOR_COUNT = 9
export const NOMINAL_PRESSURE_CHANNELS = 3
const MAX_PRESSURE_VALUES = 3001 * NOMINAL_ANCHOR_COUNT * NOMINAL_PRESSURE_CHANNELS
const MAX_FLOW_VALUES = 601 * NOMINAL_ANCHOR_COUNT
export const MAX_NOMINAL_PREDICTION_CACHE_BYTES = (MAX_PRESSURE_VALUES + MAX_FLOW_VALUES) * Float64Array.BYTES_PER_ELEMENT

function finiteBuffer(maxLength: number) {
  return z.instanceof(Float64Array).refine((buffer) => buffer.length <= maxLength
    && buffer.buffer instanceof ArrayBuffer && buffer.byteLength === buffer.buffer.byteLength && buffer.every(Number.isFinite))
}

export const nominalPredictionCacheSchema = z.strictObject({
  version: z.literal(NOMINAL_PREDICTION_CACHE_VERSION),
  modelVersion: modelVersionSchema,
  profileId: profileIdSchema,
  bankVersion: bankVersionSchema,
  windowStartUs: modelTimeSchema,
  windowEndUs: modelTimeSchema,
  checkpointTimeUs: modelTimeSchema,
  checkpointControlRevision: counterSchema,
  controlRevision: counterSchema,
  controlKey: z.string().max(256_000),
  parameterHashes: z.array(sha256Schema).length(NOMINAL_ANCHOR_COUNT).readonly(),
  pressurePa: finiteBuffer(MAX_PRESSURE_VALUES),
  inletFlowM3s: finiteBuffer(MAX_FLOW_VALUES),
}).readonly()

export type NominalPredictionCache = z.infer<typeof nominalPredictionCacheSchema>

export interface NominalPredictionJobIdentity {
  readonly modelVersion: typeof MODEL_VERSION
  readonly profileId: FluidProfile['profileId']
  readonly bankVersion: typeof BANK_VERSION
  readonly windowStartUs: number
  readonly windowEndUs: number
  readonly controlRevision: number
  readonly appliedControls: readonly AppliedControl[]
  readonly checkpointsByAnchor: readonly {
    readonly anchorId: AnchorId; readonly timeUs: number; readonly controlRevision: number; readonly parameterHash: string
  }[]
}

export function firstNominalTick(startUs: number, periodUs: number): number {
  return Math.ceil(startUs / periodUs) * periodUs
}

export function nominalTickCount(startUs: number, endUs: number, periodUs: number): number {
  return Math.max(0, Math.floor(endUs / periodUs) - Math.ceil(startUs / periodUs) + 1)
}

export function nominalControlKey(controls: readonly AppliedControl[]): string {
  return JSON.stringify(controls.map((control) => [
    control.eventOrdinal, control.commandId, control.appliedTimeUs, control.controlRevision, control.kind,
    ...(control.kind === 'outlet-flow' ? [control.valueSI, control.rampUs]
      : [control.pulse.deltaOutletFlowM3s, control.pulse.rampUs, control.pulse.holdUs, control.pulse.returnUs]),
  ]))
}

export function nominalPredictionCacheBytes(cache: Pick<NominalPredictionCache, 'pressurePa' | 'inletFlowM3s'>): number {
  return cache.pressurePa.byteLength + cache.inletFlowM3s.byteLength
}

export function nominalPredictionCacheMatches(cache: NominalPredictionCache, job: NominalPredictionJobIdentity): boolean {
  const { windowStartUs: start, windowEndUs: end } = job
  return cache.version === NOMINAL_PREDICTION_CACHE_VERSION && cache.profileId === job.profileId
    && cache.modelVersion === job.modelVersion && cache.bankVersion === job.bankVersion
    && cache.windowStartUs === start && cache.windowEndUs === end
    && end >= start && cache.controlRevision === job.controlRevision
    && cache.controlKey === nominalControlKey(job.appliedControls)
    && cache.pressurePa.length === nominalTickCount(start, end, PRESSURE_PERIOD_US) * NOMINAL_ANCHOR_COUNT * NOMINAL_PRESSURE_CHANNELS
    && cache.inletFlowM3s.length === nominalTickCount(start, end, FLOW_PERIOD_US) * NOMINAL_ANCHOR_COUNT
    && job.checkpointsByAnchor.length === NOMINAL_ANCHOR_COUNT
    && job.checkpointsByAnchor.every((checkpoint, index) =>
      checkpoint.anchorId === index && checkpoint.timeUs === cache.checkpointTimeUs
      && checkpoint.controlRevision === cache.checkpointControlRevision && checkpoint.parameterHash === cache.parameterHashes[index])
}
