import type { Calibration } from '../contracts/calibration'
import { cpuTrialSchema } from '../contracts/inference-audit'
import type { CpuTrial } from '../contracts/inference-audit'
import { diagnosticJobSchema } from '../contracts/inference'
import type { DiagnosticJob, DiagnosticResult, ProvisionalDiagnostic } from '../contracts/inference'
import type { AnchorId } from '../contracts/model'
import type { SensorId } from '../contracts/public'
import type { CheckpointAnchor } from '../twin/checkpoint'
import { prepareFit, prepareSensorBiasFit, scoreCandidate } from './hypotheses'
import type { CandidatePrediction, FitChannels, FitEvidence } from './hypotheses'
import { assessWithdrawalFit, onsetIsLeftCensored } from './hypothesis-decision'
import { candidateAllowed, createForwardPrefixCache, forwardTrial, prepareForwardContext } from './initial-state'
import { ANCHOR_IDS, candidateKey, compareTrials, MAX_REFINEMENT_LEVEL, neighbors, OPENINGS_US } from './optimizer'
import type { CandidateBounds, DisturbanceCandidate, HydraulicCandidate, RankedTrial } from './optimizer'
import { annotateExactRegions, unresolvedRegions } from './profile'
import { calculateProfileExclusions } from './qualified-spatial-profile'
import type { QualifiedSpatialEnvelope } from './qualified-spatial-profile'
import { prepareNominalPredictionCache } from './nominal-predictions'
import { prepareDictionary, prepareResponse, screenCandidate, screeningOnsets, screeningRows } from './screening'
import type { ResponseTrace, ResponseDictionary } from './screening'
import { prepareNativeScreeningRows, prepareNativeScreeningTable } from './screening-table'

export type InverseNoise = Readonly<Record<SensorId, { readonly sigmaSI: number; readonly rho: number }>>
export interface InverseTiming {
  readonly wallStopCheck: number | null
  readonly cancelStopCheck: number | null
  readonly incompleteTrialOrdinal: number | null
  readonly nominalCacheHits?: number
}
export interface InverseOptions {
  readonly shouldCancel?: () => boolean
  readonly useNominalCache?: boolean
  readonly useHydraulicPrefix?: boolean
  readonly now?: () => number
  readonly deadlineMs?: number
  readonly provisionalAtMs?: number
  readonly yieldTask?: () => Promise<void>
  readonly dictionary?: ResponseDictionary
  readonly regionCalibration?: Calibration
  readonly qualifiedSpatialEnvelope?: QualifiedSpatialEnvelope
  readonly replayClock?: Pick<InverseTiming, 'wallStopCheck'> & Partial<Pick<InverseTiming, 'cancelStopCheck'>>
  readonly replayProvisionalCheck?: number
  readonly onProvisional?: (check: number, result: ProvisionalDiagnostic) => void
  readonly onTiming?: (timing: InverseTiming) => void
  readonly onEvaluation?: (trial: { readonly candidate: HydraulicCandidate; readonly score: number | null }) => void
}

export const OFFLINE_INVERSE_EVALUATION_LIMIT = 4096

export type OfflineInverseOptions = Pick<InverseOptions,
  'shouldCancel' | 'useNominalCache' | 'yieldTask' | 'dictionary' | 'onEvaluation'>

type SearchSummary = Pick<DiagnosticResult,
  'completedEvaluations' | 'stopReason' | 'searchComplete' | 'hypotheses' | 'compatibleRegions'
  | 'fitQuality' | 'availability' | 'assumptions'>

export interface OfflineInverseComparatorResult {
  readonly kind: 'offline-comparator'
  readonly evaluationLimit: typeof OFFLINE_INVERSE_EVALUATION_LIMIT
  readonly attemptedEvaluations: number
  readonly result: Pick<SearchSummary,
    'completedEvaluations' | 'stopReason' | 'searchComplete' | 'hypotheses' | 'availability' | 'assumptions'>
}

type StopReason = DiagnosticResult['stopReason']
type DisturbanceTrial = RankedTrial & { readonly candidate: DisturbanceCandidate }
interface NominalFit {
  readonly prediction: CandidatePrediction
  readonly evidence: FitEvidence
}
interface BiasTrial {
  readonly anchorId: AnchorId
  readonly sensorId: SensorId
  readonly onsetUs: number
  readonly openingUs: typeof OPENINGS_US[number]
  readonly score: number
}

