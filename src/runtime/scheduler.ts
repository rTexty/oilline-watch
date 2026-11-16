interface Frame {
  readonly sampleTimeUs: number
}

interface Schedule<T extends Frame> {
  readonly active: T | null
  readonly pending: T | null
}

export function emptySchedule<T extends Frame>(): Schedule<T> {
  return { active: null, pending: null }
}

export function offer<T extends Frame>(previous: Schedule<T>, frame: T): Schedule<T> {
  if (!previous.active) return { active: frame, pending: null }
  if (frame.sampleTimeUs <= (previous.pending ?? previous.active).sampleTimeUs) return previous
  return { active: previous.active, pending: frame }
}

export function complete<T extends Frame>(previous: Schedule<T>, timeUs: number): Schedule<T> {
  if (previous.active?.sampleTimeUs !== timeUs) return previous
  return { active: previous.pending, pending: null }
}
