/**
 * DuckDB introspection (issue #424)
 *
 * Every reading here is SQL against DuckDB's own `duckdb_*` table functions and its
 * `pragma_*` ones. Nothing in this file knows how a statement travels - that is
 * `client.ts`'s job, and `duckdb-seam-guard.test.ts` enforces it - so each function
 * takes the neutral client and returns the product's own DTO.
 *
 * Four measured facts shape the statements below (DuckDB v1.5.5, 2026-08-27, recorded
 * in `.duckdb-measured.md`):
 *
 * - `duckdb_schemas().internal` is TRUE for `main` even in a user database, so
 *   filtering on `NOT internal` DROPS the default schema. The catalog is filtered on
 *   `database_name = current_database()` instead, which also keeps the attached
 *   `system` and `temp` catalogs out.
 * - `duckdb_tables().estimated_size` is a ROW COUNT and NOT a byte size, and it is an
 *   ESTIMATE: after deleting 19M of a table's 20M rows it answered 1,076,480 against a
 *   true 1,000,000, and a CHECKPOINT did not move it. It is never published as a row
 *   count - `readRowCounts` counts instead.
 * - `pragma_database_size()` publishes human strings ("2.0 MiB", "0 bytes") for every
 *   size column except `block_size`, so the byte figures are parsed out of the text
 *   the engine printed (`parseDuckDBSize`).
 * - There is no `duckdb_queries()` and no `duckdb_connections()`: DuckDB keeps no
 *   finished-statement store and publishes no session list, both confirmed as
 *   "Catalog Error: Table Function with name ... does not exist!". Those two readings
 *   are honest empties with a label, never a fabricated row and never a zero.
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
import type { DuckDBClient, DuckDBStatementResult } from "./client";
import { parseDuckDBSize, readCount } from "./values";

// ============================================================================
// Introspection SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope (not inlined in the functions) on purpose. bun's coverage
// instruments the interior lines of a multi-line template literal in a function body
// as 0-hit in any test process that imports this file but does not exercise the
// function, and the merged lcov then reports those SQL lines as uncovered even though
// the caller is tested. Evaluated once at module load, these consts are reported as
// covered everywhere (same pattern as sqlite.ts and libsql/introspect.ts).
// ============================================================================

/** The catalog this connection is attached to; every read below is scoped to it. */
const CATALOG_SQL = "SELECT current_database() AS catalog_name, version() AS version";

export const TABLES_SQL = `SELECT schema_name, table_name, estimated_size
      FROM duckdb_tables()
      WHERE NOT internal AND database_name = current_database()
      ORDER BY schema_name, table_name`;

export const VIEWS_SQL = `SELECT schema_name, view_name
      FROM duckdb_views()
      WHERE NOT internal AND database_name = current_database()
      ORDER BY schema_name, view_name`;

/** Columns of tables AND views alike: `duckdb_columns()` carries both. */
export const COLUMNS_SQL = `SELECT schema_name, table_name, column_name, data_type, is_nullable, column_default
      FROM duckdb_columns()
      WHERE NOT internal AND database_name = current_database()
      ORDER BY schema_name, table_name, column_index`;

/**
 * Primary keys and foreign keys in one read.
 *
 * `duckdb_constraints()` also publishes every NOT NULL and UNIQUE constraint as its
 * own row, which is why the type filter is explicit rather than a `NOT internal`.
 * `constraint_column_names` and `referenced_column_names` are `VARCHAR[]`, so they
 * arrive as real arrays; `referenced_table` is NULL on a primary key.
 */
export const CONSTRAINTS_SQL = `SELECT schema_name, table_name, constraint_type,
             constraint_column_names, referenced_table, referenced_column_names
      FROM duckdb_constraints()
      WHERE database_name = current_database()
        AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`;

/**
 * Indexes, with their key columns as a real list.
 *
 * `expressions` is declared `VARCHAR` and prints as `"[a, b]"`, which a caller would
 * otherwise have to parse by hand - and get wrong the moment an expression index
 * carries a comma. `::VARCHAR[]` makes DuckDB do it: measured, `'[customer_id]'`
 * casts to `["customer_id"]`.
 */
