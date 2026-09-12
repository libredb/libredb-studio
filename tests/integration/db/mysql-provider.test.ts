/**
 * Integration tests for MySQLProvider
 * Uses mock.module() to intercept mysql2/promise before provider import.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import { DatabaseConfigError } from "@/lib/db/errors";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { asBytes, binaryText } from "@/lib/export/binary";
import { mysqlJsonStrategy } from "@/lib/explain/mysql-json";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { CATALOG_TYPE_RULES } from "@/lib/db/providers/sql/mysql";

// ============================================================================
// Mock mysql2/promise BEFORE importing the provider
// ============================================================================

/**
 * The first tuple slot is `unknown`, not `unknown[]`: mysql2 hands back a
 * `ResultSetHeader` OBJECT for a statement that returns no result set, and the
 * second slot is `undefined` there. An array-shaped mock is exactly what hid
 * the `result.rows.map is not a function` defect, so the mock type has to be
 * able to express the header shape.
 */
let mockExecuteFn: (sql: string, params?: unknown[]) => Promise<[unknown, unknown[] | undefined]>;

/**
 * Which mysql2 method each statement went through. The driver decodes the text
 * (`query`) and binary prepared (`execute`) protocols on different code paths, and
 * three engines refuse whole statement classes on the prepared one, so the mock
 * answers BOTH methods and records the choice - a mock that only answered
 * `execute` could not tell a routed statement from an unrouted one.
 */
type ProtocolCall = { method: "query" | "execute"; sql: string; params?: unknown[] };
let protocolCalls: ProtocolCall[] = [];

/**
 * Statements NO MySQL-family server accepts, and the refusal each one earns. A fixture
 * that RESOLVES one models a server that does not exist, and every test built on that
 * fixture is then a test of the mock - which is how the health read asking for
 * `LEFT(sql_text, 100)` passed 100% line coverage and two reviews (#512).
 *
 * Evaluated in `recordCall`, the ONE funnel every fixture in this file goes through -
 * named, delegating and inline alike - so a fixture added tomorrow cannot opt out of it.
 *
 * Each rule is a MEASURED refusal, never a guess: a rule that refuses what a server
 * answers is the same defect with its sign flipped. `sql_text` is not a column of
 * `events_statements_summary_by_digest` on any build - 1054 / ER_BAD_FIELD_ERROR /
 * 42S22 on MySQL 26.7.0, Percona Server 8.4.11-11 and MariaDB 12.3.2, with
 * `@@performance_schema` 1 and 0 alike (see `sqlTextRefusal()` below and
 * `docs/providers/mysql.md`).
 *
 * The MATCH is wider than that measurement, on purpose and worth knowing: it is a
 * co-occurrence over the whole statement, so any statement naming the digest table and
 * `sql_text` anywhere trips it - including one shape a real server WOULD answer, a join
 * of the digest table against `events_statements_current`, which does have `SQL_TEXT`.
 * Nothing `mysql.ts` emits has that shape, so the over-match costs nothing today. The
 * day a statement does, narrow this rule to a `sql_text` reference bound to the digest
 * table; do not add an exception, which is the sign flipped a second time.
 *
 * There is one rule, so this list stays in this file. Lift it to `tests/helpers/` when a
 * SECOND engine has a measured refusal of its own - not before: the other fourteen
 * provider test files would receive an empty rule list, which proves nothing about their
 * fixtures and reads as coverage.
 */
const UNANSWERABLE_STATEMENTS: readonly { readonly why: string; readonly matches: (lowered: string) => boolean }[] = [
  {
    why: "events_statements_summary_by_digest has no sql_text column (ER_BAD_FIELD_ERROR 1054)",
    matches: (lowered) => lowered.includes("events_statements_summary_by_digest") && lowered.includes("sql_text"),
  },
];

/** A fixture answered a statement a real server refuses. Drained and asserted per test. */
let fixtureViolations: string[] = [];

function recordCall(
  method: "query" | "execute",
  sql: string,
  params?: unknown[],
): Promise<[unknown, unknown[] | undefined]> {
  protocolCalls.push({ method, sql, params });
  const answered = mockExecuteFn(sql, params);
  const rule = UNANSWERABLE_STATEMENTS.find((entry) => entry.matches(sql.trim().toLowerCase()));
  if (rule === undefined) return answered;
  // RECORDED, not thrown. `getHealth()` catches per panel, so a throw from here would
  // arrive as a panel error that the test under way may legitimately be asserting - the
  // unfaithfulness would be swallowed at exactly the place it did its damage. Pushing to
  // a sink a hook drains keeps the failure attributable to the fixture instead.
  //
  // The `.then` also has to leave a rejection alone: a fixture that refuses correctly
  // must stay refused, which the second test of the guard's own describe pins.
  return answered.then((value) => {
    fixtureViolations.push(`${rule.why} - the fixture ANSWERED it: ${sql.trim()}`);
    return value;
  });
}

/** The method the first statement matching `fragment` (case-insensitive) went through. */
function methodFor(fragment: string): string | undefined {
  return protocolCalls.find((c) => c.sql.toLowerCase().includes(fragment.toLowerCase()))?.method;
}

const mockConnection = {
  threadId: 42,
  query: (sql: string, params?: unknown[]) => recordCall("query", sql, params),
  execute: (sql: string, params?: unknown[]) => recordCall("execute", sql, params),
  release: () => {},
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
};

const mockPool = {
  getConnection: async () => mockConnection,
  end: async () => {},
  query: (sql: string, params?: unknown[]) => recordCall("query", sql, params),
  execute: (sql: string, params?: unknown[]) => recordCall("execute", sql, params),
};

/**
 * The config object the provider handed `createPool`. Recorded because `buildSSLConfig` is
 * private and its result is only observable here: a test that merely constructs the provider
 * and asserts it did not throw passes for every SSL mode, including a wrong one.
 */
let lastPoolConfig: Record<string, unknown> = {};

const createPool = (config: Record<string, unknown>) => {
  lastPoolConfig = config;
  return mockPool;
};

mock.module("mysql2/promise", () => ({
  default: { createPool },
  createPool,
}));

/**
 * FILE SCOPE on purpose. This file has eight top-level `describe`s and a hook inside one
 * of them would leave the other seven unguarded - the funnel is shared, so its assertion
 * has to be too. Drains before asserting, so one unfaithful answer fails the one test
 * that produced it rather than every test after it.
 */
afterEach(() => {
  const violations = fixtureViolations;
  fixtureViolations = [];
  expect(violations).toEqual([]);
});

// Dynamic import AFTER mock is installed
const { MySQLProvider } = await import("@/lib/db/providers/sql/mysql");

// ============================================================================
// Helpers
// ============================================================================

function makeMySQLConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "test-mysql",
    name: "Test MySQL",
    type: "mysql",
    host: "localhost",
    port: 3306,
    database: "testdb",
    user: "root",
    password: "secret",
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * The refusal a real MySQL-family server answers for `sql_text` over
 * `performance_schema.events_statements_summary_by_digest` - the one column that table
 * does not have on any build.
 *
 * Every fixture here that models the digest table answers WITH THIS rather than a row,
 * and that is the repair the test file needed (#512): a mock that answers a statement no
 * server accepts is how the defect survived every gate. The health line asked for
 * `LEFT(sql_text, 100)`, the fixture invented a `query` column for it, and the read looked
 * like a working one for as long as it was only mocked. The fields are the ones `mysql2`
 * puts on the error - measured 2026-08-27 on MySQL 26.7.0, Percona Server 8.4.11-11 and
 * MariaDB 12.3.2, with `@@performance_schema` 1 and 0 alike:
 *
 *   errno=1054 code=ER_BAD_FIELD_ERROR sqlState=42S22
 *   Unknown column 'sql_text' in 'field list'
 *
 * (MariaDB words the same error `Unknown column 'sql_text' in 'SELECT'`; the code, errno
 * and SQLSTATE are identical, and nothing under test reads the wording.)
 */
function sqlTextRefusal(): Error & { code: string; errno: number; sqlState: string } {
  const error = new Error("Unknown column 'sql_text' in 'field list'") as Error & {
    code: string;
    errno: number;
    sqlState: string;
  };
  error.code = "ER_BAD_FIELD_ERROR";
  error.errno = 1054;
  error.sqlState = "42S22";
  return error;
}

/**
 * Default mock execute that matches SQL patterns and returns mock data.
 */
function defaultMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  // SHOW STATUS, bare. The provider reads the whole list and picks by `Variable_name`
  // because Apache Doris rejects the LIKE clause on this statement outright: measured
  // 2026-09-06 against `apache/doris:all-in-one-4.1.3`, `SHOW STATUS LIKE 'Uptime'`
  // answers errno 1105 / ER_UNKNOWN_ERROR / HY000 "mismatched input 'LIKE' expecting
  // {<EOF>, ';'}(line 1, pos 12)" while a bare `SHOW STATUS` is accepted (#573).
  //
  // Two columns, `Variable_name` and `Value`, on every engine measured that day:
  // MySQL 26.7.0 (528 rows), MariaDB 12.3.2 (571), TiDB 8.5.1 (13), SingleStore (75),
  // StarRocks 3.3.22 (0) and Doris 4.1.3 (0). The five rows below are that shape; the
  // surrounding rows are there so the pick has something to pick out of.
  //
  // `Innodb_deadlocks` is MariaDB's variable and MariaDB 12.3.2 publishes it, so this
  // shared fixture carries it. MySQL 26.7.0 does not publish it at all, and the test
  // that pins that absence brings its own fixture.
  if (normalized.startsWith("show status")) {
    return Promise.resolve([
      [
        { Variable_name: "Connections", Value: "9" },
        { Variable_name: "Queries", Value: "3" },
        { Variable_name: "Threads_connected", Value: "5" },
        { Variable_name: "Uptime", Value: "86400" },
        { Variable_name: "Innodb_deadlocks", Value: "0" },
      ],
      [],
    ]);
  }

  // SHOW VARIABLES LIKE 'max_connections'
  if (normalized.includes("show variables like 'max_connections'")) {
    return Promise.resolve([[{ Value: "151" }], []]);
  }

  // SHOW VARIABLES LIKE 'innodb_data_file_path'
  if (normalized.includes("show variables like 'innodb_data_file_path'")) {
    return Promise.resolve([[{ Value: "ibdata1:12M:autoextend" }], []]);
  }

  // SHOW BINARY LOGS
  if (normalized.includes("show binary logs")) {
    return Promise.resolve([[{ File_size: "1048576" }], []]);
  }

  // VERSION()
  if (normalized.includes("version()")) {
    return Promise.resolve([[{ version: "8.0.35" }], [{ name: "version" }]]);
  }

  // performance_schema.global_status — cache hit ratio, buffer pool, QPS
  if (normalized.includes("performance_schema.global_status")) {
    // Buffer pool reads query (hit_ratio must be numeric — .toFixed() is called on it)
    if (normalized.includes("innodb_buffer_pool_reads") && normalized.includes("hit_ratio")) {
      return Promise.resolve([[{ hit_ratio: 99.5 }], []]);
    }
    // Buffer pool pages
    if (normalized.includes("data_pages") && normalized.includes("total_pages")) {
      return Promise.resolve([[{ data_pages: "800", total_pages: "1000" }], []]);
    }
    // Queries/uptime (QPS)
    if (normalized.includes("queries") && normalized.includes("uptime")) {
      return Promise.resolve([[{ queries: "50000", uptime: "86400" }], []]);
    }
    return Promise.resolve([[{ hit_ratio: 99.5 }], []]);
  }

  // performance_schema.events_statements_summary_by_digest (slow queries)
  //
  // THE SHARED FIXTURE REFUSES `sql_text` TOO, and that is the repair this fixture
  // needed (#512): about a hundred of the tests in this file run against this function,
  // and while it answered a row for ANY statement over the digest table it answered the
  // health line's `LEFT(sql_text, 100)` as readily as the real one - which is how a
  // statement no server has ever executed passed every gate. `sqlTextRefusal()` says what
  // a server says instead. The columns below are the aliases the real statement asks for;
  // the former `avgTime: "12.5ms"` is gone with it, an invention of the same kind (that
  // alias belonged to the broken health statement, and nothing reads it now).
  //
  // Routing every digest fixture through the one refusal helper is no longer merely
  // prophylactic: `UNANSWERABLE_STATEMENTS` records any fixture that ANSWERS this
  // statement, and the guard's own describe at the end of the file drives that rule with
  // an unfaithful fixture and then asserts THIS function refuses. So deleting the two
  // lines below fails a test by name instead of leaving the suite green.
  if (normalized.includes("events_statements_summary_by_digest")) {
    if (normalized.includes("sql_text")) {
      return Promise.reject(sqlTextRefusal());
    }
    return Promise.resolve([
      [
        {
          query: "SELECT * FROM users",
          calls: "100",
          query_id: "abc123",
          total_time_ms: "1250",
          avg_time_ms: "12.5",
          min_time_ms: "1.0",
          max_time_ms: "50.0",
          rows_examined: "5000",
        },
      ],
      [],
    ]);
  }

  // information_schema.TABLES — COUNT(*) without table_name (getOverview table count)
  if (
    normalized.includes("information_schema.tables") &&
    normalized.includes("count(*)") &&
    !normalized.includes("table_name")
  ) {
    return Promise.resolve([[{ cnt: "2" }], []]);
  }

  // information_schema.TABLES — size aggregate (no table_name in query, e.g. getOverview, getStorageStats)
  if (
    normalized.includes("information_schema.tables") &&
    normalized.includes("sum(data_length") &&
    !normalized.includes("table_name")
  ) {
    return Promise.resolve([[{ size_mb: "12.50", size_bytes: "13107200", name: "testdb" }], []]);
  }

  // information_schema.TABLES — table list (has table_name)
  if (normalized.includes("information_schema.tables") && normalized.includes("table_name")) {
    // Table count query
    if (normalized.includes("count(*)")) {
      return Promise.resolve([[{ cnt: "2" }], []]);
    }
    // Size aggregate with table_schema (getHealth size)
    if (normalized.includes("sum(data_length")) {
      return Promise.resolve([[{ size_mb: "12.50", size_bytes: "13107200", name: "testdb" }], []]);
    }
    // Table stats query
    if (normalized.includes("table_rows") && normalized.includes("data_length")) {
      return Promise.resolve([
        [
          {
            table_name: "users",
            row_count: "100",
            total_size: "8192",
            table_size_bytes: "4096",
            index_size_bytes: "2048",
            total_size_bytes: "6144",
            free_space_bytes: "512",
            schema_name: "testdb",
          },
          {
            table_name: "orders",
            row_count: "50",
            total_size: "4096",
            table_size_bytes: "2048",
            index_size_bytes: "1024",
            total_size_bytes: "3072",
            free_space_bytes: "256",
            schema_name: "testdb",
          },
        ],
        [],
      ]);
    }
    // Plain table listing (for maintenance getAllTablesForMaintenance)
    if (normalized.includes("table_name") && !normalized.includes("table_rows")) {
      return Promise.resolve([[{ TABLE_NAME: "users" }, { TABLE_NAME: "orders" }], []]);
    }
    return Promise.resolve([
      [
        { table_name: "users", row_count: "100", total_size: "8192" },
        { table_name: "orders", row_count: "50", total_size: "4096" },
      ],
      [],
    ]);
  }

  // information_schema.TABLES — size only (getHealth — has size_mb but no table_name)
  if (normalized.includes("information_schema.tables") && normalized.includes("size_mb")) {
    return Promise.resolve([[{ size_mb: "12.50" }], []]);
  }

  // information_schema.COLUMNS
  if (normalized.includes("information_schema.columns")) {
    return Promise.resolve([
      [
        { column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, column_key: "PRI" },
        { column_name: "name", data_type: "varchar", is_nullable: "YES", column_default: null, column_key: "" },
        { column_name: "email", data_type: "varchar", is_nullable: "NO", column_default: null, column_key: "UNI" },
      ],
      [],
    ]);
  }

  // information_schema.KEY_COLUMN_USAGE (foreign keys)
  if (normalized.includes("key_column_usage")) {
    return Promise.resolve([[{ column_name: "user_id", referenced_table: "users", referenced_column: "id" }], []]);
  }

  // information_schema.STATISTICS (indexes)
  if (normalized.includes("information_schema.statistics")) {
    // Count query for overview
    if (normalized.includes("count(distinct")) {
      return Promise.resolve([[{ table_count: "2", index_count: "3" }], []]);
    }
    // Index stats query
    if (normalized.includes("index_type") || normalized.includes("group_concat")) {
      return Promise.resolve([
        [
          {
            schema_name: "testdb",
            table_name: "users",
            index_name: "PRIMARY",
            index_type: "BTREE",
            columns: "id",
            is_unique: 1,
            is_primary: 1,
            cardinality: "100",
          },
          {
            schema_name: "testdb",
            table_name: "users",
            index_name: "idx_email",
            index_type: "BTREE",
            columns: "email",
            is_unique: 1,
            is_primary: 0,
            cardinality: "100",
          },
        ],
        [],
      ]);
    }
    return Promise.resolve([
      [
        { index_name: "PRIMARY", columns: "id", is_unique: 1 },
        { index_name: "idx_email", columns: "email", is_unique: 1 },
      ],
      [],
    ]);
  }

  // information_schema.PROCESSLIST (sessions)
  if (normalized.includes("processlist")) {
    return Promise.resolve([
      [
        {
          pid: 1,
          user: "root",
          database: "testdb",
          database_name: "testdb",
          state: "Query",
          query: "SELECT 1",
          duration: "0s",
          client_addr: "127.0.0.1:3306",
          duration_seconds: "0",
        },
        {
          pid: 2,
          user: "app",
          database: "testdb",
          database_name: "testdb",
          state: "Sleep",
          query: "",
          duration: "5s",
          client_addr: "10.0.0.1:3306",
          duration_seconds: "5",
        },
      ],
      [],
    ]);
  }

  // mysql.innodb_index_stats (per-index sizes) — only `users.PRIMARY` has a persistent-stats
  // row, so `users.idx_email` exercises the "no row" path.
  if (normalized.includes("innodb_index_stats")) {
    return Promise.resolve([
      [{ database_name: "testdb", table_name: "users", index_name: "PRIMARY", size_bytes: "16384" }],
      [],
    ]);
  }

  // KILL query (maintenance)
  if (normalized.startsWith("kill")) {
    return Promise.resolve([[], []]);
  }

  // ANALYZE TABLE / OPTIMIZE TABLE / CHECK TABLE answer a RESULT SET, one row per
  // (table, message), and the verdict lives in Msg_type/Msg_text. Measured through the
  // driver against MySQL 26.7.0 (`libredb-mysql`) on 2026-08-25:
  //   OPTIMIZE TABLE `real1`   -> note "Table does not support optimize, doing recreate
  //                               + analyze instead" then status "OK"
  //   OPTIMIZE TABLE `missing` -> Error "Table 'u9t.missing' doesn't exist" then
  //                               status "Operation failed"
  // The empty array this used to answer is what made the "reports success when MySQL
  // reported failure" defect untestable: no row means no verdict to read.
  if (
    normalized.startsWith("analyze table") ||
    normalized.startsWith("optimize table") ||
    normalized.startsWith("check table")
  ) {
    const op = normalized.split(" ")[0];
    const named = [...sql.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    return Promise.resolve([
      named.flatMap((name) =>
        name === "missing"
          ? [
              { Table: `testdb.${name}`, Op: op, Msg_type: "Error", Msg_text: `Table 'testdb.${name}' doesn't exist` },
              { Table: `testdb.${name}`, Op: op, Msg_type: "status", Msg_text: "Operation failed" },
            ]
          : [
              // InnoDB has no in-place OPTIMIZE, so the server prepends this note to
              // every optimize it does perform - a non-error row the user should see.
              ...(op === "optimize"
                ? [
                    {
                      Table: `testdb.${name}`,
                      Op: op,
                      Msg_type: "note",
                      Msg_text: "Table does not support optimize, doing recreate + analyze instead",
                    },
                  ]
                : []),
              { Table: `testdb.${name}`, Op: op, Msg_type: "status", Msg_text: "OK" },
            ],
      ),
      [],
    ]);
  }

  // EXPLAIN, both grammars. Measured 2026-09-06 on `mysql:latest` (26.7.0) through
  // mysql2 3.24.2 over the text protocol: `EXPLAIN FORMAT=JSON <select>` answers one
  // row of one column named `EXPLAIN` carrying the JSON plan as a string, and plain
  // `EXPLAIN <select>` answers the tabular columns. The connect-time grammar probe
  // sends `EXPLAIN FORMAT=JSON SELECT 1` first, so this shared fixture models the
  // engine the provider is named for, which accepts it.
  if (normalized.startsWith("explain format=json")) {
    return Promise.resolve([[{ EXPLAIN: '{"query_block": {"select_id": 1}}' }], [{ name: "EXPLAIN" }]]);
  }

  if (normalized.startsWith("explain")) {
    return Promise.resolve([
      [{ id: 1, select_type: "SIMPLE", table: null, type: null, rows: null, Extra: "No tables used" }],
      [{ name: "id" }, { name: "select_type" }],
    ]);
  }

  // Default: generic SELECT result
  return Promise.resolve([[{ id: 1, name: "test" }], [{ name: "id" }, { name: "name" }]]);
}

/**
 * MariaDB answers `SELECT VERSION()` with its own build string. Measured on
 * `mariadb:12.3` (`12.3.2-MariaDB-ubu2404`), which is the version
 * `WIRE_COMPATIBLE_ENGINES` records for MariaDB.
 */
function mariaDBMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  if (sql.trim().toLowerCase().includes("version()")) {
    return Promise.resolve([[{ version: "12.3.2-MariaDB-ubu2404" }], [{ name: "version" }]]);
  }
  return defaultMockExecute(sql);
}

