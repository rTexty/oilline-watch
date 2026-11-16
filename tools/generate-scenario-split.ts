import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { profileSchema } from '../src/contracts/model'
import { assertDisjointSplits } from './calibration/contracts'
import { generateOpenSplit, OPEN_SPLITS } from './calibration/generate-scenarios'
import type { GeneratedOpenSplit, OpenSplit } from './calibration/generate-scenarios'
import { jsonDocument, readBounded, readJson, sha256 } from './calibration/io'
import { assertPrivateSplitOutput } from './calibration/split-output'

const SOURCES = [
  './calibration/contracts.ts',
  './calibration/generate-scenarios.ts',
  './calibration/io.ts',
  './calibration/split-output.ts',
  './generate-scenario-split.ts',
  '../src/contracts/model.ts',
  '../src/plant/random.ts',
] as const

async function suppliedSalts(path: string | undefined, role: OpenSplit | undefined): Promise<Partial<Record<OpenSplit, string>>> {
  if (!path) return {}
  const contents = (await readBounded(path, 256)).toString('utf8').trim()
  const isSalt = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
  if (role && isSalt(contents)) return { [role]: contents }
  if (!role) {
    try {
      const salts: unknown = JSON.parse(contents)
      if (typeof salts === 'object' && salts !== null && Object.keys(salts).length === 3
        && OPEN_SPLITS.every((split) => Object.hasOwn(salts, split) && isSalt((salts as Record<string, unknown>)[split]))) {
        return salts as Record<OpenSplit, string>
      }
    } catch {
      throw new Error('Invalid private salt file.')
    }
  }
  throw new Error('Invalid private salt file.')
}

async function generatorSources() {
  const entries = await Promise.all(SOURCES.map(async (path) => ({
    path, sha256: sha256(await readFile(new URL(path, import.meta.url))),
  })))
  return { entries, hash: sha256(jsonDocument(entries)) }
}

async function writeSplit(out: string, generated: GeneratedOpenSplit, profileHash: string, sources: Awaited<ReturnType<typeof generatorSources>>) {
  const declaration = jsonDocument(generated.split)
  const recipes = jsonDocument({ ...generated.recipes, profileHash })
  const pairs = jsonDocument(generated.closurePairs)
  const declarationSha256 = sha256(declaration)
  const recipeSha256 = sha256(recipes)
  const closurePairsSha256 = sha256(pairs)
  const scenarios = generated.split.scenarios
  const counts = {
    leak: scenarios.filter((run) => run.kind === 'leak').length,
    null: scenarios.filter((run) => run.kind === 'null').length,
    discrepancy: scenarios.filter((run) => run.kind === 'discrepancy').length,
    closurePairs: generated.closurePairs.pairs.length,
  }

  await mkdir(join(out, 'private'), { mode: 0o700 })
  await writeFile(join(out, 'private', 'recipes.json'), recipes, { flag: 'wx', mode: 0o600 })
  await writeFile(join(out, 'private', 'closure-pairs.json'), pairs, { flag: 'wx', mode: 0o600 })
  await writeFile(join(out, 'split.json'), declaration, { flag: 'wx', mode: 0o644 })
  await writeFile(join(out, 'commitment.json'), jsonDocument({
    schemaVersion: 1, split: generated.split.split, status: 'declared', profileHash,
    saltCommitment: generated.split.saltCommitment, generatorHash: sources.hash, generatorSources: sources.entries,
    declarationSha256, recipeSha256, closurePairsSha256, counts,
  }), { flag: 'wx', mode: 0o644 })

  return { sha256: declarationSha256, counts }
}

async function main() {
  const { values } = parseArgs({ options: {
    profile: { type: 'string' }, split: { type: 'string' }, out: { type: 'string' }, 'salt-file': { type: 'string' },
  } })
  if (values.split === 'blind') throw new Error('Blind generation requires the independent validation owner.')
  const role = OPEN_SPLITS.find((split) => split === values.split)
  if (!values.profile || !values.out || (!role && values.split !== 'all')) {
    throw new Error('Usage: generate-scenario-split --profile <json> --split fit|calibration|development|all --out <new-directory> [--salt-file <path>]')
  }
  const out = resolve(values.out)
  await assertPrivateSplitOutput(out, fileURLToPath(new URL('..', import.meta.url)))

  const [{ value: profile, hash: profileHash }, sources, salts] = await Promise.all([
    readJson(values.profile, profileSchema), generatorSources(), suppliedSalts(values['salt-file'], role),
  ])
  const roles = role ? [role] : OPEN_SPLITS
  const generated = roles.map((split) => generateOpenSplit({
    split, saltHex: salts[split] ?? randomBytes(16).toString('hex'), generatorHash: sources.hash, profile,
  }))
  assertDisjointSplits(generated.map(({ split }) => split.scenarios))
  if (new Set(generated.map(({ split }) => split.saltCommitment)).size !== roles.length) {
    throw new Error('Split salt commitments must be independent.')
  }

  await mkdir(dirname(out), { recursive: true })
  await mkdir(out, { mode: 0o700 })
  const refs: Partial<Record<OpenSplit, { path: string; sha256: string }>> = {}
  for (const [index, result] of generated.entries()) {
    const split = roles[index]!
    const directory = role ? out : join(out, split)
    if (!role) await mkdir(directory, { mode: 0o700 })
    const { sha256: digest, counts } = await writeSplit(directory, result, profileHash, sources)
    refs[split] = { path: role ? 'split.json' : `${split}/split.json`, sha256: digest }
    console.log(`${split}: ${counts.leak} leak, ${counts.null} null, ${counts.discrepancy} discrepancy, ${counts.closurePairs} reserved closure pairs; declaration SHA-256 ${digest}`)
  }
  await writeFile(join(out, 'open-splits.json'), jsonDocument({
    schemaVersion: 1, status: 'declared', profileHash, generatorHash: sources.hash, splits: refs,
  }), { flag: 'wx', mode: 0o644 })
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Open scenario generation failed.')
  process.exitCode = 1
}