export const INDEXES_SQL = `SELECT schema_name, table_name, index_name, is_unique, is_primary,
             expressions::VARCHAR[] AS index_columns
      FROM duckdb_indexes()
      WHERE database_name = current_database()
      ORDER BY schema_name, table_name, index_name`;

export const DB_SIZE_SQL = `SELECT database_size, block_size, total_blocks, used_blocks, free_blocks,
             wal_size, memory_usage
      FROM pragma_database_size()`;

const COUNTS_SQL = `SELECT
        (SELECT COUNT(*) FROM duckdb_tables()
          WHERE NOT internal AND database_name = current_database()) AS table_count,
        (SELECT COUNT(*) FROM duckdb_indexes()
          WHERE database_name = current_database()) AS index_count`;

/** Where DuckDB spilled to disk, if it did. Empty on a query that stayed in memory. */
const TEMP_FILES_SQL = "SELECT path, size FROM duckdb_temporary_files()";

/** The file this catalog is stored in, or NULL for an in-memory database. */
const DATABASE_PATH_SQL = `SELECT path FROM duckdb_databases()
      WHERE database_name = current_database()`;

// ============================================================================
// Row shapes
// ============================================================================

/**
 * Every 64-bit column arrives as a decimal STRING through `getRowObjectsJson()`, which
 * is why the numeric fields below are typed `unknown` and read through `readCount`
 * rather than typed `number` and trusted.
 */
interface TableRow {
  schema_name: string;
  table_name: string;
  estimated_size: unknown;
}

interface ColumnRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
}

interface ConstraintRow {
  schema_name: string;
  table_name: string;
  constraint_type: string;
  constraint_column_names: string[];
  referenced_table: string | null;
  referenced_column_names: string[];
}

interface IndexRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  index_columns: string[] | null;
}

// ============================================================================
// Naming
// ============================================================================

/** DuckDB's default schema. Objects in it are named bare, everything else qualified. */
export const DEFAULT_SCHEMA = "main";

/**
 * The name the object browser shows: `table` in the default schema, `schema.table`
 * anywhere else. The same rule `postgres.ts` applies to `public`.
 */
export function displayName(schemaName: string, objectName: string): string {
  return schemaName === DEFAULT_SCHEMA ? objectName : `${schemaName}.${objectName}`;
}

/** A name inside a single-quoted SQL string literal. */
function quoteLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** A name inside a double-quoted SQL identifier. */
function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The argument `pragma_storage_info()` takes: a STRING holding a qualified,
 * double-quoted object name. Both layers of quoting are required and they are
 * different - measured, `pragma_storage_info('main."we''ird-name"')` answers where the
 * unquoted spelling is a parse error.
 *
 * A name carrying a double quote has NO spelling this argument can express - see
 * `nameIsAddressable`, which is why it is checked before this is built.
 */
function storageInfoArgument(schemaName: string, tableName: string): string {
  return quoteLiteral(`${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`);
}

/**
 * Whether `pragma_storage_info()` can be pointed at this object at all.
 *
 * It parses its argument as a qualified name with its own reader, and that reader does
 * not understand a doubled `""` - measured on DuckDB v1.5.5, and the failure is worse
 * than an error: `'"main"."we""ird"'` resolves to a table called `weird` and reports
 * ITS blocks (verified against a fixture holding both), and raises "Catalog Error:
 * Table with name weird does not exist!" when there is none. The raw form and a
 * backslash escape are parse errors ("Unterminated quote in qualified name!"), and a
 * bound parameter takes the same path as the literal, so there is no spelling that
 * reaches the table. A table nobody can address has no measurable byte figure, which is
 * an absence the Storage tab already draws.
 */
function nameIsAddressable(schemaName: string, tableName: string): boolean {
  return !schemaName.includes('"') && !tableName.includes('"');
}

// ============================================================================
// Row counts
// ============================================================================

/** The key both readers file an object under: schema and object name, never ambiguous. */
function tableKey(schemaName: string, objectName: string): string {
  return `${schemaName} ${objectName}`;
}

