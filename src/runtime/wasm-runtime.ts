import { z } from 'zod'
import { sha256Schema } from '../contracts/calibration'
import { modelVersionSchema } from '../contracts/model'
import type { FluidProfile } from '../contracts/model'
import type { HydraulicFieldBackend } from '../physics/moc'
import { loadOilWasmBackend } from '../physics/wasm-adapter'
import { createCheckpointAnchor } from '../twin/checkpoint'
import { createNumericalMemoryLedger } from './numerical-memory'
import type { NumericalMemoryLedger, NumericalMemoryReservation } from './numerical-memory'
import { readWorkerReleaseAsset } from './release-assets'

type Variant = 'scalar' | 'simd'
type WasmAsset = 'qualification.json' | 'manifest.json' | `${Variant}-polylog.wasm`

const JSON_LIMIT = 16 * 1024
const WASM_LIMIT = 2 * 1024 * 1024
const PROFILE_ID = 'synthetic-oil-turbulent-v1'

interface TypeScriptIdentity { readonly solver: 'typescript-f64' }
interface WasmIdentity {
  readonly solver: 'wasm-f64'
  readonly variant: Variant
  readonly artifactSha256: string
}

export type SimulationBackendIdentity = TypeScriptIdentity | WasmIdentity
export type SimulationBackend =
  | { readonly identity: TypeScriptIdentity; readonly fields?: undefined; readonly releaseMemory?: undefined }
  | { readonly identity: WasmIdentity; readonly fields: HydraulicFieldBackend; readonly releaseMemory?: () => void }

export const TYPESCRIPT_SIMULATION_BACKEND: SimulationBackend = Object.freeze({
  identity: Object.freeze({ solver: 'typescript-f64' as const }),
})

export interface WasmDeployment {
  /** Hash pinned by the release build after reviewing its independent full-load evidence. */
  readonly qualificationSha256: string
  readonly read: (asset: WasmAsset, limitBytes: number, exactLength?: boolean) => Promise<Uint8Array<ArrayBuffer>>
}

const variantEvidence = z.strictObject({
  artifactSha256: sha256Schema,
  anchors: z.tuple([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4),
    z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  variableCfl: z.literal(true),
  restart: z.literal(true),
  boundaryChanges: z.literal(true),
  maxPressureErrorPa: z.number().min(0).max(1e-6),
  maxFlowErrorM3s: z.number().min(0).max(1e-12),
})

const qualificationReceipt = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('full-browser-simulation'),
  profileId: z.literal(PROFILE_ID),
  modelVersion: modelVersionSchema,
  profileParameterSha256: sha256Schema,
  artifactManifestSha256: sha256Schema,
  fullLoadReportSha256: sha256Schema,
  variants: z.strictObject({ scalar: variantEvidence.optional(), simd: variantEvidence.optional() })
    .refine(({ scalar, simd }) => scalar !== undefined || simd !== undefined),
})

const artifactEntry = z.object({
  sha256: sha256Schema,
  byteLength: z.number().int().min(8).max(WASM_LIMIT),
})
const artifactManifest = z.object({ variants: z.object({ scalar: artifactEntry, simd: artifactEntry }) })

function variantOf(file: `${Variant}-polylog.wasm`): Variant {
  return file === 'simd-polylog.wasm' ? 'simd' : 'scalar'
}

async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function readPinnedJson(deployment: WasmDeployment, file: 'qualification.json' | 'manifest.json', hash: string) {
  const name = file === 'qualification.json' ? 'qualification receipt' : 'artifact manifest'
  const raw = await deployment.read(file, JSON_LIMIT)
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > JSON_LIMIT) {
    throw new Error(`WASM ${name} size outside limit`)
  }
  const owned = new Uint8Array(raw)
  if (await digest(owned) !== hash) throw new Error(`WASM ${name} hash mismatch`)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(owned)) as unknown
  } catch (cause) {
    throw new Error(`WASM ${name} is invalid JSON`, { cause })
  }
}

export function matchesSimulationBackend(left: SimulationBackendIdentity, right: SimulationBackendIdentity): boolean {
  if (left.solver === 'typescript-f64') return right.solver === 'typescript-f64'
  return right.solver === 'wasm-f64' && left.variant === right.variant && left.artifactSha256 === right.artifactSha256
}

function unavailable(expected: WasmIdentity | undefined, cause?: Error): SimulationBackend {
  if (expected) throw new Error(`Replay hydraulic backend incompatible with this deployment${cause ? `: ${cause.message}` : ''}`, { cause })
  return TYPESCRIPT_SIMULATION_BACKEND
}

class UnqualifiedVariant extends Error {}
class WasmMemoryLimit extends Error {
  constructor() { super('WASM numerical memory resource limit') }
}

function reserve(ledger: NumericalMemoryLedger, label: string, bytes: number) {
  const reservation = ledger.reserveBytes(label, bytes)
  if (!reservation) throw new WasmMemoryLimit()
  return reservation
}