function bestTrial(trials: readonly RankedTrial[], model: HydraulicCandidate['model']): RankedTrial | undefined {
  return trials.filter((trial) => trial.candidate.model === model).sort(compareTrials)[0]
}

const SENSORS = ['P1', 'P2', 'P3', 'Qin'] as const
const GUARD_US = 3_000_000
const DEFAULT_YIELD = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function channelsFor(noise: InverseNoise, baseline: DiagnosticJob['frozenBaselines'][number]): FitChannels {
  const withBaseline = (sensor: SensorId) => ({ ...noise[sensor], baselineSI: baseline.meanResidualSI[sensor] })
  return { P1: withBaseline('P1'), P2: withBaseline('P2'), P3: withBaseline('P3'), Qin: withBaseline('Qin') }
}

function prepareEvidence(job: DiagnosticJob, noise: InverseNoise): readonly FitEvidence[] {
  return job.frozenBaselines.map((baseline) => prepareFit(
    job.observations, channelsFor(noise, baseline), job.windowStartUs, job.windowEndUs, job.deliveredThroughUs,
  ))
}

function enoughChannels(evidence: FitEvidence): boolean {
  const sensors = new Set(evidence.pairs.map(({ sensorId }) => sensorId))
  return sensors.has('Qin') && SENSORS.filter((sensor) => sensor !== 'Qin' && sensors.has(sensor)).length >= 2
}

function exploreWithoutDictionary(anchorId: AnchorId, bounds: CandidateBounds): readonly DisturbanceTrial[] {
  const node = Math.max(1, Math.round((anchorId + 1) * bounds.lastNode / (ANCHOR_IDS.length + 1)))
  const onsetUs = Math.min(bounds.lastOnsetUs, bounds.firstOnsetUs + GUARD_US)
  const sign = anchorId % 2 === 0 ? -1 : 1
  return [
    { candidate: { model: 'ML', anchorId, node, cdAreaM2: 1e-5, onsetUs, openingUs: 0 }, score: 0 },
    { candidate: { model: 'MB', anchorId, amplitudeM3s: sign * 0.02 * bounds.nominalFlowM3s, onsetUs, openingUs: 0 }, score: 0 },
  ]
}

async function coarseTrials(
  dictionary: readonly ResponseTrace[],
  nominal: ReadonlyMap<AnchorId, NominalFit>,
  onsets: readonly number[],
  bounds: CandidateBounds,
  poll: () => Promise<boolean>,
): Promise<readonly DisturbanceTrial[]> {
  const ranked: DisturbanceTrial[] = []
  const rowsByAnchor = new Map([...nominal].map(([id, fit]) => {
    const rows = screeningRows(fit.evidence, fit.prediction)
    return [id, rows && { rows, native: prepareNativeScreeningRows(rows) }] as const
  }))
  for (const trace of dictionary) {
    if (!await poll()) break
    const fit = rowsByAnchor.get(trace.anchorId)
    if (!fit) continue
    const response = prepareResponse(trace)
    const nativeScreen = fit.native && prepareNativeScreeningTable(response, fit.native)
    const strongest: DisturbanceTrial[] = []
    for (const onsetUs of onsets) {
      for (const openingUs of OPENINGS_US) {
        const nativeTrial = nativeScreen?.(onsetUs, openingUs, bounds.nominalFlowM3s)
        const trial = nativeTrial === undefined ? screenCandidate(response, fit.rows, onsetUs, openingUs, bounds.nominalFlowM3s) : nativeTrial
        if (!trial) continue
        strongest.push(trial)
      }
    }
    strongest.sort(compareTrials)
    // A trace can seed multiple distinct onsets for the boundary alternative.
    ranked.push(...strongest.slice(0, trace.model === 'MB' ? 4 : 1))
  }
  return ranked.sort(compareTrials)
}

