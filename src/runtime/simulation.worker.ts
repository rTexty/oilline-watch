import { profileSchema } from '../contracts/model'
import type { AnchorId, FluidProfile, ProfileId } from '../contracts/model'
import type { DiagnosticJob, DiagnosticResult } from '../contracts/inference'
import { inferenceAuditJobSchema, MAX_AUDITED_JOBS, MAX_AUDITED_TRIALS, MAX_AUDIT_TRANSITIONS } from '../contracts/inference-audit'
import type { InferenceAuditJob, InferenceAuditTransition, InverseProvisionalAudit } from '../contracts/inference-audit'
import { MAX_NOMINAL_PREDICTION_CACHE_BYTES } from '../contracts/nominal-predictions'
import { PRESSURE_PERIOD_US } from '../contracts/public'
import type { PublicBatch } from '../contracts/public'
import { advanceDetector, createDetector } from '../detection/detector'
import type { DetectorState } from '../detection/detector'
import { advanceTo } from '../physics/advance-to'
import { initialize } from '../physics/initialize'
import type { HydraulicState } from '../physics/state'
import { advanceThermal, initializeThermal } from '../physics/thermal'
import type { ThermalState } from '../physics/thermal'
import laminarProfile from '../scenarios/synthetic-oil-laminar-v1.json'
import thermalProfile from '../scenarios/synthetic-oil-thermal-v1.json'
import turbulentProfile from '../scenarios/synthetic-oil-turbulent-v1.json'
import { predict } from '../twin/predict'
import { createCheckpointAnchor } from '../twin/checkpoint'
import type { CheckpointAnchor } from '../twin/checkpoint'
import { nextBoundary, paceTarget } from './clock'
import { buildDiagnosticJob, canCommitResult } from './diagnostic-jobs'
import { trustedCalibration } from './diagnostic-release'
import { advanceEngine, createEngine, EngineExperimentDomainError, scheduleLeak, scheduleOutlet, scheduleSensorFault } from './engine'
import type { Engine } from './engine'
import { inferenceMessageSchema } from './inference-port'
import { admitWindows, initialInferenceSchedule, preservePendingWindow } from './inference-schedule'
import type { DiagnosticWindow } from './inference-schedule'
import { freezeWindow } from './history'
import { createNumericalMemoryLedger } from './numerical-memory'
import { MAX_NOMINAL_HISTORY_BYTES, NOMINAL_HISTORY_SECOND_BYTES } from './nominal-prediction-history'
import { publicControls } from './public-controls'
import { engineFromReplay, recordReplay } from './replay'
import type { ReplayRecord } from './replay-schema'
import { emptyReplayQueue, verifyReplayQueue } from './replay-queue'
import { commitReplayJob, createReplayTimeline, markReplayDispatched, markReplayVerified, replayActions } from './replay-timeline'
import type { ReplayTimeline } from './replay-timeline'
import { complete, emptySchedule, offer } from './scheduler'
import { createSimulationMemory } from './simulation-memory'
import { diagnosticSummary, matchesReplayResponse, matchesReplayWarmup } from './simulation-diagnostics'
import { commandSchema } from './vertical-protocol'
import type { Command, RunSnapshot } from './vertical-protocol'
import { configuredWasmDeployment, resolveSimulationBackend, TYPESCRIPT_SIMULATION_BACKEND } from './wasm-runtime'
import type { SimulationBackend } from './wasm-runtime'

const worker = self as DedicatedWorkerGlobalScope
const profiles: Partial<Record<ProfileId, unknown>> = {
  'synthetic-oil-turbulent-v1': turbulentProfile,
  'synthetic-oil-laminar-v1': laminarProfile,
  'synthetic-oil-thermal-v1': thermalProfile,
}

