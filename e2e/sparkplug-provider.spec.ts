import { connect } from "node:net";
import { expect, test } from "@playwright/test";

/**
 * Sparkplug B in the browser (#1720).
 *
 * The unit, integration and live layers drive the provider directly, so they say the code is
 * right and nothing about whether a user can reach it. What a new type-id needs in order to be
 * SELECTABLE lives outside the provider - the picker, the dialog's fields, the labels and the
 * read-only declaration are all `DatabaseUIConfig` and `READ_ONLY_ENFORCED` - which is why this
 * runs in a browser.
 *
 * ONE of these tests reaches the fixture of `docker/sparkplug/compose-service.yml` on
 * 127.0.0.1:1884, and it names its reason and SKIPS where no broker is listening: CI's "E2E
 * Tests" job starts no compose service, so a case that needs one cannot pass in the job it runs
 * in. The live connection itself is measured where a broker is actually started, in
 * the `Sparkplug B live check` step of `.github/workflows/ci.yml`, which is this layer's
 * complement rather than its duplicate -
 * holding one claim in two layers means whatever reddens one reddens the other, and that is
 * exactly what happened on #1798.
 *
 * The rest are answered before any socket opens, INCLUDING the refusal case: dialling a port with
 * nothing on it needs no fixture, which is why it carries no skip.
 *
 * ABSENCE IS ASSERTED HERE TOO, and on purpose: a spec that only claims what IS drawn passes
 * just as well on a dialog that draws everything. Sparkplug reads three connection fields and
 * no credential, so the user and password boxes must NOT be there; the connection-string toggle
 * must not be there either, because a broker address has no URI form that says more.
 */
const EMPTY_GROUP_HINT =
  "One Sparkplug group id, or empty for every group. A group is a level of the topic and nothing else: " +
  "it is not a thing on the broker that can be subscribed to on its own, so an empty field reads every " +
  "group under spBv1.0 and a filled one reads that group alone.";

const READ_ONLY_HINT =
  "Sparkplug connections are read-only whether or not this is ticked, and not by a setting: this " +
  "provider's encoder has no function that writes a PUBLISH, and its CONNECT carries no Will, which is " +
  "how a death certificate would be registered.";

const BROKER = { host: "127.0.0.1", port: 1884 } as const;

/**
 * Whether the compose fixture answers a TCP connect. A plain socket and not a request: the broker
 * speaks MQTT, so there is no URL to fetch, and the one thing this has to tell apart is a listener
 * from nothing at all. Two seconds is the budget; a broker on loopback answers in single-digit
 * milliseconds, and anything slower than this is not the fixture.
 */
const brokerIsUp = async (): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ ...BROKER, timeout: 2_000 });
    const settle = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });

