import { expect, test, type CDPSession } from '@playwright/test'

test.use({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true })

async function swipeUp(session: CDPSession, x: number, y: number) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let index = 1; index <= 8; index++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - index * 15 }],
    })
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('scrolls across the thickness plot without selecting a segment and still responds to taps', async ({ page }) => {
  const rows = Array.from({ length: 525 }, (_, index) => `200002,${index},${(4 + index / 100).toFixed(2)}`)
  const body = ['id,segment_id,thickness_pred', ...rows].join('\n')
  await page.route('**/forecast/result.csv', route => route.fulfill({ contentType: 'text/csv', body }))
  await page.goto('/degradation.html?forecast=candidate')
  await expect(page.getByText('Кандидатный прогноз', { exact: true })).toBeVisible()

  const segment = page.getByRole('slider', { name: 'Сегмент' })
  const canvas = page.getByRole('img', { name: 'График прогноза толщины по сегментам' })
  const plot = page.locator('.plot-overlay')
  const bounds = await plot.boundingBox()
  if (!bounds) throw new Error('The plot is not laid out')
  await expect(segment).toHaveValue('0')

  const point = { x: bounds.x + bounds.width * (150.5 / rows.length), y: bounds.y + bounds.height * 0.8 }
  const session = await page.context().newCDPSession(page)
  await swipeUp(session, point.x, point.y)
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 2_000 }).toBeGreaterThan(30)
  await expect(segment).toHaveValue('0', { timeout: 1_000 })

  await canvas.scrollIntoViewIfNeeded()
  const [visiblePlot, canvasBox] = await Promise.all([plot.boundingBox(), canvas.boundingBox()])
  if (!visiblePlot || !canvasBox) throw new Error('The plot disappeared after scrolling')
  const tap = {
    x: visiblePlot.x + visiblePlot.width * (150.5 / rows.length),
    y: visiblePlot.y + visiblePlot.height / 2,
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...tap, id: 1 }] })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ ...tap, id: 1 }, { x: 5, y: tap.y, id: 2 }],
  })
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(segment).toHaveValue('0')

  await canvas.tap({ position: {
    x: tap.x - canvasBox.x,
    y: tap.y - canvasBox.y,
  } })
  // Touch coordinates can be rounded to CSS pixels by Chromium.
  const chosen = Number(await segment.inputValue())
  expect(chosen).toBeGreaterThanOrEqual(148)
  expect(chosen).toBeLessThanOrEqual(152)
})
