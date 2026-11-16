import { idSchema, PRESSURE_PERIOD_US, pulseSchema } from '../contracts/public'
import type { FluidProfile } from '../contracts/model'
import type { AnchorId } from '../contracts/model'
import type { Measurement, PublicBatch, SensorId } from '../contracts/public'
import { experimentBusy, finishExperiment, initialExperimentState } from '../detection/active-experiment'
import type { ExperimentState } from '../detection/active-experiment'
import { advanceTo } from '../physics/advance-to'
import { PhysicsDomainError } from '../physics/guards'
import { initialize } from '../physics/initialize'
import type { HydraulicFieldBackend } from '../physics/moc'
import { nextOutletPulseBoundary, outletPulseEnd } from '../physics/outlet-pulse'
import type { HydraulicInputs, HydraulicState } from '../physics/state'
import { createLeak } from '../plant/events'
import type { LeakInput, LeakTruth } from '../plant/events'
import { initializeSensors, initializeSensorsFromStreams, sampleSensors, sensorIds, setSensorFault } from '../plant/sensors'
import type { SensorFaultChange, SensorFaults, Sensors, SensorStreams } from '../plant/sensors'
import { deliverTelemetry } from '../plant/telemetry-delivery'
import { bankProfiles, predict } from '../twin/predict'
import { nextBoundary } from './clock'
import { appendHistory, emptyHistory } from './history'
import { appendNominalPredictions, emptyNominalPredictionHistory } from './nominal-prediction-history'
import type { NominalPredictionHistory } from './nominal-prediction-history'
import { appliedControlRevision, publicControls } from './public-controls'
import type { ReplayEvent, ReplayRecord, ReplaySensorFault } from './replay-schema'
import { TYPESCRIPT_SIMULATION_BACKEND } from './wasm-runtime'
import type { SimulationBackend } from './wasm-runtime'

type HydraulicEvent = Readonly<{ timeUs: number; inputs: HydraulicInputs; kind: 'leak' | 'control' | 'private-control' }>
type ValidationSensorEvent = Readonly<{
  timeUs: number; sensorId: SensorId; kind: 'validation-sensor-fault'
  fault: SensorFaultChange | { readonly kind: 'hold-previous'; readonly durationUs: number }
}>
export type ValidationEvent = HydraulicEvent | ValidationSensorEvent
type PulseEvent = Extract<ReplayEvent, { kind: 'active-pulse' }>
type SensorEvent = ValidationSensorEvent | Extract<ReplayEvent, { kind: 'sensor-fault' }>
type Event = ValidationEvent | PulseEvent | SensorEvent
type ActiveAbort = NonNullable<ReplayRecord['activeAbort']>

const POST_PULSE_US = 3_000_000

export interface Engine {
  readonly profile: FluidProfile
  readonly backend: SimulationBackend
  readonly explicitValidationInputs: boolean
  readonly timeUs: number
  readonly plant: HydraulicState
  readonly bank: readonly HydraulicState[]
  readonly sensors: Sensors
  readonly pendingTelemetry: readonly Measurement[]
  readonly faults: SensorFaults
  readonly samples: readonly Measurement[]
  readonly latestBatch: PublicBatch | null
  readonly events: readonly Event[]
  readonly truth: LeakTruth | null
  readonly controlCount: number
  readonly seed: number
  readonly journal: readonly ReplayEvent[]
  readonly experiment: ExperimentState
  readonly activeAbort?: ActiveAbort
  readonly replayAbort?: ActiveAbort & { readonly stoppedAtUs: number }
  readonly history: ReturnType<typeof emptyHistory<readonly Measurement[], readonly HydraulicState[]>>
  readonly nominalPredictions: NominalPredictionHistory | null
}

export class EngineExperimentDomainError extends PhysicsDomainError {
  constructor(error: PhysicsDomainError, readonly stoppedEngine: Engine) {
    super(error.code, error.message)
    this.name = 'EngineExperimentDomainError'
  }
}

function initialState(profile: FluidProfile, friction?: 'vardy-brown'): HydraulicState {
  const result = initialize(profile, { friction })
  if (!result.ok) throw result.error
  return result.value
}

