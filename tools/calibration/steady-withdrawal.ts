import type { FluidProfile } from '../../src/contracts/model'
import { frictionAcceleration } from '../../src/physics/friction'
import { requireDomain, requireRange } from '../../src/physics/guards'
import { initialize } from '../../src/physics/initialize'
import type { LeakLaw } from '../../src/physics/leak'
import { pressureIntegral, viscosityAt } from '../../src/physics/state'
import type { HydraulicState } from '../../src/physics/state'

export function initializeSteadyWithdrawal(definition: FluidProfile, leak: LeakLaw): HydraulicState {
  const initialized = initialize(definition)
  if (!initialized.ok) throw initialized.error
  const previous = initialized.value
  const { profile } = previous
  const { geometry, limits, initialPublicControls, publicFluidProfile } = definition
  const { diameterM, roughnessM } = geometry
  const { rho0KgM3 } = publicFluidProfile
  const { inletPressurePa, outletFlowM3s } = initialPublicControls
  const viscosity = viscosityAt(profile, definition.thermal.initialOilTemperatureK)
  const positionM = leak.node * profile.dxM
  requireDomain(leak.onsetUs === 0 && leak.rampUs === 0 && positionM > 0 && positionM < geometry.lengthM
    && limits.externalPressurePa < limits.pressureMinPa, 'Steady withdrawal needs a fixed, internal opening')
  const gradient = (flowM3s: number) =>
    rho0KgM3 * frictionAcceleration(flowM3s / profile.areaM2, viscosity, diameterM, roughnessM)
  const discharge = (pressurePa: number) =>
    leak.cdA * Math.sqrt(2 * (pressurePa - limits.externalPressurePa) / rho0KgM3)
  const residual = (pressurePa: number) =>
    pressurePa + gradient(outletFlowM3s + discharge(pressurePa)) * positionM - inletPressurePa
  let low: number = limits.pressureMinPa
  let high = inletPressurePa
  requireDomain(residual(low) <= 0 && residual(high) >= 0, 'Steady withdrawal does not bracket a physical pressure')
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = (low + high) / 2
    if (middle === low || middle === high) break
    if (residual(middle) > 0) high = middle
    else low = middle
  }
  const pressurePa = (low + high) / 2
  requireDomain(Math.abs(residual(pressurePa)) <= 1e-7, 'Steady withdrawal pressure did not converge')
  const leakFlowM3s = discharge(pressurePa)
  const inletFlowM3s = outletFlowM3s + leakFlowM3s
  const upstream = gradient(inletFlowM3s)
  const downstream = gradient(outletFlowM3s)
  const p = previous.p.map((_, index) => {
    const distance = (index - leak.node) * profile.dxM
    const value = pressurePa - distance * (index <= leak.node ? upstream : downstream)
    requireRange(value, limits.pressureMinPa, limits.pressureMaxPa, 'Initial pressure')
    return value
  })
  const qL = previous.qL.map((_, index) => index <= leak.node ? inletFlowM3s : outletFlowM3s)
  const qR = previous.qR.map((_, index) => index < leak.node ? inletFlowM3s : outletFlowM3s)
  return {
    ...previous, p, qL, qR, leakFlowM3s, inputs: { leak },
    volumeBalance: { ...previous.volumeBalance, initialPressureIntegralPaM: pressureIntegral(p, profile.dxM) },
  }
}
