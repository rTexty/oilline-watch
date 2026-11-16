import { expect, test } from '@playwright/test'
import { createChromiumHeapProbe } from '../../tools/chromium-heap-probe'

test('samples distinct worker heaps across retirement and restart', async ({ page }) => {
  test.setTimeout(45_000)
  await page.goto('about:blank')
  const probe = await createChromiumHeapProbe(page)
  const startWorkers = () => page.evaluate(async () => {
    const state = globalThis as typeof globalThis & { heapWorkers?: Worker[]; heapWorkerUrls?: string[] }
    const urls = Array.from({ length: 2 }, () => URL.createObjectURL(new Blob([
      'const retained = new Float64Array(1024 * 128); retained.fill(42); postMessage("ready"); onmessage = () => postMessage(retained[0]);',
    ], { type: 'text/javascript' })))
    const workers = urls.map((url) => new Worker(url))
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.onmessage = () => resolve()
      worker.onerror = () => reject(new Error('Worker failed to start'))
    })))
    state.heapWorkers = workers
    state.heapWorkerUrls = urls
  })
  const retireWorkers = () => page.evaluate(() => {
    const state = globalThis as typeof globalThis & { heapWorkers?: Worker[]; heapWorkerUrls?: string[] }
    state.heapWorkers?.forEach((worker) => worker.terminate())
    state.heapWorkerUrls?.forEach((url) => URL.revokeObjectURL(url))
    delete state.heapWorkers
    delete state.heapWorkerUrls
  })
  try {
    await startWorkers()
    const first = await probe.sample(2)
    expect(first.targets.map((target) => target.type).sort()).toEqual(['page', 'worker', 'worker'])
    expect(new Set(first.targets.map((target) => target.targetId)).size).toBe(3)
    expect(first.usedSize).toBe(first.targets.reduce((sum, target) => sum + target.usedSize, 0))
    expect(first.totalSize).toBe(first.targets.reduce((sum, target) => sum + target.totalSize, 0))
    expect(first.targets.every((target) => Number.isFinite(target.usedSize) && target.usedSize > 0
      && Number.isFinite(target.totalSize) && target.totalSize >= target.usedSize)).toBe(true)
    const mainId = first.targets.find((target) => target.type === 'page')!.targetId
    const oldWorkerIds = first.targets.filter((target) => target.type === 'worker').map((target) => target.targetId)

    await retireWorkers()
    await probe.collectMainGarbage()
    const retired = await probe.sample(0)
    expect(retired.targets.map((target) => target.targetId)).toEqual([mainId])
    expect(retired.usedSize).toBe(retired.targets[0]!.usedSize)
    expect(retired.totalSize).toBe(retired.targets[0]!.totalSize)

    await startWorkers()
    const restarted = await probe.sample(2)
    expect(restarted.targets.find((target) => target.type === 'page')?.targetId).toBe(mainId)
    const newWorkerIds = restarted.targets.filter((target) => target.type === 'worker').map((target) => target.targetId)
    expect(new Set(newWorkerIds).size).toBe(2)
    expect(newWorkerIds.every((id) => !oldWorkerIds.includes(id))).toBe(true)
    expect(restarted.usedSize).toBe(restarted.targets.reduce((sum, target) => sum + target.usedSize, 0))
    expect(restarted.totalSize).toBe(restarted.targets.reduce((sum, target) => sum + target.totalSize, 0))
  } finally {
    await retireWorkers()
    await probe.close()
  }
})

test('fails closed when the expected worker is absent', async ({ page }) => {
  test.setTimeout(20_000)
  await page.goto('about:blank')
  const probe = await createChromiumHeapProbe(page)
  try {
    await expect(probe.sample(1)).rejects.toThrow()
  } finally {
    await probe.close()
  }
})
