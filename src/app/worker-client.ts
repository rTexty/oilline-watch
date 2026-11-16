import type { ProfileId } from '../contracts/model'
import type { SensorId } from '../contracts/public'
import type { ReplayRecord, ReplaySensorFault } from '../runtime/replay-schema'
import { snapshotMessageSchema } from '../runtime/vertical-protocol'
import type { Command, Control, RunSnapshot } from '../runtime/vertical-protocol'

export type { RunSnapshot }

export interface RunClient {
  injectLeak(positionM: number, cdAreaM2: number, openingUs: number): void
  setOutletFlow(outletFlowM3s: number): void
  setSensorFault(sensorId: SensorId, fault: ReplaySensorFault): void
  setPace(pace: number): void
  pause(): void
  resume(): void
  reveal(): void
  close(): void
}

interface RunOptions {
  readonly pace?: number
  readonly replay?: ReplayRecord
  readonly diagnosticRelease?: Extract<Command, { kind: 'start' }>['diagnosticRelease']
}

export function startRun(profileId: ProfileId, onUpdate: (snapshot: RunSnapshot) => void, options?: RunOptions): RunClient {
  const simulation = new Worker(new URL('../runtime/simulation.worker.ts', import.meta.url), { type: 'module' })
  let inference: Worker
  try {
    inference = new Worker(new URL('../runtime/inference.worker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    simulation.terminate()
    throw error
  }

  const channel = new MessageChannel()
  const runId = crypto.randomUUID()
  let sequence = 0
  let incomingSequence = -1
  let closed = false
  let inferenceRetired = false
  let latest: RunSnapshot | undefined
  const send = (control: Control) => {
    if (!closed) simulation.postMessage({ schemaVersion: 1, runId, seq: sequence++, ...control })
  }
  const hidden = () => {
    if (document.hidden) send({ kind: 'pause' })
  }
  const retireInference = () => {
    if (inferenceRetired) return
    inferenceRetired = true
    inference.terminate()
  }
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(startup)
    document.removeEventListener('visibilitychange', hidden)
    simulation.terminate()
    retireInference()
  }
  const fail = (message: string) => {
    if (closed) return
    close()
    onUpdate({
      profileId, timeUs: 0, armedAtUs: null, samples: [], prediction: [], residualPa: [], residualTimeUs: null,
      temperatures: { oilInK: 313.15, oilOutK: 313.15, wallOutK: 313.15 },
      appliedTimeUs: null, leakStatus: 'idle', diagnostic: null, truth: null, replay: null, replaying: false, ...latest,
      phase: 'error', message,
    })
  }
  simulation.onmessage = (event: MessageEvent<unknown>) => {
    if (closed) return
    const parsed = snapshotMessageSchema.safeParse(event.data)
    if (!parsed.success) {
      fail('Получен некорректный ответ симулятора.')
      return
    }
    const { snapshot, seq, runId: source } = parsed.data
    if (source !== runId || seq <= incomingSequence) return
    clearTimeout(startup)
    incomingSequence = seq
    latest = snapshot
    if (snapshot.phase === 'completed' || snapshot.phase === 'invalid' || snapshot.phase === 'error') retireInference()
    onUpdate(snapshot)
  }
  simulation.onerror = () => fail('Процесс симуляции остановлен.')
  inference.onerror = () => { if (!inferenceRetired) fail('Диагностический процесс остановлен.') }
  simulation.onmessageerror = () => fail('Ошибка обмена данными между процессами.')
  inference.onmessageerror = () => { if (!inferenceRetired) fail('Ошибка обмена данными между процессами.') }
  const startup = setTimeout(() => fail('Симулятор не запустился за 10 секунд.'), 10_000)
  inference.postMessage({ schemaVersion: 1, runId, port: channel.port2 }, [channel.port2])
  simulation.postMessage({
    schemaVersion: 1, runId, seq: sequence++, kind: 'start', profileId, port: channel.port1,
    pace: options?.pace === 4 ? 4 : 1, replay: options?.replay, diagnosticRelease: options?.diagnosticRelease,
  }, [channel.port1])
  document.addEventListener('visibilitychange', hidden)
  hidden()

  return {
    injectLeak: (positionM, cdAreaM2, openingUs) => send({ kind: 'leak', positionM, cdAreaM2, openingUs }),
    setOutletFlow: (outletFlowM3s) => send({ kind: 'outlet', outletFlowM3s }),
    setSensorFault: (sensorId, fault) => send({ kind: 'sensor-fault', sensorId, fault }),
    setPace: (pace) => send({ kind: 'pace', pace: pace === 4 ? 4 : 1 }),
    pause: () => send({ kind: 'pause' }),
    resume: () => send({ kind: 'resume' }),
    reveal: () => send({ kind: 'reveal' }),
    close,
  }
}
