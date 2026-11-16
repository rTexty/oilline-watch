import { expect, test, type Page } from '@playwright/test'

async function approach(page: Page, label: string, key = 'w') {
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  await page.keyboard.down('Shift')
  await page.keyboard.down(key)
  try {
    await page.waitForFunction((target) => document.querySelector('.walk-action button')?.textContent?.includes(target), label, { timeout: 18_000 })
  } finally {
    await page.keyboard.up(key)
    await page.keyboard.up('Shift')
  }
  await expect(walk.getByRole('button', { name: 'Взаимодействовать' })).toContainText(label)
}

async function moveAcross(page: Page, key: 'a' | 'd', limit: number) {
  await page.keyboard.down(key)
  try {
    await page.waitForFunction(({ key, limit }) => {
      const position = document.querySelector('[data-testid="walk-position"]')?.textContent
      const z = Number(position?.match(/площадки (-?\d+\.\d+)/)?.[1])
      return key === 'a' ? z <= limit : z >= limit
    }, { key, limit }, { timeout: 10_000 })
  } finally {
    await page.keyboard.up(key)
  }
}

async function passConsole(page: Page, metres: number) {
  await page.keyboard.down('w')
  try {
    await page.waitForFunction(limit => {
      const label = document.querySelector('[data-testid="walk-position"] b')?.textContent
      return Number.parseInt(label ?? '', 10) >= limit
    }, metres, { timeout: 10_000 })
  } finally {
    await page.keyboard.up('w')
  }
}

test('completes the exercise using the tools, three stations and the pipe while offline', async ({ page, context }) => {
  test.setTimeout(75_000)
  await page.setViewportSize({ width: 900, height: 650 })
  const requests: URL[] = []
  page.on('request', request => requests.push(new URL(request.url())))
  await page.goto('/')
  expect(requests.some(url => /\/runtime-[\w-]+\.js$/.test(url.pathname))).toBe(false)
  await page.getByRole('button', { name: 'Обход в 3D' }).click()
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  const action = walk.getByRole('button', { name: 'Взаимодействовать' })
  await expect(action).toBeEnabled()
  expect(requests.some(url => /\/runtime-[\w-]+\.js$/.test(url.pathname))).toBe(true)
  await context.setOffline(true)
  await page.keyboard.press('e')
  await approach(page, 'Датчик P1')
  await action.click()
  await expect(walk.getByText('1 / 3 датчика')).toBeVisible()
  await passConsole(page, 21)
  await moveAcross(page, 'a', -.15)
  await approach(page, 'Задвижка')
  await action.click()
  await expect(walk.getByText('Учебная задвижка закрыта.')).toBeVisible()
  await action.click()
  await expect(walk.getByText('Учебная задвижка открыта.')).toBeVisible()
  await approach(page, 'Датчик P2')
  await action.click()
  await passConsole(page, 41)
  await moveAcross(page, 'd', 2.6)
  await approach(page, 'Ремонтная муфта')
  await action.click()
  await expect(walk.getByRole('region', { name: 'Инвентарь' })).toContainText('Ремонтная муфта')
  await moveAcross(page, 'a', 1.15)
  await approach(page, 'Учебная утечка')
  await action.click()
  await expect(walk.getByTestId('walk-objective')).toHaveText('Установите муфту')
  await page.keyboard.press('2')
  await action.click()
  await expect(walk.getByText('Утечка устранена', { exact: true })).toBeVisible()
  await approach(page, 'Датчик P3')
  await action.click()
  await expect(walk.getByTestId('walk-objective')).toHaveText('Обход завершён')
  expect(requests.filter(url => url.origin !== new URL(page.url()).origin)).toEqual([])
})

test('opens the walk, collects the scanner and moves without changing the main model', async ({ page }) => {
  await page.goto('/')
  const pipe = page.getByRole('region', { name: 'Модель участка' })
  const coordinate = pipe.getByRole('slider', { name: 'Координата на 3D-модели' })
  await coordinate.press('ArrowRight')
  const selected = await coordinate.inputValue()
  const top = pipe.getByRole('button', { name: 'Сверху', exact: true })
  await top.click()
  const opener = page.getByRole('button', { name: 'Обход в 3D' })
  await opener.click()

  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  await expect(walk.getByTestId('walk-canvas')).toBeVisible()
  await expect(walk.getByRole('button', { name: 'Полный экран' })).toBeVisible()
  const inventory = walk.getByRole('region', { name: 'Инвентарь' })
  await walk.getByRole('button', { name: 'Взаимодействовать' }).click()
  await expect(inventory).toContainText('Сканер')
  const position = walk.getByTestId('walk-position')
  await expect(position).toContainText(/\d/)
  const initial = await position.innerText()
  await page.keyboard.down('w')
  await expect.poll(() => position.innerText()).not.toBe(initial)
  await page.keyboard.up('w')
  await page.keyboard.press('e')
  await expect(inventory).toContainText('Сканер')

  await walk.getByRole('button', { name: 'Закрыть обход' }).click()
  await expect(walk).toBeHidden()
  await expect(opener).toBeFocused()
  await expect(coordinate).toHaveValue(selected)
  await expect(top).toHaveAttribute('aria-pressed', 'true')
  await opener.click()
  await expect(walk).toBeVisible()
  await walk.getByRole('button', { name: 'Закрыть обход' }).click()
  await expect(opener).toBeFocused()
  await expect(coordinate).toHaveValue(selected)
  await expect(top).toHaveAttribute('aria-pressed', 'true')
})

