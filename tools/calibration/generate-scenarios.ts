import { sha256Schema } from '../../src/contracts/calibration'
import type { FluidProfile } from '../../src/contracts/model'
import type { SensorId } from '../../src/contracts/public'
import { nextUniform } from '../../src/plant/random'
import type { Seed } from '../../src/plant/random'
import { deriveSeed, NULL_FAMILIES, PIPE_LENGTH_M, SENSOR_LAYOUTS, splitSchema } from './contracts'
import type { Scenario, Split } from './contracts'
import { jsonDocument, sha256 } from './io'

export const OPEN_SPLITS = ['fit', 'calibration', 'development'] as const
export type OpenSplit = typeof OPEN_SPLITS[number]
const SPLIT_OFFSETS: Record<OpenSplit, number> = { fit: -0.003, calibration: -0.001, development: 0.001 }
const DISCREPANCIES = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12'] as const
const OPENINGS = [0, 20] as const
const AREAS = [5e-6, 1e-5, 2e-5] as const
const CENTERS = [100, 300, 500, 700, 900] as const
const CHANNELS = ['P1', 'P2', 'P3', 'Qin'] as const
const NULL_EVENT_US = 60_000_000
const FAULT_DURATION_US = 20_000_000

interface PropertyScales {
  readonly bulkModulus: number
  readonly viscosity: number
  readonly roughness: number
  readonly density: number
}

const NOMINAL: PropertyScales = { bulkModulus: 1, viscosity: 1, roughness: 1, density: 1 }

export interface ParameterBlock {
  readonly id: string
  readonly scales: PropertyScales
  readonly bulkModulusPa: number
  readonly viscosityMultiplier: number
  readonly roughnessM: number
  readonly rho0KgM3: number
}

export interface ScenarioSeeds {
  readonly plant: Seed
  readonly event: Seed
  readonly sensors: Readonly<Record<SensorId, { readonly noise: Seed; readonly delivery: Seed }>>
}

type AtTime = { readonly timeUs: number }
export type RecipeEvent = AtTime & (
  | { readonly kind: 'withdrawal'; readonly cause: 'leak' | 'internal-demand'; readonly positionM: number;
      readonly cdAreaM2: number; readonly openingUs: number }
  | { readonly kind: 'boundary-step'; readonly visibility: 'public' | 'private';
      readonly channel: 'inlet-pressure' | 'outlet-flow'; readonly targetSI: number; readonly rampUs: number }
  | { readonly kind: 'inlet-oscillation'; readonly durationUs: number; readonly periodUs: number;
      readonly amplitudePa: number; readonly baselinePa: number }
  | { readonly kind: 'sensor-bias'; readonly sensorId: SensorId; readonly offsetSI: number }
  | { readonly kind: 'sensor-drift'; readonly sensorId: SensorId; readonly offsetSI: number; readonly durationUs: number }
  | { readonly kind: 'sensor-stuck'; readonly sensorId: SensorId; readonly durationUs: number; readonly hold: 'previous-sample' }
  | { readonly kind: 'sensor-dropout'; readonly sensorId: SensorId; readonly durationUs: number }
)

export interface ScenarioRecipe {
  readonly runId: string
  readonly ordinal: number
  readonly sensorProfileId: 'synthetic-oil-nominal-v1' | 'synthetic-oil-adverse-v1'
  readonly startupQualification: FluidProfile['startupQualification']
  readonly parameterBlock: ParameterBlock
  readonly seeds: ScenarioSeeds
  readonly events: readonly RecipeEvent[]
}

interface GenerateOpenSplit {
  readonly split: OpenSplit
  readonly saltHex: string
  readonly generatorHash: string
  readonly profile: FluidProfile
}

type Details = Omit<Extract<Scenario, { kind: 'leak' }>, 'runId' | 'seedHash' | 'parameterBlockHash'>
  | Omit<Extract<Scenario, { kind: 'null' }>, 'runId' | 'seedHash' | 'parameterBlockHash'>
  | Omit<Extract<Scenario, { kind: 'discrepancy' }>, 'runId' | 'seedHash' | 'parameterBlockHash'>

interface GeneratedScenario {
  readonly scenario: Scenario
  readonly recipe: ScenarioRecipe
}

