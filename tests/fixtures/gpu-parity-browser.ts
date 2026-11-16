import { profileSchema } from '../../src/contracts/model'
import { advanceTo } from '../../src/physics/advance-to'
import { initialize } from '../../src/physics/initialize'
import type { HydraulicState, PhysicsResult } from '../../src/physics/state'
import { createGpuBatchBackend } from '../../src/runtime/inference-gpu'
import type { GpuBatchRequest } from '../../src/runtime/inference-gpu'
import profileJson from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { createCheckpointAnchor, makeCheckpoint } from '../../src/twin/checkpoint'

function unwrap(result: PhysicsResult) {
  if (!result.ok) throw result.error
  return result.value
}

function compareWindow(start: HydraulicState, request: GpuBatchRequest, samples: Float32Array, stride: number) {
  let pressurePa = 0
  let flowM3s = 0
  for (const [index, candidate] of request.candidates.entries()) {
    let current = start
    const leak = { node: candidate.node, onsetUs: candidate.onsetUs, rampUs: candidate.rampUs, cdA: candidate.cdAreaM2 }
    let offset = index * stride
    for (let at = request.windowStartUs; at <= request.windowEndUs; at += 10_000) {
      current = unwrap(advanceTo(current, at, { leak }))
      for (const node of [20, 100, 180]) {
        pressurePa = Math.max(pressurePa, Math.abs(current.p[node]! - samples[offset++]!))
      }
      flowM3s = Math.max(flowM3s, Math.abs(current.qL[0]! - samples[offset++]!))
    }
  }
  return { pressurePa, flowM3s }
}

export async function testPackedGpu() {
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter in Chromium')
  const profile = profileSchema.parse(profileJson)
  const anchor = await createCheckpointAnchor(0, profile)
  const initial = unwrap(initialize(profile))
  const past = unwrap(advanceTo(initial, 45_000, undefined, [
    { timeUs: 5_000, inputs: { pinPa: 1_202_000 } },
    { timeUs: 25_000, inputs: { pinPa: 1_200_000 } },
  ]))
  const requests: readonly [HydraulicState, GpuBatchRequest][] = [
    [past, {
      checkpoint: makeCheckpoint(past, anchor),
      windowStartUs: 3_050_000, windowEndUs: 7_050_000, controls: [],
      candidates: Array.from({ length: 32 }, (_, id) => ({
        id, node: 1 + 6 * id, onsetUs: 105_000 + id * 5_000, rampUs: id % 2 ? 0 : 1_000_000,
        cdAreaM2: 4e-5 * id / 31,
      })),
    }],
    [initial, {
      checkpoint: makeCheckpoint(initial, anchor),
      windowStartUs: 4_000_000, windowEndUs: 34_000_000, controls: [],
      candidates: [{ id: 44, node: 199, onsetUs: 165_000, rampUs: 20_000_000, cdAreaM2: 2e-5 }],
    }],
  ]
  let reservedBytes = 0
  const gpu = await createGpuBatchBackend({ reserve: (bytes) => {
    reservedBytes += bytes
    return () => { reservedBytes -= bytes }
  } })
  try {
    const results = []
    for (const [start, request] of requests) {
      const gpuStarted = performance.now()
      const trace = await gpu.run(request, { deadlineMs: performance.now() + 30_000 })
      try {
        const gpuMs = performance.now() - gpuStarted
        if (reservedBytes <= trace.samples.byteLength) throw new Error('Trace reservation released too early')
        const referenceStarted = performance.now()
        results.push({
          count: trace.candidateIds.length, width: trace.stride, startUs: trace.windowStartUs,
          ...compareWindow(start, request, trace.samples, trace.stride),
          gpuMs, referenceMs: performance.now() - referenceStarted,
        })
      } finally {
        trace.release()
        trace.release()
      }
      if (reservedBytes !== 0) throw new Error('Trace reservation was not released exactly once')
    }
    return { results, shaderSha256: gpu.shaderSha256, adapter: {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      isFallbackAdapter: adapter.info.isFallbackAdapter,
    } }
  } finally {
    gpu.close()
  }
}
