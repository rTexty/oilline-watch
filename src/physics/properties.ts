import { requireDomain, requirePositive, requireRange } from './guards';
import { centistokesToM2s } from './units';

interface WaltherAnchor {
  readonly temperatureK: number;
  readonly viscosityM2s: number;
}

const SYNTHETIC_TEMPERATURE_MIN_K = 308.15;
const SYNTHETIC_TEMPERATURE_MAX_K = 338.15;

export interface WaltherCoefficients {
  readonly aw: number;
  readonly bw: number;
}

function transformedViscosity(viscosityM2s: number): number {
  const viscosityCst = viscosityM2s * 1e6;
  requireDomain(Number.isFinite(viscosityCst) && viscosityCst > 0.2, 'Viscosity outside Walther fit domain');
  return Math.log(Math.log(viscosityCst + 0.8));
}

export function waltherCoefficients(first: WaltherAnchor, second: WaltherAnchor): WaltherCoefficients {
  requireRange(first.temperatureK, SYNTHETIC_TEMPERATURE_MIN_K, SYNTHETIC_TEMPERATURE_MAX_K, 'First anchor temperature');
  requireRange(second.temperatureK, SYNTHETIC_TEMPERATURE_MIN_K, SYNTHETIC_TEMPERATURE_MAX_K, 'Second anchor temperature');
  requireDomain(first.temperatureK < second.temperatureK, 'Walther anchor temperatures must increase');
  const firstLogT = Math.log(first.temperatureK);
  const secondLogT = Math.log(second.temperatureK);
  const firstY = transformedViscosity(first.viscosityM2s);
  const secondY = transformedViscosity(second.viscosityM2s);
  const bw = (firstY - secondY) / (secondLogT - firstLogT);
  requirePositive(bw, 'Walther slope');
  return { aw: firstY + bw * firstLogT, bw };
}

export function waltherViscosity(
  temperatureK: number,
  { aw, bw }: WaltherCoefficients,
  minK = SYNTHETIC_TEMPERATURE_MIN_K,
  maxK = SYNTHETIC_TEMPERATURE_MAX_K,
): number {
  requireRange(temperatureK, minK, maxK, 'Oil temperature');
  const viscosity = centistokesToM2s(Math.exp(Math.exp(aw - bw * Math.log(temperatureK))) - 0.8);
  requirePositive(viscosity, 'Walther viscosity');
  return viscosity;
}

export function waveSpeed(
  densityKgM3: number,
  bulkModulusPa: number,
  diameterM: number,
  wallThicknessM: number,
  youngModulusPa: number,
  restraint: number,
): number {
  requirePositive(densityKgM3, 'Density');
  requirePositive(bulkModulusPa, 'Isentropic bulk modulus');
  requirePositive(diameterM, 'Pipe diameter');
  requirePositive(wallThicknessM, 'Wall thickness');
  requirePositive(youngModulusPa, 'Young modulus');
  requireDomain(Number.isFinite(restraint) && restraint >= 0, 'Invalid pipe restraint');
  const compliance = restraint * bulkModulusPa * diameterM / (youngModulusPa * wallThicknessM);
  const speed = Math.sqrt(bulkModulusPa / densityKgM3 / (1 + compliance));
  requirePositive(speed, 'Wave speed');
  return speed;
}
