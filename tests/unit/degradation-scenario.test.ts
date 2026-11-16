import { describe, expect, it } from 'vitest'
import { runCpu, runGpu } from '../../src/degradation/scenario'
import type { ScenarioRow } from '../../src/degradation/scenario'

const rows: readonly ScenarioRow[] = [
  { segmentId: 12, thicknessMm: [1, 2, 3, 4, 5, 6, 7] },
  { segmentId: 3, thicknessMm: [2.99996, 3, 3, 3, 3, 3, 8] },
]

describe('degradation scenarios', () => {
  it('preserves segment order and publishes threshold-major strict counts', () => {
    const result = runCpu(rows, [3, 9, 3.0001, 0])
    expect(result.segmentCount).toBe(2)
    expect(result.thresholdCount).toBe(4)
    expect(result.meansMm).toEqual(new Float64Array([4, 26 / 7]))
    expect(result.belowCounts).toEqual(new Uint32Array([2, 0, 7, 7, 3, 6, 0, 0]))
  })

  it('keeps means available for an empty threshold list', () => {
    const result = runCpu(rows.slice(0, 1), [])
    expect(result.meansMm).toEqual(new Float64Array([4]))
    expect(result.belowCounts).toHaveLength(0)
  })

  it('rejects invalid inputs before attempting GPU initialization', async () => {
    expect(() => runCpu(rows, [Number.NaN])).toThrow(/threshold/)
    expect(() => runCpu([{ segmentId: -1, thicknessMm: [1, 2, 3, 4, 5, 6, 7] }], [])).toThrow(/segment/)
    await expect(runGpu([{ segmentId: 0, thicknessMm: [1, 2, 3, 4, 5, 6, -7] }], [3])).rejects.toThrow(/thickness/)
  })

  it('surfaces missing WebGPU for the CPU fallback', async () => {
    await expect(runGpu(rows, [3])).rejects.toThrow(/WebGPU is unavailable/)
  })
})
