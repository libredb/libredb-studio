import { test, expect } from '@playwright/test';

test.describe('Demo Mode', () => {
  test.beforeEach(async ({ page }) => {
    // Login as user
    await page.goto('/login');
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL('/');
  });

  test('studio page loads after login', async ({ page }) => {
    // Studio should be visible with sidebar
    await expect(page.locator('text=LibreDB Studio')).toBeVisible();
  });

  test('demo connection is available in sidebar', async ({ page }) => {
    // The demo connection shows as "Employee Demo" with "Demo Database" subtitle
    await expect(page.locator('text=Employee Demo').first()).toBeVisible({ timeout: 10000 });
  });

  test('can select demo connection', async ({ page }) => {
    // Click on demo connection
    const demoConn = page.locator('text=Employee Demo').first();
    await demoConn.click();

    // After selecting, schema explorer or query editor should become active
    await page.waitForTimeout(1000);
  });
});
