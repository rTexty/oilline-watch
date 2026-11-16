import { describe, expect, it } from 'vitest';
import { fitSensorBias, prepareFit, prepareSensorBiasFit, scoreCandidate } from '../../src/detection/hypotheses';
import type { Measurement, SensorId } from '../../src/contracts/public';

const channels: Readonly<Record<SensorId, { sigmaSI: number; rho: number; baselineSI: number }>> = {
  P1: { sigmaSI: 1, rho: 0.5, baselineSI: 0 }, P2: { sigmaSI: 1, rho: 0.5, baselineSI: 0 },
  P3: { sigmaSI: 1, rho: 0.5, baselineSI: 0 }, Qin: { sigmaSI: 1, rho: 0.5, baselineSI: 0 },
};
function sample(timeUs: number, valueSI: number, deliveredTimeUs = timeUs): Measurement {
  return { sensorId: 'P1', sampleSeq: timeUs / 10_000, sampleTimeUs: timeUs, deliveredTimeUs, valueSI, quality: 'valid' };
}
const zero = () => 0;

describe('candidate hypothesis scoring', () => {
  it('whitens adjacent observations without bridging missing intervals', () => {
    const evidence = prepareFit([sample(0, 1), sample(10_000, 3), sample(30_000, 5), sample(40_000, 7)], channels, 0, 40_000, 40_000);
    const score = scoreCandidate(evidence, zero);
    expect(score?.count).toBe(2);
    expect(score?.sumSquares).toBeCloseTo((2.5 ** 2 + 4.5 ** 2) / 0.75, 12);
    expect(score?.meanSquare).toBeCloseTo((2.5 ** 2 + 4.5 ** 2) / (2 * 0.75), 12);
  });
  it('keeps the same causal mask for every candidate and rejects missing predictions', () => {
    const observations = [sample(0, 1), sample(10_000, 2), sample(20_000, 999, 50_000), sample(60_000, 999)];
    const evidence = prepareFit(observations, channels, 0, 30_000, 30_000);
    expect(scoreCandidate(evidence, zero)?.count).toBe(1);
    expect(scoreCandidate(evidence, (_id, time) => time === 10_000 ? undefined : 0)).toBeNull();
    expect(scoreCandidate(evidence, zero)).toEqual(scoreCandidate(prepareFit(observations.slice(0, 2), channels, 0, 30_000, 30_000), zero));
  });
  it('does not restore a pair through an invalid duplicate retransmission', () => {
    const invalid = { ...sample(10_000, 5), quality: 'out-of-range' as const };
    const retransmit = sample(10_000, 5, 11_000);
    const evidence = prepareFit([sample(0, 5), invalid, retransmit, sample(20_000, 5)], channels, 0, 20_000, 20_000);
    expect(scoreCandidate(evidence, zero)?.count ?? 0).toBe(0);
  });
  it('fits a causal opening ramp in the whitened domain', () => {
    const samples = [sample(0, 0), sample(10_000, 0.05), sample(20_000, 0.1)];
    const evidence = prepareFit(samples, channels, 0, 20_000, 20_000);
    const fit = fitSensorBias(evidence, zero, 'P1', 0, 1_000_000);
    expect(fit?.amplitudeSI).toBeCloseTo(5, 10);
    expect(fit?.sumSquares).toBeCloseTo(0, 12);
  });
  it('fits the whitened sensor bias analytically and enforces amplitude bounds', () => {
    const observations = [sample(0, 5), sample(10_000, 5), sample(20_000, 5)];
    const fit = fitSensorBias(prepareFit(observations, channels, 0, 20_000, 20_000), zero, 'P1', 0, 0);
    expect(fit?.amplitudeSI).toBeCloseTo(5, 12);
    expect(fit?.sumSquares).toBeCloseTo(0, 12);
    const large = observations.map((item) => ({ ...item, valueSI: 20_000 }));
    expect(fitSensorBias(prepareFit(large, channels, 0, 20_000, 20_000), zero, 'P1', 0, 0)?.amplitudeSI).toBe(10_000);
    expect(fitSensorBias(prepareFit(observations, channels, 0, 20_000, 20_000), zero, 'P1', 100_000, 0)).toBeNull();
  });
});

