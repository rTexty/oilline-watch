import { PRESSURE_PERIOD_US } from '../contracts/public'
import type { PublicPrediction } from '../contracts/public'
import type { DiagnosticJob } from '../contracts/inference'
import type { AnchorId } from '../contracts/model'
import type { HydraulicState } from '../physics/state'
import { predict } from '../twin/predict'
import type { ForwardContext } from './initial-state'

const SNAPSHOT_PERIOD_US = 1_000_000
// A 30 s window, its 3 s guard, and at most 1 s before the guard checkpoint.
const MAX_PREFIX_SPAN_US = 34_000_000
const CHANNEL_COUNT = 4

function firstObservationUs(job: DiagnosticJob): number {
  return Math.ceil(job.windowStartUs / PRESSURE_PERIOD_US) * PRESSURE_PERIOD_US
}

function observationCount(job: DiagnosticJob): number {
  return Math.max(0, Math.floor((job.windowEndUs - firstObservationUs(job)) / PRESSURE_PERIOD_US) + 1)
}

export function forwardPrefixCacheBytes(job: DiagnosticJob): number {
  if (job.controlRevision !== 0 || job.appliedControls.length > 0) return 0
  const observationBytes = observationCount(job) * CHANNEL_COUNT * Float64Array.BYTES_PER_ELEMENT
  let total = 0
  for (const checkpoint of job.checkpointsByAnchor) {
    if (checkpoint.memory.kind !== 'none' || checkpoint.controlRevision !== 0
      || job.windowEndUs - checkpoint.timeUs > MAX_PREFIX_SPAN_US) return 0
    const snapshots = Math.floor(job.windowEndUs / SNAPSHOT_PERIOD_US) - Math.floor(checkpoint.timeUs / SNAPSHOT_PERIOD_US)
    if (snapshots <= 0) return 0
    // Three nodal fields, two cell temperatures and four directional face volumes.
    const snapshotBytes = (3 * checkpoint.grid.nodeCount + 2 * checkpoint.grid.cellCount
      + 4 * checkpoint.grid.faceCount) * Float64Array.BYTES_PER_ELEMENT
    total += snapshots * snapshotBytes + observationBytes
  }
  return total
}

interface PrefixSnapshot {
  readonly state: HydraulicState
  readonly iterations: number
}

class AnchorPrefix {
  private readonly snapshots: PrefixSnapshot[] = []
  private readonly values: Float64Array
  private observedRows = 0

  constructor(private readonly firstUs: number, count: number) {
    this.values = new Float64Array(count * CHANNEL_COUNT)
  }

  record(state: HydraulicState, iterations: number, prediction: PublicPrediction | undefined) {
    const { timeUs } = state
    if (prediction && timeUs === this.firstUs + this.observedRows * PRESSURE_PERIOD_US) {
      const offset = this.observedRows++ * CHANNEL_COUNT
      this.values.set(prediction.pressurePa, offset)
      this.values[offset + 3] = prediction.inletFlowM3s
    }
    if (iterations > 0 && timeUs % SNAPSHOT_PERIOD_US === 0
      && timeUs > (this.snapshots.at(-1)?.state.timeUs ?? -1)
      && timeUs <= this.firstUs + this.observedRows * PRESSURE_PERIOD_US) {
      // Accepted states own immutable solver buffers. Reusing one avoids a copy of the hydraulic and thermal ledgers.
      this.snapshots.push({ state, iterations })
    }
  }

  find(cutoffUs: number): PrefixSnapshot | undefined {
    return this.snapshots.findLast(({ state }) => state.timeUs <= cutoffUs)
  }

  fillTrace(trace: Map<number, PublicPrediction>, snapshot: PrefixSnapshot, anchorId: AnchorId): void {
    const identity = predict(snapshot.state, anchorId)
    for (let timeUs = this.firstUs, offset = 0; timeUs < snapshot.state.timeUs; timeUs += PRESSURE_PERIOD_US, offset += CHANNEL_COUNT) {
      trace.set(timeUs, { ...identity, sampleTimeUs: timeUs,
        pressurePa: [this.values[offset]!, this.values[offset + 1]!, this.values[offset + 2]!],
        inletFlowM3s: this.values[offset + 3]! })
    }
  }
}

export interface ForwardPrefixCache {
  readonly forAnchor: (context: ForwardContext, anchorId: AnchorId) => AnchorPrefix | undefined
  readonly recordHit: (durationUs: number) => void
  readonly statistics: () => { readonly hits: number; readonly skippedUs: number }
}

export function createForwardPrefixCache(context: ForwardContext): ForwardPrefixCache | undefined {
  if (forwardPrefixCacheBytes(context.job) === 0 || context.anchors.some(({ state, flow, pulse }) =>
    flow.length > 0 || pulse !== null || Boolean(state.inputs.leak || state.inputs.inletLaw || state.inputs.outletPulse
      || state.zielke || state.vardyBrown || state.profile.zielkeKernel || state.profile.vardyBrownKernel)
    || state.profile.definition.mode !== 'turbulent'
    || state.profile.definition.publicFluidProfile.phaseQualification !== 'stipulated-synthetic'
    || context.job.windowEndUs > state.profile.definition.horizonUs)) return undefined
  const anchors = new Map<AnchorId, AnchorPrefix>()
  let hits = 0
  let skippedUs = 0
  return {
    forAnchor(current, anchorId) {
      if (current !== context) return undefined
      const existing = anchors.get(anchorId)
      if (existing) return existing
      const anchor = new AnchorPrefix(firstObservationUs(context.job), observationCount(context.job))
      anchors.set(anchorId, anchor)
      return anchor
    },
    recordHit(durationUs) {
      hits++
      skippedUs += durationUs
    },
    statistics: () => ({ hits, skippedUs }),
  }
}
