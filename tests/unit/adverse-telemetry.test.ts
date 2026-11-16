import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { publicBatchSchema } from '../../src/contracts/public'
import type { Measurement } from '../../src/contracts/public'
import { advanceTo } from '../../src/physics/advance-to'
import { initialize } from '../../src/physics/initialize'
import { expandSeed, nextNormal } from '../../src/plant/random'
import { initializeSensors, sampleSensors } from '../../src/plant/sensors'
import { deliverTelemetry } from '../../src/plant/telemetry-delivery'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'

function state(layout: 'nominal' | 'adverse') {
  const initialized = initialize(profileSchema.parse({
    ...rawProfile, sensorProfileId: `synthetic-oil-${layout}-v1`,
  }))
  if (!initialized.ok) throw initialized.error
  return initialized.value
}

function reading(sensorId: Measurement['sensorId'], sampleSeq: number, sampleTimeUs: number, deliveredTimeUs: number): Measurement {
  return { sensorId, sampleSeq, sampleTimeUs, deliveredTimeUs, valueSI: 1_200_000, quality: 'valid' }
}

describe('adverse telemetry', () => {
  it('preserves nominal first and second samples bit for bit', () => {
    const initial = state('nominal')
    const first = sampleSensors(initial, initializeSensors(99))
    const stepped = advanceTo(initial, 10_000)
    if (!stepped.ok) throw stepped.error
    const second = sampleSensors(stepped.value, first.sensors)
    expect(first.measurements.map(({ valueSI }) => valueSI)).toEqual([
      1196658.9248708582, 1180439.0645426428, 1166332.2873690282, 0.02510970550458304,
    ])
    expect(second.measurements.map(({ valueSI }) => valueSI)).toEqual([
      1196721.8863895154, 1180745.5612404763, 1165327.4543345051,
    ])
    expect([...first.measurements, ...second.measurements].every((sample) => sample.deliveredTimeUs === sample.sampleTimeUs)).toBe(true)
  })

  it('uses adverse pressure and flow noise scales and correlations at their native periods', () => {
    const initial = state('adverse')
    const seed = 99
    const first = sampleSensors(initial, initializeSensors(seed))
    const pressureSecond = sampleSensors({ ...initial, timeUs: 10_000 }, first.sensors)
    let flowSecond = pressureSecond
    for (let timeUs = 20_000; timeUs <= 50_000; timeUs += 10_000) {
      flowSecond = sampleSensors({ ...initial, timeUs }, flowSecond.sensors)
    }
    expect(first).toEqual(sampleSensors(initial, initializeSensors(seed)))

    for (const [index, id, physical, sigma, rho, second] of [
      [0, 'P1', initial.p[20]!, 1000, 0.85, pressureSecond],
      [3, 'Qin', initial.qR[0]!, 0.0001, 0.6, flowSecond],
    ] as const) {
      const firstNoise = nextNormal({ seed: expandSeed(seed, index), spare: null })
      const secondNoise = nextNormal(firstNoise.state)
      const previousError = sigma * firstNoise.value
      const error = rho * previousError + sigma * Math.sqrt(1 - rho * rho) * secondNoise.value
      expect(first.measurements.find((sample) => sample.sensorId === id)?.valueSI).toBe(physical + previousError)
      expect(second.measurements.find((sample) => sample.sensorId === id)?.valueSI).toBe(physical + error)
    }
  })

  it('emits deterministic missing values and bounded jitter without exposing private state', () => {
    const initial = state('adverse')
    let sensors = initializeSensors(42)
    let missing = 0
    let total = 0
    let jittered = false
    let pending: readonly Measurement[] = []
    const lastBySensor = new Map<Measurement['sensorId'], Measurement>()
    for (let tick = 0; tick < 1000; tick++) {
      const timeUs = tick * 10_000
      const output = sampleSensors({ ...initial, timeUs }, sensors)
      sensors = output.sensors
      for (const sample of output.measurements) {
        const delay = sample.deliveredTimeUs - sample.sampleTimeUs
        expect(Number.isSafeInteger(delay) && delay >= 0 && delay <= 20_000).toBe(true)
        jittered ||= delay > 0
        expect(Object.keys(sample).sort()).toEqual([
          'deliveredTimeUs', 'quality', 'sampleSeq', 'sampleTimeUs', 'sensorId', 'valueSI',
        ])
        if (sample.quality === 'missing') {
          expect(sample.valueSI).toBeNull()
          missing++
        }
        total++
      }
      const delivered = deliverTelemetry(pending, output.measurements, timeUs)
      pending = delivered.pending
      expect(pending.length).toBeLessThanOrEqual(7)
      for (const sample of delivered.measurements) {
        const previous = lastBySensor.get(sample.sensorId)
        expect(sample.sampleSeq).toBe((previous?.sampleSeq ?? -1) + 1)
        expect(sample.deliveredTimeUs).toBeGreaterThanOrEqual(previous?.deliveredTimeUs ?? 0)
        expect(sample.deliveredTimeUs).toBeLessThanOrEqual(timeUs)
        lastBySensor.set(sample.sensorId, sample)
      }
    }
    expect(jittered).toBe(true)
    expect(total).toBe(3200)
    expect(missing / total).toBeGreaterThan(0.005)
    expect(missing / total).toBeLessThan(0.015)
  })

  it('holds later samples behind their channel predecessor while releasing unrelated channels', () => {
    const initial = deliverTelemetry([], [reading('P1', 0, 0, 20_000), reading('P2', 0, 0, 0)], 0)
    expect(initial.measurements.map((sample) => sample.sensorId)).toEqual(['P2'])
    const follower = reading('P1', 1, 10_000, 10_000)
    const partial = deliverTelemetry(initial.pending, [follower], 10_000)
    expect(partial.measurements).toEqual([])
    expect(partial.pending.map((sample) => sample.deliveredTimeUs)).toEqual([20_000, 20_000])
    expect(follower.deliveredTimeUs).toBe(10_000)
    expect(deliverTelemetry(partial.pending, [], 19_999).measurements).toEqual([])

    const due = deliverTelemetry(partial.pending, [], 20_000)
    expect(due.pending).toEqual([])
    expect(due.measurements.map((sample) => sample.sampleSeq)).toEqual([0, 1])
    expect(publicBatchSchema.safeParse({ sampleTimeUs: 20_000, measurements: due.measurements, predictions: [] }).success).toBe(true)
    expect(publicBatchSchema.safeParse({ sampleTimeUs: 19_999, measurements: due.measurements, predictions: [] }).success).toBe(false)
  })
})
