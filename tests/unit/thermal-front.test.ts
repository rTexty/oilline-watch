import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { advanceThermal, initializeThermal, initializeThermalTemperature, stepThermal, stepThermalTemperature } from '../../src/physics/thermal'
import thermalProfile from '../../src/scenarios/synthetic-oil-thermal-v1.json'

// Independent characteristic analytical reference from the S06 thermal qualification,
// 200 cells, cell-average oil temperatures in K (analyticalSamples, not solver samples).
const frontSamples = [
  { seconds: 120, cells: [[10, 331.37395892595026], [15, 330.17510171224995], [18, 329.3345364042611], [19, 316.35110852476583], [20, 313.15], [21, 313.15]] },
  { seconds: 900, cells: [[120, 322.6319020848726], [135, 318.9760213777144], [140, 317.7253981977103], [143, 316.9814099322057], [144, 313.15], [145, 313.15]] },
] as const

describe('thermal front analytical qualification', () => {
  it.each(frontSamples)('resolves the front at $seconds seconds and conserves enthalpy', ({ seconds, cells }) => {
    const profile = profileSchema.parse(thermalProfile)
    const state = advanceThermal(initializeThermal(profile), seconds * 1_000_000, profile)
    const maxErrorK = Math.max(...cells.map(([index, expected]) => Math.abs(state.tOil[index]! - expected)))
    expect(maxErrorK).toBeLessThanOrEqual(0.25)
    const { ledger } = state
    const expectedInJ = profile.publicFluidProfile.rho0KgM3 * profile.publicFluidProfile.cpJkgK
      * state.qoutM3s * seconds * profile.initialPublicControls.inletTemperatureK
    expect(ledger.boundaryInJ / expectedInJ).toBeCloseTo(1, 10)
    expect(ledger.boundaryOutJ).toBeGreaterThan(0)
    const balance = ledger.oilChangeJ + ledger.wallChangeJ - ledger.boundaryInJ
      + ledger.boundaryOutJ + ledger.leakJ + ledger.ambientJ - ledger.compressionApproxJ
    expect(Math.abs(balance) / ledger.scaleJ).toBeLessThanOrEqual(1e-6)
  })

  it('retains the analytical front on the 800-cell temperature-only refinement at 900 seconds', () => {
    const parsed = profileSchema.parse(thermalProfile)
    const profile = { ...parsed, grid: { ...parsed.grid, segments: 800 } }
    let state = initializeThermalTemperature(profile)
    while (state.timeUs < 900_000_000) state = stepThermalTemperature(state, profile, 100_000)
    // S06 independent characteristic analyticalSamples: 800-cell means near x = 720 m.
    const expected = [[570, 317.1974882701996], [574, 316.95055978558617],
      [575, 316.88900825081964], [576, 313.15], [577, 313.15]] as const
    expect(Math.max(...expected.map(([i, value]) => Math.abs(state.tOil[i]! - value)))).toBeLessThanOrEqual(0.25)
    expect(state.startupFront).toBeDefined()
    for (const value of [...state.tOil, ...state.tWall]) {
      expect(value).toBeGreaterThanOrEqual(profile.thermal.initialOilTemperatureK - 1e-9)
      expect(value).toBeLessThanOrEqual(profile.initialPublicControls.inletTemperatureK + 1e-9)
    }
    expect(state.ledger.normalizedResidual).toBeLessThanOrEqual(1e-6)
  }, 30_000)

  it('integrates outlet enthalpy across a half-step insulated front crossing', () => {
    const parsed = profileSchema.parse(thermalProfile)
    const profile = { ...parsed, thermal: { ...parsed.thermal, innerConductanceWMK: 0, outerConductanceWMK: 0 } }
    const before = advanceThermal(initializeThermal(profile), 1_249_950_000, profile)
    const after = stepThermal(before, profile, 100_000)
    const coldK = profile.thermal.initialOilTemperatureK
    const hotK = profile.initialPublicControls.inletTemperatureK
    const expectedOutJ = profile.publicFluidProfile.rho0KgM3 * profile.publicFluidProfile.cpJkgK
      * before.qoutM3s * 0.1 * (coldK + hotK) / 2
    expect(after.ledger.boundaryOutJ - before.ledger.boundaryOutJ).toBeCloseTo(expectedOutJ, 4)
    for (const oilK of after.tOil) expect(oilK).toBeCloseTo(hotK, 8)
    for (const wallK of after.tWall) expect(wallK).toBeCloseTo(profile.thermal.initialWallTemperatureK, 8)
    expect(after.ledger.normalizedResidual).toBeLessThanOrEqual(1e-6)
  }, 30_000)

  it.each([
    { initialOilK: 308.15, boundaryK: 338.15 },
    { initialOilK: 338.15, boundaryK: 308.15 },
  ])('keeps valid extreme temperatures in range during startup: $initialOilK K oil', ({ initialOilK, boundaryK }) => {
    const parsed = profileSchema.parse(thermalProfile)
    const profile = {
      ...parsed,
      thermal: { ...parsed.thermal, initialOilTemperatureK: initialOilK, initialWallTemperatureK: boundaryK },
      initialPublicControls: { ...parsed.initialPublicControls, inletTemperatureK: boundaryK, ambientTemperatureK: boundaryK },
    }
    const state = advanceThermal(initializeThermal(profile), 12_000_000, profile)
    for (const value of [...state.tOil, ...state.tWall]) {
      expect(value).toBeGreaterThanOrEqual(profile.limits.temperatureMinK)
      expect(value).toBeLessThanOrEqual(profile.limits.temperatureMaxK)
    }
    expect(state.ledger.normalizedResidual).toBeLessThanOrEqual(1e-6)
  })

  it('conserves energy when inlet temperature and flow change after a front has formed', () => {
    const profile = profileSchema.parse(thermalProfile)
    const formed = advanceThermal(initializeThermal(profile), 120_000_000, profile)
    const flow = formed.qoutM3s / 2
    const inletK = 323.15
    const next = stepThermal({ ...formed, qoutM3s: flow }, profile, 100_000, {
      inletK, outletK: 313.15, ambientK: 313.15,
    })
    const capacity = profile.publicFluidProfile.rho0KgM3 * profile.publicFluidProfile.cpJkgK * flow * 0.1
    expect(next.ledger.boundaryInJ - formed.ledger.boundaryInJ).toBeCloseTo(capacity * inletK, 5)
    expect(next.ledger.boundaryOutJ - formed.ledger.boundaryOutJ).toBeCloseTo(capacity * formed.tOil.at(-1)!, 5)
    expect(next.ledger.normalizedResidual).toBeLessThanOrEqual(1e-6)
  })
})
