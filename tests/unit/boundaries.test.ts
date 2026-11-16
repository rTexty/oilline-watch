import { describe, expect, it } from 'vitest';
import { solveInlet, solveOutlet } from '../../src/physics/boundaries';

describe('characteristic boundaries', () => {
  it('fixes inlet pressure and outlet flow with correct characteristic signs', () => {
    expect(solveInlet(1200000, 1000000, 1e7)).toEqual({ p: 1200000, q: 0.02 });
    expect(solveOutlet(1500000, 0.02, 1e7)).toEqual({ p: 1300000, q: 0.02 });
    expect(solveOutlet(1500000, 0.01, 1e7).p - solveOutlet(1500000, 0.02, 1e7).p).toBeCloseTo(100000);
  });
});
