import { solveInlet, solveOutlet } from './boundaries';
import { accumulateThermalFlow, applyAcousticThermalTick, initialThermalFlow } from './coupling';
import { frictionAcceleration } from './friction';
import { PhysicsDomainError, requireDomain, requireFlowRegime, requireRange, requireTimeUs } from './guards';
import { inletPressureAt, nextInletLawBoundary } from './inlet-law';
import { openingAt, solveJunction } from './leak';
import { nextOutletPulseBoundary, outletPulseDelta, outletPulseEnd } from './outlet-pulse';
import { CFL_TOLERANCE, mergeHydraulicInputs, pressureIntegral, viscosityAt } from './state';
import type { HydraulicInputs, HydraulicState, VolumeBalance } from './state';
import { MICROSECONDS_PER_SECOND } from './units';
import { updateVardyBrown } from './vardy-brown';
import { updateZielke } from './zielke';

export interface StepInput extends HydraulicInputs {
  readonly dtUs: number;
}

export interface ResolvedInputs {
  readonly pinPa: number;
  readonly qoutM3s: number;
  readonly tinK: number;
  readonly ambientK: number;
  readonly leak: NonNullable<HydraulicInputs['leak']> | null;
}

export interface HydraulicFields {
  readonly p: Float64Array;
  readonly qL: Float64Array;
  readonly qR: Float64Array;
  readonly leakFlowM3s: number;
}

export type HydraulicFieldBackend = (
  state: HydraulicState, inputs: ResolvedInputs, stepSeconds: number, courant: number,
  viscosity: Float64Array,
) => HydraulicFields;

export function validateInputs(state: HydraulicState, inputs: HydraulicInputs, boundaryTimeUs = state.timeUs): ResolvedInputs {
  const { definition } = state.profile;
  const { initialPublicControls: defaults, limits, grid, mode, publicFluidProfile } = definition;
  requireDomain(!inputs.inletLaw || mode === 'turbulent' && !state.profile.vardyBrownKernel,
    'Inlet waveforms require the TypeScript quasi-steady turbulent solver');
  const pinPa = inputs.inletLaw
    ? inletPressureAt(inputs.inletLaw, boundaryTimeUs, limits.pressureMinPa, limits.pressureMaxPa, definition.horizonUs)
    : inputs.pinPa ?? defaults.inletPressurePa;
  const rampFraction = mode === 'laminar' ? Math.min(1, Math.max(0, (state.timeUs - 2_000_000) / 100_000)) : 0;
  const baseOutlet = inputs.qoutM3s ?? defaults.outletFlowM3s * (1 - 0.2 * rampFraction);
  const pulse = inputs.outletPulse;
  if (pulse) {
    requireDomain(mode === 'turbulent' && pulse.startUs <= state.timeUs && outletPulseEnd(pulse) <= definition.horizonUs
      && Number.isSafeInteger(pulse.startUs) && pulse.startUs >= 0
      && [pulse.pulse.rampUs, pulse.pulse.holdUs, pulse.pulse.returnUs].every((duration) =>
        Number.isSafeInteger(duration) && duration > 0)
      && Number.isFinite(pulse.pulse.deltaOutletFlowM3s) && pulse.pulse.deltaOutletFlowM3s > 0,
    'Invalid outlet pulse');
  }
  const qoutM3s = pulse ? baseOutlet + outletPulseDelta(pulse, boundaryTimeUs) : baseOutlet;
  const tinK = inputs.tinK ?? defaults.inletTemperatureK;
  const ambientK = inputs.ambientK ?? defaults.ambientTemperatureK;
  const leak = inputs.leak ?? null;

  requireRange(pinPa, limits.pressureMinPa, limits.pressureMaxPa, 'Inlet pressure');
  requireDomain(Number.isFinite(qoutM3s), 'Outlet flow must be finite');
  requireRange(tinK, limits.temperatureMinK, limits.temperatureMaxK, 'Inlet temperature');
  requireRange(ambientK, limits.temperatureMinK, limits.temperatureMaxK, 'Ambient temperature');
  const hasMemory = mode === 'laminar' || state.profile.vardyBrownKernel !== undefined;
  requireDomain(!hasMemory || (tinK === publicFluidProfile.tRefK && ambientK === publicFluidProfile.tRefK),
    'Friction memory profile requires isothermal boundaries');
  if (leak !== null) {
    requireDomain(mode === 'turbulent', 'This profile does not support leak events');
    requireDomain(Number.isSafeInteger(leak.node) && leak.node >= 1 && leak.node < grid.segments, 'Invalid leak node');
    requireRange(leak.onsetUs, 0, definition.horizonUs, 'Leak onset');
    requireDomain(publicFluidProfile.phaseQualification === 'stipulated-synthetic', 'Orifice phase closure is unqualified');
    openingAt(leak, state.timeUs);
  }

  return { pinPa, qoutM3s, tinK, ambientK, leak };
}

