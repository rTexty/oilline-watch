import type { Calibration } from '../contracts/calibration'
import type { CpuTrial, InverseProvisionalAudit } from '../contracts/inference-audit'
import type { AnchorId } from '../contracts/model'
import { publicBatchSchema } from '../contracts/public'
import { forwardPrefixCacheBytes } from '../detection/initial-state'
import { replayExactTrials, runInverseSearch } from '../detection/inverse'
import type { InverseTiming } from '../detection/inverse'
import { replayDiagnosticDecision, serializeCpuTrial } from '../detection/replay-decision'
import { verifiedSpatialEnvelopeDigest } from '../detection/qualified-spatial-profile'
import type { QualifiedSpatialEnvelope } from '../detection/qualified-spatial-profile'
import { pressureResiduals } from '../detection/residual'
import { loadResponseDictionary } from '../detection/screening'
import type { ResponseDictionary } from '../detection/screening'
import { nativeScreeningWorkspaceBytes } from '../detection/screening-table'
import { createCheckpointAnchor } from '../twin/checkpoint'
import type { CheckpointAnchor } from '../twin/checkpoint'
import { bankProfiles } from '../twin/predict'
import { inverseForwardWorkspaceBytes, withForwardPrefixWorkspace } from './inference-memory'
import { inferenceConnectionSchema, inverseRequestSchema } from './inference-port'
import type { InferenceConfigure } from './inference-port'
import { dictionarySpatialPrefixBytes, loadReservedBundledResponseDictionary } from './dictionary-runtime'
import { createNumericalMemoryLedger } from './numerical-memory'
import type { NumericalMemoryReservation } from './numerical-memory'
import { loadReservedSpatialEnvelope } from './spatial-envelope-runtime'
import { createTaskYield } from './task-yield'

const worker = self as DedicatedWorkerGlobalScope
// Leave time for result cloning, the Simulation Worker task, and validation.
const RESULT_HANDOFF_MS = 32
const PROVISIONAL_TARGET_MS = 1700
let connected = false

class InferenceMemoryLimit extends Error {}

