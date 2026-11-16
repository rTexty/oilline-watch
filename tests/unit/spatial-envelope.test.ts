import { describe, expect, it } from 'vitest'
import { shardEnvelopeCells, spatialEnvelopeCases, whitenedTraceDiscrepancy } from '../../src/detection/spatial-envelope'

const noise = {
  P1: { sigmaSI: 2, rho: 0.5 }, P2: { sigmaSI: 2, rho: 0.5 },
  P3: { sigmaSI: 2, rho: 0.5 }, Qin: { sigmaSI: 2, rho: 0.5 },
} as const

describe('spatial envelope qualification grid', () => {
  it('covers each anchor and spatial node with all 48 distinct parameter combinations', () => {
    const cells = Array.from({ length: 1791 }, (_, index) => spatialEnvelopeCases(index))
    expect(cells.flat()).toHaveLength(85_968)
    expect(new Set(cells.map((cases) => `${cases[0]!.anchorId}:${cases[0]!.node}`)).size).toBe(1791)
    expect(new Set(cells.flat().map((item) => item.anchorId))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]))
    expect(new Set(cells.flat().map((item) => item.node))).toEqual(new Set(Array.from({ length: 199 }, (_, i) => i + 1)))
    for (const cases of cells) {
      expect(cases).toHaveLength(48)
      expect(new Set(cases.map((item) => item.caseIndex)).size).toBe(48)
      expect(new Set(cases.map((item) => `${item.cdAreaM2}:${item.openingUs}:${item.onsetUs}`)).size).toBe(48)
      expect(new Set(cases.map((item) => item.cdAreaM2))).toEqual(new Set([5e-6, 1e-5, 2e-5, 4e-5]))
      expect(new Set(cases.map((item) => item.openingUs))).toEqual(new Set([0, 1_000_000, 20_000_000]))
      expect(new Set(cases.map((item) => item.onsetUs))).toEqual(new Set([0, 250_000, 500_000, 750_000]))
    }
  })

  it('partitions every cell exactly once across shards, including empty shards', () => {
    for (const shards of [1, 7, 1800]) {
      const cells = Array.from({ length: shards }, (_, i) => shardEnvelopeCells(i, shards)).flat()
      expect(cells).toHaveLength(1791)
      expect([...cells].sort((a, b) => a - b)).toEqual(Array.from({ length: 1791 }, (_, i) => i))
    }
  })

  it('rejects invalid cell and shard indexes', () => {
    for (const cell of [-1, 1791, 0.5, NaN]) expect(() => spatialEnvelopeCases(cell)).toThrow()
    for (const [index, shards] of [[-1, 2], [2, 2], [0, 0], [0.5, 2], [0, 1.5]]) {
      expect(() => shardEnvelopeCells(index!, shards!)).toThrow()
    }
  })
})

describe('whitened trace discrepancy', () => {
  it('uses AR innovations at each channel native cadence and no initial innovation', () => {
    const exact = new Float64Array(24)
    const surrogate = new Float64Array(24)
    exact[0] = 2
    exact[4] = 3
    // Keep P1 at 1.5 after its first innovation so subsequent innovations are zero.
    exact[8] = 1.5
    exact[12] = 0.75
    exact[16] = 0.375
    exact[20] = 0.1875
    exact[3] = 2
    exact[7] = exact[11] = exact[15] = exact[19] = 1000
    exact[23] = 4
    expect(whitenedTraceDiscrepancy(exact, surrogate, noise)).toBeCloseTo(Math.sqrt(13 / 3), 12)
    expect(whitenedTraceDiscrepancy(exact, exact, noise)).toBe(0)
    expect(whitenedTraceDiscrepancy(exact.subarray(0, 4), surrogate.subarray(0, 4), noise)).toBe(0)
  })

  it('rejects malformed, nonfinite, or incompatible traces and invalid noise', () => {
    const good = new Float64Array(8)
    expect(() => whitenedTraceDiscrepancy(new Float64Array(), new Float64Array(), noise)).toThrow()
    expect(() => whitenedTraceDiscrepancy(new Float64Array(5), new Float64Array(5), noise)).toThrow()
    expect(() => whitenedTraceDiscrepancy(good, new Float64Array(4), noise)).toThrow()
    expect(() => whitenedTraceDiscrepancy(Float64Array.of(NaN, 0, 0, 0), new Float64Array(4), noise)).toThrow()
    for (const invalid of [{ sigmaSI: 0, rho: 0 }, { sigmaSI: NaN, rho: 0 }, { sigmaSI: 1, rho: 1 }, { sigmaSI: 1, rho: -1 }]) {
      expect(() => whitenedTraceDiscrepancy(good, good, { ...noise, P1: invalid })).toThrow()
    }
  })
})
