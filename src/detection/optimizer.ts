import type { AnchorId } from '../contracts/model'

export const ANCHOR_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const
export const OPENINGS_US = [0, 1_000_000, 20_000_000] as const
export const MAX_CD_AREA_M2 = 4e-5
export const MAX_OUTLET_FRACTION = 0.05

type OpeningUs = typeof OPENINGS_US[number]
type EventParameters = { readonly onsetUs: number; readonly openingUs: OpeningUs }

export type HydraulicCandidate =
  | { readonly model: 'M0'; readonly anchorId: AnchorId }
  | ({ readonly model: 'ML'; readonly anchorId: AnchorId; readonly node: number; readonly cdAreaM2: number } & EventParameters)
  | ({ readonly model: 'MB'; readonly anchorId: AnchorId; readonly amplitudeM3s: number } & EventParameters)

export type DisturbanceCandidate = Exclude<HydraulicCandidate, { model: 'M0' }>

export interface CandidateBounds {
  readonly firstOnsetUs: number
  readonly lastOnsetUs: number
  readonly lastNode: number
  readonly nominalFlowM3s: number
}

export interface RankedTrial {
  readonly candidate: HydraulicCandidate
  readonly score: number
}

function coordinates(candidate: HydraulicCandidate): readonly number[] {
  const { model, anchorId } = candidate
  if (model === 'M0') return [0, 0, anchorId]
  if (model === 'ML') return [1, candidate.node, anchorId, candidate.onsetUs, candidate.openingUs, candidate.cdAreaM2]
  return [2, 0, anchorId, candidate.onsetUs, candidate.openingUs, candidate.amplitudeM3s]
}

export function candidateKey(candidate: HydraulicCandidate): string {
  return coordinates(candidate).join('/')
}

export function compareTrials(left: RankedTrial, right: RankedTrial): number {
  const score = left.score - right.score
  if (score !== 0) return score
  const rightOrder = coordinates(right.candidate)
  for (const [index, value] of coordinates(left.candidate).entries()) {
    const difference = value - (rightOrder[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

export const MAX_REFINEMENT_LEVEL = 5

export function neighbors(candidate: DisturbanceCandidate, bounds: CandidateBounds, level: number): readonly DisturbanceCandidate[] {
  const ratio = 2 ** clamp(level, 0, MAX_REFINEMENT_LEVEL)
  const timeStepUs = Math.max(31_250, 500_000 / ratio)
  const spatialStep = Math.max(1, Math.round(5 / ratio))
  const timeChoices = [-timeStepUs, timeStepUs].map((delta) => ({
    ...candidate, onsetUs: clamp(candidate.onsetUs + delta, bounds.firstOnsetUs, bounds.lastOnsetUs),
  }))
  const anchors = candidate.model === 'ML' ? ANCHOR_IDS.map((anchorId) => ({ ...candidate, anchorId })) : []
  const openings = OPENINGS_US.map((openingUs) => ({ ...candidate, openingUs }))
  const disturbanceChoices = candidate.model === 'ML'
    ? [
      ...[-spatialStep, spatialStep].map((delta) => ({ ...candidate, node: clamp(candidate.node + delta, 1, bounds.lastNode) })),
      ...[-1, 1].map((direction) => ({
        ...candidate, cdAreaM2: clamp(Number((candidate.cdAreaM2 + direction * 5e-6 / ratio).toPrecision(12)), 0, MAX_CD_AREA_M2),
      })),
    ]
    : [-1, 1].map((direction) => ({
      ...candidate,
      amplitudeM3s: clamp(Number((candidate.amplitudeM3s + direction * 0.01 * bounds.nominalFlowM3s / ratio).toPrecision(12)),
        -MAX_OUTLET_FRACTION * bounds.nominalFlowM3s, MAX_OUTLET_FRACTION * bounds.nominalFlowM3s),
    }))

  const choices = [...anchors, ...disturbanceChoices, ...timeChoices, ...openings]
  const key = candidateKey(candidate)
  const unique = new Map(choices.map((choice) => [candidateKey(choice), choice]))
  unique.delete(key)
  return [...unique.values()]
}
