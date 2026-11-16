import { colebrookDarcyFactor } from './friction';
import { requireDomain, requirePositive, requireTimeUs } from './guards';
import { MICROSECONDS_PER_SECOND } from './units';

const A_STAR = 1 / (2 * Math.sqrt(Math.PI));

// Vítkovský weights reproduced in Applied Sciences 14(16), 7173, Table A1.
const RATES = [4.78793, 51.0897, 210.868, 765.03, 2731.01, 9731.44, 34668.5, 123511, 440374, 1590300];
const WEIGHTS = [5.03362, 6.4876, 10.7735, 19.904, 37.4754, 70.7117, 133.46, 251.933, 476.597, 932.86];

interface KernelOptions {
  readonly viscosityM2s: number;
  readonly diameterM: number;
  readonly roughnessM: number;
  readonly referenceVelocityMps: number;
}

export interface VardyBrownKernel {
  readonly version: 'vardy-brown-smooth-compact-v1';
  readonly thetaRate: number;
  readonly decayRate: number;
  readonly sourceScale: number;
  readonly roughnessPlus: number;
  readonly rates: Float64Array;
}

export interface VardyBrownState {
  readonly previousLeftVelocity: Float64Array;
  readonly previousRightVelocity: Float64Array;
  readonly leftTails: Float64Array;
  readonly rightTails: Float64Array;
  readonly leftAcceleration: Float64Array;
  readonly rightAcceleration: Float64Array;
}

interface StepWeights {
  readonly decay: Float64Array;
  readonly gain: Float64Array;
  readonly firstBinCorrection: number;
  readonly exactFirstWeight: number;
}

export function createVardyBrownKernel({
  viscosityM2s, diameterM, roughnessM, referenceVelocityMps,
}: KernelOptions): VardyBrownKernel {
  requirePositive(viscosityM2s, 'Fixed Vardy–Brown viscosity');
  requirePositive(diameterM, 'Bore diameter');
  requirePositive(referenceVelocityMps, 'Reference flow velocity');

  const reynolds = referenceVelocityMps * diameterM / viscosityM2s;
  const factor = colebrookDarcyFactor(reynolds, roughnessM / diameterM);
  const roughnessPlus = roughnessM * referenceVelocityMps * Math.sqrt(factor / 8) / viscosityM2s;
  requireDomain(roughnessPlus <= 1, 'Vardy–Brown smooth wall requires roughness in wall units at most one');

  const thetaRate = 4 * viscosityM2s / diameterM ** 2;
  const exponent = Math.log10(15.29 / reynolds ** 0.0567);
  const decayRate = thetaRate * reynolds ** exponent / 12.86;
  requirePositive(decayRate, 'Vardy–Brown decay rate');
  return {
    version: 'vardy-brown-smooth-compact-v1',
    thetaRate, decayRate, roughnessPlus, sourceScale: 4 * thetaRate,
    rates: Float64Array.from(RATES, (rate) => thetaRate * rate + decayRate),
  };
}

function firstBinWeight(thetaStep: number, decayStep: number): number {
  // The substitution t = h y² removes the singularity. Integrate exp(-decayStep y²)
  // over y in [0,1] term by term. For decayStep <= 1 the alternating remainder is < 1e-18.
  let term = 1;
  let integral = term;
  for (let n = 1; n <= 20; n++) {
    term *= -decayStep / n;
    integral += term / (2 * n + 1);
  }
  return 2 * A_STAR * integral / Math.sqrt(thetaStep);
}

export function vardyBrownStepWeights(kernel: VardyBrownKernel, dtUs: number): StepWeights {
  requireTimeUs(dtUs);
  requirePositive(dtUs, 'Vardy–Brown time step');
  const h = dtUs / MICROSECONDS_PER_SECOND;
  const decayStep = kernel.decayRate * h;
  requireDomain(decayStep <= 1, 'Vardy–Brown step outside the supported decay interval');
  const exactFirstWeight = firstBinWeight(kernel.thetaRate * h, decayStep);
  requireDomain(h * kernel.sourceScale * exactFirstWeight <= 0.1, 'Vardy–Brown step exceeds the explicit source stability limit');

  const decay = kernel.rates.map((rate) => Math.exp(-rate * h));
  const gain = kernel.rates.map((rate, i) => {
    const scaled = rate * h;
    return A_STAR * WEIGHTS[i]! * (-Math.expm1(-scaled) / scaled);
  });
  const firstBinCorrection = exactFirstWeight - gain.reduce((sum, value) => sum + value, 0);
  return { decay, gain, firstBinCorrection, exactFirstWeight };
}

function requireVelocities(left: Float64Array, right: Float64Array): void {
  requireDomain(left.length >= 1 && left.length <= 401 && right.length === left.length &&
    left.every(Number.isFinite) && right.every(Number.isFinite), 'Invalid Vardy–Brown sided velocity fields');
}

export function initializeVardyBrown(
  kernel: VardyBrownKernel,
  left: Float64Array,
  right: Float64Array,
): VardyBrownState {
  requireVelocities(left, right);
  const nodes = left.length;
  const tailSize = nodes * kernel.rates.length;
  return {
    previousLeftVelocity: left.slice(), previousRightVelocity: right.slice(),
    leftTails: new Float64Array(tailSize), rightTails: new Float64Array(tailSize),
    leftAcceleration: new Float64Array(nodes), rightAcceleration: new Float64Array(nodes),
  };
}

function updateSide(
  previousVelocity: Float64Array,
  previousTail: Float64Array,
  velocity: Float64Array,
  weights: StepWeights,
  sourceScale: number,
) {
  const nodes = velocity.length;
  requireDomain(previousVelocity.length === nodes && previousTail.length === nodes * weights.gain.length,
    'Vardy–Brown history dimensions do not match the velocity field');

  const tails = new Float64Array(previousTail.length);
  const acceleration = new Float64Array(nodes);
  for (let node = 0; node < nodes; node++) {
    const increment = velocity[node]! - previousVelocity[node]!;
    let memory = weights.firstBinCorrection * increment;
    for (let term = 0; term < weights.gain.length; term++) {
      const index = term * nodes + node;
      const value = weights.decay[term]! * previousTail[index]! + weights.gain[term]! * increment;
      tails[index] = value;
      memory += value;
    }
    acceleration[node] = sourceScale * memory;
    requireDomain(Number.isFinite(acceleration[node]), 'Nonfinite Vardy–Brown acceleration');
  }
  return { velocity: velocity.slice(), tails, acceleration };
}

export function updateVardyBrown(
  kernel: VardyBrownKernel,
  previous: VardyBrownState,
  leftVelocity: Float64Array,
  rightVelocity: Float64Array,
  dtUs: number,
): VardyBrownState {
  requireVelocities(leftVelocity, rightVelocity);
  const weights = vardyBrownStepWeights(kernel, dtUs);
  const left = updateSide(previous.previousLeftVelocity, previous.leftTails, leftVelocity, weights, kernel.sourceScale);
  const right = updateSide(previous.previousRightVelocity, previous.rightTails, rightVelocity, weights, kernel.sourceScale);
  return {
    previousLeftVelocity: left.velocity, previousRightVelocity: right.velocity,
    leftTails: left.tails, rightTails: right.tails,
    leftAcceleration: left.acceleration, rightAcceleration: right.acceleration,
  };
}
