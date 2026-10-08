import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { DATABEND_LIMITER_OPTIONS } from "@/lib/db/providers/sql/databend/connection-options";
import {
  DATABEND_DEFAULT_SESSION_LIMIT,
  DATABEND_DEFAULT_SLOW_QUERY_LIMIT,
  DATABEND_DEGRADE_CODES,
  DATABEND_MAX_MONITORING_LIMIT,
  DATABEND_MONITORING_SENTENCES,
  DATABEND_UNAVAILABLE_TEXT,
  DATABEND_UNKNOWN_TEXT,
  databendSessionsSql,
  databendSlowQueriesSql,
  getActiveSessions,
  getHealth,
  getIndexStats,
  getOverview,
  getPerformanceMetrics,
  getSlowQueries,
  getStorageStats,
  getTableStats,
  killSession,
} from "@/lib/db/providers/sql/databend/introspect";
import {
  DATABEND_OBJECT_SENTENCES,
  DATABEND_SURFACE_ROW_CUT,
  type DatabendStatementRunner,
} from "@/lib/db/providers/sql/databend/objects";
import {
  DatabendError,
  type DatabendTruncation,
  type StatementOutcome,
} from "@/lib/db/providers/sql/databend/transport";

/** The en dash and the em dash, built from their code points so this file holds neither. */
const DASHES = new RegExp("[\\u2013\\u2014]");

function outcome(
  columns: readonly (readonly [string, string])[],
  rows: readonly (readonly (string | null)[])[],
  truncated: DatabendTruncation | null = null,
): StatementOutcome {
  return {
    schema: columns.map(([name, type]) => ({ name, type })),
    rows,
    truncated,
    notices: [],
    hasResultSet: true,
    affect: null,
  };
}

