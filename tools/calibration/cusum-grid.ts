import { z } from 'zod'
import { PRESSURE_PERIOD_US } from '../../src/contracts/public'
import { CHALLENGE_US, MAX_THRESHOLD, MIN_THRESHOLD } from './contracts'
import { sha256Schema } from '../../src/contracts/calibration'

const TICK_COUNT = CHALLENGE_US / PRESSURE_PERIOD_US
const RECOVERY_TICKS = 1_000_000 / PRESSURE_PERIOD_US
const REFRACTORY_TICKS = 2_000_000 / PRESSURE_PERIOD_US
const positive = z.number().nonnegative()
const cachedTickSchema = z.tuple([positive, positive, positive, positive])
  .refine(([openFast, openSlow, closeFast, closeSlow]) => openFast <= closeFast && openSlow <= closeSlow).nullable()
export type CachedTick = z.infer<typeof cachedTickSchema>

export const cusumSourceHashesSchema = z.strictObject({ model: sha256Schema, bank: sha256Schema, sensor: sha256Schema })
type CusumSourceHashes = z.infer<typeof cusumSourceHashesSchema>

export function matchingCusumSources(source: CusumSourceHashes, expected: CusumSourceHashes): boolean {
  return source.model === expected.model && source.bank === expected.bank && source.sensor === expected.sensor
}

const cacheFields = {
  splitHash: sha256Schema,
  profileHash: sha256Schema,
  policyHash: sha256Schema,
  samplePeriodUs: z.literal(PRESSURE_PERIOD_US),
  runs: z.array(z.strictObject({
    runId: z.string().min(1).max(96),
    ticks: z.array(cachedTickSchema).length(TICK_COUNT),
  })).length(15),
}

export const cachedCusumSchema = z.discriminatedUnion('schemaVersion', [
  z.strictObject({ schemaVersion: z.literal(1), ...cacheFields }),
  z.strictObject({ schemaVersion: z.literal(2), ...cacheFields, sourceHashes: cusumSourceHashesSchema }),
])

function trailingMaximum(samples: readonly CachedTick[], channel: 2 | 3): Float64Array {
  const maxima = new Float64Array(samples.length)
  const positions = new Uint16Array(samples.length)
  const values = new Float64Array(samples.length)
  let head = 0
  let tail = 0
  for (const [index, sample] of samples.entries()) {
    const value = sample?.[channel] ?? Number.POSITIVE_INFINITY
    while (head < tail && positions[head]! < index - RECOVERY_TICKS) head += 1
    while (head < tail && values[tail - 1]! <= value) tail -= 1
    positions[tail] = index
    values[tail] = value
    tail += 1
    maxima[index] = index >= RECOVERY_TICKS ? values[head]! : Number.POSITIVE_INFINITY
  }
  return maxima
}

function nextThresholdMatches(length: number, matches: (sample: number, threshold: number) => boolean) {
  return Array.from({ length: MAX_THRESHOLD - MIN_THRESHOLD + 1 }, (_, ordinal) => {
    const threshold = ordinal + MIN_THRESHOLD
    const nextMatch = new Uint16Array(length + 1)
    let nearest = length
    nextMatch[length] = length
    for (let index = length - 1; index >= 0; index--) {
      if (matches(index, threshold)) nearest = index
      nextMatch[index] = nearest
    }
    return nextMatch
  })
}

export function prepareEpisodeQueries(ticks: readonly CachedTick[]) {
  if (ticks.length > TICK_COUNT) throw new Error('CUSUM cache exceeds the model horizon.')
  const fastTrailing = trailingMaximum(ticks, 2)
  const slowTrailing = trailingMaximum(ticks, 3)
  return {
    length: ticks.length,
    openFast: nextThresholdMatches(ticks.length, (index, threshold) => (ticks[index]?.[0] ?? 0) >= threshold),
    openSlow: nextThresholdMatches(ticks.length, (index, threshold) => (ticks[index]?.[1] ?? 0) >= threshold),
    closeFast: nextThresholdMatches(ticks.length, (index, threshold) => fastTrailing[index]! < threshold / 2),
    closeSlow: nextThresholdMatches(ticks.length, (index, threshold) => slowTrailing[index]! < threshold / 2),
  }
}

export function countEpisodes(queries: ReturnType<typeof prepareEpisodeQueries>, fast: number, slow: number): number {
  const thresholdValid = (threshold: number) => Number.isInteger(threshold) && threshold >= MIN_THRESHOLD && threshold <= MAX_THRESHOLD
  if (!thresholdValid(fast) || !thresholdValid(slow)) throw new RangeError('CUSUM threshold outside the grid.')
  const fastOpen = queries.openFast[fast - MIN_THRESHOLD]!
  const slowOpen = queries.openSlow[slow - MIN_THRESHOLD]!
  const fastClose = queries.closeFast[fast - MIN_THRESHOLD]!
  const slowClose = queries.closeSlow[slow - MIN_THRESHOLD]!
  let episodes = 0
  let cursor = 0
  while (cursor < queries.length) {
    const opened = Math.min(fastOpen[cursor]!, slowOpen[cursor]!)
    if (opened === queries.length) break
    episodes += 1
    let recovered = Math.min(opened + 1 + RECOVERY_TICKS, queries.length)
    while (recovered < queries.length) {
      const next = Math.max(fastClose[recovered]!, slowClose[recovered]!)
      if (next === recovered) break
      recovered = next
    }
    cursor = recovered + REFRACTORY_TICKS
  }
  return episodes
}

export function buildCusumGrid(cache: z.infer<typeof cachedCusumSchema>) {
  const runIds = cache.runs.map(({ runId }) => runId)
  if (new Set(runIds).size !== runIds.length) throw new Error('Duplicated CUSUM cache run ID.')
  const availableUs = cache.runs.map(({ ticks }) => ticks.filter((tick) => tick !== null).length * PRESSURE_PERIOD_US)
  if (availableUs.some((time) => time === 0)) throw new Error('A healthy CUSUM run has no available observations.')
  const thresholds = Array.from({ length: MAX_THRESHOLD - MIN_THRESHOLD + 1 }, (_, index) => index + MIN_THRESHOLD)
  const candidates = thresholds.flatMap((fast) => thresholds.map((slow) => ({ fast, slow, episodes: [] as number[] })))
  for (const { ticks } of cache.runs) {
    const queries = prepareEpisodeQueries(ticks)
    for (const candidate of candidates) candidate.episodes.push(countEpisodes(queries, candidate.fast, candidate.slow))
  }
  const grid = { splitHash: cache.splitHash, profileHash: cache.profileHash, policyHash: cache.policyHash, runIds, availableUs, candidates }
  return cache.schemaVersion === 2
    ? { schemaVersion: 2 as const, ...grid, sourceHashes: cache.sourceHashes }
    : { schemaVersion: 1 as const, ...grid }
}
