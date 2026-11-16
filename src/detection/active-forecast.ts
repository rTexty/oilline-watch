import { calibrationSchema, sha256Schema } from '../contracts/calibration'
import type { Calibration } from '../contracts/calibration'
import { BANK_VERSION, CHALLENGE_WARMUP_US, profileSchema } from '../contracts/model'
import type { AnchorId, FluidProfile } from '../contracts/model'
import { FLOW_PERIOD_US, PRESSURE_PERIOD_US, idSchema } from '../contracts/public'
import type { AppliedControl, SensorId } from '../contracts/public'
import { PhysicsDomainError } from '../physics/guards'
import { step, validateInputs } from '../physics/moc'
import { outletPulseDelta } from '../physics/outlet-pulse'
import type { OutletPulseLaw } from '../physics/outlet-pulse'
import { viscosityAt } from '../physics/state'
import type { HydraulicState } from '../physics/state'
import { createCheckpointAnchor, restoreCheckpoint, serializeCheckpoint } from '../twin/checkpoint'
import { bankProfiles, predict } from '../twin/predict'
import { activeFineBankProfiles, copyActiveCheckpoint } from './active-checkpoints'
import type { ActiveCheckpointPair } from './active-checkpoints'
import type { ExperimentContext } from './active-experiment'
import { MAX_CD_AREA_M2, MAX_OUTLET_FRACTION, OPENINGS_US } from './optimizer'

const COMMAND_STEP_US = 5_000
const RAMP_US = 200_000
const HOLD_END_US = 800_000
const PULSE_US = 1_000_000
const OBSERVATION_US = 3_000_000
const MAX_EVIDENCE_AGE_US = 5_000_000
const MAX_CANDIDATES = 512
const SENSOR_IDS = ['P1', 'P2', 'P3', 'Qin'] as const
const PA_BUDGET = 500
const MIN_PRESSURE_PA = 251_000
const MAX_PRESSURE_PA = 1_999_000
const MIN_RE = 4050
const MIN_FLOW_RATIO = 0.9001
const MAX_FLOW_RATIO = 1.0999

type Evidence = NonNullable<ExperimentContext['evidence']>
type Forecast = NonNullable<ExperimentContext['forecast']>
type CellForecast = Forecast['cells'][number]
type Guards = CellForecast['grid200']
type Opening = typeof OPENINGS_US[number]

type Timing = { readonly onsetUs: number; readonly openingUs: Opening }
type Hypothesis = Timing & (
  | { readonly cause: 'ML' | 'MD'; readonly node: number; readonly cdAreaM2: number }
  | { readonly cause: 'MB'; readonly amplitudeM3s: number }
  | { readonly cause: 'MS'; readonly sensorId: SensorId; readonly biasSI: number }
)

export type { ActiveCheckpointPair } from './active-checkpoints'

export interface ActiveForecastCell {
  readonly candidateId: number
  readonly anchorId: AnchorId
  readonly boundary: 'lower' | 'upper'
  readonly hypothesis: Hypothesis
}

export interface ActiveForecastInput {
  readonly profile: FluidProfile
  readonly checkpointPairs: readonly ActiveCheckpointPair[]
  readonly cells: readonly ActiveForecastCell[]
  readonly publicControlsAfterCheckpoint: readonly AppliedControl[]
}

interface Options {
  readonly maxForwardSteps?: number
  readonly shouldCancel?: () => boolean
  readonly yieldTask?: () => Promise<void>
}

type Rejection = 'invalid-input' | 'incomplete-cells' | 'unsupported-closure' | 'unsupported-controls'
  | 'checkpoint-mismatch' | 'physical-guard' | 'refinement-budget' | 'resource-limit' | 'cancelled'

export type ActiveForecastResult =
  | { readonly ok: false; readonly reason: Rejection }
  | { readonly ok: true; readonly forecast: Forecast & { readonly empiricalQualification: false }; readonly forwardSteps: number }

interface PreparedPair {
  readonly anchorId: AnchorId
  readonly hash: string
  readonly grid200: HydraulicState
  readonly grid400: HydraulicState
}

