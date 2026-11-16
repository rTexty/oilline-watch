import type { Command } from '../../../src/runtime/vertical-protocol'
import { validationFailure } from './pilot-status'
import type { PacedFailure } from './pilot-status'
import { createPacedProvisionalTimings } from './provisional-timing'
import type { PacedFinalPublication, PacedProvisionalPublication } from './provisional-timing'
import type { PacedProgress, PacedScenarioInput } from './worker-adapter'

type DiagnosticRelease = Extract<Command, { kind: 'start' }>['diagnosticRelease']
export interface BrowserInput {
  readonly scenario: PacedScenarioInput
  readonly diagnosticRelease?: DiagnosticRelease
  readonly decisionTrace?: boolean
}

type BootstrapFailure = { readonly kind: 'validation-bootstrap-error'; readonly failure: PacedFailure }
type JobAdmission = { readonly kind: 'validation-job-admitted'; readonly jobId: string; readonly admittedEpochMs: number }
type ProvisionalPublication = { readonly kind: 'validation-provisional-publication' } & PacedProvisionalPublication
type FinalPublication = { readonly kind: 'validation-terminal-result' } & PacedFinalPublication
type ValidationMessage = { readonly kind: 'validation-ready' } | BootstrapFailure | JobAdmission | ProvisionalPublication | FinalPublication | PacedProgress

const PUBLIC_TERMINAL_GRACE_MS = 1000
type TerminalProgress = PacedProgress & { readonly phase: 'completed' | 'invalid' | 'error' }

function terminalProgress(progress: PacedProgress): progress is TerminalProgress {
  return progress.phase === 'completed' || progress.phase === 'invalid' || progress.phase === 'error'
}

function nearestRank(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]!
}

