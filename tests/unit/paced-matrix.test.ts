import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { generateOpenSplit } from '../../tools/calibration/generate-scenarios'
import { launchPacedMatrixChild, runPacedMatrixLanes, selectPacedMatrixRuns } from '../../tools/calibration/browser/paced-matrix'

const profile = profileSchema.parse(rawProfile)
const generated = generateOpenSplit({ split: 'fit', saltHex: '0'.repeat(32), generatorHash: 'a'.repeat(64), profile })
const split = { profile, runs: generated.recipes.runs, closurePairs: generated.closurePairs.pairs }

describe('open paced matrix lanes', () => {
  it('selects the committed sensor layout and its declared closure companions', () => {
    const nominal = selectPacedMatrixRuns(split)
    const adverse = selectPacedMatrixRuns({ ...split, profile: { ...profile, sensorProfileId: 'synthetic-oil-adverse-v1' } })
    expect(nominal.filter((run) => run.closure === 'qs')).toHaveLength(228)
    expect(adverse.filter((run) => run.closure === 'qs')).toHaveLength(180)
    expect(nominal.length + adverse.length).toBe(476)
    expect(new Set([...nominal, ...adverse].map(({ runId }) => runId)).size).toBe(476)
    for (const layout of [nominal, adverse]) {
      for (const companion of layout.filter((run) => run.closure === 'vb10')) {
        expect(layout.find(({ runId }) => runId === companion.sourceRunId)?.closure).toBe('qs')
      }
    }
  })

  it('keeps declaration order for subsets and rejects cross-layout and duplicate IDs', () => {
    const nominal = selectPacedMatrixRuns(split)
    const first = nominal[0]!
    const last = nominal.at(-1)!
    expect(selectPacedMatrixRuns(split, [last.runId, first.runId])).toEqual([first, last])
    expect(() => selectPacedMatrixRuns(split, [first.runId, first.runId])).toThrow(/duplicate/i)
    expect(() => selectPacedMatrixRuns(split, ['fit-leak-000'])).toThrow(/layout/i)
    expect(() => selectPacedMatrixRuns(split, ['../public'])).toThrow(/layout/i)
  })

  it('selects only reserved closure pairs from an explicit adverse layout on the nominal commitment', () => {
    const options = { sensorProfileId: 'synthetic-oil-adverse-v1', closurePairsOnly: true } as const
    const adverse = split.runs.filter(({ sensorProfileId }) => sensorProfileId === options.sensorProfileId)
    const adverseIds = new Set(adverse.map(({ runId }) => runId))
    const declaredPairs = split.closurePairs.filter(({ qsRunId }) => adverseIds.has(qsRunId))
    const pairedQsIds = new Set(declaredPairs.map(({ qsRunId }) => qsRunId))
    const qs = adverse.filter(({ runId }) => pairedQsIds.has(runId))
    const selected = selectPacedMatrixRuns(split, undefined, options)
    expect(qs).toHaveLength(34)
    expect(declaredPairs).toHaveLength(34)
    expect(selected).toHaveLength(68)
    expect(selected).toEqual([
      ...qs.map(({ runId }) => ({ runId, sourceRunId: runId, closure: 'qs' })),
      ...declaredPairs.map(({ vb10RunId, sourceRecipeRunId }) => ({
        runId: vb10RunId, sourceRunId: sourceRecipeRunId, closure: 'vb10',
      })),
    ])
    const first = selected[0]!
    const last = selected.at(-1)!
    expect(selectPacedMatrixRuns(split, [last.runId, first.runId], options)).toEqual([first, last])
    const unpaired = adverse.find(({ runId }) => !pairedQsIds.has(runId))!
    const nominalPair = split.closurePairs.find(({ qsRunId }) => !adverseIds.has(qsRunId))!
    expect(() => selectPacedMatrixRuns(split, [unpaired.runId], options)).toThrow()
    expect(() => selectPacedMatrixRuns(split, [nominalPair.vb10RunId], options)).toThrow()
  })

  it('bounds concurrent whole runs, records failed rows, and retains declaration order', async () => {
    const runs = selectPacedMatrixRuns(split).slice(0, 3)
    const gate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const secondStarted = Promise.withResolvers<void>()
    const started: string[] = []
    const matrix = runPacedMatrixLanes(runs, 2, async (run) => {
      started.push(run.runId)
      if (run === runs[0]) await gate.promise
      if (run === runs[1]) {
        secondStarted.resolve()
        await secondGate.promise
        throw new Error('private child error')
      }
      return { outcome: 'completed' }
    })
    await secondStarted.promise
    expect(started).toEqual(runs.slice(0, 2).map(({ runId }) => runId))
    secondGate.resolve()
    gate.resolve()
    const result = await matrix
    expect(result.peakLanes).toBe(2)
    expect(result.rows.map(({ run }) => run)).toEqual(runs)
    expect(result.rows.map(({ value }) => value)).toEqual([{ outcome: 'completed' }, null, { outcome: 'completed' }])
    expect(result.rows.every(({ wallMs, queueMs }) => wallMs >= 0 && queueMs >= 0)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private child error')
  })

  it('rejects invalid lane bounds before invoking any executor', async () => {
    const execute = () => { throw new Error('must not execute') }
    const runs = selectPacedMatrixRuns(split).slice(0, 1)
    await expect(runPacedMatrixLanes(runs, 33, execute)).rejects.toThrow(/lanes/i)
    await expect(runPacedMatrixLanes(runs, 0, execute)).rejects.toThrow(/lanes/i)
  })

  it('retains allowlisted child diagnostics without copying private error text', async () => {
    const child = await launchPacedMatrixChild(['--eval', `
      process.stdout.write('Browser run candidate-')
      process.stdout.write('unavailable at 38.000 model seconds. Committed inverse jobs: 0.\\n')
      process.stderr.write('page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1/private-token\\n')
      process.exitCode = 1
    `], { cwd: process.cwd(), timeoutMs: 3000, shutdownGraceMs: 150 })
    expect(child).toMatchObject({
      code: 1,
      diagnostics: {
        stdout: { outcome: 'candidate-unavailable', present: true, truncated: false },
        stderr: { failure: 'browser-navigation', present: true, truncated: false },
        spawnErrorCode: null,
      },
    })
    expect(JSON.stringify(child)).not.toContain('private-token')
  })

  it('drains noisy child streams while bounding and filtering diagnostic evidence', async () => {
    const child = await launchPacedMatrixChild(['--eval', `
      process.stdout.write('secret='.repeat(20_000))
      process.stderr.write('private value\\n'.repeat(20) + 'browserType.launch: outside inspection limit\\n')
      process.exitCode = 1
    `], { cwd: process.cwd(), timeoutMs: 3000, shutdownGraceMs: 150 })
    expect(child).toMatchObject({
      code: 1, timedOut: false,
      diagnostics: {
        stdout: { outcome: null, present: true, truncated: true },
        stderr: { failure: null, present: true, truncated: true },
      },
    })
    expect(JSON.stringify(child)).not.toMatch(/secret|private value|outside inspection limit/)
  })

  it.skipIf(process.platform === 'win32')('retries graceful shutdown before forcing a timed-out child to exit', async () => {
    const child = await launchPacedMatrixChild(['--eval', `
      let terminationSignals = 0
      process.on('SIGTERM', () => { if (++terminationSignals === 2) process.exit(0) })
      setInterval(() => {}, 1000)
    `], { cwd: process.cwd(), timeoutMs: 800, shutdownGraceMs: 150 })
    expect(child).toMatchObject({ code: 0, signal: null, timedOut: true, spawnFailed: false })
  })

  it.skipIf(process.platform === 'win32')('bounds diagnostic drain when a descendant outlives a successful launcher', async () => {
    const began = performance.now()
    const child = await launchPacedMatrixChild(['--eval', `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 2600)'], {
        stdio: ['ignore', process.stdout, process.stderr],
      }).unref()
    `], { cwd: process.cwd(), timeoutMs: 6000, shutdownGraceMs: 100 })
    expect(child).toMatchObject({
      code: 0, timedOut: false, spawnFailed: false,
      diagnostics: { stdout: { truncated: true }, stderr: { truncated: true } },
    })
    expect(performance.now() - began).toBeLessThan(2000)
  })

  it.skipIf(process.platform === 'win32')('forces a timed-out launcher to exit and closes inherited pipes', async () => {
    const began = performance.now()
    const child = await launchPacedMatrixChild(['--eval', `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 2600)'], {
        stdio: ['ignore', process.stdout, process.stderr],
      }).unref()
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `], { cwd: process.cwd(), timeoutMs: 500, shutdownGraceMs: 100 })
    expect(child).toMatchObject({
      code: null, signal: 'SIGKILL', timedOut: true,
      diagnostics: { stdout: { truncated: true }, stderr: { truncated: true } },
    })
    expect(performance.now() - began).toBeLessThan(2000)
  })
})
