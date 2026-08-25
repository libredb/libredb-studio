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
  PerformanceMetrics,
  SlowQueryStats,
  TableSchema,
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

/**
 * Whether this build has the virtual-table keyspace the monitoring reads need.
 *
 * Asked ONCE per connection, and it is the whole discriminator behind the degradation
 * below: a build that does not list `system_views` here is not asked for
 * `system_views` at all. That is a property of the server rather than of the wording
 * of a refusal - which is what this replaced (2026-08-24).
 *
 * `system_virtual_schema` and NOT `system_schema` is the load-bearing part, measured
 * 2026-08-24 through `cassandra-driver` 4.9.0:
 *
 * | Statement | cassandra:5.0.9 | scylladb/scylla:2026.2.4 |
 * |---|---|---|
 * | `SELECT keyspace_name FROM system_schema.keyspaces` | `probe, system, system_auth, system_distributed, system_schema, system_traces` - NO `system_views` | 9 rows, no `system_views` either |
 * | `SELECT keyspace_name FROM system_virtual_schema.keyspaces` | `system_views, system_virtual_schema` | 8704 `Keyspace system_virtual_schema does not exist` |
 *
 * A virtual keyspace is not in `system_schema` on either engine, so keying on that
 * catalog - which the backlog entry behind this change proposed - would have emptied all five panels on the
 * engine that answers them.
 *
 * COST: one extra statement per successful `connect()`, measured at 1.5 ms against
 * 5.0.9 over loopback. Nothing re-reads it: a keyspace cannot appear inside a
 * session's lifetime without a node restart, and a restart drops the session.
 */
export const CASSANDRA_VIRTUAL_KEYSPACE_CQL = "SELECT keyspace_name FROM system_virtual_schema.keyspaces";

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
 * The one keyspace a monitoring read may find missing on a wire-compatible build.
 *
 * `system_views` and nothing else. It is Cassandra's virtual-table keyspace, added in
 * 4.0, and ScyllaDB does not have it at all: measured 2026-08-24 against
 * scylladb/scylla:2026.2.4, every one of the three reads above answers
 * `Keyspace system_views does not exist` (8704) while `system.local`,
 * `system_schema.*` and `system.size_estimates` all answer normally.
 *
 * One NAME rather than "any absent keyspace", because the two are different facts: a
 * server without `system_views` is a dialect difference, a server without
 * `system_schema` is a fault the tree must not hide - and `system_viewz`, the shape of
 * a typo in this file, is neither.
 */
const CASSANDRA_VIRTUAL_KEYSPACE = "system_views";

/** A read that cannot work on a build with no virtual tables. Matched on THIS file's own CQL. */
const READS_VIRTUAL_KEYSPACE = new RegExp(`\\bFROM\\s+${CASSANDRA_VIRTUAL_KEYSPACE}\\.`, "i");

/**
 * Why this build has no virtual tables, in the server's own terms.
 *
 * One sentence per measured cause rather than one shared "unavailable": the three are
 * different facts and send the reader to different places. They are the only text a
 * user sees where a virtual-table panel would have been, so each names what is missing
 * rather than that something is.
 */
const NO_VIRTUAL_SCHEMA_CATALOG =
  'this server has no system_virtual_schema catalog at all, so it publishes no virtual tables (measured against scylladb/scylla:2026.2.4, which answers "Keyspace system_virtual_schema does not exist")';

const VIRTUAL_SCHEMA_DENIED =
  "the connected role may not read system_virtual_schema, so this session cannot reach the virtual tables it describes";

const VIRTUAL_KEYSPACE_ABSENT = "this server's system_virtual_schema.keyspaces does not list a system_views keyspace";

/**
 * What this connection established about the server once, at connect time.
 *
 * One field today, and it is here rather than re-derived per read because the answer
 * cannot change while the session lives (see `CASSANDRA_VIRTUAL_KEYSPACE_CQL`).
 *
 * It is a REASON and not a boolean, because a panel that has to report its own absence
 * needs a sentence and there are three different ones: a build with no virtual-schema
 * catalog, a build whose catalog lists no `system_views`, and a role that may not read
 * the catalog are all "no virtual tables here" and none of them says the same thing to
 * the user. Present means absent - the field holds the reason - and `undefined` means
 * this build has the keyspace, which is the only state in which a `system_views` read
 * is sent at all.
 */
export interface CassandraServerFacts {
  /** Why `system_views` cannot be read here, or `undefined` when it can. */
  readonly virtualTablesAbsence?: string;
}

