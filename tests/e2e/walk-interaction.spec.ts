import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Обход в 3D' }).click()
  await expect(page.getByRole('dialog', { name: 'Обход участка' }).getByRole('button', { name: 'Взаимодействовать' })).toBeEnabled()
})

test('switches camera views without losing position or inventory', async ({ page }) => {
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  const first = walk.getByRole('button', { name: 'От первого лица' })
  const third = walk.getByRole('button', { name: 'От третьего лица' })
  const canvas = walk.getByTestId('walk-canvas')
  await expect(third).toHaveAttribute('aria-pressed', 'true')
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  await expect(canvas).toHaveAttribute('data-view', 'third')
  await page.keyboard.press('e')
  const scanner = walk.getByRole('button', { name: 'Сканер' })
  await expect(scanner).toHaveAttribute('aria-pressed', 'true')
  const position = await walk.getByTestId('walk-position').textContent()
  if (position === null) throw new Error('Walk position is unavailable')
  await first.click()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(third).toHaveAttribute('aria-pressed', 'false')
  await expect(canvas).toHaveAttribute('data-view', 'first')
  await expect(scanner).toHaveAttribute('aria-pressed', 'true')
  await expect(walk.getByTestId('walk-position')).toHaveText(position)
  await page.keyboard.press('v')
  await expect(third).toHaveAttribute('aria-pressed', 'true')
  await expect(canvas).toHaveAttribute('data-view', 'third')
  await expect(scanner).toHaveAttribute('aria-pressed', 'true')
  await expect(walk.getByTestId('walk-position')).toHaveText(position)
})

test('clicking the scanner collects and equips it, while dragging does not', async ({ page }) => {
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  const canvas = walk.getByTestId('walk-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Walk canvas is not visible')
  const point = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.70 }
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 55, point.y, { steps: 5 })
  await page.mouse.up()
  await expect(walk.getByRole('button', { name: 'Сканер' })).toHaveCount(0)
  // Restore the initial view before clicking the same visible object.
  await page.mouse.move(point.x + 55, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x, point.y, { steps: 5 })
  await page.mouse.up()
  await page.mouse.down()
  await page.keyboard.press('v')
  await expect(canvas).toHaveAttribute('data-view', 'first')
  await page.keyboard.press('v')
  await expect(canvas).toHaveAttribute('data-view', 'third')
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.mouse.up()
  await expect(walk.getByRole('button', { name: 'Сканер' })).toHaveCount(0)
  await page.mouse.click(point.x, point.y)
  await expect(walk.getByRole('button', { name: 'Сканер' })).toHaveAttribute('aria-pressed', 'true')
  await expect(walk.getByRole('status')).toContainText('Сканер')
})

test('an out-of-reach sensor click does not act on the nearby scanner', async ({ page }) => {
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  const action = walk.getByRole('button', { name: 'Взаимодействовать' })
  await expect(action).toContainText('Сканер')
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  // The P1 console at the default spawn camera and 1440×900 viewport.
  await page.mouse.click(792, 425)
  await expect(walk.getByRole('status')).toHaveText('Подойдите ближе к объекту.')
  await expect(walk.getByRole('button', { name: 'Сканер', exact: true })).toHaveCount(0)
  await expect(walk.getByText('0 / 3 датчика')).toBeVisible()
})

test.describe('touch interaction', () => {
  test.use({ hasTouch: true })

  test('the first-person control is tappable on a short phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 440 })
    const walk = page.getByRole('dialog', { name: 'Обход участка' })
    const first = walk.getByRole('button', { name: 'От первого лица' })
    await first.tap()
    await expect(first).toHaveAttribute('aria-pressed', 'true')
  })

  test('tapping empty ground does nothing and tapping the scanner equips it', async ({ page }) => {
    const walk = page.getByRole('dialog', { name: 'Обход участка' })
    const box = await walk.getByTestId('walk-canvas').boundingBox()
    if (!box) throw new Error('Walk canvas is not visible')
    await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5)
    await expect(walk.getByRole('button', { name: 'Сканер' })).toHaveCount(0)
    await page.touchscreen.tap(box.x + box.width * 0.62, box.y + box.height * 0.70)
    await expect(walk.getByRole('button', { name: 'Сканер' })).toHaveAttribute('aria-pressed', 'true')
    await expect(walk.getByRole('status')).toContainText('Сканер')
  })
})

test('clicks the repair point in third and first person while offline', async ({ page, context }) => {
  test.setTimeout(60_000)
  const { PerspectiveCamera, Vector3 } = await import('three')
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  const action = walk.getByRole('button', { name: 'Взаимодействовать' })
  const position = walk.getByTestId('walk-position')
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await context.setOffline(true)
  await page.keyboard.press('e')
  await expect(walk.getByRole('button', { name: 'Сканер' })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.down('Shift')
  await page.keyboard.down('w')
  try {
    await expect(action).toContainText('Ремонтная муфта', { timeout: 20_000 })
  } finally {
    await page.keyboard.up('w')
    await page.keyboard.up('Shift')
  }
  await settle()
  await action.click()
  await expect(walk.getByRole('button', { name: 'Ремонтная муфта' })).toBeVisible()
  await page.keyboard.down('a')
  try {
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="walk-position"] .sr-only')?.textContent?.match(/(-?\d+\.\d+)/)?.[1]) <= 1, null, { timeout: 10_000 })
  } finally {
    await page.keyboard.up('a')
  }
  await settle()
  await page.keyboard.down('w')
  try {
    await page.waitForFunction(() => Number.parseInt(document.querySelector('[data-testid="walk-position"] b')?.textContent ?? '', 10) >= 52, null, { timeout: 10_000 })
  } finally {
    await page.keyboard.up('w')
  }
  await settle()
  const [x, z] = await position.evaluate(element => [
    Number(element.getAttribute('data-world-x') ?? NaN),
    Number(element.getAttribute('data-world-z') ?? NaN),
  ])
  expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true)
  const camera = new PerspectiveCamera(55, 1440 / 900, .08, 205)
  camera.position.set(x - 5.6, 3.75, z + 2.3)
  camera.lookAt(x + 4.6, 1.45, z - 1.65)
  camera.updateMatrixWorld()
  const point = new Vector3(43, 1.35, -2.15).project(camera)
  await page.mouse.click((point.x + 1) * 720, (1 - point.y) * 450)
  await expect(walk.getByRole('status')).toContainText('Сканер подтвердил учебную утечку')
  await walk.getByRole('button', { name: 'Ремонтная муфта' }).click()
  await walk.getByRole('button', { name: 'От первого лица' }).click()
  await settle()
  const dx = -Math.atan2(-2.15 - z, 43 - x) / .008
  const dy = (1.69 - 1.35) / Math.hypot(43 - x, -2.15 - z) / .7 / .014
  await page.mouse.move(650, 400)
  await page.mouse.down()
  await page.mouse.move(650 + dx, 400 + dy)
  await page.mouse.up()
  await settle()
  await page.mouse.click(720, 450)
  await expect(walk.getByText('Утечка устранена', { exact: true })).toBeVisible()
  await expect(walk.getByRole('button', { name: 'Ремонтная муфта' })).toHaveCount(0)
})
