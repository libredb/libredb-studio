/**
 * The pure rules of run_read_query (#246): the offset rule's answers, the mapping of a failure to
 * its answer by its error kind, whatever its words, the timeout classification, the deadline race
 * and the texts a caller reads. Which provider sites raise a budget refusal as its class is held by
 * tests/unit/db/operations/budget-refusal-census.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { ERROR_KINDS } from "@/lib/db/error-record";
import {
  ByteBudgetRefusal,
  ConnectionError,
  CutValueRefusal,
  QueryError,
  ReadAllowanceExceededError,
  RefusedBeforeSendError,
  RowBudgetRefusal,
  SerialisedResultRefusal,
  StudioByteBudgetRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
  TimeBudgetRefusal,
  TimeoutError,
} from "@/lib/db/errors";
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
  MCP_FAILURE_OF_KIND,
  MCP_TIMEOUT_BOUNDS_MS,
  moreRowsThanPageableHint,
  nextPageHint,
  offsetRefusalText,
  pagesWithOffset,
  profileRefusalText,
  raceDeadline,
  ROW_OVER_CAP_TEXT,
  timeoutText,
  tooLargeTextsOf,
} from "@/lib/mcp/tools/read-query-limits";
import { RUN_READ_QUERY_ENGINES, RUN_READ_QUERY_TYPES } from "../../helpers/run-read-query";

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
/** Elasticsearch SQL has no OFFSET, so the next page is asked for by key, as measured on 9.1.4. */
const KEYSET = "ORDER BY a unique field, and for the next page add WHERE that field > the last value read";
const NO_OFFSET = `This engine's SQL has no OFFSET, so this query cannot be paged with offset. Page it in SQL: ${KEYSET}.`;
/** CQL has no OFFSET either (a syntax error on 5.0.9): the next partitions by token, rows of one partition by key. */
const BY_TOKEN =
  "LIMIT n, and for the next page add WHERE token(the partition key) > token(the last one read), or, within one partition, WHERE the clustering column > the last value read";
const NO_CQL_OFFSET = `This engine's SQL has no OFFSET, so this query cannot be paged with offset. Page it in SQL: ${BY_TOKEN}.`;
/** Oracle has no LIMIT (ORA-03047 on 23ai); its own row limiting clauses are named instead. */
const OWN_LIMIT_ORACLE =
  "This query has its own FETCH FIRST, OFFSET ... FETCH or ROWNUM, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.";
/** Db2's own row limiting clauses, LIMIT among them, are named rather than SQL Server's TOP (measured on 12.1.0.0). */
const OWN_LIMIT_DB2 =
  "This query has its own FETCH FIRST, OFFSET ... FETCH or LIMIT, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.";
const OWN_LIMIT_MSSQL =
  "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.";