/**
 * The sentence a panel whose only source is a virtual table reports instead of rows.
 *
 * ABSENCE is not ZERO (`MonitoringData` in `src/lib/db/types.ts`): a panel left absent
 * with this sentence under `errors` says the engine could not answer, while the empty
 * array it used to return said the engine looked and found nothing. Measured
 * 2026-08-24 in the browser against ScyllaDB 2026.2.4, the second reading rendered as
 * "Active 0 / Idle 0 / Wait 0 / Sessions (0) / No active sessions found." for a
 * question that build cannot answer at all.
 */
export function cassandraVirtualTableRefusal(source: string, absence: string): string {
  // No engine name in the sentence: the same provider serves ScyllaDB and every other
  // relative (#455), and this refusal is the one a ScyllaDB user reads most often - naming
  // Apache Cassandra there would tell them about a server they are not connected to.
  return `This panel is read from ${source}, and ${absence}. The statement was not sent, so there is no measurement here rather than a measurement of zero.`;
}

/**
 * The three panels this engine refuses on EVERY build, virtual tables or not.
 *
 * "This engine family" and not "Apache Cassandra": the same provider serves ScyllaDB and
 * every other relative (#455), and a ScyllaDB user reading about a server they are not
 * connected to is the wrong kind of precision. The measurements below were taken on
 * Apache Cassandra 5.0.9 and the limits are the data model's, not one build's.
 *
 * Each one is the reason the corresponding `get*Stats` above used to return `[]`, moved
 * to where the user can read it: the objects exist - the schema tree lists the tables
 * and the secondary indexes - so an empty panel claimed a measurement of nothing where
 * the truth is that the figures the panel requires are not published in any honest unit.
 */
export const CASSANDRA_TABLE_STATS_REFUSAL =
  "This engine family publishes no honest table statistics. A row count would have to come from system.size_estimates, which counts PARTITIONS per token range from flushed SSTables only (measured: 143 for a 500-row clustered table, 525 for a 500-row one), and a size from system_views.disk_usage, which reports whole mebibytes (measured: 1 MiB for a 19,476-byte table). The tables are in the schema tree; these two numbers are not knowable from CQL.";

export const CASSANDRA_INDEX_STATS_REFUSAL =
  "This engine family publishes no index statistics. system_schema.indexes names an index, its table and its target column - all of which the schema tree already shows - and nothing reachable from CQL reports a secondary index's size or how often it was used. The indexes exist; the numbers this panel requires do not.";

export const CASSANDRA_STORAGE_STATS_REFUSAL =
  "This engine family publishes no byte-level storage figures. disk_usage, max_partition_size and max_sstable_size are whole mebibytes per table (measured: 1 MiB for a 19,476-byte table, 0 MiB for a table holding 500 unflushed rows), and multiplying a rounded mebibyte would report a 19 KB table as a confident 1 MB.";

/**
 * Ask the server which virtual keyspaces it has. Never throws.
 *
 * Three outcomes, and none of them reads a sentence:
 *
 * - the catalog answered -> the NAME is either in it or it is not;
 * - the catalog was refused as `invalid` (8704) -> there is no virtual-schema catalog,
 *   so there are no virtual tables. This is ScyllaDB, measured: the probe itself is
 *   `Keyspace system_virtual_schema does not exist`, and the CODE is what is read;
 * - the catalog was refused as `permission` (8448) -> a role that may not read the
 *   virtual schema is the role that may not read `system_views` either.
 *
 * Each of the three absences carries its OWN sentence out, because it is the text the
 * monitoring panels report in place of rows and the three send the reader to different
 * places: a dialect difference, a schema this build does not publish, and a grant.
 *
 * Anything else - a client timeout, an unreachable host - says nothing about which
 * keyspaces exist, so it claims no absence: the reads go out and their own failure is
 * what the caller sees, exactly as before this probe existed. That is also why this
 * cannot fail a `connect()`.
 */
export async function readServerFacts(transport: CassandraTransport): Promise<CassandraServerFacts> {
  try {
    const { rows } = await transport.execute(CASSANDRA_VIRTUAL_KEYSPACE_CQL);
    const listed = rows.some((row) => readText(row.keyspace_name) === CASSANDRA_VIRTUAL_KEYSPACE);

    return listed ? {} : { virtualTablesAbsence: VIRTUAL_KEYSPACE_ABSENT };
  } catch (error) {
    if (error instanceof CassandraTransportError) {
      if (error.category === "invalid") return { virtualTablesAbsence: NO_VIRTUAL_SCHEMA_CATALOG };
      if (error.isMonitoringUnavailable()) return { virtualTablesAbsence: VIRTUAL_SCHEMA_DENIED };
    }

    return {};
  }
}

