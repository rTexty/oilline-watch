export const PRESSURE_IDS = ['P1', 'P2', 'P3'] as const
export type PressureId = typeof PRESSURE_IDS[number]
export type Position = { readonly x: number; readonly z: number }
export type ToolId = 'scanner' | 'sleeve'
export type TargetId = PressureId | ToolId | 'valve' | 'leak' | 'flange' | 'shell'
type Target = Position & { readonly id: TargetId; readonly label: string }

export const INITIAL_POSITION: Position = { x: 0, z: 3 }
export const SITE_MIN_X = -10
export const SITE_MAX_X = 68
export const PATH_LIGHTS = [7, 17, 28, 40, 54, 64].map(x => ({ x, z: 6.6 }))
const INTERACTION_RADIUS = 2.8
const WALK_SPEED = 5
const SPRINT_SPEED = 10
export const WALK_TARGETS = [
  { id: 'scanner', label: 'Сканер', x: 2, z: 4.1 },
  { id: 'P1', label: 'Датчик P1', x: 9, z: 1 },
  { id: 'flange', label: 'Фланец', x: 12, z: -.8 },
  { id: 'valve', label: 'Задвижка', x: 18, z: -.8 },
  { id: 'P2', label: 'Датчик P2', x: 29, z: 1 },
  { id: 'sleeve', label: 'Ремонтная муфта', x: 36, z: 4.1 },
  { id: 'leak', label: 'Учебная утечка', x: 43, z: -.6 },
  { id: 'shell', label: 'Стенка трубы', x: 52, z: -.8 },
  { id: 'P3', label: 'Датчик P3', x: 56, z: 1 },
] as const satisfies readonly Target[]

const TRAINING_PRESSURE_PA: Readonly<Record<PressureId, number>> = { P1: 425_000, P2: 412_000, P3: 396_000 }
export const pressureFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export type Reading = { readonly pressurePa: number; readonly source: 'stand' | 'training' }
export type Mission = {
  readonly scanner: boolean
  readonly sleeve: boolean
  readonly scanned: boolean
  readonly repaired: boolean
  readonly equipped: ToolId | null
  readonly valveClosed: boolean
  readonly readings: Readonly<Partial<Record<PressureId, Reading>>>
}
export const INITIAL_MISSION: Mission = { scanner: false, sleeve: false, scanned: false, repaired: false, equipped: null, valveClosed: false, readings: {} }
export const TOOL_LABELS: Readonly<Record<ToolId, string>> = { scanner: 'Сканер', sleeve: 'Ремонтная муфта' }
type ActionResult = { readonly mission: Mission; readonly message: string; readonly used?: ToolId }

export function isPressureId(id: TargetId): id is PressureId {
  return id === 'P1' || id === 'P2' || id === 'P3'
}

function available(mission: Mission, id: TargetId) {
  return !(id === 'scanner' && mission.scanner) && !(id === 'sleeve' && (mission.sleeve || mission.repaired))
}

export function targetInReach(position: Position, mission: Mission, id: TargetId): Target | null {
  const target = WALK_TARGETS.find(candidate => candidate.id === id)
  if (!target || !available(mission, id)) return null
  return Math.hypot(target.x - position.x, target.z - position.z) <= INTERACTION_RADIUS ? target : null
}

export function nearestTarget(position: Position, mission: Mission): Target | null {
  let best: Target | null = null
  let distance = INTERACTION_RADIUS
  for (const target of WALK_TARGETS) {
    if (!available(mission, target.id)) continue
    const candidate = Math.hypot(target.x - position.x, target.z - position.z)
    if (candidate > distance || (best !== null && candidate === distance)) continue
    best = target
    distance = candidate
  }
  return best
}

const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value))
const AVATAR_RADIUS = .23
type Footprint = Position & { readonly halfX: number; readonly halfZ: number }
const equipment = WALK_TARGETS.flatMap<Footprint>((point) => {
  if (point.id === 'scanner' || point.id === 'sleeve') return [{ x: point.x, z: point.z, halfX: .52, halfZ: .44 }]
  if (isPressureId(point.id)) return [{ x: point.x, z: point.z - .1, halfX: .45, halfZ: .35 }]
  return []
})
const OBSTACLES = [...equipment, ...PATH_LIGHTS.map(point => ({ ...point, halfX: .19, halfZ: .19 }))]

function blocked(x: number, z: number) {
  return OBSTACLES.some(obstacle => Math.abs(x - obstacle.x) < obstacle.halfX + AVATAR_RADIUS
    && Math.abs(z - obstacle.z) < obstacle.halfZ + AVATAR_RADIUS)
}

