import { z } from 'zod'
import { sha256Schema } from '../../../src/contracts/calibration'
import { OPEN_SPLITS } from '../generate-scenarios'
import { jsonDocument, readBounded, sha256 } from '../io'
import type { PacedMatrixRun } from './paced-matrix'
import { diagnosticGridSelectionEvidenceSchema } from './selected-policy'
import { PACED_SPATIAL_ASSET_PATH } from './spatial-evaluation-options'

const modelTime = z.number().int().nonnegative()
const elapsedMs = z.number().nonnegative()
const memory = z.object({ highWaterBytes: modelTime }).nullish()
const sourceHashes = z.strictObject({
  profile: sha256Schema, model: sha256Schema, bank: sha256Schema, sensor: sha256Schema, policy: sha256Schema,
})
const selectedPolicy = z.strictObject({
  selectionHash: sha256Schema, selectionFileSha256: sha256Schema, releaseScope: z.enum(['passive', 'full']),
  dictionaryManifestSha256: sha256Schema, dictionaryDataSha256: sha256Schema,
  spatialEvaluationSha256: sha256Schema.optional(),
  researchSelection: z.literal(true).optional(),
  diagnosticGridSelection: diagnosticGridSelectionEvidenceSchema.optional(),
}).refine(({ researchSelection, diagnosticGridSelection, releaseScope }) =>
  (!researchSelection && !diagnosticGridSelection) || (releaseScope === 'passive' && !(researchSelection && diagnosticGridSelection))).nullable()
const reportStatus = z.enum([
  'completed', 'pilot-cutoff', 'invalid-domain', 'unsupported', 'worker-error', 'transport-error',
  'wall-timeout', 'incomplete-closure', 'candidate-unavailable',
])
const terminalPhase = z.enum(['completed', 'invalid', 'error'])
const phase = z.enum(['warming-up', 'running', 'paused', 'replay-wait', 'finalizing', ...terminalPhase.options])
const jobId = z.string().min(1).max(96)
const resultClock = z.object({
  jobId, observedThroughUs: modelTime, finishedAtUs: modelTime, controlRevision: modelTime,
})
export const pacedDecisionTraceSchema = z.object({
  status: z.enum(['observed', 'missing-terminal', 'snapshot-gap', 'audit-mismatch']),
  terminalSnapshot: z.object({ seq: modelTime, timeUs: modelTime, phase: terminalPhase }).nullable(),
  coverage: z.object({
    accepted: modelTime, lastSeq: modelTime.nullable(), duplicates: modelTime, invalid: modelTime,
    missingSequences: modelTime, clockRegressions: modelTime, overflow: z.boolean(),
  }),
  transitions: z.array(z.object({
    seq: modelTime, publicationUs: modelTime, phase, visible: z.boolean(), status: z.string().min(1).max(40),
    result: resultClock.nullable(), provisionalJobId: jobId.nullable(),
  })).max(10_000),
  mismatchedJobIds: z.array(jobId),
  firstVisibleSupports: z.array(resultClock.extend({
    seq: modelTime, publicationUs: modelTime,
    regions: z.array(z.object({
      startM: z.number().nonnegative(), endM: z.number().positive(), status: z.literal('compatible'),
    }).refine(({ startM, endM }) => startM < endM)).min(1).max(399),
  })),
}).refine((trace) => {
  if (trace.status !== 'observed') return trace.firstVisibleSupports.length === 0
  const { terminalSnapshot: terminal, coverage, transitions } = trace
  const last = transitions.at(-1)
  return terminal !== null && coverage.lastSeq === terminal.seq && coverage.accepted === terminal.seq + 1
    && coverage.invalid === 0 && coverage.missingSequences === 0 && coverage.clockRegressions === 0 && !coverage.overflow
    && trace.mismatchedJobIds.length === 0 && last !== undefined && last.seq <= terminal.seq
    && last.phase === terminal.phase && last.publicationUs === terminal.timeUs
})
export const pacedReportSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('open-browser-paced-pilot'), qualified: z.literal(false),
  pace: z.literal(1), solver: z.literal('typescript-f64'), calibrationHash: z.null(),
  diagnosticMode: z.enum(['selected-policy', 'scheduler-fixture', 'qualitative-residuals']),
  activeAttemptEvaluated: z.literal(false), dictionaryLoaded: z.boolean(), selectedPolicy,
  activeShadowEnabled: z.literal(true).optional(),
  decisionTraceEnabled: z.literal(true).optional(),
  split: z.enum(OPEN_SPLITS), splitSha256: sha256Schema, profileSha256: sha256Schema, commitmentSha256: sha256Schema,
  generatorSha256: sha256Schema, recipeSha256: sha256Schema, sourceHashes,
  adapterSha256: sha256Schema, assets: z.array(z.object({ name: z.string().min(1).max(256), sha256: sha256Schema })).min(1).max(64),
  runId: z.string(), closure: z.enum(['qs', 'vb10']), targetUs: modelTime, status: reportStatus,
  browser: z.object({ name: z.literal('chromium'), version: z.string().min(1).max(80), headless: z.literal(true) }), node: z.string(),
  observation: z.object({
    timeUs: modelTime, phase: terminalPhase,
    failure: z.enum(['outside-model-domain', 'uncertain-flow-regime', 'unsupported-physics',
      'worker-error', 'transport-error', 'wall-timeout']).nullable(),
    closureEvidenceMissing: z.boolean(), elapsedMs: elapsedMs.nullish(), lag: z.object({ p95Ms: elapsedMs }).optional(),
    quantitativePath: z.boolean().optional(),
    counts: z.object({ admitted: modelTime, committed: modelTime }).optional(),
    simulationNumericalMemory: memory, inferenceNumericalMemory: memory,
    publicDiagnosticTrace: pacedDecisionTraceSchema.optional(),
  }),
  heap: z.object({ maxSampledTotalSize: modelTime.nullish() }).optional(),
})