function interpolate(center: number, neighbor: number, fraction: number): number {
  return fraction === 1 ? neighbor : center + fraction * (neighbor - center);
}

function cellViscosities(state: HydraulicState): Float64Array {
  const { definition } = state.profile;
  const { temperatureMinK, temperatureMaxK } = definition.limits;
  const fixedTemperatureK = state.profile.vardyBrownKernel ? definition.publicFluidProfile.tRefK : null;
  const viscosity = new Float64Array(definition.grid.segments);
  let lastTemperatureK = Number.NaN;
  let lastViscosity = Number.NaN;
  for (let cell = 0; cell < viscosity.length; cell++) {
    const oilTemperatureK = state.tOil[cell]!;
    const wallTemperatureK = state.tWall[cell]!;
    requireRange(wallTemperatureK, temperatureMinK, temperatureMaxK, 'Wall temperature');
    requireDomain(fixedTemperatureK === null || (oilTemperatureK === fixedTemperatureK && wallTemperatureK === fixedTemperatureK),
      'Vardy–Brown comparison cannot change the fixed viscosity profile');
    if (oilTemperatureK !== lastTemperatureK) {
      lastTemperatureK = oilTemperatureK;
      lastViscosity = viscosityAt(state.profile, oilTemperatureK);
    }
    viscosity[cell] = lastViscosity;
  }
  return viscosity;
}

export function referenceCharacteristicFields(
  state: HydraulicState,
  inputs: ResolvedInputs,
  stepSeconds: number,
  courant: number,
  viscosity: Float64Array,
): HydraulicFields {
  const { profile, p, qL, qR } = state;
  const { definition, impedance, areaM2, waveSpeedMps } = profile;
  const { grid, geometry, limits, publicFluidProfile, initialPublicControls } = definition;
  const { rho0KgM3 } = publicFluidProfile;
  const { diameterM, roughnessM } = geometry;
  const segments = grid.segments;
  const leftMemory = state.vardyBrown?.leftAcceleration ?? state.zielke?.acceleration;
  const rightMemory = state.vardyBrown?.rightAcceleration ?? state.zielke?.acceleration;
  const nextP = new Float64Array(segments + 1);
  const nextQL = new Float64Array(segments + 1);
  const nextQR = new Float64Array(segments + 1);
  const pressureFloor = Math.max(limits.pressureMinPa, limits.phaseMinPa);
  const sourceScale = rho0KgM3 * waveSpeedMps * stepSeconds;
  const opening = inputs.leak ? openingAt(inputs.leak, state.timeUs) : 0;
  let leakFlowM3s = 0;
  let previousFlow = Number.NaN;
  let previousViscosity = Number.NaN;
  let previousAcceleration = Number.NaN;
  const shareOppositeSources = courant === 1 && definition.mode === 'turbulent';
  let lastMinusAcceleration = Number.NaN;
  let earlierMinusAcceleration = Number.NaN;

  function characteristic(node: number, adjacent: number, qCenter: number, qAdjacent: number, sign: number) {
    const mu = viscosity[Math.min(node, adjacent)]!;
    const q = interpolate(qCenter, qAdjacent, courant);
    if (q !== previousFlow || mu !== previousViscosity) {
      // At CFL 1 the plus characteristic can revisit the exact source used by
      // the minus characteristic two nodes earlier, from the opposite side.
      if (shareOppositeSources && sign > 0 && adjacent > 0 && q === qL[adjacent] && mu === viscosity[adjacent - 1]) {
        previousAcceleration = earlierMinusAcceleration;
      } else {
        const velocity = q / areaM2;
        requireFlowRegime(Math.abs(velocity) * diameterM / mu, velocity, definition.mode === 'laminar');
        previousAcceleration = frictionAcceleration(velocity, mu, diameterM, roughnessM, stepSeconds);
      }
      previousFlow = q;
      previousViscosity = mu;
    }
    if (shareOppositeSources && sign < 0) {
      earlierMinusAcceleration = lastMinusAcceleration;
      lastMinusAcceleration = previousAcceleration;
    }
    const pressure = interpolate(p[node]!, p[adjacent]!, courant);
    const centerMemory = sign > 0 ? leftMemory : rightMemory;
    const adjacentMemory = sign > 0 ? rightMemory : leftMemory;
    const unsteady = centerMemory && adjacentMemory
      ? interpolate(centerMemory[node]!, adjacentMemory[adjacent]!, courant)
      : 0;
    return pressure + sign * (impedance * q - sourceScale * (previousAcceleration + unsteady));
  }

  for (let node = 0; node <= segments; node++) {
    const plus = node > 0 ? characteristic(node, node - 1, qL[node]!, qR[node - 1]!, 1) : 0;
    const minus = node < segments ? characteristic(node, node + 1, qR[node]!, qL[node + 1]!, -1) : 0;

    if (node === 0 || node === segments) {
      const boundary = node === 0 ? solveInlet(inputs.pinPa, minus, impedance) : solveOutlet(plus, inputs.qoutM3s, impedance);
      nextP[node] = boundary.p;
      nextQL[node] = boundary.q;
      nextQR[node] = boundary.q;
    } else if (node === inputs.leak?.node && opening > 0) {
      const junction = solveJunction(
        plus, minus, impedance, rho0KgM3, opening, limits.externalPressurePa,
        initialPublicControls.outletFlowM3s, pressureFloor, limits.pressureMaxPa,
      );
      nextP[node] = junction.p;
      nextQL[node] = junction.qL;
      nextQR[node] = junction.qR;
      leakFlowM3s = junction.qLeak;
    } else {
      nextP[node] = (plus + minus) / 2;
      nextQL[node] = (plus - minus) / (2 * impedance);
      nextQR[node] = nextQL[node]!;
    }

    requireRange(nextP[node]!, pressureFloor, limits.pressureMaxPa, 'Absolute pressure');
    const velocityLeft = nextQL[node]! / areaM2;
    const velocityRight = nextQR[node]! / areaM2;
    const nuLeft = viscosity[Math.max(0, node - 1)]!;
    const nuRight = viscosity[Math.min(node, segments - 1)]!;
    requireFlowRegime(Math.abs(velocityLeft) * diameterM / nuLeft, velocityLeft, definition.mode === 'laminar');
    requireFlowRegime(Math.abs(velocityRight) * diameterM / nuRight, velocityRight, definition.mode === 'laminar');
  }

  return { p: nextP, qL: nextQL, qR: nextQR, leakFlowM3s };
}

