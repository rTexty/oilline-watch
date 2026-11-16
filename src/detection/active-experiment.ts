import { experimentProposalSchema } from '../contracts/inference'
import type { ExperimentProposal } from '../contracts/inference'
import type { Calibration } from '../contracts/calibration'
import { sha256Schema } from '../contracts/calibration'
import { CHALLENGE_HORIZON_US, CHALLENGE_WARMUP_US } from '../contracts/model'
import { idSchema } from '../contracts/public'
import type { SensorId } from '../contracts/public'
import { outletPulseDelta } from '../physics/outlet-pulse'

const STEP_US = 5_000
const PROPOSAL_TTL_US = 1_000_000
const MAX_EVIDENCE_AGE_US = 5_000_000
const RAMP_US = 200_000
const HOLD_US = 600_000
const RETURN_US = 200_000
const PULSE_US = RAMP_US + HOLD_US + RETURN_US
const OBSERVATION_US = 3_000_000
const REQUIRED_HORIZON_US = PULSE_US + OBSERVATION_US
const SEPARATION_MARGIN_RMS = 1
const MAX_CANDIDATES = 512
const MAX_COMMANDS = 128
const SENSORS = ['P1', 'P2', 'P3', 'Qin'] as const

type Closure = 'qs' | 'vardy-brown'
type Cause = 'ML' | 'MB' | 'MS' | 'MD'
type Pulse = ExperimentProposal['pulse']
type EnvelopeCertificate = ExperimentProposal['envelopeCertificate']

interface Candidate {
  readonly id: number
  readonly cause: Cause
  readonly checkpointHash: string
  readonly closures: readonly Closure[]
}

interface ExperimentEvidence {
  readonly jobId: string
  readonly sourceSampleSeq: number
  readonly evidenceEndUs: number
  readonly searchComplete: boolean
  readonly assessment: 'ambiguous' | 'unsupported' | 'resolved'
  readonly unresolved: boolean
  readonly sensorsAvailable: Readonly<Record<SensorId, boolean>>
  readonly candidates: readonly Candidate[]
}

interface Guards {
  readonly minimumPressurePa: number
  readonly maximumPressurePa: number
  readonly minimumRe: number
  readonly minimumOutletFlowRatio: number
  readonly maximumOutletFlowRatio: number
}

/** Extrema from the complete F64 trajectory and observation period for one cell endpoint. */
interface CellForecast {
  readonly candidateId: number
  readonly closure: Closure
  readonly boundary: 'lower' | 'upper'
  readonly checkpointHash: string
  readonly grid200: Guards
  readonly grid400: Guards
  readonly maxPressureDifferencePa: number
}

/**
 * Produced by the qualified forecast evaluator, using public checkpoints only.
 * Each cell forecast covers every grid-aligned start between firstStartUs and lastStartUs.
 */
interface ForecastEvidence {
  readonly runId: string
  readonly profileHash: string
  readonly modelHash: string
  readonly policyHash: string
  readonly pulseHash: string
  readonly sourceJobId: string
  readonly sourceSampleSeq: number
  readonly controlRevision: number
  readonly issuedAtUs: number
  readonly validUntilUs: number
  readonly firstStartUs: number
  readonly lastStartUs: number
  readonly qualifiedThroughUs: number
  readonly empiricalQualification: boolean
  readonly supportedControls: boolean
  readonly nominalOutletFlowM3s: number
  readonly baseOutletFlowM3s: number
  readonly passiveSeparationRms: number
  readonly activeSeparationRms: number
  readonly cells: readonly CellForecast[]
}

export interface ExperimentContext {
  readonly calibration: Calibration | null
  readonly runId: string
  readonly profileId: Calibration['profileId']
  readonly sensorProfileId: Calibration['sensorProfileId']
  readonly modelVersion: Calibration['modelVersion']
  readonly bankVersion: Calibration['bankVersion']
  readonly timeUs: number
  readonly horizonUs: number
  readonly controlRevision: number
  readonly phase: 'running' | 'paused' | 'closed'
  readonly inPhysicalDomain: boolean
  readonly pendingDisturbance: boolean
  readonly nominalOutletFlowM3s: number
  readonly outletFlowM3s: number
  /** Digest of the configured pulse and hydraulic profile, recomputed by the caller. */
  readonly pulseHash: string
  readonly evidence: ExperimentEvidence | null
  readonly forecast: ForecastEvidence | null
}

