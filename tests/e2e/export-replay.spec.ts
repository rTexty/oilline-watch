import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { replaySchema } from '../../src/runtime/replay-schema'
import turbulentProfile from '../../src/scenarios/synthetic-oil-turbulent-v1.json' with { type: 'json' }

test('replays a public load change after rejecting an unsupported export version', async ({ page }) => {
  test.setTimeout(65_000)
  await page.goto('/')
  await page.getByRole('button', { name: '4×' }).click()
  await page.getByRole('button', { name: 'Запустить сценарий' }).click()
  await expect(page.getByText('Испытание идёт', { exact: true })).toBeVisible({ timeout: 25_000 })

  const flow = page.getByRole('row', { name: /Qin/ })
  const predicted = flow.getByRole('cell').nth(2)
  const nominalPrediction = await predicted.innerText()
  await expect(predicted).toContainText('л/с')
  await page.getByText('Изменить расход', { exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Расход Qout' }).fill('95')
  await page.getByRole('button', { name: 'Задать расход' }).click()
  await expect(page.getByText(/Последняя команда применена в/)).toBeVisible()
  await expect(predicted).not.toHaveText(nominalPrediction)
  await page.getByRole('button', { name: 'Завершить и раскрыть' }).click()
  await expect(page.getByText('В завершённом сценарии скрытой утечки не было.')).toBeVisible()
  await page.getByRole('link', { name: 'К управлению сценарием' }).click({ timeout: 1_000 })
  await expect(page.getByRole('heading', { name: 'Сценарий', exact: true })).toBeFocused()
  const finalFlow = await flow.getByRole('cell').allTextContents()
  const clock = page.getByRole('region', { name: 'Состояние сценария' }).getByRole('definition').first()
  const endTime = await clock.innerText()

  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Экспорт повтора' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('oilline-watch-run.json')
  const path = await download.path()
  const record = replaySchema.parse(JSON.parse(await readFile(path, 'utf8')))
  expect(record.events).toEqual([{
    kind: 'control',
    timeUs: expect.any(Number),
    outletFlowM3s: expect.closeTo(0.95 * turbulentProfile.initialPublicControls.outletFlowM3s, 15),
  }])

  await page.getByRole('button', { name: 'Сброс', exact: true }).click()
  const plannedCoordinate = page.getByRole('slider', { name: /Координата на/ })
  await expect(plannedCoordinate).toBeVisible()
  const fileInput = page.getByLabel('Файл повтора')
  await page.evaluate(() => {
    const read = File.prototype.text
    const release = new Promise<void>(resolve => {
      window.addEventListener('release-replay-file', () => resolve(), { once: true })
    })
    File.prototype.text = async function () {
      if (this.name === 'unsupported-replay.json') await release
      return read.call(this)
    }
  })
  try {
    await fileInput.setInputFiles({
      name: 'unsupported-replay.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...record, schemaVersion: 2 })),
    })
    await expect(page.getByRole('region', { name: 'Состояние сценария' }).getByRole('status')).toHaveText('Загрузка повтора')
    await expect(plannedCoordinate).toHaveCount(0)
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event('release-replay-file')))
  }
  await expect(page.getByRole('alert')).toHaveText('Не удалось прочитать повтор. Проверьте формат и версию файла.')
  await expect(page.getByText('Нет запущенного сценария', { exact: true })).toBeVisible()
  await expect(clock).toHaveText('00:00.0')
  await expect(plannedCoordinate).toBeVisible()

  await fileInput.setInputFiles(path)
  await expect(page.getByText('Воспроизводится записанный сценарий.')).toBeVisible()
  await expect(plannedCoordinate).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Задать расход' })).toHaveCount(0)
  await expect(page.getByText('Испытание завершено', { exact: true })).toBeVisible({ timeout: 25_000 })
  await expect(clock).toHaveText(endTime)
  await expect(flow.getByRole('cell')).toHaveText(finalFlow)
  const backToControls = page.getByRole('link', { name: 'К управлению сценарием' })
  await expect(backToControls).toHaveCount(0)
  await page.getByRole('button', { name: 'Раскрыть сценарий' }).click()
  await expect(page.getByText('В завершённом сценарии скрытой утечки не было.')).toBeVisible()
  await expect(backToControls).toBeInViewport()
})
