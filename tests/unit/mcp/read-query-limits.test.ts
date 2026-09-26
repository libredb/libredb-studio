/**
 * The pure rules of run_read_query (#246): the offset rule's answers, the mapping of this
 * repository's own provider refusals, the timeout classification, the deadline race and the texts
 * a caller reads. The provider files are read, never edited, so a reworded message breaks this
 * build instead of falling through to an engine error.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyReadQueryFailure,
  fenceRefusalText,
  IN_SQL_PAGING,
  MORE_ROWS_THAN_PAGEABLE_HINT,
  nextPageHint,
  offsetRefusalText,
  profileRefusalText,
  raceDeadline,
  READ_ONLY_REFUSALS,
  ROW_OVER_CAP_TEXT,
  timeoutText,
} from "@/lib/mcp/tools/read-query-limits";

const PROVIDERS = join(import.meta.dir, "../../../src/lib/db/providers/sql");
const ROWS =
  "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, or remove your own LIMIT and page with offset.";
const BYTES =
  "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.";
const CUT_VALUE =
  "One value in this result is 1 MiB or larger, and SQL Server cut it at the most this server reads for one call. Select fewer or narrower columns, for example a substring of a long text column.";
const SERIALISED =
  "SQL Server returns a FOR JSON or FOR XML result as one serialised value, which this server cannot bound. Select the rows themselves, without the FOR JSON or FOR XML clause.";
const OWN_LIMIT =
  "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: LIMIT n OFFSET m, or on SQL Server ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.";

describe("the texts", () => {
  test("are the design's words", () => {
    expect(IN_SQL_PAGING).toBe(
      "Page it in SQL: LIMIT n OFFSET m, or on SQL Server ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.",
    );
    expect(MORE_ROWS_THAN_PAGEABLE_HINT).toBe(
      `More rows exist than this result holds, and this query cannot be paged with offset. ${IN_SQL_PAGING}`,
    );
    expect(nextPageHint(100)).toBe("Call again with offset 100 for the next page.");
    expect(timeoutText(500)).toBe(
      "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000.",
    );
    expect(ROW_OVER_CAP_TEXT).toBe(
      "One row of this result is larger than the 32 KiB result limit. Select fewer or narrower columns, for example a substring of a long text column.",
    );
    expect(fenceRefusalText("NON_READ_STATEMENT")).toBe(
      "The statement was refused before it reached the database (NON_READ_STATEMENT). run_read_query runs one read-only statement: a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE.",
    );
    expect(profileRefusalText("the engine has no read-only statement path", "PostgreSQL and SQLite")).toBe(
      "run_read_query cannot run on this connection: the engine has no read-only statement path. It runs on PostgreSQL and SQLite; inspect_schema works on every engine.",
    );
  });
});

describe("the offset rule", () => {
  test.each([
    ["SELECT id FROM numbers LIMIT 10", "sqlite", OWN_LIMIT],
    ["SELECT TOP 5 id FROM numbers", "mssql", OWN_LIMIT],
    ["SELECT id FROM numbers", "sqlite", `This query cannot be paged with offset. ${IN_SQL_PAGING}`],
    ["VALUES (1), (2), (3)", "sqlite", "This statement's result cannot be paged. Call again without offset."],
    ["TABLE numbers", "postgres", "This statement's result cannot be paged. Call again without offset."],
    ["EXPLAIN SELECT id FROM numbers", "duckdb", "This statement's result cannot be paged. Call again without offset."],
  ] as const)("answers %p on %s with the case that applies", (sql, type, expected) => {
    expect(offsetRefusalText(sql, type)).toBe(expected);
  });
});

describe("the provider refusal mapper", () => {
  const deadline = 10_000;

  test.each([
    ["Read-only execution exceeded the row budget: 1001 rows > 1000 allowed", { kind: "too-large", text: ROWS }],
    [
      "Read-only execution exceeded the byte budget: 2000000 bytes > 1048576 allowed",
      { kind: "too-large", text: BYTES },
    ],
    [
      "Read-only execution refused a value the server cut at the byte budget: payload came back at the ceiling",
      { kind: "too-large", text: CUT_VALUE },
    ],
    [
      "Read-only execution cannot bound a serialised result: SQL Server compiled this as FOR JSON",
      { kind: "too-large", text: SERIALISED },
    ],
    ["Read-only execution exceeded the time budget: 900ms > 500ms allowed", { kind: "timeout" }],
    ["Read-only execution exceeded its time budget: the statement was cancelled after 500 ms", { kind: "timeout" }],
  ] as const)("maps %p", (message, expected) => {
    expect(classifyReadQueryFailure(new Error(message), 1_000, deadline)).toEqual(expected);
  });

  test("answers any failure that settles at or after the deadline as the timeout", () => {
    expect(classifyReadQueryFailure(new Error("Query was cancelled"), deadline, deadline)).toEqual({ kind: "timeout" });
    expect(
      classifyReadQueryFailure(new Error("Read-only execution exceeded the row budget: late"), deadline + 1, deadline),
    ).toEqual({
      kind: "timeout",
    });
  });

  test("leaves any other failure before the deadline to the engine error", () => {
    const error = new Error("no such table: missing");
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "engine", error });
  });

  test("reads a thrown value that is not an Error", () => {
    expect(classifyReadQueryFailure("Read-only execution exceeded the byte budget: 2 > 1", 1, 2)).toEqual({
      kind: "too-large",
      text: BYTES,
    });
  });
});

describe("the prefixes the mapper matches still start a message in each provider that raises it", () => {
  const RAISED_IN: Record<string, readonly string[]> = {
    "Read-only execution exceeded the row budget": ["sqlite.ts", "duckdb/index.ts", "postgres.ts", "mssql.ts"],
    "Read-only execution exceeded the byte budget": ["sqlite.ts", "duckdb/index.ts", "postgres.ts", "mssql.ts"],
    "Read-only execution refused a value the server cut at the byte budget": ["mssql.ts"],
    "Read-only execution cannot bound a serialised result": ["mssql.ts"],
    "Read-only execution exceeded the time budget": ["sqlite.ts", "duckdb/index.ts"],
    "Read-only execution exceeded its time budget": ["mssql.ts"],
  };

  test("every prefix the mapper matches is listed here", () => {
    expect(READ_ONLY_REFUSALS.map((refusal) => refusal.prefix).sort()).toEqual(Object.keys(RAISED_IN).sort());
  });

  test.each(Object.entries(RAISED_IN).flatMap(([prefix, files]) => files.map((file) => [prefix, file] as const)))(
    "%p opens a message in %s",
    (prefix, file) => {
      expect(readFileSync(join(PROVIDERS, file), "utf8")).toContain(`\`${prefix}`);
    },
  );
});

describe("raceDeadline", () => {
  const soon = () => Date.now() + 1_000;

  test("answers the work's value", async () => {
    expect(await raceDeadline(async () => 42, new AbortController().signal, soon())).toEqual({
      kind: "settled",
      value: 42,
    });
  });

  test("answers a rejection, or a synchronous throw, with the time it settled", async () => {
    const error = new Error("refused");
    const before = Date.now();
    const rejected = await raceDeadline(() => Promise.reject(error), new AbortController().signal, soon());
    expect(rejected).toMatchObject({ kind: "failed", error });
    expect(rejected.kind === "failed" && rejected.settledAt >= before).toBe(true);
    const thrown = await raceDeadline(
      () => {
        throw error;
      },
      new AbortController().signal,
      soon(),
    );
    expect(thrown).toMatchObject({ kind: "failed", error });
  });

  test("answers cancelled when the signal aborts while the work runs", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(await raceDeadline(() => new Promise<never>(() => {}), controller.signal, soon())).toEqual({
      kind: "cancelled",
    });
  });

  test("answers timeout when the deadline passes while the work runs", async () => {
    expect(
      await raceDeadline(() => new Promise<never>(() => {}), new AbortController().signal, Date.now() + 20),
    ).toEqual({ kind: "timeout" });
  });

  test("never starts the work on an aborted signal or with no time left", async () => {
    let started = 0;
    const work = async () => {
      started += 1;
      return 1;
    };
    const aborted = new AbortController();
    aborted.abort();
    expect(await raceDeadline(work, aborted.signal, soon())).toEqual({ kind: "cancelled" });
    expect(await raceDeadline(work, new AbortController().signal, Date.now() - 1)).toEqual({ kind: "timeout" });
    expect(started).toBe(0);
  });
});
