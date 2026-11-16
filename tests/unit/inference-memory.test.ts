import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { initialize } from '../../src/physics/initialize'
import { createCheckpointAnchor, makeCheckpoint, restoreCheckpoint } from '../../src/twin/checkpoint'
import { inverseForwardWorkspaceBytes, withForwardPrefixWorkspace } from '../../src/runtime/inference-memory'
import { createNumericalMemoryLedger } from '../../src/runtime/numerical-memory'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'

describe('inverse forward memory sizing', () => {
  it('matches restored checkpoint backing bytes and reserves one largest serial trial', async () => {
    const definitions = [200, 400].map((segments) => profileSchema.parse({
      ...rawProfile, grid: { segments, nominalStepUs: rawProfile.grid.nominalStepUs * rawProfile.grid.segments / segments },
    }))
    const anchors = await Promise.all(definitions.map((profile, index) => createCheckpointAnchor(index === 0 ? 0 : 1, profile)))
    const checkpoints = anchors.map((anchor) => {
      const initial = initialize(anchor.definition)
      if (!initial.ok) throw initial.error
      return makeCheckpoint(initial.value, anchor)
    })
    const restoredBytes = checkpoints.map((checkpoint, index) => {
      const state = restoreCheckpoint(checkpoint, anchors[index]!)
      if (!state.ok) throw state.error
      const memory = createNumericalMemoryLedger('inference')
      expect(memory.retainBuffers('restored state', state.value)).not.toBeNull()
      return memory.snapshot().reservedBytes
    })

    const largest = checkpoints[1]!
    const thermalScratch = Float64Array.BYTES_PER_ELEMENT * (4 * largest.grid.faceCount + 2 * largest.grid.cellCount)
    const expectedTrialPeak = 3 * restoredBytes[1]! + thermalScratch
    const expectedContext = restoredBytes.reduce((sum, bytes) => sum + bytes, 0)
    expect(inverseForwardWorkspaceBytes(checkpoints)).toBe(expectedContext + expectedTrialPeak)
  })
})


describe('optional inverse prefix workspace', () => {
  it('runs without a lease when the estimated size is zero', async () => {
    const memory = createNumericalMemoryLedger(100)
    const existing = memory.reserveBytes('existing work', 40)
    expect(existing).not.toBeNull()
    const notifications: number[] = []
    const received: boolean[] = []
    const result = await withForwardPrefixWorkspace(memory, 0, async (enabled) => {
      received.push(enabled)
      expect(memory.snapshot().reservedBytes).toBe(40)
      await Promise.resolve()
      return 'completed'
    }, () => { notifications.push(memory.snapshot().reservedBytes) })

    expect(result).toBe('completed')
    expect(received).toEqual([false])
    expect(memory.snapshot()).toEqual({ limitBytes: 100, reservedBytes: 40, highWaterBytes: 40 })
    expect(notifications).toEqual([])
    existing?.release()
  })

  it('falls back to the same task without disturbing existing reservations when quota is exhausted', async () => {
    const memory = createNumericalMemoryLedger(100)
    const existing = memory.reserveBytes('existing work', 70)
    expect(existing).not.toBeNull()
    const notifications: number[] = []
    const received: boolean[] = []
    const result = await withForwardPrefixWorkspace(memory, 31, async (enabled) => {
      received.push(enabled)
      expect(memory.snapshot().reservedBytes).toBe(70)
      return 'fallback'
    }, () => { notifications.push(memory.snapshot().reservedBytes) })

    expect(result).toBe('fallback')
    expect(received).toEqual([false])
    expect(memory.snapshot()).toEqual({ limitBytes: 100, reservedBytes: 70, highWaterBytes: 70 })
    expect(notifications).toEqual([])
    existing?.release()
  })

  it('holds the lease until the asynchronous task completes and then releases it', async () => {
    const memory = createNumericalMemoryLedger(100)
    const existing = memory.reserveBytes('existing work', 30)
    expect(existing).not.toBeNull()
    const notifications: number[] = []
    const received: boolean[] = []
    const result = await withForwardPrefixWorkspace(memory, 50, async (enabled) => {
      received.push(enabled)
      expect(memory.snapshot().reservedBytes).toBe(80)
      await Promise.resolve()
      expect(memory.snapshot().reservedBytes).toBe(80)
      return 'cached'
    }, () => { notifications.push(memory.snapshot().reservedBytes) })

    expect(result).toBe('cached')
    expect(received).toEqual([true])
    expect(memory.snapshot()).toEqual({ limitBytes: 100, reservedBytes: 30, highWaterBytes: 80 })
    expect(notifications).toEqual([80, 30])
    existing?.release()
  })

  it('releases the lease if the admission notification throws', async () => {
    const memory = createNumericalMemoryLedger(100)
    const existing = memory.reserveBytes('existing work', 30)
    expect(existing).not.toBeNull()
    const notifications: number[] = []
    const failure = new Error('notification failed')
    let taskStarted = false

    await expect(withForwardPrefixWorkspace(memory, 50, async () => {
      taskStarted = true
    }, () => {
      const reserved = memory.snapshot().reservedBytes
      notifications.push(reserved)
      if (reserved === 80) throw failure
    })).rejects.toBe(failure)
    expect(taskStarted).toBe(false)
    expect(memory.snapshot()).toEqual({ limitBytes: 100, reservedBytes: 30, highWaterBytes: 80 })
    expect(notifications).toEqual([80, 30])
    existing?.release()
  })

  it('releases the lease and reports memory changes when the task rejects', async () => {
    const memory = createNumericalMemoryLedger(100)
    const existing = memory.reserveBytes('existing work', 30)
    expect(existing).not.toBeNull()
    const notifications: number[] = []
    const failure = new Error('inference failed')

    await expect(withForwardPrefixWorkspace(memory, 50, async (enabled) => {
      expect(enabled).toBe(true)
      expect(memory.snapshot().reservedBytes).toBe(80)
      throw failure
    }, () => { notifications.push(memory.snapshot().reservedBytes) })).rejects.toBe(failure)
    expect(memory.snapshot()).toEqual({ limitBytes: 100, reservedBytes: 30, highWaterBytes: 80 })
    expect(notifications).toEqual([80, 30])
    existing?.release()
  })
})