async function sensorBiasSearch(
  nominal: ReadonlyMap<AnchorId, NominalFit>,
  onsets: readonly number[],
  bounds: CandidateBounds,
  poll: () => Promise<boolean>,
): Promise<{ readonly best: BiasTrial | null; readonly complete: boolean }> {
  let best: BiasTrial | null = null
  let matchedAnchors = 0
  for (const [anchorId, { prediction, evidence }] of nominal) {
    let fitBias: ReturnType<typeof prepareSensorBiasFit> | undefined
    let anchorMatched = false
    for (const sensorId of SENSORS) {
      if (!await poll()) return { best, complete: false }
      if (fitBias === undefined) fitBias = prepareSensorBiasFit(evidence, prediction)
      let localBest: BiasTrial | null = null
      for (const onsetUs of onsets) {
        for (const openingUs of OPENINGS_US) {
          const fit = fitBias?.(sensorId, onsetUs, openingUs)
          if (fit && (!localBest || fit.sumSquares < localBest.score)) {
            localBest = { anchorId, sensorId, onsetUs, openingUs, score: fit.sumSquares }
          }
        }
      }
      for (let step = 500_000; localBest && step >= 31_250; step /= 2) {
        if (!await poll()) return { best, complete: false }
        const origin: BiasTrial = localBest
        for (const onsetUs of [origin.onsetUs - step, origin.onsetUs + step]) {
          if (onsetUs < bounds.firstOnsetUs || onsetUs >= bounds.lastOnsetUs) continue
          const fit = fitBias?.(sensorId, onsetUs, origin.openingUs)
          if (fit && fit.sumSquares < localBest.score) localBest = { ...localBest, onsetUs, score: fit.sumSquares }
        }
      }
      if (localBest && (!best || localBest.score < best.score)) best = localBest
      if (localBest) anchorMatched = true
    }
    if (anchorMatched) matchedAnchors++
  }
  return { best, complete: matchedAnchors === ANCHOR_IDS.length }
}

function selectBasins(ranked: readonly DisturbanceTrial[], distanceM: number): readonly DisturbanceCandidate[] {
  const leaks: DisturbanceCandidate[] = []
  const boundaries: DisturbanceCandidate[] = []
  for (const { candidate } of ranked) {
    if (candidate.model === 'ML') {
      if (leaks.length < 4 && leaks.every((existing) => existing.model === 'ML'
        && Math.abs(candidate.node - existing.node) * distanceM >= 50)) leaks.push(candidate)
    } else {
      const anchorBasins = boundaries.filter((item) => item.anchorId === candidate.anchorId)
      if (anchorBasins.length < 2 && anchorBasins.every((item) => Math.abs(item.onsetUs - candidate.onsetUs) >= 250_000
        || item.openingUs !== candidate.openingUs)) boundaries.push(candidate)
    }
  }
  return [...leaks.flatMap((leak, index) => [leak, ...boundaries.slice(index * 5, (index + 1) * 5)]),
    ...boundaries.slice(leaks.length * 5)]
}

function isDisturbanceTrial(trial: RankedTrial): trial is DisturbanceTrial {
  return trial.candidate.model !== 'M0'
}

interface Basin {
  readonly center: DisturbanceTrial
  readonly level: number
}

async function refine(
  basins: readonly Basin[],
  bounds: CandidateBounds,
  evaluate: (candidate: HydraulicCandidate) => Promise<RankedTrial | null>,
  running: () => boolean,
): Promise<boolean> {
  let open = basins
  while (open.length > 0 && running()) {
    const pending: Basin[] = []
    for (const basin of open) {
      let best = basin.center
      for (const candidate of neighbors(basin.center.candidate, bounds, basin.level)) {
        const trial = await evaluate(candidate)
        if (!running()) return false
        if (trial && isDisturbanceTrial(trial) && compareTrials(trial, best) < 0) best = trial
      }
      const level = best === basin.center ? basin.level + 1 : basin.level
      if (level <= MAX_REFINEMENT_LEVEL) pending.push({ center: best, level })
    }
    open = pending
  }
  return open.length === 0
}

