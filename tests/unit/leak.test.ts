import { describe, expect, it } from 'vitest';
import { nearestLeakNode, openingAt, solveJunction } from '../../src/physics/leak';

describe('leak junction', () => {
  it('places leaks at the nearest internal node', () => {
    expect(nearestLeakNode(0, 1000, 200)).toBe(1);
    expect(nearestLeakNode(1000, 1000, 200)).toBe(199);
    expect(nearestLeakNode(13, 1000, 200)).toBe(3);
  });
  it('handles step and ramp onset and endpoints', () => {
    const ramp = { node: 2, onsetUs: 100, rampUs: 200, cdA: 4e-5 };
    expect(openingAt(ramp, 99)).toBe(0);
    expect(openingAt(ramp, 100)).toBe(0);
    expect(openingAt(ramp, 200)).toBeCloseTo(2e-5);
    expect(openingAt(ramp, 300)).toBeCloseTo(4e-5);
    expect(openingAt({ ...ramp, rampUs: 0 }, 100)).toBe(4e-5);
  });
  it('balances distinct left and right flows, and reduces to an ordinary junction at zero opening', () => {
    const args = [1500000, 900000, 1e7, 850] as const;
    const zero = solveJunction(...args, 0);
    expect(zero.p).toBeCloseTo(1200000);
    expect(zero.qL).toBeCloseTo(zero.qR, 12);
    const leaking = solveJunction(...args, 1e-5);
    expect(leaking.qLeak).toBeGreaterThan(0);
    expect(leaking.qL - leaking.qR).toBeCloseTo(leaking.qLeak, 10);
    expect(leaking.qLeak).toBeCloseTo(1e-5 * Math.sqrt(2 * (leaking.p - 101325) / 850), 10);
  });
  it('preserves flow direction for a tiny positive opening', () => {
    const result = solveJunction(1_500_000, 900_000, 1e7, 850, 1e-16);
    expect(result.qL).toBeGreaterThanOrEqual(result.qR);
  });
  it('rejects an unbracketed junction', () => {
    expect(() => solveJunction(100000, 100000, 1e7, 850, 1e-5)).toThrow();
  });
});
