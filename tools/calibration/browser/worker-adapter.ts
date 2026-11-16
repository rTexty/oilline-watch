import type { Calibration } from '../../../src/contracts/calibration'
import type { DiagnosticJob, DiagnosticResult } from '../../../src/contracts/inference'
import type { InferenceAuditJob, InferenceAuditTransition, InverseProvisionalAudit, WarmupReplay } from '../../../src/contracts/inference-audit'
import type { FluidProfile } from '../../../src/contracts/model'
import { PhysicsDomainError } from '../../../src/physics/guards'
import { RANDOM_VERSION } from '../../../src/plant/random'
import { paceTarget } from '../../../src/runtime/clock'
import { appendNominalPredictions, emptyNominalPredictionHistory } from '../../../src/runtime/nominal-prediction-history'
import { replaySchema } from '../../../src/runtime/replay-schema'
import type { ReplayEvent } from '../../../src/runtime/replay-schema'
import type { RunSnapshot } from '../../../src/runtime/vertical-protocol'
import type { ScenarioRecipe } from '../generate-scenarios'
import { prepareValidationScenario, validateScenarioTarget } from '../scenario-setup'
import type { ValidationClosure } from '../scenario-setup'
import { createActiveShadowTrace } from './active-shadow'
import type { ActiveShadowContext } from './active-shadow'
import { createPacedDetectorTrace } from './detector-trace'
import type { DetectorObservation } from './detector-trace'
import { collectPacedFitEvidence } from './fit-evidence'
import type { PacedFailure } from './pilot-status'
import type { PacedFinalPublication, PacedProvisionalPublication } from './provisional-timing'

export interface PacedScenarioInput {
  readonly profile: FluidProfile
  readonly recipe: ScenarioRecipe
  readonly closure: ValidationClosure
  readonly targetUs: number
}

export function preparePacedEngine(input: PacedScenarioInput) {
  validateScenarioTarget(input.profile, input.targetUs)
  const prepared = prepareValidationScenario(input.profile, input.recipe, input.closure)
  if (prepared.status !== 'ready') throw new PhysicsDomainError('unsupported-physics', 'Scenario is unsupported by the validation adapter.')
  const journal: ReplayEvent[] = prepared.publicBoundaries
    .filter((event) => event.channel === 'outlet-flow')
    .map((event) => ({ kind: 'control', timeUs: event.timeUs, outletFlowM3s: event.targetSI }))
  const { engine } = prepared
  const replayable = journal.length > 0
    && prepared.publicBoundaries.every((event) => event.channel === 'outlet-flow' && event.rampUs === 0)
    && replaySchema.safeParse({
      schemaVersion: 1, profileId: engine.profile.profileId, modelVersion: engine.profile.modelVersion,
      randomVersion: RANDOM_VERSION, seed: engine.seed, endedAtUs: engine.profile.horizonUs, events: journal,
    }).success
  // The browser adapter supplies the public control journal that the generic validation engine lacks.
  const nominalPredictions = replayable && engine.latestBatch && engine.nominalPredictions === null
    ? appendNominalPredictions(emptyNominalPredictionHistory(engine.profile.profileId), engine.latestBatch, engine.bank, [])
    : engine.nominalPredictions
  return { targetUs: input.targetUs, engine: { ...engine, journal, controlCount: journal.length, nominalPredictions } }
}

let setup: ReturnType<typeof preparePacedEngine> | undefined
let validationPort: MessagePort | undefined
let failure: PacedFailure | null = null
type DictionaryStatus = 'not-requested' | 'waiting' | 'ready' | 'unavailable'
let dictionaryStatus: DictionaryStatus = 'not-requested'
const admittedWallMs = new Map<string, number>()
const roundTripWallMs = new Map<string, number>()
const fitEvidenceByJob = new Map<string, ReturnType<typeof collectPacedFitEvidence>>()
const publishedProvisionalJobs = new Set<string>()
const detectorTrace = createPacedDetectorTrace()
let calibrationRequested = false
let activeShadow: ReturnType<typeof createActiveShadowTrace> | undefined

export function validationSetup() {
  return setup
}

export function consumeValidationEngine() {
  const engine = setup?.engine
  setup = undefined
  return engine
}

export function acceptValidationBootstrap(
  event: Pick<MessageEvent<unknown>, 'data'>, scope: { postMessage(message: unknown): void }, withActiveShadow = false,
): boolean {
  const { data } = event
  if (typeof data !== 'object' || data === null || !('kind' in data) || data.kind !== 'validation-bootstrap') return false
  if (validationPort || !('port' in data) || !(data.port instanceof MessagePort)) {
    scope.postMessage({ kind: 'validation-bootstrap-error', failure: 'transport-error' })
    return true
  }
  const port = data.port
  validationPort = port
  activeShadow = withActiveShadow ? createActiveShadowTrace() : undefined
  port.onmessage = (message: MessageEvent<PacedScenarioInput>) => {
    port.onmessage = null
    try {
      setup = preparePacedEngine(message.data)
      port.postMessage({ kind: 'validation-ready' })
    } catch (error) {
      port.postMessage({ kind: 'validation-bootstrap-error', failure: sanitizedFailure(error) })
      port.close()
    }
  }
  return true
}

export function observeValidationJob(event: 'admitted' | 'finished', jobId: string, now = performance.now()): void {
  if (!validationPort) return
  if (event === 'admitted') {
    admittedWallMs.set(jobId, now)
    validationPort.postMessage({ kind: 'validation-job-admitted', jobId, admittedEpochMs: performance.timeOrigin + now })
    return
  }
  const began = admittedWallMs.get(jobId)
  if (began === undefined) return
  admittedWallMs.delete(jobId)
  roundTripWallMs.set(jobId, now - began)
}

