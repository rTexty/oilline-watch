import type { AnchorId } from '../contracts/model'
import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { SensorId } from '../contracts/public'
import { DICTIONARY_CHANNELS } from '../contracts/response-dictionary'
import { advanceTo } from '../physics/advance-to'
import type { LeakLaw } from '../physics/leak'
import type { HydraulicState } from '../physics/state'
import { predict } from '../twin/predict'
import { ANCHOR_IDS, OPENINGS_US } from './optimizer'
import { prepareResponse, screeningNodes, unitResponse } from './screening'
import type { PreparedResponse, ResponseDictionary } from './screening'

export const ENVELOPE_NODE_COUNT = 199
export const ENVELOPE_CELL_COUNT = ENVELOPE_NODE_COUNT * ANCHOR_IDS.length
export const ENVELOPE_DURATION_US = 33_000_000
export const ENVELOPE_AREAS_M2 = [5e-6, 1e-5, 2e-5, 4e-5] as const
export const ENVELOPE_ONSETS_US = [0, 250_000, 500_000, 750_000] as const
export const ENVELOPE_CASES_PER_CELL = ENVELOPE_AREAS_M2.length * OPENINGS_US.length * ENVELOPE_ONSETS_US.length
export const ENVELOPE_TRACE_COUNT = ENVELOPE_CELL_COUNT * ENVELOPE_CASES_PER_CELL
const CHANNELS = ['P1', 'P2', 'P3', 'Qin'] as const

export type EnvelopeNoise = Readonly<Record<SensorId, { readonly sigmaSI: number; readonly rho: number }>>

export function envelopeCell(cellId: number) {
  if (!Number.isSafeInteger(cellId) || cellId < 0 || cellId >= ENVELOPE_CELL_COUNT) {
    throw new RangeError('Spatial envelope cell index is outside the fit grid.')
  }
  return { anchorId: ANCHOR_IDS[Math.floor(cellId / ENVELOPE_NODE_COUNT)]!, node: cellId % ENVELOPE_NODE_COUNT + 1 }
}

export function spatialEnvelopeCases(cellId: number) {
  const cell = envelopeCell(cellId)
  return ENVELOPE_AREAS_M2.flatMap((cdAreaM2, areaIndex) =>
    OPENINGS_US.flatMap((openingUs, openingIndex) => ENVELOPE_ONSETS_US.map((onsetUs, phaseIndex) => ({
      ...cell, cdAreaM2, openingUs, onsetUs,
      caseIndex: (areaIndex * OPENINGS_US.length + openingIndex) * ENVELOPE_ONSETS_US.length + phaseIndex,
    }))),
  )
}

export function shardEnvelopeCells(shardIndex: number, shards: number): readonly number[] {
  if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shards) || shards <= 0
    || shardIndex < 0 || shardIndex >= shards) throw new RangeError('Spatial envelope shard index is invalid.')
  return Array.from({ length: Math.max(0, Math.ceil((ENVELOPE_CELL_COUNT - shardIndex) / shards)) },
    (_, index) => shardIndex + index * shards)
}

export function whitenedTraceDiscrepancy(exact: Float64Array, surrogate: Float64Array, noise: EnvelopeNoise): number {
  if (exact.length === 0 || exact.length !== surrogate.length || exact.length % DICTIONARY_CHANNELS !== 0
    || !exact.every(Number.isFinite) || !surrogate.every(Number.isFinite)) {
    throw new RangeError('Spatial envelope traces must contain equally sized finite channel samples.')
  }
  let sumSquares = 0
  for (const [channel, sensor] of CHANNELS.entries()) {
    const { sigmaSI, rho } = noise[sensor]
    const scale = sigmaSI * Math.sqrt(1 - rho ** 2)
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Spatial envelope noise must have positive finite innovation variance.')
    const stride = DICTIONARY_CHANNELS * (sensor === 'Qin' ? FLOW_PERIOD_US / PRESSURE_PERIOD_US : 1)
    let previous = exact[channel]! - surrogate[channel]!
    for (let index = channel + stride; index < exact.length; index += stride) {
      const current = exact[index]! - surrogate[index]!
      sumSquares += ((current - rho * previous) / scale) ** 2
      previous = current
    }
  }
  if (!Number.isFinite(sumSquares)) throw new RangeError('Spatial envelope innovation norm overflowed.')
  return Math.sqrt(sumSquares)
}

interface EnvelopeAnchor {
  readonly anchorId: AnchorId
  readonly nominal: Float64Array
  readonly checkpoint: HydraulicState
  readonly responses: ReadonlyMap<number, PreparedResponse>
}

