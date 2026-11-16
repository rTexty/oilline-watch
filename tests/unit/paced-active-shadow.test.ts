import { describe, expect, it } from 'vitest'
import type { DiagnosticResult } from '../../src/contracts/inference'
import { FLOW_PERIOD_US } from '../../src/contracts/public'
import { createActiveShadowTrace } from '../../tools/calibration/browser/active-shadow'

const timeUs = 80_000_000
const observedThroughUs = 79_000_000
const controlRevision = 2
const horizonUs = timeUs + 5_000 + 4_000_000
const context = {
  timeUs, horizonUs, controlRevision, sensorCohortUs: timeUs, pressureLastValidUs: [timeUs, timeUs, timeUs], lastFlowUs: timeUs,
} as const

function result(index = 0, changes: Partial<DiagnosticResult> = {}): DiagnosticResult {
  return {
    jobId: `230dc176-69f8-47df-96b4-1a3d75d7c${String(index).padStart(3, '0')}`,
    modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1', calibrationId: 'a'.repeat(64),
    observedThroughUs, finishedAtUs: timeUs, controlRevision, completedEvaluations: 20, searchComplete: true,
    stopReason: 'complete', fitQuality: 'good', availability: 'available', assumptions: [],
    hypotheses: [
      { model: 'M0', score: 100, completed: true, support: 'unsupported' },
      { model: 'ML', score: 10, completed: true, support: 'compatible' },
      { model: 'MB', score: 12, completed: true, support: 'compatible' },
      { model: 'MS', score: 100, completed: true, support: 'unsupported' },
      { model: 'MD', score: 10, completed: true, support: 'compatible' },
    ],
    compatibleRegions: [{ startM: 450, endM: 550, status: 'compatible' }],
    ...changes,
  }
}

