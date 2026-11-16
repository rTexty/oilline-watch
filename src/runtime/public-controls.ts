import type { AppliedControl } from '../contracts/public'
import type { ReplayEvent } from './replay-schema'

function isPublicControl(event: ReplayEvent): event is Extract<ReplayEvent, { kind: 'control' | 'active-pulse' }> {
  return event.kind === 'control' || event.kind === 'active-pulse'
}

export function appliedControlRevision(events: readonly ReplayEvent[], timeUs: number): number {
  return events.filter((event) => isPublicControl(event) && event.timeUs <= timeUs).length
}

export function publicControls(events: readonly ReplayEvent[]): readonly AppliedControl[] {
  return events.filter(isPublicControl).map((event, index) => {
    const metadata = { eventOrdinal: index, appliedTimeUs: event.timeUs, controlRevision: index + 1 }
    if (event.kind === 'active-pulse') {
      return { ...metadata, kind: 'active-pulse', commandId: event.commandId, pulse: event.pulse }
    }
    return {
      ...metadata, kind: 'outlet-flow', valueSI: event.outletFlowM3s, rampUs: 0,
      commandId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }
  })
}
