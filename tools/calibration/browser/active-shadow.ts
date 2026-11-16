import type { DiagnosticResult } from '../../../src/contracts/inference'
import { MAX_AUDITED_JOBS } from '../../../src/contracts/inference-audit'
import { FLOW_PERIOD_US } from '../../../src/contracts/public'
import type { SensorId } from '../../../src/contracts/public'

export interface ActiveShadowContext {
  readonly timeUs: number
  readonly horizonUs: number
  readonly controlRevision: number
  readonly sensorCohortUs: number | null
  readonly pressureLastValidUs: readonly (number | null)[]
  readonly lastFlowUs: number | null
}

const PRESSURE_IDS = ['P1', 'P2', 'P3'] as const
const COMMAND_TICK_US = 5_000
const EXPERIMENT_DURATION_US = 4_000_000
const MAX_EVIDENCE_AGE_US = 5_000_000

function availableSensors({ timeUs, sensorCohortUs, pressureLastValidUs, lastFlowUs }: ActiveShadowContext): readonly SensorId[] {
  if (sensorCohortUs === null || sensorCohortUs < 0 || sensorCohortUs > timeUs) return []
  const pressure = PRESSURE_IDS.filter((_, index) => pressureLastValidUs[index] === sensorCohortUs)
  const flowAvailable = lastFlowUs !== null && lastFlowUs <= sensorCohortUs && sensorCohortUs - lastFlowUs <= 2 * FLOW_PERIOD_US
  return flowAvailable ? [...pressure, 'Qin'] : pressure
}

function hasCausalAmbiguity(result: DiagnosticResult): boolean {
  const causes = result.hypotheses.flatMap(({ model, completed, support }) =>
    model !== 'M0' && completed && support === 'compatible' ? [model === 'MD' ? 'ML' : model] : [])
  return new Set(causes).size >= 2
}

function shadowRow(result: DiagnosticResult, context: ActiveShadowContext) {
  const { jobId, observedThroughUs, finishedAtUs, controlRevision } = result
  const { timeUs, horizonUs, sensorCohortUs } = context
  const sensors = availableSensors(context)
  const nextStartUs = (Math.floor(timeUs / COMMAND_TICK_US) + 1) * COMMAND_TICK_US
  const unresolvedRegion = result.compatibleRegions.some(({ status }) => status === 'unresolved')
  const unresolvedHypothesis = result.hypotheses.some(({ support }) => support === 'unresolved')
  const unresolvedCause = result.hypotheses.some(({ model, support }) => model !== 'M0' && support === 'unresolved')
  const stale = observedThroughUs > timeUs || timeUs - observedThroughUs > MAX_EVIDENCE_AGE_US
    || controlRevision !== context.controlRevision
  const blockers = [
    !result.searchComplete && 'incomplete-search',
    stale && 'stale-result',
    sensors.length < 4 && 'sensor-unavailable',
    nextStartUs + EXPERIMENT_DURATION_US > horizonUs && 'insufficient-horizon',
    result.fitQuality === 'poor' && 'model-fit-poor',
    result.fitQuality === 'unqualified' && 'unqualified-fit',
    unresolvedRegion && 'unresolved-region',
    unresolvedHypothesis && 'unresolved-hypothesis',
    !hasCausalAmbiguity(result) && (unresolvedCause ? 'causal-ambiguity-unassessable' : 'no-causal-ambiguity'),
  ].filter((value): value is string => value !== false)
  return {
    jobId, observedThroughUs, finishedAtUs, controlRevision, sensorCohortUs, availableSensors: sensors,
    blockers: blockers.length > 0 ? blockers : ['candidate-evidence-unavailable'],
  }
}

export function createActiveShadowTrace() {
  let rows: readonly ReturnType<typeof shadowRow>[] = []
  return {
    observe(result: DiagnosticResult, context: ActiveShadowContext) {
      if (rows.length < MAX_AUDITED_JOBS && !rows.some(({ jobId }) => jobId === result.jobId)) {
        rows = [...rows, shadowRow(result, context)]
      }
    },
    terminal: () => ({ kind: 'committed-diagnosis-shadow' as const, activeAttemptEvaluated: false as const, rows }),
  }
}