worker.onmessage = (event: MessageEvent<unknown>) => {
  const { runId, port } = inferenceConnectionSchema.parse(event.data)
  if (connected) throw new Error('Inference is already connected.')
  connected = true
  const identity = { schemaVersion: 1, runId }
  const memory = createNumericalMemoryLedger('inference')
  const pendingJobs = new Set<Promise<void>>()
  let closed = false
  let lastMemory: ReturnType<typeof memory.snapshot> | undefined
  let latestTimeUs = -1
  let calibration: Calibration | null = null
  let anchors: Promise<CheckpointAnchor[]> | null = null
  let dictionary: Promise<ResponseDictionary | null> = Promise.resolve(null)
  let dictionaryRequired = false
  let dictionaryReservation: NumericalMemoryReservation | null = null
  let spatialEnvelope: Promise<QualifiedSpatialEnvelope | null> = Promise.resolve(null)
  let spatialEnvelopeReservation: NumericalMemoryReservation | null = null
  let activeJobId: string | null = null
  let activeJobToken: symbol | null = null
  let finalizeJobId: string | undefined

  function postMemory() {
    if (closed) return
    const snapshot = memory.snapshot()
    if (lastMemory?.reservedBytes === snapshot.reservedBytes && lastMemory.highWaterBytes === snapshot.highWaterBytes) return
    lastMemory = snapshot
    port.postMessage({ ...identity, kind: 'numerical-memory', memory: snapshot })
  }

  const reject = () => {
    if (closed) return
    closed = true
    activeJobId = null
    activeJobToken = null
    port.onmessage = null
    port.postMessage({ ...identity, kind: 'invalid-public-batch' })
    port.close()
    void Promise.allSettled([dictionary, spatialEnvelope, ...pendingJobs]).then(() => {
      dictionary = Promise.resolve(null)
      dictionaryReservation?.release()
      dictionaryReservation = null
      spatialEnvelope = Promise.resolve(null)
      spatialEnvelopeReservation?.release()
      spatialEnvelopeReservation = null
    })
  }

  function trackJob(
    task: Promise<void>, closeTaskYield: () => void, ...reservations: readonly NumericalMemoryReservation[]
  ) {
    pendingJobs.add(task)
    void task.finally(() => {
      pendingJobs.delete(task)
      closeTaskYield()
      for (const reservation of reservations) reservation.release()
      postMemory()
    }).catch(reject)
  }

  async function withScreeningWorkspace<T>(
    responses: ResponseDictionary | null, observationCount: number, spatial: boolean, task: () => Promise<T>,
  ): Promise<T> {
    if (!responses) return task()
    const responseBytes = responses.traces.reduce((max, trace) => Math.max(max, trace.stepResponse.byteLength), 0)
    const bytes = nativeScreeningWorkspaceBytes(observationCount, responseBytes)
    // Spatial exclusion also checks one freshly initialized N200 anchor at a time.
    const workspace = memory.reserveBytes('inverse screening workspace', bytes + (spatial ? 32 * 1024 : 0))
    if (!workspace) throw new InferenceMemoryLimit()
    postMemory()
    try {
      return await task()
    } finally {
      workspace.release()
      postMemory()
    }
  }

  async function openDictionary(data: InferenceConfigure) {
    const hash = data.calibration.hashes.dictionary
    const prepareSpatialProfile = (await spatialEnvelope) !== null
    if (!data.dictionary) return loadReservedBundledResponseDictionary(hash, memory, { prepareSpatialProfile })
    const reservation = prepareSpatialProfile
      ? memory.reserveBytes('transferred dictionary data and spatial prefixes',
        data.dictionary.data.byteLength + dictionarySpatialPrefixBytes(data.dictionary.manifest))
      : memory.retainBuffers('provided dictionary data', data.dictionary.data)
    if (!reservation) return { kind: 'resource-limit' } as const
    try {
      const result = await loadResponseDictionary(data.dictionary.manifest, data.dictionary.data, hash, { prepareSpatialProfile })
      if (result) return { kind: 'loaded', dictionary: result, reservation } as const
    } catch {
      // A rejected dictionary is unavailable for this run.
    }
    reservation.release()
    return { kind: 'unavailable' } as const
  }

  port.onmessage = (message: MessageEvent<unknown>) => {
    const input = message.data
    if (typeof input === 'object' && input !== null && 'kind' in input) {
      const request = inverseRequestSchema.safeParse(input)
      if (!request.success) return reject()
      const data = request.data
      if (data.runId !== runId) return
      if (data.kind === 'cancel-inverse') {
        if (data.jobId === undefined) {
          activeJobId = null
          activeJobToken = null
        } else if (activeJobId === data.jobId) finalizeJobId = data.jobId
        return
      }
      if (data.kind === 'configure') {
        if (anchors || !data.calibration.qualification.quantitative || data.profile.mode !== 'turbulent'
          || data.calibration.profileId !== data.profile.profileId || data.calibration.modelVersion !== data.profile.modelVersion
          || data.calibration.sensorProfileId !== data.profile.sensorProfileId) return reject()
        calibration = data.calibration
        dictionaryRequired = Boolean(data.dictionary) || import.meta.env.PIPETWIN_BUNDLED_DICTIONARY === '1'
        const anchorTask = Promise.all(bankProfiles(data.profile).map((profile, index) => createCheckpointAnchor(index as AnchorId, profile)))
        anchors = anchorTask
        void anchorTask.catch(reject)
        if (dictionaryRequired && data.calibration.errorEnvelope.spatialArtifactSha256) {
          spatialEnvelope = loadReservedSpatialEnvelope(data.calibration, memory).then(async (result) => {
            if (!result) return null
            const values = await anchorTask.catch(() => null)
            if (closed || !values || values.some((anchor, index) => anchor.parameterHash !== result.envelope.anchorParameterHashes[index])) {
              result.reservation.release()
              return null
            }
            spatialEnvelopeReservation = result.reservation
            return result.envelope
          })
        }
        if (dictionaryRequired) {
          dictionary = openDictionary(data).then(async (result) => {
            if (result.kind === 'loaded') {
              const responses = result.dictionary
              const values = await anchorTask.catch(() => null)
              if (!closed && values && responses.profileId === data.profile.profileId
                && responses.modelVersion === data.profile.modelVersion && responses.bankVersion === data.calibration.bankVersion
                && values.every((anchor, index) => anchor.parameterHash === responses.anchorParameterHashes[index])) {
                dictionaryReservation = result.reservation
                postMemory()
                port.postMessage({ ...identity, kind: 'dictionary-ready' })
                return responses
              }
              result.reservation.release()
            }
            if (!closed) {
              postMemory()
              port.postMessage({ ...identity, kind: result.kind === 'resource-limit' ? 'resource-limit' : 'dictionary-unavailable' })
            }
            return null
          })
        }
        return
      }
      const { job } = data
      if (!anchors || !calibration || activeJobId || job.calibrationId !== calibration.calibrationId) return reject()
      const deadlineMs = data.kind === 'inverse' ? data.deadlineMs - performance.timeOrigin - RESULT_HANDOFF_MS : undefined
      const reservation = memory.retainBuffers('frozen inverse job', job)
      const forwardWorkspace = reservation && memory.reserveBytes(
        'inverse checkpoint restore and hydraulic trial', inverseForwardWorkspaceBytes(job.checkpointsByAnchor),
      )
      if (!reservation || !forwardWorkspace) {
        reservation?.release()
        postMemory()
        port.postMessage({ ...identity, kind: 'resource-limit', jobId: job.jobId })
        return
      }
      postMemory()
      const activeCalibration = calibration
      const { noise } = activeCalibration
      activeJobId = job.jobId
      const token = Symbol(job.jobId)
      activeJobToken = token
      finalizeJobId = undefined
      const shouldCancel = () => activeJobToken !== token
      const { yieldTask, close: closeTaskYield } = createTaskYield()
      const completeJob = () => {
        activeJobId = null
        activeJobToken = null
      }
      const failJob = (error: unknown) => {
        if (!(error instanceof InferenceMemoryLimit)) return reject()
        if (shouldCancel()) return
        completeJob()
        port.postMessage({ ...identity, kind: 'resource-limit', jobId: job.jobId })
      }
      if (data.kind === 'replay-inverse') {
        const task = Promise.all([anchors, dictionary, spatialEnvelope]).then(async ([values, responses, spatial]) => {
          if (shouldCancel()) return null
          if (data.decisionReplay) {
            const expected = data.decisionReplay
            if (expected.spatialEnvelopeSha256 && (!spatial || verifiedSpatialEnvelopeDigest(spatial) !== expected.spatialEnvelopeSha256)) {
              return { unavailable: 'spatial-envelope-unavailable' } as const
            }
            if (expected.dictionaryLoaded && !responses) return null
            let provisional: InverseProvisionalAudit | undefined
            const decision = await withScreeningWorkspace(expected.dictionaryLoaded ? responses : null,
              job.observations.length, Boolean(expected.spatialEnvelopeSha256),
              () => replayDiagnosticDecision(job, values, activeCalibration, expected, data.trials, responses, {
                shouldCancel, yieldTask, qualifiedSpatialEnvelope: spatial ?? undefined,
                provisional: data.provisional,
                onVerifiedProvisional: (checkpoint) => { provisional = checkpoint },
              }))
            return { matched: decision !== null, decision: decision ?? undefined, provisional }
          }
          if (data.provisional) return { matched: false }
          const result = await replayExactTrials(job, values, noise, data.trials, { shouldCancel, yieldTask })
          return { matched: result.status === 'matched' }
        }).then((result) => {
          if (shouldCancel()) return
          completeJob()
          if (!result) {
            port.postMessage({ ...identity, kind: 'dictionary-unavailable', jobId: job.jobId })
            return
          }
          if ('unavailable' in result) {
            port.postMessage({ ...identity, kind: result.unavailable, jobId: job.jobId })
            return
          }
          port.postMessage({ ...identity, kind: 'replay-inverse-result', jobId: job.jobId, ...result })
        }, failJob)
        trackJob(task, closeTaskYield, reservation, forwardWorkspace)
        return
      }
      const trials: CpuTrial[] = []
      const task = Promise.all([anchors, dictionary, spatialEnvelope]).then(async ([values, responses, spatial]) => {
        if (shouldCancel() || dictionaryRequired && !responses) return null
        let timing: InverseTiming = { wallStopCheck: null, cancelStopCheck: null, incompleteTrialOrdinal: null }
        const result = await withScreeningWorkspace(responses, job.observations.length, spatial !== null, () =>
          withForwardPrefixWorkspace(memory, forwardPrefixCacheBytes(job), (useHydraulicPrefix) => runInverseSearch(job, values, noise, {
            deadlineMs,
            provisionalAtMs: data.deadlineMs - performance.timeOrigin - job.searchBudget.wallLimitMs + PROVISIONAL_TARGET_MS,
            onProvisional: (check, summary) => {
              port.postMessage({ ...identity, kind: 'inverse-provisional', checkpoint: { check, result: summary } })
            },
            useHydraulicPrefix,
            yieldTask,
            dictionary: responses ?? undefined,
            regionCalibration: activeCalibration,
            qualifiedSpatialEnvelope: spatial ?? undefined,
            shouldCancel: () => shouldCancel() || finalizeJobId === job.jobId,
            onTiming: (value) => { timing = value },
            onEvaluation: (trial) => { trials.push(serializeCpuTrial(trial)) },
          }), postMemory))
        return { result, timing: { ...timing, dictionaryLoaded: responses !== null,
          spatialEnvelopeSha256: spatial ? verifiedSpatialEnvelopeDigest(spatial) : undefined } }
      }).then((response) => {
        if (shouldCancel()) return
        completeJob()
        if (!response) {
          port.postMessage({ ...identity, kind: 'dictionary-unavailable', jobId: job.jobId })
          return
        }
        const { result, timing } = response
        port.postMessage({ ...identity, kind: 'inverse-result', result, trials, timing })
      }, failJob)
      trackJob(task, closeTaskYield, reservation, forwardWorkspace)
      return
    }
    const parsed = publicBatchSchema.safeParse(input)
    if (!parsed.success) return reject()
    const batch = parsed.data
    if (batch.sampleTimeUs <= latestTimeUs) return
    latestTimeUs = batch.sampleTimeUs
    if (latestTimeUs % 50_000 !== 0) return
    port.postMessage({ ...identity, kind: 'residual', timeUs: latestTimeUs, residualPa: pressureResiduals(batch) })
  }
  postMemory()
}
