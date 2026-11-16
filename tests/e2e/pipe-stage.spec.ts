import { expect, test } from '@playwright/test'

test('camera presets select a view and reset to the default', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const pipe = page.getByRole('region', { name: 'Модель участка' })
  const canvas = pipe.getByTestId('pipe-3d-canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeLessThan(800)
  expect(box!.y + box!.height).toBeGreaterThan(0)
  await expect(pipe.getByRole('button', { name: 'Начать показ' })).toBeInViewport({ ratio: 1 })

  const presets = pipe.getByRole('group', { name: 'Ракурс 3D-модели' })
  const overview = presets.getByRole('button', { name: 'Общий', exact: true })
  const top = presets.getByRole('button', { name: 'Сверху', exact: true })
  const section = presets.getByRole('button', { name: 'Вдоль', exact: true })
  await expect(overview).toHaveAttribute('aria-pressed', 'true')
  await expect(top).toHaveAttribute('aria-pressed', 'false')
  await expect(section).toHaveAttribute('aria-pressed', 'false')
  const annotations = pipe.getByTestId('pipe-scene-annotations')
  await expect(annotations).toHaveAttribute('aria-hidden', 'true')
  const sensors = ['P1', 'P2', 'P3'].map(name => annotations.getByText(name, { exact: true }))
  for (const sensor of sensors) await expect(sensor).toBeVisible()
  const before = await Promise.all(sensors.map(sensor => sensor.boundingBox()))
  await top.click()
  await expect(top).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => {
    const after = await Promise.all(sensors.map(sensor => sensor.boundingBox()))
    return after.some((box, index) => box && before[index] &&
      (Math.abs(box.x - before[index]!.x) > 2 || Math.abs(box.y - before[index]!.y) > 2))
  }).toBe(true)
  await expect(overview).toHaveAttribute('aria-pressed', 'false')
  await section.click()
  await expect(section).toHaveAttribute('aria-pressed', 'true')
  await expect(top).toHaveAttribute('aria-pressed', 'false')
  await pipe.getByRole('button', { name: 'Восстановить вид' }).click()
  await expect(overview).toHaveAttribute('aria-pressed', 'true')
  await expect(section).toHaveAttribute('aria-pressed', 'false')
})

test('keeps the start action in the initial mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const start = page.getByRole('region', { name: 'Модель участка' })
    .getByRole('button', { name: 'Начать показ' })
  await expect(start).toBeVisible()
  await expect(start).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('exposes the 2D fallback without camera presets when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value(...args: Parameters<typeof getContext>) {
        return String(args[0]).includes('webgl') ? null : Reflect.apply(getContext, this, args)
      },
    })
  })
  await page.goto('/')
  const pipe = page.getByRole('region', { name: 'Модель участка' })
  await expect(pipe.getByTestId('pipe-2d-fallback')).toBeVisible()
  await expect(pipe.getByRole('slider', { name: 'Координата на схеме' })).toBeVisible()
  await expect(pipe.getByRole('group', { name: 'Ракурс 3D-модели' })).toHaveCount(0)
})

test('preserves the selection and returns focus when WebGL context is lost', async ({ page }) => {
  await page.goto('/')
  const pipe = page.getByRole('region', { name: 'Модель участка' })
  const canvas = pipe.getByTestId('pipe-3d-canvas')
  const coordinate = pipe.getByRole('slider', { name: 'Координата на 3D-модели' })
  await coordinate.press('ArrowRight')
  const selected = await coordinate.inputValue()
  await pipe.getByRole('button', { name: 'Сверху' }).focus()
  await pipe.getByRole('button', { name: 'Сверху' }).press('Enter')
  await canvas.evaluate((element: HTMLCanvasElement) => {
    const extension = element.getContext('webgl')?.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('Cannot simulate WebGL context loss')
    extension.loseContext()
  })
  await expect(pipe.getByTestId('pipe-2d-fallback')).toBeVisible()
  await expect(pipe.getByRole('heading', { name: 'Модель участка' })).toBeFocused()
  await expect(pipe.getByRole('slider', { name: 'Координата на схеме' })).toHaveValue(selected)
  await expect(pipe.getByRole('group', { name: 'Ракурс 3D-модели' })).toHaveCount(0)
})

test('applies camera presets without scheduling animation in reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const pipe = page.getByRole('region', { name: 'Модель участка' })
  const sensor = pipe.getByTestId('pipe-scene-annotations').getByText('P2', { exact: true })
  await expect(sensor).toBeVisible()
  const result = await page.evaluate(() => {
    const originalRequest = window.requestAnimationFrame
    let requests = 0
    window.requestAnimationFrame = (callback) => {
      requests++
      return originalRequest(callback)
    }
    const top = [...document.querySelectorAll('button')].find(button => button.textContent === 'Сверху')
    if (!top) throw new Error('Missing top camera preset')
    try {
      top.click()
      return requests
    } finally {
      window.requestAnimationFrame = originalRequest
    }
  })
  expect(result).toBe(0)
  await expect(pipe.getByRole('button', { name: 'Сверху', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
