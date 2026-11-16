import type { AnchorId } from '../contracts/model'
import { PRESSURE_PERIOD_US } from '../contracts/public'
import type { Measurement, PublicBatch, PublicPrediction } from '../contracts/public'
import { prepareFit } from './hypotheses'
import type { FitChannels } from './hypotheses'

const SENSORS = ['P1', 'P2', 'P3'] as const
const PRE_FRONT_SAMPLES = 3
const POST_FRONT_SAMPLES = 2
const FRONT_WINDOW_SAMPLES = PRE_FRONT_SAMPLES + POST_FRONT_SAMPLES
const MIN_NEGATIVE_SIGMA = 4
const MIN_DROP_SIGMA = 3.5
const FRONT_SEPARATION_US = 50_000
const MAX_SENSOR_OUTAGE_US = 500_000
const MAX_FRONTS_PER_SENSOR = 8
const MAX_SAMPLES = 100_000
const METRE_EPSILON = 1e-8
type PressureSensor = typeof SENSORS[number]

export interface PressureInnovation {
  readonly sensorId: PressureSensor
  readonly sampleTimeUs: number
  readonly availableAtUs: number
  readonly innovation: number
}

export interface PressureFront {
  readonly sensorId: PressureSensor
  readonly firstSampleUs: number
  readonly availableAtUs: number
  readonly arrivalStartUs: number
  readonly arrivalEndUs: number
  readonly negativeSigma: number
}

export interface PressureWaveSettings {
  readonly sensorPositionsM: Readonly<Record<PressureSensor, number>>
  readonly waveSpeedMps: { readonly min: number; readonly max: number }
  readonly clockUncertaintyUs: number
  readonly earliestSourceUs?: number
}

interface Interval {
  readonly startM: number
  readonly endM: number
}

export interface PressureWaveResult {
  readonly status: 'consistent-front' | 'ambiguous' | 'no-distinct-front' | 'insufficient-data'
  readonly intervalM: Interval | null
  readonly reason: 'front-arrivals-consistent' | 'missing-contiguous-evidence' | 'missing-distinct-front'
    | 'too-many-fronts' | 'arrival-times-inconsistent' | 'multiple-front-associations' | 'sensor-bracket-saturated'
  readonly throughUs: number
  readonly fronts: readonly PressureFront[]
}

function isTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function pressureSensor(value: Measurement['sensorId']): value is PressureSensor {
  return value !== 'Qin'
}

function sampleKey(sensor: PressureSensor, timeUs: number): string {
  return `${sensor}/${timeUs}`
}

/**
 * Uses the S10 causal validity mask and AR(1) innovations on a fixed public anchor.
 * The comparator consumes pressure evidence only and never changes the detector.
 */
export function pressureWaveEvidence(
  batches: readonly PublicBatch[],
  throughUs: number,
  anchorId: AnchorId,
  channels: FitChannels,
): readonly PressureInnovation[] {
  if (!isTime(throughUs) || batches.length > MAX_SAMPLES) throw new RangeError('Invalid pressure-wave evidence cutoff or size.')
  const observations: Measurement[] = []
  const nominal = new Map<number, PublicPrediction>()
  const availableAt = new Map<string, number>()
  const causal = batches.filter(({ sampleTimeUs }) => sampleTimeUs <= throughUs)
    .sort((left, right) => left.sampleTimeUs - right.sampleTimeUs)
  for (const batch of causal) {
    const prediction = batch.predictions.find((item) => item.anchorId === anchorId && item.sampleTimeUs === batch.sampleTimeUs)
    if (prediction && !nominal.has(batch.sampleTimeUs)) nominal.set(batch.sampleTimeUs, prediction)
    for (const reading of batch.measurements) {
      if (!pressureSensor(reading.sensorId) || reading.deliveredTimeUs > batch.sampleTimeUs) continue
      const key = sampleKey(reading.sensorId, reading.sampleTimeUs)
      if (availableAt.has(key)) continue
      observations.push(reading)
      availableAt.set(key, batch.sampleTimeUs)
    }
  }
  const { pairs } = prepareFit(observations, channels, 0, throughUs, throughUs)
  return pairs.flatMap((pair) => {
    const { sensorId, previousTimeUs, currentTimeUs, previousSI, currentSI, rho, baselineSI, innovationScaleSI } = pair
    if (!pressureSensor(sensorId)) return []
    const index = SENSORS.indexOf(sensorId)
    const previous = nominal.get(previousTimeUs)?.pressurePa[index]
    const current = nominal.get(currentTimeUs)?.pressurePa[index]
    if (previous === undefined || current === undefined) return []
    const innovation = ((currentSI - current - baselineSI)
      - rho * (previousSI - previous - baselineSI)) / innovationScaleSI
    if (!Number.isFinite(innovation)) return []
    return [{
      sensorId, sampleTimeUs: currentTimeUs,
      availableAtUs: Math.max(availableAt.get(sampleKey(sensorId, previousTimeUs))!, availableAt.get(sampleKey(sensorId, currentTimeUs))!),
      innovation,
    }]
  })
}

