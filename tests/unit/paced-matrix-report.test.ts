import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPacedMatrixReport } from '../../tools/calibration/browser/paced-matrix-report'
import { jsonDocument, sha256 } from '../../tools/calibration/io'

const digest = 'a'.repeat(64)
const report = {
  schemaVersion: 1, kind: 'open-browser-paced-pilot', qualified: false, pace: 1, solver: 'typescript-f64',
  diagnosticMode: 'scheduler-fixture', activeAttemptEvaluated: false, calibrationHash: null, selectedPolicy: null,
  dictionaryLoaded: false, split: 'fit', splitSha256: digest, commitmentSha256: digest, profileSha256: digest,
  generatorSha256: digest, recipeSha256: digest, sourceHashes: { profile: digest, model: digest, bank: digest, sensor: digest, policy: digest },
  adapterSha256: digest, assets: [{ name: 'index.html', sha256: digest }],
  runId: 'fit-leak-010', closure: 'qs', targetUs: 10_000, status: 'pilot-cutoff',
  browser: { name: 'chromium', version: '158.0', headless: true }, node: process.version,
  observation: { timeUs: 10_000, phase: 'completed', failure: null, closureEvidenceMissing: false,
    lag: { p95Ms: 0.1 }, simulationNumericalMemory: { highWaterBytes: 2 }, inferenceNumericalMemory: { highWaterBytes: 3 } },
  heap: { maxSampledTotalSize: 4 },
} as const
const expected = {
  split: report.split, splitSha256: digest, commitmentSha256: digest, profileSha256: digest,
  generatorSha256: digest, recipeSha256: digest, sourceHashes: report.sourceHashes, selectedPolicy: null,
  diagnosticMode: report.diagnosticMode, targetUs: 10_000, horizonUs: 330_000_000,
} as const
const run = { runId: report.runId, sourceRunId: report.runId, closure: report.closure } as const
const traceExpected = { ...expected, decisionTraceEnabled: true } as const
const emptyCoverage = { accepted: 0, lastSeq: null, duplicates: 0, invalid: 0, missingSequences: 0, clockRegressions: 0, overflow: false }

function observedTrace(timeUs: number) {
  const terminalSnapshot = { seq: 12, timeUs, phase: 'completed' } as const
  return {
    status: 'observed', terminalSnapshot,
    coverage: { ...emptyCoverage, accepted: terminalSnapshot.seq + 1, lastSeq: terminalSnapshot.seq },
    transitions: [
      { seq: 0, publicationUs: 0, phase: 'running', visible: true, status: 'uncalibrated', result: null, provisionalJobId: null },
      { seq: terminalSnapshot.seq, publicationUs: timeUs, phase: terminalSnapshot.phase, visible: true,
        status: 'uncalibrated', result: null, provisionalJobId: null },
    ],
    mismatchedJobIds: [], firstVisibleSupports: [],
  } as const
}

const publicDiagnosticTrace = observedTrace(report.targetUs)
const { terminalSnapshot, coverage, transitions } = publicDiagnosticTrace
const tracedReport = {
  ...report, decisionTraceEnabled: true, observation: { ...report.observation, publicDiagnosticTrace },
} as const

