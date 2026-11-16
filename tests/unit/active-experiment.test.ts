import { describe, expect, it } from 'vitest'
import { calibrationSchema } from '../../src/contracts/calibration'
import {
  acceptExperiment,
  experimentBusy,
  finishExperiment,
  initialExperimentState,
  outletFlowAt,
  proposeExperiment,
} from '../../src/detection/active-experiment'
import type { ExperimentContext } from '../../src/detection/active-experiment'

const RUN_ID = '230dc176-69f8-47df-96b4-1a3d75d7c43e'
const JOB_ID = '230dc176-69f8-47df-96b4-1a3d75d7c43f'
const PROPOSAL_ID = '230dc176-69f8-47df-96b4-1a3d75d7c440'
const COMMAND_ID = '230dc176-69f8-47df-96b4-1a3d75d7c441'
const SECOND_COMMAND = '230dc176-69f8-47df-96b4-1a3d75d7c442'
const HASH = 'a'.repeat(64)
const CHECKPOINT_HASH = 'b'.repeat(64)
const TIME = 40_000_000
const START = TIME + 5_000
const GUARDS = {
  minimumPressurePa: 300_000, maximumPressurePa: 1_100_000, minimumRe: 5000,
  minimumOutletFlowRatio: 1, maximumOutletFlowRatio: 1.01,
}
const CALIBRATION = calibrationSchema.parse({
  schemaVersion: 1, calibrationId: HASH, modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1',
  bankVersion: '1', sensorProfileId: 'synthetic-oil-nominal-v1',
  hashes: {
    model: HASH, profile: HASH, bank: HASH, sensor: HASH, policy: HASH, dictionary: HASH,
    fit: HASH, calibration: HASH, development: HASH,
  },
  releaseScope: 'full',
  noise: Object.fromEntries(['P1', 'P2', 'P3', 'Qin'].map((id) => [id, { sigmaSI: 1, rho: 0 }])),
  thresholds: { cusumFast: 3, cusumSlow: 3, improvement: 1, separation: 1, absoluteFit: 1, profile: 1, envelope: 1 },
  errorEnvelope: { numericalFloor: 1, multiplier: 1, qualified: true },
  qualification: { quantitative: true, active: true },
  reportHash: HASH,
})

function fixture(): ExperimentContext {
  return {
    calibration: CALIBRATION, runId: RUN_ID, profileId: CALIBRATION.profileId, sensorProfileId: CALIBRATION.sensorProfileId,
    modelVersion: '1', bankVersion: '1', timeUs: TIME, horizonUs: 330_000_000, controlRevision: 4,
    phase: 'running', inPhysicalDomain: true, pendingDisturbance: false,
    nominalOutletFlowM3s: 0.02, outletFlowM3s: 0.02, pulseHash: HASH,
    evidence: {
      jobId: JOB_ID, sourceSampleSeq: 1000, evidenceEndUs: TIME - 500_000,
      searchComplete: true, assessment: 'ambiguous', unresolved: false,
      sensorsAvailable: { P1: true, P2: true, P3: true, Qin: true },
      candidates: [
        { id: 4, cause: 'ML', checkpointHash: CHECKPOINT_HASH, closures: ['qs'] },
        { id: 6, cause: 'MB', checkpointHash: CHECKPOINT_HASH, closures: ['qs'] },
      ],
    },
    forecast: {
      runId: RUN_ID, profileHash: HASH, modelHash: HASH, policyHash: HASH, pulseHash: HASH, controlRevision: 4,
      sourceJobId: JOB_ID, sourceSampleSeq: 1000,
      issuedAtUs: TIME, validUntilUs: TIME + 1_000_000, firstStartUs: START, lastStartUs: START,
      qualifiedThroughUs: START + 4_000_000, empiricalQualification: true, supportedControls: true,
      nominalOutletFlowM3s: 0.02, baseOutletFlowM3s: 0.02,
      passiveSeparationRms: 0.25, activeSeparationRms: 2,
      cells: [4, 6].flatMap((candidateId) => (['lower', 'upper'] as const).map((boundary) => ({
        candidateId, boundary, checkpointHash: CHECKPOINT_HASH, closure: 'qs',
        grid200: GUARDS, grid400: GUARDS, maxPressureDifferencePa: 50,
      }))),
    },
  }
}

