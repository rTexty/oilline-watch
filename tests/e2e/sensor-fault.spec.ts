import { expect, test } from '@playwright/test'

test('applies a hidden sensor dropout and restores the channel', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '4×' }).click()
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await expect(page.getByText('Испытание идёт', { exact: true })).toBeVisible({ timeout: 20_000 })
  await page.getByText('Сбой датчика', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Канал датчика' }).selectOption('P2')
  await page.getByRole('button', { name: 'Применить к датчику' }).click()
  const row = page.getByRole('row', { name: /P2/ })
  await expect(row.getByRole('cell', { name: 'Пропуск' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Тип сбоя' }).selectOption('clear')
  await page.getByRole('button', { name: 'Применить к датчику' }).click()
  await expect(row.getByRole('cell', { name: 'Есть данные' })).toBeVisible()
})