/**
 * One read, or no rows when this server cannot answer it at all.
 *
 * Two conditions, and both are narrow on purpose - an empty panel that hides a typo
 * in the statements above hides it forever:
 *
 * 1. The read needs `system_views` and this build measurably has no such keyspace,
 *    which is every ScyllaDB build. The statement is then NOT SENT: the fact was
 *    established at connect time, so there is nothing to learn from asking, and three
 *    round trips per monitoring refresh are saved. A typo in a TABLE or COLUMN name
 *    inside `system_views` is unaffected on a build that has the keyspace - the read
 *    goes out and the refusal propagates - and on a build that does NOT have it the
 *    typo is unreachable, which is the one case the old text match could not separate
 *    either.
 * 2. `permission`, the measured shape of a restricted role: it reads all of
 *    `system_schema` and is refused `system_views.clients` with code 8448, so a denied
 *    monitoring surface is the ORDINARY case rather than a broken connection.
 *
 * Everything else propagates: a missing table, a missing column, a misspelled
 * keyspace (`system_viewz` names nothing this provider knows is optional) and every
 * fault that is not a refusal at all.
 */
async function readRows(
  transport: CassandraTransport,
  cql: string,
  facts: CassandraServerFacts,
): Promise<CassandraRow[]> {
  if (facts.virtualTablesAbsence !== undefined && READS_VIRTUAL_KEYSPACE.test(cql)) return [];

  try {
    return (await transport.execute(cql)).rows;
  } catch (error) {
    if (error instanceof CassandraTransportError && error.isMonitoringUnavailable()) return [];
    throw error;
  }
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
export async function getOverview(
  transport: CassandraTransport,
  keyspace: string,
  facts: CassandraServerFacts,
): Promise<DatabaseOverview> {
  const [identity, clients, tables, indexes] = await Promise.all([
    transport.execute(CASSANDRA_IDENTITY_CQL),
    readRows(transport, CASSANDRA_CLIENT_COUNT_CQL, facts),
    readRows(transport, cassandraTableCountCql(keyspace), facts),
    readRows(transport, cassandraIndexCountCql(keyspace), facts),
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
    // OMITTED, not zeroed, when `clients` came back empty: a successful
    // `SELECT COUNT(*)` always answers exactly one row (a table with nothing to
    // count still reports `count: 0`), so no row at all is the signature of the
    // degradation `readRows` catches - a denied grant or, on ScyllaDB, a
    // `system_views` keyspace that does not exist. A real 0 keeps this key.
    ...(clients.length === 0 ? {} : { activeConnections: readCount(clients) }),
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
export async function getPerformanceMetrics(
  transport: CassandraTransport,
  facts: CassandraServerFacts,
): Promise<PerformanceMetrics> {
  const rows = await readRows(transport, CASSANDRA_CACHE_CQL, facts);
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
  facts: CassandraServerFacts,
  options: { limit?: number } = {},
): Promise<ActiveSessionDetails[]> {
  const limit = Math.trunc(options.limit ?? DEFAULT_SESSION_LIMIT);
  const rows = await readRows(transport, CASSANDRA_RUNNING_QUERY_CQL, facts);

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
 * The health summary, from the same reads as the overview and the sessions panel.
 *
 * `slowQueries` is written out as `[]` rather than mapped from `getSlowQueries()`:
 * the summary needs the narrower `SlowQuery` shape, and a mapper over a list that is
 * always empty would be a body no test could reach.
 */
export async function getHealth(
  transport: CassandraTransport,
  keyspace: string,
  facts: CassandraServerFacts,
): Promise<HealthInfo> {
  const [overview, performance, sessions] = await Promise.all([
    getOverview(transport, keyspace, facts),
    getPerformanceMetrics(transport, facts),
    getActiveSessions(transport, facts),
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
    // `HealthInfo.activeConnections` is optional too, so a denied grant or a
    // build with no `system_views` keyspace stays an omission all the way to the
    // agent's curated health reading rather than becoming a fabricated 0 here.
    activeConnections: overview.activeConnections,
    databaseSize: overview.databaseSize,
    cacheHitRatio:
      performance.cacheHitRatio === undefined ? CASSANDRA_SIZE_UNAVAILABLE : `${performance.cacheHitRatio}%`,
    slowQueries: [],
    activeSessions,
  };
}
