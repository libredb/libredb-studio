/**
 * Druid schema introspection and monitoring (issue #265, design spec sections 9 and 10)
 *
 * Every read the provider makes that is not a user's own statement lives here,
 * and all of them go through the transport seam, so this file names nothing from
 * the wire - not a request parameter, not a response field. It owns no transport
 * either: each function takes one, which is what lets the provider hand it a live
 * transport and a test hand it nine rows.
 *
 * Druid publishes two catalogs and one set of `sys` tables, and the split
 * between them is the load-bearing decision here:
 *
 * - `INFORMATION_SCHEMA.TABLES` / `.COLUMNS` -> the schema tree. Nothing else.
 * - `sys.servers`, `sys.segments`, `sys.tasks` -> the monitoring panels.
 *
 * The schema tree deliberately does NOT touch `sys`. A cluster running
 * `druid-basic-security` grants the `sys` schema separately from the catalogs, so
 * a datasource row count read from `sys.segments` would make the whole sidebar
 * fail on a cluster that merely declines to describe its servers. The
 * per-datasource counts are in `getTableStats()`, where a denial costs one panel.
 *
 * Four live-verified shapes on 37.0.0 drive most of the code below, and each one
 * silently produces wrong output if forgotten:
 *
 * 1. A grouping-less aggregate over zero matching rows returns ZERO ROWS, not a
 *    row of zeros: `SELECT COUNT(*) FROM sys.tasks WHERE status = 'RUNNING'`
 *    describes the column and returns no row at all when nothing is running. Every
 *    scalar read therefore has to survive an absent row, not just a null.
 * 2. `sys.tasks.duration` is **-1** for a task that has not finished - which is
 *    every task the session read selects - so the elapsed time comes from
 *    `CURRENT_TIMESTAMP` minus `created_time` instead.
 * 3. `sys.servers` reports `max_size = 0` for every process that is not a
 *    historical, so the usage division meets a zero in ordinary operation.
 * 4. A large `SUM(size)` arrives as a decimal STRING, because the transport
 *    quotes integer literals outside the safe range before parsing (spec section
 *    3). Both encodings reach these mappers.
 *
 * Druid's own dialect traps apply to every statement here: Calcite's reserved-word
 * list is large and surprising (`SELECT 1 AS one` is a syntax error, and so is
 * `SUM(size) AS rows`), so every alias is double-quoted, and so is every column
 * whose name is a keyword. And no statement over a datasource may ORDER BY a
 * non-time column - the reads below are over `sys` and `INFORMATION_SCHEMA`,
 * where ordering is unrestricted, or over an aggregation, where it is allowed.
 */

