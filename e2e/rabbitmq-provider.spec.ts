import { expect, type Page, test } from "@playwright/test";
import { connectionFieldHint, connectionFieldLabel, DB_UI_CONFIG, RABBITMQ_FIELD_RULES } from "../src/lib/db-ui-config";
import { PLAINTEXT_REFUSAL } from "../src/lib/db/providers/stream/rabbitmq/errors";
import { type RabbitMQStub, startRabbitMQStub } from "./helpers/rabbitmq-stub";

/**
 * The RabbitMQ provider in a browser (#1656, #424 gates 2 and 5). The dialog's fields for RabbitMQ are declarations
 * (`DB_UI_CONFIG.rabbitmq`), so what a person can type is checked where they type it: the Management port, the AMQP
 * port and the Path prefix, the consent box drawn only while SSL mode is disable, no TLS server name and no SSH
 * tunnel, and two refusals Test Connection answers before any socket. The tree and a detail run against a stub
 * management API replaying the 4.3.6 capture (e2e/helpers/rabbitmq-stub.ts). Stream reads in the browser are the
 * manual live pass on the pinned broker, recorded in the PR, because a read needs an AMQP broker. It runs on the
 * second server, as every spec that connects does, and signs in as the admin for the reason
 * e2e/neo4j-provider.spec.ts gives.
 */
const RABBITMQ = DB_UI_CONFIG.rabbitmq;
const READER_PASSWORD = ["e2e", "reader", "pass"].join("-");
let stub: RabbitMQStub;

test.beforeAll(async () => {
  stub = await startRabbitMQStub();
});

test.afterAll(async () => {
  await stub.close();
});

async function openDialog(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("admin@libredb.org");
  await page.locator('input[type="password"]').fill("test-admin");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL(/\/admin/);
  await page.goto("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10_000 });
  const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.getByRole("button", { name: "RabbitMQ", exact: true }).click();
  return dialog;
}

function row(page: Page, label: string) {
  return page
    .locator('[role="treeitem"]')
    .filter({ has: page.getByTestId("tree-row-label").getByText(label, { exact: true }) })
    .first();
}

test.describe("RabbitMQ in the connection dialog", () => {
  test("prefills the Management port and draws the AMQP port and the Path prefix with their labels and hints", async ({
    page,
  }) => {
    const dialog = await openDialog(page);
    await expect(dialog.locator("#port")).toHaveValue("15672");
    for (const field of ["amqpPort", "apiPath"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its field.
      await expect(dialog.locator(`#${field}`)).toBeVisible();
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its field.
      await expect(dialog.getByText(connectionFieldLabel(RABBITMQ, field, ""), { exact: true })).toBeVisible();
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its field.
      await expect(dialog.locator(`#${field}-hint`)).toHaveText(connectionFieldHint(RABBITMQ, field) as string);
    }
    // The Host row's two boxes carry the names the provider's sentences use.
    await expect(dialog.locator('label[for="host"]')).toHaveText(connectionFieldLabel(RABBITMQ, "host", ""));
    await expect(dialog.locator('label[for="port"]')).toHaveText(connectionFieldLabel(RABBITMQ, "port", ""));
    await expect(dialog.locator("#port-hint")).toHaveText(connectionFieldHint(RABBITMQ, "port") as string);
  });

  test("offers no TLS server name, no connection string and no SSH tunnel", async ({ page }) => {
    const dialog = await openDialog(page);
    await expect(dialog.locator("#tlsServerName")).toHaveCount(0);
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
  });

  test("draws the consent box only while SSL mode is disable", async ({ page }) => {
    const dialog = await openDialog(page);
    const consent = dialog.getByLabel("Send the password without TLS", { exact: true });
    await expect(consent).toBeVisible();
    await expect(dialog.locator("#allowInsecureAuth-hint")).toHaveText(
      connectionFieldHint(RABBITMQ, "allowInsecureAuth") as string,
    );
    await dialog.getByText("SSL / TLS", { exact: true }).click();
    await dialog.getByRole("button", { name: "require", exact: true }).click();
    await expect(consent).toHaveCount(0);
    await dialog.getByRole("button", { name: "disable", exact: true }).click();
    await expect(consent).toBeVisible();
  });

  test("a password with TLS off to a host that is not this machine is refused on Test Connection before any socket", async ({
    page,
  }) => {
    const dialog = await openDialog(page);
    await dialog.locator("#host").fill("mq.example.invalid");
    await dialog.locator("#user").fill("studio-reader");
    await dialog.locator("#password").fill(READER_PASSWORD);
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText(PLAINTEXT_REFUSAL, { timeout: 15_000 });
    await expect(result).not.toContainText(READER_PASSWORD);
  });

  test("a Path prefix that ends in /api is refused on Test Connection before any request", async ({ page }) => {
    const dialog = await openDialog(page);
    const before = stub.requests.length;
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill(String(stub.port));
    await dialog.locator("#user").fill("studio-reader");
    await dialog.locator("#password").fill(READER_PASSWORD);
    await dialog.locator("#apiPath").fill("/rabbitmq/api");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    // The dialog's own Path prefix rule answers first, with the one sentence that names every shape it refuses.
    await expect(dialog.getByTestId("connection-test-result")).toContainText(
      RABBITMQ_FIELD_RULES.apiPath?.format?.sentence as string,
      { timeout: 15_000 },
    );
    expect(stub.requests.length).toBe(before);
  });
});

test.describe("RabbitMQ in the tree, against the replayed management API", () => {
  test("connects, opens / with its three folders, and shows a stream's nine columns", async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill(String(stub.port));
    await dialog.locator("#user").fill("studio-reader");
    await dialog.locator("#password").fill(READER_PASSWORD);
    await dialog.locator("#amqpPort").fill("5672");
    await dialog.getByRole("button", { name: "Establish Connection" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 20_000 });

    await expect(row(page, "/")).toBeVisible({ timeout: 20_000 });
    await expect(row(page, "billing")).toBeVisible();
    for (const folder of ["Streams", "Queues", "Exchanges"]) {
      // oxlint-disable-next-line no-await-in-loop -- one folder at a time, so a failure names its folder.
      await expect(row(page, folder).first()).toBeVisible({ timeout: 20_000 });
    }
    if ((await row(page, "Streams").getAttribute("aria-expanded")) !== "true") await row(page, "Streams").click();
    // Expanded, not clicked: a click runs the stream read, which needs an AMQP broker this stub does not open.
    await row(page, "st-orders").getByRole("button", { name: "Expand st-orders" }).click();
    for (const column of [
      "offset",
      "timestamp",
      "exchange",
      "routing_key",
      "headers",
      "properties",
      "payload",
      "payload_encoding",
      "payload_bytes",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one column at a time, so a failure names its column.
      await expect(page.getByText(column, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    }
    expect(stub.unrecorded).toEqual([]);
  });

  test("the default exchange sorts first under its broker label", async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill(String(stub.port));
    await dialog.locator("#user").fill("studio-reader");
    await dialog.locator("#password").fill(READER_PASSWORD);
    await dialog.locator("#amqpPort").fill("5672");
    await dialog.getByRole("button", { name: "Establish Connection" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 20_000 });
    await row(page, "Exchanges").click();
    await expect(row(page, "(AMQP default)")).toBeVisible({ timeout: 20_000 });
    expect(stub.unrecorded).toEqual([]);
  });
});
