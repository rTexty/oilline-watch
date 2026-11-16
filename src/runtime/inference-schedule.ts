import { CHALLENGE_HORIZON_US, CHALLENGE_WARMUP_US } from '../contracts/model'
import { PRESSURE_PERIOD_US } from '../contracts/public'

const SECOND_US = 1_000_000
const SHORT_US = 4 * SECOND_US
const LONG_US = 30 * SECOND_US
const GUARD_US = 3 * SECOND_US

export interface DiagnosticWindow {
  readonly startUs: number
  readonly endUs: number
  readonly durationUs: 4_000_000 | 30_000_000
  readonly priority: 'regular' | 'alarm'
}

type WindowPriority = Pick<DiagnosticWindow, 'priority' | 'durationUs'>

export function preservePendingWindow(
  pending: WindowPriority | undefined, incoming: WindowPriority, activeDurationUs: number | undefined,
): boolean {
  if (!pending) return false
  if (pending.priority !== incoming.priority) return pending.priority === 'alarm'
  if (pending.priority === 'alarm' || pending.durationUs === incoming.durationUs) return false
  return activeDurationUs === incoming.durationUs
}

interface WindowSchedule {
  readonly shortThroughUs: number
  readonly longThroughUs: number
}

export function initialInferenceSchedule(): WindowSchedule {
  return { shortThroughUs: -1, longThroughUs: -1 }
}

export function admitWindows(previous: WindowSchedule, timeUs: number, alarmOpened = false) {
  if (!Number.isSafeInteger(timeUs) || timeUs % PRESSURE_PERIOD_US !== 0
    || timeUs < CHALLENGE_WARMUP_US || timeUs > CHALLENGE_HORIZON_US) return { state: previous, windows: [] }
  const elapsed = timeUs - CHALLENGE_WARMUP_US
  const short = timeUs > previous.shortThroughUs && (alarmOpened || (elapsed > 0 && elapsed % SECOND_US === 0))
  const long = timeUs > previous.longThroughUs && timeUs >= LONG_US + GUARD_US && elapsed % (5 * SECOND_US) === 0
  const windows: readonly DiagnosticWindow[] = [
    ...(short ? [{ startUs: timeUs - SHORT_US, endUs: timeUs, durationUs: 4_000_000 as const,
      priority: alarmOpened ? 'alarm' as const : 'regular' as const }] : []),
    ...(long ? [{ startUs: timeUs - LONG_US, endUs: timeUs, durationUs: 30_000_000 as const, priority: 'regular' as const }] : []),
  ]
  return { state: {
    shortThroughUs: short ? timeUs : previous.shortThroughUs,
    longThroughUs: long ? timeUs : previous.longThroughUs,
  }, windows }
}
