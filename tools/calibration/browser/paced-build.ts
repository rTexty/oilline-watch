import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { diagnosticSourceHashes } from '../../diagnostic-source-hashes'
import { jsonDocument, sha256 } from '../io'
import type { PacedDictionaryAssets } from './selected-policy'
import { adaptPacedSimulation } from './simulation-transform'
import { PACED_SPATIAL_ASSET_PATH } from './spatial-evaluation-options'

const root = fileURLToPath(new URL('.', import.meta.url))
const DICTIONARY_CHUNK_BYTES = 64 * 1024
const sourceFiles = [
  './index.html', './client.ts', './simulation-transform.ts', './worker-adapter.ts', './detector-trace.ts', './active-shadow.ts',
  './provisional-timing.ts', './fit-evidence.ts', './public-diagnostic-trace.ts', './paced-build.ts',
  './scheduler-fixture.ts', './selected-policy.ts', './pilot-status.ts', '../scenario-setup.ts', '../steady-withdrawal.ts',
  './spatial-evaluation-options.ts',
  '../io.ts', '../selection.ts', './paced-heap.ts', '../../chromium-heap-probe.ts', '../../run-paced-scenario.ts',
]

async function adapterSources() {
  return Promise.all(sourceFiles.map(async (path) => ({
    path, sha256: sha256(await readFile(new URL(path, import.meta.url))),
  })))
}

export async function buildPacedHarness(workspace: string, outDir: string, { withDictionary = false, withActiveShadow = false } = {}) {
  const simulation = resolve(workspace, 'src/runtime/simulation.worker.ts')
  const [before, adapter] = await Promise.all([Promise.resolve(diagnosticSourceHashes(workspace)), adapterSources()])
  let transformed = false
  await build({
    root, configFile: false, mode: 'test', envDir: false, envPrefix: [], publicDir: false, logLevel: 'warn',
    define: { 'import.meta.env.PIPETWIN_BUNDLED_DICTIONARY': JSON.stringify(withDictionary ? '1' : '0') },
    build: { outDir, sourcemap: false, emptyOutDir: false },
    worker: {
      format: 'es',
      plugins: () => [{
        name: 'pipetwin-paced-validation-worker',
        enforce: 'pre',
        transform(code, id) {
          if (id.split('?')[0] !== simulation) return
          transformed = true
          return adaptPacedSimulation(code, { withDictionary, withActiveShadow })
        },
      }],
    },
  })
  if (!transformed) throw new Error('Paced validation startup hooks were absent from the Worker build.')
  if (jsonDocument(before) !== jsonDocument(diagnosticSourceHashes(workspace))
    || jsonDocument(adapter) !== jsonDocument(await adapterSources())) {
    throw new Error('Validation sources changed during the Worker build.')
  }
  return { sourceHashes: before, adapter, adapterSha256: sha256(jsonDocument(adapter)) }
}

async function outputFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? outputFiles(path) : entry.isFile() ? [path] : []
  }))
  return nested.flat().sort()
}

type DictionaryAsset = 'manifest' | 'binary'
type DictionaryResponse = 'requested' | 'finished' | 'closedEarly'
type DictionaryTransport = Readonly<Record<DictionaryAsset, Readonly<Record<DictionaryResponse, number>>>>

function dictionaryResponses() {
  const empty = { requested: 0, finished: 0, closedEarly: 0 }
  let counts: DictionaryTransport = { manifest: empty, binary: empty }
  return {
    count(asset: DictionaryAsset, response: DictionaryResponse) {
      const current = counts[asset]
      counts = { ...counts, [asset]: { ...current, [response]: current[response] + 1 } }
    },
    snapshot: () => counts,
  }
}

function* dictionaryChunks(contents: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < contents.length; offset += DICTIONARY_CHUNK_BYTES) {
    yield contents.subarray(offset, offset + DICTIONARY_CHUNK_BYTES)
  }
}

export async function servePacedHarness(directory: string, dictionary?: PacedDictionaryAssets) {
  const compiled = await Promise.all((await outputFiles(directory)).map(async (path) => {
    const name = relative(directory, path)
    if (name !== 'index.html' && !/^assets\/[\w.-]+-[\w-]{8}\.js$/.test(name)) return null
    const bytes = await readFile(path)
    return { name, bytes, sha256: sha256(bytes) }
  })).then((output) => output.filter((asset) => asset !== null))
  const dictionaryAssets = dictionary ? [
    { name: 'calibration/dictionary.json', bytes: dictionary.manifest, sha256: sha256(dictionary.manifest) },
    { name: 'calibration/dictionary.f64', bytes: dictionary.data, sha256: sha256(dictionary.data) },
  ] : []
  const spatialEnvelope = dictionary?.spatialEnvelope
  const spatialAssets = spatialEnvelope ? [{ name: PACED_SPATIAL_ASSET_PATH,
    bytes: spatialEnvelope, sha256: sha256(spatialEnvelope) }] : []
  const assets = [...compiled, ...dictionaryAssets, ...spatialAssets]
  const routes = new Map(assets.map((asset) => [`/${asset.name}`, asset.bytes]))
  const transfers = dictionary ? dictionaryResponses() : undefined
  const server = createServer((request, response) => {
    const raw = request.url?.split('?')[0]
    const path = raw === '/' ? '/index.html' : raw
    const contents = path && request.method === 'GET' ? routes.get(path) : undefined
    if (!contents) {
      response.writeHead(404).end()
      return
    }
    const dictionaryAsset = path === '/calibration/dictionary.json' ? 'manifest'
      : path === '/calibration/dictionary.f64' ? 'binary' : null
    if (transfers && dictionaryAsset) {
      transfers.count(dictionaryAsset, 'requested')
      response.once('finish', () => transfers.count(dictionaryAsset, 'finished'))
      response.once('close', () => {
        if (!response.writableFinished) transfers.count(dictionaryAsset, 'closedEarly')
      })
    }
    response.writeHead(200, {
      'Content-Type': assetContentType(extname(path ?? '')),
      'Content-Length': contents.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    })
    if (dictionaryAsset === 'binary') {
      // Bound socket buffering when several browser Workers load the dictionary concurrently.
      const stream = Readable.from(dictionaryChunks(contents), { objectMode: false })
      void pipeline(stream, response).catch(() => response.destroy())
    } else {
      response.end(contents)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Validation browser server unavailable.')
  return {
    url: `http://127.0.0.1:${address.port}`,
    assets: assets.map(({ name, sha256 }) => ({ name, sha256 })),
    dictionaryTransport: () => transfers?.snapshot() ?? null,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

function assetContentType(extension: string): string {
  switch (extension) {
    case '.js': return 'text/javascript'
    case '.json': return 'application/json'
    case '.f64': return 'application/octet-stream'
    default: return 'text/html; charset=utf-8'
  }
}
