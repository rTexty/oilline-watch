/// <reference types="@webgpu/types" />
import { predictionCheckpointSchema } from '../contracts/inference'
import type { PublicPredictionCheckpoint } from '../contracts/inference'
import { appliedControlSchema } from '../contracts/public'
import type { AppliedControl } from '../contracts/public'
import shaderCode from './oil-batch.wgsl?raw'

const MODEL_STEP_US = 5_000
const OBSERVATION_STEP_US = 10_000
const MAX_STEPS = 6800
const MAX_CANDIDATES = 512
const MAX_CONTROLS = 1000
const NODE_COUNT = 201
const CHANNELS = 4
const CANDIDATE_BYTES = 16
const CONFIG_BYTES = 16
const CHECKPOINT_BYTES = NODE_COUNT * 3 * Float32Array.BYTES_PER_ELEMENT
const MAX_RESERVED_BYTES = 64 * 1024 * 1024
// The shader implements the constants in this exact canonical anchor.
const ANCHOR_HASH = '53805cd8565530f268423635b0fdd41d0e0cf33fdfc9057b3b50fa3ebca4f9b0'
const PROFILE_ID = 'synthetic-oil-turbulent-v1'
const MODEL_VERSION = '1'
const PROFILE_HORIZON_US = 330_000_000
const INLET_PRESSURE_PA = 1_200_000
const OUTLET_FLOW_M3S = 0.02513274122871835
const TEMPERATURE_K = 313.15
const MIN_FLOW = 4000 * 0.00001 / 0.2 * (Math.PI * 0.2 ** 2 / 4)
const MAX_FLOW = 1e8 * 0.00001 / 0.2 * (Math.PI * 0.2 ** 2 / 4)

export interface GpuCandidate {
  readonly id: number
  readonly node: number
  readonly onsetUs: number
  readonly rampUs: number
  readonly cdAreaM2: number
}

export interface GpuBatchRequest {
  readonly checkpoint: PublicPredictionCheckpoint
  readonly windowStartUs: number
  readonly windowEndUs: number
  readonly controls: readonly AppliedControl[]
  readonly candidates: readonly GpuCandidate[]
}

export type GpuFallbackReason = 'disabled' | 'unavailable' | 'ineligible' | 'resource-limit'
  | 'invalid-result' | 'device-lost' | 'gpu-error' | 'deadline' | 'cancelled'

interface GpuLayout {
  readonly eligible: true
  readonly steps: number
  readonly firstSampleStep: number
  readonly stride: number
  readonly outputBytes: number
  readonly statusBytes: number
  readonly reservedBytes: number
}

function gridTime(value: number, step: number) {
  return Number.isSafeInteger(value) && value >= 0 && value % step === 0
}

function validCandidate(value: GpuCandidate, startUs: number, endUs: number) {
  return Number.isSafeInteger(value.id) && value.id >= 0 && value.id <= 65_535
    && Number.isSafeInteger(value.node) && value.node >= 1 && value.node < NODE_COUNT - 1
    && gridTime(value.onsetUs, MODEL_STEP_US) && value.onsetUs >= startUs && value.onsetUs <= endUs
    && gridTime(value.rampUs, MODEL_STEP_US) && value.rampUs <= 20_000_000
    && Number.isFinite(value.cdAreaM2) && value.cdAreaM2 >= 0 && value.cdAreaM2 <= 4e-5
}

function controlOverlaps(control: AppliedControl, startUs: number, endUs: number) {
  const duration = control.kind === 'active-pulse'
    ? control.pulse.rampUs + control.pulse.holdUs + control.pulse.returnUs : control.rampUs
  return control.appliedTimeUs <= endUs && control.appliedTimeUs + duration >= startUs
}

function nominalBoundary(checkpoint: PublicPredictionCheckpoint) {
  const { boundaries: { pinPa, qoutM3s, tinK, ambientK }, oilTemperatureK, wallTemperatureK } = checkpoint
  return (pinPa ?? INLET_PRESSURE_PA) === INLET_PRESSURE_PA
    && (qoutM3s ?? OUTLET_FLOW_M3S) === OUTLET_FLOW_M3S
    && (tinK ?? TEMPERATURE_K) === TEMPERATURE_K && (ambientK ?? TEMPERATURE_K) === TEMPERATURE_K
    && [oilTemperatureK, wallTemperatureK].every((field) => field.every((value) => Math.abs(value - TEMPERATURE_K) <= 1e-9))
}