test('keeps an active main simulation running during the walk', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Начать показ' }).click()
  const simulation = page.locator('.run-status .clock-strip dd').first()
  await expect(simulation).not.toHaveText('00:00.0')
  await page.getByRole('button', { name: 'Обход в 3D' }).click()
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  await expect(walk.getByRole('button', { name: 'Взаимодействовать' })).toBeEnabled()
  const previous = await simulation.innerText()
  await expect(simulation).not.toHaveText(previous)
  await page.keyboard.press('Escape')
  await expect(walk).toBeHidden()
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible()
})

test('offers a closeable explanation when WebGL2 is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value(...args: Parameters<typeof getContext>) {
        return String(args[0]) === 'webgl2' ? null : Reflect.apply(getContext, this, args)
      },
    })
  })
  await page.goto('/')
  const opener = page.getByRole('button', { name: 'Обход в 3D' })
  await opener.click()
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  await expect(walk.getByRole('alert')).toContainText(/WebGL/i)
  await walk.getByRole('button', { name: 'Закрыть обход' }).click()
  await expect(walk).toBeHidden()
  await expect(opener).toBeFocused()
})

test('enters real fullscreen, restores the viewport and handles graphics context loss', async ({ page }) => {
  await page.goto('/')
  const opener = page.getByRole('button', { name: 'Обход в 3D' })
  await opener.click()
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  await expect(walk.getByRole('button', { name: 'Взаимодействовать' })).toBeEnabled()
  await walk.getByRole('button', { name: 'Полный экран' }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('walk-screen')
  await walk.getByRole('button', { name: 'Выйти из полного экрана' }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull()
  await walk.getByTestId('walk-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')
    if (!context) throw new Error('No WebGL context loss extension')
    context.loseContext()
  })
  await expect(walk.getByRole('alert')).toContainText(/WebGL/)
  await page.keyboard.press('Escape')
  await expect(walk).toBeHidden()
  await expect(opener).toBeFocused()
})

test('keeps the whole viewport usable when the browser refuses fullscreen', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new DOMException('Fullscreen disabled', 'NotAllowedError'))
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Обход в 3D' }).click()
  const walk = page.getByRole('dialog', { name: 'Обход участка' })
  await walk.getByRole('button', { name: 'Полный экран' }).click()
  await expect(walk.getByText('Обход уже занимает всё окно.')).toBeVisible()
  expect(await walk.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
  await walk.getByRole('button', { name: 'Взаимодействовать' }).click()
  await expect(walk.getByRole('region', { name: 'Инвентарь' })).toContainText('Сканер')
  await walk.getByRole('button', { name: 'Закрыть обход' }).click()
  await expect(walk).toBeHidden()
})

test.describe('touch controls', () => {
  test.use({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true })

  test('exposes physically tappable movement controls', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Обход в 3D' }).tap()
    const walk = page.getByRole('dialog', { name: 'Обход участка' })
    const forward = walk.getByRole('button', { name: 'Вперёд', exact: true })
    const backward = walk.getByRole('button', { name: 'Назад', exact: true })
    await expect(forward).toBeVisible()
    await expect(backward).toBeVisible()
    const spot = await forward.boundingBox()
    if (!spot) throw new Error('Forward button has no target')
    const position = walk.getByTestId('walk-position')
    const initial = await position.innerText()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: spot.x + spot.width / 2, y: spot.y + spot.height / 2 }] })
    try {
      await expect.poll(() => position.innerText()).not.toBe(initial)
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await backward.tap()
    await walk.getByRole('button', { name: 'Взаимодействовать' }).tap()
    await expect(walk.getByRole('region', { name: 'Инвентарь' })).toContainText('Сканер')
  })
})
