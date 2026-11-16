export type Seed = readonly [number, number, number, number]

export const RANDOM_VERSION = 'xoshiro128ss-v1/splitmix32-v1'

export function expandSeed(master: number, stream: number): Seed {
  const word = (index: number) => {
    let value = (master + Math.imul(1 + stream * 4 + index, 0x9e3779b9)) >>> 0
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
    return (value ^ (value >>> 15)) >>> 0
  }
  return [word(0), word(1), word(2), word(3)]
}

function rotateLeft(word: number, bits: number): number {
  return ((word << bits) | (word >>> (32 - bits))) >>> 0
}

export function nextUniform([a, b, c, d]: Seed): { value: number; seed: Seed } {
  const word = Math.imul(rotateLeft(Math.imul(b, 5), 7), 9) >>> 0
  const mixedC = c ^ a
  const mixedD = d ^ b
  return {
    value: (word + 0.5) / 4_294_967_296,
    seed: [(a ^ mixedD) >>> 0, (b ^ mixedC) >>> 0, (mixedC ^ (b << 9)) >>> 0, rotateLeft(mixedD, 11)],
  }
}

export interface NormalState {
  readonly seed: Seed
  readonly spare: number | null
}

export function nextNormal(state: NormalState): { value: number; state: NormalState } {
  if (state.spare !== null) return { value: state.spare, state: { ...state, spare: null } }
  const a = nextUniform(state.seed)
  const b = nextUniform(a.seed)
  const radius = Math.sqrt(-2 * Math.log(a.value))
  const angle = 2 * Math.PI * b.value
  return {
    value: radius * Math.cos(angle),
    state: { seed: b.seed, spare: radius * Math.sin(angle) },
  }
}
