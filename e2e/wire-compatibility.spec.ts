import { test, expect } from "@playwright/test";

/**
 * Gate 5 for issue #424 Phase 0.
 *
 * The compatibility registry is only useful if the hint reaches the browser, and
 * the unit tests cannot show that: they mock the registry and render the component
 * in isolation, so they would still pass if the hint were never mounted in the
 * connection dialog. This spec asserts the real registry, rendered inside the real
 * dialog, in a real browser.
 *
 * It also guards the negative case. Several of PostgreSQL's verified relatives have
 * reduced support, and one of them (CockroachDB) must never be presented as though
 * it worked fully - that is the exact overclaim the issue forbids. The count is left
 * out on purpose: it moved from three to four the moment Apache Cloudberry landed as
 * partial, and a number in a comment nobody greps ages silently.
 */
test.describe("Wire compatibility hint", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

    const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
    await sidebarButtons.last().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
  });

  test("MySQL names MariaDB, so a MariaDB user knows which button to press", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByText("MySQL", { exact: true }).click();

    const hint = dialog.getByTestId("wire-compat-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("MariaDB");
    // The version is what makes the claim dated rather than open-ended.
    await expect(hint).toContainText("12.3.2-MariaDB");
    // Apache Doris is the twentieth relative (#424, probed 2026-08-26) and it arrives here
    // from the registry with no per-engine code. The tier is asserted beside the name for
    // the reason MariaDB's is not: MariaDB is `full`, so the name alone is the whole claim,
    // while a `partial` name next to it would read as parity unless the hint says otherwise.
    await expect(hint).toContainText("Apache Doris");
    await expect(hint.getByTestId("wire-compat-tier-Apache Doris")).toContainText("partial support");
    // Databend (#424, probed 2026-08-27) is the first MySQL-wire relative to be query-only,
    // so its suffix is asserted for the same reason Doris's is: the tier is the claim.
    await expect(hint).toContainText("Databend");
    await expect(hint.getByTestId("wire-compat-tier-Databend")).toContainText("query editor only");
  });

  test("PostgreSQL marks its reduced-support relatives instead of listing bare names", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByText("PostgreSQL", { exact: true }).click();

    const hint = dialog.getByTestId("wire-compat-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("CockroachDB");
    await expect(hint.getByTestId("wire-compat-tier-CockroachDB")).toContainText("partial support");
    await expect(hint.getByTestId("wire-compat-tier-Materialize")).toContainText("query editor only");
    // QuestDB must NOT appear here (#424, probed 2026-08-26 and refused a row): it speaks the
    // PostgreSQL wire protocol and a statement answers through the provider, but the editor
    // cannot run anything - `SELECT pg_backend_pid()` precedes every run with a queryId and
    // QuestDB has no such function. This hint is a claim a user acts on, so the absence is
    // asserted rather than left to whoever next reads the registry.
    await expect(hint).not.toContainText("QuestDB");
    // ParadeDB and OrioleDB are both `full` (#424, probed 2026-08-27), so neither renders a
    // tier suffix - asserting the absence keeps this honest about which claim is made, and
    // catches a future entry that quietly downgrades one of them.
    await expect(hint).toContainText("ParadeDB");
    await expect(hint).toContainText("OrioleDB");
    await expect(hint.getByTestId("wire-compat-tier-ParadeDB")).toHaveCount(0);
    await expect(hint.getByTestId("wire-compat-tier-OrioleDB")).toHaveCount(0);
    await expect(hint.getByTestId("wire-compat-caveat-notice")).toBeVisible();
  });

  test("Redis names Garnet beside the three relatives it already had", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByText("Redis", { exact: true }).click();

    const hint = dialog.getByTestId("wire-compat-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("Garnet");
    // All four Redis relatives are `full`, so no tier suffix is rendered for any of them -
    // asserting the absence is what keeps this test honest about which claim is being made.
    await expect(hint).toContainText("Valkey");
    await expect(hint.getByTestId("wire-compat-tier-Garnet")).toHaveCount(0);
  });

  test("SQLite shows no hint at all: it has no wire protocol to be compatible with", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByText("SQLite", { exact: true }).click();

    await expect(dialog.getByTestId("wire-compat-hint")).toHaveCount(0);
  });
});