/** One arm per table, each labelling its own count. */
function rowCountsSql(tables: ReadonlyArray<{ schema_name: string; table_name: string }>): string {
  return tables
    .map(
      (table) =>
        `SELECT '${quoteLiteral(table.schema_name)}' AS schema_name, '${quoteLiteral(table.table_name)}' AS table_name, count(*) AS row_count FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)}`,
    )
    .join(" UNION ALL ");
}

/**
 * The EXACT row count of every table, counted, in one statement.
 *
 * `duckdb_tables().estimated_size` is not this number and must never be published as
 * it: measured on DuckDB v1.5.5, after `DELETE FROM big WHERE id < 19000000` on a
 * 20,000,000-row table it answered 1,076,480 where `count(*)` answered 1,000,000, and a
 * CHECKPOINT left it there. It is a row-group estimate, and the object browser and the
 * Tables panel present what they get as a row count.
 *
 * Counting is affordable here in a way it is not on the other engines in this repo,
 * which is why the choice went to (a) exact rather than (b) omitted: DuckDB answers
 * `count(*)` out of row-group metadata rather than by scanning. Measured, one UNION ALL
 * over 41 tables INCLUDING a 20,000,000-row one took 8.8 ms (6.7 ms warm), and over
 * 1000 tables took 240 ms in a 68 KB statement. One statement, not one per table, so
 * the object tree stays the six catalog reads it was.
 *
 * A table that could not be counted is simply ABSENT from the map: the callers publish
 * nothing rather than a number they cannot make true. The whole read is wrapped because
 * one unreadable table would otherwise cost every table its count - a table dropped
 * between the catalog read and this one is the ordinary case.
 */
async function readRowCounts(
  client: DuckDBClient,
  tables: ReadonlyArray<{ schema_name: string; table_name: string }>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (tables.length === 0) return counts;

  let rows: Record<string, unknown>[];
  try {
    rows = (await client.run(rowCountsSql(tables))).rows;
  } catch {
    return counts;
  }

  for (const row of rows as unknown as { schema_name: string; table_name: string; row_count: unknown }[]) {
    const count = readCount(row.row_count);
    if (count !== undefined) counts.set(tableKey(row.schema_name, row.table_name), count);
  }
  return counts;
}

// ============================================================================
// Schema
// ============================================================================

/**
 * The full object tree: tables and views, with columns, primary keys, foreign keys and
 * indexes attached.
 *
 * Five catalog reads plus ONE counting statement, and no per-object sweep. The count is
 * `count(*)` and never `estimated_size`, which is an estimate a DELETE leaves wrong -
 * DuckDB answers `count(*)` out of row-group metadata, so a whole catalog is counted in
 * one statement in milliseconds (see `readRowCounts`).
 *
 * Views appear with their columns and no row count: `duckdb_views()` publishes no
 * cardinality and counting one would mean running it.
 */
