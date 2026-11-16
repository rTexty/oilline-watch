import type { FluidProfile } from '../contracts/model';
import { initialEnergyLedger, recordEnergy, type EnergyLedger, type EnergyTerms } from './conservation';
import { frictionAcceleration } from './friction';
import { requireDomain, requireFlowRegime, requireRange } from './guards';
import { deriveProfile, viscosityAt } from './state';
import { MICROSECONDS_PER_SECOND } from './units';

const THERMAL_COURANT_MAX = 0.8 + 16 * Number.EPSILON;

export interface HeatCapacities {
  readonly oilCapacity: number;
  readonly wallCapacity: number;
  readonly inner: number;
  readonly outer: number;
}

export interface BoundaryTemperatures {
  readonly inletK: number;
  readonly outletK: number;
  readonly ambientK: number;
}

export interface TemperatureFields {
  readonly tOil: Float64Array;
  readonly tWall: Float64Array;
  readonly ledger: EnergyLedger;
}

interface ThermalStartupFront {
  readonly baselineK: number;
  readonly inletK: number;
  readonly ambientK: number;
  readonly velocityMps: number;
  readonly dxM: number;
  readonly decayPerM: number;
  readonly jumpAtCellStartK: Float64Array;
  readonly residualOilK: Float64Array;
  readonly publishedOil: Float64Array;
  readonly publishedWall: Float64Array;
}

export interface ThermalTemperatureState extends TemperatureFields {
  readonly timeUs: number;
  readonly qoutM3s: number;
  readonly startupFront?: ThermalStartupFront;
}

export interface ThermalState extends ThermalTemperatureState {
  readonly p: Float64Array;
}

export interface ThermalAdvection extends Pick<EnergyTerms, 'boundaryInJ' | 'boundaryOutJ' | 'leakJ' | 'compressionApproxJ'> {
  readonly advected: Float64Array;
}

export function defaultBoundaryTemperatures(profile: FluidProfile): BoundaryTemperatures {
  const { inletTemperatureK, ambientTemperatureK } = profile.initialPublicControls;
  return { inletK: inletTemperatureK, outletK: profile.publicFluidProfile.tRefK, ambientK: ambientTemperatureK };
}

export function requireTemperatures(profile: FluidProfile, ...temperatures: readonly number[]): void {
  for (const value of temperatures) {
    requireRange(value, profile.limits.temperatureMinK, profile.limits.temperatureMaxK, 'Temperature');
  }
}

export function thermalCellGeometry(profile: FluidProfile) {
  const { diameterM, lengthM, wallThicknessM } = profile.geometry;
  const area = Math.PI * diameterM ** 2 / 4;
  const wallArea = Math.PI * wallThicknessM * (diameterM + wallThicknessM);
  const dx = lengthM / profile.grid.segments;
  return { area, wallArea, dx, cellVolume: area * dx };
}

export function requireThermalCfl(volumeM3: number, cellVolumeM3: number): void {
  requireDomain(Number.isFinite(volumeM3) && volumeM3 >= 0 && volumeM3 <= THERMAL_COURANT_MAX * cellVolumeM3,
    'Thermal advection exceeds CFL limit');
}

export function exchangeHeat(
  oilK: number,
  wallK: number,
  ambientK: number,
  { oilCapacity, wallCapacity, inner, outer }: HeatCapacities,
  dtSeconds: number,
): { readonly oilK: number; readonly wallK: number } {
  const r = inner * dtSeconds / oilCapacity;
  const s = inner * dtSeconds / wallCapacity;
  const v = outer * dtSeconds / wallCapacity;
  const determinant = 1 + r + s + v + r * v;
  const wallNext = wallK + (s * (oilK - wallK) + (1 + r) * v * (ambientK - wallK)) / determinant;
  return { oilK: oilK + r / (1 + r) * (wallNext - oilK), wallK: wallNext };
}

