import type { Calibration } from '../contracts/calibration'
import { loadQualifiedSpatialEnvelope, MAX_SPATIAL_ARTIFACT_BYTES, SPATIAL_ARTIFACT_FILENAME } from '../detection/qualified-spatial-profile'
import type { QualifiedSpatialEnvelope } from '../detection/qualified-spatial-profile'
import { ENVELOPE_CELL_COUNT } from '../detection/spatial-envelope'
import type { NumericalMemoryLedger, NumericalMemoryReservation } from './numerical-memory'
import { readWorkerReleaseAsset } from './release-assets'

interface ReservedSpatialEnvelope {
  readonly envelope: QualifiedSpatialEnvelope
  readonly reservation: NumericalMemoryReservation
}

export async function loadReservedSpatialEnvelope(
  calibration: Calibration, memory: NumericalMemoryLedger,
): Promise<ReservedSpatialEnvelope | null> {
  if (!calibration.errorEnvelope.spatialArtifactSha256) return null
  const workspace = memory.reserveBytes('spatial envelope decoding', 4 * MAX_SPATIAL_ARTIFACT_BYTES)
  if (!workspace) return null
  try {
    const bytes = await readWorkerReleaseAsset(`calibration/${SPATIAL_ARTIFACT_FILENAME}`, MAX_SPATIAL_ARTIFACT_BYTES)
    const envelope = await loadQualifiedSpatialEnvelope(bytes, calibration)
    if (!envelope) return null
    const reservation = memory.reserveBytes('spatial discrepancy norms', ENVELOPE_CELL_COUNT * Float64Array.BYTES_PER_ELEMENT)
    return reservation ? { envelope, reservation } : null
  } catch {
    return null
  } finally {
    workspace.release()
  }
}
