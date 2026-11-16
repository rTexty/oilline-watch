import { expect, test } from '@playwright/test'

const alignmentUrl = '/degradation.html?forecast=alignment'
const scenarioUrl = '**/forecast/candidate_repeat_scenarios.csv'
const forecastUrl = '**/forecast/result.csv'
const scenario = [
  'id,segment_id,cutoff,shift_m20_mm,shift_m10_mm,shift_m5_mm,shift_zero_mm,shift_p5_mm,shift_p10_mm,shift_p20_mm',
  '200002,0,2023-12-01,6.5,6.9,5.94,5.94,6.26,7.86,7.86',
  '200002,1,2023-12-01,6.74,6.5,6.5,6.9,5.94,5.94,7.86',
].join('\n')
const candidate = 'id,segment_id,thickness_pred\n200001,0,4.5\n200002,0,6.2\n200002,1,5.5'
const withPriorityCounts = (first: string, second: string) => scenario.split('\n')
  .map((row, index) => `${row},${['shift_priority_count', first, second][index]}`).join('\n')

test('opens bundled alignment scenarios without replacing the saved candidate selection', async ({ page, baseURL }) => {
  const requests: string[] = []
  await page.route(scenarioUrl, async route => {
    requests.push(route.request().url())
    await route.fulfill({ contentType: 'text/csv', body: scenario })
  })
  await page.route(forecastUrl, route => route.fulfill({ contentType: 'text/csv', body: candidate }))
  await page.goto('/degradation.html')
  await expect(page.getByText('Синтетический пример')).toBeVisible()
  expect(requests).toEqual([])

  await page.goto('/degradation.html?forecast=candidate')
  await page.getByRole('combobox', { name: 'Труба' }).selectOption('200002')
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  await segment.press('End')
  await expect(segment).toHaveValue('1')

  await page.goto(alignmentUrl)
  await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible({ timeout: 2_000 })
  await expect(page.getByText('candidate_repeat_scenarios.csv', { exact: true })).toBeVisible()
  expect(requests).toEqual([new URL('/forecast/candidate_repeat_scenarios.csv', baseURL).href])
  await expect(page.getByRole('combobox', { name: 'Труба' })).toHaveCount(0)
  const shift = page.getByRole('combobox', { name: 'Сдвиг' })
  await expect(shift.getByRole('option')).toHaveText(['-20 м', '-10 м', '-5 м', '0 м', '+5 м', '+10 м', '+20 м'])
  await expect(segment).toHaveValue('0')
  await shift.selectOption({ label: '+20 м' })
  await expect(segment).toHaveAccessibleDescription('Начало 0 м 7,86 мм По 7 сдвигам: 5,94–7,86 мм')
  await segment.press('End')
  await expect(segment).toHaveValue('1')
  await segment.press('Home')
  await expect(segment).toHaveValue('0')

  await expect(page.getByRole('link', { name: 'OilLine Watch', exact: true })).toHaveAttribute('href', './index.html?forecast=candidate')
  await page.getByRole('link', { name: 'К прогнозу толщины' }).click()
  await expect(page).toHaveURL('/degradation.html?forecast=candidate')
  await expect(page.getByRole('combobox', { name: 'Труба' })).toHaveValue('200002')
  await expect(segment).toHaveValue('1')
})