function perRunSeeds(saltHex: string, family: string, cell: string, replicate: number): ScenarioSeeds {
  const stream = (id: string) => deriveSeed(saltHex, family, cell, replicate, id)
  const sensor = (id: SensorId) => ({ noise: stream(`${id}-noise`), delivery: stream(`${id}-delivery`) })
  return {
    plant: stream('plant'), event: stream('event'),
    sensors: { P1: sensor('P1'), P2: sensor('P2'), P3: sensor('P3'), Qin: sensor('Qin') },
  }
}

function propertyBlock(id: string, scales: PropertyScales, profile: FluidProfile): ParameterBlock {
  const { bulkModulusPa, rho0KgM3, viscosity } = profile.publicFluidProfile
  if (viscosity.kind !== 'walther') throw new Error('Open calibration requires a Walther viscosity profile.')
  return {
    id, scales: { ...scales }, bulkModulusPa: bulkModulusPa * scales.bulkModulus,
    viscosityMultiplier: (viscosity.multiplier ?? 1) * scales.viscosity,
    roughnessM: profile.geometry.roughnessM * scales.roughness, rho0KgM3: rho0KgM3 * scales.density,
  }
}

function operatingBlock(input: GenerateOpenSplit, ordinal: number, joint = false): ParameterBlock {
  const block = ordinal % 3
  const offset = SPLIT_OFFSETS[input.split]
  const sign = ordinal % 2 === 0 ? 1 : -1
  const base: PropertyScales = {
    bulkModulus: 1 + offset * (1 + block / 4), viscosity: 1 + 2 * offset,
    roughness: 1 + 5 * offset, density: 1 + offset / 2,
  }
  const scales = joint ? {
    ...base, bulkModulus: base.bulkModulus * (1 + sign * 0.01),
    viscosity: base.viscosity * (1 + sign * 0.025), density: base.density * (1 + sign * 0.005),
  } : base
  return propertyBlock(`${input.split}/operating-${block}${joint ? `/joint-${sign}` : ''}`, scales, input.profile)
}

function onset(seed: Seed): number {
  return NULL_EVENT_US + 5000 * Math.floor(nextUniform(seed).value * 36_000)
}

function generate(
  split: OpenSplit, details: Details, ordinal: number, parameterBlock: ParameterBlock,
  seeds: ScenarioSeeds, events: readonly RecipeEvent[], startupQualification: ScenarioRecipe['startupQualification'] = 'known-healthy',
): GeneratedScenario {
  const runId = `${split}-${details.kind}-${String(ordinal).padStart(3, '0')}`
  const scenario: Scenario = {
    ...details, runId, seedHash: sha256(jsonDocument(seeds)), parameterBlockHash: sha256(jsonDocument(parameterBlock)),
  }
  return {
    scenario,
    recipe: {
      runId, ordinal, sensorProfileId: `synthetic-oil-${details.sensor}-v1`,
      startupQualification, parameterBlock, seeds, events,
    },
  }
}

function leakScenarios(input: GenerateOpenSplit): readonly GeneratedScenario[] {
  const runs: GeneratedScenario[] = []
  for (const openingSeconds of OPENINGS) {
    for (const sizeM2 of AREAS) {
      for (const sensor of SENSOR_LAYOUTS.toSorted()) {
        for (const centerM of CENTERS) {
          for (const replicate of [0, 1]) {
            const ordinal = runs.length
            const seeds = perRunSeeds(input.saltHex, 'leak', [openingSeconds, sizeM2, sensor, centerM].join('/'), replicate)
            const onsetUs = onset(seeds.event)
            const positionM = centerM + (replicate === 0 ? -2.5 : 2.5)
            runs.push(generate(input.split, {
              kind: 'leak', openingSeconds, sizeM2, sensor, centerM, replicate, positionM, onsetUs,
            }, ordinal, operatingBlock(input, ordinal), seeds, [{
              kind: 'withdrawal', cause: 'leak', timeUs: onsetUs, positionM, cdAreaM2: sizeM2, openingUs: openingSeconds * 1_000_000,
            }]))
          }
        }
      }
    }
  }
  return runs
}

type NullFamily = typeof NULL_FAMILIES[number]

