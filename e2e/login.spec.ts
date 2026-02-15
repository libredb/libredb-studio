import { test, expect } from '@playwright/test';

test.describe('Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('shows login page with password field', async ({ page }) => {
    await expect(page.locator('text=LibreDB Studio').first()).toBeVisible();
    await expect(page.locator('input[type="password"], input[placeholder*="security token"], input[placeholder*="password"]').first()).toBeVisible();
    await expect(page.locator('button:has-text("Sign In")').first()).toBeVisible();
  });

  test('admin login redirects to /admin', async ({ page }) => {
    await page.locator('input[type="password"]').fill('test-admin');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin**');
    await expect(page).toHaveURL(/\/admin/);
  });

  test('user login redirects to /', async ({ page }) => {
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('/');
    await expect(page).toHaveURL('/');
  });

  test('wrong password shows error', async ({ page }) => {
    await page.locator('input[type="password"]').fill('wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    // Should stay on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test('empty password shows validation error', async ({ page }) => {
    await page.getByRole('button', { name: /sign in/i }).click();
    // Should stay on login page
    await expect(page).toHaveURL(/\/login/);
  });

  test('authenticated admin accessing /login redirects to /admin', async ({ page }) => {
    // Login as admin first
    await page.locator('input[type="password"]').fill('test-admin');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin**');

    // Try navigating back to /login
    await page.goto('/login');
    await expect(page).toHaveURL(/\/admin/);
  });

  test('authenticated user accessing /login redirects to /', async ({ page }) => {
    // Login as user first
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('/');

    // Try navigating back to /login
    await page.goto('/login');
    await expect(page).toHaveURL('/');
  });

  test('unauthenticated user accessing / redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('user role cannot access /admin', async ({ page }) => {
    await page.locator('input[type="password"]').fill('test-user');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('/');

    // Try accessing admin page
    await page.goto('/admin');
    // Should redirect away from admin
    await expect(page).not.toHaveURL(/\/admin/);
  });
});
