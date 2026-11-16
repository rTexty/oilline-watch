import { describe, expect, it } from 'vitest';
import { freezeWarmup, initialWarmup, updateWarmup } from '../../src/detection/calibration';
import type { PublicBatch, SensorId } from '../../src/contracts/public';
import type { AnchorId } from '../../src/contracts/model';

const ids: SensorId[] = ['P1', 'P2', 'P3', 'Qin'];
const noise = { P1: { sigmaSI: 1 }, P2: { sigmaSI: 1 }, P3: { sigmaSI: 1 }, Qin: { sigmaSI: 1 } };

function batch(timeUs: number, varying: boolean, omitP1: boolean): PublicBatch {
  const value = 100 + (varying && (timeUs / 10_000) % 2 ? 2 : 0);
  const measurements = ids.filter((id) => (id !== 'Qin' || timeUs % 50_000 === 0) && !(id === 'P1' && omitP1)).map((sensorId) => ({
    sensorId, sampleSeq: timeUs / (sensorId === 'Qin' ? 50_000 : 10_000), sampleTimeUs: timeUs,
    deliveredTimeUs: timeUs, valueSI: value, quality: 'valid' as const,
  }));
  const predictions = Array.from({ length: 9 }, (_, id) => {
    const predicted = varying && id === 1 ? value - 10 : 100;
    return { sampleTimeUs: timeUs, anchorId: id as AnchorId, bankVersion: '1' as const, modelVersion: '1' as const,
      profileId: 'synthetic-oil-turbulent-v1' as const, pressurePa: [predicted, predicted, predicted] as const, inletFlowM3s: predicted };
  });
  return { sampleTimeUs: timeUs, measurements, predictions };
}

function warmed(varying: boolean, omitP1 = false) {
  let state = initialWarmup();
  for (let time = 0; time <= 30_000_000; time += 10_000) state = updateWarmup(state, batch(time, varying, omitP1), noise);
  return state;
}

describe('healthy warm-up calibration', () => {
  it('does not freeze before the end of warm-up or with an unavailable sensor', () => {
    expect(freezeWarmup(initialWarmup())).toBeNull();
    expect(freezeWarmup(warmed(false, true))).toBeNull();
  });
  it('uses centered residuals for anchor selection and computes per-anchor final baselines', () => {
    const result = freezeWarmup(warmed(true));
    expect(result).not.toBeNull();
    if (!result) throw new Error('warm-up did not freeze');
    expect(result.anchorId).toBe(1);
    expect(result.frozenBaselines).toHaveLength(9);
    expect(result.frozenBaselines.find((item) => item.anchorId === 1)?.meanBySensor.P1).toBeCloseTo(10, 10);
    expect(result.frozenBaselines.find((item) => item.anchorId === 0)?.meanBySensor.P1).toBeCloseTo(1, 10);
  });
  it('breaks equal scores by the lower anchor ID', () => {
    expect(freezeWarmup(warmed(false))?.anchorId).toBe(0);
  });
});
