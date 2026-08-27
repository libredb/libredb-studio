import { test, expect } from "@playwright/test";

/**
 * Gate 5 for issue #424 Phase 5.
 *
 * The unit and integration tests drive the provider through a fake transport, so they
 * prove the code is right and prove nothing about whether a user can reach it.
 * Everything a new type-id needs in order to be SELECTABLE lives outside the provider
 * - the `DatabaseType` union, `DB_UI_CONFIG`, `selectableTypes`, an icon export - and
 * a miss in any of them leaves a provider that works and cannot be picked. Several of
 * those surfaces are not type-enforced, which is exactly why this runs in a browser.
 *
 * The assertion specific to THIS engine, and that no other spec here makes, is the
 * credential's NAME: libSQL has no user names, the server checks a token it minted,
 * and a field labelled Password invites a password no libSQL server has.
 */
test.describe("libSQL in the connection dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    // `.first()` on both, unlike the older provider specs: a second, hidden pair of
    // inputs exists for a moment after hydration, and a strict locator fails on it
    // locally while passing in CI. Pinning the first match makes the spec verifiable in
    // both places rather than in CI alone.
    await page.locator('input[type="email"]').first().fill("user@libredb.org");
    await page.locator('input[type="password"]').first().fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

    const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
    await sidebarButtons.last().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
  });

  test("is offered as its own driver", async ({ page }) => {
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "libSQL", exact: true })).toBeVisible();
  });

  test("prefills sqld's own port and offers the URL Turso prints", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "libSQL", exact: true }).click();

    await expect(dialog.locator('input[value="8080"]')).toBeVisible();
    // `libsql://<database>-<org>.turso.io?authToken=<jwt>` is a real string a user has
    // in front of them, unlike Trino's JDBC URL - so the toggle IS offered here.
    await expect(dialog.getByText("Connection String", { exact: true }).first()).toBeVisible();
  });

  test("asks for an auth token rather than a password, and says where one comes from", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "libSQL", exact: true }).click();

    await expect(dialog.getByText("Auth Token", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Password", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/turso db tokens create/)).toBeVisible();
  });

  test("offers the URL form Turso prints, so a pasted connection is a real one", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "libSQL", exact: true }).click();
    await dialog.getByText("Connection String", { exact: true }).first().click();

    // The placeholder is the shape `turso db show --url` prints, token and all - the
    // one string a user has in front of them.
    await expect(dialog.locator('input[placeholder*="turso.io"]')).toBeVisible();
  });

  test("renders neither a Username nor a Database input, because libSQL takes neither", async ({ page }) => {
    // This assertion is the inverse of the one it replaces, and the inversion is the fix.
    // `connectionFields` in `db-ui-config.ts` decides what a save WRITES, and the modal
    // now gates its Username and Database inputs on the same list, so a box exists
    // exactly where a value is carried. Before, libSQL showed a Username box for an
    // engine that has no user names at all - it authenticates with a token the server
    // minted - and a Database box for one addressed entirely by URL, and a save silently
    // dropped both.
    //
    // Host and Password are asserted present in the same breath so this cannot pass by
    // the dialog having failed to render its addressing section at all.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "libSQL", exact: true }).click();

    await expect(dialog.locator("#host")).toHaveCount(1);
    await expect(dialog.locator("#password")).toHaveCount(1);
    await expect(dialog.locator("#user")).toHaveCount(0);
    await expect(dialog.locator("#database")).toHaveCount(0);
  });

  test("claims no wire-compatible relative it has not probed", async ({ page }) => {
    // The Phase 0 hint renders from the compatibility registry, which has no entry for
    // libSQL: Turso Database - the Rust rewrite - publishes no server image, so it has
    // never been connected to. A hint appearing here would mean a name was published
    // without a gate-4 probe, which is the overclaim #424 exists to prevent.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "libSQL", exact: true }).click();

    await expect(dialog.getByTestId("wire-compat-hint")).toHaveCount(0);
  });
});
