import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { CREDENTIAL_WARNINGS } from "../src/lib/db/credential-warnings";
import { parseDataServers } from "../src/lib/db/providers/keyvalue/oxia/connection-options";
import { DB_UI_CONFIG } from "../src/lib/db-ui-config";

/**
 * What a user sees in the connection dialog when choosing Oxia (SB3-5.8), and the refusals Test Connection answers.
 *
 * What a new type-id needs in order to be SELECTABLE lives outside the provider, as declarations (`DatabaseUIConfig`,
 * `READ_ONLY_ENFORCED`, the credential record), which is why this runs in a browser. Every refusal it asserts is
 * answered by the server before any socket to an Oxia server opens, so no Oxia is needed and CI runs it as it is. It
 * runs on the second server because Test Connection spends the shared account's per-process rate-limit bucket, and it
 * signs in as the admin for the reason e2e/neo4j-provider.spec.ts gives. Every sentence it expects is imported from
 * the module that owns it. The JWT it pastes is minted here from a stand-in secret and declares no `exp`; none is
 * written into a file.
 */
const oxia = DB_UI_CONFIG.oxia;
const jwt = CREDENTIAL_WARNINGS.oxia?.find((entry) => entry.kind === "jwt");
const TEST_JWT_SECRET = "password-second";
const TEST_TOKEN = "e2e.token.value";
const WILDCARD_SERVERS = "a.internal:6648, *.oxia.internal:6648";

function mintNoExpiry(): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "e2e" })}`;
  return `${head}.${createHmac("sha256", TEST_JWT_SECRET).update(head).digest("base64url")}`;
}

/** The refusal `parseDataServers` raises for a text, read from the code rather than typed here. */
function dataServersRefusal(text: string): string {
  try {
    parseDataServers(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`parseDataServers accepted ${text}`);
}

test.describe("Oxia in the connection dialog", () => {
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
    await page.locator('[role="dialog"]').getByRole("button", { name: oxia.label, exact: true }).click();
  });

  test("is offered as its own driver, prefills port 6648 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator('input[value="6648"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws Host, Port, Token, Namespace and Data servers, the TLS panel, the SSH Tunnel toggle and the Read-only toggle, and no User box", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    for (const id of ["host", "port", "password", "database", "dataServers"]) {
      // oxlint-disable-next-line no-await-in-loop -- one locator at a time, so a failure names its box.
      await expect(dialog.locator(`#${id}`)).toBeVisible();
    }
    await expect(dialog.locator("#user")).toHaveCount(0);
    await expect(dialog.locator('label[for="password"]')).toHaveText(oxia.fieldLabels?.password ?? "");
    await expect(dialog.locator('label[for="database"]')).toHaveText(oxia.fieldLabels?.database ?? "");
    await expect(dialog.locator('label[for="dataServers"]')).toHaveText(oxia.fieldLabels?.dataServers ?? "");
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Read-only", { exact: true })).toBeVisible();
  });

  test("draws the five hints and the read-only hint", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    // The consent box and its hint are drawn while SSL Mode is disable, the default.
    for (const field of ["host", "password", "database", "dataServers", "allowInsecureAuth"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one hint at a time, so a failure names its field.
      await expect(dialog.getByTestId(`${field}-hint`)).toHaveText(oxia.fieldHints?.[field] ?? "");
    }
    await expect(dialog.locator("#readOnly-hint")).toHaveText(oxia.readOnlyHint ?? "");
  });

  test("the credential warning shows before Test Connection for a JWT with no exp", async ({ page }) => {
    if (jwt?.kind !== "jwt") throw new Error("the oxia record declares no jwt entry");
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#password").fill(mintNoExpiry());
    await expect(dialog.getByTestId("credential-warning")).toContainText(jwt.message);
    await expect(dialog.getByTestId("connection-test-result")).toHaveCount(0);
  });

  test("a token with SSL mode disable to a public host is refused on Test Connection naming Token, SSL / TLS and the consent box, before any socket", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#host").fill("oxia.example.com");
    await dialog.locator("#password").fill(TEST_TOKEN);
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("send its token without TLS", { timeout: 15000 });
    await expect(result).toContainText("SSL / TLS");
    await expect(result).toContainText("Send the password without TLS");
    await expect(result).not.toContainText(TEST_TOKEN);
  });

  test("a Data servers entry with a wildcard is refused naming its position, never its text", async ({ page }) => {
    const refusal = dataServersRefusal(WILDCARD_SERVERS);
    expect(refusal).not.toContain("*.oxia.internal");
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator("#host").fill("oxia.example.com");
    await dialog.locator("#dataServers").fill(WILDCARD_SERVERS);
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText(refusal, { timeout: 15000 });
    await expect(result).not.toContainText("*.oxia.internal");
  });

  // A tunnel with Data servers is refused in tests/unit/db/oxia/connection-options.test.ts case 10 (ruling R29).

  test("another engine draws no Data servers box", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();
    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.locator("#dataServers")).toHaveCount(0);
  });
});
