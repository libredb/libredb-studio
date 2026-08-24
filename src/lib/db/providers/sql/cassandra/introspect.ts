/**
 * Cassandra's catalog and its virtual tables (issue #424, Phase 4).
 *
 * Every statement here is a fixed read against `system_schema` (the real catalog,
 * replicated across the ring) or `system_views` (the node-local virtual tables new
 * in 4.0), and every one of them was run against a live 5.0.9 on 2026-08-20 before
 * this file existed.
 *
 * The load-bearing decisions are ABSENCES, and each one is a number this module
 * refuses to invent:
 *
 * - NO ROW COUNT. `system.size_estimates` counts PARTITIONS, per token range (17
 *   rows per table), from FLUSHED SSTables only, refreshed every five minutes.
 *   Measured: 0 immediately after loading 500 rows, then 525 for those 500 rows,
 *   2049 for 2000 - and 143 for a 500-row table of 10 partitions x 50 clustering
 *   rows. `SELECT COUNT(*)` is exact and is a full scan of the ring, which is not
 *   something a schema tree may do on every refresh (measured: it is also the one
 *   statement that hit a server read timeout on a 1ms-timeout node). So no
 *   `rowCount` is reported anywhere.
 * - NO SIZE. `system_views.disk_usage` and `system_views.max_partition_size` are
 *   whole MEBIBYTES: both reported "1 MiB" for a 19,476-byte table, and `disk_usage`
 *   reported "0 MiB" for a table holding 500 rows that had not yet been flushed. A
 *   byte figure derived from either reading would be wrong by up to 50x, so the
 *   overview reports no database size and the storage panel is empty.
 * - NO SLOW QUERY LOG. `system_views.system_logs` exists and returned 0 rows on this
 *   image, and it is a log tail rather than an aggregate over finished statements.
 * - NO INDEX STATISTICS. `system_schema.indexes` names an index and its target
 *   column; nothing CQL can read reports its size or how often it was used.
 *
 * What IS honest: the version, the node's start time (the gossip generation is that,
 * in epoch seconds - verified against two containers' own start times), the
 * connected-client count, the table and index counts, the key cache's own hit ratio,
 * and the statements running right now.
 */

import { formatDuration } from "@/lib/db/utils/pool-manager";
import { quoteLiteral } from "@/lib/sql/values";
import type {
  ActiveSession,
  ActiveSessionDetails,
  ColumnSchema,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  PerformanceMetrics,
  SlowQueryStats,
  StorageStats,
  TableSchema,
  TableStats,
} from "@/lib/db/types";
import type { CassandraRow, CassandraTransport } from "./transport";
import { CassandraTransportError } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * What a figure this engine does not publish reads as.
 *
 * A string rather than a zero, for the reason `druid/introspect.ts` gives about its
 * cache ratio: "0 bytes" and "0%" are measurements, and the panels score them as
 * such. "N/A" is the same token Druid uses.
 */
export const CASSANDRA_SIZE_UNAVAILABLE = "N/A";

/** What a field the server does not publish reads as, matching Druid's own word. */
export const CASSANDRA_UNKNOWN_TEXT = "unknown";

/** The product name, so the overview never shows a bare "5.0.9". */
const CASSANDRA_PRODUCT = "Apache Cassandra";

/**
 * The cache whose hit ratio is worth reporting.
 *
 * `system_views.caches` publishes three rows - `counters`, `keys`, `rows` - and only
 * the key cache is on by default (measured: the row cache and the counter cache
 * reported a null ratio and zero requests on a node that had served 500 reads). The
 * key cache's ratio is a real measurement of a real cache, which is what the metric
 * claims to be.
 */
const KEY_CACHE_NAME = "keys";

/** How many running statements the panel asks for when the caller names no limit. */
const DEFAULT_SESSION_LIMIT = 50;

// ============================================================================
// Statements
// ============================================================================