let runId: string | undefined
let profile: FluidProfile
let engine: Engine | null = null
let thermal: ThermalState | null = null
let laminar: HydraulicState | null = null
let port: MessagePort
let phase: RunSnapshot['phase'] = 'warming-up'
let revealed = false
let replaying = false
let horizonUs = 0
let replay: ReplayRecord | null = null
let message: string | null = null
let residualPa: RunSnapshot['residualPa'] = []
let residualTimeUs = -1
let appliedTimeUs: number | null = null
let leakRejected = false
let incomingSeq = -1
let outgoingSeq = 0
let pace = 1
let originWallMs = 0
let originTimeUs = 0
let lastPublishMs = -Infinity
let timer: ReturnType<typeof setTimeout> | undefined
let inferenceTimeout: ReturnType<typeof setTimeout> | undefined
let inverseTimeout: ReturnType<typeof setTimeout> | undefined
let schedule = emptySchedule<PublicBatch>()
let detector: DetectorState | null = null
let anchors: readonly CheckpointAnchor[] = []
let windowSchedule = initialInferenceSchedule()
let activeJob: DiagnosticJob | null = null
let pendingJob: { readonly job: DiagnosticJob; readonly window: DiagnosticWindow } | null = null
let diagnosis: DiagnosticResult | null = null
let provisional: InverseProvisionalAudit | null = null
let startedAtUs = 0
let audit: readonly InferenceAuditJob[] = []
let auditTransitions: readonly InferenceAuditTransition[] = []
let auditedTrials = 0
let auditFull = false
let closureEvidenceMissing = false
let unverifiedProvisional: InverseProvisionalAudit | undefined
let revealOnClosure = false
let terminalDomainMessage: string | undefined
let importedAudit: ReplayRecord['inferenceAudit']
let replayVerification: RunSnapshot['replayVerification']
let replayTimeline: ReplayTimeline | null = null
let replayQueue = emptyReplayQueue
let replayEvidence: ReadonlyMap<string, DiagnosticJob> = new Map()
let replayDecision: DiagnosticResult | null = null
let replayProvisional: InverseProvisionalAudit | null = null
let warmupChecked = false
let initializing = false
let awaitingDictionary = false
let auditBytes = 0
let inferenceNumericalMemory: RunSnapshot['inferenceNumericalMemory']
let replayAbortMessage: string | undefined
let replayAbortBatch: PublicBatch | undefined
const MAX_AUDIT_BYTES = 24 * 1024 * 1024
const MAX_JOB_BYTES = 192 * 1024
// The largest supported startup allocation is a 401-node laminar ring (800 samples),
// plus hydraulic arrays and coefficient buffers. WASM linear memory is reserved separately.
const BOOTSTRAP_WORKSPACE_BYTES = 5 * 1024 * 1024
const NOMINAL_WORKSPACE_BYTES = MAX_NOMINAL_HISTORY_BYTES + NOMINAL_HISTORY_SECOND_BYTES + 3 * MAX_NOMINAL_PREDICTION_CACHE_BYTES
const numericalMemory = createNumericalMemoryLedger('simulation')
const simulationMemory = createSimulationMemory(numericalMemory)

const timeUs = () => engine?.timeUs ?? laminar?.timeUs ?? thermal?.timeUs ?? 0

function publish(): void {
  if (!runId) return
  const state = engine?.plant ?? laminar ?? thermal
  const last = state ? state.tOil.length - 1 : 0
  const nominal = engine?.latestBatch?.predictions[0] ?? (laminar ? predict(laminar, 0) : null)
  const snapshot: RunSnapshot = {
    profileId: profile.profileId,
    phase,
    timeUs: timeUs(),
    armedAtUs: engine && timeUs() >= profile.warmupUs && (!detector?.calibration || detector.warmupFit) ? profile.warmupUs : null,
    samples: engine?.samples ?? [],
    prediction: nominal ? [...nominal.pressurePa, nominal.inletFlowM3s] : [],
    residualPa,
    residualTimeUs: residualTimeUs >= 0 ? residualTimeUs : null,
    temperatures: {
      oilInK: state?.tOil[0] ?? profile.thermal.initialOilTemperatureK,
      oilOutK: state?.tOil[last] ?? profile.thermal.initialOilTemperatureK,
      wallOutK: state?.tWall[last] ?? profile.thermal.initialWallTemperatureK,
    },
    message, appliedTimeUs: appliedTimeUs !== null && timeUs() >= appliedTimeUs ? appliedTimeUs : null,
    leakStatus: !replaying && engine?.truth
      ? engine.truth.timeUs <= timeUs() ? 'applied' : 'pending'
      : leakRejected ? 'rejected' : 'idle',
    diagnostic: diagnosticSummary({ engine, detector, warmupUs: profile.warmupUs, awaitingDictionary, auditFull, residualPa, diagnosis, provisional }),
    numericalMemory: numericalMemory.snapshot(),
    inferenceNumericalMemory,
    truth: revealed && engine?.truth && engine.truth.timeUs <= timeUs() ? engine.truth : null,
    replay,
    replaying,
    replayVerification,
  }
  worker.postMessage({ schemaVersion: 1, runId, seq: outgoingSeq++, snapshot })
  leakRejected = false
  lastPublishMs = performance.now()
}

