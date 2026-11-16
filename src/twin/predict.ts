import { BANK_VERSION, MODEL_VERSION } from '../contracts/model'
import type { AnchorId, FluidProfile } from '../contracts/model'
import type { PublicPrediction } from '../contracts/public'
import type { HydraulicState } from '../physics/state'
import { deriveProfile } from '../physics/state'

function withBulk(profile: FluidProfile, factor: number): FluidProfile {
  return { ...profile, publicFluidProfile: { ...profile.publicFluidProfile, bulkModulusPa: profile.publicFluidProfile.bulkModulusPa * factor } }
}

function withViscosity(profile: FluidProfile, factor: number): FluidProfile {
  const law = profile.publicFluidProfile.viscosity
  if (law.kind !== 'walther') throw new Error('The nominal bank requires Walther viscosity.')
  const multiplier = (law.multiplier ?? 1) * factor
  return { ...profile, publicFluidProfile: { ...profile.publicFluidProfile, viscosity: { ...law, multiplier } } }
}

function withRoughness(profile: FluidProfile, factor: number): FluidProfile {
  return { ...profile, geometry: { ...profile.geometry, roughnessM: profile.geometry.roughnessM * factor } }
}

function withDensity(profile: FluidProfile, factor: number): FluidProfile {
  return { ...profile, publicFluidProfile: { ...profile.publicFluidProfile, rho0KgM3: profile.publicFluidProfile.rho0KgM3 * factor } }
}

export function bankProfiles(profile: FluidProfile): readonly FluidProfile[] {
  return [profile, withBulk(profile, 0.98), withBulk(profile, 1.02),
    withViscosity(profile, 0.95), withViscosity(profile, 1.05),
    withRoughness(profile, 0.8), withRoughness(profile, 1.2),
    withDensity(profile, 0.99), withDensity(profile, 1.01)]
    .map((anchor) => ({ ...anchor, grid: { ...anchor.grid, nominalStepUs: deriveProfile(anchor).stepUs } }))
}

export function predict(state: HydraulicState, anchorId: AnchorId): PublicPrediction {
  const pressure = (fraction: number) => {
    const point = (state.p.length - 1) * fraction
    const lower = Math.floor(point)
    const upper = Math.ceil(point)
    return state.p[lower]! + (point - lower) * (state.p[upper]! - state.p[lower]!)
  }
  return {
    sampleTimeUs: state.timeUs, anchorId, bankVersion: BANK_VERSION, modelVersion: MODEL_VERSION,
    profileId: state.profile.definition.profileId,
    pressurePa: [pressure(0.1), pressure(0.5), pressure(0.9)], inletFlowM3s: state.qR[0]!,
  }
}
