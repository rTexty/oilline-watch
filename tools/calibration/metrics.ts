import { createHash } from 'node:crypto'
import { CHALLENGE_US, PIPE_LENGTH_M, SENSOR_LAYOUTS } from './contracts'
import type { RunEvidence, Scenario } from './contracts'

function bisect(predicate: (value: number) => boolean, high: number): number {
  let low = 0
  for (let step = 0; step < 64; step++) {
    const middle = (low + high) / 2
    if (predicate(middle)) high = middle
    else low = middle
  }
  return (low + high) / 2
}

function logAdd(a: number, b: number): number {
  const larger = Math.max(a, b)
  return larger + Math.log1p(Math.exp(Math.min(a, b) - larger))
}

function binomialCdf(k: number, n: number, p: number): number {
  if (p === 0 || k >= n) return 1
  if (p === 1) return 0
  const ratio = Math.log(p) - Math.log1p(-p)
  let term = n * Math.log1p(-p)
  let sum = term
  for (let i = 1; i <= k; i++) {
    term += Math.log(n - i + 1) - Math.log(i) + ratio
    sum = logAdd(sum, term)
  }
  return Math.exp(sum)
}

export function binomialBounds(successes: number, trials: number) {
  if (!Number.isSafeInteger(trials) || !Number.isSafeInteger(successes) || successes < 0 || trials < successes) {
    throw new RangeError('Invalid binomial counts.')
  }
  if (trials === 0) return { successes, trials, estimate: null, lower95: null, upper95: null, twoSided95: null }
  const lower = (alpha: number) => successes === 0 ? 0 : bisect((p) => binomialCdf(successes - 1, trials, p) <= 1 - alpha, 1)
  const upper = (alpha: number) => successes === trials ? 1 : bisect((p) => binomialCdf(successes, trials, p) <= alpha, 1)
  return {
    successes, trials, estimate: successes / trials, lower95: lower(0.05), upper95: upper(0.05),
    twoSided95: [lower(0.025), upper(0.025)],
  }
}

