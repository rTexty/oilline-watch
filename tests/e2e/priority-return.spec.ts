import { expect, test } from '@playwright/test'

test('returns keyboard focus to the selected priority row and keeps list navigation', async ({ page }) => {
  const rows = Array.from({ length: 1475 }, (_, index) => `200001,${index},${(3 + index / 100).toFixed(2)}`)
  const body = ['id,segment_id,thickness_pred', ...rows].join('\n')
  await page.route('**/forecast/result.csv', route => route.fulfill({ contentType: 'text/csv', body }))
  await page.goto('/degradation.html?forecast=candidate')

  const priorities = page.getByRole('region', { name: 'Приоритет проверки' })
  const first = priorities.getByRole('button', { name: /^Сегмент 0 ·/ })
  const last = priorities.getByRole('button', { name: /^Сегмент 147 ·/ })
  const previous = priorities.getByRole('button', { name: /^Сегмент 146 ·/ })
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  const returnToList = page.getByRole('button', { name: 'К списку приоритетов', exact: true })

  await expect(priorities.getByRole('button')).toHaveCount(148)
  await first.focus()
  await first.press('End')
  await expect(last).toBeFocused()
  await last.press('Enter')
  await expect(segment).toHaveValue('147')
  await expect(last).toHaveAttribute('aria-current', 'true')
  await expect(returnToList).toBeVisible({ timeout: 2_000 })
  for (let tab = 0; tab < 10; tab++) {
    await page.keyboard.press('Tab')
    if (await returnToList.evaluate(button => button === document.activeElement)) break
  }
  await expect(returnToList).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(last).toBeFocused()
  await expect(last).toBeInViewport({ ratio: 1 })
  await page.keyboard.press('ArrowUp')
  await expect(previous).toBeFocused()
  await expect(segment).toHaveValue('147')

  await segment.press('End')
  await expect(segment).toHaveValue('1474')
  await returnToList.press('Enter')
  await expect(first).toBeFocused()
  await expect(first).toBeInViewport({ ratio: 1 })
  await expect(segment).toHaveValue('1474')
})
