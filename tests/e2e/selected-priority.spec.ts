import { expect, test } from '@playwright/test'

test('shows the selected forecast segment rank for the active pipe', async ({ page }) => {
  const firstPipe = Array.from({ length: 525 }, (_, index) => `200002,${index},${(4 + index / 100).toFixed(2)}`)
  const secondPipe = Array.from({ length: 25 }, (_, index) => `200001,${index},${(4 + (24 - index) / 100).toFixed(2)}`)
  const body = ['id,segment_id,thickness_pred', ...firstPipe, ...secondPipe].join('\n')
  await page.route('**/forecast/result.csv', route => route.fulfill({ contentType: 'text/csv', body }))
  await page.goto('/degradation.html?forecast=candidate')

  const pipe = page.getByRole('combobox', { name: 'Труба' })
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  const reading = page.locator('#segment-priority')
  await expect(pipe).toHaveValue('200002')
  await expect(segment).toHaveValue('0')
  await expect(reading).toContainText(/В приоритете\s*·\s*1 из 53/, { timeout: 2_000 })

  await segment.press('End')
  await expect(segment).toHaveValue('524')
  await expect(reading).toContainText('Вне списка приоритетов')
  await expect(reading).not.toContainText('1 из 53')

  await pipe.selectOption('200001')
  await expect(segment).toHaveValue('0')
  await expect(reading).toContainText('Вне списка приоритетов')
  await segment.press('End')
  await expect(segment).toHaveValue('24')
  await expect(reading).toContainText(/В приоритете\s*·\s*1 из 3/)
})

test('names and updates the selected segment count below the alignment threshold', async ({ page }) => {
  const body = [
    'id,segment_id,cutoff,shift_m20_mm,shift_m10_mm,shift_m5_mm,shift_zero_mm,shift_p5_mm,shift_p10_mm,shift_p20_mm',
    '200002,0,2023-12-01,1,2,3,4,5,6,7',
    '200002,1,2023-12-01,2,3,4,5,6,7,8',
  ].join('\n')
  await page.route('**/forecast/candidate_repeat_scenarios.csv', route => route.fulfill({ contentType: 'text/csv', body }))
  await page.goto('/degradation.html?forecast=alignment&segment=1')
  await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Сегмент' })).toHaveValue('1')

  const row = page.locator('aside dl > div').filter({
    has: page.getByText('Выбранный сегмент ниже порога', { exact: true }),
  })
  await expect(row).toContainText('4 из 7 сдвигов', { timeout: 2_000 })
  await page.getByRole('spinbutton', { name: 'Порог, мм' }).fill('8')
  await expect(row).toContainText('6 из 7 сдвигов')
})
