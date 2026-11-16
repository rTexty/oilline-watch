import { expect, test, type Page } from '@playwright/test'

const csvHeader = 'id,segment_id,thickness_pred'
const pipeRows = (id: string, numSegments: number) => Array.from({ length: numSegments },
  (_, segment) => `${id},${segment},${(5 + segment / 10).toFixed(1)}`)

async function openForecast(page: Page, numSegments = 51, otherRows: string[] = []) {
  await page.goto('/degradation.html')
  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'zoom.csv', mimeType: 'text/csv',
    buffer: Buffer.from([csvHeader, ...pipeRows('200001', numSegments), ...otherRows].join('\n')),
  })
  await expect(page.getByText('zoom.csv', { exact: true })).toBeVisible()
  return {
    chart: page.getByRole('img', { name: 'График прогноза толщины по сегментам' }),
    scale: page.getByRole('group', { name: 'Масштаб профиля' }),
    slider: page.getByRole('slider', { name: 'Сегмент' }),
    number: page.getByRole('spinbutton', { name: 'Номер сегмента' }),
  }
}

test('zooms around the selected cell and keeps absolute segment numbers', async ({ page }) => {
  const { chart, scale, slider, number } = await openForecast(page)
  const full = scale.getByRole('button', { name: 'Вся труба', exact: true })
  const near = scale.getByRole('button', { name: 'Рядом', exact: true })
  await expect(full).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 })
  await expect(chart).toHaveAccessibleDescription('Последний сегмент начинается на отметке 500 м.')

  await number.fill('25')
  await number.press('Enter')
  await near.click()
  await expect(near).toHaveAttribute('aria-pressed', 'true')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 15–35.')

  const [bounds, plot] = await Promise.all([chart.boundingBox(), page.locator('.plot-overlay').boundingBox()])
  if (!bounds || !plot) throw new Error('Profile chart is outside the rendered area')
  const cell = { x: plot.x - bounds.x + plot.width * 15.5 / 21, y: plot.y - bounds.y + plot.height / 2 }
  await chart.click({ position: cell })
  await expect(slider).toHaveValue('30')
  await expect(slider).toHaveAccessibleDescription('Начало 300 м 8 мм Вне списка приоритетов')
  await expect(near).toHaveAttribute('aria-pressed', 'true')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 15–35.')
  await chart.click({ position: cell })
  await expect(slider).toHaveValue('30')

  await slider.press('ArrowRight')
  await expect(slider).toHaveValue('31')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 15–35.')

  await number.fill('36')
  await number.press('Enter')
  await expect(slider).toHaveValue('36')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 26–46.')

  await full.click()
  await expect(full).toHaveAttribute('aria-pressed', 'true')
  await expect(slider).toHaveValue('36')
  await expect(chart).toHaveAccessibleDescription('Последний сегмент начинается на отметке 500 м.')
})

test('skips zoom controls when the full forecast already fits in one window', async ({ page }) => {
  const { chart, scale } = await openForecast(page, 21)
  await expect(chart).toHaveAccessibleDescription('Последний сегмент начинается на отметке 200 м.')
  await expect(scale).toHaveCount(0)
})

test('updates zoom when selecting a priority or switching between pipes', async ({ page }) => {
  const { chart, scale, slider } = await openForecast(page, 51, [...pipeRows('20', 65), ...pipeRows('30', 7)])
  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const near = scale.getByRole('button', { name: 'Рядом', exact: true })
  const priority = page.getByRole('region', { name: 'Приоритет проверки' })

  await slider.press('End')
  await near.click()
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 30–50.')
  await priority.getByRole('button', { name: 'Сегмент 0 · 0 м · 5 мм', exact: true }).click()
  await expect(slider).toHaveValue('0')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 0–20.')
  await slider.press('End')

  await pipe.selectOption('20')
  await expect(near).toHaveAttribute('aria-pressed', 'true')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 0–20.')
  await slider.press('End')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 44–64.')
  await pipe.selectOption('200001')
  await expect(slider).toHaveValue('50')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 30–50.')
  await pipe.selectOption('20')
  await expect(slider).toHaveValue('64')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 44–64.')

  await pipe.selectOption('30')
  await expect(scale).toHaveCount(0)
  await expect(slider).toHaveValue('0')
  await expect(chart).toHaveAccessibleDescription('Последний сегмент начинается на отметке 60 м.')
  await pipe.selectOption('20')
  await expect(scale.getByRole('button', { name: 'Вся труба', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(slider).toHaveValue('64')
})

test('does not use stale zoomed pointer coordinates after replacing the CSV', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const replacement = [csvHeader, ...pipeRows('200001', 23)].join('\n')
  await page.addInitScript(replacement => {
    const originalRead = File.prototype.text
    File.prototype.text = function () {
      if (this.name !== 'replace-zoom.csv') return originalRead.call(this)
      return new Promise(resolve => window.addEventListener('replace-zoom', () => {
        resolve(replacement)
        queueMicrotask(() => {
          const plot = document.querySelector('.plot canvas')!
          const bounds = plot.getBoundingClientRect()
          plot.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, clientX: bounds.right - 30, clientY: bounds.top + 30,
          }))
        })
      }, { once: true }))
    }
  }, replacement)
  const { chart, scale, slider, number } = await openForecast(page)
  await number.fill('30')
  await number.press('Enter')
  await scale.getByRole('button', { name: 'Рядом', exact: true }).click()
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 20–40.')

  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'replace-zoom.csv', mimeType: 'text/csv', buffer: Buffer.from('pending'),
  })
  await expect(page.getByText('Чтение CSV…')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('replace-zoom')))
  await expect(page.getByText('replace-zoom.csv', { exact: true })).toBeVisible()
  await expect(slider).toHaveAttribute('max', '22')
  await expect(slider).toHaveValue('0')
  await expect(scale.getByRole('button', { name: 'Вся труба', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(chart).toHaveAccessibleDescription('Последний сегмент начинается на отметке 220 м.')
  expect(errors).toEqual([])
})

test('clamps the zoom window at both ends and fits a 320px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 812 })
  const { chart, scale, slider } = await openForecast(page)
  await expect(scale).toBeVisible({ timeout: 2_000 })
  await scale.getByRole('button', { name: 'Рядом', exact: true }).click()
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 0–20.')
  await slider.press('End')
  await expect(slider).toHaveValue('50')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 30–50.')

  const visibleControls = await scale.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const panel = element.closest('.workspace')?.getBoundingClientRect()
    return panel !== undefined && bounds.left >= panel.left && bounds.right <= panel.right
      && Array.from(element.querySelectorAll('button')).every(button => {
        const rectangle = button.getBoundingClientRect()
        return rectangle.left >= bounds.left && rectangle.right <= bounds.right
      })
  })
  expect(visibleControls).toBe(true)
  await chart.scrollIntoViewIfNeeded()
  await expect(chart).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
})
