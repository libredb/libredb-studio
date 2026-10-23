import { expect, test } from "@playwright/test";

/**
 * The Modbus provider in a browser, against the compose fixture on 127.0.0.1:1502
 * (`docker/modbus/README.md`).
 *
 * WHY A BROWSER IS THE ONLY PLACE THIS CAN BE ASKED. The defect this file holds was invisible to
 * every other layer: the provider answers a column called `address` carrying the register the
 * caller asked for, and the data masking that starred it out runs in the browser
 * (`ResultsGrid` reads the rules through `src/lib/data-masking.ts`). So the provider was right,
 * the integration test was green, the live check was green, and a reader still could not see
 * which register answered. `tests/unit/components/results-grid-masking-exemption.test.ts` holds
 * the decision; this holds what a reader actually sees.
 *
 * It stays on the shared server rather than taking one of its own: it never clicks Test
 * Connection, which is what spends the account's per-process rate-limit bucket and what the
 * second-server projects in `playwright.config.ts` exist for. It establishes one connection and
 * runs one read.
 *
 * It needs no register map. A range read names its own unit, table, address and count, so the
 * map - which the dialog does not collect - is only needed for named points.
 */

/*
 * The fixture's address, overridable the way `mtconnect-provider.spec.ts` overrides its agent's
 * (`MTCONNECT_E2E_ORIGIN`): one variable, read in one place, so the probe below and the two boxes
 * the cases type into can never name different ports. It is also what let the skip be measured -
 * pointed at a port nothing serves, the six device cases skip and the three dialog cases run.
 */
const TARGET = process.env.MODBUS_E2E_TARGET ?? "127.0.0.1:1502";
const FIXTURE = {
  host: TARGET.slice(0, TARGET.lastIndexOf(":")),
  port: TARGET.slice(TARGET.lastIndexOf(":") + 1),
};
const READ = '{"unit":1,"table":"holding_register","address":0,"count":5}';

/** The fixture's holding table, as the formula `docker/modbus/README.md` documents. */
const holding = (address: number): number => 7000 + 11 * address;

/**
 * Whether the fixture is ANSWERING MODBUS on that address, asked once for the whole file.
 *
 * SKIPPED RATHER THAN FAILED WHERE NO FIXTURE WAS MEANT TO BE. CI's e2e job starts no compose
 * service, and the `Modbus live check` step of `.github/workflows/ci.yml` lives in the
 * `functional-smoke` job rather than in the e2e one - so the six cases that dial a device cannot
 * pass there. MEASURED on this branch's run: they dialled 127.0.0.1:1502 and got
 * `connect ECONNREFUSED` eighteen times. `mtconnect-provider.spec.ts` and
 * `opcua-screens.spec.ts` guard their live cases this same way, and the dialog cases below need
 * nothing but a browser and keep running everywhere.
 *
 * NOT "does the port accept". MEASURED and recorded in `tests/live/modbus-ready-probe.ts`:
 * against a published container port Docker itself answers the accept in 5 ms while the server
 * behind it took 332 ms to listen, so an accept is not a readiness fact. This asks the device for
 * one register and requires the reply's MBAP header to echo the transaction and unit it was sent.
 * The frame is built here rather than through `ModbusProvider`, because a probe that runs through
 * the thing under test cannot tell a broken fixture from a broken provider.
 *
 * THE THRESHOLD IS "SPEAKS", NOT "SERVES THIS FIXTURE'S VALUES", on purpose: nothing listening is
 * an absent fixture and skips, while a server answering another table's values is a WRONG fixture
 * and must stay red. The `Modbus live check` step of `.github/workflows/ci.yml` keeps those two
 * apart for the same reason.
 */
const TRANSACTION = 0x4242;
const UNIT = 1;

let asked: Promise<boolean> | undefined;

