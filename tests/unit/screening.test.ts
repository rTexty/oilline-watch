import { describe, expect, it } from 'vitest'
import { screenCandidate, screeningNodes, screeningOnsets } from '../../src/detection/screening'
import type { PreparedResponse } from '../../src/detection/screening'

describe('response dictionary screening', () => {
  it('retains both end-adjacent coarse nodes on the standard grid', () => {
    const nodes = screeningNodes(199)
    expect(nodes).toHaveLength(41)
    expect(nodes.slice(0, 3)).toEqual([1, 6, 11])
    expect(nodes.slice(-2)).toEqual([196, 199])
    const bounds = { firstOnsetUs: 0, lastOnsetUs: 7_000_000, lastNode: 199, nominalFlowM3s: 0.025 }
    expect(screeningOnsets(bounds, 4_000_000)).toHaveLength(28)
    expect(screeningOnsets(bounds, 30_000_000)).toHaveLength(7)
  })

  it('fits a bounded amplitude on a causal ramp-integrated unit response', () => {
    const unit = 100_000
    const response: PreparedResponse = {
      trace: { model: 'MB', anchorId: 0, stepResponse: new Float64Array([0, 0, 0, 0, unit, 0, 0, 0]) },
      integrated: new Float64Array([0, 0, 0, 0, unit * 5000, 0, 0, 0]),
      lastSampleUs: 10_000,
    }
    const row = {
      sensorId: 'P1', previousTimeUs: 0, currentTimeUs: 10_000, rho: 0, scale: 1, residual: 0.25,
    } as const
    expect(screenCandidate(response, [row], 0, 1_000_000, 0.025)).toMatchObject({
      candidate: { model: 'MB', anchorId: 0, amplitudeM3s: 0.0005 }, score: 0,
    })
    expect(screenCandidate(response, [row], 10_000, 0, 0.025)).toBeNull()
  })
})

describe('response dictionary binary transport', () => {
  it('verifies byte length, digest, and canonical trace order before creating zero-copy views', async () => {
    const { loadResponseDictionary } = await import('../../src/detection/screening')
    const traces = Array.from({ length: 9 }, (_, anchorId) => [
      ...screeningNodes(199).map((node) => ({ model: 'ML', anchorId, node, sampleCount: 2 })),
      { model: 'MB', anchorId, sampleCount: 2 },
    ]).flat()
    const raw = new Float64Array(traces.length * 2 * 4)
    raw[4] = 15
    const digest = await crypto.subtle.digest('SHA-256', raw.buffer)
    const hash = Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('')
    const manifest = {
      schemaVersion: 1, samplePeriodUs: 10_000, profileId: 'synthetic-oil-turbulent-v1',
      modelVersion: '1', bankVersion: '1', anchorParameterHashes: Array(9).fill('a'.repeat(64)),
      dataSha256: hash, traces,
    }
    const dictionary = await loadResponseDictionary(manifest, raw.buffer, hash)
    expect(dictionary?.traces[0]?.stepResponse[4]).toBe(15)
    expect(dictionary?.traces[0]?.stepResponse.buffer).toBe(raw.buffer)
    expect(await loadResponseDictionary({ ...manifest, traces: traces.toReversed() }, raw.buffer, hash)).toBeNull()
    expect(await loadResponseDictionary(manifest, raw.buffer.slice(8), hash)).toBeNull()
    expect(await loadResponseDictionary(manifest, raw.buffer, 'b'.repeat(64))).toBeNull()
  })
})