function nullEvents(family: NullFamily, ordinal: number, outletFlowM3s: number): readonly RecipeEvent[] {
  const sign = ordinal % 2 === 0 ? 1 : -1
  const sensorId = CHANNELS[ordinal % CHANNELS.length]!
  const biasSign = Math.floor(ordinal / CHANNELS.length) % 2 === 0 ? 1 : -1
  const offsetSI = biasSign * (sensorId === 'Qin' ? 0.0005 : 5000)
  const timeUs = NULL_EVENT_US
  switch (family) {
    case 'healthy':
    case 'noise-delivery-dropout':
      return []
    case 'known-qout':
    case 'unknown-qout':
      return [{ kind: 'boundary-step', visibility: family === 'known-qout' ? 'public' : 'private',
        channel: 'outlet-flow', timeUs, targetSI: outletFlowM3s * (1 + sign * 0.02), rampUs: 0 }]
    case 'sensor-bias':
    case 'joint-properties-sensor':
      return [{ kind: 'sensor-bias', sensorId, timeUs, offsetSI: family === 'joint-properties-sensor' ? offsetSI / 2 : offsetSI }]
    case 'drift':
      return [{ kind: 'sensor-drift', sensorId, timeUs, offsetSI, durationUs: FAULT_DURATION_US }]
    case 'stuck':
      return [{ kind: 'sensor-stuck', sensorId, timeUs, durationUs: FAULT_DURATION_US, hold: 'previous-sample' }]
  }
}

function nullScenarios(input: GenerateOpenSplit): readonly GeneratedScenario[] {
  const runs: GeneratedScenario[] = []
  for (const family of NULL_FAMILIES) {
    for (const sensor of SENSOR_LAYOUTS) {
      for (let replicate = 0; replicate < 15; replicate++) {
        const ordinal = runs.length
        runs.push(generate(input.split, { kind: 'null', family, sensor, replicate }, ordinal,
          operatingBlock(input, ordinal, family === 'joint-properties-sensor'),
          perRunSeeds(input.saltHex, family, sensor, replicate),
          nullEvents(family, ordinal, input.profile.initialPublicControls.outletFlowM3s)))
      }
    }
  }
  return runs
}

type DiscrepancyFamily = typeof DISCREPANCIES[number]

function discrepancyScales(family: DiscrepancyFamily, sign: number): PropertyScales {
  switch (family) {
    case 'D01': return { ...NOMINAL, bulkModulus: 1 + sign * 0.01 }
    case 'D02': return { ...NOMINAL, viscosity: 1 + sign * 0.025 }
    case 'D03': return {
      bulkModulus: 1 + sign * 0.01, viscosity: 1 + sign * 0.025, roughness: 1 + sign * 0.1, density: 1 + sign * 0.005,
    }
    case 'D04': return { ...NOMINAL, bulkModulus: 1 + sign * 0.08, viscosity: 1 + sign * 0.2 }
    default: return NOMINAL
  }
}

function withdrawal(timeUs: number, openingUs: number, cause: 'leak' | 'internal-demand' = 'leak'): RecipeEvent {
  return { kind: 'withdrawal', cause, timeUs, openingUs, positionM: 500, cdAreaM2: 1e-5 }
}

function discrepancyEvents(family: DiscrepancyFamily, replicate: number, timeUs: number, inletPressurePa: number): readonly RecipeEvent[] {
  const sign = replicate % 2 === 0 ? 1 : -1
  const bias = (sensorId: SensorId, offsetSI: number): RecipeEvent => ({ kind: 'sensor-bias', sensorId, offsetSI, timeUs })
  switch (family) {
    case 'D05': return [{ kind: 'boundary-step', visibility: 'private', channel: 'inlet-pressure',
      timeUs, targetSI: inletPressurePa + sign * 10_000, rampUs: 1_000_000 }]
    case 'D06': return [bias('P1', sign * 5000), bias('P3', -sign * 5000)]
    case 'D07': return [withdrawal(timeUs, FAULT_DURATION_US), bias('P2', sign * 5000)]
    case 'D08': return [{ kind: 'boundary-step', visibility: 'public', channel: 'inlet-pressure', timeUs, targetSI: 200_000, rampUs: 0 }]
    case 'D09': return [withdrawal(0, 0)]
    case 'D10': return [{ kind: 'sensor-dropout', sensorId: 'Qin', timeUs, durationUs: FAULT_DURATION_US },
      withdrawal(timeUs + 1_000_000, 0)]
    case 'D11': return [{ kind: 'inlet-oscillation', timeUs, durationUs: FAULT_DURATION_US, periodUs: 300_000,
      amplitudePa: sign * 4000, baselinePa: inletPressurePa }]
    case 'D12': return [withdrawal(timeUs, replicate < 2 ? 0 : FAULT_DURATION_US, sign === 1 ? 'leak' : 'internal-demand')]
    default: return []
  }
}

