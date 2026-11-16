import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { Measurement, SensorId } from '../contracts/public'
import type { HydraulicState } from '../physics/state'
import { expandSeed, nextNormal, nextUniform } from './random'
import type { NormalState, Seed } from './random'
import { faultedReading } from './sensor-faults'
import type { SensorFaults } from './sensor-faults'
import { ADVERSE_MAX_DELIVERY_DELAY_US } from './telemetry-delivery'

export { setSensorFault } from './sensor-faults'
export type { SensorFault, SensorFaultChange, SensorFaults } from './sensor-faults'

export const sensorIds = ['P1', 'P2', 'P3', 'Qin'] as const
const STUCK_OBSERVATIONS = 3
const ADVERSE_DROPOUT_RATE = 0.01
const NOMINAL_NOISE = { pressure: { sigma: 500, rho: 0.6 }, flow: { sigma: 0.00005, rho: 0.3 } }
const ADVERSE_NOISE = { pressure: { sigma: 1000, rho: 0.85 }, flow: { sigma: 0.0001, rho: 0.6 } }

interface SensorState {
  readonly normal: NormalState
  readonly deliverySeed: Seed
  readonly error: number | null
  readonly nextSeq: number
  readonly lastSampleTimeUs: number | null
  readonly lastValueSI: number | null
  readonly lastInstrumentValueSI: number | null
  readonly identicalObservations: number
}

export type Sensors = readonly SensorState[]

export type SensorStreams = Readonly<Record<SensorId, { readonly noise: Seed; readonly delivery: Seed }>>

function initialSensor(noise: Seed, deliverySeed: Seed): SensorState {
  return {
    normal: { seed: noise, spare: null }, deliverySeed,
    error: null, nextSeq: 0, lastSampleTimeUs: null, lastValueSI: null, lastInstrumentValueSI: null,
    identicalObservations: 0,
  }
}

export function initializeSensors(seed: number): Sensors {
  return sensorIds.map((_, index) => initialSensor(expandSeed(seed, index), expandSeed(seed, sensorIds.length + index)))
}

function ownSeed(seed: Seed): Seed {
  if (!Array.isArray(seed) || seed.length !== 4 || !seed.every((word) =>
    Number.isInteger(word) && word >= 0 && word <= 0xffff_ffff) || seed.every((word) => word === 0)) {
    throw new RangeError('Invalid telemetry seed')
  }
  return [seed[0], seed[1], seed[2], seed[3]]
}

export function initializeSensorsFromStreams(streams: SensorStreams): Sensors {
  return sensorIds.map((id) => {
    const channel = streams[id]
    if (!channel) throw new RangeError('Missing telemetry seed')
    return initialSensor(ownSeed(channel.noise), ownSeed(channel.delivery))
  })
}

function reading(state: HydraulicState, id: SensorId): number {
  if (id === 'Qin') return state.qR[0]!
  const fraction = id === 'P1' ? 0.1 : id === 'P2' ? 0.5 : 0.9
  const point = (state.p.length - 1) * fraction
  const lower = Math.floor(point)
  const upper = Math.ceil(point)
  return state.p[lower]! + (point - lower) * (state.p[upper]! - state.p[lower]!)
}

function classifyReading(
  state: HydraulicState,
  flow: boolean,
  valueSI: number | null,
  identicalObservations: number,
): Measurement['quality'] {
  if (valueSI === null) return 'missing'
  if (!Number.isFinite(valueSI)) return 'out-of-range'
  if (identicalObservations >= STUCK_OBSERVATIONS) return 'stuck'
  const { pressureMinPa, pressureMaxPa } = state.profile.definition.limits
  return flow || (valueSI >= pressureMinPa && valueSI <= pressureMaxPa) ? 'valid' : 'out-of-range'
}

function countIdentical(sensor: SensorState, valueSI: number | null, timeUs: number, periodUs: number): number {
  if (valueSI === null || !Number.isFinite(valueSI)) return 0
  const adjacent = sensor.lastSampleTimeUs !== null && timeUs - sensor.lastSampleTimeUs === periodUs
  return adjacent && valueSI === sensor.lastValueSI ? Math.min(STUCK_OBSERVATIONS, sensor.identicalObservations + 1) : 1
}

function delivery(seed: Seed, adverse: boolean) {
  if (!adverse) return { seed, dropout: false, delayUs: 0 }
  const dropout = nextUniform(seed)
  const jitter = nextUniform(dropout.seed)
  return {
    seed: jitter.seed,
    dropout: dropout.value < ADVERSE_DROPOUT_RATE,
    delayUs: Math.floor(jitter.value * (ADVERSE_MAX_DELIVERY_DELAY_US + 1)),
  }
}

export function sampleSensors(state: HydraulicState, previous: Sensors, faults?: SensorFaults) {
  const adverse = state.profile.definition.sensorProfileId === 'synthetic-oil-adverse-v1'
  const noise = adverse ? ADVERSE_NOISE : NOMINAL_NOISE
  const measurements: Measurement[] = []
  const sensors = previous.map((sensor, index) => {
    const sensorId = sensorIds[index]!
    const flow = sensorId === 'Qin'
    const periodUs = flow ? FLOW_PERIOD_US : PRESSURE_PERIOD_US
    if (state.timeUs % periodUs !== 0 || (sensor.lastSampleTimeUs !== null && state.timeUs <= sensor.lastSampleTimeUs)) return sensor
    const { sigma, rho } = noise[flow ? 'flow' : 'pressure']
    const normal = nextNormal(sensor.normal)
    const error = sensor.error === null
      ? sigma * normal.value
      : rho * sensor.error + sigma * Math.sqrt(1 - rho * rho) * normal.value
    const transport = delivery(sensor.deliverySeed, adverse)
    const instrumentValue = faultedReading(reading(state, sensorId) + error, faults?.[sensorId], state.timeUs)
    const valueSI = transport.dropout ? null : instrumentValue
    const identicalObservations = countIdentical(sensor, valueSI, state.timeUs, periodUs)
    const quality = classifyReading(state, flow, valueSI, identicalObservations)
    const finiteValueSI = valueSI !== null && Number.isFinite(valueSI) ? valueSI : null
    measurements.push({
      sensorId, sampleSeq: sensor.nextSeq, sampleTimeUs: state.timeUs, deliveredTimeUs: state.timeUs + transport.delayUs,
      valueSI: finiteValueSI, quality,
    })
    return {
      normal: normal.state, deliverySeed: transport.seed, error,
      nextSeq: sensor.nextSeq + 1, lastSampleTimeUs: state.timeUs,
      lastValueSI: finiteValueSI, identicalObservations,
      lastInstrumentValueSI: instrumentValue !== null && Number.isFinite(instrumentValue) ? instrumentValue : null,
    }
  })
  return { sensors, measurements }
}
