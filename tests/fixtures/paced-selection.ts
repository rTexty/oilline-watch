import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { anchorIdSchema, profileSchema } from '../../src/contracts/model'
import type { FluidProfile } from '../../src/contracts/model'
import { DICTIONARY_CHANNELS, DICTIONARY_NODES } from '../../src/contracts/response-dictionary'
import { createCheckpointAnchor } from '../../src/twin/checkpoint'
import { bankProfiles } from '../../src/twin/predict'
import { schedulerFixture } from '../../tools/calibration/browser/scheduler-fixture'
import { jsonDocument, readJson, sha256 } from '../../tools/calibration/io'
import { diagnosticSourceHashes } from '../../tools/diagnostic-source-hashes'

export async function pacedSelectionFixture(root: string, profile: FluidProfile, splitHash = sha256('committed open calibration split')) {
  const sourceHashes = diagnosticSourceHashes(process.cwd())
  const fixture = schedulerFixture('synthetic-oil-nominal-v1', sourceHashes)
  const anchors = await Promise.all(bankProfiles(profile).map((definition, index) =>
    createCheckpointAnchor(anchorIdSchema.parse(index), definition)))
  const sampleCount = 3301
  const traces = anchors.flatMap(({ anchorId }) => [
    ...DICTIONARY_NODES.map((node) => ({ model: 'ML', anchorId, node, sampleCount })),
    { model: 'MB', anchorId, sampleCount },
  ])
  // Structural test data, used only to exercise artifact transport and validation.
  const dictionaryBytes = Buffer.alloc(traces.length * sampleCount * DICTIONARY_CHANNELS * 8)
  const dictionaryDigest = sha256(dictionaryBytes)
  const dictionaryManifest = {
    schemaVersion: 1, samplePeriodUs: 10_000, profileId: profile.profileId, modelVersion: profile.modelVersion,
    bankVersion: fixture.bankVersion, anchorParameterHashes: anchors.map(({ parameterHash }) => parameterHash),
    dataSha256: dictionaryDigest, traces,
  }
  const dictionary = join(root, 'dictionary')
  await mkdir(dictionary)
  await Promise.all([
    writeFile(join(dictionary, 'dictionary.json'), jsonDocument(dictionaryManifest)),
    writeFile(join(dictionary, 'dictionary.f64'), dictionaryBytes),
  ])
  const selection = {
    schemaVersion: fixture.schemaVersion, modelVersion: fixture.modelVersion, profileId: fixture.profileId,
    bankVersion: fixture.bankVersion, sensorProfileId: fixture.sensorProfileId,
    hashes: { ...fixture.hashes, calibration: splitHash, development: sha256('untouched development split'), dictionary: dictionaryDigest },
    releaseScope: fixture.releaseScope, noise: fixture.noise, thresholds: fixture.thresholds,
    errorEnvelope: { ...fixture.errorEnvelope, qualified: false },
  }
  const expectedSelectionHash = sha256(jsonDocument(selection))
  const candidate = {
    selection, selectionHash: expectedSelectionHash, diagnosticIndices: [0, 0, 0, 0, 0],
    calibrationScore: { correct: 0, timely: 0, medianWidthM: null },
  }
  const selectionPath = join(root, 'selected.json')
  await writeFile(selectionPath, jsonDocument(candidate))
  return {
    candidate, dictionaryManifest,
    options: { selectionPath, expectedSelectionHash, dictionaryDirectory: dictionary, profile, sourceHashes,
      profileHash: sourceHashes.profile, split: 'calibration' as const, splitHash, sensorProfileId: fixture.sensorProfileId },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , root, profilePath, splitHash] = process.argv
  if (!root || !profilePath || !splitHash) throw new Error('Expected fixture directory, profile and split digest.')
  const { value: profile } = await readJson(profilePath, profileSchema)
  const { options } = await pacedSelectionFixture(root, profile, splitHash)
  console.log(options.expectedSelectionHash)
}
