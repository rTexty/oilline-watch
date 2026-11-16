import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { parseReplay } from '../src/app/replay'
import { parseCalibration } from '../src/contracts/calibration'
import { MAX_IMPORT_BYTES } from '../src/contracts/model'
import type { AnchorId } from '../src/contracts/model'
import { parsePublicScenario } from '../src/contracts/scenario'
import { advanceDetector, createDetector } from '../src/detection/detector'
import { replayExactTrials } from '../src/detection/inverse'
import { buildDiagnosticJob } from '../src/runtime/diagnostic-jobs'
import { sameDiagnosticSources } from '../src/runtime/diagnostic-release'
import { advanceEngine } from '../src/runtime/engine'
import { publicControls } from '../src/runtime/public-controls'
import { engineFromReplay } from '../src/runtime/replay'
import { createCheckpointAnchor } from '../src/twin/checkpoint'
import { diagnosticSourceHashes } from './diagnostic-source-hashes'

async function readBounded(path: string, max: number): Promise<string> {
  const info = await stat(path)
  if (!info.isFile() || info.size > max) throw new Error('Invalid input file or size')
  return readFile(path, 'utf8')
}

async function main() {
  const { values } = parseArgs({ options: {
    profile: { type: 'string' }, calibration: { type: 'string' }, replay: { type: 'string' }, out: { type: 'string' },
  } })
  if (!values.profile || !values.calibration || !values.replay || !values.out) {
    throw new Error('Usage: replay-inference --profile <json> --calibration <json> --replay <json> --out <new-json>')
  }
  const profileBytes = await readBounded(values.profile, 64 * 1024)
  const profile = parsePublicScenario(profileBytes)
  const calibration = parseCalibration(await readBounded(values.calibration, 64 * 1024))
  const record = parseReplay(await readBounded(values.replay, MAX_IMPORT_BYTES))
  const audit = record.inferenceAudit
  const profileSha256 = createHash('sha256').update(profileBytes).digest('hex')
  if (!audit || !audit.jobs.some((job) => job.trials.length > 0) || audit.calibrationId !== calibration.calibrationId
    || audit.policySha256 !== calibration.hashes.policy || audit.dictionarySha256 !== calibration.hashes.dictionary
    || profileSha256 !== calibration.hashes.profile || !sameDiagnosticSources(calibration, diagnosticSourceHashes(process.cwd()))) {
    throw new Error('Replay audit, supplied calibration and current source are incompatible')
  }
  let detector = createDetector(profile, calibration, calibration.hashes)
  if (!detector.calibration) throw new Error('Replay requires the original qualified calibration')
  let engine = engineFromReplay(profile, record)
  if (engine.latestBatch) detector = advanceDetector(detector, engine.latestBatch)
  const anchors = await Promise.all(engine.bank.map((state, index) => createCheckpointAnchor(index as AnchorId, state.profile.definition)))
  const controls = publicControls(record.events)
  const results = []
  for (const item of audit.jobs) {
    if (item.endUs < engine.timeUs) throw new Error('Replay evidence windows are out of order')
    const durationUs = item.endUs - item.startUs
    if (durationUs !== 4_000_000 && durationUs !== 30_000_000) throw new Error('Invalid replay window duration')
    engine = advanceEngine(engine, item.endUs, (batch) => { detector = advanceDetector(detector, batch) })
    const job = buildDiagnosticJob(item.jobId, { startUs: item.startUs, endUs: item.endUs, durationUs, priority: 'regular' },
      detector, engine.history, anchors, controls)
    if (!job) throw new Error('Original public evidence could not be rebuilt')
    const result = await replayExactTrials({
      ...job,
      searchBudget: { ...job.searchBudget, evaluationLimit: item.evaluationLimit, wallLimitMs: item.wallLimitMs },
    }, anchors, calibration.noise, item.trials)
    results.push({ jobId: item.jobId, result })
    if (result.status !== 'matched') break
  }
  const matched = results.length === audit.jobs.length && results.every(({ result }) => result.status === 'matched')
  await writeFile(values.out, JSON.stringify({ schemaVersion: 1, scope: 'recorded-f64-trials',
    profileSha256, calibrationId: calibration.calibrationId, matched, results }, null, 2) + '\n', { flag: 'wx' })
  process.exitCode = matched ? 0 : 1
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Inference replay failed')
  process.exitCode = 1
}
