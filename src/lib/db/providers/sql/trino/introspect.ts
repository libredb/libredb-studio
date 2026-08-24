/**
 * Trino schema introspection and monitoring (issue #424, Phase 2)
 *
 * Every read the provider makes that is not the user's own statement lives here,
 * and all of them go through the transport seam, so this file names nothing from
 * the client protocol - no endpoint, no header, no page. It owns no transport
 * either: each function takes one, which is what lets the provider hand it a live
 * coordinator and a test hand it four rows.
 *
 * Trino is a QUERY ENGINE, not a database, and that single fact decides most of
 * what follows. It stores nothing, it declares no constraints, and everything it
 * can say about the data belongs to a connector that may or may not answer. So
 * the reads split into three groups with different failure rules:
 *
 * - The SCHEMA TREE reads `<catalog>.information_schema`. Its failures PROPAGATE:
 *   a pinned catalog that does not exist is the user's own configuration, and an
 *   empty sidebar would hide it.
 * - The MONITORING reads live in `system.runtime`, `system.metadata` and `jmx`.
 *   Their failures DEGRADE to nothing, because `jmx` is a catalog an operator
 *   configures and may simply not have, and `system` is grantable separately from
 *   the data catalogs. One missing panel is the right price; a sidebar that fails
 *   because the cluster declines to describe its JVM is not.
 * - `SHOW STATS` is per TABLE, so it degrades per table.
 *
 * Six shapes measured against a live Trino 476 on 2026-08-20 drive the code
 * below, and each one produces a wrong answer if forgotten:
 *
 * 1. `SHOW STATS FOR t` answers one row PER COLUMN plus a SUMMARY row whose
 *    `column_name` is null and whose `row_count` is the table's. The per-column
 *    rows carry no row count and the summary row carries no column name, so
 *    neither can be read without the other.
 * 2. `data_size` is null for every FIXED-WIDTH column - measured, `tpch.tiny.region`
 *    reports 34 and 330 bytes for its two varchars and null for its bigint. So the
 *    sum of that column is the variable-width footprint and NOT the table's size.
 * 3. A connector with no statistics answers the same six-column shape with every
 *    value null, summary row included (measured on `system.runtime.nodes`). "No
 *    row count" is therefore ordinary and must not become a reported zero.
 * 4. Trino's `information_schema` has NO `table_constraints` and no
 *    `key_column_usage` - measured, the catalog holds exactly eight views and
 *    those are not among them. There are no primary keys, no foreign keys and no
 *    indexes to read anywhere, in any catalog.
 * 5. `system.runtime.queries` records no CATALOG for a running statement, and no
 *    row count for a finished one. Both are absent from the table, not null in it.
 * 6. `SHOW CATALOGS` names its one column `Catalog`, which cannot be aliased, so
 *    the catalog list is read from `system.metadata.catalogs` instead - which also
 *    names the connector behind each catalog, and that is the honest "location"
 *    for data Trino does not hold.
 */

