import type { AnchorId } from '../contracts/model'
import { firstNominalTick, NOMINAL_ANCHOR_COUNT, NOMINAL_PRESSURE_CHANNELS,
  nominalPredictionCacheMatches, nominalPredictionCacheSchema } from '../contracts/nominal-predictions'
import type { NominalPredictionCache, NominalPredictionJobIdentity } from '../contracts/nominal-predictions'
import { FLOW_PERIOD_US, PRESSURE_PERIOD_US } from '../contracts/public'
import type { CandidatePrediction } from './hypotheses'

const PRESSURE_INDEX = { P1: 0, P2: 1, P3: 2 } as const

export function prepareNominalPredictionCache(
  job: NominalPredictionJobIdentity & { readonly nominalPredictionCache?: NominalPredictionCache },
): ((anchorId: AnchorId) => CandidatePrediction) | null {
  if (!job.nominalPredictionCache) return null
  const parsed = nominalPredictionCacheSchema.safeParse(job.nominalPredictionCache)
  if (!parsed.success || !nominalPredictionCacheMatches(parsed.data, job)) return null
  const { windowStartUs: start, windowEndUs: end, pressurePa, inletFlowM3s } = parsed.data
  const pressureStart = firstNominalTick(start, PRESSURE_PERIOD_US)
  const flowStart = firstNominalTick(start, FLOW_PERIOD_US)
  return (anchorId) => (sensor, timeUs) => {
    if (timeUs < start || timeUs > end) return undefined
    if (sensor === 'Qin') {
      if (timeUs % FLOW_PERIOD_US !== 0) return undefined
      return inletFlowM3s[(timeUs - flowStart) / FLOW_PERIOD_US * NOMINAL_ANCHOR_COUNT + anchorId]
    }
    if (timeUs % PRESSURE_PERIOD_US !== 0) return undefined
    const row = (timeUs - pressureStart) / PRESSURE_PERIOD_US * NOMINAL_ANCHOR_COUNT + anchorId
    return pressurePa[row * NOMINAL_PRESSURE_CHANNELS + PRESSURE_INDEX[sensor]]
  }
}
