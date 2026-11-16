import { describe, expect, it } from 'vitest'
import type { DiagnosticResult } from '../../src/contracts/inference'
import { inferenceAuditSchema } from '../../src/contracts/inference-audit'
import type { InferenceAuditJob, InferenceAuditTransition } from '../../src/contracts/inference-audit'
import { extractPacedObservation } from '../../tools/calibration/browser/paced-evidence'

const bindings = {
  terminalUs: 330_000_000, phase: 'completed', sensor: 'adverse', calibrationId: 'a'.repeat(64),
  policySha256: 'b'.repeat(64), dictionarySha256: 'c'.repeat(64),
} as const
const clock = { timeUs: bindings.terminalUs, phase: bindings.phase, closureEvidenceMissing: false } as const
const jobId = '8dc30484-3d7f-4bc2-8323-a432db7e7ca1'
const cancelledId = '50f5f0bf-f0c5-4380-9799-7d58e54169cb'
const supersededId = '4fb8d8a2-1e90-489e-9734-7eddfda40cc1'
const neverAdmittedId = 'b63e6a41-4f9c-4419-a6e5-ef27336e7618'
const result: DiagnosticResult = {
  jobId, modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1', calibrationId: bindings.calibrationId,
  controlRevision: 2, observedThroughUs: 60_000_000, finishedAtUs: 60_300_000, completedEvaluations: 3,
  searchComplete: true, stopReason: 'complete', fitQuality: 'good', availability: 'available', assumptions: [],
  hypotheses: [
    { model: 'M0', score: 10, completed: true, support: 'unsupported' },
    { model: 'ML', score: 2, completed: true, support: 'compatible' },
    { model: 'MB', score: 8, completed: true, support: 'unsupported' },
    { model: 'MS', score: 6, completed: true, support: 'unsupported' },
  ],
  compatibleRegions: [{ startM: 450, endM: 550, status: 'compatible' }],
}
const job: InferenceAuditJob = {
  jobId, startUs: 56_000_000, endUs: result.observedThroughUs, startedAtUs: 60_020_000, finishedAtUs: result.finishedAtUs,
  wallLimitMs: 5000, evaluationLimit: 512, stopReason: 'complete', completedEvaluations: 3,
  trials: [['M0', 0, 10], ['ML', 0, 100, 1e-5, 60_000_000, 0, 2], ['MB', 0, 0.003, 60_000_000, 0, 8]],
  decisionReplay: { wallStopCheck: null, dictionaryLoaded: true, result },
  provisional: {
    check: 10, publishedAtUs: 60_050_000,
    result: {
      jobId, modelVersion: result.modelVersion, profileId: result.profileId, bankVersion: result.bankVersion,
      calibrationId: result.calibrationId, controlRevision: result.controlRevision, observedThroughUs: result.observedThroughUs,
      completedEvaluations: 2, scores: { M0: 10, ML: 2, MB: null, MS: null },
    },
  },
}
const timeline: readonly InferenceAuditTransition[] = [
  ['requested', jobId, job.endUs, job.startUs], ['admitted', jobId, job.startedAtUs],
  ['finished', jobId, job.finishedAtUs], ['committed', jobId, job.finishedAtUs],
  ['requested', cancelledId, 66_000_000, 62_000_000], ['admitted', cancelledId, 66_020_000], ['cancelled', cancelledId, 66_025_000],
]
const fullTimeline: readonly InferenceAuditTransition[] = [
  ...timeline.slice(0, 4), ['requested', cancelledId, 325_000_000, 321_000_000], ['admitted', cancelledId, 325_000_000],
  ['requested', neverAdmittedId, 325_000_000, 295_000_000],
  ['requested', supersededId, 328_000_000, 324_000_000], ['superseded', supersededId, 328_000_000],
  ['cancelled', cancelledId, clock.timeUs], ['cancelled', neverAdmittedId, clock.timeUs],
]
const policyAudit = { jobs: [job], warmup: null, resourceLimited: false } as const
const budget = {
  jobId, evaluationLimit: 512, wallLimitMs: 5000, completedEvaluations: 3, nominalCacheHits: 0, stopReason: 'complete',
  windowUs: 4_000_000, modelElapsedUs: 280_000, wallRoundTripMs: 123.5, closure: null,
  provisionalMs: 22, finalPageMs: 126.5, finalDisposition: 'committed',
} as const
const committedReceipt = { jobId, publishedAtUs: 60_050_000, submittedMs: 21.5,
  provisionalMs: budget.provisionalMs, finalPageMs: budget.finalPageMs, finalDisposition: budget.finalDisposition } as const
const cancelledReceipt = { jobId: cancelledId, publishedAtUs: 325_010_000, submittedMs: 15,
  provisionalMs: 16.5, finalPageMs: null, finalDisposition: null } as const