function quasiSteadyCflOneFields(
  state: HydraulicState, inputs: ResolvedInputs, stepSeconds: number, viscosity: Float64Array,
): HydraulicFields {
  const { profile, p, qL, qR } = state;
  const { definition, impedance, areaM2, waveSpeedMps } = profile;
  const { grid, geometry, limits, publicFluidProfile, initialPublicControls } = definition;
  const { rho0KgM3 } = publicFluidProfile;
  const { diameterM, roughnessM } = geometry;
  const { segments } = grid;
  const nextP = new Float64Array(segments + 1);
  const nextQL = new Float64Array(segments + 1);
  const nextQR = new Float64Array(segments + 1);
  const pressureFloor = Math.max(limits.pressureMinPa, limits.phaseMinPa);
  const sourceScale = rho0KgM3 * waveSpeedMps * stepSeconds;
  const flowDenominator = 2 * impedance;
  const opening = inputs.leak ? openingAt(inputs.leak, state.timeUs) : 0;
  const leakNode = opening > 0 ? inputs.leak!.node : -1;
  let leakFlowM3s = 0;
  let previousFlow = Number.NaN;
  let previousViscosity = Number.NaN;
  let previousMomentum = Number.NaN;
  let lastMinusMomentum = Number.NaN;
  let earlierMinusMomentum = Number.NaN;

  function momentum(q: number, mu: number) {
    const velocity = q / areaM2;
    requireFlowRegime(Math.abs(velocity) * diameterM / mu, velocity, false);
    const acceleration = frictionAcceleration(velocity, mu, diameterM, roughnessM, stepSeconds);
    return impedance * q - sourceScale * (acceleration + 0);
  }

  for (let node = 0; node <= segments; node++) {
    const left = node - 1;
    const right = node + 1;
    let plus = 0;
    let minus = 0;
    if (node > 0) {
      const q = qR[left]!;
      const mu = viscosity[left]!;
      if (q !== previousFlow || mu !== previousViscosity) {
        // The minus characteristic from this source was evaluated two nodes ago.
        previousMomentum = left > 0 && q === qL[left] && mu === viscosity[left - 1]
          ? earlierMinusMomentum : momentum(q, mu);
        previousFlow = q;
        previousViscosity = mu;
      }
      plus = p[left]! + previousMomentum;
    }
    if (node < segments) {
      const q = qL[right]!;
      const mu = viscosity[node]!;
      if (q !== previousFlow || mu !== previousViscosity) {
        previousMomentum = momentum(q, mu);
        previousFlow = q;
        previousViscosity = mu;
      }
      earlierMinusMomentum = lastMinusMomentum;
      lastMinusMomentum = previousMomentum;
      minus = p[right]! + -1 * previousMomentum;
    }

    if (node === 0 || node === segments) {
      const boundary = node === 0 ? solveInlet(inputs.pinPa, minus, impedance) : solveOutlet(plus, inputs.qoutM3s, impedance);
      nextP[node] = boundary.p;
      nextQL[node] = boundary.q;
      nextQR[node] = boundary.q;
    } else if (node === leakNode) {
      const junction = solveJunction(
        plus, minus, impedance, rho0KgM3, opening, limits.externalPressurePa,
        initialPublicControls.outletFlowM3s, pressureFloor, limits.pressureMaxPa,
      );
      nextP[node] = junction.p;
      nextQL[node] = junction.qL;
      nextQR[node] = junction.qR;
      leakFlowM3s = junction.qLeak;
    } else {
      nextP[node] = (plus + minus) / 2;
      nextQL[node] = (plus - minus) / flowDenominator;
      nextQR[node] = nextQL[node]!;
    }

    requireRange(nextP[node]!, pressureFloor, limits.pressureMaxPa, 'Absolute pressure');
    const velocityLeft = nextQL[node]! / areaM2;
    const nuLeft = viscosity[node > 0 ? left : 0]!;
    const nuRight = viscosity[node < segments ? node : segments - 1]!;
    requireFlowRegime(Math.abs(velocityLeft) * diameterM / nuLeft, velocityLeft, false);
    if (nextQL[node] !== nextQR[node] || nuLeft !== nuRight) {
      const velocityRight = nextQR[node]! / areaM2;
      requireFlowRegime(Math.abs(velocityRight) * diameterM / nuRight, velocityRight, false);
    }
  }

  return { p: nextP, qL: nextQL, qR: nextQR, leakFlowM3s };
}

