import { describe, expect, it } from 'vitest'
import { profileSchema } from '../../src/contracts/model'
import { advanceThermal, initializeThermal, stepThermal, exchangeHeat } from '../../src/physics/thermal'
import laminarProfile from '../../src/scenarios/synthetic-oil-laminar-v1.json'
import thermalProfile from '../../src/scenarios/synthetic-oil-thermal-v1.json'

const profile = () => profileSchema.parse(thermalProfile)

describe('two-temperature heat solver', () => {
  it('reproduces backward Euler exchange of two isolated heat capacities', () => {
    const oilK = 333.15
    const wallK = 313.15
    const oilCapacity = 50_000
    const wallCapacity = 20_000
    const inner = 100
    const dt = 0.1
    const next = exchangeHeat(oilK, wallK, wallK, { oilCapacity, wallCapacity, inner, outer: 0 }, dt)
    const difference = (oilK - wallK) / (1 + dt * inner * (1 / oilCapacity + 1 / wallCapacity))
    expect(next.oilK - next.wallK).toBeCloseTo(difference, 11)
    expect(oilCapacity * (next.oilK - oilK) + wallCapacity * (next.wallK - wallK)).toBeCloseTo(0, 6)
  })

  it('advances a hot inlet, preserves extrema, and recomputes the pressure after heating', () => {
    const config = profile()
    const initial = initializeThermal(config)
    const next = stepThermal(initial, config, 100_000)
    expect(next.timeUs).toBe(100_000)
    expect(next.tOil[0]).toBeGreaterThan(next.tWall[0]!)
    expect(next.tWall[0]).toBeGreaterThan(initial.tWall[0]!)
    expect(Math.min(...next.tOil)).toBe(config.thermal.initialOilTemperatureK)
    expect(Math.max(...next.tOil)).toBeLessThanOrEqual(config.initialPublicControls.inletTemperatureK)
    expect(next.p.at(-1)).toBeGreaterThan(initial.p.at(-1)!)
    expect(initial.tOil[0]).toBe(config.thermal.initialOilTemperatureK)
    expect(next.tOil).not.toBe(initial.tOil)
    expect(next.tWall).not.toBe(initial.tWall)
  })

  it('uses the reverse inflow temperature at the right end and preserves zero-flow equilibrium', () => {
    const laminar = profileSchema.parse(laminarProfile)
    const initial = initializeThermal(laminar)
    const noFlow = stepThermal({ ...initial, qoutM3s: 0 }, laminar, 100_000)
    expect(noFlow.tOil).toEqual(initial.tOil)
    expect(noFlow.tWall).toEqual(initial.tWall)
    const reverse = stepThermal({ ...initial, qoutM3s: -0.003 }, laminar, 100_000, {
      inletK: 313.15, outletK: 333.15, ambientK: 313.15,
    })
    expect(reverse.tOil.at(-1)).toBeGreaterThan(initial.tOil.at(-1)!)
    expect(reverse.tOil[0]).toBe(initial.tOil[0])
  })

  it('preserves the independently calculated steady oil and wall temperature profiles', () => {
    const config = profile()
    const initial = initializeThermal(config)
    const { lengthM } = config.geometry
    const { innerConductanceWMK: inner, outerConductanceWMK: outer } = config.thermal
    const { rho0KgM3, cpJkgK } = config.publicFluidProfile
    const { ambientTemperatureK: ambientK, inletTemperatureK: inletK } = config.initialPublicControls
    const effectiveConductance = 1 / (1 / inner + 1 / outer)
    const transportedCapacity = rho0KgM3 * cpJkgK * initial.qoutM3s
    const coolingPerCell = effectiveConductance * lengthM / config.grid.segments / transportedCapacity
    const tOil = Float64Array.from(initial.tOil, (_, i) => ambientK + (inletK - ambientK) / (1 + coolingPerCell) ** (i + 1))
    const tWall = tOil.map(oilK => ambientK + (oilK - ambientK) * inner / (inner + outer))
    const after = stepThermal({ ...initial, tOil, tWall }, config, 100_000)
    const analyticalOutletK = ambientK + (inletK - ambientK)
      * Math.exp(-effectiveConductance * lengthM / transportedCapacity)
    expect(tOil.at(-1)).toBeCloseTo(analyticalOutletK, 3)
    for (let i = 0; i < tOil.length; i++) {
      expect(after.tOil[i]).toBeCloseTo(tOil[i]!, 11)
      expect(after.tWall[i]).toBeCloseTo(tWall[i]!, 11)
    }
  })

  it('converges under time step halving on the hot-inlet transient', () => {
    const config = profile()
    const run = (dtUs: number) => {
      let state = initializeThermal(config)
      while (state.timeUs < 5_000_000) state = stepThermal(state, config, dtUs)
      return state.tOil[0]!
    }
    const coarse = run(100_000)
    const fine = run(50_000)
    const finer = run(25_000)
    const ratio = Math.abs((coarse - fine) / (fine - finer))
    expect(ratio).toBeGreaterThan(1.8)
    expect(ratio).toBeLessThan(2.2)
  })

  it('rejects excessive CFL and invalid time before committing and reaches the exact deadline', () => {
    const config = profile()
    const initial = initializeThermal(config)
    expect(() => stepThermal({ ...initial, qoutM3s: 3 }, config, 100_000)).toThrow(/CFL/)
    expect(() => advanceThermal(initial, 0.1, config)).toThrow(/deadline/)
    expect(advanceThermal(initial, 450_001, config).timeUs).toBe(450_001)
  })
})