function stop(nextPhase: RunSnapshot['phase']): void {
  clearTimeout(timer)
  timer = undefined
  phase = nextPhase
  if (nextPhase !== 'paused') {
    clearTimeout(inferenceTimeout)
    clearTimeout(inverseTimeout)
    schedule = emptySchedule()
    if (activeJob) {
      if (audit.at(-1)?.jobId !== activeJob.jobId) {
        closureEvidenceMissing = true
        unverifiedProvisional = provisional ?? undefined
      }
      auditTransitions = [...auditTransitions, ['cancelled', activeJob.jobId, timeUs()]]
    }
    if (pendingJob) auditTransitions = [...auditTransitions, ['cancelled', pendingJob.job.jobId, timeUs()]]
    if (activeJob || replayTimeline?.stage === 'dispatched') port.postMessage({ schemaVersion: 1, runId, kind: 'cancel-inverse' })
    activeJob = null
    pendingJob = null
    provisional = null
    replayEvidence = new Map()
    replayDecision = null
    replayProvisional = null
    engine?.backend.releaseMemory?.()
    port.close()
  }
}

function failInference(): void {
  if (phase === 'finalizing') {
    finishMissingClosure()
    return
  }
  initializing = false
  awaitingDictionary = false
  stop('error')
  message = 'Диагностический процесс недоступен.'
  publish()
}

function useQualitativeDiagnostics(reason = 'Словарь откликов недоступен. Продолжен расчёт с качественной диагностикой.'): void {
  if (phase === 'finalizing') {
    finishMissingClosure()
    return
  }
  clearTimeout(inverseTimeout)
  activeJob = null
  pendingJob = null
  diagnosis = null
  provisional = null
  detector = createDetector(profile, null)
  replayTimeline = null
  replayEvidence = new Map()
  replayDecision = null
  replayProvisional = null
  if (importedAudit) replayVerification = 'simulation-only'
  message = reason
  if (phase === 'replay-wait') resume()
  publish()
}

function rejectNumericalAdmission(jobId?: string): void {
  if (jobId && activeJob?.jobId === jobId) {
    if (phase === 'finalizing') {
      finishMissingClosure()
      return
    }
    auditFull = true
    clearTimeout(inverseTimeout)
    auditTransitions = [...auditTransitions, ['cancelled', jobId, timeUs()]]
    if (pendingJob) auditTransitions = [...auditTransitions, ['cancelled', pendingJob.job.jobId, timeUs()]]
    activeJob = null
    pendingJob = null
    provisional = null
    message = 'Лимит численной памяти диагностического процесса исчерпан.'
    publish()
    return
  }
  if (jobId && (replayTimeline?.stage !== 'dispatched' || replayTimeline.jobs[replayTimeline.index]?.jobId !== jobId)) return
  if (detector?.calibration) useQualitativeDiagnostics('Лимит численной памяти диагностики. Продолжен расчёт с качественной диагностикой.')
  if (awaitingDictionary) completeStartup()
}

function dispatch(batch: PublicBatch): void {
  port.postMessage(batch)
  inferenceTimeout = setTimeout(failInference, 10_000)
}

function enqueue(batch: PublicBatch): void {
  if (batch.sampleTimeUs % 50_000 !== 0) return
  const idle = schedule.active === null
  schedule = offer(schedule, batch)
  if (idle && schedule.active) dispatch(schedule.active)
}

function dispatchDiagnostic(job: DiagnosticJob): void {
  if (audit.length >= MAX_AUDITED_JOBS || auditedTrials + job.searchBudget.evaluationLimit > MAX_AUDITED_TRIALS
    || auditBytes + MAX_JOB_BYTES > MAX_AUDIT_BYTES) {
    auditFull = true
    auditTransitions = [...auditTransitions, ['cancelled', job.jobId, timeUs()]]
    return
  }
  activeJob = job
  startedAtUs = timeUs()
  auditTransitions = [...auditTransitions, ['admitted', job.jobId, startedAtUs]]
  const deadlineMs = performance.timeOrigin + performance.now() + job.searchBudget.wallLimitMs
  port.postMessage({ schemaVersion: 1, runId, kind: 'inverse', job, deadlineMs })
  inverseTimeout = setTimeout(failInference, 10_000)
}

function exportReveal(): void {
  revealed = true
  if (!engine) return
  const calibration = detector?.calibration
  replay = recordReplay(engine, !replaying && calibration ? {
    version: 1, solver: 'typescript-f64', calibrationId: calibration.calibrationId,
    policySha256: calibration.hashes.policy, dictionarySha256: calibration.hashes.dictionary, jobs: audit,
    transitions: auditTransitions, resourceLimited: auditFull, warmup: detector?.warmupFit ?? undefined,
    closureEvidenceMissing: closureEvidenceMissing || undefined, unverifiedProvisional,
  } : importedAudit)
}

function finishClosedRun(): void {
  stop(terminalDomainMessage ? 'invalid' : 'completed')
  if (terminalDomainMessage) message = terminalDomainMessage
  if (!revealOnClosure) return
  try {
    exportReveal()
  } catch (error) {
    message = error instanceof Error ? error.message : 'Не удалось сохранить запись сценария.'
  }
}

