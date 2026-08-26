/**
 * libSQL introspection (issue #424 Phase 5)
 *
 * Every reading here is SQL, because SQLite's introspection is SQL: `sqlite_master`
 * for the object list, the `pragma_*` table-valued functions for columns, indexes
 * and foreign keys, and `dbstat` for bytes. There is no management API to call and
 * nothing in this file knows how the statements travel - that is the transport's
 * job, and the seam guard enforces it.
 *
 * Two shapes drive the design, both measured on 2026-08-27 against sqld 0.24.33 and
 * against a Turso Cloud database:
 *
 * - A batch answers EACH statement separately, so a per-table read that fails costs
 *   its own reading and nothing else. That is why the per-table sweep is one batch
 *   whose outcomes are read individually rather than a `Promise.all` that a single
 *   refusal collapses (BACKLOG D22, #477).
 * - `dbstat` is available on BOTH deployments, which is more than the SQLite provider
 *   can say of its own drivers (`bun:sqlite` has no dbstat at all). So per-table and
 *   per-index bytes here are measured rather than absent - and when the table IS
 *   missing, every byte figure is omitted rather than zeroed, which is the same rule
 *   `buildTableStats` follows in `sqlite.ts`.
 *
 * The `pragma_*` functions are used instead of the `PRAGMA` statement form on
 * purpose: they are ordinary table-valued functions, so they can be projected and
 * filtered, and they carry the object name as a bound-looking literal rather than as
 * part of the statement keyword. Both forms are accepted by both deployments.
 */

import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import type {
  ActiveSessionDetails,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  SlowQueryStats,
  StorageStats,
  TableSchema,
  TableStats,
} from "@/lib/db/types";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import type { LibSQLBatchOutcome, LibSQLRow, LibSQLTransport } from "./transport";

// ============================================================================
// Introspection SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope (not inlined in the functions) on purpose. bun's
// coverage instruments the interior lines of a multi-line template literal in a
// function body as 0-hit in any test process that imports this file but does not
// exercise the function, and the merged lcov then reports those SQL lines as
// uncovered even though the caller is tested. Evaluated once at module load, these
// consts are reported as covered everywhere (same pattern as sqlite.ts).
// ============================================================================

/** The user tables, with SQLite's own objects left out. */
const TABLES_SQL = `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`;

const TABLE_COUNT_SQL = `SELECT COUNT(*) AS table_count FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;

const INDEX_COUNT_SQL = `SELECT COUNT(*) AS index_count FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`;

/**
 * The database's own footprint, from the page counters rather than from a file.
 *
 * `fs.statSync` is what the SQLite provider uses and is exactly what this provider
 * cannot do: the file is on the server's disk, not ours. The page product is the
 * same number - measured 282624 bytes against a database sqld reported as 276 KB.
 */
const DB_SIZE_SQL = `SELECT (SELECT page_count FROM pragma_page_count()) *
             (SELECT page_size FROM pragma_page_size()) AS size_bytes`;

const SQLITE_VERSION_SQL = "SELECT sqlite_version() AS version";
const INTEGRITY_CHECK_SQL = "PRAGMA integrity_check";
const JOURNAL_MODE_SQL = "PRAGMA journal_mode";

/**
 * Per-object page bytes.
 *
 * `dbstat` is a compile-time option, and this provider does not get to choose the
 * build it talks to - so the caller treats a refusal as "no bytes to show" rather
 * than as a failure. Available on both deployments measured.
 */
const DBSTAT_SIZES_SQL = `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`;

/** Which table each index belongs to, so an index's pages land on its table. */
const INDEX_OWNERS_SQL = `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'`;

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * A SQLite string literal. Doubling the quote is the whole escape SQLite defines.
 *
 * Object names reach these statements from `sqlite_master`, so they are the
 * engine's own words rather than a user's - but a table really can be named
 * `it's`, and a name that breaks the statement it is embedded in would cost the
 * whole sweep.
 */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A quoted identifier. `"` is doubled, the one escape SQLite defines for these. */
