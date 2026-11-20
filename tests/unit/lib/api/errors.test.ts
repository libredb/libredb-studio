import { describe, test, expect, spyOn } from "bun:test";
import { createErrorResponse } from "@/lib/api/errors";
import { TimeoutError } from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";

/** A driver error as the driver throws it: its own words and, when it has one, its code. */
function driverError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields);
}

async function answer(error: Error): Promise<{ status: number; body: unknown }> {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const res = createErrorResponse(error);
    return { status: res.status, body: await res.json() };
  } finally {
    warn.mockRestore();
  }
}

describe("createErrorResponse: a statement's deadline", () => {
  // Chromium sends a POST answered 408 on a reused connection again, so a statement that reached its deadline ran
  // up to six times on the target database for one editor run. 504 is not resent.
  test("a TimeoutError answers 504 with code TIMEOUT_ERROR, never 408, and keeps its own message", async () => {
    expect(await answer(new TimeoutError("query took too long", "postgres", 30000))).toEqual({
      status: 504,
      body: { error: "query took too long", code: "TIMEOUT_ERROR", statusCode: 504, retryable: true },
    });
  });

  test("a TimeoutError with no message of its own answers the shared sentence", async () => {
    expect((await answer(new TimeoutError("", "postgres", 30000))).body).toEqual({
      error: "Query timed out. Please try a simpler query or increase timeout.",
      code: "TIMEOUT_ERROR",
      statusCode: 504,
      retryable: true,
    });
  });
});

// The engine's report of its own timeout, measured on 2026-11-20, reaches the reader through the mapping
// and the body unchanged; it was replaced by the shared sentence.
describe("createErrorResponse: an engine's timeout keeps the engine's words", () => {
  test.each([
    [
      "PostgreSQL statement_timeout (PG19, PG18, TimescaleDB, YugabyteDB)",
      "postgres",
      driverError("canceling statement due to statement timeout", { code: "57014" }),
      "canceling statement due to statement timeout",
    ],
    [
      "PostgreSQL lock_timeout",
      "postgres",
      driverError("canceling statement due to lock timeout", { code: "55P03" }),
      "canceling statement due to lock timeout",
    ],
    [
      "MySQL innodb_lock_wait_timeout",
      "mysql",
      driverError("Lock wait timeout exceeded; try restarting transaction", {
        code: "ER_LOCK_WAIT_TIMEOUT",
        errno: 1205,
        sqlState: "HY000",
      }),
      "Query timeout: Lock wait timeout exceeded; try restarting transaction",
    ],
    [
      "SQL Server request timeout",
      "mssql",
      driverError("Timeout: Request failed to complete in 60000ms", { code: "ETIMEOUT" }),
      "Query timeout: Timeout: Request failed to complete in 60000ms",
    ],
  ] as const)("%s", async (_name, provider, error, text) => {
    expect(await answer(mapDatabaseError(error, provider))).toEqual({
      status: 504,
      body: { error: text, code: "TIMEOUT_ERROR", statusCode: 504, retryable: true },
    });
  });
});