async function readReportFixture(raw: unknown, pinned: Parameters<typeof readPacedMatrixReport>[2] = traceExpected) {
  const directory = await mkdtemp(join(tmpdir(), 'paced-matrix-report-trace-'))
  try {
    const path = join(directory, 'run.json')
    const content = jsonDocument(raw)
    await writeFile(path, content)
    return { actual: await readPacedMatrixReport(path, run, pinned), sha256: sha256(content) }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('paced matrix child reports', () => {
  const spatialDigest = 'c'.repeat(64)
  const spatialAsset = { name: 'calibration/spatial-envelope.json', sha256: spatialDigest }
  const spatialPolicy = { selectionHash: digest, selectionFileSha256: digest, releaseScope: 'passive',
    dictionaryManifestSha256: digest, dictionaryDataSha256: digest, spatialEvaluationSha256: spatialDigest } as const
  const spatialExpected = { ...expected, diagnosticMode: 'selected-policy', selectedPolicy: spatialPolicy } as const
  const spatialReport = { ...report, ...spatialExpected, assets: [...report.assets, spatialAsset] }

  it('binds a paced spatial evaluation to its pinned policy and exactly one served asset', async () => {
    const { actual } = await readReportFixture(spatialReport, spatialExpected)
    expect(actual.kind).toBe('verified')
  })

  it.each([
    { ...spatialReport, assets: report.assets },
    { ...spatialReport, assets: [...report.assets, { ...spatialAsset, sha256: digest }] },
    { ...spatialReport, assets: [...spatialReport.assets, spatialAsset] },
  ])('rejects missing, altered or duplicate spatial evaluation assets', async (raw) => {
    const { actual, sha256 } = await readReportFixture(raw, spatialExpected)
    expect(actual).toEqual({ kind: 'invalid', sha256 })
  })

  it('rejects an unpinned spatial evaluation asset', async () => {
    const { actual, sha256 } = await readReportFixture({ ...report, assets: [...report.assets, spatialAsset] }, expected)
    expect(actual).toEqual({ kind: 'invalid', sha256 })
  })

  it.each(['pilot-cutoff', 'completed'] as const)('verifies the observed terminal trace on a %s report', async (status) => {
    const targetUs = status === 'completed' ? expected.horizonUs : expected.targetUs
    const raw = {
      ...tracedReport, status, targetUs,
      observation: {
        ...tracedReport.observation, timeUs: targetUs,
        publicDiagnosticTrace: observedTrace(targetUs),
      },
    }
    const { actual, sha256 } = await readReportFixture(raw, { ...traceExpected, targetUs })
    expect(actual).toMatchObject({ kind: 'verified', sha256, status, decisionTraceStatus: 'observed' })
  })

  it.each([
    { name: 'missing trace', raw: { ...tracedReport, observation: report.observation } },
    { name: 'unobserved trace', raw: { ...tracedReport, observation: {
      ...tracedReport.observation, publicDiagnosticTrace: { ...publicDiagnosticTrace, status: 'snapshot-gap' },
    } } },
    { name: 'wrong terminal trace clock', raw: { ...tracedReport, observation: {
      ...tracedReport.observation, publicDiagnosticTrace: {
        ...publicDiagnosticTrace, terminalSnapshot: { ...terminalSnapshot, timeUs: terminalSnapshot.timeUs - 1 },
      },
    } } },
    { name: 'wrong terminal trace phase', raw: { ...tracedReport, observation: {
      ...tracedReport.observation, publicDiagnosticTrace: {
        ...publicDiagnosticTrace, terminalSnapshot: { ...terminalSnapshot, phase: 'invalid' },
      },
    } } },
    { name: 'false report trace flag', raw: { ...tracedReport, decisionTraceEnabled: false } },
    { name: 'missing report trace flag', raw: { ...report, observation: tracedReport.observation } },
  ])('rejects $name when the trace is pinned on', async ({ raw }) => {
    const { actual, sha256 } = await readReportFixture(raw)
    expect(actual).toEqual({ kind: 'invalid', sha256 })
  })

  it.each([
    { name: 'trace header without evidence', trace: { status: 'observed', terminalSnapshot } },
    { name: 'observed trace with missing sequences', trace: {
      ...publicDiagnosticTrace, coverage: { ...coverage, accepted: coverage.accepted - 1, missingSequences: 1 },
    } },
    { name: 'observed trace with overflow', trace: { ...publicDiagnosticTrace, coverage: { ...coverage, overflow: true } } },
    { name: 'observed trace without a terminal transition', trace: { ...publicDiagnosticTrace, transitions: transitions.slice(0, -1) } },
    { name: 'observed trace with mismatched jobs', trace: { ...publicDiagnosticTrace, mismatchedJobIds: ['job-1'] } },
  ])('rejects $name on a successful run', async ({ trace }) => {
    const { actual, sha256 } = await readReportFixture({
      ...tracedReport, observation: { ...tracedReport.observation, publicDiagnosticTrace: trace },
    })
    expect(actual).toEqual({ kind: 'invalid', sha256 })
  })

  it('rejects an enabled report when the expected inputs omit trace collection', async () => {
    const { actual, sha256 } = await readReportFixture(tracedReport, expected)
    expect(actual).toEqual({ kind: 'invalid', sha256 })
  })

  it('preserves an enabled failed run with no observed terminal snapshot', async () => {
    const { actual, sha256 } = await readReportFixture({
      ...tracedReport, status: 'wall-timeout',
      observation: {
        ...tracedReport.observation, phase: 'error', failure: 'wall-timeout', timeUs: 0,
        publicDiagnosticTrace: {
          status: 'missing-terminal', terminalSnapshot: null, coverage: emptyCoverage,
          transitions: [], mismatchedJobIds: [], firstVisibleSupports: [],
        },
      },
    })
    expect(actual).toMatchObject({ kind: 'verified', sha256, status: 'wall-timeout', failure: 'wall-timeout', timeUs: 0 })
  })

  it('preserves raw digests, peak memory, and explicit terminal failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paced-matrix-report-'))
    try {
      const path = join(directory, 'run.json')
      const content = jsonDocument(report)
      await writeFile(path, content)
      await expect(readPacedMatrixReport(path, run, expected)).resolves.toMatchObject({
        kind: 'verified', sha256: sha256(content), status: 'pilot-cutoff', timeUs: 10_000, p95LagMs: 0.1,
        peakHeapBytes: 4, peakSimulationNumericalBytes: 2, peakInferenceNumericalBytes: 3,
      })
      await writeFile(path, jsonDocument({ ...report, status: 'wall-timeout',
        observation: { timeUs: 0, phase: 'error', failure: 'wall-timeout', closureEvidenceMissing: false } }))
      await expect(readPacedMatrixReport(path, run, expected)).resolves.toMatchObject({
        kind: 'verified', status: 'wall-timeout', timeUs: 0, failure: 'wall-timeout',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps missing or malformed artifacts visible and fails closed on mismatched provenance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paced-matrix-report-rejected-'))
    try {
      const path = join(directory, 'run.json')
      await expect(readPacedMatrixReport(path, run, expected)).resolves.toEqual({ kind: 'missing', sha256: null })
      await writeFile(path, 'invalid JSON')
      await expect(readPacedMatrixReport(path, run, expected)).resolves.toEqual({ kind: 'invalid', sha256: sha256('invalid JSON') })
      for (const changed of [
        { qualified: true },
        { split: 'blind' },
        { runId: 'fit-leak-011' },
        { sourceHashes: { ...report.sourceHashes, policy: 'b'.repeat(64) } },
        { observation: { ...report.observation, timeUs: 0 } },
      ]) {
        await writeFile(path, jsonDocument({ ...report, ...changed }))
        await expect(readPacedMatrixReport(path, run, expected)).resolves.toMatchObject({ kind: 'invalid', sha256: expect.any(String) })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