function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * A statistic as a number, or absent.
 *
 * The string branch is the transport's wide-integer form (`decodeInteger` keeps an
 * integer past 2^53 as its exact decimal string rather than rounding it), and here
 * it IS parsed to a double. That is deliberate and bounded: every caller of this
 * function is a COUNT or a byte total for a panel, where the reading is a display
 * figure - a row count above 2^53 is 9 quadrillion rows - while the values that
 * must not be rounded are result CELLS, which never pass through here.
 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The rows of one outcome, or null when that statement did not answer. */
function rowsOf(outcome: LibSQLBatchOutcome | undefined): LibSQLRow[] | null {
  return outcome?.ok === true ? outcome.result.rows : null;
}

/** The first row of one outcome, or null when that statement did not answer. */
function firstRow(outcome: LibSQLBatchOutcome | undefined): LibSQLRow | null {
  const rows = rowsOf(outcome);
  return rows === null ? null : (rows[0] ?? null);
}

/**
 * True for an index SQLite created for itself.
 *
 * A UNIQUE column and a non-INTEGER primary key each get an `sqlite_autoindex_*`
 * that no user declared and no user can drop, so listing them in the object tree
 * reports objects the schema does not contain.
 */
function isInternalIndex(name: string): boolean {
  return name.startsWith("sqlite_");
}

// ============================================================================
// Object bytes
// ============================================================================

/** One table's measured page bytes, split between its own b-tree and its indexes. */
interface ObjectSizeBytes {
  tableSizeBytes: number;
  indexSizeBytes: number;
}

interface MeasuredSizes {
  /** Bytes per table, indexes folded in under the table that owns them. */
  byTable: Map<string, ObjectSizeBytes>;
  /** Bytes per index object, for the index stats tab. */
  byIndex: Map<string, number>;
}

/**
 * Page bytes per object, or null when this build has no `dbstat`.
 *
 * Null is the whole point: it is what makes every byte figure downstream ABSENT
 * rather than 0. A zero there reads as an empty table, which is a claim, and the
 * SQLite provider learned that lesson the expensive way (`rowCount * 100`).
 */
async function readSizes(transport: LibSQLTransport): Promise<MeasuredSizes | null> {
  const [pagesOutcome, ownersOutcome] = await transport.executeBatch([
    { sql: DBSTAT_SIZES_SQL },
    { sql: INDEX_OWNERS_SQL },
  ]);

  const pages = rowsOf(pagesOutcome);
  if (pages === null) return null;

  const owners = rowsOf(ownersOutcome) ?? [];
  const bytesByObject = new Map<string, number>();
  for (const row of pages) {
    const name = readText(row.name);
    if (name !== undefined) bytesByObject.set(name, readNumber(row.bytes) ?? 0);
  }

  const byTable = new Map<string, ObjectSizeBytes>();
  const byIndex = new Map<string, number>();
  const entryFor = (tableName: string): ObjectSizeBytes => {
    const existing = byTable.get(tableName);
    if (existing) return existing;
    const created = { tableSizeBytes: 0, indexSizeBytes: 0 };
    byTable.set(tableName, created);
    return created;
  };

  // Indexes first, so an index's pages land on the table that owns them: the
  // Storage tab's index total is a per-TABLE figure.
  const indexNames = new Set<string>();
  for (const row of owners) {
    const name = readText(row.name);
    const owner = readText(row.tbl_name);
    if (name === undefined || owner === undefined) continue;
    indexNames.add(name);
    const bytes = bytesByObject.get(name) ?? 0;
    entryFor(owner).indexSizeBytes += bytes;
    byIndex.set(name, bytes);
  }
  for (const [name, bytes] of bytesByObject) {
    if (!indexNames.has(name)) entryFor(name).tableSizeBytes += bytes;
  }

  return { byTable, byIndex };
}

// ============================================================================
// Schema
// ============================================================================

/** One index as `pragma_index_list` describes it, before its columns are read. */
interface IndexDescriptor {
  tableName: string;
  name: string;
  unique: boolean;
  isPrimary: boolean;
}

interface CollectedTable {
  name: string;
  rowCount: number | undefined;
  columns: TableSchema["columns"];
  foreignKeys: NonNullable<TableSchema["foreignKeys"]>;
  indexes: IndexDescriptor[];
}