export function movePlayer(position: Position, yaw: number, forward: number, right: number, sprint: boolean, dt: number): Position {
  const length = Math.hypot(forward, right)
  if (length === 0 || dt <= 0) return position
  const step = (sprint ? SPRINT_SPEED : WALK_SPEED) * Math.min(dt, .05) / length
  const nextX = clamp(position.x + step * (forward * Math.cos(yaw) - right * Math.sin(yaw)), SITE_MIN_X, SITE_MAX_X)
  const nextZ = clamp(position.z + step * (forward * Math.sin(yaw) + right * Math.cos(yaw)), -1.2, 11)
  const x = blocked(nextX, position.z) ? position.x : nextX
  return { x, z: blocked(x, nextZ) ? position.z : nextZ }
}

export function equipTool(mission: Mission, tool: ToolId): ActionResult {
  if (!mission[tool]) return { mission, message: `${TOOL_LABELS[tool]} ещё нужно подобрать.` }
  return {
    mission: mission.equipped === tool ? mission : { ...mission, equipped: tool },
    message: tool === 'scanner' ? 'Сканер в руке.' : 'Ремонтная муфта в руках.',
  }
}

function repair(mission: Mission): ActionResult {
  if (mission.repaired) return { mission, message: 'Муфта установлена. Учебная утечка устранена.' }
  if (!mission.scanned) {
    if (mission.equipped !== 'scanner') return { mission, message: 'Возьмите сканер в руку и проверьте участок трубы.' }
    return { mission: { ...mission, scanned: true }, message: 'Сканер подтвердил учебную утечку. Возьмите муфту в руки.', used: 'scanner' }
  }
  if (!mission.sleeve) return { mission, message: 'Заберите ремонтную муфту из ящика рядом с P2.' }
  if (mission.equipped !== 'sleeve') return { mission, message: 'Выберите ремонтную муфту в инвентаре или нажмите 2.' }
  return {
    mission: { ...mission, sleeve: false, repaired: true, equipped: mission.scanner ? 'scanner' : null },
    message: 'Муфта установлена. Учебная утечка устранена.', used: 'sleeve',
  }
}

export function interact(mission: Mission, id: TargetId, pressurePa?: number): ActionResult {
  if (isPressureId(id)) {
    if (mission.equipped !== 'scanner') return { mission, message: 'Чтобы считать давление, возьмите сканер в руку.' }
    const reading: Reading = pressurePa === undefined
      ? { pressurePa: TRAINING_PRESSURE_PA[id], source: 'training' }
      : { pressurePa, source: 'stand' }
    const source = reading.source === 'stand' ? 'основной стенд' : 'учебный отсчёт'
    return {
      mission: { ...mission, readings: { ...mission.readings, [id]: reading } },
      message: `${id} · ${pressureFormat.format(reading.pressurePa / 100_000)} бар абс. · ${source}`,
      used: 'scanner',
    }
  }
  switch (id) {
    case 'scanner':
      return { mission: mission.scanner ? mission : { ...mission, scanner: true, equipped: mission.equipped ?? 'scanner' }, message: 'Сканер подобран. Считайте давление на P1, P2 и P3.' }
    case 'sleeve':
      return mission.repaired ? { mission, message: 'Муфта уже стоит на трубе.' }
        : { mission: mission.sleeve ? mission : { ...mission, sleeve: true, equipped: mission.equipped ?? 'sleeve' }, message: 'Ремонтная муфта подобрана. Клавиша 2 берёт её в руки.' }
    case 'valve':
      return {
        mission: { ...mission, valveClosed: !mission.valveClosed },
        message: mission.valveClosed ? 'Учебная задвижка открыта.' : 'Учебная задвижка закрыта.',
      }
    case 'leak':
      return repair(mission)
    case 'flange':
      return { mission, message: 'Фланец соединяет секции трубы. Осмотр завершён.' }
    case 'shell':
      return { mission, message: 'Стенка трубы осмотрена. Внутренний диаметр модели — 200 мм.' }
  }
}

export function objective(mission: Mission) {
  const readings = PRESSURE_IDS.filter(id => mission.readings[id]).length
  const done = readings === PRESSURE_IDS.length && mission.repaired
  const next = PRESSURE_IDS.find(id => !mission.readings[id])
  if (done) return { done, readings, text: 'Обход завершён', next: null }
  if (!mission.scanner) return { done, readings, text: 'Подберите сканер', next: 'scanner' }
  if (readings < 2 || mission.repaired) return {
    done, readings, text: mission.equipped === 'scanner' ? `Считайте показания ${next}` : 'Возьмите сканер в руку', next,
  }
  if (!mission.sleeve) return { done, readings, text: 'Подберите ремонтную муфту', next: 'sleeve' }
  const text = mission.scanned ? 'Установите муфту'
    : mission.equipped === 'scanner' ? 'Просканируйте участок у трубы' : 'Возьмите сканер в руку'
  return { done, readings, text, next: 'leak' }
}