export function createEngine(
  profile: FluidProfile, seed: number, backend: SimulationBackend = TYPESCRIPT_SIMULATION_BACKEND,
  validationInputs?: {
    readonly plantProfile: FluidProfile; readonly sensorStreams: SensorStreams
    readonly events?: readonly ValidationEvent[]; readonly plantFriction?: 'vardy-brown'
    readonly initialPlant?: HydraulicState
  },
): Engine {
  if (profile.mode !== 'turbulent') throw new Error('Этот профиль пока недоступен в гидравлическом сценарии.')
  if (profile.sensorProfileId === 'none') throw new Error('В испытании требуется профиль датчиков.')
  const plantProfile = validationInputs?.plantProfile ?? profile
  if (plantProfile.profileId !== profile.profileId || plantProfile.modelVersion !== profile.modelVersion
    || plantProfile.sensorProfileId !== profile.sensorProfileId || plantProfile.horizonUs !== profile.horizonUs
    || plantProfile.geometry.lengthM !== profile.geometry.lengthM) throw new Error('Private plant profile is incompatible with public telemetry')
  const events = (validationInputs?.events ?? []).toSorted((left, right) => left.timeUs - right.timeUs)
  if (events.some((event) => !Number.isSafeInteger(event.timeUs)
    || event.timeUs < profile.warmupUs || event.timeUs > profile.horizonUs)) {
    throw new RangeError('Validation events must occur within the challenge window.')
  }
  const initialPlant = validationInputs?.initialPlant
  if (initialPlant && (profile.startupQualification !== 'unknown' || initialPlant.profile.definition !== plantProfile
    || initialPlant.timeUs !== 0 || validationInputs?.plantFriction !== undefined)) {
    throw new Error('Private initial plant state is incompatible with the declared scenario.')
  }
  const plant = initialPlant ?? initialState(plantProfile, validationInputs?.plantFriction)
  const bank = bankProfiles(profile).map((anchor) => initialState(anchor))
  const sensors = validationInputs ? initializeSensorsFromStreams(validationInputs.sensorStreams) : initializeSensors(seed)
  const nominalPredictions = backend.identity.solver === 'typescript-f64' && !events.some((event) => event.kind === 'control')
    ? emptyNominalPredictionHistory(profile.profileId) : null
  return observe({
    profile, backend, explicitValidationInputs: Boolean(validationInputs),
    timeUs: 0, plant, bank, sensors, pendingTelemetry: [], faults: {}, samples: [],
    latestBatch: null, events, truth: null, controlCount: 0, seed, journal: [], experiment: initialExperimentState(),
    history: emptyHistory(), nominalPredictions,
  })
}

function observe(engine: Engine): Engine {
  const { sensors, measurements: generated } = sampleSensors(engine.plant, engine.sensors, engine.faults)
  const delivered = engine.profile.sensorProfileId === 'synthetic-oil-adverse-v1'
    ? deliverTelemetry(engine.pendingTelemetry, generated, engine.timeUs) : { pending: [], measurements: generated }
  const { measurements } = delivered
  const newest = [...new Map(measurements.map((sample) => [sample.sensorId, sample])).values()]
  const newIds = new Set(newest.map((sample) => sample.sensorId))
  const samples = [...engine.samples.filter((sample) => !newIds.has(sample.sensorId)), ...newest]
  const latestBatch: PublicBatch = {
    sampleTimeUs: engine.timeUs,
    measurements,
    predictions: engine.bank.map((state, index) => predict(state, index as AnchorId)),
  }
  const checkpoint = engine.timeUs % 1_000_000 === 0 && engine.bank.every((state) => !state.inputs.outletPulse)
    ? engine.bank : null
  const history = appendHistory(engine.history, engine.timeUs, measurements, checkpoint)
  let nominalPredictions = engine.nominalPredictions
  if (nominalPredictions) {
    const revision = appliedControlRevision(engine.journal, engine.timeUs)
    const controls = nominalPredictions.controls.length === revision ? nominalPredictions.controls
      : publicControls(engine.journal).slice(0, revision)
    nominalPredictions = appendNominalPredictions(nominalPredictions, latestBatch, checkpoint, controls)
  }
  return { ...engine, sensors, pendingTelemetry: delivered.pending, samples, latestBatch, history, nominalPredictions }
}

