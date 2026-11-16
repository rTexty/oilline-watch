import { expect, test, type CDPSession } from '@playwright/test'

test.use({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true })

async function swipe(session: CDPSession, start: { x: number; y: number }, delta: { x: number; y: number }) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
  for (let index = 1; index <= 8; index++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: start.x + delta.x * index / 8, y: start.y + delta.y * index / 8 }],
    })
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('scrolls vertically across the 3D viewport while touch tap and horizontal orbit still work', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByTestId('pipe-3d-canvas')
  const coordinate = page.getByRole('slider', { name: 'Координата на 3D-модели' })
  await expect(canvas).toBeVisible()
  await expect(coordinate).toHaveValue('500')
  const session = await page.context().newCDPSession(page)
  const beforeScroll = await canvas.screenshot()
  const frame = await canvas.boundingBox()
  if (!frame) throw new Error('3D canvas is not laid out')

  await swipe(session, { x: frame.x + frame.width * 0.44, y: frame.y + frame.height * 0.82 }, { x: 0, y: -130 })
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 2_000 }).toBeGreaterThan(30)
  await page.evaluate(() => scrollTo(0, 0))
  await expect(coordinate).toHaveValue('500')
  expect(await canvas.screenshot()).toEqual(beforeScroll)

  await canvas.tap({ position: { x: frame.width * 0.66, y: frame.height * 0.48 } })
  await expect(coordinate).not.toHaveValue('500')
  const selected = Number(await coordinate.inputValue())
  expect(selected).toBeGreaterThan(500)
  expect(selected).toBeLessThanOrEqual(995)
  expect(selected % 5).toBe(0)

  const beforeRotation = await canvas.screenshot()
  const dragFrame = await canvas.boundingBox()
  if (!dragFrame) throw new Error('3D canvas disappeared before dragging')
  await swipe(session, { x: dragFrame.x + dragFrame.width * 0.4, y: dragFrame.y + dragFrame.height * 0.56 }, { x: 95, y: 0 })
  await expect.poll(() => canvas.screenshot()).not.toEqual(beforeRotation)
  await expect(coordinate).toHaveValue(String(selected))
})

test('a second touch cancels the first without blocking the next tap', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByTestId('pipe-3d-canvas')
  const coordinate = page.getByRole('slider', { name: 'Координата на 3D-модели' })
  await expect(canvas).toBeVisible()
  await expect(coordinate).toHaveValue('500')
  const session = await page.context().newCDPSession(page)
  const frame = await canvas.boundingBox()
  if (!frame) throw new Error('3D canvas is not laid out')
  const x = frame.x + frame.width * 0.66
  const y = frame.y + frame.height * 0.48

  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x, y, id: 1 }, { x: x - 50, y: y - 10, id: 2 }],
  })
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(coordinate).toHaveValue('500')

  await canvas.tap({ position: { x: frame.width * 0.66, y: frame.height * 0.48 } })
  await expect(coordinate).not.toHaveValue('500')
})