function fixtureSpeaksModbus(): Promise<boolean> {
  asked ??= (async (): Promise<boolean> => {
    const { connect } = await import("node:net");
    return new Promise((resolve) => {
      const request = Buffer.alloc(12);
      request.writeUInt16BE(TRANSACTION, 0);
      request.writeUInt16BE(0, 2);
      request.writeUInt16BE(6, 4);
      request[6] = UNIT;
      request[7] = 3;
      request.writeUInt16BE(0, 8);
      request.writeUInt16BE(1, 10);

      const socket = connect(Number(FIXTURE.port), FIXTURE.host);
      const answer = (speaks: boolean): void => {
        socket.destroy();
        resolve(speaks);
      };
      socket.setTimeout(3_000);
      socket.once("connect", () => socket.write(request));
      socket.once("data", (reply: Buffer) =>
        // An exception response counts: a device that refuses is still a device.
        answer(reply.length >= 8 && reply.readUInt16BE(0) === TRANSACTION && reply[6] === UNIT),
      );
      socket.once("timeout", () => answer(false));
      socket.once("error", () => answer(false));
    });
  })();
  return asked;
}

const NO_FIXTURE = `no Modbus device answered on ${FIXTURE.host}:${FIXTURE.port}, so nothing was dialled`;

test.describe("Modbus in the connection dialog", () => {
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
    await expect(page.locator('[role="dialog"]').getByRole("button", { name: "Modbus", exact: true })).toBeVisible();
  });

  test("offers no connection string, because Modbus TCP has none to offer", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Modbus", exact: true }).click();
    // ABSENCE. `supportsConnectionString` is false and `showConnectionStringToggle` is false, and
    // a toggle drawn here would offer a reader a form of address this protocol does not have.
    await expect(dialog.getByText("Connection String", { exact: false })).toHaveCount(0);
  });

  test("a connection that read nothing is not saved silently, it asks first", async ({ page }) => {
    // The only case in this describe that dials: the two above read the dialog alone.
    test.skip(!(await fixtureSpeaksModbus()), NO_FIXTURE);
    /*
     * The product's own honesty, and nothing held it before this.
     *
     * An empty register map is the DEFAULT state of a new Modbus connection, and Modbus has no
     * discovery, so the dial can only report that an address accepted TCP. Against a port that
     * accepts and never answers, that used to read `Connection successful` in single-digit
     * milliseconds. The dialog now says what was and was not measured and asks for a second
     * click, which is why the flow below clicks twice.
     */
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Modbus", exact: true }).click();
    await dialog.locator("#host").fill(FIXTURE.host);
    await dialog.locator("#port").fill(FIXTURE.port);
    await dialog.getByRole("button", { name: "Establish Connection" }).click();

    await expect(dialog).toContainText("carries no register map");
    await expect(dialog).toContainText("Click Establish Connection again to save it anyway");
    // ABSENCE: it is not saved yet. A dialog that had closed would have saved a connection whose
    // only measurement was that a port accepted a socket.
    await expect(dialog).toBeVisible();
  });

  test("says in the dialog that Studio cannot write to a device", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "Modbus", exact: true }).click();
    // By its id rather than by its text: the hint is the checkbox's own description
    // (`aria-describedby="readOnly-hint"`), so this also asserts the pair a screen reader reads.
    await expect(dialog.locator("#readOnly-hint")).toContainText("Studio cannot write to a Modbus device");
  });
});

