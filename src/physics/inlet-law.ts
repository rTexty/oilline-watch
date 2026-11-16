import { requireDomain, requireRange, requireTimeUs } from './guards'

type Interval = { readonly startUs: number; readonly durationUs: number; readonly baselinePa: number }
export type InletLaw = Interval & (
  | { readonly kind: 'linear-ramp'; readonly targetPa: number }
  | { readonly kind: 'sinusoid'; readonly amplitudePa: number; readonly periodUs: number }
)

export function inletPressureAt(law: InletLaw, timeUs: number, minPa: number, maxPa: number, horizonUs: number): number {
  requireTimeUs(law.startUs)
  requireTimeUs(law.durationUs)
  requireDomain(law.durationUs > 0 && law.startUs + law.durationUs <= horizonUs, 'Invalid inlet waveform interval')
  requireRange(law.baselinePa, minPa, maxPa, 'Waveform baseline pressure')
  const elapsedUs = timeUs - law.startUs
  if (law.kind === 'linear-ramp') {
    requireRange(law.targetPa, minPa, maxPa, 'Waveform target pressure')
    const fraction = Math.min(1, Math.max(0, elapsedUs / law.durationUs))
    return law.baselinePa + (law.targetPa - law.baselinePa) * fraction
  }
  requireTimeUs(law.periodUs)
  requireDomain(law.periodUs > 0 && Number.isFinite(law.amplitudePa), 'Invalid inlet oscillation')
  requireRange(law.baselinePa - Math.abs(law.amplitudePa), minPa, maxPa, 'Waveform minimum pressure')
  requireRange(law.baselinePa + Math.abs(law.amplitudePa), minPa, maxPa, 'Waveform maximum pressure')
  // The prescribed interval includes the final oscillation sample.
  return elapsedUs >= 0 && elapsedUs <= law.durationUs
    ? law.baselinePa + law.amplitudePa * Math.sin(2 * Math.PI * elapsedUs / law.periodUs)
    : law.baselinePa
}

export function nextInletLawBoundary(law: InletLaw, timeUs: number): number {
  if (timeUs < law.startUs) return law.startUs
  const endUs = law.startUs + law.durationUs
  return timeUs < endUs ? endUs : Number.POSITIVE_INFINITY
}
