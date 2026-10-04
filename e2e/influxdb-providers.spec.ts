import { expect, type Locator, type Page, test } from "@playwright/test";
import { INFLUX_CONNECTION_SENTENCES } from "../src/lib/db/providers/timeseries/influxdb/connection-options";

/**
 * Gate 5 for the two InfluxDB connection types (InfluxDB spec, SPEC-delivery D), one spec for the pair as
 * e2e/search-providers.spec.ts is for Elasticsearch and OpenSearch.
 *
 * What a new type-id needs in order to be SELECTABLE lives outside the provider, as declarations
 * (`DatabaseUIConfig`, the shared icon, the consent field), which is why this runs in a browser. The refusal a
 * secret without TLS gets is checked through Test Connection, once per type, which the server answers before any
 * socket opens (a `.invalid` host is never resolved), so no InfluxDB is needed. It runs on the second server because
 * Test Connection spends the shared account's per-process rate-limit bucket, and it signs in as the admin for the
 * reason e2e/neo4j-provider.spec.ts gives. The secret it types is a stand-in written here.
 */
const TYPES = [
  {
    label: "InfluxDB (InfluxQL)",
    port: "8086",
    color: "text-hue-purple-alt",
    passwordLabel: "Password or token",
    hints: {
      password: "1.x: the user's password. 2.x and InfluxDB 3: an API token, with User empty.",
      database:
        'A 1.x database, a 2.x bucket, or an InfluxDB 3 database: the default for a run, not a filter. Empty: the only database the credential can list, or name it in the statement as "db".."measurement".',
    },
  },
  {
    label: "InfluxDB 3 (SQL)",
    port: "8181",
    color: "text-hue-violet-alt",
    passwordLabel: "Token",
    hints: {
      password:
        "Empty only for a server started with --without-auth. On InfluxDB 3 Core every token is an admin token.",
      database:
        "The one InfluxDB 3 database this connection reads. Empty: the only database the token can list; with more than one, set it here.",
    },
  },
] as const;

const HOST_HINT =
  "A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443.";
const CONSENT_HINT =
  "Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked.";
const READ_ONLY_HINT = "InfluxDB connections are read-only whether or not this is ticked: Studio sends no write.";
const TEST_HOST = "influx-e2e.invalid";
// Not "password": the refusal itself says "password or token", so the not-repeated check needs a word it never holds.
const TEST_SECRET = "standin-not-a-token";

function dialogOf(page: Page): Locator {
  return page.locator('[role="dialog"]');
}

function typeButton(page: Page, label: string): Locator {
  return dialogOf(page).getByRole("button", { name: label, exact: true });
}

test.describe("InfluxDB (InfluxQL) and InfluxDB 3 (SQL) in the connection dialog", () => {
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
    await expect(dialogOf(page)).toBeVisible({ timeout: 5000 });
  });

  test("both types are offered with the shared icon in two distinct colours", async ({ page }) => {
    const [influxql, influxsql] = TYPES.map((type) => typeButton(page, type.label));
    await expect(influxql).toBeVisible();
    await expect(influxsql).toBeVisible();
    // One product, two connection types: the same mark drawn for Studio.
    expect(await influxql.locator("svg").innerHTML()).toBe(await influxsql.locator("svg").innerHTML());

    // A type's icon takes its colour only while that type is selected, so each is read after its own click.
    const colourOf = async (type: (typeof TYPES)[number]): Promise<string> => {
      const icon = typeButton(page, type.label).locator("svg");
      await typeButton(page, type.label).click();
      await expect(icon).toHaveClass(new RegExp(`\\b${type.color}\\b`));
      return icon.evaluate((element) => getComputedStyle(element).color);
    };
    const influxqlColour = await colourOf(TYPES[0]);
    const influxsqlColour = await colourOf(TYPES[1]);
    expect(influxqlColour).not.toBe(influxsqlColour);
  });

  test("InfluxDB (InfluxQL) prefills 8086 and draws Host, Port, User, Password or token and Database with their hints", async ({
    page,
  }) => {
    const [type] = TYPES;
    const dialog = dialogOf(page);
    await typeButton(page, type.label).click();

    await expect(dialog.locator("#port")).toHaveValue(type.port);
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
    await Promise.all(
      ["#host", "#port", "#user", "#password", "#database"].map((id) => expect(dialog.locator(id)).toBeVisible()),
    );
    await expect(dialog.getByText(type.passwordLabel, { exact: true })).toBeVisible();
    await expect(dialog.getByTestId("host-hint")).toHaveText(HOST_HINT);
    await expect(dialog.getByTestId("password-hint")).toHaveText(type.hints.password);
    await expect(dialog.getByTestId("database-hint")).toHaveText(type.hints.database);
  });

  test("InfluxDB 3 (SQL) prefills 8181 and draws Host, Port, Token and Database with their hints, and no User", async ({
    page,
  }) => {
    const [, type] = TYPES;
    const dialog = dialogOf(page);
    await typeButton(page, type.label).click();

    await expect(dialog.locator("#port")).toHaveValue(type.port);
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
    await Promise.all(
      ["#host", "#port", "#password", "#database"].map((id) => expect(dialog.locator(id)).toBeVisible()),
    );
    // InfluxDB 3 has no user name: its token is the password.
    await expect(dialog.locator("#user")).toHaveCount(0);
    await expect(dialog.getByText(type.passwordLabel, { exact: true })).toBeVisible();
    await expect(dialog.getByTestId("host-hint")).toHaveText(HOST_HINT);
    await expect(dialog.getByTestId("password-hint")).toHaveText(type.hints.password);
    await expect(dialog.getByTestId("database-hint")).toHaveText(type.hints.database);
  });

  for (const type of TYPES) {
    test(`${type.label} draws the TLS and SSH panels and the Read-only hint`, async ({ page }) => {
      const dialog = dialogOf(page);
      await typeButton(page, type.label).click();

      await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
      await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
      await expect(dialog.getByLabel("Read-only", { exact: true })).toBeVisible();
      await expect(dialog.locator("#readOnly-hint")).toHaveText(READ_ONLY_HINT);
    });

    test(`${type.label} draws the consent box with the InfluxDB hint only while SSL mode is disable`, async ({
      page,
    }) => {
      const dialog = dialogOf(page);
      await typeButton(page, type.label).click();

      const consent = dialog.getByLabel("Send the password without TLS", { exact: true });
      await expect(consent).toBeVisible();
      await expect(dialog.locator("#allowInsecureAuth-hint")).toHaveText(CONSENT_HINT);

      await dialog.getByText("SSL / TLS", { exact: true }).click();
      await dialog.getByRole("button", { name: "require", exact: true }).click();
      await expect(consent).toHaveCount(0);

      await dialog.getByRole("button", { name: "disable", exact: true }).click();
      await expect(consent).toBeVisible();
    });

    test(`${type.label}: a secret with TLS off to a non-loopback host is refused on Test Connection before any socket`, async ({
      page,
    }) => {
      const dialog = dialogOf(page);
      await typeButton(page, type.label).click();
      await dialog.locator("#host").fill(TEST_HOST);
      await dialog.locator("#password").fill(TEST_SECRET);
      await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

      const result = dialog.getByTestId("connection-test-result");
      await expect(result).toContainText(INFLUX_CONNECTION_SENTENCES.plaintext, { timeout: 15000 });
      // The sentence names the three ways out and never repeats the host or the secret.
      await expect(result).not.toContainText(TEST_HOST);
      await expect(result).not.toContainText(TEST_SECRET);
    });
  }
});
