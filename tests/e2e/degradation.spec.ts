import { expect, test } from '@playwright/test'

const header = 'id,segment_id,cutoff,shift_m20_mm,shift_m10_mm,shift_m5_mm,shift_zero_mm,shift_p5_mm,shift_p10_mm,shift_p20_mm'
const valid = [
  header,
  '42,1,2023-12-01,4,5,6,7,8,9,10',
  '42,0,2023-12-01,2,3,4,5,6,7,8',
].join('\n')

test('opens a local profile, selects a scenario and falls back without WebGPU', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }))
  await page.goto('/degradation.html')
  await expect(page.getByRole('heading', { name: 'Профиль толщины' })).toBeVisible()
  await expect(page.getByText('Синтетический пример')).toBeVisible()
  const file = page.locator('input[type=file]')
  await file.setInputFiles({ name: 'scenarios.csv', mimeType: 'text/csv', buffer: Buffer.from(valid) })
  await expect(page.getByText('42 / 2023-12-01')).toBeVisible()
  await expect(page.getByText('4 из 7 сдвигов', { exact: true })).toBeVisible()
  const range = page.getByText('По 7 сдвигам: 2–8 мм', { exact: true })
  await expect(range).toBeVisible()
  await page.getByLabel('Сдвиг', { exact: true }).selectOption('6')
  await expect(range).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveAttribute('aria-valuetext', 'Сегмент 0, начало 0 м, толщина 8 мм')
  await expect(page.getByRole('button', { name: 'Сравнить время' })).toBeHidden()
  await page.getByText('Дополнительно', { exact: true }).click()
  await page.getByRole('button', { name: 'Сравнить время' }).click()
  await expect(page.getByText('CPU · GPU-замер не завершён')).toBeVisible()
  await expect(page.getByText('8 мм', { exact: true })).toBeInViewport()
  await page.getByRole('slider', { name: 'Сегмент' }).press('ArrowRight')
  await expect(page.getByText('По 7 сдвигам: 4–10 мм', { exact: true })).toBeInViewport()

  await file.setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from(valid.replace('42,0,', '42,1,')) })
  await expect(page.getByRole('alert')).toContainText('без пропусков и дублей')
  await expect(page.getByText('42 / 2023-12-01')).toBeVisible()
})

const forecast = [
  'id,segment_id,thickness_pred',
  '10,1,6.5',
  '20,1,2.35',
  '10,0,3.45',
  '20,0,3.11',
].join('\n')

test('keeps the chart and selection visible in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' })
  await page.goto('/degradation.html')
  await expect(page.locator('.plot canvas')).toHaveCSS('background-color', 'rgb(249, 250, 252)')
  await expect(page.locator('.plot-marker span')).toHaveCSS('background-color', 'rgb(38, 63, 85)')
  await expect(page.locator('.legend-band')).toHaveCSS('forced-color-adjust', 'none')
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveCSS('forced-color-adjust', 'auto')
})

test('fits upload, segment slider and thickness at the minimum width', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 800 })
  await page.goto('/degradation.html')
  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'result.csv', mimeType: 'text/csv',
    buffer: Buffer.from('id,segment_id,thickness_pred\n200001,0,4.5\n200001,1,5'),
  })
  await expect(page.getByText('result.csv', { exact: true })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toBeInViewport({ ratio: 1, timeout: 1_000 })
  const fits = await page.evaluate(() => {
    const upload = document.querySelector('.upload')!
    const text = document.createRange()
    text.selectNode(upload.firstChild!)
    const label = text.getBoundingClientRect()
    const thickness = document.querySelector('.segment-reading strong')!.getBoundingClientRect()
    const panel = document.querySelector('.workspace')!.getBoundingClientRect()
    return label.right <= upload.getBoundingClientRect().right && thickness.right <= panel.right
      && document.documentElement.scrollWidth === 300
  })
  expect(fits).toBe(true)
})

