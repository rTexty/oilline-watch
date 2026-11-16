import { describe, expect, it } from 'vitest';
import { colebrookDarcyFactor, frictionAcceleration } from '../../src/physics/friction';

function referenceFactor(re: number, roughness: number): number {
  let lo = 1, hi = 100;
  for (let i = 0; i < 100; i++) {
    const y = (lo + hi) / 2;
    if (y + 2 * Math.log10(roughness / 3.7 + 2.51 * y / re) > 0) hi = y;
    else lo = y;
  }
  return 1 / ((lo + hi) / 2) ** 2;
}

describe('friction', () => {
  it.each([[4000, 0], [16000, 0.0001], [1e8, 0.001]])('matches an independent Colebrook bisection at Re=%s', (re, roughness) => {
    expect(colebrookDarcyFactor(re, roughness)).toBeCloseTo(referenceFactor(re, roughness), 11);
  });
  it('falls back to a bracketed solution when a candidate fails its residual check', () => {
    expect(colebrookDarcyFactor(16000, 0.0001, NaN)).toBeCloseTo(referenceFactor(16000, 0.0001), 11);
    expect(colebrookDarcyFactor(16000, 0.0001, 1)).toBeCloseTo(referenceFactor(16000, 0.0001), 11);
  });
  it('has signed Poiseuille friction and a well-defined zero', () => {
    expect(frictionAcceleration(0, 1e-4, 0.2, 1e-5)).toBe(0);
    expect(frictionAcceleration(0.01, 1e-4, 0.2, 1e-5)).toBeCloseTo(32 * 1e-4 * 0.01 / 0.2 ** 2, 14);
    expect(frictionAcceleration(-0.01, 1e-4, 0.2, 1e-5)).toBeCloseTo(-32 * 1e-4 * 0.01 / 0.2 ** 2, 14);
  });
  it('rejects uncertain transition and invalid parameters', () => {
    expect(() => frictionAcceleration(1, 1e-4, 0.2, 1e-5)).toThrow();
    expect(() => frictionAcceleration(1, 0, 0.2, 1e-5)).toThrow();
    expect(() => colebrookDarcyFactor(NaN, 0)).toThrow();
  });
});
