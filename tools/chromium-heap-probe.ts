import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright'
import { z } from 'zod'

const COMMAND_TIMEOUT_MS = 2500
const commandOptions = { timeout: COMMAND_TIMEOUT_MS }
const bytes = z.number().int().nonnegative()
const heapUsageSchema = z.object({
  usedSize: bytes,
  totalSize: bytes,
  embedderHeapUsedSize: bytes.optional(),
  backingStorageSize: bytes.optional(),
}).refine(({ usedSize, totalSize }) => usedSize <= totalSize)
const replySchema = z.object({ id: z.number().int(), result: z.unknown().optional() })

export async function createChromiumHeapProbe(page: Page) {
  const session = await page.context().newCDPSession(page)
  const workers = new Map<string, { targetId: string; url: string }>()
  const pending = new Map<number, {
    readonly sessionId: string
    readonly resolve: (result: unknown) => void
    readonly reject: (error: Error) => void
  }>()
  let requestId = 0
  let closed = false

  session.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type === 'worker') workers.set(sessionId, { targetId: targetInfo.targetId, url: targetInfo.url })
  })
  session.on('Target.detachedFromTarget', ({ sessionId }) => {
    workers.delete(sessionId)
    for (const request of pending.values()) {
      if (request.sessionId === sessionId) request.reject(new Error('Worker retired during heap sampling.'))
    }
  })
  session.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const reply = replySchema.safeParse(JSON.parse(message))
    if (!reply.success) return
    const request = pending.get(reply.data.id)
    if (request?.sessionId === sessionId) request.resolve(reply.data.result)
  })
  session.on('close', () => {
    closed = true
    for (const request of pending.values()) request.reject(new Error('Chromium heap probe closed.'))
  })

  // Nested CDP sessions route DedicatedWorker commands through this page session.
  try {
    await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }, commandOptions)
  } catch (error) {
    await session.detach()
    throw error
  }

  async function workerHeap(sessionId: string) {
    const id = ++requestId
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    pending.set(id, { sessionId, resolve, reject })
    const timer = setTimeout(() => reject(new Error('Chromium Worker heap query timed out.')), COMMAND_TIMEOUT_MS)
    try {
      const [, result] = await Promise.all([
        session.send('Target.sendMessageToTarget', {
          sessionId, message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' }),
        }, commandOptions),
        promise,
      ])
      return heapUsageSchema.parse(result)
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  }

  async function sample(expectedWorkerCount: number) {
    if (!Number.isSafeInteger(expectedWorkerCount) || expectedWorkerCount < 0) throw new RangeError('Invalid expected Worker count.')
    const deadline = performance.now() + COMMAND_TIMEOUT_MS
    while (!closed && workers.size !== expectedWorkerCount && performance.now() < deadline) await delay(10)
    if (closed) throw new Error('Chromium heap probe closed.')
    if (workers.size !== expectedWorkerCount) {
      throw new Error(`Expected ${expectedWorkerCount} Worker heap targets, found ${workers.size}.`)
    }
    const before = [...workers]
    const [pageInfo, pageHeap, workerTargets] = await Promise.all([
      session.send('Target.getTargetInfo', {}, commandOptions),
      session.send('Runtime.getHeapUsage', {}, commandOptions),
      Promise.all(before.map(async ([sessionId, target]) => ({
        ...target, type: 'worker' as const, ...await workerHeap(sessionId),
      }))),
    ])
    if (workers.size !== before.length || before.some(([sessionId]) => !workers.has(sessionId))) {
      throw new Error('Chromium Worker heap targets changed during sampling.')
    }
    const { targetId, url } = pageInfo.targetInfo
    const targets = [{ type: 'page' as const, targetId, url, ...heapUsageSchema.parse(pageHeap) }, ...workerTargets]
    if (new Set(targets.map((target) => target.targetId)).size !== targets.length) {
      throw new Error('Chromium heap targets were duplicated.')
    }
    return {
      targets,
      usedSize: targets.reduce((sum, target) => sum + target.usedSize, 0),
      totalSize: targets.reduce((sum, target) => sum + target.totalSize, 0),
    }
  }

  return {
    sample,
    collectMainGarbage: () => session.send('HeapProfiler.collectGarbage', {}, commandOptions),
    close: async () => { if (!closed) await session.detach() },
  }
}
