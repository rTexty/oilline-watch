import { DICTIONARY_CHANNELS, MAX_DICTIONARY_BYTES, responseDictionaryManifestSchema } from '../contracts/response-dictionary'
import { loadResponseDictionary } from '../detection/screening'
import type { ResponseDictionary } from '../detection/screening'
import { spatialPrefixBytes } from '../detection/spatial-surrogate'
import { createNumericalMemoryLedger } from './numerical-memory'
import type { NumericalMemoryLedger, NumericalMemoryReservation } from './numerical-memory'
import { readWorkerReleaseAsset } from './release-assets'

const MANIFEST_LIMIT_BYTES = 64 * 1024
type DictionaryManifest = ReturnType<typeof responseDictionaryManifestSchema.parse>

export function dictionarySpatialPrefixBytes(manifest: DictionaryManifest): number {
  return spatialPrefixBytes(manifest.traces[0]!.sampleCount, manifest.traces.filter(({ model }) => model === 'ML').length)
}

type ReservedDictionary =
  | { readonly kind: 'loaded'; readonly dictionary: ResponseDictionary; readonly reservation: NumericalMemoryReservation }
  | { readonly kind: 'unavailable' | 'resource-limit' }

export async function loadReservedBundledResponseDictionary(
  expectedSha256: string, ledger: NumericalMemoryLedger,
  { prepareSpatialProfile = false } = {},
): Promise<ReservedDictionary> {
  const manifestWorkspace = ledger.reserveBytes('dictionary manifest', 2 * MANIFEST_LIMIT_BYTES)
  if (!manifestWorkspace) return { kind: 'resource-limit' }
  let manifest: DictionaryManifest
  try {
    const bytes = await readWorkerReleaseAsset('calibration/dictionary.json', MANIFEST_LIMIT_BYTES)
    manifest = responseDictionaryManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    return { kind: 'unavailable' }
  } finally {
    manifestWorkspace.release()
  }
  if (manifest.dataSha256 !== expectedSha256) return { kind: 'unavailable' }
  const size = manifest.traces[0]!.sampleCount * manifest.traces.length * DICTIONARY_CHANNELS * Float64Array.BYTES_PER_ELEMENT
  if (size > MAX_DICTIONARY_BYTES) return { kind: 'unavailable' }

  const prefixBytes = prepareSpatialProfile ? dictionarySpatialPrefixBytes(manifest) : 0
  const reservation = ledger.reserveBytes('dictionary data and spatial prefixes', size + prefixBytes)
  if (!reservation) return { kind: 'resource-limit' }
  try {
    const bytes = await readWorkerReleaseAsset('calibration/dictionary.f64', size, { exactLength: true })
    const dictionary = await loadResponseDictionary(manifest, bytes.buffer, expectedSha256, { prepareSpatialProfile })
    if (!dictionary) {
      reservation.release()
      return { kind: 'unavailable' }
    }
    return { kind: 'loaded', dictionary, reservation }
  } catch {
    reservation.release()
    return { kind: 'unavailable' }
  }
}

export async function loadBundledResponseDictionary(expectedSha256: string): Promise<ResponseDictionary | null> {
  const result = await loadReservedBundledResponseDictionary(expectedSha256, createNumericalMemoryLedger('inference'))
  return result.kind === 'loaded' ? result.dictionary : null
}
