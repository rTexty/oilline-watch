import { profileSchema } from '../../src/contracts/model'
import type { FluidProfile } from '../../src/contracts/model'
import { PRESSURE_PERIOD_US } from '../../src/contracts/public'
import { deriveProfile } from '../../src/physics/state'
import { createLeak } from '../../src/plant/events'
import { createEngine } from '../../src/runtime/engine'
import type { Engine, ValidationEvent } from '../../src/runtime/engine'
import type { RecipeEvent, ScenarioRecipe } from './generate-scenarios'
import { initializeSteadyWithdrawal } from './steady-withdrawal'

export function validateScenarioTarget(profile: FluidProfile, targetUs: number): void {
  if (!Number.isSafeInteger(targetUs) || targetUs <= 0 || targetUs > profile.horizonUs || targetUs % PRESSURE_PERIOD_US !== 0) {
    throw new RangeError('Validation deadline must be a pressure tick within the profile horizon.')
  }
}

export type ValidationClosure = 'qs' | 'vb10'
type PublicBoundary = Extract<RecipeEvent, { kind: 'boundary-step' }>
type UnsupportedReason = 'continuous-boundary-forcing' | 'initial-withdrawal-equilibrium' | 'unrepresented-withdrawal-position'

type Prepared =
  | { readonly status: 'ready'; readonly engine: Engine; readonly publicBoundaries: readonly PublicBoundary[] }
  | { readonly status: 'unsupported'; readonly reason: UnsupportedReason }

function gridMatches(positionM: number, lengthM: number, segments: number): boolean {
  const node = positionM / (lengthM / segments)
  return Number.isInteger(node) && node > 0 && node < segments
}

function truePlantProfile(profile: FluidProfile, recipe: ScenarioRecipe, segments: number): FluidProfile {
  const { parameterBlock: block } = recipe
  const { viscosity } = profile.publicFluidProfile
  if (viscosity.kind !== 'walther') throw new Error('Validation requires the declared Walther model.')
  const plant = {
    ...profile,
    grid: { ...profile.grid, segments },
    geometry: { ...profile.geometry, roughnessM: block.roughnessM },
    publicFluidProfile: {
      ...profile.publicFluidProfile, bulkModulusPa: block.bulkModulusPa, rho0KgM3: block.rho0KgM3,
      viscosity: { ...viscosity, multiplier: block.viscosityMultiplier },
    },
  }
  return profileSchema.parse({ ...plant, grid: { segments, nominalStepUs: deriveProfile(plant).stepUs } })
}

function compileEvent(event: RecipeEvent, plant: FluidProfile): readonly ValidationEvent[] {
  switch (event.kind) {
    case 'withdrawal': {
      const { law } = createLeak(plant, event.timeUs, event)
      return [{ kind: 'leak', timeUs: event.timeUs, inputs: { leak: law } }]
    }
    case 'boundary-step':
      if (event.rampUs > 0) return [{ kind: 'private-control', timeUs: event.timeUs, inputs: { inletLaw: {
        kind: 'linear-ramp', startUs: event.timeUs, durationUs: event.rampUs,
        baselinePa: plant.initialPublicControls.inletPressurePa, targetPa: event.targetSI,
      } } }]
      return [{ kind: event.visibility === 'public' ? 'control' : 'private-control', timeUs: event.timeUs,
        inputs: event.channel === 'inlet-pressure' ? { pinPa: event.targetSI } : { qoutM3s: event.targetSI } }]
    case 'sensor-bias':
      return [{ kind: 'validation-sensor-fault', timeUs: event.timeUs, sensorId: event.sensorId,
        fault: { kind: 'bias', offsetSI: event.offsetSI } }]
    case 'sensor-drift':
      return [{ kind: 'validation-sensor-fault', timeUs: event.timeUs, sensorId: event.sensorId,
        fault: { kind: 'validation-drift', startUs: event.timeUs, durationUs: event.durationUs, offsetSI: event.offsetSI } }]
    case 'sensor-stuck':
      return [{ kind: 'validation-sensor-fault', timeUs: event.timeUs, sensorId: event.sensorId,
        fault: { kind: 'hold-previous', durationUs: event.durationUs } }]
    case 'sensor-dropout':
      return [
        { kind: 'validation-sensor-fault', timeUs: event.timeUs, sensorId: event.sensorId, fault: { kind: 'dropout' } },
        { kind: 'validation-sensor-fault', timeUs: event.timeUs + event.durationUs, sensorId: event.sensorId, fault: { kind: 'clear' } },
      ]
    case 'inlet-oscillation':
      return [{ kind: 'private-control', timeUs: event.timeUs, inputs: { inletLaw: {
        kind: 'sinusoid', startUs: event.timeUs, durationUs: event.durationUs,
        baselinePa: event.baselinePa, amplitudePa: event.amplitudePa, periodUs: event.periodUs,
      } } }]
  }
}

export function prepareValidationScenario(profile: FluidProfile, recipe: ScenarioRecipe, closure: ValidationClosure = 'qs'): Prepared {
  if (recipe.events.some((event) => event.kind === 'inlet-oscillation' && closure !== 'qs'
    || event.kind === 'boundary-step' && event.rampUs !== 0
      && (closure !== 'qs' || event.channel !== 'inlet-pressure' || event.visibility !== 'private'))) {
    return { status: 'unsupported', reason: 'continuous-boundary-forcing' }
  }
  const withdrawals = recipe.events.filter((event) => event.kind === 'withdrawal')
  const initialWithdrawal = withdrawals.find((event) => event.timeUs === 0)
  if (initialWithdrawal && (closure !== 'qs' || recipe.startupQualification !== 'unknown' || withdrawals.length !== 1)) {
    return { status: 'unsupported', reason: 'initial-withdrawal-equilibrium' }
  }
  const publicProfile = profileSchema.parse({
    ...profile, sensorProfileId: recipe.sensorProfileId, startupQualification: recipe.startupQualification,
  })
  const { lengthM } = profile.geometry
  const segments = withdrawals.some((event) => !gridMatches(event.positionM, lengthM, profile.grid.segments)) ? 400 : profile.grid.segments
  if (withdrawals.some((event) => !gridMatches(event.positionM, lengthM, segments))) {
    return { status: 'unsupported', reason: 'unrepresented-withdrawal-position' }
  }
  const plant = truePlantProfile(publicProfile, recipe, segments)
  const events = recipe.events.filter((event) => event !== initialWithdrawal).flatMap((event) => compileEvent(event, plant))
  const initialPlant = initialWithdrawal
    ? initializeSteadyWithdrawal(plant, createLeak(plant, 0, initialWithdrawal).law) : undefined
  const publicBoundaries = recipe.events.filter((event): event is PublicBoundary =>
    event.kind === 'boundary-step' && event.visibility === 'public')
  const engine = createEngine(publicProfile, 0, undefined, {
    plantProfile: plant, sensorStreams: recipe.seeds.sensors, events, initialPlant,
    ...(closure === 'vb10' ? { plantFriction: 'vardy-brown' as const } : {}),
  })
  return { status: 'ready', engine, publicBoundaries }
}
