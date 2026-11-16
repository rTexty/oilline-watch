import type { Calibration } from '../../../src/contracts/calibration'
import type { diagnosticSourceHashes } from '../../diagnostic-source-hashes'
import { jsonDocument, sha256 } from '../io'

const fixtureHash = sha256('PipeTwin browser scheduler exercise, version 1')

/** Test-only inputs exercise the real inverse queue without making a calibration claim. */
export function schedulerFixture(
  sensorProfileId: Calibration['sensorProfileId'],
  sourceHashes: ReturnType<typeof diagnosticSourceHashes>,
): Calibration {
  const adverse = sensorProfileId === 'synthetic-oil-adverse-v1'
  const pressure = adverse ? { sigmaSI: 1000, rho: 0.85 } : { sigmaSI: 500, rho: 0.6 }
  const flow = adverse ? { sigmaSI: 0.0001, rho: 0.6 } : { sigmaSI: 0.00005, rho: 0.3 }
  const hashes = { ...sourceHashes, dictionary: fixtureHash, fit: fixtureHash, calibration: fixtureHash, development: fixtureHash }
  return {
    schemaVersion: 1, calibrationId: sha256(jsonDocument({ hashes, sensorProfileId })), modelVersion: '1',
    profileId: 'synthetic-oil-turbulent-v1', bankVersion: '1', sensorProfileId, hashes, releaseScope: 'passive',
    noise: { P1: pressure, P2: pressure, P3: pressure, Qin: flow },
    thresholds: { cusumFast: 200, cusumSlow: 200, improvement: 1, separation: 1, absoluteFit: 1, profile: 1, envelope: 1 },
    errorEnvelope: { numericalFloor: 0, multiplier: 1, qualified: true },
    qualification: { quantitative: true, active: false }, reportHash: fixtureHash,
  }
}
