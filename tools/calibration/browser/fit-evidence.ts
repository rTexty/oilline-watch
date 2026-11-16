import type { Calibration } from '../../../src/contracts/calibration'
import type { DiagnosticJob, DiagnosticResult } from '../../../src/contracts/inference'
import type { InferenceAuditJob } from '../../../src/contracts/inference-audit'
import type { SensorId } from '../../../src/contracts/public'
import { assessWithdrawalFit } from '../../../src/detection/hypothesis-decision'
import { prepareFit } from '../../../src/detection/hypotheses'

type FitJob = Pick<DiagnosticJob, 'jobId' | 'calibrationId' | 'observations' | 'frozenBaselines' |
  'windowStartUs' | 'windowEndUs' | 'deliveredThroughUs'>
type FitAudit = Pick<InferenceAuditJob, 'jobId' | 'stopReason' | 'closure' | 'decisionReplay'>
type FitCalibration = Pick<Calibration, 'calibrationId' | 'noise'>
type FitResult = Pick<DiagnosticResult, 'jobId' | 'calibrationId' | 'hypotheses' | 'availability' | 'searchComplete' | 'stopReason'>

function countObservationPairs(job: FitJob, calibration: FitCalibration | undefined): number | null {
  const baseline = job.frozenBaselines[0]
  if (!calibration || calibration.calibrationId !== job.calibrationId || baseline?.anchorId !== 0) return null
  const channel = (sensor: SensorId) => ({ ...calibration.noise[sensor], baselineSI: baseline.meanResidualSI[sensor] })
  try {
    return prepareFit(job.observations, { P1: channel('P1'), P2: channel('P2'), P3: channel('P3'), Qin: channel('Qin') },
      job.windowStartUs, job.windowEndUs, job.deliveredThroughUs).pairs.length
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

function collectFitEvidence(
  job: FitJob, record: Pick<FitAudit, 'jobId' | 'stopReason' | 'closure'>, result: FitResult | undefined,
  calibration?: FitCalibration,
) {
  const { jobId, stopReason, closure } = record
  const observationPairCount = jobId === job.jobId ? countObservationPairs(job, calibration) : null
  const nominal = result?.hypotheses.find(({ model }) => model === 'M0')
  const sensor = result?.hypotheses.find(({ model }) => model === 'MS')
  const J0 = nominal?.score ?? null
  const JL = result?.hypotheses.find(({ model }) => model === 'ML')?.score ?? null
  const JB = result?.hypotheses.find(({ model }) => model === 'MB')?.score ?? null
  const JS = sensor?.score ?? null
  const { statistics } = assessWithdrawalFit({
    scores: { M0: J0, ML: JL, MB: JB, MS: JS },
    observations: observationPairCount ?? 0,
    completed: !closure && stopReason === 'complete' && result?.searchComplete === true
      && nominal?.completed === true && sensor?.completed === true,
    available: result?.availability === 'available',
    positiveWithdrawal: false,
    profileQualified: false,
  }, null)
  const { windowStartUs, windowEndUs, deliveredThroughUs } = job
  return { jobId, windowStartUs, windowEndUs, deliveredThroughUs, observationPairCount, J0, JL, JB, JS,
    stopReason, closure: closure ?? null, availability: result?.availability ?? null,
    searchComplete: result?.searchComplete ?? null, statistics }
}

export function collectPacedFitEvidence(job: FitJob, record: FitAudit, calibration?: FitCalibration) {
  return collectFitEvidence(job, record, record.decisionReplay?.result, calibration)
}

export function collectOfflineFitEvidence(job: FitJob, result: FitResult, calibration: FitCalibration) {
  if (result.jobId !== job.jobId || result.calibrationId !== job.calibrationId || calibration.calibrationId !== job.calibrationId) {
    return null
  }
  return collectFitEvidence(job, result, result, calibration)
}
