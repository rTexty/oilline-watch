import type { FluidProfile } from '../contracts/model';
import { requireDomain } from './guards';
import {
  applyHeatExchange, defaultBoundaryTemperatures, requireTemperatures, requireThermalCfl, thermalCellGeometry,
  type TemperatureFields,
} from './thermal';
import { MICROSECONDS_PER_SECOND } from './units';

export interface ThermalFlow {
  readonly elapsedUs: number;
  readonly leftPositiveM3: Float64Array;
  readonly leftNegativeM3: Float64Array;
  readonly rightPositiveM3: Float64Array;
  readonly rightNegativeM3: Float64Array;
}

interface NodalFlow {
  readonly qL: Float64Array;
  readonly qR: Float64Array;
}

export function initialThermalFlow(segments: number): ThermalFlow {
  const faces = segments + 1;
  return {
    elapsedUs: 0,
    leftPositiveM3: new Float64Array(faces),
    leftNegativeM3: new Float64Array(faces),
    rightPositiveM3: new Float64Array(faces),
    rightNegativeM3: new Float64Array(faces),
  };
}

function positiveVolume(start: number, end: number, halfStepSeconds: number): number {
  const high = Math.max(start, end);
  const low = Math.min(start, end);
  if (high <= 0) return 0;
  if (low >= 0) return (high + low) * halfStepSeconds;
  return high * (high / (high - low)) * halfStepSeconds;
}

export function accumulateThermalFlow(
  previous: ThermalFlow,
  old: NodalFlow,
  next: NodalFlow,
  dtUs: number,
): ThermalFlow {
  const faces = previous.leftPositiveM3.length;
  const elapsedUs = previous.elapsedUs + dtUs;
  requireDomain(Number.isSafeInteger(dtUs) && dtUs > 0 && Number.isSafeInteger(elapsedUs),
    'Invalid hydraulic step duration for thermal accumulation');
  requireDomain(old.qL.length === faces && old.qR.length === faces && next.qL.length === faces && next.qR.length === faces,
    'Hydraulic flow dimensions do not match thermal accumulator');
  const halfStepSeconds = dtUs / (2 * MICROSECONDS_PER_SECOND);
  const leftPositiveM3 = previous.leftPositiveM3.slice();
  const leftNegativeM3 = previous.leftNegativeM3.slice();
  const rightPositiveM3 = previous.rightPositiveM3.slice();
  const rightNegativeM3 = previous.rightNegativeM3.slice();

  for (let i = 0; i < faces; i++) {
    const a = old.qL[i]!;
    const b = next.qL[i]!;
    const c = old.qR[i]!;
    const d = next.qR[i]!;
    requireDomain(Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d),
      'Nonfinite hydraulic flow during thermal accumulation');
    leftPositiveM3[i] = leftPositiveM3[i]! + positiveVolume(a, b, halfStepSeconds);
    leftNegativeM3[i] = leftNegativeM3[i]! + positiveVolume(-a, -b, halfStepSeconds);
    rightPositiveM3[i] = rightPositiveM3[i]! + positiveVolume(c, d, halfStepSeconds);
    rightNegativeM3[i] = rightNegativeM3[i]! + positiveVolume(-c, -d, halfStepSeconds);
  }
  return { elapsedUs, leftPositiveM3, leftNegativeM3, rightPositiveM3, rightNegativeM3 };
}

interface JunctionTransport {
  readonly fromLeft: number;
  readonly fromRight: number;
  readonly toLeft: number;
  readonly toRight: number;
}

function junctionTemperatures(transport: JunctionTransport, leftK: number, rightK: number) {
  const { fromLeft, fromRight, toLeft, toRight } = transport;
  if (fromLeft === toRight && fromRight === toLeft) {
    return { toLeftK: rightK, toRightK: leftK, leak: 0 };
  }
  const incoming = fromLeft + fromRight;
  const leak = incoming - (toLeft + toRight);
  requireDomain(leak >= 0 && incoming > 0, 'Unexpected thermal inflow at an internal junction');
  const mixedK = leftK + (rightK - leftK) * (fromRight / incoming);
  return { toLeftK: mixedK, toRightK: mixedK, leak: leak * mixedK };
}

export function applyAcousticThermalTick(
  previous: TemperatureFields,
  flow: ThermalFlow,
  profile: FluidProfile,
  boundaries = defaultBoundaryTemperatures(profile),
): TemperatureFields {
  const segments = profile.grid.segments;
  const { cellVolume } = thermalCellGeometry(profile);
  requireDomain(flow.elapsedUs === profile.thermal.stepUs, 'Thermal accumulator must contain exactly one thermal tick');
  requireDomain(previous.tOil.length === segments && previous.tWall.length === segments
    && flow.leftPositiveM3.length === segments + 1 && flow.leftNegativeM3.length === segments + 1
    && flow.rightPositiveM3.length === segments + 1 && flow.rightNegativeM3.length === segments + 1,
  'Acoustic thermal dimensions do not match profile');
  requireTemperatures(profile, boundaries.inletK, boundaries.outletK, boundaries.ambientK);

  const lp = flow.leftPositiveM3;
  const ln = flow.leftNegativeM3;
  const rp = flow.rightPositiveM3;
  const rn = flow.rightNegativeM3;
  const boundaryIn = rp[0]! * boundaries.inletK + ln[segments]! * boundaries.outletK;
  const boundaryOut = rn[0]! * previous.tOil[0]! + lp[segments]! * previous.tOil[segments - 1]!;
  let leftDonorK = boundaries.inletK;
  let compressionApprox = 0;
  let leak = 0;
  const advected = new Float64Array(segments);

  for (let i = 0; i < segments; i++) {
    const oldK = previous.tOil[i]!;
    const node = i + 1;
    const incomingVolume = rp[i]! + ln[node]!;
    const outgoingVolume = rn[i]! + lp[node]!;
    requireThermalCfl(Math.max(incomingVolume, outgoingVolume), cellVolume);
    const junction = node === segments
      ? { toLeftK: boundaries.outletK, toRightK: oldK, leak: 0 }
      : junctionTemperatures({
        fromLeft: lp[node]!, fromRight: rn[node]!, toLeft: ln[node]!, toRight: rp[node]!,
      }, oldK, previous.tOil[node]!);
    // Combine upwind enthalpy and the volume correction before evaluation to preserve a uniform field.
    const leftTransport = rp[i]! / cellVolume * (leftDonorK - oldK);
    const rightTransport = ln[node]! / cellVolume * (junction.toLeftK - oldK);
    advected[i] = oldK + leftTransport + rightTransport;
    leftDonorK = junction.toRightK;
    leak += junction.leak;
    compressionApprox += oldK * (outgoingVolume - incomingVolume);
  }

  const { rho0KgM3, cpJkgK } = profile.publicFluidProfile;
  const rhoCp = rho0KgM3 * cpJkgK;
  return applyHeatExchange(previous, {
    advected,
    boundaryInJ: rhoCp * boundaryIn,
    boundaryOutJ: rhoCp * boundaryOut,
    leakJ: rhoCp * leak,
    compressionApproxJ: rhoCp * compressionApprox,
  }, profile, flow.elapsedUs, boundaries.ambientK);
}