export function applyHeatExchange(
  previous: TemperatureFields,
  advection: ThermalAdvection,
  profile: FluidProfile,
  dtUs: number,
  ambientK: number,
): TemperatureFields {
  const segments = profile.grid.segments;
  const { area, wallArea, dx } = thermalCellGeometry(profile);
  const { rho0KgM3, cpJkgK } = profile.publicFluidProfile;
  const { innerConductanceWMK, outerConductanceWMK, wallDensityKgM3, wallCpJkgK } = profile.thermal;
  const capacities = {
    oilCapacity: rho0KgM3 * cpJkgK * area,
    wallCapacity: wallDensityKgM3 * wallCpJkgK * wallArea,
    inner: innerConductanceWMK,
    outer: outerConductanceWMK,
  };
  const dtSeconds = dtUs / MICROSECONDS_PER_SECOND;
  const tOil = new Float64Array(segments);
  const tWall = new Float64Array(segments);
  let oilChangeJ = 0;
  let wallChangeJ = 0;
  let ambientJ = 0;

  for (let i = 0; i < segments; i++) {
    const oldOil = previous.tOil[i]!;
    const oldWall = previous.tWall[i]!;
    const advected = advection.advected[i]!;
    requireTemperatures(profile, oldOil, oldWall, advected);
    const next = exchangeHeat(advected, oldWall, ambientK, capacities, dtSeconds);
    requireTemperatures(profile, next.oilK, next.wallK);
    tOil[i] = next.oilK;
    tWall[i] = next.wallK;
    oilChangeJ += capacities.oilCapacity * dx * (next.oilK - oldOil);
    wallChangeJ += capacities.wallCapacity * dx * (next.wallK - oldWall);
    ambientJ += capacities.outer * dx * dtSeconds * (next.wallK - ambientK);
  }

  const { boundaryInJ, boundaryOutJ, leakJ, compressionApproxJ } = advection;
  const ledger = recordEnergy(previous.ledger, {
    oilChangeJ, wallChangeJ, ambientJ, boundaryInJ, boundaryOutJ, leakJ, compressionApproxJ,
  });
  return { tOil, tWall, ledger };
}

function pressureFromTemperature(profile: FluidProfile, tOil: Float64Array, flowM3s: number): Float64Array {
  const hydraulic = deriveProfile(profile);
  const { diameterM, roughnessM } = profile.geometry;
  const { rho0KgM3 } = profile.publicFluidProfile;
  const { pressureMinPa, pressureMaxPa } = profile.limits;
  const velocity = flowM3s / hydraulic.areaM2;
  const p = new Float64Array(tOil.length + 1);

  p[0] = profile.initialPublicControls.inletPressurePa;
  requireRange(p[0], pressureMinPa, pressureMaxPa, 'Inlet pressure');
  for (let i = 0; i < tOil.length; i++) {
    const nu = viscosityAt(hydraulic, tOil[i]!);
    requireFlowRegime(Math.abs(velocity) * diameterM / nu, velocity, profile.mode === 'laminar');
    const friction = frictionAcceleration(velocity, nu, diameterM, roughnessM);
    p[i + 1] = p[i]! - rho0KgM3 * friction * hydraulic.dxM;
    requireRange(p[i + 1]!, pressureMinPa, pressureMaxPa, 'Reconstructed pressure');
  }
  return p;
}

export function initializeThermalTemperature(profile: FluidProfile): ThermalTemperatureState {
  requireTemperatures(profile, profile.thermal.initialOilTemperatureK, profile.thermal.initialWallTemperatureK);
  const { segments } = profile.grid;
  requireDomain(Number.isSafeInteger(segments) && segments >= 2, 'Invalid thermal field grid');
  const tOil = new Float64Array(segments).fill(profile.thermal.initialOilTemperatureK);
  const tWall = new Float64Array(segments).fill(profile.thermal.initialWallTemperatureK);
  const qoutM3s = profile.initialPublicControls.outletFlowM3s;
  return { timeUs: 0, tOil, tWall, qoutM3s, ledger: initialEnergyLedger() };
}

