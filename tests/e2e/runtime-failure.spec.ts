import { expect, test } from '@playwright/test'

test('reports startup while the simulation worker loads', async ({ page }) => {
  const workerRequested = Promise.withResolvers<void>()
  const releaseWorker = Promise.withResolvers<void>()
  await page.route(/simulation\.worker-.*\.js/, async (route) => {
    workerRequested.resolve()
    await releaseWorker.promise
    await route.continue()
  })
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/')
  const status = page.getByRole('region', { name: 'Состояние сценария' }).getByRole('status')
  await expect(status).toHaveText('Нет запущенного сценария')
  try {
    await page.getByRole('button', { name: 'Запустить сценарий' }).click()
    await workerRequested.promise
    await expect(status).toHaveText('Запуск расчёта', { timeout: 1_000 })
    await expect(page.getByRole('button', { name: 'Ввести утечку' })).toBeDisabled()
    await expect(page.getByRole('slider', { name: /Координата на/ })).toBeInViewport()
  } finally {
    releaseWorker.resolve()
  }
  await expect(status).toHaveText('Штатный разогрев')
})

test('shows a worker load failure and permits reset', async ({ page }) => {
  await page.route(/simulation\.worker-.*\.js/, (route) => route.abort('failed'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await expect(page.getByText('Ошибка расчёта', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Процесс симуляции остановлен.')).toBeVisible()
  await page.getByRole('button', { name: 'Сброс', exact: true }).click()
  await expect(page.getByText('Нет запущенного сценария', { exact: true })).toBeVisible()
})

test('pauses, resumes and resets a running scenario', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await page.getByRole('button', { name: 'Пауза' }).click()
  await expect(page.getByRole('button', { name: 'Продолжить' })).toBeVisible()
  await page.getByRole('button', { name: 'Продолжить' }).click()
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible()
  await page.getByRole('button', { name: 'Сброс', exact: true }).click()
  await expect(page.getByText('Нет запущенного сценария', { exact: true })).toBeVisible()
})

test('pauses the model on a visibility-change event and waits for explicit resume', async ({ page }) => {
  await page.goto('/')
  const start = page.getByRole('button', { name: 'Запустить сценарий' })
  const pause = page.getByRole('button', { name: 'Пауза' })
  const resume = page.getByRole('button', { name: 'Продолжить' })
  const clock = page.getByText('Модельное время', { exact: true }).locator('..').locator('dd')
  const changeVisibility = (hidden: boolean) => page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
  await start.click()
  await expect(pause).toBeVisible()
  await expect(clock).not.toHaveText('00:00.0')
  await changeVisibility(true)
  await expect(resume).toBeVisible()
  const pausedTime = await clock.innerText()
  await changeVisibility(false)
  await expect(resume).toBeVisible()
  await expect(clock).toHaveText(pausedTime)
  await resume.click()
  await expect(clock).not.toHaveText(pausedTime)
})
