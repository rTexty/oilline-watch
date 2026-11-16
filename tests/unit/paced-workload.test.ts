import { describe, expect, it } from 'vitest'
import type { InferenceAuditJob } from '../../src/contracts/inference-audit'
import { summarizePacedWorkload } from '../../tools/calibration/browser/paced-workload'

type Disposition = 'committed' | 'discarded' | 'cancelled' | 'superseded'
const admittedAtUs = 60_020_000

function scheduled(jobId: string, windowUs: number, disposition: Disposition, admitted = true) {
  return {
    jobId, windowStartUs: 60_000_000 - windowUs, windowEndUs: 60_000_000,
    admittedAtUs: admitted ? admittedAtUs : null, terminalAtUs: 61_000_000, disposition,
  }
}

function receipt(
  jobId: string, stopReason: InferenceAuditJob['stopReason'], finalPageMs: number | null, provisionalMs: number | null,
  wallRoundTripMs: number | null = null,
) {
  return { jobId, stopReason, finalPageMs, provisionalMs, wallRoundTripMs }
}

const short = 4_000_000
const long = 30_000_000
const schedule = [
  scheduled('boundary', short, 'committed'), scheduled('partial', short, 'committed'),
  scheduled('late-page', short, 'committed'), scheduled('missing-round-trip', long, 'committed'),
  scheduled('discarded', long, 'discarded'), scheduled('cancelled-admitted', long, 'cancelled'),
  scheduled('superseded', long, 'superseded', false), scheduled('cancelled-request', short, 'cancelled', false),
  scheduled('late-round-trip', long, 'committed'), scheduled('partial-no-final', short, 'committed'),
]
const receipts = [
  receipt('boundary', 'complete', 5000, 100, 5000), receipt('partial', 'wall-limit', 4999, null, 4900),
  receipt('late-page', 'complete', 5000.1, null, 4999.9), receipt('missing-round-trip', 'complete', 320, null),
  receipt('discarded', 'complete', 200, null), receipt('cancelled-admitted', 'cancelled', null, null),
  receipt('late-round-trip', 'complete', 4999, 0, 5000.1), receipt('partial-no-final', 'evaluation-limit', null, 30),
]

