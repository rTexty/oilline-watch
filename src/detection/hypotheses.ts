import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { Measurement, SensorId } from '../contracts/public'

const SENSOR_IDS = ['P1', 'P2', 'P3', 'Qin'] as const
const OPENING_DURATIONS_US = [0, 1_000_000, 20_000_000] as const
const MAX_PRESSURE_BIAS_PA = 10_000
const MAX_FLOW_BIAS_M3S = 0.001

export interface FitChannel {
  readonly sigmaSI: number
  readonly rho: number
  readonly baselineSI: number
}

export type FitChannels = Readonly<Record<SensorId, FitChannel>>
export type CandidatePrediction = (sensorId: SensorId, timeUs: number) => number | undefined

type ValidReading = Measurement & { readonly valueSI: number }

interface FitPair {
  readonly sensorId: SensorId
  readonly previousTimeUs: number
  readonly currentTimeUs: number
  readonly previousSI: number
  readonly currentSI: number
  readonly baselineSI: number
  readonly rho: number
  readonly innovationScaleSI: number
}

export interface FitEvidence {
  readonly pairs: readonly FitPair[]
}

export interface FitScore {
  readonly sumSquares: number
  readonly meanSquare: number | null
  readonly count: number
}

export interface SensorBiasFit extends FitScore {
  readonly amplitudeSI: number
}

function validTime(timeUs: number): boolean {
  return Number.isSafeInteger(timeUs) && timeUs >= 0
}

function causalReading(
  sample: Measurement,
  windowStartUs: number,
  windowEndUs: number,
  deliveredThroughUs: number,
): boolean {
  return validTime(sample.sampleTimeUs) && validTime(sample.deliveredTimeUs)
    && validTime(sample.sampleSeq)
    && sample.sampleTimeUs >= windowStartUs && sample.sampleTimeUs <= windowEndUs
    && sample.deliveredTimeUs >= sample.sampleTimeUs && sample.deliveredTimeUs <= deliveredThroughUs
}

function usableReading(reading: Measurement, periodUs: number): reading is ValidReading {
  return reading.quality === 'valid' && reading.valueSI !== null && Number.isFinite(reading.valueSI)
    && reading.deliveredTimeUs - reading.sampleTimeUs <= 2 * periodUs
}

function channelPairs(sensorId: SensorId, readings: Measurement[], channel: FitChannel): readonly FitPair[] {
  const { baselineSI, rho, sigmaSI } = channel
  const innovationScaleSI = sigmaSI * Math.sqrt(1 - rho ** 2)
  if (!Number.isFinite(baselineSI) || !Number.isFinite(innovationScaleSI) || innovationScaleSI <= 0) {
    throw new RangeError(`Invalid fit calibration for ${sensorId}.`)
  }
  const periodUs = sensorId === 'Qin' ? FLOW_PERIOD_US : PRESSURE_PERIOD_US
  readings.sort((left, right) => left.sampleSeq - right.sampleSeq || left.deliveredTimeUs - right.deliveredTimeUs)
  const pairs: FitPair[] = []
  let lastSeq = -1
  let previous: ValidReading | undefined
  for (const reading of readings) {
    if (lastSeq === reading.sampleSeq) continue
    lastSeq = reading.sampleSeq
    if (!usableReading(reading, periodUs)) {
      previous = undefined
      continue
    }
    if (previous && previous.sampleSeq + 1 === reading.sampleSeq
      && reading.sampleTimeUs - previous.sampleTimeUs === periodUs) {
      pairs.push(Object.freeze({
        sensorId, baselineSI, rho, innovationScaleSI,
        previousTimeUs: previous.sampleTimeUs, previousSI: previous.valueSI,
        currentTimeUs: reading.sampleTimeUs, currentSI: reading.valueSI,
      }))
    }
    previous = reading
  }
  return pairs
}

export function prepareFit(
  observations: readonly Measurement[],
  channels: FitChannels,
  windowStartUs: number,
  windowEndUs: number,
  deliveredThroughUs: number,
): FitEvidence {
  if (!validTime(windowStartUs) || !validTime(windowEndUs) || !validTime(deliveredThroughUs)
    || windowStartUs > windowEndUs) throw new RangeError('Invalid fit window or causal cutoff.')

  const eligible: Record<SensorId, Measurement[]> = { P1: [], P2: [], P3: [], Qin: [] }
  for (const sample of observations) {
    if (causalReading(sample, windowStartUs, windowEndUs, deliveredThroughUs)) eligible[sample.sensorId].push(sample)
  }
  const pairs = SENSOR_IDS.flatMap((sensorId) => channelPairs(sensorId, eligible[sensorId], channels[sensorId]))
  return Object.freeze({ pairs: Object.freeze(pairs) })
}

function innovation(pair: FitPair, predict: CandidatePrediction): number | null {
  const previous = predict(pair.sensorId, pair.previousTimeUs)
  const current = predict(pair.sensorId, pair.currentTimeUs)
  if (previous === undefined || current === undefined || !Number.isFinite(previous) || !Number.isFinite(current)) {
    return null
  }
  const priorResidual = pair.previousSI - previous - pair.baselineSI
  const currentResidual = pair.currentSI - current - pair.baselineSI
  const value = (currentResidual - pair.rho * priorResidual) / pair.innovationScaleSI
  return Number.isFinite(value) ? value : null
}

