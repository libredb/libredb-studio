import { expect, test } from "@playwright/test";

/**
 * Gate 2 and gate 5 for the etcd provider (#1089).
 *
 * The unit and integration tests drive the provider over a recorded transport, so they prove the code
 * is right and nothing about whether a user can reach it. What a new type-id needs in order to be
 * SELECTABLE lives outside the provider, and the connection dialog's fields for etcd are declarations
 * (`DatabaseUIConfig`, `READ_ONLY_ENFORCED`), which is why this runs in a browser.
 *
 * The refusal a password without TLS gets is checked through Test Connection, which the server answers
 * before any socket opens, so no etcd is needed; it is asserted by its own text. It runs on the second
 * server because Test Connection spends the shared account's per-process rate-limit bucket.
 */
test.describe("etcd in the connection dialog", () => {
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
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "etcd", exact: true })).toBeVisible();
  });

  test("selecting etcd prefills port 2379 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "etcd", exact: true }).click();

    await expect(dialog.locator('input[value="2379"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("renders no Database box, while its fields, the TLS panel and the SSH Tunnel toggle are there", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "etcd", exact: true }).click();

    // The control first: the form for this engine rendered, so an absent box means no box.
    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#user")).toBeVisible();
    await expect(dialog.locator("#password")).toBeVisible();
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
    await expect(dialog.locator("#database")).toHaveCount(0);
  });

  test("draws the field hints that say which fields decide the sign-in (spec 6.1)", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "etcd", exact: true }).click();

    await expect(
      dialog.getByText(
        "A name or address only. For etcdctl's --endpoints=https://10.0.0.5:2379, type 10.0.0.5 here, 2379 in Port, and choose an SSL mode under SSL / TLS.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Leave User and Password empty to sign in with the client certificate under SSL / TLS (shown in verify-ca and verify-full): etcd uses its Common Name as the user when the server runs with --client-cert-auth. When both are set, etcd uses the password.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "etcd receives the password, then a token on every call, so a password needs an SSL mode other than disable, with or without an SSH tunnel.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  test("draws the Read-only toggle for etcd", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "etcd", exact: true }).click();

    const box = dialog.getByLabel("Read-only", { exact: true });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await expect(dialog.locator("#readOnly")).toHaveAttribute("aria-describedby", "readOnly-hint");
  });

  test("a password with TLS off is refused on test connection, naming both fields (spec E2)", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "etcd", exact: true }).click();
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#user").fill("reader");
    await dialog.locator("#password").fill("Zq9pw");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText(
      "A User or Password needs TLS on etcd: choose an SSL mode under SSL / TLS, or clear them. A plaintext etcd with password authentication cannot be connected.",
      { timeout: 15000 },
    );
    // The refusal never echoes the password (spec E2).
    await expect(result).not.toContainText("Zq9pw");
  });

  test("a host carrying a scheme is refused before any socket opens (spec E1)", async ({ page }) => {
    // The control for the test above: the same dialog reaches a different refusal from a different
    // field, so the TLS refusal there is what the password produced.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "etcd", exact: true }).click();
    await dialog.locator("#host").fill("https://10.0.0.5");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText(
      "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.",
      { timeout: 15000 },
    );
  });

  test("another engine draws no Read-only toggle", async ({ page }) => {
    // The control for the toggle: PostgreSQL's provider does not enforce the mode, so the locator the
    // etcd test finds finds nothing here (READ_ONLY_ENFORCED).
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();

    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.getByLabel("Read-only", { exact: true })).toHaveCount(0);
  });
});
