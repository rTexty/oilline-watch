import { describe, expect, it } from 'vitest'
import { createNumericalMemoryLedger } from '../../src/runtime/numerical-memory'
import { createSimulationMemory } from '../../src/runtime/simulation-memory'

describe('simulation numerical memory', () => {
  it('shares backing leases across live state and checkpoints, then retires an evicted second', () => {
    const ledger = createNumericalMemoryLedger(1024)
    const memory = createSimulationMemory(ledger)
    const first = new Float64Array(8)
    const second = new Float64Array(8)
    const third = new Float64Array(8)
    memory.track([first], { timeUs: 0, keepSinceUs: 0, states: [first.subarray(2)] })
    const initial = ledger.snapshot().reservedBytes
    memory.track([second], { timeUs: 1_000_000, keepSinceUs: 0, states: [second] })
    expect(ledger.snapshot().reservedBytes).toBe(initial + first.byteLength)
    memory.track([third], { timeUs: 2_000_000, keepSinceUs: 1_000_000, states: [third] })
    expect(ledger.snapshot().reservedBytes).toBe(initial + first.byteLength)
    expect(ledger.snapshot().highWaterBytes).toBeGreaterThanOrEqual(initial + first.byteLength)
  })

  it('refuses startup when model scratch and staged banks cannot fit the quota', () => {
    const ledger = createNumericalMemoryLedger(64)
    const memory = createSimulationMemory(ledger)
    expect(() => memory.track([new Float64Array(8)])).toThrow('resource-limit')
    expect(ledger.snapshot().reservedBytes).toBe(0)
  })

  it('preserves the accepted checkpoint leases if a replacement exceeds quota', () => {
    const ledger = createNumericalMemoryLedger(600)
    const memory = createSimulationMemory(ledger)
    const first = new Float64Array(8)
    const second = new Float64Array(8)
    memory.track([first], { timeUs: 0, keepSinceUs: 0, states: [first] })
    memory.track([second], { timeUs: 1_000_000, keepSinceUs: 0, states: [second] })
    const before = ledger.snapshot().reservedBytes
    const oversized = new Float64Array(20)
    expect(() => memory.track([oversized], { timeUs: 2_000_000, keepSinceUs: 1_000_000, states: [oversized] }))
      .toThrow('resource-limit')
    expect(ledger.snapshot().reservedBytes).toBe(before)
  })
})
