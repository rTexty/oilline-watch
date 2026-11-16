import { describe, expect, it } from 'vitest'
import { candidateKey, compareTrials, neighbors } from '../../src/detection/optimizer'
import type { HydraulicCandidate } from '../../src/detection/optimizer'

const leak = { model: 'ML', anchorId: 2, node: 1, cdAreaM2: 5e-6, onsetUs: 3_000_000, openingUs: 0 } as const
const bounds = { firstOnsetUs: 3_000_000, lastOnsetUs: 7_000_000, lastNode: 199, nominalFlowM3s: 0.025 }

describe('bounded candidate optimization', () => {
  it('keeps neighbors within causal, hydraulic and spatial bounds', () => {
    const choices = neighbors(leak, bounds, 0)
    expect(choices).toContainEqual({ ...leak, node: 6 })
    expect(choices).toContainEqual({ ...leak, openingUs: 1_000_000 })
    expect(choices).toContainEqual({ ...leak, anchorId: 0 })
    expect(choices.every((trial) => trial.onsetUs >= bounds.firstOnsetUs)).toBe(true)
    expect(new Set(choices.map(candidateKey)).size).toBe(choices.length)
    expect(choices.map(candidateKey)).not.toContain(candidateKey(leak))
  })

  it('uses deterministic location and anchor order when scores tie', () => {
    const alternatives: HydraulicCandidate[] = [leak, { ...leak, anchorId: 1 }, { ...leak, node: 2 }]
    const ranked = alternatives.map((candidate) => ({ candidate, score: 1 })).sort(compareTrials)
    expect(ranked.map(({ candidate }) => candidate)).toEqual([alternatives[1], alternatives[0], alternatives[2]])
  })
})
