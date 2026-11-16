import { z } from 'zod'
import { calibrationHashesSchema, sha256Schema } from '../contracts/calibration'
import type { Calibration } from '../contracts/calibration'
import type { DiagnosticJob, PublicPredictionCheckpoint } from '../contracts/inference'
import type { AnchorId } from '../contracts/model'
import { initialize } from '../physics/initialize'
import type { CheckpointAnchor } from '../twin/checkpoint'
import type { CandidatePrediction, FitEvidence } from './hypotheses'
import { ANCHOR_IDS } from './optimizer'
import type { RankedTrial } from './optimizer'
import { optimisticScore } from './profile'
import { prepareDictionary, screeningRows, verifiedDictionaryDigest, verifiedSpatialLowerScore } from './screening'
import type { ResponseDictionary, ScreeningRow } from './screening'
import { ENVELOPE_CELL_COUNT, ENVELOPE_NODE_COUNT } from './spatial-envelope'

const GUARD_US = 3_000_000
export const MAX_SPATIAL_ARTIFACT_BYTES = 64 * 1024
export const SPATIAL_ARTIFACT_FILENAME = 'spatial-envelope.json'
const STEADY_PRESSURE_TOLERANCE_PA = 1e-4
const STEADY_FLOW_TOLERANCE_M3S = 1e-12
const STEADY_TEMPERATURE_TOLERANCE_K = 1e-8

const spatialArtifactSchema = z.strictObject({
  schemaVersion: z.literal(1),
  controlFamily: z.literal('steady-outlet'),
  solver: z.literal('typescript-f64'),
  calibrationId: sha256Schema,
  reportHash: sha256Schema,
  hashes: calibrationHashesSchema,
  coverage: z.strictObject({
    guardUs: z.literal(GUARD_US),
    openingUs: z.tuple([z.literal(0), z.literal(1_000_000), z.literal(20_000_000)]).readonly(),
    maximumCdAreaM2: z.literal(4e-5),
    windowUs: z.tuple([z.literal(4_000_000), z.literal(30_000_000)]).readonly(),
    interiorCells: z.literal(ENVELOPE_NODE_COUNT),
    cellWidthM: z.literal(5),
    steadyPressureTolerancePa: z.literal(STEADY_PRESSURE_TOLERANCE_PA),
    steadyFlowToleranceM3s: z.literal(STEADY_FLOW_TOLERANCE_M3S),
    steadyTemperatureToleranceK: z.literal(STEADY_TEMPERATURE_TOLERANCE_K),
  }).readonly(),
  anchorParameterHashes: z.array(sha256Schema).length(ANCHOR_IDS.length).readonly(),
  discrepancyNorms: z.array(z.number().nonnegative()).length(ENVELOPE_CELL_COUNT).readonly(),
}).readonly()

export type QualifiedSpatialEnvelope = z.infer<typeof spatialArtifactSchema>
const verifiedEnvelopes = new WeakMap<QualifiedSpatialEnvelope, string>()

export function verifiedSpatialEnvelopeDigest(envelope: QualifiedSpatialEnvelope): string | undefined {
  return verifiedEnvelopes.get(envelope)
}

function sameLineage(envelope: QualifiedSpatialEnvelope, calibration: Calibration): boolean {
  return calibration.qualification.quantitative && calibration.errorEnvelope.qualified
    && envelope.calibrationId === calibration.calibrationId && envelope.reportHash === calibration.reportHash
    && Object.entries(envelope.hashes).every(([key, hash]) => hash === calibration.hashes[key as keyof Calibration['hashes']])
}

export async function loadQualifiedSpatialEnvelope(
  bytes: Uint8Array<ArrayBuffer>, calibration: Calibration,
): Promise<QualifiedSpatialEnvelope | null> {
  const expected = calibration.errorEnvelope.spatialArtifactSha256
  if (!expected || bytes.byteLength > MAX_SPATIAL_ARTIFACT_BYTES || !calibration.errorEnvelope.qualified
    || !calibration.qualification.quantitative) return null
  try {
    // Copy the bounded payload once so the verified bytes also feed the parser.
    const artifact = bytes.slice()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', artifact))
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== expected) return null
    const text = new TextDecoder('utf-8', { fatal: true }).decode(artifact)
    const envelope = spatialArtifactSchema.parse(JSON.parse(text))
    if (!sameLineage(envelope, calibration)) return null
    verifiedEnvelopes.set(envelope, hash)
    return envelope
  } catch {
    return null
  }
}

function sameJob(
  job: DiagnosticJob, dictionary: ResponseDictionary, envelope: QualifiedSpatialEnvelope, calibration: Calibration,
  anchors: readonly CheckpointAnchor[],
): boolean {
  return verifiedEnvelopes.has(envelope) && verifiedEnvelopes.get(envelope) === calibration.errorEnvelope.spatialArtifactSha256
    && sameLineage(envelope, calibration) && verifiedDictionaryDigest(dictionary) === envelope.hashes.dictionary
    && job.calibrationId === calibration.calibrationId && job.profileId === calibration.profileId
    && job.modelVersion === calibration.modelVersion && job.bankVersion === calibration.bankVersion
    && job.controlRevision === 0 && job.appliedControls.length === 0 && job.checkpointsByAnchor.length === ANCHOR_IDS.length
    && job.checkpointsByAnchor.every((checkpoint, id) => checkpoint.parameterHash === envelope.anchorParameterHashes[id]
      && checkpoint.grid.cellCount === ENVELOPE_NODE_COUNT + 1 && checkpoint.grid.spacingM === 5
      && checkpoint.memory.kind === 'none' && Object.values(checkpoint.boundaries).every((value) => value === undefined)
      && steadyCheckpoint(checkpoint, anchors[id]))
}

