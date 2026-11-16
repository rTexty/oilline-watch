import type { Calibration } from '../contracts/calibration'
import type { CpuTrial, InverseDecisionReplay, InverseProvisionalAudit } from '../contracts/inference-audit'
import { diagnosticResultSchema } from '../contracts/inference'
import type { DiagnosticJob, DiagnosticResult, ProvisionalDiagnostic } from '../contracts/inference'
import type { CheckpointAnchor } from '../twin/checkpoint'
import { matchesReplayScore, runInverseSearch } from './inverse'
import type { InverseOptions } from './inverse'
import type { HydraulicCandidate } from './optimizer'
import { verifiedSpatialEnvelopeDigest } from './qualified-spatial-profile'
import type { ResponseDictionary } from './screening'

export function serializeCpuTrial({ candidate, score }: { readonly candidate: HydraulicCandidate; readonly score: number | null }): CpuTrial {
  const { anchorId, model } = candidate
  if (model === 'M0') return [model, anchorId, score]
  if (model === 'ML') return [model, anchorId, candidate.node, candidate.cdAreaM2, candidate.onsetUs, candidate.openingUs, score]
  return [model, anchorId, candidate.amplitudeM3s, candidate.onsetUs, candidate.openingUs, score]
}

function sameTrial(expected: CpuTrial, actual: CpuTrial): boolean {
  return expected.length === actual.length && expected.slice(0, -1).every((value, index) => value === actual[index])
    && matchesReplayScore(expected.at(-1) as number | null, actual.at(-1) as number | null)
}

function sameDecision(expected: DiagnosticResult, actual: DiagnosticResult): boolean {
  if (expected.hypotheses.length !== actual.hypotheses.length
    || !expected.hypotheses.every(({ score }, index) => matchesReplayScore(score, actual.hypotheses[index]!.score))) return false
  const discrete = (result: DiagnosticResult) => JSON.stringify(diagnosticResultSchema.parse({
    ...result, hypotheses: result.hypotheses.map((hypothesis) => ({ ...hypothesis, score: null })),
  }))
  return discrete(expected) === discrete(actual)
}

function sameProvisional(expected: ProvisionalDiagnostic, actual: ProvisionalDiagnostic): boolean {
  return expected.jobId === actual.jobId && expected.modelVersion === actual.modelVersion
    && expected.profileId === actual.profileId && expected.bankVersion === actual.bankVersion
    && expected.calibrationId === actual.calibrationId && expected.controlRevision === actual.controlRevision
    && expected.observedThroughUs === actual.observedThroughUs && expected.completedEvaluations === actual.completedEvaluations
    && (['M0', 'ML', 'MB', 'MS'] as const).every((model) => matchesReplayScore(expected.scores[model], actual.scores[model]))
}

type ReplayDecisionOptions = Pick<InverseOptions, 'shouldCancel' | 'yieldTask' | 'qualifiedSpatialEnvelope'> & {
  readonly provisional?: InverseProvisionalAudit
  readonly onVerifiedProvisional?: (checkpoint: InverseProvisionalAudit) => void
}

export async function replayDiagnosticDecision(
  job: DiagnosticJob,
  anchors: readonly CheckpointAnchor[],
  calibration: Calibration,
  expected: InverseDecisionReplay,
  trials: readonly CpuTrial[],
  dictionary: ResponseDictionary | null,
  options: ReplayDecisionOptions = {},
): Promise<DiagnosticResult | null> {
  const { provisional, onVerifiedProvisional } = options
  if (expected.dictionaryLoaded && !dictionary) return null
  const qualifiedSpatialEnvelope = expected.spatialEnvelopeSha256 ? options.qualifiedSpatialEnvelope : undefined
  if (expected.spatialEnvelopeSha256 && (!qualifiedSpatialEnvelope
    || verifiedSpatialEnvelopeDigest(qualifiedSpatialEnvelope) !== expected.spatialEnvelopeSha256)) return null
  let observedTrials = 0
  let sequenceMatches = true
  let wallStopCheck: number | null = null
  let cancelStopCheck: number | null = null
  let incompleteTrialOrdinal: number | null = null
  let nominalCacheHits: number | undefined
  let matchedProvisional: InverseProvisionalAudit | undefined
  const result = await runInverseSearch(job, anchors, calibration.noise, {
    yieldTask: options.yieldTask, dictionary: expected.dictionaryLoaded ? dictionary ?? undefined : undefined,
    qualifiedSpatialEnvelope,
    useNominalCache: expected.nominalCacheHits !== undefined,
    regionCalibration: calibration, replayClock: expected,
    replayProvisionalCheck: provisional?.check,
    onProvisional: provisional && ((check, result) => {
      if (check === provisional.check && sameProvisional(provisional.result, result)) {
        matchedProvisional = { ...provisional, result }
      }
    }),
    shouldCancel: () => !sequenceMatches || Boolean(options.shouldCancel?.()),
    onEvaluation: (trial) => {
      const record = trials[observedTrials++]
      if (!record || !sameTrial(record, serializeCpuTrial(trial))) sequenceMatches = false
    },
    onTiming: (timing) => {
      wallStopCheck = timing.wallStopCheck
      cancelStopCheck = timing.cancelStopCheck
      incompleteTrialOrdinal = timing.incompleteTrialOrdinal
      nominalCacheHits = timing.nominalCacheHits
    },
  })
  const committed = { ...result, finishedAtUs: expected.result.finishedAtUs }
  const matches = sequenceMatches && observedTrials === trials.length && wallStopCheck === expected.wallStopCheck
    && cancelStopCheck === (expected.cancelStopCheck ?? null)
    && nominalCacheHits === expected.nominalCacheHits
    && (expected.incompleteTrialOrdinal === undefined || incompleteTrialOrdinal === expected.incompleteTrialOrdinal)
    && (provisional === undefined || matchedProvisional !== undefined)
    && sameDecision(expected.result, committed)
  if (!matches) return null
  if (matchedProvisional) onVerifiedProvisional?.(matchedProvisional)
  return committed
}