function outcome(
  job: DiagnosticJob,
  geometry: { readonly lengthM: number; readonly segments: number },
  completed: number,
  stopReason: StopReason,
  trials: readonly RankedTrial[],
  sensorFit: BiasTrial | null,
  sensorComplete: boolean,
  assumptions: readonly string[],
  observationCount: number,
  calibration: Calibration | undefined,
  excludedNodes: ReadonlySet<number> | undefined,
): SearchSummary {
  const leak = bestTrial(trials, 'ML')
  const healthy = bestTrial(trials, 'M0')
  const boundary = bestTrial(trials, 'MB')
  const calibrated = calibration?.qualification.quantitative && calibration.calibrationId === job.calibrationId
    && calibration.profileId === job.profileId && calibration.modelVersion === job.modelVersion
    && calibration.bankVersion === job.bankVersion
  const guardStartUs = job.windowStartUs - GUARD_US
  const leftCensored = trials.some(({ candidate, score }) => candidate.model === 'ML' && candidate.cdAreaM2 > 0
    && candidate.onsetUs === guardStartUs
    && onsetIsLeftCensored(leak?.score ?? null, score, healthy?.score ?? null, calibrated ? calibration.thresholds.profile : 0))
  const available = stopReason !== 'invalid-model' && stopReason !== 'insufficient-data' && !leftCensored
  const compatibleRegions = calibrated && available
    ? annotateExactRegions(geometry.lengthM, geometry.segments,
      trials.filter(({ candidate }) => candidate.model === 'ML' && candidate.onsetUs > guardStartUs),
      observationCount, calibration.thresholds, excludedNodes)
    : unresolvedRegions(geometry.lengthM, geometry.segments)
  const resultAssumptions = [
    ...assumptions.filter((assumption) => !excludedNodes || assumption !== 'response-envelope-unqualified'),
    ...(leftCensored ? ['left-censored-onset'] : []),
    ...(excludedNodes && available ? ['qualified-spatial-envelope']
      : compatibleRegions.some(({ status }) => status === 'compatible') ? ['tested-cells-only'] : []),
  ]
  const scores = { M0: healthy?.score ?? null, ML: leak?.score ?? null, MB: boundary?.score ?? null, MS: sensorFit?.score ?? null }
  const nominalComplete = trials.filter(({ candidate }) => candidate.model === 'M0').length === ANCHOR_IDS.length
  const fit = assessWithdrawalFit({
    scores, observations: observationCount, completed: stopReason === 'complete' && nominalComplete && sensorComplete,
    available, positiveWithdrawal: leak?.candidate.model === 'ML' && leak.candidate.cdAreaM2 > 0,
    // An untested cell remains unresolved until a separately qualified exclusion is available.
    profileQualified: Boolean(calibrated && calibration.errorEnvelope.qualified
      && compatibleRegions.every(({ status }) => status === 'compatible')),
  }, calibrated ? calibration.thresholds : null)
  const hypotheses = (['M0', 'ML', 'MB', 'MS', 'MD'] as const).map((model) => ({
    model,
    score: scores[model === 'MD' ? 'ML' : model],
    completed: model === 'MS' ? sensorComplete : model === 'M0' ? nominalComplete : stopReason === 'complete',
    support: fit.supportsWithdrawal && (model === 'ML' || model === 'MD') ? 'compatible' as const : 'unresolved' as const,
  }))
  return {
    completedEvaluations: completed, stopReason, searchComplete: stopReason === 'complete',
    hypotheses, compatibleRegions, fitQuality: fit.fitQuality,
    availability: stopReason === 'invalid-model' ? 'out-of-domain' : stopReason === 'insufficient-data'
      ? 'missing' : leftCensored ? 'insufficient-history' : 'available',
    assumptions: resultAssumptions,
  }
}

export async function runInverseSearch(
  input: DiagnosticJob,
  anchors: readonly CheckpointAnchor[],
  noise: InverseNoise,
  options: InverseOptions = {},
): Promise<DiagnosticResult> {
  const { job, summary } = await executeInverseSearch(input, anchors, noise, options, 'live')
  return {
    jobId: job.jobId, modelVersion: job.modelVersion, profileId: job.profileId, bankVersion: job.bankVersion,
    calibrationId: job.calibrationId, controlRevision: job.controlRevision,
    observedThroughUs: job.deliveredThroughUs, finishedAtUs: job.requestedAtUs,
    ...summary,
  }
}

export async function runOfflineInverseComparator(
  input: DiagnosticJob,
  anchors: readonly CheckpointAnchor[],
  noise: InverseNoise,
  { shouldCancel, useNominalCache, yieldTask, dictionary, onEvaluation }: OfflineInverseOptions = {},
): Promise<OfflineInverseComparatorResult> {
  const { attemptedEvaluations, summary } = await executeInverseSearch(input, anchors, noise,
    { shouldCancel, useNominalCache, yieldTask, dictionary, onEvaluation }, 'offline')
  const { completedEvaluations, stopReason, searchComplete, hypotheses, availability, assumptions } = summary
  return {
    kind: 'offline-comparator', evaluationLimit: OFFLINE_INVERSE_EVALUATION_LIMIT, attemptedEvaluations,
    result: { completedEvaluations, stopReason, searchComplete, hypotheses, availability, assumptions },
  }
}

