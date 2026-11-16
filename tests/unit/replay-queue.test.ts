import { describe, expect, it } from 'vitest'
import { verifyReplayQueue, emptyReplayQueue } from '../../src/runtime/replay-queue'
import type { InferenceAuditTransition } from '../../src/contracts/inference-audit'
import type { DiagnosticWindow } from '../../src/runtime/inference-schedule'

const first = '8dc30484-3d7f-4bc2-8323-a432db7e7ca1'
const alarm = '50f5f0bf-f0c5-4380-9799-7d58e54169cb'
const regular = '230dc176-69f8-47df-96b4-1a3d75d7c43e'
const another = 'ba3df6fa-52a9-4b33-8d50-52374539c418'
const endUs = 40_000_000
const at = (endUs: number, priority: DiagnosticWindow['priority'] = 'regular'): DiagnosticWindow => ({
  endUs, startUs: endUs - 4_000_000, durationUs: 4_000_000, priority,
})
const requested = (jobId: string, time: number): InferenceAuditTransition => ['requested', jobId, time, at(time).startUs]

describe('CPU replay queue', () => {
  it('rebuilds priority, immediate admission, completion and end cancellation', () => {
    const active = verifyReplayQueue(emptyReplayQueue, [at(31_000_000)], [
      requested(first, 31_000_000), ['admitted', first, 31_000_000],
    ], 31_000_000, endUs)
    const waiting = verifyReplayQueue(active, [at(32_000_000, 'alarm')], [requested(alarm, 32_000_000)], 32_000_000, endUs)
    const stillWaiting = verifyReplayQueue(waiting, [at(33_000_000)], [
      requested(regular, 33_000_000), ['superseded', regular, 33_000_000],
    ], 33_000_000, endUs)
    const promoted = verifyReplayQueue(stillWaiting, [], [
      ['finished', first, 33_500_000], ['committed', first, 33_500_000], ['admitted', alarm, 33_500_000],
    ], 33_500_000, endUs)
    expect(promoted).toEqual({ active: { jobId: alarm, priority: 'alarm', durationUs: 4_000_000 }, pending: null })
    expect(verifyReplayQueue(promoted, [], [['cancelled', alarm, endUs]], endUs, endUs)).toEqual(emptyReplayQueue)
    expect(waiting.pending?.jobId).toBe(alarm)
  })

  it('rejects plausible ledgers with delayed admission, wrong eviction or early cancellation', () => {
    const time = 31_000_000
    const waiting = {
      active: { jobId: first, priority: 'regular' as const, durationUs: 4_000_000 as const },
      pending: { jobId: alarm, priority: 'alarm' as const, durationUs: 4_000_000 as const },
    }
    expect(() => verifyReplayQueue(emptyReplayQueue, [at(time)], [requested(first, time)], time, endUs)).toThrow('replay-divergence')
    expect(() => verifyReplayQueue(waiting, [at(time)], [
      requested(regular, time), ['superseded', alarm, time],
    ], time, endUs)).toThrow('replay-divergence')
    expect(() => verifyReplayQueue({ active: waiting.active, pending: null }, [], [
      ['cancelled', first, time],
    ], time, endUs)).toThrow('replay-divergence')
  })

  it('admits both lengths under sustained load while keeping one pending window', () => {
    const long = (timeUs: number): DiagnosticWindow => ({ ...at(timeUs), startUs: timeUs - 30_000_000, durationUs: 30_000_000 })
    const active = verifyReplayQueue(emptyReplayQueue, [at(31_000_000)], [
      requested(first, 31_000_000), ['admitted', first, 31_000_000],
    ], 31_000_000, endUs)
    const pendingLong = verifyReplayQueue(active, [long(35_000_000)], [
      ['requested', alarm, 35_000_000, 5_000_000],
    ], 35_000_000, endUs)
    const longKept = verifyReplayQueue(pendingLong, [at(36_000_000)], [
      requested(regular, 36_000_000), ['superseded', regular, 36_000_000],
    ], 36_000_000, endUs)
    const longActive = verifyReplayQueue(longKept, [], [
      ['finished', first, 36_500_000], ['committed', first, 36_500_000], ['admitted', alarm, 36_500_000],
    ], 36_500_000, endUs)
    const shortWaiting = verifyReplayQueue(longActive, [at(37_000_000)], [requested(regular, 37_000_000)], 37_000_000, endUs)
    const shortKept = verifyReplayQueue(shortWaiting, [long(40_000_000)], [
      ['requested', another, 40_000_000, 10_000_000], ['superseded', another, 40_000_000],
      ['cancelled', alarm, 40_000_000], ['cancelled', regular, 40_000_000],
    ], 40_000_000, endUs)
    expect(shortKept).toEqual(emptyReplayQueue)
  })
})
