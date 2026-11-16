import { diagnosticResultSchema } from '../../../src/contracts/inference'
import type { DiagnosticResult } from '../../../src/contracts/inference'
import { MAX_AUDITED_JOBS } from '../../../src/contracts/inference-audit'
import type { InferenceAuditJob, InferenceAuditTransition } from '../../../src/contracts/inference-audit'
import { snapshotMessageSchema } from '../../../src/runtime/vertical-protocol'
import type { RunSnapshot } from '../../../src/runtime/vertical-protocol'

const MAX_TRANSITIONS = 10_000
type Phase = RunSnapshot['phase']
type TerminalPhase = Extract<Phase, 'completed' | 'invalid' | 'error'>
type ViewStatus = 'hidden' | 'replay' | 'stopped' | 'finalizing' | 'outage' | 'insufficient-history'
  | 'uncalibrated' | 'unarmed' | 'provisional' | 'historical' | 'no-current-result'
  | 'out-of-domain' | 'stale' | 'incomplete-search' | 'poor-fit' | 'unqualified-fit' | 'ambiguous' | 'supported'

interface TerminalClock {
  readonly timeUs: number
  readonly phase: TerminalPhase
}

interface TerminalEvidence extends TerminalClock {
  readonly audit: readonly InferenceAuditJob[]
  readonly transitions: readonly InferenceAuditTransition[]
}

interface SnapshotClock {
  readonly seq: number
  readonly timeUs: number
  readonly phase: Phase
}

interface ResultClock {
  readonly jobId: string
  readonly observedThroughUs: number
  readonly finishedAtUs: number
  readonly controlRevision: number
}

interface StatusTransition {
  readonly seq: number
  readonly publicationUs: number
  readonly phase: Phase
  readonly visible: boolean
  readonly status: ViewStatus
  readonly result: ResultClock | null
  readonly provisionalJobId: string | null
}

interface SupportObservation extends ResultClock {
  readonly seq: number
  readonly publicationUs: number
  readonly regions: DiagnosticResult['compatibleRegions']
}

function displayedProvisional(snapshot: RunSnapshot) {
  const pending = snapshot.diagnostic?.provisional
  return pending && (snapshot.phase === 'running' || snapshot.phase === 'paused')
    && pending.jobId !== snapshot.diagnostic?.result?.jobId ? pending : null
}

function resultStatus(result: DiagnosticResult): ViewStatus {
  if (result.availability === 'out-of-domain' || result.availability === 'stale') return result.availability
  if (!result.searchComplete) return 'incomplete-search'
  if (result.fitQuality === 'poor') return 'poor-fit'
  if (result.fitQuality === 'unqualified') return 'unqualified-fit'
  return result.hypotheses.some(({ model, completed, support }) => model === 'ML' && completed && support === 'compatible')
    && result.compatibleRegions.length > 0 && result.compatibleRegions.every(({ status }) => status === 'compatible')
    ? 'supported' : 'ambiguous'
}

function viewStatus(snapshot: RunSnapshot, visible: boolean, masked: boolean): ViewStatus {
  const { diagnostic, phase } = snapshot
  const result = masked ? null : diagnostic?.result
  if (!visible) return 'hidden'
  if (snapshot.replaying || phase === 'replay-wait') return 'replay'
  if (phase === 'error' || phase === 'invalid') return 'stopped'
  if (phase === 'finalizing') return 'finalizing'
  if (diagnostic?.availability === 'missing' || result?.availability === 'missing') return 'outage'
  if (diagnostic?.availability === 'insufficient-history' || result?.availability === 'insufficient-history') return 'insufficient-history'
  if (!diagnostic?.qualified) return 'uncalibrated'
  if (snapshot.armedAtUs === null || snapshot.timeUs < snapshot.armedAtUs || phase === 'warming-up') return 'unarmed'
  if (masked) return 'provisional'
  if (diagnostic.historical) return 'historical'
  return result ? resultStatus(result) : 'no-current-result'
}

function resultClock({ jobId, observedThroughUs, finishedAtUs, controlRevision }: DiagnosticResult): ResultClock {
  return { jobId, observedThroughUs, finishedAtUs, controlRevision }
}

function sameTransition(previous: StatusTransition | undefined, next: StatusTransition): boolean {
  return previous?.status === next.status && previous.phase === next.phase && previous.visible === next.visible
    && previous.result?.jobId === next.result?.jobId && previous.provisionalJobId === next.provisionalJobId
}

function uniqueAuditIndex<T>(rows: readonly T[], idOf: (row: T) => string): ReadonlyMap<string, T | null> {
  const index = new Map<string, T | null>()
  for (const row of rows) {
    const id = idOf(row)
    index.set(id, index.has(id) ? null : row)
  }
  return index
}

