import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { publicSampleSchema } from '../../src/contracts/public'
import { initialize } from '../../src/physics/initialize'
import { advanceTo } from '../../src/physics/advance-to'
import { setSensorFault } from '../../src/plant/sensor-faults'
import { initializeSensors, sampleSensors } from '../../src/plant/sensors'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'

function stateAt(timesUs: readonly number[]) {
  const initialized = initialize(profileSchema.parse(rawProfile))
  if (!initialized.ok) throw initialized.error
  return timesUs.map((timeUs) => {
    const advanced = advanceTo(initialized.value, timeUs)
    if (!advanced.ok) throw advanced.error
    return advanced.value
  })
}

describe('hidden sensor faults', () => {
  it('adds a bias without revealing a fault label or disturbing other channels', () => {
    const [hydraulic] = stateAt([10_000])
    const seed = initializeSensors(123)
    const normal = sampleSensors(hydraulic!, seed)
    const faults = setSensorFault({}, 'P2', { kind: 'bias', offsetSI: 5000 })
    const biased = sampleSensors(hydraulic!, seed, faults)
    expect(biased.measurements.filter(({ sensorId }) => sensorId !== 'P2'))
      .toEqual(normal.measurements.filter(({ sensorId }) => sensorId !== 'P2'))
    const before = normal.measurements.find(({ sensorId }) => sensorId === 'P2')!
    const after = biased.measurements.find(({ sensorId }) => sensorId === 'P2')!
    expect(after).toEqual({ ...before, valueSI: before.valueSI! + 5000, quality: 'valid' })
    expect(publicSampleSchema.parse(after)).toEqual(after)
    expect(biased).toEqual(sampleSensors(hydraulic!, initializeSensors(123), faults))
  })

  it('uses null for dropout and preserves sequence and nominal noise on recovery', () => {
    const [initial, next] = stateAt([0, 50_000])
    const seed = initializeSensors(456)
    const faults = setSensorFault({}, 'Qin', { kind: 'dropout' })
    const dropped = sampleSensors(initial!, seed, faults)
    const missing = dropped.measurements.find(({ sensorId }) => sensorId === 'Qin')!
    expect(missing).toMatchObject({ valueSI: null, sampleSeq: 0, quality: 'missing' })
    expect(publicSampleSchema.parse(missing)).toEqual(missing)
    const cleared = setSensorFault(faults, 'Qin', { kind: 'clear' })
    expect(faults.Qin).toEqual({ kind: 'dropout' })
    expect(cleared.Qin).toBeUndefined()
    const recovered = sampleSensors(next!, dropped.sensors, cleared)
    const nominal = sampleSensors(next!, sampleSensors(initial!, seed).sensors)
    expect(recovered.measurements).toEqual(nominal.measurements)
    expect(recovered.measurements.find(({ sensorId }) => sensorId === 'Qin')?.sampleSeq).toBe(1)
  })

  it('marks stuck from a run of observations, and a missing value breaks that run', () => {
    const readings = stateAt([0, 10_000, 20_000, 30_000, 40_000])
    const stuck = setSensorFault({}, 'P1', { kind: 'stuck-zero' })
    const dropped = setSensorFault({}, 'P1', { kind: 'dropout' })
    const schedule = [stuck, stuck, dropped, stuck, stuck]
    let sensors = initializeSensors(789)
    const qualities = readings.map((state, index) => {
      const next = sampleSensors(state, sensors, schedule[index])
      sensors = next.sensors
      return next.measurements.find(({ sensorId }) => sensorId === 'P1')?.quality
    })
    expect(qualities).toEqual(['out-of-range', 'out-of-range', 'missing', 'out-of-range', 'out-of-range'])
    const finalState = stateAt([50_000])[0]!
    const next = sampleSensors(finalState, sensors, stuck)
    expect(next.measurements.find(({ sensorId }) => sensorId === 'P1')).toMatchObject({
      valueSI: 0, quality: 'stuck', sampleSeq: 5,
    })
  })

  it('gives identical quality to the same values regardless of the hidden fault', () => {
    let stuckHistory = initializeSensors(65)
    let biasHistory = initializeSensors(65)
    for (const state of stateAt([0, 10_000, 20_000])) {
      const nominal = sampleSensors(state, biasHistory).measurements.find(({ sensorId }) => sensorId === 'P1')!
      const stuck = sampleSensors(state, stuckHistory, { P1: { kind: 'stuck-zero' } })
      const bias = sampleSensors(state, biasHistory, { P1: { kind: 'bias', offsetSI: -nominal.valueSI! } })
      expect(stuck.measurements).toEqual(bias.measurements)
      stuckHistory = stuck.sensors
      biasHistory = bias.sensors
    }
  })

  it('does not draw again for duplicate or earlier sampling times', () => {
    const [earlier, current] = stateAt([0, 50_000])
    const initial = sampleSensors(earlier!, initializeSensors(2))
    const next = sampleSensors(current!, initial.sensors)
    for (const state of [earlier!, current!]) {
      expect(sampleSensors(state, next.sensors)).toEqual({ sensors: next.sensors, measurements: [] })
    }
  })

  it('rejects nonfinite bias before producing any public observation', () => {
    expect(() => setSensorFault({}, 'P1', { kind: 'bias', offsetSI: Number.NaN })).toThrow(RangeError)
    const state = stateAt([0])[0]!
    expect(() => sampleSensors(state, initializeSensors(99), { P1: { kind: 'bias', offsetSI: Infinity } }))
      .toThrow(RangeError)
  })
})
