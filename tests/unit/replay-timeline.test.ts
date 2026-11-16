import { describe, expect, it } from 'vitest'
import { createReplayTimeline, replayActions, markReplayDispatched, markReplayVerified, commitReplayJob } from '../../src/runtime/replay-timeline'
import type { InferenceAuditJob } from '../../src/contracts/inference-audit'

const job: InferenceAuditJob = {
  jobId: '8dc30484-3d7f-4bc2-8323-a432db7e7ca1', startUs: 27_000_000, endUs: 31_000_000,
  startedAtUs: 31_100_000, finishedAtUs: 31_300_000, wallLimitMs: 5000, evaluationLimit: 512,
  stopReason: 'wall-limit', completedEvaluations: 1, trials: [['M0', 0, 2]],
}
const otherId = '50f5f0bf-f0c5-4380-9799-7d58e54169cb'

describe('CPU inference replay timeline', () => {
  it('freezes, dispatches and waits at recorded model times without mutating state', () => {
    const initial = createReplayTimeline([job])
    expect(replayActions(initial, 30_990_000)).toEqual([])
    expect(replayActions(initial, 31_000_000)).toContainEqual({ kind: 'freeze', job })
    expect(replayActions(initial, 31_100_000)).toContainEqual({ kind: 'dispatch', job })
    const dispatched = markReplayDispatched(initial, job.jobId)
    expect(dispatched).not.toBe(initial)
    expect(replayActions(dispatched, 31_200_000)).not.toContainEqual({ kind: 'commit', job })
    expect(replayActions(dispatched, 31_300_000)).toContainEqual({ kind: 'wait', job })
    expect(replayActions(initial, 31_100_000)).toContainEqual({ kind: 'dispatch', job })
    const verified = markReplayVerified(dispatched, job.jobId, true)
    expect(replayActions(verified, 31_200_000)).not.toContainEqual({ kind: 'commit', job })
    expect(replayActions(verified, 31_300_000)).toContainEqual({ kind: 'commit', job })
    expect(replayActions(commitReplayJob(verified, job.jobId), 31_300_000)).toEqual([])
  })
  it('freezes overlapping evidence and dispatches the next job at the first commit boundary', () => {
    const next: InferenceAuditJob = { ...job, jobId: otherId, startUs: 27_100_000, endUs: 31_100_000,
      startedAtUs: 31_300_000, finishedAtUs: 31_500_000 }
    const first = markReplayDispatched(createReplayTimeline([job, next]), job.jobId)
    expect(replayActions(first, 31_100_000)).toContainEqual({ kind: 'freeze', job: next })
    const verified = markReplayVerified(first, job.jobId, true)
    expect(replayActions(verified, 31_300_000)).toContainEqual({ kind: 'commit', job })
    const second = commitReplayJob(verified, job.jobId)
    expect(replayActions(second, 31_300_000)).toContainEqual({ kind: 'dispatch', job: next })
  })
  it('ignores stale replies and surfaces divergence at the recorded commit boundary', () => {
    const dispatched = markReplayDispatched(createReplayTimeline([job]), job.jobId)
    expect(markReplayVerified(dispatched, otherId, true)).toBe(dispatched)
    const diverged = markReplayVerified(dispatched, job.jobId, false)
    expect(replayActions(diverged, 31_300_000)).toContainEqual({ kind: 'divergence', job })
    expect(replayActions(diverged, 31_300_000)).not.toContainEqual({ kind: 'commit', job })
  })

  it('holds the model at a provisional publication and orders it before a same-tick terminal commit', () => {
    const previewed: InferenceAuditJob = { ...job, provisional: { check: 20, publishedAtUs: job.finishedAtUs, result: {
      jobId: job.jobId, modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1',
      calibrationId: 'a'.repeat(64), controlRevision: 0, observedThroughUs: job.endUs, completedEvaluations: 1,
      scores: { M0: 2, ML: null, MB: null, MS: null },
    } } }
    const dispatched = markReplayDispatched(createReplayTimeline([previewed]), job.jobId)
    expect(replayActions(dispatched, 31_290_000)).toEqual([])
    expect(replayActions(dispatched, 31_300_000)).toEqual([{ kind: 'wait', job: previewed }])
    const verified = markReplayVerified(dispatched, job.jobId, true)
    expect(replayActions(verified, 31_300_000)).toEqual([{ kind: 'provisional', job: previewed }])
    expect(replayActions({ ...verified, provisionalPublished: true }, 31_300_000)).toEqual([{ kind: 'commit', job: previewed }])
    expect(replayActions(verified, 31_310_000)).toEqual([{ kind: 'divergence', job: previewed }])
  })
})
