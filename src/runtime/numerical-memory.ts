const MIB = 2 ** 20

export const NUMERICAL_MEMORY_QUOTAS = Object.freeze({ simulation: 48 * MIB, inference: 64 * MIB, ui: 16 * MIB })
type MemoryOwner = keyof typeof NUMERICAL_MEMORY_QUOTAS

export interface NumericalMemoryReservation {
  readonly release: () => void
}

export interface NumericalMemoryLedger {
  readonly reserveBytes: (label: string, bytes: number) => NumericalMemoryReservation | null
  readonly retainBuffers: (label: string, ...roots: readonly unknown[]) => NumericalMemoryReservation | null
  readonly snapshot: () => { readonly limitBytes: number; readonly reservedBytes: number; readonly highWaterBytes: number }
}

function requireByteCount(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Numerical memory byte count is invalid')
}

function collectBuffers(roots: readonly unknown[]): Set<ArrayBufferLike> {
  const buffers = new Set<ArrayBufferLike>()
  const visited = new WeakSet<object>()
  function visit(value: unknown) {
    if (typeof value !== 'object' || value === null || visited.has(value)) return
    visited.add(value)
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      buffers.add(value)
    } else if (ArrayBuffer.isView(value)) {
      buffers.add(value.buffer)
    } else if (value instanceof Map) {
      for (const [key, item] of value) {
        visit(key)
        visit(item)
      }
    } else if (value instanceof Set) {
      for (const item of value) visit(item)
    } else {
      for (const item of Object.values(value)) visit(item)
    }
  }
  for (const root of roots) visit(root)
  return buffers
}

export function createNumericalMemoryLedger(owner: MemoryOwner | number): NumericalMemoryLedger {
  const limitBytes = typeof owner === 'number' ? owner : NUMERICAL_MEMORY_QUOTAS[owner]
  requireByteCount(limitBytes)
  let reservedBytes = 0
  let highWaterBytes = 0
  const backings = new Map<ArrayBufferLike, { readonly bytes: number; readonly references: number }>()

  function charge(label: string, bytes: number) {
    if (label.length === 0) throw new TypeError('Numerical memory reservation requires a label')
    requireByteCount(bytes)
    if (bytes > limitBytes - reservedBytes) return false
    reservedBytes += bytes
    highWaterBytes = Math.max(highWaterBytes, reservedBytes)
    return true
  }

  function lease(release: () => void): NumericalMemoryReservation {
    let active = true
    return Object.freeze({ release: () => {
      if (!active) return
      active = false
      release()
    } })
  }

  return Object.freeze({
    reserveBytes(label: string, bytes: number) {
      return charge(label, bytes) ? lease(() => { reservedBytes -= bytes }) : null
    },
    retainBuffers(label: string, ...roots: readonly unknown[]) {
      const buffers = collectBuffers(roots)
      let newBytes = 0
      for (const buffer of buffers) {
        if (!backings.has(buffer)) newBytes += buffer.maxByteLength ?? buffer.byteLength
      }
      if (!charge(label, newBytes)) return null
      for (const buffer of buffers) {
        const prior = backings.get(buffer)
        backings.set(buffer, { bytes: prior?.bytes ?? buffer.maxByteLength ?? buffer.byteLength, references: (prior?.references ?? 0) + 1 })
      }
      return lease(() => {
        for (const buffer of buffers) {
          const prior = backings.get(buffer)!
          if (prior.references === 1) {
            backings.delete(buffer)
            reservedBytes -= prior.bytes
          } else {
            backings.set(buffer, { ...prior, references: prior.references - 1 })
          }
        }
        buffers.clear()
      })
    },
    snapshot: () => ({ limitBytes, reservedBytes, highWaterBytes }),
  })
}
