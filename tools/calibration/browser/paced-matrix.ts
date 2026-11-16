import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import type { loadOpenScenarioSplit } from '../scenario-runner'
import type { ValidationClosure } from '../scenario-setup'

export const MAX_PACED_MATRIX_LANES = 32
const MAX_CHILD_OUTPUT_BYTES = 4096
const MAX_CHILD_OUTPUT_LINES = 16
const CHILD_OUTPUT_DRAIN_MS = 250
const SYSTEM_ERROR_CODES = new Set(['EACCES', 'EADDRINUSE', 'EAGAIN', 'EEXIST', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'EPERM'])
const SCENARIO_OUTCOME = /^Browser run (completed|pilot-cutoff|invalid-domain|unsupported|worker-error|transport-error|wall-timeout|incomplete-closure|candidate-unavailable) at \d+\.\d{3} model seconds\. Committed inverse jobs: \d+\.$/u
const STDERR_FAILURES = [
  ['browser-start', /^(?:Error: )?(?:browserType\.launch|browser\.newContext|browserContext\.newPage):/u],
  ['browser-navigation', /^(?:Error: )?page\.goto:/u],
  ['browser-evaluation', /^(?:Error: )?page\.evaluate:/u],
  ['browser-close', /^(?:Error: )?browser\.close:/u],
  ['run-id-unavailable', /^Run ID is absent from the committed open split\.$/u],
] as const

export interface PacedMatrixRun {
  readonly runId: string
  readonly sourceRunId: string
  readonly closure: ValidationClosure
}

type SplitRuns = Pick<Awaited<ReturnType<typeof loadOpenScenarioSplit>>, 'profile' | 'runs' | 'closurePairs'>
interface MatrixSelection {
  readonly sensorProfileId?: Exclude<SplitRuns['profile']['sensorProfileId'], 'none'>
  readonly closurePairsOnly?: boolean
}

export function selectPacedMatrixRuns(split: SplitRuns, requested?: readonly string[], selection: MatrixSelection = {}): PacedMatrixRun[] {
  const sensorProfileId = selection.sensorProfileId ?? split.profile.sensorProfileId
  const reserved = new Set(split.closurePairs.map(({ sourceRecipeRunId }) => sourceRecipeRunId))
  const baseline = split.runs.filter((run) => run.sensorProfileId === sensorProfileId
    && (!selection.closurePairsOnly || reserved.has(run.runId)))
  if (baseline.length === 0) throw new Error('The matrix must select a populated instrumented sensor layout.')
  const ids = new Set(baseline.map(({ runId }) => runId))
  const declared: PacedMatrixRun[] = [
    ...baseline.map(({ runId }) => ({ runId, sourceRunId: runId, closure: 'qs' as const })),
    ...split.closurePairs.filter(({ sourceRecipeRunId }) => ids.has(sourceRecipeRunId))
      .map(({ vb10RunId, sourceRecipeRunId }) => ({ runId: vb10RunId, sourceRunId: sourceRecipeRunId, closure: 'vb10' as const })),
  ]
  if (requested === undefined) return declared
  const subset = new Set(requested)
  if (requested.length !== subset.size) throw new Error('Duplicate paced matrix run ID.')
  const selected = declared.filter(({ runId }) => subset.has(runId))
  if (selected.length === 0 || selected.length !== subset.size) {
    throw new Error('Each requested run must belong to the selected sensor layout and matrix scope.')
  }
  return selected
}

export function assertPacedMatrixLanes(lanes: number): void {
  if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > MAX_PACED_MATRIX_LANES) {
    throw new RangeError(`Paced matrix lanes must be an integer from 1 to ${MAX_PACED_MATRIX_LANES}.`)
  }
}

interface LaneRow<T> {
  readonly run: PacedMatrixRun
  readonly lane: number
  readonly queueMs: number
  readonly wallMs: number
  readonly value: T | null
}

export async function runPacedMatrixLanes<T>(
  runs: readonly PacedMatrixRun[], lanes: number, execute: (run: PacedMatrixRun) => Promise<T>,
): Promise<{ readonly rows: readonly LaneRow<T>[]; readonly elapsedMs: number; readonly peakLanes: number }> {
  assertPacedMatrixLanes(lanes)
  const startedAt = performance.now()
  const rows = new Array<LaneRow<T>>(runs.length)
  let next = 0
  let active = 0
  let peakLanes = 0

  async function drain(lane: number): Promise<void> {
    while (next < runs.length) {
      const index = next++
      const run = runs[index]!
      const began = performance.now()
      peakLanes = Math.max(peakLanes, ++active)
      let value: T | null = null
      try {
        value = await execute(run)
      } catch {
        // A child failure must keep its slot in the final matrix.
      } finally {
        active--
      }
      rows[index] = { run, lane, queueMs: began - startedAt, wallMs: performance.now() - began, value }
    }
  }

  await Promise.all(Array.from({ length: Math.min(lanes, runs.length) }, (_, index) => drain(index + 1)))
  return { rows, elapsedMs: performance.now() - startedAt, peakLanes }
}

