import type { ScenarioRow } from './scenario'

const columns = [
  'shift_m20_mm', 'shift_m10_mm', 'shift_m5_mm', 'shift_zero_mm',
  'shift_p5_mm', 'shift_p10_mm', 'shift_p20_mm',
] as const
const decimal = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export type ScenarioTrace = {
  id: string
  cutoff: string
  rows: (ScenarioRow & { priorityCount?: number })[]
}

export function readScenarioCsv(text: string): ScenarioTrace {
  const [header, ...lines] = text.trim().replace(/^\ufeff/, '').split(/\r?\n/)
  const fields = header?.split(',') ?? []
  const required = ['id', 'segment_id', 'cutoff', ...columns]
  if (new Set(fields).size !== fields.length || required.some(name => !fields.includes(name))) {
    throw new Error('Нужен candidate_repeat_scenarios.csv с семью сценариями.')
  }
  if (lines.length < 1 || lines.length > 10000) throw new Error('Ожидается от 1 до 10 000 сегментов.')
  const index = new Map(fields.map((key, i) => [key, i]))
  const hasPriorityCount = index.has('shift_priority_count')
  const value = (row: string[], key: string) => row[index.get(key) ?? -1] ?? ''
  const records = lines.map(line => {
    const row = line.split(',')
    const id = value(row, 'id')
    const cutoff = value(row, 'cutoff')
    const segment = value(row, 'segment_id')
    const measurements = columns.map(column => value(row, column))
    const rawPriorityCount = value(row, 'shift_priority_count')
    const segmentId = Number(segment)
    if (row.length !== fields.length || !/^\d+$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)
      || !/^\d+$/.test(segment) || !Number.isSafeInteger(segmentId)
      || measurements.some(x => !decimal.test(x) || !Number.isFinite(+x) || +x <= 0 || +x > 1000)) {
      throw new Error('В одной из строк неверный ключ, дата или толщина.')
    }
    if (hasPriorityCount && !/^[0-7]$/.test(rawPriorityCount)) {
      throw new Error('Число сдвигов, при которых сегмент входит в приоритет, должно быть от 0 до 7.')
    }
    const [a, b, c, d, e, f, g] = measurements.map(Number)
    const point: ScenarioTrace['rows'][number] = { segmentId, thicknessMm: [a!, b!, c!, d!, e!, f!, g!] }
    return { id, cutoff, row: hasPriorityCount ? { ...point, priorityCount: Number(rawPriorityCount) } : point }
  })
  const first = records[0]!
  if (records.some(record => record.id !== first.id || record.cutoff !== first.cutoff)) {
    throw new Error('В файле должны быть один ID и одна дата прогноза.')
  }
  const rows = records.map(record => record.row).sort((a, b) => a.segmentId - b.segmentId)
  if (rows.some((row, i) => row.segmentId !== i)) throw new Error('Сетка должна идти от нуля без пропусков и дублей.')
  return { id: first.id, cutoff: first.cutoff, rows }
}

export type ForecastRow = {
  segmentId: number
  thicknessMm: number
}

export type ForecastTrace = {
  id: string
  rows: ForecastRow[]
}

export type InspectionCsv =
  | { kind: 'scenarios'; trace: ScenarioTrace }
  | { kind: 'forecast'; traces: ForecastTrace[] }

export function readInspectionCsv(text: string): InspectionCsv {
  const [header, ...lines] = text.trim().replace(/^\ufeff/, '').split(/\r?\n/)
  const fields = header?.split(',') ?? []
  if (!fields.includes('thickness_pred')) {
    return { kind: 'scenarios', trace: readScenarioCsv(text) }
  }
  const idIndex = fields.indexOf('id')
  const segmentIndex = fields.indexOf('segment_id')
  const thicknessIndex = fields.indexOf('thickness_pred')
  if (fields.length !== 3 || idIndex < 0 || segmentIndex < 0) {
    throw new Error('Нужны три колонки: id, segment_id, thickness_pred.')
  }
  if (lines.length < 1 || lines.length > 10000) throw new Error('Ожидается от 1 до 10 000 сегментов.')
  const groups = new Map<string, ForecastRow[]>()
  for (const [index, line] of lines.entries()) {
    const row = line.split(',')
    const id = row[idIndex] ?? ''
    const segment = row[segmentIndex] ?? ''
    const measurement = row[thicknessIndex] ?? ''
    const segmentId = Number(segment)
    const thicknessMm = Number(measurement)
    if (row.length !== fields.length || !/^\d+$/.test(id) || !/^\d+$/.test(segment)
      || !Number.isSafeInteger(segmentId) || !decimal.test(measurement)
      || !Number.isFinite(thicknessMm) || thicknessMm <= 0 || thicknessMm > 1000) {
      throw new Error(`Строка ${index + 2}: неверный ID, номер сегмента или толщина.`)
    }
    const group = groups.get(id)
    const entry = { segmentId, thicknessMm }
    if (group) group.push(entry)
    else groups.set(id, [entry])
  }
  const traces = Array.from(groups, ([id, readings]) => {
    const rows = readings.sort((a, b) => a.segmentId - b.segmentId)
    if (rows.some((row, i) => row.segmentId !== i)) {
      throw new Error(`Труба ${id}: сетка должна идти от нуля без пропусков и дублей.`)
    }
    return { id, rows }
  })
  return { kind: 'forecast', traces }
}
