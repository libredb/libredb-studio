import { test, expect } from '@playwright/test';

test.describe('Tab Management', () => {
  test.beforeEach(async ({ page }) => {
    // Login as user
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('user@libredb.org');
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL('/');
    // Wait for studio to fully load
    await expect(page.locator('text=Query 1').first()).toBeVisible({ timeout: 10000 });
  });

  test('default tab exists with name Query 1', async ({ page }) => {
    await expect(page.locator('text=Query 1').first()).toBeVisible();
  });

  test('can add a new tab', async ({ page }) => {
    // The tab bar's plus icon is a sibling of the "Query 1" tab div
    // Navigate from Query 1 text → its parent tab div → the parent tab bar → find the direct child SVG plus
    const query1Parent = page.locator('text=Query 1').first().locator('..');
    const tabBar = query1Parent.locator('..');
    const tabPlusIcon = tabBar.locator(':scope > svg').first();
    await tabPlusIcon.click();

    // New tab "Query 2" should appear
    await expect(page.locator('text=Query 2')).toBeVisible({ timeout: 5000 });
  });

  test('can switch between tabs', async ({ page }) => {
    // Add a second tab using the same strategy
    const query1Parent = page.locator('text=Query 1').first().locator('..');
    const tabBar = query1Parent.locator('..');
    const tabPlusIcon = tabBar.locator(':scope > svg').first();
    await tabPlusIcon.click();
    await expect(page.locator('text=Query 2')).toBeVisible({ timeout: 5000 });

    // Click on Query 1 to switch back
    await page.locator('text=Query 1').first().click();
    await page.waitForTimeout(300);
  });

  test('can close a tab when multiple exist', async ({ page }) => {
    // Add a second tab
    const query1Parent = page.locator('text=Query 1').first().locator('..');
    const tabBar = query1Parent.locator('..');
    const tabPlusIcon = tabBar.locator(':scope > svg').first();
    await tabPlusIcon.click();
    await expect(page.locator('text=Query 2')).toBeVisible({ timeout: 5000 });

    // Close Query 2 — the X icon is inside the Query 2 tab div
    // Hover the tab to reveal the X icon, then click
    const query2Parent = page.locator('text=Query 2').first().locator('..');
    await query2Parent.hover();
    const closeIcon = query2Parent.locator('svg').last();
    await closeIcon.click();

    // Query 2 should no longer exist
    await expect(page.locator('text=Query 2')).not.toBeVisible({ timeout: 3000 });
    // Query 1 should still exist
    await expect(page.locator('text=Query 1').first()).toBeVisible();
  });
});