function fitScore(sumSquares: number, count: number): FitScore | null {
  if (!Number.isFinite(sumSquares)) return null
  return { sumSquares, count, meanSquare: count === 0 ? null : sumSquares / count }
}

export function scoreCandidate(evidence: FitEvidence, predict: CandidatePrediction): FitScore | null {
  let sumSquares = 0
  for (const pair of evidence.pairs) {
    const residual = innovation(pair, predict)
    if (residual === null) return null
    sumSquares += residual ** 2
  }
  return fitScore(sumSquares, evidence.pairs.length)
}

function unitOpening(timeUs: number, onsetUs: number, openingUs: number): number {
  if (timeUs < onsetUs) return 0
  return openingUs === 0 ? 1 : Math.min(1, (timeUs - onsetUs) / openingUs)
}

function biasWeight(pair: FitPair, onsetUs: number, openingUs: number): number {
  const current = unitOpening(pair.currentTimeUs, onsetUs, openingUs)
  const previous = unitOpening(pair.previousTimeUs, onsetUs, openingUs)
  return (current - pair.rho * previous) / pair.innovationScaleSI
}

interface BiasSpan {
  readonly start: number
  end: number
  readonly unaffectedByFirst: Map<number, number>
}

interface BiasWorkspace {
  readonly pairs: readonly FitPair[]
  readonly residuals: readonly number[]
  readonly prefixSquares: readonly number[]
  readonly weights: number[]
}

function validBiasCandidate(onsetUs: number, openingUs: number): boolean {
  return validTime(onsetUs) && OPENING_DURATIONS_US.some((duration) => duration === openingUs)
}

function scorePreparedBias(
  workspace: BiasWorkspace, span: BiasSpan, sensorId: SensorId, onsetUs: number, openingUs: number,
): SensorBiasFit | null {
  const { pairs, residuals, prefixSquares, weights } = workspace
  const { start, end, unaffectedByFirst } = span
  let unaffectedSquares = prefixSquares[start]!
  let numerator = 0
  let denominator = 0
  let firstAffected = end
  let affectedCount = 0
  for (let index = start; index < end; index++) {
    const pair = pairs[index]!
    const residual = residuals[index]!
    const weight = pair.sensorId === sensorId ? biasWeight(pair, onsetUs, openingUs) : 0
    weights[index] = weight
    if (weight === 0) {
      unaffectedSquares += residual ** 2
    } else {
      if (affectedCount === 0) firstAffected = index
      affectedCount++
      numerator += weight * residual
      denominator += weight ** 2
    }
  }
  if (denominator === 0 || !Number.isFinite(denominator) || !Number.isFinite(numerator)) return null

  // With no gaps after the first affected row, the unaffected terms are a
  // prefix and a tail. Cache their original-order sum across opening times.
  const contiguous = end - firstAffected === affectedCount
  const cached = contiguous ? unaffectedByFirst.get(firstAffected) : undefined
  if (cached === undefined) {
    for (let index = end; index < pairs.length; index++) unaffectedSquares += residuals[index]! ** 2
    if (contiguous) unaffectedByFirst.set(firstAffected, unaffectedSquares)
  } else {
    unaffectedSquares = cached
  }

  const boundSI = sensorId === 'Qin' ? MAX_FLOW_BIAS_M3S : MAX_PRESSURE_BIAS_PA
  const amplitudeSI = Math.min(boundSI, Math.max(-boundSI, numerator / denominator))
  let squares = unaffectedSquares
  for (let index = firstAffected; index < end; index++) {
    const weight = weights[index]!
    if (weight !== 0) squares += (residuals[index]! - amplitudeSI * weight) ** 2
  }
  const score = fitScore(squares, pairs.length)
  return score && { ...score, amplitudeSI }
}

export function prepareSensorBiasFit(
  evidence: FitEvidence,
  predict: CandidatePrediction,
): ((sensorId: SensorId, onsetUs: number, openingUs: number) => SensorBiasFit | null) | null {
  const { pairs } = evidence
  const residuals: number[] = []
  const prefixSquares = [0]
  const spans = new Map<SensorId, BiasSpan>()
  for (const [index, pair] of pairs.entries()) {
    const residual = innovation(pair, predict)
    if (residual === null) return null
    residuals.push(residual)
    prefixSquares.push(prefixSquares[index]! + residual ** 2)
    const span = spans.get(pair.sensorId)
    if (span) span.end = index + 1
    else spans.set(pair.sensorId, { start: index, end: index + 1, unaffectedByFirst: new Map() })
  }

  const workspace: BiasWorkspace = { pairs, residuals, prefixSquares, weights: [] }
  return (sensorId, onsetUs, openingUs) => {
    const span = spans.get(sensorId)
    return span && validBiasCandidate(onsetUs, openingUs)
      ? scorePreparedBias(workspace, span, sensorId, onsetUs, openingUs) : null
  }
}

export function fitSensorBias(
  evidence: FitEvidence,
  predict: CandidatePrediction,
  sensorId: SensorId,
  onsetUs: number,
  openingUs: number,
): SensorBiasFit | null {
  if (!validBiasCandidate(onsetUs, openingUs)) return null
  return prepareSensorBiasFit(evidence, predict)?.(sensorId, onsetUs, openingUs) ?? null
}