interface ChildOutput {
  readonly present: boolean
  readonly truncated: boolean
}

interface ChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly spawnFailed: boolean
  readonly diagnostics: {
    readonly stdout: ChildOutput & { readonly outcome: string | null }
    readonly stderr: ChildOutput & { readonly failure: string | null }
    readonly spawnErrorCode: string | null
  }
}

interface ChildOptions {
  readonly cwd: string
  readonly timeoutMs: number
  readonly shutdownGraceMs: number
}

function captureChildOutput<T extends object>(stream: Readable, classify: (lines: readonly string[]) => T) {
  const prefix = Buffer.alloc(MAX_CHILD_OUTPUT_BYTES)
  let size = 0
  let truncated = false
  stream.on('data', (chunk: Buffer) => {
    const copied = chunk.copy(prefix, size)
    size += copied
    truncated ||= copied < chunk.length
  })
  return {
    snapshot() {
      const text = prefix.toString('utf8', 0, size).replace(/\r?\n$/u, '')
      const lines = text.split(/\r?\n/u, MAX_CHILD_OUTPUT_LINES + 1)
      return { ...classify(lines.slice(0, MAX_CHILD_OUTPUT_LINES)), present: size > 0, truncated: truncated || lines.length > MAX_CHILD_OUTPUT_LINES }
    },
    close() {
      if (stream.readableEnded || stream.destroyed) return
      truncated = true
      stream.destroy()
    },
  }
}

function classifyStdout(lines: readonly string[]) {
  const match = lines.map((line) => SCENARIO_OUTCOME.exec(line)?.[1]).find((outcome) => outcome !== undefined)
  return { outcome: match ?? null }
}

function classifyStderr(lines: readonly string[]) {
  for (const line of lines) {
    const failure = STDERR_FAILURES.find(([, pattern]) => pattern.test(line))?.[0]
    if (failure) return { failure }
    const systemCode = /^(?:Error: )?([A-Z]+):/u.exec(line)?.[1]
    if (systemCode && SYSTEM_ERROR_CODES.has(systemCode)) return { failure: systemCode }
  }
  return { failure: null }
}

export function launchPacedMatrixChild(args: readonly string[], options: ChildOptions): Promise<ChildExit> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    // Keep raw child output out of evidence. Browser errors can include environment values and local paths.
    const stdout = captureChildOutput(child.stdout, classifyStdout)
    const stderr = captureChildOutput(child.stderr, classifyStderr)
    let timedOut = false
    let spawnFailed = false
    let spawnErrorCode: string | null = null
    let retryShutdown: NodeJS.Timeout | undefined
    let forcedShutdown: NodeJS.Timeout | undefined
    let drainTimeout: NodeJS.Timeout | undefined
    const closeOutputs = () => {
      stdout.close()
      stderr.close()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      retryShutdown = setTimeout(() => {
        // Playwright forces its separate Chromium process group closed on the second request.
        child.kill('SIGTERM')
        forcedShutdown = setTimeout(() => {
          child.kill('SIGKILL')
          closeOutputs()
        }, options.shutdownGraceMs)
      }, options.shutdownGraceMs)
    }, options.timeoutMs)
    const clearShutdownTimers = () => {
      clearTimeout(timeout)
      clearTimeout(retryShutdown)
      clearTimeout(forcedShutdown)
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnFailed = true
      if (error.code && SYSTEM_ERROR_CODES.has(error.code)) spawnErrorCode = error.code
    })
    child.once('exit', () => {
      clearShutdownTimers()
      // A surviving descendant can keep a diagnostic pipe open after the launcher exits.
      drainTimeout = setTimeout(closeOutputs, CHILD_OUTPUT_DRAIN_MS)
    })
    child.once('close', (code, signal) => {
      clearShutdownTimers()
      clearTimeout(drainTimeout)
      done({ code, signal, timedOut, spawnFailed, diagnostics: { stdout: stdout.snapshot(), stderr: stderr.snapshot(), spawnErrorCode } })
    })
  })
}
