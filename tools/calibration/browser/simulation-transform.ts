function replaceHook(source: string, original: string, replacement: string): string {
  const index = source.indexOf(original)
  if (index === -1 || source.indexOf(original, index + original.length) !== -1) {
    throw new Error(`Expected a unique Worker hook: ${original}`)
  }
  return source.slice(0, index) + replacement + source.slice(index + original.length)
}

export function adaptPacedSimulation(source: string, { withDictionary = false, withActiveShadow = false } = {}): string {
  if (source.includes('acceptValidationBootstrap')) throw new Error('Expected a unique Worker hook: unmodified simulation source')
  const shadowBootstrap = withActiveShadow ? ', true' : ''
  const hooks = [
    ['const parsed = commandSchema.safeParse(event.data)',
      `if (acceptValidationBootstrap(event, worker${shadowBootstrap})) return\n  const parsed = commandSchema.safeParse(event.data)`],
    ['const nominal = profileSchema.parse(profiles[command.profileId])',
      'const nominal = validationSetup()?.engine.profile ?? profileSchema.parse(profiles[command.profileId])'],
    ['horizonUs = command.replay?.endedAtUs ?? profile.horizonUs',
      'horizonUs = validationSetup()?.targetUs ?? command.replay?.endedAtUs ?? profile.horizonUs'],
    ['createEngine(profile, crypto.getRandomValues(new Uint32Array(1))[0]!, backend)',
      'consumeValidationEngine() ?? createEngine(profile, crypto.getRandomValues(new Uint32Array(1))[0]!, backend)'],
    ['lastPublishMs = performance.now()',
      'lastPublishMs = performance.now()\n  reportValidationProgress({ snapshot, provisional, submittedWallMs: lastPublishMs, horizonUs, originWallMs, originTimeUs, pace, activeJob, audit, auditTransitions, closureEvidenceMissing, publicControlRevision: engine ? appliedControlRevision(engine.journal, engine.timeUs) : 0, warmup: detector?.warmupFit ?? null, resourceLimited: auditFull, detectorConfigured: detector?.calibration != null })'],
    ['const release = command.diagnosticRelease',
      'const release = command.diagnosticRelease\n    observeValidationCalibrationRequest(release !== undefined)'],
    ['detector = advanceDetector(detector, batch)',
      'detector = advanceDetector(detector, batch)\n  observeValidationDetector(detector, batch.sampleTimeUs)'],
    ["if (replayTimeline) replayVerification = 'diverged'\n    stop('invalid')",
      "observeValidationFailure(error)\n    if (replayTimeline) replayVerification = 'diverged'\n    stop('invalid')"],
    ["port.postMessage({ schemaVersion: 1, runId, kind: 'inverse', job, deadlineMs })",
      "observeValidationJob('admitted', job.jobId, deadlineMs - performance.timeOrigin - job.searchBudget.wallLimitMs)\n  port.postMessage({ schemaVersion: 1, runId, kind: 'inverse', job, deadlineMs })"],
    ['audit = [...audit, record.data]',
      "observeValidationJob('finished', record.data.jobId)\n      audit = [...audit, record.data]\n      reportValidationFinal(record.data, activeJob, detector?.calibration)"],
  ] as const
  const dictionaryHooks = [
    ['awaitingDictionary = bundled !== undefined', 'awaitingDictionary = true\n      observeValidationDictionary(\'waiting\')'],
    ["if (result.data.kind === 'dictionary-ready') {",
      "if (result.data.kind === 'dictionary-ready') {\n      observeValidationDictionary('ready')"],
    ["if (result.data.kind === 'dictionary-unavailable') {",
      "if (result.data.kind === 'dictionary-unavailable') {\n      observeValidationDictionary('unavailable')"],
  ] as const
  const shadowHooks = [
    ['diagnosis = committed', `diagnosis = committed
      observeValidationActiveOpportunity(committed, {
        timeUs: timeUs(), horizonUs,
        controlRevision: engine ? appliedControlRevision(engine.journal, engine.timeUs) : 0,
        sensorCohortUs: detector && detector.lastBatchUs >= 0 ? detector.lastBatchUs : null,
        pressureLastValidUs: detector?.channels.map(({ lastValidUs }) => lastValidUs) ?? [],
        lastFlowUs: detector?.lastFlowUs ?? null,
      })`],
  ] as const
  const activeHooks = [...hooks, ...(withDictionary ? dictionaryHooks : []), ...(withActiveShadow ? shadowHooks : [])]
  const adapted = activeHooks.reduce((current, [original, replacement]) => replaceHook(current, original, replacement), source)
  const dictionaryObserver = withDictionary ? 'observeValidationDictionary, ' : ''
  const shadowObserver = withActiveShadow ? 'observeValidationActiveOpportunity, ' : ''
  return `import { appliedControlRevision } from './public-controls'\nimport { acceptValidationBootstrap, consumeValidationEngine, ${dictionaryObserver}${shadowObserver}observeValidationCalibrationRequest, observeValidationDetector, observeValidationFailure, observeValidationJob, reportValidationFinal, reportValidationProgress, validationSetup } from '../../tools/calibration/browser/worker-adapter'\n` + adapted
}
