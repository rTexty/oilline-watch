import type { DiagnosticJob, DiagnosticResult, ProvisionalDiagnostic } from '../contracts/inference'
import type { AppliedControl, Measurement } from '../contracts/public'
import type { DetectorState } from '../detection/detector'
import type { HydraulicState } from '../physics/state'
import { makeCheckpoint } from '../twin/checkpoint'
import type { CheckpointAnchor } from '../twin/checkpoint'
import { freezeWindow } from './history'
import type { History } from './history'
import type { DiagnosticWindow } from './inference-schedule'
import { freezeNominalPredictionCache } from './nominal-prediction-history'
import type { NominalPredictionHistory } from './nominal-prediction-history'

export function buildDiagnosticJob(
  id: string,
  window: DiagnosticWindow,
  detector: DetectorState,
  history: History<readonly Measurement[], readonly HydraulicState[]>,
  anchors: readonly CheckpointAnchor[],
  controls: readonly AppliedControl[],
  nominalPredictions?: NominalPredictionHistory | null,
): DiagnosticJob | null {
  const { calibration, warmupFit, canLocalize } = detector
  if (!calibration || !warmupFit || !canLocalize || anchors.length !== 9) return null
  const frozen = freezeWindow(history, window.endUs, window.durationUs)
  if (!frozen || frozen.checkpoint.length !== anchors.length) return null
  const appliedControls = controls.filter((control) => control.appliedTimeUs <= window.endUs)
  const controlRevision = appliedControls.at(-1)?.controlRevision ?? 0
  const checkpointRevision = appliedControls.findLast((control) => control.appliedTimeUs <= frozen.checkpointTimeUs)?.controlRevision ?? 0
  const job: DiagnosticJob = {
    jobId: id, modelVersion: calibration.modelVersion, profileId: calibration.profileId,
    bankVersion: calibration.bankVersion, calibrationId: calibration.calibrationId, controlRevision,
    requestedAtUs: window.endUs, windowStartUs: window.startUs, windowEndUs: window.endUs, deliveredThroughUs: window.endUs,
    checkpointsByAnchor: frozen.checkpoint.map((state, index) => makeCheckpoint(state, anchors[index]!, checkpointRevision)),
    frozenBaselines: warmupFit.frozenBaselines.map(({ anchorId, meanBySensor }) => ({ anchorId, meanResidualSI: meanBySensor })),
    observations: frozen.frames.flat().filter((sample) => sample.deliveredTimeUs <= window.endUs),
    appliedControls,
    searchBudget: { quantumEvaluations: 64, evaluationLimit: 512, wallLimitMs: 5000 },
  }
  const nominalPredictionCache = freezeNominalPredictionCache(nominalPredictions, frozen.checkpoint, job)
  return nominalPredictionCache ? { ...job, nominalPredictionCache } : job
}

export function canCommitResult(job: DiagnosticJob, candidate: DiagnosticResult | ProvisionalDiagnostic, latest: DiagnosticResult | null): boolean {
  return candidate.jobId === job.jobId && candidate.calibrationId === job.calibrationId
    && candidate.modelVersion === job.modelVersion && candidate.bankVersion === job.bankVersion
    && candidate.profileId === job.profileId && candidate.controlRevision === job.controlRevision
    && candidate.observedThroughUs === job.windowEndUs
    && (latest === null || latest.observedThroughUs <= candidate.observedThroughUs)
}
