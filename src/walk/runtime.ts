import { ACESFilmicToneMapping, PCFShadowMap, PerspectiveCamera, Raycaster, SRGBColorSpace, Vector2, WebGLRenderer } from 'three'
import { INITIAL_MISSION, INITIAL_POSITION, equipTool, interact, isPressureId, movePlayer, nearestTarget, targetInReach, type Mission, type Position, type PressureId, type TargetId, type ToolId } from './model'
import { createWorld } from './world'

type Input = 'forward' | 'back' | 'left' | 'right' | 'sprint' | 'turn-left' | 'turn-right'
export type TouchInput = Exclude<Input, 'turn-left' | 'turn-right'>
export type CameraMode = 'first' | 'third'
export type WalkView = {
  readonly position: Position
  readonly mission: Mission
  readonly target: ReturnType<typeof nearestTarget>
  readonly message: string
  readonly cameraMode: CameraMode
}

export type WalkRuntime = ReturnType<typeof createWalkRuntime>

const KEY_INPUT: Readonly<Partial<Record<string, Input>>> = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'turn-left', ArrowRight: 'turn-right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
}
const DRAG_THRESHOLD = 6
const LEAK_MOTION_MS = 4_000

export function createWalkRuntime(canvas: HTMLCanvasElement, {
  onUpdate, onError, getPressure,
}: {
  readonly onUpdate: (view: WalkView) => void
  readonly onError: (message: string) => void
  readonly getPressure: (id: PressureId) => number | undefined
}) {
  const context = canvas.getContext('webgl2', { alpha: false, antialias: true })
  if (!context) throw new Error('Обход требует WebGL 2. Основной стенд доступен после выхода.')

  const renderer = new WebGLRenderer({ canvas, context, alpha: false, antialias: true })
  let world: ReturnType<typeof createWorld>
  try {
    world = createWorld()
  } catch (error) {
    renderer.dispose()
    throw error
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.27
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap

  const camera = new PerspectiveCamera(54, 1, .08, 205)
  const ray = new Raycaster()
  ray.near = camera.near
  ray.far = camera.far
  const cursor = new Vector2()
  const events = new AbortController()
  const options = { signal: events.signal }
  const keys = new Set<string>()
  const touch = new Map<number, TouchInput>()
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let position = INITIAL_POSITION
  let mission = INITIAL_MISSION
  let message = 'Нажмите на сканер, который лежит на ящике.'
  let cameraMode: CameraMode = 'third'
  let yaw = 0
  let tilt = 0
  let facing = Math.PI / 2
  let dragging: { readonly pointer: number; readonly x: number; readonly y: number; readonly moved: boolean } | null = null
  let previousTime = 0
  let publishedAt = 0
  let publishedTarget: TargetId | undefined
  let wasMoving = false
  let frameTime = 0
  let frame = 0
  let disposed = false
  let needsDraw = true
  let presented = false
  let leakScannedAt: number | null = null

  function publish(target = nearestTarget(position, mission)) {
    publishedAt = frameTime
    publishedTarget = target?.id
    onUpdate({ position, mission, target, message, cameraMode })
  }

  function commit(result: ReturnType<typeof interact>) {
    if (!mission.scanned && result.mission.scanned) leakScannedAt = performance.now()
    mission = result.mission
    message = result.message
    world.sync(mission)
    if (result.used && !prefersReducedMotion.matches) world.playUse(result.used)
    needsDraw = true
    publish()
  }

  function activate(expected?: TargetId) {
    const target = expected === undefined ? nearestTarget(position, mission) : targetInReach(position, mission, expected)
    if (!target) {
      if (expected !== undefined) {
        message = 'Подойдите ближе к объекту.'
        publish()
      }
      return
    }
    const result = interact(mission, target.id, isPressureId(target.id) ? getPressure(target.id) : undefined)
    if (result.used) facing = Math.atan2(target.x - position.x, target.z - position.z)
    commit(result)
  }

  function equip(tool: ToolId) {
    commit(equipTool(mission, tool))
  }

  function setCameraMode(mode: CameraMode) {
    if (cameraMode === mode) return
    cameraMode = mode
    dragging = null
    presented = false
    needsDraw = true
    publish()
  }

  function down(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.code === 'KeyE' || event.code === 'KeyV' || event.code === 'Digit1' || event.code === 'Digit2') {
      event.preventDefault()
      if (event.repeat) return
      if (event.code === 'KeyE') activate()
      else if (event.code === 'KeyV') setCameraMode(cameraMode === 'third' ? 'first' : 'third')
      else equip(event.code === 'Digit1' ? 'scanner' : 'sleeve')
      return
    }
    if (!KEY_INPUT[event.code]) return
    event.preventDefault()
    keys.add(event.code)
  }

  function up(event: KeyboardEvent) {
    keys.delete(event.code)
  }

  function held(input: Input) {
    for (const action of touch.values()) if (action === input) return true
    for (const code of keys) if (KEY_INPUT[code] === input) return true
    return false
  }

  function clearInput() {
    keys.clear()
    touch.clear()
    dragging = null
  }

  function pointerDown(event: PointerEvent) {
    if (dragging || event.button !== 0) return
    dragging = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
    canvas.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: PointerEvent) {
    if (dragging?.pointer !== event.pointerId) return
    const dx = event.clientX - dragging.x
    const dy = event.clientY - dragging.y
    if (!dragging.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    yaw -= dx * .008
    tilt = Math.min(1.5, Math.max(-1.5, tilt + dy * .014))
    dragging = { pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: true }
    needsDraw = true
  }

  function pointerEnd(event: PointerEvent) {
    if (dragging?.pointer !== event.pointerId) return
    const gesture = dragging
    dragging = null
    if (!presented || event.type !== 'pointerup' || gesture.moved
      || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= DRAG_THRESHOLD) return
    const bounds = canvas.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0
      || event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) return
    if (document.elementFromPoint(event.clientX, event.clientY) !== canvas) return
    cursor.set(2 * (event.clientX - bounds.left) / bounds.width - 1, 1 - 2 * (event.clientY - bounds.top) / bounds.height)
    ray.setFromCamera(cursor, camera)
    const id = world.pick(ray)
    if (id !== null) activate(id)
  }

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas
    if (width === 0 || height === 0) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    dragging = null
    presented = false
    needsDraw = true
  }

  function advance(forward: number, right: number, sprint: boolean, dt: number) {
    const next = movePlayer(position, yaw, forward, right, sprint, dt)
    if (next.x === position.x && next.z === position.z) return false
    facing = Math.atan2(next.x - position.x, next.z - position.z)
    position = next
    return true
  }

  function render(time: number, stride: number) {
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    if (cameraMode === 'first') {
      camera.fov = camera.aspect < .85 ? 75 : 66
      camera.position.set(position.x, 1.69, position.z)
      camera.lookAt(position.x + c, 1.69 - tilt * .7, position.z + s)
    } else {
      camera.fov = camera.aspect < .85 ? 67 : 55
      const lookSide = camera.aspect < .85 ? .63 : 1.65
      camera.position.set(position.x - 5.6 * c - 2.3 * s, 3.75 + tilt, Math.max(-1.65, position.z - 5.6 * s + 2.3 * c))
      camera.lookAt(position.x + 4.6 * c + lookSide * s, 1.45 - tilt * .35, position.z + 4.6 * s - lookSide * c)
    }
    camera.updateProjectionMatrix()
    world.avatar.position.set(position.x, 0, position.z)
    world.avatar.rotation.y = facing
    world.setView(camera, cameraMode === 'first')
    const reduced = prefersReducedMotion.matches
    const leakElapsed = reduced || leakScannedAt === null ? 0 : Math.min(LEAK_MOTION_MS, Math.max(0, time - leakScannedAt))
    world.animate(reduced ? 0 : time / 1_000, stride, leakElapsed / 1_000)
    renderer.render(world.scene, camera)
    presented = true
    needsDraw = false
  }

  function draw(time: number) {
    frameTime = time
    const dt = previousTime ? Math.min((time - previousTime) / 1_000, .05) : 0
    previousTime = time
    const turn = Number(held('turn-right')) - Number(held('turn-left'))
    yaw += turn * dt * 1.65
    const forward = Number(held('forward')) - Number(held('back'))
    const right = Number(held('right')) - Number(held('left'))
    const sprint = held('sprint')
    const moving = advance(forward, right, sprint, dt)
    const animatingLeak = leakScannedAt !== null && time - leakScannedAt < LEAK_MOTION_MS
      && !mission.repaired && !prefersReducedMotion.matches
    if (needsDraw || turn || moving || wasMoving || animatingLeak || world.isUsingTool()) render(time, moving ? (sprint ? 1 : .65) : 0)
    if (moving || wasMoving) {
      const target = nearestTarget(position, mission)
      if (!moving || target?.id !== publishedTarget || time - publishedAt >= 85) publish(target)
    }
    wasMoving = moving
    frame = requestAnimationFrame(draw)
  }

  const observer = new ResizeObserver(resize)
  function dispose() {
    if (disposed) return
    disposed = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    events.abort()
    world.dispose()
    renderer.dispose()
  }

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    dispose()
    onError('Графический контекст WebGL потерян. Закройте обход и откройте его заново.')
  }, options)
  for (const [name, listener] of [
    ['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerEnd],
    ['pointercancel', pointerEnd], ['lostpointercapture', pointerEnd],
  ] as const) canvas.addEventListener(name, listener, options)
  document.addEventListener('keydown', down, options)
  document.addEventListener('keyup', up, options)
  document.addEventListener('visibilitychange', clearInput, options)
  window.addEventListener('blur', clearInput, options)
  observer.observe(canvas)
  resize()
  world.sync(mission)
  publish()
  frame = requestAnimationFrame(draw)
  return {
    activate,
    equip,
    setCameraMode,
    setTouch(pointer: number, input: TouchInput | null) {
      if (input === null) touch.delete(pointer)
      else {
        touch.set(pointer, input)
        nudge(input)
      }
    },
    nudge,
    dispose,
  }

  function nudge(input: TouchInput) {
    const forward = Number(input === 'forward') - Number(input === 'back')
    const right = Number(input === 'right') - Number(input === 'left')
    if (!advance(forward, right, held('sprint'), .028)) return
    needsDraw = true
    publish()
  }
}
