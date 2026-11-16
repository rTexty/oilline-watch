import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { objective, pressureFormat, PRESSURE_IDS, SITE_MAX_X, SITE_MIN_X, TOOL_LABELS, WALK_TARGETS, type PressureId, type ToolId } from './model'
import type { CameraMode, TouchInput, WalkRuntime, WalkView } from './runtime'
import './walk.css'

type Pressures = Readonly<Partial<Record<PressureId, number>>>

const MOVEMENT: readonly { key: TouchInput; label: string; icon: string }[] = [
  { key: 'forward', label: 'Вперёд', icon: '↑' },
  { key: 'left', label: 'Влево', icon: '←' },
  { key: 'back', label: 'Назад', icon: '↓' },
  { key: 'right', label: 'Вправо', icon: '→' },
  { key: 'sprint', label: 'Бег', icon: 'Бег' },
]
const TOOLS = ['scanner', 'sleeve'] as const satisfies readonly ToolId[]
const CAMERA_MODES = [
  { id: 'first', label: 'От первого лица', short: '1-е лицо' },
  { id: 'third', label: 'От третьего лица', short: '3-е лицо' },
] as const satisfies readonly { id: CameraMode; label: string; short: string }[]

function WalkMap({ x, destination }: { readonly x: number; readonly destination?: number }) {
  const fraction = (position: number) => Math.round((position - SITE_MIN_X) * 1000 / (SITE_MAX_X - SITE_MIN_X)) / 10
  return (
    <div className="walk-map" aria-hidden="true">
      <div className="walk-map-track">
        {WALK_TARGETS.filter(target => target.id === 'P1' || target.id === 'P2' || target.id === 'P3')
          .map((target) => <i key={target.id} style={{ left: `${fraction(target.x)}%` }} />)}
        {destination === undefined ? null : <i className="walk-map-target" style={{ left: `${fraction(destination)}%` }} />}
        <b style={{ left: `${fraction(x)}%` }} />
      </div>
      <div className="walk-map-label"><span>Вход</span><span>Выход</span></div>
    </div>
  )
}

function WalkHUD({ view, runtime }: { readonly view: WalkView; readonly runtime: RefObject<WalkRuntime | null> }) {
  const actionTargetId = useId()
  const { mission, target, position, message, cameraMode } = view
  const progress = objective(mission)
  const xM = Math.round(position.x - SITE_MIN_X)
  const destination = WALK_TARGETS.find(({ id }) => id === progress.next)?.x
  const release = (event: PointerEvent<HTMLButtonElement>) => runtime.current?.setTouch(event.pointerId, null)

  function capture(event: PointerEvent<HTMLButtonElement>, input: TouchInput) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    runtime.current?.setTouch(event.pointerId, input)
  }

  return (
    <>
      <div className="walk-camera-switch" role="group" aria-label="Вид камеры">
        {CAMERA_MODES.map(({ id, label, short }) => (
          <button key={id} type="button" aria-label={label} aria-pressed={cameraMode === id}
            onClick={() => runtime.current?.setCameraMode(id)}>{short}</button>
        ))}
      </div>
      {cameraMode === 'first' ? <span className="walk-reticle" aria-hidden="true" /> : null}
      <section className="walk-mission walk-pane" aria-label="Задание">
        <div className="walk-mission-progress">
          <span>{progress.readings} / 3 датчика</span>
          <span data-complete={mission.repaired}>{mission.repaired ? 'Утечка устранена' : 'Учебная утечка'}</span>
        </div>
        <h2 data-testid="walk-objective">{progress.text}</h2>
        <dl className="walk-readings" aria-label="Журнал показаний">
          {PRESSURE_IDS.map((id) => {
            const reading = mission.readings[id]
            return <div key={id}>
              <dt>{id}</dt>
              <dd data-recorded={Boolean(reading)}>
                {reading ? <><span>{pressureFormat.format(reading.pressurePa / 100_000)} бар абс.</span>
                  <small>{reading.source === 'stand' ? 'Стенд' : 'Учебный'}</small></> : '—'}
              </dd>
            </div>
          })}
        </dl>
      </section>

      <div className="walk-location walk-pane">
        <p data-testid="walk-position" data-world-x={position.x} data-world-z={position.z}>
          Площадка <b>{xM} м</b><span className="sr-only"> · поперёк площадки {position.z.toFixed(1)} м</span>
        </p>
        <WalkMap x={position.x} destination={destination} />
      </div>

      <section className="walk-inventory walk-pane" aria-label="Инвентарь">
        <h2>Инвентарь</h2>
        <ul>
          {TOOLS.map((tool, index) => (
            <li key={tool}>
              {mission[tool] ? <button type="button" aria-pressed={mission.equipped === tool}
                aria-label={TOOL_LABELS[tool]} onClick={() => runtime.current?.equip(tool)}>
                <kbd aria-hidden="true">{index + 1}</kbd><span>{TOOL_LABELS[tool]}</span>
              </button> : <span className="walk-empty-slot"><kbd aria-hidden="true">{index + 1}</kbd>Пусто</span>}
            </li>
          ))}
        </ul>
      </section>

      <div className="walk-dpad" role="group" aria-label="Движение">
        {MOVEMENT.map(({ key, label, icon }) => (
          <button className={`walk-dpad-${key}`} key={key} aria-label={label} type="button"
            onPointerDown={(event) => capture(event, key)}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onClick={(event) => { if (event.detail === 0) runtime.current?.nudge(key) }}>
            {icon}
          </button>
        ))}
      </div>

      <div className="walk-action">
        <p className="walk-action-message walk-pane" role="status">{message}</p>
        <button type="button" aria-label="Взаимодействовать" aria-describedby={actionTargetId} disabled={!target}
          onClick={() => { if (target) runtime.current?.activate(target.id) }}>
          <kbd aria-hidden="true">E</kbd>
          <span id={actionTargetId}>{target ? target.label : 'Подойдите к оборудованию'}</span>
        </button>
      </div>

      <p className="walk-help">
        <span><kbd>W A S D</kbd> ходьба</span><span><kbd>Shift</kbd> бег</span><span><kbd>V</kbd> вид</span>
        <span><kbd>1 / 2</kbd> инструменты</span><span>Клик по объекту · перетаскивание для обзора</span>
      </p>
    </>
  )
}

