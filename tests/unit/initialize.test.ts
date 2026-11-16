import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { profileSchema } from '../../src/contracts/model';
import { initialize } from '../../src/physics/initialize';

const profile = () => profileSchema.parse(JSON.parse(readFileSync('src/scenarios/synthetic-oil-turbulent-v1.json', 'utf8')));

describe('steady initialization', () => {
  it('starts at zero model time with constant flow and decreasing pressure', () => {
    const result = initialize(profile());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('initialization failed');
    const state = result.value;
    expect(state.timeUs).toBe(0);
    expect(state.p[0]!).toBeGreaterThan(state.p[state.p.length - 1]!);
    expect(Math.max(...state.qL) - Math.min(...state.qL)).toBeLessThan(1e-12);
    expect(Array.from(state.tOil).every((value) => value === 313.15)).toBe(true);
  });
});
