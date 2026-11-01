/**
 * The pure rules of run_read_query (#246): the offset rule's answers, the mapping of this
 * repository's own provider refusals, the timeout classification, the deadline race and the texts
 * a caller reads. The provider files are read, never edited, so a reworded message breaks this
 * build instead of falling through to an engine error, and a provider that types out the row or
 * byte refusal again instead of calling the shared constructor breaks it too (D367).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReadAllowanceExceededError, RefusedBeforeSendError } from "@/lib/db/errors";
import { rowBudgetRefusal } from "@/lib/db/providers/document/mongodb/agent-read";
import { READ_QUERY_FORMS, readQueryFormsOf } from "@/lib/db/providers/sql/read-query-forms";
import {
  MSSQL_CUT_VALUE_PREFIX,
  MSSQL_SERIALISED_PREFIX,
  MSSQL_TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/mssql-read-only-refusals";
import {
  BYTE_BUDGET_PREFIX,
  byteBudgetSentence,
  ROW_BUDGET_PREFIX,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import {
  classifyReadQueryFailure,
  fenceRefusalText,
  inSqlPaging,
  moreRowsThanPageableHint,
  nextPageHint,
  offsetRefusalText,
  profileRefusalText,
  raceDeadline,
  READ_ONLY_REFUSALS,
  ROW_OVER_CAP_TEXT,
  timeoutText,
} from "@/lib/mcp/tools/read-query-limits";
import { RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";

const REPO = join(import.meta.dir, "../../..");
const read = (file: string): string => readFileSync(join(REPO, file), "utf8");
const ROWS =
  "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, or remove your own LIMIT and page with offset.";
const BYTES =
  "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.";
const CUT_VALUE =
  "One value in this result is 1 MiB or larger, and SQL Server cut it at the most this server reads for one call. Select fewer or narrower columns, for example a substring of a long text column.";
const SERIALISED =
  "SQL Server returns a FOR JSON or FOR XML result as one serialised value, which this server cannot bound. Select the rows themselves, without the FOR JSON or FOR XML clause.";
const OWN_LIMIT =
  "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: LIMIT n OFFSET m.";
const OWN_LIMIT_MSSQL =
  "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.";

describe("the texts", () => {
  test("are the design's words", () => {
    expect(inSqlPaging("postgres")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("clickhouse")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("mssql")).toBe("Page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.");
    expect(moreRowsThanPageableHint("sqlite")).toBe(
      "More rows exist than this result holds, and this query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m.",
    );
    expect(nextPageHint(100)).toBe("Call again with offset 100 for the next page.");
    expect(timeoutText(500)).toBe(
      "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000.",
    );
    expect(ROW_OVER_CAP_TEXT).toBe(
      "One row of this result is larger than the 32 KiB result limit. Select fewer or narrower columns, for example a substring of a long text column.",
    );
    expect(fenceRefusalText("NON_READ_STATEMENT", "postgres")).toBe(
      "The statement was refused before it reached the database (NON_READ_STATEMENT). On this engine run_read_query runs one read-only statement: a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE.",
    );
    expect(
      profileRefusalText("the engine has no read-only statement path", "PostgreSQL and SQLite", "run_read_query"),
    ).toBe(
      "run_read_query cannot run on this connection: the engine has no read-only statement path. It runs on PostgreSQL and SQLite.",
    );
  });

  // #1462: an ExecutionProfileError message (postgres.ts's assertAgentRoleIsUnprivileged,
  // mssql.ts's assertAgentPrincipalIsUnprivileged) already ends in a period, and
  // inspect_schema is refused by the same profile, so neither a double period nor the
  // "inspect_schema works on every engine" claim should appear.
  test("profileRefusalText strips a message's own trailing period rather than doubling it, and no longer claims inspect_schema works on every engine", () => {
    expect(
      profileRefusalText(
        "The agent read-only execution profile requires a least-privilege PostgreSQL role; this role is unverified or too broad (is_superuser). A read-only transaction does not stop server-side file access or program execution.",
        "PostgreSQL, SQLite, DuckDB, SQL Server, MySQL and ClickHouse",
        "run_read_query",
      ),
    ).toBe(
      "run_read_query cannot run on this connection: The agent read-only execution profile requires a least-privilege PostgreSQL role; this role is unverified or too broad (is_superuser). A read-only transaction does not stop server-side file access or program execution. It runs on PostgreSQL, SQLite, DuckDB, SQL Server, MySQL and ClickHouse.",
    );
  });
});

/**
 * The statements each served engine takes, among those the fence admits, as measured on 2026-10-27: SQLite 3.53.4 and
 * SQL Server 2022 refuse `TABLE`, SQL Server also refuses a bare `VALUES` and has no `EXPLAIN`, and MariaDB 11.8
 * refuses `TABLE` where MySQL runs it, so a refusal names only what the connection's engine runs. ClickHouse
 * 26.7.1.1315, measured on 2026-11-01, answers a bare `VALUES` and `TABLE` with a syntax error (code 62) and runs
 * `EXPLAIN`.
 */