export async function hashActiveCheckpointPair(pair: ActiveCheckpointPair): Promise<string> {
  const text = JSON.stringify([pair.anchorId, serializeCheckpoint(pair.grid200), serializeCheckpoint(pair.grid400)])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function copyCheckpointPairs(pairs: readonly ActiveCheckpointPair[]): readonly ActiveCheckpointPair[] | null {
  if (pairs.length > 9) return null
  const copies: ActiveCheckpointPair[] = []
  for (const { anchorId, grid200, grid400 } of pairs) {
    const coarse = copyActiveCheckpoint(grid200)
    const fine = copyActiveCheckpoint(grid400)
    if (!coarse || !fine) return null
    copies.push({ anchorId, grid200: coarse, grid400: fine })
  }
  return copies
}

function safeTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validContext(context: ExperimentContext, profile: FluidProfile, evidence: Evidence, calibration: Calibration): boolean {
  const { timeUs, horizonUs, controlRevision, nominalOutletFlowM3s, outletFlowM3s } = context
  return profile.mode === 'turbulent' && profile.grid.segments === 200
    && context.profileId === profile.profileId && context.modelVersion === profile.modelVersion
    && context.sensorProfileId === profile.sensorProfileId && context.bankVersion === BANK_VERSION
    && calibration.profileId === context.profileId && calibration.modelVersion === context.modelVersion
    && calibration.sensorProfileId === context.sensorProfileId && calibration.bankVersion === context.bankVersion
    && context.phase === 'running' && context.inPhysicalDomain && !context.pendingDisturbance
    && safeTime(timeUs) && timeUs >= CHALLENGE_WARMUP_US && safeTime(controlRevision)
    && safeTime(horizonUs) && horizonUs <= profile.horizonUs
    && nominalOutletFlowM3s === profile.initialPublicControls.outletFlowM3s
    && Number.isFinite(outletFlowM3s)
    && idSchema.safeParse(context.runId).success && idSchema.safeParse(evidence.jobId).success
    && sha256Schema.safeParse(context.pulseHash).success
    && evidence.searchComplete && !evidence.unresolved && evidence.assessment === 'ambiguous'
    && safeTime(evidence.sourceSampleSeq) && safeTime(evidence.evidenceEndUs)
    && evidence.evidenceEndUs <= timeUs && timeUs - evidence.evidenceEndUs <= MAX_EVIDENCE_AGE_US
    && SENSOR_IDS.every((id) => evidence.sensorsAvailable[id])
}

function causeClass(cause: Hypothesis['cause']): 'ML' | 'MB' | 'MS' {
  return cause === 'MD' ? 'ML' : cause
}

function validCells(evidence: Evidence, cells: readonly ActiveForecastCell[]): Rejection | null {
  const { candidates } = evidence
  if (candidates.length < 2 || candidates.length > MAX_CANDIDATES || cells.length !== 2 * candidates.length
    || new Set(candidates.map((entry) => causeClass(entry.cause))).size < 2
    || new Set(candidates.map((entry) => entry.id)).size !== candidates.length) return 'incomplete-cells'
  if (candidates.some(({ closures }) => closures.length !== 1 || closures[0] !== 'qs')) return 'unsupported-closure'
  const keys = new Set<string>()
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  for (const cell of cells) {
    const candidate = byId.get(cell.candidateId)
    const key = `${cell.candidateId}:${cell.boundary}`
    if (!candidate || !Number.isSafeInteger(candidate.id) || candidate.id < 0 || candidate.id > 65_535
      || !sha256Schema.safeParse(candidate.checkpointHash).success
      || candidate.cause !== cell.hypothesis.cause || (cell.boundary !== 'lower' && cell.boundary !== 'upper')
      || keys.has(key)) return 'incomplete-cells'
    keys.add(key)
  }
  return null
}

function sameBoundaries(a: HydraulicState, b: HydraulicState, outletFlowM3s: number): boolean {
  const left = validateInputs(a, a.inputs)
  const right = validateInputs(b, b.inputs)
  return left.qoutM3s === outletFlowM3s && right.qoutM3s === outletFlowM3s
    && left.pinPa === right.pinPa && left.tinK === right.tinK && left.ambientK === right.ambientK
}

async function preparePair(
  context: ExperimentContext, pair: ActiveCheckpointPair, coarse: readonly FluidProfile[], fine: readonly FluidProfile[],
): Promise<PreparedPair | null> {
  const coarseProfile = coarse[pair.anchorId]
  const fineProfile = fine[pair.anchorId]
  const boundary = pair.grid200.timeUs % PRESSURE_PERIOD_US === 0
    || pair.grid200.lastThermalTimeUs === pair.grid200.timeUs && pair.grid400.lastThermalTimeUs === pair.grid400.timeUs
  if (!coarseProfile || !fineProfile || pair.grid200.timeUs !== pair.grid400.timeUs
    || !boundary
    || pair.grid200.timeUs > context.timeUs || context.timeUs - pair.grid200.timeUs > MAX_EVIDENCE_AGE_US
    || pair.grid200.controlRevision !== context.controlRevision || pair.grid400.controlRevision !== context.controlRevision) return null
  const [anchor200, anchor400] = await Promise.all([
    createCheckpointAnchor(pair.anchorId, coarseProfile), createCheckpointAnchor(pair.anchorId, fineProfile),
  ])
  const grid200 = restoreCheckpoint(pair.grid200, anchor200)
  const grid400 = restoreCheckpoint(pair.grid400, anchor400)
  if (!grid200.ok || !grid400.ok || !sameBoundaries(grid200.value, grid400.value, context.outletFlowM3s)) return null
  return { anchorId: pair.anchorId, hash: await hashActiveCheckpointPair(pair), grid200: grid200.value, grid400: grid400.value }
}

function validHypothesis(hypothesis: Hypothesis, checkpointUs: number, timeUs: number, nominalFlow: number): boolean {
  if (!safeTime(hypothesis.onsetUs) || hypothesis.onsetUs < checkpointUs || hypothesis.onsetUs > timeUs
    || !OPENINGS_US.includes(hypothesis.openingUs)) return false
  if (hypothesis.cause === 'MB') return Math.abs(hypothesis.amplitudeM3s) <= MAX_OUTLET_FRACTION * nominalFlow
  if (hypothesis.cause === 'MS') return SENSOR_IDS.includes(hypothesis.sensorId)
    && Math.abs(hypothesis.biasSI) <= (hypothesis.sensorId === 'Qin' ? 0.001 : 10_000)
  return Number.isSafeInteger(hypothesis.node) && hypothesis.node >= 1 && hypothesis.node < 200
    && hypothesis.cdAreaM2 >= 0 && hypothesis.cdAreaM2 <= MAX_CD_AREA_M2
}

function fraction(timeUs: number, onsetUs: number, openingUs: number): number {
  if (timeUs < onsetUs) return 0
  return openingUs === 0 ? 1 : Math.min(1, (timeUs - onsetUs) / openingUs)
}

function initialGuards(): Guards {
  return { minimumPressurePa: Infinity, maximumPressurePa: -Infinity, minimumRe: Infinity,
    minimumOutletFlowRatio: Infinity, maximumOutletFlowRatio: -Infinity }
}

function guarded(state: HydraulicState, old: Guards, commandFlow: number, nominalFlow: number): Guards | null {
  const { p, qL, qR, tOil, profile } = state
  const commandRatio = commandFlow / nominalFlow
  const outletRatio = qR.at(-1)! / nominalFlow
  const minRatio = Math.min(commandRatio, outletRatio)
  const maxRatio = Math.max(commandRatio, outletRatio)
  if (!(minRatio >= MIN_FLOW_RATIO && maxRatio <= MAX_FLOW_RATIO)) return null
  const diameterPerArea = profile.definition.geometry.diameterM / profile.areaM2
  let { minimumPressurePa, maximumPressurePa, minimumRe } = old
  let leftNu = viscosityAt(profile, tOil[0]!)
  for (let node = 0; node < p.length; node++) {
    const pressure = p[node]!
    if (!(pressure >= MIN_PRESSURE_PA && pressure <= MAX_PRESSURE_PA)) return null
    const leftTemp = tOil[Math.max(0, node - 1)]!
    const rightTemp = tOil[Math.min(node, tOil.length - 1)]!
    const rightNu = rightTemp === leftTemp ? leftNu : viscosityAt(profile, rightTemp)
    const localRe = diameterPerArea * Math.min(qL[node]! / leftNu, qR[node]! / rightNu)
    if (!(localRe >= MIN_RE && Number.isFinite(localRe))) return null
    minimumPressurePa = Math.min(minimumPressurePa, pressure)
    maximumPressurePa = Math.max(maximumPressurePa, pressure)
    minimumRe = Math.min(minimumRe, localRe)
    leftNu = rightNu
  }
  return { minimumPressurePa, maximumPressurePa, minimumRe, minimumOutletFlowRatio: Math.min(old.minimumOutletFlowRatio, minRatio),
    maximumOutletFlowRatio: Math.max(old.maximumOutletFlowRatio, maxRatio) }
}

interface Cursor {
  readonly state: HydraulicState
  readonly guards: Guards
  readonly previous: Readonly<Partial<Record<SensorId, number>>>
  readonly trace: number[]
}

interface PressureFrame {
  readonly timeUs: number
  readonly p: Float64Array
}

function initialCursor(state: HydraulicState): Cursor {
  return { state, guards: initialGuards(), previous: {}, trace: [] }
}

function sample(cursor: Cursor, hypothesis: Hypothesis, noise: Calibration['noise'], pulseEndUs: number): Cursor {
  const timeUs = cursor.state.timeUs
  if (timeUs < pulseEndUs - FLOW_PERIOD_US || timeUs % PRESSURE_PERIOD_US !== 0) return cursor
  const prediction = predict(cursor.state, 0)
  const previous = { ...cursor.previous }
  for (const [index, sensor] of SENSOR_IDS.entries()) {
    if (sensor === 'Qin' && timeUs % FLOW_PERIOD_US !== 0) continue
    const base = sensor === 'Qin' ? prediction.inletFlowM3s : prediction.pressurePa[index]!
    const value = base + (hypothesis.cause === 'MS' && hypothesis.sensorId === sensor
      ? hypothesis.biasSI * fraction(timeUs, hypothesis.onsetUs, hypothesis.openingUs) : 0)
    const before = previous[sensor]
    previous[sensor] = value
    if (timeUs <= pulseEndUs || before === undefined) continue
    const { rho, sigmaSI } = noise[sensor]
    cursor.trace.push((value - rho * before) / (sigmaSI * Math.sqrt(1 - rho * rho)))
  }
  return { ...cursor, previous }
}

class ForecastInterrupted extends Error {
  constructor(readonly reason: 'resource-limit' | 'cancelled') { super(reason) }
}

interface RunParameters {
  readonly baseFlow: number
  readonly nominalFlow: number
  readonly startUs: number
  readonly pulse: OutletPulseLaw
  readonly noise: Calibration['noise']
  readonly takeStep: () => Promise<void> | undefined
}

function flowAt(parameters: RunParameters, hypothesis: Hypothesis, timeUs: number, active: boolean): number {
  const disturbance = hypothesis.cause === 'MB'
    ? hypothesis.amplitudeM3s * fraction(timeUs, hypothesis.onsetUs, hypothesis.openingUs) : 0
  return parameters.baseFlow + disturbance + (active
    ? outletPulseDelta(parameters.pulse, timeUs) : 0)
}

async function advanceGrid(
  cursor: Cursor, targetUs: number, cell: ActiveForecastCell, parameters: RunParameters, active: boolean,
): Promise<{ readonly cursor: Cursor; readonly pressure: readonly PressureFrame[] } | null> {
  let { state, guards } = cursor
  const hypothesis = cell.hypothesis
  const leak = (hypothesis.cause === 'ML' || hypothesis.cause === 'MD') && hypothesis.cdAreaM2 > 0
    ? { node: hypothesis.node * (state.profile.definition.grid.segments / 200), cdA: hypothesis.cdAreaM2,
      onsetUs: hypothesis.onsetUs, rampUs: hypothesis.openingUs } : null
  const hydraulicTiming = leak !== null || (hypothesis.cause === 'MB' && hypothesis.amplitudeM3s !== 0)
  let command = flowAt(parameters, hypothesis, state.timeUs, active)
  const initial = guarded(state, guards, command, parameters.nominalFlow)
  if (!initial) return null
  guards = initial
  const pressure = [{ timeUs: state.timeUs, p: state.p }]

  while (state.timeUs < targetUs) {
    const waiting = parameters.takeStep()
    if (waiting) await waiting
    const timeUs = state.timeUs
    const thermalUs = state.profile.definition.thermal.stepUs - state.thermalFlow.elapsedUs
    const onsetUs = hydraulicTiming && hypothesis.onsetUs > timeUs ? hypothesis.onsetUs : Infinity
    const rampEnd = hypothesis.onsetUs + hypothesis.openingUs
    const rampEndUs = hydraulicTiming && rampEnd > timeUs ? rampEnd : Infinity
    const dtUs = Math.min(state.profile.stepUs, targetUs - timeUs, thermalUs, onsetUs - timeUs, rampEndUs - timeUs)
    const installPulse = active && timeUs === parameters.startUs ? { outletPulse: parameters.pulse } : {}
    state = step(state, { dtUs, qoutM3s: flowAt(parameters, hypothesis, timeUs, false), leak, ...installPulse })
    pressure.push({ timeUs: state.timeUs, p: state.p })
    command = flowAt(parameters, hypothesis, state.timeUs, active)
    const measured = guarded(state, guards, command, parameters.nominalFlow)
    if (!measured) return null
    guards = measured
  }
  return { cursor: sample({ ...cursor, state, guards }, hypothesis, parameters.noise, parameters.startUs + PULSE_US), pressure }
}

interface TracePair {
  readonly grid200: Cursor
  readonly grid400: Cursor
  readonly maxPressureDifferencePa: number
}

function refinementDifference(coarse: readonly PressureFrame[], fine: readonly PressureFrame[]): number {
  const times = [...new Set([...coarse, ...fine].map((frame) => frame.timeUs))].sort((a, b) => a - b)
  let i = 0
  let j = 0
  let maximum = 0
  for (const timeUs of times) {
    while (i + 1 < coarse.length && coarse[i + 1]!.timeUs <= timeUs) i++
    while (j + 1 < fine.length && fine[j + 1]!.timeUs <= timeUs) j++
    const c0 = coarse[i]!
    const f0 = fine[j]!
    const c1 = coarse[i + 1] ?? c0
    const f1 = fine[j + 1] ?? f0
    const c = c0.timeUs === c1.timeUs ? 0 : (timeUs - c0.timeUs) / (c1.timeUs - c0.timeUs)
    const f = f0.timeUs === f1.timeUs ? 0 : (timeUs - f0.timeUs) / (f1.timeUs - f0.timeUs)
    for (const [node, p] of f0.p.entries()) {
      const left = Math.floor(node / 2)
      const right = Math.ceil(node / 2)
      const coarse0 = (c0.p[left]! + c0.p[right]!) / 2
      const coarse1 = (c1.p[left]! + c1.p[right]!) / 2
      const primary = coarse0 + c * (coarse1 - coarse0)
      const refined = p + f * (f1.p[node]! - p)
      maximum = Math.max(maximum, Math.abs(primary - refined))
    }
  }
  return maximum
}

async function runPair(
  pair: PreparedPair, cell: ActiveForecastCell, parameters: RunParameters, active: boolean,
): Promise<TracePair | 'physical-guard' | 'refinement-budget'> {
  let grid200 = initialCursor(pair.grid200)
  let grid400 = initialCursor(pair.grid400)
  let maxPressureDifferencePa = 0
  const throughUs = parameters.startUs + PULSE_US + OBSERVATION_US
  const pulseKnots = [0, RAMP_US, HOLD_END_US, PULSE_US].map((elapsed) => parameters.startUs + elapsed)
  let clockUs = pair.grid200.timeUs
  for (;;) {
    const next200 = await advanceGrid(grid200, clockUs, cell, parameters, active)
    const next400 = await advanceGrid(grid400, clockUs, cell, parameters, active)
    if (!next200 || !next400) return 'physical-guard'
    maxPressureDifferencePa = Math.max(maxPressureDifferencePa, refinementDifference(next200.pressure, next400.pressure))
    if (maxPressureDifferencePa > PA_BUDGET) return 'refinement-budget'
    grid200 = next200.cursor
    grid400 = next400.cursor
    if (clockUs === throughUs) break
    const nextSample = (Math.floor(clockUs / PRESSURE_PERIOD_US) + 1) * PRESSURE_PERIOD_US
    clockUs = Math.min(throughUs, nextSample, pulseKnots.find((knot) => knot > clockUs) ?? Infinity)
  }
  return { grid200, grid400, maxPressureDifferencePa }
}

interface CellTrace {
  readonly cause: ReturnType<typeof causeClass>
  readonly active: { readonly grid200: readonly number[]; readonly grid400: readonly number[] }
  readonly passive: { readonly grid200: readonly number[]; readonly grid400: readonly number[] }
}

function rms(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return Number.NaN
  let squares = 0
  for (const [index, value] of a.entries()) squares += (value - b[index]!) ** 2
  return Math.sqrt(squares / a.length)
}

function separations(traces: readonly CellTrace[]) {
  let active = Infinity
  let passive = Infinity
  for (const [i, one] of traces.entries()) {
    for (let j = i + 1; j < traces.length; j++) {
      const other = traces[j]!
      if (one.cause === other.cause) continue
      for (const grid of ['grid200', 'grid400'] as const) {
        active = Math.min(active, rms(one.active[grid], other.active[grid]))
        passive = Math.min(passive, rms(one.passive[grid], other.passive[grid]))
      }
    }
  }
  return { active, passive }
}

export async function evaluateActiveForecast(
  request: ExperimentContext, input: ActiveForecastInput, options: Options = {},
): Promise<ActiveForecastResult> {
  const context = { ...request }
  const evidence = context.evidence
  const profile = profileSchema.safeParse(input.profile)
  const calibration = calibrationSchema.safeParse(context.calibration)
  const limit = options.maxForwardSteps ?? 65_536
  if (!profile.success || !calibration.success || !evidence || !Number.isSafeInteger(limit) || limit < 1 || limit > 262_144
    || !validContext(context, profile.data, evidence, calibration.data)) return { ok: false, reason: 'invalid-input' }
  if (input.publicControlsAfterCheckpoint.length !== 0) return { ok: false, reason: 'unsupported-controls' }
  const cellRejection = validCells(evidence, input.cells)
  if (cellRejection) return { ok: false, reason: cellRejection }
  const startUs = (Math.floor(context.timeUs / COMMAND_STEP_US) + 1) * COMMAND_STEP_US
  const throughUs = startUs + PULSE_US + OBSERVATION_US
  if (throughUs > context.horizonUs) return { ok: false, reason: 'invalid-input' }

  const shouldCancel = options.shouldCancel
  if (shouldCancel?.()) return { ok: false, reason: 'cancelled' }
  const checkpointPairs = copyCheckpointPairs(input.checkpointPairs)
  if (!checkpointPairs) return { ok: false, reason: 'checkpoint-mismatch' }
  const candidates = new Map(evidence.candidates.map((candidate) => [candidate.id, candidate.checkpointHash]))
  const endpoints = input.cells.map((cell) => ({ ...cell, hypothesis: { ...cell.hypothesis } }))
  const { jobId: sourceJobId, sourceSampleSeq, evidenceEndUs } = evidence
  const pairs = new Map<AnchorId, PreparedPair>()
  const cells: CellForecast[] = []
  const traces: CellTrace[] = []
  const yieldTask = options.yieldTask ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  let forwardSteps = 0
  const takeStep = () => {
    if (forwardSteps >= limit) throw new ForecastInterrupted('resource-limit')
    if (shouldCancel?.()) throw new ForecastInterrupted('cancelled')
    forwardSteps++
    if (forwardSteps % 128 !== 0) return
    return yieldTask().then(() => {
      if (shouldCancel?.()) throw new ForecastInterrupted('cancelled')
    })
  }
  try {
    const coarse = bankProfiles(profile.data)
    const fine = activeFineBankProfiles(profile.data)
    for (const item of checkpointPairs) {
      if (pairs.has(item.anchorId)) return { ok: false, reason: 'checkpoint-mismatch' }
      const pair = await preparePair(context, item, coarse, fine)
      if (!pair) return { ok: false, reason: 'checkpoint-mismatch' }
      pairs.set(pair.anchorId, pair)
    }
    const pulse = { startUs, pulse: { deltaOutletFlowM3s: 0.01 * context.nominalOutletFlowM3s,
      rampUs: RAMP_US, holdUs: HOLD_END_US - RAMP_US, returnUs: PULSE_US - HOLD_END_US } }
    const parameters: RunParameters = { baseFlow: context.outletFlowM3s, nominalFlow: context.nominalOutletFlowM3s,
      startUs, pulse, noise: calibration.data.noise, takeStep }
    for (const cell of endpoints) {
      const pair = pairs.get(cell.anchorId)
      if (!pair || pair.hash !== candidates.get(cell.candidateId)) return { ok: false, reason: 'checkpoint-mismatch' }
      if (!validHypothesis(cell.hypothesis, pair.grid200.timeUs, evidenceEndUs, parameters.nominalFlow)) {
        return { ok: false, reason: 'invalid-input' }
      }
      const passive = await runPair(pair, cell, parameters, false)
      if (typeof passive === 'string') return { ok: false, reason: passive }
      const active = await runPair(pair, cell, parameters, true)
      if (typeof active === 'string') return { ok: false, reason: active }
      cells.push({ candidateId: cell.candidateId, closure: 'qs', boundary: cell.boundary, checkpointHash: pair.hash,
        grid200: active.grid200.guards, grid400: active.grid400.guards,
        maxPressureDifferencePa: Math.max(active.maxPressureDifferencePa, passive.maxPressureDifferencePa) })
      traces.push({ cause: causeClass(cell.hypothesis.cause),
        active: { grid200: active.grid200.trace, grid400: active.grid400.trace },
        passive: { grid200: passive.grid200.trace, grid400: passive.grid400.trace } })
    }
  } catch (error) {
    if (error instanceof ForecastInterrupted) return { ok: false, reason: error.reason }
    if (error instanceof PhysicsDomainError) return { ok: false, reason: 'physical-guard' }
    throw error
  }
  if (shouldCancel?.()) return { ok: false, reason: 'cancelled' }
  const separation = separations(traces)
  if (!Number.isFinite(separation.active) || !Number.isFinite(separation.passive)) return { ok: false, reason: 'invalid-input' }
  return { ok: true, forwardSteps, forecast: {
    runId: context.runId, profileHash: calibration.data.hashes.profile, modelHash: calibration.data.hashes.model,
    policyHash: calibration.data.hashes.policy, pulseHash: context.pulseHash, sourceJobId,
    sourceSampleSeq, controlRevision: context.controlRevision, issuedAtUs: context.timeUs,
    validUntilUs: startUs, firstStartUs: startUs, lastStartUs: startUs, qualifiedThroughUs: throughUs,
    empiricalQualification: false, supportedControls: true, nominalOutletFlowM3s: context.nominalOutletFlowM3s,
    baseOutletFlowM3s: context.outletFlowM3s, activeSeparationRms: separation.active, passiveSeparationRms: separation.passive, cells,
  } }
}