/** The four questions asked of every table, in the order the outcomes are read. */
function tableStatements(tableName: string): { sql: string }[] {
  return [
    { sql: `SELECT COUNT(*) AS row_count FROM ${identifier(tableName)}` },
    // `"notnull"` is QUOTED because it is a SQLite keyword - the postfix `x NOTNULL`
    // operator - and projecting it bare is a parse error, not a column: measured on
    // sqld 0.24.33, `SELECT cid, name, type, notnull, ... FROM pragma_table_info(...)`
    // answers "near NOTNULL: syntax error" while the same statement with the name
    // quoted returns the rows. Nothing above the transport could see that failure -
    // it costs the COLUMNS of every table and leaves the tree otherwise intact - so
    // this is a live-probe finding rather than a test one.
    { sql: `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(${literal(tableName)})` },
    { sql: `SELECT seq, name, "unique", origin FROM pragma_index_list(${literal(tableName)})` },
    { sql: `SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(${literal(tableName)})` },
  ];
}

function collectTable(tableName: string, outcomes: LibSQLBatchOutcome[]): CollectedTable {
  const [count, columns, indexes, foreignKeys] = outcomes;

  return {
    name: tableName,
    // Absent rather than 0 when the count was refused: a table reported as empty
    // is a reading, and this one failed.
    rowCount: readNumber(firstRow(count)?.row_count),
    columns: (rowsOf(columns) ?? []).map((row) => ({
      name: readText(row.name) ?? "",
      // SQLite allows a column with no declared type at all (it is then a BLOB
      // affinity column). TEXT is what the SQLite provider substitutes, and the
      // same substitution is kept here so the two read alike.
      type: readText(row.type) ?? "TEXT",
      nullable: readNumber(row.notnull) !== 1,
      isPrimary: readNumber(row.pk) === 1,
      ...(row.dflt_value === null || row.dflt_value === undefined ? {} : { defaultValue: String(row.dflt_value) }),
    })),
    foreignKeys: (rowsOf(foreignKeys) ?? []).map((row) => ({
      columnName: readText(row.from) ?? "",
      referencedTable: readText(row.table) ?? "",
      referencedColumn: readText(row.to) ?? "",
    })),
    indexes: (rowsOf(indexes) ?? [])
      .map((row) => ({
        tableName,
        name: readText(row.name) ?? "",
        unique: readNumber(row.unique) === 1,
        isPrimary: readText(row.origin) === "pk",
      }))
      .filter((index) => index.name !== "" && !isInternalIndex(index.name)),
  };
}

/**
 * Every table with its columns, indexes and foreign keys, in as few round trips as
 * the questions allow.
 *
 * Three round trips regardless of table count: the object list, one batch carrying
 * four statements per table, and one batch carrying an `index_info` per user index.
 * The SQLite provider issues the same questions one at a time, which is free on a
 * file and is four network round trips per table here.
 */
async function collectTables(
  transport: LibSQLTransport,
): Promise<{ tables: CollectedTable[]; columnsByIndex: Map<string, string[]> }> {
  // Not tolerated: with no object list there is nothing to degrade to, and the
  // caller needs to know the read failed rather than see an empty database.
  const tableRows = (await transport.execute(TABLES_SQL)).rows;
  const tableNames = tableRows.map((row) => readText(row.name)).filter((name): name is string => name !== undefined);
  if (tableNames.length === 0) return { tables: [], columnsByIndex: new Map() };

  const outcomes = await transport.executeBatch(tableNames.flatMap(tableStatements));
  const tables = tableNames.map((tableName, index) =>
    collectTable(tableName, outcomes.slice(index * 4, index * 4 + 4)),
  );

  const indexNames = tables.flatMap((table) => table.indexes.map((index) => index.name));
  const columnsByIndex = new Map<string, string[]>();
  if (indexNames.length > 0) {
    const infoOutcomes = await transport.executeBatch(
      indexNames.map((name) => ({ sql: `SELECT seqno, cid, name FROM pragma_index_info(${literal(name)})` })),
    );
    for (const [position, name] of indexNames.entries()) {
      const columns = (rowsOf(infoOutcomes[position]) ?? [])
        .map((row) => readText(row.name))
        .filter((column): column is string => column !== undefined);
      columnsByIndex.set(name, columns);
    }
  }

  return { tables, columnsByIndex };
}