export async function readSchema(client: DuckDBClient): Promise<TableSchema[]> {
  const [tables, views, columns, constraints, indexes] = await Promise.all([
    client.run(TABLES_SQL),
    client.run(VIEWS_SQL),
    client.run(COLUMNS_SQL),
    client.run(CONSTRAINTS_SQL),
    client.run(INDEXES_SQL),
  ]);

  const rowCounts = await readRowCounts(client, tables.rows as unknown as TableRow[]);

  const primaryKeys = new Map<string, Set<string>>();
  const foreignKeys = new Map<string, TableSchema["foreignKeys"]>();
  for (const row of constraints.rows as unknown as ConstraintRow[]) {
    const id = tableKey(row.schema_name, row.table_name);
    if (row.constraint_type === "PRIMARY KEY") {
      primaryKeys.set(id, new Set(row.constraint_column_names));
      continue;
    }
    // A composite foreign key is one constraint over several columns; the product's
    // `ForeignKeySchema` is per column, so the pairs are zipped out.
    const existing = foreignKeys.get(id) ?? [];
    row.constraint_column_names.forEach((columnName, index) => {
      existing.push({
        columnName,
        // Spelled exactly as the tree node it points at. DuckDB refuses a foreign key
        // across schemas ("Binder Error: Creating foreign keys across different schemas
        // or catalogs is not supported", measured), so the target lives in the
        // constraint's own schema - and the bare name would link a non-default schema's
        // foreign key to a same-named table in `main`.
        referencedTable: row.referenced_table === null ? "" : displayName(row.schema_name, row.referenced_table),
        referencedColumn: row.referenced_column_names[index] ?? "",
      });
    });
    foreignKeys.set(id, existing);
  }

  const indexesByTable = new Map<string, TableSchema["indexes"]>();
  for (const row of indexes.rows as unknown as IndexRow[]) {
    const id = tableKey(row.schema_name, row.table_name);
    const existing = indexesByTable.get(id) ?? [];
    existing.push({ name: row.index_name, columns: row.index_columns ?? [], unique: row.is_unique });
    indexesByTable.set(id, existing);
  }

  const columnsByTable = new Map<string, TableSchema["columns"]>();
  for (const row of columns.rows as unknown as ColumnRow[]) {
    const id = tableKey(row.schema_name, row.table_name);
    const existing = columnsByTable.get(id) ?? [];
    existing.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable,
      isPrimary: primaryKeys.get(id)?.has(row.column_name) === true,
      ...(row.column_default === null ? {} : { defaultValue: row.column_default }),
    });
    columnsByTable.set(id, existing);
  }

  const schemas: TableSchema[] = [];

  for (const row of tables.rows as unknown as TableRow[]) {
    const id = tableKey(row.schema_name, row.table_name);
    const rowCount = rowCounts.get(id);
    schemas.push({
      name: displayName(row.schema_name, row.table_name),
      // Absent rather than estimated: `TableSchema.rowCount` is optional, and a table
      // this provider could not count publishes no count at all.
      ...(rowCount === undefined ? {} : { rowCount }),
      columns: columnsByTable.get(id) ?? [],
      indexes: indexesByTable.get(id) ?? [],
      foreignKeys: foreignKeys.get(id) ?? [],
    });
  }

  for (const row of views.rows as unknown as { schema_name: string; view_name: string }[]) {
    const id = tableKey(row.schema_name, row.view_name);
    schemas.push({
      name: displayName(row.schema_name, row.view_name),
      columns: columnsByTable.get(id) ?? [],
      indexes: [],
      foreignKeys: [],
    });
  }

  return schemas;
}

// ============================================================================
// Sizes
// ============================================================================

/** Everything `pragma_database_size()` published, in bytes where it published one. */
export interface DuckDBDatabaseSize {
  databaseSizeBytes?: number;
  walSizeBytes?: number;
  memoryUsageBytes?: number;
  blockSize?: number;
  totalBlocks?: number;
  usedBlocks?: number;
  freeBlocks?: number;
}

/**
 * The database's own footprint.
 *
 * An IN-MEMORY database publishes neither `databaseSizeBytes` nor `walSizeBytes`, and
 * that is the point of the `blockSize === 0` test: measured, `:memory:` answers
 * database_size "0 bytes", wal_size "0 bytes" and block_size 0 whatever it holds - 10
 * million rows answered exactly that, over a memory_usage of "283.0 MiB". Those zeroes
 * are the absence of a FILE, not the size of one, and publishing them draws an empty
 * database over live data. `memoryUsageBytes` is the reading that is true of it, and
 * `readStorageStats` publishes that instead.
 *
 * `memory_limit` is deliberately NOT read: it is 80% of host RAM, so it differs per
 * machine and says nothing about this database. Every other size column is a human
 * string and goes through `parseDuckDBSize`, which answers `undefined` rather than 0
 * for text it cannot read - an unparsed size is an absent reading, not an empty
 * database. `block_size` and the block counts are the exception: they are BIGINT and
 * arrive as decimal strings.
 */
