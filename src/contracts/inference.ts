import { z } from 'zod';
import { sha256Schema } from './calibration';
import {
  CHALLENGE_HORIZON_US,
  UNITS_VERSION,
  anchorIdSchema,
  bankVersionSchema,
  modelTimeSchema,
  modelVersionSchema,
  profileIdSchema,
  schemaVersionSchema,
} from './model';
import { nominalPredictionCacheMatches, nominalPredictionCacheSchema } from './nominal-predictions';
import { appliedControlSchema, counterSchema, dataAvailabilitySchema, idSchema, publicSampleSchema, pulseSchema } from './public';

const versionFields = {
  modelVersion: modelVersionSchema,
  profileId: profileIdSchema,
  bankVersion: bankVersionSchema,
  calibrationId: sha256Schema,
};

function finiteBuffer(maxLength: number) {
  return z.instanceof(Float64Array).refine(
    (values) => values.length <= maxLength && values.buffer instanceof ArrayBuffer
      && values.byteLength === values.buffer.byteLength && values.every(Number.isFinite),
    { message: 'Buffer must own bounded finite Float64 entries' },
  );
}

const nodeBuffer = finiteBuffer(401);
const pressureBuffer = nodeBuffer.refine((values) => values.every((value) => value >= 250_000 && value <= 2_000_000));
const temperatureBuffer = finiteBuffer(400).refine((values) => values.every((value) => value >= 308.15 && value <= 338.15));
const directionalBuffer = nodeBuffer.refine((values) => values.every((value) => value >= 0));
const memorySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('zielke'),
    kernelVersion: z.string().min(1).max(80),
    ringLength: z.number().int().min(1).max(800),
    ringIndex: counterSchema,
    historyCount: counterSchema,
    ring: finiteBuffer(401 * 800),
    tails: finiteBuffer(401 * 5),
    previousVelocity: nodeBuffer,
    acceleration: nodeBuffer,
  }),
  z.strictObject({
    kind: z.literal('vardy-brown'),
    leftTails: finiteBuffer(401 * 10),
    rightTails: finiteBuffer(401 * 10),
    previousLeftVelocity: nodeBuffer,
    previousRightVelocity: nodeBuffer,
  }),
]).readonly();

const checkpointFields = z.strictObject({
  schemaVersion: schemaVersionSchema,
  unitsVersion: z.literal(UNITS_VERSION),
  dtype: z.literal('float64'),
  modelVersion: modelVersionSchema,
  profileId: profileIdSchema,
  bankVersion: bankVersionSchema,
  anchorId: anchorIdSchema,
  parameterHash: sha256Schema,
  timeUs: modelTimeSchema,
  grid: z.strictObject({
    nodeCount: z.number().int().min(3).max(401),
    faceCount: z.number().int().min(3).max(401),
    cellCount: z.number().int().min(2).max(400),
    spacingM: z.number().positive(),
  }).readonly(),
  pressurePa: pressureBuffer,
  leftFlowM3s: nodeBuffer,
  rightFlowM3s: nodeBuffer,
  oilTemperatureK: temperatureBuffer,
  wallTemperatureK: temperatureBuffer,
  thermalFlow: z.strictObject({
    elapsedUs: modelTimeSchema.max(99_999),
    leftPositiveM3: directionalBuffer,
    leftNegativeM3: directionalBuffer,
    rightPositiveM3: directionalBuffer,
    rightNegativeM3: directionalBuffer,
  }).readonly(),
  lastThermalTimeUs: modelTimeSchema,
  splittingPhase: z.enum(['hydraulic', 'thermal']),
  memory: memorySchema,
  boundaries: z.strictObject({
    pinPa: z.number().min(250_000).max(2_000_000).optional(),
    qoutM3s: z.number().optional(),
    tinK: z.number().min(308.15).max(338.15).optional(),
    ambientK: z.number().min(308.15).max(338.15).optional(),
  }).readonly(),
  controlRevision: counterSchema,
  eventCursor: counterSchema,
  previousFlux: z.strictObject({
    inletFlowM3s: z.number(),
    outletFlowM3s: z.number(),
    withdrawalM3s: z.literal(0),
  }).readonly(),
  volumeBalance: z.strictObject({
    initialPressureIntegralPaM: z.number().positive(),
    storedM3: z.number(),
    netFluxM3: z.number(),
    absoluteFluxM3: z.number().nonnegative(),
    residualM3: z.number(),
  }).readonly(),
  energyLedger: z.strictObject({
    oilChangeJ: z.number(),
    wallChangeJ: z.number(),
    boundaryInJ: z.number(),
    boundaryOutJ: z.number(),
    leakJ: z.literal(0),
    ambientJ: z.number(),
    compressionApproxJ: z.number(),
    residualJ: z.number(),
    normalizedResidual: z.number().nonnegative(),
    scaleJ: z.number().nonnegative(),
  }).readonly(),
  stepCount: counterSchema.optional(),
});

