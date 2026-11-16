/// <reference types="@webgpu/types" />
import computeShader from './scenario.wgsl?raw'

export const SCENARIO_COUNT = 7
export const SCENARIO_RESOLUTION_MM = 0.0001
const UNITS_PER_MM = 1 / SCENARIO_RESOLUTION_MM
const MAX_THICKNESS_UNITS = Math.floor(0xffffffff / SCENARIO_COUNT)
const WORKGROUP_SIZE = 64

export type ScenarioRow = {
  segmentId: number
  thicknessMm: readonly [number, number, number, number, number, number, number]
}

export type ScenarioResult = {
  segmentCount: number
  thresholdCount: number
  meansMm: Float64Array
  belowCounts: Uint32Array
}

function encodeMm(value: number, label: string): number {
  const units = Math.round(value * UNITS_PER_MM)
  if (!Number.isFinite(value) || value < 0 || units > MAX_THICKNESS_UNITS) {
    throw new RangeError(`Invalid scenario ${label} in millimeters`)
  }
  return units
}

function encode(rows: readonly ScenarioRow[], thresholdsMm: readonly number[]) {
  const thickness = new Uint32Array(rows.length * SCENARIO_COUNT)
  const segmentIds = new Set<number>()
  for (const [rowIndex, row] of rows.entries()) {
    if (!Number.isSafeInteger(row.segmentId) || row.segmentId < 0 || segmentIds.has(row.segmentId)) {
      throw new RangeError('Invalid or duplicate scenario segment ID')
    }
    segmentIds.add(row.segmentId)
    if (row.thicknessMm.length !== SCENARIO_COUNT) {
      throw new RangeError('Each segment requires seven scenario thickness values')
    }
    for (const [scenarioIndex, value] of row.thicknessMm.entries()) {
      thickness[rowIndex * SCENARIO_COUNT + scenarioIndex] = encodeMm(value, 'thickness')
    }
  }
  return { thickness, thresholds: Uint32Array.from(thresholdsMm, (value) => encodeMm(value, 'threshold')) }
}

function toMeanMm(sum: number): number {
  return sum / (SCENARIO_COUNT * UNITS_PER_MM)
}

export function runCpu(rows: readonly ScenarioRow[], thresholdsMm: readonly number[]): ScenarioResult {
  const { thickness, thresholds } = encode(rows, thresholdsMm)
  const segmentCount = rows.length
  const thresholdCount = thresholds.length
  const meansMm = new Float64Array(segmentCount)
  const belowCounts = new Uint32Array(segmentCount * thresholdCount)
  for (let row = 0; row < segmentCount; row++) {
    let sum = 0
    for (let scenario = 0; scenario < SCENARIO_COUNT; scenario++) {
      sum += thickness[row * SCENARIO_COUNT + scenario]!
    }
    meansMm[row] = toMeanMm(sum)
  }
  for (const [thresholdIndex, threshold] of thresholds.entries()) {
    for (let row = 0; row < segmentCount; row++) {
      let count = 0
      for (let scenario = 0; scenario < SCENARIO_COUNT; scenario++) {
        if (thickness[row * SCENARIO_COUNT + scenario]! < threshold) count++
      }
      belowCounts[thresholdIndex * segmentCount + row] = count
    }
  }
  return { segmentCount, thresholdCount, meansMm, belowCounts }
}

type GpuContext = { device: GPUDevice; pipeline: GPUComputePipeline }
let gpuContext: Promise<GpuContext> | undefined

function getGpuContext(): Promise<GpuContext> {
  if (gpuContext) return gpuContext
  const pending = (async () => {
    const gpu = globalThis.navigator?.gpu
    if (!gpu) throw new Error('WebGPU is unavailable in this browser')
    const adapter = await gpu.requestAdapter()
    if (!adapter) throw new Error('WebGPU returned no compatible adapter')
    const device = await adapter.requestDevice()
    void device.lost.then(() => {
      if (gpuContext === pending) gpuContext = undefined
    })
    try {
      const module = device.createShaderModule({ code: computeShader })
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto', compute: { module, entryPoint: 'aggregate' },
      })
      return { device, pipeline }
    } catch (error) {
      device.destroy()
      throw error
    }
  })()
  gpuContext = pending
  void pending.catch(() => {
    if (gpuContext === pending) gpuContext = undefined
  })
  return pending
}

