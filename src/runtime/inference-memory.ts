import type { PublicPredictionCheckpoint } from '../contracts/inference'
import type { NumericalMemoryLedger } from './numerical-memory'

function restoredFieldBytes(checkpoint: PublicPredictionCheckpoint): number {
  const { pressurePa, leftFlowM3s, rightFlowM3s, oilTemperatureK, wallTemperatureK, thermalFlow } = checkpoint
  const { leftPositiveM3, leftNegativeM3, rightPositiveM3, rightNegativeM3 } = thermalFlow
  // Each field is copied by restoreCheckpoint, even if the input fields alias.
  // Inference restores turbulent anchors, which have no unsteady-friction buffers.
  return pressurePa.byteLength + leftFlowM3s.byteLength + rightFlowM3s.byteLength
    + oilTemperatureK.byteLength + wallTemperatureK.byteLength + leftPositiveM3.byteLength
    + leftNegativeM3.byteLength + rightPositiveM3.byteLength + rightNegativeM3.byteLength
}

export function inverseForwardWorkspaceBytes(checkpoints: readonly PublicPredictionCheckpoint[]): number {
  let contextBytes = 0
  let largestTrialBytes = 0
  for (const checkpoint of checkpoints) {
    const stateBytes = restoredFieldBytes(checkpoint)
    const { cellCount, faceCount } = checkpoint.grid
    // advanceTo can hold its input, the current state and the newly allocated state.
    // The thermal tick also builds a four-face accumulator before clearing it,
    // with one cell array each for advection and hydraulic viscosity.
    const stepScratch = Float64Array.BYTES_PER_ELEMENT * (4 * faceCount + 2 * cellCount)
    largestTrialBytes = Math.max(largestTrialBytes, 3 * stateBytes + stepScratch)
    contextBytes += stateBytes
  }
  // The search awaits each forward trial before starting another one.
  return contextBytes + largestTrialBytes
}

export async function withForwardPrefixWorkspace<T>(
  memory: NumericalMemoryLedger, bytes: number, task: (enabled: boolean) => Promise<T>, onMemoryChange?: () => void,
): Promise<T> {
  const lease = bytes === 0 ? null : memory.reserveBytes('inverse hydraulic prefix states', bytes)
  if (!lease) return task(false)
  try {
    onMemoryChange?.()
    return await task(true)
  } finally {
    lease.release()
    onMemoryChange?.()
  }
}
