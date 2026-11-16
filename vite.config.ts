import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin, UserConfig } from 'vite'
import { checkBoundaries, forbiddenModule } from './tools/check-boundaries.ts'
import { diagnosticSourceHashes } from './tools/diagnostic-source-hashes.ts'
import { diagnosticReleaseAssetsPlugin, prepareDiagnosticReleaseAssets } from './tools/diagnostic-release-assets.ts'
import { localContentPolicy, prepareWasmReleaseAssets, wasmReleaseAssetsPlugin } from './tools/wasm-release-assets.ts'

const privateFilePatterns = [
  '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**',
  '**/validation/**', '**/reference/**', '**/private/**', '**/data/**', '**/.demo/**',
]

function denyPrivateDevPaths(): Plugin {
  return {
    name: 'pipetwin-private-dev-paths',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let path: string
        try {
          path = decodeURIComponent(request.url?.split('?')[0] ?? '/').replaceAll('\\', '/')
        } catch {
          response.statusCode = 400
          response.end()
          return
        }
        if (path.startsWith(server.config.base)) path = `/${path.slice(server.config.base.length)}`
        if (!/(^|\/)(validation|reference|private|data|\.demo)(\/|$)/i.test(path)) return next()
        response.statusCode = 403
        response.end()
      })
    },
  }
}

function guardBundle(worker: boolean): Plugin {
  return {
    name: 'pipetwin-boundaries',
    buildStart() {
      if (worker) return
      for (const error of checkBoundaries(process.cwd())) this.error(error)
    },
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk')
      const inference = chunks.some((chunk) => chunk.facadeModuleId?.includes('/inference.worker.ts'))
      for (const chunk of chunks) {
        for (const id of Object.keys(chunk.modules)) {
          if (!id.includes('/node_modules/') && forbiddenModule(id, inference)) {
            this.error(`Forbidden module in production bundle: ${id}`)
          }
        }
      }
    },
  }
}

export default defineConfig(async ({ mode, command }): Promise<UserConfig> => {
  const root = process.cwd()
  const env = loadEnv(mode, root, [
    'VITE_PIPETWIN_WASM_', 'PIPETWIN_WASM_', 'VITE_PIPETWIN_CALIBRATION_JSON', 'PIPETWIN_RESPONSE_DICTIONARY_DIR',
  ])
  const sourceHashes = diagnosticSourceHashes(root)
  const [wasmAssets, dictionaryAssets] = await Promise.all([
    prepareWasmReleaseAssets({
      root,
      qualificationSha256: env.VITE_PIPETWIN_WASM_QUALIFICATION_SHA256,
      qualificationFile: env.PIPETWIN_WASM_QUALIFICATION_FILE,
    }),
    command === 'build' ? prepareDiagnosticReleaseAssets({
      root, mode, sourceHashes, calibrationJson: env.VITE_PIPETWIN_CALIBRATION_JSON,
      dictionaryDirectory: env.PIPETWIN_RESPONSE_DICTIONARY_DIR,
    }) : undefined,
  ])
  return {
    base: './',
    publicDir: false,
    build: { rolldownOptions: { input: { main: 'index.html', degradation: 'degradation.html' } } },
    server: { fs: { deny: privateFilePatterns } },
    define: {
      'import.meta.env.PIPETWIN_SOURCE_HASHES': JSON.stringify(JSON.stringify(sourceHashes)),
      'import.meta.env.PIPETWIN_BUNDLED_DICTIONARY': JSON.stringify(dictionaryAssets ? '1' : ''),
    },
    plugins: [
      react(), denyPrivateDevPaths(), guardBundle(false), localContentPolicy(wasmAssets !== undefined),
      ...(wasmAssets ? [wasmReleaseAssetsPlugin(wasmAssets)] : []),
      ...(dictionaryAssets ? [diagnosticReleaseAssetsPlugin(dictionaryAssets)] : []),
    ],
    worker: { format: 'es', plugins: () => [guardBundle(true)] },
  }
})
