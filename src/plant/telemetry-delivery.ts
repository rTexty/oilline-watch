import type { Measurement, SensorId } from '../contracts/public'

export { ADVERSE_MAX_DELIVERY_DELAY_US } from '../contracts/public'

const MAX_READINGS_PER_BATCH = 16

export function deliverTelemetry(
  previousPending: readonly Measurement[],
  generated: readonly Measurement[],
  throughUs: number,
): { readonly pending: readonly Measurement[]; readonly measurements: readonly Measurement[] } {
  if (!Number.isSafeInteger(throughUs) || throughUs < 0) throw new RangeError('Invalid telemetry cutoff.')
  if (previousPending.length + generated.length > MAX_READINGS_PER_BATCH) {
    throw new RangeError('Telemetry queue exceeded the public batch limit.')
  }

  const pending: Measurement[] = []
  const measurements: Measurement[] = []
  const latestBySensor = new Map<SensorId, Measurement>()
  for (const reading of [...previousPending, ...generated]) {
    const prior = latestBySensor.get(reading.sensorId)
    if (prior && (reading.sampleSeq <= prior.sampleSeq || reading.sampleTimeUs <= prior.sampleTimeUs)) {
      throw new RangeError('Telemetry input must be ordered by sensor sequence.')
    }

    // The reorder buffer makes a sample available only after its predecessor.
    const deliveredTimeUs = Math.max(reading.deliveredTimeUs, prior?.deliveredTimeUs ?? 0)
    const ordered = deliveredTimeUs === reading.deliveredTimeUs ? reading : { ...reading, deliveredTimeUs }
    latestBySensor.set(ordered.sensorId, ordered)
    if (deliveredTimeUs <= throughUs) measurements.push(ordered)
    else pending.push(ordered)
  }
  return { pending, measurements }
}
