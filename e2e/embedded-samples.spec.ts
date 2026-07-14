/**
 * Embedded samples: the zero-config first-run promise, end to end — log in on
 * a fresh install and find ready-to-query sample connections in the sidebar:
 * Sample (LibreDB) (seeded synchronously at boot) and Sample (Employees)
 * (a SQLite copy seeded asynchronously; the client polls the managed API so
 * it appears without a page refresh).
 *
 * Channel-agnostic by design: the spec only talks to baseURL. It runs in two
 * harnesses — the regular Playwright config (webServer boots the repo build;
 * the next-dev channel) and playwright.channel.config.ts, where
 * scripts/channel-embedded-sample-e2e.sh boots a packaged artifact (tarball,
 * npx, docker, deb, rpm, snap, homebrew) and passes CHANNEL_E2E_BASE_URL.
 * Packaging bugs (a payload missing seed-assets/) only surface in the
 * channel harness, which is why one `bun run test:e2e` is not enough.
 *
 * Credentials are the fixed test env from playwright.config.ts webServer.env;
 * the channel orchestrator boots servers with the same values.
 */
import { expect, test, type Page } from "@playwright/test";

// The SQLite sample seeds asynchronously after boot and the client polls for
// up to 30s — allow the full window plus slack before calling it missing.
const SAMPLE_APPEAR_TIMEOUT = 45_000;

async function loginAsUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
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
  await page.getByRole("button", { name: "RUN" }).click();
}

test.describe("Embedded sample connections", () => {
  // Worst-case chain exceeds Playwright's default 30s test budget: login
  // (15s) + async-seed appearance (45s) + monaco (15s) + grid (20s + 5s).
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page);
  });

  test("both samples appear in the sidebar without a page refresh", async ({ page }) => {
    await expect(page.locator("text=Sample (LibreDB)").first()).toBeVisible({ timeout: 15_000 });
    // Seeded asynchronously — appears via the client's pending-seed poll.
    await expect(page.locator("text=Sample (Employees)").first()).toBeVisible({ timeout: SAMPLE_APPEAR_TIMEOUT });
  });

  test("querying Sample (Employees) renders rows in the results grid", async ({ page }) => {
    const sample = page.locator("text=Sample (Employees)").first();
    await expect(sample).toBeVisible({ timeout: SAMPLE_APPEAR_TIMEOUT });
    await sample.click();

    await runQuery(page, "SELECT COUNT(*) AS employee_count FROM employee");

    // Column header and value both come from the grid; the count pins the
    // vendored dataset (1000 employees).
    await expect(page.locator("text=employee_count").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("text=1000").first()).toBeVisible({ timeout: 5_000 });
  });

  test("querying Sample (LibreDB) still returns its seeded rows (regression)", async ({ page }) => {
    const sample = page.locator("text=Sample (LibreDB)").first();
    await expect(sample).toBeVisible({ timeout: 15_000 });
    await sample.click();

    await runQuery(page, "prefix users:");

    await expect(page.locator("text=Ada").first()).toBeVisible({ timeout: 20_000 });
  });
});
