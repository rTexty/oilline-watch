import { describe, expect, it } from 'vitest'
import { annotateExactRegions, optimisticScore, unresolvedRegions } from '../../src/detection/profile'

describe('diagnostic profile bounds', () => {
  it('bounds the exact score in residual norm before squaring', () => {
    expect(optimisticScore(25, 2, 1.5)).toBe(4)
    expect(optimisticScore(1, 2, 1.5)).toBe(0)
    expect(() => optimisticScore(1, -1, 1)).toThrow(RangeError)
  })

  it('preserves the entire interior search region without qualified exclusion bounds', () => {
    expect(unresolvedRegions(1000, 200)).toEqual([{ startM: 2.5, endM: 997.5, status: 'unresolved' }])
  })

  it('marks only nonzero exact leak fits within both limits and leaves every other cell unresolved', () => {
    const candidate = { model: 'ML', anchorId: 0, node: 20, cdAreaM2: 1e-5, onsetUs: 1_000_000, openingUs: 0 } as const
    const trials = [
      { candidate, score: 8 },
      { candidate: { ...candidate, node: 21 }, score: 9 },
      { candidate: { ...candidate, node: 30 }, score: 11 },
      { candidate: { ...candidate, node: 45, cdAreaM2: 0 }, score: 1 },
    ]
    expect(annotateExactRegions(1000, 200, trials, 10, { absoluteFit: 1, profile: 2 })).toEqual([
      { startM: 2.5, endM: 97.5, status: 'unresolved' },
      { startM: 97.5, endM: 107.5, status: 'compatible' },
      { startM: 107.5, endM: 997.5, status: 'unresolved' },
    ])
    expect(annotateExactRegions(1000, 200, trials, 2, { absoluteFit: 1, profile: 2 }))
      .toEqual(unresolvedRegions(1000, 200))
  })
})
