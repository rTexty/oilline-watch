import { predictionCheckpointSchema } from '../contracts/inference';
import type { PublicPredictionCheckpoint } from '../contracts/inference';
import { BANK_VERSION, MAX_IMPORT_BYTES, SCHEMA_VERSION, UNITS_VERSION } from '../contracts/model';
import type { AnchorId, FluidProfile } from '../contracts/model';
import { parseBoundedJson } from '../contracts/scenario';
import { PhysicsDomainError, requireDomain, requireFlowRegime } from '../physics/guards';
import { validateInputs } from '../physics/moc';
import { deriveProfile, viscosityAt } from '../physics/state';
import type { HydraulicProfile, HydraulicState, PhysicsResult } from '../physics/state';
import type { ZielkeState } from '../physics/zielke';

export interface CheckpointAnchor {
  readonly anchorId: AnchorId;
  readonly definition: FluidProfile;
  readonly parameterHash: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (
      left < right ? -1 : Number(left > right)
    ));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function createCheckpointAnchor(anchorId: AnchorId, definition: FluidProfile): Promise<CheckpointAnchor> {
  const encoded = new TextEncoder().encode(canonicalJson(definition));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const parameterHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { anchorId, definition, parameterHash };
}

function copyThermalFlow(flow: HydraulicState['thermalFlow']): HydraulicState['thermalFlow'] {
  return {
    elapsedUs: flow.elapsedUs,
    leftPositiveM3: flow.leftPositiveM3.slice(),
    leftNegativeM3: flow.leftNegativeM3.slice(),
    rightPositiveM3: flow.rightPositiveM3.slice(),
    rightNegativeM3: flow.rightNegativeM3.slice(),
  };
}

function copyMemory(state: HydraulicState): PublicPredictionCheckpoint['memory'] {
  const { zielke, profile } = state;
  if (zielke === null) return { kind: 'none' };
  requireDomain(profile.zielkeKernel !== null, 'Laminar checkpoint requires a Zielke kernel');
  return {
    kind: 'zielke',
    kernelVersion: profile.zielkeKernel.version,
    ringLength: profile.zielkeKernel.historyLength,
    ringIndex: zielke.cursor,
    historyCount: zielke.historyCount,
    ring: zielke.deltas.slice(),
    tails: zielke.tail.slice(),
    previousVelocity: zielke.previousVelocity.slice(),
    acceleration: zielke.acceleration.slice(),
  };
}

export function makeCheckpoint(
  state: HydraulicState,
  anchor: CheckpointAnchor,
  controlRevision = 0,
): PublicPredictionCheckpoint {
  const { profile, timeUs, eventCursor, lastThermalTimeUs } = state;
  const { definition, dxM } = profile;
  requireDomain(state.vardyBrown === undefined && profile.vardyBrownKernel === undefined,
    'Internal Vardy–Brown trajectories are not eligible for public checkpoints');
  requireDomain(state.inputs.leak == null && state.leakFlowM3s === 0, 'Public checkpoints require a nominal trajectory');
  requireDomain(state.inputs.inletLaw == null, 'Private inlet waveforms cannot enter a public checkpoint');
  requireDomain(state.inputs.outletPulse == null, 'A checkpoint cannot omit an ongoing outlet pulse');
  requireDomain(anchor.definition === definition || canonicalJson(anchor.definition) === canonicalJson(definition),
    'Checkpoint anchor parameters differ');
  const { pinPa, qoutM3s, tinK, ambientK } = state.inputs;
  const cellCount = definition.grid.segments;
  return predictionCheckpointSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    unitsVersion: UNITS_VERSION,
    dtype: 'float64',
    modelVersion: definition.modelVersion,
    profileId: definition.profileId,
    bankVersion: BANK_VERSION,
    anchorId: anchor.anchorId,
    parameterHash: anchor.parameterHash,
    timeUs,
    grid: { cellCount, nodeCount: cellCount + 1, faceCount: cellCount + 1, spacingM: dxM },
    pressurePa: state.p.slice(),
    leftFlowM3s: state.qL.slice(),
    rightFlowM3s: state.qR.slice(),
    oilTemperatureK: state.tOil.slice(),
    wallTemperatureK: state.tWall.slice(),
    thermalFlow: copyThermalFlow(state.thermalFlow),
    lastThermalTimeUs,
    splittingPhase: 'hydraulic',
    memory: copyMemory(state),
    boundaries: { pinPa, qoutM3s, tinK, ambientK },
    controlRevision,
    eventCursor,
    previousFlux: { inletFlowM3s: state.qL[0]!, outletFlowM3s: state.qR[cellCount]!, withdrawalM3s: 0 },
    volumeBalance: { ...state.volumeBalance },
    energyLedger: { ...state.energyLedger },
  });
}

function matchingProfile(checkpoint: PublicPredictionCheckpoint, anchor: CheckpointAnchor): HydraulicProfile {
  const { definition } = anchor;
  requireDomain(checkpoint.anchorId === anchor.anchorId && checkpoint.parameterHash === anchor.parameterHash
    && checkpoint.profileId === definition.profileId && checkpoint.modelVersion === definition.modelVersion,
  'Checkpoint anchor, parameters or version mismatch');
  const profile = deriveProfile(definition);
  const { grid, timeUs, splittingPhase, previousFlux } = checkpoint;
  requireDomain(grid.cellCount === definition.grid.segments && grid.spacingM === profile.dxM
    && timeUs <= definition.horizonUs && splittingPhase === 'hydraulic', 'Checkpoint grid or clock is incompatible');
  requireDomain(previousFlux.inletFlowM3s === checkpoint.leftFlowM3s[0]
    && previousFlux.outletFlowM3s === checkpoint.rightFlowM3s[grid.cellCount], 'Checkpoint boundary flux is inconsistent');
  return profile;
}

