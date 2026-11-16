import { describe, expect, it } from 'vitest'
import { createDetector, advanceDetector } from '../../src/detection/detector'
import { trustedCalibration } from '../../src/runtime/diagnostic-release'
import type { Calibration } from '../../src/contracts/calibration'
import type { AnchorId } from '../../src/contracts/model'
import type { PublicBatch, SensorId } from '../../src/contracts/public'
import profile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'
import { profileSchema } from '../../src/contracts/model'

const hash = 'a'.repeat(64)
const hashes = { model: hash, profile: hash, bank: hash, sensor: hash, policy: hash, dictionary: hash, fit: hash, calibration: hash, development: hash }
const noise = { sigmaSI: 1, rho: 0 }
const calibration: Calibration = {
  schemaVersion: 1, calibrationId: hash, modelVersion: '1', profileId: 'synthetic-oil-turbulent-v1',
  bankVersion: '1', sensorProfileId: 'synthetic-oil-nominal-v1', hashes, releaseScope: 'passive',
  noise: { P1: noise, P2: noise, P3: noise, Qin: noise },
  thresholds: { cusumFast: 2, cusumSlow: 2, improvement: 1, separation: 1, absoluteFit: 1, profile: 1, envelope: 1 },
  errorEnvelope: { numericalFloor: 0, multiplier: 1, qualified: true },
  qualification: { quantitative: true, active: false }, reportHash: hash,
}
const scenario = profileSchema.parse(profile)
const ids: SensorId[] = ['P1', 'P2', 'P3', 'Qin']
function batch(timeUs: number, shift = 0, omitted: SensorId[] = []): PublicBatch {
  return {
    sampleTimeUs: timeUs,
    measurements: ids.filter((id) => !omitted.includes(id) && (id !== 'Qin' || timeUs % 50_000 === 0)).map((sensorId) => ({
      sensorId, sampleSeq: timeUs / (sensorId === 'Qin' ? 50_000 : 10_000), sampleTimeUs: timeUs,
      deliveredTimeUs: timeUs, valueSI: 100 + (sensorId === 'P1' ? shift : 0), quality: 'valid' as const,
    })),
    predictions: Array.from({ length: 9 }, (_, id) => ({ sampleTimeUs: timeUs, anchorId: id as AnchorId,
      bankVersion: '1' as const, modelVersion: '1' as const, profileId: 'synthetic-oil-turbulent-v1' as const,
      pressurePa: [100, 100, 100] as const, inletFlowM3s: 100 })),
  }
}
function warm(omitted: SensorId[] = []) {
  let state = createDetector(scenario, calibration, hashes)
  for (let t = 0; t <= 30_000_000; t += 10_000) state = advanceDetector(state, batch(t, 0, omitted))
  return state
}

describe('qualified detector', () => {
  it('binds the production calibration to independently supplied build digests', () => {
    const fixture = { calibration, expectedHashes: hashes }
    expect(trustedCalibration('test', undefined, undefined, fixture)).toEqual(fixture)
    expect(trustedCalibration('production', undefined, hashes, fixture)).toBeUndefined()
    expect(trustedCalibration('production', JSON.stringify(calibration), { ...hashes, profile: 'b'.repeat(64) })).toBeUndefined()
    expect(trustedCalibration('production', '{', hashes)).toBeUndefined()
    expect(trustedCalibration('production', JSON.stringify(calibration), hashes)).toEqual(fixture)
  })
  it('refuses absent, unqualified, or mismatched calibration artifacts and missing expected hashes', () => {
    expect(createDetector(scenario, null, hashes).status).toBe('uncalibrated')
    expect(createDetector(scenario, calibration).status).toBe('uncalibrated')
    expect(createDetector(scenario, { ...calibration, qualification: { quantitative: false, active: false } }, hashes).status).toBe('uncalibrated')
    expect(createDetector(scenario, calibration, { ...hashes, policy: 'b'.repeat(64) }).status).toBe('uncalibrated')
    expect(createDetector(scenario, { ...calibration, sensorProfileId: 'synthetic-oil-adverse-v1' }, hashes).status).toBe('uncalibrated')
  })
  it('arms only after sufficient healthy warmup and freezes the deterministic baseline', () => {
    expect(createDetector(scenario, calibration, hashes).status).toBe('warming-up')
    const ready = warm()
    expect(ready.status).toBe('ready')
    expect(ready.warmupFit?.anchorId).toBe(0)
    expect(ready.warmupFit?.frozenBaselines[0]?.meanBySensor.P1).toBe(0)
    expect(warm(['P1']).status).toBe('insufficient-data')
  })
  it('opens one episode for sustained evidence and ignores a repeated batch', () => {
    let state = warm()
    state = advanceDetector(state, batch(30_010_000))
    state = advanceDetector(state, batch(30_020_000, 10))
    expect(state.episode?.openedAtUs).toBe(30_020_000)
    expect(state.lastAlarmUs).toBe(30_020_000)
    const repeated = advanceDetector(state, batch(30_020_000, 100))
    expect(repeated.episode).toEqual(state.episode)
    expect(repeated.lastAlarmUs).toBe(state.lastAlarmUs)
  })
  it('reports insufficient pressure data after an outage', () => {
    let state = warm()
    for (let t = 30_010_000; t <= 30_600_000; t += 10_000) state = advanceDetector(state, batch(t, 0, ['P1', 'P2']))
    expect(state.status).toBe('insufficient-data')
  })

  it('joins adverse deliveries to the prediction at measurement time and publishes alarms at arrival', () => {
    const adverse = { ...scenario, sensorProfileId: 'synthetic-oil-adverse-v1' } as const
    const artifact = { ...calibration, sensorProfileId: adverse.sensorProfileId }
    let state = createDetector(adverse, artifact, hashes)
    for (let timeUs = 0; timeUs <= 30_050_000; timeUs += 10_000) {
      const physicalUs = timeUs - 20_000
      const delivery = physicalUs < 0 ? [] : batch(physicalUs, physicalUs === 30_020_000 ? 10 : 0).measurements
        .map((reading) => ({ ...reading, deliveredTimeUs: timeUs }))
      state = advanceDetector(state, { ...batch(timeUs), measurements: delivery })
      if (timeUs < 30_040_000) expect(state.lastAlarmUs).toBeNull()
    }
    expect(state.warmupFit?.anchorId).toBe(0)
    expect(state.status).toBe('ready')
    expect(state.lastAlarmUs).toBe(30_040_000)
  })
})
