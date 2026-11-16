import { expect, test } from '@playwright/test'

test('keeps thermal-only telemetry and clock controls during a thermal run', async ({ page }) => {
  await page.goto('/')
  const mode = page.getByRole('combobox', { name: 'Режим' })
  await mode.selectOption('synthetic-oil-thermal-v1')
  await page.getByRole('button', { name: '4×' }).click()
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()

  const status = page.getByRole('region', { name: 'Состояние сценария' })
  const clock = status.getByRole('definition')
  await expect(status.getByRole('status')).toHaveText('Тепловой опыт идёт')
  await expect(mode).toBeDisabled()
  await expect(status.getByText('Время испытания')).toHaveCount(0)
  for (const name of ['Датчики', 'Диагностика', 'Скрытая утечка', 'Граница потока']) {
    await expect(page.getByRole('region', { name, exact: true })).toHaveCount(0)
  }
  await expect(page.getByRole('group', { name: 'Величина на графике' })).toHaveCount(0)

  const temperatures = page.getByRole('region', { name: 'Температура', exact: true })
  await expect(temperatures.getByRole('definition')).toHaveText([/^(?:5[0-9],\d|60,0) °C$/, '40,0 °C', '40,0 °C'])
  await page.getByRole('button', { name: 'Пауза' }).click()
  await expect(status.getByRole('status')).toHaveText('На паузе')
  const pausedAt = await clock.innerText()
  const slowPace = page.getByRole('button', { name: '1×' })
  await slowPace.click()
  await expect(slowPace).toHaveAttribute('aria-pressed', 'true')
  await expect(status.getByRole('status')).toHaveText('На паузе')
  await expect(clock).toHaveText(pausedAt)
  await page.getByRole('button', { name: 'Продолжить' }).click()
  await expect(status.getByRole('status')).toHaveText('Тепловой опыт идёт')
  await expect(clock).not.toHaveText(pausedAt)

  await page.getByRole('button', { name: 'Сброс', exact: true }).click()
  await expect(status.getByRole('status')).toHaveText('Нет запущенного сценария')
  await expect(clock).toHaveText('00:00.0')
  await expect(mode).toBeEnabled()
})