function finishMissingClosure(): void {
  closureEvidenceMissing = true
  finishClosedRun()
  if (!terminalDomainMessage) message = 'Часть диагностического журнала недоступна.'
  publish()
}

function closeRun(revealRequested: boolean): void {
  revealOnClosure ||= revealRequested
  if (phase === 'finalizing') return
  if (!activeJob) {
    finishClosedRun()
    return
  }
  clearTimeout(timer)
  clearTimeout(inferenceTimeout)
  clearTimeout(inverseTimeout)
  schedule = emptySchedule()
  phase = 'finalizing'
  port.postMessage({ schemaVersion: 1, runId, kind: 'cancel-inverse', jobId: activeJob.jobId })
  inverseTimeout = setTimeout(finishMissingClosure, 5000)
}

function scheduleDiagnostics(current: Engine, batch: PublicBatch): void {
  if (!detector?.calibration) return
  const previousAlarm = detector.lastAlarmUs
  detector = advanceDetector(detector, batch)
  if (replayTimeline && importedAudit?.warmup && detector.warmupFit && !warmupChecked) {
    if (!matchesReplayWarmup(importedAudit.warmup, detector.warmupFit)) throw new Error('replay-divergence: warmup baseline differs')
    warmupChecked = true
  }
  if (replaying) {
    if (!replayTimeline?.transitionsByTime) return
    const recorded = replayTimeline.transitionsByTime.get(current.timeUs) ?? []
    const eligible = detector.canLocalize && anchors.length === 9
    const admission = eligible ? admitWindows(windowSchedule, current.timeUs, previousAlarm !== detector.lastAlarmUs)
      : { state: windowSchedule, windows: [] }
    windowSchedule = admission.state
    const rebuilt = admission.windows.filter((window) => freezeWindow(current.history, window.endUs, window.durationUs))
    replayQueue = verifyReplayQueue(replayQueue, rebuilt, recorded, current.timeUs, horizonUs)
    return
  }
  if (!detector.canLocalize || anchors.length !== 9 || auditFull) return
  const admission = admitWindows(windowSchedule, current.timeUs, previousAlarm !== detector.lastAlarmUs)
  windowSchedule = admission.state
  for (const window of admission.windows) {
    if (auditTransitions.length >= MAX_AUDIT_TRANSITIONS - 8) { auditFull = true; break }
    const job = buildDiagnosticJob(crypto.randomUUID(), window, detector, current.history, anchors,
      publicControls(current.journal), current.nominalPredictions)
    if (!job) continue
    auditTransitions = [...auditTransitions, ['requested', job.jobId, job.windowEndUs, job.windowStartUs]]
    const activeDuration = activeJob ? activeJob.windowEndUs - activeJob.windowStartUs : undefined
    if (preservePendingWindow(pendingJob?.window, window, activeDuration)) {
      auditTransitions = [...auditTransitions, ['superseded', job.jobId, timeUs()]]
      continue
    }
    if (!activeJob) dispatchDiagnostic(job)
    else {
      if (pendingJob) auditTransitions = [...auditTransitions, ['superseded', pendingJob.job.jobId, timeUs()]]
      pendingJob = { job, window }
    }
  }
}

function freezeReplayEvidence(current: Engine, record: InferenceAuditJob): void {
  if (replayEvidence.has(record.jobId)) return
  const durationUs = record.endUs - record.startUs
  if (!detector || replayEvidence.size >= 2 || (durationUs !== 4_000_000 && durationUs !== 30_000_000)) {
    throw new Error('replay-divergence: invalid diagnostic window')
  }
  const job = buildDiagnosticJob(record.jobId,
    { startUs: record.startUs, endUs: record.endUs, durationUs, priority: 'regular' },
    detector, current.history, anchors, publicControls(current.journal),
    record.decisionReplay?.nominalCacheHits === undefined ? undefined : current.nominalPredictions)
  if (!job) throw new Error('replay-divergence: could not rebuild public evidence')
  const frozen = { ...job, searchBudget: { ...job.searchBudget, wallLimitMs: record.wallLimitMs, evaluationLimit: record.evaluationLimit } }
  replayEvidence = new Map([...replayEvidence, [record.jobId, frozen]])
}

