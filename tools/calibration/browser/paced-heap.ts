import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
import { createChromiumHeapProbe } from '../../chromium-heap-probe'

const SAMPLE_INTERVAL_MS = 1000
const EXPECTED_WORKERS = 2

export async function startPacedHeapSampling(page: Page) {
  const probe = await createChromiumHeapProbe(page)
  const controller = new AbortController()
  const startedAt = performance.now()
  const samples: ({ elapsedMs: number } & Awaited<ReturnType<typeof probe.sample>>)[] = []
  const failedSamples: { elapsedMs: number; reason: string }[] = []
  const sampling = (async () => {
    while (!controller.signal.aborted) {
      try {
        const sample = await probe.sample(EXPECTED_WORKERS)
        if (!controller.signal.aborted) samples.push({ elapsedMs: performance.now() - startedAt, ...sample })
      } catch (error) {
        if (!controller.signal.aborted) {
          failedSamples.push({
            elapsedMs: performance.now() - startedAt,
            reason: error instanceof Error ? error.message : 'Chromium heap sampling failed.',
          })
        }
      }
      await delay(SAMPLE_INTERVAL_MS, undefined, { signal: controller.signal }).catch((error: unknown) => {
        if (!controller.signal.aborted) throw error
      })
    }
  })()
  return async () => {
    controller.abort()
    await Promise.all([probe.close(), sampling])
    return {
      method: 'periodic Chromium Runtime.getHeapUsage for page and both DedicatedWorkers without forced GC',
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      samples,
      failedSamples,
      maxSampledUsedSize: samples.length ? Math.max(...samples.map(({ usedSize }) => usedSize)) : null,
      maxSampledTotalSize: samples.length ? Math.max(...samples.map(({ totalSize }) => totalSize)) : null,
    }
  }
}