import type {
  ActiveSession,
  ActiveSessionDetails,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  PerformanceMetrics,
  SlowQuery,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { formatBytes, formatDuration } from "@/lib/db/utils/pool-manager";
import type { ColumnSchema, TableSchema } from "@/lib/types";
import { type TrinoRow, type TrinoTransport, TrinoTransportError } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The one schema every catalog carries and no user put there.
 *
 * Excluded from the tree because it is the same eight views in every catalog and
 * would bury the user's own schemas under them. It stays reachable by typing SQL,
 * and the reads below query it directly.
 */
export const TRINO_METADATA_SCHEMA = "information_schema";

/** What a panel prints for something the cluster did not tell us. */
export const TRINO_UNKNOWN_TEXT = "unknown";

/**
 * What `HealthInfo.cacheHitRatio` and `StorageStats.size` say on Trino.
 *
 * Both fields are STRINGS, so they can say "not measured" - which is the truth
 * rather than a hedge. Trino caches nothing at this layer (a connector may cache,
 * and publishes no ratio for it), and it stores nothing at all. `sqlite.ts`,
 * `oracle.ts` and `druid/introspect.ts` already spell an unavailable reading this
 * way, so this is the repo's existing word for it.
 */
export const TRINO_UNAVAILABLE_TEXT = "N/A";

/** Row cap for the sessions panel when the caller names none. */
export const TRINO_DEFAULT_SESSION_LIMIT = 50;

/** Row cap for the slow-query panel when the caller names none. */
export const TRINO_DEFAULT_SLOW_QUERY_LIMIT = 20;

/** Row cap for the sessions and slow queries the health summary embeds. */
const TRINO_HEALTH_LIMIT = 10;

/**
 * How many tables the stats panel will describe in one pass.
 *
 * A cap rather than a page, because `SHOW STATS` is per TABLE: there is no
 * catalog of sizes to aggregate, so N tables cost N statements. Twenty-five is
 * enough to fill the panel and small enough that a catalog with ten thousand
 * tables does not turn one panel open into ten thousand queries against the
 * coordinator.
 */
export const TRINO_MAX_STATS_TABLES = 25;

/**
 * The states a statement is no longer in flight in.
 *
 * Trino's terminal states are exactly these two - a killed statement lands in
 * FAILED with `ADMINISTRATIVELY_KILLED`, not in a third state - so "active" is
 * defined as their complement rather than as a list of the eight in-flight names.
 * A future release that adds an in-flight state is then reported rather than
 * silently dropped from the panel.
 */
const TERMINAL_STATE_PREDICATE = "state <> 'FINISHED' AND state <> 'FAILED'";

/**
 * The failures that mean "this surface is not available here" rather than "the
 * read went wrong".
 *
 * `unknown-object` is the ordinary shape of a cluster with no `jmx` catalog
 * configured: measured, a missing catalog answers `CATALOG_NOT_FOUND`, which is a
 * USER_ERROR the engine reports exactly as it reports a typo. `auth` is a role
 * granted the data catalogs and not `system`. Every other failure propagates - a
 * timeout or an unplannable statement hidden behind an empty panel is hidden
 * forever.
 */
const UNAVAILABLE_CATEGORIES = new Set(["unknown-object", "auth"]);

// ============================================================================
// Statement builders
// ----------------------------------------------------------------------------
// Assembled from single-line pieces rather than written as multi-line template
// literals: bun's coverage instruments the interior lines of a template literal
// in a function body as 0-hit in any process that imports this file without
// calling that function, which the merged lcov then reports as uncovered SQL.
// `druid/introspect.ts` and `clickhouse/introspect.ts` do the same.
//
// Builders rather than constants wherever the catalog appears, because the
// catalog is the connection's and not the module's. They are exported so a test
// pins the exact statement each read sends: a test matching a substring would
// keep passing after the projection changed shape, which is precisely the change
// that breaks a mapper.
// ============================================================================

/** One identifier, quoted the way Trino quotes them, with embedded quotes doubled. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** One string literal, with embedded apostrophes doubled. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A fully qualified name: catalog, schema and table, each quoted. */
function qualify(...parts: string[]): string {
  return parts.map(quoteIdentifier).join(".");
}

/** Every table of the pinned catalog that a user put there. */
export function trinoTableListSql(catalog: string): string {
  return [
    'SELECT table_schema AS "schemaName", table_name AS "tableName"',
    `FROM ${quoteIdentifier(catalog)}.information_schema.tables`,
    `WHERE table_schema <> ${quoteLiteral(TRINO_METADATA_SCHEMA)}`,
    "ORDER BY table_schema, table_name",
  ].join(" ");
}

/**
 * Every column of every such table, in declared order.
 *
 * `ordinal_position` orders the read rather than appearing in it: it IS the
 * declared order, so it has no separate value to carry. `column_default` is
 * projected even though every connector measured reports null for it, because
 * unlike Druid this is genuinely per-connector - a connector with server-side
 * defaults would report them here - and an absent value costs nothing.
 */
export function trinoColumnListSql(catalog: string): string {
  return [
    'SELECT table_schema AS "schemaName", table_name AS "tableName", column_name AS "columnName",',
    'data_type AS "dataType", is_nullable AS "isNullable", column_default AS "columnDefault"',
    `FROM ${quoteIdentifier(catalog)}.information_schema.columns`,
    `WHERE table_schema <> ${quoteLiteral(TRINO_METADATA_SCHEMA)}`,
    "ORDER BY table_schema, table_name, ordinal_position",
  ].join(" ");
}

/** How many tables the pinned catalog holds, which is the overview's table count. */
export function trinoTableCountSql(catalog: string): string {
  return [
    'SELECT count(*) AS "tableCount"',
    `FROM ${quoteIdentifier(catalog)}.information_schema.tables`,
    `WHERE table_schema <> ${quoteLiteral(TRINO_METADATA_SCHEMA)}`,
  ].join(" ");
}

/**
 * One table's statistics.
 *
 * `SHOW STATS` and not a projection over some catalog of sizes, because no such
 * catalog exists: this statement asks the CONNECTOR, and the connector is the only
 * thing that knows. Its output column names are the server's own and cannot be
 * aliased, which is why the mapper below reads `column_name` and `row_count`
 * rather than the camel-cased names every other read here declares.
 */
export function trinoTableStatsSql(catalog: string, schema: string, table: string): string {
  return `SHOW STATS FOR ${qualify(catalog, schema, table)}`;
}

/**
 * Terminate somebody else's statement.
 *
 * A procedure rather than the client protocol's own DELETE, because this is the
 * Maintenance panel's `kill` and its argument is a query id the user READ from the
 * sessions panel rather than one this client started. Live-verified end to end on
 * 476: the target's own exchange then fails with `ADMINISTRATIVELY_KILLED` and the
 * message travels with it, while an id that no longer exists answers `NOT_FOUND`
 * rather than pretending to have killed something.
 */
export function trinoKillQuerySql(queryId: string, message: string): string {
  return `CALL system.runtime.kill_query(query_id => ${quoteLiteral(queryId)}, message => ${quoteLiteral(message)})`;
}

/**
 * Every catalog the coordinator can reach, and the connector behind it.
 *
 * `system.metadata.catalogs` rather than `SHOW CATALOGS` for two reasons, both
 * measured: `SHOW CATALOGS` names its only column `Catalog`, which no alias can
 * rename, and it does not report the connector at all.
 */
export const TRINO_CATALOG_LIST_SQL = [
  'SELECT catalog_name AS "catalogName", connector_name AS "connectorName"',
  "FROM system.metadata.catalogs",
  "ORDER BY catalog_name",
].join(" ");

/**
 * The cluster's processes, coordinator first.
 *
 * The coordinator's `node_version` is the cluster's version. `version()` would
 * answer the same string - measured, the bare `"476"`, with no product name - but
 * this read also says how many nodes are up, and one statement that answers two
 * questions is one round trip rather than two.
 */
export const TRINO_NODE_LIST_SQL = [
  'SELECT node_id AS "nodeId", node_version AS "nodeVersion", coordinator AS "isCoordinator", state AS "nodeState"',
  "FROM system.runtime.nodes",
  "ORDER BY coordinator DESC, node_id",
].join(" ");

/**
 * When the coordinator's JVM started, and how long it has been up.
 *
 * The `jmx` catalog is the ONLY SQL-reachable source for either: nothing in
 * `system.runtime` records a start time, and the coordinator's `/v1/info` - which
 * does report an uptime - is not a statement and so is not reachable through this
 * seam. An operator who has not configured `jmx` therefore gets no uptime, which
 * `UNAVAILABLE_CATEGORIES` turns into "unknown" rather than into a failure.
 *
 * `LIMIT 1` because `jmx.current` reports one row per NODE and the coordinator is
 * the one whose uptime reads as the cluster's.
 */
export const TRINO_JVM_RUNTIME_SQL = [
  'SELECT starttime AS "startedAtMillis", uptime AS "uptimeMs"',
  'FROM jmx.current."java.lang:type=runtime"',
  "LIMIT 1",
].join(" ");

/**
 * How many statements the cluster completed per second over the last minute.
 *
 * A rate the coordinator itself measures, not one derived from the query log: the
 * log is a bounded in-memory history the coordinator trims, so counting rows in it
 * over a window would report a rate that falls to zero on a busy cluster the moment
 * the history wraps.
 */
export const TRINO_QUERY_RATE_SQL = [
  'SELECT "completedqueries.oneminute.rate" AS "completedPerSecond"',
  'FROM jmx.current."trino.execution:name=querymanager"',
  "LIMIT 1",
].join(" ");

/** How many statements are in flight, which is the nearest thing to a connection count. */
export const TRINO_ACTIVE_QUERY_COUNT_SQL = [
  'SELECT count(*) AS "activeQueries"',
  "FROM system.runtime.queries",
  `WHERE ${TERMINAL_STATE_PREDICATE}`,
].join(" ");

/**
 * The statements in flight, oldest first.
 *
 * `to_iso8601` because the raw column renders as `2026-08-20 00:13:00.796 UTC`,
 * which `new Date(...)` does not parse portably; the elapsed time is computed by
 * the SERVER for the same reason Druid computes its own - the editor's clock may
 * be skewed from the cluster's, and a difference of two readings of one clock is
 * the only honest one.
 *
 * This read sees ITSELF, as a RUNNING row. That is not a defect to filter out: the
 * coordinator really is running it, and the only id that could exclude it is one
 * the statement does not know while it is being planned.
 */
export const TRINO_ACTIVE_QUERY_SQL = [
  'SELECT query_id AS "queryId", state AS "state", "user" AS "userName", source AS "source",',
  'query AS "statement", to_iso8601(created) AS "createdAt",',
  "date_diff('millisecond', created, now()) AS \"elapsedMs\"",
  "FROM system.runtime.queries",
  `WHERE ${TERMINAL_STATE_PREDICATE}`,
  "ORDER BY created",
].join(" ");

/**
 * The slowest statements the coordinator still remembers, slowest first.
 *
 * "Still remembers" is the load-bearing part and is stated in the panel's own
 * terms by `calls: 1` below: `system.runtime.queries` is a bounded in-memory
 * history that the coordinator trims and a restart empties, so this is a recent
 * window and not a query log. Nothing here is aggregated across executions,
 * because the table records executions and not statements.
 *
 * `started`/`end` rather than `created`/`end`: the difference between them is the
 * queue wait, which is reported separately, and a statement that sat in a queue for
 * a minute was not slow to execute.
 */
export const TRINO_SLOW_QUERY_SQL = [
  'SELECT query_id AS "queryId", query AS "statement",',
  'date_diff(\'millisecond\', started, "end") AS "elapsedMs", queued_time_ms AS "queuedMs"',
  "FROM system.runtime.queries",
  "WHERE state = 'FINISHED' AND started IS NOT NULL AND \"end\" IS NOT NULL",
  'ORDER BY "elapsedMs" DESC',
].join(" ");

// ============================================================================
// Types
// ============================================================================

/**
 * The part of the seam these reads use.
 *
 * Narrower than `TrinoTransport` on purpose: this module never opens, cancels or
 * closes anything, so taking the whole transport would claim a lifecycle it does
 * not have - and a test would have to supply a `cancel()` that means nothing.
 */
export type TrinoQueryRunner = Pick<TrinoTransport, "query">;

/** A column row placed against the table that owns it. */
interface OwnedColumn {
  key: string;
  column: ColumnSchema;
}

/** One table, addressed the way `SHOW STATS` needs it addressed. */
interface TableAddress {
  schema: string;
  table: string;
}

/** What one `SHOW STATS` answer said, after the summary row and the column rows are read together. */
interface TableStatistics {
  /** Undefined when the connector published none - never zero (shape 3). */
  rowCount: number | undefined;
  /** The variable-width footprint only (shape 2). */
  dataSizeBytes: number;
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
 * A number the server reported, or undefined when it reported nothing usable.
 *
 * Undefined rather than zero, everywhere, because on this engine "the connector
 * published no statistics" is the COMMON case rather than the defensive one: three
 * of the four values `SHOW STATS` can return are legitimately null (shape 3), and a
 * table shown as "0 rows" when nothing said so is a number the explorer invented.
 * Callers that genuinely have a floor - a count of rows the read itself returned -
 * apply it themselves.
 *
 * A string is parsed as well as a number: `bigint` arrives unquoted today, but a
 * value outside the safe-integer range would have to arrive as text for it to
 * survive at all, and both encodings mean the same thing here.
 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * An instant the server rendered as ISO-8601, or undefined when it rendered
 * nothing readable.
 */
function readInstant(value: unknown): Date | undefined {
  const text = readIdentifier(value);
  if (text === null) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** A row cap that is always a positive integer, so it can be inlined into SQL. */
function rowLimit(limit: number | undefined, fallback: number): number {
  const requested = Math.trunc(limit ?? fallback);
  return requested > 0 ? requested : fallback;
}

/** A duration that is never negative: a clock read backwards is worse than a zero. */
function nonNegative(value: number | undefined): number {
  return value === undefined || value < 0 ? 0 : value;
}

/**
 * The grouping key for a table, joined with NUL rather than a dot.
 *
 * A dot is ambiguous - a Trino schema or table name may legally contain one, so
 * `"a.b" + "c"` and `"a" + "b.c"` would land in the same bucket, exactly as
 * `clickhouse/introspect.ts` found.
 */
function tableKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

// ============================================================================
// Reads
// ============================================================================

/** One read whose failure is the user's business, so it propagates. */
async function readRows(runner: TrinoQueryRunner, sql: string): Promise<TrinoRow[]> {
  const result = await runner.query(sql);
  return result.rows;
}

/**
 * One read whose failure costs a panel rather than the session, so it degrades to
 * no rows when the surface is not available here.
 */
async function readOptionalRows(runner: TrinoQueryRunner, sql: string): Promise<TrinoRow[]> {
  try {
    return await readRows(runner, sql);
  } catch (error) {
    if (error instanceof TrinoTransportError && UNAVAILABLE_CATEGORIES.has(error.category)) return [];
    throw error;
  }
}

/** The single row of an optional scalar read, or null when the server returned none. */
async function readOptionalRow(runner: TrinoQueryRunner, sql: string): Promise<TrinoRow | null> {
  const rows = await readOptionalRows(runner, sql);
  return rows[0] ?? null;
}

// ============================================================================
// Schema
// ============================================================================

/**
 * One column of the tree.
 *
 * `isPrimary` is hardwired false, and that is a statement about TRINO rather than
 * about this catalog: its `information_schema` publishes no `table_constraints`
 * and no `key_column_usage` at all (shape 4), so no connector can declare a key
 * through it and there is no reading of any kind that would return one. The same
 * fact is why `indexes` and `foreignKeys` are empty by construction below.
 */
function readColumn(row: TrinoRow): OwnedColumn | null {
  const schema = readIdentifier(row.schemaName);
  const table = readIdentifier(row.tableName);
  const name = readIdentifier(row.columnName);
  if (schema === null || table === null || name === null) return null;

  const columnDefault = readIdentifier(row.columnDefault);

  return {
    key: tableKey(schema, table),
    column: {
      name,
      // The rendered type - `varchar(25)`, `array(integer)`, `row(x integer)` -
      // which is the vocabulary the user's own DDL uses.
      type: readText(row.dataType),
      // `YES`/`NO`, and anything unreadable reads as nullable: a wrongly-mandatory
      // marker on a column that accepts nulls is the more misleading mistake.
      nullable: readText(row.isNullable) !== "NO",
      isPrimary: false,
      ...(columnDefault === null ? {} : { defaultValue: columnDefault }),
    },
  };
}

/**
 * Bucket the column rows by the table that owns them. A row the decoder cannot
 * place is dropped rather than fatal, so one malformed row costs one column
 * instead of the whole tree.
 */
function groupColumns(rows: TrinoRow[]): Map<string, ColumnSchema[]> {
  const grouped = new Map<string, ColumnSchema[]>();
  for (const row of rows) {
    const owned = readColumn(row);
    if (owned === null) continue;
    const columns = grouped.get(owned.key) ?? [];
    columns.push(owned.column);
    grouped.set(owned.key, columns);
  }
  return grouped;
}

/** The tables of the pinned catalog, in the order the server listed them. */
function readTableAddresses(rows: TrinoRow[]): TableAddress[] {
  return rows.flatMap((row) => {
    const schema = readIdentifier(row.schemaName);
    const table = readIdentifier(row.tableName);
    return schema === null || table === null ? [] : [{ schema, table }];
  });
}

/**
 * Every table of the pinned catalog, with its columns.
 *
 * The tree is TWO levels inside ONE catalog, which is the whole catalog decision
 * of this provider stated in code: the connection's `database` field pins a
 * catalog exactly the way a PostgreSQL connection pins a database, and the schemas
 * inside it are the schema level. Fanning `information_schema` out across every
 * catalog was the alternative and is unbounded - `jmx.current` alone publishes one
 * table per MBean - and it would make one sidebar refresh depend on every connector
 * the cluster has configured being reachable.
 *
 * A table's display name is therefore `schema.table`, always qualified: Trino
 * resolves an unqualified name only when the SESSION has a schema, and this
 * transport pins a catalog and no schema (there is no connection field for one),
 * so a bare name in a generated statement would not resolve at all.
 */
export async function getSchema(runner: TrinoQueryRunner, catalog: string): Promise<TableSchema[]> {
  const [tableRows, columnRows] = await Promise.all([
    readRows(runner, trinoTableListSql(catalog)),
    readRows(runner, trinoColumnListSql(catalog)),
  ]);

  const columns = groupColumns(columnRows);

  return readTableAddresses(tableRows).map((address) => ({
    name: `${address.schema}.${address.table}`,
    columns: columns.get(tableKey(address.schema, address.table)) ?? [],
    // Empty by construction, not by omission (shape 4).
    indexes: [],
    foreignKeys: [],
  }));
}

// ============================================================================
// Monitoring
// ============================================================================

/** The coordinator's row, or the first node when no row claims to be one. */
function coordinatorRow(rows: TrinoRow[]): TrinoRow | null {
  return rows.find((row) => row.isCoordinator === true) ?? rows[0] ?? null;
}

/**
 * What the cluster is, how much of it is up, and how much it is doing.
 *
 * Four separate reads rather than one joined statement, for the reason the header
 * gives: `jmx` is a catalog an operator may not have configured, and folding it
 * into the others would cost the version, the table count and the query count as
 * well as the uptime.
 */
export async function getOverview(runner: TrinoQueryRunner, catalog: string): Promise<DatabaseOverview> {
  const [nodeRows, jvm, tables, active] = await Promise.all([
    readOptionalRows(runner, TRINO_NODE_LIST_SQL),
    readOptionalRow(runner, TRINO_JVM_RUNTIME_SQL),
    readOptionalRow(runner, trinoTableCountSql(catalog)),
    readOptionalRow(runner, TRINO_ACTIVE_QUERY_COUNT_SQL),
  ]);

  const coordinator = coordinatorRow(nodeRows);
  const uptimeMs = readNumber(jvm?.uptimeMs);
  const startedAtMillis = readNumber(jvm?.startedAtMillis);

  return {
    version: readIdentifier(coordinator?.nodeVersion) ?? TRINO_UNKNOWN_TEXT,
    // Unknown rather than "0ms" when `jmx` did not answer: an uptime of zero claims
    // the coordinator booted this instant, which is a statement nothing made.
    uptime: uptimeMs === undefined ? TRINO_UNKNOWN_TEXT : formatDuration(uptimeMs),
    ...(startedAtMillis === undefined ? {} : { startTime: new Date(startedAtMillis) }),
    // Trino has no connections to count - the client protocol is stateless HTTP, so
    // there is no session object anywhere - and a statement in flight is the only
    // occupied thing the cluster has.
    activeConnections: nonNegative(readNumber(active?.activeQueries)),
    // Zero means "no limit published", the encoding `mssql.ts` and `druid` already
    // use: `query.max-concurrent-queries` is a coordinator config property and is not
    // published to any catalog, so this provider genuinely cannot see a ceiling.
    maxConnections: 0,
    // Trino stores nothing. The bytes are in the systems its connectors reach, and
    // `SHOW STATS` reports a per-table logical estimate that covers variable-width
    // columns only (shape 2) - summing that into "the database size" would be a
    // number that is neither a footprint nor complete.
    databaseSize: TRINO_UNAVAILABLE_TEXT,
    databaseSizeBytes: 0,
    tableCount: nonNegative(readNumber(tables?.tableCount)),
    // No index objects exist anywhere in Trino (shape 4).
    indexCount: 0,
  };
}

/**
 * The one performance number the cluster actually measures.
 *
 * Every other field of `PerformanceMetrics` is left ABSENT rather than zeroed, and
 * each absence is a different impossibility: Trino runs no transactions, so there
 * is no rate to report; it holds no buffer pool, because it holds no pages; it
 * takes no locks, so there are no deadlocks to count; it writes no checkpoints; and
 * its caches belong to the connectors, which publish no hit ratio here. A zero in
 * any of them would read as a MEASUREMENT of zero - and `cacheHitRatio` in
 * particular is scored `direction: "below"` with `critical: 80` by
 * `DEFAULT_THRESHOLDS`, so a "neutral" 0 would paint every healthy cluster red.
 */
export async function getPerformanceMetrics(runner: TrinoQueryRunner): Promise<PerformanceMetrics> {
  const row = await readOptionalRow(runner, TRINO_QUERY_RATE_SQL);
  const rate = readNumber(row?.completedPerSecond);

  return rate === undefined ? {} : { queriesPerSecond: Math.round(rate * 100) / 100 };
}

/**
 * The slowest statements in the coordinator's recent history.
 *
 * `calls: 1` on every row, and that is the honest reading rather than a
 * placeholder: `system.runtime.queries` records one row per EXECUTION, so there is
 * no aggregation to report and `totalTime` and `avgTime` are necessarily the same
 * number. `rows` is 0 for a harder reason - the table has no such column at all
 * (shape 5), and `SlowQueryStats.rows` is required, so this is the one field here
 * that cannot say "not reported".
 */
export async function getSlowQueries(
  runner: TrinoQueryRunner,
  options: { limit?: number } = {},
): Promise<SlowQueryStats[]> {
  const limit = rowLimit(options.limit, TRINO_DEFAULT_SLOW_QUERY_LIMIT);
  const rows = await readOptionalRows(runner, `${TRINO_SLOW_QUERY_SQL} LIMIT ${limit}`);

  return rows.map((row) => {
    const elapsedMs = nonNegative(readNumber(row.elapsedMs));

    return {
      queryId: readText(row.queryId),
      query: readText(row.statement),
      calls: 1,
      totalTime: elapsedMs,
      avgTime: elapsedMs,
      rows: 0,
    };
  });
}

/**
 * Empty, and empty because no index OBJECT exists rather than because none was
 * found.
 *
 * Trino's `information_schema` publishes no index view in any catalog (shape 4).
 * Whether the underlying system has indexes is its own business and unreadable
 * from here: a Postgres table reached through the Postgres connector still has its
 * indexes, and Trino will not name one of them. No statement is sent to discover
 * that, which is why this function takes no runner and is synchronous.
 */
export function getIndexStats(): IndexStats[] {
  return [];
}

/** The statements in flight, described as sessions. */
export async function getActiveSessions(
  runner: TrinoQueryRunner,
  options: { limit?: number } = {},
): Promise<ActiveSessionDetails[]> {
  const limit = rowLimit(options.limit, TRINO_DEFAULT_SESSION_LIMIT);
  const rows = await readOptionalRows(runner, `${TRINO_ACTIVE_QUERY_SQL} LIMIT ${limit}`);

  return rows.map((row) => {
    const durationMs = nonNegative(readNumber(row.elapsedMs));

    return {
      pid: readText(row.queryId),
      user: readText(row.userName),
      // Blank, because the coordinator does not record it: `system.runtime.queries`
      // has no catalog column (shape 5). Filling it with the connection's own pinned
      // catalog would credit every other client's statement with a catalog it may
      // never have touched.
      database: "",
      // `source` is whatever the client put in its own source header, so it is
      // genuinely an application name - and null for a client that sent none.
      applicationName: readText(row.source),
      state: readText(row.state),
      query: readText(row.statement),
      queryStart: readInstant(row.createdAt),
      duration: formatDuration(durationMs),
      durationMs,
    };
  });
}

/**
 * One `SHOW STATS` answer, read as the two different kinds of row it really is.
 *
 * The summary row is the one whose `column_name` is null, and it is the ONLY row
 * carrying `row_count` (shape 1). The per-column rows are the only ones carrying
 * `data_size`, and that value is null for every fixed-width column (shape 2), so
 * the sum below is the variable-width footprint and is labelled as an estimate
 * wherever it surfaces.
 */
function readTableStatistics(rows: TrinoRow[]): TableStatistics {
  let rowCount: number | undefined;
  let dataSizeBytes = 0;

  for (const row of rows) {
    if (readIdentifier(row.column_name) === null) {
      rowCount = readNumber(row.row_count);
      continue;
    }
    dataSizeBytes += readNumber(row.data_size) ?? 0;
  }

  return { rowCount, dataSizeBytes };
}

/**
 * Row counts and logical sizes, one `SHOW STATS` per table.
 *
 * A table whose connector published NO row count is left out entirely rather than
 * reported as zero (shape 3): `TableStats.rowCount` is a required number with no
 * way to say "unknown", and "0 rows" is a claim nothing made about a Hive table
 * nobody has run `ANALYZE` on. An empty panel on such a catalog is the honest
 * answer, and it is the same answer the connector would give.
 */
export async function getTableStats(
  runner: TrinoQueryRunner,
  catalog: string,
  options: { schema?: string } = {},
): Promise<TableStats[]> {
  const tableRows = await readOptionalRows(runner, trinoTableListSql(catalog));
  const addresses = readTableAddresses(tableRows)
    .filter((address) => options.schema === undefined || address.schema === options.schema)
    .slice(0, TRINO_MAX_STATS_TABLES);

  const answers = await Promise.all(
    addresses.map(async (address) => {
      const rows = await readOptionalRows(runner, trinoTableStatsSql(catalog, address.schema, address.table));
      return { address, statistics: readTableStatistics(rows) };
    }),
  );

  return answers.flatMap(({ address, statistics }) => {
    if (statistics.rowCount === undefined) return [];
    const sizeBytes = statistics.dataSizeBytes;

    return [
      {
        schemaName: address.schema,
        tableName: address.table,
        rowCount: statistics.rowCount,
        tableSize: formatBytes(sizeBytes),
        tableSizeBytes: sizeBytes,
        // The same number, not that number plus an index total: Trino has no index
        // objects to add (shape 4), so a separate `indexSize` would be a measurement
        // of something that does not exist and stays absent.
        totalSize: formatBytes(sizeBytes),
        totalSizeBytes: sizeBytes,
      },
    ];
  });
}

/**
 * The catalogs, which is where the data this engine queries actually lives.
 *
 * Not a misuse of the panel but the only true thing it can show: Trino stores
 * nothing, so a storage row describing Trino would describe an empty disk, while a
 * row per catalog names the system that DOES hold the data and the connector that
 * reaches it. The byte figures say so out loud - `size` is the string
 * "N/A" rather than a formatted zero, because no catalog publishes a total and
 * `SHOW STATS` answers per table with a variable-width estimate (shape 2).
 * `usagePercent` is absent for the same reason: there is no capacity to be a
 * fraction of.
 */
export async function getStorageStats(runner: TrinoQueryRunner): Promise<StorageStats[]> {
  const rows = await readOptionalRows(runner, TRINO_CATALOG_LIST_SQL);

  return rows.flatMap((row) => {
    const name = readIdentifier(row.catalogName);
    if (name === null) return [];

    return [
      {
        name,
        location: readText(row.connectorName),
        size: TRINO_UNAVAILABLE_TEXT,
        sizeBytes: 0,
      },
    ];
  });
}

/** The narrower shape the health summary embeds. */
function toSlowQuery(stats: SlowQueryStats): SlowQuery {
  return { query: stats.query, calls: stats.calls, avgTime: formatDuration(stats.avgTime) };
}

/** The narrower shape the health summary embeds. */
function toActiveSession(session: ActiveSessionDetails): ActiveSession {
  return {
    pid: session.pid,
    user: session.user,
    database: session.database,
    state: session.state,
    query: session.query,
    duration: session.duration,
  };
}

/** The health summary, composed from the reads that have a source. */
export async function getHealth(runner: TrinoQueryRunner, catalog: string): Promise<HealthInfo> {
  const [overview, slow, sessions] = await Promise.all([
    getOverview(runner, catalog),
    getSlowQueries(runner, { limit: TRINO_HEALTH_LIMIT }),
    getActiveSessions(runner, { limit: TRINO_HEALTH_LIMIT }),
  ]);

  return {
    // Both DatabaseOverview.activeConnections and HealthInfo.activeConnections
    // are optional; this provider's overview never omits it, so the value just
    // passes through unchanged.
    activeConnections: overview.activeConnections,
    databaseSize: overview.databaseSize,
    // A string, so it can decline: Trino caches nothing at this layer and a
    // connector's own cache publishes no ratio here.
    cacheHitRatio: TRINO_UNAVAILABLE_TEXT,
    slowQueries: slow.map(toSlowQuery),
    activeSessions: sessions.map(toActiveSession),
  };
}
