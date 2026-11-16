import { join } from 'node:path'
import { z } from 'zod'
import { calibrationSchema, sha256Schema } from '../../../src/contracts/calibration'
import type { Calibration } from '../../../src/contracts/calibration'
import { anchorIdSchema, BANK_VERSION } from '../../../src/contracts/model'
import type { FluidProfile } from '../../../src/contracts/model'
import { DICTIONARY_CHANNELS, MAX_DICTIONARY_BYTES, responseDictionaryManifestSchema } from '../../../src/contracts/response-dictionary'
import { loadQualifiedSpatialEnvelope, MAX_SPATIAL_ARTIFACT_BYTES } from '../../../src/detection/qualified-spatial-profile'
import { createCheckpointAnchor } from '../../../src/twin/checkpoint'
import { bankProfiles } from '../../../src/twin/predict'
import type { diagnosticSourceHashes } from '../../diagnostic-source-hashes'
import type { OPEN_SPLITS } from '../generate-scenarios'
import { jsonDocument, readBounded, sha256 } from '../io'
import { diagnosticIndicesSchema, QUANTILES } from '../selection'

const MANIFEST_LIMIT_BYTES = 64 * 1024
const SELECTION_LIMIT_BYTES = 8192
const MIN_RESPONSE_DURATION_US = 33_000_000
const sourceKeys = ['model', 'bank', 'sensor', 'policy'] as const
const selectionSchema = z.strictObject(calibrationSchema.unwrap().shape).omit({
  calibrationId: true, qualification: true, reportHash: true,
})
export const selectionRequestSchema = z.strictObject({
  selection: z.unknown(),
  selectionHash: sha256Schema,
  diagnosticIndices: z.array(z.number().int().min(0).max(QUANTILES.length - 1)).length(5),
  calibrationScore: z.strictObject({
    correct: z.number().int().nonnegative(), timely: z.number().int().nonnegative(), medianWidthM: z.number().nonnegative().nullable(),
  }),
})
export const researchSelectionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('passive-spatial-research-selection'),
  releaseQualified: z.literal(false),
  cusumGridSha256: sha256Schema,
  protocolSha256: sha256Schema,
  selection: z.unknown().refine((value) => selectionSchema.safeParse(value).success, 'Invalid spatial research selection core.'),
  selectionHash: sha256Schema,
})
export const diagnosticGridSelectionEvidenceSchema = z.strictObject({
  fitStatisticsSha256: sha256Schema,
  cusumGridSha256: sha256Schema,
  diagnosticIndices: diagnosticIndicesSchema.readonly(),
})
export const diagnosticGridSelectionRequestSchema = diagnosticGridSelectionEvidenceSchema.extend({
  schemaVersion: z.literal(1),
  kind: z.literal('passive-diagnostic-grid-selection'),
  releaseQualified: z.literal(false),
  selection: z.unknown().refine((value) => selectionSchema.safeParse(value).success, 'Invalid diagnostic grid selection core.'),
  selectionHash: sha256Schema,
})
export const pacedSelectionRequestSchema = z.union([selectionRequestSchema, researchSelectionRequestSchema, diagnosticGridSelectionRequestSchema])

function validatePinnedSelection(
  candidate: Pick<z.infer<typeof selectionRequestSchema>, 'selection' | 'selectionHash'>,
  expectedSelectionHash: string,
) {
  const selection = selectionSchema.parse(candidate.selection)
  const selectionHash = sha256(jsonDocument(candidate.selection))
  if (candidate.selectionHash !== selectionHash || expectedSelectionHash !== selectionHash) {
    throw new Error('Selection digest differs from the independently pinned selection.')
  }
  return { selection, selectionHash }
}

export function validateSelectionRequest(candidate: z.infer<typeof selectionRequestSchema>, expectedSelectionHash: string) {
  return validatePinnedSelection(candidate, expectedSelectionHash)
}

type ValidatedPacedSelection = ReturnType<typeof validatePinnedSelection> & {
  readonly researchSelection?: true
  readonly diagnosticGridSelection?: true
}

