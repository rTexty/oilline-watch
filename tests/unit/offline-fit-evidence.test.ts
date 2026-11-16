import { describe, expect, it } from 'vitest'
import { calibrationSchema } from '../../src/contracts/calibration'
import type { DiagnosticJob, DiagnosticResult } from '../../src/contracts/inference'
import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../../src/contracts/public'
import type { Measurement, SensorId } from '../../src/contracts/public'
import { collectOfflineFitEvidence } from '../../tools/calibration/browser/fit-evidence'

const jobId = '8dc30484-3d7f-4bc2-8323-a432db7e7ca1'
const calibrationId = 'a'.repeat(64)
const digest = 'b'.repeat(64)
const pressureNoise = { sigmaSI: 500, rho: 0.6 }
const calibration = calibrationSchema.parse({
  schemaVersion: 1, calibrationId, modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1',
  sensorProfileId: 'synthetic-oil-nominal-v1', releaseScope: 'passive',
  hashes: { model: digest, profile: digest, bank: digest, sensor: digest, policy: digest, dictionary: digest,
    fit: digest, calibration: digest, development: digest },
  noise: { P1: pressureNoise, P2: pressureNoise, P3: pressureNoise, Qin: { sigmaSI: 5e-5, rho: 0.3 } },
  thresholds: { cusumFast: 3, cusumSlow: 3, improvement: 100, separation: 100, absoluteFit: 0, profile: 1, envelope: 1 },
  errorEnvelope: { numericalFloor: 0, multiplier: 1, qualified: false },
  qualification: { quantitative: false, active: false }, reportHash: digest,
})

function reading(sensorId: SensorId, sampleSeq: number, changes: Partial<Measurement> = {}): Measurement {
  const sampleTimeUs = sampleSeq * (sensorId === 'Qin' ? FLOW_PERIOD_US : PRESSURE_PERIOD_US)
  return { sensorId, sampleSeq, sampleTimeUs, deliveredTimeUs: sampleTimeUs,
    valueSI: sensorId === 'Qin' ? 0.025 : 1e6, quality: 'valid', ...changes }
}

const job = {
  jobId, calibrationId, windowStartUs: 56_000_000, windowEndUs: 60_000_000, deliveredThroughUs: 60_010_000,
  observations: [
    reading('P1', 5599), reading('P1', 5600), reading('P1', 5601), reading('P1', 5601, { deliveredTimeUs: 56_020_000 }),
    reading('P1', 5602, { quality: 'missing', valueSI: null }), reading('P1', 5603), reading('P1', 5604),
    reading('P1', 5606), reading('P1', 5607), reading('P1', 5999), reading('P1', 6000, { deliveredTimeUs: 60_020_000 }),
    reading('Qin', 1122), reading('Qin', 1120), reading('Qin', 1121),
  ],
  frozenBaselines: [{ anchorId: 0, meanResidualSI: { P1: 12, P2: 0, P3: 0, Qin: 1e-6 } }],
} as const satisfies Pick<DiagnosticJob, 'jobId' | 'calibrationId' | 'windowStartUs' | 'windowEndUs' |
  'deliveredThroughUs' | 'observations' | 'frozenBaselines'>
const result: DiagnosticResult = {
  jobId, calibrationId, modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1', controlRevision: 0,
  observedThroughUs: job.windowEndUs, finishedAtUs: 60_300_000, completedEvaluations: 4,
  searchComplete: true, stopReason: 'complete', fitQuality: 'unqualified', availability: 'available', assumptions: [],
  hypotheses: [
    { model: 'M0', score: 10, completed: true, support: 'unresolved' },
    { model: 'ML', score: 12, completed: true, support: 'unresolved' },
    { model: 'MB', score: 9, completed: true, support: 'unresolved' },
    { model: 'MS', score: 8, completed: true, support: 'unresolved' },
  ],
  compatibleRegions: [],
}

describe('offline fit evidence', () => {
  it('uses three pressure and two flow innovation pairs, preserving raw scores and contrasts without a fit threshold', () => {
    expect(collectOfflineFitEvidence(job, result, calibration)).toEqual({
      jobId, windowStartUs: job.windowStartUs, windowEndUs: job.windowEndUs, deliveredThroughUs: job.deliveredThroughUs,
      observationPairCount: 5, J0: 10, JL: 12, JB: 9, JS: 8, stopReason: 'complete', closure: null,
      availability: 'available', searchComplete: true, statistics: { improvement: -2, separation: -4, absoluteFit: 2.4 },
    })
  })

  it.each([
    ['incomplete search', { ...result, searchComplete: false, stopReason: 'wall-limit' }],
    ['unavailable result', { ...result, availability: 'missing' }],
    ['incomplete nominal fit', { ...result, hypotheses: result.hypotheses.map((row) => row.model === 'M0' ? { ...row, completed: false } : row) }],
    ['incomplete sensor fit', { ...result, hypotheses: result.hypotheses.map((row) => row.model === 'MS' ? { ...row, completed: false } : row) }],
    ['missing boundary score', { ...result, hypotheses: result.hypotheses.map((row) => row.model === 'MB' ? { ...row, score: null } : row) }],
  ] as const)('withholds fit statistics but retains matched observation evidence for %s', (_name, candidate) => {
    expect(collectOfflineFitEvidence(job, candidate, calibration)).toMatchObject({
      jobId, observationPairCount: 5, J0: 10, JL: 12, JS: 8, statistics: null,
    })
  })

  it('reports zero innovation pairs without manufacturing statistics', () => {
    const isolated = { ...job, observations: [reading('P1', 5600), reading('Qin', 1120)] }
    expect(collectOfflineFitEvidence(isolated, result, calibration)).toMatchObject({
      jobId, observationPairCount: 0, statistics: null,
    })
  })

  it('rejects mismatched job and calibration identities without attributing evidence', () => {
    const otherJob = { ...result, jobId: '50f5f0bf-f0c5-4380-9799-7d58e54169cb' }
    const otherCalibration = { ...calibration, calibrationId: 'c'.repeat(64) }
    expect(collectOfflineFitEvidence(job, otherJob, calibration)).toBeNull()
    expect(collectOfflineFitEvidence(job, { ...result, calibrationId: otherCalibration.calibrationId }, calibration)).toBeNull()
    expect(collectOfflineFitEvidence(job, result, otherCalibration)).toBeNull()
  })
})
