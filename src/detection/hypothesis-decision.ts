interface WithdrawalEvidence {
  readonly scores: Readonly<Record<'M0' | 'ML' | 'MB' | 'MS', number | null>>
  readonly observations: number
  readonly completed: boolean
  readonly available: boolean
  readonly positiveWithdrawal: boolean
  readonly profileQualified: boolean
}

interface FitStatistics {
  readonly improvement: number
  readonly separation: number
  readonly absoluteFit: number
}

interface FitDecision {
  readonly fitQuality: 'good' | 'poor' | 'unqualified'
  readonly supportsWithdrawal: boolean
  readonly statistics: FitStatistics | null
}

function validScore(score: number | null): score is number {
  return score !== null && Number.isFinite(score) && score >= 0
}

export function onsetIsLeftCensored(best: number | null, guard: number | null, nominal: number | null, profileCutoff: number): boolean {
  return validScore(best) && validScore(guard) && validScore(nominal) && validScore(profileCutoff)
    && guard < nominal && guard - best <= profileCutoff
}

function fitStatistics(evidence: WithdrawalEvidence): FitStatistics | null {
  const { scores: { M0, ML, MB, MS }, observations } = evidence
  if (!evidence.completed || !evidence.available || !Number.isSafeInteger(observations) || observations <= 0
    || !validScore(M0) || !validScore(ML) || !validScore(MB) || !validScore(MS)) return null
  return { improvement: M0 - ML, separation: Math.min(MB, MS) - ML, absoluteFit: ML / observations }
}

export function assessWithdrawalFit(evidence: WithdrawalEvidence, thresholds: FitStatistics | null): FitDecision {
  const statistics = fitStatistics(evidence)
  if (!statistics || !thresholds || !Number.isFinite(thresholds.improvement) || !Number.isFinite(thresholds.separation)
    || !validScore(thresholds.absoluteFit)) return { fitQuality: 'unqualified', supportsWithdrawal: false, statistics }
  const { improvement, separation, absoluteFit } = statistics
  const fitQuality = absoluteFit <= thresholds.absoluteFit ? 'good' : 'poor'
  return {
    fitQuality, statistics,
    supportsWithdrawal: fitQuality === 'good' && evidence.positiveWithdrawal && evidence.profileQualified
      && improvement > 0 && improvement >= thresholds.improvement && separation > 0 && separation >= thresholds.separation,
  }
}
