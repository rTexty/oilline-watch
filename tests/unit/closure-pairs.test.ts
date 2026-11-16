import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { summarizeClosurePairs } from '../../tools/calibration/closure-pairs'
import type { RunEvidence, Scenario } from '../../tools/calibration/contracts'
import { generateOpenSplit } from '../../tools/calibration/generate-scenarios'

type Pair = Parameters<typeof summarizeClosurePairs>[1][number]
type Leak = Extract<Scenario, { kind: 'leak' }>
const { split, closurePairs: { pairs } } = generateOpenSplit({
  split: 'development', saltHex: '0'.repeat(32), generatorHash: 'a'.repeat(64), profile: profileSchema.parse(rawProfile),
})
const scenarios = split.scenarios
const byId = new Map(scenarios.map((scenario) => [scenario.runId, scenario]))
const core = pairs.filter(({ qsRunId }) => {
  const scenario = byId.get(qsRunId)
  return scenario?.kind === 'leak' && scenario.sizeM2 !== 5e-6
})
const nullPairs = pairs.filter(({ kind }) => kind === 'null')

function run(runId: string, changes: Partial<RunEvidence> = {}): RunEvidence {
  return {
    runId, availableUs: 300_000_000, alarms: [], supports: [], jobs: [], outcome: 'healthy',
    activeProposals: 0, activeAccepts: 0, structuralClaim: false, ...changes,
  }
}

function arms(rows = pairs) {
  return {
    qs: rows.map(({ qsRunId }) => run(qsRunId)),
    vb10: rows.map(({ vb10RunId }) => run(vb10RunId)),
  }
}

function hit(scenario: Leak, delayUs: number, regions: RunEvidence['supports'][number]['regions'] = [
  [scenario.positionM - 5, scenario.positionM],
]): Partial<RunEvidence> {
  return { outcome: 'withdrawal-compatible', supports: [{ timeUs: scenario.onsetUs + delayUs, regions }] }
}

function coreEvidence(pair: Pair, arm: 'qs' | 'vb10'): RunEvidence {
  const runId = arm === 'qs' ? pair.qsRunId : pair.vb10RunId
  const ordinal = core.indexOf(pair)
  if (ordinal === -1) {
    return arm === 'vb10' && pair === nullPairs[0]
      ? run(runId, { supports: [{ timeUs: 60_000_000, regions: [] }] })
      : run(runId)
  }
  const scenario = byId.get(pair.qsRunId) as Leak
  if (ordinal === 1) return run(runId, { outcome: 'unavailable', availableUs: 0 })
  if (arm === 'qs' && ordinal === 0) return run(runId, hit(scenario, -1))
  if (arm === 'vb10' && ordinal === 2) return run(runId, hit(scenario, 30_000_001))
  if (arm === 'vb10' && ordinal === 3) return run(runId, { outcome: 'invalid-domain' })
  if (ordinal === 4 || (arm === 'qs' && ordinal === 3) || (arm === 'vb10' && ordinal === 5)) {
    return run(runId, hit(scenario, 0, [[scenario.positionM + 5, scenario.positionM + 10]]))
  }
  return run(runId, hit(scenario, 30_000_000))
}

function declaredPair(scenario: Extract<Scenario, { kind: 'leak' | 'null' }>): Pair {
  return {
    pairId: scenario.runId + '-closure', kind: scenario.kind, qsRunId: scenario.runId, vb10RunId: scenario.runId + '-vb10',
    sourceRecipeRunId: scenario.runId, seedHash: scenario.seedHash, parameterBlockHash: scenario.parameterBlockHash,
  }
}

