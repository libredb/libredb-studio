import { test, expect } from '@playwright/test';

const demoEnabled = process.env.DEMO_DB_ENABLED === 'true';

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
    test.skip(!demoEnabled, 'DEMO_DB_ENABLED not set');
    // Matches both real demo ("Employee Demo") and mock demo ("Demo Database (Mock)")
    await expect(page.locator('text=/Demo/i').first()).toBeVisible({ timeout: 10000 });
  });

  test('can select demo connection', async ({ page }) => {
    test.skip(!demoEnabled, 'DEMO_DB_ENABLED not set');
    const demoConn = page.locator('text=/Demo/i').first();
    await demoConn.click();

    // After selecting, schema explorer or query editor should become active
    await page.waitForTimeout(1000);
  });
});
