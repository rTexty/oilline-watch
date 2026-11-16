import { expect, test } from '@playwright/test'

test.describe('narrow viewport navigation', () => {
  test.use({ viewport: { width: 320, height: 800 } })

  test('keeps the header within the viewport', async ({ page }) => {
    await page.goto('/')
    const navigation = page.getByRole('navigation', { name: 'Разделы стенда' })
    await expect(navigation.getByRole('link', { name: 'Диагностика' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  })

  test('reaches start and pace from the first mobile screen', async ({ page }) => {
    await page.goto('/')
    const navigation = page.getByRole('navigation', { name: 'Разделы стенда' })
    const jump = navigation.getByRole('link', { name: 'Сценарий', exact: true })
    await expect(jump).toBeInViewport({ ratio: 1, timeout: 1_000 })
    await expect(page.getByTestId('pipe-3d-canvas')).toBeInViewport({ ratio: 1 })
    await jump.press('Enter')
    await expect(page).toHaveURL(/#operation-title$/)
    await expect(page.getByRole('heading', { name: 'Сценарий', exact: true })).toBeFocused()
    const start = page.getByRole('button', { name: 'Запустить сценарий' })
    await expect(start).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: '4×', exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Tab')
    await expect(start).toBeFocused()
  })

  test('moves from the 3D model to the scenario controls in visual order', async ({ page }) => {
    await page.goto('/')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'К содержанию' })).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    for (const control of [
      page.getByRole('button', { name: 'Начать показ' }),
      page.getByRole('button', { name: 'Повернуть модель влево' }),
      page.getByRole('button', { name: 'Повернуть модель вправо' }),
      page.getByRole('button', { name: 'Приблизить модель' }),
      page.getByRole('button', { name: 'Отдалить модель' }),
      page.getByRole('button', { name: 'Восстановить вид' }),
      page.getByRole('button', { name: 'Общий', exact: true }),
      page.getByRole('button', { name: 'Сверху', exact: true }),
      page.getByRole('button', { name: 'Вдоль', exact: true }),
      page.getByRole('slider', { name: 'Координата на 3D-модели' }),
      page.getByRole('button', { name: 'Запустить сценарий' }),
    ]) {
      await expect(control).toBeFocused()
      await page.keyboard.press('Tab')
    }
    await expect(page.getByRole('combobox', { name: 'Режим' })).toBeFocused()
  })

  test('gives the sensor fault control a usable target during a scenario', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto('/')
    const status = page.getByRole('region', { name: 'Состояние сценария' }).getByRole('status')
    const diagnosis = page.getByRole('region', { name: 'Диагностика' }).getByRole('status')
    await expect(status).toHaveText('Нет запущенного сценария')
    await expect(diagnosis).toHaveText('Калибровка отсутствует')
    await page.getByRole('button', { name: '4×' }).click()
    await page.getByRole('button', { name: 'Запустить сценарий' }).click()
    await expect(status).toHaveText('Испытание идёт', { timeout: 35_000 })
    await expect(diagnosis).toHaveText('Калибровка отсутствует')
    const sensorFault = page.getByText('Сбой датчика', { exact: true })
    const target = await sensorFault.boundingBox()
    expect(target).not.toBeNull()
    expect(target!.height).toBeGreaterThanOrEqual(24)
  })

  test('guides a narrow screen from scenario controls to the revealed event', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('slider', { name: 'Координата на 3D-модели' }).press('ArrowRight')
    await page.getByRole('button', { name: '4×' }).click()
    await page.getByRole('button', { name: 'Запустить сценарий' }).click()
    await page.getByRole('link', { name: 'К форме утечки' }).click({ timeout: 4_000 })
    const leak = page.getByRole('heading', { name: 'Скрытая утечка' })
    await expect(leak).toBeFocused()
    await expect(leak).toBeInViewport()
    const inject = page.getByRole('button', { name: 'Ввести утечку' })
    await expect(inject).toBeEnabled({ timeout: 20_000 })
    await expect(leak).toBeFocused()
    const trendLink = page.getByRole('region', { name: 'Скрытая утечка' })
      .getByRole('link', { name: 'Смотреть невязку', exact: true })
    await expect(trendLink).toHaveCount(0)
    await inject.click()
    await expect(page.getByText('Скрытая утечка применена')).toBeVisible()
    await expect(trendLink).toBeInViewport({ ratio: 1, timeout: 1_000 })
    await trendLink.press('Enter')
    await expect(page.getByRole('heading', { name: 'Телеметрия' })).toBeFocused()
    const trend = page.getByRole('region', { name: 'Телеметрия' })
    const residual = trend.getByRole('button', { name: 'Невязка' })
    await expect(residual).toBeInViewport()
    await expect(residual).toHaveAttribute('aria-pressed', 'true')
    const pressure = trend.getByRole('button', { name: 'Давление', exact: true })
    await pressure.click()
    await expect(pressure).toHaveAttribute('aria-pressed', 'true')
    await residual.click()
    await expect(residual).toHaveAttribute('aria-pressed', 'true')
    const finish = page.getByRole('button', { name: 'Завершить и раскрыть' })
    await finish.evaluate(element => {
      // WebKit touch activation can focus the nearest focusable ancestor.
      element.addEventListener('click', () => element.closest('main')?.focus(), { once: true })
    })
    await finish.click()
    const result = page.getByRole('heading', { name: 'Раскрытое событие' })
    await expect(result).toBeFocused()
    await expect(result).toBeInViewport()
    await expect(page.getByRole('region', { name: 'Диагностика' }).getByText('505 м', { exact: true })).toBeInViewport()
    const forecast = page.getByRole('region', { name: 'Диагностика' }).getByRole('link', { name: 'Прогноз толщины' })
    await expect(forecast).toBeInViewport({ timeout: 1_000 })
    await page.keyboard.press('Tab')
    await expect(forecast).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/degradation\.html$/)
  })
})

test('operates pause, resume and reset with visible keyboard focus', async ({ page }) => {
  test.setTimeout(45_000)
  await page.goto('/')
  const start = page.getByRole('button', { name: 'Запустить сценарий' })
  const focusByKeyboard = async (target: typeof start) => {
    for (let index = 0; index < 100; index++) {
      if (await target.evaluate((element) => element === document.activeElement)) break
      await page.keyboard.press('Tab')
    }
    await expect(target).toBeFocused()
    expect(await target.evaluate((element) => {
      const style = getComputedStyle(element)
      return element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
    })).toBe(true)
  }
  await focusByKeyboard(start)
  await page.keyboard.press('Enter')
  const pause = page.getByRole('button', { name: 'Пауза' })
  await expect(pause).toBeVisible({ timeout: 35_000 })
  await focusByKeyboard(pause)
  await page.keyboard.press('Space')
  const resume = page.getByRole('button', { name: 'Продолжить' })
  await expect(resume).toBeVisible()
  await focusByKeyboard(resume)
  await page.keyboard.press('Enter')
  await expect(pause).toBeVisible()
  const reset = page.getByRole('button', { name: 'Сброс', exact: true })
  await focusByKeyboard(reset)
  await page.keyboard.press('Space')
  await expect(page.getByText('Нет запущенного сценария', { exact: true })).toBeVisible()
})
