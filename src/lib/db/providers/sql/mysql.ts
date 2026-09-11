/**
 * MySQL Database Provider
 * Full MySQL support with connection pooling using mysql2
 */

import mysql, { type Pool, type PoolConnection, type RowDataPacket, type FieldPacket } from "mysql2/promise";
import { SQLBaseProvider } from "./sql-base";
import { mysqlColumnTypes } from "./column-types";
import {
  type ColumnSchema,
  type Container,
  type ContainerLevelSpec,
  type DatabaseConnection,
  type DatabaseObject,
  type ForeignKeySchema,
  type IndexSchema,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectKindSpec,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ExplainFormat,
  type ProviderLabels,
  type SlowQuery,
  type ActiveSession,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from "../../types";
import { DatabaseConfigError, ConnectionError, QueryError, mapDatabaseError } from "../../errors";
import { containerDepth, declaredKinds, findKind } from "../../object-kinds";
import { formatBytes } from "../../utils/pool-manager";
import { measuredNullableAggregate } from "../../utils/measured-aggregate";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

/**
 * mysql2 3.23 narrowed `execute`'s values parameter from `any` to a concrete
 * `ExecuteValues` union that excludes `undefined`. The provider interface every
 * driver implements passes `unknown[]` - it cannot be narrowed here without
 * narrowing it for MongoDB and Redis too - so the array is cast at this one
 * boundary.
 *
 * The cast changes nothing about what reaches the server: mysql2 validates
 * every bind value itself and REJECTS `undefined` outright ("Bind parameters
 * must not contain undefined. To pass SQL NULL specify JS null", thrown from
 * lib/base/connection.js). It is not coerced to NULL, before or after this
 * change - callers wanting SQL NULL must pass `null`. The new typing states
 * that rule; this cast keeps the runtime rule as the thing that enforces it.
 *
 * Derived from the method signature rather than importing `ExecuteValues` by
 * name, so a future rename in mysql2 surfaces as a type error here instead of
 * an unresolved import.
 */
type ExecuteParams = Parameters<PoolConnection["execute"]>[1];
const asExecuteParams = (params?: unknown[]): ExecuteParams => params as ExecuteParams;

/**
 * Anything this provider can issue a statement over: the pool, a pooled
 * connection, and the connection a transaction holds. All three are used.
 */
type MySQLQueryable = Pick<PoolConnection, "query" | "execute">;

/**
 * Every statement this provider issues goes through here, and the protocol is
 * chosen by one fact: whether the statement carries parameters.
 *
 * mysql2 offers two: `query` speaks MySQL's TEXT protocol, `execute` the BINARY
 * PREPARED one. Everything here used to call `execute`, parameterless statements
 * included, and three engines refuse whole statement classes on that protocol
 * with `This command is not supported in the prepared statement protocol yet`:
 *
 * - SingleStore 9.1.1 (`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`),
 *   measured 2026-08-24 both ways over one connection: `SHOW STATUS`,
 *   `SHOW VARIABLES`, `EXPLAIN`, `EXPLAIN JSON`, `OPTIMIZE TABLE` and
 *   `CHECK TABLE` all fail prepared with `ER_UNSUPPORTED_PS` and all succeed as
 *   text. `EXPLAIN FORMAT=JSON` is NOT in that list: it is `ER_PARSE_ERROR` on
 *   both protocols there, because SingleStore's grammar is `EXPLAIN JSON`, so the
 *   Explain panel is not something this helper recovers. What recovers it is
 *   `probeExplainFormat()` below: the grammar is measured at connect and declared
 *   as a capability, so an engine that refuses `EXPLAIN FORMAT=JSON` gets the
 *   plain `EXPLAIN` of the `mysql-text` strategy instead of a failing panel.
 * - StarRocks 3.3, whose overview this recovers (measured through the provider,
 *   2026-08-24); its health still fails on a missing
 *   `information_schema.PROCESSLIST`, which is the engine's gap, not the protocol.
 * - MySQL 26.7.0 itself refuses `CHECK TABLE` prepared - measured 2026-08-24 on
 *   `mysql:latest` - so one maintenance action was unavailable on the engine this
 *   provider is named for.
 *
 * A parameterised statement keeps `execute`: the placeholders are what the
 * prepared protocol is for, and binding is what keeps a value out of the SQL text.
 * An empty array carries no parameter and is nothing to bind, so it takes the text
 * path with the parameterless statements.
 *
 * Moving the read path across is safe because the two protocols decode to the same
 * JS shapes. Measured 2026-08-24 on MySQL 26.7.0 over one connection, the same
 * SELECT both ways across TINYINT(1), INT, BIGINT past 2^53, BIGINT UNSIGNED,
 * DECIMAL, FLOAT, DOUBLE, DATE, DATETIME, TIMESTAMP, TIME, YEAR, CHAR, VARCHAR,
 * TEXT, BLOB, BIT(1), BIT(8), JSON, ENUM, SET and NULLs: every value identical by
 * `typeof` and by `JSON.stringify`, every `FieldPacket` identical in `columnType`,
 * `flags`, `characterSet`, `columnLength` and `decimals` - so `columnTypes` names
 * the same types - and a non-result-set statement answers the same
 * `ResultSetHeader`, which is what `buildQueryResult` reads. See
 * `docs/providers/mysql.md` section 3.4.
 */
const runStatement = <T extends RowDataPacket[] = RowDataPacket[]>(
  queryable: MySQLQueryable,
  sql: string,
  params?: unknown[],
): Promise<[T, FieldPacket[]]> =>
  params === undefined || params.length === 0
    ? queryable.query<T>(sql)
    : queryable.execute<T>(sql, asExecuteParams(params));

/**
 * The EXPLAIN grammars this provider can ask for, most specific first, each paired
 * with the strategy id that reads what the statement answers.
 *
 * `EXPLAIN FORMAT=JSON` is MySQL's own grammar and the rest of the wire family does
 * not share it. Measured 2026-09-06 through mysql2 3.24.2 over the text protocol,
 * one connection per engine:
 *
 * - MySQL 26.7.0 (`mysql:latest`) and MariaDB 12.3.2 (`mariadb:latest`): both
 *   statements accepted.
 * - TiDB 8.5.1 (`pingcap/tidb:v8.5.1`): `EXPLAIN FORMAT=JSON SELECT 1` is errno 1105
 *   `explain format 'json' is not supported now`; `EXPLAIN SELECT 1` is accepted.
 * - Apache Doris 4.1.3 (`apache/doris:all-in-one-4.1.3`): errno 1105
 *   `mismatched input '=' expecting {<EOF>, ';'}(line 1, pos 14)`; `EXPLAIN SELECT 1`
 *   is accepted.
 * - StarRocks 3.3.22 (`starrocks/allin1-ubuntu:3.3.22`) and SingleStore
 *   (`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`): errno 1064, a parse error;
 *   `EXPLAIN SELECT 1` is accepted on both.
 * - Databend 1.2.925 (`datafuselabs/databend:v1.2.925-patch-11`): errno 1105
 *   SyntaxException; `EXPLAIN SELECT 1` is accepted.
 * - Vitess 24.0.2 (`vitess/vttestserver:v24.0.2-mysql80`) and OceanBase CE 4.4.2
 *   (`oceanbase/oceanbase-ce:4.4.2-lts`): both statements accepted, so nothing about
 *   those two changes. Vitess refuses the QUOTED `EXPLAIN FORMAT='json'`, which is a
 *   reason to keep sending the unquoted form the probe and the strategy already use.
 */
const EXPLAIN_PROBES: readonly (readonly [sql: string, format: ExplainFormat])[] = [
  ["EXPLAIN FORMAT=JSON SELECT 1", "mysql-json"],
  ["EXPLAIN SELECT 1", "mysql-text"],
];

/**
 * Which of those grammars this server accepts, or `undefined` when it accepts
 * neither. Run once per `connect()`, on the connection the pool check already holds.
 *
 * It reads SUCCESS OR FAILURE and never the errno, because the family does not share
 * one for a grammar refusal: Doris and TiDB answer 1105 where StarRocks and
 * SingleStore answer 1064 (measured 2026-09-06, see `EXPLAIN_PROBES`). Keying on a
 * code would have to enumerate engines, which is the branch `src/lib/db` does not
 * take; asking the server what its grammar accepts is the same answer without the
 * enumeration.
 *
 * Nothing here rejects. A grammar the server does not have is a fact about the
 * Explain panel, not about the connection, and `connect()` must not fail for it.
 */
const probeExplainFormat = async (queryable: MySQLQueryable): Promise<ExplainFormat | undefined> => {
  for (const [sql, format] of EXPLAIN_PROBES) {
    try {
      await runStatement(queryable, sql);
      return format;
    } catch {
      // Refused, so try the next grammar. The reason is the engine's own and there is
      // nothing to report: the capability this produces IS the report.
    }
  }
  return undefined;
};

/**
 * One row of MySQL's answer to `ANALYZE`/`OPTIMIZE`/`CHECK TABLE`. These statements
 * return a RESULT SET, not a header: the outcome is data, and reading it is the only
 * way to know what happened.
 */
interface MaintenanceReportRow extends RowDataPacket {
  Table: string;
  Op: string;
  Msg_type: string;
  Msg_text: string;
}

/**
 * MySQL's verdict on a table maintenance statement, taken from the statement's own
 * answer.
 *
 * The statement does NOT throw when the server refuses it: measured through this
 * provider against MySQL 26.7.0 (`libredb-mysql`) on 2026-08-25, `OPTIMIZE TABLE
 * \`missing\`` resolves normally and answers
 *
 *   [{ Table: 'u9t.missing', Op: 'optimize', Msg_type: 'Error',
 *      Msg_text: "Table 'u9t.missing' doesn't exist" },
 *    { Table: 'u9t.missing', Op: 'optimize', Msg_type: 'status',
 *      Msg_text: 'Operation failed' }]
 *
 * so `await runStatement(...); return { success: true }` reported a completed
 * operation for a statement the server had rejected - and discarded the `Msg_text`
 * that is the entire point of `CHECK TABLE`, whose OK-or-corruption-report is the only
 * thing the user asked for. `Msg_type` is the decision (`'Error'` from the server,
 * matched case-insensitively because the manual documents the set in lower case), and
 * the same read is what SQLite's `check` already does with `PRAGMA integrity_check`.
 *
 * The whole-database form names every table in one statement, so a failing table is
 * quoted WITH its name - it is the only place the failure appears - while a successful
 * run quotes the messages alone and deduplicates them: over forty tables the OK and
 * InnoDB's "doing recreate + analyze instead" note repeat once per table and say the
 * same thing forty times.
 */
function readMaintenanceReport(
  type: MaintenanceType,
  rows: MaintenanceReportRow[],
): { success: boolean; message: string } {
  const failures = rows.filter((row) => String(row.Msg_type).toLowerCase() === "error");
  if (failures.length > 0) {
    return {
      success: false,
      message: `${type.toUpperCase()} failed: ${unique(failures.map((row) => `${row.Table}: ${row.Msg_text}`)).join("; ")}`,
    };
  }

  // A statement that answers no row at all leaves nothing to quote; the generic
  // sentence is then all there is to say.
  if (rows.length === 0) {
    return { success: true, message: `${type.toUpperCase()} completed successfully` };
  }

  return { success: true, message: `${type.toUpperCase()}: ${unique(rows.map((row) => row.Msg_text)).join("; ")}` };
}

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * One status variable out of a bare `SHOW STATUS` result, or `undefined` when the
 * server does not publish it.
 *
 * The provider used to ask for each variable by name with `SHOW STATUS LIKE '<name>'`,
 * which is MySQL grammar that not every MySQL-wire server has. Measured 2026-09-06 over
 * mysql2 3.24.2's text protocol against `apache/doris:all-in-one-4.1.3`:
 *
 *   SHOW STATUS LIKE 'Uptime'  -> errno=1105 code=ER_UNKNOWN_ERROR sqlState=HY000
 *                                 "mismatched input 'LIKE' expecting {<EOF>, ';'}
 *                                  (line 1, pos 12)"
 *   SHOW STATUS                -> ok, columns Variable_name/Value, 0 rows
 *
 * so the whole Overview and Health panels failed on Doris for a clause the bare
 * statement does not need (#573). The bare form is accepted everywhere measured that
 * day: MySQL 26.7.0 (528 rows), MariaDB 12.3.2 (571), TiDB 8.5.1 (13), SingleStore
 * (75), StarRocks 3.3.22 (0) and Doris 4.1.3 (0).
 *
 * The match is case-insensitive because `LIKE` was: replacing the server-side filter
 * with a client-side one must not narrow what it accepted.
 */
function statusValue(rows: RowDataPacket[], name: string): unknown {
  const wanted = name.toLowerCase();
  return rows.find((row) => String(row.Variable_name).toLowerCase() === wanted)?.Value;
}

// ============================================================================
// SQL Statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution
// stays stable (repo pattern, see the SCHEMA_*_SQL consts in mssql.ts).

const SCHEMA_TABLES_SQL = `
        SELECT
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count,
          DATA_LENGTH + INDEX_LENGTH as total_size
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME ASC;
      `;

const SCHEMA_COLUMNS_SQL = `
          SELECT
            COLUMN_NAME as column_name,
            DATA_TYPE as data_type,
            IS_NULLABLE as is_nullable,
            COLUMN_DEFAULT as column_default,
            COLUMN_KEY as column_key
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
          LIMIT 100;
        `;

const SCHEMA_FOREIGN_KEYS_SQL = `
          SELECT
            COLUMN_NAME as column_name,
            REFERENCED_TABLE_NAME as referenced_table,
            REFERENCED_COLUMN_NAME as referenced_column
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL;
        `;

const SCHEMA_INDEXES_SQL = `
          SELECT
            INDEX_NAME as index_name,
            GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
            NOT NON_UNIQUE as is_unique
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          GROUP BY INDEX_NAME, NON_UNIQUE;
        `;

const DATABASE_SIZE_MB_SQL = `
        SELECT
          ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) as size_mb
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `;

// Shared by getHealth() and getPerformanceMetrics().
const BUFFER_CACHE_HIT_RATIO_SQL = `
        SELECT
          (1 - (
            (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') /
            NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 0)
          )) * 100 as hit_ratio;
      `;

const HEALTH_ACTIVE_SESSIONS_SQL = `
        SELECT
          ID as pid,
          USER as user,
          DB as \`database\`,
          COMMAND as state,
          LEFT(COALESCE(INFO, ''), 100) as query,
          CONCAT(TIME, 's') as duration
        FROM information_schema.PROCESSLIST
        WHERE DB = ?
        ORDER BY TIME DESC
        LIMIT 10;
      `;

const MAINTENANCE_TABLES_SQL = `
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
      LIMIT 50;
    `;

const OVERVIEW_DATABASE_SIZE_SQL = `
        SELECT SUM(DATA_LENGTH + INDEX_LENGTH) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `;

const OVERVIEW_OBJECT_COUNTS_SQL = `
        SELECT
          COUNT(DISTINCT TABLE_NAME) as table_count,
          COUNT(DISTINCT INDEX_NAME) as index_count
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?;
      `;

const OVERVIEW_TABLE_COUNT_SQL = `
        SELECT COUNT(*) as cnt FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE';
      `;

const BUFFER_POOL_PAGES_SQL = `
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_data') as data_pages,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_total') as total_pages;
      `;

const QUERIES_PER_SECOND_SQL = `
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Queries') as queries,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime') as uptime;
      `;

/**
 * The ONE read of `performance_schema.events_statements_summary_by_digest`, shared by
 * `getSlowQueries()` (the Queries panel) and `getHealth()`'s slow-query line, with only
 * the LIMIT interpolated at each call site.
 *
 * It is shared because the two used to be separate statements and the health one was
 * wrong (#512): it asked for `LEFT(sql_text, 100)`, and this table has no `sql_text`
 * column. `SQL_TEXT` belongs to `events_statements_current`/`_history`; the digest table
 * carries the normalised `DIGEST_TEXT` (MySQL 9.4 manual, "Statement Summary Tables",
 * and the server's own `information_schema.columns` on every build below). So that
 * statement answered
 *
 *   errno=1054 code=ER_BAD_FIELD_ERROR sqlState=42S22
 *   Unknown column 'sql_text' in 'field list'
 *
 * and never once returned a row. Measured 2026-08-27 on MySQL 26.7.0, Percona Server
 * 8.4.11-11, MySQL 26.7.0 started `--performance-schema=OFF` and MariaDB 12.3.2 - all
 * four, whatever `@@performance_schema` said - while this statement answered 5 real rows
 * on the two with the schema on, over the same connection.
 *
 * Two statements for one fact is what drifted, and the copy the health panel used was
 * the one no test ever put in front of a server: the mysql2 mock invented a `query`
 * column for any statement over this table, so the broken read looked like a working one
 * for as long as it was only mocked.
 */
const SLOW_QUERIES_BODY_SQL = `
        SELECT
          DIGEST as query_id,
          LEFT(DIGEST_TEXT, 500) as query,
          COUNT_STAR as calls,
          SUM_TIMER_WAIT / 1000000000 as total_time_ms,
          AVG_TIMER_WAIT / 1000000000 as avg_time_ms,
          MIN_TIMER_WAIT / 1000000000 as min_time_ms,
          MAX_TIMER_WAIT / 1000000000 as max_time_ms,
          SUM_ROWS_EXAMINED as rows_examined
        FROM performance_schema.events_statements_summary_by_digest
        WHERE SCHEMA_NAME = ?
        ORDER BY SUM_TIMER_WAIT DESC`;

/**
 * The five heaviest digests - the LIMIT the health statement this replaced already used,
 * kept so the reading's size does not change with the repair.
 *
 * A CAP, NOT A COUNT, and nothing downstream can tell the difference, which is why it is
 * written here. `SLOW_QUERIES_BODY_SQL` has no slowness predicate at all: its only WHERE
 * term is the connected schema and "slow" is the ORDERING (`SUM_TIMER_WAIT DESC`), so the
 * top five digests for a schema come back whether they took 15 ms or 15 hours. So on any
 * server with five or more digests for this schema, the LENGTH of this list is 5 -
 * permanently, and about statements no threshold has called slow. The agent's curated
 * health reading used to forward that length to the model as `slowQueryCount`; it no
 * longer projects any length at all, because a figure whose value is a cap has no
 * referent (`src/lib/agent/tools.ts`, and #513). The cap is still
 * written here: nothing downstream can tell a cap from a count, so the only place the
 * distinction can be recorded is where the limit is applied.
 *
 * Measured 2026-08-27 on MySQL 26.7.0: the digest table held 59 rows for one connected
 * schema, and the five this statement returns for it were ALL Studio's own introspection
 * statements, with the slow-query read itself first at `avg 79.11ms, calls 3` and the rest
 * between 1.15 ms and 7.78 ms. Nothing in that list is slow and none of it is the user's
 * workload; what the reading honestly reports is "the five heaviest digests recorded for
 * this schema". Raising the limit would move the saturation point without turning the
 * number into a count - only a slowness threshold, or a differently named projection,
 * would - and the projection is in a file this one does not own.
 */
const HEALTH_SLOW_QUERY_LIMIT = 5;

/**
 * One digest row in the Queries panel's shape. Module-level rather than inline in
 * `getSlowQueries()` so `getHealth()` projects the SAME row the panel does: the health
 * line's job is to agree with the panel beside it, and it can only be structurally
 * unable to disagree while there is one statement and one mapper.
 */
function toSlowQueryStats(r: RowDataPacket): SlowQueryStats {
  return {
    queryId: r.query_id || undefined,
    query: r.query || "",
    calls: parseInt(r.calls || "0"),
    totalTime: parseFloat(r.total_time_ms || "0"),
    avgTime: parseFloat(r.avg_time_ms || "0"),
    minTime: parseFloat(r.min_time_ms || "0"),
    maxTime: parseFloat(r.max_time_ms || "0"),
    rows: parseInt(r.rows_examined || "0"),
  };
}

/**
 * The health summary's narrower `SlowQuery` shape, from the panel's row.
 *
 * NOTHING RENDERS THESE TWO FIELDS, and the format is chosen on that basis rather than on
 * an appearance nobody can check. No component reads `HealthInfo.slowQueries` (the
 * monitoring Queries and Overview tabs read `MonitoringData.slowQueries`, a different
 * reading with its own `SlowQueryStats` shape), and the one caller of
 * `POST /api/db/health` - the 60s connection pulse in `src/hooks/use-connection-manager.ts` -
 * reads `res.ok` and discards the body. The agent's curated health reading
 * (`src/lib/agent/tools.ts`) was the last live consumer and read only the list's LENGTH -
 * never `query`, never `avgTime` - and it no longer reads the list at all (#513). So this
 * shape now has no consumer in the app beyond the serialised route body.
 *
 * So `toFixed(2)` plus `"ms"` is here for one reason: it is the string the statement this
 * replaced produced with `CONCAT(ROUND(avg_timer_wait / 1000000000, 2), 'ms')`, and
 * keeping the type's contents identical in form means no consumer added later inherits a
 * silent change of units from this repair. What DID change is the query text: the old
 * statement asked for `LEFT(sql_text, 100)` (and answered ER_BAD_FIELD_ERROR every time,
 * so no consumer ever saw 100 characters of anything), the shared one asks for
 * `LEFT(DIGEST_TEXT, 500)` - the panel's own width, five times wider, and the reason the
 * two readings can no longer disagree about a statement's text.
 */
function toHealthSlowQuery(stats: SlowQueryStats): SlowQuery {
  return { query: stats.query, calls: stats.calls, avgTime: `${stats.avgTime.toFixed(2)}ms` };
}

/**
 * Vendor names that a MySQL-protocol server puts into its own `VERSION()` string.
 *
 * `mysql2` serves MySQL and its wire-compatible relatives alike, and `VERSION()`
 * is the only thing that says which one answered. MySQL returns a bare number
 * ("8.0.35"), so the overview has to supply the vendor; these four supply it
 * themselves, and prefixing "MySQL" onto their answer asserted the wrong vendor
 * outright - a MariaDB 12.3 server read as "MySQL 12.3.2-MariaDB-ubu2404".
 *
 * The list is exactly the self-identifying strings `WIRE_COMPATIBLE_ENGINES`
 * records from a live probe: MariaDB `12.3.2-MariaDB-ubu2404`, TiDB
 * `8.0.11-TiDB-v8.5.1`, Vitess `8.0.43-Vitess`, OceanBase
 * `5.7.25-OceanBase_CE-v4.4.2.1`. StarRocks and SingleStore are deliberately
 * absent: both answer `VERSION()` with a plain MySQL number and nothing to key
 * on, which the compatibility table already records as their behaviour.
 */
const SELF_IDENTIFYING_VERSION = /mariadb|tidb|vitess|oceanbase/i;

/**
 * Doris is absent from `SELF_IDENTIFYING_VERSION` for the same reason as
 * StarRocks and SingleStore - `VERSION()` answers a fixed, fictitious MySQL
 * number (`5.7.99`) with nothing to key on - but unlike those two, Doris does
 * put its own build string in `@@version_comment`: `"doris version
 * doris-4.1.3-rc02-7126cf65d96"`, measured against
 * `apache/doris:all-in-one-4.1.3`. Real MySQL's own `@@version_comment`
 * ("MySQL Community Server - GPL") and MariaDB's ("mariadb.org binary
 * distribution") do not match this shape, so keying on it does not misfire on
 * the engine this provider is named for.
 */
const DORIS_VERSION_COMMENT = /doris version (?:doris-)?(\S+)/i;

/**
 * How the overview names the server: the string as the server gave it when
 * that already names a vendor, Doris's own build string extracted from
 * `@@version_comment` when the fictitious `VERSION()` number is the only
 * other option, `MySQL <version>` otherwise.
 */
function labelServerVersion(version: string, versionComment?: string): string {
  if (SELF_IDENTIFYING_VERSION.test(version)) return version;
  const doris = versionComment?.match(DORIS_VERSION_COMMENT);
  if (doris) return `Apache Doris ${doris[1]}`;
  return `MySQL ${version}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// The LIMIT clause is interpolated at the call site in getActiveSessions().
const ACTIVE_SESSIONS_BODY_SQL = `
        SELECT
          ID as pid,
          USER as user,
          DB as database_name,
          HOST as client_addr,
          COMMAND as state,
          LEFT(COALESCE(INFO, ''), 500) as query,
          TIME as duration_seconds
        FROM information_schema.PROCESSLIST
        WHERE DB = ? OR DB IS NULL
        ORDER BY TIME DESC`;

const TABLE_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as schema_name,
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count,
          DATA_LENGTH as table_size_bytes,
          INDEX_LENGTH as index_size_bytes,
          DATA_LENGTH + INDEX_LENGTH as total_size_bytes,
          DATA_FREE as free_space_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY DATA_LENGTH + INDEX_LENGTH DESC
        LIMIT 100;
      `;

const INDEX_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as schema_name,
          TABLE_NAME as table_name,
          INDEX_NAME as index_name,
          INDEX_TYPE as index_type,
          GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
          NOT NON_UNIQUE as is_unique,
          INDEX_NAME = 'PRIMARY' as is_primary,
          MAX(CARDINALITY) as cardinality
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, INDEX_TYPE, NON_UNIQUE
        ORDER BY TABLE_NAME, INDEX_NAME
        LIMIT 200;
      `;

// Sizes come from the InnoDB persistent-statistics table, not from the INNODB_* views in
// information_schema. Two measurements on 2026-08-23 forced the move: `INNODB_TABLESPACES` has no
// `INDEX_SIZE` column on MySQL 26.7.0 or on the MySQL 8.0 inside Vitess 24.0.2 (both answer
// ER_BAD_FIELD_ERROR), and the old statement's `WHERE t.NAME LIKE 'schema/%'` assumed InnoDB names
// the table after the database you connected to, which Vitess does not — it stores the physical
// shard database, `vt_probe_0/orders`. `stat_value` is the index size in pages, per index rather
// than per tablespace, and the row is keyed on database/table/index columns that
// information_schema.STATISTICS reports the same way, so nothing here parses or guesses a prefix.
const INDEX_SIZES_SQL = `
          SELECT
            database_name,
            table_name,
            index_name,
            stat_value * @@innodb_page_size as size_bytes
          FROM mysql.innodb_index_stats
          WHERE stat_name = 'size' AND database_name = ?;
        `;

const STORAGE_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as name,
          SUM(DATA_LENGTH + INDEX_LENGTH) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA;
      `;

// ============================================================================
// Object surface (#789)
// ----------------------------------------------------------------------------
// Hoisted to module scope for the same coverage reason as the schema SQL above.
//
// `information_schema` answers for every kind here, which is the OPPOSITE of the
// PostgreSQL provider's reasoning and is deliberate: MySQL 8's data dictionary made
// `information_schema` a set of views over the dictionary tables rather than the
// materialised copies it was through 5.7, so there is no cheaper native catalog to prefer
// and the SQL-standard names are the portable ones across the wire-compatible family.
// ============================================================================

/**
 * The four schemas MySQL and MariaDB both reserve for themselves.
 *
 * A hand-written name list, unlike Oracle's `ORACLE_MAINTAINED` and PostgreSQL's
 * `pg_depend` ownership test, because neither server publishes the fact: nothing in
 * `information_schema.SCHEMATA` says whether a schema is the server's own. What makes the
 * list safe is that all four names are RESERVED - `CREATE DATABASE mysql` answers
 * ER_DB_CREATE_EXISTS on a fresh server - so hiding them can never hide a database a
 * person created. Measured 2026-09-11 on MySQL 26.7.0 and MariaDB 12.3.2: `SCHEMATA` holds
 * exactly these four plus the user's own on both.
 *
 * They are hidden from the BROWSER and remain fully reachable from the SQL editor, which is
 * the same treatment `pg_catalog` gets on PostgreSQL. This provider itself reads two of
 * them (`performance_schema.global_status`, `mysql.innodb_index_stats`).
 */
const SYSTEM_SCHEMAS = ["information_schema", "mysql", "performance_schema", "sys"] as const;

/** Rendered once. Interpolated into the `NOT IN (...)` clause below. */
const SYSTEM_SCHEMA_LIST = SYSTEM_SCHEMAS.map((schema) => `'${schema}'`).join(", ");

/**
 * The containers this connection has, which on MySQL is one level: databases.
 *
 * Bound to NOTHING, and that is the point. Every other introspection read in this file is
 * parameterised with `TABLE_SCHEMA = config.database` (section 3.2 of the provider doc), so
 * the app has only ever shown the database the connection opened against. MySQL resolves a
 * qualified name across databases on one connection - unlike PostgreSQL, where a `pg` pool
 * is pinned to one database and a second would need a second connection - so every database
 * the server holds is genuinely browsable from this session.
 *
 * `SCHEMA_NAME = DATABASE()` is the SERVER's own answer for which container the session is
 * in, rather than `config.database`, for the reason Oracle reads `SYS_CONTEXT` instead of
 * `connection.user`: the configured value is what a person typed into a form. It is NULL
 * rather than 0 when no database was selected, which `listContainers` reads as false.
 */
const CONTAINERS_SQL = `
        SELECT SCHEMA_NAME AS name, SCHEMA_NAME = DATABASE() AS is_session_default
        FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME NOT IN (${SYSTEM_SCHEMA_LIST})
        ORDER BY SCHEMA_NAME ASC`;

/**
 * The catalog and EVERY spelling each declared kind is addressed by, written once.
 *
 * Two `information_schema` views answer for six of the eight kinds, and the values in each
 * entry are the literals that view's own type column holds. The counting statement's CASE
 * arms and every listing's BOUND types are both built from this table, so a kind added to
 * `objectKinds` without an entry here fails loudly instead of drawing a folder nothing can
 * fill. Triggers and events have a view each and need no type at all, so they are not here.
 *
 * THE ENGINE IS ENUMERATED HERE, NOT THE FIXTURE, and the difference was a real defect. The
 * first version of this table came from `SELECT DISTINCT TABLE_TYPE` over the seeded
 * fixture, which answers only what the fixture happens to hold; a type neither the CASE nor
 * the listing names falls out of BOTH, so the object is invisible in the tree while the
 * count and the listing still agree and every gate still passes. Measured 2026-09-11 over
 * tables built to produce each case:
 *
 * | `TABLE_TYPE` | MySQL 26.7.0 | MariaDB 12.3.2 | here |
 * |---|---|---|---|
 * | `BASE TABLE` | yes | yes | `table` |
 * | `VIEW` | yes | yes | `view` |
 * | `SYSTEM VIEW` | yes | yes | absent, see below |
 * | `SEQUENCE` | no | yes | `sequence` |
 * | `SYSTEM VERSIONED` | no | yes | `table` |
 * | `TEMPORARY` | no | yes | absent, see below |
 *
 * A PARTITIONED table is `BASE TABLE` on both, measured, so partitioning adds no spelling.
 * `ROUTINE_TYPE` is `PROCEDURE` and `FUNCTION` on MySQL, plus `PACKAGE` and `PACKAGE BODY`
 * on MariaDB, and MariaDB's grammar has no other routine form.
 *
 * `SYSTEM VERSIONED` is a `table` and not a kind of its own: MariaDB's system versioning is
 * a property of a table you still SELECT from, INSERT into and address by name, and giving it
 * a folder would split one concept across two.
 *
 * Two spellings are deliberately ABSENT, and each would be wrong in a different way.
 * `SYSTEM VIEW` is what `information_schema`'s own tables are, and that schema is not a
 * container here. `TEMPORARY` is SESSION-SCOPED, which a pooled provider cannot address at
 * all: measured on MariaDB 12.3.2, a `CREATE TEMPORARY TABLE` in one session is listed by
 * that session and by no other, and this provider hands out a different pooled connection
 * per method call. A Temporary folder would therefore badge whatever the connection that
 * answered `countObjects` happened to hold, list whatever a different connection held, and
 * hand out addresses that resolve on one connection and not the next.
 */
const MYSQL_OBJECT_TYPES: Record<
  string,
  { readonly catalog: "tables" | "routines"; readonly types: readonly string[] }
> = {
  table: { catalog: "tables", types: ["BASE TABLE", "SYSTEM VERSIONED"] },
  view: { catalog: "tables", types: ["VIEW"] },
  sequence: { catalog: "tables", types: ["SEQUENCE"] },
  procedure: { catalog: "routines", types: ["PROCEDURE"] },
  function: { catalog: "routines", types: ["FUNCTION"] },
  package: { catalog: "routines", types: ["PACKAGE"] },
};

/** Every spelling one catalog answers for, derived so it cannot drift from the table above. */
function modelledTypes(catalog: "tables" | "routines"): readonly string[] {
  return Object.values(MYSQL_OBJECT_TYPES)
    .filter((spec) => spec.catalog === catalog)
    .flatMap((spec) => spec.types);
}

/**
 * Every catalog type this provider has a RULE for, and for the excluded ones the reason.
 *
 * This exists because "the vocabulary enumerates the engine" is a claim that decays. A future
 * MariaDB release can add a `TABLE_TYPE`, and the failure mode is silence: a spelling no CASE
 * arm names is dropped from the count AND from the listing, so the two still agree, every gate
 * still passes, and the object is simply absent from the tree. That is how `SYSTEM VERSIONED`
 * hid here in the first place.
 *
 * So the set is exported, and `tests/live/mysql-object-vocabulary.ts` asks a live server for
 * its own `SELECT DISTINCT TABLE_TYPE` and `SELECT DISTINCT ROUTINE_TYPE` and fails NAMING
 * anything outside it. The modelled half is derived from `MYSQL_OBJECT_TYPES`; the excluded
 * half is written here, and it is a map rather than a list so an exclusion cannot be added
 * without saying why.
 */
export const CATALOG_TYPE_RULES: {
  readonly tables: { readonly modelled: readonly string[]; readonly excluded: Readonly<Record<string, string>> };
  readonly routines: { readonly modelled: readonly string[]; readonly excluded: Readonly<Record<string, string>> };
} = {
  tables: {
    modelled: modelledTypes("tables"),
    excluded: {
      "SYSTEM VIEW": "what information_schema's own tables are, and that schema is not a container here",
      TEMPORARY:
        "session-scoped, and a pooled provider hands out a different connection per call, so the folder would badge one connection's tables and list another's",
    },
  },
  routines: {
    modelled: modelledTypes("routines"),
    excluded: {
      "PACKAGE BODY": "the second ROUTINES row of one package node; counting it would double the Packages badge",
    },
  },
};

/**
 * One CASE mapping one catalog's type column onto the kind ids it answers for.
 *
 * `flatMap`, because a kind may have SEVERAL spellings: `table` covers `BASE TABLE` and
 * MariaDB's `SYSTEM VERSIONED`, so a per-kind `map` would silently count only the first.
 */
function kindCase(catalog: "tables" | "routines", column: string): string {
  const arms = Object.entries(MYSQL_OBJECT_TYPES)
    .filter(([, spec]) => spec.catalog === catalog)
    .flatMap(([kind, spec]) => spec.types.map((type) => `WHEN '${type}' THEN '${kind}'`))
    .join(" ");
  return `CASE ${column} ${arms} END`;
}

/**
 * One statement, one GROUP BY, one round trip for the whole folder row.
 *
 * Four `information_schema` views, one UNION ALL arm each, and the SAME statement is sent to
 * both servers. Nothing here branches on the flavour and nothing needs to: MySQL holds no
 * `SEQUENCE` row and no `PACKAGE` row, so those CASE arms simply never fire there. The data
 * decides, which is one fewer place the two branches can disagree.
 *
 * `kind IS NULL` drops what the CASE has no name for rather than counting it under a folder
 * that does not exist: `SYSTEM VIEW` on both servers, plus `PACKAGE BODY` and `TEMPORARY` on
 * MariaDB. All three are deliberate and `MYSQL_OBJECT_TYPES` says why each one is. The
 * package body is not a second package - measured, `CREATE PACKAGE BODY` with no
 * specification answers ER_SP_DOES_NOT_EXIST - so counting it would double the Packages
 * badge exactly as it would on Oracle.
 *
 * Anything NOT on that list reaching `kind IS NULL` is a defect and not a design: an object
 * dropped here is dropped from the listing too, so the count and the listing agree while the
 * object is invisible in the tree. That is why `MYSQL_OBJECT_TYPES` enumerates the engine
 * rather than a fixture.
 *
 * The schema is bound four times rather than once because a prepared statement takes
 * positional parameters and each arm needs its own.
 */
const COUNTS_SQL = `
        SELECT kind, COUNT(*) AS n FROM (
          SELECT ${kindCase("tables", "TABLE_TYPE")} AS kind
          FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
          UNION ALL
          SELECT ${kindCase("routines", "ROUTINE_TYPE")}
          FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
          UNION ALL
          SELECT 'trigger' FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
          UNION ALL
          SELECT 'event' FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
        ) s
        WHERE kind IS NOT NULL
        GROUP BY kind`;

/**
 * One kind's listing, with an `IN` list sized to however many spellings that kind has.
 *
 * `IN (?, ?)` and not `= ?`, because `table` has two: `BASE TABLE` and MariaDB's
 * `SYSTEM VERSIONED`. The placeholder count comes from `MYSQL_OBJECT_TYPES`, so the listing
 * and the counting statement's CASE arms cannot disagree about how many spellings a kind
 * has; nothing a caller supplied ever reaches the statement text, and the values are BOUND.
 *
 * On the relation side, `TABLE_ROWS` is an ESTIMATE for InnoDB, the same nature as
 * PostgreSQL's `reltuples`, and it is NULL for a VIEW along with both length columns -
 * measured, so `measuredNumber` reads absence there rather than reporting a view as an empty
 * relation. A MariaDB SEQUENCE answers `TABLE_ROWS` 1 and a real `DATA_LENGTH`, because a
 * sequence IS a table underneath.
 *
 * On the routine side, the bare `ROUTINE_NAME` is the whole path segment, and unlike
 * PostgreSQL it needs no argument list to be unique: MySQL does not overload routines.
 * Measured on 26.7.0, a second `CREATE PROCEDURE app.foo(a INT)` over an existing
 * `app.foo()` answers `ER_SP_ALREADY_EXISTS`, so a name identifies a routine within its
 * database and its type.
 */
function listingSql(catalog: "tables" | "routines", spellings: number): string {
  const placeholders = Array.from({ length: spellings }, () => "?").join(", ");
  if (catalog === "tables") {
    return `
        SELECT TABLE_NAME AS name, TABLE_ROWS AS row_count, DATA_LENGTH + INDEX_LENGTH AS size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (${placeholders})`;
  }
  return `
        SELECT ROUTINE_NAME AS name
        FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE IN (${placeholders})`;
}

/**
 * One rendered listing statement per kind, built at module scope.
 *
 * Rendered once rather than per call for the coverage reason the schema SQL above is hoisted
 * for: bun reports the interior lines of a template literal inside a function body as
 * zero-hit in any test process that imports this module without calling it.
 */
const LIST_OBJECT_SQL: Record<string, string> = Object.fromEntries(
  Object.entries(MYSQL_OBJECT_TYPES).map(([kind, spec]) => [kind, listingSql(spec.catalog, spec.types.length)]),
);

/**
 * The database's triggers, each with the table it fires on.
 *
 * `EVENT_OBJECT_TABLE` is the parent segment, which is what the `attachedTo: "table"`
 * declaration states. It is NOT there to make the name unique: measured on MySQL 26.7.0, a
 * trigger name is unique per DATABASE and not per table, so a second
 * `CREATE TRIGGER app.foo` on a different table answers `ER_TRG_ALREADY_EXISTS`. The
 * nesting is the tree shape the engine's own model implies - a trigger cannot exist without
 * its table - and `[database, trigger]` would be a perfectly unique address that simply does
 * not say what the trigger hangs off.
 *
 * `TRIGGER_SCHEMA` rather than `EVENT_OBJECT_SCHEMA`: they are the same on every MySQL
 * server, because a trigger lives in its table's database, and the first one is the
 * container that OWNS the row.
 */
const LIST_TRIGGERS_SQL = `
        SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS parent
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?`;

/** The database's scheduled events. One view, one column, no type to bind. */
const LIST_EVENTS_SQL = `
        SELECT EVENT_NAME AS name
        FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ?`;

/**
 * One object's columns, primary key included: `COLUMN_KEY = 'PRI'` is the same read
 * `getSchema()` uses, so the two surfaces cannot disagree about which column is the key.
 *
 * It carries NO `LIMIT`, and that is the one way it differs from `SCHEMA_COLUMNS_SQL`.
 * That statement stops at 100 columns, which is a cap the flat tree can live with and a
 * detail panel cannot: nothing downstream can tell a cap from a count, so a 140-column
 * table would report 100 columns as a fact.
 *
 * It is a separate statement rather than a reuse for the same reason Oracle's four are:
 * `getSchema()` goes away with #789's last task, and the object surface's reads must not
 * have to be untangled from it then.
 */
const OBJECT_COLUMNS_SQL = `
        SELECT
          COLUMN_NAME AS column_name,
          DATA_TYPE AS data_type,
          IS_NULLABLE AS is_nullable,
          COLUMN_DEFAULT AS column_default,
          COLUMN_KEY AS column_key
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`;

/**
 * One object's foreign keys, with the database each reference lands in.
 *
 * `REFERENCED_TABLE_SCHEMA` is what `SCHEMA_FOREIGN_KEYS_SQL` does not read, and it matters
 * here because the object browser is no longer confined to one database: InnoDB accepts a
 * foreign key into another database, and a bare name for one of those addresses a table in
 * the wrong place.
 */
const OBJECT_FOREIGN_KEYS_SQL = `
        SELECT
          COLUMN_NAME AS column_name,
          REFERENCED_TABLE_SCHEMA AS referenced_schema,
          REFERENCED_TABLE_NAME AS referenced_table,
          REFERENCED_COLUMN_NAME AS referenced_column
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;

/**
 * One object's indexes, ONE ROW PER COLUMN, grouped in code.
 *
 * `SCHEMA_INDEXES_SQL` uses `GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)` and this one
 * deliberately does not: `group_concat_max_len` is 1024 by default (measured on both
 * servers) and the function TRUNCATES silently at it, so a wide composite index would report
 * a column list that is short by an unknowable amount. Reading the rows and grouping them
 * here has no cap at all.
 */
const OBJECT_INDEXES_SQL = `
        SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`;

// ----------------------------------------------------------------------------
// Every object of one kind, described together (#789)
// ----------------------------------------------------------------------------

/**
 * The objects one bulk read describes, ordered, and bounded when the caller bounded it.
 *
 * This is the MEMBERSHIP of the answer and it comes from `information_schema.TABLES`, which
 * is the same view `listObjects` reads and is deliberately NOT the column read. Measured on
 * MySQL 26.7.0: a view whose base table has been dropped keeps its `TABLES` row and has no
 * `COLUMNS` row at all, so a target derived from the column read would silently drop an
 * object the folder lists - the same class of absence standing ruling 5a is about. It is
 * also what lets an object with no columns come back with three empty lists rather than
 * missing.
 *
 * `ORDER BY TABLE_NAME` is what makes a BOUNDED read deterministic, and it is the one sort
 * here that runs under the server's own collation. Measured on MySQL 26.7.0,
 * `information_schema.TABLES.TABLE_NAME` collates `utf8mb3_bin`, so that order is by code
 * point on this server; a fork that collates it case-insensitively would cut a different
 * set, which is why the doc records the order as the SERVER's rather than as ours. It
 * decides WHICH objects a bound keeps and nothing else: the answer is re-sorted by path
 * below, and a caller joins on path rather than on position.
 *
 * `LIMIT ?` is bound and not interpolated. Measured on MySQL 26.7.0 through the binary
 * prepared protocol, a placeholder in a derived table's LIMIT is accepted.
 */
function bulkTargetSql(spellings: number, bounded: boolean): string {
  const placeholders = Array.from({ length: spellings }, () => "?").join(", ");
  return `
          SELECT TABLE_NAME AS name
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN (${placeholders})
          ORDER BY TABLE_NAME${bounded ? "\n          LIMIT ?" : ""}`;
}

/** The four statements one bulk read issues, all four sharing one target set. */
interface BulkDetailStatements {
  readonly target: string;
  readonly columns: string;
  readonly foreignKeys: string;
  readonly indexes: string;
}

/**
 * The three detail reads, each re-pointed from ONE object to the whole target set.
 *
 * They are the `OBJECT_*_SQL` bodies above with `TABLE_NAME = ?` replaced by a join to
 * `bulkTargetSql()`, so every measured decision those statements carry still applies here:
 * `COLUMN_KEY = 'PRI'` is the same primary-key rule `getSchema()` uses, the index read is
 * one row per column rather than a `GROUP_CONCAT` that truncates at 1024 bytes, and the
 * foreign-key read carries `REFERENCED_TABLE_SCHEMA` so a reference that leaves the
 * database can be qualified. Neither the columns nor the indexes are capped: getSchema()'s
 * `LIMIT 100` is an unreported bound and is the defect `ObjectDetailBatch.truncated` exists
 * to prevent. What is bounded here is the number of OBJECTS, by the caller, and it is
 * reported.
 *
 * FOUR round trips for a whole folder rather than THREE PER OBJECT, which is the entire
 * reason this method exists. One statement is not reachable on this engine: mysql2 sends
 * one statement per call, and `JSON_ARRAYAGG` has no ordering guarantee at all, so the
 * column order a person reads would become the order the optimizer happened to produce.
 *
 * The three reads repeat the target subquery rather than joining a temporary of it, and
 * that is safe for one measured reason: a table name is unique within a database, so
 * `ORDER BY TABLE_NAME` is a TOTAL order and all four statements cut the same set. Rows
 * for an object the target's extra `limit + 1` row named are dropped by the caller below
 * rather than by a fourth bound.
 */
function bulkDetailSql(spellings: number, bounded: boolean): BulkDetailStatements {
  const target = bulkTargetSql(spellings, bounded);
  return {
    target,
    columns: `
        SELECT
          d.name AS object_name,
          c.COLUMN_NAME AS column_name,
          c.DATA_TYPE AS data_type,
          c.IS_NULLABLE AS is_nullable,
          c.COLUMN_DEFAULT AS column_default,
          c.COLUMN_KEY AS column_key
        FROM (${target}) d
        JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = ? AND c.TABLE_NAME = d.name
        ORDER BY d.name, c.ORDINAL_POSITION`,
    foreignKeys: `
        SELECT
          d.name AS object_name,
          k.COLUMN_NAME AS column_name,
          k.REFERENCED_TABLE_SCHEMA AS referenced_schema,
          k.REFERENCED_TABLE_NAME AS referenced_table,
          k.REFERENCED_COLUMN_NAME AS referenced_column
        FROM (${target}) d
        JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA = ? AND k.TABLE_NAME = d.name
        WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY d.name, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    indexes: `
        SELECT
          d.name AS object_name,
          s.INDEX_NAME AS index_name,
          s.COLUMN_NAME AS column_name,
          s.NON_UNIQUE AS non_unique
        FROM (${target}) d
        JOIN information_schema.STATISTICS s ON s.TABLE_SCHEMA = ? AND s.TABLE_NAME = d.name
        ORDER BY d.name, s.INDEX_NAME, s.SEQ_IN_INDEX`,
  };
}