/** A runner answering by statement text, recording every statement it was handed. */
function routed(answers: Record<string, StatementOutcome | Error>) {
  const calls: { sql: string; rowCut: number }[] = [];
  const runner: DatabendStatementRunner = async (sql, rowCut) => {
    calls.push({ sql, rowCut });
    const answer = answers[sql];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { runner, calls };
}

function failure(code: number): DatabendError {
  return new DatabendError("statement", `failed with ${code}`, { code });
}

/** The sessions read's columns as the fixture answered them (measured 2026-10-08 on v1.2.951-nightly). */
const SESSION_SCHEMA = [
  ["session_id", "String"],
  ["query_id", "String"],
  ["user_name", "String"],
  ["host", "Nullable(String)"],
  ["database_name", "String"],
  ["command", "String"],
  ["query_text", "String"],
  ["created_time", "Timestamp"],
  ["elapsed_seconds", "UInt64"],
] as const;

const SESSION_ROW = [
  "5c00e52f-34c2-4cab-8ba8-c1f1121157bf",
  "8fea4d81679744d097a29a9e964dd563",
  "studio_reader",
  "172.20.0.1",
  "libredb_demo",
  "Query",
  "SELECT 1",
  "2026-10-07 22:58:07.375243",
  "3",
];

const SLOW_SCHEMA = [
  ["query_id", "String"],
  ["query_text", "String"],
  ["query_duration_ms", "Int64"],
  ["result_rows", "UInt64"],
] as const;

/**
 * The design 5.5 statements, written out; the tests below hold each panel to them. No read matches on statement text:
 * both reads of `system.processes` read the query id each statement was sent under, which Studio's own are left out by.
 */
const BASE_TABLES =
  "FROM default.system.tables WHERE catalog = 'default' AND table_type = 'BASE TABLE' AND database NOT IN ('system', 'information_schema')";
const VERSION_SQL = "SELECT version() AS server_version";
const OVERVIEW_TABLES_SQL = `SELECT count(*) AS table_count, sum(data_compressed_size) AS compressed_bytes, sum(index_size) AS index_bytes ${BASE_TABLES}`;
const ACTIVE_QUERIES_SQL =
  "SELECT current_query_id AS query_id, count(*) OVER () AS running FROM default.system.processes WHERE command = 'Query' ORDER BY created_time DESC LIMIT 500";
const INDEX_COUNT_SQL = "SELECT count(*) AS index_count FROM default.system.indexes";
const STORAGE_SQL = `SELECT database AS database_name, sum(data_compressed_size) AS compressed_bytes, sum(index_size) AS index_bytes ${BASE_TABLES} GROUP BY database ORDER BY database`;
const tableStatsSql = (scope = "") =>
  `SELECT database AS schema_name, name AS table_name, num_rows, data_compressed_size, index_size ${BASE_TABLES}${scope} ORDER BY data_compressed_size DESC`;
const indexStatsSql = (scope = "") =>
  `SELECT database AS schema_name, \`table\` AS table_name, name AS index_name, \`type\` AS index_type, definition FROM default.system.indexes${scope} ORDER BY database, \`table\`, name`;

/** The statements a read sends to a runner that answers every one with no rows. */
async function sentBy(read: (runner: DatabendStatementRunner) => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  await read(async (sql) => {
    sent.push(sql);
    return outcome([], []);
  });
  return sent;
}

const OVERVIEW_ANSWERS = {
  [VERSION_SQL]: outcome([["server_version", "String"]], [["8.0.26-v1.2.951-nightly"]]),
  [OVERVIEW_TABLES_SQL]: outcome(
    [
      ["table_count", "UInt64"],
      ["compressed_bytes", "Nullable(UInt64)"],
      ["index_bytes", "Nullable(UInt64)"],
    ],
    [["2", "14915", "3389"]],
  ),
  [ACTIVE_QUERIES_SQL]: outcome(
    [
      ["query_id", "String"],
      ["running", "UInt64"],
    ],
    [["8fea4d81679744d097a29a9e964dd563", "1"]],
  ),
  [INDEX_COUNT_SQL]: outcome([["index_count", "UInt64"]], [["4"]]),
};

describe("the design 5.5 statements, exactly, as each panel sends them", () => {
  test("the overview reads the default catalog's sums and counts command = 'Query' [X35], one at a time", async () => {
    expect(OVERVIEW_TABLES_SQL).toBe(
      "SELECT count(*) AS table_count, sum(data_compressed_size) AS compressed_bytes, sum(index_size) AS index_bytes FROM default.system.tables WHERE catalog = 'default' AND table_type = 'BASE TABLE' AND database NOT IN ('system', 'information_schema')",
    );
    expect(ACTIVE_QUERIES_SQL).toBe(
      `SELECT current_query_id AS query_id, count(*) OVER () AS running FROM default.system.processes WHERE command = 'Query' ORDER BY created_time DESC LIMIT ${DATABEND_MAX_MONITORING_LIMIT}`,
    );
    const { runner, calls } = routed(OVERVIEW_ANSWERS);
    await getOverview(runner);
    expect(calls.map((call) => call.sql)).toEqual([
      VERSION_SQL,
      OVERVIEW_TABLES_SQL,
      ACTIVE_QUERIES_SQL,
      INDEX_COUNT_SQL,
    ]);
  });

  test("the sessions read covers every non-idle session of the warehouse, past its limit by Studio's own at most", () => {
    expect(DATABEND_LIMITER_OPTIONS.perEngine).toBe(2);
    expect(databendSessionsSql(7)).toBe(
      "SELECT id AS session_id, current_query_id AS query_id, `user` AS user_name, host, database AS database_name, command, extra_info AS query_text, created_time, time AS elapsed_seconds FROM default.system.processes WHERE command <> 'Idle' ORDER BY created_time LIMIT 9",
    );
  });

  test("the slow queries read the finished statements of the last 24 hours", () => {
    expect(databendSlowQueriesSql(9)).toBe(
      "SELECT query_id, query_text, query_duration_ms, result_rows FROM system_history.query_history WHERE log_type = 2 AND event_time >= subtract_hours(now(), 24) ORDER BY query_duration_ms DESC LIMIT 9",
    );
  });

  test("table, storage and index stats, with the database filter quoted", async () => {
    expect(await sentBy((runner) => getTableStats(runner))).toEqual([tableStatsSql()]);
    expect(await sentBy((runner) => getTableStats(runner, { schema: "d`b'\\y" }))).toEqual([
      tableStatsSql(" AND database = 'd`b''\\\\y'"),
    ]);
    expect(await sentBy(getStorageStats)).toEqual([STORAGE_SQL]);
    expect(await sentBy((runner) => getIndexStats(runner))).toEqual([indexStatsSql()]);
    expect(await sentBy((runner) => getIndexStats(runner, { schema: "d'" }))).toEqual([
      indexStatsSql(" WHERE database = 'd'''"),
    ]);
  });
});

/** One running statement as `system.processes` lists it: its session id, the query id it was sent under, its text. */
interface Running {
  readonly id: string;
  readonly queryId: string;
  readonly text: string;
  readonly command?: string;
}

/** Each column a read of `system.processes` may select, its declared type, and its value for one listed statement. */
const PROCESS_COLUMNS: Readonly<Record<string, readonly [string, (row: Running, position: number) => string]>> = {
  id: ["String", (row) => row.id],
  current_query_id: ["String", (row) => row.queryId],
  "`user`": ["String", () => "studio_reader"],
  host: ["Nullable(String)", () => "172.20.0.1"],
  database: ["String", () => "default"],
  command: ["String", (row) => row.command ?? "Query"],
  extra_info: ["String", (row) => row.text],
  // Databend's display text of a Timestamp, one second apart in the order they were listed.
  created_time: [
    "Timestamp",
    (_row, position) =>
      new Date(Date.UTC(2026, 9, 8, 13, 0, position)).toISOString().replace("T", " ").replace("Z", "000"),
  ],
  time: ["UInt64", () => "1"],
};

const READ_OF_PROCESSES =
  /^SELECT (.+) FROM default\.system\.processes WHERE (.+?)(?: ORDER BY (\w+)( DESC)?)?(?: LIMIT (\d+))?$/;

/** A LIKE pattern as a regular expression: `%` any run, `_` one character, everything else itself. */
function likePattern(pattern: string): RegExp {
  const parts = [...pattern].map((char) => {
    if (char === "%") return "[\\s\\S]*";
    if (char === "_") return "[\\s\\S]";
    return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("")}$`);
}

/** Whether one listed statement passes one predicate of a read's WHERE clause, as Databend evaluates it. */
function holds(predicate: string, row: Running, reading: Running): boolean {
  if (predicate === "id <> connection_id()") return row.id !== reading.id;
  const compared = /^(\w+) (=|<>) '([^']*)'$/.exec(predicate);
  if (compared !== null) {
    const value = PROCESS_COLUMNS[compared[1]][1](row, 0);
    return compared[2] === "=" ? value === compared[3] : value !== compared[3];
  }
  const unlike = /^extra_info NOT LIKE '((?:[^']|'')*)'$/.exec(predicate);
  if (unlike !== null) return !likePattern(unlike[1].replaceAll("''", "'")).test(row.text);
  throw new Error(`a predicate this fake does not evaluate: ${predicate}`);
}

/**
 * A runner standing for a server whose `system.processes` lists `listed` and, last, the reading statement itself, as
 * Databend lists a running read: under a session id and a query id of its own, with its own text. A read of the table
 * is answered as Databend evaluates it, its WHERE predicates, order, limit and select list (a column, a literal,
 * `count(*)` and `count(*) OVER ()`) included, and carries `ownQueryIds` as the transport sets it on a provider
 * statement: the query ids `own` names, the reading statement's own added. Any other statement answers no row.
 */
function processes(listed: readonly Running[], own: readonly string[] = []) {
  const sent: string[] = [];
  const runner: DatabendStatementRunner = async (sql) => {
    sent.push(sql);
    const read = READ_OF_PROCESSES.exec(sql);
    if (read === null) return outcome([], []);
    const [, list, where, order, descending, limit] = read;
    const reading: Running = {
      id: `reading-session-${sent.length}`,
      queryId: `reading-query-${sent.length}`,
      text: sql,
    };
    const rows = [...listed, reading];
    const kept = rows.filter((row) => where.split(" AND ").every((predicate) => holds(predicate, row, reading)));
    if (order !== undefined && order !== "created_time") throw new Error(`an order this fake does not read: ${order}`);
    if (descending !== undefined) kept.reverse();
    const items = list.split(", ").map((item) => {
      const [, expression, alias] = /^(.+?)(?: AS (\w+))?$/.exec(item) as RegExpExecArray;
      return { expression, name: alias ?? expression };
    });
    const answer = { ownQueryIds: new Set([...own, reading.queryId]) };
    if (items.some((item) => item.expression === "count(*)")) {
      // An aggregate: one row over every statement the predicates kept.
      const values = items.map((item) => {
        if (item.expression === "count(*)") return ["UInt64", String(kept.length)] as const;
        if (item.expression.startsWith("'")) return ["String", item.expression.slice(1, -1)] as const;
        throw new Error(`a column this fake does not aggregate: ${item.expression}`);
      });
      const schema = items.map((item, index) => [item.name, values[index][0]] as const);
      return { ...outcome(schema, [values.map(([, value]) => value)]), ...answer };
    }
    const shown = limit === undefined ? kept : kept.slice(0, Number(limit));
    const cells = items.map((item) => {
      if (item.expression === "count(*) OVER ()") return ["UInt64", () => String(kept.length)] as const;
      if (item.expression.startsWith("'")) return ["String", () => item.expression.slice(1, -1)] as const;
      const column = PROCESS_COLUMNS[item.expression];
      if (column === undefined) throw new Error(`a column this fake does not list: ${item.expression}`);
      return [column[0], (row: Running) => column[1](row, rows.indexOf(row))] as const;
    });
    const schema = items.map((item, index) => [item.name, cells[index][0]] as const);
    return {
      ...outcome(
        schema,
        shown.map((row) => cells.map(([, cell]) => cell(row))),
      ),
      ...answer,
    };
  };
  return { runner, sent };
}

/** A user's statement of another client, as `system.processes` lists it. */
function userStatement(n: number, text = `SELECT sleep(2) AS user_statement_${n}`): Running {
  return { id: `user-session-${n}`, queryId: `user-query-${n}`, text };
}

describe("Studio's own statements are left out by the query id Studio sent them under, never by their text (CL-OPS-1)", () => {
  test("a user's statement is listed and counted whatever literal it starts with", async () => {
    const led = userStatement(1, "SELECT 'studio' AS marker, sleep(2) AS listed");
    const plain = userStatement(2);
    const { runner } = processes([led, plain]);
    expect((await getActiveSessions(runner)).map((session) => session.query)).toEqual([led.text, plain.text]);
    expect((await getOverview(runner)).activeConnections).toBe(2);
  });

  test("Studio's own statements in flight while the read ran are left out by query id, the reading one included", async () => {
    // The object tree's read beside the panel, which no text would tell from a user's.
    const tree = {
      id: "tree-session",
      queryId: "tree-query",
      text: "SELECT name AS catalog_name FROM system.catalogs ORDER BY name",
    };
    const user = userStatement(1);
    const { runner } = processes([tree, user], [tree.queryId]);
    expect((await getActiveSessions(runner)).map((session) => session.pid)).toEqual([user.id]);
    expect((await getOverview(runner)).activeConnections).toBe(1);
  });

  test("another Studio process's statements are listed and counted, its monitoring reads included", async () => {
    const elsewhere = {
      id: "other-studio-session",
      queryId: "other-studio-query",
      text: databendSessionsSql(50),
    };
    const { runner } = processes([elsewhere]);
    expect((await getActiveSessions(runner)).map((session) => session.pid)).toEqual([elsewhere.id]);
    expect((await getOverview(runner)).activeConnections).toBe(1);
  });

  test("no read matches on statement text, and none carries a literal for one to match", async () => {
    const { runner, sent } = processes([]);
    await getOverview(runner);
    await getSlowQueries(runner);
    await getActiveSessions(runner);
    await getTableStats(runner, { schema: "d" });
    await getStorageStats(runner);
    await getIndexStats(runner, { schema: "d" });
    await getHealth(runner);
    expect(sent).toHaveLength(15);
    for (const sql of sent) {
      expect(sql, sql).not.toMatch(/\bLIKE\b|connection_id|libredb/i);
      expect(sql.startsWith("SELECT '"), sql).toBe(false);
    }
  });

  test("the Sessions panel reads as many rows past its limit as Studio runs statements at once, and shows its limit", async () => {
    const own = { id: "own-session", queryId: "own-query", text: "SHOW CREATE TABLE `default`.`d`.`t`" };
    const users = [1, 2, 3, 4, 5].map((n) => userStatement(n));
    const { runner, sent } = processes([own, ...users], [own.queryId]);
    const sessions = await getActiveSessions(runner, { limit: 3 });
    expect(sessions.map((session) => session.pid)).toEqual(users.slice(0, 3).map((user) => user.id));
    expect(sent).toEqual([databendSessionsSql(3)]);
    expect(sent[0].endsWith(` LIMIT ${3 + DATABEND_LIMITER_OPTIONS.perEngine}`)).toBe(true);
  });

  test("an idle server lists no session and counts no active statement: the reads themselves are Studio's", async () => {
    const { runner } = processes([]);
    expect(await getActiveSessions(runner)).toEqual([]);
    expect((await getOverview(runner)).activeConnections).toBe(0);
  });

  test("the active count stays whole past its bound, never the bound itself", async () => {
    const many = Array.from({ length: 700 }, (_, n) => userStatement(n));
    const { runner } = processes(many);
    expect((await getOverview(runner)).activeConnections).toBe(700);
  });

  test("past its bound, the count leaves Studio's own out only among the newest it read", async () => {
    const many = Array.from({ length: 700 }, (_, n) => userStatement(n));
    // The oldest is past the 500 newest, so it stays in the count; the newest and the reading statement are left out.
    const { runner } = processes(many, [many[0].queryId, many[699].queryId]);
    expect((await getOverview(runner)).activeConnections).toBe(699);
  });

  test("a read that degrades is no figure and no session, never a zero", async () => {
    const runner: DatabendStatementRunner = async (sql) => {
      if (sql.includes("system.processes")) throw failure(1063);
      return outcome([], []);
    };
    expect("activeConnections" in (await getOverview(runner))).toBe(false);
    expect(await getActiveSessions(runner)).toEqual([]);
  });
});

describe("limits", () => {
  test("clamped to 1..500, the default for none or a non-number", async () => {
    expect(DATABEND_MAX_MONITORING_LIMIT).toBe(500);
    const cases: [number | undefined, number][] = [
      [undefined, DATABEND_DEFAULT_SLOW_QUERY_LIMIT],
      [Number.NaN, DATABEND_DEFAULT_SLOW_QUERY_LIMIT],
      [0, 1],
      [-5, 1],
      [2.7, 2],
      [501, 500],
      [Number.POSITIVE_INFINITY, DATABEND_DEFAULT_SLOW_QUERY_LIMIT],
    ];
    const sent = await Promise.all(cases.map(([limit]) => sentBy((runner) => getSlowQueries(runner, { limit }))));
    expect(sent).toEqual(cases.map(([, clamped]) => [databendSlowQueriesSql(clamped)]));
  });

  test("the panels send the clamped limit", async () => {
    const sessions = routed({ [databendSessionsSql(500)]: outcome(SESSION_SCHEMA, []) });
    await getActiveSessions(sessions.runner, { limit: 10_000 });
    expect(sessions.calls).toEqual([{ sql: databendSessionsSql(500), rowCut: DATABEND_SURFACE_ROW_CUT }]);

    const defaults = routed({
      [databendSessionsSql(DATABEND_DEFAULT_SESSION_LIMIT)]: outcome(SESSION_SCHEMA, []),
      [databendSlowQueriesSql(DATABEND_DEFAULT_SLOW_QUERY_LIMIT)]: outcome(SLOW_SCHEMA, []),
    });
    await getActiveSessions(defaults.runner);
    await getSlowQueries(defaults.runner);
    expect(defaults.calls.map((call) => call.sql)).toEqual([
      databendSessionsSql(DATABEND_DEFAULT_SESSION_LIMIT),
      databendSlowQueriesSql(DATABEND_DEFAULT_SLOW_QUERY_LIMIT),
    ]);
  });
});

describe("sessions and the kill [X08]", () => {
  test("a row maps id to pid, the kill target, and a running statement's state is the word the panels count", async () => {
    const { runner } = routed({ [databendSessionsSql(5)]: outcome(SESSION_SCHEMA, [SESSION_ROW]) });
    expect(await getActiveSessions(runner, { limit: 5 })).toEqual([
      {
        pid: "5c00e52f-34c2-4cab-8ba8-c1f1121157bf",
        user: "studio_reader",
        database: "libredb_demo",
        clientAddr: "172.20.0.1",
        state: "active",
        query: "SELECT 1",
        queryStart: new Date("2026-10-07T22:58:07.375Z"),
        duration: "3.00s",
        durationMs: 3000,
      },
    ]);
  });

  // The Sessions, Overview and Operations panels count `state === "active"`, PostgreSQL's word for a statement in
  // flight, which is what Databend's command `Query` means (F8); `Aborting` keeps its own word, lower-cased, so no
  // card counts it as active or idle. The sessions read leaves `Idle` out.
  test.each([
    ["Query", "active"],
    ["Aborting", "aborting"],
  ])("the command %s is the panel state %s", async (command, state) => {
    const row = [...SESSION_ROW];
    row[5] = command;
    const { runner } = routed({ [databendSessionsSql(5)]: outcome(SESSION_SCHEMA, [row]) });
    const [session] = await getActiveSessions(runner, { limit: 5 });
    expect(session.state).toBe(state);
  });

  test("a session with no host and an unreadable time keeps only what it has", async () => {
    const row = [...SESSION_ROW];
    row[3] = null as unknown as string;
    row[7] = "not a time";
    const { runner } = routed({ [databendSessionsSql(5)]: outcome(SESSION_SCHEMA, [row]) });
    const [session] = await getActiveSessions(runner, { limit: 5 });
    expect(session.state).toBe("active");
    expect("clientAddr" in session).toBe(false);
    expect("queryStart" in session).toBe(false);
  });

  test("the kill sends KILL QUERY with the session id as a literal", async () => {
    const pid = "5c00e52f-34c2-4cab-8ba8-c1f1121157bf";
    const { runner, calls } = routed({ [`KILL QUERY '${pid}'`]: outcome([], []) });
    await killSession(runner, pid);
    expect(calls).toEqual([{ sql: `KILL QUERY '${pid}'`, rowCut: DATABEND_SURFACE_ROW_CUT }]);
  });

  test("the kill id pattern: 1 to 64 letters, digits and hyphens; anything else sends nothing", async () => {
    const accepted = ["a", "A-9", "x".repeat(64), "01a11896a18d7ae399fb6947927521b2"];
    const sent = await Promise.all(accepted.map((id) => sentBy((runner) => killSession(runner, id))));
    expect(sent).toEqual(accepted.map((id) => [`KILL QUERY '${id}'`]));
    const refused = routed({});
    const refusals = ["x".repeat(65), "a'b", "a b", "a\\b", "a_b", "é"].map((id) =>
      killSession(refused.runner, id).catch((error: unknown) => (error as Error).message),
    );
    expect(await Promise.all(refusals)).toEqual(refusals.map(() => DATABEND_MONITORING_SENTENCES.killIdRefused));
    expect(refused.calls).toEqual([]);
    const empty = routed({});
    await expect(killSession(empty.runner, "")).rejects.toThrow(DATABEND_MONITORING_SENTENCES.killNeedsId);
    expect(empty.calls).toEqual([]);
  });

  test("a refused kill sends nothing, and a failed one propagates", async () => {
    const refused = routed({});
    await expect(killSession(refused.runner, "a'b")).rejects.toBeInstanceOf(QueryError);
    expect(refused.calls).toHaveLength(0);

    const denied = failure(1063);
    const { runner } = routed({ "KILL QUERY 'abc'": denied });
    await expect(killSession(runner, "abc")).rejects.toBe(denied);
  });
});

describe("each panel degrades to empty on the unavailable codes and propagates the rest", () => {
  test("the six codes", () => {
    expect([...DATABEND_DEGRADE_CODES]).toEqual([1003, 1025, 1063, 1112, 1119, 1002]);
  });

  for (const code of [1003, 1025, 1063, 1112, 1119, 1002]) {
    test(`code ${code}`, async () => {
      const runner: DatabendStatementRunner = async () => {
        throw failure(code);
      };
      expect(await getSlowQueries(runner)).toEqual([]);
      expect(await getActiveSessions(runner)).toEqual([]);
      expect(await getTableStats(runner)).toEqual([]);
      expect(await getIndexStats(runner)).toEqual([]);
      expect(await getStorageStats(runner)).toEqual([]);
      expect(await getOverview(runner)).toEqual({
        version: DATABEND_UNKNOWN_TEXT,
        uptime: DATABEND_UNKNOWN_TEXT,
        maxConnections: 0,
        databaseSize: DATABEND_UNAVAILABLE_TEXT,
        tableCount: 0,
        indexCount: 0,
      });
    });
  }

  test("any other error propagates", async () => {
    await Promise.all(
      [failure(1065), new DatabendError("timeout", "late"), new Error("boom")].map(async (error) => {
        const runner: DatabendStatementRunner = async () => {
          throw error;
        };
        await expect(getSlowQueries(runner)).rejects.toBe(error);
        await expect(getOverview(runner)).rejects.toBe(error);
      }),
    );
  });

  test("a cut table list is refused, not shown in part", async () => {
    const cut = { bound: "rows", limit: 100_000 } as const;
    const { runner } = routed({
      [tableStatsSql()]: outcome([["schema_name", "String"]], [["a"]], cut),
    });
    await expect(getTableStats(runner)).rejects.toThrow(DATABEND_OBJECT_SENTENCES.incomplete("table statistics", cut));
  });
});

describe("the panels", () => {
  test("the overview: version, the default catalog's sizes, active queries, and no uptime or ceiling", async () => {
    const { runner } = routed(OVERVIEW_ANSWERS);
    expect(await getOverview(runner)).toEqual({
      version: "8.0.26-v1.2.951-nightly",
      uptime: DATABEND_UNKNOWN_TEXT,
      activeConnections: 1,
      maxConnections: 0,
      databaseSize: "17.88 KB",
      databaseSizeBytes: 18304,
      tableCount: 2,
      indexCount: 4,
    });
  });

  test("an empty catalog sums to NULL, which is zero bytes", async () => {
    const { runner } = routed({
      ...OVERVIEW_ANSWERS,
      [OVERVIEW_TABLES_SQL]: outcome(
        [
          ["table_count", "UInt64"],
          ["compressed_bytes", "Nullable(UInt64)"],
          ["index_bytes", "Nullable(UInt64)"],
        ],
        [["0", null, null]],
      ),
    });
    const overview = await getOverview(runner);
    expect(overview.databaseSizeBytes).toBe(0);
    expect(overview.tableCount).toBe(0);
  });

  test("getPerformanceMetrics is {}: Databend publishes none of its fields", () => {
    expect(getPerformanceMetrics()).toEqual({});
  });

  test("slow queries: one execution per row", async () => {
    const { runner } = routed({
      [databendSlowQueriesSql(3)]: outcome(SLOW_SCHEMA, [["q1", "SELECT 2", "1500", "7"]]),
    });
    expect(await getSlowQueries(runner, { limit: 3 })).toEqual([
      { queryId: "q1", query: "SELECT 2", calls: 1, totalTime: 1500, avgTime: 1500, rows: 7 },
    ]);
  });

  test("table stats: compressed and index bytes, a NULL left out", async () => {
    const { runner } = routed({
      [tableStatsSql(" AND database = 'db'")]: outcome(
        [
          ["schema_name", "String"],
          ["table_name", "String"],
          ["num_rows", "Nullable(UInt64)"],
          ["data_compressed_size", "Nullable(UInt64)"],
          ["index_size", "Nullable(UInt64)"],
        ],
        [
          ["db", "t", "4", "2048", "1024"],
          ["db", "ext", null, null, null],
        ],
      ),
    });
    expect(await getTableStats(runner, { schema: "db" })).toEqual([
      {
        schemaName: "db",
        tableName: "t",
        rowCount: 4,
        tableSize: "2 KB",
        tableSizeBytes: 2048,
        indexSize: "1 KB",
        indexSizeBytes: 1024,
        totalSize: "3 KB",
        totalSizeBytes: 3072,
      },
      { schemaName: "db", tableName: "ext", rowCount: 0, totalSize: "0 B", totalSizeBytes: 0 },
    ]);
  });

  test("a figure from 2^53 up, which decodes as its exact text, is its nearest number, so not exact", async () => {
    const { runner } = routed({
      [tableStatsSql()]: outcome(
        [
          ["schema_name", "String"],
          ["table_name", "String"],
          ["num_rows", "Nullable(UInt64)"],
          ["data_compressed_size", "Nullable(UInt64)"],
          ["index_size", "Nullable(UInt64)"],
        ],
        [["db", "t", "9007199254740993", "9007199254740993", "2"]],
      ),
    });
    const [stats] = await getTableStats(runner);
    // 2^53 + 1 has no double, so it reads as 2^53, one off.
    expect(stats).toMatchObject({ rowCount: 2 ** 53, tableSizeBytes: 2 ** 53, totalSizeBytes: 2 ** 53 + 2 });
  });

  test("storage: one row per database", async () => {
    const { runner } = routed({
      [STORAGE_SQL]: outcome(
        [
          ["database_name", "String"],
          ["compressed_bytes", "Nullable(UInt64)"],
          ["index_bytes", "Nullable(UInt64)"],
        ],
        [
          ["a", "1024", "1024"],
          ["b", "10", null],
        ],
      ),
    });
    expect(await getStorageStats(runner)).toEqual([
      { name: "a", size: "2 KB", sizeBytes: 2048 },
      { name: "b", size: "10 B", sizeBytes: 10 },
    ]);
  });

  test("index stats: the definition's columns, no size or scan counters to read", async () => {
    const { runner } = routed({
      [indexStatsSql()]: outcome(
        [
          ["schema_name", "String"],
          ["table_name", "Nullable(String)"],
          ["index_name", "String"],
          ["index_type", "String"],
          ["definition", "String"],
        ],
        [["db", "t", "idx", "INVERTED", "t(a, b)tokenizer='english'"]],
      ),
    });
    expect(await getIndexStats(runner)).toEqual([
      {
        schemaName: "db",
        tableName: "t",
        indexName: "idx",
        indexType: "INVERTED",
        columns: ["a", "b"],
        isUnique: false,
        isPrimary: false,
        indexSize: DATABEND_UNAVAILABLE_TEXT,
        scans: 0,
      },
    ]);
  });

  test("health sends its reads one at a time, holding one statement slot", async () => {
    const answers: Record<string, StatementOutcome> = {
      ...OVERVIEW_ANSWERS,
      [databendSlowQueriesSql(10)]: outcome(SLOW_SCHEMA, []),
      [databendSessionsSql(10)]: outcome(SESSION_SCHEMA, []),
    };
    let running = 0;
    let most = 0;
    const runner: DatabendStatementRunner = async (sql) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return answers[sql];
    };
    await getHealth(runner);
    expect(most).toBe(1);
  });

  test("health: size, active queries, slow queries and sessions, no cache ratio", async () => {
    const { runner } = routed({
      ...OVERVIEW_ANSWERS,
      [databendSlowQueriesSql(10)]: outcome(SLOW_SCHEMA, [["q1", "SELECT 2", "1500", "7"]]),
      [databendSessionsSql(10)]: outcome(SESSION_SCHEMA, [SESSION_ROW]),
    });
    expect(await getHealth(runner)).toEqual({
      activeConnections: 1,
      databaseSize: "17.88 KB",
      cacheHitRatio: DATABEND_UNAVAILABLE_TEXT,
      slowQueries: [{ query: "SELECT 2", calls: 1, avgTime: "1.50s" }],
      activeSessions: [
        {
          pid: "5c00e52f-34c2-4cab-8ba8-c1f1121157bf",
          user: "studio_reader",
          database: "libredb_demo",
          state: "active",
          query: "SELECT 1",
          duration: "3.00s",
        },
      ],
    });
  });
});

describe("the sentences", () => {
  test("each is exported, one sentence, no dash", () => {
    for (const sentence of [
      DATABEND_MONITORING_SENTENCES.killNeedsId,
      DATABEND_MONITORING_SENTENCES.killIdRefused,
      DATABEND_MONITORING_SENTENCES.killAsked("abc"),
    ]) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      expect(sentence).not.toMatch(DASHES);
    }
    expect(Object.keys(DATABEND_MONITORING_SENTENCES)).toEqual(["killNeedsId", "killIdRefused", "killAsked"]);
  });
});