export function reportValidationFinal(record: InferenceAuditJob, job: DiagnosticJob, calibration?: Calibration | null): void {
  if (!validationPort) return
  const { jobId, closure } = record
  const publication: PacedFinalPublication = {
    jobId, submittedEpochMs: performance.timeOrigin + performance.now(), finalDisposition: closure ?? 'committed',
  }
  validationPort.postMessage({ kind: 'validation-terminal-result', ...publication })
  fitEvidenceByJob.set(jobId, collectPacedFitEvidence(job, record, calibration ?? undefined))
}

function sanitizedFailure(error: unknown): PacedFailure {
  return error instanceof PhysicsDomainError ? error.code : 'worker-error'
}

export function observeValidationFailure(error: unknown): void {
  failure = sanitizedFailure(error)
}

export function observeValidationDictionary(status: Exclude<DictionaryStatus, 'not-requested'>): void {
  dictionaryStatus = status
}

export function observeValidationCalibrationRequest(requested: boolean): void {
  calibrationRequested = requested
}

export function observeValidationDetector(state: DetectorObservation, publishedAtUs: number): void {
  detectorTrace.observe(state, publishedAtUs)
}

export function observeValidationActiveOpportunity(result: DiagnosticResult, context: ActiveShadowContext): void {
  activeShadow?.observe(result, context)
}

interface Progress {
  readonly snapshot: RunSnapshot
  readonly provisional: InverseProvisionalAudit | null
  readonly submittedWallMs: number
  readonly horizonUs: number
  readonly originWallMs: number
  readonly originTimeUs: number
  readonly pace: number
  readonly activeJob: { readonly jobId: string } | null
  readonly audit: readonly InferenceAuditJob[]
  readonly auditTransitions: readonly InferenceAuditTransition[]
  readonly closureEvidenceMissing: boolean
  readonly publicControlRevision: number
  readonly warmup: WarmupReplay | null
  readonly resourceLimited: boolean
  readonly detectorConfigured: boolean
}

export function validationProgress(progress: Progress) {
  const { snapshot, horizonUs, originWallMs, originTimeUs, pace, activeJob, audit, auditTransitions,
    closureEvidenceMissing, publicControlRevision, warmup, resourceLimited, detectorConfigured } = progress
  const now = performance.now()
  const expectedUs = Math.min(horizonUs, paceTarget(originTimeUs, originWallMs, now, pace))
  const counts = { requested: 0, admitted: 0, superseded: 0, finished: 0, committed: 0, cancelled: 0 }
  const windows = { short: 0, long: 0 }
  for (const transition of auditTransitions) {
    const [event] = transition
    if (Object.hasOwn(counts, event)) counts[event as keyof typeof counts]++
    if (event === 'requested') {
      const duration = transition[2] - transition[3]
      if (duration === 4_000_000) windows.short++
      if (duration === 30_000_000) windows.long++
    }
  }
  const terminal = snapshot.phase === 'completed' || snapshot.phase === 'invalid' || snapshot.phase === 'error'
  return {
    kind: 'validation-progress' as const, phase: snapshot.phase, timeUs: snapshot.timeUs,
    failure, closureEvidenceMissing, publicControlRevision, dictionaryStatus,
    simulationNumericalMemory: snapshot.numericalMemory ?? null,
    inferenceNumericalMemory: snapshot.inferenceNumericalMemory ?? null,
    elapsedMs: originWallMs === 0 ? null : now - originWallMs, lagMs: Math.max(0, expectedUs - snapshot.timeUs) / 1000,
    residualTimeUs: snapshot.residualTimeUs, alarmAtUs: snapshot.diagnostic?.alarmAtUs ?? null,
    quantitativePath: snapshot.diagnostic?.qualified ?? false, originTimeUs, activeJob: activeJob !== null, counts, windows,
    timeline: terminal ? auditTransitions : [],
    policyAudit: terminal ? { jobs: audit, warmup, resourceLimited } : null,
    fitEvidence: terminal ? [...fitEvidenceByJob.values()] : [],
    detectorTrace: terminal ? detectorTrace.terminal({
      timeUs: snapshot.timeUs, phase: snapshot.phase, requested: calibrationRequested, configured: detectorConfigured,
    }) : null,
    ...(terminal && activeShadow ? { activeShadow: activeShadow.terminal() } : {}),
    budgets: (terminal ? audit : []).map(({ jobId, evaluationLimit, wallLimitMs, completedEvaluations, stopReason, startUs, endUs, startedAtUs, finishedAtUs, closure, decisionReplay }) =>
      ({ jobId, evaluationLimit, wallLimitMs, completedEvaluations, nominalCacheHits: decisionReplay?.nominalCacheHits ?? 0, stopReason, windowUs: endUs - startUs,
        modelElapsedUs: finishedAtUs - startedAtUs, wallRoundTripMs: roundTripWallMs.get(jobId) ?? null, closure: closure ?? null })),
  }
}

export function reportValidationProgress(progress: Progress): void {
  if (!validationPort) return
  const { snapshot, provisional, submittedWallMs } = progress
  if (provisional) {
    const { jobId } = provisional.result
    if (snapshot.diagnostic?.provisional?.jobId === jobId && !publishedProvisionalJobs.has(jobId)) {
      const publication: PacedProvisionalPublication = {
        jobId, publishedAtUs: provisional.publishedAtUs, submittedEpochMs: performance.timeOrigin + submittedWallMs,
      }
      validationPort.postMessage({ kind: 'validation-provisional-publication', ...publication })
      publishedProvisionalJobs.add(jobId)
    }
  }
  validationPort.postMessage(validationProgress(progress))
}

export type PacedProgress = ReturnType<typeof validationProgress>