/**
 * One entry per kind that HAS columns, which on this engine is the kinds
 * `information_schema.TABLES` resolves.
 *
 * Rendered at module scope for the coverage reason the listing statements are: bun reports
 * the interior lines of a template literal inside a function body as zero-hit in a process
 * that imports this module without calling it.
 */
const BULK_DETAIL_SQL: Record<string, BulkDetailStatements> = Object.fromEntries(
  Object.entries(MYSQL_OBJECT_TYPES)
    .filter(([, spec]) => spec.catalog === "tables")
    .map(([kind, spec]) => [kind, bulkDetailSql(spec.types.length, false)]),
);

/** The same four statements with the target bounded. */
const BULK_DETAIL_SQL_BOUNDED: Record<string, BulkDetailStatements> = Object.fromEntries(
  Object.entries(MYSQL_OBJECT_TYPES)
    .filter(([, spec]) => spec.catalog === "tables")
    .map(([kind, spec]) => [kind, bulkDetailSql(spec.types.length, true)]),
);

/**
 * The provider's own sentence for what stopped a bulk read, phrased for a person reading a
 * partial answer. It is the CALLER's limit that bit and never a bound this file invented:
 * an unbounded call has no limit to report and never carries this.
 */
const BULK_TRUNCATION_REASON = "column read limit reached";

