import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileSchema } from '../../src/contracts/model';
import * as friction from '../../src/physics/friction';
import { initialize } from '../../src/physics/initialize';
import { step } from '../../src/physics/moc';
import { viscosityAt, type HydraulicState } from '../../src/physics/state';

function nonsteady(varyTemperature = false): HydraulicState {
  const definition = profileSchema.parse(JSON.parse(readFileSync('src/scenarios/synthetic-oil-turbulent-v1.json', 'utf8')));
  const result = initialize(definition);
  if (!result.ok) throw result.error;
  const state = result.value;
  const q = state.qL.map((value, index) => value * (1 + 0.001 * Math.sin(index * 0.37)));
  return { ...state, qL: q, qR: q.slice(),
    tOil: state.tOil.map((value, index) => value + (varyTemperature && index % 2 ? 2 : 0)) };
}

// Calculate each characteristic independently, without sharing a friction result.
function scalarReference(state: HydraulicState, dtUs: number) {
  const { profile, p, qL, qR } = state;
  const { definition, areaM2, impedance, waveSpeedMps, dxM } = profile;
  const { diameterM, roughnessM } = definition.geometry;
  const dt = dtUs / 1e6;
  const courant = Math.min(waveSpeedMps * dt / dxM, 1);
  const interp = (a: number, b: number) => courant === 1 ? b : a + courant * (b - a);
  const characteristic = (node: number, adjacent: number, center: number, neighbor: number, sign: number) => {
    const q = interp(center, neighbor);
    const nu = viscosityAt(profile, state.tOil[Math.min(node, adjacent)]!);
    const acceleration = friction.frictionAcceleration(q / areaM2, nu, diameterM, roughnessM, dt);
    return interp(p[node]!, p[adjacent]!) + sign * (impedance * q - definition.publicFluidProfile.rho0KgM3 * waveSpeedMps * dt * acceleration);
  };
  const outP = new Float64Array(p.length);
  const outQ = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) {
    const plus = i > 0 ? characteristic(i, i - 1, qL[i]!, qR[i - 1]!, 1) : 0;
    const minus = i < p.length - 1 ? characteristic(i, i + 1, qR[i]!, qL[i + 1]!, -1) : 0;
    if (i === 0) {
      outP[i] = definition.initialPublicControls.inletPressurePa;
      outQ[i] = (outP[i]! - minus) / impedance;
    } else if (i === p.length - 1) {
      outQ[i] = definition.initialPublicControls.outletFlowM3s;
      outP[i] = plus - impedance * outQ[i]!;
    } else {
      outP[i] = (plus + minus) / 2;
      outQ[i] = (plus - minus) / (2 * impedance);
    }
  }
  return { p: outP, q: outQ };
}

afterEach(() => vi.restoreAllMocks());

describe('MOC characteristic friction reuse', () => {
  it('evaluates each shared full-CFL source once for nonsteady flow', () => {
    const state = nonsteady();
    const spy = vi.spyOn(friction, 'frictionAcceleration');
    step(state, { dtUs: state.profile.stepUs });
    expect(spy).toHaveBeenCalledTimes(state.p.length);
  });

  it.each([[5000, false], [5000, true], [1250, false], [1250, true]])(
    'matches independent characteristic fields at %i microseconds (varying temperature: %s)', (dtUs, varyTemperature) => {
      const state = nonsteady(varyTemperature);
      const expected = scalarReference(state, dtUs);
      const actual = step(state, { dtUs });
      expect(Array.from(actual.p)).toEqual(Array.from(expected.p));
      expect(Array.from(actual.qL)).toEqual(Array.from(expected.q));
      expect(Array.from(actual.qR)).toEqual(Array.from(expected.q));
    },
  );
});
