import { z } from 'zod'
import { MAX_THRESHOLD, MIN_THRESHOLD } from './contracts'
import type { Scenario } from './contracts'
import { median } from './metrics'

export const QUANTILES = [0.9, 0.95, 0.975, 0.99, 0.995, 0.999] as const
export const STATISTICS = ['improvement', 'separation', 'absoluteFit', 'profile', 'envelope'] as const
const indexSchema = z.number().int().min(0).max(QUANTILES.length - 1)
export const diagnosticIndicesSchema = z.tuple([indexSchema, indexSchema, indexSchema, indexSchema, indexSchema])

export const statisticSchema = z.strictObject({
  improvement: z.number(), separation: z.number(), absoluteFit: z.number().nonnegative(),
  profile: z.number().nonnegative(), envelope: z.number().nonnegative(),
})
type Statistic = z.infer<typeof statisticSchema>

export function fitQuantiles(values: readonly number[], floor: number): readonly number[] {
  if (values.length === 0 || !Number.isFinite(floor) || floor < 0) throw new Error('Missing fit statistics or invalid numerical floor.')
  if (!values.every(Number.isFinite)) throw new Error('Non-finite fit statistics.')
  const sorted = values.toSorted((a, b) => a - b)
  return QUANTILES.map((q) => Math.max(floor, sorted[Math.ceil(q * sorted.length) - 1]!))
}

export function thresholdGrid(rows: readonly Statistic[], floor: number): Record<keyof Statistic, readonly number[]> {
  const quantiles = (key: keyof Statistic) => fitQuantiles(rows.map((row) => row[key]), floor)
  return {
    improvement: quantiles('improvement'), separation: quantiles('separation'),
    absoluteFit: quantiles('absoluteFit'), profile: quantiles('profile'), envelope: quantiles('envelope'),
  }
}

export const cusumCandidateSchema = z.strictObject({
  fast: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD),
  slow: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD),
  episodes: z.array(z.number().int().min(0).max(150)).length(15),
})
type CusumCandidate = z.infer<typeof cusumCandidateSchema>
export const CUSUM_GRID_SIZE = (MAX_THRESHOLD - MIN_THRESHOLD + 1) ** 2

export function chooseCusum(grid: readonly CusumCandidate[], exposureHours: number, runCount: number) {
  if (!(exposureHours > 0) || !Number.isFinite(exposureHours) || grid.length === 0) throw new Error('Missing CUSUM calibration exposure.')
  const span = MAX_THRESHOLD - MIN_THRESHOLD + 1
  let selected: { fast: number; slow: number } | undefined
  for (const [ordinal, { fast, slow, episodes }] of grid.entries()) {
    if (episodes.length !== runCount || fast !== MIN_THRESHOLD + Math.floor(ordinal / span) || slow !== MIN_THRESHOLD + ordinal % span) {
      throw new Error('CUSUM grid must be complete and lexicographically ordered.')
    }
    if (!selected && episodes.reduce((sum, count) => sum + count, 0) <= exposureHours) selected = { fast, slow }
  }
  if (!selected) throw new Error('No CUSUM thresholds meet the observed healthy episode budget.')
  return selected
}

const location = z.number().min(0).max(1000)
const region = z.tuple([location, location]).refine(([left, right]) => left < right)
const support = z.strictObject({
  timeUs: z.number().int().min(30_000_000).max(330_000_000),
  regions: z.array(region).max(200).refine((regions) => regions.every(([start], index) => index === 0 || start >= regions[index - 1]![1])),
})
export const diagnosticCandidateSchema = z.strictObject({
  indices: diagnosticIndicesSchema,
  runs: z.array(z.strictObject({ runId: z.string().max(96), firstSupport: support.nullable() })).max(408),
})
export type DiagnosticCandidate = z.infer<typeof diagnosticCandidateSchema>
export type DiagnosticIndices = DiagnosticCandidate['indices']
export const DIAGNOSTIC_GRID_SIZE = QUANTILES.length ** STATISTICS.length

interface Score {
  readonly correct: number
  readonly timely: number
  readonly width: number
  readonly indices: DiagnosticCandidate['indices']
}

function evaluate(candidate: DiagnosticCandidate, scenarios: readonly Scenario[]): Score | null {
  if (candidate.runs.length !== scenarios.length) throw new Error('Diagnostic grid candidate is missing runs.')
  let correct = 0
  let timely = 0
  let falseSupport = false
  const widths: number[] = []
  for (const [ordinal, scenario] of scenarios.entries()) {
    const run = candidate.runs[ordinal]!
    if (run.runId !== scenario.runId) throw new Error('Diagnostic candidate runs must match the declared matrix order.')
    if (!run.firstSupport) continue
    if (scenario.kind !== 'leak') {
      if (scenario.kind === 'null' || !['D07', 'D10', 'D12'].includes(scenario.family)) falseSupport = true
      continue
    }
    const delay = run.firstSupport.timeUs - scenario.onsetUs
    if (delay < 0) falseSupport = true
    if (delay < 0 || delay > 30_000_000) continue
    timely += 1
    const { regions } = run.firstSupport
    if (regions.length > 0) widths.push(regions.reduce((sum, [left, right]) => sum + right - left, 0))
    if (regions.some(([left, right]) => scenario.positionM >= left && scenario.positionM <= right)) correct += 1
  }
  return falseSupport ? null : { correct, timely, width: median(widths) ?? Number.POSITIVE_INFINITY, indices: candidate.indices }
}

export async function selectDiagnostic(candidates: AsyncIterable<DiagnosticCandidate>, scenarios: readonly Scenario[]) {
  if (scenarios.length === 0) throw new Error('Missing calibration scenarios.')
  let best: Score | null = null
  let ordinal = 0
  for await (const candidate of candidates) {
    const encoded = candidate.indices.reduce((number, index) => number * QUANTILES.length + index, 0)
    if (ordinal !== encoded) throw new Error('Diagnostic grid must be unique and lexicographically ordered.')
    ordinal += 1
    const score = evaluate(candidate, scenarios)
    if (score && (!best || score.correct > best.correct || (score.correct === best.correct
      && (score.timely > best.timely || (score.timely === best.timely && score.width < best.width))))) best = score
  }
  if (ordinal !== DIAGNOSTIC_GRID_SIZE) throw new Error('Incomplete diagnostic quantile grid.')
  if (!best) throw new Error('No diagnostic thresholds avoid false support on calibration.')
  return best
}

export function selectedThresholds(grid: ReturnType<typeof thresholdGrid>, indices: DiagnosticIndices) {
  const [improvement, separation, absoluteFit, profile, envelope] = indices
  return {
    improvement: grid.improvement[improvement]!, separation: grid.separation[separation]!,
    absoluteFit: grid.absoluteFit[absoluteFit]!, profile: grid.profile[profile]!, envelope: grid.envelope[envelope]!,
  }
}