// ----------------------------------------------------------------------------
// The declaration, which is a function of the SERVER and not of the type id
// ----------------------------------------------------------------------------

/**
 * The six kinds every MySQL-protocol server has.
 *
 * No `index` kind, deliberately. MySQL's own dictionary models an index as an attribute of
 * the table it is on - `information_schema.STATISTICS` is keyed by `TABLE_SCHEMA` and
 * `TABLE_NAME`, and an index cannot exist without them - so it belongs in
 * `describeObject`'s output, where it is, rather than in a container-level folder.
 */
const MYSQL_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
  // No `acceptsRowWrites`. MySQL takes an UPDATE against a simple updatable view and
  // refuses it against a view with an aggregate, a UNION or a DISTINCT, which is a
  // per-OBJECT fact this per-kind declaration cannot state; claiming it would offer an
  // import target that fails on most views in most databases.
  { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  { id: "procedure", role: "routine", label: "Stored Procedure", labelPlural: "Stored Procedures" },
  { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
  { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
  { id: "event", role: "config", label: "Event", labelPlural: "Events" },
];

/**
 * The two kinds MariaDB has and MySQL does not have at all.
 *
 * A package's members are DECLARED and not browsable in Phase 1: `childKinds` is a true
 * statement about the engine, and the provider surface is container-scoped end to end, so
 * a Procedures folder under a package would render, never badge, and expand to nothing.
 */
const MARIADB_EXTRA_OBJECT_KINDS: readonly ObjectKindSpec[] = [
  {
    id: "package",
    role: "group",
    label: "Package",
    labelPlural: "Packages",
    childKinds: ["procedure", "function"],
  },
  { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" },
];

/**
 * MariaDB's own name inside its `VERSION()` string.
 *
 * Narrower than `SELF_IDENTIFYING_VERSION` above on purpose: that one asks "did the server
 * name a vendor at all", and this one asks "is this server MariaDB", which is a different
 * question with a different answer for TiDB, Vitess and OceanBase. All three self-identify
 * and none of them has a package or a sequence.
 */
const MARIADB_VERSION = /mariadb/i;

/**
 * The kinds a server with this `VERSION()` string has.
 *
 * THIS IS THE ONE PROVIDER WHOSE `objectKinds` IS NOT A CONSTANT, and the resolution is from
 * the server rather than from the type id because there is no second type id to resolve
 * from: `DatabaseType` has no `mariadb` entry and choosing MySQL in the connection dialog is
 * the documented way to reach a MariaDB server (docs/providers/mysql.md 1.1). Branching on
 * the type id here would be both forbidden inside `src/lib/db` and unable to tell the two
 * servers apart in the first place.
 *
 * An unmeasured version answers the MySQL set, which is what an unconnected provider gets:
 * `POST /api/db/provider-meta` reads capabilities off a provider it never connects (#457).
 * The MySQL set is the safe default of the two, because declaring a kind the server does not
 * have draws a folder that can never fill, while missing one costs two folders a MariaDB
 * user regains the moment the connection is live.
 */
function objectKindsFor(version: string | undefined): readonly ObjectKindSpec[] {
  if (version === undefined || !MARIADB_VERSION.test(version)) return MYSQL_OBJECT_KINDS;
  return [...MYSQL_OBJECT_KINDS, ...MARIADB_EXTRA_OBJECT_KINDS];
}

/**
 * What this server calls itself, or `undefined` when it would not say. Run once per
 * `connect()`, on the connection the pool check already holds.
 *
 * Nothing here rejects, for the reason `probeExplainFormat` does not: a version string the
 * server would not give is a fact about which folders the browser can draw, not about the
 * connection, and `connect()` must not fail for it. The cost of the absent case is
 * `objectKindsFor`'s MySQL default, which every server in this family does have.
 */
const probeServerVersion = async (queryable: MySQLQueryable): Promise<string | undefined> => {
  try {
    const [rows] = await runStatement(queryable, "SELECT VERSION() AS version");
    const version = rows[0]?.version;
    return version === null || version === undefined ? undefined : String(version);
  } catch {
    // Refused, so the flavour is unmeasured. The capability this produces IS the report.
    return undefined;
  }
};

// ----------------------------------------------------------------------------
// Object surface shapes and derivations
// ----------------------------------------------------------------------------

/** One row of `CONTAINERS_SQL`. `is_session_default` is 1, 0 or NULL. */
interface ContainerRow extends RowDataPacket {
  name: string;
  is_session_default: number | null;
}

/** One row of `COUNTS_SQL`: a kind id and how many of it the database holds. */
interface KindCountRow extends RowDataPacket {
  kind: string;
  n: number;
}

/**
 * One listed object, from whichever of the four listing statements answered.
 *
 * `parent` is selected by the trigger listing alone and `row_count` / `size_bytes` by the
 * relation listing alone, which is what lets one mapper serve all four.
 */
interface ObjectRow extends RowDataPacket {
  name: string;
  parent?: string | null;
  row_count?: string | number | null;
  size_bytes?: string | number | null;
}

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()` reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by two
 * different rules. `containerDepth()` is what decides, never `containerLevels.length`.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` belonging to the declared container level `id`.
 *
 * NEVER `path[0]`, and that is the general form of a defect this file shipped three times in
 * two narrower shapes. A container level's POSITION is a property of the declaration, not a
 * constant: MySQL declares `[schema]`, so the schema is the first segment here, and the five
 * two-level engines that copy this file declare `[catalog, schema]`, where `path[0]` is the
 * CATALOG and binding it as the schema narrows every read to a database that does not exist.
 * The three earlier shapes were `container.length !== 1`, `path[1]` for the object name, and
 * `path[0]` for the schema; all three are depth-identical on a one-level engine, which is
 * exactly why each survived a review. Standing ruling 5g forbids the class, not the instances.
 *
 * Both failure modes raise through one guard: a declaration with no level of this `id`, and a
 * path too short to carry it. Neither may fall through to `undefined`, which mysql2 rejects
 * outright as a bind and which would otherwise surface as a driver error naming neither the
 * path nor the method.
 */
function containerSegment(
  capabilities: ProviderCapabilities,
  path: readonly string[],
  id: ContainerLevelSpec["id"],
): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === id);
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A MySQL path needs a "${id}" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      "mysql",
    );
  }
  return segment;
}

