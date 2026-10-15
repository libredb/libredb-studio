/**
 * A statement that reaches its query timeout runs once on the database, in a real Chromium.
 *
 * The query routes answer a statement that reached its deadline with HTTP 504 (`TIMEOUT_ERROR` in docs/API_DOCS.md).
 * They used to answer 408, and Chromium reads a 408 on a reused keep-alive connection as a server closing an idle
 * connection: it sends the POST again, without telling the page, so one Run of a statement that timed out reached the
 * database several times and the editor showed only the last answer. The status is pinned by the route tests; only a
 * browser shows the resend. MEASURED on 2026-10-16 with this spec: with the 408 put back and the app rebuilt, one Run
 * reached the database 4 times in each of 3 runs, and with the 504 once in each of 3.
 *
 * The statement leaves one mark per execution in a sequence. A row it inserted would not do: PostgreSQL rolls back
 * the transaction of a statement its timeout cancelled, and the row with it, while `nextval` is never undone. The
 * connection's query timeout is 2 seconds and the statement sleeps 30, so PostgreSQL cancels it with its statement
 * timeout, which Studio answers as TIMEOUT_ERROR. The count is read once the page has its answer: Chromium resends
 * before it hands the page an answer, so every resend has run by then.
 *
 * THE DESCRIBE TITLE IS LOAD-BEARING FOR CI SELECTION, as in e2e/object-edit.spec.ts: this spec needs a Docker daemon,
 * and .github/workflows/ci.yml runs `--grep "Functional smoke"` in the one job that has one and excludes those words
 * from the container job that has none. Without a daemon the spec skips, annotated, on the precedent of
 * e2e/functional-smoke.spec.ts, and it owns its container, on a port of its own.
 *
 * It signs in as the admin, as e2e/neo4j-provider.spec.ts does: the other Functional smoke specs sign in as
 * user@libredb.org, and the per-account "query" rate-limit bucket (src/lib/api/rate-limit.ts) their logins spend is
 * not this account's.
 */
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const PG_CONTAINER = "libredb-statement-timeout-e2e-pg";
const PG_PORT = 54333;
const PG_PASSWORD = "statement-timeout-e2e";

/** The connection's query timeout, in milliseconds: far below the statement's sleep. */
const QUERY_TIMEOUT_MS = 2000;

/** Counts its own executions in `statement_runs`, then sleeps past the query timeout. */
const STATEMENT = "SELECT nextval('statement_runs') AS run, pg_sleep(30)";

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
 * Over TCP inside the container, where only the real server listens: the image's first start runs a TEMPORARY server
 * on its Unix socket only, then stops it and starts the real one, so a statement over the socket can be answered by the
 * temporary server and the next one land in the restart (measured here: the seed succeeded and the count after it
 * failed with "No such file or directory" on the socket). The CI workflow's passkey contract step waits on TCP for the
 * same reason.
 */
function psql(sql: string): string {
  return docker([
    "exec",
    PG_CONTAINER,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-tAc",
    sql,
  ]).trim();
}

/** Readiness is proven by the seed itself succeeding over TCP, never by pg_isready, which answers the temporary server. */
async function startSeededPostgres(): Promise<void> {
  try {
    docker(["rm", "-f", PG_CONTAINER]);
  } catch {
    // No stale container of this spec's own name; nothing else is ever removed.
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
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      psql("CREATE SEQUENCE IF NOT EXISTS statement_runs");
      return;
    } catch (error) {
      lastError = error;
      // oxlint-disable-next-line no-await-in-loop -- a poll: each attempt waits for the one before it.
      await sleep(1000);
    }
  }
  throw new Error(`postgres did not accept the seed within 60s: ${String(lastError)}`);
}

/** How many times the statement has run: `last_value` once `nextval` has been called, and 0 before. */
function executions(): number {
  return Number(psql("SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM statement_runs"));
}

test.describe("Functional smoke: a statement that reaches its query timeout", () => {
  test.skip(!dockerAvailable(), "Docker daemon not available - the statement timeout E2E needs its own PostgreSQL");

  test.afterAll(() => {
    try {
      docker(["rm", "-f", PG_CONTAINER]);
    } catch {
      // Already gone.
    }
  });

  test("runs once on the database, and the editor says it timed out", async ({ page }) => {
    test.setTimeout(180_000); // includes a possible postgres image pull
    await startSeededPostgres();
    // The control for the count below: nothing has run the statement yet.
    expect(executions()).toBe(0);

    await page.goto("/login");
    await page.locator('input[type="email"]').fill("admin@libredb.org");
    await page.locator('input[type="password"]').fill("test-admin");
    await page.getByRole("button", { name: "Sign In" }).click();
    // The admin lands on the Admin Dashboard; the editor is one navigation away.
    await page.waitForURL(/\/admin/);
    await page.goto("/");
    await expect(page.locator("text=Query 1").first()).toBeVisible({ timeout: 15_000 });

    const sidebarButtons = page.locator("text=LibreDB Studio").locator("..").locator("..").locator("button");
    await sidebarButtons.last().click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole("button", { name: "PostgreSQL", exact: true }).click();
    await dialog.locator("#name").fill("Timeout PG");
    await dialog.locator("#queryTimeout").fill(String(QUERY_TIMEOUT_MS));
    await dialog.locator("#host").fill("127.0.0.1");
    await dialog.locator("#port").fill(String(PG_PORT));
    await dialog.locator("#user").fill("postgres");
    await dialog.locator("#password").fill(PG_PASSWORD);
    await dialog.locator("#database").fill("postgres");
    await dialog.getByRole("button", { name: "Establish Connection" }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });
    await expect(page.locator("text=Timeout PG").first()).toBeVisible({ timeout: 15_000 });

    await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 15_000 });
    await page.evaluate((sql) => {
      const monaco = (window as unknown as { monaco?: { editor: { getEditors(): { setValue(v: string): void }[] } } })
        .monaco;
      if (!monaco) throw new Error("monaco global not found");
      monaco.editor.getEditors()[0].setValue(sql);
    }, STATEMENT);
    // The run's own POST, not the plan the editor asks for beside it, which carries `explain` and executes nothing.
    const answered = page.waitForResponse((response) => {
      const request = response.request();
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/db/query") return false;
      const body = request.postDataJSON() as { sql?: string; explain?: unknown } | null;
      return body?.sql === STATEMENT && body.explain === undefined;
    });
    // Exact, so the agent rail's "Run history" button, drawn where an LLM is configured, is never matched too (U46).
    await page.getByRole("button", { name: "RUN", exact: true }).click();

    const answer = await answered;
    expect(executions()).toBe(1);
    expect(answer.status()).toBe(504);
    await expect(page.getByText("Query timed out").first()).toBeVisible({ timeout: 10_000 });
  });
});
