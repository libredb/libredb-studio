import { test, expect } from '@playwright/test';

test.describe('Connection Management', () => {
  test.beforeEach(async ({ page }) => {
    // Login as user (simpler redirect, avoids admin → studio navigation issues)
    await page.goto('/login');
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL('/');
    // Wait for studio to fully load
    await expect(page.locator('text=Query 1').first()).toBeVisible({ timeout: 10000 });
  });

  test('add connection button opens modal', async ({ page }) => {
    // The sidebar header has buttons next to LibreDB Studio logo
    // The last button in that row is the add connection button
    const sidebarButtons = page.locator('text=LibreDB Studio').locator('..').locator('..').locator('button');
    await sidebarButtons.last().click();

    // Connection modal should appear
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
  });

  test('connection modal shows database type selector', async ({ page }) => {
    // Open connection modal
    const sidebarButtons = page.locator('text=LibreDB Studio').locator('..').locator('..').locator('button');
    await sidebarButtons.last().click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Should show database type options inside the dialog
    await expect(dialog.locator('text=PostgreSQL')).toBeVisible({ timeout: 5000 });
  });

  test('connection modal has required fields', async ({ page }) => {
    const sidebarButtons = page.locator('text=LibreDB Studio').locator('..').locator('..').locator('button');
    await sidebarButtons.last().click();

    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

    // Should have host field with localhost default
    await expect(page.locator('input[value="localhost"]').first()).toBeVisible();
  });

  test('connection modal can be closed', async ({ page }) => {
    const sidebarButtons = page.locator('text=LibreDB Studio').locator('..').locator('..').locator('button');
    await sidebarButtons.last().click();

    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

    // Press Escape to close
    await page.keyboard.press('Escape');

    await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 3000 });
  });
});
