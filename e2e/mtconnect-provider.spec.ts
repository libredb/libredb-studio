import { expect, type Page, test } from "@playwright/test";

/**
 * The MTConnect provider in a browser: its dialog, a real agent behind it, and a read of the past.
 *
 * The unit and integration tests drive the provider over captures, so they prove the code is right
 * and nothing about whether a reader can reach it. Two things live outside the provider and only a
 * browser shows them: what makes a new type-id SELECTABLE, and what the dialog draws for it, which
 * for MTConnect is a set of declarations rather than code.
 *
 * It also holds the defect that made the provider useless for its own headline. The window was read
 * from a narrowed answer, so every `at` and every `from` above 2 was refused with "past the agent's
 * next sequence number of 2", and a reader who asked for the past got a sentence instead of rows.
 * The last case here reads the past and asserts both halves: rows arrive, and that sentence is
 * nowhere on the page. Reverting either window fix turns it red.
 *
 * It runs against the compose fixture (`mtconnect` and `mtconnect-adapter` in
 * `database-compose.yml`), and on the second server because Establish Connection spends the shared
 * account's per-process rate-limit bucket.
 */

const AGENT = process.env.MTCONNECT_E2E_ORIGIN ?? "http://127.0.0.1:17322";
const PORT = new URL(AGENT).port;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the compose fixture is listening. The dialog cases below need nothing but the browser and
 * run everywhere; the live case needs an agent, and CI's e2e job starts no compose service, so it
 * names its reason and skips rather than failing where no fixture was ever meant to be. The same
 * shape `e2e/opcua-screens.spec.ts` uses.
 */
const fixtureIsUp = async (): Promise<boolean> => {
  try {
    const answer = await fetch(`${AGENT}/probe`, { signal: AbortSignal.timeout(2_000) });
    return answer.ok;
  } catch {
    return false;
  }
};

/** The agent's own last sequence, so the query below asks for a moment the buffer really holds. */
const lastSequence = async (): Promise<number> => {
  const answer = await fetch(`${AGENT}/current`);
  const found = /lastSequence="(\d+)"/.exec(await answer.text());
  if (found === null) throw new Error("the fixture agent answered no lastSequence");
  return Number(found[1]);
};

const signIn = async (page: Page): Promise<void> => {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("user@libredb.org");
  await page.locator('input[type="password"]').fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 15_000 });
};

const openDialog = async (page: Page): Promise<void> => {
  const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5_000 });
};

test.describe("MTConnect in the connection dialog", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await openDialog(page);
  });

  test("is offered as its own driver, once", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.getByRole("button", { name: "MTConnect", exact: true })).toBeVisible();
    // Once rather than at least once: a type-id that reached two lists would draw two buttons, and
    // a reader cannot tell which one carries the registration.
    await expect(dialog.getByRole("button", { name: "MTConnect", exact: true })).toHaveCount(1);
  });

  test("prefills port 5000 and draws Host, Port and Path prefix", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MTConnect", exact: true }).click();
    await expect(dialog.locator('input[value="5000"]')).toBeVisible();
    for (const id of ["#host", "#port", "#apiPath"]) {
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its field.
      await expect(dialog.locator(id)).toBeVisible();
    }
    await expect(dialog.getByText("Path prefix", { exact: true })).toBeVisible();
  });

  test("draws no credential field and no connection string, because the standard defines neither", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MTConnect", exact: true }).click();
    // The absences are the declaration: an agent takes no user and no password, so offering either
    // would be a field a reader could fill in and never be asked for.
    for (const id of ["#user", "#password", "#database"]) {
      // oxlint-disable-next-line no-await-in-loop -- one field at a time, so a failure names its field.
      await expect(dialog.locator(id)).toHaveCount(0);
    }
    await expect(dialog.getByText("Connection String", { exact: true })).toHaveCount(0);
    await expect(dialog.locator("#connectionString")).toHaveCount(0);
    // The TLS panel is offered, since an agent behind https is an ordinary deployment.
    await expect(dialog.getByText("SSL / TLS", { exact: true })).toBeVisible();
  });

  test("says the read-only mode cannot be turned off for this engine", async ({ page }) => {
    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MTConnect", exact: true }).click();
    await expect(dialog.getByText(/read-only whether or not this is ticked/)).toBeVisible();
  });
});

test.describe("MTConnect against a running agent", () => {
  test("connects, draws the device, and reads a moment the buffer still holds", async ({ page }) => {
    test.skip(!(await fixtureIsUp()), `the MTConnect fixture is not answering on ${AGENT}`);
    test.setTimeout(240_000);
    await signIn(page);
    await openDialog(page);

    const dialog = page.locator('[role="dialog"]');
    await dialog.getByRole("button", { name: "MTConnect", exact: true }).click();
    await dialog.locator("#name").fill("MTConnect fixture");
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill(PORT);

    const establish = dialog.getByRole("button", { name: "Establish Connection" });
    const refusal = dialog.getByText(/Try again in \d+ seconds/);
    await establish.click();
    await expect(async () => {
      if (await dialog.isHidden()) return;
      if (await refusal.isVisible()) {
        const sentence = (await refusal.textContent()) ?? "";
        test.info().annotations.push({ type: "rate-limited", description: `connect: ${sentence}` });
        await sleep((Number(/Try again in (\d+) seconds/.exec(sentence)?.[1] ?? 10) + 2) * 1000);
        await establish.click();
      }
      throw new Error("the connection dialog has not closed yet");
    }).toPass({ timeout: 180_000, intervals: [1_000, 2_000, 5_000] });

    // The agent's own device name, read from the agent rather than written here.
    await expect(page.getByText("LIBREDB-LATHE-1722").first()).toBeVisible({ timeout: 60_000 });

    const at = (await lastSequence()) - 5;
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate((line) => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
        .monaco;
      if (!monaco) throw new Error("monaco global not found");
      monaco.editor.getEditors()[0]?.setValue(line);
    }, `GET /current?at=${at}`);
    // The editor's own button, spelled the way the page spells it.
    await page.getByRole("button", { name: "RUN", exact: true }).first().click();

    // Both halves of the defect this spec exists for: the past is readable, and the sentence that
    // used to stand in its place is nowhere on the page.
    await expect(page.getByText(/\d+ rows/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/past the agent's next sequence number/)).toHaveCount(0);
    // Nor any other refusal: a read of the past is an ordinary read here, not a tolerated failure.
    await expect(page.getByText(/The query failed/)).toHaveCount(0);
    await expect(page.getByText(/is not a route this provider runs/)).toHaveCount(0);
  });
});
