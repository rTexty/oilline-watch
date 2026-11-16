export interface OutletPulse {
  readonly deltaOutletFlowM3s: number;
  readonly rampUs: number;
  readonly holdUs: number;
  readonly returnUs: number;
}

export interface OutletPulseLaw {
  readonly startUs: number;
  readonly pulse: OutletPulse;
}

export function outletPulseEnd(law: OutletPulseLaw): number {
  return law.startUs + law.pulse.rampUs + law.pulse.holdUs + law.pulse.returnUs;
}

export function outletPulseDelta(law: OutletPulseLaw, timeUs: number): number {
  const { deltaOutletFlowM3s, rampUs, holdUs, returnUs } = law.pulse;
  const elapsedUs = timeUs - law.startUs;
  if (elapsedUs <= 0) return 0;
  if (elapsedUs < rampUs) return deltaOutletFlowM3s * (elapsedUs / rampUs);
  if (elapsedUs <= rampUs + holdUs) return deltaOutletFlowM3s;
  return deltaOutletFlowM3s * Math.max(0, (outletPulseEnd(law) - timeUs) / returnUs);
}

export function nextOutletPulseBoundary(law: OutletPulseLaw, timeUs: number): number {
  const rampEnd = law.startUs + law.pulse.rampUs;
  const holdEnd = rampEnd + law.pulse.holdUs;
  const end = outletPulseEnd(law);
  if (timeUs < law.startUs) return law.startUs;
  if (timeUs < rampEnd) return rampEnd;
  if (timeUs < holdEnd) return holdEnd;
  return timeUs < end ? end : Infinity;
}
