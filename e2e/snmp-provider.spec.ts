import { expect, test } from "@playwright/test";

/**
 * The SNMP entry in a real browser (#1721).
 *
 * The unit and integration suites drive the provider over an in-process agent and over datagrams
 * recorded from the pinned fixture, so they prove the code is right and nothing about whether a
 * reader can reach it. What a new type-id needs in order to be SELECTABLE lives outside the
 * provider, and this entry's copy is a set of declarations (`DatabaseUIConfig`) that only a render
 * turns into controls.
 *
 * TWO OF THE ASSERTIONS HERE HOLD A DEFECT THAT WAS REAL. The connection record carries the
 * secret in its `password` field and the consent to sending it in clear in `allowInsecureAuth`,
 * and the dialog's own fallbacks name both wrongly for this protocol: it would write "Password"
 * over a community, and "Send the password without TLS" over a protocol that has no TLS to go
 * without. The second one was worse than wrong wording: until 14 October 2026 the entry did not
 * declare the consent at all, so the box was never drawn, and the provider refuses a v2c
 * connection to a host that is not loopback without it. Every agent outside this machine was
 * unreachable through the dialog, and nothing failed anywhere.
 *
 * No server is needed. Nothing here opens a socket: every control asserted is drawn from the
 * entry's declarations, which is why this spec is not in `SECOND_SERVER_SPECS` - that list is for
 * the specs that drive Test Connection.
 */
test.describe("SNMP in the connection dialog", () => {
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
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "SNMP", exact: true })).toBeVisible();
  });

  test("the address is a host and a port, with the agent's port standing", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "SNMP", exact: true }).click();

    await expect(dialog.locator('label[for="host"]')).toHaveText("Host");
    // NO LABEL OF ITS OWN ABOVE THE PORT BOX, and that is the house's shape rather than an
    // oversight: the port shares the Host row's label unless an engine declares one, and only
    // RabbitMQ does, because it has two ports to tell apart. This assertion was written the other
    // way round first and the browser said so, which is the whole reason this file exists.
    await expect(dialog.locator('label[for="port"]')).toHaveCount(0);
    // 161 is the agent's port, and it stands in the box rather than being typed from memory.
    await expect(dialog.locator("#port")).toHaveValue("161");
    // No connection string: SNMP has no such address, and a toggle offering one would be an
    // invitation to type something this provider cannot read.
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
  });

  test("the secret is labelled a community, not a password", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "SNMP", exact: true }).click();

    // A community is not a password: it names no user, it is one shared string, and a reader who
    // is asked for a "password" will look for the one their device does not have.
    await expect(dialog.locator('label[for="password"]')).toHaveText("Community");
    await expect(dialog.getByText("The read community.", { exact: false })).toBeVisible();
  });

  test("the consent to a community in clear is drawn, in this protocol's own words", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "SNMP", exact: true }).click();

    // The box the provider's own refusal points at. Without it a reader is told to consent to
    // something the screen never offered.
    await expect(
      dialog.getByLabel("Send the community in clear to an agent that is not on this machine"),
    ).toBeVisible();
    // And NOT the dialog's fallback sentence, which offers TLS. What v2c lacks is not a tunnel
    // under it but any transport security at all; v3's answer is USM, inside the message.
    await expect(dialog.getByText("Send the password without TLS", { exact: true })).toHaveCount(0);
  });

  test("no SSL / TLS panel is offered, because there is no session to secure", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "SNMP", exact: true }).click();

    /*
     * ABSENCE tied to `showSslPanel: false`, measured HERE as well as in the two tests that already
     * hold it, because those two are joined by a mock: `tests/unit/lib/db-ui-config.test.ts` pins
     * that the REAL entry declares `false`, and `tests/components/ConnectionModal.test.tsx` pins
     * that `false` removes the panel - but it declares the flag on a MOCK entry, so neither draws
     * the real snmp entry on a screen.
     *
     * The transport is bare UDP, so a certificate chain has no session to secure, and the consent
     * box right beside it says there is no transport security under a v2c datagram at all.
     */
    await expect(dialog.getByText("SSL / TLS", { exact: false })).toHaveCount(0);
    // The control, so the absence is not an empty dialog: the consent box IS drawn.
    await expect(
      dialog.getByLabel("Send the community in clear to an agent that is not on this machine"),
    ).toBeVisible();
  });

  test("no SSH Tunnel toggle is offered, because the shared tunnel carries TCP and this speaks UDP", async ({
    page,
  }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "SNMP", exact: true }).click();

    /*
     * ABSENCE tied to `showSshTunnel: false`, and NOT the same reason as the panel above. Something
     * would read this one: the factory opens a tunnel for any connection that carries one, with no
     * test on the engine, and then rewrites host and port to the tunnel's LOCAL TCP endpoint. This
     * provider would send datagrams to a port where a TCP listener sits, so the box would break the
     * connection it offers to carry.
     */
    await expect(dialog.getByText("SSH Tunnel", { exact: true })).toHaveCount(0);
    // The control, by the same reading as above: the address boxes are drawn.
    await expect(dialog.getByLabel("Host", { exact: true })).toBeVisible();
  });

  test("the read-only sentence says what makes it read-only", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "SNMP", exact: true }).click();

    // Read-only by construction rather than by a setting, and the sentence says which construction:
    // a reader who sees "read-only" beside a tick box may reasonably think the tick turns it off.
    await expect(dialog.getByText("SNMP connections are read-only", { exact: false })).toBeVisible();
  });
});