function advanceTimedReplay(current: Engine): boolean {
  while (replayTimeline) {
    const actions = replayActions(replayTimeline, current.timeUs)
    for (const action of actions) {
      if (action.kind === 'freeze') freezeReplayEvidence(current, action.job)
    }
    const transition = actions.find((action) => action.kind !== 'freeze')
    if (!transition) return true
    const { kind, job } = transition
    if (kind === 'wait') {
      phase = 'replay-wait'
      publish()
      return false
    }
    if (kind === 'divergence') throw new Error('replay-divergence: recorded F64 scores differ')
    if (kind === 'dispatch') {
      const frozen = replayEvidence.get(job.jobId)
      if (!frozen) throw new Error('replay-divergence: missing frozen window')
      if (job.decisionReplay?.nominalCacheHits !== undefined && !frozen.nominalPredictionCache) {
        useQualitativeDiagnostics('Исходный кэш штатных прогнозов недоступен. Продолжен повтор физики и датчиков.')
        return true
      }
      port.postMessage({
        schemaVersion: 1, runId, kind: 'replay-inverse', job: frozen, trials: job.trials,
        decisionReplay: job.decisionReplay, provisional: job.provisional,
      })
      replayTimeline = markReplayDispatched(replayTimeline, job.jobId)
      replayEvidence = new Map([...replayEvidence].filter(([id]) => id !== job.jobId))
    } else if (kind === 'provisional') {
      if (!replayProvisional || !detector?.canLocalize) throw new Error('replay-divergence: missing provisional evidence')
      provisional = replayProvisional
      replayTimeline = { ...replayTimeline, provisionalPublished: true }
      publish()
    } else {
      if (replayDecision && !job.closure) {
        diagnosis = replayDecision
      }
      replayDecision = null
      replayProvisional = null
      provisional = null
      replayTimeline = commitReplayJob(replayTimeline, job.jobId)
    }
  }
  return true
}

function resume(): void {
  clearTimeout(timer)
  originTimeUs = timeUs()
  originWallMs = performance.now()
  phase = originTimeUs < profile.warmupUs ? 'warming-up' : 'running'
  timer = setTimeout(tick, 0)
}

function acceptEngine(next: Engine): void {
  const seconds = next.history.seconds
  const latest = seconds.at(-1)
  const checkpoint = latest?.checkpoint && latest.startUs === next.timeUs
    ? { timeUs: latest.startUs, keepSinceUs: seconds[0]!.startUs, states: latest.checkpoint } : undefined
  simulationMemory.track([next.plant, next.bank], checkpoint)
  engine = next
}

function tick(): void {
  try {
    if (engine && replayAbortBatch) {
      enqueue(replayAbortBatch)
      scheduleDiagnostics(engine, replayAbortBatch)
      replayAbortBatch = undefined
    }
    if (engine && !advanceTimedReplay(engine)) return
    const started = performance.now()
    const target = Math.min(horizonUs, paceTarget(originTimeUs, originWallMs, started, pace))
    const stepUs = engine || laminar ? 10_000 : profile.thermal.stepUs
    let deadline = Math.min(nextBoundary(timeUs(), stepUs), horizonUs)
    while (timeUs() < horizonUs && deadline <= target) {
      if (engine) {
        const next = advanceEngine(engine, deadline)
        acceptEngine(next)
        if (next.latestBatch?.sampleTimeUs === next.timeUs) {
          enqueue(next.latestBatch)
          scheduleDiagnostics(next, next.latestBatch)
        }
        if (!advanceTimedReplay(next)) return
      }
      if (laminar) {
        const result = advanceTo(laminar, deadline)
        if (!result.ok) throw result.error
        simulationMemory.track([result.value])
        laminar = result.value
      }
      if (thermal) {
        const next = advanceThermal(thermal, deadline, profile)
        simulationMemory.track([next])
        thermal = next
      }
      deadline = Math.min(nextBoundary(timeUs(), stepUs), horizonUs)
      if (performance.now() - started >= 4) break
    }
    if (timeUs() === horizonUs) {
      if (replayTimeline) {
        if (replayTimeline.transitionsByTime && horizonUs % PRESSURE_PERIOD_US !== 0) {
          replayQueue = verifyReplayQueue(replayQueue, [], replayTimeline.transitionsByTime.get(horizonUs) ?? [], horizonUs, horizonUs)
        }
        if (replayTimeline.index !== replayTimeline.jobs.length || importedAudit?.warmup && !warmupChecked) {
          throw new Error('replay-divergence: diagnostic evidence is incomplete')
        }
        replayVerification = !replayTimeline.transitionsByTime || importedAudit?.closureEvidenceMissing ? 'partial' : 'verified'
      }
      if (replayAbortMessage) {
        stop('invalid')
        message = replayAbortMessage
      } else closeRun(false)
      publish()
      return
    }
    if (phase === 'warming-up' && timeUs() >= profile.warmupUs) phase = 'running'
    if (started - lastPublishMs >= 50) publish()
    timer = setTimeout(tick, deadline <= target ? 0 : 4)
  } catch (failure) {
    let error = failure
    if (failure instanceof EngineExperimentDomainError) {
      const before = engine
      try {
        acceptEngine(failure.stoppedEngine)
      } catch (admissionError) {
        error = admissionError
      }
      if (error === failure && before?.replayAbort && failure.stoppedEngine.timeUs === horizonUs) {
        const batch = failure.stoppedEngine.latestBatch
        if (batch?.sampleTimeUs === horizonUs && before.timeUs < horizonUs) replayAbortBatch = batch
        replayAbortMessage = failure.message
        timer = setTimeout(tick, 0)
        return
      }
      if (error === failure && !replaying) {
        terminalDomainMessage = failure.message
        closeRun(false)
        publish()
        return
      }
    }
    if (replaying && error instanceof Error && error.message.startsWith('replay-divergence:')) replayVerification = 'diverged'
    if (replayTimeline) replayVerification = 'diverged'
    stop('invalid')
    message = error instanceof Error ? error.message : 'Расчёт остановлен.'
    publish()
  }
}