/**
 * Who this node is, and since when, on the SERVER's clock.
 *
 * `gossip_generation` is the node's start time in epoch seconds. That is not read
 * off the field's name: measured on two independent 5.0.9 containers, the value
 * matched the container's own start to within four seconds on the first, and the
 * difference between the two nodes' generations (4997s) matched the difference
 * between their container start times (4998s) to within one second. It is bumped on
 * restart, which is what makes it a start time; where the gossiper has to advance it
 * past a stale value the reading can only be LATER than the real start, so the
 * uptime is under-reported rather than over.
 *
 * `toTimestamp(now())` is the coordinator's own clock, so the uptime never depends
 * on this process's.
 *
 * `native_protocol_version` is deliberately NOT read: it says 5 while
 * `system_views.clients.protocol_version` for the live session says 4, so reporting
 * it as the session's protocol would be wrong.
 */
export const CASSANDRA_IDENTITY_CQL =
  "SELECT release_version, cluster_name, data_center, gossip_generation, toTimestamp(now()) AS server_now FROM system.local";

/** How many clients are connected to THIS node. Permission-gated (measured: 8448). */
export const CASSANDRA_CLIENT_COUNT_CQL = "SELECT COUNT(*) AS count FROM system_views.clients";

/**
 * All three cache rows, filtered in code rather than in a `WHERE`.
 *
 * Three rows is not worth a predicate whose correctness depends on `name` being the
 * partition key of a virtual table, and reading them all is what the probe did.
 */
export const CASSANDRA_CACHE_CQL = "SELECT name, hit_ratio FROM system_views.caches";

/**
 * The statements running right now.
 *
 * It includes this read itself - the coordinator is running it while it answers -
 * which is honest rather than noise: the panel is a snapshot of the node's own
 * request threads.
 */
export const CASSANDRA_RUNNING_QUERY_CQL =
  "SELECT thread_id, queued_micros, running_micros, task FROM system_views.queries";

/** The tables of one keyspace. A materialized view is NOT among them (measured). */
export function cassandraTableListCql(keyspace: string): string {
  return `SELECT table_name FROM system_schema.tables WHERE keyspace_name = ${literal(keyspace)}`;
}

/**
 * The materialized views of one keyspace.
 *
 * Usually empty, and that is a property of the SERVER rather than of this read:
 * materialized views are disabled by default in 5.0, so `CREATE MATERIALIZED VIEW`
 * answers "Materialized views are disabled. Enable in cassandra.yaml to use." Where
 * one does exist it is queryable exactly like a table and refuses every write
 * ("Cannot directly modify a materialized view"), so the tree lists it beside them.
 */
export function cassandraViewListCql(keyspace: string): string {
  return `SELECT view_name, base_table_name FROM system_schema.views WHERE keyspace_name = ${literal(keyspace)}`;
}

/**
 * Every column of every table AND every view in one keyspace, in one read.
 *
 * `position` is 0-based WITHIN its kind - partition key or clustering - and -1 for
 * every regular and static column, so it cannot order the table as declared. The
 * server returns the rows alphabetically by table and then by column name.
 */
export function cassandraColumnListCql(keyspace: string): string {
  return `SELECT table_name, column_name, type, kind, position, clustering_order FROM system_schema.columns WHERE keyspace_name = ${literal(keyspace)}`;
}

/** The secondary indexes of one keyspace; `options.target` names the indexed column. */
export function cassandraIndexListCql(keyspace: string): string {
  return `SELECT table_name, index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = ${literal(keyspace)}`;
}

export function cassandraTableCountCql(keyspace: string): string {
  return `SELECT COUNT(*) AS count FROM system_schema.tables WHERE keyspace_name = ${literal(keyspace)}`;
}

export function cassandraIndexCountCql(keyspace: string): string {
  return `SELECT COUNT(*) AS count FROM system_schema.indexes WHERE keyspace_name = ${literal(keyspace)}`;
}

/**
 * A keyspace name as a CQL string literal.
 *
 * Through the shared quoter rather than by hand, so the dialect's escape rule is the
 * one recorded in `lib/sql/values.ts` - CQL doubles the quote and reads a backslash
 * as data, both measured. A keyspace name cannot contain a quote today, and that is
 * exactly the kind of assumption this function exists to not depend on.
 */
function literal(value: string): string {
  return quoteLiteral(value, "cassandra");
}

// ============================================================================
// Value helpers
// ============================================================================