export async function readDatabaseSize(client: DuckDBClient): Promise<DuckDBDatabaseSize> {
  const result = await client.run(DB_SIZE_SQL);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return {};

  const size: DuckDBDatabaseSize = {};
  const blockSize = readCount(row.block_size);
  if (blockSize !== undefined) size.blockSize = blockSize;
  // Only an in-memory database answers a zero block size; a file's own "0 bytes" WAL is
  // a real measurement of a real, empty WAL, so the test is on 0 exactly.
  const onDisk = blockSize !== 0;
  const databaseSizeBytes = parseDuckDBSize(row.database_size);
  if (onDisk && databaseSizeBytes !== undefined) size.databaseSizeBytes = databaseSizeBytes;
  const walSizeBytes = parseDuckDBSize(row.wal_size);
  if (onDisk && walSizeBytes !== undefined) size.walSizeBytes = walSizeBytes;
  const memoryUsageBytes = parseDuckDBSize(row.memory_usage);
  if (memoryUsageBytes !== undefined) size.memoryUsageBytes = memoryUsageBytes;
  const totalBlocks = readCount(row.total_blocks);
  if (totalBlocks !== undefined) size.totalBlocks = totalBlocks;
  const usedBlocks = readCount(row.used_blocks);
  if (usedBlocks !== undefined) size.usedBlocks = usedBlocks;
  const freeBlocks = readCount(row.free_blocks);
  if (freeBlocks !== undefined) size.freeBlocks = freeBlocks;

  return size;
}

/**
 * The bytes one table occupies on disk, or `undefined` when the engine has none to
 * report.
 *
 * DuckDB publishes NO per-table byte column anywhere - `duckdb_tables().estimated_size`
 * is a row count, and presenting it as a size is the fabrication this function exists
 * to avoid. `pragma_storage_info()` is the only route, and what it publishes is a
 * segment list carrying `block_id`, `persistent` and nothing measured in bytes. So the
 * figure derived here is the ALLOCATION: the count of distinct persistent blocks the
 * table's segments live in, times `block_size`.
 *
 * That is a real measurement rather than an estimate, and it is the right one for the
 * Storage tab, which sums these into a Data figure it draws beside the database size:
 * measured on a purpose-built fixture, 12 one-row tables occupied 12 distinct blocks
 * with NO block shared between two tables, and 12 x 256 KiB against a `database_size`
 * of 3.2 MiB. It is also block-granular, so a one-row table reports 256 KiB - which is
 * what the file really holds for it, and is stated in `docs/providers/duckdb.md`.
 *
 * `undefined` for three other reasons too, and none of them is a zero. A name
 * `pragma_storage_info()` cannot address (see `nameIsAddressable`) is refused before a
 * statement is issued. A statement the engine REFUSED is caught here rather than thrown
 * on: `readTableStats` reads one table at a time, so an escaping error would cost every
 * other table its row in the Storage panel - the same all-or-nothing aggregate #477
 * removed from the monitoring reads.
 *
 * `undefined` when the table has no persistent block at all: an in-memory database
 * (measured - every segment there answers `persistent: false` with a NULL `block_id`)
 * and a table whose rows are still in the write-ahead log both land there. A `0` would
 * read as an empty table on the Storage tab, which is the same fabrication in a
 * different digit (the rule `buildTableStats` follows in `sqlite.ts`).
 */
export async function readTableBytes(
  client: DuckDBClient,
  schemaName: string,
  tableName: string,
  blockSize: number | undefined,
): Promise<number | undefined> {
  if (blockSize === undefined || blockSize <= 0) return undefined;
  if (!nameIsAddressable(schemaName, tableName)) return undefined;

  const argument = storageInfoArgument(schemaName, tableName);
  let result: DuckDBStatementResult;
  try {
    result = await client.run(
      `SELECT COUNT(DISTINCT block_id) AS blocks FROM pragma_storage_info('${argument}') WHERE persistent AND block_id >= 0`,
    );
  } catch {
    return undefined;
  }
  const blocks = readCount((result.rows[0] as Record<string, unknown> | undefined)?.blocks);
  if (blocks === undefined || blocks === 0) return undefined;

  return blocks * blockSize;
}

// ============================================================================
// Monitoring
// ============================================================================