describe('paced validation shadow for committed active evidence', () => {
  it('records an empty, unevaluated trace when nothing commits', () => {
    expect(createActiveShadowTrace().terminal()).toEqual({
      kind: 'committed-diagnosis-shadow', activeAttemptEvaluated: false, rows: [],
    })
  })

  it('preserves first committed job order and never promotes shadow evidence to an action', () => {
    const trace = createActiveShadowTrace()
    const first = result(2)
    const second = result(1)
    trace.observe(first, context)
    trace.observe(second, context)
    trace.observe(result(2, { fitQuality: 'poor' }), context)

    expect(trace.terminal()).toEqual({
      kind: 'committed-diagnosis-shadow', activeAttemptEvaluated: false,
      rows: [first, second].map(({ jobId, observedThroughUs, finishedAtUs, controlRevision }) => ({
        jobId, observedThroughUs, finishedAtUs, controlRevision, sensorCohortUs: timeUs,
        availableSensors: ['P1', 'P2', 'P3', 'Qin'], blockers: ['candidate-evidence-unavailable'],
      })),
    })
  })

  it('records incomplete and unqualified evidence without treating it as a refusal', () => {
    const trace = createActiveShadowTrace()
    trace.observe(result(0, { searchComplete: false, stopReason: 'wall-limit', fitQuality: 'unqualified' }), context)
    trace.observe(result(1, { fitQuality: 'poor' }), context)
    const terminal = trace.terminal()
    expect(terminal.activeAttemptEvaluated).toBe(false)
    expect(terminal.rows[0]!.blockers).toEqual(expect.arrayContaining(['incomplete-search', 'unqualified-fit']))
    expect(terminal.rows[0]!.blockers).not.toContain('candidate-evidence-unavailable')
    expect(terminal.rows[1]!.blockers).toEqual(['model-fit-poor'])
  })

  it('distinguishes unresolved cells and unresolved hypotheses from unavailable candidate endpoints', () => {
    const trace = createActiveShadowTrace()
    trace.observe(result(0, {
      compatibleRegions: [{ startM: 450, endM: 550, status: 'unresolved' }],
    }), context)
    trace.observe(result(1, {
      hypotheses: result().hypotheses.map((item) => item.model === 'MS'
        ? { ...item, score: null, completed: false, support: 'unresolved' }
        : item),
    }), context)

    expect(trace.terminal().rows.map(({ blockers }) => blockers)).toEqual([['unresolved-region'], ['unresolved-hypothesis']])
  })

  it('requires two plausible causes after collapsing ML and MD and excluding M0', () => {
    const trace = createActiveShadowTrace()
    trace.observe(result(0, {
      hypotheses: result().hypotheses.map((item) => ({
        ...item, support: item.model === 'ML' || item.model === 'MD' || item.model === 'M0' ? 'compatible' : 'unsupported',
      })),
    }), context)
    expect(trace.terminal().rows[0]!.blockers).toEqual(['no-causal-ambiguity'])
  })

  it('reports unassessable ambiguity when compatible causes are missing and alternatives are unresolved', () => {
    const trace = createActiveShadowTrace()
    trace.observe(result(0, {
      hypotheses: result().hypotheses.map((item) => item.model === 'MB'
        ? { ...item, score: null, completed: false, support: 'unresolved' }
        : item),
    }), context)
    expect(trace.terminal().rows[0]!.blockers).toEqual(['unresolved-hypothesis', 'causal-ambiguity-unassessable'])
  })

  it('accepts exactly five seconds of evidence age and records older or stale revision commits', () => {
    const trace = createActiveShadowTrace()
    trace.observe(result(0, { observedThroughUs: timeUs - 5_000_000 }), context)
    trace.observe(result(1, { observedThroughUs: timeUs - 5_000_001 }), context)
    trace.observe(result(2, { controlRevision: controlRevision - 1 }), context)

    expect(trace.terminal().rows.map(({ blockers }) => blockers)).toEqual([
      ['candidate-evidence-unavailable'], ['stale-result'], ['stale-result'],
    ])
  })

  it('requires pressure on the current tick and accepts Qin exactly two native periods old', () => {
    const trace = createActiveShadowTrace()
    trace.observe(result(0), { ...context, lastFlowUs: timeUs - 2 * FLOW_PERIOD_US })
    trace.observe(result(1), {
      ...context, pressureLastValidUs: [timeUs, timeUs - 1, null], lastFlowUs: timeUs - 2 * FLOW_PERIOD_US - 1,
    })
    trace.observe(result(2), {
      ...context, pressureLastValidUs: [timeUs, timeUs + 1, timeUs], lastFlowUs: timeUs + 1,
    })

    expect(trace.terminal().rows.map(({ blockers, availableSensors }) => ({ blockers, availableSensors }))).toEqual([
      { blockers: ['candidate-evidence-unavailable'], availableSensors: ['P1', 'P2', 'P3', 'Qin'] },
      { blockers: ['sensor-unavailable'], availableSensors: ['P1'] },
      { blockers: ['sensor-unavailable'], availableSensors: ['P1', 'P3'] },
    ])
  })

  it('uses the finalized sensor cohort independently of the current engine clock', () => {
    const trace = createActiveShadowTrace()
    const sensorCohortUs = timeUs - 20_000
    trace.observe(result(), {
      ...context, sensorCohortUs, pressureLastValidUs: [sensorCohortUs, sensorCohortUs, sensorCohortUs],
      lastFlowUs: sensorCohortUs - 2 * FLOW_PERIOD_US,
    })
    expect(trace.terminal().rows[0]).toMatchObject({
      sensorCohortUs, finishedAtUs: timeUs, availableSensors: ['P1', 'P2', 'P3', 'Qin'],
      blockers: ['candidate-evidence-unavailable'],
    })
  })

  it('requires four seconds after the next command tick and combines independent blockers', () => {
    const trace = createActiveShadowTrace()
    trace.observe(result(0), { ...context, horizonUs: horizonUs - 1 })
    trace.observe(result(1, { fitQuality: 'poor', controlRevision: 0 }), {
      ...context, horizonUs: horizonUs - 1, lastFlowUs: null,
    })
    const rows = trace.terminal().rows
    expect(rows[0]!.blockers).toEqual(['insufficient-horizon'])
    expect(rows[1]!.blockers).toHaveLength(4)
    expect(rows[1]!.blockers).toEqual(expect.arrayContaining([
      'stale-result', 'sensor-unavailable', 'insufficient-horizon', 'model-fit-poor',
    ]))
  })
})
