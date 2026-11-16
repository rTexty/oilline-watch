import { MODEL_VERSION } from '../contracts/model'
import type { FluidProfile } from '../contracts/model'
import { createLeak } from '../plant/events'
import { RANDOM_VERSION } from '../plant/random'
import { createEngine, validOutlet } from './engine'
import type { Engine } from './engine'
import { replaySchema } from './replay-schema'
import type { ReplayRecord } from './replay-schema'
import { matchesSimulationBackend, TYPESCRIPT_SIMULATION_BACKEND } from './wasm-runtime'
import type { SimulationBackend } from './wasm-runtime'

export function recordReplay(engine: Engine, inferenceAudit?: ReplayRecord['inferenceAudit']): ReplayRecord {
  if (engine.explicitValidationInputs) throw new Error('Validation runs require their separate private recipe for replay')
  return replaySchema.parse({
    schemaVersion: 1, modelVersion: MODEL_VERSION, profileId: engine.profile.profileId,
    randomVersion: RANDOM_VERSION, seed: engine.seed,
    hydraulicBackend: engine.backend.identity, sensorProfileId: engine.profile.sensorProfileId,
    endedAtUs: engine.timeUs, events: engine.journal.filter((event) => event.timeUs <= engine.timeUs), inferenceAudit,
    activeAbort: engine.activeAbort,
  })
}

export function engineFromReplay(profile: FluidProfile, record: ReplayRecord, backend: SimulationBackend = TYPESCRIPT_SIMULATION_BACKEND): Engine {
  record = replaySchema.parse(record)
  if (profile.profileId !== record.profileId || profile.modelVersion !== record.modelVersion
    || profile.sensorProfileId !== (record.sensorProfileId ?? 'synthetic-oil-nominal-v1')) {
    throw new Error('Версии записи и профиля несовместимы.')
  }
  if (!matchesSimulationBackend(backend.identity, record.hydraulicBackend ?? TYPESCRIPT_SIMULATION_BACKEND.identity)) {
    throw new Error('Replay hydraulic backend incompatible with this deployment')
  }
  const engine = createEngine(profile, record.seed, backend)
  const nominal = profile.initialPublicControls.outletFlowM3s
  let baseOutlet = nominal
  const validatePulse = (event: Extract<ReplayRecord['events'][number], { kind: 'active-pulse' }>) => {
    if (event.pulse.deltaOutletFlowM3s !== 0.01 * nominal || !validOutlet(profile, baseOutlet + event.pulse.deltaOutletFlowM3s)) {
      throw new Error('Invalid outlet pulse in replay.')
    }
  }
  const events = record.events.map((event) => {
    if (event.kind === 'sensor-fault') return event
    if (event.kind === 'control') {
      if (!validOutlet(profile, event.outletFlowM3s)) throw new Error('Расход в записи вне допустимого диапазона.')
      baseOutlet = event.outletFlowM3s
      return { timeUs: event.timeUs, kind: event.kind, inputs: { qoutM3s: event.outletFlowM3s } }
    }
    if (event.kind === 'active-pulse') {
      validatePulse(event)
      return event
    }
    return { timeUs: event.timeUs, kind: event.kind, inputs: { leak: createLeak(profile, event.timeUs, event).law } }
  })
  const leak = record.events.find((event) => event.kind === 'leak')
  const truth = leak ? createLeak(profile, leak.timeUs, leak).truth : null
  const controlCount = record.events.filter((event) => event.kind === 'control').length
  if (record.activeAbort?.pendingPulse) validatePulse(record.activeAbort.pendingPulse)
  const replayAbort = record.activeAbort ? { ...record.activeAbort, stoppedAtUs: record.endedAtUs } : undefined
  return { ...engine, events, truth, controlCount, journal: record.events, replayAbort }
}
