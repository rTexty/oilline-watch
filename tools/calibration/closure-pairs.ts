import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sha256Schema } from '../../src/contracts/calibration'
import { scenarioCell, splitSchema } from './contracts'
import type { RunEvidence, Scenario } from './contracts'
import { binomialBounds, leakEvaluation, median } from './metrics'

const id = z.string().min(1).max(96).regex(/^[a-zA-Z0-9_-]+$/)
const pairSchema = z.strictObject({
  pairId: id, kind: z.enum(['leak', 'null']), qsRunId: id, vb10RunId: id, sourceRecipeRunId: id,
  seedHash: sha256Schema, parameterBlockHash: sha256Schema,
})
export const closurePairDeclarationSchema = z.strictObject({
  schemaVersion: z.literal(1), split: splitSchema.shape.split, pairs: z.array(pairSchema).length(68),
})
type ClosurePair = z.infer<typeof pairSchema>
type ClosureScenario = Extract<Scenario, { kind: 'leak' | 'null' }>
type Arm = 'qs' | 'vb10'

export function isReservedClosureScenario(scenario: Scenario): scenario is ClosureScenario {
  return scenario.kind === 'leak' ? scenario.replicate === 0 && [100, 500, 900].includes(scenario.centerM)
    : scenario.kind === 'null' && scenario.replicate < 2
}

export function matchClosurePairs(scenarios: readonly Scenario[], declarations: readonly ClosurePair[]) {
  const reserved = scenarios.filter(isReservedClosureScenario)
  const byId = new Map(declarations.map((row) => [row.qsRunId, row]))
  if (reserved.length !== 68 || byId.size !== 68 || declarations.length !== 68
    || new Set(reserved.map(({ runId }) => runId)).size !== 68) {
    throw new Error('Closure evidence requires the complete 68-pair declaration.')
  }
  return reserved.map((scenario) => {
    const { runId, kind, seedHash, parameterBlockHash } = scenario
    const pair = byId.get(runId)
    if (!pair || pair.kind !== kind || pair.pairId !== `${runId}-closure` || pair.vb10RunId !== `${runId}-vb10`
      || pair.sourceRecipeRunId !== runId || pair.seedHash !== seedHash || pair.parameterBlockHash !== parameterBlockHash) {
      throw new Error(`Closure pair does not match the reserved scenario ${runId}.`)
    }
    return { scenario, pair }
  })
}

function matchRuns(runs: readonly RunEvidence[], expectedIds: readonly string[]) {
  const lookup = new Map(runs.map((run) => [run.runId, run]))
  if (lookup.size !== expectedIds.length || runs.length !== expectedIds.length || expectedIds.some((id) => !lookup.has(id))) {
    throw new Error('Each closure arm must include every reserved run exactly once.')
  }
  return lookup
}

function observe(scenario: ClosureScenario, run: RunEvidence) {
  const { runId, availableUs, alarms, supports, outcome, activeProposals, activeAccepts, structuralClaim } = run
  return {
    runId, availableUs, alarms, supports, outcome, activeProposals, activeAccepts, structuralClaim,
    leak: scenario.kind === 'leak' ? leakEvaluation(scenario, run) : null,
    earlySupports: scenario.kind === 'leak' ? supports.filter(({ timeUs }) => timeUs < scenario.onsetUs).length : 0,
  }
}
type Observed = ReturnType<typeof observe>

function timely(observation: Observed): boolean {
  const delay = observation.leak?.delayUs
  return delay != null && delay <= 30_000_000
}

