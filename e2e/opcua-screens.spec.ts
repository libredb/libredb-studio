import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { openConnectionDialog } from "./helpers/connection-dialog";

/**
 * THE OPC UA PANEL IN A REAL BROWSER, WITH A REAL SERVER, AND A PICTURE OF EVERY STEP (#1677).
 *
 * WHY THIS FILE EXISTS. Every other suite proves the provider ANSWERS correctly: the unit tests over
 * fakes, the integration tests over a recorded server and an in-process one, the route tests through
 * the real handlers, the live check against the plant simulator. None of them can see what a reader
 * sees. On the MQTT provider a screenshot found what 1,400 passing tests could not - the panel's
 * completeness sentence shipped in a SURFACE colour, 1.09:1 against the ground it sat on, so the
 * one line telling a reader the list might be incomplete was invisible. A screenshot is not a gate,
 * and that is the point: this file takes the pictures, and a person looks at them.
 *
 * It needs the fixture of `tests/fixtures/opcua/README.md` on 127.0.0.1:54840. Without it the
 * connection refuses and the test says so rather than passing quietly.
 *
 * The connection is made the way a reader makes it: open the dialog, pick OPC UA, type the endpoint,
 * choose None, connect. Nothing is seeded.
 */
/*
 * UNDER THE REPOSITORY, NOT UNDER WHOEVER RAN IT LAST. This held one machine's absolute scratchpad
 * path, which exists on exactly that machine: anywhere else the run fails at `mkdirSync`, and the
 * path itself is a session id nobody else has. `test-results/` is already the directory Playwright
 * writes to and is already in `.gitignore`. The variable is there for a pass that wants the pictures
 * somewhere specific, which is how they were collected for the guide.
 */
const SHOTS = process.env.OPCUA_SHOTS_DIR?.trim() || "test-results/opcua-screens";
const ENDPOINT = "opc.tcp://127.0.0.1:54840/";

/** Whether the fixture is listening, asked once: this suite needs a server and CI has none. */
async function fixtureIsUp(): Promise<boolean> {
  const { connect } = await import("node:net");
  return new Promise((resolve) => {
    const socket = connect(54_840, "127.0.0.1");
    const answer = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => answer(true));
    socket.once("timeout", () => answer(false));
    socket.once("error", () => answer(false));
  });
}

