import { afterEach, expect, test, vi } from 'vitest'
import { drawChart } from '../../src/ui/charts/draw'

afterEach(() => vi.unstubAllGlobals())

function chartCanvas() {
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  const context = {
    scale: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillText: vi.fn(), save: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(),
  }
  const canvas = {
    getBoundingClientRect: () => ({ width: 260, height: 205 }),
    getContext: () => context,
  } as unknown as HTMLCanvasElement
  return { canvas, context }
}

test.each([-15.786, 0, 15.786])('shows a zero reference for sustained residual %s kPa', (value) => {
  const { canvas, context } = chartCanvas()
  drawChart(canvas, {
    series: [{ label: 'P1', color: '#346785', points: [{ timeS: 1, value }, { timeS: 2, value }] }],
    unit: 'кПа', endS: 2, defaultRange: [-5, 5], minSpan: 4, referenceZero: true,
  })
  const zeroLabels = context.fillText.mock.calls.filter(([label, x]) => label === '0' && x === 44)
  expect(zeroLabels).toHaveLength(1)
  const zeroY = Number(zeroLabels[0]?.[2]) - 4
  expect(zeroY).toBeGreaterThan(24)
  expect(zeroY).toBeLessThan(205 - 31)
  expect(context.moveTo).toHaveBeenCalledWith(52, zeroY)
  expect(context.lineTo).toHaveBeenCalledWith(243, zeroY)
  const labels = context.fillText.mock.calls.filter(([, x]) => x === 44).map(([label]) => label)
  expect(labels.every(label => !/,\d{2}/.test(label))).toBe(true)
})

test('keeps the native pressure scale without a zero reference', () => {
  const { canvas, context } = chartCanvas()
  drawChart(canvas, {
    series: [{ label: 'P1', color: '#346785', points: [{ timeS: 1, value: 12.013 }] }],
    unit: 'бар абс.', endS: 2, defaultRange: [11, 12.5], minSpan: 0.4,
  })
  const labels = context.fillText.mock.calls.filter(([, x]) => x === 44).map(([label]) => label)
  expect(labels).toEqual(['с', '11,813', '11,913', '12,013', '12,113', '12,213'])
  expect(context.setLineDash).not.toHaveBeenCalledWith([4, 3])
})
