interface Accumulator {
  readonly positive: number
  readonly negative: number
}

export interface CusumPolicy {
  readonly rho: number
  readonly fastThreshold: number
  readonly slowThreshold: number
  readonly periodUs: number
}

interface Pair {
  readonly residual: number
  readonly timeUs: number
  readonly seq: number
}

export interface CusumState {
  readonly fast: Accumulator
  readonly slow: Accumulator
  readonly lastReceivedSeq: number
  readonly lastReceivedUs: number
  readonly lastValidUs: number | null
  readonly pair: Pair | null
  readonly crossed: boolean
}

export function initialCusum(): CusumState {
  return {
    fast: { positive: 0, negative: 0 },
    slow: { positive: 0, negative: 0 },
    lastReceivedSeq: -1,
    lastReceivedUs: -1,
    lastValidUs: null,
    pair: null,
    crossed: false,
  }
}

function accumulate(previous: Accumulator, innovation: number, allowance: number): Accumulator {
  return {
    positive: Math.max(0, previous.positive + innovation - allowance),
    negative: Math.max(0, previous.negative - innovation - allowance),
  }
}

export function updateCusum(
  previous: CusumState,
  seq: number,
  timeUs: number,
  normalizedResidual: number | null,
  policy: CusumPolicy,
): CusumState {
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(timeUs) || seq <= previous.lastReceivedSeq
    || timeUs <= previous.lastReceivedUs) return previous
  if (!Number.isFinite(policy.rho) || Math.abs(policy.rho) >= 1 || !Number.isSafeInteger(policy.periodUs)
    || policy.periodUs <= 0 || !Number.isFinite(policy.fastThreshold) || policy.fastThreshold <= 0
    || !Number.isFinite(policy.slowThreshold) || policy.slowThreshold <= 0) throw new RangeError('Invalid CUSUM policy.')

  const outage = previous.lastValidUs !== null && timeUs - previous.lastValidUs > 500_000
  const state = outage ? initialCusum() : previous
  const next = { ...state, lastReceivedSeq: seq, lastReceivedUs: timeUs, crossed: false }
  if (normalizedResidual === null || !Number.isFinite(normalizedResidual)) return { ...next, pair: null }

  const pair = { seq, timeUs, residual: normalizedResidual }
  const updated = { ...next, lastValidUs: timeUs, pair }
  const reference = state.pair
  if (!reference || reference.seq + 1 !== seq || timeUs - reference.timeUs > 2 * policy.periodUs) return updated

  const innovation = (normalizedResidual - policy.rho * reference.residual) / Math.sqrt(1 - policy.rho ** 2)
  const fast = accumulate(state.fast, innovation, 0.5)
  const slow = accumulate(state.slow, innovation, 0.1)
  const crossed = Math.max(fast.positive, fast.negative) >= policy.fastThreshold
    || Math.max(slow.positive, slow.negative) >= policy.slowThreshold
  return { ...updated, fast, slow, crossed }
}
