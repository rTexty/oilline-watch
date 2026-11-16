import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { accumulateThermalFlow, applyAcousticThermalTick, initialThermalFlow } from '../../src/physics/coupling'
import { initialEnergyLedger } from '../../src/physics/conservation'
import turbulentProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json'

const fields = (tOil: number[]) => ({
  tOil: Float64Array.from(tOil),
  tWall: Float64Array.from(tOil),
  ledger: initialEnergyLedger(),
})

describe('acoustic heat transport', () => {
  it('integrates both sides of a flow reversal even with zero net volume', () => {
    const profile = profileSchema.parse(turbulentProfile)
    const segments = profile.grid.segments
    const initial = initialThermalFlow(segments)
    const old = new Float64Array(segments + 1)
    const next = new Float64Array(segments + 1)
    old[1] = 0.02
    next[1] = -0.02
    const flow = accumulateThermalFlow(initial, { qL: old, qR: old }, { qL: next, qR: next }, 100_000)
    expect(flow.leftPositiveM3[1]).toBeCloseTo(0.0005, 15)
    expect(flow.leftNegativeM3[1]).toBeCloseTo(0.0005, 15)
    expect(initial.leftPositiveM3[1]).toBe(0)
    const temperatures = Array.from({ length: segments }, (_, i) => i === 0 ? 333.15 : 313.15)
    const result = applyAcousticThermalTick(fields(temperatures), flow, profile)
    expect(result.tOil[0]).toBeLessThan(temperatures[0]!)
    expect(result.tOil[1]).toBeGreaterThan(temperatures[1]!)
    expect(result.ledger.normalizedResidual).toBeLessThan(1e-6)
  })

  it('charges one mixed leak enthalpy when both sides flow into the junction', () => {
    const profile = profileSchema.parse(turbulentProfile)
    const segments = profile.grid.segments
    const left = new Float64Array(segments + 1)
    const right = new Float64Array(segments + 1)
    left[1] = 0.02
    right[1] = -0.01
    const flows = { qL: left, qR: right }
    const flow = accumulateThermalFlow(initialThermalFlow(segments), flows, flows, 100_000)
    const temperatures = Array.from({ length: segments }, (_, i) => i === 0 ? 333.15 : 313.15)
    const result = applyAcousticThermalTick(fields(temperatures), flow, profile)
    const rhoCp = profile.publicFluidProfile.rho0KgM3 * profile.publicFluidProfile.cpJkgK
    expect(result.ledger.leakJ).toBeCloseTo(rhoCp * (0.002 * 333.15 + 0.001 * 313.15), 7)
    expect(result.ledger.compressionApproxJ).toBeCloseTo(result.ledger.leakJ, 7)
    expect(result.ledger.normalizedResidual).toBeLessThan(1e-6)
  })

  it('preserves a uniform oil and wall field at the lower domain bound during a leak', () => {
    const profile = profileSchema.parse(turbulentProfile)
    const segments = profile.grid.segments
    const left = new Float64Array(segments + 1).fill(0.025)
    const right = left.slice()
    right[1] = 0.02
    const flows = { qL: left, qR: right }
    const flow = accumulateThermalFlow(initialThermalFlow(segments), flows, flows, 100_000)
    const t = profile.limits.temperatureMinK
    const initial = fields(Array.from({ length: segments }, () => t))
    const result = applyAcousticThermalTick(initial, flow, profile, { inletK: t, outletK: t, ambientK: t })
    expect(result.tOil).toEqual(initial.tOil)
    expect(result.tWall).toEqual(initial.tWall)
    expect(result.ledger.residualJ).toBeCloseTo(0, 8)
  })
})
