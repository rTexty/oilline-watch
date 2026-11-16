import { PhysicsDomainError, requireDomain } from './guards';
import { openingAt } from './leak';
import type { HydraulicFieldBackend, HydraulicFields, ResolvedInputs } from './moc';
import type { HydraulicState } from './state';

const NODES = 401;
const WORKSPACE_WORDS = 7 * NODES + 1;
const MEMORY_LIMIT_BYTES = 2 * 1024 * 1024;
const ABI_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;

type Variant = 'scalar' | 'simd';
type OilWasmFile = `${Variant}-polylog.wasm`;

interface Artifact {
  readonly file: OilWasmFile;
  readonly sha256: string;
  readonly byteLength: number;
}

interface Kernel {
  readonly memory: WebAssembly.Memory;
  readonly workspace_ptr: () => number;
  readonly step_si: (
    nodes: number, courant: number, seconds: number, waveSpeed: number, density: number, impedance: number,
    area: number, diameter: number, roughness: number, pin: number, qout: number, leakNode: number, opening: number,
    externalPressure: number, pressureMin: number, pressureMax: number, referenceFlow: number,
  ) => number;
}

export interface OilWasmBackend {
  readonly variant: Variant;
  readonly abiVersion: typeof ABI_VERSION;
  readonly sha256: string;
  readonly linearMemoryBytes: number;
  readonly fields: HydraulicFieldBackend;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseArtifact(value: unknown, variant: Variant): Artifact {
  const data = record(value);
  const file = `${variant}-polylog.wasm` as const;
  if (!data || data.file !== file || typeof data.sha256 !== 'string' || !SHA256.test(data.sha256)
    || typeof data.byteLength !== 'number' || !Number.isSafeInteger(data.byteLength)
    || data.byteLength < 8 || data.byteLength > MEMORY_LIMIT_BYTES) {
    throw new TypeError(`Invalid oil WASM manifest for ${variant}`);
  }
  return { file, sha256: data.sha256, byteLength: data.byteLength };
}

function parseManifest(value: unknown) {
  const data = record(value);
  const variants = record(data?.variants);
  if (!data || data.schemaVersion !== 1 || data.abiVersion !== ABI_VERSION || !variants
    || data.target !== 'wasm32-unknown-unknown' || data.memoryLimitBytes !== MEMORY_LIMIT_BYTES
    || typeof data.sourceSha256 !== 'string' || !SHA256.test(data.sourceSha256)) {
    throw new TypeError('Invalid oil WASM manifest');
  }
  return { scalar: parseArtifact(variants.scalar, 'scalar'), simd: parseArtifact(variants.simd, 'simd') };
}

function supportsSimd() {
  // An empty function executes i8x16.splat, then drops the result.
  return WebAssembly.validate(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
    10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11,
  ]));
}

async function verifyArtifact(artifact: Artifact, bytes: Uint8Array<ArrayBuffer>) {
  const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...checksum].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (hex !== artifact.sha256) throw new Error('Oil WASM artifact hash does not match the manifest');
}

function inspectExports(exports: WebAssembly.Exports, variant: Variant): Kernel {
  const { memory, step_si, workspace_ptr, workspace_words, kernel_version, kernel_variant } = exports;
  if (!(memory instanceof WebAssembly.Memory) || typeof step_si !== 'function' || typeof workspace_ptr !== 'function'
    || typeof workspace_words !== 'function' || workspace_words() !== WORKSPACE_WORDS
    || typeof kernel_version !== 'function' || kernel_version() !== ABI_VERSION
    || typeof kernel_variant !== 'function' || kernel_variant() !== (variant === 'simd' ? 2 : 1)
    || memory.buffer.byteLength > MEMORY_LIMIT_BYTES) {
    throw new Error('Oil WASM kernel ABI does not match the manifest');
  }
  return { memory, step_si: step_si as Kernel['step_si'], workspace_ptr: workspace_ptr as Kernel['workspace_ptr'] };
}

function workspace(kernel: Kernel): Float64Array<ArrayBuffer> {
  const ptr = kernel.workspace_ptr() >>> 0;
  const { buffer } = kernel.memory;
  requireDomain(ptr > 0 && ptr % 8 === 0 && ptr + 8 * WORKSPACE_WORDS <= buffer.byteLength
    && buffer.byteLength <= MEMORY_LIMIT_BYTES, 'Oil WASM workspace is outside its memory limit');
  return new Float64Array(buffer as ArrayBuffer, ptr, WORKSPACE_WORDS);
}

