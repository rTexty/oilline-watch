import { describe, expect, it } from 'vitest'
import type { PublicBatch, Measurement } from '../../src/contracts/public'
import { compareNegativePressureWave, pressureWaveEvidence } from '../../src/detection/negative-pressure-wave'

type SensorId = 'P1' | 'P2' | 'P3'
type Sample = { sensorId: SensorId; sampleTimeUs: number; availableAtUs: number; innovation: number }
const settings = {
  sensorPositionsM: { P1: 100, P2: 500, P3: 900 },
  waveSpeedMps: { min: 990, max: 1010 },
  clockUncertaintyUs: 10_000,
} as const
const sensors: SensorId[] = ['P1', 'P2', 'P3']

function signals(arrivals: Record<SensorId, number[]>, endUs = 2_000_000): Sample[] {
  return sensors.flatMap((sensorId) => {
    const samples: Sample[] = []
    for (let time = 0; time <= endUs; time += 10_000) {
      const pulse = arrivals[sensorId].some((arrival) => time === arrival || time === arrival + 10_000)
      samples.push({ sensorId, sampleTimeUs: time, availableAtUs: time, innovation: pulse ? -6 : 0 })
    }
    return samples
  })
}

describe('negative pressure wave comparator', () => {
  it('localizes a distinct front using propagation delays', () => {
    const samples = signals({ P1: [700_000], P2: [700_000], P3: [1_100_000] })
    const result = compareNegativePressureWave(samples, 2_000_000, settings)
    expect(result.status).toBe('consistent-front')
    expect(result.intervalM).not.toBeNull()
    expect(result.intervalM!.startM).toBeLessThanOrEqual(300)
    expect(result.intervalM!.endM).toBeGreaterThanOrEqual(300)
    expect(result.intervalM!.endM - result.intervalM!.startM).toBeLessThan(100)
    expect(result.reason.length).toBeGreaterThan(0)
  })

  it('abstains for a gradual decrease without a distinct pressure front', () => {
    const samples = signals({ P1: [], P2: [], P3: [] }).map((sample) => ({
      ...sample, innovation: -Math.min(6, sample.sampleTimeUs / 200_000),
    }))
    const result = compareNegativePressureWave(samples, 2_000_000, settings)
    expect(result.status).toBe('no-distinct-front')
    expect(result.intervalM).toBeNull()
  })

  it('marks saturated one-sided arrival delays as ambiguous', () => {
    const result = compareNegativePressureWave(signals({ P1: [500_000], P2: [900_000], P3: [1_300_000] }), 2_000_000, settings)
    expect(result.status).toBe('ambiguous')
    expect(result.intervalM).toBeNull()
  })

  it('marks two independent matched fronts as ambiguous', () => {
    const result = compareNegativePressureWave(signals({ P1: [300_000, 1_100_000], P2: [300_000, 1_100_000], P3: [700_000, 1_500_000] }), 2_000_000, settings)
    expect(result.status).toBe('ambiguous')
    expect(result.intervalM).toBeNull()
  })

  it('does not use future or not-yet-available samples at a cutoff', () => {
    const samples = signals({ P1: [700_000], P2: [700_000], P3: [1_100_000] })
    const cutoff = 800_000
    const baseline = compareNegativePressureWave(samples.filter((sample) => sample.sampleTimeUs <= cutoff), cutoff, settings)
    expect(compareNegativePressureWave(samples, cutoff, settings)).toEqual(baseline)
    const delayed = samples.map((sample) => sample.sensorId === 'P3' && sample.sampleTimeUs >= 1_100_000
      ? { ...sample, availableAtUs: 3_000_000 } : sample)
    const beforeAvailable = compareNegativePressureWave(delayed, 2_000_000, settings)
    expect(beforeAvailable.status).toBe('insufficient-data')
    expect(beforeAvailable.intervalM).toBeNull()
  })

  it('reports insufficient data for empty input', () => {
    const result = compareNegativePressureWave([], 0, settings)
    expect(result.status).toBe('insufficient-data')
    expect(result.intervalM).toBeNull()
  })

  it('rejects incompatible arrival times and invalid comparator bounds', () => {
    const samples = signals({ P1: [700_000], P2: [1_000_000], P3: [1_550_000] })
    expect(compareNegativePressureWave(samples, 2_000_000, settings))
      .toMatchObject({ status: 'ambiguous', reason: 'arrival-times-inconsistent', intervalM: null })
    expect(() => compareNegativePressureWave(samples, 2_000_000, {
      ...settings, waveSpeedMps: { min: 1010, max: 990 },
    })).toThrow(RangeError)
  })

  it('abstains if compatible lags would require emission before the allowed source time', () => {
    const samples = signals({ P1: [100_000], P2: [100_000], P3: [500_000] })
    expect(compareNegativePressureWave(samples, 2_000_000, settings))
      .toMatchObject({ status: 'ambiguous', reason: 'arrival-times-inconsistent', intervalM: null })
    const legal = signals({ P1: [700_000], P2: [700_000], P3: [1_100_000] })
    expect(compareNegativePressureWave(legal, 2_000_000, { ...settings, earliestSourceUs: 650_000 }).intervalM)
      .toBeNull()
  })
})