type Rejection = 'active-disabled' | 'experiment-used' | 'experiment-busy' | 'invalid-command'
  | 'invalid-state' | 'insufficient-evidence' | 'unverified-envelope' | 'insufficient-separation'
  | 'stale-proposal' | 'insufficient-horizon' | 'command-cap'

interface ExperimentCommand {
  readonly commandId: string
  readonly proposalId: string
  readonly expectedControlRevision: number
}

interface ExperimentAck {
  readonly commandId: string
  readonly status: 'accepted' | 'rejected'
  readonly reasonCode: 'ok' | Rejection
  readonly appliedTimeUs: number | null
  readonly controlRevision: number
}

interface ExperimentAttempt {
  readonly status: 'reserved' | 'completed' | 'aborted'
  readonly proposalId: string
  readonly commandId: string
  readonly appliedTimeUs: number
  readonly pulseEndUs: number
  readonly postActionThroughUs: number
  readonly controlRevision: number
  readonly pulse: Pulse
  readonly baseOutletFlowM3s: number
  readonly stoppedAtUs: number | null
}

export interface ExperimentState {
  readonly runId: string | null
  readonly attempt: ExperimentAttempt | null
  readonly acks: ReadonlyMap<string, ExperimentAck>
}

type ProposalDecision =
  | { readonly ok: true; readonly proposal: ExperimentProposal }
  | { readonly ok: false; readonly reason: Rejection }

interface Acceptance {
  readonly state: ExperimentState
  readonly ack: ExperimentAck
}

export function initialExperimentState(): ExperimentState {
  return { runId: null, attempt: null, acks: new Map() }
}

function safeTime(timeUs: number): boolean {
  return Number.isSafeInteger(timeUs) && timeUs >= 0
}

function nextStartUs(timeUs: number): number {
  return (Math.floor(timeUs / STEP_US) + 1) * STEP_US
}

export function experimentScopeEnabled(calibration: Calibration | null): calibration is Calibration {
  return calibration !== null && calibration.releaseScope === 'full' && calibration.qualification.active
    && calibration.qualification.quantitative && calibration.errorEnvelope.qualified
    && calibration.profileId === 'synthetic-oil-turbulent-v1'
}

function compatibleCalibration(context: ExperimentContext): boolean {
  const { calibration } = context
  return experimentScopeEnabled(calibration) && calibration.profileId === context.profileId
    && calibration.sensorProfileId === context.sensorProfileId && calibration.bankVersion === context.bankVersion
    && calibration.modelVersion === context.modelVersion
}

function contextRejection(state: ExperimentState, context: ExperimentContext): Rejection | null {
  if (state.runId !== null && state.runId !== context.runId) return 'stale-proposal'
  if (!compatibleCalibration(context)) return 'active-disabled'
  if (state.attempt) return 'experiment-used'
  if (context.pendingDisturbance) return 'experiment-busy'
  const { timeUs, horizonUs, controlRevision, nominalOutletFlowM3s, outletFlowM3s } = context
  const flowRatio = outletFlowM3s / nominalOutletFlowM3s
  if (context.phase !== 'running' || !context.inPhysicalDomain || !safeTime(timeUs) || !safeTime(horizonUs)
    || !safeTime(controlRevision) || controlRevision === Number.MAX_SAFE_INTEGER || timeUs < CHALLENGE_WARMUP_US
    || horizonUs > CHALLENGE_HORIZON_US || !Number.isFinite(nominalOutletFlowM3s) || nominalOutletFlowM3s <= 0
    || !Number.isFinite(flowRatio) || flowRatio < 0.9001 || flowRatio + 0.01 > 1.0999) return 'invalid-state'
  return nextStartUs(timeUs) + REQUIRED_HORIZON_US > horizonUs ? 'insufficient-horizon' : null
}

function adequateEvidence(evidence: ExperimentEvidence | null, timeUs: number): evidence is ExperimentEvidence {
  if (!evidence || !evidence.searchComplete || evidence.unresolved || evidence.assessment !== 'ambiguous'
    || !safeTime(evidence.evidenceEndUs) || !safeTime(evidence.sourceSampleSeq)
    || evidence.evidenceEndUs > timeUs || timeUs - evidence.evidenceEndUs > MAX_EVIDENCE_AGE_US
    || !SENSORS.every((sensor) => evidence.sensorsAvailable[sensor] === true)
    || evidence.candidates.length > MAX_CANDIDATES) return false
  const classes = new Set(evidence.candidates.map(({ cause }) => cause === 'MD' ? 'ML' : cause))
  return classes.size >= 2 && evidence.candidates.some(({ cause }) => cause === 'ML' || cause === 'MB' || cause === 'MS')
}

