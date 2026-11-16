export type DomainCode = 'outside-model-domain' | 'uncertain-flow-regime' | 'unsupported-physics';

export class PhysicsDomainError extends RangeError {
  constructor(readonly code: DomainCode, message: string) {
    super(message);
    this.name = 'PhysicsDomainError';
  }
}

export function requireDomain(condition: boolean, message: string): asserts condition {
  if (!condition) throw new PhysicsDomainError('outside-model-domain', message);
}

export function requireTimeUs(timeUs: number): void {
  requireDomain(Number.isSafeInteger(timeUs) && timeUs >= 0, 'Expected nonnegative integer microseconds');
}

export function requireRange(value: number, min: number, max: number, label: string): void {
  requireDomain(Number.isFinite(value) && value >= min && value <= max, `${label} outside model domain`);
}

export function requirePositive(value: number, label: string): void {
  requireDomain(Number.isFinite(value) && value > 0, `${label} must be positive and finite`);
}

export function requireFlowRegime(reynolds: number, velocityMps: number, laminar: boolean): void {
  if (reynolds >= 2000 && reynolds < 4000) {
    throw new PhysicsDomainError('uncertain-flow-regime', 'Reynolds number is in the unsupported transition band');
  }
  requireDomain(
    Number.isFinite(reynolds) && reynolds >= 0 && Number.isFinite(velocityMps) &&
      (laminar ? reynolds < 2000 : reynolds >= 4000 && reynolds <= 1e8 && velocityMps > 0),
    'Flow is outside the profile regime',
  );
}
