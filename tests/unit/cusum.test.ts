import { describe, expect, it } from 'vitest'
import { initialCusum, updateCusum } from '../../src/detection/cusum'

const policy = { rho: 0, fastThreshold: 3, slowThreshold: 4, periodUs: 10_000 }
const scores = initialCusum()

describe('causal CUSUM', () => {
  it('uses the first observation for pairing and counts each valid sample once', () => {
    const first = updateCusum(scores, 0, 0, 0, policy)
    const alarm = updateCusum(first, 1, 10_000, -6, policy)
    expect(first.crossed).toBe(false)
    expect(alarm.crossed).toBe(true)
    expect(updateCusum(alarm, 1, 10_000, 100, policy)).toBe(alarm)
  })

  it('drops the pair across a missing sample and resets after a long outage', () => {
    const first = updateCusum(scores, 0, 0, 0, policy)
    const elevated = updateCusum(first, 1, 10_000, 2, policy)
    const missing = updateCusum(elevated, 2, 20_000, null, policy)
    const next = updateCusum(missing, 3, 30_000, -20, policy)
    expect(next.fast).toEqual(elevated.fast)
    const outage = updateCusum(next, 60, 600_000, 0, policy)
    expect(outage.fast).toEqual({ positive: 0, negative: 0 })
    expect(outage.crossed).toBe(false)
  })
})