function restoreMemory(checkpoint: PublicPredictionCheckpoint, profile: HydraulicProfile): ZielkeState | null {
  const { memory, timeUs, leftFlowM3s } = checkpoint;
  const kernel = profile.zielkeKernel;
  if (memory.kind === 'none' && kernel === null) return null;
  requireDomain(memory.kind === 'zielke' && kernel !== null
    && memory.kernelVersion === kernel.version && memory.ringLength === kernel.historyLength,
  'Checkpoint friction memory and kernel differ');
  const steps = timeUs / kernel.stepUs;
  requireDomain(Number.isInteger(steps) && memory.ringIndex === steps % memory.ringLength
    && memory.historyCount === Math.min(steps, memory.ringLength),
  'Checkpoint friction memory and model clock are inconsistent');
  requireDomain(memory.previousVelocity.every((value, node) => value === leftFlowM3s[node]! / profile.areaM2),
    'Checkpoint friction memory velocity is inconsistent');
  return {
    cursor: memory.ringIndex,
    historyCount: memory.historyCount,
    deltas: memory.ring.slice(),
    tail: memory.tails.slice(),
    previousVelocity: memory.previousVelocity.slice(),
    acceleration: memory.acceleration.slice(),
  };
}

function validateFlow(state: HydraulicState): void {
  const { profile, qL, qR, tOil } = state;
  const { definition, areaM2 } = profile;
  for (let node = 0; node < qL.length; node++) {
    const velocity = qL[node]! / areaM2;
    requireDomain(qL[node] === qR[node], 'Nominal checkpoint cannot contain an internal withdrawal');
    const left = viscosityAt(profile, tOil[Math.max(0, node - 1)]!);
    const right = viscosityAt(profile, tOil[Math.min(node, tOil.length - 1)]!);
    const velocityDiameter = Math.abs(velocity) * definition.geometry.diameterM;
    requireFlowRegime(velocityDiameter / left, velocity, definition.mode === 'laminar');
    requireFlowRegime(velocityDiameter / right, velocity, definition.mode === 'laminar');
  }
}

export function restoreCheckpoint(raw: unknown, anchor: CheckpointAnchor): PhysicsResult {
  const parsed = predictionCheckpointSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: new PhysicsDomainError('outside-model-domain', 'Invalid checkpoint schema') };
  const checkpoint = parsed.data;
  try {
    const profile = matchingProfile(checkpoint, anchor);
    const inputs = Object.fromEntries(Object.entries(checkpoint.boundaries).filter(([, value]) => value !== undefined));
    const restored: HydraulicState = {
      profile,
      timeUs: checkpoint.timeUs,
      eventCursor: checkpoint.eventCursor,
      inputs,
      p: checkpoint.pressurePa.slice(),
      qL: checkpoint.leftFlowM3s.slice(),
      qR: checkpoint.rightFlowM3s.slice(),
      tOil: checkpoint.oilTemperatureK.slice(),
      tWall: checkpoint.wallTemperatureK.slice(),
      thermalFlow: copyThermalFlow(checkpoint.thermalFlow),
      lastThermalTimeUs: checkpoint.lastThermalTimeUs,
      zielke: restoreMemory(checkpoint, profile),
      energyLedger: { ...checkpoint.energyLedger },
      volumeBalance: { ...checkpoint.volumeBalance },
      leakFlowM3s: 0,
    };
    validateInputs(restored, restored.inputs);
    validateFlow(restored);
    return { ok: true, value: restored };
  } catch (error) {
    if (error instanceof PhysicsDomainError) return { ok: false, error };
    throw error;
  }
}

export function serializeCheckpoint(checkpoint: PublicPredictionCheckpoint): string {
  const parsed = predictionCheckpointSchema.parse(checkpoint);
  const text = JSON.stringify(parsed, (_key, value: unknown) => value instanceof Float64Array ? Array.from(value) : value);
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) throw new RangeError('Checkpoint exceeds export limit');
  return text;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a checkpoint object');
  return value as Record<string, unknown>;
}

function decodeBuffers(object: Record<string, unknown>, shapes: Readonly<Record<string, number>>) {
  return {
    ...object,
    ...Object.fromEntries(Object.entries(shapes).map(([field, limit]) => {
      const values = object[field];
      if (!Array.isArray(values) || values.length > limit || !values.every((value: unknown) => Number.isFinite(value))) {
        throw new TypeError(`Invalid Float64 checkpoint array: ${field}`);
      }
      return [field, Float64Array.from(values)];
    })),
  };
}

function decodeMemory(value: unknown): Record<string, unknown> {
  const memory = readObject(value);
  if (memory.kind === 'none') return memory;
  if (memory.kind !== 'zielke') throw new TypeError('Unsupported checkpoint memory');
  return decodeBuffers(memory, { ring: 401 * 800, tails: 401 * 5, previousVelocity: 401, acceleration: 401 });
}

export function parseCheckpoint(text: string, anchor: CheckpointAnchor): PublicPredictionCheckpoint {
  const object = readObject(parseBoundedJson(text));
  const checkpoint = predictionCheckpointSchema.parse({
    ...decodeBuffers(object, {
      pressurePa: 401, leftFlowM3s: 401, rightFlowM3s: 401, oilTemperatureK: 400, wallTemperatureK: 400,
    }),
    thermalFlow: decodeBuffers(readObject(object.thermalFlow), {
      leftPositiveM3: 401, leftNegativeM3: 401, rightPositiveM3: 401, rightNegativeM3: 401,
    }),
    memory: decodeMemory(object.memory),
  });
  const restored = restoreCheckpoint(checkpoint, anchor);
  if (!restored.ok) throw restored.error;
  return checkpoint;
}
