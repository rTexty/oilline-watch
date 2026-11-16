import { PhysicsDomainError, requireDomain, requirePositive, requireRange } from './guards';

const RESIDUAL_TOLERANCE = 1e-12;

function clamond(reynolds: number, relativeRoughness: number): number {
  const x1 = Math.LN10 * relativeRoughness * reynolds / 18.574;
  const x2 = Math.log(Math.LN10 * reynolds / 5.02);
  let z = x2 - 0.2;

  for (let iteration = 0; iteration < 2; iteration++) {
    const sum = x1 + z;
    const correction = (z + Math.log(sum) - x2) / (1 + sum);
    z -= ((1 + sum + correction / 2) * correction * sum) / (1 + sum + correction + correction ** 2 / 3);
  }
  return (Math.LN10 / (2 * z)) ** 2;
}

function colebrookResidual(inverseRoot: number, roughnessTerm: number, reynoldsTerm: number): number {
  return inverseRoot + 2 * Math.log10(roughnessTerm + reynoldsTerm * inverseRoot);
}

function safeguardedNewton(roughnessTerm: number, reynoldsTerm: number): number {
  let low = 1;
  let high = 100;
  requireDomain(
    colebrookResidual(low, roughnessTerm, reynoldsTerm) <= 0 &&
      colebrookResidual(high, roughnessTerm, reynoldsTerm) >= 0,
    'Colebrook root outside the search bracket',
  );
  let inverseRoot = (low + high) / 2;

  for (let iteration = 0; iteration < 100; iteration++) {
    const term = roughnessTerm + reynoldsTerm * inverseRoot;
    const residual = inverseRoot + 2 * Math.log10(term);
    if (Math.abs(residual) <= RESIDUAL_TOLERANCE) return inverseRoot ** -2;

    if (residual > 0) high = inverseRoot;
    else low = inverseRoot;

    const derivative = 1 + 2 * reynoldsTerm / (Math.LN10 * term);
    const candidate = inverseRoot - residual / derivative;
    inverseRoot = candidate > low && candidate < high ? candidate : (low + high) / 2;
  }
  throw new PhysicsDomainError('outside-model-domain', 'Colebrook solver did not converge');
}

export function colebrookDarcyFactor(reynolds: number, relativeRoughness: number, candidateFactor?: number): number {
  requireRange(reynolds, 4000, 1e8, 'Turbulent Reynolds number');
  requireRange(relativeRoughness, 0, 0.05, 'Relative roughness');

  const roughnessTerm = relativeRoughness / 3.7;
  const reynoldsTerm = 2.51 / reynolds;
  const factor = candidateFactor ?? clamond(reynolds, relativeRoughness);
  if (Number.isFinite(factor) && factor > 0 &&
      Math.abs(colebrookResidual(1 / Math.sqrt(factor), roughnessTerm, reynoldsTerm)) <= RESIDUAL_TOLERANCE) {
    return factor;
  }
  return safeguardedNewton(roughnessTerm, reynoldsTerm);
}

export function frictionAcceleration(
  velocityMps: number,
  viscosityM2s: number,
  diameterM: number,
  roughnessM: number,
  stepSeconds = 0,
): number {
  requireDomain(Number.isFinite(velocityMps), 'Velocity must be finite');
  requirePositive(viscosityM2s, 'Kinematic viscosity');
  requirePositive(diameterM, 'Pipe diameter');
  requireRange(roughnessM / diameterM, 0, 0.05, 'Relative roughness');
  requireDomain(Number.isFinite(stepSeconds) && stepSeconds >= 0, 'Invalid source step');

  const speed = Math.abs(velocityMps);
  const reynolds = speed * diameterM / viscosityM2s;
  if (reynolds < 2000) {
    const slope = 32 * viscosityM2s / diameterM ** 2;
    requireDomain(stepSeconds * slope <= 0.1, 'Poiseuille source step exceeds stability limit');
    return slope * velocityMps;
  }
  if (reynolds < 4000) {
    throw new PhysicsDomainError('uncertain-flow-regime', 'Reynolds number is in the unsupported transition band');
  }

  const darcy = colebrookDarcyFactor(reynolds, roughnessM / diameterM);
  requireDomain(stepSeconds * 2 * darcy * speed / diameterM <= 0.1, 'Colebrook source step exceeds stability limit');
  return darcy * velocityMps * speed / (2 * diameterM);
}