function nominalCheckpoint(checkpoint: PublicPredictionCheckpoint) {
  const parsed = predictionCheckpointSchema.safeParse(checkpoint)
  return parsed.success && checkpoint.parameterHash === ANCHOR_HASH && checkpoint.profileId === PROFILE_ID
    && checkpoint.modelVersion === MODEL_VERSION && checkpoint.grid.spacingM === 5
    && checkpoint.splittingPhase === 'hydraulic' && checkpoint.memory.kind === 'none' && nominalBoundary(checkpoint)
    && checkpoint.leftFlowM3s.every((flow, i) => flow >= MIN_FLOW && flow <= MAX_FLOW && flow === checkpoint.rightFlowM3s[i])
    && checkpoint.previousFlux.inletFlowM3s === checkpoint.leftFlowM3s[0]
    && checkpoint.previousFlux.outletFlowM3s === checkpoint.rightFlowM3s[NODE_COUNT - 1]
}

export function inspectGpuBatch(request: GpuBatchRequest): GpuLayout | { readonly eligible: false } {
  const { checkpoint, candidates, controls, windowStartUs, windowEndUs } = request
  const timeUs = checkpoint.timeUs
  const steps = (windowEndUs - timeUs) / MODEL_STEP_US
  const firstSampleStep = (windowStartUs - timeUs) / MODEL_STEP_US
  const windowLengthUs = windowEndUs - windowStartUs
  if (checkpoint.anchorId !== 0 || checkpoint.grid.nodeCount !== NODE_COUNT
    || !gridTime(timeUs, MODEL_STEP_US) || !gridTime(windowStartUs, OBSERVATION_STEP_US)
    || !gridTime(windowEndUs, OBSERVATION_STEP_US) || windowEndUs > PROFILE_HORIZON_US
    || (windowLengthUs !== 4_000_000 && windowLengthUs !== 30_000_000)
    || steps <= 0 || steps > MAX_STEPS || firstSampleStep < 0
    || candidates.length < 1 || candidates.length > MAX_CANDIDATES
    || !candidates.every((value) => validCandidate(value, timeUs, windowEndUs))
    || new Set(candidates.map(({ id }) => id)).size !== candidates.length
    || controls.length > MAX_CONTROLS || controls.some((control) => !appliedControlSchema.safeParse(control).success
      || controlOverlaps(control, timeUs, windowEndUs))
    || !nominalCheckpoint(checkpoint)) return { eligible: false }

  const stride = (windowLengthUs / OBSERVATION_STEP_US + 1) * CHANNELS
  const outputBytes = stride * Float32Array.BYTES_PER_ELEMENT * candidates.length
  const statusBytes = candidates.length * Uint32Array.BYTES_PER_ELEMENT
  const inputBytes = candidates.length * CANDIDATE_BYTES + CONFIG_BYTES + CHECKPOINT_BYTES
  // Includes host staging, GPU storage/readback, mapped range and owned output copy.
  const reservedBytes = 2 * inputBytes + 4 * outputBytes + 3 * statusBytes
  return { eligible: true, steps, firstSampleStep, stride, outputBytes, statusBytes, reservedBytes }
}

function packCandidates(request: GpuBatchRequest) {
  const input = new ArrayBuffer(request.candidates.length * CANDIDATE_BYTES)
  const view = new DataView(input)
  for (const [index, candidate] of request.candidates.entries()) {
    const offset = index * CANDIDATE_BYTES
    view.setUint32(offset, candidate.node, true)
    view.setUint32(offset + 4, (candidate.onsetUs - request.checkpoint.timeUs) / MODEL_STEP_US, true)
    view.setUint32(offset + 8, candidate.rampUs / MODEL_STEP_US, true)
    view.setFloat32(offset + 12, candidate.cdAreaM2, true)
  }
  return input
}

function packCheckpoint(checkpoint: PublicPredictionCheckpoint) {
  const nodes = new Float32Array(NODE_COUNT * 3)
  for (let i = 0; i < NODE_COUNT; i++) {
    nodes[i * 3] = checkpoint.pressurePa[i]! - INLET_PRESSURE_PA
    nodes[i * 3 + 1] = checkpoint.leftFlowM3s[i]!
    nodes[i * 3 + 2] = checkpoint.rightFlowM3s[i]!
  }
  return nodes
}

export interface GpuApproximateTrace {
  readonly precision: 'approximate-f32'
  readonly candidateIds: readonly number[]
  readonly windowStartUs: number
  readonly stride: number
  readonly samples: Float32Array<ArrayBuffer>
  /** Release the reservation after all reads of the trace finish. */
  release(): void
}

export interface GpuBudget {
  readonly deadlineMs: number
  readonly signal?: AbortSignal
}

export interface GpuBatchBackend {
  readonly shaderSha256: string
  run(request: GpuBatchRequest, budget: GpuBudget): Promise<GpuApproximateTrace>
  close(): void
}

export class GpuBatchError extends Error {
  constructor(readonly reason: GpuFallbackReason, message: string) { super(message) }
}