test('opens the alignment for the selected repeat forecast segment', async ({ page }) => {
  await page.route(forecastUrl, route => route.fulfill({ contentType: 'text/csv', body: candidate }))
  await page.route(scenarioUrl, route => route.fulfill({ contentType: 'text/csv', body: scenario }))
  await page.goto('/degradation.html?forecast=candidate')

  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  const alignmentLink = page.getByRole('link', { name: 'Проверить привязку ВТД', exact: true })
  await expect(pipe).toHaveValue('200001')
  await expect(alignmentLink).toHaveCount(0)
  await pipe.selectOption('200002')
  await expect(alignmentLink).toHaveAttribute('href', './degradation.html?forecast=alignment&segment=0')
  await segment.press('End')
  await expect(segment).toHaveValue('1')
  await expect(alignmentLink).toBeVisible({ timeout: 2_000 })
  await alignmentLink.click()
  await expect(page).toHaveURL(`${alignmentUrl}&segment=1`)
  await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible()
  await expect(segment).toHaveValue('1')
  await expect(segment).toHaveAccessibleDescription('Начало 10 м 6,9 мм По 7 сдвигам: 5,94–7,86 мм')

  await page.getByRole('link', { name: 'К прогнозу толщины' }).click()
  await expect(pipe).toHaveValue('200002')
  await expect(segment).toHaveValue('1')

  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'manual-repeat.csv', mimeType: 'text/csv', buffer: Buffer.from(candidate),
  })
  await expect(page.getByText('manual-repeat.csv', { exact: true })).toBeVisible()
  await expect(pipe).toHaveValue('200002')
  await expect(alignmentLink).toHaveCount(0)
})

test('starts at segment zero for invalid alignment segment parameters', async ({ page }) => {
  await page.route(scenarioUrl, route => route.fulfill({ contentType: 'text/csv', body: scenario }))
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  for (const requested of ['-1', '2', '1.5']) {
    await page.goto(`${alignmentUrl}&segment=${requested}`)
    await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible()
    await expect(segment).toHaveValue('0')
  }
})

test('explains an unchanged thickness and the range for nearby segments', async ({ page }) => {
  const equalRow = '200002,1,2023-12-01,6,6,6,6,6,6,6'
  const roundedRow = '200002,2,2023-12-01,6.001,6.004,6.001,6.001,6.001,6.001,6.001'
  const withEqual = [...scenario.split('\n').slice(0, 2), equalRow, roundedRow].join('\n')
  await page.setViewportSize({ width: 320, height: 800 })
  await page.route(scenarioUrl, route => route.fulfill({ contentType: 'text/csv', body: withEqual }))
  await page.goto(alignmentUrl)
  await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible()
  const reading = page.locator('#segment-reading')
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  const explanation = page.getByText('Размах показывает влияние сдвига координат. Ошибка прогноза в него не входит.', { exact: true })
  await expect(reading).toContainText('По 7 сдвигам: 5,94–7,86 мм')
  await expect.soft(explanation).toBeVisible({ timeout: 1_500 })

  await segment.press('ArrowRight')
  await expect(segment).toHaveValue('1')
  await expect.soft(reading).toContainText('Все 7 сдвигов дают 6 мм.', { timeout: 1_500 })
  await expect.soft(segment).toHaveAccessibleDescription(/Все 7 сдвигов дают 6 мм\./, { timeout: 1_500 })
  await expect(reading).not.toContainText('6–6 мм', { timeout: 1_500 })
  await expect.soft(explanation).toBeVisible({ timeout: 1_500 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)

  await segment.press('End')
  await expect(segment).toHaveAccessibleDescription(/разница меньше 0,01 мм/)

  await segment.press('Home')
  await expect(reading).toContainText('По 7 сдвигам: 5,94–7,86 мм')
  await expect.soft(explanation).toBeVisible({ timeout: 1_500 })
})

test('zooms the bundled alignment around its selected segment', async ({ page }) => {
  const count = 525
  const header = scenario.split('\n')[0]!
  const rows = Array.from({ length: count }, (_, index) =>
    `200002,${index},2023-12-01,6.5,6.9,5.94,5.94,6.26,7.86,7.86`)
  const body = [header, ...rows].join('\n')
  await page.route(scenarioUrl, route => route.fulfill({ contentType: 'text/csv', body }))
  await page.goto(`${alignmentUrl}&segment=250`)

  const segment = page.getByRole('slider', { name: 'Сегмент' })
  const chart = page.getByRole('img', { name: 'График толщины и диапазона сценариев' })
  const scale = page.getByRole('group', { name: 'Масштаб профиля' })
  const near = scale.getByRole('button', { name: 'Рядом', exact: true })
  await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible()
  await expect(segment).toHaveValue('250')
  await expect(near).toBeVisible({ timeout: 2_000 })
  await near.click()
  await expect(near).toHaveAttribute('aria-pressed', 'true')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 240–260.')

  await page.getByRole('combobox', { name: 'Сдвиг' }).selectOption({ label: '+20 м' })
  await expect(segment).toHaveValue('250')
  await expect(page.locator('#segment-reading strong')).toHaveText('7,86 мм')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 240–260.')

  const number = page.getByRole('spinbutton', { name: 'Номер сегмента' })
  await number.fill('275')
  await number.press('Enter')
  await expect(segment).toHaveValue('275')
  await expect(chart).toHaveAccessibleDescription('Показаны сегменты 265–285.')
  await expect(near).toHaveAttribute('aria-pressed', 'true')
})

test('reports priority votes for the selected segment when the CSV supplies them', async ({ page }) => {
  await page.route(scenarioUrl, route => route.fulfill({ contentType: 'text/csv', body: withPriorityCounts('7', '3') }))
  await page.goto(alignmentUrl)
  await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible()
  const reading = page.locator('#segment-reading')
  await expect.soft(reading).toContainText('В нижних 10% по толщине: 7 из 7 сдвигов', { timeout: 2_000 })

  await page.getByRole('combobox', { name: 'Сдвиг' }).selectOption({ label: '+20 м' })
  await expect(reading.locator('strong')).toHaveText('7,86 мм')
  await page.getByRole('spinbutton', { name: 'Порог, мм' }).fill('4')
  await expect(page.getByRole('spinbutton', { name: 'Порог, мм' })).toHaveValue('4')
  await expect.soft(reading).toContainText('В нижних 10% по толщине: 7 из 7 сдвигов', { timeout: 2_000 })

  await page.getByRole('slider', { name: 'Сегмент' }).press('End')
  await expect.soft(reading).toContainText('В нижних 10% по толщине: 3 из 7 сдвигов', { timeout: 2_000 })

  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'zero-votes.csv', mimeType: 'text/csv', buffer: Buffer.from(withPriorityCounts('0', '3')),
  })
  await expect(page.getByText('zero-votes.csv', { exact: true })).toBeVisible()
  await expect(reading).toContainText('В нижних 10% по толщине: 0 из 7 сдвигов')

  await page.getByLabel('Загрузить CSV').setInputFiles({
    name: 'without-votes.csv', mimeType: 'text/csv', buffer: Buffer.from(scenario),
  })
  await expect(page.getByText('without-votes.csv', { exact: true })).toBeVisible()
  await expect(reading).not.toContainText('В нижних 10% по толщине:')
})