/**
 * The one database a container path names on this engine.
 *
 * The expected depth is read through `containerDepth()` and the segment NAMES come from the
 * declared level labels, so the check and its message are the same array and a provider
 * copying this file cannot inherit a hardcoded `1`. That matters even though MySQL declares
 * exactly one level: `container.length !== 1` is behaviour-identical here and silently wrong
 * on the five two-level engines that copy this file, so no suite on a one-level engine can
 * tell the two spellings apart.
 *
 * A path of any other length is a caller that built it from another engine's shape, and it
 * raises rather than reading a segment and carrying on, because `undefined` bound to `?`
 * would answer an empty folder that looks exactly like a database holding nothing - and
 * mysql2 rejects `undefined` outright, which would surface as a driver error naming neither
 * the path nor the method. The segment itself comes from `containerSegment()`, so which
 * position holds the schema is read off the declaration rather than assumed.
 */
function containerSchema(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `A MySQL container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      "mysql",
    );
  }
  return containerSegment(capabilities, container, "schema");
}

/**
 * Every declared kind seeded at zero, before any row is read.
 *
 * Seeding is what makes "this server has this kind and this database holds none" render as a
 * 0 badge. Building the record from the GROUP BY rows alone would leave the kind out
 * entirely, and an absent kind already means something else and stronger: the server has no
 * such concept, so the tree draws no folder at all.
 */
function seedZeroCounts(kinds: readonly ObjectKindSpec[]): Record<string, KindCount> {
  return Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 } as KindCount]));
}

/**
 * Overwrites the seeded zeros with what the GROUP BY actually answered.
 *
 * A kind that was never seeded is SKIPPED, and on this provider that is a live case rather
 * than defensive programming: the counting statement is the same text on both servers, so a
 * MariaDB server whose version probe came back empty answers `sequence` and `package` rows
 * that the MySQL declaration has no folder for. The DECLARATION decides which folders exist
 * and a catalog row cannot add one, which is also what keeps
 * `tests/helpers/object-surface-conformance.ts`'s "never answers for an undeclared kind"
 * true from the provider's side.
 *
 * `Object.hasOwn` and not `in`, which is what makes that guarantee absolute rather than
 * nearly so: `in` walks the prototype chain, so a catalog row whose kind read `toString` or
 * `constructor` would pass the test and write a folder the provider never declared.
 */
function applyKindCounts(counts: Record<string, KindCount>, rows: readonly KindCountRow[]): void {
  for (const row of rows) {
    if (Object.hasOwn(counts, row.kind)) counts[row.kind] = { count: Number(row.n) };
  }
}

/**
 * The server's own sentence, verbatim, against every kind the failed read covered.
 *
 * Deliberately NOT through `mapDatabaseError`. That mapper gives a THROWN error a type and
 * this product's prefix, and nothing here throws: the sentence is rendered to a person as
 * the reason a folder has no number, so prefixing it would put our words in front of the
 * server's. A refused read is never 0 - "SELECT command denied to user" and "this database
 * holds no tables" are different facts and `KindCount` is the type that keeps them apart.
 */
function unavailableCounts(ids: readonly string[], error: unknown): Record<string, KindCount> {
  const reason = error instanceof Error ? error.message : String(error);
  return Object.fromEntries(ids.map((id) => [id, { unavailable: reason } as KindCount]));
}

/**
 * Which statement answers for one kind, or nothing when this server has no such kind.
 *
 * Four shapes, and the kind decides which: a trigger reads the trigger view for the table it
 * hangs off, an event reads the event view, and the other six are one row each out of
 * `TABLES` or `ROUTINES` with the type BOUND rather than interpolated - so nothing a caller
 * supplied ever reaches the statement text.
 */
function objectListingStatement(schema: string, kind: string): { sql: string; params: unknown[] } | undefined {
  if (kind === "trigger") return { sql: LIST_TRIGGERS_SQL, params: [schema] };
  if (kind === "event") return { sql: LIST_EVENTS_SQL, params: [schema] };
  const spec = MYSQL_OBJECT_TYPES[kind];
  if (spec === undefined) return undefined;
  return { sql: LIST_OBJECT_SQL[kind], params: [schema, ...spec.types] };
}

/**
 * Where one listed object is addressed.
 *
 * Built from the ROW rather than from the kind id, so the four listing statements share one
 * rule: a `parent` column adds a nesting segment and nothing else does. That is what the
 * `attachedTo: "table"` declaration states.
 *
 * A NULL parent collapses to the container-level address, and on MySQL that is a complete
 * address rather than a degraded one: a trigger name is unique per DATABASE (measured,
 * ER_TRG_ALREADY_EXISTS), so `[database, trigger]` addresses it. No measured server puts a
 * NULL there - `information_schema.TRIGGERS` has no row without a base table - which is why
 * this is one expression and not two shapes.
 */
function objectPath(schema: string, row: ObjectRow): string[] {
  const parent = row.parent;
  if (parent === undefined || parent === null) return [schema, row.name];
  return [schema, parent, row.name];
}

/**
 * Two paths compared SEGMENT BY SEGMENT, so a sort is over the address and never over one
 * joined string.
 *
 * `JSON.stringify(path)` is the obvious spelling and it is wrong twice. At MIXED DEPTH the
 * deeper path sorts first, because the separator `,` (0x2C) is below the terminator `]`
 * (0x5D): `["app","orders","orders_stamp"]` would sort above `["app","orders"]`, putting a
 * trigger above the row it hangs off. And JSON ESCAPES, so a name holding a quote, a
 * backslash or a control character sorts by its escape sequence rather than by its own code
 * points, which a docblock claiming a code-point sort of the segments would be lying about.
 *
 * A shorter path that is a prefix of a longer one sorts first, which is the ordering the
 * tree wants: a container-level row above the rows nested under its name.
 */
function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return left.length - right.length;
}

/** One row of the column read, single or bulk. `object_name` is present only in the bulk one. */
interface DetailColumnRow extends RowDataPacket {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  column_key: string;
}

/** One referencing column of one foreign key, with the database the reference lands in. */
interface DetailForeignKeyRow extends RowDataPacket {
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
}

/** One COLUMN of one index. The index itself is grouped out of these rows. */
interface DetailIndexRow extends RowDataPacket {
  index_name: string;
  column_name: string;
  non_unique: number;
}

/** The three row sets one object's detail is built from, whichever read produced them. */
interface DetailRows {
  readonly columns: readonly DetailColumnRow[];
  readonly foreignKeys: readonly DetailForeignKeyRow[];
  readonly indexes: readonly DetailIndexRow[];
}

/**
 * Three catalog row sets turned into one `ObjectDetail`, shared by the single and the bulk
 * read.
 *
 * ONE function because the two reads select the same columns from the same three views and
 * a caller joins their results together: two copies of this mapping would be two chances
 * for the bulk read to spell a foreign key differently from the single read of the SAME
 * table, and nothing downstream could tell which one was right.
 *
 * `NON_UNIQUE` is 0 for a unique index, so the flag is its negation and not its value, and
 * the columns of one index arrive in `SEQ_IN_INDEX` order because both statements order by
 * it.
 *
 * `referencedTable` is spelled the way `getSchema()` spells it - bare within the container,
 * qualified outside it - because `ForeignKeySchema` carries one string and both surfaces
 * are live through Phase 1. The phase that removes `getSchema` is where that string becomes
 * a path. Qualifying the cross-database case is not cosmetic: a bare name there addresses a
 * table in the wrong database, and InnoDB does accept a foreign key into another one.
 */
function objectDetailFromRows(path: readonly string[], schema: string, rows: DetailRows): ObjectDetail {
  const columns: ColumnSchema[] = rows.columns.map((row) => ({
    name: row.column_name,
    type: row.data_type,
    nullable: row.is_nullable === "YES",
    isPrimary: row.column_key === "PRI",
    defaultValue: row.column_default ?? undefined,
  }));

  const byIndex = new Map<string, IndexSchema>();
  for (const row of rows.indexes) {
    const name = String(row.index_name);
    const index = byIndex.get(name) ?? { name, columns: [], unique: Number(row.non_unique) === 0 };
    index.columns.push(String(row.column_name));
    byIndex.set(name, index);
  }

  const foreignKeys: ForeignKeySchema[] = rows.foreignKeys.map((row) => ({
    columnName: row.column_name,
    referencedTable:
      row.referenced_schema === schema
        ? String(row.referenced_table)
        : `${String(row.referenced_schema)}.${String(row.referenced_table)}`,
    referencedColumn: row.referenced_column,
  }));

  return { path: [...path], columns, indexes: [...byIndex.values()], foreignKeys };
}

/**
 * Whether this kind's objects can have columns, an index or a foreign key on this server.
 *
 * ONE rule for the single read and the bulk one, keyed on the CATALOG each kind is read
 * from rather than on `role === "relation"`. That is what makes a MariaDB SEQUENCE come out
 * right: it is `config`, since nobody selects rows from it, and it still has eight real
 * columns because a sequence is a table underneath (measured on 12.3.2).
 *
 * `Object.hasOwn` and not a bare index: a kind id is an OPEN string, and
 * `MYSQL_OBJECT_TYPES["constructor"]` answers an object off the prototype chain.
 */
function hasColumns(kind: string): boolean {
  return Object.hasOwn(MYSQL_OBJECT_TYPES, kind) && MYSQL_OBJECT_TYPES[kind].catalog === "tables";
}

/** The rows of one bulk read grouped by the object each belongs to. */
function byObjectName<T extends RowDataPacket>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const name = String(row.object_name);
    const held = grouped.get(name);
    if (held === undefined) grouped.set(name, [row]);
    else held.push(row);
  }
  return grouped;
}

// ============================================================================
// MySQL Provider
// ============================================================================

export class MySQLProvider extends SQLBaseProvider {
  private pool: Pool | null = null;

  /**
   * The EXPLAIN grammar this server accepts, measured by `probeExplainFormat()` at
   * connect. It starts as MySQL's own grammar, which is what this provider declared
   * unconditionally before the probe existed and is still the right answer for an
   * unconnected provider: `POST /api/db/provider-meta` reads capabilities off a
   * provider it never connects (#457), so the pre-flight the client does keeps
   * exactly the behaviour it had.
   */
  private measuredExplainFormat: ExplainFormat | undefined = "mysql-json";

  /**
   * What this server called itself, measured by `probeServerVersion()` at connect, and the
   * only thing that decides whether `objectKinds` carries MariaDB's two extra kinds. It
   * starts undefined, which `objectKindsFor()` reads as the MySQL set: an unconnected
   * provider has not asked any server anything yet.
   */
  private measuredServerVersion: string | undefined;

  // Transaction support: dedicated connection held outside pool
  private txConn: PoolConnection | null = null;
  private txActive = false;
  private txTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly TX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 3306,
      // Measured at connect, not declared per type id: the MySQL-wire relatives do
      // not all accept `EXPLAIN FORMAT=JSON` (#574). The key is spread in rather than
      // set to `undefined` because `ProviderCapabilities.explainFormat` is present iff
      // `supportsExplain` is true, and the provider tests assert that as a shape.
      supportsExplain: this.measuredExplainFormat !== undefined,
      ...(this.measuredExplainFormat === undefined ? {} : { explainFormat: this.measuredExplainFormat }),
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // The driver's own connection.beginTransaction() over one held connection.
      supportsTransactions: true,
      maintenanceOperations: ["analyze", "optimize", "check", "kill"],
      // MySQL has no VACUUM, and every statement it does have names tables:
      // `ANALYZE/OPTIMIZE/CHECK TABLE <t>` with a target, the same verb over every
      // table in the database without one (`getAllTablesForMaintenance`). `kill`
      // takes a connection id from the Sessions panel.
      maintenanceOperationSpecs: {
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        optimize: { label: "Optimize Table", perEntity: true, global: true },
        check: { label: "Check Table", perEntity: true, global: true },
        kill: { label: "Kill Connection", perEntity: false, global: false },
      },
      // One level, and on MySQL the level IS a database: a schema is not a thing created
      // beside a database, the two words name the same object. `catalog` is not a second
      // level here - MySQL has exactly one and `information_schema.SCHEMATA` is what a
      // catalog would contain.
      containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
      // Six kinds on MySQL and eight on MariaDB, resolved from what the server called
      // itself and never from the type id (#789). See `objectKindsFor`.
      objectKinds: objectKindsFor(this.measuredServerVersion),
    };
  }

  /**
   * The vacuum slot and the slow-query empty state; every other label is the SQL
   * default and right.
   *
   * MySQL rendered the base default *"Vacuum Table"* in the explorer's per-row menu
   * and the base *"Run Vacuum" / "Reclaim Space"* copy on the Operations tab, for an
   * engine whose operations are `analyze`/`optimize`/`check`/`kill` (#496). The words
   * below name what MySQL actually runs, and `vacuumActionOperation` says which
   * operation the surfaces should send for them.
   *
   * `getSlowQueries()` reads `performance_schema.events_statements_summary_by_digest`,
   * and the panel used to name PostgreSQL's extension in its empty state (#463) - a
   * statement store MySQL does not have under any name.
   *
   * The sentence describes the SOURCE and what an empty list means about it, and stops
   * there. It cannot do more: `QueriesTab` renders this one fixed string for every empty
   * list whatever produced it, so any instruction in it is addressed to causes it cannot
   * tell apart. It used to end "enable the Performance Schema to see them", which named
   * the one cause that never reaches the failure path at all (off-ness answers 0 rows,
   * measured; see `getSlowQueries()`) and was unactionable advice for the ones that do -
   * a denied grant, or a tenant with no `performance_schema` database. Those now reject
   * instead of emptying, and the panel shows the server's own reason through
   * `PanelUnavailable`, which is a different string on a different branch.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      vacuumAction: "Optimize Table",
      vacuumActionOperation: "optimize",
      vacuumGlobalLabel: "Run Optimize",
      vacuumGlobalTitle: "Optimize Tables",
      vacuumGlobalDesc:
        "Runs OPTIMIZE TABLE over every table in the database, rebuilding its storage and reclaiming the space deleted rows left behind.",
      slowQueriesEmptyState:
        "Query stats come from performance_schema.events_statements_summary_by_digest for this database. An empty list means it recorded nothing - the Performance Schema is off, or nothing has run against this database yet.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for MySQL", "mysql");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for MySQL", "mysql");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      // No pool `error` listener here, unlike the PostgreSQL and SQL Server providers
      // (#298): mysql2's pool has no pool-level `error` event to listen for. Audited in
      // the installed package — `mysql2/lib/base/pool.js` emits only `acquire`,
      // `connection`, `enqueue` and `release`, the promise wrapper forwards exactly those
      // four (`lib/promise/pool.js`), and `typings/mysql/lib/Pool.d.ts` types no `error`
      // overload. A connection that fails reports through the call that holds it.
      this.pool = mysql.createPool(this.buildPoolConfig());

      const conn = await this.pool.getConnection();
      // The pool check already holds a connection, so the two probes cost no extra
      // acquisition. Neither rejects, so the release below is never skipped.
      this.measuredExplainFormat = await probeExplainFormat(conn);
      // Which server this is, which is what decides the object-kind declaration (#789).
      // Measured rather than derived from the type id, because there is no `mariadb` type
      // id to derive from.
      this.measuredServerVersion = await probeServerVersion(conn);
      conn.release();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to MySQL: ${error instanceof Error ? error.message : error}`,
        "mysql",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.setConnected(false);
    }
  }

  private buildPoolConfig(): mysql.PoolOptions {
    const baseConfig: mysql.PoolOptions = {
      connectionLimit: this.poolConfig.max,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    };

    if (this.config.connectionString) {
      return {
        ...baseConfig,
        uri: this.config.connectionString,
      };
    }

    return {
      ...baseConfig,
      host: this.config.host,
      port: this.config.port ?? 3306,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.buildSSLConfig(),
      timezone: this.options.timezone ?? "Z",
    };
  }

  private buildSSLConfig(): mysql.SslOptions | undefined {
    const connSSL = this.config.ssl;

    if (connSSL) {
      if (connSSL.mode === "disable") return undefined;

      const ssl: mysql.SslOptions = {
        // Every mode except `require` verifies (D26): `verify-system` checks the chain against
        // the trust store the runtime already has - no `ca` is set below, so Node's bundled
        // roots decide - while `verify-ca`/`verify-full` check it against the PEM pasted into
        // the form. `require` is the one mode that encrypts without checking anything.
        rejectUnauthorized: connSSL.mode !== "require",
      };

      if (connSSL.caCert) ssl.ca = connSSL.caCert;
      if (connSSL.clientCert) ssl.cert = connSSL.clientCert;
      if (connSSL.clientKey) ssl.key = connSSL.clientKey;

      return ssl;
    }

    if (this.shouldEnableSSL()) {
      return { rejectUnauthorized: false };
    }

    return undefined;
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  /**
   * Build the query envelope from what mysql2 handed back.
   *
   * `execute`'s first return value is an ARRAY of rows only for a statement that
   * produced a result set. For everything else - DDL, INSERT, UPDATE, DELETE - it
   * is a `ResultSetHeader` object and `fields` is `undefined`. Measured verbatim
   * against mysql 26.7.0 on 2026-08-23, `INSERT INTO r5_hdr (note) VALUES
   * ('a'),('b')` answers
   * `{fieldCount:0,affectedRows:2,insertId:1,info:"Records: 2  Duplicates: 0  Warnings: 0",serverStatus:2,warningStatus:0,changedRows:0}`.
   *
   * Calling `.map` on that object threw `result.rows.map is not a function` AFTER
   * the server had already applied the statement, so every DDL and DML statement
   * run from the editor reported a failure for work that had landed - the answer
   * that makes a user retry and double-apply it.
   *
   * The empty-result answer follows what the other SQL providers here already do:
   * no rows, no fields, and the affected-row count in `rowCount` (mssql reports
   * `rowsAffected[0]`, sqlite `changes`, postgres `pg`'s own `rowCount`).
   * `insertId`, `changedRows` and `warningStatus` are deliberately dropped:
   * `QueryResult` models none of them, and `rowCount` is the field the results
   * footer renders. `affectedRows` is the matched count, which is why a no-op
   * UPDATE still reports 1 - matching mssql, whose `rowsAffected` counts the same
   * way.
   */
  private buildQueryResult(rows: unknown, fields: FieldPacket[] | undefined, executionTime: number): QueryResult {
    if (!Array.isArray(rows)) {
      const header = rows as { affectedRows?: number };
      return {
        rows: [],
        fields: [],
        rowCount: header.affectedRows ?? 0,
        executionTime,
      };
    }

    return {
      // The driver's rows are handed on UNCHANGED, binary values included.
      // A `sanitizeRow` used to walk every row and turn a `Buffer` into the string
      // `0x<hex>` (and an empty one into `""`), because the JSON a Buffer serializes
      // to - `{"type":"Buffer","data":[…]}` - was unreadable. `src/lib/export/binary.ts`
      // now READS that exact shape (#469), which is how Postgres's `bytea` reaches the
      // grid, the row sheet, the CSV and the SQL export, so the string was the only
      // thing standing between a MySQL BLOB and the same treatment: the grid showed
      // `0x0102ab` where Postgres showed `\x0102ab`, and the export wrote the eight
      // characters `'0x0102ab'` into a BLOB column rather than the three bytes.
      // Measured against MySQL 26.7.0 on 2026-08-24; see docs/providers/mysql.md §3.3.
      rows: rows as Record<string, unknown>[],
      fields: fields?.map((f: FieldPacket) => f.name) ?? [],
      ...mysqlColumnTypes(fields),
      rowCount: rows.length,
      executionTime,
    };
  }

  // Track running query thread IDs for cancellation
  private runningQueryThreadIds = new Map<string, number>();

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        const conn = await this.pool!.getConnection();
        try {
          // Track thread ID for cancellation support
          if (queryId) {
            this.runningQueryThreadIds.set(queryId, conn.threadId);
          }
          const [rows, fields] = await runStatement(conn, sql, params);
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, "mysql", sql);
        } finally {
          if (queryId) this.runningQueryThreadIds.delete(queryId);
          conn.release();
        }
      });

      return this.buildQueryResult(result.rows, result.fields, executionTime);
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const threadId = this.runningQueryThreadIds.get(queryId);
    if (!threadId) return false;

    try {
      await runStatement(this.pool!, `KILL QUERY ${threadId}`);
      return true;
    } catch (error) {
      console.error("[MySQL] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  private clearTxTimeout(): void {
    if (this.txTimeout) {
      clearTimeout(this.txTimeout);
      this.txTimeout = null;
    }
  }

  /**
   * Force-expire an active transaction (auto-rollback).
   * Called by the timeout timer, but also available for testing.
   */
  public async expireTransaction(): Promise<void> {
    if (this.txActive && this.txConn) {
      console.warn("[MySQL] Transaction timed out, auto-rolling back");
      try {
        await this.txConn.rollback();
      } catch {
        /* ignore */
      } finally {
        this.txConn.release();
        this.txConn = null;
        this.txActive = false;
        this.clearTxTimeout();
      }
    }
  }

  public async beginTransaction(): Promise<void> {
    this.ensureConnected();
    if (this.txActive) throw new QueryError("Transaction already active", "mysql");
    this.txConn = await this.pool!.getConnection();
    await this.txConn.beginTransaction();
    this.txActive = true;

    // Auto-rollback after timeout to prevent leaked locks
    this.txTimeout = setTimeout(() => {
      void this.expireTransaction();
    }, MySQLProvider.TX_TIMEOUT_MS);
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");
    this.clearTxTimeout();
    try {
      await this.txConn.commit();
    } finally {
      this.txConn.release();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");
    this.clearTxTimeout();
    try {
      await this.txConn.rollback();
    } finally {
      this.txConn.release();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const [rows, fields] = await runStatement(this.txConn!, sql, params);
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, "mysql", sql);
        }
      });

      return this.buildQueryResult(result.rows, result.fields, executionTime);
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const [tablesRows] = await runStatement(conn, SCHEMA_TABLES_SQL, [this.config.database]);

      const schemas: TableSchema[] = [];

      for (const row of tablesRows) {
        const tableName = row.table_name;
        const rowCount = parseInt(row.row_count || "0");
        const sizeBytes = parseInt(row.total_size || "0");

        const [columnsRows] = await runStatement(conn, SCHEMA_COLUMNS_SQL, [this.config.database, tableName]);

        const [fkRows] = await runStatement(conn, SCHEMA_FOREIGN_KEYS_SQL, [this.config.database, tableName]);

        const [indexRows] = await runStatement(conn, SCHEMA_INDEXES_SQL, [this.config.database, tableName]);

        schemas.push({
          name: tableName,
          rowCount,
          size: formatBytes(sizeBytes),
          columns: columnsRows.map((col) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            isPrimary: col.column_key === "PRI",
            defaultValue: col.column_default ?? undefined,
          })),
          indexes: indexRows.map((idx) => ({
            name: idx.index_name,
            columns: idx.columns?.split(",") ?? [],
            unique: Boolean(idx.is_unique),
          })),
          foreignKeys: fkRows.map((fk) => ({
            columnName: fk.column_name,
            referencedTable: fk.referenced_table,
            referencedColumn: fk.referenced_column,
          })),
        });
      }

      return schemas;
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Object surface (#789)
  // ============================================================================

  /**
   * The databases this connection can see. One level, so `parent` can only ever name a
   * database, and nothing nests under one here - that answers `[]` rather than raising,
   * because "this level has no children" is a true statement about MySQL and not a caller
   * mistake.
   *
   * This is what ends the single-database confinement section 3.2 of the provider doc
   * records: `getSchema()` binds `TABLE_SCHEMA = config.database` in all four of its reads,
   * and this one is bound to nothing at all.
   */
  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    this.ensureConnected();
    if (parent !== undefined && parent.length > 0) return [];

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement<ContainerRow[]>(conn, CONTAINERS_SQL);
      return rows.map((row) => ({
        path: [row.name],
        name: row.name,
        level: 0,
        // 1, 0 or NULL, and only 1 is the session's own database.
        isSessionDefault: Number(row.is_session_default) === 1,
      }));
    } finally {
      conn.release();
    }
  }

  /**
   * How many objects of each declared kind one database holds, in one statement.
   *
   * Three outcomes, and the type keeps all three apart. A kind the GROUP BY answered for
   * carries its count. A kind it did not carries `{ count: 0 }`, because it was seeded
   * before the read. A kind whose read was refused carries the server's own sentence, so the
   * object browser can say why a folder has no number instead of showing a zero nobody
   * measured.
   *
   * There is no partial outcome to report and no retry that could produce one. The four
   * `information_schema` views are one statement, so the server answers it whole or not at
   * all; a caller who can see only part of a database gets a real count of the part they can
   * see, because `information_schema` FILTERS by privilege rather than refusing.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const schema = containerSchema(capabilities, container);
    const declared = declaredKinds(capabilities);
    const counts = seedZeroCounts(declared);

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement<KindCountRow[]>(conn, COUNTS_SQL, [schema, schema, schema, schema]);
      applyKindCounts(counts, rows);
      return counts;
    } catch (error) {
      return unavailableCounts(
        declared.map((kind) => kind.id),
        error,
      );
    } finally {
      conn.release();
    }
  }

  /**
   * One object-surface read, mapped against THE STATEMENT THE SERVER RECEIVED.
   *
   * Shared by `listObjects` and `describeObject` so a failure in the third of three detail
   * reads does not quote the first one's text at whoever has to read the message.
   */
  private async runObjectQuery<T extends RowDataPacket[]>(
    conn: PoolConnection,
    sql: string,
    params: unknown[],
  ): Promise<T> {
    try {
      const [rows] = await runStatement<T>(conn, sql, params);
      return rows;
    } catch (error) {
      throw mapDatabaseError(error, "mysql", sql);
    }
  }

  /**
   * The objects of one kind in one database, names only.
   *
   * Ordering is done here rather than with an `ORDER BY`, and that is deliberate. Four
   * statements answer these listings, so four `ORDER BY` clauses would be four chances to
   * disagree; and a SQL sort runs under the column's own collation, which is case
   * insensitive on the `information_schema` views and case sensitive on a server started
   * with a binary collation, so the same database would come back in two orders on two
   * servers. A code-point sort here is one rule and the same rule everywhere.
   *
   * By PATH and not by name, because it is the address that has to be stable: sorting by the
   * address groups a table's triggers together under that table.
   */
  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const schema = containerSchema(capabilities, container);
    // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
    // "is this kind declared" from whether a listing statement exists would make the two
    // methods disagree, and would report "declares no object kind" about a kind
    // `objectKinds` does declare - which on THIS provider is a live case, because
    // `MYSQL_OBJECT_TYPES` carries MariaDB's two entries whatever server is connected.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`MySQL declares no object kind "${kind}"`, "mysql");
    }
    const statement = objectListingStatement(schema, kind);
    if (statement === undefined) {
      throw new QueryError(`MySQL declares the kind "${kind}" but has no statement that lists it`, "mysql");
    }

    const conn = await this.pool!.getConnection();
    try {
      const rows = await this.runObjectQuery<ObjectRow[]>(conn, statement.sql, statement.params);
      return rows
        .map((row) => ({
          path: objectPath(schema, row),
          name: row.name,
          kind,
          // Absent for every kind but a relation, and absent for a VIEW too: measured,
          // `information_schema.TABLES` answers NULL in all three columns for a view, and a
          // view reported as 0 rows and 0 bytes would be a measurement nobody took.
          rowCount: measuredNumber(row.row_count),
          sizeBytes: measuredNumber(row.size_bytes),
        }))
        .sort((left, right) => comparePaths(left.path, right.path));
    } finally {
      conn.release();
    }
  }

  /**
   * Columns, indexes and foreign keys for one object of one KIND.
   *
   * The kind decides everything and nothing here reads the name to work out what it is
   * holding. Only the kinds `information_schema.TABLES` resolves - the `tables` entries of
   * `MYSQL_OBJECT_TYPES` - have any of the three, so a routine, a trigger, an event and a
   * MariaDB package answer three empty arrays without a round trip. That is a true fact
   * about those kinds rather than a failed read, and
   * `tests/helpers/object-surface-conformance.ts` states the same rule from the caller's
   * side.
   *
   * A MariaDB SEQUENCE is in the `tables` group and therefore DOES describe: measured on
   * 12.3.2, `information_schema.COLUMNS` answers eight real columns for one
   * (`next_not_cached_value`, `minimum_value`, ...), because a sequence is a table
   * underneath. Keying this on the catalog rather than on `role === "relation"` is what
   * makes that come out right, and a sequence is `config` rather than `relation` because
   * nobody selects rows from it.
   *
   * Without the kind the same answer would come out by accident, and only sometimes. The
   * three reads key the LAST path segment against `TABLE_NAME`, so a procedure returned
   * nothing only because no table was called that - and on MySQL a table and a procedure
   * CAN share a name in one database. Measured on 26.7.0: `app.order_archive` is both, so a
   * name-driven describe would have handed the procedure the table's columns as if they were
   * its own. The kind removes the coincidence.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    const spec = findKind(capabilities, kind);
    if (spec === undefined) {
      throw new QueryError(`MySQL declares no object kind "${kind}"`, "mysql");
    }

    // Derived, not counted. The depth is read through `containerDepth()` so absent and empty
    // cannot be answered differently here than anywhere else, and the segment NAMES are the
    // declared level labels sliced to that same depth, so the message and the check cannot
    // disagree. An attached kind takes either depth, because `objectPath` collapses a
    // parentless trigger onto the container-level address.
    const levels = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
    const shapes =
      spec.attachedTo === undefined
        ? [[...levels, "name"]]
        : [
            [...levels, spec.attachedTo, "name"],
            [...levels, "name"],
          ];
    if (!shapes.some((shape) => shape.length === path.length)) {
      throw new QueryError(
        `A MySQL "${kind}" path is ${shapes.map((shape) => `[${shape.join(", ")}]`).join(" or ")}, ` +
          `received ${JSON.stringify(path)}`,
        "mysql",
      );
    }

    if (!hasColumns(kind)) {
      return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
    }

    // Three narrow reads, each bound to ONE database and ONE object, which is what the four
    // `SCHEMA_*_SQL` statements are not: those are the N+1 `getSchema()` issues per table.
    //
    // Neither bind is positional. The schema comes from the segment the DECLARATION assigns to
    // the `schema` level, and the object's own name is the LAST segment. On MySQL those are
    // `path[0]` and `path[1]`; on the five two-level engines that copy this file `path[0]` is
    // the catalog and `path[1]` is a container segment, so both literals would narrow these
    // three reads to an object that does not exist.
    const schema = containerSegment(capabilities, path, "schema");
    const binds = [schema, path[path.length - 1]];
    const conn = await this.pool!.getConnection();
    try {
      const columns = await this.runObjectQuery<DetailColumnRow[]>(conn, OBJECT_COLUMNS_SQL, binds);
      const foreignKeys = await this.runObjectQuery<DetailForeignKeyRow[]>(conn, OBJECT_FOREIGN_KEYS_SQL, binds);
      const indexes = await this.runObjectQuery<DetailIndexRow[]>(conn, OBJECT_INDEXES_SQL, binds);
      return objectDetailFromRows(path, schema, { columns, foreignKeys, indexes });
    } finally {
      conn.release();
    }
  }

  /**
   * Columns, indexes and foreign keys for EVERY object of one kind in one database (#789).
   *
   * FOUR round trips for the whole folder, which is the entire reason this method exists:
   * the inventory route built the same answer as one `describeObject` per object - three
   * statements each, up to 5000 objects - and removed it as an N+1. The four are the target
   * read plus the three `bulkDetailSql()` reads, and the count does not grow with the
   * folder.
   *
   * Only the kinds `information_schema.TABLES` resolves can have any of the three, so a
   * routine, a trigger, an event and a MariaDB package answer an empty batch with NO round
   * trip at all, exactly as `describeObject` answers three empty arrays for one of them.
   * That is a true fact about those kinds and not a refused read, so it is `{ details: [] }`
   * rather than a throw or a truncation. `hasColumns()` is the one rule both methods ask.
   *
   * An empty container costs ONE round trip rather than four: there is nothing for the
   * three detail reads to be about, and an empty answer to each of them is not worth asking
   * for.
   *
   * The bound is the CALLER's and is never invented here. `limit + 1` is bound to the target
   * statement, so a saturated read is distinguishable from an exact one without a second
   * count, the extra object is dropped, and `truncated` carries the caller's own limit. An
   * unbounded call runs a statement with no LIMIT clause at all and can never report
   * truncation - if this file ever caps a read of its own, it says so in the same field.
   *
   * The paths are built by `objectPath()`, the same rule `listObjects` builds its paths
   * with, and sorted by the same `comparePaths`, because every caller joins the two answers
   * on path. The three detail reads may carry rows for the extra `limit + 1` object; they
   * are dropped here rather than by a fourth bound, since the target list is what says which
   * objects the answer is about.
   */
  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    this.ensureConnected();
    const capabilities = this.getCapabilities();
    // Two questions, asked in order, and only the DECLARATION answers the first, for the
    // reason `listObjects` gives: `MYSQL_OBJECT_TYPES` carries MariaDB's two entries whatever
    // server is connected, so a kind resolved from the statement table would answer for a
    // `sequence` on a server that has none.
    if (findKind(capabilities, kind) === undefined) {
      throw new QueryError(`MySQL declares no object kind "${kind}"`, "mysql");
    }
    const schema = containerSchema(capabilities, container);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      // Not clamped and not ignored. A 0 would answer nothing while reporting a truncation
      // the caller never asked for, and a fraction reaches mysql2 as a bind the server
      // cannot use; both are caller mistakes and neither has a right answer to guess at.
      throw new QueryError(
        `A MySQL bulk column read limit must be a positive whole number, received ${limit}`,
        "mysql",
      );
    }
    if (!hasColumns(kind)) return { details: [] };

    const bounded = limit !== undefined;
    const statements = bounded ? BULK_DETAIL_SQL_BOUNDED[kind] : BULK_DETAIL_SQL[kind];
    const types = MYSQL_OBJECT_TYPES[kind].types;
    // One row more than the bound, so the read itself says whether it stopped short.
    const targetParams = bounded ? [schema, ...types, limit + 1] : [schema, ...types];
    // The three detail reads carry the target's own binds and then the schema again, for
    // the join. A prepared statement takes positional parameters, so the repeat is a second
    // bind of one value rather than a second question.
    const detailParams = [...targetParams, schema];

    const conn = await this.pool!.getConnection();
    try {
      const targetRows = await this.runObjectQuery<ObjectRow[]>(conn, statements.target, targetParams);
      const truncated = bounded && targetRows.length > limit;
      const described = truncated ? targetRows.slice(0, limit) : targetRows;
      if (described.length === 0) return { details: [] };

      const columns = byObjectName(
        await this.runObjectQuery<DetailColumnRow[]>(conn, statements.columns, detailParams),
      );
      const foreignKeys = byObjectName(
        await this.runObjectQuery<DetailForeignKeyRow[]>(conn, statements.foreignKeys, detailParams),
      );
      const indexes = byObjectName(await this.runObjectQuery<DetailIndexRow[]>(conn, statements.indexes, detailParams));

      const details = described
        .map((row) =>
          objectDetailFromRows(objectPath(schema, row), schema, {
            columns: columns.get(row.name) ?? [],
            foreignKeys: foreignKeys.get(row.name) ?? [],
            indexes: indexes.get(row.name) ?? [],
          }),
        )
        .sort((left, right) => comparePaths(left.path, right.path));
      return truncated ? { details, truncated: { limit, reason: BULK_TRUNCATION_REASON } } : { details };
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // One bare read, picked client-side: see `statusValue()` for the Doris measurement
      // that forced it. `Threads_connected` is absent on TiDB 8.5.1 (13 status rows,
      // none of them that one), on StarRocks 3.3.22 and on Doris 4.1.3 (0 rows each),
      // all measured 2026-09-06, and an unmeasured count is OMITTED rather than sent as
      // a fabricated 0 (#477, and the docblock on `HealthInfo.activeConnections`): this
      // is the field the agent's curated health reading forwards to the model.
      const [statusRows] = await runStatement(conn, "SHOW STATUS");
      const activeConnections = measuredNumber(statusValue(statusRows, "Threads_connected"));

      const [sizeRows] = await runStatement(conn, DATABASE_SIZE_MB_SQL, [this.config.database]);
      const databaseSize = `${sizeRows[0]?.size_mb || 0} MB`;

      // A tenant can be missing the performance_schema DATABASE rather than merely
      // having the schema off, and then this query does not answer NULLs, it throws:
      // measured 2026-08-20 on OceanBase Community Edition 4.4.2.1 through this
      // provider, and reproduced on mysql:latest as
      // `ERROR 1049 (42000): Unknown database 'performance_schema_absent'`. Uncaught,
      // it took the whole health read down, so the panel showed nothing at all where
      // one unavailable metric was the honest answer.
      let cacheHitRatio = CACHE_HIT_RATIO_UNAVAILABLE;
      try {
        const [hitRows] = await runStatement(conn, BUFFER_CACHE_HIT_RATIO_SQL);
        cacheHitRatio = formatCacheHitRatio(measuredNumber(hitRows[0]?.hit_ratio));
      } catch {
        // Nothing to read, so nothing is reported.
      }

      // The digest rows, or none - never a sentence dressed as a row (#512).
      //
      // This used to report `[{ query: "Performance schema not available", calls: 0,
      // avgTime: "N/A" }]` whenever its statement threw, and the statement threw on every
      // server: it named a column the digest table does not have (see
      // SLOW_QUERIES_BODY_SQL). So the line stated an engine capability as absent on
      // MySQL 26.7.0 and Percona Server 8.4.11-11 where `@@performance_schema` was 1 and
      // `getSlowQueries()` answered 5 rows on the same connection - measured 2026-08-27,
      // both arms.
      //
      // That row was a fabricated measurement rather than a missing number, which is the
      // class the absence rule (#477) exists to prevent: `calls: 0` is a figure nobody
      // took, and it was COUNTED - the agent's curated health reading then forwarded
      // `health.slowQueries.length` as `slowQueryCount` (src/lib/agent/tools.ts), so the
      // invented row told the model "1 slow query" about every MySQL-family server. That
      // projection carries no length any more (#513), so a row invented here would now be
      // silent rather than counted - a reason to keep it out, not a reason it could return.
      //
      // Why an empty list rather than a marker that says "unavailable": the capability
      // being OFF does not raise here at all. Measured on the same pass, MySQL 26.7.0
      // started `--performance-schema=OFF` and MariaDB 12.3.2 (which ships it off) both
      // keep the digest table selectable and answer 0 rows. A marker keyed on the throw
      // would therefore be emitted for something other than off-ness - the same fabrication
      // as the row it replaces, one level up.
      // What remains in the catch is a genuine refusal: no `performance_schema` DATABASE
      // at all (ER_1049 on the OceanBase tenant above), or a grant denied on it.
      //
      // ON THIS PATH THE REASON IS DROPPED, and saying so is the point of this
      // paragraph. `HealthInfo.slowQueries` is a `SlowQuery[]`; it has no error field
      // and no sibling that carries one, so a refusal cannot be represented here at all,
      // and a row saying "Performance schema not available" is what representing it
      // anyway looked like. Empty is the least-wrong shape, not a shape that carries the
      // reason. Nothing renders this list either: no component reads
      // `HealthInfo.slowQueries` (the monitoring Queries and Overview tabs read
      // `MonitoringData.slowQueries`, a different reading), and the one caller of
      // `POST /api/db/health` - the 60s connection pulse in
      // `src/hooks/use-connection-manager.ts` - looks at `res.ok` and discards the body.
      //
      // The operator is not left without the reason, because the SAME refusal reaches
      // them on the path that does have a channel: `getSlowQueries()` below lets it
      // reject, `getMonitoringData()` (src/lib/db/base-provider.ts) records it as
      // `errors.slowQueries`, and `QueriesTab` renders that through `PanelUnavailable`
      // with the server's own sentence. `ProviderLabels.slowQueriesEmptyState` is NOT
      // that channel - it is the same sentence for every empty list regardless of cause,
      // which is why it must not name one cause as the fix.
      let slowQueries: SlowQuery[] = [];
      try {
        const [slowRows] = await runStatement(conn, `${SLOW_QUERIES_BODY_SQL} LIMIT ${HEALTH_SLOW_QUERY_LIMIT};`, [
          this.config.database,
        ]);
        slowQueries = slowRows.map((r) => toHealthSlowQuery(toSlowQueryStats(r)));
      } catch {
        // Nothing was read, so nothing is reported.
      }

      const [sessionRows] = await runStatement(conn, HEALTH_ACTIVE_SESSIONS_SQL, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionRows.map((r) => ({
        pid: r.pid,
        user: r.user || "unknown",
        database: r.database || "",
        state: r.state || "unknown",
        query: r.query || "",
        duration: r.duration || "N/A",
      }));

      return {
        ...(activeConnections === undefined ? {} : { activeConnections }),
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      const conn = await this.pool!.getConnection();
      try {
        let sql = "";

        switch (type) {
          // The three table verbs share one shape: `<VERB> TABLE <list>`, where the
          // list is the one table the caller named or every table in the database, and
          // the answer is a RESULT SET carrying the verdict (`readMaintenanceReport`).
          case "analyze":
          case "optimize":
          case "check": {
            const tables = target ? this.escapeIdentifier(target) : await this.getAllTablesForMaintenance(conn);
            // An empty database joined to an empty list, and `OPTIMIZE TABLE ` alone is
            // a syntax error - measured through the provider against a database with no
            // tables on 2026-08-25: "You have an error in your SQL syntax ... near ''".
            // Nothing to do is not a failure, so it is reported as what it is rather
            // than as the engine's complaint about a statement we should not have sent.
            if (!tables) {
              return {
                success: true,
                message: `${type.toUpperCase()}: no tables in ${this.config.database ?? "this database"} to run it on.`,
              };
            }
            const [rows] = await runStatement<MaintenanceReportRow[]>(conn, `${type.toUpperCase()} TABLE ${tables}`);
            return readMaintenanceReport(type, rows);
          }
          case "kill":
            if (!target) {
              throw new QueryError("Target connection ID is required for kill operation", "mysql");
            }
            const connId = parseInt(target, 10);
            if (isNaN(connId)) {
              throw new QueryError("Invalid connection ID for kill operation", "mysql");
            }
            sql = `KILL ${connId}`;
            break;
        }

        // Unsupported types fall through the switch with sql left empty. A
        // `default:` label is deliberately avoided here: bun's coverage emits
        // a 0-hit line record for `default:` that no runtime execution ever
        // credits, which permanently poisons the merged lcov report.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type for MySQL: ${type}`, "mysql");
        }

        await runStatement(conn, sql);
        return { success: true, message: `${type.toUpperCase()} completed successfully` };
      } finally {
        conn.release();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  private async getAllTablesForMaintenance(conn: PoolConnection): Promise<string> {
    const [rows] = await runStatement(conn, MAINTENANCE_TABLES_SQL, [this.config.database]);

    return rows.map((r) => this.escapeIdentifier(r.TABLE_NAME)).join(", ");
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Get version
      const [versionRows] = await runStatement(
        conn,
        "SELECT VERSION() as version, @@version_comment as version_comment",
      );
      const version = versionRows[0]?.version || "Unknown";
      const versionComment = versionRows[0]?.version_comment as string | undefined;

      // Uptime and the connection count come out of ONE bare `SHOW STATUS`: the LIKE
      // clause is what Doris 4.1.3 refuses (see `statusValue()`), and reading the list
      // once serves both variables in one round trip instead of two.
      const [statusRows] = await runStatement(conn, "SHOW STATUS");
      const uptimeSeconds = measuredNumber(statusValue(statusRows, "Uptime"));
      const activeConnections = measuredNumber(statusValue(statusRows, "Threads_connected"));

      // `SHOW VARIABLES LIKE` STAYS. Doris rejects the LIKE clause on `SHOW STATUS`
      // only: measured 2026-09-06, `SHOW VARIABLES LIKE 'max_connections'` is accepted
      // on Doris 4.1.3 and on StarRocks 3.3.22 alike (both answering 0 rows), so the
      // narrowest fix changes only the statement a grammar refuses.
      //
      // The `|| "151"` default is gone with it: 151 is MySQL's compiled-in ceiling and
      // was reported for every server that published none, including TiDB, which
      // publishes a real `0`. `maxConnections` is the one figure where 0 and absence
      // are the SAME fact, "no limit published", which is why it stays a required
      // number here rather than being omitted (see `src/lib/db/types.ts`).
      const [maxConnRows] = await runStatement(conn, "SHOW VARIABLES LIKE 'max_connections'");
      const maxConnections = measuredNumber(maxConnRows[0]?.Value) ?? 0;

      // Get database size
      const [sizeRows] = await runStatement(conn, OVERVIEW_DATABASE_SIZE_SQL, [this.config.database]);
      const databaseSizeBytes = measuredNullableAggregate(sizeRows[0], "size_bytes");
      const databaseSize = databaseSizeBytes === undefined ? "N/A" : formatBytes(databaseSizeBytes);

      // Get table and index count
      const [countRows] = await runStatement(conn, OVERVIEW_OBJECT_COUNTS_SQL, [this.config.database]);

      const [tableCountRows] = await runStatement(conn, OVERVIEW_TABLE_COUNT_SQL, [this.config.database]);

      return {
        version: labelServerVersion(version, versionComment),
        // "N/A" is what a provider that cannot measure uptime sends (sqlite, duckdb,
        // libsql, mongodb), and no `startTime` is derived from an uptime nobody
        // published: `Date.now()` would have been reported as the server's start.
        uptime: uptimeSeconds === undefined ? "N/A" : this.formatUptimeString(uptimeSeconds),
        ...(uptimeSeconds === undefined ? {} : { startTime: new Date(Date.now() - uptimeSeconds * 1000) }),
        ...(activeConnections === undefined ? {} : { activeConnections }),
        maxConnections,
        databaseSize,
        ...(databaseSizeBytes === undefined ? {} : { databaseSizeBytes }),
        tableCount: parseInt(tableCountRows[0]?.cnt || "0"),
        indexCount: parseInt(countRows[0]?.index_count || "0"),
      };
    } finally {
      conn.release();
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Every reading below is optional on purpose. A server with performance_schema
      // OFF - MariaDB's default - answers each of these with NULL rather than
      // failing, and a metric nobody measured must stay absent instead of arriving
      // as a number the panels would rate (#424, and the rule #448/#452 settled).

      // Calculate cache hit ratio from InnoDB buffer pool
      const [hitRows] = await runStatement(conn, BUFFER_CACHE_HIT_RATIO_SQL);
      const hitRatio = measuredNumber(hitRows[0]?.hit_ratio);

      // Get buffer pool usage
      const [poolRows] = await runStatement(conn, BUFFER_POOL_PAGES_SQL);
      const dataPages = measuredNumber(poolRows[0]?.data_pages);
      const totalPages = measuredNumber(poolRows[0]?.total_pages);

      // Get queries per second
      const [qpsRows] = await runStatement(conn, QUERIES_PER_SECOND_SQL);
      const queries = measuredNumber(qpsRows[0]?.queries);
      const uptime = measuredNumber(qpsRows[0]?.uptime);

      // Get deadlocks. SHOW STATUS answers this with or without performance_schema,
      // so a 0 here is a measurement and is reported as one. Bare, for the reason
      // `statusValue()` records: Doris 4.1.3 refuses the LIKE clause on this statement.
      // `Innodb_deadlocks` is MariaDB's variable (12.3.2 publishes it among 571 rows);
      // MySQL 26.7.0 publishes none of it among its 528, measured 2026-09-06, so the
      // row is simply not in the list there and the reading stays absent.
      const [statusRows] = await runStatement(conn, "SHOW STATUS");
      const deadlocks = measuredNumber(statusValue(statusRows, "Innodb_deadlocks"));

      return {
        ...(hitRatio === undefined ? {} : { cacheHitRatio: Math.min(100, Math.max(0, hitRatio)) }),
        ...(queries === undefined || !uptime ? {} : { queriesPerSecond: round2(queries / uptime) }),
        ...(dataPages === undefined || !totalPages ? {} : { bufferPoolUsage: round2((dataPages / totalPages) * 100) }),
        ...(deadlocks === undefined ? {} : { deadlocks }),
      };
    } catch {
      // performance_schema is absent entirely rather than merely off: nothing was
      // measured, so nothing is reported.
      return {};
    } finally {
      conn.release();
    }
  }

  /**
   * The digests, or the server's refusal - this read does NOT swallow.
   *
   * It used to `return []` on any throw, with a comment saying the reason travelled
   * through `ProviderLabels.slowQueriesEmptyState` instead. It did not: that label is
   * one fixed sentence rendered for every empty list whatever produced it, and the
   * sentence this provider declares names the Performance Schema - the one cause that
   * never reaches here.
   *
   * What never reaches here is off-ness. Measured 2026-08-27, a server with
   * `@@performance_schema` = 0 keeps the digest table selectable and answers 0 rows
   * (MySQL 26.7.0 started `--performance-schema=OFF`, MariaDB 12.3.2 which ships it off),
   * so an unreadable source is the ONLY thing that throws: no `performance_schema`
   * DATABASE at all (ER_1049 on an OceanBase tenant) or the grant denied on it -
   *
   *   errno=1142 code=ER_TABLEACCESS_DENIED_ERROR sqlState=42000
   *   SELECT command denied to user 'nops'@'...' for table
   *   'events_statements_summary_by_digest'
   *
   * measured on MySQL 26.7.0 with a user holding only `SELECT ON d32.*` plus `PROCESS`.
   * Letting that reject is what puts the reason in front of the operator: it becomes
   * `errors.slowQueries` in `getMonitoringData()` (src/lib/db/base-provider.ts), which
   * reads every panel with `Promise.allSettled` and records a rejected one by name, and
   * `QueriesTab` renders it through `PanelUnavailable` carrying the server's own
   * sentence. One rejected panel costs nothing else: that method throws only when all
   * four core reads reject. This is also what the PostgreSQL provider already does - it
   * falls back to `pg_stat_activity` and lets a failure of THAT propagate.
   */
  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, `${SLOW_QUERIES_BODY_SQL} LIMIT ${Number(limit)};`, [
        this.config.database,
      ]);

      return rows.map(toSlowQueryStats);
    } finally {
      conn.release();
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, `${ACTIVE_SESSIONS_BODY_SQL} LIMIT ${Number(limit)};`, [
        this.config.database,
      ]);

      return rows.map((r) => {
        const durationSeconds = parseInt(r.duration_seconds || "0");
        return {
          pid: r.pid,
          user: r.user || "unknown",
          database: r.database_name || "",
          clientAddr: r.client_addr?.split(":")[0] || undefined,
          state: r.state || "unknown",
          query: r.query || "",
          duration: this.formatDurationString(durationSeconds * 1000),
          durationMs: durationSeconds * 1000,
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getTableStats(options?: { schema?: string }): Promise<TableStats[]> {
    this.ensureConnected();
    const schema = options?.schema ?? this.config.database;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, TABLE_STATS_SQL, [schema]);

      return rows.map((r) => {
        const tableSizeBytes = parseInt(r.table_size_bytes || "0");
        const indexSizeBytes = parseInt(r.index_size_bytes || "0");
        const totalSizeBytes = parseInt(r.total_size_bytes || "0");
        const freeSpaceBytes = parseInt(r.free_space_bytes || "0");

        // Estimate bloat ratio from free space
        const bloatRatio = totalSizeBytes > 0 ? (freeSpaceBytes / totalSizeBytes) * 100 : 0;

        return {
          schemaName: r.schema_name || schema || "",
          tableName: r.table_name || "",
          rowCount: parseInt(r.row_count || "0"),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          // The byte figure was computed and then dropped, so the storage panel had no per-table
          // index total to add up: `INDEX_LENGTH` is what MySQL itself calls index bytes.
          indexSizeBytes,
          totalSize: formatBytes(totalSizeBytes),
          totalSizeBytes,
          bloatRatio: Math.round(bloatRatio * 10) / 10,
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getIndexStats(options?: { schema?: string }): Promise<IndexStats[]> {
    this.ensureConnected();
    const schema = options?.schema ?? this.config.database;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, INDEX_STATS_SQL, [schema]);

      // Vitess answers information_schema.STATISTICS with the physical shard database
      // (`vt_probe_0`) even though the filter above named the keyspace, so the size lookup asks
      // for the schema the server just reported rather than the one we connected to.
      const physicalSchema = (rows[0]?.schema_name as string | undefined) ?? schema;

      const indexSizes: Record<string, number> = {};
      try {
        const [sizeRows] = await runStatement(conn, INDEX_SIZES_SQL, [physicalSchema]);

        for (const row of sizeRows) {
          indexSizes[`${row.database_name}/${row.table_name}/${row.index_name}`] = parseInt(row.size_bytes || "0");
        }
      } catch {
        // Reading mysql.innodb_index_stats needs SELECT on the mysql schema, which a user granted
        // only its own database does not have (measured ER_TABLEACCESS_DENIED_ERROR). Every index
        // then reports no size at all rather than a fabricated 0 bytes.
      }

      return rows.map((r) => {
        // An absent row is not a zero-byte index: MyISAM tables and InnoDB tables whose
        // persistent statistics were never written have no row here at all.
        const indexSizeBytes = indexSizes[`${r.schema_name}/${r.table_name}/${r.index_name}`];

        return {
          schemaName: r.schema_name || schema || "",
          tableName: r.table_name || "",
          indexName: r.index_name || "",
          indexType: r.index_type || "BTREE",
          columns: r.columns?.split(",") || [],
          isUnique: Boolean(r.is_unique),
          isPrimary: Boolean(r.is_primary),
          indexSize: indexSizeBytes === undefined ? "N/A" : formatBytes(indexSizeBytes),
          indexSizeBytes,
          scans: parseInt(r.cardinality || "0"),
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const stats: StorageStats[] = [];

      // Get database size
      const [dbRows] = await runStatement(conn, STORAGE_STATS_SQL, [this.config.database]);

      if (dbRows.length > 0) {
        const sizeBytes = parseInt(dbRows[0].size_bytes || "0");
        stats.push({
          name: "Data",
          location: this.config.database || "default",
          size: formatBytes(sizeBytes),
          sizeBytes,
        });
      }

      // Get binary log size if available
      try {
        const [binlogRows] = await runStatement(conn, "SHOW BINARY LOGS");
        const binlogSize = binlogRows.reduce((sum, r) => sum + parseInt(r.File_size || "0"), 0);
        if (binlogSize > 0) {
          stats.push({
            name: "Binary Logs",
            size: formatBytes(binlogSize),
            sizeBytes: binlogSize,
          });
        }
      } catch {
        // Binary logging not enabled
      }

      // Get InnoDB data file size
      try {
        const [innodbRows] = await runStatement(conn, "SHOW VARIABLES LIKE 'innodb_data_file_path'");
        if (innodbRows.length > 0) {
          stats.push({
            name: "InnoDB",
            location: innodbRows[0].Value || "ibdata1",
            size: "N/A",
            sizeBytes: 0,
          });
        }
      } catch {
        // Could not get InnoDB info
      }

      return stats;
    } finally {
      conn.release();
    }
  }

  private formatUptimeString(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private formatDurationString(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
}
