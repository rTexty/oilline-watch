import coefficients from '../profiles/zielke-coefficients.json';
import { requireDomain, requirePositive, requireTimeUs } from './guards';
import { MICROSECONDS_PER_SECOND } from './units';

interface ZielkeOptions {
  readonly stepUs: number;
  readonly viscosityM2s: number;
  readonly diameterM: number;
}

export interface ZielkeKernel {
  readonly version: string;
  readonly stepUs: number;
  readonly historyLength: number;
  readonly weights: Float64Array;
  readonly tailDecay: Float64Array;
  readonly tailGain: Float64Array;
  readonly sourceScale: number;
}

export interface ZielkeState {
  readonly previousVelocity: Float64Array;
  readonly deltas: Float64Array;
  readonly tail: Float64Array;
  readonly cursor: number;
  readonly historyCount: number;
  readonly acceleration: Float64Array;
}

function recentBinWeight(index: number, thetaStep: number): number {
  const lower = index * thetaStep;
  const upper = (index + 1) * thetaStep;
  return coefficients.recentCoefficients.reduce((integral, coefficient, term) => {
    const exponent = (term + 1) / 2;
    return integral + coefficient * (upper ** exponent - lower ** exponent) / exponent;
  }, 0) / thetaStep;
}

export function createZielkeKernel({ stepUs, viscosityM2s, diameterM }: ZielkeOptions): ZielkeKernel {
  requireTimeUs(stepUs);
  requirePositive(stepUs, 'Zielke step');
  requirePositive(viscosityM2s, 'Fixed laminar viscosity');
  requirePositive(diameterM, 'Bore diameter');

  const h = stepUs / MICROSECONDS_PER_SECOND;
  const kappa = 4 * viscosityM2s / diameterM ** 2;
  const thetaStep = kappa * h;
  const history = coefficients.cutoffTheta / thetaStep;
  const historyLength = Math.round(history);
  requireDomain(historyLength >= 1 && historyLength <= 800 &&
    Math.abs(history - historyLength) <= 16 * Number.EPSILON * history,
  'Zielke history cutoff must align with the supported fixed step');

  const weights = Float64Array.from({ length: historyLength }, (_, i) => recentBinWeight(i, thetaStep));
  const sourceScale = 16 * viscosityM2s / diameterM ** 2;
  requireDomain(h * 2 * sourceScale <= 0.1 && h * sourceScale * weights[0]! <= 0.1,
    'Zielke explicit source step exceeds stability limits');

  const tailDecay = Float64Array.from(coefficients.tailRates, (rate) => Math.exp(-rate * thetaStep));
  const tailGain = Float64Array.from(coefficients.tailRates, (rate) => {
    const scaledStep = rate * thetaStep;
    return Math.exp(-rate * coefficients.cutoffTheta) * (-Math.expm1(-scaledStep) / scaledStep);
  });
  return { version: coefficients.kernelVersion, stepUs, historyLength, weights, tailDecay, tailGain, sourceScale };
}

export function initializeZielke(kernel: ZielkeKernel, velocities: Float64Array): ZielkeState {
  const nodes = velocities.length;
  requireDomain(nodes > 0 && nodes <= 401 && velocities.every(Number.isFinite), 'Invalid initial Zielke velocity field');
  return {
    previousVelocity: velocities.slice(),
    deltas: new Float64Array(nodes * kernel.historyLength),
    tail: new Float64Array(nodes * kernel.tailDecay.length),
    cursor: 0, historyCount: 0,
    acceleration: new Float64Array(nodes),
  };
}

function advanceTails(
  kernel: ZielkeKernel,
  previous: ZielkeState,
  nodes: number,
  accumulated: Float64Array,
): Float64Array {
  const tail = new Float64Array(previous.tail.length);
  const evictedStart = previous.cursor * nodes;
  for (let term = 0; term < kernel.tailDecay.length; term++) {
    const decay = kernel.tailDecay[term]!;
    const gain = kernel.tailGain[term]!;
    const termOffset = term * nodes;
    for (let node = 0; node < nodes; node++) {
      const index = termOffset + node;
      const value = decay * previous.tail[index]! + gain * previous.deltas[evictedStart + node]!;
      tail[index] = value;
      accumulated[node] = accumulated[node]! + value;
    }
  }
  return tail;
}

export function updateZielke(kernel: ZielkeKernel, previous: ZielkeState, velocities: Float64Array): ZielkeState {
  const nodes = velocities.length;
  const { historyLength } = kernel;
  const { cursor } = previous;
  requireDomain(nodes === previous.previousVelocity.length && previous.deltas.length === nodes * historyLength &&
    previous.tail.length === nodes * kernel.tailDecay.length &&
    Number.isInteger(cursor) && cursor >= 0 && cursor < historyLength &&
    Number.isInteger(previous.historyCount) && previous.historyCount >= 0 && previous.historyCount <= historyLength &&
    velocities.every(Number.isFinite), 'Invalid Zielke history dimensions or velocities');

  const deltas = previous.deltas.slice();
  const newSlot = cursor * nodes;
  for (let node = 0; node < nodes; node++) {
    deltas[newSlot + node] = velocities[node]! - previous.previousVelocity[node]!;
  }

  const acceleration = new Float64Array(nodes);
  const tail = advanceTails(kernel, previous, nodes, acceleration);
  const historyCount = Math.min(historyLength, previous.historyCount + 1);
  for (let lag = 0; lag < historyCount; lag++) {
    const offset = ((cursor - lag + historyLength) % historyLength) * nodes;
    const weight = kernel.weights[lag]!;
    for (let node = 0; node < nodes; node++) {
      acceleration[node] = acceleration[node]! + weight * deltas[offset + node]!;
    }
  }
  for (let node = 0; node < nodes; node++) {
    acceleration[node] = acceleration[node]! * kernel.sourceScale;
    requireDomain(Number.isFinite(acceleration[node]), 'Nonfinite Zielke acceleration');
  }

  return {
    previousVelocity: velocities.slice(), deltas, tail, acceleration,
    cursor: (cursor + 1) % historyLength, historyCount,
  };
}
