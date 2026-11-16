import type { Scenario, Split } from '../contracts'
import { isReservedClosureScenario } from '../closure-pairs'
import { relevantScenarios } from '../qualify'

type OpenRole = Exclude<Split['split'], 'blind'>
type Closure = 'qs' | 'vb10'

interface AcquiredRun {
  readonly runId: string
  readonly sourceRunId: string
  readonly closure: Closure
  readonly status: 'acquired' | 'missing-report' | 'invalid-report'
  readonly reportSha256: string | null
  readonly fullHorizon: boolean
  readonly build?: {
    readonly browserVersion: string
    readonly adapterSha256: string
    readonly assetsSha256: string
  }
}

function truthFor(scenario: Scenario) {
  if (scenario.kind !== 'leak') return { kind: scenario.kind, family: scenario.family }
  const { kind, onsetUs, positionM, sizeM2, openingSeconds } = scenario
  return { kind, core: sizeM2 !== 5e-6, onsetUs, positionM, sizeM2, openingSeconds }
}

function indexRuns(rows: readonly AcquiredRun[], scenarios: readonly Scenario[]) {
  const declared = new Map(scenarios.map((scenario) => [scenario.runId, scenario]))
  const byClosure = { qs: new Map<string, Omit<AcquiredRun, 'sourceRunId'>>(), vb10: new Map<string, Omit<AcquiredRun, 'sourceRunId'>>() }
  for (const { sourceRunId, runId, closure, status, reportSha256, fullHorizon, build } of rows) {
    const source = declared.get(sourceRunId)
    if (!source) throw new Error(`Paced run ${runId} has no declared source in this layout.`)
    if (closure === 'vb10' && !isReservedClosureScenario(source)) throw new Error(`Paced run ${runId} has no reserved VB10 source.`)
    if (runId !== (closure === 'qs' ? sourceRunId : `${sourceRunId}-vb10`)) throw new Error(`Invalid paced run lineage: ${runId}.`)
    const group = byClosure[closure]
    if (group.has(sourceRunId)) throw new Error(`Duplicate paced run: ${runId}.`)
    group.set(sourceRunId, { runId, closure, status, reportSha256, fullHorizon, ...(build ? { build } : {}) })
  }
  return byClosure
}

function counts(rows: ReadonlyMap<string, Omit<AcquiredRun, 'sourceRunId'>>) {
  const recorded = [...rows.values()]
  return {
    listed: rows.size,
    acquired: recorded.filter(({ status }) => status === 'acquired').length,
    fullHorizons: recorded.filter(({ fullHorizon }) => fullHorizon).length,
  }
}

export function buildPacedSplitCoverage(
  split: Split, role: OpenRole, sensor: Scenario['sensor'], rows: readonly AcquiredRun[],
) {
  if (split.split !== role) throw new Error('Paced matrix and split declaration roles differ.')
  const scenarios = relevantScenarios(split.scenarios, sensor)
  const runs = indexRuns(rows, scenarios)
  const qs = counts(runs.qs)
  const projected = scenarios.map((scenario) => ({
    sourceRunId: scenario.runId, truth: truthFor(scenario),
    qs: runs.qs.get(scenario.runId) ?? null, vb10: runs.vb10.get(scenario.runId) ?? null,
  }))
  return {
    declaredScenarios: scenarios.length,
    coreLeaks: projected.filter(({ truth }) => truth.kind === 'leak' && truth.core).length,
    qs: { ...qs, unlisted: scenarios.length - qs.listed }, vb10: counts(runs.vb10), rows: projected,
  }
}
