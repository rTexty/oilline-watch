import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { profileSchema } from '../../src/contracts/model';
import { initialize } from '../../src/physics/initialize';
import { advanceTo } from '../../src/physics/advance-to';

function initial() {
  const result = initialize(profileSchema.parse(JSON.parse(readFileSync('src/scenarios/synthetic-oil-turbulent-v1.json', 'utf8'))));
  if (!result.ok) throw new Error('initialization failed');
  return result.value;
}

describe('model clock', () => {
  it('reaches an integer deadline exactly including a short final step', () => {
    const state = initial();
    const result = advanceTo(state, 11234);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('advance failed');
    expect(result.value.timeUs).toBe(11234);
    expect(state.timeUs).toBe(0);
  });
  it('applies a control at the deadline without changing the completed state until the next step', () => {
    const state = initial();
    const eventTime = 10_000;
    const healthy = advanceTo(state, eventTime);
    const event = advanceTo(state, eventTime, {}, [{ timeUs: eventTime, inputs: { qoutM3s: state.qR[state.qR.length - 1]! - 1e-4 } }]);
    expect(healthy.ok && event.ok).toBe(true);
    if (!healthy.ok || !event.ok) throw new Error('advance failed');
    expect(Array.from(event.value.p)).toEqual(Array.from(healthy.value.p));
    expect(event.value.eventCursor).toBe(1);
    const after = advanceTo(event.value, 15_000);
    expect(after.ok).toBe(true);
    if (after.ok) expect(Array.from(after.value.p)).not.toEqual(Array.from(healthy.value.p));
  });
  it('rejects a fractional or backwards deadline', () => {
    expect(advanceTo(initial(), 1.5).ok).toBe(false);
    expect(advanceTo(initial(), -1).ok).toBe(false);
  });
});

describe('laminar fixed clock', () => {
  it('accepts a fixed-grid deadline and rejects a fractional deadline', () => {
    const parsed = profileSchema.parse(JSON.parse(readFileSync('src/scenarios/synthetic-oil-laminar-v1.json', 'utf8')));
    const initialState = initialize(parsed);
    if (!initialState.ok) throw new Error('initialization failed');
    expect(advanceTo(initialState.value, 10_000).ok).toBe(true);
    expect(advanceTo(initialState.value, 15_000).ok).toBe(false);
  });
});
