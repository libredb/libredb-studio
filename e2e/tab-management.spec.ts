import { test, expect } from "@playwright/test";

test.describe("Tab Management", () => {
  test.beforeEach(async ({ page }) => {
    // Login as user
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    // Wait for studio to fully load
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible({ timeout: 10000 });
  });

  test("default tab exists with name Query 1", async ({ page }) => {
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible();
  });

  test("can add a new tab", async ({ page }) => {
    await page.getByRole("button", { name: "New tab" }).click();

    // New tab "Query 2" should appear
    await expect(page.getByRole("tab", { name: "Query 2" })).toBeVisible({ timeout: 5000 });
  });

  test("can switch between tabs", async ({ page }) => {
    // Add a second tab; the new tab becomes the active one
    await page.getByRole("button", { name: "New tab" }).click();
    const queryTab1 = page.getByRole("tab", { name: "Query 1" });
    const queryTab2 = page.getByRole("tab", { name: "Query 2" });
    await expect(queryTab2).toBeVisible({ timeout: 5000 });
    await expect(queryTab2).toHaveAttribute("aria-selected", "true");

    // Click on Query 1 to switch back
    await queryTab1.click();
    await expect(queryTab1).toHaveAttribute("aria-selected", "true");
    await expect(queryTab2).toHaveAttribute("aria-selected", "false");
  });

  test("can close a tab when multiple exist", async ({ page }) => {
    // Add a second tab
    await page.getByRole("button", { name: "New tab" }).click();
    await expect(page.getByRole("tab", { name: "Query 2" })).toBeVisible({ timeout: 5000 });

    // Hover the tab to reveal its close button, then click it
    await page.getByRole("tab", { name: "Query 2" }).hover();
    await page.getByRole("button", { name: "Close Query 2" }).click();

    // Query 2 should no longer exist
    await expect(page.getByRole("tab", { name: "Query 2" })).not.toBeVisible({ timeout: 3000 });
    // Query 1 should still exist
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible();
  });
});
