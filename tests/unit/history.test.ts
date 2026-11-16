import { describe, expect, it } from 'vitest'
import { appendHistory, emptyHistory, freezeWindow } from '../../src/runtime/history'

describe('public inference history', () => {
  it('returns a causal window with the latest checkpoint before the guard', () => {
    let history = emptyHistory<number, number>()
    for (let second = 0; second <= 51; second++) {
      const time = second * 1_000_000
      history = appendHistory(history, time, time, second)
    }
    expect(history.seconds).toHaveLength(41)
    const window = freezeWindow(history, 50_000_000, 30_000_000)
    expect(window?.checkpoint).toBe(17)
    expect(window?.frames[0]).toBe(20_000_000)
    expect(window?.frames.at(-1)).toBe(50_000_000)
    expect(freezeWindow(history, 19_000_000, 30_000_000)).toBeNull()
    expect(freezeWindow(history, 60_000_000, 4_000_000)).toBeNull()
  })
})
