import { PRESSURE_PERIOD_US } from '../contracts/public'
import { DICTIONARY_CHANNELS } from '../contracts/response-dictionary'
import { MAX_CD_AREA_M2 } from './optimizer'
import type { ResponseTrace, ScreeningRow } from './screening'

const CHANNEL_INDEX = { P1: 0, P2: 1, P3: 2, Qin: 3 } as const
// Widen the relaxed intervals for F64 interpolation and integrated ramp roundoff.
// The release dictionary holds at most 3401 samples, with ramps of at least 1 s.
const ROUNDING_MARGIN = 1e-8
const PREFIX_BLOCK_SAMPLES = 25

interface PrefixResponseRange {
  readonly minimum: Float64Array
  readonly maximum: Float64Array
  readonly samples: number
}

export function spatialPrefixBytes(samples: number, traceCount: number): number {
  return Math.ceil(samples / PREFIX_BLOCK_SAMPLES) * DICTIONARY_CHANNELS
    * 2 * Float64Array.BYTES_PER_ELEMENT * traceCount
}

export function prefixResponseRange(trace: ResponseTrace): PrefixResponseRange {
  const { stepResponse } = trace
  const samples = stepResponse.length / DICTIONARY_CHANNELS
  const elements = Math.ceil(samples / PREFIX_BLOCK_SAMPLES) * DICTIONARY_CHANNELS
  const minimum = new Float64Array(elements)
  const maximum = new Float64Array(elements)
  for (let index = 0; index < stepResponse.length; index++) {
    const element = Math.floor(index / (DICTIONARY_CHANNELS * PREFIX_BLOCK_SAMPLES)) * DICTIONARY_CHANNELS
      + index % DICTIONARY_CHANNELS
    minimum[element] = Math.min(stepResponse[index]!, minimum[element]!, minimum[element - DICTIONARY_CHANNELS] ?? 0)
    maximum[element] = Math.max(stepResponse[index]!, maximum[element]!, maximum[element - DICTIONARY_CHANNELS] ?? 0)
  }
  return { minimum, maximum, samples }
}

function rangeOffset(trace: PrefixResponseRange, timeUs: number, channel: number): number {
  const sample = Math.min(trace.samples - 1, Math.max(0, Math.ceil(timeUs / PRESSURE_PERIOD_US)))
  return Math.floor(sample / PREFIX_BLOCK_SAMPLES) * DICTIONARY_CHANNELS + channel
}

function intervalDistance(row: ScreeningRow, minNow: number, maxNow: number, minPrior: number, maxPrior: number): number {
  const prior1 = row.rho * minPrior
  const prior2 = row.rho * maxPrior
  const scale = MAX_CD_AREA_M2 / row.scale
  const margin = ROUNDING_MARGIN * (Math.abs(row.residual)
    + scale * (Math.max(-minNow, maxNow) + Math.max(Math.abs(prior1), Math.abs(prior2))))
  const min = Math.min(0, (minNow - Math.max(prior1, prior2)) * scale) - margin
  const max = Math.max(0, (maxNow - Math.min(prior1, prior2)) * scale) + margin
  return Math.max(0, min - row.residual, row.residual - max)
}

// Every allowed step value lies inside its reachable prefix. A ramp is an
// average over that same prefix with zero extension. Relaxing the shared
// onset and amplitude independently for each row can only lower the score.
export function prefixSurrogateLowerScore(
  lower: PrefixResponseRange, upper: PrefixResponseRange, fraction: number,
  rows: readonly ScreeningRow[], firstOnsetUs: number,
): number {
  let score = 0
  const complement = 1 - fraction
  for (const row of rows) {
    const channel = CHANNEL_INDEX[row.sensorId]
    const nowUs = row.currentTimeUs - firstOnsetUs
    const priorUs = row.previousTimeUs - firstOnsetUs
    const ln = rangeOffset(lower, nowUs, channel)
    const un = rangeOffset(upper, nowUs, channel)
    const lp = rangeOffset(lower, priorUs, channel)
    const up = rangeOffset(upper, priorUs, channel)
    const distance = intervalDistance(row,
      complement * lower.minimum[ln]! + fraction * upper.minimum[un]!,
      complement * lower.maximum[ln]! + fraction * upper.maximum[un]!,
      complement * lower.minimum[lp]! + fraction * upper.minimum[up]!,
      complement * lower.maximum[lp]! + fraction * upper.maximum[up]!,
    )
    score += distance * distance
  }
  return score * (1 - ROUNDING_MARGIN)
}
