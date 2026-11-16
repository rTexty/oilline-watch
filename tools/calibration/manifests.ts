import { z } from 'zod'
import { calibrationSchema, releaseScopeSchema, sha256Schema } from '../../src/contracts/calibration'
import { CHALLENGE_US, refsSchema, evidenceSchema, runEvidenceSchema } from './contracts'
import { cusumSourceHashesSchema } from './cusum-grid'
import { cusumCandidateSchema, CUSUM_GRID_SIZE, statisticSchema } from './selection'

const noise = calibrationSchema.unwrap().shape.noise
const referenceHashesSchema = z.strictObject({
  model: sha256Schema, bank: sha256Schema, sensor: sha256Schema, policy: sha256Schema, dictionary: sha256Schema,
})

const splitReferences = {
  fit: refsSchema, calibration: refsSchema, development: refsSchema,
  blindCommitment: sha256Schema,
}

export const selectedEvidenceSchema = z.strictObject({
  summary: refsSchema,
  browserSchedule: refsSchema,
  policyTrace: refsSchema,
})

export const calibrationManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseScope: releaseScopeSchema,
  profileHash: sha256Schema,
  hashes: referenceHashesSchema,
  splits: z.strictObject(splitReferences),
  noise,
  numericalFloor: z.number().nonnegative(),
  fitStatistics: refsSchema,
  cusumGrid: refsSchema,
  diagnosticGrid: refsSchema.extend({
    splitHash: sha256Schema, profileHash: sha256Schema, policyHash: sha256Schema, fitStatisticsHash: sha256Schema,
    cusum: z.strictObject({ fast: z.number().int(), slow: z.number().int() }),
  }),
  selectedPolicyReplay: selectedEvidenceSchema.optional(),
  developmentEvidence: selectedEvidenceSchema.optional(),
})

export const fitStatisticsSchema = z.strictObject({
  schemaVersion: z.literal(1), splitHash: sha256Schema, profileHash: sha256Schema, policyHash: sha256Schema,
  runs: z.array(z.strictObject({ runId: z.string().min(1).max(96), statistic: statisticSchema })).min(1).max(408),
})

export const cusumGridSchema = z.strictObject({
  schemaVersion: z.literal(2), splitHash: sha256Schema, profileHash: sha256Schema, policyHash: sha256Schema,
  sourceHashes: cusumSourceHashesSchema,
  runIds: z.array(z.string().min(1).max(96)).length(15),
  availableUs: z.array(z.number().int().positive().max(CHALLENGE_US).multipleOf(10_000)).length(15),
  candidates: z.array(cusumCandidateSchema).length(CUSUM_GRID_SIZE),
})

export const qualificationEvidenceSchema = evidenceSchema.extend({
  runs: z.array(runEvidenceSchema).min(180).max(228),
  selectionHash: sha256Schema,
  backend: z.enum(['cpu-ts-f64', 'cpu-wasm-f64', 'webgpu-f64-recheck']),
  clock: z.literal('paced-browser'),
})

export const freezeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  calibrationHash: sha256Schema,
  releaseScope: releaseScopeSchema,
  blindCommitment: sha256Schema,
  fitHash: sha256Schema, calibrationSplitHash: sha256Schema, developmentHash: sha256Schema,
})

export const blindManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  splits: z.strictObject(splitReferences),
  frozenPolicy: refsSchema,
  calibrationReport: refsSchema,
  blindSplit: refsSchema,
  blindEvidence: selectedEvidenceSchema,
})