describe('paced workload metrics', () => {
  it('retains denominators and distinguishes completion round-trip from final page receipt', () => {
    const workload = summarizePacedWorkload(schedule, receipts.toReversed())
    expect(workload.all).toMatchObject({
      requested: 10, admitted: 8, superseded: 1, cancelledBeforeAdmission: 1, committed: 6, discarded: 1,
      cancelledAfterAdmission: 1, completedWithin5s: 2, committedFinalWithin5s: 4,
      observedProvisional: { delivered: 3, p95Ms: 100 },
      provisionalIncludingMissing: { requiredOrDelivered: 6, missing: 3, p95Ms: null },
      stopReasons: { complete: 5, 'wall-limit': 1, cancelled: 1, 'evaluation-limit': 1 },
    })
    expect(workload.short).toMatchObject({
      requested: 5, admitted: 4, superseded: 0, cancelledBeforeAdmission: 1, committed: 4, discarded: 0,
      cancelledAfterAdmission: 0, completedWithin5s: 2, committedFinalWithin5s: 2,
      observedProvisional: { delivered: 2, p95Ms: 100 },
      provisionalIncludingMissing: { requiredOrDelivered: 3, missing: 1, p95Ms: null },
      stopReasons: { complete: 2, 'wall-limit': 1, 'evaluation-limit': 1 },
    })
    expect(workload.long).toMatchObject({
      requested: 5, admitted: 4, superseded: 1, cancelledBeforeAdmission: 0, committed: 2, discarded: 1,
      cancelledAfterAdmission: 1, completedWithin5s: 0, committedFinalWithin5s: 2,
      observedProvisional: { delivered: 1, p95Ms: 0 },
      provisionalIncludingMissing: { requiredOrDelivered: 3, missing: 2, p95Ms: null },
      stopReasons: { complete: 3, cancelled: 1 },
    })
  })

  it('counts a timely completion when the page receipt is missing', () => {
    const workload = summarizePacedWorkload([scheduled('worker-only', short, 'committed')], [receipt('worker-only', 'complete', null, null, 5000)])
    expect(workload.all).toMatchObject({ completedWithin5s: 1, committedFinalWithin5s: 0 })
  })

  it('uses nearest-rank p95 and keeps missing incomplete receipts in the conservative percentile', () => {
    const delivered = Array.from({ length: 20 }, (_, index) => ({
      schedule: scheduled(`delivered-${index}`, short, 'committed'),
      receipt: receipt(`delivered-${index}`, 'complete', 100, 20 - index),
    }))
    const timed = delivered.map((row) => row.schedule)
    const observed = delivered.map((row) => row.receipt)
    const firstMissing = scheduled('missing-1', short, 'committed')
    const secondMissing = scheduled('missing-2', short, 'discarded')
    const first = receipt(firstMissing.jobId, 'evaluation-limit', 100, null)
    const second = receipt(secondMissing.jobId, 'complete', null, null)

    const oneMissing = summarizePacedWorkload([...timed, firstMissing], [...observed, first])
    expect(oneMissing.all.observedProvisional).toEqual({ delivered: 20, p95Ms: 19 })
    expect(oneMissing.all.provisionalIncludingMissing).toEqual({ requiredOrDelivered: 21, missing: 1, p95Ms: 20 })
    const twoMissing = summarizePacedWorkload([...timed, firstMissing, secondMissing], [...observed, first, second])
    expect(twoMissing.all.observedProvisional).toEqual({ delivered: 20, p95Ms: 19 })
    expect(twoMissing.all.provisionalIncludingMissing).toEqual({ requiredOrDelivered: 22, missing: 2, p95Ms: null })
  })

  it('preserves null percentiles for empty groups and completed jobs without provisional receipts', () => {
    const workload = summarizePacedWorkload([scheduled('no-provisional', short, 'committed')], [receipt('no-provisional', 'complete', null, null)])
    expect(workload.short).toMatchObject({
      requested: 1, admitted: 1, completedWithin5s: 0, committedFinalWithin5s: 0,
      observedProvisional: { delivered: 0, p95Ms: null }, provisionalIncludingMissing: { requiredOrDelivered: 0, missing: 0, p95Ms: null },
    })
    expect(workload.long).toMatchObject({
      requested: 0, admitted: 0,
      observedProvisional: { delivered: 0, p95Ms: null }, provisionalIncludingMissing: { requiredOrDelivered: 0, missing: 0, p95Ms: null },
    })
  })

  it.each([
    { name: 'missing admitted job', schedule, jobs: receipts.slice(1) },
    { name: 'duplicate admitted job', schedule, jobs: [...receipts, receipts[0]!] },
    { name: 'duplicate schedule ticket', schedule: [...schedule, schedule[0]!], jobs: receipts },
    { name: 'unmatched job', schedule, jobs: [...receipts, receipt('foreign', 'complete', 500, 10)] },
    { name: 'superseded ticket with a job', schedule, jobs: [...receipts, receipt('superseded', 'complete', 500, null)] },
    { name: 'pre-admission cancellation with a job', schedule, jobs: [...receipts, receipt('cancelled-request', 'cancelled', null, null)] },
    { name: 'committed ticket without admission', schedule: [scheduled('missing-admission', short, 'committed', false)], jobs: [] },
    { name: 'admitted superseded ticket', schedule: [scheduled('superseded', short, 'superseded')], jobs: [receipt('superseded', 'cancelled', null, null)] },
    { name: 'unsupported window length', schedule: [scheduled('wrong-window', long - 1, 'committed')], jobs: [receipt('wrong-window', 'complete', 10, null)] },
  ])('rejects a $name', ({ schedule, jobs }) => {
    expect(() => summarizePacedWorkload(schedule, jobs)).toThrow()
  })
})
