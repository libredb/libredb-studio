import { expect, test, type Page } from "@playwright/test";

/**
 * The NETCONF provider in a browser, against the fixture on 127.0.0.1:1830
 * (`docker/netconf/README.md`).
 *
 * WHY THIS FILE EXISTS, AND IT IS NOT COVERAGE. The heaviest defect of this engine's night was
 * that NETCONF could not be connected FROM THE SCREEN AT ALL, and no layer caught it. The host key
 * fingerprint was declared in `connectionFields`, the form carried its state, `buildConnection`
 * saved it - and `ConnectionModal.tsx` drew no box for it. The provider refuses every connection
 * without one ("this connection needs the device's host key fingerprint"), so a reader could reach
 * the dialog, fill in everything the dialog offered, and never connect.
 *
 * Every layer below was green while that was true, and each for a good reason: the unit tests pass
 * the fingerprint in as a field, the integration test replays a session that already has one, and
 * the live check builds its connection in TypeScript. None of them opens the dialog. The compiler
 * held the state side - a field added to `connectionFields` with no setter fails the typecheck -
 * and the drawing side had no such hold at all.
 *
 * So the first describe below asserts the box is drawn, and it needs no device: it is the guard
 * against that defect returning, and it runs wherever this suite runs.
 *
 * MEASURED, both ways, in a Linux container with Node and the browsers (see
 * `docker/netconf/e2e-project.md` for why not on the workstation). With the drawing code in
 * place, 8 of 8 pass. With it pulled back out, 6 of the 8 go red: the two cases that name the box
 * fail with "expected visible, received hidden" on `#hostKeyFingerprint`, and all four reads fail
 * because there is no box to put the fingerprint in, which is the defect itself. The two that
 * stay green are the two ABSENCE cases, which do not depend on the box and should not - an
 * absence that went red here would be an absence standing in for something else.
 *
 * IT NEEDS THE FIX TO BE GREEN. The box is drawn by `c64e4dcc9` ("fix(ui): draw the host key
 * fingerprint, and derive the field census from the table"), which is not on this branch: on a
 * tree without it this file is red for the right reason, which is also the reason it exists.
 *
 * The second describe connects and reads, which needs the fixture AND two values that are not in
 * this file: the device's password and its host key fingerprint. Neither is committed - a password
 * in a repository is a published credential whatever it unlocks, and the fingerprint is generated
 * when the image is BUILT, so a constant here would be wrong on the next build. Without them these
 * cases are SKIPPED, which is a third state and not a pass: a CI step that runs this suite without
 * setting them has measured the dialog and nothing else, and its own output says so.
 *
 *   export NETCONF_E2E_FINGERPRINT="$(ssh-keyscan -T 5 -p 1830 127.0.0.1 2>/dev/null | ssh-keygen -lf - | awk '{print $2}')"
 *   export NETCONF_E2E_PASSWORD=...     # the read-only account named in docker/netconf/README.md
 *
 * It stays on the shared server rather than taking one of its own: it never clicks Test
 * Connection, which is what spends the account's per-process rate-limit bucket and what the
 * second-server projects in `playwright.config.ts` exist for (`docker/netconf/e2e-project.md`).
 */

/**
 * Where the device is, which is not always loopback on 1830.
 *
 * The address is read rather than fixed because the suite does not always run beside the fixture:
 * on a machine whose runner is a container, the device is reached by its own name on the compose
 * network instead. The fingerprint and password are read for their own reasons, below.
 */
const FIXTURE = {
  host: process.env.NETCONF_E2E_HOST ?? "127.0.0.1",
  port: process.env.NETCONF_E2E_PORT ?? "1830",
  user: process.env.NETCONF_E2E_USER ?? "ro-pass",
};
const FINGERPRINT = process.env.NETCONF_E2E_FINGERPRINT ?? "";
const PASSWORD = process.env.NETCONF_E2E_PASSWORD ?? "";

/** The fixture's first interface, whose name carries the slash that the key path has to escape. */
const FIRST_INTERFACE = "ge-0/0/0";
const READ = JSON.stringify({ datastore: "running", path: "ietf-interfaces:interfaces", limit: 5 });
const WRITE = "<edit-config><target><running/></target></edit-config>";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });
}