describe("the accepted forms each engine's refusal names", () => {
  test.each([
    ["postgres", "a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE"],
    ["sqlite", "a SELECT (a WITH is fine), VALUES, or EXPLAIN"],
    ["duckdb", "a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE"],
    ["mssql", "a SELECT (a WITH is fine)"],
    ["mysql", "a SELECT (a WITH is fine), VALUES, TABLE (MySQL, not MariaDB), or EXPLAIN without ANALYZE"],
    ["clickhouse", "a SELECT (a WITH is fine), or EXPLAIN without ANALYZE"],
  ] as const)("%s: %s", (type, statements) => {
    expect(fenceRefusalText("NON_READ_STATEMENT", type)).toBe(
      `The statement was refused before it reached the database (NON_READ_STATEMENT). On this engine run_read_query runs one read-only statement: ${statements}.`,
    );
  });

  test("a SQLite refusal no longer offers TABLE", () => {
    expect(fenceRefusalText("NON_READ_STATEMENT", "sqlite")).not.toContain("TABLE");
  });

  test("every engine run_read_query serves has a row", () => {
    for (const type of RUN_READ_QUERY_TYPES) expect(READ_QUERY_FORMS[type]).not.toBeNull();
  });

  test("an engine with no row is refused by name, never answered with another engine's forms", () => {
    expect(READ_QUERY_FORMS.mongodb).toBeNull();
    expect(() => readQueryFormsOf("mongodb")).toThrow("run_read_query has no accepted-forms row for mongodb");
  });
});

