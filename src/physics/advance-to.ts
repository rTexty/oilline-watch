import { PhysicsDomainError, requireDomain, requireTimeUs } from './guards';
import { nextInletLawBoundary } from './inlet-law';
import { step, validateInputs } from './moc';
import { nextOutletPulseBoundary } from './outlet-pulse';
import { mergeHydraulicInputs } from './state';
import type { HydraulicFieldBackend } from './moc';
import type { HydraulicInputs, HydraulicState, PhysicsResult } from './state';

export interface HydraulicEvent {
  readonly timeUs: number;
  readonly inputs: HydraulicInputs;
}

function applyInputs(state: HydraulicState, changes: HydraulicInputs, isEvent: boolean): HydraulicState {
  const inputs = mergeHydraulicInputs(state.inputs, changes);
  validateInputs(state, inputs);
  return { ...state, inputs, eventCursor: state.eventCursor + Number(isEvent) };
}

function checkDeadlines(state: HydraulicState, targetTimeUs: number, events: readonly HydraulicEvent[]): void {
  requireTimeUs(targetTimeUs);
  requireDomain(targetTimeUs >= state.timeUs && targetTimeUs <= state.profile.definition.horizonUs, 'Invalid hydraulic deadline');
  const fixedStep = state.profile.definition.mode === 'laminar' ? state.profile.stepUs : null;
  requireDomain(fixedStep === null || targetTimeUs % fixedStep === 0, 'Laminar deadline must lie on the fixed grid');
  let previousTimeUs = state.timeUs;
  for (const event of events) {
    requireTimeUs(event.timeUs);
    requireDomain(event.timeUs >= previousTimeUs && event.timeUs <= targetTimeUs, 'Hydraulic events must be ordered within the interval');
    requireDomain(fixedStep === null || event.timeUs % 10_000 === 0, 'Laminar event must lie on the command grid');
    previousTimeUs = event.timeUs;
  }
}

function nextStepUs(state: HydraulicState, deadline: number): number {
  const { profile, timeUs, thermalFlow } = state;
  const thermalRemainingUs = profile.definition.thermal.stepUs - thermalFlow.elapsedUs;
  const leak = state.inputs.leak;
  let remainingUs = deadline - timeUs;
  if (state.inputs.inletLaw) remainingUs = Math.min(remainingUs, nextInletLawBoundary(state.inputs.inletLaw, timeUs) - timeUs);
  if (state.inputs.outletPulse) {
    remainingUs = Math.min(remainingUs, nextOutletPulseBoundary(state.inputs.outletPulse, timeUs) - timeUs);
  }
  if (leak) {
    if (leak.onsetUs > timeUs) remainingUs = Math.min(remainingUs, leak.onsetUs - timeUs);
    const rampEndUs = leak.onsetUs + leak.rampUs;
    if (rampEndUs > timeUs) remainingUs = Math.min(remainingUs, rampEndUs - timeUs);
  }
  return Math.min(remainingUs, profile.stepUs, thermalRemainingUs);
}

export function advanceTo(
  previous: HydraulicState,
  targetTimeUs: number,
  inputs?: HydraulicInputs,
  events: readonly HydraulicEvent[] = [],
  solveFields?: HydraulicFieldBackend,
): PhysicsResult {
  let current = previous;
  try {
    checkDeadlines(previous, targetTimeUs, events);
    if (inputs) current = applyInputs(current, inputs, false);
    let eventIndex = 0;
    while (current.timeUs < targetTimeUs || eventIndex < events.length) {
      const event = events[eventIndex];
      if (event && current.timeUs === event.timeUs) {
        current = applyInputs(current, event.inputs, true);
        eventIndex++;
      } else {
        current = step(current, { dtUs: nextStepUs(current, event?.timeUs ?? targetTimeUs) }, solveFields);
      }
    }
    return { ok: true, value: current };
  } catch (error) {
    if (error instanceof PhysicsDomainError) return { ok: false, error, lastValidState: current };
    if (error instanceof RangeError) {
      return {
        ok: false,
        error: new PhysicsDomainError('outside-model-domain', error.message),
        lastValidState: current,
      };
    }
    throw error;
  }
}
