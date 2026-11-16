import { expect, test } from '@playwright/test';

test('reveals a hidden leak after closing and reproduces the run from its export', async ({ page }) => {
  test.setTimeout(65_000);
  await page.goto('/');
  const diagnosis = page.getByRole('region', { name: 'Диагностика' });

  await page.getByRole('button', { name: '4×' }).click();
  await page.getByRole('button', { name: 'Запустить сценарий' }).click();
  const coordinate = page.getByRole('spinbutton', { name: 'Координата' });
  await expect(page.getByText('Испытание идёт', { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(coordinate).toBeEnabled();

  await coordinate.fill('305');
  await page.getByRole('button', { name: 'Ввести утечку' }).press('Enter');
  await expect(coordinate).toHaveCount(0);
  await expect(page.getByText('Раскрытое событие', { exact: true })).toHaveCount(0);
  await expect(page.getByText('305 м', { exact: true })).toHaveCount(0);

  const residual = page.getByRole('row', { name: /P2/ }).getByRole('cell').last();
  await expect.poll(async () => {
    const value = (await residual.innerText()).replace(/\s/g, '').replace('−', '-').replace(',', '.');
    return Math.abs(Number.parseFloat(value));
  }, { timeout: 10_000 }).toBeGreaterThan(0.7);

  await page.getByRole('button', { name: 'Завершить и раскрыть' }).click();
  await expect(page.getByText('Раскрытое событие', { exact: true })).toBeVisible();
  await expect(diagnosis.getByText('305 м', { exact: true })).toBeVisible();
  await expect.poll(() => page.workers().map((worker) => new URL(worker.url()).pathname))
    .toEqual([expect.stringContaining('simulation.worker-')]);
  const p2Measurement = page.getByRole('row', { name: /P2/ }).getByRole('cell').nth(1);
  const expectedMeasurement = await p2Measurement.innerText();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт повтора' }).click();
  const download = await downloading;
  const path = await download.path();

  await page.getByRole('button', { name: 'Сброс', exact: true }).click();
  await expect(page.getByText('Нет запущенного сценария', { exact: true })).toBeVisible();
  await expect(page.getByText('Раскрытое событие', { exact: true })).toHaveCount(0);

  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Импорт повтора' }).click();
  await (await choosing).setFiles(path);
  await expect(page.getByText('Воспроизводится записанный сценарий.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ввести утечку' })).toHaveCount(0);
  await expect(page.getByText('Испытание завершено', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(p2Measurement).toHaveText(expectedMeasurement);
  await page.getByRole('button', { name: 'Раскрыть сценарий' }).click();
  await expect(diagnosis.getByText('305 м', { exact: true })).toBeVisible();
});

test('runs thermal and laminar profiles with their own telemetry and controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Режим' }).selectOption('synthetic-oil-thermal-v1');
  await expect(page.getByRole('heading', { name: 'Тепловой опыт' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ввести утечку' })).toHaveCount(0);

  await page.getByRole('button', { name: '4×' }).click();
  await page.getByRole('button', { name: 'Запустить сценарий' }).click();
  await expect(page.getByText('Тепловой опыт идёт', { exact: true })).toBeVisible();
  const temperature = page.getByRole('region', { name: 'Температура' });
  await expect.poll(async () => {
    const firstCell = await temperature.getByRole('definition').first().innerText();
    return Number.parseFloat(firstCell.replace(',', '.'));
  }).toBeGreaterThan(45);
  await expect(temperature.getByText('40,0 °C').first()).toBeVisible();
  await page.getByRole('button', { name: 'Сброс', exact: true }).click();

  await page.getByRole('combobox', { name: 'Режим' }).selectOption('synthetic-oil-laminar-v1');
  await expect(page.getByRole('heading', { name: 'Ламинарный опыт' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ввести утечку' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Диагностика' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Запустить сценарий' }).click();
  await expect(page.getByText('Ламинарный опыт идёт', { exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /P2/ })).toContainText('бар абс.');
});

test('provides keyboard navigation and fits a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'К содержанию' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
  await expect(page.getByRole('main')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Запустить сценарий' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
