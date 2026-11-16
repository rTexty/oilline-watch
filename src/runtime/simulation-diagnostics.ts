import type { InferenceAuditJob, InverseProvisionalAudit, WarmupReplay } from '../contracts/inference-audit'
import type { DiagnosticResult } from '../contracts/inference'
import type { DetectorState } from '../detection/detector'
import type { Engine } from './engine'
import { appliedControlRevision } from './public-controls'
import type { RunSnapshot } from './vertical-protocol'

interface DiagnosticSummaryInput {
  readonly engine: Engine | null
  readonly detector: DetectorState | null
  readonly warmupUs: number
  readonly awaitingDictionary: boolean
  readonly auditFull: boolean
  readonly residualPa: RunSnapshot['residualPa']
  readonly diagnosis: DiagnosticResult | null
  readonly provisional: InverseProvisionalAudit | null
}

export function diagnosticSummary({
  engine, detector, warmupUs, awaitingDictionary, auditFull, residualPa, diagnosis, provisional,
}: DiagnosticSummaryInput): RunSnapshot['diagnostic'] {
  if (!engine) return null
  const qualified = !awaitingDictionary && detector?.calibration != null
  const availability = engine.timeUs < warmupUs ? 'insufficient-history'
    : qualified ? detector?.status === 'ready' ? 'available' : 'missing'
      : residualPa.some((value) => value !== null) ? 'available' : 'missing'
  const explanation = awaitingDictionary ? 'Проверяется словарь откликов.'
    : !qualified ? 'Показаны причинные невязки. Порог тревоги и локализация требуют калибровки.'
    : detector?.status === 'insufficient-data' ? 'Недостаточно валидных измерений для тревоги.'
      : auditFull ? 'Исчерпан лимит журнала поиска.'
        : !detector?.canLocalize ? 'Для локализации нужны штатные отсчёты давления и входного расхода.'
        : diagnosis?.searchComplete ? 'Сравнение гипотез завершено.' : 'Показаны только проверенные оценки. Необследованные области остаются открытыми.'
  const controlRevision = appliedControlRevision(engine.journal, engine.timeUs)
  const preview = detector?.canLocalize ? provisional?.result : undefined
  return { availability, explanation, qualified, alarmAtUs: detector?.lastAlarmUs ?? null, alarmOpen: detector?.episode != null,
    historical: diagnosis !== null && diagnosis.controlRevision !== controlRevision,
    result: detector?.canLocalize ? diagnosis : null,
    provisional: preview,
    provisionalHistorical: preview ? preview.controlRevision !== controlRevision : undefined }
}

export function matchesReplayWarmup(expected: WarmupReplay, actual: WarmupReplay): boolean {
  return expected.anchorId === actual.anchorId && expected.frozenBaselines.every((baseline, index) =>
    (['P1', 'P2', 'P3', 'Qin'] as const).every((id) => {
      const before = baseline.meanBySensor[id]
      const after = actual.frozenBaselines[index]!.meanBySensor[id]
      return Math.abs(before - after) <= 1e-8 + 1e-12 * Math.max(Math.abs(before), Math.abs(after))
    }))
}

export function matchesReplayResponse(expected: InferenceAuditJob, response: {
  readonly matched: boolean
  readonly decision?: DiagnosticResult
  readonly provisional?: InverseProvisionalAudit
}): boolean {
  const { decision, provisional } = response
  const recorded = expected.provisional
  const validProvisional = recorded ? provisional?.check === recorded.check
    && provisional.publishedAtUs === recorded.publishedAtUs && provisional.result.jobId === expected.jobId : !provisional
  const validDecision = expected.decisionReplay ? decision?.jobId === expected.jobId
    && decision.finishedAtUs === expected.finishedAtUs && decision.observedThroughUs === expected.endUs : !decision
  return response.matched && validDecision && validProvisional
}
