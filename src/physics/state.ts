import type { FluidProfile } from '../contracts/model';
import type { EnergyLedger } from './conservation';
import type { ThermalFlow } from './coupling';
import { requireDomain, requirePositive, requireRange } from './guards';
import type { PhysicsDomainError } from './guards';
import type { InletLaw } from './inlet-law';
import type { LeakLaw } from './leak';
import type { OutletPulseLaw } from './outlet-pulse';
import { waltherCoefficients, waltherViscosity, waveSpeed } from './properties';
import type { WaltherCoefficients } from './properties';
import { MICROSECONDS_PER_SECOND } from './units';
import type { VardyBrownKernel, VardyBrownState } from './vardy-brown';
import { createZielkeKernel, type ZielkeKernel, type ZielkeState } from './zielke';

export interface HydraulicProfile {
  readonly definition: FluidProfile;
  readonly areaM2: number;
  readonly dxM: number;
  readonly waveSpeedMps: number;
  readonly impedance: number;
  readonly stepUs: number;
  readonly viscosity: number | WaltherCoefficients;
  readonly viscosityMultiplier: number;
  readonly zielkeKernel: ZielkeKernel | null;
  readonly vardyBrownKernel?: VardyBrownKernel;
}

export interface HydraulicInputs {
  readonly pinPa?: number;
  readonly inletLaw?: InletLaw | null;
  readonly qoutM3s?: number;
  readonly outletPulse?: OutletPulseLaw | null;
  readonly tinK?: number;
  readonly ambientK?: number;
  readonly leak?: LeakLaw | null;
}

export function mergeHydraulicInputs(previous: HydraulicInputs, changes: HydraulicInputs): HydraulicInputs {
  return {
    ...previous, ...changes,
    ...(changes.leak ? { leak: { ...changes.leak } } : {}),
    ...(changes.inletLaw ? { inletLaw: { ...changes.inletLaw } } : {}),
    ...(changes.outletPulse ? { outletPulse: { ...changes.outletPulse, pulse: { ...changes.outletPulse.pulse } } } : {}),
    ...(previous.inletLaw && changes.pinPa !== undefined && changes.inletLaw === undefined ? { inletLaw: null } : {}),
  };
}

export interface VolumeBalance {
  readonly initialPressureIntegralPaM: number;
  readonly storedM3: number;
  readonly netFluxM3: number;
  readonly absoluteFluxM3: number;
  readonly residualM3: number;
}

export interface HydraulicState {
  readonly profile: HydraulicProfile;
  readonly timeUs: number;
  readonly inputs: HydraulicInputs;
  readonly eventCursor: number;
  readonly p: Float64Array;
  readonly qL: Float64Array;
  readonly qR: Float64Array;
  readonly tOil: Float64Array;
  readonly tWall: Float64Array;
  readonly thermalFlow: ThermalFlow;
  readonly energyLedger: EnergyLedger;
  readonly lastThermalTimeUs: number;
  readonly leakFlowM3s: number;
  readonly zielke: ZielkeState | null;
  readonly vardyBrown?: VardyBrownState;
  readonly volumeBalance: VolumeBalance;
}

export type PhysicsState = HydraulicState;

export type PhysicsResult =
  | { readonly ok: true; readonly value: HydraulicState }
  | { readonly ok: false; readonly error: PhysicsDomainError; readonly lastValidState?: HydraulicState };

export const CFL_TOLERANCE = 16 * Number.EPSILON;

export function deriveProfile(definition: FluidProfile): HydraulicProfile {
  const { geometry, publicFluidProfile, grid, mode } = definition;
  const { lengthM, diameterM, wallThicknessM, youngModulusPa, supportFactor } = geometry;
  const { rho0KgM3, bulkModulusPa, viscosity } = publicFluidProfile;

  requirePositive(lengthM, 'Pipe length');
  requireDomain(Number.isSafeInteger(grid.segments) && grid.segments >= 2 && grid.segments <= 400, 'Invalid grid');
  const areaM2 = Math.PI * diameterM ** 2 / 4;
  const dxM = lengthM / grid.segments;
  const waveSpeedMps = waveSpeed(rho0KgM3, bulkModulusPa, diameterM, wallThicknessM, youngModulusPa, supportFactor);
  const impedance = rho0KgM3 * waveSpeedMps / areaM2;
  const cflUs = dxM / waveSpeedMps * MICROSECONDS_PER_SECOND;
  const nearestUs = Math.round(cflUs);
  const roundoff = CFL_TOLERANCE * Math.max(1, Math.abs(cflUs));
  const maxStepUs = Math.abs(cflUs - nearestUs) <= roundoff ? nearestUs : Math.floor(cflUs);
  const stepUs = mode === 'turbulent' ? maxStepUs : grid.nominalStepUs;
  requireDomain(Number.isSafeInteger(stepUs) && stepUs >= 1, 'Invalid hydraulic step');
  requireDomain(mode !== 'laminar' || stepUs <= maxStepUs, 'Fixed laminar step exceeds CFL limit');

  const viscosityLaw = viscosity.kind === 'constant'
    ? viscosity.kinematicM2S
    : waltherCoefficients(
      { temperatureK: viscosity.points[0].temperatureK, viscosityM2s: viscosity.points[0].kinematicM2S },
      { temperatureK: viscosity.points[1].temperatureK, viscosityM2s: viscosity.points[1].kinematicM2S },
    );

  let zielkeKernel = null;
  if (mode === 'laminar') {
    requireDomain(typeof viscosityLaw === 'number', 'Zielke memory requires constant viscosity');
    requireDomain(definition.thermal.initialOilTemperatureK === publicFluidProfile.tRefK &&
      definition.thermal.initialWallTemperatureK === publicFluidProfile.tRefK,
    'Laminar memory profile requires isothermal initial fields');
    zielkeKernel = createZielkeKernel({ stepUs, viscosityM2s: viscosityLaw, diameterM });
  }
  const viscosityMultiplier = viscosity.kind === 'walther' ? viscosity.multiplier ?? 1 : 1;
  requirePositive(viscosityMultiplier, 'Walther viscosity multiplier');
  return { definition, areaM2, dxM, waveSpeedMps, impedance, stepUs, viscosity: viscosityLaw, viscosityMultiplier, zielkeKernel };
}

export function viscosityAt(profile: HydraulicProfile, temperatureK: number): number {
  const { temperatureMinK, temperatureMaxK } = profile.definition.limits;
  if (typeof profile.viscosity === 'number') {
    requireRange(temperatureK, temperatureMinK, temperatureMaxK, 'Oil temperature');
    requirePositive(profile.viscosity, 'Kinematic viscosity');
    return profile.viscosity;
  }
  return profile.viscosityMultiplier * waltherViscosity(temperatureK, profile.viscosity, temperatureMinK, temperatureMaxK);
}

export function pressureIntegral(p: Float64Array, dxM: number): number {
  const last = p.length - 1;
  let sum = (p[0]! + p[last]!) / 2;
  for (let node = 1; node < last; node++) sum += p[node]!;
  return sum * dxM;
}
