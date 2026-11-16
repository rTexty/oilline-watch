import type { DiagnosticJob } from '../contracts/inference'
import type { AnchorId } from '../contracts/model'
import { PRESSURE_PERIOD_US } from '../contracts/public'
import type { SensorId } from '../contracts/public'
import { DICTIONARY_CHANNELS, DICTIONARY_NODES, MAX_DICTIONARY_BYTES, responseDictionaryManifestSchema } from '../contracts/response-dictionary'
import type { CandidatePrediction, FitEvidence } from './hypotheses'
import { MAX_CD_AREA_M2, MAX_OUTLET_FRACTION, OPENINGS_US } from './optimizer'
import type { CandidateBounds, DisturbanceCandidate, RankedTrial } from './optimizer'
import { prefixResponseRange, prefixSurrogateLowerScore } from './spatial-surrogate'

const CHANNEL_INDEX = { P1: 0, P2: 1, P3: 2, Qin: 3 } as const
const CHANNELS = DICTIONARY_CHANNELS
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

export type ResponseTrace =
  | { readonly model: 'ML'; readonly anchorId: AnchorId; readonly node: number; readonly stepResponse: Float64Array }
  | { readonly model: 'MB'; readonly anchorId: AnchorId; readonly stepResponse: Float64Array }

export interface ResponseDictionary {
  readonly profileId: DiagnosticJob['profileId']
  readonly modelVersion: DiagnosticJob['modelVersion']
  readonly bankVersion: DiagnosticJob['bankVersion']
  readonly anchorParameterHashes: readonly string[]
  readonly traces: readonly ResponseTrace[]
}

const verifiedDictionaries = new WeakMap<ResponseDictionary, {
  readonly hash: string
  readonly ranges: ReadonlyMap<number, ReturnType<typeof prefixResponseRange>> | null
}>()

export function verifiedDictionaryDigest(dictionary: ResponseDictionary): string | undefined {
  return verifiedDictionaries.get(dictionary)?.hash
}

export function verifiedSpatialLowerScore(
  dictionary: ResponseDictionary, anchorId: AnchorId, node: number, rows: readonly ScreeningRow[], firstOnsetUs: number,
): number | null {
  const ranges = verifiedDictionaries.get(dictionary)?.ranges
  if (!ranges) return null
  const lower = DICTIONARY_NODES.findLast((item) => item <= node)
  const upper = DICTIONARY_NODES.find((item) => item >= node)
  if (lower === undefined || upper === undefined) return null
  const a = ranges.get(anchorId * 200 + lower)
  const b = ranges.get(anchorId * 200 + upper)
  return a && b ? prefixSurrogateLowerScore(a, b, upper === lower ? 0 : (node - lower) / (upper - lower), rows, firstOnsetUs) : null
}

export async function loadResponseDictionary(
  rawManifest: unknown,
  data: ArrayBuffer,
  expectedDataSha256: string,
  { prepareSpatialProfile = false } = {},
): Promise<ResponseDictionary | null> {
  if (!LITTLE_ENDIAN || !(data instanceof ArrayBuffer) || data.byteLength > MAX_DICTIONARY_BYTES) return null
  const parsed = responseDictionaryManifestSchema.safeParse(rawManifest)
  if (!parsed.success || parsed.data.dataSha256 !== expectedDataSha256) return null
  const manifest = parsed.data
  const valuesPerTrace = manifest.traces[0]!.sampleCount * CHANNELS
  const bytesPerTrace = valuesPerTrace * Float64Array.BYTES_PER_ELEMENT
  if (data.byteLength !== bytesPerTrace * manifest.traces.length) return null
  // The spatial proof may not alias a buffer the caller can mutate while hashing.
  const backing = prepareSpatialProfile ? data.transferToFixedLength() : data
  const digest = await crypto.subtle.digest('SHA-256', backing)
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== expectedDataSha256) return null
  const traces = manifest.traces.map((descriptor, index): ResponseTrace => {
    const stepResponse = new Float64Array(backing, index * bytesPerTrace, valuesPerTrace)
    return descriptor.model === 'ML'
      ? { model: 'ML', anchorId: descriptor.anchorId, node: descriptor.node, stepResponse }
      : { model: 'MB', anchorId: descriptor.anchorId, stepResponse }
  })
  const dictionary = Object.freeze({
    profileId: manifest.profileId, modelVersion: manifest.modelVersion, bankVersion: manifest.bankVersion,
    anchorParameterHashes: manifest.anchorParameterHashes, traces: Object.freeze(traces.map((trace) => Object.freeze(trace))),
  })
  const ranges = prepareSpatialProfile
    ? new Map(traces.flatMap((trace) => trace.model === 'ML'
      ? [[trace.anchorId * 200 + trace.node, prefixResponseRange(trace)] as const] : []))
    : null
  verifiedDictionaries.set(dictionary, { hash: actual, ranges })
  return dictionary
}