function start(command: Extract<Command, { kind: 'start' }>): void {
  const nominal = profileSchema.parse(profiles[command.profileId])
  profile = command.replay?.sensorProfileId
    ? profileSchema.parse({ ...nominal, sensorProfileId: command.replay.sensorProfileId }) : nominal
  replaying = Boolean(command.replay)
  importedAudit = command.replay?.inferenceAudit
  replayVerification = importedAudit ? 'simulation-only' : undefined
  horizonUs = command.replay?.endedAtUs ?? profile.horizonUs
  runId = command.runId
  incomingSeq = command.seq
  port = command.port
  pace = command.pace
  port.onmessageerror = failInference
  port.onmessage = (event: MessageEvent<unknown>) => {
    const result = inferenceMessageSchema.safeParse(event.data)
    if (!result.success || result.data.kind === 'invalid-public-batch') {
      failInference()
      return
    }
    if (result.data.runId !== runId) return
    if (result.data.kind === 'dictionary-ready') {
      if (awaitingDictionary) completeStartup()
      return
    }
    if (result.data.kind === 'dictionary-unavailable') {
      const jobId = result.data.jobId
      if (jobId && (replayTimeline?.stage !== 'dispatched' || replayTimeline.jobs[replayTimeline.index]?.jobId !== jobId)) return
      if (detector?.calibration) useQualitativeDiagnostics()
      if (awaitingDictionary) completeStartup()
      return
    }
    if (result.data.kind === 'spatial-envelope-unavailable') {
      if (replayTimeline?.stage === 'dispatched' && replayTimeline.jobs[replayTimeline.index]?.jobId === result.data.jobId) {
        useQualitativeDiagnostics('Исходная пространственная огибающая недоступна. Воспроизводятся физика и датчики.')
      }
      return
    }
    if (result.data.kind === 'resource-limit') {
      rejectNumericalAdmission(result.data.jobId)
      return
    }
    if (result.data.kind === 'numerical-memory') {
      inferenceNumericalMemory = result.data.memory
      return
    }
    if (result.data.kind === 'replay-inverse-result') {
      if (!replayTimeline) return
      const expected = replayTimeline.jobs[replayTimeline.index]
      if (expected?.jobId !== result.data.jobId) return
      const next = markReplayVerified(replayTimeline, result.data.jobId, matchesReplayResponse(expected, result.data))
      if (next === replayTimeline) return
      replayTimeline = next
      replayDecision = next.stage === 'matched' ? result.data.decision ?? null : null
      replayProvisional = next.stage === 'matched' ? result.data.provisional ?? null : null
      if (phase === 'replay-wait') resume()
      return
    }
    if (result.data.kind === 'inverse-provisional') {
      const { checkpoint } = result.data
      if (!activeJob || checkpoint.result.jobId !== activeJob.jobId || provisional || !detector?.canLocalize
        || (phase !== 'running' && phase !== 'paused')) return
      if (!canCommitResult(activeJob, checkpoint.result, diagnosis)
        || checkpoint.result.completedEvaluations > activeJob.searchBudget.evaluationLimit) return failInference()
      provisional = { ...checkpoint, publishedAtUs: timeUs() }
      publish()
      return
    }
    if (result.data.kind === 'inverse-result') {
      if (!activeJob || activeJob.jobId !== result.data.result.jobId) return
      if (!canCommitResult(activeJob, result.data.result, diagnosis)) return failInference()
      clearTimeout(inverseTimeout)
      const committed = { ...result.data.result, finishedAtUs: timeUs() }
      const closing = phase === 'finalizing'
      const record = inferenceAuditJobSchema.safeParse({
        jobId: activeJob.jobId, startUs: activeJob.windowStartUs, endUs: activeJob.windowEndUs,
        startedAtUs, finishedAtUs: timeUs(), wallLimitMs: activeJob.searchBudget.wallLimitMs,
        evaluationLimit: activeJob.searchBudget.evaluationLimit, stopReason: result.data.result.stopReason,
        completedEvaluations: result.data.result.completedEvaluations, trials: result.data.trials,
        closure: closing ? 'discarded' : undefined,
        decisionReplay: result.data.timing ? { ...result.data.timing, result: committed } : undefined,
        provisional: provisional ?? undefined,
      })
      if (!record.success) return failInference()
      const bytes = new TextEncoder().encode(JSON.stringify(record.data)).byteLength
      if (bytes > MAX_JOB_BYTES) return failInference()
      audit = [...audit, record.data]
      auditedTrials += record.data.trials.length
      auditBytes += bytes + 1
      if (closing) {
        finishClosedRun()
        publish()
        return
      }
      auditTransitions = [...auditTransitions, ['finished', record.data.jobId, timeUs()], ['committed', record.data.jobId, timeUs()]]
      diagnosis = committed
      provisional = null
      activeJob = null
      if (pendingJob) dispatchDiagnostic(pendingJob.job)
      pendingJob = null
      if (phase === 'paused') publish()
      return
    }
    if (result.data.timeUs !== schedule.active?.sampleTimeUs || result.data.timeUs > timeUs()) return
    clearTimeout(inferenceTimeout)
    schedule = complete(schedule, result.data.timeUs)
    if (schedule.active) dispatch(schedule.active)
    residualTimeUs = result.data.timeUs
    residualPa = result.data.residualPa
  }
  const expected = command.replay ? command.replay.hydraulicBackend ?? TYPESCRIPT_SIMULATION_BACKEND.identity : undefined
  const deployment = profile.mode === 'turbulent' && expected?.solver !== 'typescript-f64'
    ? configuredWasmDeployment() : undefined
  if (!deployment && expected?.solver !== 'wasm-f64') {
    try {
      finishStartup(command, TYPESCRIPT_SIMULATION_BACKEND)
    } catch (error) {
      failStartup(error)
    }
    return
  }
  initializing = true
  void resolveSimulationBackend(profile, deployment, expected, numericalMemory).then((backend) => {
    if (!initializing) {
      backend.releaseMemory?.()
      return
    }
    initializing = false
    try {
      finishStartup(command, backend)
    } catch (error) {
      backend.releaseMemory?.()
      throw error
    }
  }).catch(failStartup)
}

