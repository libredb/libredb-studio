import { expect, test } from "@playwright/test";

/**
 * Gate 5 for the Neo4j provider (#424): the connection dialog offers it, draws its fields, and refuses
 * a routing URI typed into Host (spec E7).
 *
 * The unit and integration tests drive the provider directly, so they prove nothing about whether a
 * user can reach it. The dialog's fields for Neo4j are declarations (`DatabaseUIConfig`), which is why
 * this runs in a browser.
 *
 * The refusals are checked through Test Connection, which the server answers from `boltEndpointOf`
 * before the driver is built, so no Neo4j is needed; each is asserted by its own text. The scheme
 * refusal's text is the shared host validator's (`validateHost` in src/lib/db/http/endpoint.ts), which
 * `boltEndpointOf` calls, so it is not spelled in uri.ts; the userinfo test is the control showing that
 * `boltEndpointOf` is what answers. It runs on the second server because Test Connection spends the
 * shared account's per-process rate-limit bucket.
 */
test.describe("Neo4j in the connection dialog", () => {
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
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "Neo4j", exact: true })).toBeVisible();
  });

  test("selecting Neo4j prefills the Bolt port 7687 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Neo4j", exact: true }).click();

    await expect(dialog.locator('input[value="7687"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws the Database box with its hint, the TLS panel and the SSH Tunnel toggle", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Neo4j", exact: true }).click();

    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#user")).toBeVisible();
    await expect(dialog.locator("#password")).toBeVisible();
    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.getByText("Leave empty to use the server's home database.", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
  });

  test("says under User that the connection is read-only whatever the toggle says", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Neo4j", exact: true }).click();

    await expect(
      dialog.getByText(
        "Neo4j connections are read-only in this version, whether or not Read-only is set: this user's write privileges are never used.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  test("a routing neo4j:// URI in Host is refused before any socket opens (spec E7)", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Neo4j", exact: true }).click();
    await dialog.locator("#host").fill("neo4j://10.0.0.5:7687");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("Invalid host: expected a hostname, an IPv4 address or an IPv6 address", {
      timeout: 15000,
    });
  });

  test("a neo4j:// URI carrying a user is refused with the user-and-password advice (spec E7)", async ({ page }) => {
    // The control for the test above: the same field reaches a different refusal from the userinfo,
    // which uri.ts checks first, so the text there is what the scheme produced.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Neo4j", exact: true }).click();
    await dialog.locator("#host").fill("neo4j://reader:Zq9pw@10.0.0.5");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText(
      "Invalid host: a user name or password belongs in the connection's user and password fields, not in the host",
      { timeout: 15000 },
    );
    // The refusal never echoes the password it found in the host.
    await expect(result).not.toContainText("Zq9pw");
  });
});
