import { test, expect } from "@playwright/test";

/**
 * Gate 2 and gate 5 for the Prometheus provider (#1085).
 *
 * The unit and integration tests drive the provider through a fake transport, so they prove
 * the code is right and nothing about whether a user can reach it. Everything a new type-id
 * needs in order to be SELECTABLE lives outside the provider, and several of those surfaces
 * are not type-enforced, which is why this runs in a browser.
 *
 * The assertions specific to this engine are the absent Database box and the password
 * field's declared label and hint: Prometheus is the first engine whose dialog wording comes
 * from `DatabaseUIConfig.fieldLabels` and `fieldHints` rather than from a type test in the
 * dialog, so a regression in that lookup shows here and nowhere else.
 */
test.describe("Prometheus in the connection dialog", () => {
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
    await expect(
      page.locator('[role="dialog"]').getByRole("button", { name: "Prometheus", exact: true }),
    ).toBeVisible();
  });

  test("selecting Prometheus prefills port 9090 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Prometheus", exact: true }).click();

    // 9090 for both schemes: a secured server serves on whatever port its operator chose.
    await expect(dialog.locator('input[value="9090"]')).toBeVisible();
    // `http(s)://` already resolves to ClickHouse, and two engines cannot own one scheme.
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("renders no Database box, while the fields it does take are there", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Prometheus", exact: true }).click();

    // The control first: the form for this engine rendered, with its host and user fields.
    // Without it, an absent Database box could mean a form that never rendered at all.
    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#user")).toBeVisible();
    // One Prometheus server is one TSDB, so there is nothing to select.
    await expect(dialog.locator("#database")).toHaveCount(0);
    await expect(dialog.getByText("Database Name")).toHaveCount(0);
  });

  test("labels the password field as a password or token, and says when it is a bearer token", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Prometheus", exact: true }).click();

    // Declared on DB_UI_CONFIG.prometheus, not chosen by a type test in the dialog.
    await expect(dialog.locator('label[for="password"]')).toHaveText("Password or token");
    await expect(dialog.getByText("Leave User empty to send this as a bearer token.", { exact: true })).toBeVisible();
  });

  test("another engine keeps the plain Password label and draws its Database box", async ({ page }) => {
    // The control for the declaration and for the absent Database box: the lookup is per engine,
    // so an engine that declares nothing must keep the dialog's fallback wording and show no
    // bearer-token hint, and an engine that takes a database must draw the box the Prometheus
    // test expects to be missing, found by the same two locators.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();

    await expect(dialog.locator('label[for="password"]')).toHaveText("Password");
    await expect(dialog.getByText("Leave User empty to send this as a bearer token.", { exact: true })).toHaveCount(0);
    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.getByText("Database Name")).toBeVisible();
  });

  test("an engine that parses a connection string shows the toggle", async ({ page }) => {
    // The control for the absent toggle: MongoDB declares `showConnectionStringToggle: true`, so
    // the locator the Prometheus test expects to find nothing finds the toggle's button here.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MongoDB", exact: true }).click();

    await expect(dialog.getByText("Connection String", { exact: true })).toBeVisible();
  });
});