function failStartup(error: unknown): void {
  initializing = false
  awaitingDictionary = false
  stop('error')
  message = error instanceof Error ? error.message : 'Гидравлический модуль недоступен.'
  publish()
}

function finishStartup(command: Extract<Command, { kind: 'start' }>, backend: SimulationBackend): void {
  const bootstrap = numericalMemory.reserveBytes('simulation bootstrap workspace', BOOTSTRAP_WORKSPACE_BYTES)
  if (!bootstrap) throw new Error('resource-limit: simulation bootstrap workspace')
  try {
    if (command.replay) acceptEngine(engineFromReplay(profile, command.replay, backend))
    else if (profile.mode === 'thermal') {
      const next = initializeThermal(profile)
      simulationMemory.track([next])
      thermal = next
    } else if (profile.mode === 'laminar') {
      const result = initialize(profile)
      if (!result.ok) throw result.error
      simulationMemory.track([result.value])
      laminar = result.value
    } else acceptEngine(createEngine(profile, crypto.getRandomValues(new Uint32Array(1))[0]!, backend))
    if (engine?.nominalPredictions && !numericalMemory.reserveBytes('retained and staged nominal predictions', NOMINAL_WORKSPACE_BYTES)) {
      throw new Error('resource-limit: simulation nominal prediction workspace')
    }
  } finally {
    bootstrap.release()
  }
  if (engine) {
    const release = command.diagnosticRelease
    const bundled = import.meta.env.PIPETWIN_BUNDLED_DICTIONARY === '1' ? import.meta.env.VITE_PIPETWIN_CALIBRATION_JSON : undefined
    const supplied = trustedCalibration(import.meta.env.MODE, bundled,
      import.meta.env.PIPETWIN_SOURCE_HASHES, release)
    const candidateDetector = createDetector(profile, supplied?.calibration ?? null, supplied?.expectedHashes)
    const calibration = candidateDetector.calibration
    const replayCompatible = importedAudit && calibration
      && importedAudit.calibrationId === calibration.calibrationId && importedAudit.policySha256 === calibration.hashes.policy
      && importedAudit.dictionarySha256 === calibration.hashes.dictionary
      && (importedAudit.transitions && !importedAudit.resourceLimited
        || importedAudit.jobs.some((job) => job.trials.length > 0 || job.decisionReplay))
    if (replayCompatible && importedAudit) {
      replayTimeline = createReplayTimeline(importedAudit.jobs, importedAudit.resourceLimited ? undefined : importedAudit.transitions)
      replayVerification = 'pending'
    }
    detector = !replaying || replayCompatible ? candidateDetector : createDetector(profile, null)
    if (detector.calibration) {
      const dictionary = import.meta.env.MODE === 'development' || import.meta.env.MODE === 'test' ? release?.dictionary : undefined
      awaitingDictionary = bundled !== undefined
      initializing = awaitingDictionary
      port.postMessage({ schemaVersion: 1, runId, kind: 'configure', profile, calibration: detector.calibration, dictionary },
        dictionary ? [dictionary.data] : [])
      void Promise.all(engine.bank.map((state, index) => createCheckpointAnchor(index as AnchorId, state.profile.definition)))
        .then((value) => { anchors = value }, failInference)
    }
  }
  if (awaitingDictionary) publish()
  else completeStartup()
}

