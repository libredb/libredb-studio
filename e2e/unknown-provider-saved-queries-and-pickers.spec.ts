/**
 * A saved query, or a connection, whose type names no provider (FND-1), the way a user meets it on the surfaces that
 * are not the editor's connection lists: a backup that holds a query saved from another Studio's engine, a saved query
 * stored by a newer Studio that shares the same storage, and the monitoring page's connection picker. Before the fix,
 * the import refused the whole backup with a sentence that named neither the entry nor the type, the command palette
 * loaded the stored query into the active tab, and the monitoring page landed on "Something went wrong" for a stored
 * connection whose type is not text.
 *
 * Runs under playwright.config.ts's "chromium-unknown-provider" project, against the second server, for the reason
 * unknown-provider-connection.spec.ts does: every test signs in and loads the studio, and the palette test reloads it
 * and the monitoring test opens a second page, so they pay the hydration requests again.
 * That server keeps its storage in the browser, so what a test writes to `localStorage` is what the page reads.
 */
import { expect, test, type Page } from "@playwright/test";
import { MALFORMED_TYPE_SENTENCE, unknownTypeSentence } from "../src/lib/db/type-id";

const CONNECTIONS_KEY = "libredb_connections";
const ACTIVE_KEY = "libredb_active_connection_id";
const SAVED_QUERIES_KEY = "libredb_saved_queries";

const KNOWN_REPORT = {
  id: "fnd1-known-report",
  name: "Known Report",
  query: "SELECT 1",
  connectionType: "postgres",
  createdAt: "2026-11-21T10:00:00.000Z",
  updatedAt: "2026-11-21T10:00:00.000Z",
};
const ACME_REPORT = {
  ...KNOWN_REPORT,
  id: "fnd1-acme-report",
  name: "Acme Report",
  query: "FIND acme report",
  connectionType: "acmefoo",
};
// No spaces in the statement: Monaco draws a space as a no-break space, so a statement with spaces would never be
// found in the editor's text, and the check that it is not there would pass for the wrong reason.
const ACME_STORED = {
  ...ACME_REPORT,
  id: "fnd1-acme-stored",
  name: "Acme Stored",
  query: "FIND_acme_stored",
};

const UNKNOWN_CONNECTION = {
  id: "fnd1-picker-unknown",
  name: "Acme Picker Store",
  type: "acmefoo",
  host: "acme.example",
  port: 7000,
  createdAt: "2026-11-21T10:00:00.000Z",
};
const MALFORMED_CONNECTION = {
  id: "fnd1-picker-malformed",
  name: "Malformed Picker Record",
  type: { id: "postgres" },
  host: "malformed.example",
  port: 5432,
  createdAt: "2026-11-21T10:00:00.000Z",
};

async function storedSavedQueries(page: Page): Promise<{ id: string }[]> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as { id: string }[], SAVED_QUERIES_KEY);
}

async function appendStored(page: Page, key: string, records: readonly unknown[]): Promise<void> {
  await page.evaluate(
    ({ key: storageKey, records: added }) => {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as unknown[];
      localStorage.setItem(storageKey, JSON.stringify([...stored, ...added]));
    },
    { key, records },
  );
}

test.describe("a saved query or a picker entry whose type names no provider", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible({ timeout: 15_000 });
  });

  test("importing a backup imports the rest and names the query whose type names no provider", async ({ page }) => {
    await page.getByRole("button", { name: "Saved", exact: true }).click();
    await page.getByLabel("Import saved queries JSON").setInputFiles({
      name: "saved-queries.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify([KNOWN_REPORT, ACME_REPORT])),
    });

    // The outcome is drawn in the Saved panel itself, so the npm StudioWorkspace, which mounts no toaster, shows it too.
    const outcome = page.getByRole("status").filter({ hasText: "Not imported" });
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText(`${ACME_REPORT.name}: ${unknownTypeSentence(ACME_REPORT.connectionType)}`);

    const stored = (await storedSavedQueries(page)).map((query) => query.id);
    expect(stored).toContain(KNOWN_REPORT.id);
    expect(stored).not.toContain(ACME_REPORT.id);
  });

  test("the command palette marks a stored saved query whose type names no provider and loads none of it", async ({
    page,
  }) => {
    await appendStored(page, SAVED_QUERIES_KEY, [ACME_STORED]);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press("ControlOrMeta+K");
    const item = page.getByRole("option").filter({ hasText: ACME_STORED.name });
    await expect(item).toBeVisible();
    await expect(item.getByTitle(unknownTypeSentence(ACME_STORED.connectionType))).toHaveText("Unavailable");

    await item.click();

    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Saved query unavailable" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(`${ACME_STORED.name}: ${unknownTypeSentence(ACME_STORED.connectionType)}`);
    await expect(page.locator(".monaco-editor .view-lines").first()).not.toContainText(ACME_STORED.query);
  });

  test("the monitoring page opens on an available connection, says the saved one is unavailable, marks the others and refuses a pick by name", async ({
    page,
  }) => {
    await appendStored(page, CONNECTIONS_KEY, [UNKNOWN_CONNECTION, MALFORMED_CONNECTION]);
    // Written as the monitoring page starts loading, not from the editor's page: the editor can still be settling on its
    // first connection there and would write that one over it.
    await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
      key: ACTIVE_KEY,
      id: UNKNOWN_CONNECTION.id,
    });

    await page.goto("/monitoring");
    // The header's comboboxes in document order: the refresh interval, then the connection.
    const connectionSelect = page.getByRole("combobox").nth(1);
    // The list arrives after the first render, which shows the placeholder; the account's own sample connection is
    // available, so the select settles on a connection.
    await expect(connectionSelect).not.toHaveText("Select connection", { timeout: 15_000 });
    await expect(connectionSelect).not.toContainText(UNKNOWN_CONNECTION.name);
    await expect(connectionSelect).not.toContainText(MALFORMED_CONNECTION.name);
    const selectedBefore = (await connectionSelect.textContent()) ?? "";
    // The saved active connection is not replaced in silence: the page names it with its reason.
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Connection unavailable" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(`${UNKNOWN_CONNECTION.name}: ${unknownTypeSentence(UNKNOWN_CONNECTION.type)}`);
    // That notice leaves on its own, so the one the refused pick below raises is the only one on the page.
    await expect(toast).toHaveCount(0, { timeout: 15_000 });

    await connectionSelect.click();
    const unknownOption = page.getByRole("option").filter({ hasText: UNKNOWN_CONNECTION.name });
    const malformedOption = page.getByRole("option").filter({ hasText: MALFORMED_CONNECTION.name });
    await expect(unknownOption.getByTitle(unknownTypeSentence(UNKNOWN_CONNECTION.type))).toContainText("Unavailable");
    await expect(malformedOption.getByTitle(MALFORMED_TYPE_SENTENCE)).toContainText("Unavailable");

    await unknownOption.click();

    await expect(toast).toBeVisible();
    await expect(toast).toContainText(`${UNKNOWN_CONNECTION.name}: ${unknownTypeSentence(UNKNOWN_CONNECTION.type)}`);
    await expect(connectionSelect).toHaveText(selectedBefore);
    // Last, once the list and its markers have rendered: a crash after the first render would come before this.
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  });
});