function auditMismatches(
  results: ReadonlyMap<string, DiagnosticResult>, conflicts: ReadonlySet<string>, evidence: TerminalEvidence,
): readonly string[] {
  const jobs = uniqueAuditIndex(evidence.audit, ({ jobId }) => jobId)
  const commits = uniqueAuditIndex(evidence.transitions.filter(([kind]) => kind === 'committed'), ([, jobId]) => jobId)
  const unmatched = new Set(conflicts)
  for (const [jobId, result] of results) {
    const job = jobs.get(jobId)
    const committed = commits.get(jobId)
    const checked = diagnosticResultSchema.safeParse(job?.decisionReplay?.result)
    if (!job || job.closure || !committed || committed[2] !== result.finishedAtUs || job.finishedAtUs !== result.finishedAtUs
      || job.endUs !== result.observedThroughUs || !checked.success || JSON.stringify(checked.data) !== JSON.stringify(result)) {
      unmatched.add(jobId)
    }
  }
  return [...unmatched]
}

function possibleSnapshot(raw: unknown, runId: string): boolean {
  return typeof raw === 'object' && raw !== null && 'runId' in raw && raw.runId === runId && 'snapshot' in raw
}

/** Observes the public Worker wire on the page. This does not measure DOM paint or define support episodes. */
export function createPublicDiagnosticTrace(runId: string) {
  const transitions: StatusTransition[] = []
  const results = new Map<string, DiagnosticResult>()
  const conflicts = new Set<string>()
  const supports = new Map<string, SupportObservation>()
  let last: SnapshotClock | undefined
  let accepted = 0
  let duplicates = 0
  let invalid = 0
  let missingSequences = 0
  let clockRegressions = 0
  let overflow = false

  function recordResult(snapshot: RunSnapshot, result: DiagnosticResult): void {
    const previous = results.get(result.jobId)
    if (result.finishedAtUs > snapshot.timeUs || result.profileId !== snapshot.profileId
      || previous && JSON.stringify(previous) !== JSON.stringify(result)) conflicts.add(result.jobId)
    if (previous) return
    if (results.size >= MAX_AUDITED_JOBS) overflow = true
    else results.set(result.jobId, result)
  }

  function observe(raw: unknown, visible: boolean): void {
    if (!possibleSnapshot(raw, runId)) return
    const parsed = snapshotMessageSchema.safeParse(raw)
    if (!parsed.success) { invalid++; return }
    const { seq, snapshot } = parsed.data
    const { timeUs, phase, diagnostic } = snapshot
    if (last && seq <= last.seq) { duplicates++; return }
    if (last && timeUs < last.timeUs) clockRegressions++
    missingSequences += seq - (last ? last.seq + 1 : 0)
    last = { seq, timeUs, phase }
    accepted++
    const result = diagnostic?.result
    if (result && !snapshot.replaying) recordResult(snapshot, result)
    const pending = displayedProvisional(snapshot)
    const status = viewStatus(snapshot, visible, pending !== null)
    const transition: StatusTransition = {
      seq, publicationUs: timeUs, phase, visible, status,
      result: result ? resultClock(result) : null, provisionalJobId: pending?.jobId ?? null,
    }
    if (!sameTransition(transitions.at(-1), transition)) {
      if (transitions.length >= MAX_TRANSITIONS) overflow = true
      else transitions.push(transition)
    }
    if (result && status === 'supported' && results.has(result.jobId) && !supports.has(result.jobId)) {
      supports.set(result.jobId, { ...resultClock(result), seq, publicationUs: timeUs, regions: result.compatibleRegions })
    }
  }

  const hasTerminal = ({ timeUs, phase }: TerminalClock): boolean => last?.timeUs === timeUs && last.phase === phase
  function terminal(expected: TerminalEvidence | null) {
    const terminalObserved = expected !== null && hasTerminal(expected)
    const mismatches = expected ? auditMismatches(results, conflicts, expected) : []
    const status = !terminalObserved ? 'missing-terminal'
      : missingSequences > 0 || invalid > 0 || clockRegressions > 0 || overflow ? 'snapshot-gap'
      : mismatches.length > 0 ? 'audit-mismatch' : 'observed'
    return {
      status, terminalSnapshot: terminalObserved ? last! : null,
      coverage: { accepted, lastSeq: last?.seq ?? null, duplicates, invalid, missingSequences, clockRegressions, overflow },
      transitions: [...transitions], mismatchedJobIds: mismatches,
      firstVisibleSupports: status === 'observed' ? [...supports.values()] : [],
    } as const
  }
  return { observe, hasTerminal, terminal }
}
