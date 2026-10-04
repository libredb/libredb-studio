import { test, expect, type Page } from "@playwright/test";

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

  // Typed with the keyboard, the way a user writes a statement, so the text reaches the tab
  // through the editor's own change path. It is read back through the global `monaco`
  // handle, because the text lives in Monaco's model rather than in the DOM.
  async function typeInEditor(page: Page, sql: string): Promise<void> {
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () =>
        ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors()
          .length ?? 0) > 0,
    );
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await page.keyboard.type(sql);
    await page.keyboard.press("Escape");
  }

  async function editorValue(page: Page): Promise<string> {
    return page.evaluate(() => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { getValue(): string }[] } } }).monaco;
      if (!monaco) throw new Error("monaco global not found");
      return monaco.editor.getEditors()[0].getValue();
    });
  }

  test("a statement typed into the editor survives opening a new tab and returning", async ({ page }) => {
    await typeInEditor(page, "SELECT 42");
    // The new-tab shortcut listens on document so it works while Monaco has focus; it
    // must not drop the text the tab has not yet blurred away.
    await page.keyboard.press("Control+Shift+X");
    await expect(page.getByRole("tab", { name: "Query 2" })).toBeVisible({ timeout: 5000 });
    await page.getByRole("tab", { name: "Query 1" }).click();
    await expect(page.getByRole("tab", { name: "Query 1" })).toHaveAttribute("aria-selected", "true");

    expect(await editorValue(page)).toBe("SELECT 42");
  });

  test("a statement typed into the editor survives a reload", async ({ page }) => {
    await typeInEditor(page, "SELECT 43");
    // The workspace save is debounced; reload only once the statement has been written.
    await expect
      .poll(() => page.evaluate(() => Object.values(localStorage).some((value) => value.includes("SELECT 43"))))
      .toBe(true);
    await page.reload();
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () =>
        ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors()
          .length ?? 0) > 0,
    );

    expect(await editorValue(page)).toBe("SELECT 43");
  });
});
