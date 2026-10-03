import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { CREDENTIAL_WARNINGS } from "../src/lib/db/credential-warnings";

/**
 * Gate 2 and gate 5 for the Qdrant provider (vector-family spec 8.3).
 *
 * What a new type-id needs in order to be SELECTABLE lives outside the provider, as declarations
 * (`DatabaseUIConfig`, `READ_ONLY_ENFORCED`, the credential record), which is why this runs in a browser. The
 * refusal a key without TLS gets is checked through Test Connection, which the server answers before any socket
 * opens, so no Qdrant is needed. It runs on the second server because Test Connection spends the shared account's
 * per-process rate-limit bucket, and it signs in as the admin for the reason e2e/neo4j-provider.spec.ts gives. The
 * JWT it pastes is minted here from a stand-in secret; none is written into a file.
 */
const jwt = CREDENTIAL_WARNINGS.qdrant?.find((entry) => entry.kind === "jwt");
const TEST_JWT_SECRET = "password-second";
const TEST_KEY = "password";

function mintNoExpiry(): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ access: "r" })}`;
  return `${head}.${createHmac("sha256", TEST_JWT_SECRET).update(head).digest("base64url")}`;
}

test.describe("Qdrant in the connection dialog", () => {
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
    await page.locator('[role="dialog"]').getByRole("button", { name: "Qdrant", exact: true }).click();
  });

  test("is offered as its own driver, prefills port 6333 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('input[value="6333"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws Host, Port and API key or JWT, no User and no Database, and the TLS, SSH and Read-only controls", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#port")).toBeVisible();
    await expect(dialog.locator("#password")).toBeVisible();
    await expect(dialog.locator("#user")).toHaveCount(0);
    await expect(dialog.locator("#database")).toHaveCount(0);
    await expect(dialog.getByText("API key or JWT", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Read-only", { exact: true })).toBeVisible();
  });

  test("draws the field hints of spec 6.2", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByText(/never Qdrant's gRPC port 6334 or its cluster port 6335\./)).toBeVisible();
    await expect(
      dialog.getByText(/A read-only or collection-scoped key with an expiry is the safest choice\./),
    ).toBeVisible();
  });

  test("a pasted http address in the Host box splits into Host and Port", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const host = dialog.locator("#host");
    await host.fill("http://localhost:6333");
    await host.blur();
    await expect(host).toHaveValue("localhost");
    await expect(dialog.locator("#port")).toHaveValue("6333");
  });

  test("the credential warning shows before Test Connection for a JWT that declares no expiry", async ({ page }) => {
    if (jwt?.kind !== "jwt") throw new Error("the qdrant record declares no jwt entry");
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#password").fill(mintNoExpiry());
    await expect(dialog.getByTestId("credential-warning")).toContainText(jwt.message);
    await expect(dialog.getByTestId("connection-test-result")).toHaveCount(0);
  });

  test("a key with TLS off to a public host is refused on Test Connection, naming the three ways out", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#host").fill("qdrant.example.com");
    await dialog.locator("#password").fill(TEST_KEY);
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("SSL / TLS", { timeout: 15000 });
    await expect(result).toContainText("SSH tunnel");
    await expect(result).toContainText("clear the");
    await expect(result).not.toContainText(TEST_KEY);
  });
});
