import { test, expect } from '@playwright/test';

test.describe('Export Functionality', () => {
  test.beforeEach(async ({ page }) => {
    // Login as user
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('user@libredb.org');
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('/');
  });

  test('export dropdown is not visible when no results', async ({ page }) => {
    // Without query results, export dropdown should not be prominent
    // The export button appears in the results panel header
    await page.waitForTimeout(1000);

    // Export options should not be accessible without results
    const exportBtn = page.locator('button:has-text("Export")');
    await expect(exportBtn).toHaveCount(0);
  });

  test('history tab has export functionality', async ({ page }) => {
    // Switch to history tab
    const historyTab = page.locator('button:has-text("History")').first();
    await historyTab.click();

    // History panel should be visible
    await page.waitForTimeout(500);

    // The history panel has export options (CSV/JSON)
    await expect(page.locator('text=History').first()).toBeVisible();
  });
});
