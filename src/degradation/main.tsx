import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { readCandidateSelection, saveCandidateSelection } from './candidate-selection'
import { readInspectionCsv } from './load-scenarios'
import type { ForecastRow, ForecastTrace, InspectionCsv, ScenarioTrace } from './load-scenarios'
import { runCpu, runGpu } from './scenario'
import { defenseHomeLink, forecastLink, forecastMode } from '../ui/forecast-links'
import '../ui/surface.css'
import './style.css'

const SHIFTS = [-20, -10, -5, 0, 5, 10, 20]
const ALIGNMENT_PIPE_ID = '200002'
const TEST_SIZES = [1, 32, 512]
const MAX_CSV_BYTES = 4 * 1024 * 1024
const formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const format = (value: number) => formatter.format(value)
const formatShift = (shift: number) => `${shift > 0 ? '+' : ''}${shift} м`

const bundles = {
  demo: { name: 'wall-thickness-demo.csv', kind: 'forecast', label: 'Синтетический прогноз' },
  candidate: { name: 'result.csv', kind: 'forecast', label: 'Кандидатный прогноз' },
  alignment: { name: 'candidate_repeat_scenarios.csv', kind: 'scenarios', label: 'Сценарии привязки' },
  reportGap: { name: 'result.csv', kind: 'forecast', label: 'Экспериментальный прогноз' },
} as const
type Bundle = (typeof bundles)[keyof typeof bundles]

function requestedBundle(): Bundle | null {
  const mode = forecastMode(window.location.search)
  if (mode === 'demo') return bundles.demo
  if (mode === 'candidate') return bundles.candidate
  if (mode === 'alignment') return bundles.alignment
  if (mode === 'report-gap') return bundles.reportGap
  return null
}

async function readBundleCsv(bundle: Bundle, signal: AbortSignal): Promise<string> {
  const folder = bundle === bundles.reportGap ? 'report-gap/' : ''
  const path = bundle === bundles.demo ? `./${bundle.name}` : `../../forecast/${folder}${bundle.name}`
  const response = await fetch(path, { mode: 'same-origin', redirect: 'error', signal })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error('Файл прогноза недоступен.')
  }
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let received = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return chunks.join('') + decoder.decode()
      received += value.byteLength
      if (received > MAX_CSV_BYTES) {
        await reader.cancel()
        throw new Error('Размер CSV должен быть не больше 4 МБ.')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
}
const example: ScenarioTrace = {
  id: 'пример',
  cutoff: '',
  rows: Array.from({ length: 160 }, (_, segmentId) => {
    const value = (shift: number) => {
      const x = segmentId + shift / 10
      return 7.5 - 1.8 * Math.exp(-((x - 48) ** 2) / 45) - 2.4 * Math.exp(-((x - 116) ** 2) / 30)
        + 0.24 * Math.cos(0.41 * x) + 0.12 * Math.sin(0.61 * x)
    }
    return { segmentId, thicknessMm: [value(-20), value(-10), value(-5), value(0), value(5), value(10), value(20)] }
  }),
}

type Benchmark = { size: number; cpu: number; gpu: number; error: number; exact: boolean }

type ChartPoint = { thickness: number; low?: number; high?: number; priority?: boolean }

const CHART_LEFT = 48
const CHART_RIGHT = 20
const CHART_TOP = 17
const CHART_BOTTOM = 36
const LOCAL_SEGMENTS = 21
const TAP_TOLERANCE_PX = 5
const distance = (segmentId: number) => format(segmentId * 10)