function guardRangesValid(guards: Guards): boolean {
  const { minimumPressurePa, maximumPressurePa, minimumRe, minimumOutletFlowRatio, maximumOutletFlowRatio } = guards
  return Number.isFinite(minimumPressurePa) && minimumPressurePa >= 251_000
    && Number.isFinite(maximumPressurePa) && maximumPressurePa <= 1_999_000
    && minimumPressurePa <= maximumPressurePa && Number.isFinite(minimumRe) && minimumRe >= 4050
    && Number.isFinite(minimumOutletFlowRatio) && minimumOutletFlowRatio >= 0.9001
    && Number.isFinite(maximumOutletFlowRatio) && maximumOutletFlowRatio <= 1.0999
    && minimumOutletFlowRatio <= maximumOutletFlowRatio
}

function cellKey(id: number, closure: Closure, boundary: CellForecast['boundary']): string {
  return `${id}:${closure}:${boundary}`
}

function expectedCells(candidates: readonly Candidate[]): ReadonlyMap<string, string> | null {
  const cells = new Map<string, string>()
  const ids = new Set<number>()
  for (const { id, checkpointHash, closures } of candidates) {
    if (!safeTime(id) || id > 65_535 || ids.has(id) || !sha256Schema.safeParse(checkpointHash).success
      || closures.length === 0 || closures.length > 2 || new Set(closures).size !== closures.length) return null
    ids.add(id)
    for (const closure of closures) {
      if (closure !== 'qs' && closure !== 'vardy-brown') return null
      cells.set(cellKey(id, closure, 'lower'), checkpointHash)
      cells.set(cellKey(id, closure, 'upper'), checkpointHash)
    }
  }
  return cells
}

function qualifiedCells(proof: ForecastEvidence, evidence: ExperimentEvidence): boolean {
  const expected = expectedCells(evidence.candidates)
  if (!expected || expected.size !== proof.cells.length) return false
  const seen = new Set<string>()
  for (const cell of proof.cells) {
    const key = cellKey(cell.candidateId, cell.closure, cell.boundary)
    if (seen.has(key) || expected.get(key) !== cell.checkpointHash
      || !guardRangesValid(cell.grid200) || !guardRangesValid(cell.grid400)
      || !Number.isFinite(cell.maxPressureDifferencePa) || cell.maxPressureDifferencePa < 0
      || cell.maxPressureDifferencePa > 500) return false
    seen.add(key)
  }
  return true
}

function validProofTime(proof: ForecastEvidence, context: ExperimentContext): boolean {
  const { issuedAtUs, validUntilUs, firstStartUs, lastStartUs, qualifiedThroughUs } = proof
  const startUs = nextStartUs(context.timeUs)
  return [issuedAtUs, validUntilUs, firstStartUs, lastStartUs, qualifiedThroughUs].every(safeTime)
    && issuedAtUs <= context.timeUs && context.timeUs <= validUntilUs && validUntilUs - issuedAtUs <= PROPOSAL_TTL_US
    && firstStartUs >= nextStartUs(issuedAtUs) && firstStartUs % STEP_US === 0 && lastStartUs % STEP_US === 0
    && firstStartUs <= startUs && startUs <= lastStartUs && lastStartUs <= validUntilUs
    && qualifiedThroughUs >= lastStartUs + REQUIRED_HORIZON_US && qualifiedThroughUs <= context.horizonUs
}

function validProofIdentity(proof: ForecastEvidence, context: ExperimentContext, evidence: ExperimentEvidence): boolean {
  const hashes = context.calibration?.hashes
  return proof.empiricalQualification && proof.supportedControls && proof.runId === context.runId && hashes !== undefined
    && proof.modelHash === hashes.model && proof.profileHash === hashes.profile && proof.policyHash === hashes.policy
    && proof.pulseHash === context.pulseHash && proof.controlRevision === context.controlRevision
    && proof.sourceJobId === evidence.jobId && proof.sourceSampleSeq === evidence.sourceSampleSeq
    && proof.baseOutletFlowM3s === context.outletFlowM3s && proof.nominalOutletFlowM3s === context.nominalOutletFlowM3s
}