function stopReason({ deadlineMs, signal }: GpuBudget) {
  if (signal?.aborted) return 'cancelled'
  if (!Number.isFinite(deadlineMs) || performance.now() >= deadlineMs) return 'deadline'
  return null
}

async function withDeadline<T>(operation: Promise<T>, budget: GpuBudget, lost: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  let loss: (() => void) | undefined
  const stopping = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new GpuBatchError('cancelled', 'GPU job was cancelled'))
    loss = () => reject(new GpuBatchError('device-lost', 'WebGPU device was lost during dispatch'))
    budget.signal?.addEventListener('abort', abort, { once: true })
    lost.addEventListener('abort', loss, { once: true })
    if (budget.signal?.aborted) abort()
    if (lost.aborted) loss()
    timer = setTimeout(() => reject(new GpuBatchError('deadline', 'GPU job exceeded its deadline')),
      Math.max(0, budget.deadlineMs - performance.now()))
  })
  try {
    return await Promise.race([operation, stopping])
  } finally {
    clearTimeout(timer)
    if (abort) budget.signal?.removeEventListener('abort', abort)
    if (loss) lost.removeEventListener('abort', loss)
  }
}

function sha256(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
}

async function createPipeline(device: GPUDevice) {
  const module = device.createShaderModule({ code: shaderCode })
  const diagnostics = (await module.getCompilationInfo()).messages.filter(({ type }) => type === 'error')
  if (diagnostics.length > 0) throw new GpuBatchError('gpu-error', diagnostics.map(({ message }) => message).join('\n'))
  return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'simulate' } })
}

function canAllocate(device: GPUDevice, layout: GpuLayout, count: number) {
  const largestStorage = Math.max(layout.outputBytes, count * CANDIDATE_BYTES, CHECKPOINT_BYTES)
  return largestStorage <= device.limits.maxStorageBufferBindingSize
    && layout.outputBytes + layout.statusBytes <= device.limits.maxBufferSize
    && count <= device.limits.maxComputeWorkgroupsPerDimension
}

