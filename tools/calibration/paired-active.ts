import { z } from 'zod'
import { CHALLENGE_HORIZON_US, CHALLENGE_WARMUP_US } from '../../src/contracts/model'
import { scenarioCell } from './contracts'
import type { RunEvidence, Scenario } from './contracts'
import { leakEvaluation } from './metrics'

const actionClock = z.number().int().min(CHALLENGE_WARMUP_US).max(CHALLENGE_HORIZON_US)
const actionBase = { runId: z.string().min(1).max(96).regex(/^[a-zA-Z0-9_-]+$/) }
const EXPERIMENT_DURATION_US = 4_000_000
const appliedTime = actionClock.min(CHALLENGE_WARMUP_US + 5000)
  .max(CHALLENGE_HORIZON_US - EXPERIMENT_DURATION_US).multipleOf(5000)
export const activeActionSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...actionBase, status: z.literal('no-opportunity') }),
  z.strictObject({ ...actionBase, status: z.literal('refused'), reason: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }),
  z.strictObject({ ...actionBase, status: z.literal('unaccepted') }),
  z.strictObject({ ...actionBase, status: z.literal('completed'), appliedTimeUs: appliedTime, terminalTimeUs: actionClock }),
  z.strictObject({ ...actionBase, status: z.literal('aborted'), appliedTimeUs: appliedTime.nullable(), terminalTimeUs: actionClock }),
]).refine((action) => {
  if (action.status === 'completed') return action.terminalTimeUs === action.appliedTimeUs + EXPERIMENT_DURATION_US
  if (action.status !== 'aborted' || action.appliedTimeUs === null) return true
  return action.terminalTimeUs >= action.appliedTimeUs && action.terminalTimeUs < action.appliedTimeUs + EXPERIMENT_DURATION_US
}, { message: 'Invalid pulse or post-observation time.' })

type Action = z.infer<typeof activeActionSchema>

function byRunId<T extends { readonly runId: string }>(scenarios: readonly Scenario[], rows: readonly T[]) {
  const lookup = new Map(rows.map((row) => [row.runId, row]))
  if (lookup.size !== rows.length || lookup.size !== scenarios.length || scenarios.some(({ runId }) => !lookup.has(runId))) {
    throw new Error('Paired evidence must include every declared run exactly once in each arm and action log.')
  }
  return lookup
}

function assertActionAccounting(run: RunEvidence, action: Action): void {
  const { activeAccepts, activeProposals } = run
  const valid = activeAccepts <= activeProposals && (
    action.status === 'completed' || action.status === 'aborted'
      ? activeAccepts === 1
      : activeAccepts === 0 && (action.status === 'refused'
        || (action.status === 'no-opportunity' ? activeProposals === 0 : activeProposals > 0))
  )
  if (!valid) throw new Error(`Inconsistent active action accounting for ${run.runId}.`)
}

function pairedCounts(rows: readonly (readonly [boolean, boolean])[]) {
  return {
    activeOnly: rows.filter(([active, passive]) => active && !passive).length,
    passiveOnly: rows.filter(([active, passive]) => !active && passive).length,
    both: rows.filter(([active, passive]) => active && passive).length,
    neither: rows.filter(([active, passive]) => !active && !passive).length,
  }
}

function armSummary(run: RunEvidence) {
  const { availableUs, alarms, supports, outcome, activeProposals, activeAccepts, structuralClaim } = run
  return { availableUs, alarms, supports, outcome, activeProposals, activeAccepts, structuralClaim }
}

function pairedRows(
  scenarios: readonly Scenario[], activeRuns: readonly RunEvidence[], passiveRuns: readonly RunEvidence[], actions: readonly Action[],
) {
  if (new Set(scenarios.map(({ runId }) => runId)).size !== scenarios.length) throw new Error('Duplicate scenario run ID.')
  const activeById = byRunId(scenarios, activeRuns)
  const passiveById = byRunId(scenarios, passiveRuns)
  const actionById = byRunId(scenarios, actions)
  return scenarios.map((scenario) => {
    const { runId } = scenario
    const active = activeById.get(runId)!
    const passive = passiveById.get(runId)!
    if (passive.activeProposals !== 0 || passive.activeAccepts !== 0) throw new Error(`Passive run ${runId} contains active actions.`)
    const action = activeActionSchema.parse(actionById.get(runId))
    assertActionAccounting(active, action)
    return {
      scenario, action, active, passive,
      leak: scenario.kind === 'leak' ? {
        active: leakEvaluation(scenario, active), passive: leakEvaluation(scenario, passive),
      } : null,
    }
  })
}

export function summarizeActivePairs(
  scenarios: readonly Scenario[], activeRuns: readonly RunEvidence[], passiveRuns: readonly RunEvidence[], actions: readonly Action[],
) {
  const rows = pairedRows(scenarios, activeRuns, passiveRuns, actions)
  const noneOfModels = rows.filter(({ scenario }) => scenario.kind === 'discrepancy' && scenario.family === 'D11')
  const leaks = rows.flatMap(({ leak }) => leak ? [leak] : [])
  const refusals = rows.flatMap(({ action }) => action.status === 'refused' ? [action.reason] : [])
  const statuses = ['no-opportunity', 'refused', 'unaccepted', 'completed', 'aborted'] as const satisfies readonly Action['status'][]
  const timely = (delayUs: number | null) => delayUs !== null && delayUs <= 30_000_000
  return {
    pairs: rows.map(({ scenario, action, active, passive, leak }) => ({
      runId: scenario.runId, cell: scenarioCell(scenario), action, active: armSummary(active), passive: armSummary(passive), leak,
    })),
    leak: {
      timelySupport: pairedCounts(leaks.map(({ active, passive }) => [timely(active.delayUs), timely(passive.delayUs)])),
      timelyCovered: pairedCounts(leaks.map(({ active, passive }) => [active.covered, passive.covered])),
    },
    actionCounts: Object.fromEntries(statuses.map((status) => [status, rows.filter(({ action }) => action.status === status).length])),
    refusalReasons: [...new Set(refusals)].sort().map((reason) => ({ reason, runs: refusals.filter((entry) => entry === reason).length })),
    noneOfModels: {
      runs: noneOfModels.length,
      falseSupport: pairedCounts(noneOfModels.map(({ active, passive }) => [active.supports.length > 0, passive.supports.length > 0])),
      structuralClaim: pairedCounts(noneOfModels.map(({ active, passive }) => [active.structuralClaim, passive.structuralClaim])),
      activeProposals: noneOfModels.reduce((sum, { active }) => sum + active.activeProposals, 0),
      activeAccepts: noneOfModels.reduce((sum, { active }) => sum + active.activeAccepts, 0),
    },
  }
}