describe('public S10 pressure innovation evidence', () => {
  const channel = { sigmaSI: 2, rho: 0.5, baselineSI: 1 }
  const channels = { P1: channel, P2: channel, P3: channel, Qin: channel }
  function batch(timeUs: number, measurements: readonly Measurement[]): PublicBatch {
    return {
      sampleTimeUs: timeUs, measurements,
      predictions: [{ sampleTimeUs: timeUs, pressurePa: [100, 100, 100], inletFlowM3s: 1, anchorId: 0,
        modelVersion: '1', bankVersion: '1', profileId: 'synthetic-oil-turbulent-v1' }],
    }
  }
  const first = {
    sensorId: 'P1', sampleTimeUs: 0, sampleSeq: 0, deliveredTimeUs: 0, quality: 'valid', valueSI: 103,
  } as const

  it('waits for delivery, applies frozen centering and whitening, and does not bridge an invalid sample', () => {
    const delayed = { ...first, sampleTimeUs: 10_000, sampleSeq: 1, deliveredTimeUs: 20_000, valueSI: 96 }
    const missing = { ...first, sampleTimeUs: 20_000, sampleSeq: 2, deliveredTimeUs: 20_000, quality: 'missing', valueSI: null } as const
    const latest = { ...first, sampleTimeUs: 30_000, sampleSeq: 3, deliveredTimeUs: 30_000 }
    const batches = [batch(0, [first]), batch(10_000, []), batch(20_000, [delayed, missing]), batch(30_000, [latest])]
    expect(pressureWaveEvidence(batches, 10_000, 0, channels)).toEqual([])
    expect(pressureWaveEvidence(batches, 30_000, 0, channels)).toEqual([{
      sensorId: 'P1', sampleTimeUs: 10_000, availableAtUs: 20_000, innovation: -6 / Math.sqrt(3),
    }])
    expect(pressureWaveEvidence(batches, 30_000, 1, channels)).toEqual([])
  })

  it('preserves the original public availability across later retransmission of a selected reading', () => {
    const second = { ...first, sampleTimeUs: 10_000, sampleSeq: 1, deliveredTimeUs: 10_000, valueSI: 96 }
    const initial = [batch(0, [first]), batch(10_000, [second])]
    const later = [...initial, batch(40_000, [second])]
    const prefix = pressureWaveEvidence(initial, 10_000, 0, channels)
    expect(prefix[0]?.availableAtUs).toBe(10_000)
    expect(pressureWaveEvidence(later, 40_000, 0, channels)).toEqual(prefix)
  })
})