const command = { commandId: COMMAND_ID, proposalId: PROPOSAL_ID, expectedControlRevision: 4 }

function requireProposal(context: ExperimentContext) {
  const outcome = proposeExperiment(initialExperimentState(), context, PROPOSAL_ID)
  if (!outcome.ok) throw new Error(`Fixture proposal failed: ${outcome.reason}`)
  return outcome.proposal
}

describe('active experiment eligibility and certificate', () => {
  it('disables proposal and accept without full calibration', () => {
    const full = fixture()
    const state = initialExperimentState()
    const proposal = requireProposal(full)
    for (const context of [ { ...full, calibration: null }, {
      ...full, calibration: { ...CALIBRATION, releaseScope: 'passive' as const,
        qualification: { ...CALIBRATION.qualification, active: false } },
    }]) {
      expect(proposeExperiment(state, context, PROPOSAL_ID)).toMatchObject({ ok: false, reason: 'active-disabled' })
      const rejected = acceptExperiment(state, context, command, proposal)
      expect(rejected.ack).toMatchObject({ status: 'rejected', reasonCode: 'active-disabled', appliedTimeUs: null })
      expect(rejected.state.attempt).toBeNull()
    }
  })

  it('requires measured ambiguity across identifiable classes and all four sensors', () => {
    const context = fixture()
    const state = initialExperimentState()
    const evidence = context.evidence!
    const candidates = [evidence.candidates[0]!, { ...evidence.candidates[1]!, cause: 'MD' as const }]
    for (const change of [
      { searchComplete: false },
      { unresolved: true },
      { assessment: 'unsupported' as const },
      { sensorsAvailable: { ...evidence.sensorsAvailable, Qin: false } },
      { candidates },
    ]) {
      expect(proposeExperiment(state, { ...context, evidence: { ...evidence, ...change } }, PROPOSAL_ID))
        .toMatchObject({ ok: false, reason: 'insufficient-evidence' })
    }
  })

  it('rejects unqualified, incomplete, inconsistent and unsafe forecast cases', () => {
    const context = fixture()
    const state = initialExperimentState()
    const forecast = context.forecast!
    for (const change of [
      { empiricalQualification: false },
      { supportedControls: false },
      { runId: JOB_ID },
      { sourceSampleSeq: 999 },
      { baseOutletFlowM3s: 0.019 },
      { policyHash: CHECKPOINT_HASH },
      { cells: forecast.cells.slice(1) },
      { cells: [...forecast.cells.slice(1), forecast.cells[1]!] },
      { cells: [{ ...forecast.cells[0]!, maxPressureDifferencePa: 501 }, ...forecast.cells.slice(1)] },
      { cells: [{ ...forecast.cells[0]!, grid400: { ...GUARDS, minimumPressurePa: 249_999 } }, ...forecast.cells.slice(1)] },
      { qualifiedThroughUs: START + 3_999_999 },
    ]) {
      expect(proposeExperiment(state, { ...context, forecast: { ...forecast, ...change } }, PROPOSAL_ID))
        .toMatchObject({ ok: false, reason: 'unverified-envelope' })
    }
    expect(proposeExperiment(state, { ...context, forecast: { ...forecast, activeSeparationRms: 1.24 } }, PROPOSAL_ID))
      .toMatchObject({ ok: false, reason: 'insufficient-separation' })
  })
})