export function initializeThermal(profile: FluidProfile): ThermalState {
  const fields = initializeThermalTemperature(profile);
  return { ...fields, p: pressureFromTemperature(profile, fields.tOil, fields.qoutM3s) };
}

function steadyFlowAdvection(
  state: ThermalTemperatureState,
  profile: FluidProfile,
  dtUs: number,
  boundaries: BoundaryTemperatures,
): ThermalAdvection {
  const { cellVolume } = thermalCellGeometry(profile);
  const volume = Math.abs(state.qoutM3s) * dtUs / MICROSECONDS_PER_SECOND;
  requireThermalCfl(volume, cellVolume);

  const flowsForward = state.qoutM3s >= 0;
  const incomingK = flowsForward ? boundaries.inletK : boundaries.outletK;
  const outgoingK = state.tOil[flowsForward ? state.tOil.length - 1 : 0]!;
  const advected = state.tOil.map((temperature, index, old) => {
    const upwindK = old[flowsForward ? index - 1 : index + 1] ?? incomingK;
    return temperature + volume / cellVolume * (upwindK - temperature);
  });
  const { rho0KgM3, cpJkgK } = profile.publicFluidProfile;
  const capacity = rho0KgM3 * cpJkgK * volume;
  return {
    advected, boundaryInJ: capacity * incomingK, boundaryOutJ: capacity * outgoingK, leakJ: 0, compressionApproxJ: 0,
  };
}

function standaloneHeatCapacities(profile: FluidProfile, area: number, wallArea: number): HeatCapacities {
  const { rho0KgM3, cpJkgK } = profile.publicFluidProfile;
  const { wallDensityKgM3, wallCpJkgK, innerConductanceWMK, outerConductanceWMK } = profile.thermal;
  return { oilCapacity: rho0KgM3 * cpJkgK * area, wallCapacity: wallDensityKgM3 * wallCpJkgK * wallArea,
    inner: innerConductanceWMK, outer: outerConductanceWMK };
}

function startupFront(
  state: ThermalTemperatureState,
  boundaries: BoundaryTemperatures,
  velocityMps: number,
  dxM: number,
  capacities: HeatCapacities,
): ThermalStartupFront | null {
  if (velocityMps <= 0) return null;
  const decayPerM = capacities.inner / (capacities.oilCapacity * velocityMps);
  const previous = state.startupFront;
  if (previous) {
    return previous.publishedOil === state.tOil && previous.publishedWall === state.tWall && previous.inletK === boundaries.inletK
      && previous.ambientK === boundaries.ambientK && previous.velocityMps === velocityMps
      && previous.dxM === dxM && previous.decayPerM === decayPerM ? previous : null;
  }
  const baselineK = state.tOil[0]!;
  if (state.timeUs !== 0 || boundaries.inletK === baselineK || boundaries.ambientK !== baselineK
    || !state.tOil.every((oilK) => oilK === baselineK) || !state.tWall.every((wallK) => wallK === baselineK)) {
    return null;
  }
  const amplitudeK = boundaries.inletK - baselineK;
  return {
    baselineK, inletK: boundaries.inletK, ambientK: boundaries.ambientK, velocityMps, dxM, decayPerM,
    jumpAtCellStartK: Float64Array.from(state.tOil, (_, cell) => amplitudeK * Math.exp(-decayPerM * dxM * cell)),
    residualOilK: state.tOil, publishedOil: state.tOil, publishedWall: state.tWall,
  };
}

function exponentialIntegral(decayPerM: number, widthM: number): number {
  return decayPerM === 0 ? widthM : -Math.expm1(-decayPerM * widthM) / decayPerM;
}

function exponentialFirstMoment(decayPerM: number, widthM: number): number {
  const scaled = decayPerM * widthM;
  if (scaled < 1e-3) return widthM ** 2 * (0.5 + scaled * (-1 / 3 + scaled * (1 / 8 - scaled / 30)));
  return (-Math.expm1(-scaled) - scaled * Math.exp(-scaled)) / decayPerM ** 2;
}

