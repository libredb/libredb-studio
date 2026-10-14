import net from "node:net";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ApiErrorCode } from "../src/lib/api/error-codes";
import { DB_UI_CONFIG, SPARK_FIELD_HINTS } from "../src/lib/db-ui-config";
import { plaintextSecretRefusal } from "../src/lib/db/http/endpoint";
import { SPARK_FIELD_SENTENCES } from "../src/lib/db/providers/sql/spark/connection-options";
import { SPARK_ERROR_SENTENCES } from "../src/lib/db/providers/sql/spark/errors";
import { SPARK_PASTE_SENTENCES } from "../src/lib/db/providers/sql/spark/sc-uri";

/**
 * What a user sees in the connection dialog when choosing Apache Spark.
 *
 * No assertion here reaches Spark: the paste is parsed in the browser, the form's own rules refuse before Test
 * Connection sends anything (each refusal proves it by counting the requests to the test route), the plaintext-token
 * and nothing-listening refusals come from the real route, which the provider raises before or at its first socket, and
 * the one refusal that needs a Spark server (the version floor) is answered by route interception. It runs on the
 * second server (the chromium-spark project of playwright.config.ts) for the reason snowflake-provider.spec.ts does.
 */
const spark = DB_UI_CONFIG.spark;

async function openDialog(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });
  const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  return dialog;
}

async function chooseSpark(page: Page) {
  const dialog = await openDialog(page);
  await dialog.getByRole("button", { name: spark.label, exact: true }).click();
  await expect(dialog.locator("#host")).toBeVisible();
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

/** The Paste URL box, drawn while the Paste URL control is open. */
function pasteBox(dialog: Locator): Locator {
  return dialog.getByPlaceholder(/postgres:\/\//);
}

/** Opens Paste URL when it is closed, writes the address into its box and applies it with Parse. */
async function pasteAddress(dialog: Locator, text: string) {
  if ((await pasteBox(dialog).count()) === 0) await dialog.getByRole("button", { name: "Paste URL" }).click();
  await pasteBox(dialog).fill(text);
  await dialog.getByRole("button", { name: "Parse", exact: true }).click();
}

/** The SSL mode as the SSL / TLS toggle shows it: its badge names any mode but disable, upper-cased. */
async function expectSslMode(dialog: Locator, mode: string) {
  const toggle = dialog.getByRole("button", { name: /SSL \/ TLS/ });
  if (mode === "disable") await expect(toggle).toHaveText(/^\s*SSL \/ TLS\s*$/);
  else await expect(toggle).toContainText(mode.toUpperCase());
}

/** The answer the test route gives a ConnectionError, carrying the version refusal. */
function versionRefusalResponse() {
  return {
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      success: false,
      error: SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"),
      code: ApiErrorCode.CONNECTION_ERROR,
      statusCode: 503,
      retryable: true,
    }),
  };
}

