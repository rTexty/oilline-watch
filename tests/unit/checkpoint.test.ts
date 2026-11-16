import { describe, expect, it } from 'vitest';
import { profileSchema } from '../../src/contracts/model';
import { advanceTo } from '../../src/physics/advance-to';
import { initialize } from '../../src/physics/initialize';
import type { PhysicsResult } from '../../src/physics/state';
import rawLaminarProfile from '../../src/scenarios/synthetic-oil-laminar-v1.json';
import rawProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json';
import {
  createCheckpointAnchor, makeCheckpoint, parseCheckpoint, restoreCheckpoint, serializeCheckpoint,
} from '../../src/twin/checkpoint';

const profile = profileSchema.parse(rawProfile);

function state(result: PhysicsResult) {
  if (!result.ok) throw result.error;
  return result.value;
}

describe('public prediction checkpoint', () => {
  it('resumes an exact step through a thermal tick after an event boundary', async () => {
    const anchor = await createCheckpointAnchor(0, profile);
    const initial = state(initialize(profile));
    const atEvent = state(advanceTo(initial, 95_000, undefined, [{
      timeUs: 95_000, inputs: { qoutM3s: profile.initialPublicControls.outletFlowM3s * 0.98 },
    }]));
    const checkpoint = makeCheckpoint(atEvent, anchor, 1);
    const json = serializeCheckpoint(checkpoint);
    const parsed = parseCheckpoint(json, anchor);
    const resumed = state(restoreCheckpoint(parsed, anchor));
    expect(parsed.thermalFlow.elapsedUs).toBe(95_000);
    expect(parsed.eventCursor).toBe(1);
    expect(parsed.controlRevision).toBe(1);
    expect(parsed.pressurePa).not.toBe(atEvent.p);
    expect(resumed).toEqual(atEvent);
    expect(state(advanceTo(resumed, 105_000))).toEqual(state(advanceTo(atEvent, 105_000)));
  });

  it('rejects a checkpoint from another anchor and rejects invalid shapes', async () => {
    const anchor = await createCheckpointAnchor(0, profile);
    const other = await createCheckpointAnchor(1, profile);
    const checkpoint = makeCheckpoint(state(initialize(profile)), anchor);
    expect(restoreCheckpoint(checkpoint, other).ok).toBe(false);
    expect(restoreCheckpoint({ ...checkpoint, pressurePa: new Float64Array(1) }, anchor).ok).toBe(false);
    const json = serializeCheckpoint(checkpoint);
    const corrupted: unknown = JSON.parse(json);
    expect(() => parseCheckpoint(JSON.stringify({ ...(corrupted as object), privateSeed: [1, 2, 3, 4] }), anchor)).toThrow();
  });

  it('rejects internal Vardy–Brown state until its checkpoint format is qualified', async () => {
    const anchor = await createCheckpointAnchor(0, profile);
    const internal = state(initialize(profile, { friction: 'vardy-brown' }));
    expect(() => makeCheckpoint(internal, anchor)).toThrow('Vardy–Brown');
  });

  it('restores the nonzero Zielke memory and resumes its next step', async () => {
    const laminar = profileSchema.parse(rawLaminarProfile);
    const anchor = await createCheckpointAnchor(0, laminar);
    const atBraking = state(advanceTo(state(initialize(laminar)), 2_050_000));
    const checkpoint = makeCheckpoint(atBraking, anchor);
    const resumed = state(restoreCheckpoint(parseCheckpoint(serializeCheckpoint(checkpoint), anchor), anchor));
    expect(checkpoint.memory.kind).toBe('zielke');
    expect(resumed.zielke?.acceleration.some((value) => value !== 0)).toBe(true);
    expect(state(advanceTo(resumed, 2_060_000))).toEqual(state(advanceTo(atBraking, 2_060_000)));
  });
});
