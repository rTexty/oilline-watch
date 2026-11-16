import { expect, test } from '@playwright/test'

test('keeps the coordinates and duration of a gradual leak hidden until reveal', async ({ page }) => {
  test.setTimeout(45_000)
  await page.goto('/')
  await page.getByRole('button', { name: '4×' }).click()
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await expect(page.getByText('Испытание идёт', { exact: true })).toBeVisible({ timeout: 25_000 })

  await page.getByRole('spinbutton', { name: 'Координата' }).fill('355')
  await page.getByRole('combobox', { name: 'Время открытия' }).selectOption('20')
  await page.getByRole('button', { name: 'Ввести утечку' }).click()
  await expect(page.getByText('Скрытая утечка применена', { exact: true })).toBeVisible()
  const diagnosis = page.getByRole('region', { name: 'Диагностика' })
  await expect(diagnosis.getByRole('status')).toHaveText('Калибровка отсутствует')
  await expect(page.getByRole('combobox', { name: 'Время открытия' })).toHaveCount(0)
  await expect(diagnosis.getByRole('heading', { name: 'Раскрытое событие' })).toHaveCount(0)
  await expect(diagnosis.getByText('355 м', { exact: true })).toHaveCount(0)

  const clock = page.getByRole('region', { name: 'Состояние сценария' }).getByRole('definition').nth(1)
  const challengeSeconds = async () => {
    const [minutes, seconds] = (await clock.innerText()).split(':').map(Number)
    return minutes! * 60 + seconds!
  }
  const appliedAt = await challengeSeconds()
  await expect.poll(challengeSeconds, { timeout: 15_000 }).toBeGreaterThanOrEqual(appliedAt + 20)
  await expect(diagnosis.getByRole('heading', { name: 'Раскрытое событие' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Завершить и раскрыть' }).click()
  await expect(diagnosis.getByRole('heading', { name: 'Раскрытое событие' })).toBeVisible()
  await expect(diagnosis.getByText('355 м', { exact: true })).toBeVisible()
  await expect(diagnosis.getByText('20 с', { exact: true })).toBeVisible()
})