describe('QS and VB10 closure-pair evidence', () => {
  it('uses the generated declaration and all 68 reserved pairs', () => {
    expect(scenarios).toHaveLength(408)
    expect(pairs.filter(({ kind }) => kind === 'leak')).toHaveLength(36)
    expect(core).toHaveLength(24)
    expect(nullPairs).toHaveLength(32)
    const { qs, vb10 } = arms()
    const summary = summarizeClosurePairs(scenarios, pairs, qs, vb10)
    expect(summary.pairs).toHaveLength(68)
    for (const arm of [summary.arms.qs, summary.arms.vb10]) {
      expect(arm.corePod30).toMatchObject({ successes: 0, trials: 24, estimate: 0 })
      expect(arm.coreCoverage).toMatchObject({ successes: 0, trials: 24, estimate: 0 })
      expect(arm.null).toMatchObject({ runs: 32, falseSupportEpisodes: 0 })
    }
    for (const statistic of ['corePod30', 'coreCoverage', 'nullFalseSupport'] as const) {
      expect(summary.discordance[statistic]).toMatchObject({
        both: 0, qsOnly: 0, vb10Only: 0, neither: statistic === 'nullFalseSupport' ? 32 : 24,
        estimate: 0, twoSided95: [0, 0],
      })
    }
  })

  it('keeps timing, localization, misses and null support in their fixed denominators', () => {
    const qs = pairs.map((pair) => coreEvidence(pair, 'qs'))
    const vb10 = pairs.map((pair) => coreEvidence(pair, 'vb10'))
    const summary = summarizeClosurePairs(scenarios, pairs, qs, vb10)

    expect(summary.arms.qs).toMatchObject({
      corePod30: { successes: 22, trials: 24, estimate: 22 / 24 },
      coreCoverage: { successes: 20, trials: 24, estimate: 20 / 24 },
      null: { runs: 32, falseSupportEpisodes: 0 },
      gates: { pod30: true, coverage: true, zeroFalseSupport: true },
    })
    expect(summary.arms.vb10).toMatchObject({
      corePod30: { successes: 21, trials: 24, estimate: 21 / 24 },
      coreCoverage: { successes: 19, trials: 24, estimate: 19 / 24 },
      null: { runs: 32, falseSupportEpisodes: 1 },
      gates: { pod30: false, coverage: false, zeroFalseSupport: false },
    })
    expect(summary.discordance.corePod30).toMatchObject({ both: 20, qsOnly: 2, vb10Only: 1, neither: 1 })
    expect(summary.discordance.coreCoverage).toMatchObject({ both: 18, qsOnly: 2, vb10Only: 1, neither: 3 })
    expect(summary.discordance.nullFalseSupport).toMatchObject({ both: 0, qsOnly: 0, vb10Only: 1, neither: 31 })
    expect(summary.discordance.corePod30.estimate).toBeCloseTo(-1 / 24, 12)
    expect(summary.discordance.coreCoverage.estimate).toBeCloseTo(-1 / 24, 12)
    expect(summary.discordance.nullFalseSupport.estimate).toBeCloseTo(1 / 32, 12)
    for (const { estimate, twoSided95 } of Object.values(summary.discordance)) {
      expect(twoSided95).toHaveLength(2)
      expect(twoSided95[0]).toBeLessThan(estimate)
      expect(twoSided95[1]).toBeGreaterThan(estimate)
    }
    expect(summarizeClosurePairs(scenarios, pairs, [...qs].reverse(), [...vb10].reverse()).discordance)
      .toEqual(summary.discordance)
  })

  it('rejects missing, extra and duplicate pairs even with matching arm evidence', () => {
    for (const altered of [pairs.slice(1), [...pairs, pairs[0]!], [pairs[1]!, ...pairs.slice(1)]]) {
      const { qs, vb10 } = arms(altered)
      expect(() => summarizeClosurePairs(scenarios, altered, qs, vb10)).toThrow()
    }
  })

  it('rejects a different repeat or leak location even with internally consistent pair metadata', () => {
    const repeatLeak = scenarios.find((row): row is Leak =>
      row.kind === 'leak' && row.centerM === 100 && row.replicate === 1)!
    const offCenterLeak = scenarios.find((row): row is Leak =>
      row.kind === 'leak' && row.centerM === 300 && row.replicate === 0)!
    const repeatNull = scenarios.find((row): row is Extract<Scenario, { kind: 'null' }> =>
      row.kind === 'null' && row.replicate === 2)!
    for (const replacement of [repeatLeak, offCenterLeak, repeatNull]) {
      const replaced = pairs.findIndex(({ kind }) => kind === replacement.kind)
      const altered = pairs.map((pair, index) => index === replaced ? declaredPair(replacement) : pair)
      const { qs, vb10 } = arms(altered)
      expect(() => summarizeClosurePairs(scenarios, altered, qs, vb10)).toThrow()
    }
  })

  it.each([
    { pairId: 'different-pair' }, { kind: 'null' as const }, { sourceRecipeRunId: pairs[1]!.qsRunId },
    { vb10RunId: 'different-companion-vb10' }, { qsRunId: 'different-qs' },
    { seedHash: 'a'.repeat(64) }, { parameterBlockHash: 'a'.repeat(64) },
  ])('rejects a mismatched pair field %j', (changes) => {
    const altered = [{ ...pairs[0]!, ...changes }, ...pairs.slice(1)]
    const { qs, vb10 } = arms(altered)
    expect(() => summarizeClosurePairs(scenarios, altered, qs, vb10)).toThrow()
  })

  it.each(['qs', 'vb10'] as const)('rejects missing, extra, duplicate and foreign %s evidence', (arm) => {
    const evidence = arms()
    const runs = evidence[arm]
    for (const altered of [runs.slice(1), [...runs, run('foreign')], [runs[1]!, ...runs.slice(1)], [run('foreign'), ...runs.slice(1)]]) {
      const qs = arm === 'qs' ? altered : evidence.qs
      const vb10 = arm === 'vb10' ? altered : evidence.vb10
      expect(() => summarizeClosurePairs(scenarios, pairs, qs, vb10)).toThrow()
    }
  })

  it('rejects swapped arm evidence and a declaration missing a reserved scenario', () => {
    const { qs, vb10 } = arms()
    expect(() => summarizeClosurePairs(scenarios, pairs, vb10, qs)).toThrow()
    expect(() => summarizeClosurePairs(scenarios.filter(({ runId }) => runId !== pairs[0]!.qsRunId), pairs, qs, vb10)).toThrow()
  })
})
