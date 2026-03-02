import { test, expect } from '@playwright/test';

test.describe('Admin Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin
    await page.goto('/login');
    await page.locator('input[type="email"]').fill('admin@libredb.org');
    await page.locator('input[type="password"]').fill('test-admin');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin**');
  });

  test('admin dashboard loads', async ({ page }) => {
    await expect(page.locator('text=Admin Dashboard')).toBeVisible({ timeout: 10000 });
  });

  test('shows 5 tab triggers', async ({ page }) => {
    await expect(page.getByRole('tab', { name: /Overview/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('tab', { name: /Operations/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Monitoring/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Security/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Audit/i })).toBeVisible();
  });

  test('default tab is overview', async ({ page }) => {
    // Overview tab content should be visible by default
    await expect(page.locator('text=Command Center').first()).toBeVisible({ timeout: 10000 });
  });

  test('can switch to operations tab', async ({ page }) => {
    await page.locator('button:has-text("Operations"), [role="tab"]:has-text("Operations")').first().click();
    await page.waitForTimeout(500);
    // Operations tab content
    await expect(page.locator('text=Connection').first()).toBeVisible({ timeout: 5000 });
  });

  test('can switch to security tab', async ({ page }) => {
    await page.locator('button:has-text("Security"), [role="tab"]:has-text("Security")').first().click();
    await page.waitForTimeout(500);
    // Security tab should show Data Masking content
    await expect(page.locator('text=Data Masking').first()).toBeVisible({ timeout: 5000 });
  });

  test('can switch to audit tab', async ({ page }) => {
    await page.locator('button:has-text("Audit"), [role="tab"]:has-text("Audit")').first().click();
    await page.waitForTimeout(500);
    // Audit tab should show operations/queries
    await expect(page.locator('text=Operations').first()).toBeVisible({ timeout: 5000 });
  });

  test('editor button navigates to studio', async ({ page }) => {
    const editorBtn = page.locator('button:has-text("Editor"), a:has-text("Editor")').first();
    await editorBtn.click();
    await page.waitForURL('/');
    await expect(page).toHaveURL('/');
  });

  test('logout button redirects to login', async ({ page }) => {
    const logoutBtn = page.locator('button:has-text("Logout")').first();
    await logoutBtn.click();
    await page.waitForURL('**/login**');
    await expect(page).toHaveURL(/\/login/);
  });
});
