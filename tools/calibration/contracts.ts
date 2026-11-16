import { createHash } from 'node:crypto'
import { z } from 'zod'
import { sha256Schema } from '../../src/contracts/calibration'
import { CHALLENGE_HORIZON_US, CHALLENGE_WARMUP_US } from '../../src/contracts/model'

export const CHALLENGE_US = CHALLENGE_HORIZON_US - CHALLENGE_WARMUP_US
export const PIPE_LENGTH_M = 1000
export const MIN_THRESHOLD = 2
export const MAX_THRESHOLD = 200
export const SENSOR_LAYOUTS = ['nominal', 'adverse'] as const
const sensorSchema = z.enum(SENSOR_LAYOUTS)
const id = z.string().min(1).max(96).regex(/^[a-zA-Z0-9_-]+$/)
const challengeTime = z.number().int().min(CHALLENGE_WARMUP_US).max(CHALLENGE_HORIZON_US)
const replicate = z.number().int().nonnegative()
const center = z.literal([100, 300, 500, 700, 900])
const position = z.number().min(0).max(PIPE_LENGTH_M)
const runBase = { runId: id, sensor: sensorSchema, seedHash: sha256Schema, parameterBlockHash: sha256Schema }

export const NULL_FAMILIES = [
  'healthy', 'known-qout', 'unknown-qout', 'sensor-bias', 'drift', 'stuck', 'noise-delivery-dropout', 'joint-properties-sensor',
] as const

const discrepancyFamilies = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12'] as const
const scenarioSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...runBase, kind: z.literal('leak'), replicate: replicate.max(1),
    openingSeconds: z.literal([0, 20]), sizeM2: z.literal([5e-6, 1e-5, 2e-5]),
    centerM: center, positionM: position, onsetUs: z.number().int().min(60_000_000).max(239_995_000).multipleOf(5000),
  }),
  z.strictObject({ ...runBase, kind: z.literal('null'), replicate: replicate.max(14), family: z.enum(NULL_FAMILIES) }),
  z.strictObject({ ...runBase, kind: z.literal('discrepancy'), replicate: replicate.max(3), family: z.enum(discrepancyFamilies) }),
])
export type Scenario = z.infer<typeof scenarioSchema>

export function scenarioCell(scenario: Scenario): string {
  switch (scenario.kind) {
    case 'leak': return ['leak', scenario.openingSeconds, scenario.sizeM2, scenario.sensor, scenario.centerM, scenario.replicate].join('/')
    case 'null': return ['null', scenario.family, scenario.sensor, scenario.replicate].join('/')
    case 'discrepancy': return ['discrepancy', scenario.family, scenario.replicate].join('/')
  }
}

function pairedCell(scenario: Scenario): string | null {
  return scenario.kind === 'discrepancy' && scenario.family === 'D12'
    ? `D12/${Math.floor(scenario.replicate / 2)}`
    : null
}

function assertMatrix(scenarios: readonly Scenario[]): void {
  const cells = new Set<string>()
  const ids = new Set<string>()
  const seeds = new Map<string, string | null>()
  const pairs = new Map<string, string>()
  for (const scenario of scenarios) {
    const cell = scenarioCell(scenario)
    if (cells.has(cell) || ids.has(scenario.runId)) throw new Error('Duplicate matrix cell or run ID.')
    cells.add(cell)
    ids.add(scenario.runId)
    const pair = pairedCell(scenario)
    if (seeds.has(scenario.seedHash) && (!pair || seeds.get(scenario.seedHash) !== pair)) throw new Error('Reused seed commitment.')
    seeds.set(scenario.seedHash, pair)
    if (pair) {
      const previous = pairs.get(pair)
      if (previous && previous !== scenario.seedHash) throw new Error('D12 pair must share a seed commitment.')
      pairs.set(pair, scenario.seedHash)
    }
    if (scenario.kind === 'leak' && scenario.positionM !== scenario.centerM + (scenario.replicate === 0 ? -2.5 : 2.5)) {
      throw new Error('Leak truth does not use its predeclared off-grid location.')
    }
    if (scenario.kind === 'discrepancy' && scenario.sensor !== 'nominal') throw new Error('Discrepancy scenarios use the nominal layout.')
  }
  const counts = scenarios.reduce((result, scenario) => ({ ...result, [scenario.kind]: result[scenario.kind] + 1 }), { leak: 0, null: 0, discrepancy: 0 })
  if (counts.leak !== 120 || counts.null !== 240 || counts.discrepancy !== 48) throw new Error('Incomplete scenario matrix.')
}