/** The engine version and the catalog name this connection is attached to. */
async function readCatalog(client: DuckDBClient): Promise<{ catalogName: string; version: string }> {
  const result = await client.run(CATALOG_SQL);
  const row = (result.rows[0] ?? {}) as { catalog_name?: string; version?: string };
  return { catalogName: row.catalog_name ?? DEFAULT_SCHEMA, version: row.version ?? "unknown" };
}

export async function readOverview(client: DuckDBClient): Promise<DatabaseOverview> {
  const [{ version }, size, counts] = await Promise.all([
    readCatalog(client),
    readDatabaseSize(client),
    client.run(COUNTS_SQL),
  ]);
  const row = (counts.rows[0] ?? {}) as Record<string, unknown>;

  return {
    version: `DuckDB ${version}`,
    // DuckDB is embedded: it starts when this process opens the file and there is no
    // server uptime to read. "N/A" is the word every other embedded provider uses.
    uptime: "N/A",
    // One, measured rather than assumed: this provider holds exactly one connection,
    // and DuckDB admits exactly one operating-system process per file (a second one is
    // refused with a lock error, in read-only mode too). What the engine does NOT
    // publish is the session LIST - see `readActiveSessions`.
    activeConnections: 1,
    // No published ceiling. `0` means exactly that here, per `DatabaseOverview`.
    maxConnections: 0,
    databaseSize: size.databaseSizeBytes === undefined ? "N/A" : formatBytes(size.databaseSizeBytes),
    ...(size.databaseSizeBytes === undefined ? {} : { databaseSizeBytes: size.databaseSizeBytes }),
    tableCount: readCount(row.table_count) ?? 0,
    indexCount: readCount(row.index_count) ?? 0,
  };
}

export async function readHealth(client: DuckDBClient): Promise<HealthInfo> {
  const size = await readDatabaseSize(client);

  return {
    activeConnections: 1,
    databaseSize: size.databaseSizeBytes === undefined ? "N/A" : formatBytes(size.databaseSizeBytes),
    // DuckDB publishes no buffer-cache hit counter of any kind: `duckdb_memory()`
    // reports bytes held per subsystem and nothing about hits or misses. The same word
    // the performance panel uses for an absent ratio, and the same constant, so the two
    // cannot drift apart.
    cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
    // Both empty, and deliberately so - see `readSlowQueries` and `readActiveSessions`.
    // The pseudo-rows `sqlite.ts` puts here (integrity, journal mode) have no DuckDB
    // equivalent: `PRAGMA integrity_check` does not exist on this engine (measured,
    // "Pragma Function with name integrity_check does not exist!").
    slowQueries: [],
    activeSessions: [],
  };
}

/**
 * Always empty, and the reason travels as a label rather than as a fabricated row.
 *
 * DuckDB keeps no finished-statement store: `duckdb_queries()` does not exist
 * ("Catalog Error: Table Function with name duckdb_queries does not exist!"), there is
 * no `pg_stat_statements` equivalent to install, and the profiler writes to a file the
 * user configures per session rather than to a catalog. `ProviderLabels
 * .slowQueriesEmptyState` carries that sentence to the Queries panel, which otherwise
 * tells the reader to install a PostgreSQL extension (#463).
 */
export async function readSlowQueries(): Promise<SlowQueryStats[]> {
  return [];
}

/**
 * Always empty, for the same class of reason: `duckdb_connections()` does not exist,
 * so the engine publishes no session list at all.
 *
 * `sqlite.ts` answers this with a row describing its own handle. That row would be
 * true here too, but it would also be the ONLY row this panel can ever show, and a
 * Sessions tab listing the reader's own connection reads as "the engine reports one
 * session" rather than "the engine reports nothing". The count that IS measurable
 * travels as `activeConnections` on the overview, where it is a number rather than a
 * fabricated session record.
 */
export async function readActiveSessions(): Promise<ActiveSessionDetails[]> {
  return [];
}

