import { expect, test } from '@playwright/test'

const candidatePage = '/degradation.html?forecast=candidate'
const experimentalPage = '/degradation.html?forecast=report-gap&segment=1'
const header = 'id,segment_id,thickness_pred'
const candidate = [header, '200001,0,4.5', '200002,0,6.2', '200002,1,5.5'].join('\n')
const experimental = [header, '200001,0,4.5', '200002,0,5.1', '200002,1,5.85'].join('\n')

test('opens the experimental repeat forecast at the linked segment and preserves the candidate selection', async ({ page, baseURL }) => {
  const requests: string[] = []
  await page.route('**/forecast/result.csv', route => route.fulfill({ contentType: 'text/csv', body: candidate }))
  await page.route('**/forecast/report-gap/result.csv', route => {
    requests.push(route.request().url())
    return route.fulfill({ contentType: 'text/csv', body: experimental })
  })
  await page.goto(candidatePage)

  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  const reading = page.locator('#segment-reading')
  const comparison = page.getByText(/^Кандидатный прогноз · /)
  const seeExperimental = page.getByRole('link', { name: 'Экспериментальный прогноз', exact: true })
  await expect(pipe).toHaveValue('200001')
  await expect(seeExperimental).toHaveCount(0)
  await pipe.selectOption('200002')
  await segment.press('End')
  await expect(segment).toHaveValue('1')
  await expect(reading).toContainText('5,5 мм')
  await expect(comparison).toHaveCount(0)
  await expect(seeExperimental).toHaveAttribute('href', `.${experimentalPage}`, { timeout: 2_000 })
  expect(requests).toEqual([])

  await seeExperimental.click()
  await expect(page).toHaveURL(experimentalPage)
  await expect(page.getByText('Экспериментальный прогноз', { exact: true })).toBeVisible()
  expect(requests).toEqual([new URL('/forecast/report-gap/result.csv', baseURL).href])
  await expect(pipe).toHaveValue('200002')
  await expect(segment).toHaveValue('1')
  await expect(reading).toContainText('5,85 мм')
  await expect(page.locator('#segment-priority')).toHaveText('Вне списка приоритетов')
  await expect(comparison).toHaveText('Кандидатный прогноз · 5,5 мм · В приоритете 1 из 1', { timeout: 1_500 })
  await expect(reading).not.toContainText('Кандидатный прогноз')
  await segment.press('Home')
  await expect(reading).toContainText('5,1 мм')
  await expect(page.locator('#segment-priority')).toHaveText('В приоритете · 1 из 1')
  await expect(comparison).toHaveText('Кандидатный прогноз · 6,2 мм · Вне списка приоритетов')

  const back = page.getByRole('link', { name: 'К прогнозу толщины', exact: true })
  await back.click()
  await expect(page).toHaveURL(candidatePage)
  await expect(pipe).toHaveValue('200002')
  await expect(segment).toHaveValue('1')
  await expect(reading).toContainText('5,5 мм')

  await page.goto(experimentalPage)
  await expect(page.getByText('Экспериментальный прогноз', { exact: true })).toBeVisible()
  await expect(pipe).toHaveValue('200002')
  await expect(segment).toHaveValue('1')
  await expect(comparison).toHaveText('Кандидатный прогноз · 5,5 мм · В приоритете 1 из 1')
  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'manual-report.csv', mimeType: 'text/csv', buffer: Buffer.from(experimental),
  })
  await expect(page.getByText('manual-report.csv', { exact: true })).toBeVisible()
  await expect(page.getByText('Экспериментальный прогноз', { exact: true })).toHaveCount(0)
  await expect(comparison).toHaveCount(0)
  await expect(seeExperimental).toHaveCount(0)
  await pipe.selectOption('200001')
  await expect(segment).toHaveValue('0')
  await back.click()
  await expect(page).toHaveURL(candidatePage)
  await expect(pipe).toHaveValue('200002')
  await expect(segment).toHaveValue('1')
})

for (const unavailable of [
  { reason: 'missing file', status: 404, body: '' },
  { reason: 'missing selected segment', status: 200, body: [header, '200002,0,6.2'].join('\n') },
]) {
  test(`keeps the experimental forecast usable with ${unavailable.reason}`, async ({ page }) => {
    await page.route('**/forecast/result.csv', route => route.fulfill({
      status: unavailable.status, contentType: 'text/csv', body: unavailable.body,
    }))
    await page.route('**/forecast/report-gap/result.csv', route => route.fulfill({ contentType: 'text/csv', body: experimental }))
    await page.goto(experimentalPage)
    await expect(page.getByText('Экспериментальный прогноз', { exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: 'График прогноза толщины по сегментам' })).toBeVisible()
    await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveValue('1')
    await expect(page.locator('#segment-reading')).toContainText('5,85 мм')
    await expect(page.getByText('Кандидатный прогноз недоступен', { exact: true })).toBeVisible({ timeout: 1_500 })
  })
}