export function WalkDialog({ onClose, opener, pressures }: {
  readonly onClose: () => void
  readonly opener: RefObject<HTMLButtonElement | null>
  readonly pressures: Pressures
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const runtime = useRef<WalkRuntime | null>(null)
  const pressuresRef = useRef(pressures)
  const [view, setView] = useState<WalkView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenMessage, setFullscreenMessage] = useState('')

  useLayoutEffect(() => { pressuresRef.current = pressures }, [pressures])

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const screen = screenRef.current
    if (!dialog || !screen) return
    const button = opener.current
    dialog.showModal()
    closeRef.current?.focus()
    const update = () => setFullscreen(document.fullscreenElement === screen)
    document.addEventListener('fullscreenchange', update)
    return () => {
      document.removeEventListener('fullscreenchange', update)
      if (document.fullscreenElement === screen) {
        void document.exitFullscreen().catch(() => { /* Removing the fullscreen element also exits. */ })
      }
      dialog.close()
      button?.focus()
    }
  }, [opener])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let active = true
    void import('./runtime').then(({ createWalkRuntime }) => {
      if (!active) return
      runtime.current = createWalkRuntime(canvas, {
        onUpdate: setView,
        onError: setError,
        getPressure: id => pressuresRef.current[id],
      })
    }).catch((failure: unknown) => {
      if (!active) return
      setError(failure instanceof Error && failure.message.includes('WebGL')
        ? failure.message : 'Не удалось загрузить 3D-обход. Закройте режим и попробуйте снова.')
    })
    return () => {
      active = false
      runtime.current?.dispose()
      runtime.current = null
    }
  }, [])

  async function toggleFullscreen() {
    const screen = screenRef.current
    if (!screen) return
    try {
      if (document.fullscreenElement === screen) await document.exitFullscreen()
      else if (screen.requestFullscreen) await screen.requestFullscreen({ navigationUI: 'hide' })
      else throw new Error('Fullscreen unavailable')
      setFullscreenMessage('')
    } catch {
      setFullscreenMessage('Обход уже занимает всё окно.')
    }
  }

  return (
    <dialog className="walk-dialog" ref={dialogRef} aria-labelledby={titleId} onCancel={(event) => {
      event.preventDefault()
      if (document.fullscreenElement === screenRef.current) void toggleFullscreen()
      else onClose()
    }}>
      <div className="walk-screen" ref={screenRef}>
      <canvas ref={canvasRef} className="walk-canvas" data-testid="walk-canvas" data-view={view?.cameraMode ?? 'third'} aria-hidden="true" />
      <header className="walk-top">
        <div className="walk-title">
          <span>OilLine Watch <b>·</b> Учебный режим</span>
          <h1 id={titleId}>Обход участка</h1>
        </div>
        <div className="walk-top-actions">
          <button type="button" className="walk-full" aria-label={fullscreen ? 'Выйти из полного экрана' : 'Полный экран'}
            title={fullscreen ? 'Выйти из полного экрана' : 'Полный экран'} aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>
            <span className="walk-full-icon" aria-hidden="true" /><span className="walk-button-text">Полный экран</span>
          </button>
          <button type="button" className="walk-exit" ref={closeRef} aria-label="Закрыть обход" title="Закрыть обход" onClick={onClose}>
            <span aria-hidden="true">×</span><span className="walk-button-text">Закрыть обход</span>
          </button>
        </div>
      </header>
      {fullscreenMessage ? <p className="walk-full-message walk-pane" role="status">{fullscreenMessage}</p> : null}
      {error ? <p className="walk-wait walk-pane" role="alert">{error}</p>
        : view ? <WalkHUD view={view} runtime={runtime} />
          : <p className="walk-wait walk-pane" role="status">Загружается 3D-участок…</p>}
      </div>
    </dialog>
  )
}