const statistics = { improvement: 8, separation: 4, absoluteFit: 0.5 } as const
const fitEvidence = {
  jobId, windowStartUs: job.startUs, windowEndUs: job.endUs, deliveredThroughUs: job.endUs, observationPairCount: 4,
  J0: 10, JL: 2, JB: 8, JS: 6, stopReason: 'complete', closure: null, availability: 'available', searchComplete: true, statistics,
} as const

const detectorTrace = {
  status: 'observed', lastDetectorStatus: 'ready', deliveredThroughUs: 330_000_000, observedThroughUs: 329_980_000,
  availableUs: 299_980_000, processedChallengeCohorts: 29_998,
  exposure: [{ firstCohortUs: 30_010_000, lastCohortUs: 329_980_000, ready: true, canLocalize: true }],
  episodes: [{ openedAtUs: 60_020_000, openingCohortUs: 60_000_000, closedAtUs: 70_020_000, closingCohortUs: 70_000_000 }],
} as const
const detector = { ...clock, detectorTrace, alarmTimesUs: [60_020_000] } as const
const physicalBindings = { ...bindings, terminalUs: 72_005_000, phase: 'invalid' } as const
const failedTrace = {
  status: 'failed', lastDetectorStatus: 'ready', deliveredThroughUs: 72_000_000, observedThroughUs: 71_980_000,
  availableUs: 41_960_000, processedChallengeCohorts: 4198,
  exposure: [
    { firstCohortUs: 30_010_000, lastCohortUs: 39_990_000, ready: true, canLocalize: true },
    { firstCohortUs: 40_000_000, lastCohortUs: 40_010_000, ready: false, canLocalize: false },
    { firstCohortUs: 40_020_000, lastCohortUs: 71_980_000, ready: true, canLocalize: true },
  ],
  episodes: [detectorTrace.episodes[0], {
    openedAtUs: 71_520_000, openingCohortUs: 71_500_000, closedAtUs: null, closingCohortUs: null,
  }],
} as const
const physicalDetector = {
  ...clock, timeUs: physicalBindings.terminalUs, phase: physicalBindings.phase, failure: 'outside-model-domain',
  detectorTrace: failedTrace, alarmTimesUs: [60_020_000, 71_520_000],
} as const
const resultClock = { jobId, observedThroughUs: result.observedThroughUs, finishedAtUs: result.finishedAtUs, controlRevision: result.controlRevision }
const support = { seq: 1, publicationUs: 60_310_000, ...resultClock, regions: result.compatibleRegions } as const
const supported = {
  seq: support.seq, publicationUs: support.publicationUs, phase: 'running', visible: true, status: 'supported',
  result: resultClock, provisionalJobId: null,
} as const
const terminalTransition = {
  seq: 2, publicationUs: clock.timeUs, phase: clock.phase, visible: true, status: 'no-current-result',
  result: null, provisionalJobId: null,
} as const
const publicDiagnosticTrace = {
  status: 'observed', terminalSnapshot: { seq: 2, timeUs: clock.timeUs, phase: clock.phase },
  coverage: { accepted: 3, lastSeq: 2, duplicates: 0, invalid: 0, missingSequences: 0, clockRegressions: 0, overflow: false },
  transitions: [
    { ...terminalTransition, seq: 0, publicationUs: 0, phase: 'warming-up', status: 'unarmed' }, supported, terminalTransition,
  ],
  mismatchedJobIds: [], firstVisibleSupports: [support],
} as const
const audited = { ...detector, policyAudit, timeline, budgets: [budget], fitEvidence: [fitEvidence] } as const
const fullAudited = { ...audited, timeline: fullTimeline, closureEvidenceMissing: true } as const

