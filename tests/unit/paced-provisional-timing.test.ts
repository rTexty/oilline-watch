import { describe, expect, it } from 'vitest'
import { createPacedProvisionalTimings } from '../../tools/calibration/browser/provisional-timing'

describe('paced provisional timings', () => {
  it('measures submission and receipt against the admission epoch, retaining the simulation timestamp', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('job-a', 1_700_000_000_000)
    timings.observe({ jobId: 'job-a', publishedAtUs: 42_000_000, submittedEpochMs: 1_700_000_000_125 }, 1_700_000_000_480)
    expect(timings.entries()).toEqual([{ jobId: 'job-a', publishedAtUs: 42_000_000, submittedMs: 125, provisionalMs: 480, finalPageMs: null, finalDisposition: null }])
  })

  it('keeps the first publication and does not duplicate a job', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('job-a', 10_000)
    timings.observe({ jobId: 'job-a', publishedAtUs: 100, submittedEpochMs: 10_010 }, 10_100)
    timings.observe({ jobId: 'job-a', publishedAtUs: 200, submittedEpochMs: 10_020 }, 10_200)
    timings.admit('job-a', 11_000)
    expect(timings.entries()).toEqual([{ jobId: 'job-a', publishedAtUs: 100, submittedMs: 10, provisionalMs: 100, finalPageMs: null, finalDisposition: null }])
  })

  it('retains late receipts and reports admitted jobs without a publication as null', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('late', 1_000)
    timings.admit('missing', 2_000)
    timings.observe({ jobId: 'late', publishedAtUs: 500, submittedEpochMs: 1_050 }, 4_100)
    expect(timings.entries()).toEqual([
      { jobId: 'late', publishedAtUs: 500, submittedMs: 50, provisionalMs: 3_100, finalPageMs: null, finalDisposition: null },
      { jobId: 'missing', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: null, finalDisposition: null },
    ])
  })

  it('retains raw receipt times when Worker and page clocks disagree within one millisecond', () => {
    const timings = createPacedProvisionalTimings()
    const admittedEpochMs = 1_700_000_000_000
    timings.admit('quantized', admittedEpochMs)
    timings.observe({
      jobId: 'quantized', publishedAtUs: 37_670_000, submittedEpochMs: admittedEpochMs + 1_701,
    }, admittedEpochMs + 1_700.875)
    timings.admit('boundary', admittedEpochMs)
    timings.observe({
      jobId: 'boundary', publishedAtUs: 42_640_000, submittedEpochMs: admittedEpochMs + 1_701,
    }, admittedEpochMs + 1_700)
    expect(timings.entries()).toEqual([
      { jobId: 'quantized', publishedAtUs: 37_670_000, submittedMs: 1_701, provisionalMs: 1_700.875, finalPageMs: null, finalDisposition: null },
      { jobId: 'boundary', publishedAtUs: 42_640_000, submittedMs: 1_701, provisionalMs: 1_700, finalPageMs: null, finalDisposition: null },
    ])
  })

  it('does not fabricate timings for unadmitted jobs or invalid clock ordering', () => {
    const timings = createPacedProvisionalTimings()
    timings.observe({ jobId: 'unknown', publishedAtUs: 100, submittedEpochMs: 1_000 }, 1_100)
    timings.admit('before-admission', 2_000)
    timings.observe({ jobId: 'before-admission', publishedAtUs: 100, submittedEpochMs: 1_999 }, 2_100)
    timings.admit('before-submission', 3_000)
    timings.observe({ jobId: 'before-submission', publishedAtUs: 100, submittedEpochMs: 3_100 }, 3_098.75)
    timings.admit('receipt-before-admission', 4_000)
    timings.observe({ jobId: 'receipt-before-admission', publishedAtUs: 100, submittedEpochMs: 4_000.25 }, 3_999.75)
    expect(timings.entries()).toEqual([
      { jobId: 'before-admission', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: null, finalDisposition: null },
      { jobId: 'before-submission', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: null, finalDisposition: null },
      { jobId: 'receipt-before-admission', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: null, finalDisposition: null },
    ])
  })

  it('rejects non-finite timestamps without recording a publication', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('job', 1_000)
    timings.observe({ jobId: 'job', publishedAtUs: 100, submittedEpochMs: Number.NaN }, 1_100)
    timings.observe({ jobId: 'job', publishedAtUs: 100, submittedEpochMs: 1_050 }, Number.POSITIVE_INFINITY)
    expect(timings.entries()).toEqual([{ jobId: 'job', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: null, finalDisposition: null }])
  })

  it('pairs provisional and terminal page receipts against the original admission epoch', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('job', 1_000)
    timings.observe({ jobId: 'job', publishedAtUs: 100, submittedEpochMs: 1_125 }, 1_200)
    timings.observeFinal({ jobId: 'job', submittedEpochMs: 1_250, finalDisposition: 'committed' }, 1_400)
    timings.observeFinal({ jobId: 'job', submittedEpochMs: 1_500, finalDisposition: 'discarded' }, 1_600)
    expect(timings.entries()).toEqual([
      { jobId: 'job', publishedAtUs: 100, submittedMs: 125, provisionalMs: 200, finalPageMs: 400, finalDisposition: 'committed' },
    ])
  })

  it('reports a discarded terminal receipt separately from a missing receipt', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('cutoff', 1_000)
    timings.admit('missing', 2_000)
    timings.observeFinal({ jobId: 'cutoff', submittedEpochMs: 1_100, finalDisposition: 'discarded' }, 1_099)
    expect(timings.entries()).toEqual([
      { jobId: 'cutoff', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: 99, finalDisposition: 'discarded' },
      { jobId: 'missing', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: null, finalDisposition: null },
    ])
  })

  it('rejects a terminal receipt with invalid clock ordering while retaining the provisional receipt', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('job', 1_000)
    timings.observe({ jobId: 'job', publishedAtUs: 100, submittedEpochMs: 1_100 }, 1_200)
    timings.observeFinal({ jobId: 'job', submittedEpochMs: 1_100, finalDisposition: 'committed' }, 1_199.75)
    timings.observeFinal({ jobId: 'job', submittedEpochMs: 1_250, finalDisposition: 'committed' }, 1_248.75)
    timings.observeFinal({ jobId: 'job', submittedEpochMs: 1_250, finalDisposition: 'committed' }, Number.POSITIVE_INFINITY)
    timings.observeFinal({ jobId: 'unknown', submittedEpochMs: 1_250, finalDisposition: 'committed' }, 1_260)
    expect(timings.entries()).toEqual([
      { jobId: 'job', publishedAtUs: 100, submittedMs: 100, provisionalMs: 200, finalPageMs: null, finalDisposition: null },
    ])
  })

  it('ignores a provisional marker received after a terminal receipt', () => {
    const timings = createPacedProvisionalTimings()
    timings.admit('job', 1_000)
    timings.observeFinal({ jobId: 'job', submittedEpochMs: 1_125, finalDisposition: 'committed' }, 1_200)
    timings.observe({ jobId: 'job', publishedAtUs: 100, submittedEpochMs: 1_100 }, 1_250)
    expect(timings.entries()).toEqual([
      { jobId: 'job', publishedAtUs: null, submittedMs: null, provisionalMs: null, finalPageMs: 200, finalDisposition: 'committed' },
    ])
  })
})
