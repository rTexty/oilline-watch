import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { deriveProfile, viscosityAt } from '../../src/physics/state'
import { bankProfiles } from '../../src/twin/predict'
import raw from '../../src/scenarios/synthetic-oil-turbulent-v1.json'

describe('nominal anchor definitions', () => {
  it('scales the full viscosity function and publishes the correct CFL step per anchor', () => {
    const bank = bankProfiles(profileSchema.parse(raw))
    const nominal = deriveProfile(bank[0]!)
    for (const temperatureK of [308.15, 323.15, 338.15]) {
      const base = viscosityAt(nominal, temperatureK)
      expect(viscosityAt(deriveProfile(bank[3]!), temperatureK) / base).toBeCloseTo(0.95, 12)
      expect(viscosityAt(deriveProfile(bank[4]!), temperatureK) / base).toBeCloseTo(1.05, 12)
    }
    for (const anchor of bank) {
      expect(profileSchema.safeParse(anchor).success).toBe(true)
      expect(anchor.grid.nominalStepUs).toBe(deriveProfile(anchor).stepUs)
    }
  })
})