function validateState(
  state: HydraulicState, inputs: ResolvedInputs, seconds: number, courant: number, viscosity: Float64Array,
) {
  const { definition, areaM2, waveSpeedMps, impedance } = state.profile;
  const { limits, geometry, grid, publicFluidProfile, initialPublicControls } = definition;
  if (definition.mode !== 'turbulent' || state.zielke !== null || state.vardyBrown || state.profile.vardyBrownKernel) {
    throw new PhysicsDomainError('unsupported-physics', 'Oil WASM supports only turbulent quasi-steady friction');
  }
  const nodes = grid.segments + 1;
  requireDomain(Number.isSafeInteger(nodes) && nodes >= 3 && nodes <= NODES
    && [state.p, state.qL, state.qR].every((field) => field instanceof Float64Array && field.length === nodes)
    && viscosity instanceof Float64Array && viscosity.length === nodes - 1,
  'Oil WASM input field dimensions are invalid');
  const pressureMin = Math.max(limits.pressureMinPa, limits.phaseMinPa);
  const { pressureMaxPa, externalPressurePa } = limits;
  const stepUs = Math.round(seconds * 1e6);
  requireDomain(Number.isSafeInteger(state.timeUs) && state.timeUs >= 0
    && Number.isSafeInteger(stepUs) && Math.abs(stepUs - seconds * 1e6) < 1e-6 && stepUs > 0
    && stepUs <= state.profile.stepUs && state.timeUs + stepUs <= definition.horizonUs && courant > 0 && courant <= 1
    && inputs.pinPa >= pressureMin && inputs.pinPa <= pressureMaxPa && Number.isFinite(inputs.qoutM3s)
    && Number.isFinite(externalPressurePa) && externalPressurePa < pressureMin
    && [waveSpeedMps, publicFluidProfile.rho0KgM3, impedance, areaM2, geometry.diameterM,
      pressureMin, pressureMaxPa, initialPublicControls.outletFlowM3s].every((value) => Number.isFinite(value) && value > 0)
    && geometry.roughnessM >= 0 && geometry.roughnessM / geometry.diameterM <= 0.05,
  'Oil WASM expects finite SI inputs and an integer microsecond step within the CFL limit');
  requireDomain(state.p.every((value) => value >= pressureMin && value <= pressureMaxPa)
    && state.qL.every(Number.isFinite) && state.qR.every(Number.isFinite)
    && viscosity.every((value) => Number.isFinite(value) && value > 0),
  'Oil WASM input fields are outside the supported domain');
}

function solve(kernel: Kernel, state: HydraulicState, inputs: ResolvedInputs, seconds: number,
  courant: number, viscosity: Float64Array): HydraulicFields {
  validateState(state, inputs, seconds, courant, viscosity);
  const { definition, areaM2, waveSpeedMps, impedance } = state.profile;
  const { limits, geometry, publicFluidProfile, initialPublicControls } = definition;
  const opening = inputs.leak ? openingAt(inputs.leak, state.timeUs) : 0;
  const leakNode = inputs.leak?.node ?? 0;
  const nodes = state.p.length;
  requireDomain(opening === 0 || Number.isSafeInteger(leakNode) && leakNode >= 1 && leakNode < nodes - 1
    && publicFluidProfile.phaseQualification === 'stipulated-synthetic', 'Oil WASM leak input is outside the supported domain');
  const input = workspace(kernel);
  input.set(state.p, 0);
  input.set(state.qL, NODES);
  input.set(state.qR, 2 * NODES);
  input.set(viscosity, 3 * NODES);
  const code = kernel.step_si(
    nodes, courant, seconds, waveSpeedMps, publicFluidProfile.rho0KgM3, impedance, areaM2, geometry.diameterM,
    geometry.roughnessM / geometry.diameterM, inputs.pinPa, inputs.qoutM3s, leakNode, opening,
    limits.externalPressurePa, Math.max(limits.pressureMinPa, limits.phaseMinPa), limits.pressureMaxPa,
    initialPublicControls.outletFlowM3s,
  );
  if (code === 3) throw new PhysicsDomainError('uncertain-flow-regime', 'Oil WASM reached the unsupported transition band');
  requireDomain(code === 0, 'Oil WASM step left the supported model domain');

  const output = workspace(kernel);
  const field = (offset: number) => output.slice(offset * NODES, offset * NODES + nodes);
  return { p: field(4), qL: field(5), qR: field(6), leakFlowM3s: output[7 * NODES]! };
}

/** A missing or mismatched declared artifact fails at startup. SIMD capability alone selects scalar. */
export async function loadOilWasmBackend(
  rawManifest: unknown,
  read: (file: OilWasmFile) => Promise<Uint8Array<ArrayBuffer>>,
  options: { readonly simdSupported?: boolean } = {},
): Promise<OilWasmBackend> {
  const manifest = parseManifest(rawManifest);
  const variant = (options.simdSupported ?? supportsSimd()) ? 'simd' : 'scalar';
  const artifact = manifest[variant];
  const supplied = await read(artifact.file);
  if (!(supplied instanceof Uint8Array) || supplied.byteLength !== artifact.byteLength) {
    throw new Error('Oil WASM artifact size and hash do not match the manifest');
  }
  const bytes = new Uint8Array(supplied);
  await verifyArtifact(artifact, bytes);
  const { instance } = await WebAssembly.instantiate(bytes);
  const kernel = inspectExports(instance.exports, variant);
  workspace(kernel);
  return {
    variant, abiVersion: ABI_VERSION, sha256: artifact.sha256,
    get linearMemoryBytes() { return kernel.memory.buffer.byteLength; },
    fields: (state, inputs, seconds, courant, viscosity) => solve(kernel, state, inputs, seconds, courant, viscosity),
  };
}
