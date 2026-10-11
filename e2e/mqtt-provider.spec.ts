import { expect, test } from "@playwright/test";

/**
 * Gate 2 and gate 5 for the MQTT provider (#1635).
 * The unit and integration tests drive the provider over a recorded transport, so they prove the code is
 * right and nothing about whether a user can reach it. What a new type-id needs in order to be SELECTABLE
 * lives outside the provider, and the connection dialog's fields for MQTT are declarations
 * (`DatabaseUIConfig`, `READ_ONLY_ENFORCED`), which is why this runs in a browser.
 *
 * The refusals here are answered before any socket opens, so no broker is needed: a `$share/` filter is
 * refused by the provider's own reader, and the two of them are asserted by their own text.
 *
 * One of these tests exists because a screenshot found what a unit test could not. The completeness
 * sentence shipped in `text-muted`, a SURFACE token, and rendered at 1.34:1 on the dark ground: the one
 * line that tells a reader the list may be incomplete was drawn in the colour of the panel behind it.
 */
test.describe("MQTT in the connection dialog", () => {
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
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "MQTT", exact: true })).toBeVisible();
  });

  test("selecting MQTT prefills port 1883 and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();

    await expect(dialog.locator('input[value="1883"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("renders the Topic filter in the Database box, relabelled, with the TLS and tunnel panels", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();

    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#user")).toBeVisible();
    await expect(dialog.locator("#password")).toBeVisible();
    // One connection reads one filter, carried in the Database field, as Oxia's carries a namespace.
    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.getByText("Topic filter", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toBeVisible();
  });

  test("the Topic filter's placeholder is the filter an empty box means", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();

    // `#` is what an empty filter subscribes to, so the placeholder is the value, not an example.
    await expect(dialog.locator("#database")).toHaveAttribute("placeholder", "#");
  });

  test("draws the field hints that say what is subscribed to and what is refused", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();

    await expect(
      dialog.getByText(
        "What to subscribe to. Empty means #, every topic except the broker's own $SYS tree, which no # filter reaches. A narrower filter reads less and finishes sooner. $share/, $queue/ and $exclusive/ are refused: each one takes messages away from the devices that need them, and no broker reports that it happened.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  /**
   * The read-only hint names the reason as structural, because it is: the provider's encoder has no
   * function that writes a PUBLISH and its CONNECT carries no Will, so the toggle cannot turn writing on.
   */
  test("draws the Read-only toggle, whose hint says the mode is not what makes it read-only", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();

    const box = dialog.getByLabel("Read-only", { exact: true });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await expect(dialog.locator("#readOnly")).toHaveAttribute("aria-describedby", "readOnly-hint");
    await expect(
      dialog.getByText(
        "MQTT connections are read-only whether or not this is ticked, and not by a setting: this provider has no code that can write a PUBLISH, and its CONNECT carries no Will.",
        { exact: true },
      ),
    ).toBeVisible();
  });

  /**
   * A shared subscription takes messages away from the devices subscribed beside Studio, and no broker
   * reports that it happened: every one we measured answers SUBACK Granted and then delivers less. The
   * refusal therefore has to land before the packet is sent, which is what this asserts.
   */
  test("a $share/ topic filter is refused on test connection, before any socket opens", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#database").fill("$share/group/sensors/#");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText(
      "A filter beginning $share/ is refused. It takes messages away from the devices subscribed beside us, the broker reports nothing when it happens, and a read-only tool must not be able to do that. Type the topic filter without the prefix.",
      { timeout: 15000 },
    );
  });

  test("a $queue/ filter is refused in the same words, which is the control for the one above", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#database").fill("$queue/sensors/#");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    await expect(dialog.getByTestId("connection-test-result")).toContainText("A filter beginning $queue/ is refused.", {
      timeout: 15000,
    });
  });

  /**
   * Case sensitivity is the point: `$SHARE/` in uppercase is an ordinary topic carrying real data, and a
   * case-insensitive check would refuse a reader the data they are entitled to see. The dialog gets past
   * the filter check and fails on the connection instead, which is how we know the filter was accepted.
   *
   * THE POSITIVE ASSERTION COMES FIRST, AND IT HAS TO. A bare negative `toContainText` is satisfied by an
   * absent locator, so this passed on the first poll before the dialog had rendered any result at all - and
   * would have kept passing if the uppercase filter WERE wrongly refused a moment later. Waiting for the
   * connection failure first means the negative is read against a result that exists.
   */
  test("an uppercase $SHARE/ is ordinary data and is not refused as a shared subscription", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MQTT", exact: true }).click();
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill("1");
    await dialog.locator("#database").fill("$SHARE/group/sensors/#");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    // Port 1 has nothing listening, so the filter was accepted and the dial is what failed.
    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("broker", { timeout: 15000 });
    await expect(result).not.toContainText("is refused. It takes messages away");
  });

  test("another engine draws no Topic filter, which is the control for the relabelled box", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();

    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.getByText("Topic filter", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Read-only", { exact: true })).toHaveCount(0);
  });
});
