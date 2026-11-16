import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { sha256Schema } from '../../src/contracts/calibration'
import { profileSchema } from '../../src/contracts/model'
import type { FluidProfile } from '../../src/contracts/model'
import type { PublicBatch } from '../../src/contracts/public'
import { PhysicsDomainError } from '../../src/physics/guards'
import { advanceEngine } from '../../src/runtime/engine'
import { generateOpenSplit, OPEN_SPLITS } from './generate-scenarios'
import type { ScenarioRecipe } from './generate-scenarios'
import { jsonDocument, readBounded, readJson, sha256 } from './io'
import { prepareValidationScenario, validateScenarioTarget } from './scenario-setup'
import type { ValidationClosure } from './scenario-setup'

export { prepareValidationScenario } from './scenario-setup'
export type { ValidationClosure } from './scenario-setup'

const recipeSaltSchema = z.object({ saltHex: z.string().regex(/^[a-f0-9]{32}$/) })
export const openSplitCommitmentSchema = z.strictObject({
  schemaVersion: z.literal(1), split: z.enum(OPEN_SPLITS), status: z.literal('declared'), profileHash: sha256Schema,
  saltCommitment: sha256Schema, generatorHash: sha256Schema,
  generatorSources: z.array(z.strictObject({ path: z.string().min(1).max(256), sha256: sha256Schema })).min(1).max(32),
  declarationSha256: sha256Schema, recipeSha256: sha256Schema, closurePairsSha256: sha256Schema,
  counts: z.strictObject({ leak: z.literal(120), null: z.literal(240), discrepancy: z.literal(48), closurePairs: z.literal(68) }),
})

const GENERATOR_SOURCES = [
  './calibration/contracts.ts', './calibration/generate-scenarios.ts', './calibration/io.ts',
  './calibration/split-output.ts', './generate-scenario-split.ts', '../src/contracts/model.ts', '../src/plant/random.ts',
] as const

async function validateGeneratorSources(expected: z.infer<typeof openSplitCommitmentSchema>['generatorSources']): Promise<void> {
  const base = new URL('../', import.meta.url)
  const actual = await Promise.all(GENERATOR_SOURCES.map(async (path) => ({
    path, sha256: sha256(await readFile(new URL(path, base))),
  })))
  if (jsonDocument(actual) !== jsonDocument(expected)) {
    throw new Error('Open split generator source files differ from the committed source hashes.')
  }
}

export async function loadOpenScenarioSplit(directory: string, profilePath: string, expectedDeclarationSha256?: string) {
  const [profile, commitment, declaration, privateRecipes, closurePairs] = await Promise.all([
    readJson(profilePath, profileSchema),
    readJson(join(directory, 'commitment.json'), openSplitCommitmentSchema),
    readBounded(join(directory, 'split.json'), 512 * 1024),
    readBounded(join(directory, 'private', 'recipes.json'), 4 * 1024 * 1024),
    readBounded(join(directory, 'private', 'closure-pairs.json'), 256 * 1024),
  ])
  const declared = commitment.value
  if (expectedDeclarationSha256 !== undefined && expectedDeclarationSha256 !== declared.declarationSha256) {
    throw new Error('Open split does not match its independently pinned declaration digest.')
  }
  if (declared.profileHash !== profile.hash || declared.declarationSha256 !== sha256(declaration)
    || declared.recipeSha256 !== sha256(privateRecipes) || declared.closurePairsSha256 !== sha256(closurePairs)
    || declared.generatorHash !== sha256(jsonDocument(declared.generatorSources))) {
    throw new Error('Open scenario files do not match the committed digests.')
  }
  await validateGeneratorSources(declared.generatorSources)
  let saltHex: string
  try {
    saltHex = recipeSaltSchema.parse(JSON.parse(privateRecipes.toString('utf8'))).saltHex
  } catch {
    throw new Error('Invalid private scenario input.')
  }
  const recreated = generateOpenSplit({ split: declared.split, saltHex, generatorHash: declared.generatorHash, profile: profile.value })
  if (recreated.split.saltCommitment !== declared.saltCommitment
    || jsonDocument(recreated.split) !== declaration.toString('utf8')
    || jsonDocument({ ...recreated.recipes, profileHash: profile.hash }) !== privateRecipes.toString('utf8')
    || jsonDocument(recreated.closurePairs) !== closurePairs.toString('utf8')) {
    throw new Error('Private scenarios do not regenerate the committed open split.')
  }
  return {
    profile: profile.value, split: recreated.split, runs: recreated.recipes.runs,
    closurePairs: recreated.closurePairs.pairs, commitment: declared, commitmentSha256: commitment.hash,
  }
}

interface RunOptions {
  readonly closure?: ValidationClosure
  readonly targetUs?: number
  readonly onBatch?: (batch: PublicBatch) => void
}

export function runValidationScenario(profile: FluidProfile, recipe: ScenarioRecipe, options: RunOptions = {}) {
  const start = performance.now()
  const closure = options.closure ?? 'qs'
  const runId = closure === 'qs' ? recipe.runId : `${recipe.runId}-vb10`
  const targetUs = options.targetUs ?? profile.horizonUs
  validateScenarioTarget(profile, targetUs)
  const digest = createHash('sha256')
  let batchCount = 0
  let lastBatchUs: number | null = null
  let measurementCount = 0
  let plantSegments: number | null = null
  let consumerFailed = false
  function record(batch: PublicBatch) {
    batchCount++
    lastBatchUs = batch.sampleTimeUs
    measurementCount += batch.measurements.length
    digest.update(JSON.stringify(batch)).update('\n')
    try {
      options.onBatch?.(batch)
    } catch (error) {
      consumerFailed = true
      throw error
    }
  }
  function summary(status: 'completed' | 'pilot-cutoff' | 'unsupported' | 'invalid-domain', reason: string | null) {
    return {
      runId, closure, status, reason, targetUs, lastBatchUs, batchCount, measurementCount, plantSegments,
      traceSha256: batchCount > 0 ? digest.digest('hex') : null, wallMs: performance.now() - start,
    }
  }
  try {
    const prepared = prepareValidationScenario(profile, recipe, closure)
    if (prepared.status === 'unsupported') return summary('unsupported', prepared.reason)
    plantSegments = prepared.engine.plant.profile.definition.grid.segments
    if (prepared.engine.latestBatch) record(prepared.engine.latestBatch)
    advanceEngine(prepared.engine, targetUs, record)
    return summary(targetUs === profile.horizonUs ? 'completed' : 'pilot-cutoff', null)
  } catch (error) {
    if (consumerFailed || !(error instanceof PhysicsDomainError)) throw error
    return summary('invalid-domain', error.code)
  }
}
