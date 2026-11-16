export function nextBoundary(timeUs: number, periodUs: number): number {
  return (Math.floor(timeUs / periodUs) + 1) * periodUs
}

export function paceTarget(originTimeUs: number, originWallMs: number, nowWallMs: number, pace: number): number {
  return originTimeUs + Math.max(0, Math.floor((nowWallMs - originWallMs) * 1000 * pace))
}
