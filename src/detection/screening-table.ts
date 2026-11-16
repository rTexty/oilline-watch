import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { SensorId } from '../contracts/public'
import { DICTIONARY_CHANNELS } from '../contracts/response-dictionary'
import { ANCHOR_IDS, OPENINGS_US } from './optimizer'
import { screeningCandidateFromSums, unitResponse, unitResponseAtNativeTick } from './screening'
import type { PreparedResponse, ScreeningRow } from './screening'

const RESPONSE_PADDING = FLOW_PERIOD_US / PRESSURE_PERIOD_US
const MAX_TICK = 0xffff_ffff

interface NativeRowGroup {
  readonly sensorId: SensorId
  readonly stride: number
  readonly scale: number
  readonly rho: number
  readonly currentTicks: Uint32Array
  readonly residuals: Float64Array
}

interface NativeScreeningRows {
  readonly groups: readonly NativeRowGroup[]
  readonly lastTick: number
  readonly baseline: number
}

export function nativeScreeningWorkspaceBytes(observationCount: number, largestResponseBytes: number): number {
  const rowBytes = ANCHOR_IDS.length * observationCount * (Uint32Array.BYTES_PER_ELEMENT + Float64Array.BYTES_PER_ELEMENT)
  const paddingBytes = DICTIONARY_CHANNELS * RESPONSE_PADDING * Float64Array.BYTES_PER_ELEMENT
  // Retain row groups for all anchors, then integrate and tabulate one response at a time.
  return rowBytes + largestResponseBytes + OPENINGS_US.length * (largestResponseBytes + paddingBytes)
}

function prepareGroup(rows: readonly ScreeningRow[], first: number, end: number): NativeRowGroup | null {
  const { sensorId, rho, scale } = rows[first]!
  if (!Number.isFinite(rho) || !Number.isFinite(scale) || scale <= 0) return null
  const stride = sensorId === 'Qin' ? RESPONSE_PADDING : 1
  const currentTicks = new Uint32Array(end - first)
  const residuals = new Float64Array(end - first)
  let previousTick = -1
  for (let index = first; index < end; index++) {
    const row = rows[index]!
    const tick = row.currentTimeUs / PRESSURE_PERIOD_US
    if (!Number.isSafeInteger(tick) || tick < stride || tick > MAX_TICK || tick <= previousTick
      || row.previousTimeUs !== (tick - stride) * PRESSURE_PERIOD_US
      || !Object.is(row.scale, scale) || !Object.is(row.rho, rho) || !Number.isFinite(row.residual)) return null
    currentTicks[index - first] = tick
    residuals[index - first] = row.residual
    previousTick = tick
  }
  return { sensorId, stride, scale, rho, currentTicks, residuals }
}

export function prepareNativeScreeningRows(rows: readonly ScreeningRow[]): NativeScreeningRows | null {
  const groups: NativeRowGroup[] = []
  let lastTick = -1
  let first = 0
  while (first < rows.length) {
    const { sensorId } = rows[first]!
    if (groups.some((group) => group.sensorId === sensorId)) return null
    let end = first + 1
    while (end < rows.length && rows[end]!.sensorId === sensorId) end++
    const group = prepareGroup(rows, first, end)
    if (!group) return null
    groups.push(group)
    lastTick = Math.max(lastTick, group.currentTicks.at(-1)!)
    first = end
  }
  const baseline = rows.reduce((sum, row) => sum + row.residual ** 2, 0)
  return { groups, lastTick, baseline }
}

function responseSamples(response: PreparedResponse, sensorId: SensorId, openingUs: typeof OPENINGS_US[number]) {
  const ticks = response.lastSampleUs / PRESSURE_PERIOD_US + 1
  const aligned = Number.isInteger(ticks)
  const values = new Float64Array(ticks + RESPONSE_PADDING)
  let firstNonzeroTick = ticks
  for (let tick = 0; tick < ticks; tick++) {
    const value = aligned ? unitResponseAtNativeTick(response, sensorId, tick, openingUs)
      : unitResponse(response, sensorId, tick * PRESSURE_PERIOD_US, 0, openingUs)
    if (firstNonzeroTick === ticks && value !== 0) firstNonzeroTick = tick
    values[tick + RESPONSE_PADDING] = value
  }
  return { values, firstNonzeroTick }
}

function lowerBound(ticks: Uint32Array, target: number): number {
  let low = 0
  let high = ticks.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (ticks[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

export function prepareNativeScreeningTable(response: PreparedResponse, rows: NativeScreeningRows) {
  const tables = new Map(OPENINGS_US.map((openingUs) =>
    [openingUs, rows.groups.map(({ sensorId }) => responseSamples(response, sensorId, openingUs))]))
  return (onsetUs: number, openingUs: typeof OPENINGS_US[number], nominalFlowM3s: number) => {
    const onset = onsetUs / PRESSURE_PERIOD_US
    if (!Number.isSafeInteger(onset) || rows.lastTick - onset > response.lastSampleUs / PRESSURE_PERIOD_US) return undefined
    const samples = tables.get(openingUs)!
    let numerator = 0
    let denominator = 0
    for (let channel = 0; channel < rows.groups.length; channel++) {
      const { currentTicks, residuals, scale, rho, stride } = rows.groups[channel]!
      const { firstNonzeroTick, values } = samples[channel]!
      // Both response samples are zero before the first nonzero tick.
      const first = lowerBound(currentTicks, onset + firstNonzeroTick)
      for (let row = first; row < currentTicks.length; row++) {
        const index = currentTicks[row]! - onset + RESPONSE_PADDING
        const weight = (values[index]! - rho * values[index - stride]!) / scale
        numerator += weight * residuals[row]!
        denominator += weight ** 2
      }
    }
    return screeningCandidateFromSums(response.trace, onsetUs, openingUs, nominalFlowM3s, numerator, denominator, rows.baseline)
  }
}
