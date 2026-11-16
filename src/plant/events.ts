import { nearestLeakNode } from '../physics/leak'
import type { LeakLaw } from '../physics/leak'
import type { FluidProfile } from '../contracts/model'

export interface LeakInput {
  readonly positionM: number
  readonly cdAreaM2: number
  readonly openingUs: number
}

export interface LeakTruth extends LeakInput {
  readonly timeUs: number
}

export function createLeak(profile: FluidProfile, timeUs: number, input: LeakInput) {
  if (profile.publicFluidProfile.phaseQualification !== 'stipulated-synthetic') {
    throw new Error('Фазовая область профиля не подтверждена.')
  }
  const node = nearestLeakNode(input.positionM, profile.geometry.lengthM, profile.grid.segments)
  if (!Number.isFinite(input.cdAreaM2) || input.cdAreaM2 <= 0 || input.cdAreaM2 > 4e-5) {
    throw new Error('CdA вне допустимого диапазона.')
  }
  if (!Number.isSafeInteger(input.openingUs) || input.openingUs < 0 || input.openingUs > 20_000_000) {
    throw new Error('Время открытия вне допустимого диапазона.')
  }
  const law: LeakLaw = { node, onsetUs: timeUs, rampUs: input.openingUs, cdA: input.cdAreaM2 }
  const truth: LeakTruth = {
    cdAreaM2: input.cdAreaM2, openingUs: input.openingUs, timeUs,
    positionM: node * profile.geometry.lengthM / profile.grid.segments,
  }
  return { law, truth }
}