describe('active experiment transaction', () => {
  it('reserves one pulse on a shared model-time boundary, with idempotent ACK', () => {
    const context = fixture()
    const initial = initialExperimentState()
    const proposal = requireProposal(context)
    const accepted = acceptExperiment(initial, context, command, proposal)
    expect(initial.attempt).toBeNull()
    expect(accepted.ack).toMatchObject({ status: 'accepted', controlRevision: 5, appliedTimeUs: START })
    expect(accepted.state.attempt).toMatchObject({ status: 'reserved', appliedTimeUs: START, controlRevision: 5 })
    expect(acceptExperiment(accepted.state, { ...context, controlRevision: 5, timeUs: START }, command, proposal))
      .toEqual(accepted)
    expect(acceptExperiment(accepted.state, context, { ...command, commandId: SECOND_COMMAND }, proposal).ack)
      .toMatchObject({ status: 'rejected', reasonCode: 'experiment-used' })
  })

  it('rejects stale or tampered acceptance without reserving or changing revision', () => {
    const context = fixture()
    const proposal = requireProposal(context)
    const state = initialExperimentState()
    for (const change of [
      { pendingDisturbance: true },
      { timeUs: START },
      { timeUs: TIME + 1_000_001 },
      { horizonUs: START + 3_999_999 },
      { controlRevision: 5 },
      { inPhysicalDomain: false },
      { phase: 'paused' as const },
      { evidence: { ...context.evidence!, sourceSampleSeq: 1001 } },
    ]) {
      const result = acceptExperiment(state, { ...context, ...change }, command, proposal)
      expect(result.ack).toMatchObject({ status: 'rejected', appliedTimeUs: null })
      expect(result.state.attempt).toBeNull()
    }
    const tampered = {
      ...proposal, envelopeCertificate: { ...proposal.envelopeCertificate, minimumPressurePa: 400_000 },
    }
    expect(acceptExperiment(state, context, command, tampered).ack)
      .toMatchObject({ status: 'rejected', reasonCode: 'unverified-envelope' })
  })

  it('keeps rejected ACKs idempotent and never reuses them across runs', () => {
    const context = fixture()
    const proposal = requireProposal(context)
    const rejected = acceptExperiment(initialExperimentState(), { ...context, pendingDisturbance: true }, command, proposal)
    expect(acceptExperiment(rejected.state, context, command, proposal)).toEqual(rejected)
    const accepted = acceptExperiment(initialExperimentState(), context, command, proposal)
    const wrongRun = acceptExperiment(accepted.state, { ...context, runId: JOB_ID }, command, proposal)
    expect(wrongRun.state).toBe(accepted.state)
    expect(wrongRun.ack).toMatchObject({ status: 'rejected', reasonCode: 'stale-proposal' })
  })

  it('preserves the ramp, hold and return in model time and never repeats after abort', () => {
    const context = fixture()
    const accepted = acceptExperiment(initialExperimentState(), context, command, requireProposal(context)).state
    expect(experimentBusy(accepted, TIME)).toBe(true)
    expect(experimentBusy(accepted, START + 999_999)).toBe(true)
    expect(experimentBusy(accepted, START + 1_000_000)).toBe(false)
    for (const [offset, flow] of [
      [-5000, 0.02], [0, 0.02], [100_000, 0.0201], [200_000, 0.0202],
      [800_000, 0.0202], [900_000, 0.0201], [1_000_000, 0.02],
    ] as const) expect(outletFlowAt(accepted, START + offset, 0.02)).toBeCloseTo(flow, 12)
    const aborted = finishExperiment(accepted, START + 350_000, false)
    expect(aborted.attempt?.status).toBe('aborted')
    expect(outletFlowAt(aborted, START + 2_000_000, 0.02)).toBeCloseTo(0.0202, 12)
    expect(proposeExperiment(aborted, context, PROPOSAL_ID))
      .toMatchObject({ ok: false, reason: 'experiment-used' })
    const observing = finishExperiment(accepted, START + 1_000_000, true)
    expect(observing).toBe(accepted)
    expect(finishExperiment(observing, START + 2_000_000, false).attempt?.status).toBe('aborted')
    expect(finishExperiment(observing, START + 4_000_000, true).attempt?.status).toBe('completed')
  })
})
