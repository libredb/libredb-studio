/**
 * Editing an object's definition and applying it, in a real browser (#789 Phase 3, discussion #778).
 *
 * Every other layer of this feature is measured somewhere else: the providers against live engines,
 * the two routes against a mock provider, the pane and the dialog under happy-dom. Four things are
 * left that only a browser can answer, and this file exists for them.
 *
 * 1. The diff editor MOUNTS AND COMPUTES under the production Content-Security-Policy. Monaco's diff
 *    is worker-backed and this app's worker bundles are constructed from `blob:` URLs, so a policy
 *    that is one directive short shows an empty diff with nothing in the product pointing at the
 *    cause.
 * 2. That the console channel the CSP assertion reads actually carries a violation. An empty array
 *    is the same empty array on a clean page and on a page whose listener was never wired.
 * 3. The whole round trip, driven with REAL USER INPUT: Edit, type, preview, apply, and the pane
 *    re-reads the engine's own rendering of what was written.
 * 4. The apply marker's COORDINATE. An uncorrected coordinate is neither rejected NOR clamped by
 *    Monaco: it is kept as given, off the end of the document, and no unit test can see it.
 *    MEASURED on 2026-09-14 by wave 11's review: shifting the offset-to-position mapping in
 *    src/lib/db/object-edit.ts by 20 and rebuilding put `monaco.editor.getModelMarkers()` at
 *    line 27 of a NINE-LINE model, not at the model's last line. The marker below is asserted at
 *    line 7 column 3, the position in the READER's document, while the engine's own position is
 *    inside the roughly 20-line assembled batch and cannot produce that pair.
 *
 * There is no E2E baseline for the object tree at all, measured by grep before this file was
 * written, so it is also the first regression test for the Phase 2 tree and Source pane.
 *
 * THE FIXTURE IS PART OF THE DELIVERABLE. This spec owns a throwaway PostgreSQL container, creates
 * `app.order_total(integer)` in it and re-creates that function before every test, so an apply that
 * lands leaves the next test a known definition. Without a Docker daemon the spec SKIPS, annotated,
 * on the precedent of e2e/functional-smoke.spec.ts. MEASURED against postgres:16-alpine on
 * 2026-09-14; the day-one provider measurements behind the feature were taken on PostgreSQL 18.4 and
 * are recorded in docs/providers/postgres.md, not here.
 *
 * THE DESCRIBE TITLE BELOW IS LOAD-BEARING FOR CI SELECTION, so do not rename it for readability.
 * This spec needs a Docker daemon, and .github/workflows/ci.yml has exactly one job that has one:
 * it selects with `--grep "Functional smoke"`, while the container job that has no daemon excludes
 * with `--grep-invert "Functional smoke"`. Playwright greps the full title path, so the words
 * "Functional smoke" in the describe are what put these tests in the job that can run them and keep
 * them out of the job where `test.skip(!dockerAvailable())` would retire them in silence. MEASURED
 * on 2026-09-14 before the rename: `--grep "Functional smoke"` listed 1 test in 1 file and none of
 * these five, and `--grep-invert "Functional smoke"` listed all five. Both jobs stayed green while
 * this file ran on nobody's machine.
 *
 * The connection is created THROUGH THE REAL MODAL rather than seeded through SEED_CONFIG_PATH:
 * seeding would need an environment variable on the webServer entry in playwright.config.ts, which
 * this spec does not own, and driving the modal exercises one more surface a user has to pass.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

const PG_CONTAINER = "libredb-object-edit-e2e-pg";
const PG_PORT = 54331;
const PG_PASSWORD = "object-edit-e2e";

/** The definition every test starts from. Multi-line ON PURPOSE: see EDIT_MARKER below. */
const SEED_SQL = [
  "CREATE SCHEMA IF NOT EXISTS app;",
  "CREATE TABLE IF NOT EXISTS app.orders (id int PRIMARY KEY, total numeric);",
  "CREATE OR REPLACE FUNCTION app.order_total(order_id integer) RETURNS numeric LANGUAGE plpgsql AS $fn$",
  "BEGIN",
  "  RETURN (SELECT total FROM app.orders WHERE id = order_id);",
  "END;",
  "$fn$;",
].join("\n");