export async function readTableStats(client: DuckDBClient): Promise<TableStats[]> {
  const [tables, size] = await Promise.all([client.run(TABLES_SQL), readDatabaseSize(client)]);
  const rowCounts = await readRowCounts(client, tables.rows as unknown as TableRow[]);

  const stats: TableStats[] = [];
  for (const row of tables.rows as unknown as TableRow[]) {
    // `TableStats.rowCount` is required, so absence is not expressible here as it is on
    // `TableSchema`. The counted figure is the answer; `estimated_size` is the fallback
    // only when the count could not be read at all, because of the two numbers
    // available it is the closer one - a 0 would draw an empty table over real rows.
    const rowCount = rowCounts.get(tableKey(row.schema_name, row.table_name)) ?? readCount(row.estimated_size) ?? 0;
    const tableSizeBytes = await readTableBytes(client, row.schema_name, row.table_name, size.blockSize);

    if (tableSizeBytes === undefined) {
      stats.push({
        schemaName: row.schema_name,
        tableName: row.table_name,
        rowCount,
        totalSize: "N/A",
        totalSizeBytes: 0,
      });
      continue;
    }

    stats.push({
      schemaName: row.schema_name,
      tableName: row.table_name,
      rowCount,
      tableSize: formatBytes(tableSizeBytes),
      tableSizeBytes,
      // `indexSize` is absent, not zero: `pragma_storage_info()` reports the TABLE's
      // column segments and attributes nothing to an index, so `totalSize` below is the
      // table's own bytes and says nothing about its indexes.
      totalSize: formatBytes(tableSizeBytes),
      totalSizeBytes: tableSizeBytes,
    });
  }

  return stats;
}

export async function readIndexStats(client: DuckDBClient): Promise<IndexStats[]> {
  const result = await client.run(INDEXES_SQL);

  return (result.rows as unknown as IndexRow[]).map((row) => ({
    schemaName: row.schema_name,
    tableName: row.table_name,
    indexName: row.index_name,
    columns: row.index_columns ?? [],
    isUnique: row.is_unique,
    isPrimary: row.is_primary,
    // DuckDB publishes no per-index size and no per-index usage counter:
    // `duckdb_indexes()` has neither column and `pragma_storage_info()` reports only
    // the table's own column segments. "N/A" with `indexSizeBytes` omitted is the same
    // answer `sqlite.ts` gives for the same absence (#469).
    indexSize: "N/A",
    scans: 0,
  }));
}

export async function readStorageStats(client: DuckDBClient): Promise<StorageStats[]> {
  const [size, pathResult, tempFiles] = await Promise.all([
    readDatabaseSize(client),
    client.run(DATABASE_PATH_SQL),
    client.run(TEMP_FILES_SQL),
  ]);

  // NULL for an in-memory database, which is a fact about the database rather than a
  // missing reading - and the one case where the file readings must not be drawn at
  // all: it has no file, publishes "0 bytes" for the one it does not have, and holds
  // its data in memory, where `memory_usage` is the figure that measures it (283.0 MiB
  // over 10 million rows, measured, against a database_size of "0 bytes").
  const location = ((pathResult.rows[0] ?? {}) as { path?: string | null }).path ?? null;
  const stats: StorageStats[] = [
    location === null
      ? {
          name: "In-Memory Database",
          location: ":memory:",
          size: size.memoryUsageBytes === undefined ? "N/A" : formatBytes(size.memoryUsageBytes),
          sizeBytes: size.memoryUsageBytes ?? 0,
        }
      : {
          name: "Main Database",
          location,
          size: size.databaseSizeBytes === undefined ? "N/A" : formatBytes(size.databaseSizeBytes),
          sizeBytes: size.databaseSizeBytes ?? 0,
          ...(size.walSizeBytes === undefined
            ? {}
            : { walSize: formatBytes(size.walSizeBytes), walSizeBytes: size.walSizeBytes }),
        },
  ];

  // Only when there is one. DuckDB spills to disk under memory pressure and reports
  // nothing at all when it did not, so an always-present row of zeroes would claim a
  // spill file that does not exist.
  for (const row of tempFiles.rows as unknown as { path: string; size: unknown }[]) {
    const bytes = readCount(row.size) ?? 0;
    stats.push({ name: "Temporary File", location: row.path, size: formatBytes(bytes), sizeBytes: bytes });
  }

  return stats;
}
