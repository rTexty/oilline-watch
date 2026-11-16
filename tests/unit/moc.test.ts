import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { profileSchema } from '../../src/contracts/model';
import { initialize } from '../../src/physics/initialize';
import { step } from '../../src/physics/moc';

function initial() {
  const result = initialize(profileSchema.parse(JSON.parse(readFileSync('src/scenarios/synthetic-oil-turbulent-v1.json', 'utf8'))));
  if (!result.ok) throw new Error('initialization failed');
  return result.value;
}

describe('MOC stepping', () => {
  it.each([5000, 1250])('preserves the steady profile at %s microseconds and does not mutate its input', (dtUs) => {
    const state = initial();
    const pressure = Array.from(state.p);
    const flow = Array.from(state.qL);
    const next = step(state, { dtUs });
    expect(state.timeUs).toBe(0);
    expect(Array.from(state.p)).toEqual(pressure);
    expect(next.p).not.toBe(state.p);
    expect(next.timeUs).toBe(dtUs);
    pressure.forEach((p, i) => expect(next.p[i]).toBeCloseTo(p, 6));
    flow.forEach((q, i) => expect(next.qL[i]).toBeCloseTo(q, 11));
  });
  it('produces the Joukowsky pressure rise at the outlet when flow decreases', () => {
    const state = initial();
    const last = state.p.length - 1;
    const deltaQ = 1e-4;
    const next = step(state, { dtUs: 5000, qoutM3s: state.qR[last]! - deltaQ });
    expect(next.p[last]! - state.p[last]!).toBeCloseTo(state.profile.impedance * deltaQ, 5);
  });
  it('rejects a step beyond the CFL limit', () => {
    expect(() => step(initial(), { dtUs: 5001 })).toThrow();
  });
});

describe('laminar profile guards', () => {
  function laminar() {
    const result = initialize(profileSchema.parse(JSON.parse(readFileSync('src/scenarios/synthetic-oil-laminar-v1.json', 'utf8'))));
    if (!result.ok) throw new Error('initialization failed');
    return result.value;
  }

  it('rejects leak and thermal forcing in the isothermal laboratory', () => {
    const state = laminar();
    expect(() => step(state, { dtUs: 10_000, leak: { node: 2, onsetUs: 0, rampUs: 0, cdA: 1e-5 } })).toThrow();
    expect(() => step(state, { dtUs: 10_000, tinK: 320 })).toThrow();
  });
});

describe('event boundaries', () => {
  it('rejects a direct step that crosses a future leak onset', () => {
    expect(() => step(initial(), { dtUs: 5000, leak: { node: 50, onsetUs: 2500, rampUs: 0, cdA: 1e-5 } })).toThrow();
  });
});