/**
 * The text the reader types, and WHERE it is typed, which is a measurement rather than a taste.
 *
 * It goes INSIDE the body because the CATALOG says so, and not because of a syntax error.
 * `pg_get_functiondef` rebuilds everything outside the body from the catalog, so a comment written
 * next to the signature, or after the closing `$function$`, is discarded by the engine and the
 * re-read assertion below would have nothing to find. MEASURED at this build against PostgreSQL
 * 18.4 (Debian 18.4-1.pgdg13+1) through the shipped provider, in both placements: the re-read
 * carried the body edit and never the comment. Typed at the end of a line inside the body it is
 * ordinary plpgsql.
 *
 * An earlier version of this docblock explained the placement with a syntax error instead. That
 * WAS true of the build it was written against: appending the comment at the END of the document
 * made the apply fail `syntax error at or near "DO"`, SQLSTATE 42601, because the strategy's
 * terminating semicolon sat on the reader's own last line and the comment swallowed it. `b3aa6822`
 * repaired the composition by opening the suffix with a newline, and the same edit now answers
 * `applied` with the comment on the `$function$` line and on a line of its own after it. The
 * placement rule above survives that repair; the syntax error does not.
 */
const EDIT_MARKER = " -- edited by the e2e";

/** The body line the marker and the deliberate error are typed onto. Line 6 of the read definition. */
const BODY_LINE = "RETURN (SELECT total FROM app.orders WHERE id = order_id)";

/** A plpgsql statement that is not one. Typed on its own line, which is line 7, at column 3. */
const BAD_STATEMENT = "ZZZ_NOT_SQL;";

/** What `ObjectSourceView` writes its apply markers under. */
const MARKER_OWNER = "libredb-object-apply";

interface MarkerReading {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Readiness is proven by the seed itself succeeding, never by pg_isready: the official image starts
 * a TEMPORARY server during init, which pg_isready reports as ready, and then restarts. Retrying the
 * real operation is the only honest readiness check (the same reasoning as functional-smoke.spec.ts).
 */
async function seedPostgres(): Promise<void> {
  let seeded = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 60 && !seeded; attempt++) {
    try {
      docker([
        "exec",
        PG_CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        SEED_SQL,
      ]);
      seeded = true;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  if (!seeded) throw new Error(`postgres did not accept the seed within 60s: ${String(lastError)}`);
}

function startPostgres(): void {
  try {
    docker(["rm", "-f", PG_CONTAINER]);
  } catch {
    // No stale container of OUR OWN name. Nothing else is ever removed: the human's databases run
    // on this machine under names this spec never touches.
  }
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    PG_CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    "-p",
    `127.0.0.1:${PG_PORT}:5432`,
    "postgres:16-alpine",
  ]);
}

/** The definition the engine holds now, straight from its catalog, for an assertion below the UI. */
function definitionInTheEngine(): string {
  return docker([
    "exec",
    PG_CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tAc",
    "SELECT pg_get_functiondef('app.order_total(integer)'::regprocedure)",
  ]);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 20_000 });
}

