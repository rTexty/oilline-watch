import { describe, expect, it } from 'vitest';
import { createVardyBrownKernel, initializeVardyBrown, updateVardyBrown, vardyBrownStepWeights } from '../../src/physics/vardy-brown';

const options = { viscosityM2s: 1e-5, diameterM: 0.2, roughnessM: 0.000045, referenceVelocityMps: 0.8 };

describe('Vardy–Brown unsteady friction', () => {
  it('matches an independent first-bin integral fixture', () => {
    const kernel = createVardyBrownKernel(options);
    const weights = vardyBrownStepWeights(kernel, 5000);
    expect(kernel.decayRate).toBeCloseTo(0.7379024981856235, 12);
    expect(weights.exactFirstWeight).toBeCloseTo(252.00329106345032, 9);
  });
  it('keeps constant histories at zero and tracks signed left and right histories independently', () => {
    const kernel = createVardyBrownKernel(options);
    const initial = initializeVardyBrown(kernel, new Float64Array([0.8]), new Float64Array([0.8]));
    const constant = updateVardyBrown(kernel, initial, new Float64Array([0.8]), new Float64Array([0.8]), 5000);
    expect(constant.leftAcceleration[0]).toBe(0);
    expect(constant.rightAcceleration[0]).toBe(0);
    const changed = updateVardyBrown(kernel, constant, new Float64Array([0.9]), new Float64Array([0.7]), 5000);
    expect(changed.leftAcceleration[0]).toBeGreaterThan(0);
    expect(changed.rightAcceleration[0]).toBeLessThan(0);
    expect(changed.leftAcceleration[0]).toBeCloseTo(-changed.rightAcceleration[0]!, 10);
    expect(Array.from(initial.previousLeftVelocity)).toEqual([0.8]);
  });
  it('rejects nonphysical roughness and fluid properties', () => {
    expect(() => createVardyBrownKernel({ ...options, roughnessM: -1 })).toThrow();
    expect(() => createVardyBrownKernel({ ...options, viscosityM2s: 0 })).toThrow();
    expect(() => createVardyBrownKernel({ ...options, referenceVelocityMps: 0 })).toThrow();
  });
});

it('advances an internal Vardy–Brown state with a leak without contaminating its input', async () => {
  const { profileSchema } = await import('../../src/contracts/model');
  const { initialize } = await import('../../src/physics/initialize');
  const { advanceTo } = await import('../../src/physics/advance-to');
  const profileJson = (await import('../../src/scenarios/synthetic-oil-turbulent-v1.json')).default;
  const result = initialize(profileSchema.parse(profileJson), { friction: 'vardy-brown' });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('initialization failed');
  const state = result.value;
  expect(state.vardyBrown).toBeDefined();
  const before = Array.from(state.p);
  const quasiSteady = initialize(profileSchema.parse(profileJson));
  if (!quasiSteady.ok) throw new Error('initialization failed');
  expect(quasiSteady.value.vardyBrown).toBeUndefined();
  const next = advanceTo(state, 20_000, { leak: { node: 100, onsetUs: 0, rampUs: 0, cdA: 1e-5 } });
  expect(next.ok).toBe(true);
  if (!next.ok) throw new Error('advance failed');
  expect(next.value.leakFlowM3s).toBeGreaterThan(0);
  expect(next.value.qL[100]).toBeGreaterThan(next.value.qR[100]!);
  expect(next.value.vardyBrown?.leftAcceleration[100]).not.toBe(next.value.vardyBrown?.rightAcceleration[100]);
  expect(Array.from(state.p)).toEqual(before);
  const comparison = advanceTo(quasiSteady.value, 20_000, { leak: { node: 100, onsetUs: 0, rampUs: 0, cdA: 1e-5 } });
  if (!comparison.ok) throw new Error('advance failed');
  expect(Array.from(next.value.p)).not.toEqual(Array.from(comparison.value.p));
});