function Plot({ points, focus, threshold, windowStart, onSelect }: {
  points: ChartPoint[]; focus: number; threshold: number | null
  windowStart: number | null; onSelect: (index: number) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const tap = useRef<{ id: number; x: number; y: number; points: ChartPoint[]; start: number } | null>(null)
  useEffect(() => {
    function cancelForSecondTouch(event: globalThis.PointerEvent) {
      if (event.pointerType === 'touch' && tap.current && tap.current.id !== event.pointerId) {
        tap.current = null
      }
    }
    document.addEventListener('pointerdown', cancelForSecondTouch, true)
    return () => document.removeEventListener('pointerdown', cancelForSecondTouch, true)
  }, [])
  const start = windowStart ?? 0
  const end = windowStart === null ? points.length : start + LOCAL_SEGMENTS
  const visiblePoints = useMemo(() => windowStart === null ? points : points.slice(start, end),
    [points, windowStart, start, end])
  const [low, high] = useMemo(() => {
    let min = threshold ?? Infinity, max = threshold ?? -Infinity
    for (const point of points) {
      min = Math.min(min, point.low ?? point.thickness)
      max = Math.max(max, point.high ?? point.thickness)
    }
    const floor = Math.floor(min * 2) / 2
    return [floor, Math.max(floor + 0.5, Math.ceil(max * 2) / 2)] as const
  }, [points, threshold])
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    function draw(element: HTMLCanvasElement) {
      const width = element.clientWidth
      const height = element.clientHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      element.width = width * ratio
      element.height = height * ratio
      const ctx = element.getContext('2d')
      if (!ctx || width < 100) return
      ctx.scale(ratio, ratio)
      const left = CHART_LEFT, top = CHART_TOP, right = width - CHART_RIGHT, bottom = height - CHART_BOTTOM
      const x = (i: number) => left + (right - left) * (i + 0.5) / visiblePoints.length
      const y = (v: number) => bottom - (bottom - top) * (v - low) / (high - low)
      ctx.font = '11px ui-monospace, monospace'
      ctx.fillStyle = '#516170'
      for (let i = 0; i <= 4; i++) {
        const v = low + (high - low) * i / 4
        const yy = y(v)
        ctx.strokeStyle = '#d6dfe8'
        ctx.beginPath()
        ctx.moveTo(left, yy)
        ctx.lineTo(right, yy)
        ctx.stroke()
        ctx.fillText(format(v), 5, yy + 4)
      }
      const stepWidth = (right - left) / visiblePoints.length
      if (visiblePoints[0]?.low !== undefined) {
        ctx.beginPath()
        for (const [i, point] of visiblePoints.entries()) {
          const level = y(point.high!)
          const edge = left + stepWidth * i
          if (i === 0) ctx.moveTo(edge, level)
          else ctx.lineTo(edge, level)
          ctx.lineTo(edge + stepWidth, level)
        }
        for (let i = visiblePoints.length - 1; i >= 0; i--) {
          const level = y(visiblePoints[i]!.low!)
          const edge = left + stepWidth * i
          ctx.lineTo(edge + stepWidth, level)
          ctx.lineTo(edge, level)
        }
        ctx.closePath()
        ctx.fillStyle = '#dce7ef'
        ctx.fill()
        ctx.strokeStyle = '#627e93'
        ctx.lineWidth = 1
        ctx.stroke()
      }
      ctx.beginPath()
      visiblePoints.forEach((point, i) => {
        const level = y(point.thickness)
        if (i === 0) ctx.moveTo(left, level)
        else ctx.lineTo(left + stepWidth * i, level)
        ctx.lineTo(left + stepWidth * (i + 1), level)
      })
      ctx.strokeStyle = '#3f637e'
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.fillStyle = '#8a592e'
      visiblePoints.forEach((point, i) => {
        if (!point.priority) return
        ctx.fillRect(x(i) - 2, y(point.thickness) - 2, 4, 4)
      })
      if (threshold !== null) {
        ctx.beginPath()
        ctx.setLineDash([4, 4])
        ctx.moveTo(left, y(threshold))
        ctx.lineTo(right, y(threshold))
        ctx.strokeStyle = '#8a592e'
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.fillStyle = '#516170'
      ctx.fillText(`${distance(start)} м`, left, height - 13)
      ctx.textAlign = 'right'
      ctx.fillText(`Последний с ${distance(end - 1)} м`, right, height - 13)
    }
    draw(element)
    const observer = new ResizeObserver(() => draw(element))
    observer.observe(element)
    return () => observer.disconnect()
  }, [visiblePoints, start, end, threshold, low, high])
  const selectedThickness = points[focus]!.thickness

  function selectPoint(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = (event.clientX - rect.left - CHART_LEFT) / Math.max(1, rect.width - CHART_LEFT - CHART_RIGHT)
    const local = Math.floor(fraction * visiblePoints.length)
    onSelect(start + Math.max(0, Math.min(visiblePoints.length - 1, local)))
  }

  function beginSelection(event: PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType !== 'touch') {
      if (event.button === 0) selectPoint(event)
      return
    }
    tap.current = event.isPrimary
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, points, start } : null
  }

  function cancelTapOnMove(event: PointerEvent<HTMLCanvasElement>) {
    const current = tap.current
    if (current?.id === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) >= TAP_TOLERANCE_PX) tap.current = null
  }

  function finishSelection(event: PointerEvent<HTMLCanvasElement>) {
    cancelTapOnMove(event)
    const current = tap.current
    if (current?.id !== event.pointerId) return
    tap.current = null
    if (current.points === points && current.start === start) selectPoint(event)
  }

  function cancelSelection(event: PointerEvent<HTMLCanvasElement>) {
    if (tap.current?.id === event.pointerId) tap.current = null
  }

  return <div className="plot">
    <canvas ref={canvas} aria-label={threshold === null ? 'График прогноза толщины по сегментам' : 'График толщины и диапазона сценариев'}
      aria-description={windowStart === null
        ? `Последний сегмент начинается на отметке ${distance(end - 1)} м.`
        : `Показаны сегменты ${start}–${end - 1}.`}
      role="img" onPointerDown={beginSelection} onPointerMove={cancelTapOnMove}
      onPointerUp={finishSelection} onPointerCancel={cancelSelection} onLostPointerCapture={cancelSelection} />
    <div className="plot-overlay" aria-hidden="true" style={{ left: CHART_LEFT, right: CHART_RIGHT, top: CHART_TOP, bottom: CHART_BOTTOM }}>
      <div className="plot-marker" style={{ left: `${100 * (focus - start + 0.5) / visiblePoints.length}%` }}>
        <span style={{ top: `${100 * (high - selectedThickness) / (high - low)}%` }} />
      </div>
    </div>
  </div>
}

