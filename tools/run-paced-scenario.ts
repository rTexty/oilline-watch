import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import { sha256Schema } from '../src/contracts/calibration'
import type { BrowserInput } from './calibration/browser/client'
import { buildPacedHarness, servePacedHarness } from './calibration/browser/paced-build'
import { startPacedHeapSampling } from './calibration/browser/paced-heap'
import { pacedPilotStatus, validationFailure } from './calibration/browser/pilot-status'
import { schedulerFixture } from './calibration/browser/scheduler-fixture'
import { preparePacedSelection } from './calibration/browser/selected-policy'
import { parseSpatialEvaluationOptions, spatialEvaluationOptions } from './calibration/browser/spatial-evaluation-options'
import { jsonDocument, writeImmutable } from './calibration/io'
import { loadOpenScenarioSplit } from './calibration/scenario-runner'
import { validateScenarioTarget } from './calibration/scenario-setup'
import { assertPrivateSplitOutput } from './calibration/split-output'

async function main() {
  const { values } = parseArgs({ options: {
    profile: { type: 'string' }, split: { type: 'string' }, run: { type: 'string' },
    out: { type: 'string' }, 'until-us': { type: 'string' }, 'expected-split-sha256': { type: 'string' },
    selection: { type: 'string' }, 'expected-selection-sha256': { type: 'string' }, dictionary: { type: 'string' },
    'expected-selection-file-sha256': { type: 'string' },
    'scheduler-fixture': { type: 'boolean' }, 'heap-probe': { type: 'boolean' }, 'active-shadow': { type: 'boolean' },
    headed: { type: 'boolean' }, 'decision-trace': { type: 'boolean' }, ...spatialEvaluationOptions,
  } })
  if (!values.profile || !values.split || !values.run || !values.out || !values['expected-split-sha256']) {
    throw new Error('Usage: run-paced-scenario --profile <json> --split <directory> --expected-split-sha256 <digest> --run <id> --out <new-json> [--until-us <integer>] [--scheduler-fixture | --selection <json> --expected-selection-sha256 <digest> --dictionary <directory> [--expected-selection-file-sha256 <digest>]] [--spatial-evaluation <json> --expected-spatial-evaluation-sha256 <digest>] [--active-shadow] [--decision-trace] [--heap-probe] [--headed]')
  }
  const selectionPath = values.selection
  const selectionSha256 = values['expected-selection-sha256']
  const selectionFilePin = values['expected-selection-file-sha256']
  const dictionaryDirectory = values.dictionary
  const candidateRequested = [selectionPath, selectionSha256, selectionFilePin, dictionaryDirectory].some((value) => value !== undefined)
  if (candidateRequested && (!selectionPath || !selectionSha256 || !dictionaryDirectory || values['scheduler-fixture'])) {
    throw new Error('Selected policy requires --selection, --expected-selection-sha256 and --dictionary, without --scheduler-fixture.')
  }
  const spatialEvaluation = parseSpatialEvaluationOptions(values, candidateRequested)
  const expectedSelectionHash = selectionSha256 === undefined ? undefined : sha256Schema.parse(selectionSha256)
  const expectedSelectionFileSha256 = sha256Schema.optional().parse(selectionFilePin)
  const workspace = fileURLToPath(new URL('..', import.meta.url))
  await assertPrivateSplitOutput(values.out, workspace)
  const expected = sha256Schema.parse(values['expected-split-sha256'])
  const split = await loadOpenScenarioSplit(values.split, values.profile, expected)
  const pair = split.closurePairs.find((item) => item.vb10RunId === values.run)
  const recipe = split.runs.find((item) => item.runId === (pair?.sourceRecipeRunId ?? values.run))
  if (!recipe) throw new Error('Run ID is absent from the committed open split.')
  const targetUs = values['until-us'] === undefined ? split.profile.horizonUs : Number(values['until-us'])
  validateScenarioTarget(split.profile, targetUs)
  const closure = pair ? 'vb10' : 'qs'
  const temporary = await mkdtemp(join(tmpdir(), 'pipetwin-paced-'))
  try {
    const output = join(temporary, 'site')
    const withActiveShadow = values['active-shadow'] === true
    const provenance = await buildPacedHarness(workspace, output, { withDictionary: candidateRequested, withActiveShadow })
    const selected = selectionPath && expectedSelectionHash && dictionaryDirectory ? await preparePacedSelection({
      selectionPath, expectedSelectionHash, expectedSelectionFileSha256, dictionaryDirectory, sourceHashes: provenance.sourceHashes,
      profile: split.profile, profileHash: split.commitment.profileHash, split: split.commitment.split, splitHash: expected,
      sensorProfileId: recipe.sensorProfileId, spatialEvaluation,
    }) : undefined
    if (selected?.evidence.diagnosticGridSelection && (!values['decision-trace'] || withActiveShadow)) {
      throw new Error('Diagnostic grid selection requires a passive public decision trace.')
    }
    const host = await servePacedHarness(output, selected?.dictionary)
    try {
      const browser = await chromium.launch({ headless: !values.headed })
      try {
        const context = await browser.newContext()
        const page = await context.newPage()
        const workers: string[] = []
        page.on('worker', (worker) => { workers.push(basename(new URL(worker.url()).pathname)) })
        await page.goto(host.url, { waitUntil: 'load' })
        const fixture = values['scheduler-fixture'] ? schedulerFixture(recipe.sensorProfileId, provenance.sourceHashes) : undefined
        const browserInput: BrowserInput = {
          scenario: { profile: split.profile, recipe, closure, targetUs },
          diagnosticRelease: selected?.diagnosticRelease ?? (fixture ? { calibration: fixture, expectedHashes: fixture.hashes } : undefined),
          ...(values['decision-trace'] ? { decisionTrace: true } : {}),
        }
        const stopHeapSampling = values['heap-probe'] ? await startPacedHeapSampling(page) : undefined
        const observation = await page.evaluate((input) => window.runPacedScenario(input), browserInput)
          .catch(async () => ({
            ...validationFailure('transport-error', 'execution', 0),
            ...(values['decision-trace'] ? { publicDiagnosticTrace: (await import('./calibration/browser/public-diagnostic-trace')).createPublicDiagnosticTrace('').terminal(null) } : {}),
          }))
        const heap = await stopHeapSampling?.()
        const runStatus = workers.length !== 2 && !observation.failure
          ? 'worker-error' : pacedPilotStatus(observation, targetUs, split.profile.horizonUs)
        const dictionaryLoaded = observation.kind === 'validation-progress' && observation.dictionaryStatus === 'ready'
        const candidateUnavailable = selected && recipe.startupQualification === 'known-healthy'
          && (!dictionaryLoaded || !('quantitativePath' in observation && observation.quantitativePath))
        const status = candidateUnavailable && (runStatus === 'completed' || runStatus === 'pilot-cutoff')
          ? 'candidate-unavailable' : runStatus
        await writeImmutable(values.out, jsonDocument({
          schemaVersion: 1, kind: 'open-browser-paced-pilot', qualified: false, pace: 1, solver: 'typescript-f64',
          diagnosticMode: selected ? 'selected-policy' : fixture ? 'scheduler-fixture' : 'qualitative-residuals',
          calibrationHash: null, selectedPolicy: selected?.evidence ?? null,
          dictionaryLoaded, activeAttemptEvaluated: false,
          ...(withActiveShadow ? { activeShadowEnabled: true } : {}),
          ...(values['decision-trace'] ? { decisionTraceEnabled: true } : {}),
          split: split.split.split, splitSha256: expected, commitmentSha256: split.commitmentSha256,
          profileSha256: split.commitment.profileHash, generatorSha256: split.commitment.generatorHash,
          recipeSha256: split.commitment.recipeSha256, ...provenance, assets: host.assets,
          runId: values.run, closure, targetUs, status, workers,
          browser: { name: 'chromium', version: browser.version(), headless: !values.headed }, node: process.version,
          observation, heap, dictionaryTransport: host.dictionaryTransport(),
        }))
        const committed = 'counts' in observation ? observation.counts.committed : 0
        console.log(`Browser run ${status} at ${(observation.timeUs / 1_000_000).toFixed(3)} model seconds. Committed inverse jobs: ${committed}.`)
        if (values['decision-trace'] && observation.publicDiagnosticTrace?.status !== 'observed') {
          console.error(`Public diagnostic trace: ${observation.publicDiagnosticTrace?.status ?? 'missing-terminal'}.`)
          process.exitCode = 1
        }
        if (['worker-error', 'transport-error', 'wall-timeout', 'incomplete-closure', 'candidate-unavailable'].includes(status)) process.exitCode = 1
      } finally {
        await browser.close()
      }
    } finally {
      await host.close()
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Paced browser pilot failed.')
  process.exitCode = 1
}