export async function readSchema(transport: LibSQLTransport): Promise<TableSchema[]> {
  const { tables, columnsByIndex } = await collectTables(transport);
  if (tables.length === 0) return [];

  const sizes = await readSizes(transport);

  return tables.map((table) => {
    const size = sizes?.byTable.get(table.name);

    return {
      name: table.name,
      ...(table.rowCount === undefined ? {} : { rowCount: table.rowCount }),
      // Omitted, not "0 B", when this build has no dbstat: the object tree draws
      // nothing for an absent size and draws "0 B" for a present zero, and one of
      // those two is a claim about the table.
      ...(size === undefined ? {} : { size: formatBytes(size.tableSizeBytes + size.indexSizeBytes) }),
      columns: table.columns,
      indexes: table.indexes.map((index) => ({
        name: index.name,
        columns: columnsByIndex.get(index.name) ?? [],
        unique: index.unique,
      })),
      foreignKeys: table.foreignKeys,
    };
  });
}

// ============================================================================
// Overview, health, metrics
// ============================================================================

/**
 * What the server is and how much it holds.
 *
 * The version is the one place the two deployments disagree, and both answers are
 * kept: a self-hosted sqld publishes its own version on a route Turso Cloud does
 * not have, so the panel reads `sqld 0.24.33 (…) (SQLite 3.47.0)` there and
 * `SQLite 3.47.0` on the cloud. Neither is "Unknown", because the engine answered.
 */
export async function readOverview(transport: LibSQLTransport): Promise<DatabaseOverview> {
  const [serverVersion, outcomes] = await Promise.all([
    transport.serverVersion(),
    transport.executeBatch([
      { sql: SQLITE_VERSION_SQL },
      { sql: DB_SIZE_SQL },
      { sql: TABLE_COUNT_SQL },
      { sql: INDEX_COUNT_SQL },
    ]),
  ]);

  const sqliteVersion = readText(firstRow(outcomes[0])?.version);
  const engine = sqliteVersion === undefined ? "SQLite" : `SQLite ${sqliteVersion}`;
  const sizeBytes = readNumber(firstRow(outcomes[1])?.size_bytes);

  return {
    version: serverVersion === null ? engine : `${serverVersion} (${engine})`,
    // libSQL publishes no start time and no uptime on any route or in any catalog.
    // "N/A" is the SQLite provider's own wording for the same absence.
    uptime: "N/A",
    // No `activeConnections` at all: Hrana is stateless, so a statement is a
    // request and there is no session anywhere to count. A 1 here would be this
    // provider counting itself.
    maxConnections: 0,
    databaseSize: sizeBytes === undefined ? "N/A" : formatBytes(sizeBytes),
    databaseSizeBytes: sizeBytes ?? 0,
    tableCount: readNumber(firstRow(outcomes[2])?.table_count) ?? 0,
    indexCount: readNumber(firstRow(outcomes[3])?.index_count) ?? 0,
  };
}

/**
 * The two readings libSQL has, and no invented third.
 *
 * `PRAGMA integrity_check` and `PRAGMA journal_mode` are both accepted by both
 * deployments (unlike `VACUUM`, `ANALYZE`, `PRAGMA optimize` and
 * `PRAGMA wal_checkpoint`, which sqld's statement allowlist refuses outright), and
 * they are what the health panel shows. The cache hit ratio is the shared
 * "not measured" constant rather than a number: SQLite's hit and miss counters
 * live behind the C API, and no statement reaches them - which is as true over
 * Hrana as it is in the SQLite provider.
 */
export async function readHealth(transport: LibSQLTransport): Promise<HealthInfo> {
  const outcomes = await transport.executeBatch([
    { sql: DB_SIZE_SQL },
    { sql: INTEGRITY_CHECK_SQL },
    { sql: JOURNAL_MODE_SQL },
  ]);

  const sizeBytes = readNumber(firstRow(outcomes[0])?.size_bytes);
  const integrity = readText(firstRow(outcomes[1])?.integrity_check);
  const journalMode = readText(firstRow(outcomes[2])?.journal_mode) ?? "unknown";

  return {
    databaseSize: sizeBytes === undefined ? "N/A" : formatBytes(sizeBytes),
    cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
    slowQueries: [
      { query: `Integrity: ${integrity === "ok" ? "OK" : "FAILED"}`, calls: 0, avgTime: "N/A" },
      { query: `Journal Mode: ${journalMode}`, calls: 0, avgTime: "N/A" },
    ],
    // Empty, not a row describing this process: the SQLite provider can name the
    // one handle it holds open, and this provider holds none - the server has the
    // sessions and publishes none of them.
    activeSessions: [],
  };
}

