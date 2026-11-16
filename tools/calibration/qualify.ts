import { z } from 'zod'
import { SENSOR_LAYOUTS, assertDisjointSplits, assertEvidenceCoverage, refsSchema, splitSchema } from './contracts'
import type { Scenario, Split } from './contracts'
import { readEvidence, verifyEvidenceDigest } from './io'
import { qualificationEvidenceSchema } from './manifests'
import { summarizeRuns } from './metrics'

type Sensor = (typeof SENSOR_LAYOUTS)[number]
export type SelectedEvidenceRefs = {
  readonly summary: z.infer<typeof refsSchema>
  readonly browserSchedule: z.infer<typeof refsSchema>
  readonly policyTrace: z.infer<typeof refsSchema>
}
export type SplitRefs = {
  readonly fit: z.infer<typeof refsSchema>
  readonly calibration: z.infer<typeof refsSchema>
  readonly development: z.infer<typeof refsSchema>
  readonly blindCommitment: string
}

export function layoutFromId(id: string): Sensor {
  switch (id) {
    case 'synthetic-oil-nominal-v1': return 'nominal'
    case 'synthetic-oil-adverse-v1': return 'adverse'
    default: throw new Error('Unsupported calibration sensor layout.')
  }
}

export function relevantScenarios(scenarios: readonly Scenario[], sensor: Sensor): Scenario[] {
  return scenarios.filter((scenario) => scenario.sensor === sensor)
}

export function assertRunOrder(scenarios: readonly Scenario[], actualIds: readonly string[]): void {
  if (scenarios.length !== actualIds.length || scenarios.some(({ runId }, index) => runId !== actualIds[index])) {
    throw new Error('Evidence run IDs must match the declared matrix order.')
  }
}

export function assertDistinctSalts(splits: readonly Split[]): void {
  if (new Set(splits.map((split) => split.saltCommitment)).size !== splits.length) throw new Error('Split salt commitments must be independent.')
}

export async function loadPublicSplits(base: string, refs: SplitRefs) {
  const roles = ['fit', 'calibration', 'development'] as const
  const [fit, calibration, development] = await Promise.all(roles.map(async (role) => {
    const split = await readEvidence(base, refs[role], splitSchema)
    if (split.split !== role) throw new Error(`Expected ${role} split, received ${split.split}.`)
    return split
  }))
  if (!fit || !calibration || !development) throw new Error('Missing split.')
  const splits = [fit, calibration, development]
  assertDistinctSalts(splits)
  assertDisjointSplits(splits.map((split) => split.scenarios))
  if (roles.some((role) => refs[role].sha256 === refs.blindCommitment)) throw new Error('Blind commitment reuses an open split digest.')
  return { fit, calibration, development }
}

interface ExpectedEvidence {
  readonly splitHash: string
  readonly profileHash: string
  readonly policyHash: string
  readonly selectionHash: string
  readonly releaseScope: 'passive' | 'full'
  readonly sensor: Sensor
  readonly arm?: 'active' | 'passive'
}

export async function loadPolicyEvidence(base: string, refs: SelectedEvidenceRefs, split: Split, expected: ExpectedEvidence) {
  const schema = expected.arm === undefined ? qualificationEvidenceSchema
    : qualificationEvidenceSchema.extend({ arm: z.literal(expected.arm) })
  const summary = await readEvidence(base, refs.summary, schema)
  if (summary.splitHash !== expected.splitHash || summary.profileHash !== expected.profileHash
    || summary.policyHash !== expected.policyHash || summary.selectionHash !== expected.selectionHash
    || summary.scheduleHash !== refs.browserSchedule.sha256 || summary.traceHash !== refs.policyTrace.sha256) {
    throw new Error(`Paced browser evidence does not bind to the frozen policy or ${split.split} split.`)
  }
  assertEvidenceCoverage(relevantScenarios(split.scenarios, expected.sensor), summary.runs)
  if (expected.releaseScope === 'passive' && summary.runs.some((run) => run.activeProposals > 0 || run.activeAccepts > 0)) {
    throw new Error('Passive evidence contains active actions.')
  }
  await Promise.all([verifyEvidenceDigest(base, refs.browserSchedule), verifyEvidenceDigest(base, refs.policyTrace)])
  return summary
}

export function reportByLayout(split: Split, summary: z.infer<typeof qualificationEvidenceSchema>, sensor: Sensor) {
  const scenarios = relevantScenarios(split.scenarios, sensor)
  const ids = new Set(scenarios.map(({ runId }) => runId))
  return summarizeRuns(scenarios, summary.runs.filter(({ runId }) => ids.has(runId)), sensor)
}