test.describe("NETCONF in the connection dialog", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "New connection", exact: true }).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[role="dialog"]').getByRole("button", { name: "NETCONF", exact: true }).click();
  });

  test("the host key fingerprint has a box, which is what this engine could not be reached without", async ({
    page,
  }) => {
    // THE DEFECT, as a reader met it: everything else about this engine worked and this box was
    // not on the screen, so every connection was refused by the provider for a field the dialog
    // never asked for.
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.locator("#hostKeyFingerprint")).toBeVisible();
    await expect(dialog.getByText("Host key fingerprint", { exact: false })).toBeVisible();
  });

  test("the box says what goes in it, which is a digest and not a password", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    const field = dialog.locator("#hostKeyFingerprint");
    // The placeholder is the spelling `ssh-keygen -lf` prints, so a reader knows which of the two
    // fingerprints a device shows them is wanted. `hostkey.ts` refuses the MD5 form by name.
    await expect(field).toHaveAttribute("placeholder", /SHA256:/);
    // Not a password box: what goes in it is public material, and a masked box would invite a
    // reader to paste a credential into it.
    await expect(field).not.toHaveAttribute("type", "password");
    // Pasted text, so every helpful transformation is off: an autocorrected digest is a digest
    // that does not match.
    await expect(field).toHaveAttribute("spellcheck", "false");
    await expect(field).toHaveAttribute("autocomplete", "off");
  });

  test("it is its own box, and not the certificate one borrowed", async ({ page }) => {
    // ABSENCE, and a declared one: `netconf` lists `hostKeyFingerprint` in `connectionFields` and
    // does NOT list `serverCertificateThumbprint`. A host key is not a certificate, the two are
    // checked by different code, and one box for both would carry a label that is wrong half the
    // time. The selector is not vacuous: `opcua-provider.spec.ts` asserts the same id IS drawn.
    await expect(page.locator('[role="dialog"]').locator("#serverCertificateThumbprint")).toHaveCount(0);
  });

  test("no SSL / TLS panel is offered, because this transport's security is its own", async ({ page }) => {
    /*
     * ABSENCE tied to `showSslPanel: false`, and the third of this engine's three. It is measured
     * HERE and not only in the two tests that already hold it, because those two are joined by a
     * mock: `tests/unit/lib/db-ui-config.test.ts` pins that the REAL entry declares `false`, and
     * `tests/components/ConnectionModal.test.tsx` pins that `false` removes the panel - but it
     * declares that flag on a MOCK entry, so neither one draws the real netconf entry on a screen.
     *
     * This is also the absence whose reason the config calls the worst of the three: the panel was
     * not answered with a word this engine does not know, it was read by nothing at all, so a
     * reader who chose `verify-full` was shown no objection and given no verification either.
     *
     * The selector is not vacuous: `ConnectionModal.test.tsx` asserts this same text IS drawn for
     * an engine that declares no flag, and Kafka's case asserts it is kept.
     */
    await expect(page.locator('[role="dialog"]').getByText("SSL / TLS", { exact: false })).toHaveCount(0);
  });

  test("no connection string is offered, because this protocol has no address to paste", async ({ page }) => {
    // ABSENCE tied to `showConnectionStringToggle: false`. MEASURED in the config's own comment:
    // `netconf://host:830`, `ssh://host:830` and a bare `host:830` are all answered `null` by the
    // shared parser, so a box here would offer a reading nothing can do.
    await expect(page.locator('[role="dialog"]').getByText("Connection String", { exact: false })).toHaveCount(0);
  });
});