function detectFronts(samples: readonly PressureInnovation[], clockUncertaintyUs: number) {
  const fronts: PressureFront[] = []
  const stable = [...new Map([...samples]
    .sort((left, right) => left.sampleTimeUs - right.sampleTimeUs || right.availableAtUs - left.availableAtUs)
    .map((sample) => [sample.sampleTimeUs, sample])).values()]
  let contiguous = 0
  let hasHistory = false
  let lastFrontUs = -Infinity
  for (const [index, sample] of stable.entries()) {
    contiguous = stable[index - 1]?.sampleTimeUs === sample.sampleTimeUs - PRESSURE_PERIOD_US ? contiguous + 1 : 1
    if (contiguous < FRONT_WINDOW_SAMPLES) continue
    hasHistory = true
    const window = stable.slice(index - FRONT_WINDOW_SAMPLES + 1, index + 1)
    const prior = window.slice(0, PRE_FRONT_SAMPLES).reduce((sum, entry) => sum + entry.innovation, 0) / PRE_FRONT_SAMPLES
    const after = window.slice(PRE_FRONT_SAMPLES).reduce((sum, entry) => sum + entry.innovation, 0) / POST_FRONT_SAMPLES
    const first = window[PRE_FRONT_SAMPLES]!
    if (after > -MIN_NEGATIVE_SIGMA || prior - after < MIN_DROP_SIGMA
      || first.innovation >= 0 || first.sampleTimeUs - lastFrontUs < FRONT_SEPARATION_US) continue
    lastFrontUs = first.sampleTimeUs
    fronts.push({
      sensorId: first.sensorId, firstSampleUs: first.sampleTimeUs, negativeSigma: -after,
      availableAtUs: Math.max(...window.map((entry) => entry.availableAtUs)),
      arrivalStartUs: Math.max(0, first.sampleTimeUs - PRESSURE_PERIOD_US - clockUncertaintyUs),
      arrivalEndUs: first.sampleTimeUs + clockUncertaintyUs,
    })
    if (fronts.length > MAX_FRONTS_PER_SENSOR) break
  }
  return { fronts, hasHistory, lastSampleUs: stable.at(-1)?.sampleTimeUs ?? -Infinity }
}

interface Affine {
  readonly intercept: number
  readonly slope: number
}

function valueAt(line: Affine, speed: number): number {
  return line.intercept + line.slope * speed
}

function crossingSpeeds(lines: readonly Affine[], speedMin: number, speedMax: number): readonly number[] {
  return lines.flatMap((first, index) => lines.slice(index + 1).flatMap((second) => {
    if (first.slope === second.slope) return []
    const crossing = (second.intercept - first.intercept) / (first.slope - second.slope)
    return crossing > speedMin && crossing < speedMax ? [crossing] : []
  }))
}

// For a source between two consecutive sensors, each TDOA interval becomes
// an affine position bound in velocity, or constrains velocity alone.
function fitSegment(
  positions: readonly number[],
  arrivals: readonly PressureFront[],
  leftIndex: number,
  speed: PressureWaveSettings['waveSpeedMps'],
  earliestSourceUs: number,
): Interval | null {
  const leftEdge = positions[leftIndex]!
  const rightEdge = positions[leftIndex + 1]!
  const lower: Affine[] = [{ intercept: leftEdge, slope: 0 }]
  const upper: Affine[] = [{ intercept: rightEdge, slope: 0 }]
  let speedMin = speed.min
  let speedMax = speed.max

  for (const [i, a] of arrivals.entries()) {
    const latestTravelUs = a.arrivalEndUs - earliestSourceUs
    if (latestTravelUs < 0) return null
    const xi = positions[i]!
    if (i <= leftIndex) upper.push({ intercept: xi, slope: latestTravelUs / 1e6 })
    else lower.push({ intercept: xi, slope: -latestTravelUs / 1e6 })
    for (const [offset, b] of arrivals.slice(i + 1).entries()) {
      const j = i + offset + 1
      const minLagUs = a.arrivalStartUs - b.arrivalEndUs
      const maxLagUs = a.arrivalEndUs - b.arrivalStartUs
      const xj = positions[j]!
      if (i <= leftIndex && j > leftIndex) {
        const intercept = (xi + xj) / 2
        lower.push({ intercept, slope: minLagUs / 2e6 })
        upper.push({ intercept, slope: maxLagUs / 2e6 })
      } else {
        const lagMin = i <= leftIndex ? minLagUs : -maxLagUs
        const lagMax = i <= leftIndex ? maxLagUs : -minLagUs
        if (lagMax <= 0) return null
        speedMin = Math.max(speedMin, (xj - xi) * 1e6 / lagMax)
        if (lagMin > 0) speedMax = Math.min(speedMax, (xj - xi) * 1e6 / lagMin)
      }
    }
  }
  for (const low of lower) {
    for (const high of upper) {
      const slope = low.slope - high.slope
      const intercept = high.intercept - low.intercept
      if (slope > 0) speedMax = Math.min(speedMax, intercept / slope)
      else if (slope < 0) speedMin = Math.max(speedMin, intercept / slope)
      else if (intercept < 0) return null
    }
  }
  if (speedMin > speedMax) return null
  const possible = [speedMin, speedMax, ...crossingSpeeds(lower, speedMin, speedMax), ...crossingSpeeds(upper, speedMin, speedMax)]
  const startM = Math.max(leftEdge, Math.min(...possible.map((v) => Math.max(...lower.map((line) => valueAt(line, v))))))
  const endM = Math.min(rightEdge, Math.max(...possible.map((v) => Math.min(...upper.map((line) => valueAt(line, v))))))
  return startM <= endM ? { startM, endM } : null
}

