import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { anchorIdSchema, profileSchema } from '../src/contracts/model.ts'
import { DICTIONARY_CHANNELS, MAX_DICTIONARY_BYTES, responseDictionaryManifestSchema } from '../src/contracts/response-dictionary.ts'
import { loadQualifiedSpatialEnvelope, MAX_SPATIAL_ARTIFACT_BYTES, SPATIAL_ARTIFACT_FILENAME } from '../src/detection/qualified-spatial-profile.ts'
import { trustedCalibration } from '../src/runtime/diagnostic-release.ts'
import { createCheckpointAnchor } from '../src/twin/checkpoint.ts'
import { bankProfiles } from '../src/twin/predict.ts'
import { readBounded, sha256 } from './calibration/io.ts'

const MANIFEST_LIMIT_BYTES = 64 * 1024
const PROFILE_PATH = 'src/scenarios/synthetic-oil-turbulent-v1.json'
const MIN_RESPONSE_DURATION_US = 33_000_000

interface StagingOptions {
  readonly root: string
  readonly mode: string
  readonly calibrationJson?: string
  readonly sourceHashes: unknown
  readonly dictionaryDirectory?: string
}

interface DiagnosticReleaseAssets {
  readonly manifest: Uint8Array
  readonly data: Uint8Array
  readonly spatialEnvelope?: Uint8Array
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

export async function prepareDiagnosticReleaseAssets(options: StagingOptions): Promise<DiagnosticReleaseAssets | undefined> {
  const calibration = trustedCalibration(options.mode, options.calibrationJson, options.sourceHashes)?.calibration
  if (!calibration?.qualification.quantitative) return undefined
  if (!options.dictionaryDirectory) throw new Error('Quantitative calibration requires PIPETWIN_RESPONSE_DICTIONARY_DIR')
  const directory = resolve(options.root, options.dictionaryDirectory)
  const manifestBytes = await readBounded(join(directory, 'dictionary.json'), MANIFEST_LIMIT_BYTES)
  const manifest = responseDictionaryManifestSchema.parse(parseJson(manifestBytes))
  if (manifest.profileId !== calibration.profileId || manifest.modelVersion !== calibration.modelVersion
    || manifest.bankVersion !== calibration.bankVersion) throw new Error('Response dictionary version differs from calibration')
  if (manifest.dataSha256 !== calibration.hashes.dictionary) throw new Error('Response dictionary digest differs from calibration')

  const sampleCount = manifest.traces[0]!.sampleCount
  if ((sampleCount - 1) * manifest.samplePeriodUs < MIN_RESPONSE_DURATION_US) {
    throw new Error('Release response dictionary must cover the 33 s observation window and guard')
  }
  const profileBytes = await readBounded(join(options.root, PROFILE_PATH), MANIFEST_LIMIT_BYTES)
  if (sha256(profileBytes) !== calibration.hashes.profile) throw new Error('Bundled profile changed during response dictionary staging')
  const profile = profileSchema.parse({ ...profileSchema.parse(parseJson(profileBytes)), sensorProfileId: calibration.sensorProfileId })
  const anchors = await Promise.all(bankProfiles(profile).map((definition, index) =>
    createCheckpointAnchor(anchorIdSchema.parse(index), definition)))
  if (anchors.some(({ parameterHash }, index) => parameterHash !== manifest.anchorParameterHashes[index])) {
    throw new Error('Response dictionary anchors differ from the bundled bank')
  }

  let spatialEnvelope: Uint8Array | undefined
  if (calibration.errorEnvelope.spatialArtifactSha256) {
    const bytes = await readBounded(join(directory, SPATIAL_ARTIFACT_FILENAME), MAX_SPATIAL_ARTIFACT_BYTES)
    const envelope = await loadQualifiedSpatialEnvelope(Uint8Array.from(bytes), calibration)
    if (!envelope || envelope.anchorParameterHashes.some((hash, index) => hash !== anchors[index]!.parameterHash)) {
      throw new Error('Pinned spatial envelope is incompatible with the bundled calibration and bank')
    }
    spatialEnvelope = bytes
  }
  const data = await readBounded(join(directory, 'dictionary.f64'), MAX_DICTIONARY_BYTES)
  const expectedBytes = manifest.traces.length * sampleCount * DICTIONARY_CHANNELS * Float64Array.BYTES_PER_ELEMENT
  if (data.byteLength !== expectedBytes) throw new Error('Response dictionary binary length differs from its manifest')
  if (sha256(data) !== manifest.dataSha256) throw new Error('Response dictionary binary digest mismatch')
  for (let offset = 0; offset < data.byteLength; offset += Float64Array.BYTES_PER_ELEMENT) {
    if (!Number.isFinite(data.readDoubleLE(offset))) throw new Error('Response dictionary contains non-finite samples')
  }
  return { manifest: manifestBytes, data, spatialEnvelope }
}

export function diagnosticReleaseAssetsPlugin(assets: DiagnosticReleaseAssets): Plugin {
  return {
    name: 'pipetwin-qualified-dictionary',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'calibration/dictionary.json', source: assets.manifest })
      this.emitFile({ type: 'asset', fileName: 'calibration/dictionary.f64', source: assets.data })
      if (assets.spatialEnvelope) {
        this.emitFile({ type: 'asset', fileName: `calibration/${SPATIAL_ARTIFACT_FILENAME}`, source: assets.spatialEnvelope })
      }
    },
  }
}