async function runPacedScenario({ scenario, diagnosticRelease, decisionTrace }: BrowserInput) {
  const runId = crypto.randomUUID()
  const publicTrace = decisionTrace ? (await import('./public-diagnostic-trace')).createPublicDiagnosticTrace(runId) : undefined
  const simulation = new Worker(new URL('../../../src/runtime/simulation.worker.ts', import.meta.url), { type: 'module' })
  const inference = new Worker(new URL('../../../src/runtime/inference.worker.ts', import.meta.url), { type: 'module' })
  const validation = new MessageChannel()
  const diagnostics = new MessageChannel()
  const startedAt = performance.now()
  const provisionalTimings = createPacedProvisionalTimings()
  const lagMs: number[] = []
  const alarmTimesUs = new Set<number>()
  let hiddenSnapshots = 0
  let simulationReservedMaxBytes = 0
  let inferenceReservedMaxBytes = 0
  let bootstrapMs: number | null = null
  let firstModelAdvanceMs: number | null = null
  let observedTimeUs = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  let terminalTimeout: ReturnType<typeof setTimeout> | undefined
  let awaitingPublicTerminal: TerminalProgress | undefined
  try {
    const terminal = await new Promise<PacedProgress | ReturnType<typeof validationFailure>>((resolve) => {
      const fail = (failure: PacedFailure) =>
        resolve(validationFailure(failure, bootstrapMs === null ? 'bootstrap' : 'execution', observedTimeUs))
      timeout = setTimeout(() => fail('wall-timeout'), scenario.targetUs / 1000 + 45_000)
      simulation.onerror = () => fail('worker-error')
      inference.onerror = () => fail('worker-error')
      validation.port2.onmessageerror = () => fail('transport-error')
      if (publicTrace) simulation.onmessageerror = () => fail('transport-error')
      const receiveBootstrap = ({ data }: MessageEvent<unknown>) => {
        if (typeof data === 'object' && data !== null && 'kind' in data && data.kind === 'validation-bootstrap-error') {
          fail('transport-error')
        }
      }
      simulation.onmessage = publicTrace ? (event: MessageEvent<unknown>) => {
        receiveBootstrap(event)
        publicTrace.observe(event.data, document.visibilityState === 'visible')
        if (awaitingPublicTerminal && publicTrace.hasTerminal(awaitingPublicTerminal)) {
          clearTimeout(terminalTimeout)
          resolve(awaitingPublicTerminal)
        }
      } : receiveBootstrap
      validation.port2.onmessage = ({ data }: MessageEvent<ValidationMessage>) => {
        if (data.kind === 'validation-bootstrap-error') fail(data.failure)
        if (data.kind === 'validation-job-admitted') provisionalTimings.admit(data.jobId, data.admittedEpochMs)
        if (data.kind === 'validation-provisional-publication') {
          // Main-thread receipt of the validation marker approximates snapshot delivery.
          provisionalTimings.observe(data, performance.timeOrigin + performance.now())
        }
        if (data.kind === 'validation-terminal-result') {
          provisionalTimings.observeFinal(data, performance.timeOrigin + performance.now())
        }
        if (data.kind === 'validation-ready') {
          bootstrapMs = performance.now() - startedAt
          inference.postMessage({ schemaVersion: 1, runId, port: diagnostics.port2 }, [diagnostics.port2])
          simulation.postMessage({
            schemaVersion: 1, runId, seq: 0, kind: 'start', profileId: scenario.profile.profileId, pace: 1,
            port: diagnostics.port1, diagnosticRelease,
          } satisfies Extract<Command, { kind: 'start' }>, [diagnostics.port1])
        }
        if (data.kind === 'validation-progress') {
          observedTimeUs = data.timeUs
          if (firstModelAdvanceMs === null && data.timeUs > 0) firstModelAdvanceMs = performance.now() - startedAt
          if (data.elapsedMs !== null) lagMs.push(data.lagMs)
          if (document.visibilityState !== 'visible') hiddenSnapshots++
          simulationReservedMaxBytes = Math.max(simulationReservedMaxBytes, data.simulationNumericalMemory?.reservedBytes ?? 0)
          inferenceReservedMaxBytes = Math.max(inferenceReservedMaxBytes, data.inferenceNumericalMemory?.reservedBytes ?? 0)
          if (data.alarmAtUs !== null) alarmTimesUs.add(data.alarmAtUs)
          if (terminalProgress(data)) {
            if (!publicTrace || publicTrace.hasTerminal(data)) resolve(data)
            else if (!awaitingPublicTerminal) {
              // Public snapshots and validation metadata arrive on different channels.
              awaitingPublicTerminal = data
              terminalTimeout = setTimeout(() => resolve(data), PUBLIC_TERMINAL_GRACE_MS)
            }
          }
        }
      }
      simulation.postMessage({ kind: 'validation-bootstrap', port: validation.port1 }, [validation.port1])
      validation.port2.postMessage(scenario)
    })
    const provisionalByJob = provisionalTimings.entries()
    const timingsByJob = new Map(provisionalByJob.map((entry) => [entry.jobId, entry]))
    const result = terminal.kind === 'validation-progress' ? {
      ...terminal, budgets: terminal.budgets.map((budget) => {
        const timing = timingsByJob.get(budget.jobId)
        return { ...budget, provisionalMs: timing?.provisionalMs ?? null,
          finalPageMs: timing?.finalPageMs ?? null, finalDisposition: timing?.finalDisposition ?? null }
      }),
    } : terminal
    const terminalEvidence = publicTrace && terminal.kind === 'validation-progress' && terminalProgress(terminal) && terminal.policyAudit ? {
      timeUs: terminal.timeUs, phase: terminal.phase, audit: terminal.policyAudit.jobs, transitions: terminal.timeline,
    } : null
    return {
      ...result, provisionalByJob, bootstrapMs, firstModelAdvanceMs, pageElapsedMs: performance.now() - startedAt,
      visibility: { final: document.visibilityState, hiddenSnapshots },
      simulationReservedMaxBytes, inferenceReservedMaxBytes,
      lag: { observedSnapshots: lagMs.length, p50Ms: nearestRank(lagMs, 0.5), p95Ms: nearestRank(lagMs, 0.95),
        maxMs: Math.max(0, ...lagMs) },
      alarmTimesUs: [...alarmTimesUs],
      ...(publicTrace ? { publicDiagnosticTrace: publicTrace.terminal(terminalEvidence) } : {}),
    }
  } finally {
    clearTimeout(timeout)
    clearTimeout(terminalTimeout)
    validation.port2.close()
    simulation.terminate()
    inference.terminate()
  }
}

declare global {
  interface Window {
    runPacedScenario: typeof runPacedScenario
  }
}

window.runPacedScenario = runPacedScenario