export function validatePacedSelectionRequest(
  candidate: z.infer<typeof pacedSelectionRequestSchema>, expectedSelectionHash: string,
): ValidatedPacedSelection {
  const validated = validatePinnedSelection(candidate, expectedSelectionHash)
  if (!('kind' in candidate)) return validated
  if (candidate.kind === 'passive-diagnostic-grid-selection') {
    const { releaseScope, errorEnvelope } = validated.selection
    if (releaseScope !== 'passive') throw new Error('Diagnostic grid selection requires passive scope.')
    if (errorEnvelope.qualified || errorEnvelope.spatialArtifactSha256 !== undefined) {
      throw new Error('Diagnostic grid selection requires an unqualified envelope.')
    }
    return { ...validated, diagnosticGridSelection: true }
  }
  if (validated.selection.releaseScope !== 'passive') throw new Error('Spatial research selection requires passive scope.')
  if (validated.selection.errorEnvelope.qualified || validated.selection.errorEnvelope.spatialArtifactSha256 !== undefined) {
    throw new Error('Spatial research selection requires an unqualified envelope.')
  }
  return { ...validated, researchSelection: true as const }
}

export interface PacedDictionaryAssets {
  readonly manifest: Buffer
  readonly data: Buffer
  readonly spatialEnvelope?: Buffer
}

interface SpatialEvaluation {
  readonly path: string
  readonly expectedSha256: string
}

