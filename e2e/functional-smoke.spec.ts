/**
 * Functional smoke: the product's reason to exist, end to end - boot the real
 * app, log in, create a PostgreSQL connection through the real connection
 * modal, run a SQL query, and see the rows in the results grid. This is the
 * invariant no change may break (the maintainer loop runs it as the last step
 * before declaring a milestone complete; CI runs it with the regular E2E job).
 *
 * The spec manages its own throwaway PostgreSQL container. Without a Docker
 * daemon the spec SKIPS (annotated) - fine for a dev machine; the loop's
 * close-out wrapper (loop/scripts/functional-smoke.sh) hard-fails on missing
 * Docker instead, so the loop can never pass this gate vacuously.
 */
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const PG_CONTAINER = "libredb-functional-smoke-pg";
const PG_PORT = 54329;
const PG_PASSWORD = "smoke-pg-password";

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

async function startSeededPostgres(): Promise<void> {
  try {
    docker(["rm", "-f", PG_CONTAINER]);
  } catch {
    // no stale container - fine
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
  // Readiness is proven by the seed itself succeeding, not by pg_isready:
  // the official image's init sequence starts a TEMPORARY server (which
  // pg_isready happily reports ready) and then restarts - a seed racing that
  // gap fails with "socket ... failed". Retrying the real operation is the
  // only honest readiness check.
  const seedSql =
    "CREATE TABLE smoke_items (id int PRIMARY KEY, name text NOT NULL);" +
    " INSERT INTO smoke_items VALUES (1, 'smoke_row_one'), (2, 'smoke_row_two');";
  let seeded = false;
  let lastError: unknown;
  for (let i = 0; i < 60 && !seeded; i++) {
    try {
      docker(["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-c", seedSql]);
      seeded = true;
    } catch (err) {
      lastError = err;
      await sleep(1000);
    }
  }
  if (!seeded) throw new Error(`postgres did not accept the seed within 60s: ${lastError}`);
}

test.describe("Functional smoke: connect to PostgreSQL and run a query", () => {
  test.skip(!dockerAvailable(), "Docker daemon not available - postgres smoke skipped");
  test.describe.configure({ mode: "serial" });

  test.afterAll(() => {
    try {
      docker(["rm", "-f", PG_CONTAINER]);
    } catch {
      // already gone
    }
  });

  test("login -> create connection via the modal -> run SQL -> rows render", async ({ page }) => {
    test.setTimeout(180_000); // includes a possible postgres image pull
    await startSeededPostgres();

    // Login (user role: lands directly on the studio).
    await page.goto("/login");
    await page.locator('input[type="email"]').fill("user@libredb.org");
    await page.locator('input[type="password"]').fill("test-user");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 15_000 });

    // Open the connection modal (last button in the sidebar header row).
    const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
    await sidebarButtons.last().click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Fill the real form: PostgreSQL type, host/port/user/password/database.
    await dialog.locator("text=PostgreSQL").first().click();
    await dialog.locator("#name").fill("Smoke PG");
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill(String(PG_PORT));
    await dialog.locator("#user").fill("postgres");
    await dialog.locator("#password").fill(PG_PASSWORD);
    await dialog.locator("#database").fill("postgres");
    await dialog.getByRole("button", { name: "Establish Connection" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });

    // The new connection appears and is selected; its health is proven by the
    // query below, not by a status badge (the header renders hidden responsive
    // duplicates of the status text, which makes badge assertions brittle).
    await expect(page.locator("text=Smoke PG").first()).toBeVisible({ timeout: 15_000 });

    // Run a real query through the editor.
    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
        .monaco;
      if (!monaco) throw new Error("monaco global not found");
      monaco.editor.getEditors()[0].setValue("SELECT id, name FROM smoke_items ORDER BY id");
    });
    await page.getByRole("button", { name: "RUN" }).click();

    // The seeded rows render in the results grid.
    await expect(page.locator("text=smoke_row_one").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("text=smoke_row_two").first()).toBeVisible({ timeout: 5000 });
  });
});
