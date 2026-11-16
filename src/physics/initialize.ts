import type { FluidProfile } from '../contracts/model';
import { initialEnergyLedger } from './conservation';
import { initialThermalFlow } from './coupling';
import { frictionAcceleration } from './friction';
import { PhysicsDomainError, requireDomain, requireFlowRegime, requireRange } from './guards';
import { deriveProfile, pressureIntegral, viscosityAt } from './state';
import type { PhysicsResult } from './state';
import { createVardyBrownKernel, initializeVardyBrown } from './vardy-brown';
import { initializeZielke } from './zielke';

interface InitializeOptions {
  readonly friction?: 'vardy-brown';
}

export function initialize(definition: FluidProfile, options: InitializeOptions = {}): PhysicsResult {
  try {
    const base = deriveProfile(definition);
    const { geometry, initialPublicControls, limits, thermal, mode, grid, publicFluidProfile } = definition;
    const { segments } = grid;
    const { inletPressurePa, outletFlowM3s } = initialPublicControls;
    const { diameterM, roughnessM } = geometry;
    const oilTemperatureK = thermal.initialOilTemperatureK;
    const wallTemperatureK = thermal.initialWallTemperatureK;
    requireRange(wallTemperatureK, limits.temperatureMinK, limits.temperatureMaxK, 'Wall temperature');

    const viscosity = viscosityAt(base, oilTemperatureK);
    const velocity = outletFlowM3s / base.areaM2;
    requireFlowRegime(Math.abs(velocity) * diameterM / viscosity, velocity, mode === 'laminar');
    let profile = base;
    if (options.friction === 'vardy-brown') {
      const temperatureK = publicFluidProfile.tRefK;
      requireDomain(mode === 'turbulent' && [oilTemperatureK, wallTemperatureK,
        initialPublicControls.inletTemperatureK, initialPublicControls.ambientTemperatureK].every((value) => value === temperatureK),
      'Vardy–Brown comparison requires the isothermal turbulent profile');
      const vardyBrownKernel = createVardyBrownKernel({
        diameterM, roughnessM, viscosityM2s: viscosity, referenceVelocityMps: velocity,
      });
      profile = { ...base, vardyBrownKernel };
    }
    const gradient = publicFluidProfile.rho0KgM3 * frictionAcceleration(velocity, viscosity, diameterM, roughnessM);
    const p = new Float64Array(segments + 1);
    for (let node = 0; node <= segments; node++) {
      const pressure = inletPressurePa - gradient * node * profile.dxM;
      requireRange(pressure, Math.max(limits.pressureMinPa, limits.phaseMinPa), limits.pressureMaxPa, 'Initial pressure');
      p[node] = pressure;
    }

    return {
      ok: true,
      value: {
        profile, timeUs: 0, inputs: {}, eventCursor: 0, p,
        qL: new Float64Array(segments + 1).fill(outletFlowM3s),
        qR: new Float64Array(segments + 1).fill(outletFlowM3s),
        tOil: new Float64Array(segments).fill(oilTemperatureK),
        tWall: new Float64Array(segments).fill(wallTemperatureK),
        thermalFlow: initialThermalFlow(segments), energyLedger: initialEnergyLedger(), lastThermalTimeUs: 0,
        leakFlowM3s: 0,
        zielke: profile.zielkeKernel
          ? initializeZielke(profile.zielkeKernel, new Float64Array(segments + 1).fill(velocity))
          : null,
        ...(profile.vardyBrownKernel ? {
          vardyBrown: initializeVardyBrown(
            profile.vardyBrownKernel,
            new Float64Array(segments + 1).fill(velocity),
            new Float64Array(segments + 1).fill(velocity),
          ),
        } : {}),
        volumeBalance: {
          initialPressureIntegralPaM: pressureIntegral(p, profile.dxM),
          storedM3: 0, netFluxM3: 0, absoluteFluxM3: 0, residualM3: 0,
        },
      },
    };
  } catch (error) {
    if (error instanceof PhysicsDomainError) return { ok: false, error };
    throw error;
  }
}