/**
 * Nothing, and the reason is the engine rather than the transport.
 *
 * libSQL keeps no statement statistics: there is no `SLOWLOG`, no
 * `pg_stat_statements` and no equivalent to enable. `query_duration_ms` comes back
 * with each answer, but that is this client's own statement, measured once, which
 * is not a statistic about finished ones.
 */
export async function readSlowQueries(): Promise<SlowQueryStats[]> {
  return [];
}

/**
 * Nothing, for the same reason `readHealth` reports no sessions.
 *
 * Hrana is stateless over HTTP, and no route publishes the server's connected
 * clients. A row for the request in flight would be this provider describing
 * itself.
 */
export async function readActiveSessions(): Promise<ActiveSessionDetails[]> {
  return [];
}

// ============================================================================
// Stats tabs
// ============================================================================

export async function readTableStats(transport: LibSQLTransport): Promise<TableStats[]> {
  const { tables } = await collectTables(transport);
  if (tables.length === 0) return [];

  const sizes = await readSizes(transport);

  return tables.map((table) => {
    const size = sizes?.byTable.get(table.name);
    const rowCount = table.rowCount ?? 0;
    if (size === undefined) {
      // `totalSize`/`totalSizeBytes` are required by `TableStats`, so they carry
      // the "N/A" / 0 placeholder the tab keys off - it draws neither figure once
      // `tableSizeBytes` is absent (#469).
      return { schemaName: "main", tableName: table.name, rowCount, totalSize: "N/A", totalSizeBytes: 0 };
    }

    const totalSizeBytes = size.tableSizeBytes + size.indexSizeBytes;
    return {
      schemaName: "main",
      tableName: table.name,
      rowCount,
      tableSize: formatBytes(size.tableSizeBytes),
      tableSizeBytes: size.tableSizeBytes,
      indexSize: formatBytes(size.indexSizeBytes),
      indexSizeBytes: size.indexSizeBytes,
      totalSize: formatBytes(totalSizeBytes),
      totalSizeBytes,
    };
  });
}

export async function readIndexStats(transport: LibSQLTransport): Promise<IndexStats[]> {
  const { tables, columnsByIndex } = await collectTables(transport);
  if (tables.length === 0) return [];

  const sizes = await readSizes(transport);

  return tables.flatMap((table) =>
    table.indexes.map((index) => {
      const bytes = sizes?.byIndex.get(index.name);

      return {
        schemaName: "main",
        tableName: table.name,
        indexName: index.name,
        columns: columnsByIndex.get(index.name) ?? [],
        isUnique: index.unique,
        isPrimary: index.isPrimary,
        indexSize: bytes === undefined ? "N/A" : formatBytes(bytes),
        ...(bytes === undefined ? {} : { indexSizeBytes: bytes }),
        // SQLite keeps no per-index scan counter anywhere, so this is the count of
        // a statistic that does not exist rather than a measurement of no scans.
        // `scans` is required by `IndexStats`; the tab renders the 0.
        scans: 0,
      };
    }),
  );
}

/**
 * The one file libSQL has, or nothing.
 *
 * An entry reading 0 B would draw an empty database on the Storage tab, which is a
 * claim; no entry draws the tab's own empty state, which is the honest one.
 */
export async function readStorageStats(transport: LibSQLTransport): Promise<StorageStats[]> {
  const [outcome] = await transport.executeBatch([{ sql: DB_SIZE_SQL }]);
  const sizeBytes = readNumber(firstRow(outcome)?.size_bytes);
  if (sizeBytes === undefined) return [];

  // No `walSize`: the WAL is a file on the server's disk and no statement reports
  // its size. `PRAGMA wal_checkpoint` - which would at least prove it exists - is
  // one of the statements sqld refuses.
  return [{ name: "main", size: formatBytes(sizeBytes), sizeBytes }];
}