function discrepancyScenarios(input: GenerateOpenSplit): readonly GeneratedScenario[] {
  const runs: GeneratedScenario[] = []
  for (const family of DISCREPANCIES) {
    for (let replicate = 0; replicate < 4; replicate++) {
      const sign = replicate % 2 === 0 ? 1 : -1
      const ordinal = runs.length
      const paired = family === 'D12'
      const seedReplicate = paired ? Math.floor(replicate / 2) : replicate
      const seeds = perRunSeeds(input.saltHex, family, 'nominal', seedReplicate)
      const block = propertyBlock(`${input.split}/${family}/${paired ? seedReplicate : sign}`,
        discrepancyScales(family, sign), input.profile)
      runs.push(generate(input.split, { kind: 'discrepancy', sensor: 'nominal', family, replicate }, ordinal, block, seeds,
        discrepancyEvents(family, replicate, onset(seeds.event), input.profile.initialPublicControls.inletPressurePa),
        family === 'D09' ? 'unknown' : 'known-healthy'))
    }
  }
  return runs
}

function reserveClosurePairs(scenarios: readonly Scenario[]) {
  const selected = scenarios.filter((run): run is Extract<Scenario, { kind: 'leak' | 'null' }> =>
    run.kind === 'leak' ? run.replicate === 0 && [100, 500, 900].includes(run.centerM)
      : run.kind === 'null' && run.replicate < 2)
  return selected.map((run) => ({
    pairId: `${run.runId}-closure`, kind: run.kind, qsRunId: run.runId, vb10RunId: `${run.runId}-vb10`,
    sourceRecipeRunId: run.runId, seedHash: run.seedHash, parameterBlockHash: run.parameterBlockHash,
  }))
}

export function generateOpenSplit(input: GenerateOpenSplit) {
  if (!OPEN_SPLITS.includes(input.split)) throw new Error('Blind generation requires the independent validation owner.')
  if (!/^[a-f0-9]{32}$/.test(input.saltHex)) throw new Error('Expected a 128-bit lowercase hexadecimal salt.')
  if (input.profile.mode !== 'turbulent' || input.profile.geometry.lengthM !== PIPE_LENGTH_M) {
    throw new Error('Expected the declared 1000 m turbulent profile.')
  }
  const generatorHash = sha256Schema.parse(input.generatorHash)
  const generated = [...leakScenarios(input), ...nullScenarios(input), ...discrepancyScenarios(input)]
  const split: Split = splitSchema.parse({
    schemaVersion: 1, split: input.split, generator: 'synthetic-fit', generatorHash,
    saltCommitment: sha256(Buffer.from(input.saltHex, 'hex')), scenarios: generated.map(({ scenario }) => scenario),
  })
  const d12 = split.scenarios.filter((run) => run.kind === 'discrepancy' && run.family === 'D12')
  return {
    split,
    recipes: {
      schemaVersion: 1 as const, split: input.split, generatorHash, saltHex: input.saltHex,
      runs: generated.map(({ recipe }) => recipe),
      d12Pairs: [
        { openingUs: 0, leakRunId: d12[0]!.runId, internalDemandRunId: d12[1]!.runId },
        { openingUs: FAULT_DURATION_US, leakRunId: d12[2]!.runId, internalDemandRunId: d12[3]!.runId },
      ],
    },
    closurePairs: { schemaVersion: 1 as const, split: input.split, pairs: reserveClosurePairs(split.scenarios) },
  }
}

export type GeneratedOpenSplit = ReturnType<typeof generateOpenSplit>