/**
 * What a server with `performance_schema` OFF actually returns. MariaDB ships it
 * disabled by default, and the tables still EXIST there: every query below is a
 * bare `SELECT (subquery)` with no FROM, so it answers one row of NULLs rather
 * than throwing or returning nothing. Measured on `mariadb:12.3` with
 * `@@performance_schema` = 0.
 */
function perfSchemaDisabledMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  if (normalized.includes("performance_schema.global_status")) {
    if (normalized.includes("innodb_buffer_pool_reads") && normalized.includes("hit_ratio")) {
      return Promise.resolve([[{ hit_ratio: null }], []]);
    }
    if (normalized.includes("data_pages") && normalized.includes("total_pages")) {
      return Promise.resolve([[{ data_pages: null, total_pages: null }], []]);
    }
    if (normalized.includes("queries") && normalized.includes("uptime")) {
      return Promise.resolve([[{ queries: null, uptime: null }], []]);
    }
    return Promise.resolve([[{ hit_ratio: null }], []]);
  }

  // OFF does not remove the column list. A server with `@@performance_schema` = 0 still
  // rejects `sql_text` over this table with ER_BAD_FIELD_ERROR - the column does not
  // exist on any build, whatever the switch says - and answering `[[], []]` to that
  // statement too modelled a server that does not exist: it let BOTH the working read
  // and the broken one produce `[]`, so the off-server test could not tell them apart.
  if (normalized.includes("events_statements_summary_by_digest")) {
    if (normalized.includes("sql_text")) {
      return Promise.reject(sqlTextRefusal());
    }
    return Promise.resolve([[], []]);
  }

  return defaultMockExecute(sql);
}

/**
 * The digest table with the columns a real server gives it, and the refusal a real
 * server answers for the one column it does not have.
 *
 * `defaultMockExecute` used to invent a `query`/`calls`/`avgTime` row for ANY statement
 * over `events_statements_summary_by_digest`, which is exactly how the defect survived
 * every gate (#512): the health line asked for `LEFT(sql_text, 100)` and the mock
 * answered it, while no MySQL-family server will. Measured 2026-08-27 via `information_schema.columns` on
 * MySQL 26.7.0, Percona Server 8.4.11-11 and MariaDB 12.3.2 - the digest table carries
 * `DIGEST_TEXT`, never `SQL_TEXT` (that one belongs to `events_statements_current`,
 * MySQL 9.4 manual 29.12.20.1 / 29.12.20.3) - and asking for it answers
 *
 *   errno=1054 code=ER_BAD_FIELD_ERROR sqlState=42S22
 *   Unknown column 'sql_text' in 'field list'
 *
 * on all three, with `@@performance_schema` 1 or 0 alike. So this mock refuses it too.
 */
function digestTableMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  if (normalized.includes("events_statements_summary_by_digest")) {
    if (normalized.includes("sql_text")) {
      return Promise.reject(sqlTextRefusal());
    }
    // The two rows MySQL 26.7.0 answered on the live d32 database, verbatim: mysql2
    // hands DECIMAL divisions back as strings, which is why the times are quoted.
    return Promise.resolve([
      [
        {
          query_id: "4a851b710602abe1a349ea94f18828aa1ebd9c71a2aca9192b19239e7e644a71",
          query: "CREATE TABLE IF NOT EXISTS `t` ( `id` INTEGER PRIMARY KEY )",
          calls: "1",
          total_time_ms: "15.3182",
          avg_time_ms: "15.3182",
          min_time_ms: "15.3182",
          max_time_ms: "15.3182",
          rows_examined: "0",
        },
        {
          query_id: "ce25f4e6e4f27e1f15596c115886fcd761a1bdceb78383cf698d675423e8d23a",
          query: "SELECT COUNT ( * ) FROM `t`",
          calls: "2",
          total_time_ms: "4.1114",
          avg_time_ms: "2.0557",
          min_time_ms: "0.0622",
          max_time_ms: "4.0492",
          rows_examined: "0",
        },
      ],
      [],
    ]);
  }

  return defaultMockExecute(sql);
}

/**
 * The digest table present but UNREADABLE - the grant denied on it. This is the other
 * half of what actually reaches the failure path (the first is the schema being absent
 * outright, below); off-ness never does, it answers 0 rows.
 *
 * Measured 2026-08-27 on MySQL 26.7.0 with a user granted only `SELECT ON d32.*` plus
 * `PROCESS`:
 *
 *   errno=1142 code=ER_TABLEACCESS_DENIED_ERROR sqlState=42000
 *   SELECT command denied to user 'nops'@'172.17.0.1' for table
 *   'events_statements_summary_by_digest'
 *
 * Everything else that connection can read still answers, which is why this fixture
 * delegates the rest: the point of the tests below is that ONE unreadable source costs
 * one reading and names itself, rather than emptying a list that is then counted.
 */
function digestGrantDeniedMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  if (sql.trim().toLowerCase().includes("events_statements_summary_by_digest")) {
    const error = new Error(
      "SELECT command denied to user 'nops'@'172.17.0.1' for table 'events_statements_summary_by_digest'",
    ) as Error & { code: string; errno: number; sqlState: string };
    error.code = "ER_TABLEACCESS_DENIED_ERROR";
    error.errno = 1142;
    error.sqlState = "42000";
    return Promise.reject(error);
  }

  return defaultMockExecute(sql);
}

/**
 * Apache Doris, whose status and variable lists are both empty. Measured 2026-09-06
 * against `apache/doris:all-in-one-4.1.3` (FE with one alive BE) over mysql2 3.24.2's
 * text protocol:
 *
 *   SHOW STATUS                             -> ok, columns Variable_name/Value, 0 rows
 *   SHOW STATUS LIKE 'Uptime'               -> errno=1105 code=ER_UNKNOWN_ERROR
 *                                              sqlState=HY000, "mismatched input 'LIKE'
 *                                              expecting {<EOF>, ';'}(line 1, pos 12)"
 *   SHOW VARIABLES LIKE 'max_connections'   -> ok, 0 rows (four columns there)
 *
 * The LIKE arm REFUSES rather than answering, and that is the whole point of the
 * fixture: issue #573 is that the provider sent a statement this server rejects, so a
 * fixture that answered it would let the old statement keep passing this file.
 */
function dorisMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  if (normalized.startsWith("show status like")) {
    const error = new Error(
      "errCode = 2, detailMessage = \nmismatched input 'LIKE' expecting {<EOF>, ';'}(line 1, pos 12)\n",
    ) as Error & { code: string; errno: number; sqlState: string };
    error.code = "ER_UNKNOWN_ERROR";
    error.errno = 1105;
    error.sqlState = "HY000";
    return Promise.reject(error);
  }

  if (normalized.startsWith("show status")) {
    return Promise.resolve([[], []]);
  }

  if (normalized.includes("show variables like 'max_connections'")) {
    return Promise.resolve([[], []]);
  }

  return defaultMockExecute(sql);
}

/**
 * What a server with no `performance_schema` DATABASE does - a different fact from
 * the schema being merely OFF. Measured 2026-08-20 against a live OceanBase
 * Community Edition 4.4.2.1 tenant through this provider, and reproduced against
 * `mysql:latest` by naming a schema that is not there:
 *
 *   ERROR 1049 (42000) at line 1: Unknown database 'performance_schema_absent'
 *
 * The driver rejects rather than answering NULLs, so every reading that goes
 * through `performance_schema` is a throw on that tenant - not an edge case there,
 * the only path.
 */
function perfSchemaAbsentMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  if (normalized.includes("performance_schema.")) {
    const error = new Error("Unknown database 'performance_schema'") as Error & { code: string; errno: number };
    error.code = "ER_BAD_DB_ERROR";
    error.errno = 1049;
    return Promise.reject(error);
  }

  return defaultMockExecute(sql);
}

// ============================================================================
// Tests
// ============================================================================