function createCertificate(proof: ForecastEvidence, evidence: ExperimentEvidence): EnvelopeCertificate {
  const guards = proof.cells.flatMap(({ grid200, grid400 }) => [grid200, grid400])
  const checkpointHashes = [...new Set(evidence.candidates.map(({ checkpointHash }) => checkpointHash))].sort()
  const candidateIds = evidence.candidates.map(({ id }) => id).sort((a, b) => a - b)
  return {
    modelHash: proof.modelHash, profileHash: proof.profileHash, pulseHash: proof.pulseHash,
    checkpointHashes, candidateIds, controlRevision: proof.controlRevision, qualifiedThroughUs: proof.qualifiedThroughUs,
    issuedAtUs: proof.issuedAtUs, validUntilUs: proof.validUntilUs,
    minimumPressurePa: Math.min(...guards.map((guard) => guard.minimumPressurePa)),
    maximumPressurePa: Math.max(...guards.map((guard) => guard.maximumPressurePa)),
    minimumRe: Math.min(...guards.map((guard) => guard.minimumRe)),
    minimumOutletFlowRatio: Math.min(...guards.map((guard) => guard.minimumOutletFlowRatio)),
    maximumOutletFlowRatio: Math.max(...guards.map((guard) => guard.maximumOutletFlowRatio)),
    numericalBudgetPa: Math.max(...proof.cells.map((cell) => cell.maxPressureDifferencePa)),
  }
}

function expectedProposal(context: ExperimentContext, proposalId: string): ProposalDecision {
  const { evidence, forecast, timeUs, calibration } = context
  if (!calibration || !adequateEvidence(evidence, timeUs)) return { ok: false, reason: 'insufficient-evidence' }
  if (!forecast || !validProofIdentity(forecast, context, evidence) || !validProofTime(forecast, context)
    || !qualifiedCells(forecast, evidence)) return { ok: false, reason: 'unverified-envelope' }
  if (!Number.isFinite(forecast.activeSeparationRms) || !Number.isFinite(forecast.passiveSeparationRms)
    || forecast.passiveSeparationRms < 0 || forecast.activeSeparationRms - forecast.passiveSeparationRms < SEPARATION_MARGIN_RMS) {
    return { ok: false, reason: 'insufficient-separation' }
  }
  const checked = experimentProposalSchema.safeParse({
    proposalId, sourceJobId: evidence.jobId, sourceSampleSeq: evidence.sourceSampleSeq, runId: context.runId,
    modelVersion: context.modelVersion, profileId: context.profileId, bankVersion: context.bankVersion,
    calibrationId: calibration.calibrationId, controlRevision: context.controlRevision,
    issuedAtUs: forecast.issuedAtUs, validUntilUs: forecast.validUntilUs, evidenceEndUs: evidence.evidenceEndUs,
    pulse: { deltaOutletFlowM3s: 0.01 * context.nominalOutletFlowM3s, rampUs: RAMP_US, holdUs: HOLD_US, returnUs: RETURN_US },
    envelopeCertificate: createCertificate(forecast, evidence),
  })
  return checked.success ? { ok: true, proposal: checked.data } : { ok: false, reason: 'unverified-envelope' }
}

export function proposeExperiment(state: ExperimentState, context: ExperimentContext, proposalId: string): ProposalDecision {
  const rejection = contextRejection(state, context)
  if (rejection) return { ok: false, reason: rejection }
  if (!idSchema.safeParse(proposalId).success) return { ok: false, reason: 'invalid-command' }
  return expectedProposal(context, proposalId)
}

function matchesEvidence(proposal: ExperimentProposal, context: ExperimentContext, command: ExperimentCommand): boolean {
  return proposal.proposalId === command.proposalId && proposal.runId === context.runId
    && proposal.modelVersion === context.modelVersion && proposal.profileId === context.profileId
    && proposal.bankVersion === context.bankVersion && proposal.calibrationId === context.calibration?.calibrationId
    && proposal.controlRevision === context.controlRevision && command.expectedControlRevision === context.controlRevision
    && proposal.sourceJobId === context.evidence?.jobId && proposal.sourceSampleSeq === context.evidence.sourceSampleSeq
    && proposal.evidenceEndUs === context.evidence.evidenceEndUs
    && proposal.issuedAtUs <= context.timeUs && context.timeUs <= proposal.validUntilUs
    && context.timeUs - proposal.evidenceEndUs <= MAX_EVIDENCE_AGE_US
}

