import { expect, test } from '@playwright/test'

test('stops diagnosis after an inference worker error and starts a fresh run after reset', async ({ page, context }) => {
  test.setTimeout(60_000)
  let routedInferenceSources = 0
  await context.route('**/assets/inference.worker-*.js', async (route) => {
    routedInferenceSources += 1
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({ response, body: `${source}\nconst originalOnMessage = self.onmessage
    self.onmessage = function testInferenceFailure(event) {
      if (event.data?.kind === '__test_inference_failure__') throw new Error('Injected inference worker failure')
      return originalOnMessage.call(self, event)
    }\n` })
  })
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    const workers: { url: string; worker: Worker; terminated: boolean }[] = []
    Object.assign(window, { __testWorkers: workers })
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        const record = { url: String(url), worker: this, terminated: false }
        workers.push(record)
        const terminate = this.terminate.bind(this)
        this.terminate = () => { record.terminated = true; terminate() }
      }
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: '4×' }).click()
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await expect(page.getByText('Испытание идёт', { exact: true })).toBeVisible({ timeout: 25_000 })

  expect(routedInferenceSources).toBe(1)
  const diagnosis = page.getByRole('region', { name: 'Диагностика' })
  const clock = page.getByRole('region', { name: 'Состояние сценария' }).getByRole('definition').first()
  const workerCount = await page.evaluate(() => {
    const workers = (window as unknown as { __testWorkers: { url: string; worker: Worker }[] }).__testWorkers
    const inference = workers.find(({ url }) => url.includes('inference.worker-'))
    if (!inference) throw new Error('Inference worker was not captured')
    inference.worker.postMessage({ kind: '__test_inference_failure__' })
    return workers.length
  })
  expect(workerCount).toBe(2)
  await expect(page.getByText('Ошибка расчёта', { exact: true })).toBeVisible()
  await expect(page.getByText('Диагностический процесс остановлен.', { exact: true })).toBeVisible()
  await expect(diagnosis.getByRole('status')).toHaveText('Расчёт остановлен')
  await expect(diagnosis.getByText('Поддержан внутренний отбор, совместимый с утечкой')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testWorkers: { terminated: boolean }[]
  }).__testWorkers.every(({ terminated }) => terminated))).toBe(true)
  const stoppedAt = await clock.innerText()
  await page.waitForTimeout(1_000)
  await expect(clock).toHaveText(stoppedAt)

  await page.getByRole('button', { name: 'Сброс' }).click()
  await expect(clock).toHaveText('00:00.0')
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await expect(page.getByText('Испытание идёт', { exact: true })).toBeVisible({ timeout: 25_000 })
  await expect(page.getByText('Диагностический процесс остановлен.', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __testWorkers: { terminated: boolean }[]
  }).__testWorkers.filter(({ terminated }) => !terminated).length)).toBe(2)
})
