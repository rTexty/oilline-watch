import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { profileSchema } from '../../src/contracts/model'
import { buildPacedHarness, servePacedHarness } from '../../tools/calibration/browser/paced-build'
import { generateOpenSplit } from '../../tools/calibration/generate-scenarios'
import { jsonDocument, sha256 } from '../../tools/calibration/io'

test.use({ trace: 'off' })

test('runs the production simulation and inference Workers at real browser pace', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'pipetwin-paced-e2e-'))
  try {
    await buildPacedHarness(process.cwd(), directory)
    const host = await servePacedHarness(directory)
    try {
      const profile = profileSchema.parse(JSON.parse(await readFile(
        new URL('../../src/scenarios/synthetic-oil-turbulent-v1.json', import.meta.url), 'utf8',
      )))
      const { recipes } = generateOpenSplit({ split: 'fit', saltHex: '0'.repeat(32), generatorHash: 'a'.repeat(64), profile })
      const recipe = recipes.runs.find((run) => run.runId === 'fit-null-030')!
      const workers: string[] = []
      page.on('worker', (worker) => workers.push(worker.url()))
      await page.goto(host.url, { waitUntil: 'load' })
      const observation = await page.evaluate((input) => window.runPacedScenario(input), {
        scenario: { profile, recipe, closure: 'qs' as const, targetUs: 500_000 },
      })
      expect(workers).toHaveLength(2)
      expect(workers.some((url) => url.includes('/simulation.worker-'))).toBe(true)
      expect(workers.some((url) => url.includes('/inference.worker-'))).toBe(true)
      expect(observation).toMatchObject({ phase: 'completed', timeUs: 500_000, failure: null,
        quantitativePath: false, visibility: { final: 'visible', hiddenSnapshots: 0 },
        detectorTrace: { status: 'uncalibrated', availableUs: 0, exposure: [], episodes: [] } })
      if (observation.kind !== 'validation-progress') throw new Error('Missing terminal Worker observation.')
      expect(observation.activeShadow).toBeUndefined()
      expect(observation.publicDiagnosticTrace).toBeUndefined()
      expect(observation.elapsedMs).toBeGreaterThanOrEqual(500)
      expect(observation.residualTimeUs).toBeGreaterThanOrEqual(50_000)
      expect(observation.simulationNumericalMemory?.highWaterBytes).toBeGreaterThan(0)
      expect((await page.request.get(`${host.url}/private/recipes.json`)).status()).toBe(404)
      const failed = await page.evaluate((input) => window.runPacedScenario(input), {
        scenario: { profile, recipe, closure: 'qs' as const, targetUs: 500_001 },
      })
      expect(failed).toMatchObject({ phase: 'error', failure: 'worker-error', stage: 'bootstrap', timeUs: 0 })
    } finally {
      await host.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('uses a pre-freeze selection and verified dictionary in the isolated browser build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipetwin-paced-selected-e2e-'))
  try {
    const run = promisify(execFile)
    const profile = 'src/scenarios/synthetic-oil-turbulent-v1.json'
    const split = join(directory, 'calibration')
    await run(process.execPath, ['--import', 'tsx', 'tools/generate-scenario-split.ts',
      '--profile', profile, '--split', 'calibration', '--out', split])
    const splitHash = createHash('sha256').update(await readFile(join(split, 'split.json'))).digest('hex')
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/paced-selection.ts', directory, profile, splitHash])
    const expected = stdout.trim()
    const out = join(directory, 'pilot.json')
    await run(process.execPath, ['--import', 'tsx', 'tools/run-paced-scenario.ts',
      '--profile', profile, '--split', split, '--expected-split-sha256', splitHash,
      '--run', 'calibration-null-030', '--until-us', '500000', '--out', out,
      '--selection', join(directory, 'selected.json'), '--expected-selection-sha256', expected,
      '--dictionary', join(directory, 'dictionary'), '--heap-probe', '--active-shadow', '--decision-trace'])
    const report = JSON.parse(await readFile(out, 'utf8'))
    expect(report).toMatchObject({
      qualified: false, diagnosticMode: 'selected-policy', calibrationHash: null, dictionaryLoaded: true,
      activeAttemptEvaluated: false, activeShadowEnabled: true, decisionTraceEnabled: true,
      split: 'calibration', splitSha256: splitHash, status: 'pilot-cutoff',
      selectedPolicy: { selectionHash: expected, releaseScope: 'passive' },
      dictionaryTransport: {
        manifest: { requested: 1, finished: 1, closedEarly: 0 },
        binary: { requested: 1, finished: 1, closedEarly: 0 },
      },
      observation: { phase: 'completed', timeUs: 500_000, failure: null, quantitativePath: true,
        dictionaryStatus: 'ready', policyAudit: { jobs: [], warmup: null, resourceLimited: false },
        activeShadow: { kind: 'committed-diagnosis-shadow', activeAttemptEvaluated: false, rows: [] },
        publicDiagnosticTrace: { status: 'observed', terminalSnapshot: { phase: 'completed', timeUs: 500_000 },
          mismatchedJobIds: [], firstVisibleSupports: [] },
        detectorTrace: { status: 'warming-up', observedThroughUs: 500_000, deliveredThroughUs: 500_000,
          processedChallengeCohorts: 0, availableUs: 0 } },
    })
    expect(report.heap.failedSamples).toEqual([])
    expect(report.heap.samples.length).toBeGreaterThan(0)
    for (const sample of report.heap.samples as Array<{ elapsedMs: number; usedSize: number; totalSize: number;
      targets: Array<{ type: string; targetId: string; usedSize: number; totalSize: number }> }>) {
      expect(sample.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(sample.targets.map((target) => target.type).sort()).toEqual(['page', 'worker', 'worker'])
      expect(new Set(sample.targets.map((target) => target.targetId)).size).toBe(3)
      expect(sample.usedSize).toBe(sample.targets.reduce((sum, target) => sum + target.usedSize, 0))
      expect(sample.totalSize).toBe(sample.targets.reduce((sum, target) => sum + target.totalSize, 0))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stages a pinned passive spatial envelope in the paced CLI browser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pipetwin-paced-spatial-e2e-'))
  try {
    const run = promisify(execFile)
    const profilePath = 'src/scenarios/synthetic-oil-turbulent-v1.json'
    const split = join(directory, 'calibration')
    await run(process.execPath, ['--import', 'tsx', 'tools/generate-scenario-split.ts',
      '--profile', profilePath, '--split', 'calibration', '--out', split])
    const splitHash = sha256(await readFile(join(split, 'split.json')))
    await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/paced-selection.ts', directory, profilePath, splitHash])
    const selectionPath = join(directory, 'selected.json')
    const dictionaryDirectory = join(directory, 'dictionary')
    const [selectionBytes, manifestBytes] = await Promise.all([
      readFile(selectionPath), readFile(join(dictionaryDirectory, 'dictionary.json')),
    ])
    const candidate = JSON.parse(selectionBytes.toString('utf8')) as { selectionHash: string; selection: { hashes: unknown } }
    const dictionaryManifest = JSON.parse(manifestBytes.toString('utf8')) as { anchorParameterHashes: readonly string[] }
    // Structural fixture. The cutoff does not exercise an inverse job.
    const envelope = jsonDocument({
      schemaVersion: 1, controlFamily: 'steady-outlet', solver: 'typescript-f64',
      calibrationId: candidate.selectionHash, reportHash: sha256(selectionBytes), hashes: candidate.selection.hashes,
      coverage: {
        guardUs: 3_000_000, openingUs: [0, 1_000_000, 20_000_000], maximumCdAreaM2: 4e-5,
        windowUs: [4_000_000, 30_000_000], interiorCells: 199, cellWidthM: 5,
        steadyPressureTolerancePa: 1e-4, steadyFlowToleranceM3s: 1e-12, steadyTemperatureToleranceK: 1e-8,
      },
      anchorParameterHashes: dictionaryManifest.anchorParameterHashes, discrepancyNorms: Array<number>(9 * 199).fill(10),
    })
    const envelopePath = join(directory, 'spatial-envelope.json')
    const pin = sha256(envelope)
    const out = join(directory, 'pilot.json')
    await writeFile(envelopePath, envelope)
    const cli = ['--import', 'tsx', 'tools/run-paced-scenario.ts', '--profile', profilePath, '--split', split,
      '--expected-split-sha256', splitHash, '--run', 'calibration-null-030', '--until-us', '500000', '--out', out]
    const selected = ['--selection', selectionPath, '--expected-selection-sha256', candidate.selectionHash,
      '--dictionary', dictionaryDirectory]
    const spatial = ['--spatial-evaluation', envelopePath, '--expected-spatial-evaluation-sha256', pin]

    const incomplete = [
      [...selected, ...spatial.slice(0, 2)], [...selected, ...spatial.slice(2)], spatial,
    ]
    for (const flags of incomplete) {
      await expect(run(process.execPath, [...cli, ...flags])).rejects.toMatchObject({
        code: 1, stderr: expect.stringMatching(/spatial evaluation requires.*selected policy/i),
      })
    }
    await expect(readFile(out)).rejects.toMatchObject({ code: 'ENOENT' })
    await run(process.execPath, [...cli, ...selected, ...spatial])

    const report = JSON.parse(await readFile(out, 'utf8')) as unknown
    expect(report).toMatchObject({
      qualified: false, diagnosticMode: 'selected-policy', dictionaryLoaded: true, status: 'pilot-cutoff',
      selectedPolicy: { selectionHash: candidate.selectionHash, releaseScope: 'passive', spatialEvaluationSha256: pin },
      assets: expect.arrayContaining([{ name: 'calibration/spatial-envelope.json', sha256: pin }]),
      observation: { phase: 'completed', timeUs: 500_000, failure: null, dictionaryStatus: 'ready', policyAudit: { jobs: [] } },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