/** A port on 127.0.0.1 this spec bound and released, so nothing listens on it. */
async function releasedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test.describe("Apache Spark in the connection dialog", () => {
  test("1. is selectable with its fields in order, their labels and hints, Port 15002, no User and no Read-only", async ({
    page,
  }) => {
    const dialog = await chooseSpark(page);
    for (const [id, label] of [
      ["host", "Host"],
      ["port", "Port"],
      ["password", "Token"],
      ["database", "Catalog"],
      ["schema", "Namespace"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its box.
      await expect(dialog.locator(`label[for="${id}"]`)).toHaveText(label);
    }
    await expect(dialog.locator("#port")).toHaveValue("15002");
    await expect(dialog.locator("#user")).toHaveCount(0);
    await expect(dialog.getByText("Read-only", { exact: false })).toHaveCount(0);
    await expect(dialog.getByText(SPARK_FIELD_HINTS.host ?? "")).toBeVisible();
    await expect(dialog.locator("#database")).toHaveAttribute("placeholder", spark.fieldPlaceholders?.database ?? "");
    await expect(dialog.locator("#schema")).toHaveAttribute("placeholder", spark.fieldPlaceholders?.schema ?? "");
    await expect(dialog.getByText("SSL / TLS")).toBeVisible();
    // By its button: the Token hint names an SSH tunnel too.
    await expect(dialog.getByRole("button", { name: "SSH Tunnel" })).toBeVisible();
  });

  test("2. an sc:// paste fills Host, Port, Token and verify-system, and names user_id as not applied", async ({
    page,
  }) => {
    const dialog = await chooseSpark(page);
    await pasteAddress(dialog, "sc://spark.example.internal:15002/;use_ssl=true;token=e2e-test-value;user_id=x");
    await expect(dialog.locator("#host")).toHaveValue("spark.example.internal");
    await expect(dialog.locator("#port")).toHaveValue("15002");
    await expect(dialog.locator("#password")).toHaveValue("e2e-test-value");
    await expect(dialog.getByText("Not applied: user_id", { exact: false })).toBeVisible();
    await expectSslMode(dialog, "verify-system");
  });

  test("3. a Databricks, a jdbc:sc:// and a path address are refused with their sentences, filling nothing", async ({
    page,
  }) => {
    const dialog = await chooseSpark(page);
    // The form's own starting values, which a refused paste leaves as they were.
    const before = {
      host: await dialog.locator("#host").inputValue(),
      port: await dialog.locator("#port").inputValue(),
      password: await dialog.locator("#password").inputValue(),
    };
    // The Databricks address may hold a token, so the box is cleared; the other two hold no secret and stay to be
    // corrected.
    for (const [address, sentence, kept] of [
      [
        "sc://adb-1.azuredatabricks.net:443/;token=e2e-test-value;x-databricks-cluster-id=0101",
        SPARK_PASTE_SENTENCES.databricks,
        "",
      ],
      [
        "jdbc:sc://spark.example.internal:15002",
        SPARK_PASTE_SENTENCES.jdbcPrefix,
        "jdbc:sc://spark.example.internal:15002",
      ],
      [
        "sc://spark.example.internal:15002/db",
        SPARK_PASTE_SENTENCES.pathNotEmpty,
        "sc://spark.example.internal:15002/db",
      ],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one paste at a time, so a failure names its address.
      await pasteAddress(dialog, address);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await expect(dialog.getByText(sentence)).toBeVisible();
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await expect(dialog.locator("#host")).toHaveValue(before.host);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await expect(dialog.locator("#port")).toHaveValue(before.port);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await expect(dialog.locator("#password")).toHaveValue(before.password);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await expect(pasteBox(dialog)).toHaveValue(kept);
    }
  });

  test("4. a malformed Namespace and a Catalog holding a dot are refused before Test Connection sends anything", async ({
    page,
  }) => {
    const sent = countTestRequests(page);
    const dialog = await chooseSpark(page);
    await dialog.locator("#host").fill("spark.example.internal");
    await dialog.locator("#schema").fill("a..b");
    await dialog.getByRole("button", { name: "Test Connection" }).click();
    await expect(dialog.getByText(SPARK_FIELD_SENTENCES.namespaceFormat)).toBeVisible();
    await dialog.locator("#schema").fill("");
    await dialog.locator("#database").fill("spark.catalog");
    await dialog.getByRole("button", { name: "Test Connection" }).click();
    await expect(dialog.getByText(SPARK_FIELD_SENTENCES.catalogFormat)).toBeVisible();
    expect(sent()).toBe(0);
  });

  test("5. a token with SSL disabled to a remote host is refused by the real route before any socket", async ({
    page,
  }) => {
    const dialog = await chooseSpark(page);
    await dialog.locator("#host").fill("spark.example.internal");
    await dialog.locator("#password").fill("e2e-test-value");
    await dialog.getByRole("button", { name: "Test Connection" }).click();
    const sentence = plaintextSecretRefusal({
      host: "spark.example.internal",
      tunnelled: false,
      tls: false,
      hasSecret: true,
      secretLabel: "token",
    });
    await expect(dialog.getByText(sentence ?? "")).toBeVisible({ timeout: 15000 });
  });

  test("6. a port nothing listens on answers the not-connected sentence from the real route", async ({ page }) => {
    const port = await releasedPort();
    const dialog = await chooseSpark(page);
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill(String(port));
    await dialog.getByRole("button", { name: "Test Connection" }).click();
    await expect(dialog.getByText(SPARK_ERROR_SENTENCES.notConnected("127.0.0.1", port))).toBeVisible({
      timeout: 15000,
    });
  });

  test("7. the version refusal, the one answer that needs a server, by route interception", async ({ page }) => {
    await page.route("**/api/db/test-connection", (route) => route.fulfill(versionRefusalResponse()));
    const dialog = await chooseSpark(page);
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.getByRole("button", { name: "Test Connection" }).click();
    await expect(dialog.getByText(SPARK_ERROR_SENTENCES.versionTooOld("3.5.9"))).toBeVisible();
  });
});
