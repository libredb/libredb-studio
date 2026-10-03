import { expect, test } from "@playwright/test";
import { CREDENTIAL_WARNINGS } from "../src/lib/db/credential-warnings";

/**
 * Gate 2 and gate 5 for the Milvus provider (vector-family spec 8.3).
 *
 * What a new type-id needs in order to be SELECTABLE lives outside the provider, as declarations
 * (`DatabaseUIConfig`, `READ_ONLY_ENFORCED`, the credential record), which is why this runs in a browser. The
 * refusal a password without TLS gets is checked through Test Connection, which the server answers before any
 * socket opens, so no Milvus is needed. It runs on the second server because Test Connection spends the shared
 * account's per-process rate-limit bucket, and it signs in as the admin for the reason e2e/neo4j-provider.spec.ts
 * gives. The documented default pair is read from the credential record, never written here.
 */
const pair = CREDENTIAL_WARNINGS.milvus?.find((entry) => entry.kind === "pair");
// The refusal names "the password", so the stand-in is one that sentence cannot contain.
const TEST_PASSWORD = "password-second";

test.describe("Milvus in the connection dialog", () => {
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
    await page.locator('[role="dialog"]').getByRole("button", { name: "Milvus", exact: true }).click();
  });

  test("is offered as its own driver, prefills port 19530 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('input[value="19530"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws Host, Port, User, Password or token and Database, and the TLS, SSH and Read-only controls", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#port")).toBeVisible();
    await expect(dialog.locator("#user")).toBeVisible();
    await expect(dialog.locator("#password")).toBeVisible();
    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.getByText("Password or token", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Read-only", { exact: true })).toBeVisible();
  });

  test("draws the field hints of spec 5.2", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText(/Port 9091 is Milvus's management port, which Studio never dials\./)).toBeVisible();
    await expect(dialog.getByText(/Leave it empty to put a token in Password or token\./)).toBeVisible();
  });

  test("a pasted https address in the Host box splits into Host and Port, keeping 443", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const host = dialog.locator("#host");
    await host.fill("https://in03-abc.serverless.example.com:443");
    await host.blur();
    await expect(host).toHaveValue("in03-abc.serverless.example.com");
    await expect(dialog.locator("#port")).toHaveValue("443");
  });

  test("the credential warning shows before Test Connection for the documented default pair", async ({ page }) => {
    if (pair?.kind !== "pair") throw new Error("the milvus record declares no pair");
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#user").fill(pair.user);
    await dialog.locator("#password").fill(pair.password);
    await expect(dialog.getByTestId("credential-warning")).toContainText(pair.message);
    await expect(dialog.getByTestId("connection-test-result")).toHaveCount(0);
  });

  test("a password with TLS off to a public host is refused on Test Connection, naming the three ways out", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#host").fill("milvus.example.com");
    await dialog.locator("#user").fill("reader");
    await dialog.locator("#password").fill(TEST_PASSWORD);
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("SSL / TLS", { timeout: 15000 });
    await expect(result).toContainText("SSH tunnel");
    await expect(result).toContainText("clear the password");
    await expect(result).not.toContainText(TEST_PASSWORD);
  });
});
