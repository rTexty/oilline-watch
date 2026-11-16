import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { Calibration } from '../../src/contracts/calibration'
import type { RunSnapshot } from '../../src/runtime/vertical-protocol'
import { buildPacedHarness, servePacedHarness } from '../../tools/calibration/browser/paced-build'
import { schedulerFixture } from '../../tools/calibration/browser/scheduler-fixture'

type WorkerAssets = { simulation: string; inference: string }

async function exercisePassiveGuard(page: Page, assets: WorkerAssets, calibration?: Calibration) {
  return page.evaluate(async ({ assets, calibration }) => {
    return new Promise<{
      rejected: RunSnapshot
      afterRejection: RunSnapshot
      final: RunSnapshot
      simulationMessages: string[]
      inferenceMessages: string[]
      bridgeRequests: string[]
    }>((resolve, reject) => {
      const runId = crypto.randomUUID()
      const simulation = new Worker(assets.simulation, { type: 'module' })
      const inference = new Worker(assets.inference, { type: 'module' })
      const simulationChannel = new MessageChannel()
      const inferenceChannel = new MessageChannel()
      const simulationMessages: string[] = []
      const inferenceMessages: string[] = []
      const bridgeRequests: string[] = []
      let rejected: RunSnapshot | undefined
      let afterRejection: RunSnapshot | undefined
      let requested = false
      const timeout = setTimeout(() => finish(new Error('Passive experiment scenario timed out')), 45_000)

      function finish(error?: Error, final?: RunSnapshot) {
        clearTimeout(timeout)
        simulation.terminate()
        inference.terminate()
        simulationChannel.port2.close()
        inferenceChannel.port2.close()
        if (error) reject(error)
        else if (rejected && afterRejection && final) {
          resolve({ rejected, afterRejection, final, simulationMessages, inferenceMessages, bridgeRequests })
        } else reject(new Error('Missing rejection, later snapshot, or final replay'))
      }

      simulation.onerror = inference.onerror = () => finish(new Error('Worker failed'))
      simulationChannel.port2.onmessage = ({ data }) => {
        if (typeof data.kind === 'string') bridgeRequests.push(data.kind)
        inferenceChannel.port2.postMessage(data)
      }
      inferenceChannel.port2.onmessage = ({ data }) => {
        if (typeof data.kind === 'string') inferenceMessages.push(data.kind)
        simulationChannel.port2.postMessage(data)
      }
      simulation.onmessage = ({ data }) => {
        if (typeof data.kind === 'string') simulationMessages.push(data.kind)
        const snapshot = data.snapshot as RunSnapshot | undefined
        if (!snapshot) return
        if (snapshot.phase === 'error' || snapshot.phase === 'invalid') {
          finish(new Error(`Simulation failed: ${snapshot.message}`))
          return
        }
        if (!requested && snapshot.phase === 'running' && snapshot.timeUs >= 36_000_000
          && (!calibration || bridgeRequests.includes('inverse'))) {
          requested = true
          simulation.postMessage({ schemaVersion: 1, runId, seq: 1, kind: 'accept-experiment', proposalId: crypto.randomUUID() })
        } else if (requested && !rejected && snapshot.message === 'Активный опыт недоступен без квалифицированного предложения.') {
          rejected = snapshot
        } else if (rejected && !afterRejection && snapshot.phase === 'running'
          && snapshot.timeUs >= rejected.timeUs + 100_000
          && (!calibration || (snapshot.diagnostic?.result?.finishedAtUs ?? 0) > rejected.timeUs)) {
          afterRejection = snapshot
          simulation.postMessage({ schemaVersion: 1, runId, seq: 2, kind: 'reveal' })
        } else if (afterRejection && snapshot.phase === 'completed') {
          finish(undefined, snapshot)
        }
      }
      inference.postMessage({ schemaVersion: 1, runId, port: inferenceChannel.port1 }, [inferenceChannel.port1])
      simulation.postMessage({
        schemaVersion: 1, runId, seq: 0, kind: 'start', profileId: 'synthetic-oil-turbulent-v1', pace: 4,
        port: simulationChannel.port1,
        ...(calibration ? { diagnosticRelease: { calibration, expectedHashes: calibration.hashes } } : {}),
      }, [simulationChannel.port1])
    })
  }, { assets, calibration })
}

function expectRejected(outcome: Awaited<ReturnType<typeof exercisePassiveGuard>>) {
  expect(outcome.rejected.phase).toBe('running')
  expect(outcome.rejected.message).toBe('Активный опыт недоступен без квалифицированного предложения.')
  expect(outcome.rejected.appliedTimeUs).toBeNull()
  expect(outcome.afterRejection.timeUs).toBeGreaterThanOrEqual(outcome.rejected.timeUs + 100_000)
  expect(outcome.final.replay).not.toBeNull()
  expect(outcome.final.replay?.endedAtUs).toBeGreaterThanOrEqual(outcome.afterRejection.timeUs)
  expect(outcome.final.replay?.events.filter(({ kind }) => kind === 'active-pulse')).toEqual([])
  expect(outcome.final.replay?.activeAbort).toBeUndefined()
  expect(outcome.simulationMessages).not.toContain('proposal')
  expect(outcome.inferenceMessages).not.toContain('experiment-proposal')
  expect(outcome.inferenceMessages).toContain('residual')
}

test('rejects active experiment acceptance in the built synthetic demo', async ({ page }) => {
  test.setTimeout(60_000)
  const files = await readdir('dist/assets')
  const simulation = files.find((file) => file.startsWith('simulation.worker-') && file.endsWith('.js'))
  const inference = files.find((file) => file.startsWith('inference.worker-') && file.endsWith('.js'))
  if (!simulation || !inference) throw new Error('Missing production Worker assets')
  await page.goto('/')
  const outcome = await exercisePassiveGuard(page, { simulation: `/assets/${simulation}`, inference: `/assets/${inference}` })
  expectRejected(outcome)
  expect(outcome.bridgeRequests).not.toContain('configure')
})

test('rejects active experiment acceptance with a passive calibration fixture', async ({ page }) => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'pipetwin-passive-e2e-'))
  try {
    const provenance = await buildPacedHarness(process.cwd(), directory)
    const host = await servePacedHarness(directory)
    try {
      const simulation = host.assets.find(({ name }) => name.includes('/simulation.worker-'))?.name
      const inference = host.assets.find(({ name }) => name.includes('/inference.worker-'))?.name
      if (!simulation || !inference) throw new Error('Missing test-mode Worker assets')
      await page.goto(host.url)
      const calibration = schedulerFixture('synthetic-oil-nominal-v1', provenance.sourceHashes)
      const outcome = await exercisePassiveGuard(page, { simulation: `/${simulation}`, inference: `/${inference}` }, calibration)
      expectRejected(outcome)
      expect(outcome.bridgeRequests).toContain('configure')
      expect(outcome.bridgeRequests).toContain('inverse')
      const result = outcome.afterRejection.diagnostic?.result
      expect(result).toBeTruthy()
      expect(result!.finishedAtUs).toBeGreaterThan(outcome.rejected.timeUs)
      const audit = outcome.final.replay?.inferenceAudit
      expect(audit?.jobs).toContainEqual(expect.objectContaining({ jobId: result!.jobId, finishedAtUs: result!.finishedAtUs }))
      expect(audit?.jobs.find(({ jobId }) => jobId === result!.jobId)?.closure).toBeUndefined()
      expect(audit?.transitions).toContainEqual(['committed', result!.jobId, result!.finishedAtUs])
    } finally {
      await host.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
