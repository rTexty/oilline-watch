import { describe, expect, it } from 'vitest';
import { createZielkeKernel, initializeZielke, updateZielke } from '../../src/physics/zielke';

const options = { stepUs: 10_000, viscosityM2s: 1e-4, diameterM: 0.2 };

describe('laminar unsteady friction memory', () => {
  it('integrates the singular first interval and has the declared bounded history', () => {
    const kernel = createZielkeKernel(options);
    expect(kernel.historyLength).toBe(200);
    const b = [0.282095, -1.25, 1.057855, 0.9375, 0.396696, -0.351563];
    const theta = 0.0001;
    const firstWeight = b.reduce((sum, coefficient, i) => {
      const exponent = (i - 1) / 2;
      return sum + coefficient * theta ** exponent / (exponent + 1);
    }, 0);
    expect(kernel.weights[0]).toBeCloseTo(firstWeight, 10);
    expect(Number.isFinite(kernel.weights[0])).toBe(true);
  });
  it('preserves zero memory for constant velocity and keeps prior state immutable', () => {
    const kernel = createZielkeKernel(options);
    const old = initializeZielke(kernel, new Float64Array([1, -1]));
    const next = updateZielke(kernel, old, new Float64Array([1, -1]));
    expect(Array.from(next.acceleration)).toEqual([0, 0]);
    expect(next.previousVelocity).not.toBe(old.previousVelocity);
    expect(Array.from(old.previousVelocity)).toEqual([1, -1]);
  });
  it('matches direct convolution across ring wrap and resumes exactly from a checkpoint', () => {
    const kernel = createZielkeKernel(options);
    let state = initializeZielke(kernel, new Float64Array([0]));
    const increments: number[] = [];
    let velocity = 0;
    for (let n = 0; n < kernel.historyLength + 20; n++) {
      const delta = n % 7 === 0 ? 0.02 : -0.001;
      velocity += delta;
      increments.unshift(delta);
      state = updateZielke(kernel, state, new Float64Array([velocity]));
      let expected = 0;
      for (let lag = 0; lag < increments.length; lag++) {
        const weight = lag < kernel.historyLength
          ? kernel.weights[lag]!
          : kernel.tailDecay.reduce((sum, decay, i) => sum + kernel.tailGain[i]! * decay ** (lag - kernel.historyLength), 0);
        expected += weight * increments[lag]!;
      }
      expect(state.acceleration[0]).toBeCloseTo(kernel.sourceScale * expected, 10);
    }
    const checkpoint = structuredClone(state);
    const next = updateZielke(kernel, state, new Float64Array([velocity + 0.01]));
    const resumed = updateZielke(kernel, checkpoint, new Float64Array([velocity + 0.01]));
    expect(Array.from(resumed.acceleration)).toEqual(Array.from(next.acceleration));
  });
  it('retains the sign of acceleration and braking', () => {
    const kernel = createZielkeKernel(options);
    const old = initializeZielke(kernel, new Float64Array([1, 1]));
    const next = updateZielke(kernel, old, new Float64Array([1.1, 0.9]));
    expect(next.acceleration[0]).toBeGreaterThan(0);
    expect(next.acceleration[1]).toBeLessThan(0);
    expect(next.acceleration[0]).toBeCloseTo(-next.acceleration[1]!, 12);
  });
});
