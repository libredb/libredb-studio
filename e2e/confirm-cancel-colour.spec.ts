/**
 * The Cancel buttons in the confirmation dialogs use the `bg-fill` token, but
 * the shadcn outline variant under `AlertDialogCancel` adds `dark:bg-input/30`,
 * and `dark:` follows the OS colour scheme rather than studio's theme (#1199).
 * happy-dom computes no CSS, so the colour is checked here, in a real browser.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const FILL = {
  dark: "rgba(255, 255, 255, 0.05)",
  light: "rgba(9, 9, 11, 0.05)",
} as const;

test.describe("Confirmation dialog Cancel colour", () => {
  test.describe.configure({ timeout: 120_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of ["dark", "light"] as const) {
    test.describe(`studio in ${theme} theme, OS in dark mode`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: "dark" });
        if (theme === "light") {
          await page.addInitScript(() => window.localStorage.setItem("libredb-theme", "light"));
        }
        await loginAsUser(page);
      });

      test("Query Safety Check Cancel uses the fill token", async ({ page }) => {
        const sample = page.locator("text=Sample (Employees)").first();
        await expect(sample).toBeVisible({ timeout: 45_000 });
        await sample.click();

        await runQuery(page, "DELETE FROM employee WHERE 1 = 0");

        const cancel = cancelButton(page);
        await expect(cancel).toBeVisible({ timeout: 15_000 });
        await expectFill(cancel, FILL[theme]);
        await cancel.click();
        await expect(page.getByRole("alertdialog")).toBeHidden();
      });

      test("Delete connection Cancel uses the fill token", async ({ page }) => {
        const sample = page.locator("text=Sample (Employees)").first();
        await expect(sample).toBeVisible({ timeout: 45_000 });
        const item = sample.locator("xpath=ancestor::div[contains(concat(' ', @class, ' '), ' group ')][1]");
        await item.hover();
        await item.getByRole("button", { name: "Delete connection" }).click();

        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toContainText("Delete connection?");
        const cancel = cancelButton(page);
        await expectFill(cancel, FILL[theme]);
        // Always close with Cancel, never Delete: the sample connection is shared.
        await cancel.click();
        await expect(dialog).toBeHidden();
      });
    });
  }
});

function cancelButton(page: Page): Locator {
  return page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true });
}

async function expectFill(cancel: Locator, expected: string): Promise<void> {
  // Move the pointer away so the hover colour does not stand in for the resting one.
  await cancel.page().mouse.move(0, 0);
  await expect.poll(() => cancel.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(expected);
}

async function loginAsUser(page: Page): Promise<void> {
  await page.goto("/login");
  // The login page renders more than one field of each type. A bare type
  // selector is a strict-mode violation, same as e2e/agent-models.spec.ts.
  await page.locator('input[type="email"]').first().fill("user@libredb.org");
  await page.locator('input[type="password"]').first().fill("test-user");
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 15_000 });
}

async function runQuery(page: Page, sql: string): Promise<void> {
  await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () =>
      ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors().length ??
        0) > 0,
  );
  await page.evaluate((query) => {
    const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
      .monaco;
    if (!monaco) throw new Error("monaco global not found");
    monaco.editor.getEditors()[0].setValue(query);
  }, sql);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
}