describe("the texts", () => {
  test("are the design's words", () => {
    expect(inSqlPaging("postgres")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("clickhouse")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("libsql")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("influxdb3")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("opensearch")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("couchbase")).toBe("Page it in SQL: LIMIT n OFFSET m.");
    expect(inSqlPaging("elasticsearch")).toBe(
      "Page it in SQL: ORDER BY a unique field, and for the next page add WHERE that field > the last value read.",
    );
    expect(inSqlPaging("cassandra")).toBe(`Page it in SQL: ${BY_TOKEN}.`);
    expect(inSqlPaging("mssql")).toBe("Page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.");
    expect(inSqlPaging("oracle")).toBe("Page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.");
    expect(inSqlPaging("db2")).toBe("Page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.");
    expect(moreRowsThanPageableHint("sqlite")).toBe(
      "More rows exist than this result holds, and this query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m.",
    );
    expect(moreRowsThanPageableHint("elasticsearch")).toBe(
      "More rows exist than this result holds, and this query cannot be paged with offset. Page it in SQL: ORDER BY a unique field, and for the next page add WHERE that field > the last value read.",
    );
    expect(moreRowsThanPageableHint("cassandra")).toBe(
      `More rows exist than this result holds, and this query cannot be paged with offset. Page it in SQL: ${BY_TOKEN}.`,
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

  test("the timeout answer offers more time only below the most timeout_ms allows", () => {
    expect(MCP_TIMEOUT_BOUNDS_MS.max).toBe(30_000);
    expect(timeoutText(500)).toBe(
      "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000.",
    );
    expect(timeoutText(29_999)).toBe(
      "The statement did not finish within timeout_ms (29999 ms). Narrow it, or raise timeout_ms up to 30000.",
    );
    expect(timeoutText(30_000)).toBe("The statement did not finish within timeout_ms (30000 ms). Narrow it.");
  });

  // #1462: an ExecutionProfileError message (postgres.ts's assertAgentRoleIsUnprivileged,
  // mssql.ts's assertAgentPrincipalIsUnprivileged) already ends in a period, and
  // inspect_schema is refused by the same profile, so neither a double period nor the
  // "inspect_schema works on every engine" claim should appear.
  test("profileRefusalText strips a message's own trailing period rather than doubling it, and no longer claims inspect_schema works on every engine", () => {
    expect(
      profileRefusalText(
        "The agent read-only execution profile requires a least-privilege PostgreSQL role; this role is unverified or too broad (is_superuser). A read-only transaction does not stop server-side file access or program execution.",
        RUN_READ_QUERY_ENGINES,
        "run_read_query",
      ),
    ).toBe(
      `run_read_query cannot run on this connection: The agent read-only execution profile requires a least-privilege PostgreSQL role; this role is unverified or too broad (is_superuser). A read-only transaction does not stop server-side file access or program execution. It runs on ${RUN_READ_QUERY_ENGINES}.`,
    );
  });
});

/**
 * The statements each served engine takes, among those the fence admits, as measured on 2026-10-27: SQLite 3.53.4 and
 * SQL Server 2022 refuse `TABLE`, SQL Server also refuses a bare `VALUES` and has no `EXPLAIN`, and MariaDB 11.8
 * refuses `TABLE` where MySQL runs it, so a refusal names only what the connection's engine runs. ClickHouse
 * 26.7.1.1315, measured on 2026-11-01, answers a bare `VALUES` and `TABLE` with a syntax error (code 62) and runs
 * `EXPLAIN`. libSQL (sqld 0.24.33), measured on 2026-11-01 with a read-only token, runs a bare `VALUES` and `EXPLAIN`
 * (`EXPLAIN QUERY PLAN` too) and answers `TABLE` and `EXPLAIN ANALYZE` with a syntax error, as SQLite does. InfluxDB 3
 * Core 3.12.0, measured on 2026-11-01 through the agent read-only path, runs a bare `VALUES` and `EXPLAIN` (`VERBOSE`
 * too), answers `TABLE` with a parser error, and runs `EXPLAIN ANALYZE`, which the fence refuses. Elasticsearch
 * 9.1.4, measured on 2026-11-01 through the agent read-only path, runs a `SELECT` and `EXPLAIN`, parses a `WITH` but
 * reads a name it defines as an index ("Unknown index"), and refuses `VALUES`, `TABLE` and `EXPLAIN ANALYZE` in its
 * grammar. OpenSearch 3.8.0, measured on 2026-11-02 through the agent read-only path, runs a `SELECT` and pages it
 * with `LIMIT n OFFSET m`; the path's statement check refuses a comment, a subquery, a `WITH`, a `JOIN` and a
 * double-quoted name, and the plugin refuses `WITH`, `VALUES`, `TABLE` and `EXPLAIN`. Oracle AI Database 26ai Free
 * 23.26.3, measured on 2026-11-02 through the agent read-only path, runs a `SELECT` and a `WITH`, answers a bare
 * `VALUES` and `TABLE` with ORA-00900 and `EXPLAIN` with ORA-02000, and refuses `EXPLAIN PLAN`, which writes its rows
 * into PLAN_TABLE, inside the read-only transaction (ORA-01456).
 * Apache Cassandra 5.0.9, measured on 2026-11-02 as a role holding only SELECT on its keyspace, runs a `SELECT`
 * (`JSON` and `DISTINCT` too) and answers `WITH`, `VALUES`, `TABLE`, `EXPLAIN` and `OFFSET` with a syntax error, and the
 * agent path reads one table of the connection's keyspace or of `system_schema`.
 * Couchbase Server 8.0.2 Enterprise, measured on 2026-11-02 through the agent read-only path, runs a `SELECT` (a
 * `WITH` before it too), while the path's statement check refuses `EXPLAIN` and every other statement before it is
 * sent, and SQL++ has no bare `VALUES` or `TABLE` statement.
 * Db2 12.1.0.0, measured on 2026-11-02 through the agent read-only path, which sends the statement inside a derived
 * table, runs a `SELECT`, a `WITH` and a bare `VALUES`, and answers `TABLE` and `EXPLAIN` with SQL0104N.
 */
describe("the accepted forms each engine's refusal names", () => {
  test.each([
    ["postgres", "a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE"],
    ["sqlite", "a SELECT (a WITH is fine), VALUES, or EXPLAIN"],
    ["duckdb", "a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE"],
    ["mssql", "a SELECT (a WITH is fine)"],
    ["mysql", "a SELECT (a WITH is fine), VALUES, TABLE (MySQL, not MariaDB), or EXPLAIN without ANALYZE"],
    ["clickhouse", "a SELECT (a WITH is fine), or EXPLAIN without ANALYZE"],
    ["libsql", "a SELECT (a WITH is fine), VALUES, or EXPLAIN"],
    ["influxdb3", "a SELECT (a WITH is fine), VALUES, or EXPLAIN without ANALYZE"],
    [
      "elasticsearch",
      "a SELECT that reads at most one index expression, with no comment, subquery, WITH or JOIN, or an EXPLAIN of such a SELECT",
    ],
    [
      "opensearch",
      "a SELECT that reads at most one index expression, with no comment, subquery, WITH, JOIN or double quote (quote a name in backticks)",
    ],
    ["oracle", "a SELECT (a WITH is fine)"],
    ["db2", "a SELECT (a WITH is fine), or VALUES"],
    ["cassandra", "a SELECT of one table of the connection's keyspace or of system_schema"],
    ["couchbase", "a SELECT (a WITH is fine)"],
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

  test("every engine pages with OFFSET but Elasticsearch and Cassandra, whose SQL has none", () => {
    expect(RUN_READ_QUERY_TYPES.filter((type) => !pagesWithOffset(type))).toEqual(["elasticsearch", "cassandra"]);
    expect(READ_QUERY_FORMS.elasticsearch?.paging).toBe(KEYSET);
    expect(READ_QUERY_FORMS.cassandra?.paging).toBe(BY_TOKEN);
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
    ["SELECT id FROM numbers ORDER BY id LIMIT 2 OFFSET 1", "libsql", OWN_LIMIT],
    ["SELECT id FROM numbers", "libsql", "This query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m."],
    ["VALUES (1), (2), (3)", "libsql", "This statement's result cannot be paged. Call again without offset."],
    [
      "EXPLAIN QUERY PLAN SELECT id FROM numbers",
      "libsql",
      "This statement's result cannot be paged. Call again without offset.",
    ],
    ["SELECT room FROM home ORDER BY time LIMIT 2 OFFSET 1", "influxdb3", OWN_LIMIT],
    ["SELECT room FROM home", "influxdb3", "This query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m."],
    ["VALUES (1), (2), (3)", "influxdb3", "This statement's result cannot be paged. Call again without offset."],
    [
      "EXPLAIN SELECT count(*) FROM home",
      "influxdb3",
      "This statement's result cannot be paged. Call again without offset.",
    ],
    ["SELECT k FROM probe_buckets", "elasticsearch", NO_OFFSET],
    ["SELECT k FROM probe_buckets ORDER BY k LIMIT 5", "elasticsearch", NO_OFFSET],
    [
      "EXPLAIN SELECT k FROM probe_buckets",
      "elasticsearch",
      "This statement's result cannot be paged. Call again without offset.",
    ],
    // OpenSearch's SQL has an OFFSET, so its offset refusals are the shared ones.
    ["SELECT k FROM probe_buckets ORDER BY k LIMIT 5", "opensearch", OWN_LIMIT],
    [
      "SELECT k FROM probe_buckets",
      "opensearch",
      "This query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m.",
    ],
    [
      "EXPLAIN SELECT k FROM probe_buckets",
      "opensearch",
      "This statement's result cannot be paged. Call again without offset.",
    ],
    // Oracle's own row limiting clause, its OFFSET form, and ROWNUM each count as the query's own limit.
    ["SELECT id FROM t ORDER BY id FETCH FIRST 3 ROWS ONLY", "oracle", OWN_LIMIT_ORACLE],
    ["SELECT id FROM t ORDER BY id OFFSET 1 ROWS FETCH NEXT 3 ROWS ONLY", "oracle", OWN_LIMIT_ORACLE],
    ["SELECT id FROM t WHERE ROWNUM <= 3", "oracle", OWN_LIMIT_ORACLE],
    [
      "SELECT id FROM t",
      "oracle",
      "This query cannot be paged with offset. Page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.",
    ],
    ["VALUES (1)", "oracle", "This statement's result cannot be paged. Call again without offset."],
    [
      "EXPLAIN PLAN FOR SELECT 1 FROM DUAL",
      "oracle",
      "This statement's result cannot be paged. Call again without offset.",
    ],
    // Db2's FETCH FIRST, its OFFSET form and LIMIT each count as the query's own limit.
    ["SELECT ID FROM APP.ORDERS ORDER BY ID FETCH FIRST 2 ROWS ONLY", "db2", OWN_LIMIT_DB2],
    ["SELECT ID FROM APP.ORDERS ORDER BY ID OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY", "db2", OWN_LIMIT_DB2],
    ["SELECT ID FROM APP.ORDERS ORDER BY ID LIMIT 2 OFFSET 1", "db2", OWN_LIMIT_DB2],
    ["SELECT ID FROM APP.ORDERS ORDER BY ID LIMIT 2", "db2", OWN_LIMIT_DB2],
    [
      "SELECT ID FROM APP.ORDERS ORDER BY ID",
      "db2",
      "This query cannot be paged with offset. Page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.",
    ],
    ["VALUES (1), (2), (3)", "db2", "This statement's result cannot be paged. Call again without offset."],
    [
      "EXPLAIN PLAN FOR SELECT ID FROM APP.ORDERS",
      "db2",
      "This statement's result cannot be paged. Call again without offset.",
    ],
    ["SELECT id FROM probe.customers", "cassandra", NO_CQL_OFFSET],
    ["SELECT id FROM probe.customers LIMIT 5", "cassandra", NO_CQL_OFFSET],
    ["SELECT id FROM probe.customers WHERE id = 1 LIMIT 5 ALLOW FILTERING", "cassandra", NO_CQL_OFFSET],
    ["SELECT d.n FROM `_default` AS d ORDER BY d.n LIMIT 2 OFFSET 1", "couchbase", OWN_LIMIT],
    [
      "SELECT d.n FROM `_default` AS d ORDER BY d.n",
      "couchbase",
      "This query cannot be paged with offset. Page it in SQL: LIMIT n OFFSET m.",
    ],
    [
      "EXPLAIN SELECT d.n FROM `_default` AS d",
      "couchbase",
      "This statement's result cannot be paged. Call again without offset.",
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

  test("answers any failure that settles at or after the deadline as the deadline", () => {
    expect(classifyReadQueryFailure(new Error("Query was cancelled"), deadline, deadline)).toEqual({
      kind: "deadline",
    });
    expect(
      classifyReadQueryFailure(new RowBudgetRefusal(rowBudgetSentence(1001, 1000)), deadline + 1, deadline),
    ).toEqual({
      kind: "deadline",
    });
  });

  test("a failure settling at or after the deadline is the deadline, whatever its class", () => {
    for (const error of [
      new TimeBudgetRefusal(rowBudgetSentence(1001, 1000), "postgres"),
      new QueryError("relation does not exist", "postgres"),
      new RefusedBeforeSendError("the statement writes", "postgres"),
      "a thrown string",
    ]) {
      expect(classifyReadQueryFailure(error, deadline, deadline)).toEqual({ kind: "deadline" });
      expect(classifyReadQueryFailure(error, deadline + 1, deadline)).toEqual({ kind: "deadline" });
    }
  });

  test("a time budget refusal before the deadline is the timeout", () => {
    expect(classifyReadQueryFailure(new TimeBudgetRefusal("over time", "postgres"), deadline - 1, deadline)).toEqual({
      kind: "timeout",
    });
  });

  test("answers a pre-send refusal with the error itself, for the caller to render", () => {
    const error = new RefusedBeforeSendError(
      "Read-only execution refused the statement before sending it: not-a-real-fence",
    );
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "not-sent", error });
  });

  test("answers a provider's own subclass of a pre-send refusal with the error itself", () => {
    class FenceRefusal extends RefusedBeforeSendError {}
    const error = new FenceRefusal(`${crypto.randomUUID()} ${crypto.randomUUID()}`, "postgres");
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "not-sent", error });
  });

  test("keeps the read allowance's refusal as too large, though it too is refused before sending", () => {
    const error = new ReadAllowanceExceededError("Read-only execution exceeded the read allowance: not-a-real-read");
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "too-large", text: error.message });
  });

  test("leaves any other failure before the deadline to the engine error", () => {
    const error = new Error("no such table: missing");
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "engine", error });
  });
});