const characteristicFields: HydraulicFieldBackend = (state, inputs, seconds, courant, viscosity) =>
  courant === 1 && state.profile.definition.mode === 'turbulent' && state.zielke === null && !state.vardyBrown
    ? quasiSteadyCflOneFields(state, inputs, seconds, viscosity)
    : referenceCharacteristicFields(state, inputs, seconds, courant, viscosity);

function volumeBalance(state: HydraulicState, next: HydraulicFields, stepSeconds: number): VolumeBalance {
  const { volumeBalance: prior, profile } = state;
  const { areaM2, dxM, waveSpeedMps, definition } = profile;
  const last = definition.grid.segments;
  const fluxBefore = state.qL[0]! - state.qR[last]! - state.leakFlowM3s;
  const fluxAfter = next.qL[0]! - next.qR[last]! - next.leakFlowM3s;
  const storedM3 = areaM2 / (definition.publicFluidProfile.rho0KgM3 * waveSpeedMps ** 2)
    * (pressureIntegral(next.p, dxM) - prior.initialPressureIntegralPaM);
  const netFluxM3 = prior.netFluxM3 + (fluxBefore + fluxAfter) * stepSeconds / 2;
  const absoluteFluxM3 = prior.absoluteFluxM3 + (Math.abs(fluxBefore) + Math.abs(fluxAfter)) * stepSeconds / 2;
  return {
    initialPressureIntegralPaM: prior.initialPressureIntegralPaM,
    storedM3, netFluxM3, absoluteFluxM3, residualM3: netFluxM3 - storedM3,
  };
}

