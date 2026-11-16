import { calibrationSchema } from '../contracts/calibration'
import type { Calibration } from '../contracts/calibration'

interface TrustedCalibration {
  readonly calibration: Calibration
  readonly expectedHashes: Calibration['hashes']
}

const sourceKeys = ['model', 'profile', 'bank', 'sensor', 'policy'] as const

export function sameDiagnosticSources(calibration: Calibration, sourceHashes: unknown): boolean {
  if (typeof sourceHashes !== 'object' || sourceHashes === null) return false
  return sourceKeys.every((key) => Object.hasOwn(sourceHashes, key)
    && calibration.hashes[key] === (sourceHashes as Record<string, unknown>)[key])
}

export function trustedCalibration(
  mode: string | undefined,
  bundled: unknown,
  sourceHashes: unknown,
  fixture?: TrustedCalibration,
): TrustedCalibration | undefined {
  if (mode === 'test' || mode === 'development') return fixture
  if (typeof bundled !== 'string' || bundled.length > 8192) return undefined
  try {
    const result = calibrationSchema.safeParse(JSON.parse(bundled))
    const expected = typeof sourceHashes === 'string' ? JSON.parse(sourceHashes) as unknown : sourceHashes
    return result.success && sameDiagnosticSources(result.data, expected)
      ? { calibration: result.data, expectedHashes: result.data.hashes } : undefined
  } catch {
    return undefined
  }
}
