import { requireDomain, requirePositive } from './guards';

export function solveInlet(pinPa: number, minusPa: number, impedance: number): { p: number; q: number } {
  requirePositive(impedance, 'Characteristic impedance');
  requireDomain(Number.isFinite(pinPa) && Number.isFinite(minusPa), 'Invalid inlet characteristic');
  return { p: pinPa, q: (pinPa - minusPa) / impedance };
}

export function solveOutlet(plusPa: number, qoutM3s: number, impedance: number): { p: number; q: number } {
  requirePositive(impedance, 'Characteristic impedance');
  requireDomain(Number.isFinite(plusPa) && Number.isFinite(qoutM3s), 'Invalid outlet characteristic');
  return { p: plusPa - impedance * qoutM3s, q: qoutM3s };
}
