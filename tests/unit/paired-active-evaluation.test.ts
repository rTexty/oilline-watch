import { describe, expect, it } from 'vitest'
import { scenarioCell } from '../../tools/calibration/contracts'
import type { RunEvidence, Scenario } from '../../tools/calibration/contracts'
import { summarizeActivePairs } from '../../tools/calibration/paired-active'

type Action = Parameters<typeof summarizeActivePairs>[3][number]
type Leak = Extract<Scenario, { kind: 'leak' }>
const onsetUs = 60_000_000
const actionStartUs = 70_000_000

function scenarioBase(runId: string) {
  return {
    runId, sensor: 'nominal' as const, seedHash: runId.padEnd(64, '0'), parameterBlockHash: runId.padEnd(64, 'a'),
    replicate: 0 as const,
  }
}

function leak(runId: string, centerM: Leak['centerM'] = 500): Leak {
  return {
    ...scenarioBase(runId), kind: 'leak', centerM, positionM: centerM - 2.5,
    openingSeconds: 0, sizeM2: 1e-5, onsetUs,
  }
}

function discrepancy(runId: string, replicate: number): Scenario {
  return { ...scenarioBase(runId), replicate, kind: 'discrepancy', family: 'D11' }
}

function run(runId: string, changes: Partial<RunEvidence> = {}): RunEvidence {
  return {
    runId, availableUs: 300_000_000, alarms: [], supports: [], jobs: [], outcome: 'healthy',
    activeProposals: 0, activeAccepts: 0, structuralClaim: false, ...changes,
  }
}

function support(timeUs: number, regions: RunEvidence['supports'][number]['regions'] = []) {
  return { timeUs, regions }
}

const noOpportunity = (runId: string): Action => ({ runId, status: 'no-opportunity' })
const unaccepted = (runId: string): Action => ({ runId, status: 'unaccepted' })
const refused = (runId: string, reason: string): Action => ({ runId, status: 'refused', reason })
const completed = (runId: string): Action => ({
  runId, status: 'completed', appliedTimeUs: actionStartUs, terminalTimeUs: actionStartUs + 4_000_000,
})
const accepted = { activeProposals: 1, activeAccepts: 1 }