/** A string the server sent, or "" when it sent nothing usable. */
function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A number the server sent, or 0.
 *
 * Strings are parsed because that is how the big integers arrive: a `COUNT(*)` is a
 * `Long`, and the driver adapter turns one into its exact decimal string rather than
 * a rounded double.
 */
function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return typeof value === "string" && value !== "" && Number.isFinite(parsed) ? parsed : 0;
}

/** The one number a `SELECT COUNT(*) AS count` answered. */
function readCount(rows: CassandraRow[]): number {
  return asNumber(rows[0]?.count);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The keyspaces a monitoring read may find missing on a wire-compatible build.
 *
 * `system_views` and nothing else. It is Cassandra's virtual-table keyspace, added in
 * 4.0, and ScyllaDB does not have it at all: measured 2026-08-24 against
 * scylladb/scylla:2026.2.4, every one of the three reads above answers
 * `Keyspace system_views does not exist` (8704) while `system.local`,
 * `system_schema.*` and `system.size_estimates` all answer normally.
 *
 * An allowlist rather than "any absent keyspace", because the discriminator is text
 * and text is all the server gives ([`transport.ts`](./transport.ts) records the four
 * measured spellings). `system_schema` is deliberately NOT here: it is readable on
 * every measured build and even by a least-privilege role, so a server refusing the
 * whole keyspace is a fault the tree must not hide. `system_viewz` - the shape of a
 * typo in this file - is not here either, which is the point of naming names.
 */
const CASSANDRA_OPTIONAL_KEYSPACES = new Set(["system_views"]);

/**
 * One read, or no rows when this server cannot answer it at all.
 *
 * Two conditions, and both are narrow on purpose - an empty panel that hides a typo
 * in the statements above hides it forever:
 *
 * 1. `permission`, the measured shape of a restricted role: it reads all of
 *    `system_schema` and is refused `system_views.clients` with code 8448, so a denied
 *    monitoring surface is the ORDINARY case rather than a broken connection.
 * 2. An `invalid` naming an ABSENT KEYSPACE this provider knows is optional - which is
 *    every ScyllaDB build. A fact about the server, not about the CQL:
 *    the same code 8704 carrying a missing table, a missing column or a misspelled
 *    keyspace still propagates, because none of those three name an optional keyspace.
 *
 * Everything else propagates, exactly as before.
 */
async function readRows(transport: CassandraTransport, cql: string): Promise<CassandraRow[]> {
  try {
    return (await transport.execute(cql)).rows;
  } catch (error) {
    if (error instanceof CassandraTransportError && isDegradable(error)) return [];
    throw error;
  }
}

/** Whether this failure is one of the two a monitoring panel may answer empty for. */
function isDegradable(error: CassandraTransportError): boolean {
  if (error.isMonitoringUnavailable()) return true;
  const absent = error.absentKeyspace();

  return absent !== null && CASSANDRA_OPTIONAL_KEYSPACES.has(absent.toLowerCase());
}

// ============================================================================
// Schema
// ============================================================================

/** Where a column sits in the primary key, and whether it is in one at all. */
const PARTITION_KEY = "partition_key";
const CLUSTERING = "clustering";

/**
 * How the columns of one table are ordered for display.
 *
 * DECLARATION ORDER IS NOT RECOVERABLE, and this is the whole reason the order is
 * stated here rather than taken from the server: `system_schema.columns.position` is
 * -1 for every regular and static column, and the rows come back sorted by column
 * name. So the choice is between an order that means something and an alphabetical
 * list that pretends to be the DDL.
 *
 * The order is the one CQL itself puts first: the partition key (by its own
 * position), then the clustering columns (by theirs), then everything else
 * alphabetically - which is also how `DESCRIBE TABLE` prints a table, and how the
 * primary key has to be written in a `WHERE` clause.
 */
function columnRank(kind: string): number {
  if (kind === PARTITION_KEY) return 0;
  if (kind === CLUSTERING) return 1;
  return 2;
}

function toColumnSchema(row: CassandraRow): ColumnSchema {
  const kind = readText(row.kind);

  return {
    name: readText(row.column_name),
    // The declared CQL spelling, verbatim: `text`, `frozen<list<int>>`,
    // `vector<float, 3>`, `frozen<address>` for a UDT. This is the DDL word, unlike
    // the wire declaration a result carries, where `text` reads back as `varchar`.
    type: readText(row.type),
    // Only a primary-key component is non-nullable, and it is non-nullable
    // absolutely: CQL has no NOT NULL to declare on anything else, and every regular
    // column of an existing row may be missing entirely.
    nullable: columnRank(kind) === 2,
    isPrimary: columnRank(kind) < 2,
  };
}

function tableColumns(rows: CassandraRow[]): ColumnSchema[] {
  return rows
    .slice()
    .sort((left, right) => {
      const byKind = columnRank(readText(left.kind)) - columnRank(readText(right.kind));
      if (byKind !== 0) return byKind;
      const byPosition = asNumber(left.position) - asNumber(right.position);
      if (byPosition !== 0) return byPosition;

      return readText(left.column_name).localeCompare(readText(right.column_name));
    })
    .map(toColumnSchema);
}

/**
 * The tables and materialized views of one keyspace, with their columns and indexes.
 *
 * Three reads rather than one join, because CQL has no join at all - and three
 * rather than four because a view's columns are in the same `system_schema.columns`
 * the tables' are, keyed by the view's name.
 *
 * Every table carries `foreignKeys: []`, and the provider declares
 * `declaresForeignKeys: false` so a reader knows that means "this engine has none"
 * rather than "this schema declares none".
 *
 * These four reads deliberately do NOT degrade on a refused grant, unlike the
 * monitoring reads below: measured, `system_schema` is readable by a least-privilege
 * role for every table in every keyspace, so a denial here is abnormal and an empty
 * tree would hide it. (The consequence of that same measurement is worth knowing from
 * the other side: the tree therefore lists tables the connected role cannot SELECT
 * from, which is Cassandra's own permission model rather than a defect here.)
 */
export async function getSchema(transport: CassandraTransport, keyspace: string): Promise<TableSchema[]> {
  const [tables, views, columns, indexes] = await Promise.all([
    transport.execute(cassandraTableListCql(keyspace)),
    transport.execute(cassandraViewListCql(keyspace)),
    transport.execute(cassandraColumnListCql(keyspace)),
    transport.execute(cassandraIndexListCql(keyspace)),
  ]);

  const names = [
    ...tables.rows.map((row) => readText(row.table_name)),
    ...views.rows.map((row) => readText(row.view_name)),
  ];

  return names.map((name) => ({
    name,
    columns: tableColumns(columns.rows.filter((row) => readText(row.table_name) === name)),
    indexes: indexes.rows
      .filter((row) => readText(row.table_name) === name)
      .map((row) => ({
        name: readText(row.index_name),
        // `options` is a map, and `target` is the indexed column. A legacy secondary
        // index (kind COMPOSITES) targets exactly one; the field also carries the
        // full target expression for the newer index kinds.
        columns: [readText((row.options as Record<string, unknown> | null)?.target)],
        // No index in Cassandra enforces uniqueness. `CREATE UNIQUE INDEX` is a
        // syntax error - the keyword is not in the grammar (measured) - so `false`
        // here is the engine's answer rather than this schema's.
        unique: false,
      })),
    foreignKeys: [],
  }));
}

// ============================================================================
// Monitoring
// ============================================================================

/**
 * What the cluster is, how long this node has been up, and how much it holds - minus
 * the two figures it cannot answer.
 *
 * Four separate reads rather than one statement, for the reason ClickHouse's
 * overview gives: the virtual tables are permission-gated PER TABLE, so a role that
 * is refused `system_views.clients` must still get the version and the counts that
 * `system.local` and `system_schema` answer happily. Measured with a least-privilege
 * role: `system.local`, `system.peers_v2` and all of `system_schema` are readable,
 * while `system_views.clients`, `system_views.caches` and `system_views.queries` each
 * answer 8448.
 *
 * The identity read is therefore the one that does NOT degrade: the driver's own
 * control connection reads `system.local` for the cluster's topology before this
 * provider can send anything, so a session that exists can read it, and a failure
 * there is a real fault rather than a permission gate. The fallbacks below are for a
 * server that answers the statement with no row at all - which no measured version
 * does - and they cost nothing to keep honest.
 */
export async function getOverview(transport: CassandraTransport, keyspace: string): Promise<DatabaseOverview> {
  const [identity, clients, tables, indexes] = await Promise.all([
    transport.execute(CASSANDRA_IDENTITY_CQL),
    readRows(transport, CASSANDRA_CLIENT_COUNT_CQL),
    readRows(transport, cassandraTableCountCql(keyspace)),
    readRows(transport, cassandraIndexCountCql(keyspace)),
  ]);

  const row = identity.rows[0];
  const version = readText(row?.release_version);
  const startedAt = asNumber(row?.gossip_generation);
  const serverNow = row?.server_now;
  const startTime = startedAt > 0 ? new Date(startedAt * 1000) : undefined;
  // Milliseconds since this node started, or -1 for "there is no clock reading here".
  // A negative sentinel rather than a zero: an uptime of zero claims the node booted
  // this instant, which the server never said.
  const upFor = startTime !== undefined && serverNow instanceof Date ? serverNow.getTime() - startTime.getTime() : -1;

  return {
    version: version === "" ? CASSANDRA_UNKNOWN_TEXT : `${CASSANDRA_PRODUCT} ${version}`,
    uptime: upFor < 0 ? CASSANDRA_UNKNOWN_TEXT : formatDuration(upFor),
    ...(startTime === undefined ? {} : { startTime }),
    activeConnections: readCount(clients),
    // Zero means "no ceiling published", which is the truth: Cassandra's
    // `native_transport_max_concurrent_connections` defaults to unlimited and is a
    // configuration reading rather than a live capacity. The Connections card treats
    // a zero limit as "no limit published" rather than dividing by it.
    maxConnections: 0,
    // The one figure #424 exists to refuse. `system_views.disk_usage` is whole
    // mebibytes - measured, "1 MiB" for a 19,476-byte table, and "0 MiB" for a table
    // holding 500 unflushed rows - and `size_estimates` describes partitions rather
    // than bytes. `databaseSizeBytes` is therefore OMITTED, not zeroed: a zero is a
    // measurement, and the Storage tab read `?? 0` and rendered "0 B" with a 0.0%
    // breakdown from it.
    databaseSize: CASSANDRA_SIZE_UNAVAILABLE,
    tableCount: readCount(tables),
    indexCount: readCount(indexes),
  };
}

/**
 * The key cache's hit ratio, and nothing else.
 *
 * Every other field of `PerformanceMetrics` is OMITTED rather than zeroed, because a
 * zero is a measurement: Cassandra publishes its throughput and latency as
 * percentiles per table (`system_views.local_read_latency`,
 * `coordinator_read_latency`) rather than as a cluster rate, and `cql_metrics`
 * counts prepared statements rather than statements per second. There is no
 * queries-per-second figure to read, so none is claimed.
 *
 * The ratio itself is omitted when the server reports null - which is what an unused
 * cache reports (measured). `DEFAULT_THRESHOLDS` scores this metric `direction:
 * "below"` with `critical: 80`, so substituting a zero would paint an idle cluster
 * red.
 */
export async function getPerformanceMetrics(transport: CassandraTransport): Promise<PerformanceMetrics> {
  const rows = await readRows(transport, CASSANDRA_CACHE_CQL);
  const ratio = rows.find((row) => readText(row.name) === KEY_CACHE_NAME)?.hit_ratio;

  return typeof ratio === "number" ? { cacheHitRatio: round2(ratio * 100) } : {};
}

/**
 * Empty, because there is no slow-query log to read.
 *
 * Not a permission gate and not a switched-off feature: Cassandra keeps no aggregate
 * of finished statements anywhere CQL can reach. `system_views.system_logs` is a tail
 * of the node's log file (0 rows on this image), and the slow-query threshold that
 * exists writes to that log rather than to a table. No statement is sent to discover
 * this.
 */
export function getSlowQueries(): SlowQueryStats[] {
  return [];
}

/**
 * The statements this node is running now.
 *
 * `system_views.queries` is the only source, and what it does NOT publish decides
 * most of this mapping: there is no user, no keyspace, no client address and no start
 * timestamp on the row - only the request thread, the task text and two microsecond
 * readings. The connected role is deliberately not borrowed for `user`: it would
 * credit this connection with a statement another client is running.
 */
export async function getActiveSessions(
  transport: CassandraTransport,
  options: { limit?: number } = {},
): Promise<ActiveSessionDetails[]> {
  const limit = Math.trunc(options.limit ?? DEFAULT_SESSION_LIMIT);
  const rows = await readRows(transport, CASSANDRA_RUNNING_QUERY_CQL);

  // A zero is honoured, a negative is not. The three SQL siblings that take this option
  // all pass a zero straight through - PostgreSQL to `LIMIT $2`, MSSQL to `SELECT TOP`,
  // Oracle to `ROWNUM <= 0` - so all three answer no rows, and substituting the default
  // would make this the one engine where asking for none returns fifty. A negative is
  // not an amount at all, and unlike those three this list is sliced locally, so it
  // costs one comparison to refuse it rather than hand it to `slice` backwards.
  return rows.slice(0, limit < 0 ? DEFAULT_SESSION_LIMIT : limit).map((row) => {
    // Microseconds, so the millisecond figure the panel wants is a division rather
    // than a cast - and it is kept fractional: a 1118µs statement is 1.118ms, and
    // rounding it to 1 would hide the only precision the server offered.
    const durationMs = asNumber(row.running_micros) / 1000;

    return {
      pid: readText(row.thread_id),
      user: CASSANDRA_UNKNOWN_TEXT,
      database: CASSANDRA_UNKNOWN_TEXT,
      state: "running",
      query: readText(row.task),
      duration: formatDuration(durationMs),
      durationMs,
    };
  });
}

/**
 * Empty, because every figure a table statistic needs is one this engine cannot give
 * honestly.
 *
 * `TableStats` requires a row count and a byte size. The row count would have to come
 * from `system.size_estimates`, which counts PARTITIONS per token range from flushed
 * SSTables - measured at 143 for a 500-row clustered table, 525 for a 500-row one -
 * and the size from `system_views.disk_usage`, which is whole mebibytes and reported
 * "1 MiB" for 19,476 bytes. Either would render as a confident number that is wrong,
 * which is the failure this whole issue exists to avoid; an empty panel is the
 * honest alternative. No statement is sent.
 */
export function getTableStats(): TableStats[] {
  return [];
}

/**
 * Empty, because an index here has no size and no usage counter.
 *
 * `system_schema.indexes` names an index, its table and its target column - all of
 * which the schema tree already shows - and `IndexStats` also requires a size and a
 * scan count. Nothing reachable from CQL reports either for a secondary index, and a
 * zeroed scan count would read as "never used".
 */
export function getIndexStats(): IndexStats[] {
  return [];
}

/**
 * Empty, for the same reason as the database size.
 *
 * The only storage figures a statement can read - `disk_usage`,
 * `max_partition_size`, `max_sstable_size` - are whole mebibytes per table, and
 * `StorageStats` wants a byte figure. Multiplying a rounded mebibyte by 1048576 would
 * turn a 19KB table into a confident 1MB.
 */
export function getStorageStats(): StorageStats[] {
  return [];
}

/**
 * The health summary, from the same reads as the overview and the sessions panel.
 *
 * `slowQueries` is written out as `[]` rather than mapped from `getSlowQueries()`:
 * the summary needs the narrower `SlowQuery` shape, and a mapper over a list that is
 * always empty would be a body no test could reach.
 */
export async function getHealth(transport: CassandraTransport, keyspace: string): Promise<HealthInfo> {
  const [overview, performance, sessions] = await Promise.all([
    getOverview(transport, keyspace),
    getPerformanceMetrics(transport),
    getActiveSessions(transport),
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
    cacheHitRatio:
      performance.cacheHitRatio === undefined ? CASSANDRA_SIZE_UNAVAILABLE : `${performance.cacheHitRatio}%`,
    slowQueries: [],
    activeSessions,
  };
}