import type {
  ActiveSession,
  ActiveSessionDetails,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  PerformanceMetrics,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { formatBytes, formatDuration } from "@/lib/db/utils/pool-manager";
import type { ColumnSchema, TableSchema } from "@/lib/types";
import { DRUID_CLIENT_DEADLINE_GRACE_MS, type DruidRow, type DruidTransport, DruidTransportError } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The one schema that holds datasources, and Druid's default schema.
 *
 * Because it IS the default, a `TableSchema.name` is the BARE datasource name and
 * `SELECT * FROM "libredb_demo"` resolves - none of the qualification the other
 * multi-schema providers need. `INFORMATION_SCHEMA.SCHEMATA` reports exactly one
 * catalog, always `druid`, so there is nothing else to pin either.
 */
export const DRUID_SCHEMA_NAME = "druid";

/**
 * The mandatory primary timestamp of every datasource.
 *
 * It is the partitioning key, the sort key within a segment, and the only column
 * Druid reports as `IS_NULLABLE = 'NO'` - which is why it, and only it, is the
 * primary column of the schema tree.
 */
export const DRUID_TIME_COLUMN = "__time";

/**
 * Druid's own SQL type for a column its SQL layer cannot name.
 *
 * Never observed empty in `DATA_TYPE`, so this is the defensive branch - but when
 * it fires, `OTHER` keeps the column list speaking Druid's vocabulary (spec
 * section 2 observed it alongside `BIGINT`, `VARCHAR`, `TIMESTAMP` and `ARRAY`)
 * instead of showing a blank type.
 */
const DRUID_UNKNOWN_COLUMN_TYPE = "OTHER";

/** The value `IS_NULLABLE` carries for `__time`, and for nothing else today. */
const NOT_NULLABLE = "NO";

/**
 * What a panel prints for something the cluster did not tell us.
 *
 * Used for the server version, the uptime and a task's submitter, all of which
 * are genuinely unknown rather than empty: Druid records no submitter identity in
 * `sys.tasks` (a `druid-basic-security` cluster puts it in the audit log), and a
 * cluster that declines to describe its servers reports no version at all.
 */
export const DRUID_UNKNOWN_TEXT = "unknown";

/**
 * What `HealthInfo.cacheHitRatio` says on Druid.
 *
 * That field is a STRING, so it can say "not measured" - which is the truth.
 * Druid's cache statistics reach a metrics emitter (statsd, Kafka, the log) and
 * never a SQL-readable table, so any number here would be invented, and a low
 * one would trip the cache-ratio threshold alert into reporting a fault that does
 * not exist. `sqlite.ts` and `oracle.ts` already spell an unavailable ratio this
 * way, so this is the repo's existing word for it rather than a new one.
 */
export const DRUID_CACHE_HIT_RATIO_UNAVAILABLE = "N/A";

/**
 * What an ingestion task calls itself in the sessions panel.
 *
 * Druid has no query sessions - no `sys.queries`, no connection catalog - so its
 * tasks are the only activity it can describe, and returning nothing while a
 * multi-hour ingestion runs would hide the one thing happening on the cluster.
 * This is what stops the row being read as a client connection.
 */
export const DRUID_TASK_APPLICATION_NAME = "Druid ingestion task";

/** Row cap for the sessions panel when the caller names none. */
export const DRUID_DEFAULT_SESSION_LIMIT = 50;

/** Row cap for the sessions the health summary embeds. */
const DRUID_HEALTH_SESSION_LIMIT = 10;

/**
 * Server-side deadline for one catalog or `sys` read, in milliseconds.
 *
 * Set on BOTH halves of the exchange, which are not duplicates of each other: the
 * server-side deadline is what actually frees the cluster's resources, while the
 * client-side one also bounds a stalled connect and a response body that stops
 * arriving part-way.
 *
 * The client half is this plus `DRUID_CLIENT_DEADLINE_GRACE_MS`, never this value
 * itself. Equal deadlines are a race the client wins - the server's 504 still has
 * to travel back - and winning it throws away Druid's classified `TIMEOUT` envelope
 * in favour of a bare abort, which is the whole reason the provider distinguishes
 * the two halves in the first place.
 */
export const DRUID_SYSTEM_READ_TIMEOUT_MS = 15_000;

// ============================================================================
// Catalog and sys SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope and joined from single lines rather than written as
// multi-line template literals inside the functions: bun's coverage instruments
// the interior lines of a template literal in a function body as 0-hit in any
// process that imports this file without calling that function, which the merged
// lcov then reports as uncovered SQL. `clickhouse/introspect.ts` and
// `postgres.ts` hoist their own for the same reason.
//
// Exported so the tests pin the exact statement each read sends. A test that
// matched a substring would keep passing after the projection changed shape,
// which is precisely the change that breaks a mapper.
// ============================================================================

/** The schema name is a compile-time constant, so inlining it as a literal is safe. */
const DATASOURCE_SCHEMA_FILTER = `WHERE TABLE_SCHEMA = '${DRUID_SCHEMA_NAME}'`;

/**
 * The datasources, and only the datasources.
 *
 * `INFORMATION_SCHEMA.TABLES` also lists the four `INFORMATION_SCHEMA` views and
 * the six `sys` tables as `SYSTEM_TABLE`, and a cluster with lookups or views
 * carries a `lookup` / `view` schema besides. The schema predicate is the entire
 * mechanism that keeps all of those out of the sidebar; they stay reachable by
 * typing SQL, and the monitoring reads below query `sys` directly.
 */
export const DRUID_TABLE_LIST_SQL = [
  'SELECT TABLE_NAME AS "tableName"',
  "FROM INFORMATION_SCHEMA.TABLES",
  DATASOURCE_SCHEMA_FILTER,
  "ORDER BY TABLE_NAME",
].join(" ");

/**
 * The columns of every datasource, in declared order.
 *
 * `ORDINAL_POSITION` orders the read rather than appearing in it: it IS the
 * declared column order, so it has no separate value to carry. `COLUMN_DEFAULT`
 * is left out for a stronger reason - live-verified, it is the empty string for
 * every column of every datasource, because a Druid column has no default: a
 * dimension absent from an ingested row is null, and that is not a default the
 * user could have chosen.
 */
export const DRUID_COLUMN_LIST_SQL = [
  'SELECT TABLE_NAME AS "tableName", COLUMN_NAME AS "columnName",',
  'DATA_TYPE AS "dataType", IS_NULLABLE AS "isNullable"',
  "FROM INFORMATION_SCHEMA.COLUMNS",
  DATASOURCE_SCHEMA_FILTER,
  "ORDER BY TABLE_NAME, ORDINAL_POSITION",
].join(" ");

/**
 * Who the cluster is and when it came up.
 *
 * Live `sys.servers` returns one row per process - the Coordinator and Overlord
 * (which share an address), a Broker, a Router, a MiddleManager and each
 * Historical - all reporting the same `version` but different start times. The
 * Coordinator is the cluster's brain, so its start time is the one that reads as
 * "the cluster came up"; the Broker is the fallback because a Broker-only
 * deployment is a supported way to reach Druid (spec section 11) and would have
 * no Coordinator row to offer.
 *
 * `CURRENT_TIMESTAMP` rides along so the uptime is a difference of two readings
 * of the SAME clock. The editor's clock may be skewed from the cluster's, and
 * `TIME_PARSE` cannot help here: live-verified, any expression over a `sys`
 * column fails with "cannot translate call TIME_PARSE", so the subtraction has to
 * happen in the mapper - from two values the server produced.
 */
export const DRUID_SERVER_IDENTITY_SQL = [
  'SELECT "version" AS "version", start_time AS "startTime", CURRENT_TIMESTAMP AS "serverNow"',
  "FROM sys.servers",
  "ORDER BY CASE server_type WHEN 'coordinator' THEN 0 WHEN 'broker' THEN 1 ELSE 2 END, server",
  "LIMIT 1",
].join(" ");

/**
 * Bytes held by the cluster's active segments.
 *
 * `is_active = 1` is not an optimisation. `sys.segments` describes every segment
 * the metadata store knows about, and its own `is_overshadowed` and `is_published`
 * columns exist because a segment can be superseded - by a compaction or a
 * re-ingestion of the same interval - while its row is still there. Summing those
 * would count the same rows and the same bytes twice, so a re-ingested datasource
 * would appear to double in size.
 */
export const DRUID_SEGMENT_TOTALS_SQL = [
  'SELECT SUM("size") AS "sizeBytes"',
  "FROM sys.segments",
  "WHERE is_active = 1",
].join(" ");

/** How many datasources there are, which is the overview's table count. */
export const DRUID_DATASOURCE_COUNT_SQL = [
  'SELECT COUNT(*) AS "datasourceCount"',
  "FROM INFORMATION_SCHEMA.TABLES",
  DATASOURCE_SCHEMA_FILTER,
].join(" ");

/**
 * How many ingestion tasks are running, which is the nearest thing Druid has to
 * an active connection count.
 *
 * Live-verified: this answers with the column-name row and NO data row when
 * nothing is running, rather than a row holding 0 - so the mapper has to read an
 * absent row as zero.
 */
export const DRUID_RUNNING_TASK_COUNT_SQL = [
  'SELECT COUNT(*) AS "runningTasks"',
  "FROM sys.tasks",
  "WHERE status = 'RUNNING'",
].join(" ");

/**
 * The unfinished tasks, newest first.
 *
 * `duration` is deliberately NOT projected. Live-verified against a `noop` task
 * submitted to the running cluster: `sys.tasks` reports `duration = -1` for a
 * task that has not finished, which is every task this filter selects, so
 * reporting that column would print "-1ms" on every row. Leaving it out of the
 * projection is what stops someone reaching for it later; `CURRENT_TIMESTAMP`
 * minus `created_time` is the age, and both values come from the server.
 *
 * `"type"` is quoted because it is a Calcite keyword.
 */
export const DRUID_ACTIVE_TASK_SQL = [
  'SELECT task_id AS "taskId", "type" AS "taskType", datasource AS "datasource",',
  'status AS "status", created_time AS "createdTime", CURRENT_TIMESTAMP AS "serverNow"',
  "FROM sys.tasks",
  "WHERE status IN ('RUNNING', 'PENDING')",
  "ORDER BY created_time DESC",
].join(" ");

/** Rows and bytes per datasource. Active segments only, for the reason above. */
export const DRUID_DATASOURCE_STATS_SQL = [
  'SELECT datasource AS "datasource", SUM(num_rows) AS "rowCount", SUM("size") AS "sizeBytes"',
  "FROM sys.segments",
  "WHERE is_active = 1",
  "GROUP BY datasource",
  'ORDER BY SUM("size") DESC',
].join(" ");

/**
 * Each historical's segment cache.
 *
 * The historicals are the only processes that hold segments: live-verified, the
 * Coordinator, Overlord, Broker, Router and MiddleManager rows of this same table
 * all report `curr_size` 0 and `max_size` 0, so listing them would fill the panel
 * with rows describing no storage - and would divide by their zero capacity.
 */
export const DRUID_HISTORICAL_STORAGE_SQL = [
  'SELECT server AS "server", host AS "host", curr_size AS "currSize", max_size AS "maxSize"',
  "FROM sys.servers",
  "WHERE server_type = 'historical'",
  "ORDER BY server",
].join(" ");

// ============================================================================
// Types
// ============================================================================

/**
 * The part of the seam these reads use.
 *
 * Narrower than `DruidTransport` on purpose: this module never opens or closes
 * anything, so taking the whole transport would claim a lifecycle it does not
 * have - and a test would have to supply a `close()` that means nothing.
 */
export type DruidQueryRunner = Pick<DruidTransport, "query">;

/** A column row placed against the datasource that owns it. */
interface OwnedColumn {
  table: string;
  column: ColumnSchema;
}

// ============================================================================
// Value readers
// ============================================================================

/** An identifier, or null for a row that cannot be placed and must be skipped. */
function readIdentifier(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A number the server reported, or 0 when it reported nothing usable.
 *
 * Both encodings are real and both can arrive in the same panel: a `LONG` is an
 * unquoted JSON number, until it leaves the safe-integer range and the transport
 * quotes it so `JSON.parse` cannot round it (spec section 3). A null - or an
 * absent row, which is what a grouping-less aggregate over no matching rows
 * produces here - is neither, and zero is the honest reading of both.
 */
function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return typeof value === "string" && value !== "" && Number.isFinite(parsed) ? parsed : 0;
}

/**
 * An instant the server reported, or undefined when it reported nothing readable.
 *
 * Every timestamp Druid puts in a `sys` table or returns from
 * `CURRENT_TIMESTAMP` is an ISO-8601 string in UTC (`2026-08-03T14:29:00.534Z`),
 * live-verified - including the ones whose native type claims to be `LONG`, which
 * is why the string is parsed rather than trusted as millis.
 */
function asInstant(value: unknown): Date | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A percentage, or 0 when there is nothing to divide by. Zero rather than a
 * flattering 100: a historical with no configured capacity must not look full,
 * and it must not show NaN either.
 */
function percentOf(part: number, whole: number): number {
  return whole > 0 ? round2((part / whole) * 100) : 0;
}

/** A row cap that is always a positive integer, so it can be inlined into SQL. */
function rowLimit(limit: number | undefined, fallback: number): number {
  const requested = Math.trunc(limit ?? fallback);
  return requested > 0 ? requested : fallback;
}

/**
 * How long ago something happened, according to the server's own clock.
 *
 * Zero when either reading is unusable - the honest answer, because the two
 * timestamps are the only clock available and there is no other source to fall
 * back on. Never negative: the row is one snapshot, but a cluster whose metadata
 * store disagrees with its Coordinator can still order the pair backwards, and an
 * age of "-2s" is worse than an age of 0.
 */
function elapsedMs(from: Date | undefined, until: Date | undefined): number {
  if (from === undefined || until === undefined) return 0;
  return Math.max(0, until.getTime() - from.getTime());
}

// ============================================================================
// Reads
// ============================================================================

/**
 * One catalog or `sys` read, degrading to no rows when the surface is not
 * available here.
 *
 * `UNAUTHORIZED`, `FORBIDDEN` and `NOT_FOUND` are the three categories that mean
 * "this surface does not exist for this user or this deployment", and all three
 * are ordinary: a cluster running `druid-basic-security` grants the `sys` schema
 * table by table, and a role may hold `INFORMATION_SCHEMA` and nothing else.
 * Every OTHER failure propagates - an unplannable statement or a timeout hidden
 * behind an empty panel is hidden forever, and the provider is the place that
 * turns a propagated failure into a message the user sees.
 */
async function readRows(runner: DruidQueryRunner, sql: string): Promise<DruidRow[]> {
  try {
    const result = await runner.query(sql, {
      timeoutMs: DRUID_SYSTEM_READ_TIMEOUT_MS,
      // Deliberately LATER than the server deadline, by the seam's own grace: equal
      // deadlines are a race the client wins, and winning it replaces Druid's
      // classified TIMEOUT envelope with a bare abort that says nothing useful.
      clientDeadlineMs: DRUID_SYSTEM_READ_TIMEOUT_MS + DRUID_CLIENT_DEADLINE_GRACE_MS,
    });
    return result.rows;
  } catch (error) {
    if (error instanceof DruidTransportError && error.isMonitoringUnavailable()) return [];
    throw error;
  }
}

/** The single row of a scalar read, or null when the server returned none. */
async function readRow(runner: DruidQueryRunner, sql: string): Promise<DruidRow | null> {
  const rows = await readRows(runner, sql);
  return rows[0] ?? null;
}

// ============================================================================
// Schema
// ============================================================================

function readColumn(row: DruidRow): OwnedColumn | null {
  const table = readIdentifier(row.tableName);
  const name = readIdentifier(row.columnName);
  if (table === null || name === null) return null;

  return {
    table,
    column: {
      name,
      // DATA_TYPE is the SQL type, which is the accurate one of the two Druid
      // publishes: spec section 2 records the native type lying about
      // CURRENT_TIMESTAMP (native LONG, actually an ISO timestamp) and about a
      // boolean expression (native LONG, actually true).
      type: readText(row.dataType) || DRUID_UNKNOWN_COLUMN_TYPE,
      // Nullable is the safe reading of an unreadable flag: Druid marks every
      // column but `__time` as YES, and a wrongly-mandatory marker on a column
      // that accepts nulls is the more misleading of the two mistakes.
      nullable: readText(row.isNullable) !== NOT_NULLABLE,
      // NEVER primary, `__time` included.
      //
      // `__time` is tempting: it is mandatory, it is the partition and sort key, and
      // it is the only column Druid reports as NOT NULL. But `isPrimary` means
      // PRIMARY KEY to every consumer of this field, and a primary key is UNIQUE,
      // which `__time` is not - live-verified on the fixture datasource, 50 rows
      // carry 30 distinct `__time` values. Nothing in a Druid datasource is unique.
      //
      // Claiming otherwise is not cosmetic, because the field is stated as fact
      // wherever it is read: `sql-completions.ts` appends "(PK)" in autocomplete,
      // `agent/context-snapshot.ts` and `DatabaseDocs.tsx` put " PK" into the schema
      // context a model reasons from, and `schema-diff/diff-engine.ts` reports
      // "Primary key changed" - so two Druid datasources that differ only in this
      // would diff as a key change. A
      // partition/time-key concept distinct from a primary key is what this would
      // need, and `ColumnSchema` has no such field.
      isPrimary: false,
    },
  };
}

/**
 * Bucket the column rows by the datasource that owns them. A row the decoder
 * cannot place is dropped rather than fatal, so one malformed row costs one
 * column instead of the whole tree.
 */
function groupColumns(rows: DruidRow[]): Map<string, ColumnSchema[]> {
  const grouped = new Map<string, ColumnSchema[]>();
  for (const row of rows) {
    const owned = readColumn(row);
    if (owned === null) continue;
    const columns = grouped.get(owned.table) ?? [];
    columns.push(owned.column);
    grouped.set(owned.table, columns);
  }
  return grouped;
}

/**
 * Every datasource, with its columns.
 *
 * `indexes` and `foreignKeys` are empty by construction, not by omission: Druid
 * has no user-defined indexes - every dimension is indexed inside the segment -
 * and no foreign keys anywhere, so there is no DDL that could declare either.
 *
 * A datasource whose segments have all been marked unused disappears from
 * `INFORMATION_SCHEMA.TABLES` entirely (live-verified through the Coordinator's
 * `markUnused`), so an empty result means "no datasources" and there is no
 * empty-datasource row to render - the opposite of Couchbase's empty-collection
 * case, and worth knowing before looking for one.
 */
export async function getSchema(runner: DruidQueryRunner): Promise<TableSchema[]> {
  const [tableRows, columnRows] = await Promise.all([
    readRows(runner, DRUID_TABLE_LIST_SQL),
    readRows(runner, DRUID_COLUMN_LIST_SQL),
  ]);

  const columns = groupColumns(columnRows);

  return tableRows
    .map((row) => readIdentifier(row.tableName))
    .filter((name): name is string => name !== null)
    .map((name) => ({
      name,
      columns: columns.get(name) ?? [],
      indexes: [],
      foreignKeys: [],
    }));
}

// ============================================================================
// Monitoring
// ============================================================================

/**
 * What the cluster is and how much it holds.
 *
 * Four separate reads on purpose, not one joined statement: `sys` permissions are
 * granted per table, so a cluster that declines `sys.tasks` must still report the
 * datasource count `INFORMATION_SCHEMA` answers happily. Combining them would
 * throw away every panel a restricted user CAN see.
 */
export async function getOverview(runner: DruidQueryRunner): Promise<DatabaseOverview> {
  const [identity, segments, datasources, tasks] = await Promise.all([
    readRow(runner, DRUID_SERVER_IDENTITY_SQL),
    readRow(runner, DRUID_SEGMENT_TOTALS_SQL),
    readRow(runner, DRUID_DATASOURCE_COUNT_SQL),
    readRow(runner, DRUID_RUNNING_TASK_COUNT_SQL),
  ]);

  const startTime = asInstant(identity?.startTime);
  const serverNow = asInstant(identity?.serverNow);
  const sizeBytes = asNumber(segments?.sizeBytes);
  const clockRead = startTime !== undefined && serverNow !== undefined;

  return {
    version: readIdentifier(identity?.version) ?? DRUID_UNKNOWN_TEXT,
    // Unknown rather than "0ms" when either reading is missing: an uptime of zero
    // claims the cluster booted this instant, which is a statement the server
    // never made. The branch is on the two readings rather than on their
    // difference, so a cluster that genuinely came up this millisecond still
    // reports a measured 0.
    uptime: clockRead ? formatDuration(elapsedMs(startTime, serverNow)) : DRUID_UNKNOWN_TEXT,
    startTime,
    // Druid has no query sessions to count, so a running ingestion task is the
    // only activity it can report as an occupied slot.
    activeConnections: asNumber(tasks?.runningTasks),
    // Zero means "no limit published", which is the truth: Druid has no connection
    // pool, and its task-slot capacity (`druid.worker.capacity`) is an Overlord API
    // reading rather than anything in the `sys` schema, so this provider cannot see
    // it. `mssql.ts` uses the same encoding and comments it the same way. The
    // Connections card treats a zero limit as "no limit published" rather than
    // dividing by it - it used to render the literal "NaN% used" - so no invented
    // ceiling is needed to keep the panel sane. There are likewise no index objects.
    maxConnections: 0,
    databaseSize: formatBytes(sizeBytes),
    databaseSizeBytes: sizeBytes,
    tableCount: asNumber(datasources?.datasourceCount),
    indexCount: 0,
  };
}

/**
 * Empty, because there is nothing to read - and empty specifically rather than
 * zeroed.
 *
 * Druid's cache, query and ingestion metrics all reach a metrics emitter -
 * statsd, Kafka, an HTTP endpoint, the log - and none of them reaches a
 * SQL-readable table, so every field here would be a number the editor made up.
 *
 * `cacheHitRatio` used to carry a "neutral" 0, which was not neutral at all:
 * `DEFAULT_THRESHOLDS` scores that metric `direction: "below"` with
 * `critical: 80`, so a 0 made every healthy Druid cluster render a red critical
 * cache fault - the exact alert-for-a-fault-that-does-not-exist that
 * `DRUID_CACHE_HIT_RATIO_UNAVAILABLE` above was written to avoid. The field is now
 * optional in `PerformanceMetrics`, and the monitoring tabs already default the
 * THRESHOLD to a healthy 100 when it is absent, so omission is both honest and
 * the one value that raises no alarm.
 *
 * Every other metric was already optional. A zero would read as a measurement of
 * zero, which is a different and false claim, so none of them are invented either.
 */
export function getPerformanceMetrics(): PerformanceMetrics {
  return {};
}

/**
 * Empty, because Druid has no query log.
 *
 * Not a switched-off feature and not a permission gate: there is no `sys` table,
 * no endpoint and no file holding finished queries, so unlike ClickHouse's
 * `system.query_log` or Postgres's `pg_stat_statements` there is nothing to ask.
 * No statement is sent to discover that.
 */
export function getSlowQueries(): SlowQueryStats[] {
  return [];
}

/**
 * Empty, because no user-defined indexes exist.
 *
 * Druid indexes every dimension by construction, but those indexes live inside a
 * segment with no name, no size and no usage counter of their own, so there is
 * nothing an index row could describe. The schema tree reports the same thing
 * from the other side, with `indexes: []`.
 */
export function getIndexStats(): IndexStats[] {
  return [];
}

/**
 * The unfinished ingestion tasks, described as sessions.
 *
 * Druid has no query sessions at all - no `sys.queries`, no connection catalog -
 * so this is the one honest thing the panel can show. The alternative, an empty
 * list, would report a quiet cluster while a multi-hour ingestion saturates the
 * MiddleManagers, and `applicationName` is what keeps the row from being read as
 * a client connection.
 */
export async function getActiveSessions(
  runner: DruidQueryRunner,
  options: { limit?: number } = {},
): Promise<ActiveSessionDetails[]> {
  const limit = rowLimit(options.limit, DRUID_DEFAULT_SESSION_LIMIT);
  const rows = await readRows(runner, `${DRUID_ACTIVE_TASK_SQL} LIMIT ${limit}`);

  return rows.map((row) => {
    const queryStart = asInstant(row.createdTime);
    const durationMs = elapsedMs(queryStart, asInstant(row.serverNow));

    return {
      pid: readText(row.taskId),
      // `sys.tasks` records no submitter identity - a druid-basic-security
      // cluster puts it in the audit log - and borrowing the connection's user
      // would credit it with a task it did not submit.
      user: DRUID_UNKNOWN_TEXT,
      // Live-verified: a task with no datasource, such as a `noop` task, reports
      // the literal string "none" rather than null.
      database: readText(row.datasource),
      applicationName: DRUID_TASK_APPLICATION_NAME,
      state: readText(row.status),
      // The task TYPE - `index_parallel`, `compact`, `kill` - which is the
      // closest thing a task has to a statement.
      query: readText(row.taskType),
      queryStart,
      duration: formatDuration(durationMs),
      durationMs,
    };
  });
}

/**
 * Rows and bytes per datasource, from the active segments.
 *
 * The schema filter is answered without a round trip when it names anything but
 * `druid`: that is the only schema holding datasources, so any other value
 * selects nothing, and a predicate that can never match is slower and less
 * obviously right than not asking.
 */
export async function getTableStats(
  runner: DruidQueryRunner,
  options: { schema?: string } = {},
): Promise<TableStats[]> {
  if (options.schema !== undefined && options.schema !== DRUID_SCHEMA_NAME) return [];

  const rows = await readRows(runner, DRUID_DATASOURCE_STATS_SQL);

  return rows.map((row) => {
    const sizeBytes = asNumber(row.sizeBytes);

    return {
      schemaName: DRUID_SCHEMA_NAME,
      tableName: readText(row.datasource),
      rowCount: asNumber(row.rowCount),
      // Segment bytes are all the bytes a datasource has: the dimension indexes
      // are inside the segment, so the table size and the total size are the same
      // number rather than one being the other plus an index total. The optional
      // index size stays absent for the same reason - a zero would be a
      // measurement of something that does not exist.
      tableSize: formatBytes(sizeBytes),
      tableSizeBytes: sizeBytes,
      totalSize: formatBytes(sizeBytes),
      totalSizeBytes: sizeBytes,
    };
  });
}

/** Each historical's segment cache, and how full it is. */
export async function getStorageStats(runner: DruidQueryRunner): Promise<StorageStats[]> {
  const rows = await readRows(runner, DRUID_HISTORICAL_STORAGE_SQL);

  return rows.map((row) => {
    const sizeBytes = asNumber(row.currSize);

    return {
      name: readText(row.server),
      location: readText(row.host),
      size: formatBytes(sizeBytes),
      sizeBytes,
      // `max_size` is 0 for every process that is not a historical (live-verified
      // on the Coordinator, Overlord, Broker, Router and MiddleManager rows of
      // this same table), and a historical with no configured segment cache
      // reports it too, so the zero denominator is real data rather than a
      // defensive guess.
      usagePercent: percentOf(sizeBytes, asNumber(row.maxSize)),
    };
  });
}

/** The health summary, composed from the reads that have a source. */
export async function getHealth(runner: DruidQueryRunner): Promise<HealthInfo> {
  const [overview, sessions] = await Promise.all([
    getOverview(runner),
    getActiveSessions(runner, { limit: DRUID_HEALTH_SESSION_LIMIT }),
  ]);

  const activeSessions: ActiveSession[] = sessions.map((session) => ({
    pid: session.pid,
    user: session.user,
    database: session.database,
    state: session.state,
    query: session.query,
    duration: session.duration,
  }));

  return {
    activeConnections: overview.activeConnections,
    databaseSize: overview.databaseSize,
    cacheHitRatio: DRUID_CACHE_HIT_RATIO_UNAVAILABLE,
    // Written out rather than mapped from `getSlowQueries()`: the summary needs
    // the narrower `SlowQuery` shape, and a mapper over a list that is always
    // empty would be a body no test can reach. Same reason, stated once there.
    slowQueries: [],
    activeSessions,
  };
}