describe('paced acquisition evidence', () => {
  it('reports adverse exposure from the first challenge cohort and alarms on the published model clock', () => {
    expect(extractPacedObservation(detector, bindings).cusum).toEqual({
      status: 'observed', availableUs: 299_980_000, alarmTimesUs: [60_020_000],
    })
  })

  it.each([
    ['delivery clock', { ...detectorTrace, deliveredThroughUs: 329_990_000 }],
    ['observed cohort clock', { ...detectorTrace, observedThroughUs: 330_000_000 }],
    ['exposure gap', { ...detectorTrace, exposure: [{ ...detectorTrace.exposure[0], firstCohortUs: 30_020_000 }] }],
    ['processed count', { ...detectorTrace, processedChallengeCohorts: 30_000 }],
    ['exposure sum', { ...detectorTrace, availableUs: 300_000_000 }],
    ['alarm cohort offset', { ...detectorTrace, episodes: [{ ...detectorTrace.episodes[0], openingCohortUs: 60_010_000 }] }],
  ] as const)('fails closed on a false detector %s', (_name, trace) => {
    expect(extractPacedObservation({ ...detector, detectorTrace: trace }, bindings).cusum)
      .toEqual({ status: 'invalid', availableUs: null, alarmTimesUs: null })
  })

  it('rejects alarm times that disagree with the authoritative episodes', () => {
    expect(extractPacedObservation({ ...detector, alarmTimesUs: [60_000_000] }, bindings).cusum)
      .toEqual({ status: 'invalid', availableUs: null, alarmTimesUs: null })
  })

  it('keeps absent evidence distinct from observed zeros', () => {
    const observed = extractPacedObservation(clock, bindings)
    expect(observed.cusum).toEqual({ status: 'missing', availableUs: null, alarmTimesUs: null })
    expect(observed.inference).toEqual({ status: 'missing', jobs: null })
    expect(observed.publications).toEqual({ status: 'missing', firstVisibleSupports: null })
    const noAlarms = { ...detector, detectorTrace: { ...detectorTrace, episodes: [] }, alarmTimesUs: [] }
    expect(extractPacedObservation(noAlarms, bindings).cusum).toEqual({
      status: 'observed', availableUs: detectorTrace.availableUs, alarmTimesUs: [],
    })
  })

  it('distinguishes an observed but unavailable detector from missing evidence', () => {
    const trace = {
      ...detectorTrace, status: 'unavailable', lastDetectorStatus: 'insufficient-data', availableUs: 0,
      exposure: [{ ...detectorTrace.exposure[0], ready: false, canLocalize: false }], episodes: [],
    }
    expect(extractPacedObservation({ ...detector, detectorTrace: trace, alarmTimesUs: [] }, bindings).cusum.status)
      .toBe('unavailable')
  })

  it.each(['outside-model-domain', 'uncertain-flow-regime'] as const)('preserves an exact detector prefix before %s', (failure) => {
    const observed = extractPacedObservation({ ...physicalDetector, failure }, physicalBindings)
    expect(observed.cusum).toEqual({
      status: 'observed-prefix', deliveredThroughUs: 72_000_000, observedThroughUs: 71_980_000,
      availableUs: 41_960_000, alarmTimesUs: [60_020_000, 71_520_000],
    })
    expect(observed.alarmEpisodes).toEqual(failedTrace.episodes)
  })

  it.each([
    ['delivery after terminal', {
      ...failedTrace, deliveredThroughUs: 72_010_000, observedThroughUs: 71_990_000,
      availableUs: 41_970_000, processedChallengeCohorts: 4199,
      exposure: [failedTrace.exposure[0], failedTrace.exposure[1], { ...failedTrace.exposure[2], lastCohortUs: 71_990_000 }],
    }, physicalDetector.alarmTimesUs],
    ['exposure hole', {
      ...failedTrace, availableUs: 41_950_000,
      exposure: [failedTrace.exposure[0], failedTrace.exposure[1], { ...failedTrace.exposure[2], firstCohortUs: 40_030_000 }],
    }, physicalDetector.alarmTimesUs],
    ['wrong adverse delivery delay', {
      ...failedTrace, observedThroughUs: 71_990_000, availableUs: 41_970_000, processedChallengeCohorts: 4199,
      exposure: [failedTrace.exposure[0], failedTrace.exposure[1], { ...failedTrace.exposure[2], lastCohortUs: 71_990_000 }],
    }, physicalDetector.alarmTimesUs],
    ['receipt beyond the prefix', failedTrace, [60_020_000, 71_520_000, 72_010_000]],
    ['episode opened in non-ready exposure', {
      ...failedTrace, episodes: [{ ...failedTrace.episodes[0], openedAtUs: 40_020_000, openingCohortUs: 40_000_000 }, failedTrace.episodes[1]],
    }, [40_020_000, 71_520_000]],
  ] as const)('rejects a physical failure prefix with %s', (_name, detectorTrace, alarmTimesUs) => {
    const observed = extractPacedObservation({ ...physicalDetector, detectorTrace, alarmTimesUs }, physicalBindings)
    expect(observed.cusum).toEqual({ status: 'invalid', availableUs: null, alarmTimesUs: null })
    expect(observed.alarmEpisodes).toBeNull()
  })

  it('rejects an episode closing after the detector prefix but before the physical terminal', () => {
    const terminalUs = 72_015_000
    const episodes = [failedTrace.episodes[0], { ...failedTrace.episodes[1], closedAtUs: 72_010_000, closingCohortUs: 71_990_000 }]
    const observed = extractPacedObservation({ ...physicalDetector, timeUs: terminalUs, detectorTrace: { ...failedTrace, episodes } },
      { ...physicalBindings, terminalUs })
    expect(observed.cusum).toEqual({ status: 'invalid', availableUs: null, alarmTimesUs: null })
    expect(observed.alarmEpisodes).toBeNull()
  })

  it('retains an exact physical prefix with zero ready exposure but rejects a complete observed trace with zero exposure', () => {
    const noReadyExposure = (lastCohortUs: number) => [{ firstCohortUs: 30_010_000, lastCohortUs, ready: false, canLocalize: false }]
    const prefix = extractPacedObservation({ ...physicalDetector, alarmTimesUs: [], detectorTrace: {
      ...failedTrace, lastDetectorStatus: 'insufficient-data', availableUs: 0, episodes: [], exposure: noReadyExposure(71_980_000),
    } }, physicalBindings)
    expect(prefix.cusum).toEqual({
      status: 'observed-prefix', deliveredThroughUs: 72_000_000, observedThroughUs: 71_980_000, availableUs: 0, alarmTimesUs: [],
    })
    expect(prefix.alarmEpisodes).toEqual([])
    const complete = extractPacedObservation({ ...detector, alarmTimesUs: [], detectorTrace: {
      ...detectorTrace, lastDetectorStatus: 'insufficient-data', availableUs: 0, episodes: [], exposure: noReadyExposure(329_980_000),
    } }, bindings)
    expect(complete.cusum).toEqual({ status: 'invalid', availableUs: null, alarmTimesUs: null })
  })

  it('withholds the detector prefix on a technical failure or when physical failure evidence is absent', () => {
    const technical = { ...physicalDetector, phase: 'error', failure: 'worker-error' }
    const technicalFailure = extractPacedObservation(technical, { ...physicalBindings, phase: 'error' })
    const missingTrace = extractPacedObservation({ ...physicalDetector, detectorTrace: null, alarmTimesUs: undefined }, physicalBindings)
    expect(technicalFailure.cusum).toEqual({ status: 'unavailable', availableUs: null, alarmTimesUs: null })
    expect(technicalFailure.alarmEpisodes).toBeNull()
    expect(missingTrace.cusum).toEqual({ status: 'missing', availableUs: null, alarmTimesUs: null })
    expect(missingTrace.alarmEpisodes).toBeNull()
  })

  it('retains admitted cancellations separately from committed jobs with fit and timings', () => {
    expect(inferenceAuditSchema.safeParse({
      version: 1, solver: 'typescript-f64', calibrationId: bindings.calibrationId, policySha256: bindings.policySha256,
      dictionarySha256: bindings.dictionarySha256, jobs: policyAudit.jobs, resourceLimited: false, transitions: timeline,
    }).success).toBe(true)
    const inference = extractPacedObservation(audited, bindings).inference
    expect(inference.status).toBe('observed')
    expect(inference.jobs).toHaveLength(2)
    expect(inference.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jobId, admittedAtUs: job.startedAtUs, disposition: 'committed', stopReason: 'complete',
        provisionalMs: 22, provisionalAudit: 'verified', finalPageMs: 126.5, wallRoundTripMs: 123.5, statistics,
        provisionalPublishedAtUs: 60_050_000, provisionalSubmittedMs: null,
      }),
      expect.objectContaining({
        jobId: cancelledId, admittedAtUs: 66_020_000, disposition: 'cancelled',
        provisionalMs: null, provisionalAudit: null, finalPageMs: null, wallRoundTripMs: null, statistics: null,
      }),
    ]))
  })

  it('retains all ticket dispositions and distinguishes audited and unaudited provisional receipts', () => {
    const { inference } = extractPacedObservation({
      ...fullAudited, provisionalByJob: [cancelledReceipt, committedReceipt],
    }, bindings)
    expect(inference).toMatchObject({
      status: 'observed', schedule: [
        { jobId, windowStartUs: job.startUs, windowEndUs: job.endUs,
          admittedAtUs: job.startedAtUs, terminalAtUs: job.finishedAtUs, disposition: 'committed' },
        { jobId: cancelledId, windowStartUs: 321_000_000, windowEndUs: 325_000_000,
          admittedAtUs: 325_000_000, terminalAtUs: clock.timeUs, disposition: 'cancelled' },
        { jobId: neverAdmittedId, windowStartUs: 295_000_000, windowEndUs: 325_000_000,
          admittedAtUs: null, terminalAtUs: clock.timeUs, disposition: 'cancelled' },
        { jobId: supersededId, windowStartUs: 324_000_000, windowEndUs: 328_000_000,
          admittedAtUs: null, terminalAtUs: 328_000_000, disposition: 'superseded' },
      ], jobs: [
        { jobId, disposition: 'committed', provisionalMs: 22, provisionalAudit: 'verified', finalPageMs: 126.5,
          provisionalPublishedAtUs: 60_050_000, provisionalSubmittedMs: 21.5 },
        { jobId: cancelledId, disposition: 'cancelled', provisionalMs: 16.5, provisionalAudit: 'unverified',
          provisionalPublishedAtUs: 325_010_000, provisionalSubmittedMs: 15,
          finalPageMs: null, wallRoundTripMs: null, statistics: null },
      ],
      workload: { all: { unverifiedProvisionalReceipts: 1 } },
    })
  })

  it.each([
    ['missing admission', [committedReceipt]],
    ['duplicate receipt', [committedReceipt, cancelledReceipt, cancelledReceipt]],
    ['non-admitted ticket', [committedReceipt, cancelledReceipt, { ...cancelledReceipt, jobId: supersededId }]],
    ['audited marker time mismatch', [{ ...committedReceipt, publishedAtUs: 60_060_000 }, cancelledReceipt]],
    ['marker before admission', [committedReceipt, { ...cancelledReceipt, publishedAtUs: 324_990_000 }]],
    ['marker after cancellation', [committedReceipt, { ...cancelledReceipt, publishedAtUs: 330_010_000 }]],
    ['provisional timing mismatch with budget', [{ ...committedReceipt, provisionalMs: 23 }, cancelledReceipt]],
    ['final timing mismatch with budget', [{ ...committedReceipt, finalPageMs: 127.5 }, cancelledReceipt]],
  ] as const)('rejects a provisional receipt ledger with %s', (_name, provisionalByJob) => {
    const { inference } = extractPacedObservation({ ...fullAudited, provisionalByJob }, bindings)
    expect(inference).toMatchObject({ status: 'invalid', jobs: null })
  })

  it('rejects an invalid requested window even when the ticket was never admitted', () => {
    const wrongWindow = fullTimeline.map((row) => row[0] === 'requested' && row[1] === supersededId
      ? [row[0], row[1], row[2], row[3] + 10_000] : row)
    const { inference } = extractPacedObservation({ ...fullAudited, timeline: wrongWindow }, bindings)
    expect(inference).toMatchObject({ status: 'invalid', jobs: null })
  })

  it('rejects an audit whose committed clock contradicts its completed job', () => {
    const broken = timeline.map((row) => row[0] === 'committed' ? [row[0], row[1], row[2] + 10_000] : row)
    expect(extractPacedObservation({ ...audited, timeline: broken }, bindings).inference)
      .toEqual({ status: 'invalid', jobs: null })
  })

  it('rejects provisional receipt timing without a matching audited checkpoint', () => {
    const unpublished = { ...job, provisional: undefined }
    const inference = extractPacedObservation({ ...audited, policyAudit: { ...policyAudit, jobs: [unpublished] } }, bindings).inference
    expect(inference).toEqual({ status: 'invalid', jobs: null })
  })

  it('rejects a committed page receipt disposition with no receipt time', () => {
    const inference = extractPacedObservation({ ...audited, budgets: [{ ...budget, finalPageMs: null }] }, bindings).inference
    expect(inference).toEqual({ status: 'invalid', jobs: null })
  })

  it('allows one millisecond of clock skew between the worker and final page receipt', () => {
    const measured = { ...budget, wallRoundTripMs: budget.finalPageMs + 1 }
    const { inference } = extractPacedObservation({ ...audited, budgets: [measured] }, bindings)
    expect(inference).toMatchObject({ status: 'observed' })
    expect(inference.jobs).toContainEqual(expect.objectContaining({ jobId, finalPageMs: 126.5, wallRoundTripMs: 127.5 }))
  })

  it('rejects a worker round trip more than one millisecond later than the final page receipt', () => {
    const measured = { ...budget, wallRoundTripMs: budget.finalPageMs + 1.125 }
    const { inference } = extractPacedObservation({ ...audited, budgets: [measured] }, bindings)
    expect(inference).toEqual({ status: 'invalid', jobs: null })
  })

  it('keeps an unavailable inference binding separate from observed audit rows', () => {
    const unavailable = { ...bindings, inferenceAvailable: false } as const
    const observation = extractPacedObservation(audited, unavailable)
    expect(observation.inference).toEqual({ status: 'unavailable', jobs: null })
    expect(observation.cusum.status).toBe('observed')
  })

  it('rejects fit evidence whose scores disagree with the replay result', () => {
    const fit = { ...fitEvidence, JL: 3, statistics: { improvement: 7, separation: 3, absoluteFit: 0.75 } }
    const inference = extractPacedObservation({ ...audited, fitEvidence: [fit] }, bindings).inference
    expect(inference).toEqual({ status: 'invalid', jobs: null })
  })

  it('retains the first visible supported publication bound to the committed replay result', () => {
    expect(extractPacedObservation({ ...audited, publicDiagnosticTrace }, bindings).publications)
      .toEqual({ status: 'observed', firstVisibleSupports: [support] })
  })

  it.each([
    ['control revision', { ...support, controlRevision: 3 }],
    ['observation clock', { ...support, observedThroughUs: support.observedThroughUs - 10_000 }],
    ['completion clock', { ...support, finishedAtUs: support.finishedAtUs - 10_000 }],
    ['publication clock', { ...support, publicationUs: support.publicationUs + 10_000 }],
    ['regions', { ...support, regions: [{ startM: 650, endM: 750, status: 'compatible' }] }],
    ['cancelled job ID', { ...support, jobId: cancelledId }],
  ] as const)('rejects forged support %s', (_name, forged) => {
    const trace = { ...publicDiagnosticTrace, firstVisibleSupports: [forged] }
    expect(extractPacedObservation({ ...audited, publicDiagnosticTrace: trace }, bindings).publications)
      .toEqual({ status: 'invalid', firstVisibleSupports: null })
  })

  it('rejects a publication whose only supported transition is hidden', () => {
    const transitions = [publicDiagnosticTrace.transitions[0], { ...supported, visible: false }, terminalTransition]
    const trace = { ...publicDiagnosticTrace, transitions }
    expect(extractPacedObservation({ ...audited, publicDiagnosticTrace: trace }, bindings).publications)
      .toEqual({ status: 'invalid', firstVisibleSupports: null })
  })

  it('rejects duplicate support attributed to the same committed job', () => {
    const trace = { ...publicDiagnosticTrace, firstVisibleSupports: [support, support] }
    expect(extractPacedObservation({ ...audited, publicDiagnosticTrace: trace }, bindings).publications)
      .toEqual({ status: 'invalid', firstVisibleSupports: null })
  })

  it('rejects visible support even if a discarded audit carries the matching result', () => {
    const discarded = {
      ...audited, publicDiagnosticTrace, policyAudit: { ...policyAudit, jobs: [{ ...job, closure: 'discarded' }] },
      timeline: [timeline[0]!, timeline[1]!, ['cancelled', jobId, job.finishedAtUs]],
      budgets: [{ ...budget, closure: 'discarded', finalDisposition: 'discarded' }],
      fitEvidence: [{ ...fitEvidence, closure: 'discarded', statistics: null }],
    } as const
    const extracted = extractPacedObservation(discarded, bindings)
    expect(extracted.inference).toMatchObject({ status: 'observed', jobs: [{ jobId, disposition: 'discarded', statistics: null }] })
    expect(extracted.publications).toEqual({ status: 'invalid', firstVisibleSupports: null })
  })

  it('keeps explicitly unobserved publications separate from observed runs with no supports', () => {
    const trace = { ...publicDiagnosticTrace, status: 'snapshot-gap', firstVisibleSupports: [],
      coverage: { ...publicDiagnosticTrace.coverage, accepted: 2, missingSequences: 1 }, transitions: [supported, terminalTransition] }
    expect(extractPacedObservation({ ...audited, publicDiagnosticTrace: trace }, bindings).publications)
      .toEqual({ status: 'snapshot-gap', firstVisibleSupports: null })
  })
})

