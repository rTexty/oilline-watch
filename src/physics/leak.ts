import { requireDomain, requirePositive, requireRange, requireTimeUs } from './guards';

export interface LeakLaw {
  readonly node: number;
  readonly onsetUs: number;
  readonly rampUs: number;
  readonly cdA: number;
}

interface Junction {
  readonly p: number;
  readonly qL: number;
  readonly qR: number;
  readonly qLeak: number;
}

export function nearestLeakNode(xM: number, lengthM: number, segments: number): number {
  requirePositive(lengthM, 'Pipe length');
  requireRange(xM, 0, lengthM, 'Leak position');
  requireDomain(Number.isSafeInteger(segments) && segments >= 2, 'Invalid grid segment count');
  return Math.max(1, Math.min(segments - 1, Math.round(xM * segments / lengthM)));
}

export function openingAt(law: LeakLaw, timeUs: number): number {
  requireTimeUs(timeUs);
  requireTimeUs(law.onsetUs);
  requireTimeUs(law.rampUs);
  requireRange(law.rampUs, 0, 20_000_000, 'Opening duration');
  requireRange(law.cdA, 0, 4e-5, 'Effective orifice area');
  if (timeUs < law.onsetUs) return 0;
  if (law.rampUs === 0) return law.cdA;
  return law.cdA * Math.min((timeUs - law.onsetUs) / law.rampUs, 1);
}

export function solveJunction(
  plusPa: number,
  minusPa: number,
  impedance: number,
  densityKgM3: number,
  cdA: number,
  externalPressurePa = 101325,
  referenceFlowM3s = 0.02513274122871835,
  pressureMinPa = 250000,
  pressureMaxPa = 2000000,
): Junction {
  requirePositive(impedance, 'Characteristic impedance');
  requirePositive(densityKgM3, 'Oil density');
  requirePositive(referenceFlowM3s, 'Reference flow');
  requireRange(cdA, 0, 4e-5, 'Effective orifice area');
  requireDomain(Number.isFinite(plusPa) && Number.isFinite(minusPa), 'Invalid leak characteristics');
  if (cdA === 0) {
    const p = (plusPa + minusPa) / 2;
    requireRange(p, pressureMinPa, pressureMaxPa, 'Junction pressure');
    const q = (plusPa - minusPa) / (2 * impedance);
    return { p, qL: q, qR: q, qLeak: 0 };
  }

  requireDomain(Number.isFinite(externalPressurePa) && pressureMinPa > externalPressurePa, 'Orifice head outside phase domain');
  const tolerance = 1e-10 * referenceFlowM3s;
  let low = pressureMinPa;
  let high = pressureMaxPa;
  const at = (p: number): Junction => ({
    p,
    qL: (plusPa - p) / impedance,
    qR: (p - minusPa) / impedance,
    qLeak: cdA * Math.sqrt(2 * (p - externalPressurePa) / densityKgM3),
  });
  const residual = ({ qL, qR, qLeak }: Junction) => qL - qR - qLeak;

  const left = at(low);
  const right = at(high);
  const leftResidual = residual(left);
  const rightResidual = residual(right);
  requireDomain(leftResidual >= 0 && rightResidual <= 0, 'Leak junction root outside the pressure bracket');
  if (leftResidual <= tolerance) return left;
  if (rightResidual === 0) return right;

  for (let iteration = 0; iteration < 80; iteration++) {
    const middle = at((low + high) / 2);
    const mismatch = residual(middle);
    // Accept the lower side of the bracket so a tiny withdrawal cannot appear as an inflow.
    if (mismatch >= 0 && mismatch <= tolerance) return middle;
    if (mismatch > 0) low = middle.p;
    else high = middle.p;
  }
  requireDomain(false, 'Leak junction solver did not converge');
}
