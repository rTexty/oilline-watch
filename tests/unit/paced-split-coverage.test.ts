import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { buildPacedSplitCoverage } from '../../tools/calibration/browser/paced-split-coverage'
import type { Scenario } from '../../tools/calibration/contracts'
import { generateOpenSplit } from '../../tools/calibration/generate-scenarios'

const role = 'development'
const sensor = 'adverse'
const generated = generateOpenSplit({
  split: role, saltHex: '0'.repeat(32), generatorHash: 'a'.repeat(64), profile: profileSchema.parse(rawProfile),
})
const split = generated.split
const reserved = new Set(generated.closurePairs.pairs.map(({ qsRunId }) => qsRunId))
const adverse = split.scenarios.filter((scenario) => scenario.sensor === sensor)
type Leak = Extract<Scenario, { kind: 'leak' }>
const core = adverse.find((scenario): scenario is Leak => scenario.kind === 'leak'
  && scenario.sizeM2 !== 5e-6 && reserved.has(scenario.runId))!
const small = adverse.find((scenario): scenario is Leak => scenario.kind === 'leak'
  && scenario.sizeM2 === 5e-6 && reserved.has(scenario.runId))!
const nullRun = adverse.find((scenario) => scenario.kind === 'null')!
const standalone = adverse.find((scenario): scenario is Extract<Scenario, { kind: 'null' }> =>
  scenario.kind === 'null' && scenario.runId !== nullRun.runId
  && reserved.has(scenario.runId))!
const discrepancy = split.scenarios.find((scenario) => scenario.kind === 'discrepancy')!
const build = { browserVersion: '158.0.0', adapterSha256: 'b'.repeat(64), assetsSha256: 'c'.repeat(64) }

type Status = 'acquired' | 'missing-report' | 'invalid-report'
type Closure = 'qs' | 'vb10'

function row(sourceRunId: string, closure: Closure, status: Status, fullHorizon = false) {
  return {
    sourceRunId, runId: closure === 'qs' ? sourceRunId : `${sourceRunId}-vb10`, closure, status,
    reportSha256: status === 'missing-report' ? null : 'd'.repeat(64), fullHorizon,
    ...(status === 'acquired' ? { build } : {}),
  }
}

const coreQs = row(core.runId, 'qs', 'acquired', true)
const coreVb10 = row(core.runId, 'vb10', 'acquired', true)
const smallQs = row(small.runId, 'qs', 'missing-report')
const smallVb10 = row(small.runId, 'vb10', 'invalid-report')
const nullQs = row(nullRun.runId, 'qs', 'acquired')
const discrepancyQs = row(discrepancy.runId, 'qs', 'invalid-report')
const standaloneVb10 = row(standalone.runId, 'vb10', 'acquired')

function withoutSource({ runId, closure, status, reportSha256, fullHorizon, build }: ReturnType<typeof row>) {
  return { runId, closure, status, reportSha256, fullHorizon, ...(build ? { build } : {}) }
}