describe('opt-in paced fit inputs', () => {
  const fitBindings = { ...bindings, includeFitInputs: true } as const
  const record = {
    deliveredThroughUs: job.endUs, observationPairCount: 4, J0: 10, JL: 2, JB: 8, JS: 6,
    availability: 'available', searchComplete: true,
  }

  it('exposes precisely the verified raw inputs for measured fits and marks unaudited cancellation unavailable', () => {
    const { inference } = extractPacedObservation(audited, fitBindings)
    expect(inference).toMatchObject({ status: 'observed', jobs: [{ jobId, statistics }, { jobId: cancelledId, statistics: null }] })
    expect(inference.jobs?.[0]).toHaveProperty('fitInput', { status: 'measured', reason: null, record })
    expect(inference.jobs?.[1]).toHaveProperty('fitInput', { status: 'unavailable', reason: 'cancelled', record: null })
  })

  it('distinguishes a committed job with no archived fit row from an opt-out', () => {
    const missing = extractPacedObservation({ ...audited, fitEvidence: undefined }, fitBindings).inference
    expect(missing).toMatchObject({ status: 'observed', jobs: [{ jobId, statistics: null }, { jobId: cancelledId }] })
    expect(missing.jobs?.[0]).toHaveProperty('fitInput', { status: 'missing', reason: 'fit-not-recorded', record: null })

    const legacy = extractPacedObservation(audited, bindings).inference
    expect(legacy.jobs).toHaveLength(2)
    for (const row of legacy.jobs ?? []) expect(row).not.toHaveProperty('fitInput')
  })

  it('retains verified raw inputs when a committed search stops at its evaluation limit', () => {
    const partial = {
      ...result, stopReason: 'evaluation-limit', searchComplete: false, fitQuality: 'unqualified', compatibleRegions: [],
      hypotheses: result.hypotheses.map(({ model }) => ({
        model, score: model === 'M0' ? 10 : null, completed: false, support: 'unresolved',
      })),
    }
    const incompleteJob = {
      ...job, evaluationLimit: 3, stopReason: 'evaluation-limit', provisional: undefined,
      trials: [['M0', 0, 10], ['M0', 1, 12], ['M0', 2, 14]], decisionReplay: { ...job.decisionReplay, result: partial },
    }
    const { inference } = extractPacedObservation({
      ...audited, policyAudit: { ...policyAudit, jobs: [incompleteJob] },
      budgets: [{ ...budget, evaluationLimit: 3, stopReason: 'evaluation-limit', provisionalMs: null }],
      fitEvidence: [{ ...fitEvidence, stopReason: 'evaluation-limit', searchComplete: false, JL: null, JB: null, JS: null, statistics: null }],
    }, fitBindings)
    expect(inference).toMatchObject({ status: 'observed', jobs: [{ jobId, disposition: 'committed', statistics: null }, { jobId: cancelledId }] })
    expect(inference.jobs?.[0]).toHaveProperty('fitInput', {
      status: 'unavailable', reason: 'search-incomplete', record: { ...record, searchComplete: false, JL: null, JB: null, JS: null },
    })
  })

  it('marks discarded inputs unavailable and preserves a verified raw row when recorded', () => {
    const terminalUs = job.finishedAtUs
    const discarded = {
      ...clock, timeUs: terminalUs, policyAudit: { ...policyAudit, jobs: [{ ...job, closure: 'discarded' }] },
      timeline: [timeline[0]!, timeline[1]!, ['cancelled', jobId, terminalUs]],
      budgets: [{ ...budget, closure: 'discarded', finalDisposition: 'discarded' }],
    }
    const withRaw = extractPacedObservation({ ...discarded, fitEvidence: [{ ...fitEvidence, closure: 'discarded', statistics: null }] },
      { ...fitBindings, terminalUs }).inference
    expect(withRaw).toMatchObject({ status: 'observed', jobs: [{ jobId, disposition: 'discarded', statistics: null }] })
    expect(withRaw.jobs?.[0]).toHaveProperty('fitInput', { status: 'unavailable', reason: 'discarded', record })

    const withoutRaw = extractPacedObservation(discarded, { ...fitBindings, terminalUs }).inference
    expect(withoutRaw.jobs?.[0]).toHaveProperty('fitInput', { status: 'unavailable', reason: 'discarded', record: null })
  })

  it('rejects rather than exposing contradictory archived fit inputs', () => {
    const fit = { ...fitEvidence, deliveredThroughUs: job.startedAtUs + 10_000 }
    expect(extractPacedObservation({ ...audited, fitEvidence: [fit] }, fitBindings).inference)
      .toEqual({ status: 'invalid', jobs: null })
  })

  it.each([
    ['default output', bindings], ['fit-input output', fitBindings],
  ] as const)('rejects fit data through a later admission timestamp in %s', (_mode, expected) => {
    expect(job.startedAtUs).toBeGreaterThan(job.endUs)
    const fit = { ...fitEvidence, deliveredThroughUs: job.startedAtUs }
    expect(extractPacedObservation({ ...audited, fitEvidence: [fit] }, expected).inference)
      .toEqual({ status: 'invalid', jobs: null })
  })
})

