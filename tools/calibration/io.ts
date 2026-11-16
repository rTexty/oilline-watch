import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ZodType } from 'zod'
import type { EvidenceRef } from './contracts'

const MEBIBYTE = 1024 * 1024
const MAX_JSON_BYTES = 64 * MEBIBYTE
const MAX_LINE_BYTES = 16 * MEBIBYTE
const MAX_GRID_BYTES = 8 * 1024 * MEBIBYTE

export function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

export function jsonDocument(contents: unknown): string {
  return JSON.stringify(contents, null, 2) + '\n'
}

export async function readBounded(path: string, maxBytes = MAX_JSON_BYTES): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error(`Invalid JSON file size: ${path}`)
    const bytes = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read({ buffer: bytes, length: bytes.length, position: 0 })
    if (bytesRead !== bytes.length || (await handle.stat()).size !== bytes.length) throw new Error(`File changed while reading: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
}

function parse<T>(path: string, bytes: Buffer, schema: ZodType<T>): T {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return schema.parse(JSON.parse(text) as unknown)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON.'
    throw new Error(`${path}: ${message.slice(0, 1024)}`, { cause: error })
  }
}

export async function readJson<T>(path: string, schema: ZodType<T>) {
  const bytes = await readBounded(path)
  return { value: parse(path, bytes, schema), hash: sha256(bytes) }
}

export async function readEvidence<T>(base: string, ref: EvidenceRef, schema: ZodType<T>) {
  const path = resolve(base, ref.path)
  const bytes = await readBounded(path)
  if (sha256(bytes) !== ref.sha256) throw new Error(`Evidence digest mismatch: ${ref.path}`)
  return parse(path, bytes, schema)
}

export async function* readGrid<T>(base: string, ref: EvidenceRef, schema: ZodType<T>): AsyncGenerator<T> {
  const path = resolve(base, ref.path)
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_GRID_BYTES) throw new Error('Diagnostic grid exceeds its size limit.')
  const digest = createHash('sha256')
  let pending = Buffer.alloc(0)
  let lineNumber = 0
  let bytesSeen = 0
  for await (const value of createReadStream(path)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    digest.update(chunk)
    bytesSeen += chunk.length
    if (bytesSeen > MAX_GRID_BYTES) throw new Error('Diagnostic grid exceeds its size limit.')
    const bytes = Buffer.concat([pending, chunk])
    let offset = 0
    for (let index = bytes.indexOf(10, offset); index !== -1; index = bytes.indexOf(10, offset)) {
      if (index - offset > MAX_LINE_BYTES) throw new Error('Diagnostic grid row exceeds its size limit.')
      lineNumber += 1
      yield parse(`${path}:${lineNumber}`, bytes.subarray(offset, index), schema)
      offset = index + 1
    }
    pending = bytes.subarray(offset)
    if (pending.length > MAX_LINE_BYTES) throw new Error('Diagnostic grid row exceeds its size limit.')
  }
  if (pending.length > 0) yield parse(`${path}:${lineNumber + 1}`, pending, schema)
  if (digest.digest('hex') !== ref.sha256) throw new Error(`Evidence digest mismatch: ${ref.path}`)
}

export async function writeImmutable(path: string, document: string | Buffer): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const staging = await mkdtemp(join(directory, '.write-'))
  const temporary = join(staging, 'output')
  try {
    await writeFile(temporary, document, { flag: 'wx', mode: 0o644 })
    await link(temporary, path)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function verifyEvidenceDigest(base: string, ref: EvidenceRef): Promise<void> {
  const path = resolve(base, ref.path)
  const info = await stat(path)
  if (!info.isFile() || info.size === 0 || info.size > MAX_GRID_BYTES) throw new Error(`Invalid evidence file size: ${ref.path}`)
  const digest = createHash('sha256')
  let bytesSeen = 0
  for await (const chunk of createReadStream(path)) {
    bytesSeen += chunk.length
    if (bytesSeen > MAX_GRID_BYTES) throw new Error(`Evidence exceeds size limit: ${ref.path}`)
    digest.update(chunk)
  }
  if (digest.digest('hex') !== ref.sha256) throw new Error(`Evidence digest mismatch: ${ref.path}`)
}