export function poissonUpper(episodes: number, hours: number): number | null {
  if (!Number.isSafeInteger(episodes) || episodes < 0 || !Number.isFinite(hours) || hours < 0) throw new RangeError('Invalid exposure or event count.')
  if (hours === 0) return null
  function belowTail(mean: number): boolean {
    const logMean = Math.log(mean)
    let term = -mean
    let sum = term
    for (let i = 1; i <= episodes; i++) {
      term += logMean - Math.log(i)
      sum = logAdd(sum, term)
    }
    return sum <= Math.log(0.05)
  }
  let high = Math.max(8, episodes * 2)
  while (!belowTail(high)) high *= 2
  return bisect(belowTail, high) / hours
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function nearestRank(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  return values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!
}

function bootstrapMedian(values: readonly (number | null)[]) {
  const observed = values.filter((value) => value !== null)
  if (observed.length === 0) return { observed: 0, runs: values.length, estimate: null, twoSided95: null }
  let state = createHash('sha256').update('metrics-bootstrap-v1').digest().readUInt32LE(0)
  function draw(): number | null {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return values[Math.floor((state >>> 0) / 2 ** 32 * values.length)]!
  }
  const medians = Array.from({ length: 2000 }, () => median(Array.from({ length: values.length }, draw).filter((value) => value !== null)))
    .filter((value) => value !== null)
  return {
    observed: observed.length, runs: values.length, estimate: median(observed),
    twoSided95: [nearestRank(medians, 0.025), nearestRank(medians, 0.975)],
  }
}

export function leakEvaluation(scenario: Extract<Scenario, { kind: 'leak' }>, run: RunEvidence) {
  const support = run.supports.find((entry) => entry.timeUs >= scenario.onsetUs)
  const delayUs = support ? support.timeUs - scenario.onsetUs : null
  const timely = support && delayUs !== null && delayUs <= 30_000_000
  const regions = timely ? support.regions : []
  return {
    delayUs,
    localized: regions.length > 0,
    covered: regions.some(([left, right]) => scenario.positionM >= left && scenario.positionM <= right),
    width: regions.length === 0 ? null : regions.reduce((sum, [left, right]) => sum + right - left, 0),
  }
}

function pod(leaks: readonly ReturnType<typeof leakEvaluation>[]) {
  return Object.fromEntries([1, 5, 10, 30].map((seconds) => [
    seconds,
    binomialBounds(leaks.filter(({ delayUs }) => delayUs !== null && delayUs <= seconds * 1e6).length, leaks.length),
  ]))
}

function nullMetrics(runs: readonly RunEvidence[]) {
  const availableHours = runs.reduce((sum, run) => sum + run.availableUs, 0) / 3_600_000_000
  const totalHours = runs.length * CHALLENGE_US / 3_600_000_000
  const rate = (episodes: number) => ({
    episodes,
    availableRate: availableHours === 0 ? null : episodes / availableHours,
    totalRate: totalHours === 0 ? null : episodes / totalHours,
    availableUpper95: poissonUpper(episodes, availableHours),
    totalUpper95: poissonUpper(episodes, totalHours),
  })
  return {
    runs: runs.length, availableHours, totalHours,
    anomalies: rate(runs.reduce((sum, run) => sum + run.alarms.length, 0)),
    falseSupports: rate(runs.reduce((sum, run) => sum + run.supports.length, 0)),
  }
}

function confusion(rows: readonly { scenario: Scenario; run: RunEvidence }[]) {
  return Object.fromEntries(['leak', 'null', 'discrepancy'].map((kind) => {
    const counts = new Map<RunEvidence['outcome'], number>()
    for (const { scenario, run } of rows) {
      if (scenario.kind === kind) counts.set(run.outcome, (counts.get(run.outcome) ?? 0) + 1)
    }
    return [kind, Object.fromEntries(counts)]
  }))
}

export function summarizeRuns(
  scenarios: readonly Scenario[],
  runs: readonly RunEvidence[],
  scope: (typeof SENSOR_LAYOUTS)[number] | 'both' = 'both',
) {
  const lookup = new Map(runs.map((run) => [run.runId, run]))
  const rows = scenarios.map((scenario) => {
    const run = lookup.get(scenario.runId)
    if (!run) throw new Error(`Missing evidence for ${scenario.runId}.`)
    return { scenario, run }
  })
  const leaks = rows.flatMap(({ scenario, run }) => scenario.kind === 'leak'
    ? [{ ...leakEvaluation(scenario, run), core: scenario.sizeM2 !== 5e-6, run }]
    : [])
  const core = leaks.filter((leak) => leak.core)
  const local = core.filter((leak) => leak.localized)
  const hits = local.filter((leak) => leak.covered).length
  const jobs = core.flatMap(({ run }) => run.jobs.length === 0 ? [null] : run.jobs)
  const completeWithinDeadline = jobs.filter((job) => job?.stopReason === 'complete' && job.wallMs <= 5000).length
  const provisionalTimes = jobs.flatMap((job) => job?.provisionalMs != null ? [job.provisionalMs]
    : job?.stopReason === 'complete' ? [] : [Number.POSITIVE_INFINITY])
  const provisionalP95 = nearestRank(provisionalTimes, 0.95)
  const provisionalP95Ms = provisionalP95 !== null && Number.isFinite(provisionalP95) ? provisionalP95 : null
  const sensors = scope === 'both' ? SENSOR_LAYOUTS : [scope]
  const nullBySensor = Object.fromEntries(sensors.map((sensor) => [
    sensor, nullMetrics(rows.filter(({ scenario }) => scenario.kind === 'null' && scenario.sensor === sensor).map(({ run }) => run)),
  ]))
  const corePod = pod(core)
  const earlySupports = rows.reduce((sum, { scenario, run }) => sum + (scenario.kind === 'leak'
    ? run.supports.filter((support) => support.timeUs < scenario.onsetUs).length : 0), 0)
  const prohibitedSupports = rows.filter(({ scenario, run }) => scenario.kind === 'discrepancy'
    && !['D07', 'D10', 'D12'].includes(scenario.family) && run.supports.length > 0).map(({ scenario }) => scenario.runId)
  const structuralClaims = runs.filter((run) => run.structuralClaim).map((run) => run.runId)
  const discrepancyOutcomes = rows.flatMap(({ scenario, run }) => scenario.kind === 'discrepancy'
    ? [{ runId: run.runId, family: scenario.family, replicate: scenario.replicate, outcome: run.outcome,
      alarms: run.alarms.length, supports: run.supports.length, activeProposals: run.activeProposals }]
    : [])
  const pairMembers = rows.flatMap(({ scenario, run }) => scenario.kind === 'discrepancy' && scenario.family === 'D12'
    ? [{ replicate: scenario.replicate, run }]
    : [])
  const equivalentPairs = [0, 2].flatMap((replicate) => {
    const left = pairMembers.find((member) => member.replicate === replicate)?.run
    const right = pairMembers.find((member) => member.replicate === replicate + 1)?.run
    if (!left || !right) return []
    const decision = (run: RunEvidence) => [run.outcome, run.alarms, run.supports, run.activeProposals, run.activeAccepts]
    return [{ runIds: [left.runId, right.runId], matchingDecision: JSON.stringify(decision(left)) === JSON.stringify(decision(right)) }]
  })
  const localization = {
    conditional: binomialBounds(hits, local.length),
    unconditional: binomialBounds(hits, core.length),
    abstentions: core.length - local.length,
    medianWidthM: median(local.map((leak) => leak.width!)),
    widthBootstrapM: bootstrapMedian(core.map((leak) => leak.width)),
  }
  const gates = {
    matrix: leaks.length === 60 * sensors.length && core.length === 40 * sensors.length && Object.values(nullBySensor).every((result) => result.totalHours >= 10),
    null: Object.values(nullBySensor).every((result) => result.anomalies.availableRate !== null
      && result.anomalies.availableRate <= 1 && result.falseSupports.episodes === 0),
    pod: (corePod[30]?.estimate ?? 0) >= 0.9 && (corePod[30]?.lower95 ?? 0) >= 0.8,
    localization: (localization.conditional.estimate ?? 0) >= 0.9 && (localization.unconditional.estimate ?? 0) >= 0.8
      && localization.medianWidthM !== null && localization.medianWidthM <= 0.2 * PIPE_LENGTH_M,
    deadline: jobs.length > 0 && completeWithinDeadline / jobs.length >= 0.9 && (provisionalP95 ?? 0) <= 2000,
    discrepancy: earlySupports === 0 && prohibitedSupports.length === 0 && structuralClaims.length === 0
      && (scope === 'adverse' || (equivalentPairs.length === 2 && equivalentPairs.every((pair) => pair.matchingDecision))),
  }
  return {
    corePod, smallPod: pod(leaks.filter((leak) => !leak.core)), allPod: pod(leaks),
    delayBootstrapUs: bootstrapMedian(core.map((leak) => leak.delayUs)), censoredCore: core.filter((leak) => leak.delayUs === null).length,
    localization, nullBySensor, earlySupports, prohibitedSupports, structuralClaims, discrepancyOutcomes, equivalentPairs,
    completion: { completeWithinDeadline, jobs: jobs.length, provisionalP95Ms,
      missingProvisionalOnIncomplete: provisionalTimes.filter((time) => !Number.isFinite(time)).length },
    confusion: confusion(rows), gates, passed: Object.values(gates).every(Boolean),
    poissonAssumption: 'Intervals assume homogeneous independent episodes over the reported exposure.',
  }
}
