import { expect, test } from '@playwright/test';

test('opens the idle application without presenting a running scenario', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/нет запущенного сценария/i)).toBeVisible();
});