test('explains equal forecast values at the priority cutoff', async ({ page }) => {
  await page.goto('/degradation.html')
  const file = page.getByLabel('Загрузить CSV')
  await file.setInputFiles({
    name: 'result.csv', mimeType: 'text/csv',
    buffer: Buffer.from('id,segment_id,thickness_pred\n10,2,4.5\n10,0,4.5\n10,1,5\n20,0,4.5002\n20,1,4.5001'),
  })
  const priority = page.getByRole('region', { name: 'Приоритет проверки' })
  await expect(priority.getByText(/В списке 1 из 2/)).toBeVisible({ timeout: 1_000 })
  await expect(priority.getByRole('button')).toHaveCount(1)
  await expect(priority.getByRole('button', { name: 'Сегмент 0 · 0 м · 4,5 мм' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Труба' }).selectOption('20')
  await expect(priority.getByText(/На границе отбора одинаковая толщина/)).toHaveCount(0)
  await expect(priority.getByRole('button', { name: 'Сегмент 1 · 10 м · 4,5 мм' })).toBeVisible()
})

test('moves keyboard focus through the scrollable priority list', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/degradation.html')
  const rows = Array.from({ length: 150 }, (_, index) => `10,${index},${4 + index / 100}`)
  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'priority.csv', mimeType: 'text/csv',
    buffer: Buffer.from(['id,segment_id,thickness_pred', ...rows].join('\n')),
  })
  const buttons = page.getByRole('region', { name: 'Приоритет проверки' }).getByRole('button')
  await expect(buttons).toHaveCount(15)
  await buttons.first().press('End')
  await expect(buttons.last()).toBeFocused({ timeout: 1_000 })
  await expect(buttons.last()).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('ArrowUp')
  await expect(buttons.nth(13)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(buttons.last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(buttons.first()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(buttons.nth(1)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveValue('1')
  await expect(page.getByText('Начало 10 м', { exact: true })).toBeInViewport()
})

test('moves the selection marker without redrawing the thickness profile', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 800 })
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      this.canvas.dataset.axisDraws = String(Number(this.canvas.dataset.axisDraws ?? 0) + 1)
      this.canvas.dataset.lastAxisLabel = args[0]
      if (args[0] === '0 м') this.canvas.dataset.originRight = String(args[1] + this.measureText(args[0]).width)
      if (args[0].startsWith('Последний')) this.canvas.dataset.endLeft = String(args[1] - this.measureText(args[0]).width)
      Reflect.apply(fillText, this, args)
    }
  })
  await page.goto('/degradation.html')
  const plot = page.getByRole('img', { name: 'График толщины и диапазона сценариев' })
  await expect(plot).toHaveAttribute('data-axis-draws', /[1-9]/)
  await expect(plot).toHaveAttribute('data-last-axis-label', /^Последний с 1\s590 м$/)
  await expect(plot).toHaveAccessibleDescription(/Последний сегмент начинается на отметке 1\s590 м/)
  const labelsGap = await plot.evaluate(element => Number(element.dataset.endLeft) - Number(element.dataset.originRight))
  expect(labelsGap).toBeGreaterThan(8)
  await page.evaluate(() => new Promise(requestAnimationFrame))
  const before = await plot.getAttribute('data-axis-draws')
  const marker = page.locator('.plot-marker')
  const position = await marker.getAttribute('style')
  const slider = page.getByRole('slider', { name: 'Сегмент' })
  await slider.press('ArrowRight')
  await expect(slider).toHaveValue('1')
  await expect(marker).not.toHaveAttribute('style', position ?? '')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(plot).toHaveAttribute('data-axis-draws', before ?? '')
})

test('reads the forecast format and inspects each pipe independently at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/degradation.html')
  await page.locator('input[type=file]').setInputFiles({
    name: 'расчёт-по-истории.csv', mimeType: 'text/csv', buffer: Buffer.from(forecast),
  })
  const pipe = page.getByRole('combobox', { name: 'Труба' })
  await expect(pipe).toHaveValue('10')
  await expect(page.getByText(/По 7 сдвигам/)).toHaveCount(0)
  await expect(page.getByText('расчёт-по-истории.csv', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Профиль толщины' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Приоритет проверки' })).toBeVisible()
  await expect(page.getByText(/На границе отбора одинаковая толщина/)).toHaveCount(0)
  await expect(page.locator('.segment-reading').getByText('3,45 мм', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'CPU и WebGPU' })).toHaveCount(0)

  await pipe.selectOption('20')
  await expect(page.getByRole('button', { name: 'Сегмент 1 · 10 м · 2,35 мм' })).toBeVisible()
  await page.getByRole('button', { name: 'Сегмент 1 · 10 м · 2,35 мм' }).click()
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveValue('1')
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveAttribute('aria-valuetext', 'Сегмент 1, начало 10 м, толщина 2,35 мм')
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveAccessibleDescription('Начало 10 м 2,35 мм В приоритете · 1 из 1')
  await expect(page.getByText('Начало 10 м', { exact: true })).toBeInViewport()
  await expect(page.locator('.segment-reading').getByText('2,35 мм', { exact: true })).toBeInViewport()
  const segmentNumber = page.getByRole('spinbutton', { name: 'Номер сегмента' })
  const slider = page.getByRole('slider', { name: 'Сегмент' })
  await expect(segmentNumber).toHaveValue('1')
  await segmentNumber.fill('0')
  await segmentNumber.press('Enter')
  await expect(slider).toHaveValue('0')
  await expect(page.locator('.segment-reading').getByText('3,11 мм', { exact: true })).toBeVisible()
  await segmentNumber.fill('25')
  await segmentNumber.press('Enter')
  await expect(segmentNumber).toHaveAttribute('aria-invalid', 'true')
  await expect(slider).toHaveValue('0')
  await segmentNumber.press('Escape')
  await expect(segmentNumber).toHaveValue('0')
  await slider.press('ArrowRight')
  await expect(segmentNumber).toHaveValue('1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)

  await page.locator('input[type=file]').setInputFiles({
    name: 'result.csv', mimeType: 'text/csv', buffer: Buffer.from(forecast.replace('20,1,', '20,2,')),
  })
  await expect(page.getByRole('alert')).toContainText('без пропусков и дублей')
  await expect(page.getByText('расчёт-по-истории.csv', { exact: true })).toBeVisible()
  await expect(pipe).toHaveValue('20')
})

