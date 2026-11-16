import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { initialize } from '../../src/physics/initialize'
import { advanceTo } from '../../src/physics/advance-to'
import { expandSeed, nextUniform } from '../../src/plant/random'
import { initializeSensors, initializeSensorsFromStreams, sampleSensors } from '../../src/plant/sensors'

describe('seeded public telemetry', () => {
  it('owns explicit streams supplied by independent validation scenarios', () => {
    const input: [number, number, number, number] = [1, 2, 3, 4]
    const channel = { noise: input, delivery: [4, 3, 2, 1] as const }
    const set = { P1: channel, P2: channel, P3: channel, Qin: channel }
    const streams = initializeSensorsFromStreams(set)
    input[0] = 99
    expect(streams[0]?.normal.seed).toEqual([1, 2, 3, 4])
    expect(streams[0]?.deliverySeed).toEqual([4, 3, 2, 1])
    const zero = { ...set, P1: { ...channel, noise: [0, 0, 0, 0] as const } }
    expect(() => initializeSensorsFromStreams(zero)).toThrow(/seed/)
  })
  it('matches the xoshiro128** transition and output vector', () => {
    const step = nextUniform([1, 2, 3, 4])
    expect(step.seed).toEqual([7, 0, 1026, 12288])
    expect(step.value).toBe((11520 + 0.5) / 2 ** 32)
  })

  it('separates initial streams and keeps each flow sample at its native cadence', () => {
    const firstDraws = Array.from({ length: 4 }, (_, stream) => nextUniform(expandSeed(99, stream)).value)
    expect(new Set(firstDraws).size).toBe(4)
    expect(nextUniform(expandSeed(100, 0)).value).not.toBe(firstDraws[0])

    const init = initialize(profileSchema.parse(rawProfile))
    if (!init.ok) throw init.error
    const first = sampleSensors(init.value, initializeSensors(99))
    expect(first.measurements).toHaveLength(4)
    expect(first).toEqual(sampleSensors(init.value, initializeSensors(99)))
    const next = advanceTo(init.value, 10_000)
    if (!next.ok) throw next.error
    const samples = sampleSensors(next.value, first.sensors)
    expect(samples.measurements.map((sample) => sample.sensorId)).toEqual(['P1', 'P2', 'P3'])
    expect(samples.measurements.map((sample) => sample.sampleSeq)).toEqual([1, 1, 1])
  })
})
