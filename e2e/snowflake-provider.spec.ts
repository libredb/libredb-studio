import { expect, type Page, test } from "@playwright/test";
import { DB_UI_CONFIG } from "../src/lib/db-ui-config";
import { SNOWFLAKE_FIELD_SENTENCES, snowflakeHostHint } from "../src/lib/db/providers/sql/snowflake/account-host";
import { pemArmour } from "../tests/helpers/pem-armour";
import { openConnectionDialog } from "./helpers/connection-dialog";

/**
 * What a user sees in the connection dialog when choosing Snowflake.
 *
 * No assertion here reaches Snowflake: the paste is parsed in the browser, the form's own checks refuse before Test
 * Connection sends anything, which each refusal test proves by counting the requests to the test route, and the one
 * refusal that needs an answer (the key-pair refusal with its registration statement) is answered in the browser by
 * route interception. It runs on the second server (the chromium-snowflake project of playwright.config.ts): each test
 * signs in and opens the dialog, which spends the shared account's query budget. Every sentence it expects is imported
 * from the module that owns it.
 */
const snowflake = DB_UI_CONFIG.snowflake;
const JDBC_URL =
  "jdbc:snowflake://myorg-myacct.snowflakecomputing.com/?user=studio_svc&warehouse=STUDIO_WH&role=STUDIO_RO&db=SALES";
const PEM_LINES = [pemArmour("BEGIN"), "A".repeat(32), pemArmour("END")];

async function openDialog(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

  await openConnectionDialog(page);
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  return dialog;
}

async function chooseSnowflake(page: Page) {
  const dialog = await openDialog(page);
  await dialog.getByRole("button", { name: snowflake.label, exact: true }).click();
  await expect(dialog.locator("#authMethod")).toBeVisible();
  return dialog;
}

/** Counts the requests Test Connection would send, so a refusal can be shown to send none. */
function countTestRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/db/test-connection")) count += 1;
  });
  return () => count;
}