function summarizeArm(core: readonly Observed[], small: readonly Observed[], nulls: readonly Observed[]) {
  const corePod30 = binomialBounds(core.filter(timely).length, core.length)
  const coreCoverage = binomialBounds(core.filter(({ leak }) => leak?.covered).length, core.length)
  const observedDelaysUs = core.flatMap(({ leak }) => leak?.delayUs == null ? [] : [leak.delayUs])
  const falseSupportEpisodes = nulls.reduce((sum, run) => sum + run.supports.length, 0)
  const all = [...core, ...small, ...nulls]
  return {
    corePod30, coreCoverage,
    smallPod30: binomialBounds(small.filter(timely).length, small.length),
    smallCoverage: binomialBounds(small.filter(({ leak }) => leak?.covered).length, small.length),
    coreDelayUs: { median: median(observedDelaysUs), observed: observedDelaysUs.length, censored: core.length - observedDelaysUs.length },
    coreAbstentions: core.filter(({ leak }) => !leak?.localized).length,
    earlySupports: all.reduce((sum, run) => sum + run.earlySupports, 0),
    alarmEpisodes: all.reduce((sum, run) => sum + run.alarms.length, 0),
    null: {
      runs: nulls.length, falseSupportEpisodes, falseSupportRuns: nulls.filter(({ supports }) => supports.length > 0).length,
      alarmEpisodes: nulls.reduce((sum, run) => sum + run.alarms.length, 0),
      availableUs: nulls.reduce((sum, run) => sum + run.availableUs, 0),
    },
    gates: { pod30: corePod30.successes >= 22, coverage: coreCoverage.successes >= 20, zeroFalseSupport: falseSupportEpisodes === 0 },
  }
}

const BOOTSTRAP_REPLICATES = 2000

function bootstrapDifference(differences: readonly number[]) {
  let state = createHash('sha256').update('metrics-bootstrap-v1').digest().readUInt32LE(0)
  const replicates = Array.from({ length: BOOTSTRAP_REPLICATES }, () => {
    let sum = 0
    for (let pair = 0; pair < differences.length; pair++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      const index = Math.floor((state >>> 0) / 2 ** 32 * differences.length)
      sum += differences[index]!
    }
    return sum / differences.length
  }).sort((a, b) => a - b)
  return [replicates[Math.ceil(replicates.length * 0.025) - 1]!, replicates[Math.ceil(replicates.length * 0.975) - 1]!] as const
}

function comparePairs(rows: readonly Record<Arm, Observed>[], predicate: (run: Observed) => boolean) {
  const paired = rows.map(({ qs, vb10 }) => [predicate(qs), predicate(vb10)] as const)
  const both = paired.filter(([qs, vb10]) => qs && vb10).length
  const qsOnly = paired.filter(([qs, vb10]) => qs && !vb10).length
  const vb10Only = paired.filter(([qs, vb10]) => !qs && vb10).length
  return {
    both, qsOnly, vb10Only, neither: paired.length - both - qsOnly - vb10Only,
    estimate: (vb10Only - qsOnly) / paired.length,
    twoSided95: bootstrapDifference(paired.map(([qs, vb10]) => Number(vb10) - Number(qs))),
  }
}

export function summarizeClosurePairs(
  scenarios: readonly Scenario[], declarations: readonly ClosurePair[], qsRuns: readonly RunEvidence[], vb10Runs: readonly RunEvidence[],
) {
  const matched = matchClosurePairs(scenarios, declarations)
  const qs = matchRuns(qsRuns, matched.map(({ pair }) => pair.qsRunId))
  const vb10 = matchRuns(vb10Runs, matched.map(({ pair }) => pair.vb10RunId))
  const rows = matched.map(({ scenario, pair }) => ({
    pairId: pair.pairId, cell: scenarioCell(scenario), kind: scenario.kind, sensor: scenario.sensor,
    core: scenario.kind === 'leak' && scenario.sizeM2 !== 5e-6,
    qs: observe(scenario, qs.get(pair.qsRunId)!), vb10: observe(scenario, vb10.get(pair.vb10RunId)!),
  }))
  const core = rows.filter((row) => row.core)
  const small = rows.filter(({ core, kind }) => !core && kind === 'leak')
  const nulls = rows.filter(({ kind }) => kind === 'null')
  if (core.length !== 24 || small.length !== 12 || nulls.length !== 32) throw new Error('Invalid closure-pair strata.')
  const arm = (key: Arm) => summarizeArm(core.map((row) => row[key]), small.map((row) => row[key]), nulls.map((row) => row[key]))
  return {
    pairs: rows,
    arms: { qs: arm('qs'), vb10: arm('vb10') },
    discordance: {
      corePod30: comparePairs(core, timely),
      coreCoverage: comparePairs(core, ({ leak }) => leak?.covered === true),
      nullFalseSupport: comparePairs(nulls, ({ supports }) => supports.length > 0),
    },
    bootstrap: { replicates: BOOTSTRAP_REPLICATES, unit: 'whole-pair', difference: 'vb10-minus-qs' },
  }
}