test('keeps the selected location when a replacement CSV covers it', async ({ page }) => {
  await page.goto('/degradation.html')
  const upload = page.getByLabel('Загрузить CSV')
  const choose = (name: string, text: string) =>
    upload.setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })
  await choose('базовый.csv', forecast)
  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const slider = page.getByRole('slider', { name: 'Сегмент' })
  await expect(pipe).toHaveValue('10')
  await slider.press('End')
  await pipe.selectOption('20')
  await expect(slider).toHaveValue('0')
  await slider.press('End')
  await pipe.selectOption('10')
  await expect(slider).toHaveValue('1', { timeout: 1_000 })
  await expect(page.locator('#segment-reading')).toContainText('6,5 мм')
  await pipe.selectOption('20')
  await expect(slider).toHaveValue('1')

  await choose('новый.csv', forecast.replace('2.35', '2.75'))
  await expect(page.getByText('новый.csv', { exact: true })).toBeVisible()
  await expect(pipe).toHaveValue('20')
  await expect(slider).toHaveValue('1')
  await expect(page.locator('#segment-reading')).toContainText('2,75 мм')

  await choose('короткий.csv', forecast.replace('20,1,2.35\n', ''))
  await expect(page.getByText('короткий.csv', { exact: true })).toBeVisible()
  await expect(pipe).toHaveValue('20')
  await expect(slider).toHaveValue('0')
  await pipe.selectOption('10')
  await expect(slider).toHaveValue('1')
  await pipe.selectOption('20')
  await expect(slider).toHaveValue('0')

  await choose('другая-труба.csv', 'id,segment_id,thickness_pred\n30,0,7')
  await expect(pipe).toHaveValue('30')
  await expect(slider).toHaveValue('0')
})

test('ignores a plot click from a CSV that is being replaced', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.addInitScript(() => {
    const text = File.prototype.text
    File.prototype.text = function () {
      if (this.name !== 'short.csv') return text.call(this)
      return new Promise(resolve => {
        window.addEventListener('replace-forecast', () => {
          resolve('id,segment_id,thickness_pred\n10,0,3.45')
          queueMicrotask(() => {
            const plot = document.querySelector('.plot canvas')!
            const bounds = plot.getBoundingClientRect()
            plot.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, clientX: bounds.right - 30, clientY: bounds.top + 30,
            }))
          })
        }, { once: true })
      })
    }
  })
  await page.goto('/degradation.html')
  const file = page.getByLabel('Загрузить CSV')
  await file.setInputFiles({ name: 'result.csv', mimeType: 'text/csv', buffer: Buffer.from(forecast) })
  const slider = page.getByRole('slider', { name: 'Сегмент' })
  await slider.press('End')
  await file.setInputFiles({ name: 'short.csv', mimeType: 'text/csv', buffer: Buffer.from('pending') })
  await expect(page.getByText('Чтение CSV…')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('replace-forecast')))
  await expect(page.getByText('short.csv', { exact: true })).toBeVisible({ timeout: 1_000 })
  await expect(slider).toHaveAttribute('max', '0')
  await expect(slider).toHaveValue('0')
  expect(pageErrors).toEqual([])
})
