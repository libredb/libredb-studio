import { expect, test } from "@playwright/test";

/**
 * Gate 2 and gate 5 for the Weaviate provider (#1566 spec 8.3), the Qdrant shape (e2e/qdrant-provider.spec.ts).
 *
 * What a new type-id needs in order to be SELECTABLE lives outside the provider, as declarations
 * (`DatabaseUIConfig`, `READ_ONLY_ENFORCED`, the credential record), which is why this runs in a browser. The
 * refusal a key without TLS gets is checked through Test Connection, which the server answers before any socket
 * opens, so no Weaviate is needed. It runs on the second server because Test Connection spends the shared account's
 * per-process rate-limit bucket, and it signs in as the admin for the reason e2e/neo4j-provider.spec.ts gives.
 */
const TEST_KEY = "password";

test.describe("Weaviate in the connection dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@libredb.org");
    await page.locator('input[type="password"]').fill("test-admin");
    await page.getByRole("button", { name: "Sign In" }).click();
    // The admin lands on the Admin Dashboard; the editor is one navigation away.
    await page.waitForURL(/\/admin/);
    await page.goto("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

    const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
    await sidebarButtons.last().click();
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[role="dialog"]').getByRole("button", { name: "Weaviate", exact: true }).click();
  });

  test("is offered as its own driver, prefills port 8080 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('input[value="8080"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws Host, Port and API key or token, no User and no Database, and the TLS, SSH and Read-only controls", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#port")).toBeVisible();
    await expect(dialog.locator("#password")).toBeVisible();
    await expect(dialog.locator("#user")).toHaveCount(0);
    await expect(dialog.locator("#database")).toHaveCount(0);
    await expect(dialog.getByText("API key or token", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Read-only", { exact: true })).toBeVisible();
  });

  test("draws the field hints of spec 6.1", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText(/never Weaviate's gRPC port 50051\./)).toBeVisible();
    await expect(dialog.getByText(/A key for a user with only the viewer role is the safest choice\./)).toBeVisible();
  });

  test("a pasted http address in the Host box splits into Host and Port", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const host = dialog.locator("#host");
    await host.fill("http://localhost:8080");
    await host.blur();
    await expect(host).toHaveValue("localhost");
    await expect(dialog.locator("#port")).toHaveValue("8080");
  });

  test("a key with TLS off to a public host is refused on Test Connection, naming the three ways out", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#host").fill("weaviate.example.com");
    await dialog.locator("#password").fill(TEST_KEY);
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("SSL / TLS", { timeout: 15000 });
    await expect(result).toContainText("SSH tunnel");
    await expect(result).toContainText("clear the");
    await expect(result).not.toContainText(TEST_KEY);
  });
});