export interface PreparedResponse {
  readonly trace: ResponseTrace
  readonly integrated: Float64Array
  readonly lastSampleUs: number
}

export function screeningNodes(lastNode: number): readonly number[] {
  if (lastNode === 199) return DICTIONARY_NODES
  const nodes = Array.from({ length: Math.ceil(lastNode / 5) }, (_, index) => 1 + 5 * index)
  return [...new Set([...nodes, lastNode])]
}

export function screeningOnsets(bounds: CandidateBounds, windowUs: number): readonly number[] {
  const stepUs = windowUs === 4_000_000 ? 250_000 : 1_000_000
  const times = Array.from({ length: Math.ceil((bounds.lastOnsetUs - bounds.firstOnsetUs) / stepUs) },
    (_, index) => bounds.firstOnsetUs + index * stepUs)
  return times
}

function responseKey(trace: ResponseTrace): string {
  return trace.model === 'ML' ? `ML/${trace.anchorId}/${trace.node}` : `MB/${trace.anchorId}`
}

export function prepareDictionary(
  dictionary: ResponseDictionary | undefined,
  job: DiagnosticJob,
  bounds: CandidateBounds,
): readonly ResponseTrace[] | null {
  const requiredDurationUs = job.windowEndUs - bounds.firstOnsetUs
  const nodes = new Set(screeningNodes(bounds.lastNode))
  if (!dictionary || dictionary.profileId !== job.profileId || dictionary.modelVersion !== job.modelVersion
    || dictionary.bankVersion !== job.bankVersion || dictionary.anchorParameterHashes.length !== job.checkpointsByAnchor.length
    || dictionary.traces.length !== (nodes.size + 1) * job.checkpointsByAnchor.length
    || dictionary.anchorParameterHashes.some((hash, index) => hash !== job.checkpointsByAnchor[index]?.parameterHash)) return null

  const entries = new Set<string>()
  for (const trace of dictionary.traces) {
    const key = responseKey(trace)
    if (!(trace.stepResponse instanceof Float64Array)) return null
    const size = trace.stepResponse.length
    const lastSampleUs = (size / CHANNELS - 1) * PRESSURE_PERIOD_US
    if (entries.has(key) || !job.checkpointsByAnchor[trace.anchorId] || (trace.model === 'ML' && !nodes.has(trace.node))
      || size % CHANNELS !== 0
      || lastSampleUs < requiredDurationUs || lastSampleUs > 34_000_000 || !trace.stepResponse.every(Number.isFinite)) return null
    entries.add(key)
  }
  return dictionary.traces
}

export function prepareResponse(trace: ResponseTrace): PreparedResponse {
  const size = trace.stepResponse.length
  const integrated = new Float64Array(size)
  for (let index = CHANNELS; index < size; index++) {
    integrated[index] = integrated[index - CHANNELS]!
      + (trace.stepResponse[index - CHANNELS]! + trace.stepResponse[index]!) * PRESSURE_PERIOD_US / 2
  }
  return { trace, integrated, lastSampleUs: (size / CHANNELS - 1) * PRESSURE_PERIOD_US }
}

function sampleAtIndex(response: PreparedResponse, index: number, offsetUs: number, integrate: boolean): number {
  const first = response.trace.stepResponse[index]!
  const last = response.trace.stepResponse[index + CHANNELS] ?? first
  const interpolated = first + (last - first) * offsetUs / PRESSURE_PERIOD_US
  return integrate ? response.integrated[index]! + (first + interpolated) * offsetUs / 2 : interpolated
}

function sampledResponse(response: PreparedResponse, sensorId: SensorId, elapsedUs: number, integrate: boolean): number {
  if (elapsedUs < 0) return 0
  const timeUs = Math.min(response.lastSampleUs, elapsedUs)
  const sample = Math.floor(timeUs / PRESSURE_PERIOD_US)
  const offsetUs = timeUs - sample * PRESSURE_PERIOD_US
  return sampleAtIndex(response, CHANNELS * sample + CHANNEL_INDEX[sensorId], offsetUs, integrate)
}

