import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('opens a bundled synthetic forecast from the lab on a hosted repository path', async ({ page, baseURL }) => {
  const site = '/oilline-watch/'
  const demoQuery = '?forecast=demo'
  const csv = 'wall-thickness-demo.csv'
  const fixture = await readFile(new URL('../../examples/synthetic/wall-thickness-demo.csv', import.meta.url))
  const forecastRequests: string[] = []

  await page.route(`**${site}**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === site + csv) {
      forecastRequests.push(url.href)
      await route.fulfill({ contentType: 'text/csv', body: fixture })
      return
    }
    url.pathname = '/' + url.pathname.slice(site.length)
    await route.fulfill({ response: await route.fetch({ url: url.href }) })
  })

  await page.goto(site + demoQuery)
  await page.getByRole('link', { name: 'Прогноз толщины' }).click()
  await expect(page).toHaveURL(site + 'degradation.html' + demoQuery)
  await expect(page.getByText('Синтетический прогноз', { exact: true })).toBeVisible()
  const pipes = page.getByRole('combobox', { name: 'Труба' })
  await expect(pipes.getByRole('option')).toHaveText(['900000001', '900000002'])
  const segment = page.getByRole('slider', { name: 'Сегмент' })
  await expect(segment).toHaveAttribute('max', '41')
  await pipes.selectOption('900000002')
  await expect(segment).toHaveAttribute('max', '53')

  await page.getByRole('link', { name: 'Стенд утечки' }).click()
  await expect(page).toHaveURL(site + 'index.html' + demoQuery)
  await expect(page.getByRole('heading', { name: 'Испытание нефтепровода' })).toBeVisible()
  expect(forecastRequests).toEqual([new URL(site + csv, baseURL).href])
})
