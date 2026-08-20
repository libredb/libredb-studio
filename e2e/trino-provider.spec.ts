import { test, expect } from "@playwright/test";

/**
 * Gate 5 for issue #424 Phase 2.
 *
 * The unit and integration tests drive the provider through a fake transport, so they
 * prove the code is right and prove nothing about whether a user can reach it.
 * Everything a new type-id needs in order to be SELECTABLE lives outside the provider
 * - the `DatabaseType` union, `DB_UI_CONFIG`, `selectableTypes`, an icon export - and
 * a miss in any of them leaves a provider that works and cannot be picked. Several of
 * those surfaces are not type-enforced, which is exactly why this runs in a browser.
 *
 * The two assertions that are specific to THIS engine, and that no other spec here
 * makes, are the catalog field and the password warning: both are consequences of
 * live measurements against Trino 476 that a mocked test cannot reach.
 */
test.describe("Trino in the connection dialog", () => {
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

  test("is offered as its own driver", async ({ page }) => {
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "Trino", exact: true })).toBeVisible();
  });

  test("selecting Trino prefills the coordinator port and asks for host, not a connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Trino", exact: true }).click();

    // 8080 for both schemes: a secured cluster serves on whatever port its operator
    // chose, so there is no second well-known one to fall back to.
    await expect(dialog.locator('input[value="8080"]')).toBeVisible();
    // Trino's canonical URL is a JDBC one this parser does not read, and `http(s)://`
    // already resolves to ClickHouse - two engines cannot own one scheme. So there
    // must be no connection-string toggle here.
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("asks for a catalog rather than a database, and says what one is", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Trino", exact: true }).click();

    // The field is the one value a user cannot guess: a coordinator with no catalog
    // pinned resolves no table at all. Measured on 476, `SHOW CATALOGS` on the probe
    // cluster answers jmx, memory, system, tpcds and tpch.
    await expect(dialog.getByText("Catalog Name")).toBeVisible();
    await expect(dialog.getByText("Database Name")).toHaveCount(0);
    await expect(dialog.locator('input[placeholder="tpch"]')).toBeVisible();
  });

  test("warns that a password needs TLS before the connection can 401 on it", async ({ page }) => {
    // Measured on 476 with authentication DISABLED: a request carrying
    // `Authorization: Basic` over plain HTTP is answered 401, "Password not allowed
    // for insecure authentication". Typing a password into an http:// connection
    // therefore BREAKS one that would otherwise work - the one failure mode this form
    // must not produce silently.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Trino", exact: true }).click();

    await expect(dialog.getByText(/refuses a password over plain HTTP/)).toBeVisible();
  });

  test("claims no wire-compatible relative it has not probed", async ({ page }) => {
    // The Phase 0 hint renders from the compatibility registry, which has no entry for
    // Trino - Presto and Starburst have not been probed against this provider. A hint
    // appearing here would mean a name was published without a gate-4 probe, which is
    // the overclaim #424 exists to prevent.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Trino", exact: true }).click();

    await expect(dialog.getByTestId("wire-compat-hint")).toHaveCount(0);
  });
});