function forecast(checkpoint: HydraulicState, anchorId: AnchorId, leak?: LeakLaw): Float64Array {
  const samples = ENVELOPE_DURATION_US / PRESSURE_PERIOD_US + 1
  const trace = new Float64Array(samples * DICTIONARY_CHANNELS)
  let state = checkpoint
  for (let sample = 0; sample < samples; sample++) {
    if (sample > 0) {
      const result = advanceTo(state, sample * PRESSURE_PERIOD_US, sample === 1 && leak ? { leak } : undefined)
      if (!result.ok) throw result.error
      state = result.value
    }
    const { pressurePa, inletFlowM3s } = predict(state, anchorId)
    const index = sample * DICTIONARY_CHANNELS
    trace[index] = pressurePa[0]
    trace[index + 1] = pressurePa[1]
    trace[index + 2] = pressurePa[2]
    trace[index + 3] = inletFlowM3s
  }
  return trace
}

export function prepareEnvelopeAnchor(
  checkpoint: HydraulicState,
  anchorId: AnchorId,
  dictionary: ResponseDictionary,
): EnvelopeAnchor {
  const { definition } = checkpoint.profile
  if (checkpoint.timeUs !== 0 || checkpoint.inputs.leak != null || checkpoint.inputs.qoutM3s !== undefined
    || checkpoint.inputs.pinPa !== undefined || checkpoint.inputs.tinK !== undefined || checkpoint.inputs.ambientK !== undefined
    || definition.mode !== 'turbulent' || definition.geometry.lengthM !== 1000 || definition.grid.segments !== 200
    || definition.horizonUs < ENVELOPE_DURATION_US) {
    throw new Error('Spatial envelope fit requires a canonical steady F64 anchor at model time zero.')
  }
  const responses = new Map(dictionary.traces.flatMap((trace) =>
    trace.model === 'ML' && trace.anchorId === anchorId ? [[trace.node, prepareResponse(trace)] as const] : []))
  if (responses.size !== screeningNodes(ENVELOPE_NODE_COUNT).length
    || screeningNodes(ENVELOPE_NODE_COUNT).some((node) => !responses.has(node))
    || [...responses.values()].some((response) => response.lastSampleUs < ENVELOPE_DURATION_US)) {
    throw new Error('Spatial envelope fit needs every steady leak response through 33 seconds.')
  }
  return { anchorId, checkpoint, nominal: forecast(checkpoint, anchorId), responses }
}

function bracket(node: number, responses: ReadonlyMap<number, PreparedResponse>) {
  const nodes = screeningNodes(ENVELOPE_NODE_COUNT)
  const lower = nodes.findLast((candidate) => candidate <= node)!
  const upper = nodes.find((candidate) => candidate >= node)!
  return {
    lower: responses.get(lower)!, upper: responses.get(upper)!,
    fraction: upper === lower ? 0 : (node - lower) / (upper - lower),
  }
}

export function measureSpatialCell(anchor: EnvelopeAnchor, cellId: number, noise: EnvelopeNoise): readonly number[] {
  return measureSpatialCellForLayouts(anchor, cellId, [noise])[0]!
}

export function measureSpatialCellForLayouts(
  anchor: EnvelopeAnchor, cellId: number, noises: readonly EnvelopeNoise[],
): readonly (readonly number[])[] {
  if (noises.length === 0) throw new RangeError('Spatial envelope fit requires at least one noise layout.')
  const cases = spatialEnvelopeCases(cellId)
  const cell = cases[0]!
  if (cell.anchorId !== anchor.anchorId) throw new Error('Spatial envelope cell does not match its immutable F64 anchor.')
  const { lower, upper, fraction } = bracket(cell.node, anchor.responses)
  const byCase = cases.map(({ node, cdAreaM2, onsetUs, openingUs }) => {
    const exact = forecast(anchor.checkpoint, anchor.anchorId, { node, cdA: cdAreaM2, onsetUs, rampUs: openingUs })
    const surrogate = anchor.nominal.map((nominal, index) => {
      const sensor = CHANNELS[index % DICTIONARY_CHANNELS]!
      const timeUs = Math.floor(index / DICTIONARY_CHANNELS) * PRESSURE_PERIOD_US
      const low = unitResponse(lower, sensor, timeUs, onsetUs, openingUs)
      const high = lower === upper ? low : unitResponse(upper, sensor, timeUs, onsetUs, openingUs)
      return nominal + cdAreaM2 * (low + fraction * (high - low))
    })
    return noises.map((noise) => whitenedTraceDiscrepancy(exact, surrogate, noise))
  })
  return noises.map((_, index) => byCase.map((norms) => norms[index]!))
}
