/**
 * Exporting a query result as XLSX in a real browser, end to end.
 *
 * The unit tests prove the writer emits string cells and the menu offers the right
 * formats; nothing below the browser proves a user can actually download the file the
 * menu names. Two things are left that only a browser can answer:
 *
 * 1. The whole round trip, driven with REAL USER INPUT: connect, type a SELECT whose
 *    result carries a spreadsheet-formula-looking value, run it, and download the XLSX
 *    the Export menu names.
 * 2. The downloaded file itself: it must open as a workbook whose cells are strings
 *    (`t: "s"`) with no formula field, so `=1+1` stays data on the machine of whoever
 *    opens the file.
 *
 * THE FIXTURE IS PART OF THE DELIVERABLE, on the precedent of e2e/object-edit.spec.ts:
 * this spec owns a throwaway PostgreSQL container and, without a Docker daemon, SKIPS,
 * annotated. THE DESCRIBE TITLE BELOW IS LOAD-BEARING FOR CI SELECTION: the
 * "Functional smoke" words put this file in the CI job that has a Docker daemon and keep
 * it out of the job that has none.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const PG_CONTAINER = "libredb-export-e2e-pg";
const PG_PORT = 54332;
const PG_PASSWORD = "export-e2e";

/** The statement every test runs: a value a spreadsheet would read as a formula. */
const QUERY = "SELECT '=1+1' AS payload, 'plain' AS label;";

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

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill("user@libredb.org");
  await page.locator('input[type="password"]').first().fill("test-user");
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("/");
  await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 20_000 });
}

async function connectToTheFixture(page: Page): Promise<void> {
  const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
  await sidebarButtons.last().click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();
  await dialog.locator("#name").fill("Export E2E PG");
  await dialog.locator("#host").fill("127.0.0.1");
  await dialog.locator("#port").fill(String(PG_PORT));
  await dialog.locator("#user").fill("postgres");
  await dialog.locator("#password").fill(PG_PASSWORD);
  await dialog.locator("#database").fill("postgres");
  await dialog.getByRole("button", { name: "Establish Connection" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

test.describe("Functional smoke: XLSX export", () => {
  test.beforeAll(async () => {
    test.skip(!dockerAvailable(), "requires a Docker daemon to run a throwaway PostgreSQL");
    try {
      docker(["rm", "-f", PG_CONTAINER]);
    } catch {
      // No stale container of OUR OWN name; nothing else is ever removed.
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
    // Readiness is proven by the probe itself succeeding, never by pg_isready: the image
    // starts a TEMPORARY server during init, which pg_isready reports as ready, and then
    // restarts (the same reasoning as object-edit.spec.ts).
    let ready = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      try {
        docker(["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"]);
        ready = true;
      } catch (error) {
        lastError = error;
        await sleep(1000);
      }
    }
    if (!ready) throw new Error(`postgres did not become ready within 60s: ${String(lastError)}`);
  });

  test("downloads an XLSX whose cells are strings, not formulas", async ({ page }) => {
    await login(page);
    await connectToTheFixture(page);

    await page.locator(".monaco-editor, [data-testid='query-editor'], textarea").first().click();
    await page.keyboard.type(QUERY);
    // Scoped to the editor's own toolbar: the agent panel's "Run history" toggle also
    // matches a bare "RUN" role-name query.
    await page.getByTestId("studio-editor-top").getByRole("button", { name: "RUN", exact: true }).click();

    // The export menu appears only once the result is on screen.
    await expect(page.getByTestId("export-row-count")).toBeVisible({ timeout: 20_000 });

    // Scoped to the results panel: the connection card's own name ("Export E2E PG")
    // also matches a bare /Export/ role-name query.
    await page.getByTestId("studio-editor-bottom").getByRole("button", { name: /Export/ }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: "Export as XLSX" }).click(),
    ]);

    const path = await download.path();
    expect(path).not.toBeNull();
    const XLSX = await import("@e965/xlsx");
    const workbook = XLSX.read(readFileSync(path as string), { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["Results"]);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const header = sheet.A1 as { t?: string; v?: unknown };
    const formulaLead = sheet.A2 as { t?: string; v?: unknown; f?: unknown };
    const plain = sheet.B2 as { t?: string; v?: unknown };
    expect(header.v).toBe("payload");
    expect(formulaLead.t).toBe("s");
    expect(formulaLead.v).toBe("=1+1");
    expect(formulaLead.f).toBeUndefined();
    expect(plain.v).toBe("plain");
  });
});