type Report = z.infer<typeof pacedReportSchema>
type PinnedFields = Pick<Report, 'split' | 'splitSha256' | 'profileSha256' | 'commitmentSha256' | 'generatorSha256' |
  'recipeSha256' | 'sourceHashes' | 'selectedPolicy' | 'diagnosticMode' | 'targetUs' | 'decisionTraceEnabled'>
export type PacedMatrixExpected = PinnedFields & { readonly horizonUs: number }

export function matchesPacedMatrixReport(report: Report, run: PacedMatrixRun, expected: PacedMatrixExpected, node = process.version): boolean {
  if (report.runId !== run.runId || report.closure !== run.closure || report.node !== node
    || report.observation.timeUs > expected.targetUs || report.decisionTraceEnabled !== expected.decisionTraceEnabled) return false
  const { horizonUs, ...pinned } = expected
  if (Object.entries(pinned).some(([key, value]) => jsonDocument(report[key as keyof PinnedFields]) !== jsonDocument(value))) return false
  if (report.selectedPolicy?.researchSelection
    && (report.diagnosticMode !== 'selected-policy' || report.selectedPolicy.releaseScope !== 'passive')) return false
  const spatialPin = report.selectedPolicy?.spatialEvaluationSha256
  const hasAsset = (name: string, digest: string) => {
    const matches = report.assets.filter((asset) => asset.name === name)
    return matches.length === 1 && matches[0]?.sha256 === digest
  }
  if (report.selectedPolicy?.diagnosticGridSelection
    && (report.split !== 'calibration' || report.diagnosticMode !== 'selected-policy' || !report.decisionTraceEnabled
      || !spatialPin || report.activeShadowEnabled
      || !hasAsset('calibration/dictionary.json', report.selectedPolicy.dictionaryManifestSha256)
      || !hasAsset('calibration/dictionary.f64', report.selectedPolicy.dictionaryDataSha256))) return false
  const spatialAssets = report.assets.filter(({ name }) => name === PACED_SPATIAL_ASSET_PATH)
  if (spatialPin ? report.diagnosticMode !== 'selected-policy' || report.selectedPolicy?.releaseScope !== 'passive'
    || spatialAssets.length !== 1 || spatialAssets[0]?.sha256 !== spatialPin : spatialAssets.length > 0) return false
  if (report.status === 'completed' || report.status === 'pilot-cutoff') {
    const status = expected.targetUs === horizonUs ? 'completed' : 'pilot-cutoff'
    const observation = report.observation
    const trace = observation.publicDiagnosticTrace
    return report.status === status && observation.phase === 'completed' && observation.timeUs === report.targetUs
      && observation.failure === null && !observation.closureEvidenceMissing
      && (!expected.decisionTraceEnabled || (trace?.status === 'observed'
        && trace.terminalSnapshot?.phase === observation.phase && trace.terminalSnapshot.timeUs === observation.timeUs))
  }
  return true
}

export async function readPacedMatrixReport(path: string, run: PacedMatrixRun, expected: PacedMatrixExpected) {
  let bytes: Buffer
  try {
    bytes = await readBounded(path)
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    return { kind: missing ? 'missing' as const : 'invalid' as const, sha256: null }
  }
  const digest = sha256(bytes)
  try {
    const report = pacedReportSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
    if (!matchesPacedMatrixReport(report, run, expected)) return { kind: 'invalid' as const, sha256: digest }
    const observation = report.observation
    return {
      kind: 'verified' as const, sha256: digest, status: report.status, timeUs: observation.timeUs,
      failure: observation.failure, closureEvidenceMissing: observation.closureEvidenceMissing,
      dictionaryLoaded: report.dictionaryLoaded, browserVersion: report.browser.version, adapterSha256: report.adapterSha256,
      assetsSha256: sha256(jsonDocument(report.assets)), elapsedMs: observation.elapsedMs ?? null,
      p95LagMs: observation.lag?.p95Ms ?? null, admittedJobs: observation.counts?.admitted ?? null,
      committedJobs: observation.counts?.committed ?? null, peakHeapBytes: report.heap?.maxSampledTotalSize ?? null,
      peakSimulationNumericalBytes: observation.simulationNumericalMemory?.highWaterBytes ?? null,
      peakInferenceNumericalBytes: observation.inferenceNumericalMemory?.highWaterBytes ?? null,
      ...(report.decisionTraceEnabled ? { decisionTraceStatus: observation.publicDiagnosticTrace?.status ?? null } : {}),
    }
  } catch {
    return { kind: 'invalid' as const, sha256: digest }
  }
}