/** The real connection modal, filled the way a user fills it. */
async function connectToTheFixture(page: Page): Promise<void> {
  const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await dialog.locator("#name").fill("Object Edit PG");
  await dialog.locator("#host").fill("127.0.0.1");
  await dialog.locator("#port").fill(String(PG_PORT));
  await dialog.locator("#user").fill("postgres");
  await dialog.locator("#password").fill(PG_PASSWORD);
  await dialog.locator("#database").fill("postgres");
  await dialog.getByRole("button", { name: "Establish Connection" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

/**
 * Wait for the catalog read, and press the tree's own Try again when the account is rate limited.
 *
 * MEASURED on 2026-09-14, on the fifth test of this file's first full run: the tree drew "The object
 * list could not be read / Too many requests. Try again in 51 seconds." Every test here signs in as
 * the same shared `user@libredb.org` account, whose per-process "query" bucket
 * (src/lib/api/rate-limit.ts, 120 requests per 60 seconds, shared by every db-reaching route) is
 * sized for one real session and not for five fresh logins in three minutes. The same hazard is
 * documented on playwright.config.ts's `chromium-offline-editor` project for the same reason.
 *
 * Pressing the button the product itself offers, rather than reaching past the UI: this is what the
 * reader in front of that message does, and the wait is bounded so a tree that never arrives still
 * fails the test.
 */
async function waitForTheObjectTree(page: Page): Promise<void> {
  const app = page.getByRole("treeitem", { name: "app", exact: true });
  await expect(async () => {
    if (await app.isVisible()) return;
    const retry = page.getByTestId("tree-retry");
    if (await retry.isVisible()) await retry.click();
    throw new Error("the object tree has not been read yet");
  }).toPass({ timeout: 120_000, intervals: [2_000, 5_000, 10_000, 15_000] });
}

/**
 * Log in, connect, walk the object tree to `app` -> Functions -> order_total, and open its Source
 * tab through the row's own actions menu. Every step is the one a reader takes; nothing here reaches
 * past the UI into a store.
 */
async function openSourceTabOnSeededPostgres(page: Page): Promise<void> {
  await login(page);
  await connectToTheFixture(page);

  await waitForTheObjectTree(page);
  await page.getByRole("treeitem", { name: "app", exact: true }).click();
  await page.getByRole("treeitem", { name: "Functions 1" }).click();
  await page.getByRole("treeitem", { name: "order_total" }).hover();
  await page.getByRole("button", { name: "Actions for order_total" }).click();
  await page.getByRole("menuitem", { name: "View Source" }).click();

  await expect(page.getByTestId("object-source-view")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("object-source-view")).toContainText("RETURN (SELECT total", { timeout: 20_000 });
}

/**
 * Type at the end of the body line, with the keyboard, into a Monaco the test never scripts.
 *
 * The click lands on the rendered line and `End` puts the caret at its end; Monaco 0.5x takes its
 * input through an EditContext element that has no size, so a click on `.view-line` is how a real
 * pointer reaches it and `page.keyboard` is how a real keystroke does.
 */
async function typeIntoTheEditor(page: Page, text: string): Promise<void> {
  await page.locator(`[data-testid="object-source-view"] .view-line`).filter({ hasText: BODY_LINE }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

/** Edit and type, and stop there: nothing is previewed and nothing is applied. */
async function editWithoutApplying(page: Page): Promise<void> {
  await openSourceTabOnSeededPostgres(page);
  await page.getByTestId("object-source-edit").click();
  await typeIntoTheEditor(page, EDIT_MARKER);
  // The draft store writes on a 500 ms debounce, and the reload below must find it written.
  await expect(page.getByTestId("object-source-draft-state")).toHaveText("Saved in this browser.", {
    timeout: 10_000,
  });
}

/** The whole round trip, through the modal preview, which is the only route to the engine. */
async function applyThroughTheUi(page: Page): Promise<void> {
  await editWithoutApplying(page);
  await page.getByTestId("object-source-preview").click();
  await expect(page.getByTestId("object-source-apply-diff")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("object-source-apply-confirm").click();
}

function watchForCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  return violations;
}

async function markersOnTheSourceEditor(page: Page): Promise<MarkerReading[]> {
  return page.evaluate((owner) => {
    const monaco = (
      window as unknown as {
        monaco?: {
          editor: {
            getModelMarkers(filter: { owner: string }): {
              startLineNumber: number;
              startColumn: number;
              message: string;
            }[];
          };
        };
      }
    ).monaco;
    if (!monaco) throw new Error("monaco global not found");
    return monaco.editor.getModelMarkers({ owner }).map((marker) => ({
      line: marker.startLineNumber,
      column: marker.startColumn,
      message: marker.message,
    }));
  }, MARKER_OWNER);
}

/**
 * Reload, and reload AGAIN whenever the restored tab's source read was REFUSED (X22, #789).
 *
 * MEASURED on 2026-09-14, locally, with `--retries=0` and the CI selection
 * (`--project=chromium --grep "Functional smoke"`, one worker): the assertion below failed on its
 * FIRST attempt exactly as it does in CI, and the page snapshot Playwright captured says why. The
 * source pane read `The source read failed. / Too many requests. Try again in 41 seconds.` and the
 * object tree beside it read `The object list could not be read / Too many requests. Try again in
 * 41 seconds.` So it is the FIRST of the two candidates the filing named, the shared account's
 * query budget, and not a late affordance: the affordance was not slow, the read was refused, and
 * 41 seconds is longer than the 30-second assertion that was waiting for it.
 *
 * The arithmetic behind that, from `src/lib/api/rate-limit.ts`: every test in this file and in
 * `functional-smoke.spec.ts` signs in as the same `user@libredb.org`, whose per-process `query`
 * bucket is 120 requests per 60 seconds and is shared by every database-reaching route including
 * all nine under `db/objects`. A `page.reload()` re-hydrates the whole application on top of
 * whatever three earlier tests already spent. The bucket is a FIXED window and a refused request
 * does not increment the counter, so waiting out the `Retry-After` the server itself names buys a
 * full fresh budget rather than one slot.
 *
 * A RELOAD AND NOT A RETRY BUTTON, and the difference is the product gap this test met rather than
 * a choice made for convenience. The object tree offers `tree-retry` when its read is refused and
 * `waitForTheObjectTree` presses it; the source pane's failure region offers NO control at all, and
 * a tab that has recorded a failure never re-reads, because `needsRead` in `ObjectSourceView` is
 * `document === undefined && failure === undefined`. So reloading is the only way back for a
 * restored tab whose read was refused, for this test and for a reader. That is filed, with this
 * measurement behind it, rather than fixed here: the pane is not this spec's file.
 *
 * The reload is still the restore under test. `PersistedTabState` persists a Source tab's address
 * and never its document or its failure, so every reload restores the same tab from localStorage
 * and issues the same fresh read, and the draft the previous step saved is still in the draft
 * store. A second reload weakens nothing.
 */
async function reloadUntilTheRestoredTabIsRead(page: Page): Promise<void> {
  const edit = page.getByTestId("object-source-edit");
  const failure = page.getByTestId("object-source-failure-message");
  await expect(async () => {
    await page.reload();
    // Either outcome, so a refusal is READ rather than waited out for the full timeout: without
    // the `or` this is the 30-second wait that made X22 look like a slow affordance.
    await expect(edit.or(failure).first()).toBeVisible({ timeout: 30_000 });
    if (await edit.isVisible()) return;
    const sentence = (await failure.textContent()) ?? "";
    // The server's own number, and a fallback for a refusal that is not the rate limiter's, so a
    // different failure still costs one bounded wait instead of hanging.
    const named = /Try again in (\d+) seconds/.exec(sentence);
    // Recorded in the report, so a GREEN run still says the budget was hit and how long it waited.
    // Without it this helper would hide exactly the fact X22 was filed about.
    test.info().annotations.push({ type: "rate-limited", description: sentence });
    await sleep((Number(named?.[1] ?? 10) + 2) * 1000);
    throw new Error(`the restored tab's source read did not land: ${sentence}`);
  }).toPass({ timeout: 240_000, intervals: [0] });
}

test.describe("Functional smoke: object edit end to end", () => {
  test.skip(!dockerAvailable(), "Docker daemon not available - the object edit E2E needs its own PostgreSQL");
  // Serial: every test drives the SAME function in the same container, and an apply from one test
  // running inside another test's preview is a race with no product meaning.
  test.describe.configure({ mode: "serial" });
  // A first run may pull the postgres image, the chain is login, connect, tree, read, apply, and
  // `waitForTheObjectTree` may sit out a 60-second rate-limit window on top of all of it.
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    startPostgres();
    await seedPostgres();
  });

  test.beforeEach(async () => {
    // CREATE OR REPLACE, so a test that applied leaves the next one the definition it expects.
    await seedPostgres();
  });

  test.afterAll(() => {
    try {
      docker(["rm", "-f", PG_CONTAINER]);
    } catch {
      // Already gone.
    }
  });

  test("the diff editor mounts and COMPUTES under the production CSP", async ({ page }) => {
    // THIS ASSERTION IS OWED RATHER THAN OPTIONAL. The browser probe's own CSP control was INVALID:
    // code injected through CDP `Runtime.evaluate` is exempt from CSP's compile-time check, and that
    // probe said so and named this assertion as the repair. What it DID prove stands in the
    // meantime: resource-load and string-evaluation enforcement are both live on the page, and the
    // diff's worker-backed char-level output could not have been produced by a blocked worker.
    //
    // Driven with `page.goto` and REAL USER INPUT rather than injected script, which is the whole
    // point: an injected-script version has the same blind spot the probe had.
    const violations = watchForCspViolations(page);
    await openSourceTabOnSeededPostgres(page);
    await page.getByTestId("object-source-edit").click();
    await typeIntoTheEditor(page, EDIT_MARKER);
    await page.getByTestId("object-source-preview").click();
    // `object-source-apply-diff`, not the `object-source-apply-dialog-diff` this task's brief named:
    // the shipped testid is the former (src/components/object-source/ApplyPreviewDialog.tsx), and a
    // spec asserting a testid nothing renders would fail for a reason that is not the product's.
    await expect(page.getByTestId("object-source-apply-diff")).toBeVisible({ timeout: 20_000 });
    // A real char-level diff requires Monaco's diff worker to have RUN, which a blocked worker
    // cannot do.
    await expect(page.locator(".monaco-diff-editor .line-insert").first()).toBeVisible({ timeout: 20_000 });
    expect(violations).toEqual([]);
    // Nothing was applied here: this test closes on the preview, so the fixture is as it found it.
  });

  test("THE CONTROL: this listener DOES catch a violation, so the empty array above means something", async ({
    page,
  }) => {
    // `expect(violations).toEqual([])` is the same empty array on a clean page and on a page whose
    // listener was never wired, and an uncontrolled negative at acceptance criterion 11 is exactly
    // this epic's signature defect. This test proves the channel carries what the assertion above
    // says it did not.
    //
    // The violation is a REAL one caused by real page state, not an injected script: a
    // `<script src>` pointing at an origin the production `script-src` does not allow. The element
    // is appended by a DOM write, which CSP's resource-load enforcement refuses and reports on the
    // console channel; the compile-time exemption that made the earlier probe's CSP control invalid
    // applies to `Runtime.evaluate`'d CODE and not to a blocked RESOURCE LOAD.
    const violations = watchForCspViolations(page);
    await openSourceTabOnSeededPostgres(page);
    await page.evaluate(() => {
      const blocked = document.createElement("script");
      blocked.src = "https://csp-control.invalid/blocked.js";
      document.head.appendChild(blocked);
    });
    await expect.poll(() => violations.length, { timeout: 20_000 }).toBeGreaterThan(0);
    // And nothing was applied by this test, so it leaves the fixture as it found it.
  });

  test("Edit, type, preview, apply, and the pane RE-READS and shows the new text", async ({ page }) => {
    await applyThroughTheUi(page);
    await expect(page.getByTestId("object-source-apply-dialog")).toBeHidden({ timeout: 30_000 });
    // `object-source-view` rather than the brief's `source-editor`: this pane renders Monaco through
    // `@monaco-editor/react` with no testid of its own, and the view is the smallest shipped handle
    // that contains the editor's text.
    await expect(page.getByTestId("object-source-view")).toContainText("edited by the e2e", { timeout: 30_000 });
    // The pane re-read the ENGINE, so the engine has to agree. Without this the assertion above is
    // satisfied by a pane that kept showing the reader's own buffer.
    expect(definitionInTheEngine()).toContain("edited by the e2e");
    // And the pane is read-only again: the Edit button is what a reader gets back after an apply.
    await expect(page.getByTestId("object-source-edit")).toBeVisible();
  });

  test("a RESTORED tab is read-only until the reader presses Edit again", async ({ page }) => {
    // The restored-tab population's only entry point is `use-tab-manager.ts`'s restore, and a test
    // that does not drive the restore certifies nothing about it. `PersistedTabState` is a whitelist
    // of four fields plus the address, so a restored tab is always read-only and a reader always
    // re-enters editing deliberately.
    await editWithoutApplying(page);
    // The reload, retried on a REFUSED read rather than waited out: X22, and the helper's docblock
    // carries the measurement that named the cause.
    await reloadUntilTheRestoredTabIsRead(page);
    await expect(page.getByTestId("object-source-edit")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("object-source-draft-restore")).toBeVisible({ timeout: 30_000 });
  });

  test("a refused apply marks the READER's own line, not the engine's line in the assembled batch", async ({
    page,
  }) => {
    // The assertion no unit test can make. An uncorrected coordinate is neither rejected nor
    // clamped by Monaco: the engine reports its position inside the assembled batch, whose CREATE
    // starts about twenty lines down behind the guard `DO` block, and Monaco keeps that number
    // exactly as handed to it. MEASURED on 2026-09-14 by wave 11's review: shifting the mapping in
    // src/lib/db/object-edit.ts by 20 and rebuilding reported a marker at line 27 on a NINE-LINE
    // model, so it is painted past the end of the document and the reader is shown nothing. Line 7
    // column 3 is where the reader typed, and it is a value the unmapped coordinate cannot produce.
    await openSourceTabOnSeededPostgres(page);
    await page.getByTestId("object-source-edit").click();
    await typeIntoTheEditor(page, EDIT_MARKER);
    await page.keyboard.press("Enter");
    await page.keyboard.type(BAD_STATEMENT);
    // The rendered lines, asserted BEFORE the coordinate, so that a Monaco auto-indent change fails
    // here by name instead of moving the marker's column and failing as if the mapping had broken.
    // MEASURED: Enter at the end of `  RETURN ...` carries the body's two-space indent, so the bad
    // statement starts at column 3 of line 7.
    // Located by CONTENT rather than by index: Monaco reuses and reorders its `.view-line` nodes, so
    // the nth node in the DOM is not the nth line of the document.
    const typedLine = page.locator(`[data-testid="object-source-view"] .view-line`).filter({ hasText: BAD_STATEMENT });
    await expect(typedLine).toHaveText(`  ${BAD_STATEMENT}`);
    await page.getByTestId("object-source-preview").click();
    await expect(page.getByTestId("object-source-apply-diff")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("object-source-apply-confirm").click();

    await expect(page.getByTestId("object-source-apply-failure-code")).toHaveText("42601", { timeout: 30_000 });
    await expect.poll(async () => (await markersOnTheSourceEditor(page)).length, { timeout: 20_000 }).toBe(1);
    const [marker] = await markersOnTheSourceEditor(page);
    expect(marker).toEqual({
      line: 7,
      column: 3,
      message: 'syntax error at or near "ZZZ_NOT_SQL"',
    });
    // A refusal loses nothing: the definition in the engine is the one the seed wrote.
    expect(definitionInTheEngine()).not.toContain("ZZZ_NOT_SQL");
  });
});