function associatedInterval(
  positions: readonly number[],
  arrivals: readonly PressureFront[],
  speed: PressureWaveSettings['waveSpeedMps'],
  earliestSourceUs: number,
): Interval | 'disjoint' | null {
  const left = fitSegment(positions, arrivals, 0, speed, earliestSourceUs)
  const right = fitSegment(positions, arrivals, 1, speed, earliestSourceUs)
  if (!left || !right) return left ?? right
  if (right.startM - left.endM > METRE_EPSILON) return 'disjoint'
  return { startM: left.startM, endM: right.endM }
}

export function compareNegativePressureWave(
  samples: readonly PressureInnovation[],
  throughUs: number,
  settings: PressureWaveSettings,
): PressureWaveResult {
  const positions = SENSORS.map((sensor) => settings.sensorPositionsM[sensor])
  const speed = settings.waveSpeedMps
  const earliestSourceUs = settings.earliestSourceUs ?? 0
  if (!isTime(throughUs) || !isTime(settings.clockUncertaintyUs) || samples.length > MAX_SAMPLES
    || !isTime(earliestSourceUs) || !Number.isSafeInteger(throughUs + settings.clockUncertaintyUs)
    || positions.some((position, index) => !Number.isFinite(position) || position < 0 || index > 0 && position <= positions[index - 1]!)
    || !Number.isFinite(speed.min) || !Number.isFinite(speed.max) || speed.min <= 0 || speed.max < speed.min) {
    throw new RangeError('Invalid pressure-wave comparator bounds.')
  }
  const causal = samples.filter((sample) => sample.availableAtUs <= throughUs && sample.sampleTimeUs <= throughUs)
  if (causal.some((sample) => !SENSORS.includes(sample.sensorId)
    || !isTime(sample.sampleTimeUs) || sample.sampleTimeUs % PRESSURE_PERIOD_US !== 0
    || !isTime(sample.availableAtUs) || sample.availableAtUs < sample.sampleTimeUs || !Number.isFinite(sample.innovation))) {
    throw new RangeError('Invalid causal pressure-wave innovation.')
  }
  const channels = SENSORS.map((sensor) => detectFronts(causal.filter((sample) => sample.sensorId === sensor), settings.clockUncertaintyUs))
  const fronts = channels.flatMap((channel) => channel.fronts)
  const abstain = (status: PressureWaveResult['status'], reason: PressureWaveResult['reason']): PressureWaveResult =>
    ({ status, reason, throughUs, intervalM: null, fronts })

  if (channels.some((channel) => !channel.hasHistory || throughUs - channel.lastSampleUs > MAX_SENSOR_OUTAGE_US)) {
    return abstain('insufficient-data', 'missing-contiguous-evidence')
  }
  if (channels.some((channel) => channel.fronts.length > MAX_FRONTS_PER_SENSOR)) return abstain('ambiguous', 'too-many-fronts')
  if (channels.some((channel) => channel.fronts.length === 0)) return abstain('no-distinct-front', 'missing-distinct-front')

  let match: { readonly intervalM: Interval; readonly fronts: readonly PressureFront[] } | null = null
  for (const left of channels[0]!.fronts) {
    for (const middle of channels[1]!.fronts) {
      for (const right of channels[2]!.fronts) {
        const arrivalFronts = [left, middle, right]
        const intervalM = associatedInterval(positions, arrivalFronts, speed, earliestSourceUs)
        if (!intervalM) continue
        if (intervalM === 'disjoint' || match) return abstain('ambiguous', 'multiple-front-associations')
        match = { intervalM, fronts: arrivalFronts }
      }
    }
  }
  if (!match) return abstain('ambiguous', 'arrival-times-inconsistent')
  if (match.intervalM.startM - positions[0]! <= METRE_EPSILON || positions[2]! - match.intervalM.endM <= METRE_EPSILON) {
    return abstain('ambiguous', 'sensor-bracket-saturated')
  }
  return { status: 'consistent-front', reason: 'front-arrivals-consistent', throughUs, ...match }
}
