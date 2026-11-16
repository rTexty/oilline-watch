import { describe, expect, it } from 'vitest'
import { admitWindows, initialInferenceSchedule } from '../../src/runtime/inference-schedule'

describe('diagnostic window scheduling', () => {
  it('schedules short and long windows on their model-time cadence after warmup', () => {
    let schedule = initialInferenceSchedule()
    const early = admitWindows(schedule, 29_000_000)
    expect(early.windows).toEqual([])
    schedule = early.state
    const short = admitWindows(schedule, 31_000_000)
    expect(short.windows).toContainEqual({ startUs: 27_000_000, endUs: 31_000_000, durationUs: 4_000_000, priority: 'regular' })
    const both = admitWindows(short.state, 35_000_000)
    expect(both.windows).toContainEqual({ startUs: 31_000_000, endUs: 35_000_000, durationUs: 4_000_000, priority: 'regular' })
    expect(both.windows).toContainEqual({ startUs: 5_000_000, endUs: 35_000_000, durationUs: 30_000_000, priority: 'regular' })
  })
  it('deduplicates alarm and regular requests at the same endpoint', () => {
    const first = admitWindows(initialInferenceSchedule(), 31_000_000, true)
    expect(first.windows.filter((window) => window.durationUs === 4_000_000 && window.endUs === 31_000_000)).toHaveLength(1)
    expect(admitWindows(first.state, 31_000_000, true).windows).toEqual([])
  })
  it('admits a priority short window at an intervening pressure tick', () => {
    const regular = admitWindows(initialInferenceSchedule(), 31_000_000)
    const alarm = admitWindows(regular.state, 31_230_000, true)
    expect(alarm.windows).toContainEqual({ startUs: 27_230_000, endUs: 31_230_000, durationUs: 4_000_000, priority: 'alarm' })
  })
})