function move(
  state: HydraulicState, deadline: number, events: readonly HydraulicEvent[], fields?: HydraulicFieldBackend,
): HydraulicState {
  const result = advanceTo(state, deadline, undefined, events, fields)
  if (!result.ok) throw result.error
  return result.value
}

function applySensorEvent(
  faults: SensorFaults, event: SensorEvent, sensors: Sensors,
): SensorFaults {
  if (event.fault.kind !== 'hold-previous') return setSensorFault(faults, event.sensorId, event.fault)
  const instrument = sensors[sensorIds.indexOf(event.sensorId)]
  if (!instrument || !Number.isSafeInteger(event.fault.durationUs) || event.fault.durationUs <= 0) {
    throw new RangeError('Invalid sensor hold event.')
  }
  return setSensorFault(faults, event.sensorId, {
    kind: 'validation-hold', untilUs: event.timeUs + event.fault.durationUs, valueSI: instrument.lastInstrumentValueSI,
  })
}

function publicOutlet(engine: Engine): number {
  return engine.bank[0]?.inputs.qoutM3s ?? engine.profile.initialPublicControls.outletFlowM3s
}

function replayPulseAttempt(engine: Engine, event: PulseEvent): ExperimentState {
  const pulseEndUs = outletPulseEnd({ startUs: event.timeUs, pulse: event.pulse })
  return {
    ...engine.experiment,
    attempt: {
      status: 'reserved', commandId: event.commandId, proposalId: event.proposalId, appliedTimeUs: event.timeUs,
      pulseEndUs, postActionThroughUs: pulseEndUs + POST_PULSE_US,
      controlRevision: appliedControlRevision(engine.journal, event.timeUs),
      pulse: event.pulse, baseOutletFlowM3s: publicOutlet(engine), stoppedAtUs: null,
    },
  }
}

function moveEngine(engine: Engine, deadline: number, applied: readonly Event[]): Engine {
  const pulse = applied.find((event): event is PulseEvent => event.kind === 'active-pulse')
  const hydraulics = applied.filter((event) => 'inputs' in event)
  const pulseHydraulics: HydraulicEvent[] = pulse ? [{
    kind: 'control', timeUs: pulse.timeUs, inputs: { outletPulse: { startUs: pulse.timeUs, pulse: pulse.pulse } },
  }] : []
  const controls = [...hydraulics.filter((event) => event.kind === 'control'), ...pulseHydraulics]
  const plant = move(engine.plant, deadline, [...hydraulics, ...pulseHydraulics], engine.backend.fields)
  const bank = engine.bank.map((anchor) => move(anchor, deadline, controls, engine.backend.fields))
  const faults = applied.filter((event): event is SensorEvent =>
    event.kind === 'sensor-fault' || event.kind === 'validation-sensor-fault')
    .reduce((state, event) => applySensorEvent(state, event, engine.sensors), engine.faults)
  const experiment = pulse && !engine.experiment.attempt ? replayPulseAttempt(engine, pulse) : engine.experiment
  return {
    ...engine, timeUs: deadline, plant, bank, faults,
    experiment: finishExperiment(experiment, Math.min(deadline, experiment.attempt?.postActionThroughUs ?? deadline), true),
    events: engine.events.filter((event) => event.timeUs > deadline),
  }
}

function verifyReplayAbort(engine: Engine, abort: NonNullable<Engine['replayAbort']>): never {
  // Recompute the failing interval without exposing any state past the recorded common boundary.
  let probe = { ...engine, replayAbort: undefined }
  if (abort.pendingPulse) {
    const pulse = abort.pendingPulse
    probe = { ...probe, events: appendEvent(probe, pulse), journal: [...probe.journal, pulse] }
    probe = { ...probe, experiment: replayPulseAttempt(probe, pulse) }
  }
  try {
    advanceEngine(probe, abort.attemptedThroughUs)
  } catch (error) {
    if (error instanceof EngineExperimentDomainError && error.code === abort.code
      && error.stoppedEngine.timeUs === abort.stoppedAtUs
      && error.stoppedEngine.activeAbort?.attemptedThroughUs === abort.attemptedThroughUs) throw error
  }
  throw new Error('replay-divergence: recorded experiment domain stop did not reproduce.')
}

