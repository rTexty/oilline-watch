const RELEASE_ASSET_TIMEOUT_MS = 5000

export async function readWorkerReleaseAsset(
  path: string, limitBytes: number, { exactLength = false } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const configuredBase = import.meta.env.BASE_URL
  // The relative production worker script lives under the application's assets directory.
  const base = new URL(import.meta.env.PROD && (configuredBase === './' || configuredBase === '') ? '../' : configuredBase,
    globalThis.location.href)
  const url = new URL(path, base)
  if (url.origin !== globalThis.location.origin) throw new Error('Release assets must be same-origin')
  const response = await fetch(url, { mode: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(RELEASE_ASSET_TIMEOUT_MS) })
  const advertisedLength = response.headers.get('content-length')
  const encoding = response.headers.get('content-encoding')
  const decodedLengthAdvertised = advertisedLength !== null && (encoding === null || encoding === 'identity')
  if (!response.ok || !response.body || decodedLengthAdvertised
    && (Number(advertisedLength) > limitBytes || exactLength && Number(advertisedLength) !== limitBytes)) {
    await response.body?.cancel()
    throw new Error(`Release asset unavailable: ${path}`)
  }
  const stream = response.body.getReader()
  const bytes = new Uint8Array(limitBytes)
  let offset = 0
  try {
    while (true) {
      const { done, value } = await stream.read()
      if (done) {
        if (offset === bytes.byteLength) return bytes
        if (exactLength) throw new Error(`Release asset has an unexpected length: ${path}`)
        return bytes.slice(0, offset)
      }
      if (offset + value.byteLength > limitBytes) {
        await stream.cancel()
        throw new Error(`Release asset exceeds size limit: ${path}`)
      }
      bytes.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    stream.releaseLock()
  }
}