test.describe("Sparkplug B in the connection dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New connection", exact: true }).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
  });

  test("is offered as its own driver", async ({ page }) => {
    await expect(
      page.locator('[role="dialog"]').getByRole("button", { name: "Sparkplug B", exact: true }),
    ).toBeVisible();
  });

  test("prefills 1883, the MQTT port Sparkplug runs over, and offers no connection string", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();

    await expect(dialog.locator('input[value="1883"]')).toBeVisible();
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("draws three boxes and NO credential boxes, because the read touches none", async ({ page }) => {
    // The absence half. A user and a password here would be collected and dropped: the provider
    // reads `host`, `port` and `database` and nothing else, so a box for either would be a
    // promise the read does not keep.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();

    await expect(dialog.locator("#host")).toBeVisible();
    await expect(dialog.locator("#database")).toBeVisible();
    await expect(dialog.locator("#user")).toHaveCount(0);
    await expect(dialog.locator("#password")).toHaveCount(0);
    // MQTT, which Sparkplug runs over, draws six boxes here and an insecure-auth toggle with
    // them; this provider reads three and declares no credential, so that toggle is absent too.
    await expect(dialog.locator("#allowInsecureAuth")).toHaveCount(0);
  });

  /**
   * THE PANEL HAS TO BE OPENED BEFORE ANYTHING ABOUT IT CAN BE MEASURED, which is why this case
   * clicks twice before it asserts. Measured on this dialog: with the SSL / TLS panel closed the
   * three boxes are not in the DOM at all, so a broadly written claim - "the dialog draws no
   * certificate box" or "no CA field is on the page" - stays green while the panel sits one click
   * away with all three. The case above this one is right about what it measures (`#user`,
   * `#password` and `#allowInsecureAuth` are absent) and its reason covers these boxes too, but it
   * never reaches them; this one does.
   *
   * WHAT IT PINS. The panel is offered because TLS is a real capability of this transport: 8883 is
   * the IANA TLS port for MQTT, and since #1720's TLS wiring the provider reads every one of these
   * three fields (`tests/integration/db/sparkplug-provider.test.ts`, the four SSL / TLS cases).
   * Hiding the panel would hide a working capability, so its disappearance should fail here.
   */
  test("the SSL / TLS panel, once opened, draws the three boxes the provider reads", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();

    // Closed: the absence that makes a broad assertion worthless.
    await expect(dialog.getByText("CA Certificate (PEM)", { exact: true })).toHaveCount(0);

    // OPENING IS NOT ENOUGH EITHER, and that is the second thing a broad claim would miss: the
    // mode starts at `disable` (`use-connection-form.ts`, `sslMode: "disable"`), and every box
    // below the mode row is drawn only where the mode is something else.
    await dialog.getByRole("button", { name: "SSL / TLS" }).click();
    await expect(dialog.getByTestId("ssl-mode-hint")).toBeVisible();
    await expect(dialog.getByText("CA Certificate (PEM)", { exact: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: "require", exact: true }).click();
    await expect(dialog.getByText("CA Certificate (PEM)", { exact: true })).toBeVisible();
    // `require` carries no client material, so the two client boxes are still absent here.
    await expect(dialog.getByText("Client Certificate (PEM)", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Client Private Key (PEM)", { exact: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: "verify-ca", exact: true }).click();
    await expect(dialog.getByText("CA Certificate (PEM)", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Client Certificate (PEM)", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Client Private Key (PEM)", { exact: true })).toBeVisible();
  });

  test("the Database box is NOT called Database, because the word would name the wrong thing", async ({ page }) => {
    // A group is a level of the topic, not a database on the broker, and the dialog says so by
    // never using the house word for this box. The absence is the claim.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();

    await expect(dialog.getByText("Group", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Database", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("Schema", { exact: true })).toHaveCount(0);
  });

  test("the Database box is labelled Group, with the hint that says what an empty one reads", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();

    await expect(dialog.getByText("Group", { exact: true })).toBeVisible();
    await expect(dialog.getByText(EMPTY_GROUP_HINT, { exact: true })).toBeVisible();
    // The placeholder is empty rather than an example, because an empty field is a MEANING here
    // (every group) and a greyed-out example would read as the value it takes when left alone.
    await expect(dialog.locator("#database")).toHaveAttribute("placeholder", "");
  });

  test("draws the Read-only toggle, whose hint says the mode is not what makes it read-only", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();

    const box = dialog.getByLabel("Read-only", { exact: true });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await expect(dialog.locator("#readOnly")).toHaveAttribute("aria-describedby", "readOnly-hint");
    await expect(dialog.getByText(READ_ONLY_HINT, { exact: true })).toBeVisible();
  });

  test("a group holding an MQTT filter character is refused before any socket opens", async ({ page }) => {
    // `+`, `#` and `/` are filter characters: a group holding one would either widen the
    // subscription past that group or make the filter invalid, and escaping it would hide the
    // mistake. The refusal lands before the dial, which is what this asserts.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#database").fill("Plant/Line1");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    await expect(dialog.getByTestId("connection-test-result")).toContainText(
      'A group name cannot contain "+", "#" or "/"',
      { timeout: 15000 },
    );
  });

  test("Test Connection reaches the fixture broker, with the Group left empty", async ({ page }) => {
    // SKIPPED AND NOT FAILED WHERE NO BROKER IS LISTENING, with the address in the reason. Skipped
    // is a third state beside passed and failed: it says this case MEASURED NOTHING here, which is
    // the honest answer in a job that starts no fixture, and it is not a quiet one - the runner
    // prints the reason. Where the fixture IS up, `docker compose -f
    // docker/sparkplug/compose-service.yml up -d`, the case runs and must pass; that arm is the
    // canary for this skip.
    const reachable = await brokerIsUp();
    // THE REASON IS PRINTED, not only recorded. MEASURED with the `list` reporter: a skipped case
    // shows its title with a `-` and NOT the reason behind it, which the HTML and JSON reporters do
    // carry. A reader of the job log would see a case that did not run and no word about why, and
    // "not measured" is only an honest third state when it says what it could not measure.
    if (!reachable) console.log(`SKIP: no broker is answering on ${BROKER.host}:${BROKER.port}`);
    test.skip(!reachable, `no broker is answering on ${BROKER.host}:${BROKER.port}`);
    // The empty Group is the case the dialog's own hint promises: every group under spBv1.0.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill("1884");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    // "Connected successfully" is the DIALOG's word. The route answers "Connection successful",
    // and asserting that string here passed every layer below and failed on the screen, which is
    // the one thing this layer is for.
    await expect(dialog.getByTestId("connection-test-result")).toContainText("Connected successfully", {
      timeout: 30000,
    });
  });

  test("a port with no broker is refused with a sentence that is not about an empty plant", async ({ page }) => {
    // The other half of the test above, and the distinction the provider exists to keep: nothing
    // listening is not the same as a broker with nothing on it.
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Sparkplug B", exact: true }).click();
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill("1");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();

    const result = dialog.getByTestId("connection-test-result");
    await expect(result).toContainText("Nothing was read", { timeout: 20000 });
    await expect(result).toContainText("not an empty broker", { timeout: 20000 });
  });
});