export function unitResponse(
  response: PreparedResponse,
  sensorId: SensorId,
  timeUs: number,
  onsetUs: number,
  openingUs: number,
): number {
  const elapsedUs = timeUs - onsetUs
  if (openingUs === 0) return sampledResponse(response, sensorId, elapsedUs, false)
  return (sampledResponse(response, sensorId, elapsedUs, true)
    - sampledResponse(response, sensorId, elapsedUs - openingUs, true)) / openingUs
}

/** Native table entries have a whole tick inside the response and an aligned opening. */
export function unitResponseAtNativeTick(
  response: PreparedResponse,
  sensorId: SensorId,
  tick: number,
  openingUs: typeof OPENINGS_US[number],
): number {
  const index = CHANNELS * tick + CHANNEL_INDEX[sensorId]
  if (openingUs === 0) return sampleAtIndex(response, index, 0, false)
  const openingTicks = openingUs / PRESSURE_PERIOD_US
  const previous = tick >= openingTicks ? sampleAtIndex(response, index - CHANNELS * openingTicks, 0, true) : 0
  return (sampleAtIndex(response, index, 0, true) - previous) / openingUs
}

export interface ScreeningRow {
  readonly sensorId: SensorId
  readonly previousTimeUs: number
  readonly currentTimeUs: number
  readonly rho: number
  readonly scale: number
  readonly residual: number
}

export function screeningRows(evidence: FitEvidence, nominal: CandidatePrediction): readonly ScreeningRow[] | null {
  const rows: ScreeningRow[] = []
  for (const pair of evidence.pairs) {
    const prior = nominal(pair.sensorId, pair.previousTimeUs)
    const current = nominal(pair.sensorId, pair.currentTimeUs)
    if (prior === undefined || current === undefined) return null
    const residual = (pair.currentSI - current - pair.baselineSI
      - pair.rho * (pair.previousSI - prior - pair.baselineSI)) / pair.innovationScaleSI
    rows.push({
      sensorId: pair.sensorId, previousTimeUs: pair.previousTimeUs, currentTimeUs: pair.currentTimeUs,
      rho: pair.rho, scale: pair.innovationScaleSI, residual,
    })
  }
  return rows
}

export function screenCandidate(
  response: PreparedResponse,
  rows: readonly ScreeningRow[],
  onsetUs: number,
  openingUs: typeof OPENINGS_US[number],
  nominalFlowM3s: number,
): (RankedTrial & { readonly candidate: DisturbanceCandidate }) | null {
  let numerator = 0
  let denominator = 0
  let baseline = 0
  for (const row of rows) {
    const responseNow = unitResponse(response, row.sensorId, row.currentTimeUs, onsetUs, openingUs)
    const responsePrior = unitResponse(response, row.sensorId, row.previousTimeUs, onsetUs, openingUs)
    const weight = (responseNow - row.rho * responsePrior) / row.scale
    numerator += weight * row.residual
    denominator += weight ** 2
    baseline += row.residual ** 2
  }
  return screeningCandidateFromSums(response.trace, onsetUs, openingUs, nominalFlowM3s, numerator, denominator, baseline)
}

export function screeningCandidateFromSums(
  trace: ResponseTrace,
  onsetUs: number,
  openingUs: typeof OPENINGS_US[number],
  nominalFlowM3s: number,
  numerator: number,
  denominator: number,
  baseline: number,
): (RankedTrial & { readonly candidate: DisturbanceCandidate }) | null {
  if (denominator <= 0 || ![numerator, denominator, baseline].every(Number.isFinite)) return null

  const { anchorId } = trace
  const lower = trace.model === 'ML' ? 0 : -MAX_OUTLET_FRACTION * nominalFlowM3s
  const upper = trace.model === 'ML' ? MAX_CD_AREA_M2 : MAX_OUTLET_FRACTION * nominalFlowM3s
  const amplitude = Math.max(lower, Math.min(upper, numerator / denominator))
  const candidate: DisturbanceCandidate = trace.model === 'ML'
    ? { model: 'ML', anchorId, node: trace.node, cdAreaM2: amplitude, onsetUs, openingUs }
    : { model: 'MB', anchorId, amplitudeM3s: amplitude, onsetUs, openingUs }
  const score = Math.max(0, baseline - 2 * amplitude * numerator + amplitude ** 2 * denominator)
  return Number.isFinite(score) ? { candidate, score } : null
}
