import { expect, test } from "@playwright/test";
import { READ_ONLY_FIXED_HINT } from "../src/lib/db-ui-config";

/**
 * The OPC UA entry in a real browser (#1677).
 *
 * The unit and integration suites drive the provider over a recorded server and an in-process one,
 * so they prove the code is right and nothing about whether a reader can reach it. What a new
 * type-id needs in order to be SELECTABLE lives outside the provider, and this entry's own two
 * fields are declarations (`DatabaseUIConfig`) that only a render turns into controls — which is the
 * bug this file exists for: both were declared, labelled and hinted while the dialog drew neither.
 *
 * No server is needed. Every refusal asserted here is answered before a socket opens: the endpoint
 * URL's scheme, and the password that would cross the network with nothing encrypting it.
 */
test.describe("OPC UA in the connection dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

    const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
    await sidebarButtons.first().click();
  });

  test("is offered as its own driver", async ({ page }) => {
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "OPC UA", exact: true })).toBeVisible();
  });

  test("the address is one endpoint URL, with no connection string beside it", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "OPC UA", exact: true }).click();

    await expect(dialog.getByText("Endpoint URL", { exact: true })).toBeVisible();
    await expect(dialog.locator("#host")).toHaveAttribute("placeholder", "opc.tcp://plc.example.net:4840/");
    // NO PORT BOX, and that is the point of this engine's address: the endpoint URL carries its own
    // port, so a second box beside it could only disagree with the URL the reader typed. An earlier
    // draft drew one "for orientation" pre-filled with 4840, and this assertion was written against
    // that draft; the box is gone and the assertion now holds the absence in place.
    await expect(dialog.locator("#port")).toHaveCount(0);
    await expect(dialog.getByText("Port", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws the security mode as three buttons and the certificate pin as a box", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "OPC UA", exact: true }).click();

    await expect(dialog.getByText("Security mode", { exact: true })).toBeVisible();
    for (const mode of ["None", "Sign", "SignAndEncrypt"]) {
      await expect(dialog.getByRole("button", { name: mode, exact: true })).toBeVisible();
    }
    // SignAndEncrypt is the standing choice, because that is what an empty field means.
    await expect(dialog.getByRole("button", { name: "SignAndEncrypt", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(dialog.getByText("Server certificate", { exact: true })).toBeVisible();
    await expect(dialog.locator("#serverCertificateThumbprint")).toBeVisible();
  });

  test("draws the fixed Read-only label, since no setting is what makes it read-only", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "OPC UA", exact: true }).click();

    // A fixed label and no box: Studio has no write path on this engine, so there is no mode to choose.
    await expect(dialog.getByRole("checkbox", { name: "Read-only", exact: true })).toHaveCount(0);
    await expect(dialog.locator("#readOnly-label")).toHaveText("Read-only");
    await expect(dialog.locator("#readOnly-hint")).toHaveText(READ_ONLY_FIXED_HINT);
  });

  /** The scheme is refused before anything is dialled: there is no WebSocket transport in this version. */
  test("an endpoint in another scheme is refused on test connection", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "OPC UA", exact: true }).click();
    await dialog.locator("#host").fill("https://plc.example.net:4840/");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    await expect(dialog.getByTestId("connection-test-result")).toContainText(
      "This provider speaks opc.tcp:// only. There is no WebSocket or HTTPS transport in this version.",
      { timeout: 15000 },
    );
  });

  /** A password with no username names no identity, and the refusal says which half to supply. */
  test("a password with no username is refused, before any socket opens", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "OPC UA", exact: true }).click();
    await dialog.locator("#host").fill("opc.tcp://127.0.0.1:1/");
    await dialog.locator("#password").fill("secret");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    await expect(dialog.getByTestId("connection-test-result")).toContainText(
      "A password with no username names no identity.",
      { timeout: 15000 },
    );
  });

  test("another engine draws neither field, which is the control for the two above", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();

    await expect(dialog.getByText("Security mode", { exact: true })).toHaveCount(0);
    await expect(dialog.locator("#serverCertificateThumbprint")).toHaveCount(0);
    await expect(dialog.locator("#host")).toHaveAttribute("placeholder", "localhost");
  });
});