interface SelectionOptions {
  readonly selectionPath: string
  readonly expectedSelectionHash: string
  readonly expectedSelectionFileSha256?: string
  readonly dictionaryDirectory: string
  readonly profile: FluidProfile
  readonly sourceHashes: ReturnType<typeof diagnosticSourceHashes>
  readonly profileHash: string
  readonly split: typeof OPEN_SPLITS[number]
  readonly splitHash: string
  readonly sensorProfileId: Calibration['sensorProfileId']
  readonly spatialEvaluation?: SpatialEvaluation
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

function assertSelectionMatches(selection: z.infer<typeof selectionSchema>, options: SelectionOptions): void {
  if (selection.errorEnvelope.qualified || selection.errorEnvelope.spatialArtifactSha256 !== undefined) {
    throw new Error('Paced selection must be the unqualified pre-freeze output of calibrate --select-only.')
  }
  if (options.spatialEvaluation && selection.releaseScope !== 'passive') {
    throw new Error('Paced spatial evaluation requires a passive selection.')
  }
  if (selection.modelVersion !== options.profile.modelVersion || selection.bankVersion !== BANK_VERSION
    || selection.profileId !== options.profile.profileId || selection.hashes.profile !== options.profileHash) {
    throw new Error('Selection profile and model versions differ from the committed open profile.')
  }
  if (selection.sensorProfileId !== options.sensorProfileId) throw new Error('Selection sensor layout differs from the selected run.')
  if (!sourceKeys.every((key) => selection.hashes[key] === options.sourceHashes[key])) {
    throw new Error('Selection source hashes differ from the paced Worker build.')
  }
  const splitHashes = [selection.hashes.fit, selection.hashes.calibration, selection.hashes.development]
  if (new Set(splitHashes).size !== splitHashes.length || selection.hashes[options.split] !== options.splitHash) {
    throw new Error('Selection split hashes must independently bind to the committed open split and role.')
  }
}

async function prepareSpatialEnvelope(
  input: SpatialEvaluation, calibration: Calibration, anchorParameterHashes: readonly string[],
): Promise<Buffer> {
  const bytes = await readBounded(input.path, MAX_SPATIAL_ARTIFACT_BYTES).catch((error: unknown) => {
    throw new Error('Unable to read the bounded spatial evaluation envelope.', { cause: error })
  })
  const envelope = await loadQualifiedSpatialEnvelope(Uint8Array.from(bytes), calibration)
  if (!envelope) throw new Error('Pinned spatial evaluation envelope failed digest, schema, or calibration lineage verification.')
  if (envelope.anchorParameterHashes.some((hash, index) => hash !== anchorParameterHashes[index])) {
    throw new Error('Spatial evaluation envelope anchors differ from the verified response dictionary.')
  }
  return bytes
}

async function prepareDictionary(options: SelectionOptions, calibration: Calibration): Promise<PacedDictionaryAssets> {
  const manifest = await readBounded(join(options.dictionaryDirectory, 'dictionary.json'), MANIFEST_LIMIT_BYTES)
  const parsed = responseDictionaryManifestSchema.parse(parseJson(manifest))
  if (parsed.profileId !== calibration.profileId || parsed.modelVersion !== calibration.modelVersion
    || parsed.bankVersion !== calibration.bankVersion || parsed.dataSha256 !== calibration.hashes.dictionary) {
    throw new Error('Response dictionary version or digest differs from the selected policy.')
  }
  const sampleCount = parsed.traces[0]!.sampleCount
  if ((sampleCount - 1) * parsed.samplePeriodUs < MIN_RESPONSE_DURATION_US) {
    throw new Error('Paced response dictionary must cover the 33 s observation window and guard.')
  }
  const publicProfile = { ...options.profile, sensorProfileId: options.sensorProfileId, startupQualification: 'known-healthy' as const }
  const anchors = await Promise.all(bankProfiles(publicProfile).map((definition, index) =>
    createCheckpointAnchor(anchorIdSchema.parse(index), definition)))
  if (anchors.some(({ parameterHash }, index) => parameterHash !== parsed.anchorParameterHashes[index])) {
    throw new Error('Response dictionary anchors differ from the selected bank and sensor layout.')
  }
  const data = await readBounded(join(options.dictionaryDirectory, 'dictionary.f64'), MAX_DICTIONARY_BYTES)
  if (data.byteLength !== parsed.traces.length * sampleCount * DICTIONARY_CHANNELS * Float64Array.BYTES_PER_ELEMENT) {
    throw new Error('Response dictionary binary length differs from its manifest.')
  }
  if (sha256(data) !== parsed.dataSha256) throw new Error('Response dictionary binary digest mismatch.')
  for (let offset = 0; offset < data.byteLength; offset += Float64Array.BYTES_PER_ELEMENT) {
    if (!Number.isFinite(data.readDoubleLE(offset))) throw new Error('Response dictionary contains non-finite samples.')
  }
  const spatialEnvelope = options.spatialEvaluation
    ? await prepareSpatialEnvelope(options.spatialEvaluation, calibration, parsed.anchorParameterHashes) : undefined
  return { manifest, data, ...(spatialEnvelope ? { spatialEnvelope } : {}) }
}

export async function preparePacedSelection(options: SelectionOptions) {
  const bytes = await readBounded(options.selectionPath, SELECTION_LIMIT_BYTES)
  const selectionFileSha256 = sha256(bytes)
  const filePin = options.expectedSelectionFileSha256
  if (filePin !== undefined && selectionFileSha256 !== sha256Schema.parse(filePin)) {
    throw new Error('Selection file digest differs from --expected-selection-file-sha256.')
  }
  const candidate = pacedSelectionRequestSchema.parse(parseJson(bytes))
  const gridSelection = 'kind' in candidate && candidate.kind === 'passive-diagnostic-grid-selection'
    ? {
      fitStatisticsSha256: candidate.fitStatisticsSha256, cusumGridSha256: candidate.cusumGridSha256, diagnosticIndices: candidate.diagnosticIndices,
    } : undefined
  if ('kind' in candidate && filePin === undefined) {
    const label = gridSelection ? 'Diagnostic grid selection' : 'Research selection'
    throw new Error(`${label} requires --expected-selection-file-sha256.`)
  }
  if (gridSelection && options.split !== 'calibration') throw new Error('Diagnostic grid selection requires the calibration split.')
  if (gridSelection && !options.spatialEvaluation) throw new Error('Diagnostic grid selection requires a pinned spatial evaluation.')
  const { selection, selectionHash, researchSelection } = validatePacedSelectionRequest(candidate, options.expectedSelectionHash)
  assertSelectionMatches(selection, options)
  const spatialEvaluationSha256 = options.spatialEvaluation && sha256Schema.parse(options.spatialEvaluation.expectedSha256)
  // Test-mode Workers accept fixture calibration to run the quantitative path. The disk artifact and report remain unqualified.
  const calibration = calibrationSchema.parse({
    ...selection, calibrationId: selectionHash, reportHash: selectionFileSha256,
    qualification: { quantitative: true, active: false },
    ...(spatialEvaluationSha256 ? { errorEnvelope: { ...selection.errorEnvelope,
      qualified: true, spatialArtifactSha256: spatialEvaluationSha256 } } : {}),
  })
  const dictionary = await prepareDictionary(options, calibration)
  return {
    diagnosticRelease: { calibration, expectedHashes: calibration.hashes },
    dictionary,
    evidence: { selectionHash, selectionFileSha256, releaseScope: selection.releaseScope,
      dictionaryManifestSha256: sha256(dictionary.manifest), dictionaryDataSha256: selection.hashes.dictionary,
      ...(spatialEvaluationSha256 ? { spatialEvaluationSha256 } : {}), ...(researchSelection ? { researchSelection } : {}),
      ...(gridSelection ? { diagnosticGridSelection: gridSelection } : {}) },
  }
}