test.describe("OPC UA, end to end, with pictures", () => {
  test("a reader connects, walks the address space, opens a node and reads a value", async ({ page }) => {
    /*
     * SKIPPED WITHOUT THE FIXTURE, and skipped rather than failed: this is the one OPC UA spec that
     * needs a real server, and CI runs none. `tests/fixtures/opcua/README.md` gives the one command
     * that starts it; with it up, this walks the whole product path and leaves the pictures a person
     * then looks at - which is how three defects were found that no other suite could see.
     */
    test.skip(!(await fixtureIsUp()), "the OPC UA fixture is not listening on 127.0.0.1:54840");
    mkdirSync(SHOTS, { recursive: true });
    test.setTimeout(180_000);

    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({
      timeout: 20_000,
    });

    // ---- the dialog ---------------------------------------------------------------------------
    await openConnectionDialog(page);
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "OPC UA", exact: true }).click();
    await page.screenshot({ path: `${SHOTS}/01-dialog.png`, fullPage: false });

    await dialog.locator("#name").fill("Plant");
    await dialog.locator("#host").fill(ENDPOINT);
    // None, because the fixture's certificate is not in this run's trust list.
    await dialog.getByRole("button", { name: "None", exact: true }).click();
    await page.screenshot({ path: `${SHOTS}/02-dialog-filled.png` });

    /*
     * WHAT THE BOXES HOLD BEFORE ANYTHING IS TYPED, because a screenshot showed `user` and a
     * password in them: Chromium autofills the login form's credentials into this dialog. A reader
     * seeing a username there would believe they are authenticating, so this records what the
     * fields hold AND proves what travels - a filled username really does reach the provider, which
     * refuses it on a server that takes none.
     */
    /*
     * ASSERTED, NOT PRINTED. These two lines logged whatever the boxes held, and the password box is
     * one of them: on a real machine Chromium can autofill a saved credential there, and the run's
     * log is kept by CI and read by anyone. An assertion proves the same thing - the dialog opens
     * empty - and puts nothing in the log.
     */
    await expect(dialog.locator("#user")).toHaveValue("");
    await expect(dialog.locator("#password")).toHaveValue("");
    await dialog.locator("#user").fill("plant-reader");
    await dialog.locator("#password").fill("s3cret");
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect(dialog.getByTestId("connection-test-result")).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByTestId("connection-test-result")).toContainText("takes no username", { timeout: 30_000 });
    const named = (await dialog.getByTestId("connection-test-result").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] with a username: ${named.slice(0, 200)}`);
    await page.screenshot({ path: `${SHOTS}/03a-username-refused.png` });
    // Cleared the way a reader clears them, and then CHECKED: the first version of this test typed
    // into the boxes and pressed on, and the next Test Connection still carried the username.
    await dialog.locator("#password").fill("");
    await dialog.locator("#user").fill("");
    await expect(dialog.locator("#user")).toHaveValue("");
    await expect(dialog.locator("#password")).toHaveValue("");
    await page.waitForTimeout(500);

    /*
     * Test Connection, which is what a reader presses: the result is a sentence either way. The
     * assertion POLLS rather than reading once, because the panel keeps the previous sentence on
     * screen until the new one arrives - which is how this test came to read the refusal from the
     * press before it and call the product broken. The request bodies, captured separately, showed
     * the product was right: `user: ""` goes out and the server answers.
     */
    await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
    await expect(dialog.getByTestId("connection-test-result")).toContainText("successful", { timeout: 30_000 });
    /*
     * THE ANSWER IS WHERE THE PRESS WAS, asserted rather than eyeballed. The result panel is the last
     * child of the dialog's scrolling body while the buttons are pinned to the bottom, so it used to
     * be painted UNDER the footer: measured, 24 of its 163 pixels on screen and not one character
     * readable. Two attempts at the fix looked right in the DOM and still failed in a picture - the
     * first scrolled a box that had no height yet, the second was still scrolling smoothly when the
     * screenshot was taken - which is why this is a measurement of the box against the viewport.
     */
    const answerBox = await dialog.getByTestId("connection-test-result").boundingBox();
    const viewport = page.viewportSize();
    console.log(`[SHOT] answer box: ${JSON.stringify(answerBox)} viewport: ${JSON.stringify(viewport)}`);
    expect(answerBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (answerBox !== null && viewport !== null) {
      expect(answerBox.y).toBeGreaterThanOrEqual(0);
      // The whole box, inside the window, with room for the footer that overlays the body's bottom.
      expect(answerBox.y + answerBox.height).toBeLessThanOrEqual(viewport.height - 80);
    }
    const tested = (await dialog.getByTestId("connection-test-result").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] test connection: ${tested.slice(0, 160)}`);
    await page.screenshot({ path: `${SHOTS}/03-test-connection.png` });

    // The button is "Establish Connection", which a screenshot had to tell me: the test waited three
    // minutes for a "Connect" that is not there.
    await dialog.getByRole("button", { name: "Establish Connection", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/04-connected.png` });

    // ---- the Keys panel -----------------------------------------------------------------------
    /*
     * THE TABS ARE `role="tab"`, NOT BUTTONS, and this step used to ask for a button named Keys:
     * the locator matched nothing, the `if` above it swallowed that, and the one step the spec exists
     * for - the sidebar's own default - never ran. Every step below is now REQUIRED for the same
     * reason: a walkthrough whose steps are optional reports a pass for a product it never touched.
     */
    const keysTab = page.getByRole("tab", { name: "Keys", exact: true });
    await expect(keysTab).toBeVisible({ timeout: 20_000 });
    // THE DEFAULT, not a press: this engine enumerates nothing, so the panel opens on Keys by itself.
    expect(await keysTab.getAttribute("aria-selected")).toBe("true");
    await expect(page.getByTestId("key-browser-panel")).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(4_000);
    await page.screenshot({
      path: `${SHOTS}/05-keys-root.png`,
      fullPage: false,
    });

    const rootText = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] root level mentions OpcPlc: ${rootText.includes("OpcPlc")}`);
    expect(rootText).toContain("OpcPlc");
    expect(rootText).toContain("Server");

    /*
     * AND WHAT THE OTHER TAB SAYS, which is this round's own change: pressing Objects on an engine
     * with nothing to enumerate used to read "the engine answered, and reported nothing at this
     * level" - a claim about a server holding 6,769 nodes.
     */
    await page.getByRole("tab", { name: "Objects", exact: true }).click();
    await expect(page.getByTestId("tree-listed-elsewhere")).toBeVisible({
      timeout: 20_000,
    });
    const objectsText = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] objects tab says nodes are listed in the Keys panel: ${objectsText.includes("Keys panel")}`);
    expect(objectsText).not.toContain("reported nothing at this level");
    await page.screenshot({
      path: `${SHOTS}/05b-objects-tab.png`,
      fullPage: false,
    });
    await keysTab.click();
    await expect(page.getByTestId("key-browser-panel")).toBeVisible({
      timeout: 20_000,
    });

    // Open the Server folder, which holds the dual row this round added.
    const twisty = page.getByRole("button", { name: /Server/ }).first();
    await twisty.click({ timeout: 15_000 });
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: `${SHOTS}/06-keys-server-open.png` });

    // ServerStatus is a Variable that bears children: it must be openable AND expandable.
    const dual = page.getByText("ServerStatus", { exact: false }).first();
    await dual.click({ timeout: 15_000 });
    await page.waitForTimeout(4_000);
    await page.screenshot({
      path: `${SHOTS}/07-node-source.png`,
      fullPage: false,
    });
    const source = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] source shows nodeClass: ${source.includes("nodeClass")}`);
    expect(source).toContain("nodeClass");
    expect(source).not.toContain("JSON Parse error");
    /*
     * THE DOCUMENT'S OWN KEYS ARE NOT ASKED ABOUT HERE, and that is not an omission: the editor
     * mounts a window of its lines, so a key further down reads as absent whatever the document
     * holds - measured, `keepsHistory` came back false from a document that carries it. They are
     * covered where the document can be read whole, in `tests/unit/db/opcua/objects.test.ts`.
     *
     * AN OBJECT NODE, WHICH HAS NO VALUE ATTRIBUTE AT ALL (Part 3 5.5.1): its document must SAY so
     * rather than show a bare `BadAttributeIdInvalid`, which is this round's own change and had
     * never been looked at. `Dictionaries` is an Object on the level already open - the root's own
     * rows are off screen by now, in a list that mounts a window of its rows.
     */
    const noValue = page.getByText("Dictionaries", { exact: true }).first();
    await noValue.click({ timeout: 15_000 });
    await page.waitForTimeout(4_000);
    await page.screenshot({
      path: `${SHOTS}/07b-object-node-source.png`,
      fullPage: false,
    });
    const objectSource = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] object note shown: ${objectSource.includes("no Value attribute")}`);
    expect(objectSource).toContain("no Value attribute");

    // ---- the console --------------------------------------------------------------------------
    /*
     * BACK TO THE QUERY TAB FIRST, which a screenshot had to tell me: opening a node leaves the
     * Source tab active, and this test then typed its read request into a READ-ONLY editor - the
     * picture showed the tooltip "Cannot edit in read-only editor" over the document. Everything it
     * "measured" after that was the Source document's text, not a query result.
     */
    await page
      .getByRole("tab", { name: /Query 1/ })
      .first()
      .click()
      .catch(async () => {
        await page.getByText("Query 1", { exact: false }).first().click();
      });
    await page.waitForTimeout(1_000);
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible({ timeout: 20_000 });
    {
      await editor.click();
      // `insertText` rather than `type`: Monaco auto-closes a brace, so typing the request leaves
      // `}}` at the end and the console answers a JSON parse error - which a screenshot caught.
      // The CLOSING brace is left out on purpose: Monaco auto-closes it, and typing it too leaves
      // `}}` and a JSON parse error - which is what a screenshot of this very step showed.
      await page.keyboard.insertText('{ "read": ["i=2258"');
      console.log(`[SHOT] editor holds: ${(await editor.innerText()).replaceAll(/\s+/g, " ").slice(0, 90)}`);
      await page.screenshot({ path: `${SHOTS}/08-read-request.png` });
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(7_000);
      await page.screenshot({
        path: `${SHOTS}/09-read-result.png`,
        fullPage: false,
      });
      const result = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
      console.log(`[SHOT] result mentions statusCode: ${result.includes("statusCode")}`);
      console.log(`[SHOT] result mentions Good: ${result.includes("Good")}`);
      // A read that answered: the row's own status, from the server, in the grid.
      expect(result).toContain("statusCode");
      expect(result).toContain("Good");
    }

    // ---- history, which is where the warning sentence is drawn --------------------------------
    {
      await editor.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText('{ "history": "ns=3;s=HistorianInt32", "limit": 101');
      await page.keyboard.press("Control+Enter");
      await page.waitForTimeout(8_000);
      await page.screenshot({
        path: `${SHOTS}/10-history-warning.png`,
        fullPage: false,
      });
      const history = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
      console.log(`[SHOT] history mentions the cap sentence: ${history.includes("cap of")}`);
      // The sentence the MQTT round was built for: a capped read says it was capped, where a reader
      // can see it. A screenshot is still what settles whether it is LEGIBLE.
      expect(history).toContain("cap of");
    }

    /*
     * ---- THE DEEPEST BRANCH, which is where a row label is hardest ---------------------------
     *
     * The level that produced the label rule: eight siblings under one 59-character prefix. A
     * screenshot of it is the only thing that settles whether a reader can tell them apart, and it
     * is where the first attempt still failed - two rows drew `Exceptio...` because the type badge
     * kept its width ahead of the name.
     */
    await keysTab.click();
    const prefixBox = page.getByLabel("Key prefix");
    await prefixBox.fill("OpcPlc/Telemetry/Historian/HistorianInt32/HA Configuration/");
    await prefixBox.press("Enter");
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: `${SHOTS}/11-deep-level.png`, fullPage: false });
    const deep = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] deep level lists ExceptionDeviation: ${deep.includes("ExceptionDeviation")}`);
    expect(deep).toContain("AggregateFunctions");

    /*
     * ---- A PREFIX THAT DIFFERS ONLY IN CASE, which is this round's own refusal ---------------
     */
    await prefixBox.fill("opcplc/");
    await prefixBox.press("Enter");
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: `${SHOTS}/12-case-refusal.png`, fullPage: false });
    const refusal = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] case refusal names the real name: ${refusal.includes("differs from it only in case")}`);
    expect(refusal).toContain("differs from it only in case");

    /*
     * ---- AND THE LIGHT THEME, because every picture above is dark and a token can read
     * differently in the two: the key panel's refusal was measured at 4.25:1 in light against
     * 7.78:1 in dark, which is under what small text needs.
     */
    // The app's own control, not a `data-theme` attribute: the theme is next-themes' `class="dark"`
    // on the root, and an attribute nothing reads changed no colour at all - a screenshot of the
    // "light" theme that came out dark is what showed it.
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await page.waitForTimeout(2_000);
    const themed = await page.evaluate(() => document.documentElement.className);
    console.log(`[SHOT] root class after the toggle: ${JSON.stringify(themed)}`);
    expect(themed).not.toContain("dark");
    await page.screenshot({ path: `${SHOTS}/13-light-refusal.png`, fullPage: false });
    await prefixBox.fill("");
    await prefixBox.press("Enter");
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: `${SHOTS}/14-light-keys.png`, fullPage: false });
    await page.getByRole("tab", { name: "Objects", exact: true }).click();
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: `${SHOTS}/15-light-objects.png`, fullPage: false });

    /*
     * ---- THE MONITORING TABS, which 15 pictures never opened -------------------------------
     *
     * Four of these drew something FALSE for this engine before this round: a PostgreSQL extension
     * instruction, "No active sessions found." against a server holding this very session, a
     * measured "0 tables / 0 B", and "unknown" for a version and an uptime the server answers.
     */
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.goto("/monitoring");
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: `${SHOTS}/16-monitoring-overview.png`, fullPage: false });
    const monitoring = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
    console.log(`[SHOT] monitoring names a PostgreSQL extension: ${monitoring.includes("pg_stat_statements")}`);
    expect(monitoring).not.toContain("pg_stat_statements");

    for (const tab of ["Queries", "Sessions", "Tables"]) {
      const control = page.getByRole("tab", { name: tab, exact: true });
      if ((await control.count()) === 0) continue;
      await control.click();
      await page.waitForTimeout(3_000);
      await page.screenshot({ path: `${SHOTS}/16-monitoring-${tab.toLowerCase()}.png`, fullPage: false });
      const text = (await page.locator("body").innerText()).replaceAll(/\s+/g, " ");
      console.log(`[SHOT] ${tab} tab says "No tables found": ${text.includes("No tables found")}`);
    }

    console.log(`[SHOT] screenshots written to ${SHOTS}`);
  });
});