for (const failedResponse of [
  { label: 'missing CSV', status: 404, body: '' },
  { label: 'wrong CSV type', status: 200, body: candidate },
  { label: 'invalid scenario grid', status: 200, body: scenario.replace('200002,1,', '200002,3,') },
  { label: 'priority count of eight', status: 200, body: withPriorityCounts('8', '3') },
  { label: 'fractional priority count', status: 200, body: withPriorityCounts('2.5', '3') },
  { label: 'missing priority count value', status: 200, body: withPriorityCounts('', '3') },
]) {
  test(`allows local upload after ${failedResponse.label}`, async ({ page }) => {
    const { status, body } = failedResponse
    await page.route(scenarioUrl, route => route.fulfill({ contentType: 'text/csv', status, body }))
    await page.goto(alignmentUrl)

    await expect(page.getByRole('alert')).toBeVisible({ timeout: 2_000 })
    await expect(page.getByRole('link', { name: 'К прогнозу толщины' })).toBeVisible()
    await expect(page.getByText('Синтетический пример')).toBeVisible()
    await page.getByLabel('Загрузить CSV').setInputFiles({
      name: 'manual-scenarios.csv', mimeType: 'text/csv', buffer: Buffer.from(scenario),
    })
    await expect(page.getByText('manual-scenarios.csv', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Сдвиг' }).getByRole('option')).toHaveCount(7)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
}