describe('prepared sensor bias scoring', () => {
  const ids = ['P1', 'P2', 'P3', 'Qin'] as const;
  const noise = { ...channels, P2: { sigmaSI: 0.01, rho: -0.6, baselineSI: 0.25 },
    Qin: { sigmaSI: 0.0001, rho: 0.8, baselineSI: -0.001 } };
  const evidence = prepareFit(ids.flatMap((sensorId, index) => {
    const period = sensorId === 'Qin' ? 50_000 : 10_000;
    return Array.from({ length: 220 }, (_, sampleSeq) => ({
      ...sample(sampleSeq * period, Math.sin(sampleSeq / 7) + index),
      sensorId, sampleSeq,
    })).filter(({ sampleSeq }) => sampleSeq !== 9);
  }), noise, 0, 3_000_000, 3_000_000);
  const nominal = (id: SensorId, time: number) => Math.cos(time / 200_000) + ids.indexOf(id);

  it('looks up each pair once for the whole bias sweep', () => {
    let predictionReads = 0;
    const fit = prepareSensorBiasFit(evidence, (id, time) => {
      predictionReads++;
      return nominal(id, time);
    });
    expect(fit).not.toBeNull();
    for (const sensor of ids) {
      for (const onset of [0, 10_000, 90_001, 500_000, 1_000_000, 3_100_000]) {
        for (const opening of [0, 1_000_000, 20_000_000]) {
          expect(fit?.(sensor, onset, opening)).toEqual(fitSensorBias(evidence, nominal, sensor, onset, opening));
        }
      }
    }
    expect(predictionReads).toBe(2 * evidence.pairs.length);
  });

  it('uses the same original-order sum for interleaved or reversed evidence', () => {
    const mixed = { pairs: [...evidence.pairs].sort((a, b) => b.currentTimeUs - a.currentTimeUs) };
    const fit = prepareSensorBiasFit(mixed, nominal);
    for (const sensor of ids) {
      expect(fit?.(sensor, 10_000, 20_000_000)).toEqual(fitSensorBias(mixed, nominal, sensor, 10_000, 20_000_000));
    }
  });

  it('adds unaffected terms in their original order with and without a cached suffix', () => {
    const unitNoise = { sigmaSI: 1, rho: 0, baselineSI: 0 };
    const fixture = prepareFit([
      sample(0, 0), sample(10_000, 2 ** 27),
      ...[0, 1, 1].map((value, index) => ({ ...sample(10_000 * index, value), sensorId: 'P2' as const })),
      ...[0, 1, 1, 1].map((value, index) => ({ ...sample(10_000 * index, value), sensorId: 'P3' as const })),
    ], { P1: unitNoise, P2: unitNoise, P3: unitNoise, Qin: unitNoise }, 0, 30_000, 30_000);

    // At 2**54, each unaffected +1 rounds away. Adding a regrouped subtotal
    // of the four small terms would change the score by one ULP.
    const grouped = prepareSensorBiasFit(fixture, zero);
    expect(grouped?.('P2', 20_000, 0)).toMatchObject({ amplitudeSI: 1, sumSquares: 2 ** 54 });
    expect(grouped?.('P2', 10_000, 1_000_000)).toMatchObject({ amplitudeSI: 100, sumSquares: 2 ** 54 });

    const [large, firstP2, lastP2, firstP3, ...tail] = fixture.pairs;
    const interleaved = prepareSensorBiasFit({ pairs: [large!, firstP2!, firstP3!, lastP2!, ...tail] }, zero);
    expect(interleaved?.('P2', 0, 0)).toMatchObject({ amplitudeSI: 1, sumSquares: 2 ** 54 });
  });

  it('rejects a missing or nonfinite innovation even outside the target channel', () => {
    for (const missing of [undefined, Number.POSITIVE_INFINITY]) {
      const predict = (id: SensorId, time: number) => id === 'Qin' ? missing : nominal(id, time);
      expect(prepareSensorBiasFit(evidence, predict)).toBeNull();
      expect(fitSensorBias(evidence, predict, 'P1', 10_000, 0)).toBeNull();
    }
  });
});
