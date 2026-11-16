import { CHALLENGE_WARMUP_US } from '../contracts/model'
import type { AnchorId } from '../contracts/model'
import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { PublicBatch, SensorId } from '../contracts/public'
import { sensorResidual } from './residual'

const ANCHORS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const
const CHANNELS = ['P1', 'P2', 'P3', 'Qin'] as const
const SELECTION_END_US = 20_000_000

interface Moments {
  readonly count: number
  readonly mean: number
  readonly squared: number
}

type Channels<T> = Readonly<Record<SensorId, T>>
type Segment = readonly Channels<Moments>[]
type Noise = Channels<{ readonly sigmaSI: number }>

interface Warmup {
  readonly lastUs: number
  readonly selection: Segment
  readonly baseline: Segment
}

function channelMap<T>(make: (id: SensorId) => T): Channels<T> {
  return { P1: make('P1'), P2: make('P2'), P3: make('P3'), Qin: make('Qin') }
}

function moments(): Segment {
  return ANCHORS.map(() => channelMap(() => ({ count: 0, mean: 0, squared: 0 })))
}

export function initialWarmup(): Warmup {
  return { lastUs: -1, selection: moments(), baseline: moments() }
}

function updateMoment(previous: Moments, value: number): Moments {
  const count = previous.count + 1
  const delta = value - previous.mean
  const mean = previous.mean + delta / count
  return { count, mean, squared: previous.squared + delta * (value - mean) }
}

function period(id: SensorId): number {
  return id === 'Qin' ? FLOW_PERIOD_US : PRESSURE_PERIOD_US
}

export function updateWarmup(previous: Warmup, batch: PublicBatch, noise: Noise, availableThroughUs = batch.sampleTimeUs): Warmup {
  if (batch.sampleTimeUs <= previous.lastUs || previous.lastUs >= CHALLENGE_WARMUP_US) return previous
  const next = { ...previous, lastUs: batch.sampleTimeUs }
  if (batch.sampleTimeUs >= CHALLENGE_WARMUP_US) return next
  const stage = batch.sampleTimeUs < SELECTION_END_US ? 'selection' : 'baseline'
  const observations = channelMap((id) => batch.measurements.find((reading) => reading.sensorId === id
    && reading.sampleTimeUs % period(id) === 0))
  const updated = ANCHORS.map((anchorId) => {
    const prediction = batch.predictions.find((entry) => entry.anchorId === anchorId)
    const prior = previous[stage][anchorId]!
    if (!prediction) return prior
    return channelMap((id) => {
      const observation = observations[id]
      const residual = observation ? sensorResidual(observation, prediction, availableThroughUs) : null
      if (residual === null) return prior[id]
      const sigma = noise[id].sigmaSI
      if (!Number.isFinite(sigma) || sigma <= 0) throw new RangeError('Invalid sensor noise scale.')
      return updateMoment(prior[id], stage === 'selection' ? residual / sigma : residual)
    })
  })
  return { ...next, [stage]: updated }
}

function sufficient(segment: Segment, durationUs: number): boolean {
  return segment.every((anchor) => CHANNELS.every((id) => anchor[id].count >= 0.95 * durationUs / period(id)))
}

export function freezeWarmup(state: Warmup): {
  readonly anchorId: AnchorId
  readonly frozenBaselines: readonly { readonly anchorId: AnchorId; readonly meanBySensor: Channels<number> }[]
} | null {
  if (state.lastUs < CHALLENGE_WARMUP_US || !sufficient(state.selection, SELECTION_END_US)
    || !sufficient(state.baseline, CHALLENGE_WARMUP_US - SELECTION_END_US)) return null
  const score = (anchorId: AnchorId) => CHANNELS.reduce((sum, id) => sum + state.selection[anchorId]![id].squared, 0)
  const anchorId = ANCHORS.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best, 0 as AnchorId)
  const frozenBaselines = ANCHORS.map((id) => ({
    anchorId: id,
    meanBySensor: channelMap((sensor) => state.baseline[id]![sensor].mean),
  }))
  return { anchorId, frozenBaselines }
}
