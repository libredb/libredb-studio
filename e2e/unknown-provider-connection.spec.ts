/**
 * A stored connection whose type names no provider (FND-1), the way a user meets it: a record saved by a newer Studio
 * that shares the same storage, or one with no type at all, sits in the browser copy of the connections. Before the
 * fix, the sidebar read that type's icon from the per-engine table, the render threw, and every load of the studio
 * landed on the app's "Something went wrong" page while the record was stored.
 *
 * Runs under playwright.config.ts's "chromium-unknown-provider" project, against the second server: each test reloads
 * the studio, so it pays the hydration requests twice, and the shared server's query budget is spent by the specs
 * before it in file order.
 */
import { expect, test, type Page } from "@playwright/test";
import { ABSENT_TYPE_SENTENCE, unknownTypeSentence } from "../src/lib/db/type-id";

const CONNECTIONS_KEY = "libredb_connections";
const ACTIVE_KEY = "libredb_active_connection_id";

const UNKNOWN = {
  id: "fnd1-unknown-type",
  name: "Acme Foo Store",
  type: "acmefoo",
  host: "acme.example",
  port: 7000,
  createdAt: "2026-11-20T10:00:00.000Z",
};
const UNTYPED = {
  id: "fnd1-absent-type",
  name: "Untyped Record",
  host: "untyped.example",
  createdAt: "2026-11-20T10:00:00.000Z",
};

async function storedConnections(page: Page): Promise<unknown[]> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[], CONNECTIONS_KEY);
}

function row(page: Page, name: string) {
  return page.getByRole("button").filter({ has: page.getByTitle(name, { exact: true }) });
}

test.describe("a stored connection whose type names no provider", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible({ timeout: 15_000 });
    await page.evaluate(
      ({ key, records }) => {
        const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
        localStorage.setItem(key, JSON.stringify([...stored, ...records]));
      },
      { key: CONNECTIONS_KEY, records: [UNKNOWN, UNTYPED] },
    );
    await page.reload();
  });

  test("the studio loads and lists both stored connections as unavailable, with the reason", async ({ page }) => {
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Something went wrong")).toHaveCount(0);

    const unknownRow = row(page, UNKNOWN.name);
    await expect(unknownRow).toBeVisible();
    await expect(unknownRow.getByTitle(unknownTypeSentence(UNKNOWN.type))).toHaveText(/Unavailable/);

    const untypedRow = row(page, UNTYPED.name);
    await expect(untypedRow).toBeVisible();
    await expect(untypedRow.getByTitle(ABSENT_TYPE_SENTENCE)).toHaveText(/Unavailable/);

    await unknownRow.hover();
    await expect(unknownRow.getByRole("button", { name: "Edit connection" })).toHaveCount(0);
    await expect(unknownRow.getByRole("button", { name: "Duplicate connection" })).toHaveCount(0);
    await expect(unknownRow.getByRole("button", { name: "Delete connection" })).toHaveCount(1);
  });

  test("opening one is refused by name and the active connection stays", async ({ page }) => {
    await expect(row(page, UNKNOWN.name)).toBeVisible({ timeout: 15_000 });
    const activeBefore = await page.evaluate((key) => localStorage.getItem(key), ACTIVE_KEY);
    expect(activeBefore).not.toBe(UNKNOWN.id);
    expect(activeBefore).not.toBe(UNTYPED.id);

    await row(page, UNKNOWN.name).click();

    await expect(page.getByText("Connection unavailable").first()).toBeVisible();
    await expect(page.getByText(unknownTypeSentence(UNKNOWN.type), { exact: false }).first()).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), ACTIVE_KEY)).toBe(activeBefore);
  });

  test("the stored records are kept as they were after a reload and a refused pick", async ({ page }) => {
    await expect(row(page, UNTYPED.name)).toBeVisible({ timeout: 15_000 });
    await row(page, UNTYPED.name).click();
    await expect(page.getByText("Connection unavailable").first()).toBeVisible();
    await page.reload();
    await expect(row(page, UNTYPED.name)).toBeVisible({ timeout: 15_000 });

    const stored = await storedConnections(page);
    expect(stored).toContainEqual(UNKNOWN);
    expect(stored).toContainEqual(UNTYPED);
  });
});