function rejectedAck(context: ExperimentContext, command: ExperimentCommand, reasonCode: Rejection): ExperimentAck {
  return { commandId: command.commandId, status: 'rejected', appliedTimeUs: null, reasonCode, controlRevision: context.controlRevision }
}

function rememberAck(state: ExperimentState, runId: string, ack: ExperimentAck): Acceptance {
  return { state: { ...state, runId, acks: new Map([...state.acks, [ack.commandId, ack]]) }, ack }
}

function reserve(state: ExperimentState, context: ExperimentContext, command: ExperimentCommand, proposal: ExperimentProposal): Acceptance {
  const appliedTimeUs = nextStartUs(context.timeUs)
  const controlRevision = context.controlRevision + 1
  const attempt: ExperimentAttempt = {
    status: 'reserved', proposalId: proposal.proposalId, commandId: command.commandId, appliedTimeUs,
    pulseEndUs: appliedTimeUs + PULSE_US, postActionThroughUs: appliedTimeUs + REQUIRED_HORIZON_US, controlRevision,
    pulse: proposal.pulse, baseOutletFlowM3s: context.outletFlowM3s, stoppedAtUs: null,
  }
  return rememberAck({ ...state, attempt }, context.runId, {
    commandId: command.commandId, status: 'accepted', appliedTimeUs, controlRevision, reasonCode: 'ok',
  })
}

export function acceptExperiment(
  state: ExperimentState,
  context: ExperimentContext,
  command: ExperimentCommand,
  proposal: unknown,
): Acceptance {
  if (![context.runId, command.commandId, command.proposalId].every((id) => idSchema.safeParse(id).success)) {
    return { state, ack: rejectedAck(context, command, 'invalid-command') }
  }
  if (state.runId !== null && state.runId !== context.runId) {
    return { state, ack: rejectedAck(context, command, 'stale-proposal') }
  }
  const priorAck = state.acks.get(command.commandId)
  if (priorAck) return { state, ack: priorAck }
  if (state.acks.size >= MAX_COMMANDS) return { state, ack: rejectedAck(context, command, 'command-cap') }
  const reject = (reason: Rejection) => rememberAck(state, context.runId, rejectedAck(context, command, reason))
  const rejection = contextRejection(state, context)
  if (rejection) return reject(rejection)
  const parsed = experimentProposalSchema.safeParse(proposal)
  if (!parsed.success || !matchesEvidence(parsed.data, context, command)) return reject('stale-proposal')
  const expected = expectedProposal(context, command.proposalId)
  if (!expected.ok) return reject(expected.reason)
  // Both values have the same strict schema and canonical key order after parsing.
  if (JSON.stringify(parsed.data) !== JSON.stringify(expected.proposal)) return reject('unverified-envelope')
  return reserve(state, context, command, parsed.data)
}

export function experimentBusy(state: ExperimentState, timeUs: number): boolean {
  return state.attempt?.status === 'reserved' && timeUs < state.attempt.pulseEndUs
}

export function outletFlowAt(state: ExperimentState, timeUs: number, ordinaryOutletFlowM3s: number): number {
  const { attempt } = state
  if (!attempt || timeUs < attempt.appliedTimeUs || attempt.status === 'completed') return ordinaryOutletFlowM3s
  const appliedUs = Math.min(timeUs, attempt.stoppedAtUs ?? timeUs)
  if (appliedUs >= attempt.pulseEndUs) return ordinaryOutletFlowM3s
  return attempt.baseOutletFlowM3s + outletPulseDelta({ startUs: attempt.appliedTimeUs, pulse: attempt.pulse }, appliedUs)
}

export function finishExperiment(state: ExperimentState, timeUs: number, domainValid: boolean): ExperimentState {
  const { attempt } = state
  if (attempt?.status !== 'reserved' || !safeTime(timeUs) || (domainValid && timeUs < attempt.postActionThroughUs)) return state
  return {
    ...state,
    attempt: { ...attempt, status: domainValid ? 'completed' : 'aborted', stoppedAtUs: timeUs },
  }
}
