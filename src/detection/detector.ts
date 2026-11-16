import { BANK_VERSION } from '../contracts/model'
import type { Calibration } from '../contracts/calibration'
import type { FluidProfile } from '../contracts/model'
import { ADVERSE_MAX_DELIVERY_DELAY_US, FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { PublicBatch } from '../contracts/public'
import { freezeWarmup, initialWarmup, updateWarmup } from './calibration'
import { initialCusum, updateCusum } from './cusum'
import type { CusumState } from './cusum'
import { sensorResidual } from './residual'

const pressureIds = ['P1', 'P2', 'P3'] as const
const EPISODE_RECOVERY_US = 1_000_000
const REFRACTORY_US = 2_000_000
const OUTAGE_US = 500_000

export interface DetectorState {
  readonly status: 'uncalibrated' | 'warming-up' | 'insufficient-data' | 'ready'
  readonly calibration: Calibration | null
  readonly warmupEndUs: number
  readonly warmup: ReturnType<typeof initialWarmup> | null
  readonly warmupFit: ReturnType<typeof freezeWarmup>
  readonly lastBatchUs: number
  readonly lastDeliveryBatchUs: number
  readonly pendingCohorts: readonly PublicBatch[] | null
  readonly channels: readonly CusumState[]
  readonly lastFlowUs: number | null
  readonly canLocalize: boolean
  readonly episode: { readonly openedAtUs: number; readonly belowSinceUs: number | null } | null
  readonly refractoryUntilUs: number
  readonly lastAlarmUs: number | null
}

export function createDetector(profile: FluidProfile, calibration: Calibration | null, expectedHashes?: Calibration['hashes']): DetectorState {
  const qualified = profile.mode === 'turbulent' && profile.startupQualification === 'known-healthy'
    && calibration && expectedHashes && calibration.qualification.quantitative
    && calibration.profileId === profile.profileId && calibration.modelVersion === profile.modelVersion
    && calibration.bankVersion === BANK_VERSION && calibration.sensorProfileId === profile.sensorProfileId
    && (Object.keys(calibration.hashes) as (keyof Calibration['hashes'])[])
      .every((key) => calibration.hashes[key] === expectedHashes[key])
  return {
    status: qualified ? 'warming-up' : 'uncalibrated',
    calibration: qualified ? calibration : null,
    warmupEndUs: profile.warmupUs,
    warmup: qualified ? initialWarmup() : null,
    warmupFit: null, lastBatchUs: -1, lastDeliveryBatchUs: -1,
    pendingCohorts: qualified && profile.sensorProfileId === 'synthetic-oil-adverse-v1' ? [] : null,
    channels: pressureIds.map(initialCusum),
    lastFlowUs: null, canLocalize: false, episode: null, refractoryUntilUs: 0, lastAlarmUs: null,
  }
}

function pressures(state: DetectorState, batch: PublicBatch, calibration: Calibration, availableThroughUs: number) {
  const fit = state.warmupFit
  const baseline = fit?.frozenBaselines[fit.anchorId]?.meanBySensor
  const prediction = batch.predictions.find((value) => value.anchorId === fit?.anchorId)
  return pressureIds.map((id, index) => {
    const prior = state.channels[index]!
    const sample = batch.measurements.find((value) => value.sensorId === id && value.sampleTimeUs === batch.sampleTimeUs)
    if (!sample || sample.deliveredTimeUs > availableThroughUs) {
      const reset = prior.lastValidUs !== null && batch.sampleTimeUs - prior.lastValidUs > OUTAGE_US
      return { ...prior, ...(reset ? initialCusum() : {}), lastReceivedSeq: prior.lastReceivedSeq,
        lastReceivedUs: prior.lastReceivedUs, pair: null, crossed: false }
    }
    const residual = prediction && sample.deliveredTimeUs - sample.sampleTimeUs <= 2 * PRESSURE_PERIOD_US
      ? sensorResidual(sample, prediction, availableThroughUs) : null
    const { sigmaSI, rho } = calibration.noise[id]
    return updateCusum(prior, sample.sampleSeq, sample.sampleTimeUs,
      residual !== null && baseline ? (residual - baseline[id]) / sigmaSI : null, {
        rho, periodUs: PRESSURE_PERIOD_US, fastThreshold: calibration.thresholds.cusumFast,
        slowThreshold: calibration.thresholds.cusumSlow,
      })
  })
}

function updateEpisode(state: DetectorState, valid: readonly CusumState[], calibration: Calibration, publishedAtUs: number): DetectorState {
  const time = state.lastBatchUs
  if (!state.episode) {
    if (valid.length < 2 || time < state.refractoryUntilUs || !valid.some((channel) => channel.crossed)) return state
    return { ...state, lastAlarmUs: publishedAtUs, episode: { openedAtUs: publishedAtUs, belowSinceUs: null } }
  }
  const { cusumFast, cusumSlow } = calibration.thresholds
  const below = valid.length >= 2 && valid.every(({ fast, slow }) => Math.max(fast.positive, fast.negative) < cusumFast / 2
    && Math.max(slow.positive, slow.negative) < cusumSlow / 2)
  const belowSinceUs = below ? state.episode.belowSinceUs ?? time : null
  if (belowSinceUs !== null && time - belowSinceUs >= EPISODE_RECOVERY_US) {
    return { ...state, episode: null, refractoryUntilUs: time + REFRACTORY_US }
  }
  return { ...state, episode: { ...state.episode, belowSinceUs } }
}

function advanceCohort(previous: DetectorState, batch: PublicBatch, availableThroughUs: number): DetectorState {
  const calibration = previous.calibration
  const timeUs = batch.sampleTimeUs
  if (!calibration || timeUs <= previous.lastBatchUs) return previous
  const episode = previous.episode && timeUs - previous.lastBatchUs > PRESSURE_PERIOD_US
    ? { ...previous.episode, belowSinceUs: null } : previous.episode
  const state = { ...previous, lastBatchUs: timeUs, episode }
  const flow = batch.measurements.find((reading) => reading.sensorId === 'Qin' && reading.quality === 'valid'
    && reading.sampleTimeUs <= timeUs && reading.deliveredTimeUs <= availableThroughUs
    && reading.deliveredTimeUs - reading.sampleTimeUs <= 2 * FLOW_PERIOD_US)
  const lastFlowUs = flow ? Math.max(flow.sampleTimeUs, previous.lastFlowUs ?? -1) : previous.lastFlowUs
  if (state.warmup) {
    const warmup = updateWarmup(state.warmup, batch, calibration.noise, availableThroughUs)
    if (timeUs < state.warmupEndUs) return { ...state, warmup, lastFlowUs }
    const warmupFit = freezeWarmup(warmup)
    return { ...state, warmup: null, warmupFit, lastFlowUs, status: warmupFit ? 'ready' : 'insufficient-data',
      canLocalize: warmupFit !== null && lastFlowUs !== null && timeUs - lastFlowUs <= 2 * FLOW_PERIOD_US }
  }
  if (!state.warmupFit) return state
  const channels = pressures(state, batch, calibration, availableThroughUs)
  const valid = channels.filter((channel) => channel.lastValidUs === timeUs)
  const canLocalize = valid.length >= 2 && lastFlowUs !== null && timeUs - lastFlowUs <= 2 * FLOW_PERIOD_US
  const status = valid.length >= 2 ? 'ready' : 'insufficient-data'
  return updateEpisode({ ...state, status, lastFlowUs, canLocalize, channels }, valid, calibration, availableThroughUs)
}

export function advanceDetector(previous: DetectorState, batch: PublicBatch): DetectorState {
  if (!previous.pendingCohorts) return advanceCohort(previous, batch, batch.sampleTimeUs)
  if (batch.sampleTimeUs <= previous.lastDeliveryBatchUs) return previous

  const throughUs = batch.sampleTimeUs
  const watermarkUs = throughUs - ADVERSE_MAX_DELIVERY_DELAY_US
  const cohorts = [...previous.pendingCohorts, { ...batch, measurements: [] }].map((cohort) => ({
    ...cohort,
    measurements: [...cohort.measurements, ...batch.measurements.filter((reading) =>
      reading.sampleTimeUs === cohort.sampleTimeUs && reading.deliveredTimeUs <= throughUs
      && !cohort.measurements.some((known) => known.sensorId === reading.sensorId && known.sampleSeq === reading.sampleSeq))],
  }))
  const pendingCohorts = cohorts.filter((cohort) => cohort.sampleTimeUs > watermarkUs)
  return cohorts.filter((cohort) => cohort.sampleTimeUs <= watermarkUs).reduce<DetectorState>(
    (state, cohort) => advanceCohort(state, cohort, throughUs),
    { ...previous, pendingCohorts, lastDeliveryBatchUs: throughUs },
  )
}
