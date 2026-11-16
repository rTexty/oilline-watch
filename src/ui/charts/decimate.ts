export interface ChartPoint {
  readonly timeS: number;
  readonly value: number | null;
}

export function decimate(
  points: readonly ChartPoint[],
  columns: number,
  startS: number,
  endS: number,
): readonly ChartPoint[] {
  if (points.length <= columns * 2 || columns < 1 || startS >= endS) return points;

  const output: ChartPoint[] = [];
  let bucket = -1;
  let first: ChartPoint | undefined;
  let low: ChartPoint | undefined;
  let high: ChartPoint | undefined;
  let last: ChartPoint | undefined;

  function flush() {
    const extrema = [first, low, high, last].filter((point) => point !== undefined);
    output.push(...Array.from(new Set(extrema)).sort((left, right) => left.timeS - right.timeS));
    first = low = high = last = undefined;
  }

  for (const point of points) {
    if (point.value === null) {
      flush();
      if (output.at(-1)?.value !== null) output.push(point);
      continue;
    }

    const nextBucket = Math.floor((point.timeS - startS) / (endS - startS) * columns);
    if (nextBucket !== bucket) {
      flush();
      bucket = nextBucket;
    }

    first ??= point;
    if (!low || low.value === null || point.value < low.value) low = point;
    if (!high || high.value === null || point.value > high.value) high = point;
    last = point;
  }

  flush();
  return output;
}
