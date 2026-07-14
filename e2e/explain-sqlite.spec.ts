/**
 * SQLite EXPLAIN QUERY PLAN, end to end: the zero-config "Sample (Employees)"
 * SQLite connection now has a working Explain tab (dead through PR-2,
 * undeliverable before PR-3 wired up sqlite-queryplan). Run a SELECT, open
 * Explain, and see a metric-less tree whose node labels come straight from
 * SQLite's EXPLAIN QUERY PLAN `detail` column - always SCAN or SEARCH for
 * table access. Tree plans have no "insights" tab (its heuristics key off
 * postgres-only fields - Actual Rows, Total Cost, buffer stats - the sqlite
 * dialect never produces), so its absence is asserted too.
 *
 * Login/seed-appearance conventions match embedded-samples.spec.ts: the
 * SQLite sample seeds asynchronously after boot and the client polls for up
 * to 30s, so give it the full window plus slack before calling it missing.
 */
import { expect, test, type Page } from "@playwright/test";

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

test.describe("SQLite EXPLAIN QUERY PLAN", () => {
  // Worst-case chain: login (15s) + async-seed appearance (45s) + monaco
  // (15s) + results grid (20s) + background explain pre-warm (20s) exceeds
  // Playwright's default 30s test budget, as in embedded-samples.spec.ts.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await loginAsUser(page);
  });

  test("Explain tab renders a SCAN/SEARCH tree and hides the insights tab", async ({ page }) => {
    const sample = page.locator("text=Sample (Employees)").first();
    await expect(sample).toBeVisible({ timeout: SAMPLE_APPEAR_TIMEOUT });
    await sample.click();

    // Absent through PR-2 - now visible because sqlite declares explainFormat.
    // data-testid disambiguates from QueryEditor's own "Explain" toolbar
    // button (direct EXPLAIN ANALYZE run), which renders the same text.
    const explainTab = page.getByTestId("bottom-panel-tab-explain");
    await expect(explainTab).toBeVisible({ timeout: 15_000 });

    await runQuery(page, "SELECT * FROM employee LIMIT 10");
    // Results grid confirms the query landed before we go looking at its plan.
    // "10 rows" (StatsBar / BottomPanel toolbar) rather than a column header:
    // ResultsGrid virtualizes columns, so a header cell can resolve but report
    // not-visible depending on horizontal scroll/measurement state.
    await expect(page.locator("text=10 rows").first()).toBeVisible({ timeout: 20_000 });

    await explainTab.click();

    // The background EXPLAIN QUERY PLAN pre-warm resolves into the tagged
    // tree model; node labels are SQLite's own `detail` column verbatim.
    await expect(page.getByText(/SCAN|SEARCH/).first()).toBeVisible({ timeout: 20_000 });

    // Tree plans render tree/raw/ai only - no insights tab (postgres-only heuristics).
    await expect(page.getByRole("button", { name: "insights", exact: true })).toHaveCount(0);
  });
});