function coveredLength(frontM: number, cellStartM: number, widthM: number): number {
  return Math.max(0, Math.min(widthM, frontM - cellStartM));
}

function oilJump(
  front: ThermalStartupFront,
  cell: number,
  startM: number,
  endM: number,
  travelM: number,
  fullCellFactor: number,
): { readonly newMeanK: number; readonly timeMeanK: number } {
  const { dxM, decayPerM } = front;
  const leftM = cell * dxM;
  if (endM <= leftM) return { newMeanK: 0, timeMeanK: 0 };
  const jumpK = front.jumpAtCellStartK[cell]!;
  if (startM >= leftM + dxM) {
    const meanK = jumpK * fullCellFactor;
    return { newMeanK: meanK, timeMeanK: meanK };
  }
  const beforeM = coveredLength(startM, leftM, dxM);
  const afterM = coveredLength(endM, leftM, dxM);
  const newlyCoveredM = afterM - beforeM;
  const jumpAtNewlyCoveredK = jumpK * Math.exp(-decayPerM * beforeM);
  const remainingTravelM = endM - leftM - beforeM;
  const timeWeightedIntegral = remainingTravelM * exponentialIntegral(decayPerM, newlyCoveredM)
    - exponentialFirstMoment(decayPerM, newlyCoveredM);
  return {
    newMeanK: jumpK * exponentialIntegral(decayPerM, afterM) / dxM,
    timeMeanK: (jumpK * exponentialIntegral(decayPerM, beforeM)
      + jumpAtNewlyCoveredK * timeWeightedIntegral / travelM) / dxM,
  };
}

function outgoingResidualK(residual: Float64Array, cell: number, inletK: number, courant: number): number {
  const value = residual[cell]!;
  // The inlet temperature lives on the face, half a cell from the first
  // average. Mirror it to a ghost-cell center for the slope calculation.
  const left = cell === 0 ? 2 * (value - inletK) : value - residual[cell - 1]!;
  const right = (residual[cell + 1] ?? value) - value;
  if (left * right <= 0) return value;
  const slope = Math.sign(left) * Math.min(2 * Math.abs(left), 2 * Math.abs(right), Math.abs(left + right) / 2);
  return value + (1 - courant) * slope / 2;
}

interface TrackedExchange {
  readonly dtSeconds: number;
  readonly ambientK: number;
  readonly capacities: HeatCapacities;
  readonly lowerK: number;
  readonly upperK: number;
  readonly roundoffK: number;
  readonly oilSensitivity: number;
  readonly wallSensitivity: number;
}

function trackedExchange(front: ThermalStartupFront, capacities: HeatCapacities, profile: FluidProfile,
  dtSeconds: number): TrackedExchange {
  const r = capacities.inner * dtSeconds / capacities.oilCapacity;
  const s = capacities.inner * dtSeconds / capacities.wallCapacity;
  const v = capacities.outer * dtSeconds / capacities.wallCapacity;
  const determinant = 1 + r + s + v + r * v;
  const roundoffK = 16 * Number.EPSILON * Math.max(Math.abs(front.baselineK), Math.abs(front.inletK), 1);
  return {
    dtSeconds, ambientK: front.ambientK, capacities, roundoffK,
    lowerK: Math.max(profile.limits.temperatureMinK, Math.min(front.baselineK, front.inletK) - roundoffK),
    upperK: Math.min(profile.limits.temperatureMaxK, Math.max(front.baselineK, front.inletK) + roundoffK),
    oilSensitivity: (1 + s + v) / determinant, wallSensitivity: s / determinant,
  };
}

function withinBounds(temperatureK: number, exchange: TrackedExchange): boolean {
  return temperatureK >= exchange.lowerK && temperatureK <= exchange.upperK;
}

