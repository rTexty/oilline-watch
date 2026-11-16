import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildPacedHarness, servePacedHarness } from '../../tools/calibration/browser/paced-build'
import type { ProvisionalDiagnostic } from '../../src/contracts/inference'
import type { InverseProvisionalAudit } from '../../src/contracts/inference-audit'
import { schedulerFixture } from '../../tools/calibration/browser/scheduler-fixture'

type ReplayRecord = { inferenceAudit?: { jobs: readonly { provisional?: InverseProvisionalAudit }[] } }
type Preview = { timeUs: number; result: ProvisionalDiagnostic }

test('replays a real provisional diagnostic at its recorded model time', async ({ page }) => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'pipetwin-provisional-e2e-'))
  try {
    const provenance = await buildPacedHarness(process.cwd(), directory)
    const host = await servePacedHarness(directory)
    try {
      const simulation = host.assets.find(({ name }) => name.includes('/simulation.worker-'))?.name
      const inference = host.assets.find(({ name }) => name.includes('/inference.worker-'))?.name
      if (!simulation || !inference) throw new Error('Missing worker assets')
      const calibration = schedulerFixture('synthetic-oil-nominal-v1', provenance.sourceHashes)
      await page.goto(host.url)
      const outcome = await page.evaluate(async ({ simulation, inference, calibration }) => {
        const run = (replay?: ReplayRecord) => new Promise<{ replay: ReplayRecord; previews: Preview[]; verification: string; finalAfterReveal: boolean }>((resolve, reject) => {
          const runId = crypto.randomUUID()
          const sim = new Worker(`/${simulation}`, { type: 'module' })
          const infer = new Worker(`/${inference}`, { type: 'module' })
          const channel = new MessageChannel()
          const previews: Preview[] = []
          let revealed = false
          let finalAfterReveal = false
          const timeout = setTimeout(() => { sim.terminate(); infer.terminate(); reject(new Error(`Worker timeout: ${replay ? 'replay' : 'live'}, previews=${previews.length}`)) }, 26_000)
          sim.onerror = infer.onerror = () => { clearTimeout(timeout); sim.terminate(); infer.terminate(); reject(new Error('Worker error')) }
          sim.onmessage = ({ data }) => {
            const snapshot = data.snapshot
            if (!snapshot) return
            if (revealed && snapshot.diagnostic?.result) finalAfterReveal = true
            if (snapshot.diagnostic?.provisional) {
              previews.push({ timeUs: snapshot.timeUs, result: snapshot.diagnostic.provisional })
              if (!replay && !revealed) {
                revealed = true
                sim.postMessage({ schemaVersion: 1, runId, seq: 1, kind: 'reveal' })
              }
            }
            if (snapshot.phase === 'completed' || snapshot.phase === 'error') {
              clearTimeout(timeout); sim.terminate(); infer.terminate()
              if (snapshot.phase === 'error') reject(new Error(`Simulation error: ${snapshot.replayVerification}`))
              else resolve({ replay: snapshot.replay, previews, verification: snapshot.replayVerification, finalAfterReveal })
            }
          }
          infer.postMessage({ schemaVersion: 1, runId, port: channel.port2 }, [channel.port2])
          sim.postMessage({ schemaVersion: 1, runId, seq: 0, kind: 'start', profileId: calibration.profileId, pace: 4,
            port: channel.port1, diagnosticRelease: { calibration, expectedHashes: calibration.hashes }, ...(replay ? { replay } : {}) }, [channel.port1])
        })
        const live = await run()
        const repeated = await run(live.replay)
        return { live, repeated }
      }, { simulation, inference, calibration })
      const checkpoint = outcome.live.replay.inferenceAudit?.jobs.find((job) => job.provisional)?.provisional
      if (!checkpoint) throw new Error('Missing recorded provisional checkpoint')
      expect(outcome.live.previews.some(({ timeUs, result }) => timeUs === checkpoint.publishedAtUs && result.jobId === checkpoint.result.jobId)).toBe(true)
      expect(outcome.live.finalAfterReveal).toBe(false)
      expect(outcome.repeated.verification).toBe('verified')
      expect(outcome.repeated.previews.find(({ timeUs }) => timeUs === checkpoint.publishedAtUs)?.result).toEqual(checkpoint.result)
    } finally { await host.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