describe('paced evidence split coverage', () => {
  it('keeps each declared source in layout order and distinguishes unlisted, missing and partial acquisitions', () => {
    const coverage = buildPacedSplitCoverage(split, role, sensor, [
      standaloneVb10, smallVb10, coreVb10, nullQs, smallQs, coreQs,
    ])
    expect(coverage).toMatchObject({
      declaredScenarios: 180, coreLeaks: 40,
      qs: { listed: 3, acquired: 2, fullHorizons: 1, unlisted: 177 },
      vb10: { listed: 3, acquired: 2, fullHorizons: 1 },
    })
    expect(coverage.rows.map(({ sourceRunId }) => sourceRunId)).toEqual(adverse.map(({ runId }) => runId))
    const byId = new Map(coverage.rows.map((entry) => [entry.sourceRunId, entry]))
    expect(byId.get(core.runId)).toEqual({
      sourceRunId: core.runId, truth: { kind: 'leak', core: true, onsetUs: core.onsetUs,
        positionM: core.positionM, sizeM2: core.sizeM2, openingSeconds: core.openingSeconds },
      qs: withoutSource(coreQs), vb10: withoutSource(coreVb10),
    })
    expect(byId.get(small.runId)).toEqual({
      sourceRunId: small.runId, truth: { kind: 'leak', core: false, onsetUs: small.onsetUs,
        positionM: small.positionM, sizeM2: small.sizeM2, openingSeconds: small.openingSeconds },
      qs: withoutSource(smallQs), vb10: withoutSource(smallVb10),
    })
    expect(byId.get(nullRun.runId)).toEqual({
      sourceRunId: nullRun.runId, truth: { kind: 'null', family: nullRun.family }, qs: withoutSource(nullQs), vb10: null,
    })
    expect(byId.get(standalone.runId)).toEqual({
      sourceRunId: standalone.runId, truth: { kind: 'null', family: standalone.family },
      qs: null, vb10: withoutSource(standaloneVb10),
    })
    const unlisted = adverse.find(({ runId }) => ![core, small, nullRun, standalone].some((run) => run.runId === runId))!
    expect(byId.get(unlisted.runId)).toMatchObject({ qs: null, vb10: null })
  })

  it('projects nominal discrepancy family without reporting an invalid acquisition as unlisted', () => {
    const coverage = buildPacedSplitCoverage(split, role, 'nominal', [discrepancyQs])
    expect(coverage.qs).toEqual({ listed: 1, acquired: 0, fullHorizons: 0, unlisted: 227 })
    expect(coverage.rows.find(({ sourceRunId }) => sourceRunId === discrepancy.runId)).toEqual({
      sourceRunId: discrepancy.runId, truth: { kind: 'discrepancy', family: discrepancy.family },
      qs: withoutSource(discrepancyQs), vb10: null,
    })
  })

  it('retains the declared nominal denominator when the matrix lists no reports', () => {
    const coverage = buildPacedSplitCoverage(split, role, 'nominal', [])
    expect(coverage).toMatchObject({
      declaredScenarios: 228, coreLeaks: 40,
      qs: { listed: 0, acquired: 0, fullHorizons: 0, unlisted: 228 }, vb10: { listed: 0, acquired: 0, fullHorizons: 0 },
    })
    expect(coverage.rows).toHaveLength(228)
    expect(coverage.rows.every(({ qs, vb10 }) => qs === null && vb10 === null)).toBe(true)
  })

  it('rejects a mismatched declared split role', () => {
    expect(() => buildPacedSplitCoverage(split, 'fit', sensor, [coreQs])).toThrow()
  })

  it('rejects a VB10 suffix for a declared adverse source outside the closure-pair reservation', () => {
    const unreserved = adverse.find(({ kind, runId }) => kind === 'leak' && !reserved.has(runId))!
    const qs = row(unreserved.runId, 'qs', 'missing-report')
    expect(buildPacedSplitCoverage(split, role, sensor, [qs]).qs.listed).toBe(1)
    expect(() => buildPacedSplitCoverage(split, role, sensor, [qs, row(unreserved.runId, 'vb10', 'missing-report')]))
      .toThrow(/reserv|lineage|closure pair|eligible/i)
  })

  it.each([
    ['foreign source', [row('development-leak-999', 'qs', 'missing-report')]],
    ['VB10 with undeclared lineage', [row('development-leak-999', 'vb10', 'missing-report')]],
    ['wrong layout', [row(split.scenarios.find(({ sensor }) => sensor === 'nominal')!.runId, 'qs', 'missing-report')]],
    ['duplicate QS', [coreQs, { ...coreQs, status: 'invalid-report' as const, fullHorizon: false }]],
    ['duplicate VB10', [coreVb10, coreVb10]],
    ['QS with a VB10 suffix', [{ ...coreQs, runId: coreVb10.runId }]],
    ['VB10 without a suffix', [{ ...coreVb10, runId: coreQs.runId }]],
    ['VB10 with another source ID', [{ ...coreVb10, runId: standaloneVb10.runId }]],
  ] as const)('rejects %s', (_name, rows) => {
    expect(() => buildPacedSplitCoverage(split, role, sensor, rows)).toThrow()
  })
})
