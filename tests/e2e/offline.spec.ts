import { expect, test } from '@playwright/test'

test('loads the production bundle from localhost and continues after going offline', async ({ page, context }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== 'http://127.0.0.1:4173') externalRequests.push(url.href)
    }
  })
  await page.goto('/')
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1)
  await page.getByRole('combobox', { name: 'Режим' }).selectOption('synthetic-oil-thermal-v1')
  await page.getByRole('button', { name: '4×' }).click()
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await expect(page.getByText('Тепловой опыт идёт', { exact: true })).toBeVisible()
  await context.setOffline(true)
  const temperature = page.getByRole('region', { name: 'Температура' })
  await expect.poll(async () => {
    const text = await temperature.innerText()
    const entry = text.match(/(\d+[,.]\d+)\s*°C/)
    return Number.parseFloat(entry?.[1]?.replace(',', '.') ?? '')
  }).toBeGreaterThan(45)
  expect(externalRequests).toEqual([])
})