async function executeInverseSearch(
  input: DiagnosticJob,
  anchors: readonly CheckpointAnchor[],
  noise: InverseNoise,
  options: InverseOptions,
  mode: 'live' | 'offline',
) {
  const now = options.now ?? (() => performance.now())
  const yieldTask = options.yieldTask ?? DEFAULT_YIELD
  const checkWallClock = mode === 'live' && !options.replayClock
  const startedAt = checkWallClock ? now() : 0
  const job = diagnosticJobSchema.parse(input)
  const evaluationLimit = mode === 'offline' ? OFFLINE_INVERSE_EVALUATION_LIMIT : job.searchBudget.evaluationLimit
  const deadlineMs = Math.min(startedAt + job.searchBudget.wallLimitMs, options.deadlineMs ?? Infinity)
  const nominalCache = options.useNominalCache === false ? null : prepareNominalPredictionCache(job)
  const geometry = { lengthM: anchors[0]?.definition.geometry.lengthM ?? 1000, segments: job.checkpointsByAnchor[0]!.grid.cellCount }
  const assumptions = ['cpu-f64', 'response-envelope-unqualified', 'hydraulically-equivalent-withdrawal']
  const trials: RankedTrial[] = []
  const nominal = new Map<AnchorId, NominalFit>()
  let stopReason: StopReason | null = null
  let evaluations = 0
  let attempts = 0
  let sensorFit: BiasTrial | null = null
  let sensorComplete = false
  let observationCount = 0
  let timingChecks = 0
  let provisionalSent = false
  let wallStopCheck: number | null = null
  let cancelStopCheck: number | null = null
  let incompleteTrialOrdinal: number | null = null
  let excludedNodes: ReadonlySet<number> | undefined
  let nominalCacheHits = nominalCache ? 0 : undefined
  const result = (reason: StopReason) => {
    options.onTiming?.({ wallStopCheck, cancelStopCheck, incompleteTrialOrdinal, nominalCacheHits })
    return {
      job, attemptedEvaluations: attempts,
      summary: outcome(job, geometry, evaluations, reason, trials, sensorFit, sensorComplete,
        assumptions, observationCount, options.regionCalibration, excludedNodes),
    }
  }
  const running = () => {
    if (stopReason) return false
    timingChecks++
    if (options.shouldCancel?.() || options.replayClock?.cancelStopCheck === timingChecks) {
      stopReason = 'cancelled'
      cancelStopCheck = timingChecks
      return false
    }
    const wallTimeMs = checkWallClock ? now() : undefined
    if (options.replayClock ? options.replayClock.wallStopCheck === timingChecks
      : wallTimeMs !== undefined && wallTimeMs >= deadlineMs) {
      stopReason = 'wall-limit'
      wallStopCheck = timingChecks
      return false
    }
    if (!options.onProvisional || provisionalSent || nominal.size !== ANCHOR_IDS.length) return true
    const checkpointReached = options.replayClock ? options.replayProvisionalCheck === timingChecks
      : options.provisionalAtMs !== undefined && wallTimeMs !== undefined && wallTimeMs >= options.provisionalAtMs
    if (!checkpointReached) return true
    const healthy = bestTrial(trials, 'M0')
    if (!healthy) return true
    provisionalSent = true
    options.onProvisional(timingChecks, {
      jobId: job.jobId, modelVersion: job.modelVersion, profileId: job.profileId, bankVersion: job.bankVersion,
      calibrationId: job.calibrationId, controlRevision: job.controlRevision, observedThroughUs: job.deliveredThroughUs,
      completedEvaluations: evaluations,
      scores: {
        M0: healthy.score,
        ML: bestTrial(trials, 'ML')?.score ?? null,
        MB: bestTrial(trials, 'MB')?.score ?? null,
        MS: sensorComplete ? sensorFit?.score ?? null : null,
      },
    })
    return true
  }
  const poll = async () => {
    if (!running()) return false
    await yieldTask()
    return running()
  }

  if (!running()) return result(stopReason!)
  const context = prepareForwardContext(job, anchors)
  if (!context) return result('invalid-model')
  const prefixCache = mode === 'live' && options.useHydraulicPrefix ? createForwardPrefixCache(context) : undefined
  const bounds: CandidateBounds = {
    firstOnsetUs: job.windowStartUs - GUARD_US, lastOnsetUs: job.windowEndUs,
    lastNode: geometry.segments - 1, nominalFlowM3s: anchors[0]!.definition.initialPublicControls.outletFlowM3s,
  }
  const onsets = screeningOnsets(bounds, job.windowEndUs - job.windowStartUs)
  const evidence = prepareEvidence(job, noise)
  if (!enoughChannels(evidence[0]!)) return result('insufficient-data')
  observationCount = evidence[0]!.pairs.length

  const cache = new Map<string, RankedTrial | null>()
  const evaluate = async (candidate: HydraulicCandidate): Promise<RankedTrial | null> => {
    const key = candidateKey(candidate)
    if (!running()) return null
    if (cache.has(key)) return cache.get(key) ?? null
    if (attempts >= evaluationLimit) {
      stopReason = 'evaluation-limit'
      return null
    }
    attempts++
    const forward = await forwardTrial(context, candidate, poll, prefixCache)
    if (!running() || forward.status === 'interrupted') {
      incompleteTrialOrdinal = attempts - 1
      return null
    }
    const current = evidence[candidate.anchorId]!
    const score = forward.status === 'complete' ? scoreCandidate(current, forward.prediction) : null
    if (forward.status === 'complete') evaluations++
    options.onEvaluation?.({ candidate, score: score?.sumSquares ?? null })
    const ranked = score && { candidate, score: score.sumSquares }
    cache.set(key, ranked)
    if (ranked) {
      trials.push(ranked)
      if (candidate.model === 'M0' && forward.status === 'complete') {
        nominal.set(candidate.anchorId, { prediction: forward.prediction, evidence: current })
      }
    }
    if (attempts % job.searchBudget.quantumEvaluations === 0) await poll()
    return ranked
  }

  for (const anchorId of ANCHOR_IDS) {
    const candidate = { model: 'M0' as const, anchorId }
    if (nominalCache && nominalCacheHits !== undefined) {
      if (!await poll()) return result(stopReason!)
      const prediction = nominalCache(anchorId)
      const current = evidence[anchorId]!
      const score = scoreCandidate(current, prediction)
      if (!score) return result('invalid-model')
      nominal.set(anchorId, { prediction, evidence: current })
      trials.push({ candidate, score: score.sumSquares })
      nominalCacheHits++
    } else await evaluate(candidate)
    if (!running()) return result(stopReason!)
  }
  if (nominal.size !== ANCHOR_IDS.length) return result('invalid-model')

  // An unqualified control family cannot use the steady-boundary response dictionary.
  const dictionary = job.appliedControls.length === 0 ? prepareDictionary(options.dictionary, job, bounds) : null
  if (!dictionary) assumptions.push('screening-dictionary-unavailable')
  const coarse = dictionary ? await coarseTrials(dictionary, nominal, onsets, bounds, poll)
    : ANCHOR_IDS.flatMap((id) => exploreWithoutDictionary(id, bounds))
  if (!running()) return result(stopReason!)

  let mandatoryComplete = dictionary !== null
  for (const anchorId of ANCHOR_IDS) {
    for (const model of ['ML', 'MB'] as const) {
      const seed = coarse.find(({ candidate }) => candidate.model === model && candidate.anchorId === anchorId)
      const fallback = exploreWithoutDictionary(anchorId, bounds).find(({ candidate }) => candidate.model === model)!
      const exact = await evaluate((seed ?? fallback).candidate)
      if (!seed || !exact) mandatoryComplete = false
      if (!running()) return result(stopReason!)
    }
  }

  const bias = await sensorBiasSearch(nominal, onsets, bounds, poll)
  sensorFit = bias.best
  sensorComplete = bias.complete

  // Without dictionary evidence, exact development trials remain provisional.
  let refined = false
  if (running()) {
    const ranked = dictionary ? coarse : trials.filter(isDisturbanceTrial).sort(compareTrials)
    const basins: Basin[] = []
    const selected = selectBasins(ranked, geometry.lengthM / geometry.segments)
    for (const candidate of selected) {
      const exact = await evaluate(candidate)
      if (exact && isDisturbanceTrial(exact)) basins.push({ center: exact, level: 0 })
      if (!running()) break
    }
    const validBasins = basins.length === selected.length
      && basins.filter(({ center }) => center.candidate.model === 'ML').length === 4
      && ANCHOR_IDS.every((id) => basins.filter(({ center }) => center.candidate.model === 'MB'
        && center.candidate.anchorId === id).length === 2)
    const exhausted = await refine(basins, bounds, evaluate, running)
    refined = validBasins && exhausted
  }

  const alternativesPresent = ['ML', 'MB'].every((model) => trials.some((trial) => trial.candidate.model === model))
  if (stopReason) return result(stopReason)
  if (!alternativesPresent || !sensorComplete) return result('invalid-model')
  if (dictionary && (!mandatoryComplete || !refined)) assumptions.push('screening-incomplete')
  const { qualifiedSpatialEnvelope, regionCalibration } = options
  if (mandatoryComplete && refined && qualifiedSpatialEnvelope && regionCalibration && options.dictionary
    && SENSORS.every((id) => noise[id].sigmaSI === regionCalibration.noise[id].sigmaSI
      && noise[id].rho === regionCalibration.noise[id].rho)) {
    const exclusions = await calculateProfileExclusions(
      job, options.dictionary, qualifiedSpatialEnvelope, regionCalibration, anchors, nominal, trials, poll,
    )
    if (!running()) return result(stopReason!)
    excludedNodes = exclusions ?? undefined
  }
  return result(mandatoryComplete && refined ? 'complete' : 'resource-limit')
}
export type TrialReplayResult =
  | { readonly status: 'matched' | 'invalid-input' | 'cancelled'; readonly compared: number }
  | { readonly status: 'replay-divergence'; readonly compared: number; readonly trialIndex: number;
    readonly expectedScore: number | null; readonly actualScore: number | null }

