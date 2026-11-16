import { CHALLENGE_HORIZON_US, CHALLENGE_WARMUP_US } from '../../../src/contracts/model'
import { ADVERSE_MAX_DELIVERY_DELAY_US, PRESSURE_PERIOD_US } from '../../../src/contracts/public'
import type { DetectorState } from '../../../src/detection/detector'

export type DetectorObservation = Pick<DetectorState,
  'status' | 'lastBatchUs' | 'lastAlarmUs' | 'episode' | 'canLocalize' | 'pendingCohorts'>

interface Exposure {
  readonly firstCohortUs: number
  readonly lastCohortUs: number
  readonly ready: boolean
  readonly canLocalize: boolean
}

interface Episode {
  readonly openedAtUs: number
  readonly openingCohortUs: number
  readonly closedAtUs: number | null
  readonly closingCohortUs: number | null
}

interface TerminalDetector {
  readonly timeUs: number
  readonly phase: 'completed' | 'invalid' | 'error'
  readonly requested: boolean
  readonly configured: boolean
}

function recordEpisode(episodes: Episode[], state: DetectorObservation, publishedAtUs: number): boolean {
  const previous = episodes.at(-1)
  const open = previous?.closedAtUs === null
  if (state.lastAlarmUs !== (previous?.openedAtUs ?? null)) {
    if (open || state.status !== 'ready' || state.lastBatchUs <= CHALLENGE_WARMUP_US
      || state.lastAlarmUs !== publishedAtUs || state.episode?.openedAtUs !== publishedAtUs) return false
    episodes.push({ openedAtUs: publishedAtUs, openingCohortUs: state.lastBatchUs, closedAtUs: null, closingCohortUs: null })
    return true
  }
  if (state.episode) return open && state.episode.openedAtUs === previous.openedAtUs
  if (open) {
    episodes[episodes.length - 1] = { ...previous, closedAtUs: publishedAtUs, closingCohortUs: state.lastBatchUs }
  }
  return true
}

function recordExposure(exposure: Exposure[], { lastBatchUs, status, canLocalize }: DetectorObservation): void {
  const ready = status === 'ready'
  const last = exposure.at(-1)
  if (last?.ready === ready && last.canLocalize === canLocalize) {
    exposure[exposure.length - 1] = { ...last, lastCohortUs: lastBatchUs }
  } else {
    exposure.push({ firstCohortUs: lastBatchUs, lastCohortUs: lastBatchUs, ready, canLocalize })
  }
}

function traceStatus(result: TerminalDetector, complete: boolean, status: DetectorObservation['status'] | null, availableUs: number) {
  if (result.phase !== 'completed') return 'failed'
  if (!result.configured) return result.requested ? 'unavailable' : 'uncalibrated'
  if (!complete) return 'incomplete'
  if (status === 'warming-up') return 'warming-up'
  return availableUs > 0 ? 'observed' : 'unavailable'
}

/** The production detector remains authoritative. A skipped delivery tick makes the recorded prefix incomplete. */
export function createPacedDetectorTrace() {
  const exposure: Exposure[] = []
  const episodes: Episode[] = []
  let deliveredThroughUs: number | null = null
  let observedThroughUs: number | null = null
  let lastDetectorStatus: DetectorObservation['status'] | null = null
  let availableUs = 0
  let exact = true
  return {
    observe(state: DetectorObservation, publishedAtUs: number): void {
      if (!exact) return
      const nextDeliveryUs = deliveredThroughUs === null ? 0 : deliveredThroughUs + PRESSURE_PERIOD_US
      const delayUs = state.pendingCohorts ? ADVERSE_MAX_DELIVERY_DELAY_US : 0
      const expectedCohortUs = Math.max(-1, publishedAtUs - delayUs)
      if (publishedAtUs !== nextDeliveryUs || publishedAtUs > CHALLENGE_HORIZON_US || state.lastBatchUs !== expectedCohortUs
        || !recordEpisode(episodes, state, publishedAtUs)) {
        exact = false
        return
      }
      deliveredThroughUs = publishedAtUs
      lastDetectorStatus = state.status
      if (state.lastBatchUs < 0) return
      observedThroughUs = state.lastBatchUs
      // The arming cohort freezes the baseline. Exposure begins with the first subsequent cohort.
      if (observedThroughUs <= CHALLENGE_WARMUP_US) return
      if (state.status === 'ready') availableUs += PRESSURE_PERIOD_US
      recordExposure(exposure, state)
    },
    terminal(result: TerminalDetector) {
      const complete = exact && deliveredThroughUs === result.timeUs
      return {
        status: traceStatus(result, complete, lastDetectorStatus, availableUs),
        lastDetectorStatus, deliveredThroughUs, observedThroughUs, availableUs,
        processedChallengeCohorts: Math.max(0, (observedThroughUs ?? 0) - CHALLENGE_WARMUP_US) / PRESSURE_PERIOD_US,
        exposure: [...exposure], episodes: [...episodes],
      }
    },
  }
}