function Priority({ list, rows, cutoffTie, selected, onSelect }: {
  list: React.RefObject<HTMLOListElement | null>;
  rows: ForecastRow[]; cutoffTie: { included: number; total: number } | null; selected: number; onSelect: (index: number) => void
}) {
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    let next: number
    switch (event.key) {
      case 'ArrowUp': next = Math.max(0, index - 1); break
      case 'ArrowDown': next = Math.min(rows.length - 1, index + 1); break
      case 'Home': next = 0; break
      case 'End': next = rows.length - 1; break
      default: return
    }
    event.preventDefault()
    list.current?.children.item(next)?.querySelector('button')?.focus()
  }

  return <section className="panel priority" aria-labelledby="priority-title">
    <div className="bar"><div><h2 id="priority-title">Приоритет проверки</h2>
      <p className="caption">Нижние 10% по толщине из CSV. Количество округлено вверх.
        {cutoffTie && ` На границе отбора одинаковая толщина. В списке ${cutoffTie.included} из ${cutoffTie.total}. При равенстве первыми идут меньшие номера.`}</p></div>
      <span className="value-tag">{format(rows.length)} сегментов</span></div>
    <ol ref={list} className="priority-list" role="list">{rows.map((row, index) => <li key={row.segmentId}>
      <button className="priority-button" type="button" aria-current={row.segmentId === selected ? true : undefined}
        aria-label={`Сегмент ${row.segmentId} · ${distance(row.segmentId)} м · ${format(row.thicknessMm)} мм`}
        onKeyDown={event => moveFocus(event, index)} onClick={() => onSelect(row.segmentId)}>
        <span>Сегмент {row.segmentId}<small>{distance(row.segmentId)} м от начала</small></span>
        <strong>{format(row.thicknessMm)} мм</strong>
        <span className="priority-arrow" aria-hidden="true">↗</span>
      </button>
    </li>)}</ol>
  </section>
}

const INITIAL: InspectionCsv = { kind: 'scenarios', trace: example }
type ProfileView = {
  data: InspectionCsv
  fileName: string | null
  bundle: Bundle | null
  pipe: string
  forecastSelections: ReadonlyMap<string, number>
  scenarioSelection: number
  zoomStart: number | null
}

function centeredStart(segment: number, length: number): number {
  return Math.max(0, Math.min(segment - Math.floor(LOCAL_SEGMENTS / 2), length - LOCAL_SEGMENTS))
}

function orderedForecast(rows: readonly ForecastRow[]) {
  return [...rows].sort((a, b) => a.thicknessMm - b.thicknessMm || a.segmentId - b.segmentId)
}

