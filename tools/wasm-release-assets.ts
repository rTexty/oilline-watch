import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { z } from 'zod'
import { sha256Schema } from '../src/contracts/calibration.ts'
import { profileSchema } from '../src/contracts/model.ts'
import { loadOilWasmBackend } from '../src/physics/wasm-adapter.ts'
import { resolveSimulationBackend } from '../src/runtime/wasm-runtime.ts'
import type { WasmDeployment } from '../src/runtime/wasm-runtime.ts'

const JSON_LIMIT = 16 * 1024
const WASM_LIMIT = 2 * 1024 * 1024
const GENERATED = 'src/generated/oil'
const PROFILE = 'src/scenarios/synthetic-oil-turbulent-v1.json'
const VARIANTS = ['scalar', 'simd'] as const
type WasmAsset = Parameters<WasmDeployment['read']>[0]
type Assets = ReadonlyMap<WasmAsset, Uint8Array<ArrayBuffer>>

interface ReleaseOptions {
  readonly root: string
  readonly qualificationSha256?: string
  readonly qualificationFile?: string
}

function artifact(variant: typeof VARIANTS[number]) {
  return z.strictObject({
    file: z.literal(`${variant}-polylog.wasm`),
    sha256: sha256Schema,
    byteLength: z.number().int().min(8).max(WASM_LIMIT),
    flags: z.tuple([
      z.literal(`-Ctarget-feature=${variant === 'simd' ? '+' : '-'}simd128`),
      z.literal(`-Clink-arg=--max-memory=${WASM_LIMIT}`),
    ]),
  })
}

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  abiVersion: z.literal(1),
  toolchain: z.string().regex(/^rustc 1\.99\.1 \([a-f0-9]{9} \d{4}-\d{2}-\d{2}\)$/),
  target: z.literal('wasm32-unknown-unknown'),
  memoryLimitBytes: z.literal(WASM_LIMIT),
  sourceSha256: sha256Schema,
  sourceHashes: z.record(z.string().regex(/^(Cargo\.(lock|toml)|rust-toolchain\.toml|src\/[a-z0-9_-]+\.rs)$/), sha256Schema),
  variants: z.strictObject({ scalar: artifact('scalar'), simd: artifact('simd') }),
})

const qualifiedVariantsSchema = z.object({
  variants: z.object({
    scalar: z.object({ artifactSha256: sha256Schema }).optional(),
    simd: z.object({ artifactSha256: sha256Schema }).optional(),
  }),
})

async function readLimited(path: string, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum) throw new Error('WASM release input size outside limit')
    // One extra byte detects growth after stat without reading unbounded input.
    const bytes = new Uint8Array(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== stat.size) throw new Error('WASM release input changed size while reading')
    return bytes.slice(0, offset)
  } finally {
    await file.close()
  }
}

function parseJson(bytes: Uint8Array<ArrayBuffer>): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

export async function prepareWasmReleaseAssets(options: ReleaseOptions): Promise<Assets | undefined> {
  const { root, qualificationSha256, qualificationFile } = options
  if (!qualificationSha256) return undefined
  if (!sha256Schema.safeParse(qualificationSha256).success) throw new Error('Expected a trusted WASM qualification SHA-256')
  if (!qualificationFile) throw new Error('Set PIPETWIN_WASM_QUALIFICATION_FILE for the declared WASM release')

  const files = new Map<WasmAsset, Uint8Array<ArrayBuffer>>()
  const read: WasmDeployment['read'] = async (name, limit) => {
    const existing = files.get(name)
    if (existing) {
      if (existing.byteLength > limit) throw new Error('WASM release input size outside limit')
      return existing
    }
    const path = name === 'qualification.json' ? resolve(root, qualificationFile) : join(root, GENERATED, name)
    const bytes = await readLimited(path, limit)
    files.set(name, bytes)
    return bytes
  }
  const profile = profileSchema.parse(parseJson(await readLimited(join(root, PROFILE), JSON_LIMIT)))
  const startup = await resolveSimulationBackend(profile, { qualificationSha256, read })
  if (startup.identity.solver !== 'wasm-f64') throw new Error('WASM release qualification does not match the bundled profile or toolchain')

  const manifest = manifestSchema.parse(parseJson(await read('manifest.json', JSON_LIMIT)))
  const sourceHash = createHash('sha256').update(JSON.stringify(manifest.sourceHashes)).digest('hex')
  if (sourceHash !== manifest.sourceSha256) throw new Error('WASM artifact source hash is inconsistent')
  const qualified = qualifiedVariantsSchema.parse(parseJson(await read('qualification.json', JSON_LIMIT))).variants
  for (const variant of VARIANTS) {
    const evidence = qualified[variant]
    if (evidence && evidence.artifactSha256 !== manifest.variants[variant].sha256) {
      throw new Error(`WASM ${variant} artifact hash differs from qualification evidence`)
    }
    await loadOilWasmBackend(manifest, (name) => read(name, manifest.variants[variant].byteLength), { simdSupported: variant === 'simd' })
  }
  return files
}

export function wasmReleaseAssetsPlugin(assets: Assets): Plugin {
  return {
    name: 'pipetwin-qualified-wasm-assets',
    generateBundle() {
      for (const [name, source] of assets) this.emitFile({ type: 'asset', fileName: `oil/${name}`, source })
    },
    configureServer(server) {
      const prefix = `${server.config.base}oil/`
      const routes = new Map([...assets].map(([name, bytes]) => [prefix + name, { name, bytes }]))
      server.middlewares.use((request, response, next) => {
        const asset = routes.get(request.url?.split('?')[0] ?? '')
        if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) return next()
        response.setHeader('Content-Type', asset.name.endsWith('.wasm') ? 'application/wasm' : 'application/json')
        response.setHeader('Content-Length', asset.bytes.byteLength)
        response.end(request.method === 'HEAD' ? undefined : asset.bytes)
      })
    },
  }
}

export function localContentPolicy(qualifiedWasm: boolean): Plugin {
  const script = qualifiedWasm ? "script-src 'self' 'wasm-unsafe-eval'" : "script-src 'self'"
  return {
    name: 'pipetwin-content-policy',
    apply: 'build',
    transformIndexHtml: () => [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: `default-src 'self'; ${script}; style-src 'self' 'unsafe-inline'; worker-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`,
      },
      injectTo: 'head-prepend',
    }],
  }
}