test.describe("a read of the fixture, as a reader sees it", () => {
  test.beforeEach(async ({ page }) => {
    // Every case here reads the device, so the guard sits in the hook rather than five times over.
    test.skip(!(await fixtureSpeaksModbus()), NO_FIXTURE);
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New connection", exact: true }).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole("button", { name: "Modbus", exact: true }).click();
    await dialog.locator("#host").fill(FIXTURE.host);
    await dialog.locator("#port").fill(FIXTURE.port);
    // Twice, and the sentence between them is the reason: with no register map the dialog
    // reports what it could and could not measure and asks to be told again. Asserted on its own
    // in the dialog describe above; here it is waited for, so the second click lands on the
    // acknowledged caution rather than racing it.
    const establish = dialog.getByRole("button", { name: "Establish Connection" });
    await establish.click();
    await expect(dialog).toContainText("carries no register map", { timeout: 20000 });
    await establish.click();
    await expect(dialog).toBeHidden({ timeout: 20000 });

    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15000 });
    await page.evaluate((statement) => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
        .monaco;
      monaco?.editor.getEditors()[0]?.setValue(statement);
    }, READ);
    // The button, not the shortcut. The editor's own hint reads "Cmd/Ctrl+Enter", so a spec that
    // presses one of them passes on the platform it was written on and quietly runs nothing on
    // the other: MEASURED here, the statement reached the editor and the panel still read "Ready
    // to query". Six specs in this suite click RUN; this is the same reason they do.
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    // The first value of the fixture's holding table, which is also the proof the read ran.
    await expect(page.getByText(String(holding(0)), { exact: false }).first()).toBeVisible({ timeout: 20000 });
  });

  test("the register each row answered for is readable, not starred out", async ({ page }) => {
    /*
     * THE DEFECT, as a reader met it. `builtin-address` matches a column by NAME, so it read the
     * register number as a postal address and drew `********` in the one column the request was
     * about. Reverting `ProviderCapabilities.maskingExemptColumns` on the Modbus provider turns
     * this case red.
     */
    /*
     * Read by their own text, one assertion for one fact.
     *
     * NOT by scanning rows: `[role='row'], tr` matched nothing in this grid and handed back an
     * empty array, which fails the same way an absent value does - the test went red for the
     * scanner's reason while every value was on screen. The grid draws its own divs and
     * virtualizes columns besides, so the row is not a thing to count.
     *
     * It cannot pass vacuously either: the flow above has already waited for the first value, so
     * reaching here means the read ran, and all five are asserted together rather than as five
     * separate claims about one read.
     */
    const onScreen = await Promise.all(
      [0, 1, 2, 3, 4].map((address) =>
        page
          .getByText(String(holding(address)), { exact: false })
          .first()
          .isVisible(),
      ),
    );
    expect(onScreen).toEqual([true, true, true, true, true]);
    // ABSENCE, and the defect's own signature: the masked form of a value, anywhere in the grid.
    await expect(page.getByText("********", { exact: false })).toHaveCount(0);
  });

  test("the address column says it was left open, and why", async ({ page }) => {
    // The exemption keeps the slot the masked-column lock would have used, so a reader can tell
    // a column this engine excused from one no rule ever matched. The reason is its title.
    const openMark = page.locator('[title*="PDU register number"]');
    await expect(openMark.first()).toBeVisible({ timeout: 10000 });
  });

  test("no Explain tab is offered, because this engine plans nothing", async ({ page }) => {
    // ABSENCE, tied to `supportsExplain: false`. Modbus has no planner to ask: a read is four
    // function codes, and a tab offering to explain one would promise something no device answers.
    // By the test id the panel carries for exactly this ambiguity: the tabs are plain buttons,
    // not `role="tab"`, and the query editor renders an "Explain" button of its own.
    // `e2e/explain-sqlite.spec.ts` asserts this same id IS visible on an engine that declares
    // `explainFormat`, which is what keeps this absence from being an absence of the selector.
    await expect(page.getByTestId("bottom-panel-tab-explain")).toHaveCount(0);
  });

  test("no cell opens an editor, because nothing here can be written", async ({ page }) => {
    // ABSENCE, tied to `supportsInlineRowEdit: false` and to `enforcesReadOnly: true`, which is
    // structural here rather than configured: there is no code in the provider that builds a write.
    const cell = page.getByText(String(holding(0)), { exact: false }).first();
    await cell.dblclick();
    /*
     * By the editor's own shape, not by a grid role this grid does not use.
     *
     * The first writing of this looked for `[role='gridcell'] input, td input`, which matches
     * nothing here whatever the product does - an absence that is true for the selector's reason
     * rather than the engine's. The cell editor is an `<input autoFocus>`
     * (the `autoFocus` input in `ResultsGrid.tsx`), so if one had opened it would be THE focused
     * input on the page;
     * the query editor is Monaco, whose own field is a textarea.
     *
     * And the branch this asserts is real: with `editingEnabled` false the cell renders without
     * an `onDoubleClick` at all (the cell's handler in `ResultsGrid.tsx`), which is what `supportsInlineRowEdit:
     * false` buys on this engine.
     */
    await expect(page.locator("input:focus")).toHaveCount(0);
  });

  test("the address column carries no masked-column lock", async ({ page }) => {
    // ABSENCE. The lock is drawn from the masked set; after the exemption that column is not in
    // it, and a lock here would mean the subtraction never happened.
    await expect(page.locator('[title="Masked column"]')).toHaveCount(0);
  });
});
