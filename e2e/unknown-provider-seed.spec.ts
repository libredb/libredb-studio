/**
 * A seed entry whose type names no provider this Studio has (FND-1), the way an operator and an admin meet it: the
 * operator's seed file lists an engine of a newer Studio beside a connection this one opens. Before the fix, that one
 * entry failed the whole file, so the managed list answered 500, the studio listed no seed connection at all and the
 * admin's seed sources card showed the file as failed.
 *
 * Runs under playwright.config.ts's "chromium-unknown-provider-seed" project, against a server of its own whose
 * SEED_CONFIG_PATH names e2e/fixtures/unknown-provider-seed-connections.json: a seed file is the server's own, so a spec
 * on a shared server would list its entries too.
 */
import { expect, test, type Page } from "@playwright/test";
import { unknownTypeSentence } from "../src/lib/db/type-id";

const ACTIVE_KEY = "libredb_active_connection_id";
const ACME = { id: "seed:acme-store", name: "Acme Store", type: "acmefoo" };
const SQLITE = { id: "seed:e2e-sqlite", name: "E2E SQLite" };

function row(page: Page, name: string) {
  return page.getByRole("button").filter({ has: page.getByTitle(name, { exact: true }) });
}

test.describe("a seed entry whose type names no provider", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@libredb.org");
    await page.locator('input[type="password"]').fill("test-admin");
    await page.getByRole("button", { name: "Sign In" }).click();
    // An admin lands on /admin, which redirects to /admin/overview; wait for that landing, or the goto below races it.
    await page.waitForURL("**/admin/overview");
    await page.goto("/");
    await expect(page.getByRole("tab", { name: "Query 1" })).toBeVisible({ timeout: 15_000 });
  });

  test("the studio lists the seed whose type names no provider as unavailable, with the reason, and opens the file's other seed", async ({
    page,
  }) => {
    const acmeRow = row(page, ACME.name);
    await expect(acmeRow).toBeVisible({ timeout: 15_000 });
    await expect(acmeRow.getByTitle(unknownTypeSentence(ACME.type))).toHaveText(/Unavailable/);

    await expect(row(page, SQLITE.name)).toBeVisible();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), ACTIVE_KEY)).toBe(SQLITE.id);
    // Last, once the list and its markers have rendered: a crash after the first render would come before this.
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  });

  test("opening it is refused by name and the active connection stays", async ({ page }) => {
    await expect(row(page, ACME.name)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), ACTIVE_KEY)).toBe(SQLITE.id);

    await row(page, ACME.name).click();

    // Scoped to the toast: the row's own screen-reader text carries the same sentence before the click.
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Connection unavailable" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(`${ACME.name}: ${unknownTypeSentence(ACME.type)}`);
    expect(await page.evaluate((key) => localStorage.getItem(key), ACTIVE_KEY)).toBe(SQLITE.id);
  });

  test("the managed list and the seed sources card name it", async ({ page }) => {
    const response = await page.request.get("/api/connections/managed");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { connections: Array<Record<string, unknown>> };
    const acme = body.connections.find((connection) => connection.id === ACME.id);
    expect(acme).toMatchObject({ id: ACME.id, name: ACME.name, type: ACME.type, managed: true });
    expect(acme).not.toHaveProperty("host");

    await page.goto("/admin/overview");
    const unavailable = page.getByTestId("seed-source-unavailable");
    await expect(unavailable).toHaveText(
      `acme-store (./e2e/fixtures/unknown-provider-seed-connections.json): ${unknownTypeSentence(ACME.type)}`,
      { timeout: 15_000 },
    );
    await expect(page.getByText("Unavailable (1)")).toBeVisible();
  });
});
