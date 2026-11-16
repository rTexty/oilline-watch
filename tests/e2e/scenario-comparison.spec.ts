import { expect, test } from '@playwright/test'

test('compares all seven alignments for the selected segment in a collapsible table', async ({ page }) => {
  const body = [
    'id,segment_id,cutoff,shift_m20_mm,shift_m10_mm,shift_m5_mm,shift_zero_mm,shift_p5_mm,shift_p10_mm,shift_p20_mm',
    '200002,0,2023-12-01,1.1,2.2,3.3,4.4,5.5,6.6,7.7',
    '200002,1,2023-12-01,8.1,9.2,10.3,11.4,12.5,13.6,14.7',
  ].join('\n')
  await page.route('**/forecast/candidate_repeat_scenarios.csv', route =>
    route.fulfill({ contentType: 'text/csv', body }),
  )
  await page.goto('/degradation.html?forecast=alignment')
  await expect(page.getByText('Сценарии привязки', { exact: true })).toBeVisible()

  const disclosure = page.locator('details').filter({ has: page.getByText('Все 7 сдвигов', { exact: true }) })
  const summary = disclosure.locator('summary')
  await expect(summary).toHaveText('Все 7 сдвигов', { timeout: 2_000 })
  const table = page.getByRole('table', { name: 'Толщина по сдвигам', exact: true })
  await expect(disclosure).not.toHaveAttribute('open')
  await expect(table).not.toBeVisible()

  await summary.press('Enter')
  await expect(disclosure).toHaveAttribute('open', '')
  await expect(table).toBeVisible()
  const rows = table.getByRole('row')
  await expect(rows).toHaveCount(8)
  await expect(rows.first().getByRole('columnheader')).toHaveCount(2)
  const active = table.locator('tr[aria-current="true"]')
  await expect(active).toHaveCount(1)
  await expect(active).toContainText('0 м')
  await expect(active).toContainText('4,4')

  const segment = page.getByRole('slider', { name: 'Сегмент' })
  await segment.press('End')
  await expect(segment).toHaveValue('1')
  await expect(active).toContainText('11,4')
  await expect(rows.last()).toContainText('14,7')

  const shift = page.getByRole('combobox', { name: 'Сдвиг' })
  await shift.selectOption({ label: '+20 м' })
  await expect(active).toHaveCount(1)
  await expect(active).toContainText('+20 м')
  await expect(active).toContainText('14,7')

  await summary.press('Enter')
  await expect(disclosure).not.toHaveAttribute('open')
  await expect(table).not.toBeVisible()
})