async function readReservedJson(
  ledger: NumericalMemoryLedger, deployment: WasmDeployment, file: 'qualification.json' | 'manifest.json', hash: string,
) {
  const workspace = reserve(ledger, 'WASM JSON workspace', 3 * JSON_LIMIT)
  try {
    return await readPinnedJson(deployment, file, hash)
  } finally {
    workspace.release()
  }
}

function retainedBackend(
  identity: WasmIdentity, fields: HydraulicFieldBackend, memory: NumericalMemoryReservation,
): SimulationBackend {
  let activeFields: HydraulicFieldBackend | undefined = fields
  return Object.freeze({
    identity,
    fields: (...parameters: Parameters<HydraulicFieldBackend>) => {
      if (!activeFields) throw new Error('WASM hydraulic backend was retired')
      return activeFields(...parameters)
    },
    releaseMemory: () => {
      activeFields = undefined
      memory.release()
    },
  })
}

export async function resolveSimulationBackend(
  profile: FluidProfile,
  deployment?: WasmDeployment,
  expectedIdentity?: SimulationBackendIdentity,
  ledger = createNumericalMemoryLedger('simulation'),
): Promise<SimulationBackend> {
  if (expectedIdentity?.solver === 'typescript-f64') return TYPESCRIPT_SIMULATION_BACKEND
  if (!deployment || profile.mode !== 'turbulent' || profile.profileId !== PROFILE_ID || typeof WebAssembly === 'undefined') {
    return unavailable(expectedIdentity)
  }
  if (!sha256Schema.safeParse(deployment.qualificationSha256).success) throw new Error('Invalid WASM qualification receipt pin')
  let receipt: z.infer<typeof qualificationReceipt>
  let rawManifest: unknown
  try {
    receipt = qualificationReceipt.parse(await readReservedJson(ledger, deployment, 'qualification.json', deployment.qualificationSha256))
    if (receipt.modelVersion !== profile.modelVersion
      || receipt.profileParameterSha256 !== (await createCheckpointAnchor(0, profile)).parameterHash) return unavailable(expectedIdentity)
    if (expectedIdentity && receipt.variants[expectedIdentity.variant]?.artifactSha256 !== expectedIdentity.artifactSha256) {
      return unavailable(expectedIdentity)
    }
    rawManifest = await readReservedJson(ledger, deployment, 'manifest.json', receipt.artifactManifestSha256)
  } catch (error) {
    if (error instanceof WasmMemoryLimit) return unavailable(expectedIdentity, error)
    if (error instanceof z.ZodError) throw new Error('Invalid WASM qualification receipt', { cause: error })
    throw error
  }
  return selectQualifiedVariant(receipt, rawManifest, deployment, expectedIdentity, ledger)
}

async function selectQualifiedVariant(
  receipt: z.infer<typeof qualificationReceipt>, rawManifest: unknown, deployment: WasmDeployment,
  expected: WasmIdentity | undefined, ledger: NumericalMemoryLedger,
): Promise<SimulationBackend> {
  const manifest = artifactManifest.parse(rawManifest)
  const simdSupported = expected ? expected.variant === 'simd' : receipt.variants.simd ? undefined : false
  let scratch: NumericalMemoryReservation | undefined
  let capacity: NumericalMemoryReservation | undefined
  try {
    const selected = await loadOilWasmBackend(rawManifest, async (file) => {
      const variant = variantOf(file)
      const evidence = receipt.variants[variant]
      if (!evidence) throw new UnqualifiedVariant('Selected capability has no qualified WASM binary')
      const artifact = manifest.variants[variant]
      if (artifact.sha256 !== evidence.artifactSha256) throw new Error('WASM artifact differs from qualification evidence')
      capacity = reserve(ledger, 'WASM linear memory capacity', WASM_LIMIT)
      scratch = reserve(ledger, 'WASM artifact workspace', 2 * artifact.byteLength)
      return deployment.read(file, artifact.byteLength, true)
    }, { simdSupported })
    if (!capacity) throw new Error('WASM backend loaded without a memory reservation')
    const backend = retainedBackend(Object.freeze({
      solver: 'wasm-f64', variant: selected.variant, artifactSha256: selected.sha256,
    }), selected.fields, capacity)
    capacity = undefined
    return backend
  } catch (error) {
    if (error instanceof WasmMemoryLimit || error instanceof UnqualifiedVariant) return unavailable(expected, error)
    if (expected) throw new Error('Replay hydraulic backend incompatible with this deployment', { cause: error })
    throw error
  } finally {
    scratch?.release()
    capacity?.release()
  }
}

async function readDeploymentAsset(asset: WasmAsset, limitBytes: number, exactLength = false): Promise<Uint8Array<ArrayBuffer>> {
  return readWorkerReleaseAsset(`oil/${asset}`, limitBytes, { exactLength })
}

export function configuredWasmDeployment(): WasmDeployment | undefined {
  const qualificationSha256 = import.meta.env?.VITE_PIPETWIN_WASM_QUALIFICATION_SHA256 as string | undefined
  return qualificationSha256 ? { qualificationSha256, read: readDeploymentAsset } : undefined
}
