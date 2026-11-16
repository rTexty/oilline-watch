import type { NumericalMemoryLedger, NumericalMemoryReservation } from './numerical-memory'

interface CheckpointBacking {
  readonly timeUs: number
  readonly keepSinceUs: number
  readonly states: unknown
}

// Reserve for step temporaries and up to three simultaneous serialized banks:
// active, pending and the next staged job before it is admitted or superseded.
const WORKSPACE_STATE_COPIES = 6

export function createSimulationMemory(ledger: NumericalMemoryLedger) {
  let live: NumericalMemoryReservation | undefined
  let workspace: NumericalMemoryReservation | undefined
  const checkpoints = new Map<number, NumericalMemoryReservation>()

  function track(roots: readonly unknown[], checkpoint?: CheckpointBacking): void {
    const before = ledger.snapshot().reservedBytes
    const next = ledger.retainBuffers('live numerical state', ...roots)
    if (!next) throw new Error('resource-limit: simulation numerical state')
    let workspaceAdmission: NumericalMemoryReservation | undefined
    if (!workspace) {
      const bytes = ledger.snapshot().reservedBytes - before
      workspaceAdmission = ledger.reserveBytes('hydraulic workspace and diagnostic staging', WORKSPACE_STATE_COPIES * bytes) ?? undefined
      if (!workspaceAdmission) {
        next.release()
        throw new Error('resource-limit: simulation numerical workspace')
      }
    }
    if (checkpoint && !checkpoints.has(checkpoint.timeUs)) {
      const retained = ledger.retainBuffers('checkpoint bank', checkpoint.states)
      if (!retained) {
        workspaceAdmission?.release()
        next.release()
        throw new Error('resource-limit: simulation checkpoint bank')
      }
      checkpoints.set(checkpoint.timeUs, retained)
    }
    if (checkpoint) {
      for (const [timeUs, reservation] of checkpoints) {
        if (timeUs >= checkpoint.keepSinceUs) break
        reservation.release()
        checkpoints.delete(timeUs)
      }
    }
    workspace ??= workspaceAdmission
    live?.release()
    live = next
  }

  return { track }
}