function sameField(actual: Float64Array, expected: Float64Array, tolerance: number): boolean {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance)
}

function steadyCheckpoint(checkpoint: PublicPredictionCheckpoint, anchor: CheckpointAnchor | undefined): boolean {
  if (!anchor || anchor.anchorId !== checkpoint.anchorId || anchor.parameterHash !== checkpoint.parameterHash
    || checkpoint.eventCursor !== 0 || checkpoint.controlRevision !== 0
    || checkpoint.lastThermalTimeUs !== checkpoint.timeUs || checkpoint.thermalFlow.elapsedUs !== 0) return false
  const initial = initialize(anchor.definition)
  if (!initial.ok) return false
  const { p, qL, qR, tOil, tWall } = initial.value
  return sameField(checkpoint.pressurePa, p, STEADY_PRESSURE_TOLERANCE_PA)
    && sameField(checkpoint.leftFlowM3s, qL, STEADY_FLOW_TOLERANCE_M3S)
    && sameField(checkpoint.rightFlowM3s, qR, STEADY_FLOW_TOLERANCE_M3S)
    && sameField(checkpoint.oilTemperatureK, tOil, STEADY_TEMPERATURE_TOLERANCE_K)
    && sameField(checkpoint.wallTemperatureK, tWall, STEADY_TEMPERATURE_TOLERANCE_K)
}

function sameMask(reference: readonly ScreeningRow[], rows: readonly ScreeningRow[]): boolean {
  return reference.length === rows.length && rows.every(({ sensorId, previousTimeUs, currentTimeUs, scale, rho }, index) => {
    const expected = reference[index]!
    return expected.sensorId === sensorId && expected.previousTimeUs === previousTimeUs
      && expected.currentTimeUs === currentTimeUs && expected.scale === scale && expected.rho === rho
  })
}

interface AnchorNominalFit {
  readonly evidence: FitEvidence
  readonly prediction: CandidatePrediction
}

export async function calculateProfileExclusions(
  job: DiagnosticJob, dictionary: ResponseDictionary, envelope: QualifiedSpatialEnvelope, calibration: Calibration,
  anchors: readonly CheckpointAnchor[], nominal: ReadonlyMap<AnchorId, AnchorNominalFit>, trials: readonly RankedTrial[],
  poll: () => Promise<boolean>,
): Promise<ReadonlySet<number> | null> {
  if (!sameJob(job, dictionary, envelope, calibration, anchors)) return null
  const firstOnsetUs = job.windowStartUs - GUARD_US
  const traces = prepareDictionary(dictionary, job, {
    firstOnsetUs, lastOnsetUs: job.windowEndUs, lastNode: ENVELOPE_NODE_COUNT, nominalFlowM3s: 1,
  })
  if (!traces || firstOnsetUs < 0) return null

  const fits = trials.filter(({ candidate }) => candidate.model === 'ML' && candidate.cdAreaM2 > 0
    && candidate.onsetUs > firstOnsetUs && candidate.onsetUs <= job.windowEndUs)
  const best = Math.min(...fits.map(({ score }) => score))
  const cutoff = best + calibration.thresholds.profile
  const { multiplier, numericalFloor } = calibration.errorEnvelope
  if (!Number.isFinite(cutoff) || cutoff < best || !Number.isFinite(multiplier) || multiplier < 1
    || !Number.isFinite(calibration.thresholds.absoluteFit) || calibration.thresholds.absoluteFit < 0
    || !Number.isFinite(numericalFloor) || numericalFloor < 0) return null

  const exactByCell = new Map<number, number>()
  for (const { candidate, score } of fits) {
    if (candidate.model !== 'ML') continue
    if (!Number.isFinite(score) || score < 0 || candidate.node < 1 || candidate.node > ENVELOPE_NODE_COUNT) return null
    const cell = candidate.anchorId * ENVELOPE_NODE_COUNT + candidate.node - 1
    exactByCell.set(cell, Math.min(score, exactByCell.get(cell) ?? Infinity))
  }

  const excluded = new Set(Array.from({ length: ENVELOPE_NODE_COUNT }, (_, index) => index + 1))
  let referenceRows: readonly ScreeningRow[] | undefined
  for (const anchorId of ANCHOR_IDS) {
    const fit = nominal.get(anchorId)
    const rows = fit && screeningRows(fit.evidence, fit.prediction)
    if (!rows?.length || (referenceRows && !sameMask(referenceRows, rows))
      || !rows.every(({ scale, rho, residual, previousTimeUs, currentTimeUs }) => Number.isFinite(scale) && scale > 0
        && Math.abs(rho) < 1 && Number.isFinite(residual) && previousTimeUs >= job.windowStartUs
        && currentTimeUs > previousTimeUs && currentTimeUs <= job.windowEndUs)) return null
    referenceRows = rows
    if (best / rows.length > calibration.thresholds.absoluteFit) return null
    for (let node = 1; node <= ENVELOPE_NODE_COUNT; node++) {
      if ((node - 1) % 5 === 0 && !await poll()) return null
      const surrogate = verifiedSpatialLowerScore(dictionary, anchorId, node, rows, firstOnsetUs)
      const cell = anchorId * ENVELOPE_NODE_COUNT + node - 1
      const discrepancy = envelope.discrepancyNorms[cell]! + numericalFloor
      if (surrogate === null || !Number.isFinite(surrogate) || !Number.isFinite(discrepancy)) return null
      const lowerScore = optimisticScore(surrogate, discrepancy, multiplier)
      // An exact observation can falsify an empirical bound. Do not prune on
      // any of its claims when the current evidence contains a contradiction.
      if (lowerScore > (exactByCell.get(cell) ?? Infinity)) return null
      if (lowerScore <= cutoff) excluded.delete(node)
    }
  }
  return excluded
}