describe('paced spatial evaluation worker evidence', () => {
  const pin = 'd'.repeat(64)
  const spatialBindings = { ...bindings, spatialEvaluationSha256: pin }
  const ordinaryBindings = { ...bindings, spatialEvaluationSha256: null }
  const steadyResult = { ...result, controlRevision: 0 }
  const applied = { ...steadyResult, assumptions: ['qualified-spatial-envelope'] }
  const spatialSupport = { ...support, controlRevision: steadyResult.controlRevision }
  const spatialTrace = {
    ...publicDiagnosticTrace,
    transitions: [publicDiagnosticTrace.transitions[0],
      { ...supported, result: { ...resultClock, controlRevision: steadyResult.controlRevision } }, terminalTransition],
    firstVisibleSupports: [spatialSupport],
  }

  const workerAudit = (spatialEnvelopeSha256: string | undefined, diagnostic = steadyResult) => ({
    ...policyAudit, jobs: [{ ...job,
      provisional: { ...job.provisional!, result: { ...job.provisional!.result, controlRevision: diagnostic.controlRevision } },
      decisionReplay: { ...job.decisionReplay, result: diagnostic, spatialEnvelopeSha256 },
    }],
  })

  it('counts only committed jobs and records exact worker loading separately from application', () => {
    for (const [diagnostic, appliedJobs] of [[steadyResult, 0], [applied, 1]] as const) {
      const { inference } = extractPacedObservation({ ...audited, policyAudit: workerAudit(pin, diagnostic) }, spatialBindings)
      expect(inference).toMatchObject({ status: 'observed', spatialEvaluation: {
        status: 'worker-verified', committedJobs: 1, loadedJobs: 1, appliedJobs,
      } })
    }
    const legacy = extractPacedObservation(audited, bindings).inference
    expect(legacy).not.toHaveProperty('spatialEvaluation')
  })

  it('distinguishes a committed job without its digest from a run that committed no jobs', () => {
    const missing = extractPacedObservation(audited, spatialBindings).inference
    expect(missing).toMatchObject({ status: 'observed', spatialEvaluation: {
      status: 'incomplete-worker-evidence', committedJobs: 1, loadedJobs: 0, appliedJobs: 0,
    } })
    const noCommit = { ...audited, policyAudit: { ...policyAudit, jobs: [] }, timeline: timeline.slice(4), budgets: [], fitEvidence: [] }
    expect(extractPacedObservation(noCommit, spatialBindings).inference).toMatchObject({
      status: 'observed', spatialEvaluation: { status: 'not-exercised', committedJobs: 0, loadedJobs: 0, appliedJobs: 0 },
    })
  })

  it('excludes an audited discard that loaded the envelope before terminal closure', () => {
    const terminalUs = job.finishedAtUs
    const matched = workerAudit(pin)
    const discarded = {
      ...clock, timeUs: terminalUs, policyAudit: { ...matched, jobs: [{ ...matched.jobs[0], closure: 'discarded' }] },
      timeline: [timeline[0]!, timeline[1]!, ['cancelled', jobId, terminalUs]],
      budgets: [{ ...budget, closure: 'discarded', finalDisposition: 'discarded' }],
      fitEvidence: [{ ...fitEvidence, closure: 'discarded', statistics: null }],
    }
    expect(extractPacedObservation(discarded, { ...spatialBindings, terminalUs }).inference).toMatchObject({
      status: 'observed', jobs: [{ jobId, disposition: 'discarded' }],
      spatialEvaluation: { status: 'not-exercised', committedJobs: 0, loadedJobs: 0, appliedJobs: 0 },
    })
  })

  it.each([['a foreign', 'e'.repeat(64)], ['no', undefined]] as const)('rejects claimed application with %s worker digest', (_name, digest) => {
    const { inference } = extractPacedObservation({ ...audited, policyAudit: workerAudit(digest, applied) }, spatialBindings)
    expect(inference).toEqual({ status: 'invalid', jobs: null })
  })

  it('withholds ordinary selected-policy support while preserving synthetic fixture semantics', () => {
    const observation = { ...audited, publicDiagnosticTrace }
    const ordinary = extractPacedObservation(observation, ordinaryBindings)
    expect(ordinary.inference).toMatchObject({ status: 'observed' })
    expect(ordinary.inference).not.toHaveProperty('spatialEvaluation')
    expect(ordinary.publications).toEqual({ status: 'invalid', firstVisibleSupports: null })
    expect(extractPacedObservation(observation, bindings).publications).toEqual({ status: 'observed', firstVisibleSupports: [support] })
  })

  it.each([
    ['a worker digest in ordinary mode', ordinaryBindings, workerAudit(pin)],
    ['an application assumption in ordinary mode', ordinaryBindings, workerAudit(undefined, applied)],
    ['a worker digest in synthetic mode', bindings, workerAudit(pin)],
    ['an application assumption in synthetic mode', bindings, workerAudit(undefined, applied)],
  ] as const)('rejects unpinned audit with %s', (_name, unpinned, policyAudit) => {
    expect(extractPacedObservation({ ...audited, policyAudit }, unpinned).inference).toEqual({ status: 'invalid', jobs: null })
  })

  it('rejects an application claim after a non-steady control revision even with an exact worker digest', () => {
    const policyAudit = workerAudit(pin, { ...applied, controlRevision: 2 })
    expect(extractPacedObservation({ ...audited, policyAudit }, spatialBindings).inference).toEqual({ status: 'invalid', jobs: null })
  })

  it('rejects an application claim on an incomplete search even with an exact worker digest', () => {
    const incomplete: DiagnosticResult = {
      ...steadyResult, stopReason: 'evaluation-limit', searchComplete: false, fitQuality: 'unqualified',
      compatibleRegions: [{ startM: 2.5, endM: 997.5, status: 'unresolved' }],
      hypotheses: (['M0', 'ML', 'MB', 'MS', 'MD'] as const).map((model) => ({
        model, score: model === 'M0' ? 10 : null, completed: false, support: 'unresolved',
      })),
    }
    const matched = workerAudit(pin, incomplete)
    const incompleteJob = {
      ...matched.jobs[0]!, evaluationLimit: 3, stopReason: 'evaluation-limit', provisional: undefined,
      trials: [['M0', 0, 10], ['M0', 1, 12], ['M0', 2, 14]],
    }
    const raw = { ...audited, policyAudit: { ...matched, jobs: [incompleteJob] }, budgets: [], fitEvidence: [] }
    expect(extractPacedObservation(raw, spatialBindings).inference).toMatchObject({
      status: 'observed', spatialEvaluation: { loadedJobs: 1, appliedJobs: 0 },
    })
    const forged = { ...incompleteJob,
      decisionReplay: { ...incompleteJob.decisionReplay, result: { ...incomplete, assumptions: applied.assumptions } },
    }
    expect(extractPacedObservation({ ...raw, policyAudit: { ...matched, jobs: [forged] } }, spatialBindings).inference)
      .toEqual({ status: 'invalid', jobs: null })
  })

  it('attributes visible support under the pin only to an audited worker that loaded and applied it', () => {
    for (const policyAudit of [workerAudit(undefined), workerAudit(pin)]) {
      const { publications } = extractPacedObservation({ ...audited, policyAudit, publicDiagnosticTrace: spatialTrace }, spatialBindings)
      expect(publications).toEqual({ status: 'invalid', firstVisibleSupports: null })
    }
    const verified = { ...audited, policyAudit: workerAudit(pin, applied), publicDiagnosticTrace: spatialTrace }
    expect(extractPacedObservation(verified, spatialBindings).publications)
      .toEqual({ status: 'observed', firstVisibleSupports: [spatialSupport] })
  })
})