type CheckpointFields = z.infer<typeof checkpointFields>;

function hasCheckpointDimensions(checkpoint: CheckpointFields): boolean {
  const { nodeCount, faceCount, cellCount } = checkpoint.grid;
  const { memory, thermalFlow } = checkpoint;
  if (nodeCount !== cellCount + 1 || nodeCount !== faceCount
    || checkpoint.timeUs - checkpoint.lastThermalTimeUs !== thermalFlow.elapsedUs) return false;
  if (![checkpoint.pressurePa, checkpoint.leftFlowM3s, checkpoint.rightFlowM3s]
    .every((values) => values.length === nodeCount)) return false;
  if (checkpoint.oilTemperatureK.length !== cellCount || checkpoint.wallTemperatureK.length !== cellCount) return false;
  if (![thermalFlow.leftPositiveM3, thermalFlow.leftNegativeM3, thermalFlow.rightPositiveM3,
    thermalFlow.rightNegativeM3].every((values) => values.length === faceCount)) return false;
  switch (memory.kind) {
    case 'none':
      return true;
    case 'zielke':
      return memory.ringIndex < memory.ringLength && memory.historyCount <= memory.ringLength
        && memory.ring.length === nodeCount * memory.ringLength && memory.tails.length === nodeCount * 5
        && memory.previousVelocity.length === nodeCount && memory.acceleration.length === nodeCount;
    case 'vardy-brown':
      return memory.leftTails.length === nodeCount * 10 && memory.rightTails.length === nodeCount * 10
        && memory.previousLeftVelocity.length === nodeCount && memory.previousRightVelocity.length === nodeCount;
  }
}

export const predictionCheckpointSchema = checkpointFields.refine(hasCheckpointDimensions, {
  message: 'Checkpoint fields do not match the grid, clock or memory dimensions',
}).readonly();

const baselinesSchema = z.strictObject({
  anchorId: anchorIdSchema,
  meanResidualSI: z.strictObject({
    P1: z.number(), P2: z.number(), P3: z.number(), Qin: z.number(),
  }).readonly(),
}).readonly();

const searchBudgetSchema = z.strictObject({
  quantumEvaluations: z.number().int().min(1).max(64),
  evaluationLimit: z.number().int().min(1).max(512),
  wallLimitMs: z.number().positive().max(5000),
}).readonly();

export const diagnosticJobSchema = z.strictObject({
  jobId: idSchema,
  ...versionFields,
  controlRevision: counterSchema,
  requestedAtUs: modelTimeSchema,
  windowStartUs: modelTimeSchema,
  windowEndUs: modelTimeSchema,
  deliveredThroughUs: modelTimeSchema,
  checkpointsByAnchor: z.array(predictionCheckpointSchema).length(9).readonly(),
  frozenBaselines: z.array(baselinesSchema).length(9).readonly(),
  observations: z.array(publicSampleSchema).max(12_804).readonly(),
  appliedControls: z.array(appliedControlSchema).max(1000).readonly(),
  nominalPredictionCache: nominalPredictionCacheSchema.optional(),
  searchBudget: searchBudgetSchema,
}).refine((job) => {
  const windowUs = job.windowEndUs - job.windowStartUs;
  return job.profileId === 'synthetic-oil-turbulent-v1' && job.requestedAtUs <= CHALLENGE_HORIZON_US
    && (windowUs === 4_000_000 || windowUs === 30_000_000)
    && job.requestedAtUs >= job.windowEndUs && job.requestedAtUs >= job.deliveredThroughUs
    && job.observations.every((sample) => sample.sampleTimeUs >= Math.max(0, job.windowStartUs - 3_000_000)
      && sample.sampleTimeUs <= job.windowEndUs && sample.deliveredTimeUs <= job.deliveredThroughUs)
    && job.appliedControls.every((control) => control.appliedTimeUs <= job.windowEndUs
      && control.controlRevision <= job.controlRevision)
    && (!job.nominalPredictionCache || nominalPredictionCacheMatches(job.nominalPredictionCache, job))
    && job.checkpointsByAnchor.every((checkpoint, index) => checkpoint.anchorId === index
      && checkpoint.timeUs <= job.windowStartUs - 3_000_000
      && checkpoint.modelVersion === job.modelVersion && checkpoint.profileId === job.profileId
      && checkpoint.bankVersion === job.bankVersion && checkpoint.controlRevision <= job.controlRevision)
    && job.frozenBaselines.every((baseline, index) => baseline.anchorId === index);
}, { message: 'Invalid diagnostic window, checkpoints or causal prefix' }).readonly();

export const stopReasonSchema = z.enum([
  'complete', 'evaluation-limit', 'wall-limit', 'cancelled', 'invalid-model', 'insufficient-data', 'resource-limit',
]);