describe("a failure is answered by its class", () => {
  const deadline = 10_000;
  const words = () => `${crypto.randomUUID()} ${crypto.randomUUID()}`;
  const TIMEOUT = { kind: "timeout" } as const;
  const tooLarge = (text: string) => ({ kind: "too-large", text }) as const;

  test.each([
    ["RowBudgetRefusal", "too-large", (text: string) => new RowBudgetRefusal(text, "postgres"), tooLarge(ROWS)],
    [
      "StudioRowBudgetRefusal",
      "too-large",
      (text: string) => new StudioRowBudgetRefusal(text, "postgres"),
      tooLarge(ROWS),
    ],
    ["ByteBudgetRefusal", "too-large", (text: string) => new ByteBudgetRefusal(text, "postgres"), tooLarge(BYTES)],
    [
      "StudioByteBudgetRefusal",
      "too-large",
      (text: string) => new StudioByteBudgetRefusal(text, "postgres"),
      tooLarge(BYTES),
    ],
    ["CutValueRefusal", "too-large", (text: string) => new CutValueRefusal(text, "mssql"), tooLarge(CUT_VALUE)],
    [
      "SerialisedResultRefusal",
      "too-large",
      (text: string) => new SerialisedResultRefusal(text, "mssql"),
      tooLarge(SERIALISED),
    ],
    ["TimeBudgetRefusal", "the timeout", (text: string) => new TimeBudgetRefusal(text, "postgres"), TIMEOUT],
    [
      "StudioTimeBudgetRefusal",
      "the timeout",
      (text: string) => new StudioTimeBudgetRefusal(text, "postgres"),
      TIMEOUT,
    ],
  ] as const)("a %s answers %s, whatever its words", (_label, _answer, make, expected) => {
    expect(classifyReadQueryFailure(make(words()), 1_000, deadline)).toEqual(expected);
  });

  test("an arm's own texts answer each too-large class in its statement language's words", () => {
    const texts = { rows: words(), bytes: words(), "cut-value": words(), serialised: words() };
    expect(classifyReadQueryFailure(new RowBudgetRefusal(words()), 1_000, deadline, texts)).toEqual(
      tooLarge(texts.rows),
    );
    expect(classifyReadQueryFailure(new ByteBudgetRefusal(words()), 1_000, deadline, texts)).toEqual(
      tooLarge(texts.bytes),
    );
    expect(classifyReadQueryFailure(new CutValueRefusal(words()), 1_000, deadline, texts)).toEqual(
      tooLarge(texts["cut-value"]),
    );
    expect(classifyReadQueryFailure(new SerialisedResultRefusal(words()), 1_000, deadline, texts)).toEqual(
      tooLarge(texts.serialised),
    );
  });

  // A `TimeoutError` says some timeout fired, not that it was the call's: Cassandra's coordinator, a connection's own
  // query timeout or a client socket timeout may be shorter than timeout_ms. Before the deadline the provider's own
  // text names which one, so the timeout answer, which says timeout_ms was reached, would be false.
  test("a timeout of any author before the deadline is the engine's, whose text names which timeout fired", () => {
    for (const error of [
      new TimeoutError(words(), "cassandra", 1_000),
      new StudioTimeoutRefusal(words(), "postgres", 1_000),
    ]) {
      expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "engine", error });
    }
  });

  test("a timeout of any author at or after the deadline answers the deadline", () => {
    for (const error of [
      new TimeoutError(words(), "cassandra", 1_000),
      new StudioTimeoutRefusal(words(), "postgres", 1_000),
    ]) {
      expect(classifyReadQueryFailure(error, deadline, deadline)).toEqual({ kind: "deadline" });
    }
  });

  test("a failure whose class is no budget's is the engine's, whatever its words", () => {
    const sentences = [
      ROW_BUDGET_PREFIX,
      BYTE_BUDGET_PREFIX,
      TIME_BUDGET_PREFIX,
      MSSQL_CUT_VALUE_PREFIX,
      MSSQL_SERIALISED_PREFIX,
      MSSQL_TIME_BUDGET_PREFIX,
      rowBudgetSentence(1001, 1000),
      byteBudgetSentence(2000000, 1048576),
    ];
    for (const sentence of sentences) {
      for (const error of [
        new QueryError(sentence, "postgres"),
        new Error(sentence),
        sentence,
        new ConnectionError(sentence, "postgres"),
      ]) {
        expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual({ kind: "engine", error });
      }
    }
  });

  test("MySQL's and MongoDB's deadline refusal is the timeout before the deadline", () => {
    const error = new TimeBudgetRefusal(
      "Read-only execution exceeded the statement deadline of 500ms and was killed server-side",
      "mysql",
    );
    expect(classifyReadQueryFailure(error, 1_000, deadline)).toEqual(TIMEOUT);
  });

  test("every error kind has one answer", () => {
    expect(Object.keys(MCP_FAILURE_OF_KIND).sort()).toEqual([...ERROR_KINDS].sort());
  });

  // Oracle has no LIMIT, so its budget refusals name its own row limiting clause.
  test("answers Oracle's budget refusals in Oracle's clause", () => {
    const texts = tooLargeTextsOf("oracle");
    expect(texts).toEqual({
      rows: "The result has more than 1000 rows, the most this server reads for one call. Add FETCH FIRST n ROWS ONLY with n of 1000 or less, or remove your own FETCH FIRST, OFFSET ... FETCH or ROWNUM and page with offset.",
      bytes:
        "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add FETCH FIRST n ROWS ONLY with a smaller n.",
    });
    expect(classifyReadQueryFailure(new RowBudgetRefusal(words(), "oracle"), 1_000, deadline, texts)).toEqual(
      tooLarge(texts.rows ?? ""),
    );
    for (const type of ["postgres", "mssql", "clickhouse", "opensearch"] as const) {
      expect(tooLargeTextsOf(type)).toEqual({});
    }
  });

  // Db2 names its own row limiting clauses too, LIMIT among them, never SQL Server's TOP.
  test("answers Db2's budget refusals in Db2's clause", () => {
    const texts = tooLargeTextsOf("db2");
    expect(texts).toEqual({
      rows: "The result has more than 1000 rows, the most this server reads for one call. Add FETCH FIRST n ROWS ONLY with n of 1000 or less, or remove your own FETCH FIRST, OFFSET ... FETCH or LIMIT and page with offset.",
      bytes:
        "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add FETCH FIRST n ROWS ONLY with a smaller n.",
    });
    expect(classifyReadQueryFailure(new ByteBudgetRefusal(words(), "db2"), 1_000, deadline, texts)).toEqual(
      tooLarge(texts.bytes ?? ""),
    );
  });

  // kubectl's own refusals are fed to the mapper in tests/unit/db/kubernetes/machine-read.test.ts.
  test("maps MongoDB's row refusal at the cursor bound to too-large", () => {
    const error = rowBudgetRefusal(201, { statementTimeoutMs: 1, maxResultRows: 200, maxResultBytes: 1 }, "{}", true);
    expect(classifyReadQueryFailure(error, 1_000, 10_000)).toEqual(tooLarge(ROWS));
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
