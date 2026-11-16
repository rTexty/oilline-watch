const SECOND_US = 1_000_000
const GUARD_US = 3 * SECOND_US
export const HISTORY_SECOND_LIMIT = 41
const FRAME_LIMIT = 100

interface Sample<T> {
  readonly timeUs: number
  readonly frame: T
}

interface Second<T, C> {
  readonly startUs: number
  readonly frames: readonly Sample<T>[]
  readonly checkpoint: C | null
}

export interface History<T, C> {
  readonly seconds: readonly Second<T, C>[]
  readonly lastTimeUs: number
}

export function emptyHistory<T, C>(): History<T, C> {
  return { seconds: [], lastTimeUs: -1 }
}

export function appendHistory<T, C>(
  history: History<T, C>,
  timeUs: number,
  frame: T,
  checkpoint: C | null,
): History<T, C> {
  if (!Number.isSafeInteger(timeUs) || timeUs <= history.lastTimeUs) throw new RangeError('History time must increase.')
  const startUs = Math.floor(timeUs / SECOND_US) * SECOND_US
  const last = history.seconds.at(-1)
  const sample = { timeUs, frame }
  if (last?.startUs === startUs) {
    if (last.frames.length >= FRAME_LIMIT || checkpoint !== null) throw new RangeError('Invalid second history capacity.')
    return { seconds: [...history.seconds.slice(0, -1), { ...last, frames: [...last.frames, sample] }], lastTimeUs: timeUs }
  }
  if (checkpoint !== null && timeUs !== startUs) throw new RangeError('Checkpoint must be on the one-second grid.')
  const entry = { startUs, frames: [sample], checkpoint }
  return { seconds: [...history.seconds.slice(-(HISTORY_SECOND_LIMIT - 1)), entry], lastTimeUs: timeUs }
}

export function freezeWindow<T, C>(history: History<T, C>, endUs: number, durationUs: number) {
  const startUs = endUs - durationUs
  if (!Number.isSafeInteger(endUs) || !Number.isSafeInteger(durationUs) || endUs > history.lastTimeUs
    || startUs < GUARD_US || durationUs <= 0) return null
  const checkpoint = history.seconds.findLast((entry) => entry.checkpoint !== null && entry.startUs <= startUs - GUARD_US)
  if (!checkpoint || checkpoint.checkpoint === null || checkpoint.startUs < startUs - GUARD_US - SECOND_US) return null
  const frames = history.seconds.flatMap((entry) => entry.frames
    .filter((sample) => sample.timeUs >= startUs && sample.timeUs <= endUs)
    .map((sample) => sample.frame))
  if (frames.length === 0) return null
  return { checkpoint: checkpoint.checkpoint, checkpointTimeUs: checkpoint.startUs, startUs, endUs, frames }
}
