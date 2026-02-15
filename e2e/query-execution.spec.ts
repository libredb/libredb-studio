import { test, expect } from '@playwright/test';

test.describe('Query Execution', () => {
  test.beforeEach(async ({ page }) => {
    // Login as user
    await page.goto('/login');
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL('/');
  });

  test('query editor is visible after login', async ({ page }) => {
    // The Monaco editor or its container should be visible
    await expect(page.locator('.monaco-editor, [data-testid="query-editor"], textarea').first()).toBeVisible({ timeout: 10000 });
  });

  test('run button is visible', async ({ page }) => {
    // Run button shows as "RUN" in the toolbar
    await expect(page.getByRole('button', { name: 'RUN' })).toBeVisible({ timeout: 10000 });
  });

  test('bottom panel shows results tab', async ({ page }) => {
    // Results tab button should be visible in the bottom panel
    await expect(page.getByRole('button', { name: 'Results' })).toBeVisible({ timeout: 10000 });
  });

  test('bottom panel has history tab', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'History' })).toBeVisible({ timeout: 10000 });
  });

  test('bottom panel has charts tab', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Charts' })).toBeVisible({ timeout: 10000 });
  });
});