async function dispatch(
  device: GPUDevice, pipeline: GPUComputePipeline, request: GpuBatchRequest, layout: GpuLayout,
): Promise<Omit<GpuApproximateTrace, 'release'>> {
  const buffers: GPUBuffer[] = []
  const candidateIds = request.candidates.map(({ id }) => id)
  function buffer(size: number, usage: GPUBufferUsageFlags) {
    const value = device.createBuffer({ size, usage })
    buffers.push(value)
    return value
  }

  device.pushErrorScope('validation')
  let result: Omit<GpuApproximateTrace, 'release'> | undefined
  let failure: unknown
  try {
    const input = packCandidates(request)
    const candidates = buffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const config = buffer(CONFIG_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    const checkpoint = buffer(CHECKPOINT_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
    const output = buffer(layout.outputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const status = buffer(layout.statusBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
    const readback = buffer(layout.outputBytes + layout.statusBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST)
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [candidates, config, output, checkpoint, status].map((value, binding) => ({ binding, resource: { buffer: value } })),
    })
    device.queue.writeBuffer(candidates, 0, input)
    device.queue.writeBuffer(config, 0, new Uint32Array([layout.steps, layout.stride, layout.firstSampleStep, layout.steps]))
    device.queue.writeBuffer(checkpoint, 0, packCheckpoint(request.checkpoint))
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(candidateIds.length)
    pass.end()
    encoder.copyBufferToBuffer(output, 0, readback, 0, layout.outputBytes)
    encoder.copyBufferToBuffer(status, 0, readback, layout.outputBytes, layout.statusBytes)
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const mapped = readback.getMappedRange()
    if (new Uint32Array(mapped, layout.outputBytes).some((value) => value !== 0)) {
      throw new GpuBatchError('invalid-result', 'A GPU candidate left the qualified numerical domain')
    }
    const samples = new Float32Array(mapped, 0, layout.outputBytes / Float32Array.BYTES_PER_ELEMENT).slice()
    if (!samples.every((value, index) => index % CHANNELS === 3
      ? Number.isFinite(value) && value > 0 : value >= 250_000 && value <= 2_000_000)) {
      throw new GpuBatchError('invalid-result', 'GPU output contained invalid samples')
    }
    result = {
      precision: 'approximate-f32', windowStartUs: request.windowStartUs, stride: layout.stride,
      candidateIds, samples,
    }
  } catch (error) {
    failure = error
  } finally {
    for (const item of buffers) item.destroy()
  }
  const validation = await device.popErrorScope()
  if (validation) throw new GpuBatchError('gpu-error', validation.message)
  if (!result) throw failure ?? new GpuBatchError('gpu-error', 'GPU dispatch produced no result')
  return result
}

export async function createGpuBatchBackend(options: {
  readonly gpu?: GPU
  /** Optional worker-level accounting for all concurrent numerical allocations. */
  readonly reserve?: (bytes: number) => (() => void) | null
} = {}): Promise<GpuBatchBackend> {
  const adapter = await (options.gpu ?? globalThis.navigator?.gpu)?.requestAdapter()
  if (!adapter) throw new GpuBatchError('unavailable', 'WebGPU adapter unavailable')
  const device = await adapter.requestDevice()
  let closed = false
  let busy = false
  let reservedBytes = 0
  const loss = new AbortController()
  const close = () => {
    if (closed) return
    closed = true
    loss.abort()
    device.destroy()
  }
  void device.lost.then(() => { closed = true; loss.abort() })
  try {
    const pipeline = await createPipeline(device)
    const shaderHash = sha256(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shaderCode)))
    return {
      shaderSha256: shaderHash,
      close,
      async run(request, budget) {
        const ended = stopReason(budget)
        if (ended) throw new GpuBatchError(ended, 'GPU job no longer has an active budget')
        if (closed) throw new GpuBatchError('device-lost', 'WebGPU device is no longer available')
        if (busy) throw new GpuBatchError('resource-limit', 'A GPU batch is already active')
        const layout = inspectGpuBatch(request)
        if (!layout.eligible) throw new GpuBatchError('ineligible', 'GPU batch is outside the nominal profile')
        const afterValidation = stopReason(budget)
        if (afterValidation) throw new GpuBatchError(afterValidation, 'GPU budget ended before dispatch')
        if (closed) throw new GpuBatchError('device-lost', 'WebGPU device was lost during batch validation')
        if (busy || reservedBytes + layout.reservedBytes > MAX_RESERVED_BYTES
          || !canAllocate(device, layout, request.candidates.length)) {
          throw new GpuBatchError('resource-limit', 'GPU batch exceeds available numerical resources')
        }
        const bytes = layout.reservedBytes
        const releaseWorker = options.reserve ? options.reserve(bytes) : () => {}
        if (!releaseWorker) throw new GpuBatchError('resource-limit', 'GPU batch exceeded the worker reservation budget')
        reservedBytes += bytes
        let released = false
        function release() {
          if (released) return
          released = true
          reservedBytes -= bytes
          releaseWorker!()
        }
        busy = true
        const work = dispatch(device, pipeline, request, layout)
          .then((trace) => ({ ...trace, release }))
          .finally(() => { busy = false })
        try {
          const trace = await withDeadline(work, budget, loss.signal)
          const ended = stopReason(budget)
          if (ended) throw new GpuBatchError(ended, 'GPU job ended before its result was accepted')
          return trace
        } catch (error) {
          // A timed out dispatch may still own device storage until mapAsync settles.
          void work.then(release, release)
          if (closed) throw new GpuBatchError('device-lost', 'WebGPU device was lost during dispatch')
          throw error
        }
      },
    }
  } catch (error) {
    device.destroy()
    throw error
  }
}

export type GpuRoute<T> =
  | { readonly kind: 'completed'; readonly route: 'cpu' | 'gpu-screened'; readonly reason: GpuFallbackReason | null; readonly value: T }
  | { readonly kind: 'incomplete'; readonly reason: 'deadline' | 'cancelled' }

/** GPU output can only assist the required F64 evaluation. */
export async function routeGpuBatch<T>(
  request: GpuBatchRequest,
  options: GpuBudget & {
    readonly gpuEnabled?: boolean
    readonly gpu?: GpuBatchBackend
    readonly cpu: (input: GpuBudget & { readonly approximate: GpuApproximateTrace | null }) => Promise<T>
  },
): Promise<GpuRoute<T>> {
  const budget: GpuBudget = { deadlineMs: options.deadlineMs, signal: options.signal }
  const before = stopReason(budget)
  if (before) return { kind: 'incomplete', reason: before }
  let reason: GpuFallbackReason | null = null
  let approximate: GpuApproximateTrace | null = null
  if (!options.gpuEnabled) reason = 'disabled'
  else if (!options.gpu) reason = 'unavailable'
  else {
    try {
      approximate = await options.gpu.run(request, budget)
    } catch (error) {
      reason = error instanceof GpuBatchError ? error.reason : 'gpu-error'
    }
  }
  const beforeCpu = stopReason(budget)
  try {
    if (beforeCpu) return { kind: 'incomplete', reason: beforeCpu }
    const value = await options.cpu({ ...budget, approximate })
    const afterCpu = stopReason(budget)
    return afterCpu ? { kind: 'incomplete', reason: afterCpu }
      : { kind: 'completed', route: approximate ? 'gpu-screened' : 'cpu', reason, value }
  } finally {
    approximate?.release()
  }
}
