import type { SensorId } from '../contracts/public'

export type SensorFault =
  | { readonly kind: 'bias'; readonly offsetSI: number }
  | { readonly kind: 'dropout' }
  | { readonly kind: 'stuck-zero' }
  | { readonly kind: 'validation-drift'; readonly offsetSI: number; readonly startUs: number; readonly durationUs: number }
  | { readonly kind: 'validation-hold'; readonly valueSI: number | null; readonly untilUs: number }

export type SensorFaults = Readonly<Partial<Record<SensorId, SensorFault>>>
export type SensorFaultChange = SensorFault | { readonly kind: 'clear' }

function validOffset(offsetSI: number): number {
  if (!Number.isFinite(offsetSI)) throw new RangeError('Sensor bias must be finite.')
  return offsetSI
}

export function setSensorFault(faults: SensorFaults, sensorId: SensorId, change: SensorFaultChange): SensorFaults {
  if (change.kind === 'clear') {
    return Object.fromEntries(Object.entries(faults).filter(([id]) => id !== sensorId))
  }
  if (change.kind === 'bias' || change.kind === 'validation-drift') validOffset(change.offsetSI)
  if (change.kind === 'validation-drift' && (!Number.isSafeInteger(change.startUs) || change.startUs < 0
    || !Number.isSafeInteger(change.durationUs) || change.durationUs <= 0)) {
    throw new RangeError('Invalid sensor drift interval.')
  }
  if (change.kind === 'validation-hold' && (!Number.isSafeInteger(change.untilUs) || change.untilUs <= 0
    || (change.valueSI !== null && !Number.isFinite(change.valueSI)))) throw new RangeError('Invalid held sensor sample.')
  return { ...faults, [sensorId]: { ...change } }
}

export function faultedReading(nominalSI: number, fault: SensorFault | undefined, timeUs: number): number | null {
  switch (fault?.kind) {
    case 'bias': return nominalSI + validOffset(fault.offsetSI)
    case 'dropout': return null
    case 'stuck-zero': return 0
    case 'validation-drift':
      return nominalSI + fault.offsetSI * Math.max(0, Math.min(1, (timeUs - fault.startUs) / fault.durationUs))
    case 'validation-hold': return timeUs < fault.untilUs ? fault.valueSI : nominalSI
    case undefined: return nominalSI
  }
}