test.describe("a read of the fixture, as a reader sees it", () => {
  test.skip(
    FINGERPRINT === "" || PASSWORD === "",
    "NETCONF_E2E_FINGERPRINT and NETCONF_E2E_PASSWORD are not set, so no device was dialled: the dialog was " +
      "measured and the reads were not (docker/netconf/README.md says how to read both)",
  );

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "New connection", exact: true }).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole("button", { name: "NETCONF", exact: true }).click();
    await dialog.locator("#host").fill(FIXTURE.host);
    await dialog.locator("#port").fill(FIXTURE.port);
    await dialog.locator("#user").fill(FIXTURE.user);
    await dialog.locator("#password").fill(PASSWORD);
    await dialog.locator("#hostKeyFingerprint").fill(FINGERPRINT);
    await dialog.getByRole("button", { name: "Establish Connection" }).click();
    // The dialog closes only when the device answered: `connect()` dials, checks the host key,
    // exchanges hellos and reads the YANG library before this returns. So a closed dialog here is
    // the connection claim, and it is the one the fingerprint box above is for.
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15000 });
  });

  async function run(page: Page, statement: string): Promise<void> {
    await page.evaluate((text) => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
        .monaco;
      monaco?.editor.getEditors()[0]?.setValue(text);
    }, statement);
    // The button, not the shortcut. The editor's hint reads "Cmd/Ctrl+Enter", and a spec that
    // presses one of them passes on the platform it was written on and quietly runs nothing on the
    // other: MEASURED on this machine, the statement reached the editor and the panel still read
    // "Ready to query". Six specs in this suite click RUN, for this reason.
    await page.getByRole("button", { name: "RUN", exact: true }).click();
  }

  test("a read answers rows the device sent, with the slash in the name intact", async ({ page }) => {
    await run(page, READ);
    // `ge-0/0/0` is the value that makes the key path percent-encode at all, and the grid is where
    // a reader sees whether it survived the round trip as itself rather than as `%2F`.
    await expect(page.getByText(FIRST_INTERFACE, { exact: false }).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("%2F", { exact: false })).toHaveCount(0);
  });

  test("a write is refused on screen, in the provider's own words", async ({ page }) => {
    // The refusal a user actually meets. It is this provider's own and costs the device nothing:
    // `enforcesReadOnly` is structural here, there being no code in the provider that builds a
    // write, and the sentence says which five operations it does send.
    await run(page, WRITE);
    /*
     * By the panel's own test id, and that is a correction rather than a preference. Written as a
     * page-wide text search this failed with a strict mode violation: the sentence is on screen
     * TWICE, once in `run-failure-message` and once in the toast, which is the product being
     * louder than the assertion expected. Bound to the panel, it says where a reader finds it
     * after the toast has gone.
     */
    await expect(page.getByTestId("run-failure-message")).toContainText("reads a device and does not write to it", {
      timeout: 30000,
    });
    // And it is the provider's whole sentence, which names what this engine DOES send: a refusal
    // that only said no would leave a reader guessing what the connection is for.
    await expect(page.getByTestId("run-failure-message")).toContainText("get-schema and close-session");
  });

  test("no cell opens an editor, because nothing here can be written", async ({ page }) => {
    await run(page, READ);
    const cell = page.getByText(FIRST_INTERFACE, { exact: false }).first();
    await expect(cell).toBeVisible({ timeout: 30000 });
    await cell.dblclick();
    /*
     * By the editor's own shape, not by a grid role this grid does not use. A first writing of the
     * Modbus spec looked for `[role='gridcell'] input, td input`, which matches nothing here
     * whatever the product does - an absence true for the selector's reason rather than the
     * engine's. The cell editor is an `<input autoFocus>` (`ResultsGrid.tsx:736`), so if one had
     * opened it would be THE focused input on the page; the query editor is Monaco, whose own
     * field is a textarea.
     */
    await expect(page.locator("input:focus")).toHaveCount(0);
  });

  test("no Explain tab is offered, because a device plans nothing", async ({ page }) => {
    await run(page, READ);
    await expect(page.getByText(FIRST_INTERFACE, { exact: false }).first()).toBeVisible({ timeout: 30000 });
    // ABSENCE tied to `supportsExplain: false`. By the test id the panel carries for exactly this
    // ambiguity: the tabs are plain buttons, not `role="tab"`, and the query editor renders an
    // "Explain" button of its own. `e2e/explain-sqlite.spec.ts` asserts this same id IS visible on
    // an engine that declares `explainFormat`, which keeps this absence from being the selector's.
    await expect(page.getByTestId("bottom-panel-tab-explain")).toHaveCount(0);
  });
});