function completeStartup(): void {
  awaitingDictionary = false
  initializing = false
  if (engine?.latestBatch) scheduleDiagnostics(engine, engine.latestBatch)
  if (engine?.latestBatch) enqueue(engine.latestBatch)
  if (phase !== 'paused') resume()
  publish()
}

function apply(command: Exclude<Command, { kind: 'start' }>): void {
  switch (command.kind) {
    case 'pause':
      if (phase === 'running' || phase === 'warming-up' || phase === 'replay-wait') stop('paused')
      return
    case 'resume':
      if (phase === 'paused') resume()
      return
    case 'pace':
      pace = command.pace
      if (phase === 'running' || phase === 'warming-up') resume()
      return
    case 'reveal':
      if (replaying && phase !== 'completed' && phase !== 'invalid' && phase !== 'error') {
        throw new Error('Дождитесь окончания воспроизведения.')
      }
      if (timeUs() < profile.warmupUs) throw new Error('Сначала дождитесь окончания прогрева.')
      if (engine?.truth && engine.truth.timeUs > timeUs()) throw new Error('Дождитесь применения запланированной команды.')
      if (phase === 'invalid' || phase === 'error') exportReveal()
      else closeRun(true)
      return
    case 'accept-experiment':
      throw new Error('Активный опыт недоступен без квалифицированного предложения.')
    case 'sensor-fault':
    case 'leak':
    case 'outlet':
      if (phase !== 'running' || !engine || replaying) throw new Error('Команда недоступна в текущем режиме.')
      if (detector?.calibration && !detector.warmupFit) throw new Error('Штатный прогрев не прошёл проверку датчиков.')
      if (command.kind === 'sensor-fault') {
        engine = scheduleSensorFault(engine, command.sensorId, command.fault)
        appliedTimeUs = engine.journal.at(-1)?.timeUs ?? null
        message = 'Изменение показаний датчика запланировано.'
        return
      }
      engine = command.kind === 'leak' ? scheduleLeak(engine, {
        positionM: command.positionM, cdAreaM2: command.cdAreaM2, openingUs: command.openingUs,
      }) : scheduleOutlet(engine, command.outletFlowM3s)
      appliedTimeUs = command.kind === 'leak'
        ? engine.truth?.timeUs ?? null
        : engine.events.find((event) => event.kind === 'control')?.timeUs ?? null
      if (command.kind === 'outlet') message = 'Изменение расхода запланировано.'
  }
}

worker.onmessage = (event: MessageEvent<unknown>) => {
  const parsed = commandSchema.safeParse(event.data)
  if (!parsed.success) {
    if (!runId) throw new Error('Invalid initialization.')
    message = 'Недопустимая команда.'
    const data: unknown = event.data
    leakRejected = !engine?.truth && typeof data === 'object' && data !== null && 'kind' in data && data.kind === 'leak'
    publish()
    return
  }
  const command = parsed.data
  if (command.kind === 'start') {
    if (!runId) start(command)
    return
  }
  if (command.runId !== runId || command.seq <= incomingSeq) return
  incomingSeq = command.seq
  if (initializing) {
    if (command.kind === 'pause') phase = 'paused'
    if (command.kind === 'resume') phase = 'warming-up'
    if (command.kind === 'pace') pace = command.pace
    if (awaitingDictionary) publish()
    return
  }
  message = null
  try {
    apply(command)
  } catch (error) {
    message = error instanceof Error ? error.message : 'Команда отклонена.'
    if (command.kind === 'leak') leakRejected = true
  }
  publish()
}
