import { expect, test } from "@playwright/test";

/**
 * The s3 provider's connection dialog in a browser.
 *
 * The unit and integration tests drive the provider over a recorded transport, so they prove the code is right and
 * nothing about whether a user can reach it. What makes a new type-id SELECTABLE lives outside the provider, and the
 * dialog's fields for S3 are declarations, which is why this runs in a browser.
 *
 * Both refusals come from Studio's own connection checks, so no S3 server is needed: a link-local endpoint, refused
 * whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says, and plain HTTP to a host that is not this machine without the consent
 * box. It runs on the second server because Test Connection spends the shared account's per-process rate-limit bucket.
 */
test.describe("S3 in the connection dialog", () => {
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
      page.locator('[role="dialog"]').getByRole("button", { name: "S3-compatible object storage", exact: true }),
    ).toBeVisible();
  });

  test("selecting S3 prefills port 9000, shows its fields and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "S3-compatible object storage", exact: true }).click();

    await expect(dialog.locator('input[value="9000"]')).toBeVisible();
    for (const id of ["#host", "#user", "#password", "#database", "#region"]) {
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its field.
      await expect(dialog.locator(id)).toBeVisible();
    }
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Connect without TLS")).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("a link-local endpoint is refused on Test Connection", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "S3-compatible object storage", exact: true }).click();
    await dialog.locator("#host").fill("169.254.169.254");
    // The plain HTTP refusal is checked before the transport is built, so the consent box is ticked to reach the
    // link-local refusal; ticking it never lets the connection through to that address.
    await dialog.getByLabel("Connect without TLS").check();
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    await expect(dialog.getByTestId("connection-test-result")).toContainText(
      "Invalid host: this connection never reaches a link-local address or AWS's IPv6 instance metadata address, whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says",
      { timeout: 15000 },
    );
  });

  test("plain HTTP to a host that is not this machine is refused without the consent box", async ({ page }) => {
    // The control for the test above: the same dialog without the consent box and with a routable private host
    // reaches the plain HTTP refusal instead, so the sentence in the test above comes from the link-local address,
    // not from the dialog.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "S3-compatible object storage", exact: true }).click();
    await dialog.locator("#host").fill("10.0.0.5");
    await dialog.locator("#user").fill("studio-browse");
    await dialog.locator("#password").fill("Zq9pw-not-a-secret");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("This connection would reach a host that is not this machine over plain HTTP", {
      timeout: 15000,
    });
    await expect(result).not.toContainText("Zq9pw-not-a-secret");
  });
});