export function advanceEngine(engine: Engine, targetTimeUs: number, onBatch?: (batch: PublicBatch) => void): Engine {
  if (engine.experiment.attempt?.status === 'aborted') throw new Error('Experiment run already stopped.')
  if (!Number.isSafeInteger(targetTimeUs) || targetTimeUs < engine.timeUs || targetTimeUs > engine.profile.horizonUs) {
    throw new Error('Недопустимое модельное время.')
  }
  const reserved = engine.journal.find((event) => event.kind === 'active-pulse')
  const pulseBoundary = reserved !== undefined
    && nextOutletPulseBoundary({ startUs: reserved.timeUs, pulse: reserved.pulse }, targetTimeUs - 1) === targetTimeUs
  const offSchedule = targetTimeUs !== engine.timeUs && targetTimeUs % PRESSURE_PERIOD_US !== 0 && !pulseBoundary
  // An arbitrary cut changes the next CFL step partition and cannot be replayed from the control journal.
  if (reserved && engine.experiment.attempt?.status !== 'completed' && offSchedule) {
    throw new Error('An experiment can stop only at a sample deadline or a pulse knot.')
  }
  const abort = engine.replayAbort
  const throughUs = Math.min(targetTimeUs, abort?.stoppedAtUs ?? Infinity)
  let current = engine.nominalPredictions && (offSchedule || engine.backend.identity.solver !== 'typescript-f64')
    ? { ...engine, nominalPredictions: null } : engine
  while (current.timeUs < throughUs) {
    const sampleUs = nextBoundary(current.timeUs, PRESSURE_PERIOD_US)
    const activeLaw = current.bank[0]?.inputs.outletPulse
    const nextPulseUs = activeLaw ? nextOutletPulseBoundary(activeLaw, current.timeUs)
      : current.events.find((event) => event.kind === 'active-pulse')?.timeUs ?? Infinity
    const deadline = Math.min(sampleUs, nextPulseUs, throughUs)
    const applied = current.events.filter((event) => event.timeUs <= deadline)
    if (!current.explicitValidationInputs && applied.some((event) =>
      event.kind === 'private-control' || event.kind === 'validation-sensor-fault')) {
      throw new Error('Private validation events require a validation engine.')
    }
    try {
      current = moveEngine(current, deadline, applied)
    } catch (error) {
      const experiment = finishExperiment(current.experiment, current.timeUs, false)
      if (error instanceof PhysicsDomainError && experiment !== current.experiment) {
        const pendingPulse = current.events.find((event): event is PulseEvent => event.kind === 'active-pulse')
        const activeAbort = { attemptedThroughUs: deadline, code: error.code, ...(pendingPulse ? { pendingPulse } : {}) }
        throw new EngineExperimentDomainError(error, { ...current, experiment, activeAbort })
      }
      throw error
    }
    if (deadline === sampleUs) {
      current = observe(current)
      if (current.latestBatch) onBatch?.(current.latestBatch)
    }
  }
  if (abort && current.timeUs === abort.stoppedAtUs) verifyReplayAbort(current, abort)
  return current
}

function commandTime(engine: Engine): number {
  if (engine.experiment.attempt?.status === 'aborted') throw new Error('Experiment run already stopped.')
  if (experimentBusy(engine.experiment, engine.timeUs)) throw new Error('experiment-busy')
  if (engine.timeUs < engine.profile.warmupUs) throw new Error('Команда доступна после штатного прогрева.')
  const timeUs = nextBoundary(engine.timeUs, engine.profile.grid.nominalStepUs)
  if (timeUs > engine.profile.horizonUs) throw new Error('Сценарий завершён.')
  return timeUs
}