describe("the offset rule", () => {
  test.each([
    ["SELECT id FROM numbers LIMIT 10", "sqlite", OWN_LIMIT],
    ["SELECT TOP 5 id FROM numbers", "mssql", OWN_LIMIT_MSSQL],
    ["SELECT id FROM numbers", "sqlite", "This query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m."],
    [
      "SELECT id FROM numbers",
      "mssql",
      "This query cannot be paged with offset. Page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.",
    ],
    ["SELECT id FROM numbers LIMIT 5", "clickhouse", OWN_LIMIT],
    [
      "SELECT id FROM numbers SETTINGS max_threads = 1",
      "clickhouse",
      "This query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m.",
    ],
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

  test("answers a refusal the provider raised before sending in this server's words", () => {
    const error = new RefusedBeforeSendError(
      "Read-only execution refused the statement before sending it: not-a-real-fence",
    );
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({
      kind: "not-sent",
      text: "The statement was refused before it reached the database: Read-only execution refused the statement before sending it: not-a-real-fence.",
    });
    expect(classifyReadQueryFailure(new RefusedBeforeSendError("Refused already."), 1_000, deadline)).toEqual({
      kind: "not-sent",
      text: "The statement was refused before it reached the database: Refused already.",
    });
  });

  test("keeps the read allowance's refusal as too large, though it too is refused before sending", () => {
    const error = new ReadAllowanceExceededError("Read-only execution exceeded the read allowance: not-a-real-read");
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "too-large", text: error.message });
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

describe("the budget sentences every provider shares (D367)", () => {
  test("read the way the mapper and rowBudgetIn read them", () => {
    expect(rowBudgetSentence(1001, 1000)).toBe("Read-only execution exceeded the row budget: 1001 rows > 1000 allowed");
    expect(byteBudgetSentence(2000000, 1048576)).toBe(
      "Read-only execution exceeded the byte budget: 2000000 bytes > 1048576 allowed",
    );
  });

  // The mapper matches the very openings the constructors write, so neither can be reworded alone.
  test("the mapper's row and byte entries are the shared module's prefixes", () => {
    expect(READ_ONLY_REFUSALS.filter(({ kind }) => kind === "rows" || kind === "bytes")).toEqual([
      { prefix: ROW_BUDGET_PREFIX, kind: "rows" },
      { prefix: BYTE_BUDGET_PREFIX, kind: "bytes" },
    ]);
    expect(rowBudgetSentence(1, 0).startsWith(`${ROW_BUDGET_PREFIX}: `)).toBe(true);
    expect(byteBudgetSentence(1, 0).startsWith(`${BYTE_BUDGET_PREFIX}: `)).toBe(true);
  });

  // MongoDB's row refusal adds a cursor-bound tail after the shared sentence; the mapper still reads it.
  // kubectl's own refusals are fed to the mapper in tests/unit/db/kubernetes/machine-read.test.ts.
  test("maps MongoDB's row refusal at the cursor bound to too-large", () => {
    const message = rowBudgetRefusal(
      201,
      { statementTimeoutMs: 1, maxResultRows: 200, maxResultBytes: 1 },
      "{}",
      true,
    ).message;
    expect(classifyReadQueryFailure(new Error(message), 1_000, 10_000)).toEqual({ kind: "too-large", text: ROWS });
  });
});

describe("the prefixes the mapper matches still start a message in each provider that raises it", () => {
  const SHARED = "src/lib/db/providers/sql/read-only-budget.ts";
  // The row and byte openings are constants of the shared module, so they are checked as declared there.
  const SHARED_PREFIXES = [ROW_BUDGET_PREFIX, BYTE_BUDGET_PREFIX];
  // Each opening an engine raises on its own, by the constant that declares it beside the provider and the files
  // that open a message with it.
  const RAISED_IN: Record<string, { readonly prefix: string; readonly files: readonly string[] }> = {
    MSSQL_CUT_VALUE_PREFIX: { prefix: MSSQL_CUT_VALUE_PREFIX, files: ["src/lib/db/providers/sql/mssql.ts"] },
    MSSQL_SERIALISED_PREFIX: { prefix: MSSQL_SERIALISED_PREFIX, files: ["src/lib/db/providers/sql/mssql.ts"] },
    TIME_BUDGET_PREFIX: {
      prefix: TIME_BUDGET_PREFIX,
      files: ["src/lib/db/providers/sql/sqlite.ts", "src/lib/db/providers/sql/duckdb/index.ts"],
    },
    MSSQL_TIME_BUDGET_PREFIX: { prefix: MSSQL_TIME_BUDGET_PREFIX, files: ["src/lib/db/providers/sql/mssql.ts"] },
  };
  // Each provider with a queryReadOnly, by the files that raise its row or byte refusal.
  const SHARED_USERS: Record<string, readonly string[]> = {
    postgres: ["src/lib/db/providers/sql/postgres.ts"],
    mysql: ["src/lib/db/providers/sql/mysql.ts"],
    mssql: ["src/lib/db/providers/sql/mssql.ts"],
    sqlite: ["src/lib/db/providers/sql/sqlite.ts"],
    duckdb: ["src/lib/db/providers/sql/duckdb/index.ts"],
    clickhouse: ["src/lib/db/providers/sql/clickhouse/agent-read.ts", "src/lib/db/providers/sql/clickhouse/index.ts"],
    mongodb: ["src/lib/db/providers/document/mongodb/agent-read.ts"],
    kubernetes: [
      "src/lib/db/providers/platform/kubernetes/machine-read.ts",
      "src/lib/db/providers/platform/kubernetes/console/describe.ts",
      "src/lib/db/providers/platform/kubernetes/console/events.ts",
      "src/lib/db/providers/platform/kubernetes/console/get-documents.ts",
      "src/lib/db/providers/platform/kubernetes/console/logs.ts",
    ],
  };

  test("every prefix the mapper matches is listed here", () => {
    expect(READ_ONLY_REFUSALS.map((refusal) => refusal.prefix).sort()).toEqual(
      [...SHARED_PREFIXES, ...Object.values(RAISED_IN).map(({ prefix }) => prefix)].sort(),
    );
  });

  test.each(Object.entries(RAISED_IN).flatMap(([name, { files }]) => files.map((file) => [name, file] as const)))(
    "%s opens a message in %s",
    (name, file) => {
      expect(read(file)).toContain("`${" + name + "}");
    },
  );

  // The MCP mapper answers a refusal by its opening and names no engine: every opening, and every engine's own
  // answer text, is declared beside the provider that raises it.
  test("the MCP module spells no refusal opening and no engine's answer of its own", () => {
    const source = read("src/lib/mcp/tools/read-query-limits.ts");
    expect(source.match(/["'`]Read-only execution[^"'`]*/g) ?? []).toEqual([]);
    expect(source.match(/SQL Server|SQLite|DuckDB/g) ?? []).toEqual([]);
  });

  test.each(SHARED_PREFIXES)("%p is written once, in the shared module", (prefix) => {
    expect(read(SHARED).split(prefix)).toHaveLength(2);
  });

  // The whole source tree, the MCP mapper included: it imports the prefixes rather than typing its own copy.
  test.each(SHARED_PREFIXES)("%p is written in no source file but the shared module", (prefix) => {
    const writers = readdirSync(join(REPO, "src"), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      // readdirSync answers with the platform separator; the census names files with "/".
      .map((file) => `src/${file.replaceAll("\\", "/")}`)
      .filter((file) => read(file).includes(prefix));
    expect(writers).toEqual([SHARED]);
  });

  test.each(
    Object.entries(SHARED_USERS).flatMap(([provider, files]) => files.map((file) => [provider, file] as const)),
  )("%s builds its budget refusal with the shared constructor in %s", (_provider, file) => {
    const source = read(file);
    expect(source).toMatch(
      /import \{[^}]*\b(rowBudgetSentence|byteBudgetSentence)\b[^}]*\} from "[^"]*read-only-budget";/,
    );
    expect(source).toMatch(/\b(rowBudgetSentence|byteBudgetSentence)\(/);
  });
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
