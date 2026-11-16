import { describe, expect, it } from 'vitest'
import {
  commandAckSchema, inferenceInitSchema, inferenceRequestSchema, inferenceResponseSchema,
  runStatusSchema, simulationCommandSchema, simulationMessageSchema,
} from '../../src/contracts/protocol'
import { diagnosticJobSchema } from '../../src/contracts/inference'
import { profileSchema } from '../../src/contracts/model'
import { initialize } from '../../src/physics/initialize'
import { bankProfiles } from '../../src/twin/predict'
import { createCheckpointAnchor, makeCheckpoint } from '../../src/twin/checkpoint'
import type { AnchorId } from '../../src/contracts/model'
import raw from '../../src/scenarios/synthetic-oil-turbulent-v1.json'

const runId = '230dc176-69f8-47df-96b4-1a3d75d7c43e'
const envelope = (kind: string, payload: unknown) => ({ schemaVersion: 1, transportSeq: 0, runId, kind, payload })

describe('versioned application wire contracts', () => {
  it('rejects private fields, unknown versions and invalid command metadata', () => {
    const init = envelope('init', { profile: raw, calibration: null })
    expect(simulationCommandSchema.safeParse(init).success).toBe(true)
    expect(simulationCommandSchema.safeParse({ ...init, schemaVersion: 2 }).success).toBe(false)
    expect(simulationCommandSchema.safeParse({ ...init, transportSeq: -1 }).success).toBe(false)
    expect(inferenceInitSchema.safeParse(envelope('init-public', { profile: raw, calibration: null, hiddenSeed: 42 })).success).toBe(false)
    expect(inferenceRequestSchema.safeParse(envelope('close', {})).success).toBe(true)
    expect(inferenceRequestSchema.safeParse(envelope('close', { positionM: 300 })).success).toBe(false)
    expect(inferenceResponseSchema.safeParse(envelope('diagnostic-progress', { jobId: runId, completedEvaluations: 513 })).success).toBe(false)
  })

  it('verifies arming time, command rejection and reveal gating', () => {
    const status = {
      phase: 'running', mode: 'turbulent', timeUs: 30_001_000, armedAtUs: 30_000_000,
      challengeElapsedUs: 1000, pacing: 1, lagMs: 0, dataAvailability: 'available',
    }
    expect(runStatusSchema.safeParse(status).success).toBe(true)
    expect(runStatusSchema.safeParse({ ...status, armedAtUs: null }).success).toBe(false)
    expect(runStatusSchema.safeParse({ ...status, challengeElapsedUs: 0 }).success).toBe(false)
    const ack = { commandId: runId, status: 'rejected', reasonCode: 'stale', controlRevision: 0 }
    expect(commandAckSchema.safeParse({ ...ack, appliedTimeUs: null }).success).toBe(true)
    expect(commandAckSchema.safeParse({ ...ack, appliedTimeUs: 30_005_000 }).success).toBe(false)
    const revealedLeak = { positionM: 500, cdAreaM2: 1e-5, openingUs: 0, appliedTimeUs: 30_005_000 }
    expect(simulationMessageSchema.safeParse(envelope('report', { timeUs: 31_000_000, reveal: false, revealedLeak })).success).toBe(false)
    expect(simulationMessageSchema.safeParse(envelope('report', { timeUs: 31_000_000, reveal: true, revealedLeak })).success).toBe(true)
  })

  it('accepts cell-centered temperatures next to nodal pressure', () => {
    const frame = {
      timeUs: 0, frameSeq: 0, pressurePa: new Float64Array(201).fill(1.2e6),
      oilTemperatureK: new Float64Array(200).fill(313.15), wallTemperatureK: new Float64Array(200).fill(313.15),
    }
    expect(simulationMessageSchema.safeParse(envelope('field-frame', frame)).success).toBe(true)
    expect(simulationMessageSchema.safeParse(envelope('field-frame', {
      ...frame, wallTemperatureK: new Float64Array(199),
    })).success).toBe(false)
  })

  it('checks checkpoint identities, clocks and limits against a real nominal bank', async () => {
    const profile = profileSchema.parse(raw)
    const checkpointsByAnchor = await Promise.all(bankProfiles(profile).map(async (definition, index) => {
      const state = initialize(definition)
      if (!state.ok) throw state.error
      return makeCheckpoint(state.value, await createCheckpointAnchor(index as AnchorId, definition))
    }))
    const job = {
      jobId: runId, modelVersion: '1', profileId: profile.profileId, calibrationId: 'a'.repeat(64), bankVersion: '1',
      controlRevision: 0, requestedAtUs: 7_000_000, windowStartUs: 3_000_000, windowEndUs: 7_000_000,
      deliveredThroughUs: 7_000_000, checkpointsByAnchor,
      frozenBaselines: checkpointsByAnchor.map(({ anchorId }) => ({ anchorId, meanResidualSI: { P1: 0, P2: 0, P3: 0, Qin: 0 } })),
      observations: [{ sensorId: 'P1', sampleSeq: 1, sampleTimeUs: 7_000_000, deliveredTimeUs: 7_000_000, valueSI: 1.2e6, quality: 'valid' }],
      appliedControls: [], searchBudget: { quantumEvaluations: 64, evaluationLimit: 512, wallLimitMs: 5000 },
    }
    expect(diagnosticJobSchema.safeParse(job).success).toBe(true)
    expect(diagnosticJobSchema.safeParse({ ...job, checkpointsByAnchor: checkpointsByAnchor.toReversed() }).success).toBe(false)
    expect(diagnosticJobSchema.safeParse({ ...job, deliveredThroughUs: 6_990_000 }).success).toBe(false)
    expect(diagnosticJobSchema.safeParse({ ...job, searchBudget: { ...job.searchBudget, quantumEvaluations: 65 } }).success).toBe(false)
  })
})
