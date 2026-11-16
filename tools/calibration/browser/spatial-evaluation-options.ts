import { resolve } from 'node:path'
import { sha256Schema } from '../../../src/contracts/calibration'

export const PACED_SPATIAL_ASSET_PATH = 'calibration/spatial-envelope.json'

export const spatialEvaluationOptions = {
  'spatial-evaluation': { type: 'string' },
  'expected-spatial-evaluation-sha256': { type: 'string' },
} as const

export function parseSpatialEvaluationOptions(values: {
  readonly 'spatial-evaluation'?: string
  readonly 'expected-spatial-evaluation-sha256'?: string
}, hasSelection: boolean) {
  const { 'spatial-evaluation': path, 'expected-spatial-evaluation-sha256': expected } = values
  if (path === undefined && expected === undefined) return undefined
  if (!path || !expected || !hasSelection) {
    throw new Error('Spatial evaluation requires --spatial-evaluation and --expected-spatial-evaluation-sha256 with a selected policy.')
  }
  return { path: resolve(path), expectedSha256: sha256Schema.parse(expected) }
}