test.describe("Snowflake in the connection dialog", () => {
  test("is offered as its own driver, with an Account box and no Port box", async ({ page }) => {
    const dialog = await chooseSnowflake(page);
    await expect(dialog.locator('label[for="host"]')).toHaveText(snowflake.fieldLabels?.host ?? "");
    await expect(dialog.locator("#port")).toHaveCount(0);
    for (const id of [
      "host",
      "user",
      "authMethod",
      "privateKey",
      "privateKeyPassphrase",
      "warehouse",
      "database",
      "schema",
      "role",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one locator at a time, so a failure names its box.
      await expect(dialog.locator(`#${id}`)).toBeVisible();
    }
  });

  test("the Account placeholder, then the host Studio derives once the identifier reads", async ({ page }) => {
    const dialog = await chooseSnowflake(page);
    await expect(dialog.locator("#host")).toHaveAttribute("placeholder", snowflake.fieldPlaceholders?.host ?? "");
    await dialog.locator("#host").fill("myorg-myacct");
    await expect(dialog.getByTestId("host-hint")).toHaveText(snowflakeHostHint("myorg-myacct") ?? "");
    await expect(dialog.getByTestId("host-hint")).toHaveText("Studio connects to myorg-myacct.snowflakecomputing.com.");
  });

  test("the Supports line of Paste URL names the Snowflake forms", async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.getByRole("button", { name: "Paste URL" }).click();
    const supports = dialog.getByText(/^Supports:/);
    await expect(supports).toContainText("jdbc:snowflake://");
    await expect(supports).toContainText("snowflake://");
    await expect(supports).toContainText("a Snowflake account URL");
  });

  test("a JDBC paste switches to Snowflake and fills Account, User, Warehouse, Database and Role", async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.getByRole("button", { name: "Paste URL" }).click();
    await dialog.getByPlaceholder(/postgres:\/\//).fill(JDBC_URL);
    await dialog.getByRole("button", { name: "Parse", exact: true }).click();
    await expect(dialog.locator("#host")).toHaveValue("myorg-myacct.snowflakecomputing.com");
    await expect(dialog.locator("#user")).toHaveValue("studio_svc");
    await expect(dialog.locator("#warehouse")).toHaveValue("STUDIO_WH");
    await expect(dialog.locator("#database")).toHaveValue("SALES");
    await expect(dialog.locator("#role")).toHaveValue("STUDIO_RO");
    await expect(dialog.getByTestId("host-hint")).toHaveText("Studio connects to myorg-myacct.snowflakecomputing.com.");
  });

  test("the private key box is a text area that keeps its line breaks", async ({ page }) => {
    const dialog = await chooseSnowflake(page);
    const key = dialog.locator("#privateKey");
    await expect(key).toHaveJSProperty("tagName", "TEXTAREA");
    await key.fill(PEM_LINES.join("\n"));
    await expect(key).toHaveValue(PEM_LINES.join("\n"));
    await expect(key).toHaveAttribute("spellcheck", "false");
  });

  test("the token box shows only for a programmatic access token, and the key boxes only for a key pair", async ({
    page,
  }) => {
    const dialog = await chooseSnowflake(page);
    await expect(dialog.locator("#password")).toHaveCount(0);
    await dialog.locator("#authMethod").selectOption("pat");
    await expect(dialog.locator("#password")).toBeVisible();
    await expect(dialog.locator('label[for="password"]')).toHaveText(snowflake.fieldLabels?.password ?? "");
    await expect(dialog.locator("#privateKey")).toHaveCount(0);
    await expect(dialog.locator("#privateKeyPassphrase")).toHaveCount(0);
    await dialog.locator("#authMethod").selectOption("keypair");
    await expect(dialog.locator("#privateKey")).toBeVisible();
    await expect(dialog.locator("#password")).toHaveCount(0);
  });

  test("an empty Account and a key pair with no key are refused in their sentences, before anything is sent", async ({
    page,
  }) => {
    const sent = countTestRequests(page);
    const dialog = await chooseSnowflake(page);
    const result = dialog.getByTestId("connection-test-result");
    await dialog.locator("#user").fill("studio_svc");
    await dialog.locator("#role").fill("STUDIO_RO");
    await dialog.locator("#privateKey").fill(PEM_LINES.join("\n"));
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect(result).toContainText(SNOWFLAKE_FIELD_SENTENCES.accountEmpty);
    await dialog.locator("#host").fill("myorg-myacct");
    // Leaving the key box hides the key (SF-014): its text is no longer on the page.
    await expect(dialog.locator("#privateKey")).toHaveCount(0);
    await expect(dialog).not.toContainText(PEM_LINES[1]);
    // Replace key empties the box and hands it the focus.
    await dialog.getByRole("button", { name: "Replace key", exact: true }).click();
    await expect(dialog.locator("#privateKey")).toHaveValue("");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect(result).toContainText(SNOWFLAKE_FIELD_SENTENCES.keyEmpty);
    expect(sent()).toBe(0);
  });

  test("a valid form sends one Test Connection, so the refusal counts above are not vacuous", async ({ page }) => {
    const sent = countTestRequests(page);
    await page.route("**/api/db/test-connection", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) }),
    );
    const dialog = await chooseSnowflake(page);
    await dialog.locator("#host").fill("myorg-myacct");
    await dialog.locator("#user").fill("studio_svc");
    await dialog.locator("#role").fill("STUDIO_RO");
    await dialog.locator("#authMethod").selectOption("pat");
    await dialog.locator("#password").fill("stand-in-token");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect.poll(sent).toBe(1);
  });

  test("the registration statement of a refused key pair fits a 390 px viewport with no horizontal scroll", async ({
    page,
  }) => {
    const statement = `ALTER USER ADD KEY PAIR libredb_studio_0123abcd PUBLIC_KEY = '${"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".repeat(9)}'`;
    await page.route("**/api/db/test-connection", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Snowflake refused the key pair.", fixStatement: statement }),
      }),
    );
    const dialog = await chooseSnowflake(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.locator("#host").fill("myorg-myacct");
    await dialog.locator("#user").fill("studio_svc");
    await dialog.locator("#role").fill("STUDIO_RO");
    await dialog.locator("#authMethod").selectOption("pat");
    await dialog.locator("#password").fill("stand-in-token");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const block = dialog.getByTestId("connection-fix-statement");
    await expect(block).toHaveText(statement);
    await expect(dialog.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const box = await block.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(390);
  });
});
