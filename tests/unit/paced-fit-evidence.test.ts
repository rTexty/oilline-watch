import { describe, expect, it } from 'vitest'
import type { Calibration } from '../../src/contracts/calibration'
import type { DiagnosticJob, DiagnosticResult } from '../../src/contracts/inference'
import type { InferenceAuditJob } from '../../src/contracts/inference-audit'
import type { Measurement } from '../../src/contracts/public'
import { collectPacedFitEvidence } from '../../tools/calibration/browser/fit-evidence'

const channel = { sigmaSI: 1, rho: 0 }
const calibration = { calibrationId: 'cal', noise: { P1: channel, P2: channel, P3: channel, Qin: channel } } as Pick<Calibration, 'calibrationId' | 'noise'>
const reading = (seq: number, extra: Partial<Measurement> = {}): Measurement => ({
  sensorId: 'P1', sampleSeq: seq, sampleTimeUs: seq * 10_000, deliveredTimeUs: seq * 10_000,
  valueSI: 1, quality: 'valid', ...extra,
})
const job = {
  jobId: 'job', calibrationId: 'cal', windowStartUs: 10_000, windowEndUs: 90_000, deliveredThroughUs: 80_000,
  observations: [reading(0), reading(1), reading(2), reading(2, { deliveredTimeUs: 25_000 }),
    reading(3, { quality: 'missing', valueSI: null }), reading(4), reading(5), reading(7), reading(8), reading(9)],
  frozenBaselines: [{ anchorId: 0, meanResidualSI: { P1: 0, P2: 0, P3: 0, Qin: 0 } }],
} as Pick<DiagnosticJob, 'jobId' | 'calibrationId' | 'observations' | 'frozenBaselines' | 'windowStartUs' | 'windowEndUs' | 'deliveredThroughUs'>
const hypotheses = (scores = [10, 12, 9, 8], completed = true): DiagnosticResult['hypotheses'] =>
  (['M0', 'ML', 'MB', 'MS'] as const).map((model, index) => ({ model, score: scores[index]!, completed, support: 'unresolved' as const }))
const result = {
  jobId: 'job', searchComplete: true, stopReason: 'complete', availability: 'available', hypotheses: hypotheses(),
} as DiagnosticResult
const record = {
  jobId: 'job', stopReason: 'complete', decisionReplay: { result, wallStopCheck: null, dictionaryLoaded: true },
} as Pick<InferenceAuditJob, 'jobId' | 'stopReason' | 'closure' | 'decisionReplay'>

describe('paced fit evidence', () => {
  it('counts causal adjacent pairs and preserves raw scores and negative contrasts', () => {
    expect(collectPacedFitEvidence(job, record, calibration)).toEqual({
      jobId: 'job', windowStartUs: 10_000, windowEndUs: 90_000, deliveredThroughUs: 80_000,
      observationPairCount: 3, J0: 10, JL: 12, JB: 9, JS: 8, stopReason: 'complete', closure: null,
      availability: 'available', searchComplete: true,
      statistics: { improvement: -2, separation: -4, absoluteFit: 4 },
    })
  })

  it.each([
    ['incomplete', { ...record, stopReason: 'wall-limit', decisionReplay: { ...record.decisionReplay!, result: { ...result, stopReason: 'wall-limit', searchComplete: false } } }],
    ['discarded', { ...record, closure: 'discarded' }],
    ['missing terminal result', { ...record, decisionReplay: undefined }],
    ['missing score', { ...record, decisionReplay: { ...record.decisionReplay!, result: { ...result, hypotheses: hypotheses().map((h) => h.model === 'MB' ? { ...h, score: null } : h) } } }],
    ['unavailable', { ...record, decisionReplay: { ...record.decisionReplay!, result: { ...result, availability: 'missing' } } }],
    ['nominal incomplete', { ...record, decisionReplay: { ...record.decisionReplay!, result: { ...result, hypotheses: hypotheses().map((h) => h.model === 'M0' ? { ...h, completed: false } : h) } } }],
    ['sensor incomplete', { ...record, decisionReplay: { ...record.decisionReplay!, result: { ...result, hypotheses: hypotheses().map((h) => h.model === 'MS' ? { ...h, completed: false } : h) } } }],
  ] as const)('withholds statistics for %s evidence', (_name, audit) => {
    expect(collectPacedFitEvidence(job, audit, calibration).statistics).toBeNull()
  })

  it.each([undefined, { ...calibration, calibrationId: 'other' }])('fails closed without matching calibration', (candidate) => {
    expect(collectPacedFitEvidence(job, record, candidate)).toMatchObject({ observationPairCount: null, statistics: null })
  })
})