export const provisionalDiagnosticSchema = z.strictObject({
  jobId: idSchema,
  ...versionFields,
  controlRevision: counterSchema,
  observedThroughUs: modelTimeSchema,
  completedEvaluations: z.number().int().min(0).max(512),
  scores: z.strictObject({
    M0: z.number().nonnegative(),
    ML: z.number().nonnegative().nullable(),
    MB: z.number().nonnegative().nullable(),
    MS: z.number().nonnegative().nullable(),
  }).readonly(),
}).readonly();

export type ProvisionalDiagnostic = z.infer<typeof provisionalDiagnosticSchema>;

const hypothesisSchema = z.strictObject({
  model: z.enum(['M0', 'ML', 'MB', 'MS', 'MD']),
  score: z.number().nonnegative().nullable(),
  completed: z.boolean(),
  support: z.enum(['compatible', 'unsupported', 'unresolved']),
}).readonly();

const compatibleRegionSchema = z.strictObject({
  startM: z.number().nonnegative(),
  endM: z.number().positive(),
  status: z.enum(['compatible', 'unresolved']),
}).refine((interval) => interval.startM < interval.endM).readonly();

export const diagnosticResultSchema = z.strictObject({
  jobId: idSchema,
  ...versionFields,
  controlRevision: counterSchema,
  observedThroughUs: modelTimeSchema,
  finishedAtUs: modelTimeSchema,
  completedEvaluations: z.number().int().min(0).max(512),
  searchComplete: z.boolean(),
  stopReason: stopReasonSchema,
  hypotheses: z.array(hypothesisSchema).max(5).readonly(),
  compatibleRegions: z.array(compatibleRegionSchema).max(399).readonly(),
  fitQuality: z.enum(['good', 'poor', 'unqualified']),
  availability: dataAvailabilitySchema,
  assumptions: z.array(z.string().max(240)).max(24).readonly(),
}).refine((result) => result.finishedAtUs >= result.observedThroughUs
  && result.searchComplete === (result.stopReason === 'complete'), {
  message: 'Diagnostic completion and causal timestamp are inconsistent',
}).readonly();

const envelopeCertificateSchema = z.strictObject({
  profileHash: sha256Schema,
  modelHash: sha256Schema,
  pulseHash: sha256Schema,
  checkpointHashes: z.array(sha256Schema).min(1).max(9).readonly(),
  candidateIds: z.array(z.number().int().min(0).max(65535)).min(1).max(512).readonly(),
  controlRevision: counterSchema,
  qualifiedThroughUs: modelTimeSchema,
  issuedAtUs: modelTimeSchema,
  validUntilUs: modelTimeSchema,
  minimumPressurePa: z.number().min(251_000),
  maximumPressurePa: z.number().max(1_999_000),
  minimumRe: z.number().min(4050),
  minimumOutletFlowRatio: z.number().min(0.9001).max(1.0999),
  maximumOutletFlowRatio: z.number().min(0.9001).max(1.0999),
  numericalBudgetPa: z.number().min(0).max(500),
}).readonly();

export const experimentProposalSchema = z.strictObject({
  proposalId: idSchema,
  sourceJobId: idSchema,
  sourceSampleSeq: counterSchema,
  runId: idSchema,
  ...versionFields,
  controlRevision: counterSchema,
  issuedAtUs: modelTimeSchema,
  validUntilUs: modelTimeSchema,
  evidenceEndUs: modelTimeSchema,
  pulse: pulseSchema,
  envelopeCertificate: envelopeCertificateSchema,
}).refine((proposal) => {
  const { envelopeCertificate: cert } = proposal;
  return proposal.issuedAtUs <= proposal.validUntilUs && proposal.validUntilUs - proposal.issuedAtUs <= 1_000_000
    && proposal.evidenceEndUs <= proposal.issuedAtUs && proposal.issuedAtUs - proposal.evidenceEndUs <= 5_000_000
    && cert.controlRevision === proposal.controlRevision && cert.issuedAtUs === proposal.issuedAtUs
    && cert.validUntilUs === proposal.validUntilUs && cert.qualifiedThroughUs >= proposal.issuedAtUs + 4_000_000
    && cert.minimumPressurePa <= cert.maximumPressurePa
    && cert.minimumOutletFlowRatio <= cert.maximumOutletFlowRatio;
}, { message: 'Experiment proposal has stale or inconsistent evidence or certificate' }).readonly();

export type PublicPredictionCheckpoint = z.infer<typeof predictionCheckpointSchema>;
export type DiagnosticJob = z.infer<typeof diagnosticJobSchema>;
export type DiagnosticResult = z.infer<typeof diagnosticResultSchema>;
export type ExperimentProposal = z.infer<typeof experimentProposalSchema>;
