import { describe, expect, it } from 'vitest'
import { CHALLENGE_HORIZON_US, CHALLENGE_WARMUP_US } from '../../src/contracts/model'
import { ADVERSE_MAX_DELIVERY_DELAY_US, PRESSURE_PERIOD_US } from '../../src/contracts/public'
import { createPacedDetectorTrace } from '../../tools/calibration/browser/detector-trace'
import type { DetectorObservation } from '../../tools/calibration/browser/detector-trace'

const warmup = CHALLENGE_WARMUP_US
const tick = PRESSURE_PERIOD_US
const adverseDelay = ADVERSE_MAX_DELIVERY_DELAY_US

function advanceThrough(
  trace: ReturnType<typeof createPacedDetectorTrace>, end: number, delay: number,
  facts?: (cohortUs: number, publishedAtUs: number) => Partial<DetectorObservation>,
) {
  for (let deliveredThroughUs = 0; deliveredThroughUs <= end; deliveredThroughUs += tick) {
    const cohortUs = Math.max(-1, deliveredThroughUs - delay)
    const state: DetectorObservation = {
      lastBatchUs: cohortUs, status: cohortUs < warmup ? 'warming-up' : 'ready',
      lastAlarmUs: null, episode: null, canLocalize: false, pendingCohorts: delay > 0 ? [] : null,
      ...facts?.(cohortUs, deliveredThroughUs),
    }
    trace.observe(state, deliveredThroughUs)
  }
}

describe('paced detector cohort evidence', () => {
  it('counts only ready challenge cohorts and preserves exact availability changes', () => {
    const trace = createPacedDetectorTrace()
    const end = warmup + 5 * tick
    advanceThrough(trace, end, 0, (cohortUs) => cohortUs === warmup + 2 * tick
      ? { status: 'insufficient-data' } : { canLocalize: cohortUs >= warmup + 4 * tick })
    expect(trace.terminal({ timeUs: end, phase: 'completed', requested: true, configured: true })).toMatchObject({
      status: 'observed', processedChallengeCohorts: 5, availableUs: 4 * tick,
      observedThroughUs: end, deliveredThroughUs: end, episodes: [],
      exposure: [
        { firstCohortUs: warmup + tick, lastCohortUs: warmup + tick, ready: true, canLocalize: false },
        { firstCohortUs: warmup + 2 * tick, lastCohortUs: warmup + 2 * tick, ready: false, canLocalize: false },
        { firstCohortUs: warmup + 3 * tick, lastCohortUs: warmup + 3 * tick, ready: true, canLocalize: false },
        { firstCohortUs: warmup + 4 * tick, lastCohortUs: warmup + 5 * tick, ready: true, canLocalize: true },
      ],
    })
  })

  it('records adverse opening and closure on both clocks and keeps unprocessed trailing cohorts out', () => {
    const trace = createPacedDetectorTrace()
    const openedAt = warmup + tick
    const closedAt = openedAt + 1_100_000
    const reopenedAt = closedAt + 2_100_000
    const end = reopenedAt + adverseDelay + tick
    advanceThrough(trace, end, adverseDelay, (cohortUs) => ({
      lastAlarmUs: cohortUs >= reopenedAt ? reopenedAt + adverseDelay : cohortUs >= openedAt ? openedAt + adverseDelay : null,
      episode: cohortUs >= reopenedAt ? { openedAtUs: reopenedAt + adverseDelay, belowSinceUs: null }
        : cohortUs >= openedAt && cohortUs < closedAt ? { openedAtUs: openedAt + adverseDelay, belowSinceUs: null } : null,
    }))
    const result = trace.terminal({ timeUs: end, phase: 'completed', requested: true, configured: true })
    expect(result).toMatchObject({
      status: 'observed', observedThroughUs: end - adverseDelay, deliveredThroughUs: end,
      availableUs: end - adverseDelay - warmup,
      episodes: [
        { openedAtUs: openedAt + adverseDelay, openingCohortUs: openedAt,
          closedAtUs: closedAt + adverseDelay, closingCohortUs: closedAt },
        { openedAtUs: reopenedAt + adverseDelay, openingCohortUs: reopenedAt, closedAtUs: null, closingCohortUs: null },
      ],
    })
  })

  it('keeps a complete nominal challenge within its 30,000-cohort bound', () => {
    const trace = createPacedDetectorTrace()
    advanceThrough(trace, CHALLENGE_HORIZON_US, 0)
    expect(trace.terminal({ timeUs: CHALLENGE_HORIZON_US, phase: 'completed', requested: true, configured: true })).toMatchObject({
      status: 'observed', processedChallengeCohorts: 30_000, availableUs: 300_000_000,
      exposure: [{ firstCohortUs: warmup + tick, lastCohortUs: CHALLENGE_HORIZON_US, ready: true, canLocalize: false }],
    })
  })

  it('distinguishes unavailable, uncalibrated, failed, and incomplete observations', () => {
    const trace = createPacedDetectorTrace()
    const end = warmup + tick
    expect(trace.terminal({ timeUs: end, phase: 'completed', requested: false, configured: false }).status).toBe('uncalibrated')
    expect(trace.terminal({ timeUs: end, phase: 'completed', requested: true, configured: false }).status).toBe('unavailable')
    expect(trace.terminal({ timeUs: end, phase: 'invalid', requested: true, configured: false }).status).toBe('failed')
    expect(trace.terminal({ timeUs: end, phase: 'completed', requested: true, configured: true }).status).toBe('incomplete')
    advanceThrough(trace, warmup, 0)
    trace.observe({ lastBatchUs: end + tick, status: 'ready', canLocalize: true,
      lastAlarmUs: end + tick, episode: { openedAtUs: end + tick, belowSinceUs: null }, pendingCohorts: null }, end + tick)
    expect(trace.terminal({ timeUs: end + tick, phase: 'completed', requested: true, configured: true })).toMatchObject({
      status: 'incomplete', processedChallengeCohorts: 0, availableUs: 0, episodes: [],
      observedThroughUs: warmup, deliveredThroughUs: warmup,
    })
    expect(trace.terminal({ timeUs: end + tick, phase: 'error', requested: true, configured: true }).status).toBe('failed')
  })

  it('uses the adverse detector status when the delivery clock crosses the warmup boundary first', () => {
    const trace = createPacedDetectorTrace()
    const end = warmup + tick
    advanceThrough(trace, end, adverseDelay)
    expect(trace.terminal({ timeUs: end, phase: 'completed', requested: true, configured: true })).toMatchObject({
      status: 'warming-up', lastDetectorStatus: 'warming-up', availableUs: 0, observedThroughUs: warmup - tick,
    })
  })
})
