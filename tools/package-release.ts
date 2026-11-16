import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const assetPattern = /^((?:index|degradation)\.html|assets\/[\w.-]+\.(?:js|css|svg|png|woff2|wasm))$/
const documentation = ['docs/methodology.md'] as const
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

async function inventory(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Bundle contains a symbolic link')
    if (entry.isDirectory()) return inventory(root, path)
    if (!entry.isFile()) throw new Error('Bundle contains an unexpected file type')
    return [relative(root, path).split(sep).join('/')]
  }))
  return nested.flat().sort()
}

async function packageDemo(out: string) {
  const build = resolve('dist')
  if (!(await lstat(build)).isDirectory()) throw new Error('Expected a built dist directory')
  const source = await realpath(build)
  const destination = resolve(out)
  const target = join(await realpath(dirname(destination)), basename(destination))
  if (target === source || target.startsWith(source + sep)) throw new Error('Choose a destination outside dist')
  const assets = await inventory(source)
  if (!assets.includes('index.html') || assets.some((path) => !assetPattern.test(path))) {
    throw new Error('Build contains files outside the approved demo bundle layout')
  }
  const inputs = [
    ...assets.map((path) => ({ path: `dist/${path}`, input: join(source, path) })),
    ...documentation.map((path) => ({ path, input: path })),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const contents = await Promise.all(inputs.map(async ({ path, input }) => {
    const bytes = await readFile(input)
    return { path, bytes, sha256: digest(bytes) }
  }))
  const payloads = contents.map(({ path, bytes, sha256 }) => ({ path, sha256, bytes: bytes.length }))
  const files = payloads.filter(({ path }) => path.startsWith('dist/'))
    .map(({ path, sha256 }) => ({ path: path.slice('dist/'.length), sha256 }))
  await mkdir(target)
  try {
    await mkdir(join(target, 'dist', 'assets'), { recursive: true })
    await mkdir(join(target, 'docs'), { recursive: true })
    for (const { path, bytes } of contents) await writeFile(join(target, path), bytes, { flag: 'wx' })
    await writeFile(join(target, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, scope: 'synthetic-demo', qualified: false, node: process.version, files,
      payloads, bundleSha256: digest(JSON.stringify(payloads)),
      previewCommand: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory dist',
    }, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
  console.log(`Synthetic demo bundle written to ${target}`)
}

try {
  const { values } = parseArgs({ options: { out: { type: 'string' }, demo: { type: 'boolean' } } })
  if (!values.demo || !values.out) throw new Error('Usage: package-release.ts --demo --out <new-directory>')
  await packageDemo(values.out)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Failed to package demo')
  process.exitCode = 1
}