function boundedTrackedExchange(advectedK: number, wallBaseK: number, jumpK: number, step: TrackedExchange) {
  const solve = (residualK: number) => exchangeHeat(residualK, wallBaseK, step.ambientK, step.capacities, step.dtSeconds);
  const trial = solve(advectedK);
  const oilK = trial.oilK + jumpK;
  requireDomain(Number.isFinite(oilK) && Number.isFinite(trial.wallK), 'Nonfinite standalone thermal trial');
  if (withinBounds(oilK, step) && withinBounds(trial.wallK, step)) return { ...trial, correctionK: 0 };
  if (step.wallSensitivity === 0 && !withinBounds(trial.wallK, step)) return null;

  // Implicit exchange is affine in the advected oil residual. Derive the
  // allowed shift, then move the associated energy through the outgoing face.
  const lowerK = step.lowerK + step.roundoffK / 2;
  const upperK = step.upperK - step.roundoffK / 2;
  const lowerOil = (lowerK - oilK) / step.oilSensitivity;
  const upperOil = (upperK - oilK) / step.oilSensitivity;
  const lower = step.wallSensitivity === 0 ? lowerOil
    : Math.max(lowerOil, (lowerK - trial.wallK) / step.wallSensitivity);
  const upper = step.wallSensitivity === 0 ? upperOil
    : Math.min(upperOil, (upperK - trial.wallK) / step.wallSensitivity);
  if (lower > upper) return null;
  const correctionK = Math.max(lower, Math.min(upper, 0));
  const corrected = solve(advectedK + correctionK);
  return withinBounds(corrected.oilK + jumpK, step) && withinBounds(corrected.wallK, step)
    ? { ...corrected, correctionK } : null;
}

function outletJumpTemperature(front: ThermalStartupFront, positionM: number, endM: number, travelM: number): number {
  const pointJumpK = (front.inletK - front.baselineK) * Math.exp(-front.decayPerM * positionM);
  return pointJumpK * coveredLength(endM, positionM, travelM) / travelM;
}

function stepStartupFront(
  state: ThermalTemperatureState,
  profile: FluidProfile,
  front: ThermalStartupFront,
  capacities: HeatCapacities,
  dtUs: number,
): (TemperatureFields & { readonly startupFront: ThermalStartupFront }) | null {
  // Decompose the oil into an exact advected, damped inlet jump and a
  // continuous residual. A limited finite-volume flux transports the residual.
  const { dxM, decayPerM, velocityMps, baselineK, residualOilK } = front;
  const dtSeconds = dtUs / MICROSECONDS_PER_SECOND;
  const travelM = velocityMps * dtSeconds;
  const courant = travelM / dxM;
  const startM = velocityMps * (state.timeUs / MICROSECONDS_PER_SECOND);
  const endM = velocityMps * ((state.timeUs + dtUs) / MICROSECONDS_PER_SECOND);
  const fullCellFactor = exponentialIntegral(decayPerM, dxM) / dxM;
  const exchange = trackedExchange(front, capacities, profile, dtSeconds);
  const tOil = new Float64Array(state.tOil.length);
  const tWall = new Float64Array(state.tWall.length);
  const residualNext = new Float64Array(state.tOil.length);
  let oilChangeJ = 0;
  let wallChangeJ = 0;
  let ambientJ = 0;
  let upstreamK = baselineK;
  for (let cell = 0; cell < tOil.length; cell++) {
    const downstreamK = outgoingResidualK(residualOilK, cell, baselineK, courant);
    const advectedK = residualOilK[cell]! + courant * (upstreamK - downstreamK);
    const jump = oilJump(front, cell, startM, endM, travelM, fullCellFactor);
    const oldWallK = state.tWall[cell]!;
    const jumpWallK = capacities.inner * dtSeconds / capacities.wallCapacity * jump.timeMeanK;
    const oldOilK = state.tOil[cell]!;
    requireTemperatures(profile, oldOilK, oldWallK);
    const next = boundedTrackedExchange(advectedK, oldWallK + jumpWallK, jump.newMeanK, exchange);
    if (!next) return null;
    const correctedDownstreamK = downstreamK - next.correctionK / courant;
    if (next.correctionK !== 0) {
      const outgoingK = correctedDownstreamK + outletJumpTemperature(front, (cell + 1) * dxM, endM, travelM);
      if (!withinBounds(outgoingK, exchange)) return null;
    }
    const newOilK = next.oilK + jump.newMeanK;
    residualNext[cell] = next.oilK;
    tOil[cell] = newOilK;
    tWall[cell] = next.wallK;
    oilChangeJ += capacities.oilCapacity * dxM * (newOilK - oldOilK);
    wallChangeJ += capacities.wallCapacity * dxM * (next.wallK - oldWallK);
    ambientJ += capacities.outer * dxM * dtSeconds * (next.wallK - front.ambientK);
    upstreamK = correctedDownstreamK;
  }
  const lengthM = profile.geometry.lengthM;
  const outletJumpK = outletJumpTemperature(front, lengthM, endM, travelM);
  const transport = capacities.oilCapacity * travelM;
  const ledger = recordEnergy(state.ledger, { oilChangeJ, wallChangeJ, ambientJ, leakJ: 0, compressionApproxJ: 0,
    boundaryInJ: transport * front.inletK, boundaryOutJ: transport * (upstreamK + outletJumpK) });
  return { tOil, tWall, ledger, startupFront: { ...front, residualOilK: residualNext, publishedOil: tOil, publishedWall: tWall } };
}

