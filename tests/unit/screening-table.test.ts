import { describe, expect, it } from 'vitest'
import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../../src/contracts/public'
import type { SensorId } from '../../src/contracts/public'
import { OPENINGS_US } from '../../src/detection/optimizer'
import { prepareNativeScreeningRows, prepareNativeScreeningTable } from '../../src/detection/screening-table'
import { prepareResponse, screenCandidate, unitResponse, unitResponseAtNativeTick } from '../../src/detection/screening'
import type { ResponseTrace, ScreeningRow } from '../../src/detection/screening'

const sensors: readonly SensorId[] = ['P1', 'P2', 'P3', 'Qin']
const nominalFlow = 0.025
const sampleCount = 3401

function rowsFor(windowUs: number, polarity: number, adverse: boolean): readonly ScreeningRow[] {
  return sensors.flatMap((sensorId, sensorIndex) => {
    const period = sensorId === 'Qin' ? FLOW_PERIOD_US : PRESSURE_PERIOD_US
    return Array.from({ length: windowUs / period }, (_, index) => ({
      sensorId, previousTimeUs: 3_000_000 + index * period, currentTimeUs: 3_000_000 + (index + 1) * period,
      rho: sensorId === 'Qin' ? 0.3 : 0.6, scale: sensorId === 'Qin' ? 5e-5 : 500,
      residual: polarity * (2 + Math.sin(index / 40 + sensorIndex)),
    })).filter((_, index) => !adverse || (index + sensorIndex) % 17 > 1)
  })
}

function responseFor(model: 'ML' | 'MB', anchorId: ResponseTrace['anchorId']) {
  const stepResponse = Float64Array.from({ length: sampleCount * sensors.length }, (_, index) => {
    const channel = index % sensors.length
    const time = Math.floor(index / sensors.length) - 23 - channel * 9 - anchorId * 3
    return time <= 0 ? 0 : (1 + 0.3 * Math.cos(time / 15)) * (channel === 3 ? 1e-2 : 5e6)
  })
  const trace = model === 'ML' ? { model, anchorId, node: 117, stepResponse } as const
    : { model, anchorId, stepResponse } as const
  return prepareResponse(trace)
}

describe('native-tick response sampling', () => {
  it.each(['ML', 'MB'] as const)('matches the scalar response at every native tick for %s', (model) => {
    const response = responseFor(model, 4)
    let comparisons = 0
    for (const sensor of sensors) {
      for (const openingUs of OPENINGS_US) {
        for (let tick = 0; tick < sampleCount; tick++) {
          const expected = unitResponse(response, sensor, tick * PRESSURE_PERIOD_US, 0, openingUs)
          const actual = unitResponseAtNativeTick(response, sensor, tick, openingUs)
          if (!Object.is(actual, expected)) {
            throw new Error(`Mismatch for ${model}/${sensor} at tick ${tick} with opening ${openingUs}: ${actual} vs ${expected}`)
          }
          comparisons++
        }
      }
    }
    expect(comparisons).toBe(sampleCount * sensors.length * OPENINGS_US.length)
  })

  it('preserves signed zero and nonfinite results of overflow from finite amplitudes', () => {
    const stepResponse = new Float64Array([
      -0, 0, 1e308, -1e308,
      -1, -0, -1e308, 1e308,
      -0, -0, 1e308, -1e308,
    ])
    const response = prepareResponse({ model: 'MB', anchorId: 0, stepResponse })
    let signedZeroSeen = false
    let nonfiniteSeen = false
    for (const sensor of sensors) {
      for (const openingUs of OPENINGS_US) {
        for (let tick = 0; tick < 3; tick++) {
          const expected = unitResponse(response, sensor, tick * PRESSURE_PERIOD_US, 0, openingUs)
          const actual = unitResponseAtNativeTick(response, sensor, tick, openingUs)
          expect(Object.is(actual, expected)).toBe(true)
          signedZeroSeen ||= Object.is(expected, -0)
          nonfiniteSeen ||= !Number.isFinite(expected)
        }
      }
    }
    expect(signedZeroSeen).toBe(true)
    expect(nonfiniteSeen).toBe(true)
  })

  it('retains interpolation for fractional response times', () => {
    const stepResponse = new Float64Array([
      2, 4, 6, 8,
      6, 8, 10, 12,
    ])
    const response = prepareResponse({ model: 'ML', anchorId: 0, node: 1, stepResponse })
    expect(unitResponse(response, 'P1', PRESSURE_PERIOD_US / 2, 0, 0)).toBe(4)
    expect(unitResponse(response, 'Qin', PRESSURE_PERIOD_US / 4, 0, 0)).toBe(9)
  })
})

describe('native screening table', () => {
  it.each([
    { windowUs: 4_000_000, anchorId: 0, model: 'ML', polarity: 1, adverse: false },
    { windowUs: 30_000_000, anchorId: 4, model: 'MB', polarity: 1, adverse: true },
    { windowUs: 30_000_000, anchorId: 8, model: 'MB', polarity: -1, adverse: true },
  ] as const)('keeps every candidate field and F64 score exact for $model/$anchorId', (fixture) => {
    const rows = rowsFor(fixture.windowUs, fixture.polarity, fixture.adverse)
    const response = responseFor(fixture.model, fixture.anchorId)
    const prepared = prepareNativeScreeningRows(rows)
    expect(prepared).not.toBeNull()
    const screen = prepareNativeScreeningTable(response, prepared!)
    let fitted = 0
    for (const onsetUs of [0, 250_000, 2_990_000, 3_000_000, 3_550_000, fixture.windowUs + 2_000_000]) {
      for (const openingUs of OPENINGS_US) {
        const current = screen(onsetUs, openingUs, nominalFlow)
        const legacy = screenCandidate(response, rows, onsetUs, openingUs, nominalFlow)
        expect(current).toEqual(legacy)
        if (current) {
          fitted++
          const amplitude = current.candidate.model === 'ML' ? current.candidate.cdAreaM2 : current.candidate.amplitudeM3s
          expect(Math.sign(amplitude)).toBe(fixture.polarity)
        }
      }
    }
    expect(fitted).toBeGreaterThan(0)
  })

  it('leaves off-grid, non-native, and saturated responses to the scalar scorer', () => {
    const rows = rowsFor(4_000_000, 1, false)
    const response = responseFor('ML', 1)
    const screen = prepareNativeScreeningTable(response, prepareNativeScreeningRows(rows)!)
    expect(screen(3_000_001, 0, nominalFlow)).toBeUndefined()
    expect(screen(-35_000_000, 20_000_000, nominalFlow)).toBeUndefined()
    const [first, second] = rows
    expect(prepareNativeScreeningRows([{ ...first!, currentTimeUs: first!.currentTimeUs + 1 }])).toBeNull()
    expect(prepareNativeScreeningRows([first!, { ...second!, rho: 0.5 }])).toBeNull()
    expect(prepareNativeScreeningRows([second!, first!])).toBeNull()
    expect(prepareNativeScreeningRows([{ ...first!, previousTimeUs: first!.previousTimeUs - PRESSURE_PERIOD_US }])).toBeNull()
  })
})