describe("MySQLProvider", () => {
  let provider: InstanceType<typeof MySQLProvider>;

  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
  });

  afterEach(async () => {
    try {
      if (provider?.isConnected()) {
        await provider.disconnect();
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe("validate()", () => {
    test("missing host throws DatabaseConfigError", () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig({ host: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test("missing database throws DatabaseConfigError", () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig({ database: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test("valid config passes validation", () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig());
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    test("isConnected() is false before connect", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      expect(provider.isConnected()).toBe(false);
    });

    test("connect() sets connected to true", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect() sets connected to false", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test("double connect is idempotent", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe("query()", () => {
    test("SELECT returns rows, fields, and executionTime", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.query("SELECT * FROM users");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(Array.isArray(result.fields)).toBe(true);
      expect(typeof result.executionTime).toBe("number");
      expect(typeof result.rowCount).toBe("number");
    });

    test("result contains sanitized rows", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.query("SELECT id, name FROM test");
      expect(result.rows.length).toBe(1);
      const row = result.rows[0] as Record<string, unknown>;
      expect(row.id).toBe(1);
      expect(row.name).toBe("test");
    });

    /**
     * A BLOB reaches every surface AS BYTES.
     *
     * The provider used to answer the string `0x0102ab` for these three bytes, so
     * the grid showed `0x0102ab` where Postgres showed `\x0102ab` and the SQL export
     * wrote `'0x0102ab'` - eight characters of text into a BLOB column, which is the
     * defect #469 fixed for every other engine, entered one layer earlier. Measured
     * against MySQL 26.7.0 before the change; see docs/providers/mysql.md §3.3.
     */
    describe("a binary value", () => {
      async function queryBinary(value: unknown): Promise<unknown> {
        provider = new MySQLProvider(makeMySQLConfig());
        await provider.connect();
        mockExecuteFn = () => Promise.resolve([[{ b: value }], [{ name: "b" }]]);
        const result = await provider.query("SELECT b FROM types");
        return (result.rows[0] as Record<string, unknown>).b;
      }

      test("is handed on as bytes, spelled the one way every surface spells it", async () => {
        const bytes = asBytes(await queryBinary(Buffer.from("0102ab", "hex")));

        expect(bytes).toEqual(new Uint8Array([1, 2, 171]));
        expect(binaryText(bytes as Uint8Array)).toBe("\\x0102ab");
      });

      test("survives the JSON the API response is made of", async () => {
        const overTheWire: unknown = JSON.parse(JSON.stringify(await queryBinary(Buffer.from("0102ab", "hex"))));

        expect(binaryText(asBytes(overTheWire) as Uint8Array)).toBe("\\x0102ab");
      });

      test("is an empty byte string when empty, not the empty text one", async () => {
        // This answered `""` before, which reads as a zero-length VARCHAR: an empty
        // BLOB and an empty string are different values and were spelled alike.
        const bytes = asBytes(await queryBinary(Buffer.alloc(0)));

        expect(bytes).toEqual(new Uint8Array(0));
        expect(binaryText(bytes as Uint8Array)).toBe("\\x");
      });

      test("stays null when the column is NULL", async () => {
        expect(await queryBinary(null)).toBeNull();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe("getCapabilities()", () => {
    // #U9: MySQL has no VACUUM at all, and every statement it does have names tables.
    test("declares the target grammar of every maintenance operation", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const caps = provider.getCapabilities();

      expect(caps.maintenanceOperationSpecs).toEqual({
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        optimize: { label: "Optimize Table", perEntity: true, global: true },
        check: { label: "Check Table", perEntity: true, global: true },
        kill: { label: "Kill Connection", perEntity: false, global: false },
      });
      expect(Object.keys(caps.maintenanceOperationSpecs ?? {}).sort()).toEqual([...caps.maintenanceOperations].sort());
      // The engine has no `vacuum`, so nothing may be offered under that name.
      expect(caps.maintenanceOperations).not.toContain("vacuum");
    });

    test("the vacuum label names OPTIMIZE, and the surfaces send that", () => {
      // The base default put "Vacuum Table" in the explorer's per-row menu and
      // "Run Vacuum / Reclaim Space" on the Operations tab for an engine that has
      // neither, and the global card was gated on the literal `vacuum`, so MySQL's
      // own wording could never appear (#496).
      const labels = new MySQLProvider(makeMySQLConfig()).getLabels();

      expect(labels.vacuumAction).toBe("Optimize Table");
      expect(labels.vacuumActionOperation).toBe("optimize");
      expect(labels.vacuumGlobalLabel).toBe("Run Optimize");
      expect(labels.vacuumGlobalTitle).toBe("Optimize Tables");
      expect(labels.vacuumGlobalDesc).toContain("OPTIMIZE TABLE");
    });
    test("returns correct MySQL capabilities", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBe(3306);
      expect(caps.queryLanguage).toBe("sql");
      expect(caps.supportsExplain).toBe(true);
      expect(caps.explainFormat).toBe("mysql-json");
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
      expect(caps.supportsConnectionString).toBe(true);
      // `UPDATE t SET c = v WHERE pk = v` is core MySQL DML — the shape the inline
      // row editor builds (#269).
      expect(caps.supportsInlineRowEdit).toBe(true);
      // One held connection carries the transaction, so the trio is offered (#464).
      expect(caps.supportsTransactions).toBe(true);
      // Inherited from the base capabilities: this engine declares foreign keys, so
      // an empty `foreignKeys` list is a fact about the schema or the role, never
      // about the engine (#414).
      expect(caps.declaresForeignKeys).toBe(true);
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("optimize");
      expect(caps.maintenanceOperations).toContain("check");
      expect(caps.maintenanceOperations).toContain("kill");
    });
  });

  // --------------------------------------------------------------------------
  // Labels
  // --------------------------------------------------------------------------

  describe("getLabels()", () => {
    // The only label this provider declares. Until #U12 the monitoring Queries panel told
    // a MySQL operator to install a PostgreSQL extension, so the sentence has to name the
    // source MySQL actually has:
    // `performance_schema.events_statements_summary_by_digest`.
    test("names the Performance Schema, not a Postgres extension, as the source of query stats", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const { slowQueriesEmptyState, entityName } = provider.getLabels();

      expect(slowQueriesEmptyState).toContain("performance_schema.events_statements_summary_by_digest");
      expect(slowQueriesEmptyState).toContain("Performance Schema");
      expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
      // Everything else is still the inherited SQL wording, which is right for MySQL.
      expect(entityName).toBe("Table");
    });

    // The sentence describes the source and stops. `QueriesTab` renders this ONE fixed
    // string for every empty list whatever produced it, so it cannot be a reason carrier
    // and must not read as one: an instruction in it is addressed to causes it cannot tell
    // apart. It used to end "enable the Performance Schema to see them", which named the
    // one cause that never reaches the failure path - off-ness answers 0 rows, measured -
    // and was unactionable for the ones that do (a denied grant, a tenant with no
    // `performance_schema` database). Those reject now and reach the panel as the server's
    // own sentence through `PanelUnavailable`, a different string on a different branch.
    test("the empty-state sentence gives no instruction, because it cannot know which cause emptied the list", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const { slowQueriesEmptyState } = provider.getLabels();

      expect(slowQueriesEmptyState).not.toMatch(/enable/i);
      expect(slowQueriesEmptyState).not.toMatch(/not available|unavailable/i);
      // What it does say: the two things an empty list can mean once an unreadable source
      // rejects instead of emptying.
      expect(slowQueriesEmptyState).toContain("recorded nothing");
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe("getSchema()", () => {
    test("returns TableSchema array with columns, indexes, foreignKeys", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema.length).toBeGreaterThan(0);

      for (const table of schema) {
        expect(typeof table.name).toBe("string");
        expect(Array.isArray(table.columns)).toBe(true);
        expect(table.columns.length).toBeGreaterThan(0);
        expect(Array.isArray(table.indexes)).toBe(true);
        expect(Array.isArray(table.foreignKeys)).toBe(true);
      }
    });

    test("columns have expected properties", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const schema = await provider.getSchema();
      const firstTable = schema[0];
      const col = firstTable.columns[0];

      expect(typeof col.name).toBe("string");
      expect(typeof col.type).toBe("string");
      expect(typeof col.nullable).toBe("boolean");
      expect(typeof col.isPrimary).toBe("boolean");
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe("getHealth()", () => {
    test("returns health info with activeConnections, databaseSize, cacheHitRatio, slowQueries, activeSessions", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe("number");
      expect(health.activeConnections).toBe(5);
      expect(typeof health.databaseSize).toBe("string");
      expect(typeof health.cacheHitRatio).toBe("string");
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);
    });

    test("reads the connection count from ONE bare SHOW STATUS, never SHOW STATUS LIKE", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      protocolCalls = [];
      await provider.getHealth();

      // Apache Doris 4.1.3 rejects the LIKE clause on SHOW STATUS as a parse error
      // (errno 1105, measured 2026-09-06), which took the whole Health panel down
      // there. One bare read, picked client-side, is what every engine accepts (#573).
      expect(
        protocolCalls
          .filter((c) => c.sql.toLowerCase().includes("show status"))
          .map((c) => ({ method: c.method, sql: c.sql.trim() })),
      ).toEqual([{ method: "query", sql: "SHOW STATUS" }]);
    });

    test("omits activeConnections on a server that publishes no Threads_connected row", async () => {
      mockExecuteFn = dorisMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      // ABSENCE and ZERO are different facts (#477, and the docblock on
      // `HealthInfo.activeConnections`). Doris 4.1.3 and StarRocks 3.3.22 answer a bare
      // SHOW STATUS with zero rows and TiDB 8.5.1 publishes Uptime but not
      // Threads_connected, so the key must be missing rather than a fabricated 0.
      expect("activeConnections" in health).toBe(false);
      expect(Array.isArray(health.activeSessions)).toBe(true);
    });

    test("reports the cache hit ratio as measured when performance_schema answers", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe("99.5");
    });

    test("reports the cache hit ratio as unavailable when performance_schema is disabled", async () => {
      mockExecuteFn = perfSchemaDisabledMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    });

    test("survives a tenant with no performance_schema database and reports the ratio as unavailable", async () => {
      mockExecuteFn = perfSchemaAbsentMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      // The ratio query threw ERROR 1049, which used to take the whole health read
      // down with it - the OceanBase tenant got no panel at all rather than a panel
      // with one honest gap in it.
      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
      expect(health.activeConnections).toBe(5);
      // EMPTY, not a sentence about the Performance Schema: see the slow-query line
      // section below and the reason recorded next to the read in `mysql.ts`. A sentence
      // wearing a row's clothes is a fabricated measurement whatever counts it; when this
      // was written the agent's curated health reading also forwarded the list's length,
      // and that projection has since been removed (#513).
      expect(health.slowQueries).toEqual([]);
      expect(Array.isArray(health.activeSessions)).toBe(true);
    });

    // ------------------------------------------------------------------------
    // #512: the slow-query line stated a capability as absent on servers that had it
    // ------------------------------------------------------------------------

    test("the health slow-query line carries the digest rows the panel reads, not a capability sentence", async () => {
      mockExecuteFn = digestTableMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(health.slowQueries).toEqual([
        {
          query: "CREATE TABLE IF NOT EXISTS `t` ( `id` INTEGER PRIMARY KEY )",
          calls: 1,
          avgTime: "15.32ms",
        },
        { query: "SELECT COUNT ( * ) FROM `t`", calls: 2, avgTime: "2.06ms" },
      ]);
    });

    test("no health read names sql_text, the column the digest table does not have", async () => {
      mockExecuteFn = digestTableMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      protocolCalls = [];
      await provider.getHealth();

      // The regression guard that does not depend on the mock's kindness: the mock
      // above refuses `sql_text` the way a server does, and this asserts the provider
      // never asks for it in the first place.
      expect(protocolCalls.filter((c) => c.sql.toLowerCase().includes("sql_text"))).toEqual([]);
    });

    test("the health slow-query line and the Queries panel report the same statements", async () => {
      mockExecuteFn = digestTableMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();
      const panel = await provider.getSlowQueries({ limit: 5 });

      // The panel beside the health line must never be able to disprove it, which is
      // only structurally true while both come from the one digest statement.
      expect(health.slowQueries.map((q) => q.query)).toEqual(panel.map((q) => q.query));
      expect(health.slowQueries.map((q) => q.calls)).toEqual(panel.map((q) => q.calls));
    });

    test("the health slow-query line is empty on a server whose Performance Schema is off", async () => {
      mockExecuteFn = perfSchemaDisabledMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      // Measured 2026-08-27 on MySQL 26.7.0 started with `--performance-schema=OFF` and
      // on MariaDB 12.3.2, which ships it off: the digest table still EXISTS and answers
      // 0 rows rather than throwing. So off-ness never reaches the catch, and the honest
      // reading here is no rows.
      expect(health.slowQueries).toEqual([]);
    });

    test("the health slow-query read is the five heaviest digests with no slowness threshold", async () => {
      mockExecuteFn = digestTableMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      protocolCalls = [];
      await provider.getHealth();

      const digestRead = protocolCalls.find((c) => c.sql.toLowerCase().includes("events_statements_summary_by_digest"));
      const normalized = digestRead?.sql.trim().toLowerCase() ?? "";

      // WHAT THIS LIST IS, pinned so nobody can read its length as a count of slow
      // statements. There is no slowness predicate anywhere in the statement: the only
      // WHERE term is the connected schema, "slow" is an ORDERING (`SUM_TIMER_WAIT
      // DESC`), and the LIMIT is 5. So on any server with five or more digests for this
      // schema the list is five rows whatever their times are, so `health.slowQueries.length`
      // reports 5 forever. It saturates at the cap; it is not a count, and no threshold
      // makes a member of it "slow". The agent's curated health reading used to forward
      // that length to the model and no longer projects any length at all (#513), which is
      // why this stays pinned here: the cap is a property of the statement, not of the
      // consumer that happened to count it.
      expect(normalized).toContain("order by sum_timer_wait desc");
      expect(normalized.endsWith("limit 5;")).toBe(true);
      expect(normalized.split("where")[1]?.split("order by")[0]?.trim()).toBe("schema_name = ?");
    });

    test("a denied grant on the digest table empties the health line and names itself on the panel path", async () => {
      mockExecuteFn = digestGrantDeniedMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      // THE HEALTH LINE DROPS THE REASON, and this asserts exactly that rather than
      // claiming otherwise: `HealthInfo.slowQueries` is a `SlowQuery[]` with no error
      // field, so an unreadable source is indistinguishable here from a source that
      // measured nothing. Empty is the least-wrong shape - a row saying "Performance
      // schema not available" was what representing it anyway looked like, and it was
      // counted as a slow query (#512). Everything else the connection can read still
      // answers.
      const health = await provider.getHealth();
      expect(health.slowQueries).toEqual([]);
      expect(health.activeConnections).toBe(5);
      expect(health.activeSessions).toHaveLength(2);

      // The reason is not lost to the operator, because the panel path has a channel for
      // it: `getSlowQueries()` rejects rather than swallowing, `getMonitoringData()`
      // (src/lib/db/base-provider.ts) records the rejection under `errors.slowQueries`,
      // and `QueriesTab` renders that through `PanelUnavailable` with the server's own
      // sentence. Without this test the comments saying so would be assertions about
      // nothing: before the repair `getSlowQueries()` returned `[]` here too, and then
      // `errors.slowQueries` could never be set for MySQL at all.
      await expect(provider.getSlowQueries()).rejects.toThrow(
        /SELECT command denied .* for table 'events_statements_summary_by_digest'/,
      );

      const monitoring = await provider.getMonitoringData({ includeTables: false, includeIndexes: false });
      expect(monitoring.slowQueries).toBeUndefined();
      expect(monitoring.errors?.slowQueries).toContain("events_statements_summary_by_digest");
      // One refused panel costs only itself.
      expect(monitoring.overview).toBeDefined();
      expect(monitoring.activeSessions?.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe("runMaintenance()", () => {
    test("analyze returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("analyze", "users");
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe("number");
      expect(result.message).toContain("ANALYZE");
    });

    test("optimize returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("optimize", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("OPTIMIZE");
    });

    test("check returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("check", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("CHECK");
    });

    test("analyze without target runs against all tables", async () => {
      const executedStatements: string[] = [];
      mockExecuteFn = (sql: string) => {
        executedStatements.push(sql);
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("analyze");
      expect(result.success).toBe(true);
      expect(result.message).toContain("ANALYZE");

      // getAllTablesForMaintenance lists tables and escapes each identifier
      const analyzeSql = executedStatements.find((s) => s.startsWith("ANALYZE TABLE"));
      expect(analyzeSql).toBeDefined();
      expect(analyzeSql).toContain("`users`");
      expect(analyzeSql).toContain("`orders`");
    });

    test("kill without target throws QueryError", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await expect(provider.runMaintenance("kill")).rejects.toThrow("Target connection ID is required");
    });

    test("kill with valid target returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("kill", "1234");
      expect(result.success).toBe(true);
      expect(result.message).toContain("KILL");
    });

    test("unsupported type throws QueryError", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await expect(provider.runMaintenance("vacuum" as unknown as "analyze", "users")).rejects.toThrow(
        "Unsupported maintenance type for MySQL",
      );
    });

    // ------------------------------------------------------------------------
    // The verdict is in the RESULT SET, not in the absence of a throw
    // ------------------------------------------------------------------------
    // `await runStatement(conn, sql); return { success: true }` discarded the rows
    // MySQL answers with, so a statement the server refused was reported as a
    // completed operation and CHECK TABLE's whole purpose - its Msg_text - never
    // reached the user. Measured through the provider against MySQL 26.7.0 on
    // 2026-08-25: `optimize u9t` answered `{"success":true,"message":"OPTIMIZE
    // completed successfully"}` while the server's own answer for the same statement
    // was Error / "Table 'u9t.missing' doesn't exist" / "Operation failed".

    test("check reports the engine's own verdict rather than a generic sentence", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("check", "users");

      expect(result.success).toBe(true);
      // The Msg_text is the point of CHECK TABLE: "OK" here, a corruption report on a
      // damaged table.
      expect(result.message).toContain("OK");
    });

    test("a table MySQL says does not exist is a failure, and says why", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("optimize", "missing");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Table 'testdb.missing' doesn't exist");
    });

    test("check on a missing table fails too", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("check", "missing");

      expect(result.success).toBe(false);
      expect(result.message).toContain("doesn't exist");
    });

    test("one failing table fails the whole-database run and names that table", async () => {
      // The global card sends no target and the statement names every table, so a
      // per-table Error row is the only place the failure appears.
      mockExecuteFn = (sql: string) => {
        if (sql.includes("SELECT TABLE_NAME")) {
          return Promise.resolve([[{ TABLE_NAME: "users" }, { TABLE_NAME: "missing" }], []]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("optimize");

      expect(result.success).toBe(false);
      expect(result.message).toContain("testdb.missing");
      // The table that DID optimize is not reported as a failure.
      expect(result.message).not.toContain("testdb.users");
    });

    test("the non-error rows MySQL adds are kept, deduplicated", async () => {
      // InnoDB prepends a note to every OPTIMIZE it performs; over many tables that
      // note and the OK repeat once per table, which is one sentence, not forty.
      mockExecuteFn = (sql: string) => {
        if (sql.includes("SELECT TABLE_NAME")) {
          return Promise.resolve([[{ TABLE_NAME: "users" }, { TABLE_NAME: "orders" }], []]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("optimize");

      expect(result.success).toBe(true);
      expect(result.message).toContain("Table does not support optimize");
      expect(result.message).toContain("OK");
      expect(result.message.match(/OK/g)).toHaveLength(1);
    });

    test("the whole-database form on a database with no tables runs no statement", async () => {
      // `OPTIMIZE TABLE ${await this.getAllTablesForMaintenance(conn)}` string-joined an
      // empty list, and MySQL answered "You have an error in your SQL syntax ... near ''"
      // - measured through the provider against an empty database on 2026-08-25.
      const statements: string[] = [];
      mockExecuteFn = (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT TABLE_NAME")) {
          return Promise.resolve([[], []]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("optimize");

      // Nothing to do is not a failure, and it is not a syntax error either.
      expect(result.success).toBe(true);
      expect(result.message).toContain("no tables");
      expect(statements.some((sql) => sql.startsWith("OPTIMIZE TABLE"))).toBe(false);
    });

    test("a statement that answers a header rather than a result set still succeeds", async () => {
      // KILL is the one maintenance statement here that does NOT answer a result set -
      // mysql2 hands back a `ResultSetHeader` object - so it never reaches the row reader
      // and keeps the generic sentence. The three that do (ANALYZE/OPTIMIZE/CHECK TABLE)
      // always answer rows, measured on 26.7.0, which is why the reader does not have to
      // defend against a header shape it is never given.
      mockExecuteFn = (sql: string) => {
        if (sql.startsWith("KILL")) {
          return Promise.resolve([{ affectedRows: 0, warningStatus: 0 }, undefined]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("kill", "1234");

      expect(result.success).toBe(true);
      expect(result.message).toBe("KILL completed successfully");
    });
  });

  // --------------------------------------------------------------------------
  // Transaction support
  // --------------------------------------------------------------------------

  describe("Transaction lifecycle", () => {
    test("beginTransaction / commitTransaction works", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("beginTransaction / rollbackTransaction works", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("double beginTransaction throws", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      await expect(provider.beginTransaction()).rejects.toThrow("Transaction already active");
      // Clean up
      await provider.rollbackTransaction();
    });

    test("expireTransaction auto-rollbacks an active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      await provider.expireTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("transaction auto-rolls back when the timeout timer fires", async () => {
      // TX_TIMEOUT_MS is a compile-time-private static; shrink it at runtime so
      // the setTimeout callback in beginTransaction actually fires in the test.
      const providerStatics = MySQLProvider as unknown as { TX_TIMEOUT_MS: number };
      const originalTimeout = providerStatics.TX_TIMEOUT_MS;
      providerStatics.TX_TIMEOUT_MS = 5;

      try {
        provider = new MySQLProvider(makeMySQLConfig());
        await provider.connect();
        await provider.beginTransaction();
        expect(provider.isInTransaction()).toBe(true);

        // Wait for the shortened timeout to trigger the auto-rollback
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(provider.isInTransaction()).toBe(false);
      } finally {
        providerStatics.TX_TIMEOUT_MS = originalTimeout;
      }
    });

    test("expireTransaction is no-op when no active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      // Should not throw
      await provider.expireTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Cancel query
  // --------------------------------------------------------------------------

  describe("cancelQuery()", () => {
    test("cancelQuery with unknown queryId returns false", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.cancelQuery("nonexistent-query-id");
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getOverview()
  // --------------------------------------------------------------------------

  describe("getOverview()", () => {
    test("returns version, uptime, connections, size, table/index counts", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toContain("MySQL");
      expect(overview.version).toContain("8.0.35");
      expect(typeof overview.uptime).toBe("string");
      expect(overview.uptime.length).toBeGreaterThan(0);
      expect(typeof overview.activeConnections).toBe("number");
      expect(overview.activeConnections).toBe(5);
      expect(typeof overview.maxConnections).toBe("number");
      expect(overview.maxConnections).toBe(151);
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(overview.databaseSizeBytes).toBe(13107200);
      expect(typeof overview.tableCount).toBe("number");
      expect(overview.tableCount).toBe(2);
      expect(typeof overview.indexCount).toBe("number");
      expect(overview.indexCount).toBe(3);
      expect(overview.startTime).toBeInstanceOf(Date);
    });

    test("a size result without the expected column leaves overview size absent", async () => {
      mockExecuteFn = (sql: string) => {
        const lower = sql.toLowerCase();
        if (
          lower.includes("information_schema.tables") &&
          lower.includes("sum(data_length") &&
          !lower.includes("table_name")
        ) {
          return Promise.resolve([[{ size_mb: "12.50", name: "testdb" }], []]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a size read with no result row leaves overview size absent", async () => {
      mockExecuteFn = (sql: string) => {
        const lower = sql.toLowerCase();
        if (
          lower.includes("information_schema.tables") &&
          lower.includes("sum(data_length") &&
          !lower.includes("table_name")
        ) {
          return Promise.resolve([[], []]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a non-finite size leaves overview size absent", async () => {
      mockExecuteFn = (sql: string) => {
        const lower = sql.toLowerCase();
        if (
          lower.includes("information_schema.tables") &&
          lower.includes("sum(data_length") &&
          !lower.includes("table_name")
        ) {
          return Promise.resolve([[{ size_mb: "12.50", size_bytes: Number.POSITIVE_INFINITY, name: "testdb" }], []]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a database that measures zero bytes keeps its measured zero size", async () => {
      // The anti-vacuity twin of the tests above: `SUM(DATA_LENGTH + INDEX_LENGTH)`
      // returns NULL over an empty schema, and that returned null aggregate is a
      // measured zero the provider must keep publishing - never an absence.
      mockExecuteFn = (sql: string) => {
        const lower = sql.toLowerCase();
        if (
          lower.includes("information_schema.tables") &&
          lower.includes("sum(data_length") &&
          !lower.includes("table_name")
        ) {
          return Promise.resolve([[{ size_mb: "0.00", size_bytes: null, name: "testdb" }], []]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(true);
      expect(overview.databaseSizeBytes).toBe(0);
      expect(overview.databaseSize).toBe("0 B");
    });

    test("does not call a MariaDB server MySQL", async () => {
      mockExecuteFn = mariaDBMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // The driver is mysql2 and the wire protocol is MySQL's, but the SERVER is not
      // MySQL and the panel must not assert that it is.
      expect(overview.version).not.toContain("MySQL");
      expect(overview.version).toContain("MariaDB");
      expect(overview.version).toContain("12.3.2");
    });

    test("leaves every measured self-identifying version string as the server gave it", async () => {
      // The exact strings WIRE_COMPATIBLE_ENGINES recorded from a live probe.
      const probed = ["12.3.2-MariaDB-ubu2404", "8.0.11-TiDB-v8.5.1", "8.0.43-Vitess", "5.7.25-OceanBase_CE-v4.4.2.1"];

      for (const version of probed) {
        mockExecuteFn = (sql: string) =>
          sql.trim().toLowerCase().includes("version()")
            ? Promise.resolve([[{ version }], [{ name: "version" }]])
            : defaultMockExecute(sql);

        provider = new MySQLProvider(makeMySQLConfig());
        await provider.connect();
        const overview = await provider.getOverview();
        await provider.disconnect();

        expect(overview.version).toBe(version);
      }
    });

    test("still names MySQL when the server does not name itself", async () => {
      // StarRocks answers VERSION() with a plain "5.1.0" and SingleStore with a
      // MySQL number too: there is nothing to key on, so the prefix stays.
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toBe("MySQL 8.0.35");
    });

    test("reads Doris's real build from @@version_comment when VERSION() is the fictitious compat number", async () => {
      // Measured against apache/doris:all-in-one-4.1.3: VERSION() answers the
      // fixed "5.7.99" and has nothing to key on, but @@version_comment carries
      // Doris's own build string.
      mockExecuteFn = (sql: string) =>
        sql.trim().toLowerCase().includes("version()")
          ? Promise.resolve([
              [{ version: "5.7.99", version_comment: "doris version doris-4.1.3-rc02-7126cf65d96" }],
              [{ name: "version" }, { name: "version_comment" }],
            ])
          : defaultMockExecute(sql);

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toBe("Apache Doris 4.1.3-rc02-7126cf65d96");
    });

    test("does not mistake a generic @@version_comment for Doris's", async () => {
      // Measured against mysql:latest 26.7.0: @@version_comment answers
      // "MySQL Community Server - GPL", which must not match the Doris pattern.
      mockExecuteFn = (sql: string) =>
        sql.trim().toLowerCase().includes("version()")
          ? Promise.resolve([
              [{ version: "8.0.35", version_comment: "MySQL Community Server - GPL" }],
              [{ name: "version" }, { name: "version_comment" }],
            ])
          : defaultMockExecute(sql);

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toBe("MySQL 8.0.35");
    });

    test("formats uptime correctly", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // 86400 seconds = 1 day
      expect(overview.uptime).toBe("1d 0h");
    });

    test("reads uptime and connections from ONE bare SHOW STATUS, and keeps SHOW VARIABLES LIKE", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      protocolCalls = [];
      await provider.getOverview();

      // Doris 4.1.3 rejects `SHOW STATUS LIKE` (errno 1105, measured 2026-09-06) and
      // accepts `SHOW VARIABLES LIKE 'max_connections'`, so only the first statement
      // changes: the narrowest fix touches only what a grammar refuses. One read
      // serves both variables, which is one round trip fewer than before.
      expect(
        protocolCalls
          .filter((c) => c.sql.toLowerCase().includes("show status"))
          .map((c) => ({ method: c.method, sql: c.sql.trim() })),
      ).toEqual([{ method: "query", sql: "SHOW STATUS" }]);
      expect(methodFor("show variables like 'max_connections'")).toBe("query");
    });

    test("reports absence, not zero, on a server that publishes no status rows", async () => {
      mockExecuteFn = dorisMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // Doris 4.1.3: SHOW STATUS answers 0 rows and SHOW VARIABLES LIKE
      // 'max_connections' answers 0 rows, both measured 2026-09-06. Nothing was read,
      // so nothing is reported as read: no `activeConnections` key at all, no
      // `startTime` for an uptime nobody published, and the uptime string is the "N/A"
      // every other provider sends for an unmeasured one.
      expect("activeConnections" in overview).toBe(false);
      expect("startTime" in overview).toBe(false);
      expect(overview.uptime).toBe("N/A");
      // `maxConnections` is the one figure where 0 and absence are the SAME fact - it
      // means "no limit published", see the docblock in `src/lib/db/types.ts` - so it
      // stays a number. The old fallback invented MySQL's 151 for every server.
      expect(overview.maxConnections).toBe(0);
      expect(overview.version).toBe("MySQL 8.0.35");
    });

    test("picks the status rows case-insensitively", async () => {
      // `SHOW STATUS LIKE 'Uptime'` matched case-insensitively on every MySQL-family
      // server, so the client-side pick that replaces it has to match the same way.
      mockExecuteFn = (sql: string) =>
        sql.trim().toLowerCase().startsWith("show status")
          ? Promise.resolve([
              [
                { Variable_name: "uptime", Value: "86400" },
                { Variable_name: "threads_connected", Value: "7" },
              ],
              [],
            ])
          : defaultMockExecute(sql);

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.uptime).toBe("1d 0h");
      expect(overview.activeConnections).toBe(7);
    });
  });

  // --------------------------------------------------------------------------
  // getPerformanceMetrics()
  // --------------------------------------------------------------------------

  describe("getPerformanceMetrics()", () => {
    test("reports nothing at all on a tenant with no performance_schema database", async () => {
      mockExecuteFn = perfSchemaAbsentMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      expect(await provider.getPerformanceMetrics()).toEqual({});
    });

    test("returns cacheHitRatio, bufferPoolUsage, deadlocks, QPS", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(typeof metrics.cacheHitRatio).toBe("number");
      expect(metrics.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(metrics.cacheHitRatio).toBeLessThanOrEqual(100);
      expect(typeof metrics.bufferPoolUsage).toBe("number");
      // 800/1000 * 100 = 80
      expect(metrics.bufferPoolUsage).toBe(80);
      expect(typeof metrics.deadlocks).toBe("number");
      expect(metrics.deadlocks).toBe(0);
      expect(typeof metrics.queriesPerSecond).toBe("number");
      // 50000 / 86400 ≈ 0.58
      expect(metrics.queriesPerSecond).toBeGreaterThan(0);
    });

    test("omits the metrics performance_schema cannot answer when it is disabled", async () => {
      mockExecuteFn = perfSchemaDisabledMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      // ABSENCE and ZERO are different inputs (#448, #452). A server with
      // performance_schema off has measured nothing, so nothing is reported -
      // not a confident 99% hit ratio, not a 0% buffer pool, not 0 QPS.
      expect(metrics.cacheHitRatio).toBeUndefined();
      expect(metrics.bufferPoolUsage).toBeUndefined();
      expect(metrics.queriesPerSecond).toBeUndefined();

      // Deadlocks come from SHOW STATUS, which answers with or without
      // performance_schema, so this 0 is a measurement and stays.
      expect(metrics.deadlocks).toBe(0);
    });

    test("omits deadlocks on a server that does not publish Innodb_deadlocks", async () => {
      // `Innodb_deadlocks` is MariaDB's status variable. MySQL does not publish it -
      // measured 2026-09-06 on MySQL 26.7.0, whose bare SHOW STATUS answers 528 rows
      // and none of them named `Innodb_deadlocks`, against MariaDB 12.3.2's 571 rows
      // which do. So the row is simply not in the list, and the old
      // `parseInt(row?.Value || "0")` reported a deadlock count MySQL never gave.
      mockExecuteFn = (sql: string) =>
        sql.trim().toLowerCase().startsWith("show status")
          ? Promise.resolve([
              [
                { Variable_name: "Threads_connected", Value: "5" },
                { Variable_name: "Uptime", Value: "86400" },
              ],
              [],
            ])
          : defaultMockExecute(sql);

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.deadlocks).toBeUndefined();
      // The performance_schema readings are unaffected: still measured, still reported.
      expect(metrics.cacheHitRatio).toBe(99.5);
      expect(metrics.bufferPoolUsage).toBe(80);
    });

    test("reads deadlocks from a bare SHOW STATUS, never SHOW STATUS LIKE", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      protocolCalls = [];
      await provider.getPerformanceMetrics();

      expect(
        protocolCalls
          .filter((c) => c.sql.toLowerCase().includes("show status"))
          .map((c) => ({ method: c.method, sql: c.sql.trim() })),
      ).toEqual([{ method: "query", sql: "SHOW STATUS" }]);
    });

    test("omits every metric when the performance_schema query fails outright", async () => {
      mockExecuteFn = (sql: string) => {
        if (sql.trim().toLowerCase().includes("performance_schema")) {
          return Promise.reject(new Error("Table 'performance_schema.global_status' doesn't exist"));
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.cacheHitRatio).toBeUndefined();
      expect(metrics.bufferPoolUsage).toBeUndefined();
      expect(metrics.queriesPerSecond).toBeUndefined();
      expect(metrics.deadlocks).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getSlowQueries()
  // --------------------------------------------------------------------------

  describe("getSlowQueries()", () => {
    test("returns slow query stats from performance_schema", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);

      const first = slowQueries[0];
      expect(typeof first.query).toBe("string");
      expect(first.query).toContain("SELECT");
      expect(typeof first.calls).toBe("number");
      expect(typeof first.totalTime).toBe("number");
      expect(typeof first.avgTime).toBe("number");
      expect(typeof first.rows).toBe("number");
    });

    test("respects limit option", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries({ limit: 5 });

      // Our mock returns 1 row regardless of limit, but we verify the method accepts it
      expect(Array.isArray(slowQueries)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getActiveSessions()
  // --------------------------------------------------------------------------

  describe("getActiveSessions()", () => {
    test("returns session list with pid, user, state, query", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBe(2);

      const first = sessions[0];
      expect(typeof first.pid).toBe("number");
      expect(first.pid).toBe(1);
      expect(typeof first.user).toBe("string");
      expect(first.user).toBe("root");
      expect(typeof first.state).toBe("string");
      expect(typeof first.query).toBe("string");
      expect(typeof first.duration).toBe("string");
      expect(typeof first.durationMs).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // getTableStats()
  // --------------------------------------------------------------------------

  describe("getTableStats()", () => {
    test("returns table stats with sizes and row counts", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(2);

      const first = stats[0];
      expect(typeof first.tableName).toBe("string");
      expect(first.tableName).toBe("users");
      expect(typeof first.rowCount).toBe("number");
      expect(first.rowCount).toBe(100);
      expect(typeof first.tableSize).toBe("string");
      expect(typeof first.tableSizeBytes).toBe("number");
      expect(first.tableSizeBytes).toBe(4096);
      expect(typeof first.indexSize).toBe("string");
      // The byte figure, not only the formatted string: the storage panel's index total is the sum
      // of these, and MySQL used to compute this number and drop it, so the panel read "N/A".
      expect(first.indexSizeBytes).toBe(2048);
      expect(typeof first.totalSize).toBe("string");
      expect(typeof first.totalSizeBytes).toBe("number");
      expect(first.totalSizeBytes).toBe(6144);
      expect(typeof first.schemaName).toBe("string");
      expect(typeof first.bloatRatio).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // getIndexStats()
  // --------------------------------------------------------------------------

  describe("getIndexStats()", () => {
    test("returns index stats with scan counts", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(2);

      const primary = stats[0];
      expect(typeof primary.indexName).toBe("string");
      expect(primary.indexName).toBe("PRIMARY");
      expect(typeof primary.tableName).toBe("string");
      expect(primary.tableName).toBe("users");
      expect(typeof primary.indexType).toBe("string");
      expect(primary.indexType).toBe("BTREE");
      expect(Array.isArray(primary.columns)).toBe(true);
      expect(primary.columns).toContain("id");
      expect(typeof primary.isUnique).toBe("boolean");
      expect(primary.isUnique).toBe(true);
      expect(typeof primary.isPrimary).toBe("boolean");
      expect(primary.isPrimary).toBe(true);
      expect(typeof primary.scans).toBe("number");
      expect(primary.scans).toBe(100);
      expect(primary.indexSize).toBe("16 KB");
      expect(primary.indexSizeBytes).toBe(16384);
    });

    test("reports an index with no persistent-stats row as unavailable, not as zero bytes", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      // `users.idx_email` has no mysql.innodb_index_stats row (MyISAM tables and
      // never-analyzed InnoDB tables behave the same way on a live server).
      const secondary = stats[1];
      expect(secondary.indexName).toBe("idx_email");
      expect(secondary.indexSize).toBe("N/A");
      expect(secondary.indexSizeBytes).toBeUndefined();
    });

    test("reports every size as unavailable when the mysql schema is not readable", async () => {
      mockExecuteFn = (sql, params) => {
        if (sql.toLowerCase().includes("innodb_index_stats")) {
          return Promise.reject(new Error("SELECT command denied to user 'app'@'%' for table 'innodb_index_stats'"));
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(stats.length).toBe(2);
      for (const index of stats) {
        expect(index.indexSize).toBe("N/A");
        expect(index.indexSizeBytes).toBeUndefined();
      }
    });

    test("looks the sizes up under the schema the server reported, not the one connected to", async () => {
      // Vitess answers information_schema.STATISTICS with the physical shard database
      // (`vt_testdb_0`) even though the filter named the keyspace.
      const sizeParams: unknown[][] = [];
      mockExecuteFn = (sql, params) => {
        const normalized = sql.toLowerCase();
        if (normalized.includes("information_schema.statistics") && normalized.includes("group_concat")) {
          return Promise.resolve([
            [
              {
                schema_name: "vt_testdb_0",
                table_name: "orders",
                index_name: "PRIMARY",
                index_type: "BTREE",
                columns: "id",
                is_unique: 1,
                is_primary: 1,
                cardinality: "3",
              },
            ],
            [],
          ]);
        }
        if (normalized.includes("innodb_index_stats")) {
          sizeParams.push(params ?? []);
          return Promise.resolve([
            [{ database_name: "vt_testdb_0", table_name: "orders", index_name: "PRIMARY", size_bytes: "16384" }],
            [],
          ]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(sizeParams).toEqual([["vt_testdb_0"]]);
      expect(stats[0].indexSizeBytes).toBe(16384);
      expect(stats[0].indexSize).toBe("16 KB");
    });
  });

  // --------------------------------------------------------------------------
  // getStorageStats()
  // --------------------------------------------------------------------------

  describe("getStorageStats()", () => {
    test("returns innodb data and binary log sizes", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThanOrEqual(1);

      // First item should be "Data"
      const dataEntry = stats.find((s) => s.name === "Data");
      expect(dataEntry).toBeDefined();
      expect(typeof dataEntry!.size).toBe("string");
      expect(typeof dataEntry!.sizeBytes).toBe("number");
      expect(dataEntry!.sizeBytes).toBe(13107200);

      // Binary Logs entry
      const binlogEntry = stats.find((s) => s.name === "Binary Logs");
      expect(binlogEntry).toBeDefined();
      expect(binlogEntry!.sizeBytes).toBe(1048576);

      // InnoDB entry
      const innodbEntry = stats.find((s) => s.name === "InnoDB");
      expect(innodbEntry).toBeDefined();
      expect(innodbEntry!.location).toContain("ibdata1");
    });
  });

  // --------------------------------------------------------------------------
  // Note: MySQLProvider does not expose a getPoolStats() method.
  // Pool stats are handled by the base provider if needed.
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // buildSSLConfig() (tested indirectly via connect)
  // --------------------------------------------------------------------------

  describe("buildSSLConfig()", () => {
    test("cloud provider auto-enables SSL", () => {
      // A cloud hostname should trigger SSL auto-enable
      provider = new MySQLProvider(
        makeMySQLConfig({
          host: "my-db.supabase.co",
        }),
      );
      // If no error during construction, SSL config was built
      expect(provider).toBeDefined();
    });

    test("explicit ssl mode disable", async () => {
      provider = new MySQLProvider(
        makeMySQLConfig({
          ssl: { mode: "disable" },
        }),
      );
      await provider.connect();
      expect(lastPoolConfig.ssl).toBeUndefined();
    });

    // D26: the mode a pasted `?ssl=true` / `?useSSL=true` lands on. mysql2 gets
    // `rejectUnauthorized: true` and no `ca`, which is what the driver does with `ssl: {}`
    // itself - so the paste is honoured instead of quietly downgraded to `require`.
    test("ssl mode verify-system verifies against the runtime trust store with no ca", async () => {
      provider = new MySQLProvider(makeMySQLConfig({ ssl: { mode: "verify-system" } }));
      await provider.connect();
      expect(lastPoolConfig.ssl).toEqual({ rejectUnauthorized: true });
    });

    test("ssl mode require encrypts without checking the chain", async () => {
      provider = new MySQLProvider(makeMySQLConfig({ ssl: { mode: "require" } }));
      await provider.connect();
      expect(lastPoolConfig.ssl).toEqual({ rejectUnauthorized: false });
    });

    test("ssl mode verify-ca carries the pasted CA alongside the chain check", async () => {
      provider = new MySQLProvider(makeMySQLConfig({ ssl: { mode: "verify-ca", caCert: "ca-pem" } }));
      await provider.connect();
      expect(lastPoolConfig.ssl).toEqual({ rejectUnauthorized: true, ca: "ca-pem" });
    });
  });

  // --------------------------------------------------------------------------
  // queryInTransaction()
  // --------------------------------------------------------------------------

  describe("queryInTransaction()", () => {
    test("executes query within active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.beginTransaction();

      const result = await provider.queryInTransaction("SELECT * FROM users");
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(typeof result.executionTime).toBe("number");

      await provider.commitTransaction();
    });

    test("throws when no active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await expect(provider.queryInTransaction("SELECT 1")).rejects.toThrow("No active transaction");
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery()
  // --------------------------------------------------------------------------

  describe("prepareQuery()", () => {
    test("SELECT gets LIMIT appended", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const result = provider.prepareQuery("SELECT * FROM users");
      expect(result.query).toContain("LIMIT");
      expect(result.wasLimited).toBe(true);
    });

    test("non-SELECT passes through unchanged", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const sql = "INSERT INTO users (name) VALUES ('test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    // `#` is MySQL's own second line-comment marker, and it is the reason
    // `lib/sql/leading-keyword.ts` skips such a run at all - on every dialect, since
    // none of them can OPEN a statement with one. Without it a `# note`-led SELECT
    // classified as an unknown statement type and reached the server with no LIMIT,
    // which is #275's reported symptom on this provider.
    test.each<[string, string]>([
      ["a hash comment", "# note\nSELECT * FROM users"],
      ["a line comment", "-- note\nSELECT * FROM users"],
      ["a block comment", "/* note */ SELECT * FROM users"],
    ])("SELECT behind %s still gets LIMIT appended", (_label, sql) => {
      provider = new MySQLProvider(makeMySQLConfig());
      const result = provider.prepareQuery(sql);

      expect(result.query).toContain("LIMIT");
      expect(result.wasLimited).toBe(true);
    });

    test("a hash comment does not make a write look like a read", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const sql = "# note\nUPDATE users SET name = 'x' WHERE id = 1";

      const result = provider.prepareQuery(sql);

      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    // ── The `#` grammar is MySQL's here (#292) ────────────────────────────
    //
    // The shared readers used to decide `#` from the characters alone, and the
    // rule they settled on was PostgreSQL's: a hash whose next character makes a
    // jsonb/geometric operator is code. On THIS provider that reading is simply
    // wrong - every `#` opens a comment - and it cost a write its typing. The
    // provider now tells the readers which dialect they are reading, so these
    // assertions go through `prepareQuery`, the real caller, and pin the emitted
    // text rather than "a bound was added".

    describe("hash comments (#292)", () => {
      test("a comment hiding a paren does not retype the DELETE it precedes", () => {
        provider = new MySQLProvider(makeMySQLConfig());
        // `#-` reads as a jsonb operator to a dialect-blind scan, so the `)` inside
        // the comment closed the CTE body early and `SELECT` answered for the whole
        // statement - a bound on a DELETE, which MySQL 8 accepts and commits.
        const sql = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });

      test("a bound written after a hash is commented out, so a real one is added before it", () => {
        provider = new MySQLProvider(makeMySQLConfig());

        const result = provider.prepareQuery("SELECT * FROM t # LIMIT 10", { limit: 50 });

        expect(result.query).toBe("SELECT * FROM t LIMIT 50 # LIMIT 10");
        expect(result.wasLimited).toBe(true);
      });

      test("a hash inside a backtick-quoted name is part of the name", () => {
        provider = new MySQLProvider(makeMySQLConfig());

        const result = provider.prepareQuery("SELECT `a#b` FROM t", { limit: 50 });

        expect(result.query).toBe("SELECT `a#b` FROM t LIMIT 50");
        expect(result.wasLimited).toBe(true);
      });
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe("error mapping", () => {
    test("ER_ACCESS_DENIED maps to auth error", async () => {
      mockExecuteFn = async () => {
        throw new Error("ER_ACCESS_DENIED: Access denied for user");
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      try {
        await provider.query("SELECT 1");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.message).toContain("Access denied");
      }
    });

    test("connection error on query throws", async () => {
      mockExecuteFn = async () => {
        throw new Error("ECONNREFUSED: Connection refused");
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      try {
        await provider.query("SELECT 1");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.message).toContain("ECONNREFUSED");
      }
    });
  });
});

// ============================================================================
// Declared column types
// ============================================================================

/**
 * Every field packet below is verbatim from a live server: `SELECT * FROM types` on
 * MySQL 26.7.0, printed straight out of mysql2. That matters because the codes are
 * shared - 252 is every text tier AND every blob tier, and only the charset (63 is
 * `binary`) and the length tell them apart.
 */
describe("MySQLProvider declared column types", () => {
  test("query() names what the field packets declare", async () => {
    mockExecuteFn = () =>
      Promise.resolve([
        [{ id: 19, price: "19.99", body: "hello", b: null }],
        [
          { name: "id", columnType: 8, characterSet: 63, columnLength: 20, decimals: 0, flags: 0 },
          { name: "price", columnType: 246, characterSet: 63, columnLength: 12, decimals: 2, flags: 0 },
          { name: "body", columnType: 252, characterSet: 224, columnLength: 262140, decimals: 0, flags: 16 },
          { name: "b", columnType: 252, characterSet: 63, columnLength: 65535, decimals: 0, flags: 144 },
        ],
      ]);

    const provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("SELECT id, price, body, b FROM types");

    // `price` was the reason for all this: a DECIMAL arrives as the string "19.99", so
    // no value-shaped guess could ever have called it anything but text.
    expect(result.columnTypes).toEqual({ id: "bigint", price: "decimal", body: "text", b: "blob" });
    await provider.disconnect();
  });

  test("the key is omitted entirely when the statement declared no columns", async () => {
    mockExecuteFn = () => Promise.resolve([[], []]);

    const provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("SELECT id FROM types WHERE 1 = 0");

    expect(result.columnTypes).toBeUndefined();
    expect(Object.hasOwn(result, "columnTypes")).toBe(false);
    await provider.disconnect();
  });

  test("queryInTransaction() declares them too", async () => {
    mockExecuteFn = () =>
      Promise.resolve([
        [{ ts: "2026-08-23 17:46:34" }],
        [{ name: "ts", columnType: 7, characterSet: 63, columnLength: 19, decimals: 0, flags: 128 }],
      ]);

    const provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    await provider.beginTransaction();
    const result = await provider.queryInTransaction("SELECT ts FROM types");

    expect(result.columnTypes).toEqual({ ts: "timestamp" });
    await provider.rollbackTransaction();
    await provider.disconnect();
  });
});

// ============================================================================
// Non-SELECT statements (the ResultSetHeader shape)
// ============================================================================
/**
 * Every DDL and DML statement threw `result.rows.map is not a function` before
 * this block existed, AFTER the server had already applied it. Measured through
 * `createDatabaseProvider({type:"mysql"})` against mysql 26.7.0 on 2026-08-23:
 * DROP/CREATE/INSERT/UPDATE/DELETE and the transaction path all failed, and a
 * following SELECT returned the row the failed INSERT had written.
 *
 * The header literals below are printed verbatim out of mysql2 3.15 against that
 * same server - including `fields` arriving as `undefined`, which is why the
 * second tuple slot is not an empty array here.
 */
function makeResultSetHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fieldCount: 0,
    affectedRows: 0,
    insertId: 0,
    info: "",
    serverStatus: 2,
    warningStatus: 0,
    changedRows: 0,
    ...overrides,
  };
}

describe("MySQLProvider non-SELECT statements", () => {
  let provider: InstanceType<typeof MySQLProvider>;

  afterEach(async () => {
    try {
      if (provider?.isConnected()) await provider.disconnect();
    } catch {
      // Ignore cleanup errors
    }
  });

  test("CREATE TABLE answers an empty result set, not a throw", async () => {
    mockExecuteFn = () => Promise.resolve([makeResultSetHeader(), undefined]);

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("CREATE TABLE t (id INT PRIMARY KEY)");

    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.columnTypes).toBeUndefined();
    expect(typeof result.executionTime).toBe("number");
  });

  test("DROP TABLE IF EXISTS on an absent table answers zero rows", async () => {
    // warningStatus 1 is what the live server returns for the absent-table note.
    mockExecuteFn = () => Promise.resolve([makeResultSetHeader({ warningStatus: 1 }), undefined]);

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("DROP TABLE IF EXISTS gone");

    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  test("INSERT reports affectedRows as the rowCount", async () => {
    mockExecuteFn = () =>
      Promise.resolve([
        makeResultSetHeader({ affectedRows: 2, insertId: 1, info: "Records: 2  Duplicates: 0  Warnings: 0" }),
        undefined,
      ]);

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("INSERT INTO t (note) VALUES ('a'),('b')");

    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(2);
  });

  test("UPDATE reports affectedRows, not changedRows", async () => {
    // The live server distinguishes them: a no-op UPDATE matches a row
    // (affectedRows 1) while changing nothing (changedRows 0). `rowCount` is
    // the matched count, which is what every other provider here reports.
    mockExecuteFn = () =>
      Promise.resolve([
        makeResultSetHeader({ affectedRows: 1, changedRows: 0, info: "Rows matched: 1  Changed: 0  Warnings: 0" }),
        undefined,
      ]);

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("UPDATE t SET note = note WHERE id = 1");

    expect(result.rowCount).toBe(1);
  });

  test("DELETE reports affectedRows as the rowCount", async () => {
    mockExecuteFn = () => Promise.resolve([makeResultSetHeader({ affectedRows: 3 }), undefined]);

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("DELETE FROM t WHERE id < 4");

    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(3);
  });

  test("queryInTransaction() answers the same envelope for a non-SELECT", async () => {
    mockExecuteFn = () => Promise.resolve([makeResultSetHeader({ affectedRows: 1, insertId: 7 }), undefined]);

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    await provider.beginTransaction();
    const result = await provider.queryInTransaction("INSERT INTO t (note) VALUES ('gamma')");

    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.rowCount).toBe(1);
    expect(result.columnTypes).toBeUndefined();
    await provider.rollbackTransaction();
  });

  test("a SELECT that returns an array is unaffected by the header branch", async () => {
    mockExecuteFn = () =>
      Promise.resolve([
        [{ id: 1 }],
        [{ name: "id", columnType: 3, characterSet: 63, columnLength: 11, decimals: 0, flags: 0 }],
      ]);

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const result = await provider.query("SELECT id FROM t");

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.rowCount).toBe(1);
    expect(result.columnTypes).toEqual({ id: "int" });
  });
});

// ============================================================================
// Wire protocol: text (`query`) vs binary prepared (`execute`)
// ============================================================================
/**
 * Three engines refuse whole statement classes on mysql2's binary prepared
 * protocol with `This command is not supported in the prepared statement protocol
 * yet`: SingleStore 9.1.1 rejects `SHOW STATUS`, `SHOW VARIABLES`, `EXPLAIN`,
 * `EXPLAIN JSON`, `OPTIMIZE TABLE` and `CHECK TABLE` there, StarRocks 3.3 loses its
 * overview to the same cause, and MySQL 26.7.0 itself rejects `CHECK TABLE` - all
 * measured 2026-08-24, both ways over one connection.
 *
 * So a statement with no parameters goes over the text protocol and a statement
 * with parameters keeps the prepared one - the placeholders are what the prepared
 * protocol is for, and nothing else changes about how a bind value reaches the
 * server.
 */
describe("MySQLProvider wire protocol", () => {
  let provider: InstanceType<typeof MySQLProvider>;

  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
    protocolCalls = [];
  });

  afterEach(async () => {
    try {
      if (provider?.isConnected()) await provider.disconnect();
    } catch {
      // Ignore cleanup errors
    }
  });

  async function connected(): Promise<InstanceType<typeof MySQLProvider>> {
    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    protocolCalls = [];
    return provider;
  }

  test("getHealth sends its parameterless reads as text and its parameterised reads as prepared", async () => {
    const p = await connected();
    await p.getHealth();

    expect(methodFor("show status")).toBe("query");
    // Every information_schema read here binds the database name.
    expect(methodFor("information_schema.tables")).toBe("execute");
    expect(methodFor("processlist")).toBe("execute");
  });

  test("getOverview sends SHOW STATUS, SHOW VARIABLES and VERSION() as text", async () => {
    const p = await connected();
    await p.getOverview();

    expect(methodFor("version()")).toBe("query");
    expect(methodFor("show status")).toBe("query");
    expect(methodFor("show variables like 'max_connections'")).toBe("query");
    expect(methodFor("information_schema.tables")).toBe("execute");
  });

  test("getPerformanceMetrics sends every read as text", async () => {
    const p = await connected();
    await p.getPerformanceMetrics();

    expect(protocolCalls.length).toBeGreaterThan(0);
    expect(protocolCalls.every((c) => c.method === "query")).toBe(true);
  });

  test("the maintenance statement is text, and the table lookup behind it stays prepared", async () => {
    const p = await connected();
    await p.runMaintenance("check");

    // The table list binds the database name; CHECK TABLE binds nothing and is the
    // statement MySQL 26.7.0 itself refuses on the prepared protocol.
    expect(methodFor("information_schema.tables")).toBe("execute");
    expect(methodFor("check table")).toBe("query");
  });

  test("OPTIMIZE TABLE goes over the text protocol", async () => {
    const p = await connected();
    await p.runMaintenance("optimize");

    expect(methodFor("optimize table")).toBe("query");
  });

  test("the maintenance KILL takes the text protocol too", async () => {
    const p = await connected();
    await p.runMaintenance("kill", "77");

    expect(methodFor("kill 77")).toBe("query");
  });

  test("getSchema keeps its parameterised reads on the prepared protocol", async () => {
    const p = await connected();
    await p.getSchema();

    expect(protocolCalls.length).toBeGreaterThan(0);
    expect(protocolCalls.every((c) => c.method === "execute")).toBe(true);
    expect(methodFor("information_schema.columns")).toBe("execute");
    expect(methodFor("key_column_usage")).toBe("execute");
    expect(methodFor("information_schema.statistics")).toBe("execute");
  });

  test("getStorageStats sends SHOW BINARY LOGS and SHOW VARIABLES as text", async () => {
    const p = await connected();
    await p.getStorageStats();

    expect(methodFor("show binary logs")).toBe("query");
    expect(methodFor("show variables like 'innodb_data_file_path'")).toBe("query");
    expect(methodFor("information_schema.tables")).toBe("execute");
  });

  test("the editor's own query path is text without parameters and prepared with them", async () => {
    const p = await connected();

    await p.query("SELECT 1");
    expect(protocolCalls).toEqual([{ method: "query", sql: "SELECT 1", params: undefined }]);

    protocolCalls = [];
    await p.query("SELECT * FROM users WHERE id = ?", [7]);
    expect(protocolCalls).toEqual([{ method: "execute", sql: "SELECT * FROM users WHERE id = ?", params: [7] }]);
  });

  test("an empty parameter array is not a parameterised statement", async () => {
    const p = await connected();
    await p.query("SELECT 1", []);

    expect(protocolCalls[0]?.method).toBe("query");
    expect(protocolCalls[0]?.params).toBeUndefined();
  });

  test("the Explain panel's statement reaches the server over the text protocol", async () => {
    const p = await connected();
    // Verbatim what mysqlJsonStrategy.buildSql() produces. MySQL takes it either way;
    // SingleStore refuses `EXPLAIN FORMAT=JSON` on both protocols (its grammar is
    // `EXPLAIN JSON`), so what this pins is the route, not a recovered panel there.
    const explainSql = mysqlJsonStrategy.buildSql("SELECT * FROM users", "estimate");
    await p.query(explainSql as string);

    expect(explainSql).toBe("EXPLAIN FORMAT=JSON SELECT * FROM users");
    expect(methodFor("explain format=json")).toBe("query");
  });

  test("the transaction path picks the protocol the same way", async () => {
    const p = await connected();
    await p.beginTransaction();

    await p.queryInTransaction("SELECT 1");
    expect(protocolCalls.at(-1)).toEqual({ method: "query", sql: "SELECT 1", params: undefined });

    await p.queryInTransaction("SELECT * FROM users WHERE id = ?", [7]);
    expect(protocolCalls.at(-1)).toEqual({
      method: "execute",
      sql: "SELECT * FROM users WHERE id = ?",
      params: [7],
    });

    await p.rollbackTransaction();
  });

  test("cancelQuery kills the running thread over the text protocol", async () => {
    let releaseStatement: () => void = () => {};
    let statementStarted: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      releaseStatement = resolve;
    });
    const started = new Promise<void>((resolve) => {
      statementStarted = resolve;
    });

    const p = await connected();
    mockExecuteFn = async (sql: string) => {
      if (sql.toLowerCase().includes("sleep")) {
        statementStarted();
        await inFlight;
      }
      return [[], []];
    };

    const running = p.query("SELECT SLEEP(5)", undefined, "q1");
    await started;
    expect(await p.cancelQuery("q1")).toBe(true);
    releaseStatement();
    await running;

    expect(methodFor("kill query 42")).toBe("query");
  });
});

// ============================================================================
// The fixture-fidelity guard itself
// ============================================================================

/**
 * `UNANSWERABLE_STATEMENTS` is a construction, and a construction nothing drives is the
 * `toBeNull()`-after-a-testid-rename shape: `mysql.ts` no longer emits any statement
 * naming `sql_text`, so no other test in this file can make the guard fire. These two
 * do it directly - one with an unfaithful fixture, one with the shared one.
 */
describe("the mysql2 fixture-fidelity guard", () => {
  const SQL_TEXT_DIGEST_READ =
    "SELECT LEFT(sql_text, 100) as query, COUNT_STAR as calls FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME = ?";

  test("an unfaithful fixture that answers the sql_text digest read is recorded as a violation", async () => {
    mockExecuteFn = () => Promise.resolve([[{ query: "SELECT * FROM users", calls: "100" }], []]);

    await mockConnection.execute(SQL_TEXT_DIGEST_READ, ["testdb"]);

    expect(fixtureViolations).toHaveLength(1);
    expect(fixtureViolations[0]).toContain("no sql_text column");
    expect(fixtureViolations[0]).toContain("ANSWERED it");
    // Drained here so the file-scope afterEach does not fail this test for the very
    // violation it exists to produce.
    fixtureViolations = [];
  });

  test("the SHARED fixture refuses that statement, so the guard has nothing to record", async () => {
    mockExecuteFn = defaultMockExecute;

    // `rejects` is doing two jobs: it pins the shared fixture's fidelity (reverting it
    // to the shape that answered a row fails here), and it proves the guard's `.then`
    // wrapper leaves a rejection a rejection rather than resolving it.
    await expect(mockConnection.execute(SQL_TEXT_DIGEST_READ, ["testdb"])).rejects.toThrow(/Unknown column 'sql_text'/);
    expect(fixtureViolations).toEqual([]);
  });
});

// ============================================================================
// The connect-time EXPLAIN grammar probe
// ============================================================================
/**
 * `EXPLAIN FORMAT=JSON` is MySQL's grammar, not the wire family's. Measured
 * 2026-09-06 through mysql2 3.24.2 over the text protocol, `EXPLAIN FORMAT=JSON
 * SELECT 1` is refused by Apache Doris 4.1.3 and TiDB 8.5.1 (errno 1105) and by
 * StarRocks 3.3.22 and SingleStore (errno 1064), while a plain `EXPLAIN SELECT 1`
 * is accepted by every one of them. The relatives share no errno for a grammar
 * refusal, so the provider probes at connect and reads success or failure only.
 *
 * The refusals below are the fixtures from those runs. A mock that resolves them
 * models a server that does not exist, which is exactly how the panel's failure
 * survived until now.
 */
function explainRefusal(
  message: string,
  errno: number,
  code: string,
  sqlState: string,
): Error & { code: string; errno: number; sqlState: string } {
  const error = new Error(message) as Error & { code: string; errno: number; sqlState: string };
  error.code = code;
  error.errno = errno;
  error.sqlState = sqlState;
  return error;
}

/** Apache Doris 4.1.3 (`apache/doris:all-in-one-4.1.3`), measured 2026-09-06. */
const dorisExplainRefusal = () =>
  explainRefusal("mismatched input '=' expecting {<EOF>, ';'}(line 1, pos 14)", 1105, "ER_UNKNOWN_ERROR", "HY000");

/** TiDB 8.5.1 (`pingcap/tidb:v8.5.1`), measured 2026-09-06. */
const tidbExplainRefusal = () =>
  explainRefusal("explain format 'json' is not supported now", 1105, "ER_UNKNOWN_ERROR", "HY000");

/** StarRocks 3.3.22 and SingleStore both answer a parse error, measured 2026-09-06. */
const parseErrorExplainRefusal = () =>
  explainRefusal("You have an error in your SQL syntax", 1064, "ER_PARSE_ERROR", "42000");

describe("MySQLProvider EXPLAIN grammar probe", () => {
  let provider: InstanceType<typeof MySQLProvider>;

  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
    protocolCalls = [];
  });

  afterEach(async () => {
    try {
      if (provider?.isConnected()) await provider.disconnect();
    } catch {
      // Ignore cleanup errors
    }
  });

  /** Every statement the probe issued, in order. */
  function explainProbeCalls(): ProtocolCall[] {
    return protocolCalls.filter((c) => c.sql.toLowerCase().startsWith("explain"));
  }

  /**
   * A server that refuses the statements named here and answers everything else
   * through the shared fixture.
   */
  function refusing(refusals: Record<string, () => Error>): (sql: string) => Promise<[unknown[], unknown[]]> {
    return (sql: string) => {
      const normalized = sql.trim().toLowerCase();
      const refusal = Object.entries(refusals).find(([statement]) => normalized === statement.toLowerCase());
      return refusal === undefined ? defaultMockExecute(sql) : Promise.reject(refusal[1]());
    };
  }

  test("before connect the provider answers the static MySQL default", () => {
    provider = new MySQLProvider(makeMySQLConfig());
    const caps = provider.getCapabilities();

    // `POST /api/db/provider-meta` never connects (#457), so this is the answer the
    // client's pre-flight sees, and it must stay what it has always been.
    expect(caps.explainFormat).toBe("mysql-json");
    expect(caps.supportsExplain).toBe(true);
    expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
    expect(explainProbeCalls()).toEqual([]);
  });

  test("a server that accepts EXPLAIN FORMAT=JSON keeps mysql-json, probed with one statement", async () => {
    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const caps = provider.getCapabilities();

    expect(caps.explainFormat).toBe("mysql-json");
    expect(caps.supportsExplain).toBe(true);
    expect(explainProbeCalls().map((c) => c.sql)).toEqual(["EXPLAIN FORMAT=JSON SELECT 1"]);
    // Parameterless, so the text protocol, like every other statement of that shape.
    expect(methodFor("explain format=json select 1")).toBe("query");
  });

  test("Doris refuses FORMAT=JSON and accepts plain EXPLAIN, so the format is mysql-text", async () => {
    mockExecuteFn = refusing({ "explain format=json select 1": dorisExplainRefusal });

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const caps = provider.getCapabilities();

    expect(caps.explainFormat).toBe("mysql-text");
    expect(caps.supportsExplain).toBe(true);
    expect(explainProbeCalls().map((c) => c.sql)).toEqual(["EXPLAIN FORMAT=JSON SELECT 1", "EXPLAIN SELECT 1"]);
    expect(explainProbeCalls().every((c) => c.method === "query")).toBe(true);
  });

  test("TiDB's own wording for the same refusal reaches the same format", async () => {
    mockExecuteFn = refusing({ "explain format=json select 1": tidbExplainRefusal });

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();

    expect(provider.getCapabilities().explainFormat).toBe("mysql-text");
  });

  test("a parse error rather than an unknown error reaches the same format", async () => {
    // StarRocks 3.3.22 and SingleStore answer errno 1064 where Doris and TiDB answer
    // 1105. The probe reads success or failure, never the code, and this pins that.
    mockExecuteFn = refusing({ "explain format=json select 1": parseErrorExplainRefusal });

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();

    expect(provider.getCapabilities().explainFormat).toBe("mysql-text");
  });

  test("a server that refuses both statements declares no explain support and no format", async () => {
    mockExecuteFn = refusing({
      "explain format=json select 1": dorisExplainRefusal,
      "explain select 1": parseErrorExplainRefusal,
    });

    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    const caps = provider.getCapabilities();

    expect(caps.supportsExplain).toBe(false);
    // Absent, not undefined-valued: `explainFormat` is present iff supportsExplain is.
    expect("explainFormat" in caps).toBe(false);
    expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
    expect(explainProbeCalls().map((c) => c.sql)).toEqual(["EXPLAIN FORMAT=JSON SELECT 1", "EXPLAIN SELECT 1"]);
  });

  test("a refused probe is not a failed connection", async () => {
    mockExecuteFn = refusing({
      "explain format=json select 1": dorisExplainRefusal,
      "explain select 1": parseErrorExplainRefusal,
    });

    provider = new MySQLProvider(makeMySQLConfig());

    // The probe is a capability measurement, not a connection check. A grammar the
    // server does not have must never cost the user the connection.
    await expect(provider.connect()).resolves.toBeUndefined();
    expect(provider.isConnected()).toBe(true);
  });

  test("a re-connect over a live pool does not probe again", async () => {
    provider = new MySQLProvider(makeMySQLConfig());
    await provider.connect();
    protocolCalls = [];

    await provider.connect();

    expect(explainProbeCalls()).toEqual([]);
    expect(provider.getCapabilities().explainFormat).toBe("mysql-json");
  });
});

// ============================================================================
// The object surface (#789)
// ----------------------------------------------------------------------------
// This provider is the one whose `objectKinds` is NOT a constant. It serves MariaDB as
// well - there is no `mariadb` type id and choosing MySQL in the dialog is the documented
// way to reach it (docs/providers/mysql.md 1.1) - and MariaDB has two kinds MySQL does not
// have at all. So the declaration is resolved from the server's own `VERSION()` string,
// never from the type id, and BOTH branches are driven below against the rows the two live
// fixtures answered.
// ============================================================================

/** MySQL 26.7.0, `mysql:latest`, measured 2026-09-11 on the fixture container. */
const MYSQL_VERSION_STRING = "26.7.0";

/** MariaDB, `mariadb:latest`, measured 2026-09-11 on the fixture container. */
const MARIADB_VERSION_STRING = "12.3.2-MariaDB-ubu2404";

/**
 * The fixture the two `docker/*-init/01-object-fixture.sql` files build, answered from the
 * mock so the contract can be driven without a server in the loop.
 *
 * Every row here is VERBATIM what the live container returned on 2026-09-11, including the
 * shapes that are easy to invent wrongly: a VIEW's `TABLE_ROWS`, `DATA_LENGTH` and
 * `INDEX_LENGTH` are all NULL, a MariaDB SEQUENCE is a row of `information_schema.TABLES`
 * with `TABLE_TYPE = 'SEQUENCE'` carrying `TABLE_ROWS` 1, and a MariaDB package is TWO rows
 * of `information_schema.ROUTINES`, `PACKAGE` and `PACKAGE BODY`.
 *
 * `mariadb: true` changes the version string and adds the two MariaDB-only row sets, and
 * nothing else. That is the whole experiment: one type id, one fixture, one difference.
 */
function objectSurfaceFixture(options: { mariadb: boolean }) {
  const tables = [
    { name: "customers", row_count: 0, size_bytes: 16384 },
    { name: "order_archive", row_count: 0, size_bytes: 16384 },
    { name: "orders", row_count: 0, size_bytes: 49152 },
    // MariaDB's fixture holds a fourth table, and it arrives through the SAME listing read
    // rather than a second one: `order_audit` is TABLE_TYPE 'SYSTEM VERSIONED', which the
    // `table` kind binds alongside 'BASE TABLE'. So the MariaDB conformance run exercises a
    // multi-spelling kind end to end instead of only in a unit assertion.
    ...(options.mariadb ? [{ name: "order_audit", row_count: 0, size_bytes: 16384 }] : []),
  ];
  const counts = options.mariadb
    ? [
        { kind: "table", n: 4 },
        { kind: "view", n: 1 },
        { kind: "sequence", n: 1 },
        { kind: "procedure", n: 2 },
        { kind: "function", n: 1 },
        { kind: "package", n: 1 },
        { kind: "trigger", n: 1 },
        { kind: "event", n: 1 },
      ]
    : [
        { kind: "table", n: 3 },
        { kind: "view", n: 1 },
        { kind: "procedure", n: 2 },
        { kind: "function", n: 1 },
        { kind: "trigger", n: 1 },
        { kind: "event", n: 1 },
      ];

  return async (sql: string, params?: unknown[]): Promise<[unknown, unknown[] | undefined]> => {
    const normalized = sql.trim().toLowerCase();
    if (normalized.includes("version()")) {
      return [[{ version: options.mariadb ? MARIADB_VERSION_STRING : MYSQL_VERSION_STRING }], []];
    }
    if (normalized.startsWith("explain")) return [[], []];
    if (normalized.includes("information_schema.schemata")) {
      return [
        [
          { name: "app", is_session_default: 1 },
          { name: "reporting", is_session_default: 0 },
        ],
        [],
      ];
    }
    // Before `information_schema.tables`, which the counting statement also names.
    if (normalized.includes("group by kind")) return [counts, []];

    // The bulk column read's four statements (#789), each of which the single-object reads
    // cannot be confused with: the target read is the only one ordered by TABLE_NAME, and
    // the three detail reads are the only ones selecting `object_name`.
    const columnsByObject: Record<string, unknown[]> = {
      customers: [
        {
          object_name: "customers",
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          column_key: "PRI",
        },
      ],
      order_archive: [
        {
          object_name: "order_archive",
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          column_key: "PRI",
        },
      ],
      orders: [
        {
          object_name: "orders",
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          column_key: "PRI",
        },
        {
          object_name: "orders",
          column_name: "total",
          data_type: "decimal",
          is_nullable: "YES",
          column_default: "0.00",
          column_key: "MUL",
        },
      ],
      order_audit: [
        {
          object_name: "order_audit",
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: null,
          column_key: "PRI",
        },
      ],
      order_summary: [
        {
          object_name: "order_summary",
          column_name: "customer",
          data_type: "varchar",
          is_nullable: "YES",
          column_default: null,
          column_key: "",
        },
      ],
      invoice_number_seq: [
        {
          object_name: "invoice_number_seq",
          column_name: "next_not_cached_value",
          data_type: "bigint",
          is_nullable: "NO",
          column_default: null,
          column_key: "",
        },
      ],
    };
    // ------------------------------------------------------------------
    // The FLAT reading (`getSchema()`), over the SAME objects this fixture publishes.
    //
    // Four statements, and each one is told apart from the object surface's by a fragment
    // only it carries, because both surfaces read the same three catalog views:
    // `SCHEMA_TABLES_SQL` is the only one with a literal `TABLE_TYPE = 'BASE TABLE'`,
    // `SCHEMA_COLUMNS_SQL` the only one with `LIMIT 100`, `SCHEMA_FOREIGN_KEYS_SQL` the
    // only `KEY_COLUMN_USAGE` read that does NOT select `REFERENCED_TABLE_SCHEMA`, and
    // `SCHEMA_INDEXES_SQL` the only index read that uses `GROUP_CONCAT`.
    //
    // The spelling is the ENGINE'S, not the one the join would find convenient. Two places
    // where those differ:
    //
    //   - the table names are BARE. `SCHEMA_TABLES_SQL` binds `TABLE_SCHEMA = ?` and
    //     projects `TABLE_NAME` alone, so the flat reading of a database qualifies nothing,
    //     while the object path is `[database, table]`. That bare-against-qualified join is
    //     the whole thing the guard is here to protect.
    //   - the foreign-key target is bare EVEN WHEN IT LEAVES THE DATABASE. This statement
    //     does not read `REFERENCED_TABLE_SCHEMA` at all, so `orders.region_id`, which
    //     references `reporting.regions`, comes back as `regions` with nothing saying where
    //     it lives. `OBJECT_FOREIGN_KEYS_SQL` reads the schema and qualifies that one; the
    //     difference between the two answers is a real property of the two statements and
    //     is asserted below rather than smoothed over here.
    //
    // The population is narrower than the object listing on both servers, again because the
    // engine says so and not because it was arranged: `TABLE_TYPE = 'BASE TABLE'` excludes
    // the view `order_summary` on both, and on MariaDB it also excludes `order_audit`, whose
    // type is 'SYSTEM VERSIONED'. So the join has to survive listed objects the flat reading
    // never names.
    const flatTables = tables.filter((table) => table.name !== "order_audit");
    if (normalized.includes("table_type = 'base table'")) {
      return [
        flatTables.map((table) => ({
          table_name: table.name,
          row_count: table.row_count,
          total_size: table.size_bytes,
        })),
        [],
      ];
    }
    if (normalized.includes("limit 100")) {
      const named = String((params ?? [])[1]);
      // The bulk read's rows carry `object_name`, which the single-object read does not
      // project. Dropping it here keeps one measured column set behind both surfaces.
      const rows = (columnsByObject[named] ?? []).map((row) => {
        const { object_name: _objectName, ...rest } = row as Record<string, unknown>;
        return rest;
      });
      return [rows, []];
    }
    if (normalized.includes("key_column_usage") && !normalized.includes("referenced_table_schema")) {
      return [
        String((params ?? [])[1]) === "orders"
          ? [
              { column_name: "customer_id", referenced_table: "customers", referenced_column: "id" },
              { column_name: "region_id", referenced_table: "regions", referenced_column: "id" },
            ]
          : [],
        [],
      ];
    }
    if (normalized.includes("group_concat")) {
      return [
        String((params ?? [])[1]) === "orders"
          ? [
              { index_name: "PRIMARY", columns: "id", is_unique: 1 },
              { index_name: "orders_total_ix", columns: "total,note", is_unique: 0 },
            ]
          : [],
        [],
      ];
    }

    const targetNames = (type: unknown, bound: number | undefined): string[] => {
      const all =
        type === "BASE TABLE"
          ? tables.map((table) => table.name)
          : type === "VIEW"
            ? ["order_summary"]
            : type === "SEQUENCE" && options.mariadb
              ? ["invoice_number_seq"]
              : [];
      return bound === undefined ? all : all.slice(0, bound);
    };
    const boundOf = (): number | undefined =>
      normalized.includes("limit ?") ? Number((params ?? [])[(params ?? []).length - 1]) : undefined;
    if (normalized.includes("order by table_name") && !normalized.includes("object_name")) {
      return [targetNames((params ?? [])[1], boundOf()).map((name) => ({ name })), []];
    }
    if (normalized.includes("object_name")) {
      // The detail reads carry the schema a second time, after the target's own binds, so
      // the bound is not the last parameter here.
      const bound = normalized.includes("limit ?") ? Number((params ?? [])[(params ?? []).length - 2]) : undefined;
      const named = targetNames((params ?? [])[1], bound);
      if (normalized.includes("information_schema.columns")) {
        return [named.flatMap((name) => columnsByObject[name] ?? []), []];
      }
      if (normalized.includes("key_column_usage")) {
        return [
          named.includes("orders")
            ? [
                {
                  object_name: "orders",
                  column_name: "customer_id",
                  referenced_schema: "app",
                  referenced_table: "customers",
                  referenced_column: "id",
                },
                {
                  object_name: "orders",
                  column_name: "region_id",
                  referenced_schema: "reporting",
                  referenced_table: "regions",
                  referenced_column: "id",
                },
              ]
            : [],
          [],
        ];
      }
      return [
        named.includes("orders")
          ? [
              { object_name: "orders", index_name: "PRIMARY", column_name: "id", non_unique: 0 },
              { object_name: "orders", index_name: "orders_total_ix", column_name: "total", non_unique: 1 },
              { object_name: "orders", index_name: "orders_total_ix", column_name: "note", non_unique: 1 },
            ]
          : [],
        [],
      ];
    }
    if (normalized.includes("information_schema.tables")) {
      const type = (params ?? [])[1];
      // Scoped to the DATABASE the read bound. `reporting` holds `regions` and nothing
      // else, which is what `docker/mysql-init/01-object-fixture.sql` creates and what
      // `orders.region_id` references. The double answered `app`'s rows for every database
      // before, and the conformance guard now resolves a flat name against every container
      // `listContainers` answered (#789), so that lie would have put three phantom objects
      // in the pool.
      if ((params ?? [])[0] === "reporting") {
        return [type === "BASE TABLE" ? [{ name: "regions", row_count: 0, size_bytes: 16384 }] : [], []];
      }
      if (type === "BASE TABLE") return [tables, []];
      if (type === "VIEW") {
        return [[{ name: "order_summary", row_count: null, size_bytes: null }], []];
      }
      if (type === "SEQUENCE" && options.mariadb) {
        return [[{ name: "invoice_number_seq", row_count: 1, size_bytes: 16384 }], []];
      }
      return [[], []];
    }
    if (normalized.includes("information_schema.routines")) {
      const type = (params ?? [])[1];
      if (type === "PROCEDURE") return [[{ name: "order_archive" }, { name: "touch_order" }], []];
      if (type === "FUNCTION") return [[{ name: "order_total" }], []];
      if (type === "PACKAGE" && options.mariadb) return [[{ name: "orders_pkg" }], []];
      return [[], []];
    }
    if (normalized.includes("information_schema.triggers")) {
      return [[{ name: "orders_stamp", parent: "orders" }], []];
    }
    if (normalized.includes("information_schema.events")) {
      return [[{ name: "orders_nightly" }], []];
    }
    if (normalized.includes("information_schema.columns")) {
      return [
        [
          { column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, column_key: "PRI" },
          {
            column_name: "total",
            data_type: "decimal",
            is_nullable: "YES",
            column_default: "0.00",
            column_key: "MUL",
          },
        ],
        [],
      ];
    }
    if (normalized.includes("key_column_usage")) {
      return [
        [
          {
            column_name: "customer_id",
            referenced_schema: "app",
            referenced_table: "customers",
            referenced_column: "id",
          },
          {
            column_name: "region_id",
            referenced_schema: "reporting",
            referenced_table: "regions",
            referenced_column: "id",
          },
        ],
        [],
      ];
    }
    if (normalized.includes("information_schema.statistics")) {
      return [
        [
          { index_name: "PRIMARY", column_name: "id", non_unique: 0 },
          { index_name: "orders_total_ix", column_name: "total", non_unique: 1 },
          { index_name: "orders_total_ix", column_name: "note", non_unique: 1 },
        ],
        [],
      ];
    }
    return [[], []];
  };
}

/** A provider connected against a fixture server of the flavour asked for. */
async function connectedTo(mariadb: boolean): Promise<InstanceType<typeof MySQLProvider>> {
  mockExecuteFn = objectSurfaceFixture({ mariadb });
  const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
  await provider.connect();
  return provider;
}

describe("object surface", () => {
  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
    protocolCalls = [];
  });

  test("declares the kinds a MySQL server has, and no index kind", async () => {
    const provider = await connectedTo(false);
    const capabilities = provider.getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((k) => k.id).sort()).toEqual(["event", "function", "procedure", "table", "trigger", "view"]);
    expect(kinds.find((k) => k.id === "table")?.role).toBe("relation");
    expect(kinds.find((k) => k.id === "table")?.acceptsRowWrites).toBe(true);
    // No `acceptsRowWrites` on a view. MySQL does update a simple updatable view and
    // refuses the rest, which is a per-OBJECT fact this per-kind declaration cannot state.
    expect(kinds.find((k) => k.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((k) => k.id === "procedure")?.role).toBe("routine");
    expect(kinds.find((k) => k.id === "function")?.role).toBe("routine");
    expect(kinds.find((k) => k.id === "trigger")?.role).toBe("attached");
    expect(kinds.find((k) => k.id === "trigger")?.attachedTo).toBe("table");
    expect(kinds.find((k) => k.id === "event")?.role).toBe("config");
    // No `index` kind: MySQL models an index as an attribute of the table it is on, so it
    // belongs in describeObject's output rather than in a folder of its own.
    expect(kinds.find((k) => k.id === "index")).toBeUndefined();
    // MySQL has neither of MariaDB's two, and a kind an engine does not have is ABSENT
    // rather than declared and counted zero.
    expect(kinds.find((k) => k.id === "package")).toBeUndefined();
    expect(kinds.find((k) => k.id === "sequence")).toBeUndefined();
    expect(capabilities.containerLevels).toEqual([{ id: "schema", label: "Database", labelPlural: "Databases" }]);
    await provider.disconnect();
  });

  test("a MariaDB server declares two more kinds, and the version string is what says so", async () => {
    // The experiment this provider exists to run. Same type id, same config, same fixture:
    // the ONLY difference is the string `VERSION()` answered, so a declaration resolved
    // from the type id could not produce two answers here.
    const mysql = await connectedTo(false);
    const mariadb = await connectedTo(true);

    const mysqlKinds = (mysql.getCapabilities().objectKinds ?? []).map((k) => k.id);
    const mariadbKinds = (mariadb.getCapabilities().objectKinds ?? []).map((k) => k.id);

    // Both are the same type id, which is the control: `DatabaseType` has no `mariadb`
    // entry, so nothing about the configuration can tell these two providers apart.
    expect([mysql.config.type, mariadb.config.type]).toEqual(["mysql", "mysql"]);
    expect(mariadbKinds).not.toEqual(mysqlKinds);
    expect(mariadbKinds.filter((id) => !mysqlKinds.includes(id)).sort()).toEqual(["package", "sequence"]);
    // Additive: MariaDB has everything MySQL has plus its own two.
    for (const id of mysqlKinds) expect(mariadbKinds).toContain(id);

    const kinds = mariadb.getCapabilities().objectKinds ?? [];
    const pkg = kinds.find((k) => k.id === "package");
    expect(pkg?.role).toBe("group");
    expect(pkg?.childKinds).toEqual(["procedure", "function"]);
    expect(kinds.find((k) => k.id === "sequence")?.role).toBe("config");
    await mysql.disconnect();
    await mariadb.disconnect();
  });

  test("an unconnected provider declares the kinds every MySQL-protocol server has", () => {
    // POST /api/db/provider-meta reads capabilities off a provider it never connects
    // (#457), so the pre-connect answer is a real surface rather than an internal state.
    // It is the MySQL set, because declaring MariaDB's two for a server that has not
    // identified itself would draw folders nothing can fill.
    const kinds = (new MySQLProvider(makeMySQLConfig()).getCapabilities().objectKinds ?? []).map((k) => k.id);

    expect(kinds.sort()).toEqual(["event", "function", "procedure", "table", "trigger", "view"]);
  });

  test("the containers are the server's user databases, with the connected one marked", async () => {
    const provider = await connectedTo(false);

    const containers = await provider.listContainers();

    expect(containers).toEqual([
      { path: ["app"], name: "app", level: 0, isSessionDefault: true },
      { path: ["reporting"], name: "reporting", level: 0, isSessionDefault: false },
    ]);
    // The statement excludes the four schemas both servers reserve, and it is bound to
    // nothing: the container list is the SERVER's databases, not the one the pool opened
    // against, which is what makes `reporting` reachable at all.
    const read = protocolCalls.find((c) => c.sql.includes("information_schema.SCHEMATA"));
    expect(read?.params).toBeUndefined();
    for (const schema of ["information_schema", "mysql", "performance_schema", "sys"]) {
      expect(read?.sql).toContain(`'${schema}'`);
    }
    await provider.disconnect();
  });

  test("nothing nests under a database", async () => {
    const provider = await connectedTo(false);

    expect(await provider.listContainers(["app"])).toEqual([]);
    await provider.disconnect();
  });

  test("satisfies the shared object surface contract on MySQL", async () => {
    const provider = await connectedTo(false);

    await assertObjectSurface(provider, {
      containers: [["app"], ["reporting"]],
      kinds: { table: 3, view: 1, procedure: 2, function: 1, trigger: 1, event: 1 },
      sampleObject: { path: ["app", "orders"], kind: "table" },
    });
    await provider.disconnect();
  });

  test("satisfies the shared object surface contract on MariaDB", async () => {
    const provider = await connectedTo(true);

    await assertObjectSurface(provider, {
      containers: [["app"], ["reporting"]],
      // Four tables, not three: the MariaDB fixture's `order_audit` is SYSTEM VERSIONED and the
      // `table` kind covers it, so this count is also the assertion that the count arms and the
      // listing binds read the same spelling list.
      kinds: { table: 4, view: 1, sequence: 1, procedure: 2, function: 1, package: 1, trigger: 1, event: 1 },
      sampleObject: { path: ["app", "orders_pkg"], kind: "package" },
    });
    await provider.disconnect();
  });
});

/**
 * The rest of the object surface: the catalog reads behind each kind, the detail rows, the
 * refusals, and the namespace measurement #789 owed. Kept out of the block above so
 * `-t "object surface"` still runs exactly the seven conformance tests.
 */
describe("MySQL object listing and detail", () => {
  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
    protocolCalls = [];
  });

  test("a table and a stored routine of ONE name are two addressable objects", async () => {
    // THE MEASUREMENT #789 owed, and the reason `assertObjectSurface` checks path
    // uniqueness WITHIN a kind and not across kinds. Measured 2026-09-11 on MySQL 26.7.0
    // and MariaDB 12.3.2, in one database:
    //
    //   CREATE TABLE app.foo (id INT PRIMARY KEY)           -> accepted
    //   CREATE PROCEDURE app.foo() SELECT 1                 -> accepted
    //   CREATE FUNCTION app.foo() RETURNS INT ... RETURN 1   -> accepted
    //   CREATE TRIGGER app.foo BEFORE INSERT ON app.foo ...  -> accepted
    //   CREATE EVENT app.foo ON SCHEDULE EVERY 1 DAY ...     -> accepted
    //   CREATE VIEW app.foo AS SELECT 1                      -> ERROR 1050 "Table 'foo' already exists"
    //
    // So a table and a routine really are in separate namespaces, and the one namespace
    // that IS shared is the table/view/sequence one. The fixture ships the pair as
    // `app.order_archive`, a table AND a procedure.
    const provider = await connectedTo(false);

    const tables = await provider.listObjects(["app"], "table");
    const procedures = await provider.listObjects(["app"], "procedure");

    const tablePath = tables.find((o) => o.name === "order_archive")?.path;
    const procedurePath = procedures.find((o) => o.name === "order_archive")?.path;
    expect(tablePath).toEqual(["app", "order_archive"]);
    // The SAME path under a different kind, which is exactly what the tree's row identity
    // (path plus kind id) is built to carry and what a cross-kind uniqueness assertion
    // would have reported as a broken provider.
    expect(procedurePath).toEqual(tablePath);
    expect([tables[0].kind, procedures[0].kind]).toEqual(["table", "procedure"]);

    // And the two describe differently, which is what the kind argument buys. A name-driven
    // describe would have handed the procedure the table's columns.
    const asTable = await provider.describeObject(["app", "order_archive"], "table");
    const asProcedure = await provider.describeObject(["app", "order_archive"], "procedure");
    expect(asTable.columns.length).toBeGreaterThan(0);
    expect(asProcedure.columns).toEqual([]);
    await provider.disconnect();
  });

  test("every catalog type has exactly one rule, which is what the live guard rests on", () => {
    // `tests/live/mysql-object-vocabulary.ts` asks a real server for its own
    // `SELECT DISTINCT TABLE_TYPE` and fails naming anything outside modelled-plus-excluded.
    // That subset assertion has two ways to be vacuous and neither is visible from the live
    // run, so both are pinned here where the suite always runs them.
    for (const catalog of ["tables", "routines"] as const) {
      const rules = CATALOG_TYPE_RULES[catalog];
      // An empty modelled list would make the CASE arms empty and the subset check accept
      // nothing; an empty exclusion map would mean the doc's named exclusions live only in prose.
      expect(rules.modelled.length).toBeGreaterThan(0);
      expect(Object.keys(rules.excluded).length).toBeGreaterThan(0);
      // A spelling in both halves is a contradiction, not belt and braces: the CASE would map
      // it to a kind while the doc says it is deliberately dropped.
      expect(rules.modelled.filter((type) => type in rules.excluded)).toEqual([]);
      // Every exclusion states a reason. A map rather than a list is what makes that possible,
      // and this is what stops somebody adding an entry with an empty string to silence the
      // live guard.
      for (const [type, reason] of Object.entries(rules.excluded)) {
        expect(reason.length, `exclusion ${type} carries no reason`).toBeGreaterThan(20);
      }
    }
    // Derived from MYSQL_OBJECT_TYPES rather than typed twice, so the multi-spelling kind is
    // visible here too.
    expect([...CATALOG_TYPE_RULES.tables.modelled].sort()).toEqual([
      "BASE TABLE",
      "SEQUENCE",
      "SYSTEM VERSIONED",
      "VIEW",
    ]);
    expect([...CATALOG_TYPE_RULES.routines.modelled].sort()).toEqual(["FUNCTION", "PACKAGE", "PROCEDURE"]);
    expect(Object.keys(CATALOG_TYPE_RULES.tables.excluded).sort()).toEqual(["SYSTEM VIEW", "TEMPORARY"]);
    expect(Object.keys(CATALOG_TYPE_RULES.routines.excluded)).toEqual(["PACKAGE BODY"]);
  });

  test("a container path that is not one database is refused, rather than read as empty", async () => {
    const provider = await connectedTo(false);

    // Not [] and not a zero count: mysql2 rejects an `undefined` bind outright, so the
    // alternative is a driver error naming neither the path nor the method.
    //
    // The expected depth and the segment names in the message are both derived from the
    // declaration through `containerDepth()`, never from a hardcoded 1, so the message names
    // the level MySQL declares and a two-level engine copying this file gets its own.
    await expect(provider.countObjects([])).rejects.toThrow(/container path is \[database\], received \[\]/);
    await expect(provider.listObjects(["catalog", "app"], "table")).rejects.toThrow(
      /container path is \[database\], received \["catalog","app"\]/,
    );
    await provider.disconnect();
  });

  test("a kind this server does not declare is refused, not answered empty", async () => {
    // MariaDB's two are the live case: this provider carries a listing statement for
    // `package` and `sequence` whatever server is connected, so a MySQL server has to
    // refuse them from the DECLARATION rather than from the absence of a statement.
    const provider = await connectedTo(false);

    for (const kind of ["package", "sequence", "index"]) {
      await expect(provider.listObjects(["app"], kind)).rejects.toThrow(
        new RegExp(`declares no object kind "${kind}"`),
      );
      await expect(provider.describeObject(["app", "x"], kind)).rejects.toThrow(
        new RegExp(`declares no object kind "${kind}"`),
      );
    }
    await provider.disconnect();
  });

  test("the same two kinds ARE listable once the server says it is MariaDB", async () => {
    // The control for the negatives above. Without it, "refused" could mean the statements
    // do not work rather than that the declaration refused them.
    const provider = await connectedTo(true);

    expect(await provider.listObjects(["app"], "package")).toEqual([
      { path: ["app", "orders_pkg"], name: "orders_pkg", kind: "package", rowCount: undefined, sizeBytes: undefined },
    ]);
    expect(await provider.listObjects(["app"], "sequence")).toEqual([
      {
        path: ["app", "invoice_number_seq"],
        name: "invoice_number_seq",
        kind: "sequence",
        rowCount: 1,
        sizeBytes: 16384,
      },
    ]);
    await provider.disconnect();
  });

  test("every declared kind binds its own catalog spelling, derived from the declaration", async () => {
    // Derived rather than pinned to a list: a kind added to `objectKinds` without an entry
    // in the vocabulary table fails here instead of drawing a folder nothing can fill.
    const provider = await connectedTo(true);
    const bound = new Map<string, { sql: string; params: unknown[] }>();

    const declared = (provider.getCapabilities().objectKinds ?? []).map((k) => k.id);
    expect(declared.length).toBeGreaterThan(0);
    for (const kind of declared) {
      mockExecuteFn = async (sql: string, params?: unknown[]) => {
        bound.set(kind, { sql, params: params ?? [] });
        return [[], []];
      };
      await provider.listObjects(["app"], kind);
    }

    // `table` binds TWO spellings, because MariaDB reports a system-versioned table under a
    // TABLE_TYPE of its own and it is still a table. The placeholder count is sized from the
    // same vocabulary table, so the statement and the binds cannot disagree.
    expect(bound.get("table")?.params).toEqual(["app", "BASE TABLE", "SYSTEM VERSIONED"]);
    expect(bound.get("table")?.sql).toContain("TABLE_TYPE IN (?, ?)");
    expect(bound.get("view")?.params).toEqual(["app", "VIEW"]);
    expect(bound.get("view")?.sql).toContain("TABLE_TYPE IN (?)");
    expect(bound.get("sequence")?.params).toEqual(["app", "SEQUENCE"]);
    expect(bound.get("procedure")?.params).toEqual(["app", "PROCEDURE"]);
    expect(bound.get("function")?.params).toEqual(["app", "FUNCTION"]);
    expect(bound.get("package")?.params).toEqual(["app", "PACKAGE"]);
    // The trigger and event views are keyed by database alone and have no type to bind.
    expect(bound.get("trigger")?.params).toEqual(["app"]);
    expect(bound.get("trigger")?.sql).toContain("information_schema.TRIGGERS");
    expect(bound.get("event")?.params).toEqual(["app"]);
    expect(bound.get("event")?.sql).toContain("information_schema.EVENTS");
    expect(bound.size).toBe(declared.length);
    await provider.disconnect();
  });

  test("counting is one statement that reads no column of any table", async () => {
    const statements: string[] = [];
    mockExecuteFn = async (sql: string) => {
      statements.push(sql);
      if (sql.toLowerCase().includes("version()")) return [[{ version: MYSQL_VERSION_STRING }], []];
      if (sql.toLowerCase().startsWith("explain")) return [[], []];
      return [[{ kind: "table", n: 43512 }], []];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();
    statements.length = 0;

    const counts = await provider.countObjects(["app"]);

    // One round trip for the whole folder row, and none of the four schema reads
    // `getSchema()` issues per table.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("GROUP BY kind");
    expect(statements[0]).not.toContain("information_schema.COLUMNS");
    expect(statements[0]).not.toContain("information_schema.STATISTICS");
    expect(counts.table).toEqual({ count: 43512 });
    // Seeded before the read: a declared kind the GROUP BY did not answer for holds none,
    // which is a different fact from a kind the server does not have.
    expect(counts.view).toEqual({ count: 0 });
    expect(counts.event).toEqual({ count: 0 });
    await provider.disconnect();
  });

  test("the counting statement has one CASE arm per catalog spelling and drops what it cannot name", async () => {
    let counted = "";
    mockExecuteFn = async (sql: string) => {
      if (sql.includes("GROUP BY kind")) counted = sql;
      if (sql.toLowerCase().includes("version()")) return [[{ version: MARIADB_VERSION_STRING }], []];
      return [[], []];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();
    await provider.countObjects(["app"]);

    // PACKAGE BODY is a second ROUTINES row for one node, exactly as on Oracle, so counting
    // it would double the Packages badge. SYSTEM VIEW is what information_schema's own
    // tables are. Both fall out of `kind IS NOT NULL` rather than being filtered by name.
    expect(counted).not.toContain("PACKAGE BODY");
    expect(counted).not.toContain("SYSTEM VIEW");
    expect(counted).toContain("WHERE kind IS NOT NULL");
    // The four views the four arms read, so "one statement" is a measurement rather than a
    // claim about a statement that only reads one of them.
    for (const view of [
      "information_schema.TABLES",
      "information_schema.ROUTINES",
      "information_schema.TRIGGERS",
      "information_schema.EVENTS",
    ]) {
      expect(counted).toContain(view);
    }
    // Derived, never pinned to a magnitude: the arms are built from the same vocabulary
    // table the listings bind from, so this counts them rather than asserting a number.
    const spellings = [
      "BASE TABLE",
      // MariaDB's own, and it maps to `table` rather than to a kind of its own.
      "SYSTEM VERSIONED",
      "VIEW",
      "SEQUENCE",
      "PROCEDURE",
      "FUNCTION",
      "PACKAGE",
    ];
    for (const spelling of spellings) expect(counted).toContain(`WHEN '${spelling}' THEN`);
    expect(counted.match(/WHEN '[A-Z ]+' THEN/g) ?? []).toHaveLength(spellings.length);
    // TEMPORARY is the third deliberate exclusion and the one with a reason the other two do
    // not have: measured on MariaDB 12.3.2, a temporary table is listed by the session that
    // created it and by no other, and this provider hands out a different pooled connection
    // per call. SYSTEM VERSIONED above is the control that makes this negative mean
    // something: both are MariaDB-only TABLE_TYPEs and only one of them is excluded.
    expect(counted).not.toContain("TEMPORARY");
    await provider.disconnect();
  });

  test("a MariaDB system-versioned table is a table, in the count and in the listing", async () => {
    // The defect this closes was an ABSENCE that passed every gate. The vocabulary was first
    // derived from `SELECT DISTINCT TABLE_TYPE` over the fixture, which enumerates the
    // fixture; `SYSTEM VERSIONED` was therefore in no CASE arm and in no bind, so such a
    // table fell out of BOTH the count and the listing. The two still agreed, so ruling 5f
    // held, and the table was simply invisible in the tree.
    //
    // Measured 2026-09-11 on MariaDB 12.3.2, `CREATE TABLE t (..., PERIOD FOR
    // SYSTEM_TIME(s, e)) WITH SYSTEM VERSIONING` answers TABLE_TYPE 'SYSTEM VERSIONED'.
    // MySQL 26.7.0 has no such type, and a PARTITIONED table is 'BASE TABLE' on both.
    let counted = "";
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if (sql.toLowerCase().includes("version()")) return [[{ version: MARIADB_VERSION_STRING }], []];
      if (sql.includes("GROUP BY kind")) {
        counted = sql;
        // What the one counting statement answers when the CASE has an arm for the type.
        return [[{ kind: "table", n: 2 }], []];
      }
      // The listing binds every spelling the kind has, so a server holding one of each
      // answers both rows through one read.
      if ((params ?? []).includes("SYSTEM VERSIONED")) {
        return [
          [
            { name: "orders", row_count: 0, size_bytes: 16384 },
            { name: "orders_history", row_count: 0, size_bytes: 16384 },
          ],
          [],
        ];
      }
      return [[], []];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();

    expect((await provider.countObjects(["app"])).table).toEqual({ count: 2 });
    expect(counted).toContain("WHEN 'SYSTEM VERSIONED' THEN 'table'");
    expect((await provider.listObjects(["app"], "table")).map((o) => o.path)).toEqual([
      ["app", "orders"],
      ["app", "orders_history"],
    ]);
    // Not a kind of its own: system versioning is a property of a table you still select
    // from, and a folder for it would split one concept across two.
    expect((provider.getCapabilities().objectKinds ?? []).map((k) => k.id)).not.toContain("system_versioned");
    await provider.disconnect();
  });

  test("a catalog row for an undeclared kind draws no folder", async () => {
    // A live case, not a defensive one: the counting statement is the same text on both
    // servers, so a MariaDB whose version probe came back empty answers `sequence` and
    // `package` rows against a MySQL declaration. The DECLARATION decides which folders
    // exist and a catalog row cannot add one.
    mockExecuteFn = async (sql: string) => {
      if (sql.toLowerCase().includes("version()")) return [[{ version: MYSQL_VERSION_STRING }], []];
      if (sql.toLowerCase().startsWith("explain")) return [[], []];
      return [
        [
          { kind: "table", n: 3 },
          { kind: "sequence", n: 7 },
          { kind: "package", n: 2 },
        ],
        [],
      ];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();

    const counts = await provider.countObjects(["app"]);

    expect(counts.table).toEqual({ count: 3 });
    expect("sequence" in counts).toBe(false);
    expect("package" in counts).toBe(false);
    expect(Object.keys(counts).sort()).toEqual(["event", "function", "procedure", "table", "trigger", "view"]);
    await provider.disconnect();
  });

  test("a refused count is reported as unavailable, never as zero", async () => {
    const provider = await connectedTo(false);
    mockExecuteFn = async () => {
      throw Object.assign(new Error("SELECT command denied to user 'app'@'%' for table 'orders'"), {
        code: "ER_TABLEACCESS_DENIED_ERROR",
        errno: 1142,
      });
    };

    const counts = await provider.countObjects(["app"]);
    for (const kind of provider.getCapabilities().objectKinds ?? []) {
      // The server's own sentence, unmapped and unprefixed.
      expect(counts[kind.id]).toEqual({
        unavailable: "SELECT command denied to user 'app'@'%' for table 'orders'",
      });
    }
    await provider.disconnect();
  });

  test("a trigger nests under the table it fires on, and a parentless row falls back to the database", async () => {
    mockExecuteFn = async (sql: string) => {
      if (sql.toLowerCase().includes("version()")) return [[{ version: MYSQL_VERSION_STRING }], []];
      if (!sql.includes("information_schema.TRIGGERS")) return [[], []];
      return [
        [
          { name: "orders_stamp", parent: "orders" },
          { name: "customers_stamp", parent: "customers" },
          // Defensive rather than measured: information_schema.TRIGGERS has no row without a
          // base table on either server. It collapses to the container-level address, which
          // is a COMPLETE address here because a trigger name is unique per database
          // (measured, ER_TRG_ALREADY_EXISTS on a second CREATE against another table).
          { name: "orphan_stamp", parent: null },
          // The MIXED-DEPTH pair, and the reason the sort compares segments rather than
          // `JSON.stringify(path)`. This row's address is ["app","orders"], two segments, and
          // `orders_stamp`'s is ["app","orders","orders_stamp"], three. A stringified sort
          // puts the DEEPER one first, because the separator `,` is below the terminator `]`,
          // which would render a trigger above the row it hangs off. A trigger really can
          // share its table's name: measured, CREATE TRIGGER app.foo ON app.foo is accepted.
          { name: "orders", parent: null },
        ],
        [],
      ];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();

    // Sorted by PATH, so a table's triggers group under that table rather than by name, and
    // a shorter path that is a prefix of a longer one comes FIRST.
    expect((await provider.listObjects(["app"], "trigger")).map((o) => o.path)).toEqual([
      ["app", "customers", "customers_stamp"],
      ["app", "orders"],
      ["app", "orders", "orders_stamp"],
      ["app", "orphan_stamp"],
    ]);
    // Both depths describe, which is what the two accepted path shapes are for.
    expect((await provider.describeObject(["app", "orders", "orders_stamp"], "trigger")).columns).toEqual([]);
    expect((await provider.describeObject(["app", "orphan_stamp"], "trigger")).columns).toEqual([]);
    await provider.disconnect();
  });

  test("a view carries neither a row count nor a size, while a table carries both", async () => {
    // Measured: information_schema.TABLES answers NULL in TABLE_ROWS, DATA_LENGTH and
    // INDEX_LENGTH for a VIEW. Reporting 0 and 0 would be a measurement nobody took.
    const provider = await connectedTo(false);

    const [view] = await provider.listObjects(["app"], "view");
    expect(view).toEqual({
      path: ["app", "order_summary"],
      name: "order_summary",
      kind: "view",
      rowCount: undefined,
      sizeBytes: undefined,
    });
    const orders = (await provider.listObjects(["app"], "table")).find((o) => o.name === "orders");
    expect(orders?.rowCount).toBe(0);
    expect(orders?.sizeBytes).toBe(49152);
    await provider.disconnect();
  });

  test("a listing is sorted by path and not by the order the catalog answered", async () => {
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      if (sql.toLowerCase().includes("version()")) return [[{ version: MYSQL_VERSION_STRING }], []];
      if ((params ?? [])[1] !== "BASE TABLE") return [[], []];
      return [[{ name: "zeta" }, { name: "alpha" }, { name: "mid" }], []];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();

    expect((await provider.listObjects(["app"], "table")).map((o) => o.name)).toEqual(["alpha", "mid", "zeta"]);
    await provider.disconnect();
  });

  test("a listing refusal is raised, mapped, quoting the statement the server received", async () => {
    const provider = await connectedTo(false);
    mockExecuteFn = async (sql: string) => {
      if (!sql.includes("information_schema.EVENTS")) return [[], []];
      throw Object.assign(new Error("SELECT command denied to user 'app'@'%' for table 'events'"), {
        code: "ER_TABLEACCESS_DENIED_ERROR",
        errno: 1142,
      });
    };

    const failure = await provider.listObjects(["app"], "event").catch((error: unknown) => error);
    expect((failure as Error).message).toContain("SELECT command denied");
    expect((failure as { query?: string }).query).toContain("information_schema.EVENTS");
    await provider.disconnect();
  });

  test("a table's detail carries its columns, primary key, foreign keys and indexes", async () => {
    const provider = await connectedTo(false);
    const bound: unknown[][] = [];
    const base = objectSurfaceFixture({ mariadb: false });
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      bound.push(params ?? []);
      return base(sql, params);
    };

    const detail = await provider.describeObject(["app", "orders"], "table");

    expect(detail.path).toEqual(["app", "orders"]);
    expect(detail.columns).toEqual([
      { name: "id", type: "int", nullable: false, isPrimary: true, defaultValue: undefined },
      { name: "total", type: "decimal", nullable: true, isPrimary: false, defaultValue: "0.00" },
    ]);
    // One entry per index with its columns in SEQ_IN_INDEX order, and NON_UNIQUE negated:
    // 0 is a unique index. GROUP_CONCAT is deliberately not used - group_concat_max_len is
    // 1024 by default on both servers and truncates silently.
    expect(detail.indexes).toEqual([
      { name: "PRIMARY", columns: ["id"], unique: true },
      { name: "orders_total_ix", columns: ["total", "note"], unique: false },
    ]);
    // Bare within the container, qualified outside it: a bare cross-database name addresses
    // a table in the wrong database, and InnoDB does accept a foreign key into another one.
    expect(detail.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      { columnName: "region_id", referencedTable: "reporting.regions", referencedColumn: "id" },
    ]);
    // Three reads, each narrowed to ONE database and ONE object.
    expect(bound).toHaveLength(3);
    for (const params of bound) expect(params).toEqual(["app", "orders"]);
    await provider.disconnect();
  });

  test("the flat reading names the same objects bare, and spells a cross-database key bare too", async () => {
    // The other half of the join `assertObjectSurface` protects, pinned here rather than
    // left to the guard: the guard proves the two readings CAN be joined, and this proves
    // the flat side is spelled the way the engine spells it (#789).
    const provider = await connectedTo(false);

    const flat = await provider.getSchema();

    // BARE, every one of them. `SCHEMA_TABLES_SQL` binds `TABLE_SCHEMA = ?` and projects
    // `TABLE_NAME` alone, so the flat reading of a database qualifies nothing, while
    // `listObjects` answers `["app", "orders"]`.
    expect(flat.map((table) => table.name)).toEqual(["customers", "order_archive", "orders"]);
    // Narrower than the object listing, because `TABLE_TYPE = 'BASE TABLE'` excludes the
    // view `order_summary` that the `view` folder lists. The join has to survive that.
    expect(flat.map((table) => table.name)).not.toContain("order_summary");
    const orders = flat.find((table) => table.name === "orders")!;
    expect(orders.columns.map((column) => column.name)).toEqual(["id", "total"]);
    // Per TABLE, not one column set for the whole database: `customers` has one column and
    // no foreign key, and reading the same two answers for every table would be a double
    // that agrees with itself rather than with the fixture.
    const customers = flat.find((table) => table.name === "customers")!;
    expect(customers.columns.map((column) => column.name)).toEqual(["id"]);
    expect(customers.foreignKeys).toEqual([]);
    expect(customers.indexes).toEqual([]);
    expect(orders.indexes).toEqual([
      { name: "PRIMARY", columns: ["id"], unique: true },
      { name: "orders_total_ix", columns: ["total", "note"], unique: false },
    ]);
    // The difference between the two surfaces, and it is the statements' own:
    // `SCHEMA_FOREIGN_KEYS_SQL` never reads `REFERENCED_TABLE_SCHEMA`, so the key into
    // `reporting.regions` comes back as `regions` here while `describeObject` qualifies it.
    expect(orders.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      { columnName: "region_id", referencedTable: "regions", referencedColumn: "id" },
    ]);
    await provider.disconnect();
  });

  test("a MariaDB SYSTEM VERSIONED table is listed as a table and absent from the flat reading", async () => {
    // Not an arrangement: `SCHEMA_TABLES_SQL` binds `TABLE_TYPE = 'BASE TABLE'` and
    // `order_audit` is 'SYSTEM VERSIONED', so the flat reading loses an object the `table`
    // folder holds. Pinned because it is the shape the join must tolerate.
    const provider = await connectedTo(true);

    const listed = await provider.listObjects(["app"], "table");
    const flat = await provider.getSchema();

    expect(listed.map((object) => object.path[object.path.length - 1])).toContain("order_audit");
    // The control: without it an EMPTY flat reading would satisfy the absence below.
    expect(flat.map((table) => table.name)).toEqual(["customers", "order_archive", "orders"]);
    expect(flat.map((table) => table.name)).not.toContain("order_audit");
    await provider.disconnect();
  });

  test("the column read carries no LIMIT, because a cap cannot be told from a count", async () => {
    const provider = await connectedTo(false);
    const columnReads: string[] = [];
    mockExecuteFn = async (sql: string) => {
      if (sql.includes("information_schema.COLUMNS")) columnReads.push(sql);
      // One table, so getSchema() reaches its own column read below.
      if (sql.includes("information_schema.TABLES")) return [[{ table_name: "orders" }], []];
      return [[], []];
    };

    await provider.describeObject(["app", "orders"], "table");
    // THE CONTROL, and the reason this test is not vacuous: `getSchema()` reads the same
    // view for the same purpose and its statement DOES cap, at 100 columns. Without this
    // half, "no LIMIT" would pass for a statement that never ran at all.
    await provider.getSchema();

    expect(columnReads).toHaveLength(2);
    expect(columnReads[0]).toContain("information_schema.COLUMNS");
    expect(columnReads[0].toUpperCase()).not.toContain("LIMIT");
    expect(columnReads[1]).toContain("LIMIT 100");
    await provider.disconnect();
  });

  test("a kind with no table behind it describes as three empty lists, without asking the server", async () => {
    // Not an optimisation and not a name test. The three reads key the last path segment
    // against TABLE_NAME, and on MySQL a table and a procedure CAN share a name, so a
    // name-driven describe would hand the procedure the table's columns. The KIND settles it.
    const provider = await connectedTo(true);
    let asked = 0;
    mockExecuteFn = async () => {
      asked += 1;
      return [[], []];
    };

    for (const [path, kind] of [
      [["app", "touch_order"], "procedure"],
      [["app", "order_total"], "function"],
      [["app", "orders_nightly"], "event"],
      [["app", "orders_pkg"], "package"],
      [["app", "orders", "orders_stamp"], "trigger"],
    ] as [string[], string][]) {
      expect(await provider.describeObject(path, kind)).toEqual({
        path,
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
    }
    expect(asked).toBe(0);
    await provider.disconnect();
  });

  test("a MariaDB sequence DOES describe, because the column dictionary answers for it", async () => {
    // Measured on 12.3.2: information_schema.COLUMNS answers eight real columns for a
    // sequence, because a sequence is a table underneath. Keying the detail read on the
    // CATALOG rather than on role === "relation" is what makes that come out right - a
    // sequence is `config`, since nobody selects rows from it.
    const provider = await connectedTo(true);
    mockExecuteFn = async (sql: string) => {
      if (!sql.includes("information_schema.COLUMNS")) return [[], []];
      return [
        [
          {
            column_name: "next_not_cached_value",
            data_type: "bigint",
            is_nullable: "NO",
            column_default: null,
            column_key: "",
          },
        ],
        [],
      ];
    };

    const detail = await provider.describeObject(["app", "invoice_number_seq"], "sequence");
    expect(detail.columns).toEqual([
      { name: "next_not_cached_value", type: "bigint", nullable: false, isPrimary: false, defaultValue: undefined },
    ]);
    await provider.disconnect();
  });

  test("an object path that is not [database, name] is refused", async () => {
    const provider = await connectedTo(false);

    await expect(provider.describeObject(["app"], "table")).rejects.toThrow(/"table" path is \[database, name\]/);
    await expect(provider.describeObject(["a", "b", "c"], "table")).rejects.toThrow(
      /"table" path is \[database, name\]/,
    );
    // An attached kind takes either depth, and only those two.
    await expect(provider.describeObject(["a", "b", "c", "d"], "trigger")).rejects.toThrow(
      /"trigger" path is \[database, table, name\] or \[database, name\]/,
    );
    await expect(provider.describeObject(["a"], "trigger")).rejects.toThrow(
      /"trigger" path is \[database, table, name\] or \[database, name\]/,
    );
    await provider.disconnect();
  });

  test("a kind that is declared but has no listing statement says so, not that it is undeclared", async () => {
    // Two questions, and only the declaration answers the first. Deciding "declared" from
    // whether a statement exists would report "declares no object kind" about a kind
    // `objectKinds` does declare, and this provider is the one where the two lists really
    // can differ: `MYSQL_OBJECT_TYPES` carries MariaDB's entries on a MySQL server.
    const provider = await connectedTo(false);
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [...(real.objectKinds ?? []), { id: "tablespace", role: "config", label: "T", labelPlural: "Ts" }],
    });

    await expect(provider.listObjects(["app"], "tablespace")).rejects.toThrow(
      /declares the kind "tablespace" but has no statement that lists it/,
    );
    await provider.disconnect();
  });

  test("a catalog row whose kind names a prototype member draws no folder either", async () => {
    // `Object.hasOwn` and not `in`, which is what makes the declared-kind guard ABSOLUTE
    // rather than nearly so. `"toString" in counts` is true on any object literal, so the
    // `in` spelling would write a folder for a kind the provider never declared, out of a
    // catalog row nobody can see. The row below is hostile rather than realistic, and that is
    // the point: the guard's docblock claims the declaration decides, with no exceptions.
    mockExecuteFn = async (sql: string) => {
      if (sql.toLowerCase().includes("version()")) return [[{ version: MYSQL_VERSION_STRING }], []];
      if (sql.toLowerCase().startsWith("explain")) return [[], []];
      return [
        [
          { kind: "table", n: 3 },
          { kind: "toString", n: 9 },
          { kind: "constructor", n: 9 },
          { kind: "__proto__", n: 9 },
        ],
        [],
      ];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();

    const counts = await provider.countObjects(["app"]);

    // The control, so this is not a test of an empty read: the declared kind DID take its
    // count from the same rows.
    expect(counts.table).toEqual({ count: 3 });
    expect(Object.keys(counts).sort()).toEqual(["event", "function", "procedure", "table", "trigger", "view"]);
    await provider.disconnect();
  });

  test("the container depth and the name bind are DERIVED, which a two-level declaration shows", async () => {
    // Standing ruling 5g: `container.length !== 1` and `binds = [path[0], path[1]]` are
    // behaviour-identical to the derived forms on a one-level engine, which is exactly why
    // both shipped. Rather than defer the whole pair to the first two-level provider, this
    // test hands THIS provider a two-level declaration and asks the same two questions. The
    // declaration is synthetic for MySQL; the derivation under test is the shared one that
    // thirteen providers copy.
    const provider = await connectedTo(false);
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });

    // The depth comes from `containerDepth()`, so a one-segment path is now WRONG and the
    // message names both declared levels. A hardcoded `!== 1` would accept it.
    await expect(provider.countObjects(["app"])).rejects.toThrow(
      /container path is \[catalog, database\], received \["app"\]/,
    );
    await expect(provider.listObjects(["app", "x", "y"], "table")).rejects.toThrow(
      /container path is \[catalog, database\], received \["app","x","y"\]/,
    );

    // AND THE BINDS, which is the half a refusal-only test cannot see. Neither is positional:
    // at this depth `path[0]` is the CATALOG and `path[1]` is the schema, so binding `path[0]`
    // as the schema narrows all three detail reads to a database that does not exist, and
    // binding `path[1]` as the name asks for an object called `app`. Both literals are
    // depth-identical on MySQL's real one-level declaration, which is why they survived two
    // providers and a review round: every test written for them stopped at the refusal.
    const bound: unknown[][] = [];
    mockExecuteFn = async (sql: string, params?: unknown[]) => {
      bound.push(params ?? []);
      if (!sql.includes("KEY_COLUMN_USAGE")) return [[], []];
      return [
        [
          // Same schema as the object, so the reference is spelled bare.
          {
            column_name: "customer_id",
            referenced_schema: "app",
            referenced_table: "customers",
            referenced_column: "id",
          },
          // Another schema, so it is qualified. The comparison is against the SCHEMA segment,
          // and reading `path[0]` there would compare against the catalog and qualify both.
          {
            column_name: "region_id",
            referenced_schema: "reporting",
            referenced_table: "regions",
            referenced_column: "id",
          },
        ],
        [],
      ];
    };
    const detail = await provider.describeObject(["cat", "app", "orders"], "table");

    // Three reads ACTUALLY ISSUED, which is what stops the per-bind assertion below from
    // being a loop over an empty array.
    expect(bound).toHaveLength(3);
    for (const params of bound) expect(params).toEqual(["app", "orders"]);
    expect(detail.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      { columnName: "region_id", referencedTable: "reporting.regions", referencedColumn: "id" },
    ]);
    await provider.disconnect();
  });

  test("a declaration with no schema level is refused rather than bound to nothing", async () => {
    // The other half of `containerSegment`'s guard. A path long enough for the declared depth
    // still has no schema segment when the declaration carries no `schema` level, and
    // `undefined` must not reach mysql2, which rejects it as a bind with a message naming
    // neither the path nor the method.
    const provider = await connectedTo(false);
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [{ id: "catalog", label: "Catalog", labelPlural: "Catalogs" }],
    });

    await expect(provider.countObjects(["cat"])).rejects.toThrow(
      /needs a "schema" container level and a segment for it; the declaration is \[catalog\]/,
    );
    await expect(provider.describeObject(["cat", "orders"], "table")).rejects.toThrow(
      /needs a "schema" container level and a segment for it/,
    );
    await provider.disconnect();
  });

  test("a server that will not answer VERSION() still connects, and declares the MySQL kinds", async () => {
    // The probe is a capability measurement, not a connection check, exactly like the
    // EXPLAIN grammar probe beside it. The cost of an unmeasured flavour is two folders a
    // MariaDB user does not get, never the connection.
    mockExecuteFn = async (sql: string) => {
      if (sql.toLowerCase().includes("version()")) {
        throw Object.assign(new Error("SELECT command denied"), { errno: 1142 });
      }
      return [[], []];
    };
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));

    await expect(provider.connect()).resolves.toBeUndefined();
    expect(provider.isConnected()).toBe(true);
    expect((provider.getCapabilities().objectKinds ?? []).map((k) => k.id).sort()).toEqual([
      "event",
      "function",
      "procedure",
      "table",
      "trigger",
      "view",
    ]);
    await provider.disconnect();
  });

  test("a server that answers no row for VERSION() declares the MySQL kinds too", async () => {
    // StarRocks 3.3.22 and Doris 4.1.3 answer 0 rows to SHOW STATUS, so an empty result set
    // from a probe is a shape this family really produces.
    mockExecuteFn = async () => [[], []];
    const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
    await provider.connect();

    expect((provider.getCapabilities().objectKinds ?? []).map((k) => k.id)).not.toContain("package");
    await provider.disconnect();
  });

  test("a version string that names another vendor does not get MariaDB's kinds", async () => {
    // The narrow control on the regex. TiDB, Vitess and OceanBase all self-identify in
    // VERSION() and none of them has a package or a sequence, so a test keyed on "did the
    // server name a vendor at all" would pass for all three and be wrong for all three.
    for (const version of ["8.0.11-TiDB-v8.5.1", "8.0.43-Vitess", "5.7.25-OceanBase_CE-v4.4.2.1", "26.7.0"]) {
      mockExecuteFn = async (sql: string) => {
        if (sql.toLowerCase().includes("version()")) return [[{ version }], []];
        return [[], []];
      };
      const provider = new MySQLProvider(makeMySQLConfig({ database: "app" }));
      await provider.connect();

      const ids = (provider.getCapabilities().objectKinds ?? []).map((k) => k.id);
      expect(ids).not.toContain("package");
      expect(ids).not.toContain("sequence");
      await provider.disconnect();
    }
  });
});

/**
 * The fifth provider method (#789): every object of one kind in one database described in
 * FOUR round trips rather than three per object.
 *
 * This mock dispatches on the statement the provider built, which standing ruling 5b names
 * as a blind spot: a rewrite it cannot see stays green here. So the two catalog decisions a
 * rewrite would silently undo are pinned by statement TEXT below - the membership of the
 * answer comes from `information_schema.TABLES` and never from the column read, and no read
 * here carries a column cap - and both are measured live in the task report.
 */
describe("MySQL bulk column read", () => {
  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
    protocolCalls = [];
  });

  test("describes every table of one database in four round trips, keyed by path", async () => {
    const provider = await connectedTo(false);
    protocolCalls = [];

    const batch = await provider.describeObjects(["app"], "table");

    // FOUR statements for the whole folder, whatever the folder holds. A loop over
    // describeObject is three per object, which is the N+1 the inventory route refused once.
    expect(protocolCalls).toHaveLength(4);
    // The membership of the answer is the TABLES read and never the column read. Measured on
    // MySQL 26.7.0: a view whose base table was dropped keeps its information_schema.TABLES
    // row and has NO information_schema.COLUMNS row at all, so a target taken from the
    // column read would drop an object the listing shows.
    expect(protocolCalls[0].sql).toContain("information_schema.TABLES");
    expect(protocolCalls[0].sql).toContain("ORDER BY TABLE_NAME");
    expect(protocolCalls[0].params).toEqual(["app", "BASE TABLE", "SYSTEM VERSIONED"]);
    // Unbounded, so no LIMIT reaches the server and nothing can claim truncation.
    for (const call of protocolCalls) expect(call.sql.toUpperCase()).not.toContain("LIMIT");
    expect(batch.truncated).toBeUndefined();
    // No column cap. getSchema()'s own column read stops at 100 and does not say so, which
    // is the defect `truncated` exists to prevent.
    expect(protocolCalls[1].sql).toContain("information_schema.COLUMNS");
    expect(protocolCalls[1].sql).not.toContain("LIMIT 100");

    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["app", "customers"],
      ["app", "order_archive"],
      ["app", "orders"],
    ]);
    const orders = batch.details[2];
    expect(orders.columns).toEqual([
      { name: "id", type: "int", nullable: false, isPrimary: true, defaultValue: undefined },
      { name: "total", type: "decimal", nullable: true, isPrimary: false, defaultValue: "0.00" },
    ]);
    expect(orders.indexes).toEqual([
      { name: "PRIMARY", columns: ["id"], unique: true },
      { name: "orders_total_ix", columns: ["total", "note"], unique: false },
    ]);
    // Bare within the container, qualified outside it, exactly as the single read spells it.
    expect(orders.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      { columnName: "region_id", referencedTable: "reporting.regions", referencedColumn: "id" },
    ]);
    // An object the three detail reads answered nothing for is still IN the answer, with
    // three empty lists rather than absent.
    expect(batch.details[0].indexes).toEqual([]);
    expect(batch.details[0].foreignKeys).toEqual([]);
    await provider.disconnect();
  });

  test("the answer is sorted by path, whatever order the server cut it in", async () => {
    // The server's order is the server's, and the two servers in this family do not agree.
    // Measured: `information_schema.TABLES.TABLE_NAME` collates utf8mb3_bin on MySQL 26.7.0
    // and utf8mb3_general_ci on MariaDB 12.3.2, where `s` folds to the weight of `S` (0x53)
    // and sorts BELOW `_` (0x5F) - so the same four tables come back as
    // `customers, orders, order_archive, order_audit` there. The rows below are that answer,
    // verbatim. The ORDER BY decides which objects a bound keeps; the order a caller reads
    // is ours, one rule on every server, because callers join on path.
    const provider = await connectedTo(true);
    mockExecuteFn = async (sql: string) => {
      if (sql.includes("ORDER BY TABLE_NAME") && !sql.includes("object_name")) {
        return [[{ name: "customers" }, { name: "orders" }, { name: "order_archive" }], []];
      }
      return [[], []];
    };

    const batch = await provider.describeObjects(["app"], "table");

    expect(batch.details.map((detail) => detail.path[1])).toEqual(["customers", "order_archive", "orders"]);
    await provider.disconnect();
  });

  test("the bulk read and the single read spell one object identically", async () => {
    // ONE mapper serves both, so the two answers for one table cannot disagree about a
    // foreign key, a composite index or which column is the primary key.
    const provider = await connectedTo(false);

    const bulk = (await provider.describeObjects(["app"], "table")).details.find(
      (detail) => detail.path[1] === "orders",
    );
    const single = await provider.describeObject(["app", "orders"], "table");

    expect(bulk).toEqual(single);
    await provider.disconnect();
  });

  test("a bounded read binds one row more than the bound and reports its own truncation", async () => {
    const provider = await connectedTo(false);
    protocolCalls = [];

    const batch = await provider.describeObjects(["app"], "table", 1);

    // limit + 1, which is how a saturated read is told from an exact one with no second
    // count. The bound is the caller's and is reported as the caller's.
    expect(protocolCalls[0].params).toEqual(["app", "BASE TABLE", "SYSTEM VERSIONED", 2]);
    expect(protocolCalls[0].sql).toContain("LIMIT ?");
    expect(batch.details.map((detail) => detail.path)).toEqual([["app", "customers"]]);
    expect(batch.truncated).toEqual({ limit: 1, reason: "column read limit reached" });
    await provider.disconnect();
  });

  test("a bounded read that fits reports nothing", async () => {
    const provider = await connectedTo(false);

    // Three tables against a bound of three: the read reached the end, so marking it would
    // teach a reader to discount every badge.
    const batch = await provider.describeObjects(["app"], "table", 3);

    expect(batch.details).toHaveLength(3);
    expect(batch.truncated).toBeUndefined();
    await provider.disconnect();
  });

  test("a kind with no table behind it answers empty without asking the server", async () => {
    const provider = await connectedTo(true);
    let asked = 0;
    mockExecuteFn = async () => {
      asked += 1;
      return [[], []];
    };

    for (const kind of ["procedure", "function", "event", "package", "trigger"]) {
      expect(await provider.describeObjects(["app"], kind)).toEqual({ details: [] });
    }
    expect(asked).toBe(0);
    await provider.disconnect();
  });

  test("a MariaDB sequence DOES describe in bulk, because the column dictionary answers for it", async () => {
    // Measured on MariaDB 12.3.2: information_schema.COLUMNS answers real columns for a
    // SEQUENCE, because a sequence is a table underneath - so the kinds with no columns are
    // decided by the CATALOG each kind is read from and never by `role === "relation"`.
    const provider = await connectedTo(true);

    const batch = await provider.describeObjects(["app"], "sequence");

    expect(batch.details).toEqual([
      {
        path: ["app", "invoice_number_seq"],
        columns: [
          { name: "next_not_cached_value", type: "bigint", nullable: false, isPrimary: false, defaultValue: undefined },
        ],
        indexes: [],
        foreignKeys: [],
      },
    ]);
    await provider.disconnect();
  });

  test("an empty container costs one round trip and not four", async () => {
    const provider = await connectedTo(false);
    protocolCalls = [];
    mockExecuteFn = async () => [[], []];

    expect(await provider.describeObjects(["app"], "table")).toEqual({ details: [] });
    expect(protocolCalls).toHaveLength(1);
    await provider.disconnect();
  });

  test("a kind this server does not declare is refused, not answered empty", async () => {
    // An undeclared kind is a fact about the SERVER and an empty answer is a claim about
    // the data. On this provider the difference is live: MYSQL_OBJECT_TYPES carries
    // MariaDB's `sequence` whatever server is connected, so only the DECLARATION can refuse.
    const provider = await connectedTo(false);

    await expect(provider.describeObjects(["app"], "sequence")).rejects.toThrow(/declares no object kind "sequence"/);
    await provider.disconnect();
  });

  test("a container path that is not [database] is refused, rather than read as empty", async () => {
    const provider = await connectedTo(false);

    await expect(provider.describeObjects([], "table")).rejects.toThrow(/container path is \[database\]/);
    await expect(provider.describeObjects(["app", "orders"], "table")).rejects.toThrow(
      /container path is \[database\]/,
    );
    await provider.disconnect();
  });

  test("a limit that cannot bound anything is refused, rather than silently ignored", async () => {
    const provider = await connectedTo(false);

    // 0 would answer nothing while reporting a truncation nobody asked for, and a fractional
    // bound reaches mysql2 as a bind the server cannot use.
    await expect(provider.describeObjects(["app"], "table", 0)).rejects.toThrow(
      /limit must be a positive whole number, received 0/,
    );
    await expect(provider.describeObjects(["app"], "table", 1.5)).rejects.toThrow(
      /limit must be a positive whole number, received 1.5/,
    );
    await provider.disconnect();
  });

  test("a refusal is raised naming the statement that earned it", async () => {
    const provider = await connectedTo(false);
    mockExecuteFn = async (sql: string) => {
      if (sql.includes("information_schema.COLUMNS")) throw new Error("SELECT command denied to user 'app'@'%'");
      return [[{ name: "orders" }], []];
    };

    const failure = await provider.describeObjects(["app"], "table").catch((error: unknown) => error);
    expect((failure as Error).message).toContain("SELECT command denied");
    expect((failure as { query?: string }).query).toContain("information_schema.COLUMNS");
    await provider.disconnect();
  });

  test("the paths it answers are the paths listObjects answers", async () => {
    // Every caller joins the two answers on path, so they are built by ONE rule rather than
    // by two that happen to agree.
    const provider = await connectedTo(false);

    const listed = await provider.listObjects(["app"], "table");
    const batch = await provider.describeObjects(["app"], "table");

    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    await provider.disconnect();
  });

  test("a two-level declaration binds the SCHEMA segment, not the first one", async () => {
    // Standing ruling 5g (#789), driven to a BOUND VALUE rather than to a refusal. MySQL is
    // one-level, so `container[0]` and the schema segment are the same string here and no
    // fixture of this engine can tell them apart; handing this provider a two-level
    // declaration is what makes the derivation mutatable on a one-level engine.
    const provider = await connectedTo(false);
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...provider.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });
    protocolCalls = [];

    const batch = await provider.describeObjects(["cluster", "app"], "table");

    expect(protocolCalls[0].params).toEqual(["app", "BASE TABLE", "SYSTEM VERSIONED"]);
    expect(protocolCalls[1].params).toEqual(["app", "BASE TABLE", "SYSTEM VERSIONED", "app"]);
    // And the two answers still agree about the address, because `objectPath()` builds both.
    // It builds a container-level path from the SCHEMA segment alone, which is this file's
    // shape for a one-level engine and is what a two-level engine copying it has to widen;
    // the invariant asserted here is that the bulk read never invents a second rule.
    const listed = await provider.listObjects(["cluster", "app"], "table");
    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    await provider.disconnect();
  });
});
