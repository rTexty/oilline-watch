import { describe, expect, it } from 'vitest'
import { createNumericalMemoryLedger, NUMERICAL_MEMORY_QUOTAS } from '../../src/runtime/numerical-memory'

describe('numerical memory admission', () => {
  it('splits the fixed 128 MiB limit among the three owners', () => {
    expect(NUMERICAL_MEMORY_QUOTAS).toEqual({ simulation: 48 * 2 ** 20, inference: 64 * 2 ** 20, ui: 16 * 2 ** 20 })
    expect(createNumericalMemoryLedger('simulation').snapshot().limitBytes).toBe(48 * 2 ** 20)
  })

  it('deduplicates shared backing storage in each claim and among concurrent owners', () => {
    const memory = createNumericalMemoryLedger(20)
    const backing = new ArrayBuffer(16)
    const nested: { self?: unknown; rows: Map<string, ArrayBufferView> } = {
      rows: new Map([['one', new DataView(backing, 4, 2)]]),
    }
    nested.self = nested
    const one = memory.retainBuffers('rows', nested, new Uint8Array(backing))
    const two = memory.retainBuffers('aliases', new Set([new Uint8Array(backing, 8, 1)]))
    expect(one).not.toBeNull()
    expect(two).not.toBeNull()
    expect(memory.snapshot().reservedBytes).toBe(16)
    expect(memory.retainBuffers('too-large', new ArrayBuffer(5))).toBeNull()
    expect(memory.reserveBytes('too-large', 5)).toBeNull()
    one?.release()
    expect(memory.snapshot().reservedBytes).toBe(16)
    two?.release()
    two?.release()
    expect(memory.snapshot()).toEqual({ limitBytes: 20, reservedBytes: 0, highWaterBytes: 16 })
  })

  it('charges transferred storage to its owner until lease release', () => {
    const memory = createNumericalMemoryLedger(16)
    const backing = new ArrayBuffer(16)
    const first = memory.retainBuffers('transfer source', backing)
    const target = structuredClone(backing, { transfer: [backing] })
    expect(backing.byteLength).toBe(0)
    expect(memory.retainBuffers('new backing', target)).toBeNull()
    first?.release()
    expect(memory.retainBuffers('new backing', target)).not.toBeNull()
  })

  it('charges the maximum capacity of a resizable backing', () => {
    const buffer = new ArrayBuffer(4, { maxByteLength: 16 })
    const memory = createNumericalMemoryLedger(16)
    const reservation = memory.retainBuffers('resizable', buffer)
    expect(memory.snapshot().reservedBytes).toBe(16)
    buffer.resize(8)
    expect(memory.reserveBytes('extra', 1)).toBeNull()
    reservation?.release()
    expect(memory.snapshot().reservedBytes).toBe(0)
  })

  it('rejects invalid sizes and combines backing and scalar reservations', () => {
    const memory = createNumericalMemoryLedger(16)
    expect(() => memory.reserveBytes('invalid', NaN)).toThrow(RangeError)
    expect(() => memory.reserveBytes('invalid', -1)).toThrow(RangeError)
    const direct = memory.reserveBytes('allocation bound', 8)
    const backing = memory.retainBuffers('shared memory', new SharedArrayBuffer(8))
    expect(memory.snapshot().reservedBytes).toBe(16)
    direct?.release()
    backing?.release()
    expect(memory.snapshot().reservedBytes).toBe(0)
  })
})
