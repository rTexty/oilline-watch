import { expect, test } from '@playwright/test'

const candidateUrl = '/degradation.html?forecast=candidate'
const csvUrl = '**/forecast/result.csv'
const candidate = 'id,segment_id,thickness_pred\n200001,0,4.5\n200002,0,6.2\n200002,1,5.5'
const manual = 'id,segment_id,thickness_pred\n20,0,8.25'

test('opens the bundled candidate only through the explicit link', async ({ page, baseURL }) => {
  const requests: string[] = []
  await page.route(csvUrl, async route => {
    requests.push(route.request().url())
    await route.fulfill({ contentType: 'text/csv', body: candidate })
  })

  await page.goto('/degradation.html')
  await expect(page.getByText('Синтетический пример')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Стенд утечки' })).toHaveAttribute('href', './index.html')
  expect(requests).toEqual([])

  const archivePage = '/PipeTwin/demo/dist/degradation.html?forecast=candidate'
  await page.route(`**${archivePage}`, async route => {
    const response = await route.fetch({ url: new URL('/degradation.html', baseURL).href })
    await route.fulfill({ response })
  })
  await page.route('**/PipeTwin/demo/dist/assets/**', async route => {
    const url = new URL(route.request().url())
    url.pathname = url.pathname.replace('/PipeTwin/demo/dist/', '/')
    await route.fulfill({ response: await route.fetch({ url: url.href }) })
  })
  await page.goto(archivePage)
  await expect(page.getByText('result.csv', { exact: true })).toBeVisible({ timeout: 2_000 })
  await expect(page.getByText('Кандидатный прогноз', { exact: true })).toBeVisible()
  const pipe = page.getByRole('combobox', { name: 'Труба' })
  await expect(pipe).toHaveValue('200001')
  await expect(pipe.getByRole('option')).toHaveText(['200001', '200002'])
  await expect(page.getByRole('region', { name: 'Приоритет проверки' })).toBeVisible()
  expect(requests).toEqual([new URL('/PipeTwin/forecast/result.csv', baseURL).href])

  const segment = page.getByRole('slider', { name: 'Сегмент' })
  await pipe.selectOption('200002')
  await segment.press('End')
  await expect(segment).toHaveValue('1')

  await page.route('**/PipeTwin/demo/dist/index.html?forecast=candidate', async route => {
    const response = await route.fetch({ url: new URL('/index.html', baseURL).href })
    await route.fulfill({ response })
  })
  await page.getByRole('link', { name: 'Стенд утечки' }).click()
  await expect(page.getByRole('heading', { name: 'Испытание нефтепровода' })).toBeVisible()
  await expect(page).toHaveURL(/\/PipeTwin\/demo\/dist\/index\.html\?forecast=candidate$/)
  await page.getByRole('link', { name: 'Прогноз толщины' }).click()
  await expect(page).toHaveURL(archivePage)
  await expect(page.getByText('Кандидатный прогноз', { exact: true })).toBeVisible()
  await expect(pipe).toHaveValue('200002', { timeout: 2_000 })
  await expect(segment).toHaveValue('1')
})

test('restores the candidate selection on reload without saving changes from a manual CSV', async ({ page }) => {
  await page.route(csvUrl, route => route.fulfill({ contentType: 'text/csv', body: candidate }))
  await page.goto(candidateUrl)
  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  await pipe.selectOption('200002')
  await segment.press('End')
  await expect(segment).toHaveValue('1')

  await page.reload()
  await expect(page.getByText('Кандидатный прогноз', { exact: true })).toBeVisible()
  await expect.soft(pipe).toHaveValue('200002', { timeout: 2_000 })
  await expect.soft(segment).toHaveValue('1', { timeout: 2_000 })

  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'manual.csv', mimeType: 'text/csv', buffer: Buffer.from(candidate.replace('5.5', '9.5')),
  })
  await expect(page.getByText('manual.csv', { exact: true })).toBeVisible()
  await pipe.selectOption('200002')
  await segment.press('Home')
  await expect(segment).toHaveValue('0')
  await pipe.selectOption('200001')

  await page.reload()
  await expect(page.getByText('Кандидатный прогноз', { exact: true })).toBeVisible()
  await expect(pipe).toHaveValue('200002', { timeout: 2_000 })
  await expect(segment).toHaveValue('1')
})

test('falls back safely when the saved candidate selection is invalid', async ({ page }) => {
  await page.route(csvUrl, route => route.fulfill({ contentType: 'text/csv', body: candidate }))
  await page.goto(candidateUrl)
  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  await expect(pipe).toHaveValue('200001')

  for (const entry of [
    { saved: '{broken-json', expectedPipe: '200001' },
    { saved: JSON.stringify({ pipe: '200002', segment: 52 }), expectedPipe: '200002' },
    { saved: JSON.stringify({ pipe: '9999', segment: 1 }), expectedPipe: '200001' },
  ]) {
    await page.evaluate(saved => {
      sessionStorage.setItem(`pipetwin:candidate-selection:v1:${location.pathname}`, saved)
    }, entry.saved)
    await page.reload()
    await expect(page.getByText('Кандидатный прогноз', { exact: true })).toBeVisible()
    await expect(pipe).toHaveValue(entry.expectedPipe)
    await expect(segment).toHaveValue('0')
  }
})

test('candidate forecast remains usable when browser session storage is disabled', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() { throw new DOMException('Storage blocked', 'SecurityError') },
    })
  })
  await page.route(csvUrl, route => route.fulfill({ contentType: 'text/csv', body: candidate }))
  await page.goto(candidateUrl)
  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  await expect(page.getByText('Кандидатный прогноз', { exact: true })).toBeVisible()
  await pipe.selectOption('200002')
  await segment.press('End')
  await expect(segment).toHaveValue('1')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('can open a manual forecast after the candidate file is unavailable', async ({ page }) => {
  await page.route(csvUrl, route => route.fulfill({ status: 404 }))
  await page.goto(candidateUrl)

  await expect(page.getByRole('alert')).toBeVisible({ timeout: 2_000 })
  await expect(page.getByText('Синтетический пример')).toBeVisible()
  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'manual.csv', mimeType: 'text/csv', buffer: Buffer.from(manual),
  })
  await expect(page.getByText('manual.csv', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Труба' })).toHaveValue('20')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('keeps the manually selected CSV when the earlier candidate request completes', async ({ page }) => {
  const requestGate = Promise.withResolvers<void>()
  let requested = false
  await page.route(csvUrl, async route => {
    requested = true
    await requestGate.promise
    await route.fulfill({ contentType: 'text/csv', body: candidate })
  })

  await page.goto(candidateUrl)
  try {
    await expect.poll(() => requested, { timeout: 2_000 }).toBe(true)
    await page.getByLabel('Загрузить CSV').setInputFiles({
      name: 'manual.csv', mimeType: 'text/csv', buffer: Buffer.from(manual),
    })
    await expect(page.getByText('manual.csv', { exact: true })).toBeVisible()
    const response = page.waitForResponse('**/forecast/result.csv')
    requestGate.resolve()
    await (await response).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByText('manual.csv', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Труба' })).toHaveValue('20')
    await expect(page.getByText('Кандидатный прогноз', { exact: true })).toHaveCount(0)
  } finally {
    requestGate.resolve()
  }
})