function replayCandidate(record: CpuTrial): HydraulicCandidate {
  if (record[0] === 'M0') return { model: record[0], anchorId: record[1] }
  if (record[0] === 'MB') {
    return { model: record[0], anchorId: record[1], amplitudeM3s: record[2], onsetUs: record[3], openingUs: record[4] }
  }
  return {
    model: record[0], anchorId: record[1], node: record[2], cdAreaM2: record[3], onsetUs: record[4], openingUs: record[5],
  }
}

export function matchesReplayScore(expected: number | null, actual: number | null): boolean {
  if (expected === null || actual === null) return expected === actual
  return Math.abs(expected - actual) <= 1e-8 + 1e-12 * Math.max(Math.abs(expected), Math.abs(actual))
}

export async function replayExactTrials(
  input: DiagnosticJob,
  anchors: readonly CheckpointAnchor[],
  noise: InverseNoise,
  records: readonly CpuTrial[],
  options: Pick<InverseOptions, 'shouldCancel' | 'yieldTask'> = {},
): Promise<TrialReplayResult> {
  const parsed = diagnosticJobSchema.safeParse(input)
  if (!parsed.success || records.length > parsed.data.searchBudget.evaluationLimit) {
    return { status: 'invalid-input', compared: 0 }
  }
  const job = parsed.data
  const context = prepareForwardContext(job, anchors)
  if (!context) return { status: 'invalid-input', compared: 0 }
  const committed: { readonly candidate: HydraulicCandidate; readonly score: number | null }[] = []
  const keys = new Set<string>()
  for (const item of records) {
    const record = cpuTrialSchema.safeParse(item)
    if (!record.success) return { status: 'invalid-input', compared: 0 }
    const candidate = replayCandidate(record.data)
    const key = candidateKey(candidate)
    if (keys.has(key) || !candidateAllowed(context, candidate)) return { status: 'invalid-input', compared: 0 }
    keys.add(key)
    const score = record.data.at(-1) as number | null
    committed.push({ candidate, score })
  }

  const evidence = prepareEvidence(job, noise)
  if (committed.length > 0 && !enoughChannels(evidence[0]!)) return { status: 'invalid-input', compared: 0 }
  const yieldTask = options.yieldTask ?? DEFAULT_YIELD
  const poll = async () => {
    if (options.shouldCancel?.()) return false
    await yieldTask()
    return !options.shouldCancel?.()
  }
  for (const [index, record] of committed.entries()) {
    const forward = await forwardTrial(context, record.candidate, poll)
    if (forward.status === 'interrupted') return { status: 'cancelled', compared: index }
    const actualScore = forward.status === 'complete'
      ? scoreCandidate(evidence[record.candidate.anchorId]!, forward.prediction)?.sumSquares ?? null
      : null
    if (!matchesReplayScore(record.score, actualScore)) {
      return { status: 'replay-divergence', compared: index, trialIndex: index, expectedScore: record.score, actualScore }
    }
  }
  return { status: 'matched', compared: committed.length }
}