export const splitSchema = z.strictObject({
  schemaVersion: z.literal(1), split: z.enum(['fit', 'calibration', 'development', 'blind']),
  saltCommitment: sha256Schema, generatorHash: sha256Schema,
  generator: z.enum(['synthetic-fit', 'independent-fvm']),
  scenarios: z.array(scenarioSchema).length(408),
}).superRefine((split, context) => {
  try {
    assertMatrix(split.scenarios)
    if (split.split === 'blind' && split.generator !== 'independent-fvm') throw new Error('Blind truth requires an independent FVM.')
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid scenario matrix.' })
  }
})
export type Split = z.infer<typeof splitSchema>

export function assertDisjointSplits(splits: readonly (readonly Pick<Scenario, 'runId' | 'seedHash' | 'parameterBlockHash'>[])[]): void {
  for (const [field, label] of [['runId', 'run ID'], ['seedHash', 'seed'], ['parameterBlockHash', 'parameter block']] as const) {
    const prior = new Set<string>()
    for (const split of splits) {
      const current = new Set(split.map((run) => run[field]))
      if (Array.from(current).some((value) => prior.has(value))) throw new Error(`Cross-split ${label} reuse.`)
      for (const value of current) prior.add(value)
    }
  }
}

export function deriveSeed(saltHex: string, family: string, cell: string, index: number, streamId: string): readonly [number, number, number, number] {
  if (!/^[a-f0-9]{32}$/.test(saltHex) || !Number.isSafeInteger(index) || index < 0
    || [family, cell, streamId].some((part) => part.length === 0 || part.includes('|'))) throw new Error('Invalid seed domain.')
  const digest = createHash('sha256').update(['pipetwin-oil-v1', saltHex, family, cell, index, streamId].join('|')).digest()
  const seed = [digest.readUInt32LE(0), digest.readUInt32LE(4), digest.readUInt32LE(8), digest.readUInt32LE(12)] as const
  return seed.every((word) => word === 0) ? [0, 0, 0, 1] : seed
}

const outcomes = ['healthy', 'withdrawal-compatible', 'boundary-compatible', 'sensor-compatible', 'ambiguous', 'unexplained', 'unavailable', 'invalid-domain'] as const
const region = z.tuple([position, position]).refine(([start, end]) => start < end)
const regionsSchema = z.array(region).max(200).refine((regions) => regions.every(([start], index) => index === 0 || start >= regions[index - 1]![1]))
export const runEvidenceSchema = z.strictObject({
  runId: id,
  availableUs: z.number().int().min(0).max(CHALLENGE_US),
  alarms: z.array(challengeTime).max(150),
  supports: z.array(z.strictObject({ timeUs: challengeTime, regions: regionsSchema })).max(150),
  jobs: z.array(z.strictObject({
    wallMs: z.number().nonnegative(), provisionalMs: z.number().nonnegative().nullable(),
    stopReason: z.enum(['complete', 'evaluation-limit', 'wall-limit', 'cancelled', 'invalid-model', 'insufficient-data', 'resource-limit']),
  }).refine((job) => job.provisionalMs === null || job.provisionalMs <= job.wallMs)).max(350),
  outcome: z.enum(outcomes),
  activeProposals: z.number().int().min(0).max(350),
  activeAccepts: z.number().int().min(0).max(1),
  structuralClaim: z.boolean(),
}).refine((run) => {
  const ordered = (times: number[]) => times.every((time, index) => index === 0 || time > times[index - 1]!)
  return ordered(run.alarms) && ordered(run.supports.map((support) => support.timeUs))
    && run.activeAccepts <= run.activeProposals
    && (run.availableUs > 0 || (run.alarms.length === 0 && run.supports.length === 0))
}, { message: 'Invalid observation, episode, or action accounting.' })
export type RunEvidence = z.infer<typeof runEvidenceSchema>

export const refsSchema = z.strictObject({ path: z.string().min(1).max(1024), sha256: sha256Schema })
export type EvidenceRef = z.infer<typeof refsSchema>
export const evidenceSchema = z.strictObject({
  schemaVersion: z.literal(1), splitHash: sha256Schema, policyHash: sha256Schema, profileHash: sha256Schema,
  scheduleHash: sha256Schema, traceHash: sha256Schema, browserBuild: z.string().min(1).max(120),
  runs: z.array(runEvidenceSchema).length(408),
})
export type Evidence = z.infer<typeof evidenceSchema>

export function assertEvidenceCoverage(scenarios: readonly Scenario[], evidence: readonly RunEvidence[]): void {
  const ids = new Set(evidence.map((run) => run.runId))
  if (ids.size !== evidence.length || scenarios.length !== evidence.length || scenarios.some(({ runId }) => !ids.has(runId))) {
    throw new Error('Whole-run evidence must include every declared run exactly once.')
  }
}