/**
 * The Keys panel, through the route, in both spellings a reader can arrive with.
 *
 * WHY THIS IS AN E2E CASE AND NOT A UNIT ONE. The defect these two steps hold was in the SEAM
 * between the keys route and the provider: the route holds a level page to rows sitting directly
 * under the pattern (`api/db/keys/scan/route.ts:215-219`), the provider answered the level BELOW,
 * and no test saw it because every unit and integration test calls `scanKeysPage` DIRECTLY. The
 * panel is this engine's only tree surface, and both documented spellings showed a reader nothing:
 *
 *   running/ietf-interfaces:interfaces    every key held a separator after the pattern, so the
 *                                         route answered 500 and blamed the provider
 *   running/ietf-interfaces:interfaces/   `parseKeyPath` kept the trailing empty piece as a node
 *                                         named "", and the panel drew an empty folder
 *
 * A screen check found it and a screen check does not run again. These two steps are what runs.
 */
test.describe("the Keys panel, as a reader reaches it", () => {
  test.skip(
    FINGERPRINT === "" || PASSWORD === "",
    "NETCONF_E2E_FINGERPRINT and NETCONF_E2E_PASSWORD are not set, so no device was dialled",
  );

  /** The node whose children the fixture serves, and the spelling that names its level. */
  const LEVEL = "running/ietf-interfaces:interfaces/";
  /** The same node with no trailing separator: a prefix, not a level. */
  const NOT_A_LEVEL = "running/ietf-interfaces:interfaces";

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "New connection", exact: true }).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole("button", { name: "NETCONF", exact: true }).click();
    await dialog.locator("#host").fill(FIXTURE.host);
    await dialog.locator("#port").fill(FIXTURE.port);
    await dialog.locator("#user").fill(FIXTURE.user);
    await dialog.locator("#password").fill(PASSWORD);
    await dialog.locator("#hostKeyFingerprint").fill(FINGERPRINT);
    await dialog.getByRole("button", { name: "Establish Connection" }).click();
    await expect(dialog).toBeHidden({ timeout: 30000 });
    await page.getByRole("tab", { name: "Keys", exact: true }).click();
    await expect(page.getByTestId("key-browser-panel")).toBeVisible({ timeout: 15000 });
  });

  test("a prefix ending in the separator lists the level, and the route accepts every row", async ({ page }) => {
    const box = page.getByLabel("Key prefix");
    await box.fill(LEVEL);
    await box.press("Enter");

    const panel = page.getByTestId("key-browser-panel");
    // One entry, and it is a FOLDER: `LevelEntry.kind` says which, and both kinds used to be sent
    // as keys, so the panel offered nothing to open on an engine whose key space is a tree.
    await expect(panel).toContainText("interface/", { timeout: 30000 });
    await expect(panel).toContainText("1 entry listed");
    // No error at all, which is the half the route decides: a row outside the level is a 500 and
    // the panel would be showing that sentence instead of a folder.
    await expect(page.getByTestId("key-browser-error")).toHaveCount(0);
  });

  test("a prefix with no separator is refused by name, and the refusal shows the one that works", async ({ page }) => {
    const box = page.getByLabel("Key prefix");
    await box.fill(NOT_A_LEVEL);
    await box.press("Enter");

    const error = page.getByTestId("key-browser-error");
    // Refused BY NAME. This is the spelling the provider's own sentence used to teach, and it names
    // the datastore's top level, which this engine cannot read because an unfiltered read of a
    // datastore is the one read it does not send.
    await expect(error).toContainText("ends with the separator", { timeout: 30000 });
    // And the sentence shows the prefix that works, so a reader is not left to guess the one
    // character that was missing.
    await expect(error).toContainText(LEVEL);
    /*
     * NOT the route's 500. That sentence blames the provider for leaving the level it was asked
     * for, and it is what a reader met here before the walk split the pattern at its last
     * separator. If it ever comes back, this is the line that says so.
     */
    await expect(error).not.toContainText("outside the level it was asked for");
  });
});