export function scheduleAuthorizedOutletPulse(engine: Engine, authorization: ExperimentState): Engine {
  const attempt = authorization.attempt
  const prior = engine.experiment.attempt
  if (prior && prior.commandId === attempt?.commandId && engine.experiment.runId === authorization.runId) return engine
  if (prior || attempt?.status !== 'reserved' || !idSchema.safeParse(authorization.runId).success
    || !idSchema.safeParse(attempt.commandId).success || !idSchema.safeParse(attempt.proposalId).success) {
    throw new Error('Outlet pulse requires a new authorized experiment.')
  }
  const ack = authorization.acks.get(attempt.commandId)
  const pulse = pulseSchema.parse(attempt.pulse)
  const timeUs = commandTime(engine)
  const pulseEndUs = outletPulseEnd({ startUs: timeUs, pulse })
  const controlRevision = appliedControlRevision(engine.journal, engine.timeUs) + 1
  const baseOutlet = publicOutlet(engine)
  if (ack?.status !== 'accepted' || ack.reasonCode !== 'ok' || ack.commandId !== attempt.commandId
    || ack.appliedTimeUs !== timeUs || ack.controlRevision !== controlRevision
    || attempt.appliedTimeUs !== timeUs || attempt.controlRevision !== controlRevision || attempt.stoppedAtUs !== null
    || attempt.pulseEndUs !== pulseEndUs || attempt.postActionThroughUs !== pulseEndUs + POST_PULSE_US
    || attempt.postActionThroughUs > engine.profile.horizonUs || baseOutlet !== attempt.baseOutletFlowM3s
    || !validOutlet(engine.profile, baseOutlet + pulse.deltaOutletFlowM3s)
    || pulse.deltaOutletFlowM3s !== 0.01 * engine.profile.initialPublicControls.outletFlowM3s
    || engine.events.some((event) => event.timeUs < pulseEndUs)) {
    throw new Error('Authorized outlet pulse no longer matches the engine boundary.')
  }
  const event = { kind: 'active-pulse' as const, timeUs, commandId: attempt.commandId, proposalId: attempt.proposalId, pulse }
  const acks = new Map([...authorization.acks].map(([id, value]) => [id, { ...value }]))
  const experiment = { ...authorization, acks, attempt: { ...attempt, pulse } }
  return { ...engine, experiment, events: appendEvent(engine, event), journal: [...engine.journal, event] }
}

function appendEvent(engine: Engine, event: Event): readonly Event[] {
  return [...engine.events, event].sort((left, right) => left.timeUs - right.timeUs)
}

export function scheduleLeak(engine: Engine, input: LeakInput): Engine {
  const timeUs = commandTime(engine)
  if (engine.truth) throw new Error('В одном сценарии допускается один отбор.')
  const { law, truth } = createLeak(engine.profile, timeUs, input)
  return {
    ...engine, truth, events: appendEvent(engine, { timeUs, kind: 'leak', inputs: { leak: law } }),
    journal: [...engine.journal, { kind: 'leak', ...truth }],
  }
}

export function validOutlet(profile: FluidProfile, qoutM3s: number): boolean {
  const nominal = profile.initialPublicControls.outletFlowM3s
  return Number.isFinite(qoutM3s) && qoutM3s >= 0.9 * nominal && qoutM3s <= 1.1 * nominal
}

export function scheduleOutlet(engine: Engine, qoutM3s: number): Engine {
  const timeUs = commandTime(engine)
  if (!validOutlet(engine.profile, qoutM3s)) {
    throw new Error('Расход должен быть в пределах ±10% от штатного.')
  }
  if (engine.controlCount >= 128 || engine.events.some((event) => event.kind === 'control')) {
    throw new Error('Новая команда расхода пока недоступна.')
  }
  const events = appendEvent(engine, { timeUs, kind: 'control', inputs: { qoutM3s } })
  return {
    ...engine, events, controlCount: engine.controlCount + 1,
    journal: [...engine.journal, { kind: 'control', timeUs, outletFlowM3s: qoutM3s }],
  }
}

export function scheduleSensorFault(engine: Engine, sensorId: SensorId, fault: ReplaySensorFault): Engine {
  const timeUs = commandTime(engine)
  const limit = sensorId === 'Qin' ? 0.001 : 10_000
  if (fault.kind === 'bias' && (!Number.isFinite(fault.offsetSI) || Math.abs(fault.offsetSI) > limit)) {
    throw new Error('Смещение датчика вне допустимого диапазона.')
  }
  if (engine.journal.filter((event) => event.kind === 'sensor-fault').length >= 128) throw new Error('Лимит событий датчика исчерпан.')
  const event = { kind: 'sensor-fault' as const, timeUs, sensorId, fault: { ...fault } }
  return { ...engine, events: appendEvent(engine, event), journal: [...engine.journal, event] }
}
