import { test, expect } from "@playwright/test";

/**
 * Gate 2 and gate 5 for the Apache Kafka provider (#1088).
 *
 * The unit and integration tests drive the provider over a recorded client, so they prove the code
 * is right and nothing about whether a user can reach it. Everything a new type-id needs in order to
 * be SELECTABLE lives outside the provider, and several of those surfaces are not type-enforced,
 * which is why this runs in a browser.
 *
 * The assertions specific to this engine are the absent Database box and SSH Tunnel panel, and the
 * SASL mechanism select: Kafka is the first engine whose dialog renders a select from
 * `DatabaseUIConfig.fieldOptions` and hides the tunnel through `showSshTunnel: false`. The refusal a
 * mechanism without TLS gets is checked through Test Connection, which the server answers before any
 * socket opens, so no broker is needed; it is asserted by its own text, because the refusal of a user
 * with no mechanism would also appear if the select's value never reached the connection.
 */
test.describe("Apache Kafka in the connection dialog", () => {
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
      page.locator('[role="dialog"]').getByRole("button", { name: "Apache Kafka", exact: true }),
    ).toBeVisible();
  });

  test("selecting Apache Kafka prefills port 9092 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Apache Kafka", exact: true }).click();

    await expect(dialog.locator('input[value="9092"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("renders no Database box and no SSH Tunnel toggle, while its own fields and the TLS panel are there", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Apache Kafka", exact: true }).click();

    // The control first: the form for this engine rendered, with its host, user and TLS toggle.
    // Without it, an absent box or toggle could mean a form that never rendered at all.
    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#user")).toBeVisible();
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    // One connection is one cluster, and a tunnel cannot carry the addresses the brokers advertise.
    await expect(dialog.locator("#database")).toHaveCount(0);
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toHaveCount(0);
  });

  test("the SASL select offers none and the three mechanisms, with its hint", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Apache Kafka", exact: true }).click();

    const select = dialog.locator("select#saslMechanism");
    await expect(dialog.locator('label[for="saslMechanism"]')).toHaveText("SASL mechanism");
    await expect(select.locator("option")).toHaveText(["None", "PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"]);
    await expect(select).toHaveValue("");
    await expect(dialog.getByText("PLAIN and SCRAM require TLS", { exact: true })).toBeVisible();
  });

  test("a mechanism with TLS off is refused on test connection because it requires TLS", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Apache Kafka", exact: true }).click();
    await dialog.locator("select#saslMechanism").selectOption("SCRAM-SHA-512");
    await dialog.locator("#user").fill("reader");
    await dialog.locator("#password").fill("x");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("SCRAM-SHA-512 requires TLS", { timeout: 15000 });
    await expect(result).not.toContainText("needs a SASL mechanism");
  });

  test("a user with no mechanism gets the missing-mechanism refusal instead", async ({ page }) => {
    // The control for the test above: the same form without a mechanism reaches the other
    // refusal, so the TLS refusal there is what the select's value produced.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Apache Kafka", exact: true }).click();
    await dialog.locator("#user").fill("reader");
    await dialog.locator("#password").fill("x");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("needs a SASL mechanism", { timeout: 15000 });
    await expect(result).not.toContainText("requires TLS");
  });

  test("another engine draws its Database box and SSH Tunnel toggle", async ({ page }) => {
    // The control for the absent box and toggle: PostgreSQL takes a database and a tunnel, so the
    // locators the Kafka test expects to find nothing find both here.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();

    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
    await expect(dialog.locator("select#saslMechanism")).toHaveCount(0);
  });
});