function makeInput(
  device: GPUDevice, buffers: GPUBuffer[], values: Uint32Array<ArrayBuffer>, usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({ size: values.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
  buffers.push(buffer)
  device.queue.writeBuffer(buffer, 0, values)
  return buffer
}

function dispatchSize(
  device: GPUDevice, inputsBytes: readonly number[], outputBytes: number, invocations: number,
): { x: number; y: number } {
  const maxStorageBytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize)
  const workgroups = Math.ceil(invocations / WORKGROUP_SIZE)
  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension
  const x = Math.min(workgroups, maxWorkgroups)
  const y = Math.ceil(workgroups / x)
  if ([...inputsBytes, outputBytes].some((size) => size > maxStorageBytes)
      || y > maxWorkgroups || invocations + x * WORKGROUP_SIZE > 0xffffffff) {
    throw new RangeError('Scenario batch exceeds WebGPU device limits')
  }
  return { x, y }
}

function submit(
  device: GPUDevice, pipeline: GPUComputePipeline, workgroups: { x: number; y: number },
  inputs: readonly GPUBuffer[], output: GPUBuffer, readback: GPUBuffer,
): void {
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [...inputs, output].map((buffer, binding) => ({ binding, resource: { buffer } })),
  })
  const commands = device.createCommandEncoder()
  const pass = commands.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.dispatchWorkgroups(workgroups.x, workgroups.y)
  pass.end()
  commands.copyBufferToBuffer(output, 0, readback, 0, output.size)
  device.queue.submit([commands.finish()])
}

async function checkedDispatch(device: GPUDevice, dispatch: () => GPUBuffer): Promise<GPUBuffer> {
  const filters = ['internal', 'out-of-memory', 'validation'] as const
  for (const filter of filters) device.pushErrorScope(filter)
  let readback: GPUBuffer
  try {
    readback = dispatch()
  } catch (error) {
    await Promise.allSettled(filters.map(() => device.popErrorScope()))
    throw error
  }
  // Pop synchronously before letting another call enter its own scopes.
  const errors = await Promise.all(filters.map(() => device.popErrorScope()))
  const failure = errors.find((error) => error !== null)
  if (failure) throw new Error(`WebGPU scenario dispatch failed: ${failure.message}`)
  return readback
}

export async function runGpu(
  rows: readonly ScenarioRow[], thresholdsMm: readonly number[],
): Promise<ScenarioResult> {
  if (rows.length === 0 || thresholdsMm.length === 0) return runCpu(rows, thresholdsMm)
  const { thickness, thresholds } = encode(rows, thresholdsMm)
  const segmentCount = rows.length
  const thresholdCount = thresholds.length
  const count = segmentCount * thresholdCount
  const outputBytes = (segmentCount + count) * Uint32Array.BYTES_PER_ELEMENT
  const { device, pipeline } = await getGpuContext()
  const workgroups = dispatchSize(device, [thickness.byteLength, thresholds.byteLength], outputBytes, count)
  const buffers: GPUBuffer[] = []
  try {
    const readback = await checkedDispatch(device, () => {
      const config = makeInput(
        device, buffers, new Uint32Array([segmentCount, thresholdCount, 0, 0]), GPUBufferUsage.UNIFORM,
      )
      const values = makeInput(device, buffers, thickness, GPUBufferUsage.STORAGE)
      const thresholdsBuffer = makeInput(device, buffers, thresholds, GPUBufferUsage.STORAGE)
      const output = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
      buffers.push(output)
      const copy = device.createBuffer({ size: outputBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
      buffers.push(copy)
      submit(device, pipeline, workgroups, [config, values, thresholdsBuffer], output, copy)
      return copy
    })
    await readback.mapAsync(GPUMapMode.READ)
    const results = new Uint32Array(readback.getMappedRange())
    return {
      segmentCount,
      thresholdCount,
      meansMm: Float64Array.from(results.subarray(0, segmentCount), toMeanMm),
      belowCounts: results.slice(segmentCount),
    }
  } finally {
    for (const buffer of buffers) buffer.destroy()
  }
}
