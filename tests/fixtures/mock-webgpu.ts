import { vi } from 'vitest'

type MockMode = 'valid' | 'invalid-candidate' | 'invalid-samples'

class Buffer {
  readonly bytes: ArrayBuffer
  readonly destroy = vi.fn()
  readonly mapAsync: () => Promise<void>
  constructor(size: number, map: () => Promise<void>) {
    this.bytes = new ArrayBuffer(size)
    this.mapAsync = map
  }
  getMappedRange() { return this.bytes }
}

interface Binding {
  readonly resource: { readonly buffer: Buffer }
}

export function mockGpu(options: { readonly mode?: MockMode; readonly deferredMap?: boolean; readonly storageLimit?: number } = {}) {
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_DST: 2, UNIFORM: 4, COPY_SRC: 8, MAP_READ: 16 })
  vi.stubGlobal('GPUMapMode', { READ: 1 })
  const map = Promise.withResolvers<void>()
  if (!options.deferredMap) map.resolve()
  const loss = Promise.withResolvers<void>()
  const buffers: Buffer[] = []
  const device = {
    limits: {
      maxStorageBufferBindingSize: options.storageLimit ?? 2 ** 28,
      maxBufferSize: 2 ** 28,
      maxComputeWorkgroupsPerDimension: 65_535,
    },
    lost: loss.promise,
    destroy: vi.fn(),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => null),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: ({ size }: { readonly size: number }) => {
      const buffer = new Buffer(size, () => map.promise)
      buffers.push(buffer)
      return buffer
    },
    createBindGroup: ({ entries }: { readonly entries: readonly Binding[] }) => entries,
    queue: {
      writeBuffer: (buffer: Buffer, offset: number, source: ArrayBuffer | ArrayBufferView) => {
        const bytes = source instanceof ArrayBuffer
          ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        new Uint8Array(buffer.bytes).set(bytes, offset)
      },
      submit: vi.fn(),
    },
    createCommandEncoder: () => ({
      beginComputePass() {
        let entries: readonly Binding[]
        return {
          setPipeline() {},
          setBindGroup(_index: number, bindings: readonly Binding[]) { entries = bindings },
          dispatchWorkgroups() {
            const out = new Float32Array(entries[2]!.resource.buffer.bytes)
            for (let i = 0; i < out.length; i++) out[i] = i % 4 === 3 ? 0.025 : 1_200_000
            if (options.mode === 'invalid-candidate') new Uint32Array(entries[4]!.resource.buffer.bytes)[0] = 1
            if (options.mode === 'invalid-samples') out[0] = Number.NaN
          },
          end() {},
        }
      },
      copyBufferToBuffer(source: Buffer, start: number, destination: Buffer, offset: number, size: number) {
        new Uint8Array(destination.bytes).set(new Uint8Array(source.bytes, start, size), offset)
      },
      finish() { return {} },
    }),
  }
  const gpu = { requestAdapter: async () => ({ requestDevice: async () => device }) } as unknown as GPU
  return { gpu, device, buffers, finishMap: map.resolve, lose: loss.resolve }
}
