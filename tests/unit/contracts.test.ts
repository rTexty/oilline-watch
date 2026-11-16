import { describe, expect, it } from 'vitest';
import { modelTimeSchema } from '../../src/contracts/model';
import { publicSampleSchema } from '../../src/contracts/public';
import sample from '../fixtures/public-contract.json';

describe('model time', () => {
  it.each([0, 10_000, 3_600_000_000, Number.MAX_SAFE_INTEGER])('accepts %s microseconds', (time) => {
    expect(modelTimeSchema.safeParse(time).success).toBe(true);
  });

  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10000', null])('rejects invalid time %s', (time) => {
    expect(modelTimeSchema.safeParse(time).success).toBe(false);
  });
});

describe('public measurement contract', () => {
  it('accepts a valid observation and preserves a missing value', () => {
    expect(publicSampleSchema.parse(sample)).toEqual(sample);
    expect(publicSampleSchema.safeParse({ ...sample, valueSI: null, quality: 'missing' }).success).toBe(true);
  });

  it.each([
    { sampleTimeUs: 1.5 }, { deliveredTimeUs: -1 }, { sampleSeq: -1 },
    { valueSI: NaN }, { valueSI: Infinity }, { quality: 'unknown' },
    { leakLocationM: 500 }, { leakAreaM2: 0.001 }, { leakTimeUs: 10000 },
    { privateSeed: 42 }, { futureSamples: [] },
  ])('rejects malformed or private fields %j', (patch) => {
    expect(publicSampleSchema.safeParse({ ...sample, ...patch }).success).toBe(false);
  });

  it('rejects delivery before the physical sample', () => {
    expect(publicSampleSchema.safeParse({ ...sample, deliveredTimeUs: 9999 }).success).toBe(false);
  });
});

describe('synthetic oil profiles', () => {
  it.each([
    'synthetic-oil-turbulent-v1',
    'synthetic-oil-laminar-v1',
    'synthetic-oil-thermal-v1',
  ])('validates the published %s profile', async (id) => {
    const { readFileSync } = await import('node:fs');
    const { profileSchema } = await import('../../src/contracts/model');
    const profile: unknown = JSON.parse(readFileSync(`src/scenarios/${id}.json`, 'utf8'));
    expect(profileSchema.safeParse(profile).success).toBe(true);
  });

  it('rejects unknown versions, incorrect units and nonphysical fluid values', async () => {
    const { readFileSync } = await import('node:fs');
    const { profileSchema } = await import('../../src/contracts/model');
    const profile = JSON.parse(readFileSync('src/scenarios/synthetic-oil-turbulent-v1.json', 'utf8'));
    for (const invalid of [
      { ...profile, schemaVersion: 2 },
      { ...profile, unitsVersion: 2 },
      { ...profile, profileId: 'unknown' },
      { ...profile, publicFluidProfile: { ...profile.publicFluidProfile, rho0KgM3: -1 } },
      { ...profile, geometry: { ...profile.geometry, diameterM: 0 } },
      { ...profile, horizonUs: 1.5 },
    ]) expect(profileSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('private scenario', () => {
  const seed = [1, 2, 3, 4];
  const scenario = {
    schemaVersion: 1,
    profileId: 'synthetic-oil-turbulent-v1',
    modelVersion: '1',
    randomVersion: 'xoshiro128ss-v1',
    seeds: { plant: seed, scenario: seed, sensors: { P1: seed, P2: seed, P3: seed, Qin: seed } },
    events: [{ kind: 'leak', timeUs: 60_000_000, eventOrdinal: 0, positionM: 500, cdAreaM2: 0.000005, openingUs: 20_000_000 }],
  };

  it('accepts a bounded event and rejects one beyond the challenge horizon', async () => {
    const { privateScenarioSchema } = await import('../../src/contracts/private-scenario');
    expect(privateScenarioSchema.safeParse(scenario).success).toBe(true);
    expect(privateScenarioSchema.safeParse({ ...scenario, events: [{ ...scenario.events[0], timeUs: 330_000_001 }] }).success).toBe(false);
  });

  it('rejects imports exceeding the size limit', async () => {
    const { parsePrivateScenario } = await import('../../src/contracts/private-scenario');
    expect(() => parsePrivateScenario(' '.repeat(32 * 1024 * 1024 + 1))).toThrow();
  });
});
