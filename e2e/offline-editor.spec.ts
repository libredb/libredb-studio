/**
 * Air-gapped workspace (issue #247): with every off-origin request blocked, the SQL
 * editor must still render and run a query.
 *
 * Before Monaco was self-hosted, @monaco-editor/react fetched it from cdn.jsdelivr.net:
 * the editor pane stayed a spinner forever on an isolated network, while the rest of the
 * app looked healthy — and the Channel E2E gate flaked whenever the runner could not
 * reach the CDN. The existing specs pass *because* the CDN is reachable, which is the
 * wrong thing to assert for a self-hosted product, so this one asserts the opposite:
 * nothing the workspace needs comes from another host.
 */
import { expect, test, type Page } from "@playwright/test";

async function loginAsUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
}

test.describe("Workspace with all off-origin requests blocked", () => {
  // Login (15s) + async SQLite seed (45s) + monaco (20s) + grid (20s) exceeds the default budget.
  test.describe.configure({ timeout: 120_000 });

  test("renders the editor and runs a query without reaching any external host", async ({ page, baseURL }) => {
    const appOrigin = new URL(baseURL as string).origin;
    const blocked: string[] = [];

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith(appOrigin) || url.startsWith("data:") || url.startsWith("blob:")) {
        return route.continue();
      }
      blocked.push(url);
      return route.abort();
    });

    await loginAsUser(page);

    // The editor itself: this is what the CDN dependency used to break.
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 20_000 });

    const sample = page.locator("text=Sample (Employees)").first();
    await expect(sample).toBeVisible({ timeout: 45_000 });
    await sample.click();

    await page.waitForFunction(
      () =>
        ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors()
          .length ?? 0) > 0,
    );
    await page.evaluate(() => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
        .monaco;
      if (!monaco) throw new Error("monaco global not found");
      monaco.editor.getEditors()[0].setValue("SELECT COUNT(*) AS employee_count FROM employee");
    });
    await page.getByRole("button", { name: "RUN" }).click();

    await expect(page.locator("text=employee_count").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("text=1000").first()).toBeVisible({ timeout: 5_000 });

    // Zero off-origin traffic: anything here is a new external dependency that would
    // break air-gapped installs, whether or not this run had internet access.
    expect(blocked).toEqual([]);
  });
});
