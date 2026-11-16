import { expect, test } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true })

for (const viewport of [{ width: 844, height: 390 }, { width: 780, height: 360 }]) {
  test(`offers the pipe center and 4× speed before scrolling at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    const canvas = page.getByTestId('pipe-3d-canvas')
    const speed = page.getByRole('button', { name: '4×', exact: true })
    await expect(canvas).toBeVisible()
    await expect(speed).toBeVisible()

    const [canvasRect, speedRect, scrollY] = await Promise.all([
      canvas.boundingBox(), speed.boundingBox(), page.evaluate(() => window.scrollY),
    ])
    if (!canvasRect || !speedRect) throw new Error('Missing landscape model or speed control')
    expect(scrollY).toBe(0)
    expect.soft(speedRect.x).toBeGreaterThanOrEqual(0)
    expect.soft(speedRect.x + speedRect.width).toBeLessThanOrEqual(viewport.width)
    expect.soft(speedRect.y).toBeGreaterThanOrEqual(0)
    expect.soft(speedRect.y + speedRect.height).toBeLessThanOrEqual(viewport.height)
    expect.soft(canvasRect.x + canvasRect.width / 2).toBeGreaterThan(0)
    expect.soft(canvasRect.x + canvasRect.width / 2).toBeLessThan(viewport.width)
    expect.soft(canvasRect.y + canvasRect.height / 2).toBeGreaterThan(0)
    expect.soft(canvasRect.y + canvasRect.height / 2).toBeLessThan(viewport.height)

    const modelPoint = { x: canvasRect.x + canvasRect.width * 0.66, y: canvasRect.y + canvasRect.height * 0.48 }
    const speedPoint = { x: speedRect.x + speedRect.width / 2, y: speedRect.y + speedRect.height / 2 }
    const targetable = await page.evaluate(({ modelPoint, speedPoint }) => ({
      model: document.elementFromPoint(modelPoint.x, modelPoint.y)?.matches('[data-testid="pipe-3d-canvas"]'),
      speed: document.elementFromPoint(speedPoint.x, speedPoint.y)?.closest('button')?.textContent,
    }), { modelPoint, speedPoint })
    expect(targetable).toEqual({ model: true, speed: '4×' })
    await page.touchscreen.tap(modelPoint.x, modelPoint.y)
    const position = page.getByRole('slider', { name: 'Координата на 3D-модели' })
    await expect(position).not.toHaveValue('500')
    expect(Number(await position.inputValue()) % 5).toBe(0)
    await page.touchscreen.tap(speedPoint.x, speedPoint.y)
    await expect(speed).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })
}