describe('paired active/passive evaluation', () => {
  it('counts directional support and coverage changes against matching run IDs', () => {
    const scenarios = [leak('a', 100), leak('b', 300), leak('c', 500), leak('d', 700), leak('e', 900)]
    const active = [
      run('a', { ...accepted, outcome: 'withdrawal-compatible', supports: [support(onsetUs + 30_000_000, [[90, 97.5]])] }),
      run('b', { activeProposals: 2, supports: [support(onsetUs)] }),
      run('c', { activeProposals: 1, supports: [support(onsetUs - 1, [[480, 510]]), support(onsetUs + 30_000_001, [[480, 510]])] }),
      run('d', { outcome: 'unavailable', availableUs: 0 }),
      run('e', { ...accepted, supports: [support(onsetUs + 1, [[897.5, 900]])] }),
    ]
    const passive = [
      run('e', { supports: [support(onsetUs + 2, [[895, 900]])] }),
      run('c', { supports: [support(onsetUs, [[510, 520]]), support(onsetUs + 1, [[480, 510]])] }),
      run('b', { supports: [support(onsetUs, [[290, 310]])] }),
      run('a', { outcome: 'ambiguous', supports: [support(onsetUs + 30_000_001, [[90, 100]])] }),
      run('d', { outcome: 'unavailable', availableUs: 0 }),
    ]
    const actions: Action[] = [
      { runId: 'e', status: 'aborted', appliedTimeUs: actionStartUs, terminalTimeUs: actionStartUs + 3_999_999 },
      completed('a'), noOpportunity('d'), refused('b', 'stale-proposal'), unaccepted('c'),
    ]
    const result = summarizeActivePairs(scenarios, active, passive, actions)

    expect(result.pairs).toHaveLength(scenarios.length)
    expect(result.pairs).toContainEqual(expect.objectContaining({
      runId: 'a', cell: scenarioCell(scenarios[0]!),
      active: expect.objectContaining({ outcome: active[0]!.outcome, supports: active[0]!.supports, ...accepted }),
      passive: expect.objectContaining({ outcome: passive[3]!.outcome, supports: passive[3]!.supports,
        activeProposals: 0, activeAccepts: 0 }),
      action: expect.objectContaining({ status: 'completed', appliedTimeUs: actionStartUs }),
    }))
    expect(result.leak.timelySupport).toEqual({ activeOnly: 1, passiveOnly: 1, both: 2, neither: 1 })
    expect(result.leak.timelyCovered).toEqual({ activeOnly: 1, passiveOnly: 1, both: 1, neither: 2 })
    expect(result.actionCounts).toEqual({ 'no-opportunity': 1, refused: 1, unaccepted: 1, completed: 1, aborted: 1 })
    expect(result.refusalReasons).toEqual([{ reason: 'stale-proposal', runs: 1 }])
  })

  it('keeps D11 false support and structural claims separate from other discrepancy and null cases', () => {
    const scenarios: Scenario[] = [
      discrepancy('a', 0), discrepancy('b', 1), discrepancy('c', 2), discrepancy('d', 3),
      { ...scenarioBase('e'), kind: 'discrepancy', family: 'D05' },
      { ...scenarioBase('f'), kind: 'null', family: 'healthy' },
    ]
    const active = [
      run('a', { ...accepted, supports: [support(onsetUs)] }),
      run('b', { ...accepted, structuralClaim: true }),
      run('c', { activeProposals: 3, supports: [support(onsetUs)], structuralClaim: true }),
      run('d', { activeProposals: 1 }),
      run('e', { ...accepted, supports: [support(onsetUs)], structuralClaim: true }),
      run('f', { activeProposals: 4, supports: [support(onsetUs)], structuralClaim: true }),
    ]
    const passive = [
      run('a', { structuralClaim: true }),
      run('b', { supports: [support(onsetUs)] }),
      run('c', { supports: [support(onsetUs)], structuralClaim: true }),
      run('d'), run('e'), run('f'),
    ]
    const actions: Action[] = [
      completed('a'), { runId: 'b', status: 'aborted', appliedTimeUs: null, terminalTimeUs: actionStartUs },
      refused('c', 'unverified-envelope'), refused('d', 'unverified-envelope'), completed('e'), unaccepted('f'),
    ]
    const result = summarizeActivePairs(scenarios, active, passive, actions)

    expect(result.pairs).toHaveLength(6)
    expect(result.noneOfModels).toEqual({
      runs: 4, falseSupport: { activeOnly: 1, passiveOnly: 1, both: 1, neither: 1 },
      structuralClaim: { activeOnly: 1, passiveOnly: 1, both: 1, neither: 1 },
      activeProposals: 6, activeAccepts: 2,
    })
    expect(result.refusalReasons).toEqual([{ reason: 'unverified-envelope', runs: 2 }])
    expect(result.actionCounts).toMatchObject({ completed: 2, aborted: 1 })
  })

  const scenarios = [leak('a', 100), leak('b', 300)]
  const runs = [run('a'), run('b')]
  const actions = [noOpportunity('a'), noOpportunity('b')]

  it.each(['active', 'passive', 'action'] as const)('rejects missing, duplicate, and unmatched %s rows', (arm) => {
    for (const runIds of [['a'], ['a', 'a'], ['a', 'c'], ['a', 'b', 'c']]) {
      const active = arm === 'active' ? runIds.map((id) => run(id)) : runs
      const passive = arm === 'passive' ? runIds.map((id) => run(id)) : runs
      const outcomes = arm === 'action' ? runIds.map(noOpportunity) : actions
      expect(() => summarizeActivePairs(scenarios, active, passive, outcomes)).toThrow()
    }
  })

  it('rejects duplicate scenarios and any passive proposal or accept', () => {
    expect(() => summarizeActivePairs([scenarios[0]!, scenarios[0]!], runs, runs, actions)).toThrow()
    for (const changes of [{ activeProposals: 1 }, accepted]) {
      expect(() => summarizeActivePairs(scenarios, runs, [run('a', changes), runs[1]!], actions)).toThrow()
    }
  })

  it.each([
    [noOpportunity('a'), { activeProposals: 1 }],
    [unaccepted('a'), { activeProposals: 0 }],
    [unaccepted('a'), accepted],
    [refused('a', ''), { activeProposals: 1 }],
    [refused('a', 'unverified-envelope'), accepted],
    [completed('a'), { activeProposals: 1 }],
    [{ runId: 'a', status: 'aborted', appliedTimeUs: null, terminalTimeUs: actionStartUs }, { activeProposals: 1 }],
  ] as const)('rejects inconsistent action accounting for %j', (action, counts) => {
    expect(() => summarizeActivePairs(scenarios, [run('a', counts), runs[1]!], runs, [action, actions[1]!])).toThrow()
  })

  it.each([
    { status: 'completed', appliedTimeUs: null, terminalTimeUs: actionStartUs + 4_000_000 },
    { status: 'completed', appliedTimeUs: actionStartUs, terminalTimeUs: actionStartUs + 3_999_999 },
    { status: 'completed', appliedTimeUs: actionStartUs, terminalTimeUs: actionStartUs + 4_000_001 },
    { status: 'aborted', appliedTimeUs: actionStartUs, terminalTimeUs: actionStartUs - 1 },
    { status: 'aborted', appliedTimeUs: actionStartUs, terminalTimeUs: actionStartUs + 4_000_000 },
    { status: 'aborted', appliedTimeUs: 326_005_000, terminalTimeUs: 329_000_000 },
  ] as const)('rejects impossible applied/terminal times for %j', (timing) => {
    const action = { runId: 'a', ...timing } as Action
    expect(() => summarizeActivePairs(scenarios, [run('a', accepted), runs[1]!], runs, [action, actions[1]!])).toThrow()
  })
})