function App() {
  const [entry] = useState(requestedBundle)
  const secondaryProfile = entry === bundles.alignment || entry === bundles.reportGap
  const defenseHome = defenseHomeLink(window.location.pathname)
  const [{ data, fileName, bundle, pipe, forecastSelections, scenarioSelection, zoomStart }, setProfileView] = useState<ProfileView>({
    data: INITIAL, fileName: null, bundle: null, pipe: '', forecastSelections: new Map(), scenarioSelection: 0, zoomStart: null,
  })
  const [shift, setShift] = useState(3)
  const [threshold, setThreshold] = useState(6)
  const [segmentDraft, setSegmentDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(entry !== null)
  const [candidateTraces, setCandidateTraces] = useState<ForecastTrace[] | null>(null)
  const [benchmark, setBenchmark] = useState<Benchmark[]>([])
  const [engine, setEngine] = useState('CPU')
  const loading = useRef(0)
  const chart = useRef<HTMLElement>(null)
  const priorityList = useRef<HTMLOListElement>(null)

  const forecast = data.kind === 'forecast' ? data.traces.find(trace => trace.id === pipe) ?? data.traces[0]! : null
  const scenario = data.kind === 'scenarios' ? data.trace : null
  const selected = forecast ? forecastSelections.get(forecast.id) ?? 0 : scenarioSelection
  const candidatePipe = bundle === bundles.candidate ? forecast?.id : undefined
  useEffect(() => {
    if (candidatePipe !== undefined) saveCandidateSelection(candidatePipe, selected)
  }, [candidatePipe, selected])
  const { priority, cutoffTie } = useMemo(() => {
    if (!forecast) return { priority: [], cutoffTie: null }
    const ordered = orderedForecast(forecast.rows)
    const count = Math.ceil(ordered.length / 10)
    const priority = ordered.slice(0, count)
    const cutoff = priority.at(-1)!.thicknessMm
    if (cutoff !== ordered[count]?.thicknessMm) return { priority, cutoffTie: null }
    const included = priority.filter(row => row.thicknessMm === cutoff).length
    const total = ordered.filter(row => row.thicknessMm === cutoff).length
    return { priority, cutoffTie: { included, total } }
  }, [forecast])
  const points = useMemo(() => {
    if (forecast) {
      const priorityIds = new Set(priority.map(row => row.segmentId))
      return forecast.rows.map(row => ({ thickness: row.thicknessMm, priority: priorityIds.has(row.segmentId) }))
    }
    return (scenario ?? example).rows.map(row => ({
      thickness: row.thicknessMm[shift]!, low: Math.min(...row.thicknessMm), high: Math.max(...row.thicknessMm),
    }))
  }, [forecast, scenario, priority, shift])
  const counts = useMemo(() => scenario ? [...runCpu(scenario.rows, [threshold]).belowCounts] : [],
    [scenario, threshold])
  const current = points[selected] ?? points[0]!
  const canZoom = fileName !== null && points.length > LOCAL_SEGMENTS
  const windowStart = canZoom ? zoomStart : null
  const segmentStart = distance(selected)
  const segmentThickness = format(current.thickness)
  let scenarioRange = null
  if ('low' in current) {
    const low = format(current.low)
    const high = format(current.high)
    if (current.low === current.high) scenarioRange = `Все 7 сдвигов дают ${low} мм.`
    else if (low === high) scenarioRange = `По 7 сдвигам: около ${low} мм, разница меньше 0,01 мм.`
    else scenarioRange = `По 7 сдвигам: ${low}–${high} мм`
  }
  const selectedScenario = scenario?.rows[selected]
  const priorityCount = selectedScenario?.priorityCount
  const priorityRank = forecast ? priority.findIndex(row => row.segmentId === selected) + 1 : null
  const priorityText = priorityRank === null ? null : priorityRank > 0
    ? `В приоритете · ${format(priorityRank)} из ${format(priority.length)}` : 'Вне списка приоритетов'
  const comparisonTrace = candidateTraces?.find(trace => trace.id === forecast?.id)
  const comparisonRow = comparisonTrace?.rows.length === forecast?.rows.length
    ? comparisonTrace?.rows[selected] : undefined
  const comparisonRank = useMemo(() => {
    if (!comparisonTrace) return null
    const count = Math.ceil(comparisonTrace.rows.length / 10)
    const ranks = new Map(orderedForecast(comparisonTrace.rows)
      .slice(0, count).map((row, index) => [row.segmentId, index + 1]))
    return { count, ranks }
  }, [comparisonTrace])
  const comparisonIndex = comparisonRank?.ranks.get(selected)
  const segmentNumber = segmentDraft === null ? selected : Number(segmentDraft)
  const segmentInvalid = segmentDraft === '' || !Number.isInteger(segmentNumber)
    || segmentNumber < 0 || segmentNumber >= points.length
  const mean = useMemo(() => forecast
    ? forecast.rows.reduce((sum, row) => sum + row.thicknessMm, 0) / forecast.rows.length
    : null, [forecast])

  function selectSegment(index: number) {
    setProfileView(current => {
      if (current.data !== data || current.pipe !== pipe) return current
      const start = current.zoomStart
      const nextStart = start !== null && (index < start || index >= start + LOCAL_SEGMENTS)
        ? centeredStart(index, points.length) : start
      if (current.data.kind === 'scenarios') return { ...current, scenarioSelection: index, zoomStart: nextStart }
      return {
        ...current,
        forecastSelections: new Map(current.forecastSelections).set(current.pipe, index),
        zoomStart: nextStart,
      }
    })
    setSegmentDraft(null)
  }

  function setZoom(enabled: boolean) {
    setProfileView(current => {
      if (current.data !== data || current.pipe !== pipe) return current
      const focus = current.data.kind === 'scenarios'
        ? current.scenarioSelection : current.forecastSelections.get(current.pipe) ?? 0
      return { ...current, zoomStart: enabled ? current.zoomStart ?? centeredStart(focus, points.length) : null }
    })
  }

  function commitSegment() {
    if (!segmentInvalid) selectSegment(segmentNumber)
  }

  const loadCsv = useCallback(async (
    read: () => Promise<string>, name: string, bundle: Bundle | null,
  ) => {
    const request = ++loading.current
    setReading(true)
    try {
      const csv = await read()
      if (request !== loading.current) return
      const parsed = readInspectionCsv(csv)
      if (bundle && parsed.kind !== bundle.kind) throw new Error('Формат CSV не соответствует разделу.')
      const saved = bundle === bundles.candidate ? readCandidateSelection() : null
      const requestedSegment = new URLSearchParams(window.location.search).get('segment')
      const segment = requestedSegment !== null && /^\d+$/.test(requestedSegment) ? Number(requestedSegment) : 0
      const scenarioSelection = bundle === bundles.alignment && parsed.kind === 'scenarios'
        && parsed.trace.id === ALIGNMENT_PIPE_ID && segment < parsed.trace.rows.length ? segment : 0
      setProfileView(current => {
        const selections = new Map<string, number>()
        if (parsed.kind === 'forecast') {
          for (const trace of parsed.traces) {
            const index = current.forecastSelections.get(trace.id)
            if (index !== undefined && index < trace.rows.length) selections.set(trace.id, index)
          }
        }
        let nextPipe = ''
        if (parsed.kind === 'forecast') {
          const preferredPipe = bundle === bundles.reportGap ? ALIGNMENT_PIPE_ID : saved?.pipe ?? current.pipe
          const nextTrace = parsed.traces.find(trace => trace.id === preferredPipe) ?? parsed.traces[0]!
          nextPipe = nextTrace.id
          if (saved?.pipe === nextPipe && saved.segment < nextTrace.rows.length) {
            selections.set(nextPipe, saved.segment)
          }
          if (bundle === bundles.reportGap && nextPipe === ALIGNMENT_PIPE_ID && segment < nextTrace.rows.length) {
            selections.set(nextPipe, segment)
          }
        }
        return {
          data: parsed,
          fileName: name,
          bundle,
          pipe: nextPipe,
          forecastSelections: selections,
          scenarioSelection,
          zoomStart: null,
        }
      })
      setSegmentDraft(null)
      if (bundle === bundles.alignment) setShift(3)
      setBenchmark([])
      setEngine('CPU')
      setError('')
    } catch (cause) {
      if (request === loading.current) {
        setError(bundle ? `Не удалось открыть файл из комплекта. Загрузите ${bundle === bundles.reportGap ? 'forecast/report-gap/result.csv' : bundle.name} вручную.`
          : cause instanceof Error ? cause.message : 'Не удалось прочитать CSV.')
      }
    } finally {
      if (request === loading.current) setReading(false)
    }
  }, [])

  useEffect(() => {
    if (!entry) return
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 5_000)
    void loadCsv(() => readBundleCsv(entry, controller.signal), entry.name, entry).finally(() => window.clearTimeout(timeout))
    return () => {
      loading.current++
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [entry, loadCsv])

  useEffect(() => {
    if (bundle !== bundles.reportGap) return
    const controller = new AbortController()
    let active = true
    const timeout = window.setTimeout(() => controller.abort(), 5_000)
    void readBundleCsv(bundles.candidate, controller.signal).then(csv => {
      const data = readInspectionCsv(csv)
      if (active) setCandidateTraces(data.kind === 'forecast' ? data.traces : [])
    }).catch(() => {
      if (active) setCandidateTraces([])
    }).finally(() => window.clearTimeout(timeout))
    return () => {
      active = false
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [bundle])

  async function measure() {
    if (!scenario) return
    const { rows } = scenario
    setBusy(true)
    setBenchmark([])
    setError('')
    const results: Benchmark[] = []
    try {
      for (const size of TEST_SIZES) {
        const thresholds = Array.from({ length: size }, (_, i) => Math.max(0, threshold - i / Math.max(size, 2)))
        const cpuStart = performance.now()
        const cpu = runCpu(rows, thresholds)
        const cpuTime = performance.now() - cpuStart
        const gpuStart = performance.now()
        const gpu = await runGpu(rows, thresholds)
        const gpuTime = performance.now() - gpuStart
        const maxError = cpu.meansMm.reduce((value, result, i) => Math.max(value, Math.abs(result - gpu.meansMm[i]!)), 0)
        const exact = cpu.belowCounts.every((count, i) => count === gpu.belowCounts[i])
        results.push({ size, cpu: cpuTime, gpu: gpuTime, exact, error: maxError })
      }
      setBenchmark(results)
      setEngine(results.every(row => row.exact && row.error <= 0.0001) ? 'CPU · WebGPU проверен' : 'CPU · расхождение WebGPU')
    } catch (cause) {
      setBenchmark(results)
      setEngine('CPU · GPU-замер не завершён')
      setError(cause instanceof Error ? cause.message : 'WebGPU недоступен.')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <a className="skip-link" href="#main">К содержанию</a>
    <header className="mast"><div className="layout mast-inner">
      <a href={defenseHome ?? (secondaryProfile ? './index.html?forecast=candidate' : forecastLink('index.html'))}
        className="brand" aria-label={defenseHome ? 'OilLine Watch · к материалам' : undefined}
        title={defenseHome ? 'К материалам' : undefined}>OilLine Watch</a>
      {secondaryProfile
        ? <a className="lab-link" href="./degradation.html?forecast=candidate">К прогнозу толщины <span aria-hidden="true">↗</span></a>
        : <a className="lab-link" href={forecastLink('index.html')}>Стенд утечки <span aria-hidden="true">↗</span></a>}
      <label className="upload">Загрузить CSV<input aria-label="Загрузить CSV" type="file"
        accept=".csv,text/csv" disabled={busy} onChange={event => {
          const file = event.currentTarget.files?.[0]
          if (file) void loadCsv(async () => {
            if (file.size > MAX_CSV_BYTES) throw new Error('Размер CSV должен быть не больше 4 МБ.')
            return file.text()
          }, file.name, null)
          event.currentTarget.value = ''
        }} /></label>
    </div></header>
    <main className="layout" id="main" tabIndex={-1}>
      <section className="intro">
        <div><h1>Профиль толщины</h1>
          <p className="subtitle">{forecast ? 'Остаточная толщина стенки по сегментам с шагом 10 м.'
            : scenario?.cutoff
              ? 'Семь сценариев показывают, как сдвиг старых отметок ВТД меняет прогноз толщины.'
              : 'Загрузите result.csv для просмотра прогноза. Файл сценариев показывает чувствительность к сдвигу ВТД.'}</p></div>
        <p className="source" aria-live="polite">
          <span className="source-file" title={fileName ?? undefined}>{reading ? 'Чтение CSV…' : fileName ?? 'Синтетический пример'}</span>
          {bundle && <span>{bundle.label}</span>}
          {scenario?.cutoff && <span>{scenario.id} / {scenario.cutoff}</span>}
          <span>{format(points.length)} сегментов</span></p>
      </section>
      {error && <p role="alert" className="notice">{error}</p>}
      <section className="workspace">
        <article className="panel chart" ref={chart} tabIndex={-1}>
          <div className="bar"><h2>Остаточная толщина, мм</h2>{data.kind === 'forecast' && forecast
            ? <label>Труба <select aria-label="Труба" value={forecast.id} onChange={event => {
              const nextPipe = event.target.value
              const nextTrace = data.traces.find(trace => trace.id === nextPipe)
              if (nextTrace) setProfileView(current => current.data !== data ? current : {
                ...current,
                pipe: nextPipe,
                zoomStart: current.zoomStart === null || nextTrace.rows.length <= LOCAL_SEGMENTS ? null
                  : centeredStart(current.forecastSelections.get(nextPipe) ?? 0, nextTrace.rows.length),
              })
              setSegmentDraft(null)
            }}>{data.traces.map(trace => <option key={trace.id} value={trace.id}>{trace.id}</option>)}</select></label>
            : <label>Сдвиг <select aria-label="Сдвиг" value={shift}
              onChange={event => setShift(+event.target.value)}>{SHIFTS.map((value, i) =>
                <option key={value} value={i}>{formatShift(value)}</option>)}</select></label>}</div>
          {canZoom && <div className="profile-scale workspace-glass" role="group" aria-label="Масштаб профиля">
            <button type="button" aria-pressed={windowStart === null} onClick={() => setZoom(false)}>Вся труба</button>
            <button type="button" aria-pressed={windowStart !== null} onClick={() => setZoom(true)}>Рядом</button>
          </div>}
          <Plot points={points} focus={selected} threshold={scenario ? threshold : null} windowStart={windowStart} onSelect={selectSegment} />
          <div className="segment-control">
            <div className="segment">
              <label htmlFor="segment-number">Сегмент</label>
              <input id="segment-number" type="number" inputMode="numeric" min="0" max={points.length - 1} step="1"
                aria-label="Номер сегмента" aria-invalid={segmentInvalid || undefined}
                aria-describedby={segmentInvalid ? 'segment-limits' : undefined}
                value={segmentDraft ?? selected} onChange={event => setSegmentDraft(event.currentTarget.value)}
                onBlur={commitSegment} onKeyDown={event => {
                  if (event.key === 'Enter') commitSegment()
                  if (event.key === 'Escape') setSegmentDraft(null)
                }} />
              <input aria-label="Сегмент" type="range" min="0" max={points.length - 1}
                aria-describedby={priorityText ? 'segment-reading segment-priority' : 'segment-reading'}
                aria-valuetext={`Сегмент ${selected}, начало ${segmentStart} м, толщина ${segmentThickness} мм`}
                value={selected} onChange={event => selectSegment(+event.target.value)} />
            </div>
            {segmentInvalid && <p className="segment-error" id="segment-limits">Введите целый номер от 0 до {format(points.length - 1)}.</p>}
            <div className="segment-reading" id="segment-reading">
              <span>Начало {segmentStart} м</span>
              <strong>{segmentThickness} мм</strong>
              {scenarioRange && <span className="segment-range">{scenarioRange}</span>}
              {priorityCount !== undefined && <span className="segment-range">В нижних 10% по толщине: {priorityCount} из 7 сдвигов</span>}
            </div>
            {fileName && selectedScenario && <details className="scenario-comparison">
              <summary>Все 7 сдвигов</summary>
              <table aria-label="Толщина по сдвигам">
                <thead><tr><th scope="col">Сдвиг</th><th scope="col">Толщина, мм</th></tr></thead>
                <tbody>{SHIFTS.map((value, index) => <tr key={value} aria-current={index === shift || undefined}>
                  <th scope="row">{formatShift(value)}</th>
                  <td>{format(selectedScenario.thicknessMm[index]!)}</td>
                </tr>)}</tbody>
              </table>
            </details>}
            {priorityText && <div className="segment-priority-row">
              <p id="segment-priority" className={priorityRank ? 'segment-priority is-listed' : 'segment-priority'}>{priorityText}</p>
              <button type="button" className="priority-return" onClick={() => {
                const buttons = priorityList.current
                const target = buttons?.querySelector<HTMLButtonElement>('button[aria-current="true"]')
                  ?? buttons?.querySelector<HTMLButtonElement>('button')
                target?.focus()
              }}>К списку приоритетов</button>
            </div>}
            {bundle === bundles.reportGap && <p className="segment-priority" aria-live="polite">
              {comparisonRow && comparisonRank
                ? `Кандидатный прогноз · ${format(comparisonRow.thicknessMm)} мм · ${comparisonIndex
                  ? `В приоритете ${format(comparisonIndex)} из ${format(comparisonRank.count)}`
                  : 'Вне списка приоритетов'}`
                : candidateTraces === null ? 'Чтение кандидатного прогноза…' : 'Кандидатный прогноз недоступен'}
            </p>}
            {candidatePipe === ALIGNMENT_PIPE_ID && <div className="segment-links">
              <a className="segment-alignment" href={`./degradation.html?forecast=alignment&segment=${selected}`}>
                Проверить привязку ВТД <span aria-hidden="true">↗</span>
              </a>
              <a className="segment-alignment" href={`./degradation.html?forecast=report-gap&segment=${selected}`}>
                Экспериментальный прогноз <span aria-hidden="true">↗</span>
              </a>
            </div>}
          </div>
          <p className="chart-legend"><span className="legend-line" />{forecast ? 'Прогноз' : 'Выбранный сдвиг'}
            <span className={forecast ? 'legend-dot' : 'legend-band'} />{forecast ? 'Приоритетные 10%' : 'Размах 7 сценариев'}</p>
          {!forecast && <p className="caption scenario-range-note">Размах показывает влияние сдвига координат. Ошибка прогноза в него не входит.</p>}
        </article>
        <aside className="panel details">
          {forecast ? <>
            <h2>Сводка по трубе</h2>
            <dl><div><dt>Минимум</dt><dd>{format(priority[0]!.thicknessMm)} мм</dd></div>
              <div><dt>Среднее</dt><dd>{format(mean!)} мм</dd></div></dl>
          </> : <>
            <h2>Чувствительность к порогу</h2>
            <label className="threshold">Порог, мм<input type="number" min="0" max="1000" step="0.1" value={threshold} disabled={busy}
              onChange={event => { const number = event.target.valueAsNumber; if (Number.isFinite(number) && number >= 0 && number <= 1000) setThreshold(number) }} /></label>
            <dl><div><dt>Ниже во всех сценариях</dt><dd>{format(counts.filter(value => value === 7).length)}</dd></div>
              <div><dt>Меняется со сдвигом</dt><dd>{format(counts.filter(value => value > 0 && value < 7).length)}</dd></div>
              <div><dt>Выбранный сегмент ниже порога</dt><dd>{counts[selected] ?? 0} из {SHIFTS.length} сдвигов</dd></div></dl>
            <p className="caption">Порог условный.</p>
          </>}
        </aside>
      </section>
      {forecast ? <Priority list={priorityList} rows={priority} cutoffTie={cutoffTie} selected={selected} onSelect={index => { selectSegment(index); chart.current?.focus() }} /> :
        <details className="panel bench">
          <summary>Дополнительно</summary>
          <div className="bar"><div><h2>CPU и WebGPU</h2><p className="caption" aria-live="polite">{engine}</p></div>
            <button type="button" onClick={() => void measure()} disabled={busy || reading}>{busy ? 'Идёт замер…' : 'Сравнить время'}</button></div>
          {benchmark.length > 0 && <div className="table-wrap"><table><thead><tr>
            <th>Порогов</th><th>CPU, мс</th><th>WebGPU, мс</th><th>Проверка результата</th>
          </tr></thead><tbody>{benchmark.map(row => <tr key={row.size}><td>{row.size}</td><td>{format(row.cpu)}</td>
            <td>{format(row.gpu)}</td><td>{row.exact ? 'Число совпало' : 'Расхождение'} · Δ {row.error.toExponential(2)} мм</td>
          </tr>)}</tbody></table></div>}
          <p className="caption">Замер включает подготовку, вычисление и чтение результата. Первый запуск страницы может включать инициализацию GPU.</p>
        </details>}
    </main>
  </>
}

const target = document.getElementById('root')
if (!target) throw new Error('Missing degradation root')
createRoot(target).render(<App />)
