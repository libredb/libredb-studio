import { test, expect } from "@playwright/test";
import { openConnectionDialog } from "./helpers/connection-dialog";

test.describe("Connection Management", () => {
  test.beforeEach(async ({ page }) => {
    // Login as user (simpler redirect, avoids admin → studio navigation issues)
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    // Wait for studio to fully load
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });
  });

  test("add connection button opens modal", async ({ page }) => {
    await openConnectionDialog(page);

    // Connection modal should appear
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
  });

  test("connection modal shows database type selector", async ({ page }) => {
    // Open connection modal
    await openConnectionDialog(page);

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // The driver BUTTON, not any text containing "PostgreSQL": the dialog also
    // names the wire-compatible engines (#424), and three of their probed version
    // strings mention PostgreSQL, so a substring locator matches four elements.
    await expect(dialog.getByRole("button", { name: "PostgreSQL" })).toBeVisible({ timeout: 5000 });
  });

  test("connection modal has required fields", async ({ page }) => {
    await openConnectionDialog(page);

    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

    // Should have host field with localhost default
    await expect(page.locator('input[value="localhost"]').first()).toBeVisible();
  });

  test("Trino sends the catalog and session schema entered in the form", async ({ page }) => {
    await page.route("**/api/db/test-connection", (route) => route.fulfill({ json: { success: true, latency: 1 } }));
    await openConnectionDialog(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Trino", exact: true }).click();
    await dialog.getByLabel("Catalog Name").fill("memory");
    await dialog.getByLabel("Schema Name").fill("default");
    const request = page.waitForRequest("**/api/db/test-connection");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    expect((await request).postDataJSON()).toMatchObject({
      type: "trino",
      database: "memory",
      schema: "default",
    });
  });

  test("connection modal can be closed", async ({ page }) => {
    await openConnectionDialog(page);

    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });

    // Press Escape to close
    await page.keyboard.press("Escape");

    await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 3000 });
  });
});
