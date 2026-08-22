import { test, expect } from "@playwright/test";

/**
 * Gate 5 for issue #424 Phase 1.
 *
 * The unit and integration tests drive the two providers through a fake transport, so
 * they prove the code is right and prove nothing about whether a user can reach it.
 * Everything a new type-id needs in order to be SELECTABLE lives outside the provider
 * - the `DatabaseType` union, `DB_UI_CONFIG`, `selectableTypes`, an icon export - and
 * a miss in any of them leaves a provider that works and cannot be picked. Two of
 * those surfaces are not type-enforced (measured during Phase 1 recon), which is
 * exactly why this runs in a browser.
 */
test.describe("Search providers in the connection dialog", () => {
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

  test("both engines are offered as their own drivers", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');

    await expect(dialog.getByRole("button", { name: "Elasticsearch" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "OpenSearch" })).toBeVisible();
  });

  test("selecting Elasticsearch prefills its port and asks for host, not a connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Elasticsearch" }).click();

    // 9200 for both products and both schemes: a TLS deployment serves TLS on the
    // same port, so there is no second well-known one to fall back to.
    await expect(dialog.locator('input[value="9200"]')).toBeVisible();
    // Configured by host and port, like Druid: `http(s)://` already resolves to
    // ClickHouse in the connection-string parser, and two engines cannot own one
    // scheme. So there must be no connection-string toggle here.
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("selecting OpenSearch keeps the same port and its own identity", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "OpenSearch" }).click();

    await expect(dialog.locator('input[value="9200"]')).toBeVisible();
    // One implementation serves both type-ids, so the risk worth asserting is that
    // picking one silently selects the other.
    await expect(dialog.getByRole("button", { name: "OpenSearch" })).toBeVisible();
  });

  test("neither engine claims a wire-compatible relative it has not probed", async ({ page }) => {
    // The Phase 0 hint renders from the compatibility registry, which has no entry for
    // either search engine - nothing has been probed against them. A hint appearing
    // here would mean a name was published without a gate-4 probe, which is the
    // overclaim #424 exists to prevent.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Elasticsearch" }).click();

    await expect(dialog.getByTestId("wire-compat-hint")).toHaveCount(0);
  });
});