export function stepThermalTemperature(
  state: ThermalTemperatureState,
  profile: FluidProfile,
  dtUs: number,
  boundaries = defaultBoundaryTemperatures(profile),
): ThermalTemperatureState {
  const timeUs = state.timeUs + dtUs;
  requireDomain(Number.isSafeInteger(dtUs) && dtUs > 0 && dtUs <= profile.thermal.stepUs
    && Number.isSafeInteger(timeUs) && timeUs <= profile.horizonUs, 'Thermal step outside profile clock');
  const { segments } = profile.grid;
  requireDomain(Number.isSafeInteger(segments) && segments >= 2
    && state.tOil.length === segments && state.tWall.length === segments,
    'Thermal state dimensions do not match profile');
  requireTemperatures(profile, boundaries.inletK, boundaries.outletK, boundaries.ambientK);
  const { area, wallArea, dx, cellVolume } = thermalCellGeometry(profile);
  requireThermalCfl(Math.abs(state.qoutM3s) * dtUs / MICROSECONDS_PER_SECOND, cellVolume);
  const capacities = standaloneHeatCapacities(profile, area, wallArea);
  const front = profile.mode === 'thermal' ? startupFront(state, boundaries, state.qoutM3s / area, dx, capacities) : null;
  const tracked = front ? stepStartupFront(state, profile, front, capacities, dtUs) : null;
  // If the recombined trial leaves its temperature hull, restart this tick
  // with the original fields and ledger. The upwind fallback is conservative.
  const fields = tracked
    ?? applyHeatExchange(state, steadyFlowAdvection(state, profile, dtUs, boundaries), profile, dtUs, boundaries.ambientK);
  return { ...fields, timeUs, qoutM3s: state.qoutM3s };
}

export function stepThermal(
  state: ThermalState,
  profile: FluidProfile,
  dtUs: number,
  boundaries = defaultBoundaryTemperatures(profile),
): ThermalState {
  const fields = stepThermalTemperature(state, profile, dtUs, boundaries);
  return { ...fields, p: pressureFromTemperature(profile, fields.tOil, fields.qoutM3s) };
}

export function advanceThermal(state: ThermalState, targetUs: number, profile: FluidProfile): ThermalState {
  requireDomain(Number.isSafeInteger(targetUs) && targetUs >= state.timeUs && targetUs <= profile.horizonUs,
    'Invalid thermal deadline');
  let current = state;
  while (current.timeUs < targetUs) {
    current = stepThermal(current, profile, Math.min(targetUs - current.timeUs, profile.thermal.stepUs));
  }
  return current;
}