function thermalAfterStep(state: HydraulicState, fields: HydraulicFields, inputs: ResolvedInputs, dtUs: number) {
  const { definition } = state.profile;
  const thermalFlow = accumulateThermalFlow(state.thermalFlow, state, fields, dtUs);
  if (thermalFlow.elapsedUs < definition.thermal.stepUs) {
    return {
      thermalFlow, tOil: state.tOil.slice(), tWall: state.tWall.slice(),
      energyLedger: state.energyLedger, lastThermalTimeUs: state.lastThermalTimeUs,
    };
  }
  const updated = applyAcousticThermalTick(
    { tOil: state.tOil, tWall: state.tWall, ledger: state.energyLedger },
    thermalFlow,
    definition,
    { inletK: inputs.tinK, outletK: definition.publicFluidProfile.tRefK, ambientK: inputs.ambientK },
  );
  return {
    thermalFlow: initialThermalFlow(definition.grid.segments),
    tOil: updated.tOil, tWall: updated.tWall, energyLedger: updated.ledger,
    lastThermalTimeUs: state.timeUs + dtUs,
  };
}

export function step(
  state: HydraulicState,
  { dtUs, ...changes }: StepInput,
  solveFields: HydraulicFieldBackend = characteristicFields,
): HydraulicState {
  const { profile } = state;
  const { definition } = profile;
  if (definition.mode === 'thermal') {
    throw new PhysicsDomainError('unsupported-physics', 'Use the thermal-only integrator for this profile');
  }
  requireTimeUs(dtUs);
  requireDomain(dtUs > 0 && dtUs <= profile.stepUs, 'Hydraulic step exceeds the CFL limit');
  requireDomain(definition.mode !== 'laminar' || (dtUs === profile.stepUs && state.zielke !== null),
    'Laminar memory requires the full fixed step and matching history');
  requireDomain(Boolean(profile.vardyBrownKernel) === Boolean(state.vardyBrown),
    'Vardy–Brown parameters and history must be present together');
  const timeUs = state.timeUs + dtUs;
  requireDomain(timeUs <= definition.horizonUs, 'Step exceeds the scenario horizon');
  requireDomain(state.thermalFlow.elapsedUs + dtUs <= definition.thermal.stepUs, 'Step crosses a thermal deadline');

  const inputs = mergeHydraulicInputs(state.inputs, changes);
  const resolved = validateInputs(state, inputs, timeUs);
  if (inputs.inletLaw) {
    requireDomain(solveFields === characteristicFields || solveFields === referenceCharacteristicFields,
      'Inlet waveforms are unavailable on the selected hydraulic backend');
    requireDomain(nextInletLawBoundary(inputs.inletLaw, state.timeUs) >= timeUs, 'Hydraulic step crosses an inlet waveform deadline');
  }
  if (inputs.outletPulse) {
    requireDomain(nextOutletPulseBoundary(inputs.outletPulse, state.timeUs) >= timeUs,
      'Hydraulic step crosses an outlet pulse deadline');
  }
  if (resolved.leak) {
    const { onsetUs, rampUs } = resolved.leak;
    const rampEndUs = onsetUs + rampUs;
    requireDomain(
      (onsetUs <= state.timeUs || onsetUs >= timeUs) && (rampEndUs <= state.timeUs || rampEndUs >= timeUs),
      'Hydraulic step crosses a leak deadline',
    );
  }
  const stepSeconds = dtUs / MICROSECONDS_PER_SECOND;
  const courant = profile.waveSpeedMps * stepSeconds / profile.dxM;
  requireDomain(courant <= 1 + CFL_TOLERANCE, 'Hydraulic step exceeds the CFL limit');

  const fields = solveFields(state, resolved, stepSeconds, Math.min(courant, 1), cellViscosities(state));
  const thermal = thermalAfterStep(state, fields, resolved, dtUs);
  const zielke = profile.zielkeKernel && state.zielke
    ? updateZielke(profile.zielkeKernel, state.zielke, fields.qL.map((q) => q / profile.areaM2))
    : null;
  const vardyBrown = profile.vardyBrownKernel && state.vardyBrown
    ? updateVardyBrown(
      profile.vardyBrownKernel, state.vardyBrown,
      fields.qL.map((q) => q / profile.areaM2), fields.qR.map((q) => q / profile.areaM2), dtUs,
    )
    : undefined;
  return {
    ...state, ...fields, ...thermal, zielke, timeUs, ...(vardyBrown ? { vardyBrown } : {}),
    inputs: inputs.outletPulse && timeUs === outletPulseEnd(inputs.outletPulse) ? { ...inputs, outletPulse: null } : inputs,
    volumeBalance: volumeBalance(state, fields, stepSeconds),
  };
}
