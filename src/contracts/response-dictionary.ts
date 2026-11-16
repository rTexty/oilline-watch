import { z } from 'zod'
import { sha256Schema } from './calibration'
import { anchorIdSchema, bankVersionSchema, modelVersionSchema, schemaVersionSchema } from './model'
import { PRESSURE_PERIOD_US } from './public'

export const DICTIONARY_NODES = [...Array.from({ length: 40 }, (_, index) => 1 + 5 * index), 199] as const
export const DICTIONARY_CHANNELS = 4
const MAX_SAMPLES = 3401
const ANCHORS = 9
const TRACES_PER_ANCHOR = DICTIONARY_NODES.length + 1
const TRACE_COUNT = TRACES_PER_ANCHOR * ANCHORS
export const MAX_DICTIONARY_BYTES = TRACE_COUNT * MAX_SAMPLES * DICTIONARY_CHANNELS * Float64Array.BYTES_PER_ELEMENT

const sampleCount = z.number().int().min(2).max(MAX_SAMPLES)
const traceDescriptor = z.discriminatedUnion('model', [
  z.strictObject({ model: z.literal('ML'), anchorId: anchorIdSchema, node: z.number().int().min(1).max(199), sampleCount }).readonly(),
  z.strictObject({ model: z.literal('MB'), anchorId: anchorIdSchema, sampleCount }).readonly(),
])

export const responseDictionaryManifestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  samplePeriodUs: z.literal(PRESSURE_PERIOD_US),
  profileId: z.literal('synthetic-oil-turbulent-v1'),
  modelVersion: modelVersionSchema,
  bankVersion: bankVersionSchema,
  anchorParameterHashes: z.array(sha256Schema).length(ANCHORS).readonly(),
  dataSha256: sha256Schema,
  traces: z.array(traceDescriptor).length(TRACE_COUNT).readonly(),
}).refine((manifest) => manifest.traces.every((trace, index) => {
  const node = DICTIONARY_NODES[index % TRACES_PER_ANCHOR]
  return trace.anchorId === Math.floor(index / TRACES_PER_ANCHOR)
    && trace.sampleCount === manifest.traces[0]?.sampleCount
    && (node === undefined ? trace.model === 'MB' : trace.model === 'ML' && trace.node === node)
}), { message: 'Response dictionary must use canonical trace order and uniform sample counts' }).readonly();

export const responseDictionaryPackageSchema = z.strictObject({
  manifest: responseDictionaryManifestSchema,
  data: z.instanceof(ArrayBuffer).refine((data) => data.byteLength <= MAX_DICTIONARY_BYTES),
}).readonly()
