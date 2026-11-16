import type { DiagnosticResult } from '../contracts/inference'
import type { RankedTrial } from './optimizer'

export function optimisticScore(surrogateScore: number, discrepancyNorm: number, multiplier: number): number {
  if (![surrogateScore, discrepancyNorm, multiplier].every(Number.isFinite)
    || surrogateScore < 0 || discrepancyNorm < 0 || multiplier < 1) {
    throw new RangeError('Invalid profile discrepancy bound.')
  }
  return Math.max(0, Math.sqrt(surrogateScore) - multiplier * discrepancyNorm) ** 2
}

export function unresolvedRegions(lengthM: number, segments: number): DiagnosticResult['compatibleRegions'] {
  const halfCell = lengthM / segments / 2
  if (!Number.isFinite(lengthM) || lengthM <= 0 || !Number.isSafeInteger(segments) || segments < 2) {
    throw new RangeError('Invalid localization grid.')
  }
  return [{ startM: halfCell, endM: lengthM - halfCell, status: 'unresolved' }]
}

// Exact fits provide positive evidence for individual cells. Only an independently
// qualified discrepancy envelope can exclude the cells this bounded search misses.
export function annotateExactRegions(
  lengthM: number,
  segments: number,
  trials: readonly RankedTrial[],
  observationCount: number,
  thresholds: { readonly absoluteFit: number; readonly profile: number },
  excludedNodes?: ReadonlySet<number>,
): DiagnosticResult['compatibleRegions'] {
  const fallback = unresolvedRegions(lengthM, segments)
  if (!Number.isSafeInteger(observationCount) || observationCount <= 0
    || !Number.isFinite(thresholds.absoluteFit) || thresholds.absoluteFit < 0
    || !Number.isFinite(thresholds.profile) || thresholds.profile < 0) return fallback

  const fits = trials.flatMap(({ candidate, score }) => candidate.model === 'ML' && candidate.cdAreaM2 > 0
    && Number.isSafeInteger(candidate.node) && candidate.node > 0 && candidate.node < segments
    && Number.isFinite(score) && score >= 0 ? [{ node: candidate.node, score }] : [])
  const best = Math.min(...fits.map(({ score }) => score))
  const compatible = new Set(fits.filter(({ score }) => score / observationCount <= thresholds.absoluteFit
    && score - best <= thresholds.profile).map(({ node }) => node))
  if (compatible.size === 0) return fallback

  const spacing = lengthM / segments
  const regions: DiagnosticResult['compatibleRegions'][number][] = []
  for (let node = 1; node < segments; node++) {
    if (!compatible.has(node) && excludedNodes?.has(node)) continue
    const status = compatible.has(node) ? 'compatible' : 'unresolved'
    const startM = (node - 0.5) * spacing
    const endM = (node + 0.5) * spacing
    const previous = regions.at(-1)
    if (previous?.status === status && previous.endM === startM) regions[regions.length - 1] = { ...previous, endM }
    else regions.push({ startM, endM, status })
  }
  return regions
}
