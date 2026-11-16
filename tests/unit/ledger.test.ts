import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { advanceThermal, initializeThermal } from '../../src/physics/thermal'
import thermalProfile from '../../src/scenarios/synthetic-oil-thermal-v1.json'

describe('sensible energy ledger', () => {
  it('reports stored energy, ambient loss and both boundary enthalpies', () => {
    const profile = profileSchema.parse(thermalProfile)
    const initial = initializeThermal(profile)
    const { ledger } = advanceThermal(initial, 30_000_000, profile)
    expect(ledger.oilChangeJ).toBeGreaterThan(0)
    expect(ledger.wallChangeJ).toBeGreaterThan(0)
    expect(ledger.ambientJ).toBeGreaterThan(0)
    expect(ledger.boundaryInJ).toBeGreaterThan(ledger.boundaryOutJ)
    expect(ledger.leakJ).toBe(0)
    expect(ledger.compressionApproxJ).toBe(0)
    expect(ledger.normalizedResidual).toBeLessThan(1e-6)
    expect(Math.abs(ledger.residualJ)).toBeLessThan(0.01)
    expect(initial.ledger.oilChangeJ).toBe(0)
  })
})
