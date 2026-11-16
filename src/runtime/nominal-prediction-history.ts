import { BANK_VERSION, MODEL_VERSION } from '../contracts/model'
import type { FluidProfile } from '../contracts/model'
import { firstNominalTick, NOMINAL_ANCHOR_COUNT, NOMINAL_PREDICTION_CACHE_VERSION, NOMINAL_PRESSURE_CHANNELS,
  nominalControlKey, nominalPredictionCacheMatches, nominalTickCount } from '../contracts/nominal-predictions'
import type { NominalPredictionCache, NominalPredictionJobIdentity } from '../contracts/nominal-predictions'
import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { AppliedControl, PublicBatch } from '../contracts/public'
import type { HydraulicState } from '../physics/state'
import { appendHistory, emptyHistory, HISTORY_SECOND_LIMIT } from './history'
import type { History } from './history'

const PRESSURE_ROW = NOMINAL_ANCHOR_COUNT * NOMINAL_PRESSURE_CHANNELS
const FLOW_ROW = NOMINAL_ANCHOR_COUNT
const ROWS_PER_SECOND = 1_000_000 / PRESSURE_PERIOD_US
export const NOMINAL_HISTORY_SECOND_BYTES = (ROWS_PER_SECOND * PRESSURE_ROW + 1_000_000 / FLOW_PERIOD_US * FLOW_ROW)
  * Float64Array.BYTES_PER_ELEMENT
export const MAX_NOMINAL_HISTORY_BYTES = HISTORY_SECOND_LIMIT * NOMINAL_HISTORY_SECOND_BYTES

export interface NominalPredictionHistory {
  readonly profileId: FluidProfile['profileId']
  readonly frames: History<Float64Array, readonly HydraulicState[]>
  readonly controls: readonly AppliedControl[]
  readonly bytes: number
}

export function emptyNominalPredictionHistory(profileId: FluidProfile['profileId']): NominalPredictionHistory {
  return { profileId, frames: emptyHistory(), controls: [], bytes: 0 }
}

export function nominalPredictionHistoryBytes(history: NominalPredictionHistory | null | undefined): number {
  return history?.bytes ?? 0
}

export function appendNominalPredictions(
  history: NominalPredictionHistory,
  batch: PublicBatch,
  checkpoint: readonly HydraulicState[] | null,
  controls: readonly AppliedControl[],
): NominalPredictionHistory | null {
  const { sampleTimeUs, predictions } = batch
  const priorUs = history.frames.lastTimeUs
  if (sampleTimeUs !== (priorUs < 0 ? 0 : priorUs + PRESSURE_PERIOD_US) || predictions.length !== NOMINAL_ANCHOR_COUNT) return null
  const flowTick = sampleTimeUs % FLOW_PERIOD_US === 0
  const row = new Float64Array(PRESSURE_ROW + (flowTick ? FLOW_ROW : 0))
  for (const [index, prediction] of predictions.entries()) {
    if (prediction.anchorId !== index || prediction.sampleTimeUs !== sampleTimeUs || prediction.profileId !== history.profileId
      || prediction.bankVersion !== BANK_VERSION || prediction.modelVersion !== MODEL_VERSION
      || prediction.pressurePa.length !== NOMINAL_PRESSURE_CHANNELS || !prediction.pressurePa.every(Number.isFinite)
      || !Number.isFinite(prediction.inletFlowM3s)) return null
    row.set(prediction.pressurePa, index * NOMINAL_PRESSURE_CHANNELS)
    if (flowTick) row[PRESSURE_ROW + index] = prediction.inletFlowM3s
  }
  const frames = appendHistory(history.frames, sampleTimeUs, row, checkpoint)
  const oldSecond = history.frames.seconds[0]
  const evictedBytes = oldSecond && oldSecond.startUs !== frames.seconds[0]?.startUs
    ? oldSecond.frames.reduce((total, { frame }) => total + frame.byteLength, 0) : 0
  return { ...history, frames, controls, bytes: history.bytes + row.byteLength - evictedBytes }
}

export function freezeNominalPredictionCache(
  history: NominalPredictionHistory | null | undefined,
  checkpoint: readonly HydraulicState[],
  job: NominalPredictionJobIdentity,
): NominalPredictionCache | null {
  const { windowStartUs: start, windowEndUs: end } = job
  const durationUs = end - start
  const source = job.checkpointsByAnchor[0]
  if (!history || history.profileId !== job.profileId || !source || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || (durationUs !== 4_000_000 && durationUs !== 30_000_000)
    || !history.frames.seconds.some((second) => second.startUs === source.timeUs && second.checkpoint === checkpoint)) return null
  const controlKey = nominalControlKey(history.controls.filter(({ appliedTimeUs }) => appliedTimeUs <= end))
  if (controlKey !== nominalControlKey(job.appliedControls)) return null

  const pressureTicks = nominalTickCount(start, end, PRESSURE_PERIOD_US)
  const flowTicks = nominalTickCount(start, end, FLOW_PERIOD_US)
  const pressurePa = new Float64Array(pressureTicks * PRESSURE_ROW)
  const inletFlowM3s = new Float64Array(flowTicks * FLOW_ROW)
  const pressureStart = firstNominalTick(start, PRESSURE_PERIOD_US)
  let pressureIndex = 0
  let flowIndex = 0
  for (const second of history.frames.seconds) {
    for (const { timeUs, frame } of second.frames) {
      if (timeUs < start || timeUs > end) continue
      if (timeUs !== pressureStart + pressureIndex * PRESSURE_PERIOD_US) return null
      const flowTick = timeUs % FLOW_PERIOD_US === 0
      if (frame.length !== PRESSURE_ROW + (flowTick ? FLOW_ROW : 0)) return null
      pressurePa.set(frame.subarray(0, PRESSURE_ROW), pressureIndex++ * PRESSURE_ROW)
      if (flowTick) inletFlowM3s.set(frame.subarray(PRESSURE_ROW), flowIndex++ * FLOW_ROW)
    }
  }
  if (pressureIndex !== pressureTicks || flowIndex !== flowTicks) return null
  const cache = {
    version: NOMINAL_PREDICTION_CACHE_VERSION,
    modelVersion: job.modelVersion, bankVersion: job.bankVersion, profileId: job.profileId,
    windowStartUs: start, windowEndUs: end, checkpointTimeUs: source.timeUs, checkpointControlRevision: source.controlRevision,
    controlRevision: job.controlRevision, controlKey, parameterHashes: job.checkpointsByAnchor.map(({ parameterHash }) => parameterHash),
    pressurePa, inletFlowM3s,
  } as const
  return nominalPredictionCacheMatches(cache, job) ? cache : null
}
