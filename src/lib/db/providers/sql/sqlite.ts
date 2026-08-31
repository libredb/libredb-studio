/**
 * SQLite Database Provider
 * File-based SQLite support - runs under both Bun and Node.
 *
 * The underlying driver is selected at runtime by the sqlite-driver adapter:
 * bun:sqlite under Bun, node:sqlite under Node (override with
 * LIBREDB_SQLITE_DRIVER=bun|node).
 *
 * Note: SQLite is primarily for local development. Cloud deployments
 * typically use PostgreSQL or MySQL instead.
 */

import { SQLBaseProvider } from "./sql-base";
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderExecutionContext,
  type ReadOnlyStatementBudget,
  type ProviderCapabilities,
  type ProviderLabels,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from "../../types";
import {
  DatabaseConfigError,
  ConnectionError,
  ExecutionProfileError,
  QueryError,
  mapDatabaseError,
} from "../../errors";
import { assertReadOnlyBudget, measureResultBytes } from "./read-only-budget";
import { formatBytes } from "../../utils/pool-manager";
import { loadSQLiteDriver, type SQLiteDatabase } from "./sqlite-driver";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Type Definitions
// ============================================================================

// Row shapes returned by the PRAGMA introspection statements below.
interface SQLiteColumnInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SQLiteForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
}

interface SQLiteIndexListRow {
  seq: number;
  name: string;
  unique: number;
}

// ============================================================================
// Introspection SQL
// ----------------------------------------------------------------------------
// Hoisted to module scope (not inlined in the methods) on purpose. bun's
// coverage instruments the interior lines of a *multi-line template literal in
// a function body* as 0-hit in any test process that imports this file but
// does not exercise the method — and the merged lcov then reports those SQL
// lines as uncovered even though the method is tested. Evaluated once at
// module load, these consts are reported as covered everywhere, so coverage
// stays accurate (same pattern as postgres.ts).
// ============================================================================

const SCHEMA_TABLES_SQL = `
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `;

const DB_PAGE_SIZE_SQL = `
          SELECT (SELECT page_count FROM pragma_page_count()) *
                 (SELECT page_size FROM pragma_page_size()) as size
        `;

// Size of a :memory: database (no file to stat).
const MEMORY_DB_SIZE_SQL = `
          SELECT (page_count * page_size) as size
          FROM pragma_page_count(), pragma_page_size()
        `;

const TABLE_COUNT_SQL = `
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `;

const INDEX_COUNT_SQL = `
      SELECT COUNT(*) as count FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    `;

const STATS_TABLES_SQL = `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;

// Per-object page bytes. `dbstat` is a virtual table behind the compile-time
// SQLITE_ENABLE_DBSTAT_VTAB option, so whether it answers is a property of the BUILD
// behind the driver rather than of the driver's name: node:sqlite has carried it
// throughout, bun:sqlite raised "no such table: dbstat" through Bun 1.3.14 (measured
// 2026-08-24 on SQLite 3.53.0 against a working row from node:sqlite 3.51.2 /
// Node 24.14.0) and answers from 1.4.0 / 3.53.2 on the Linux and Windows builds
// (re-measured 2026-08-31 on Linux x86_64). Both arms stay live - see readDbstatSizes.
// It is the only
// per-table size SQLite publishes at all - there is no catalog column for it - and
// reading it costs a scan of the whole database file, which is acceptable on the
// monitoring tab and is why nothing else calls it.
const DBSTAT_SIZES_SQL = `
      SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name
    `;

// Every index and which table it belongs to. Deliberately NOT filtered by
// `name NOT LIKE 'sqlite_%'` the way STATS_INDEXES_SQL is: an implicit
// `sqlite_autoindex_*` occupies real pages and belongs in its table's index bytes,
// even though it is not an index a user declared and so is not listed on its own.
const DBSTAT_INDEX_OWNERS_SQL = `
      SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'
    `;

const STATS_INDEXES_SQL = `
      SELECT name, tbl_name FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
      ORDER BY tbl_name, name
    `;

// ============================================================================
// Agent read-only execution profile (#328)
// ============================================================================

const QUERY_ONLY_PRAGMA_SQL = "PRAGMA query_only = true";
const QUERY_ONLY_READBACK_SQL = "PRAGMA query_only";

/**
 * Refuses a read-only handle whose `query_only` pragma does not read back
 * enabled.
 *
 * A read-only OPEN does not imply `query_only` on either adapter (it reads
 * back 0 until explicitly set), so the profile sets it and verifies it — at
 * open AND before every statement.
 *
 * The two controls cover different things and neither is redundant. The
 * read-only open governs the TARGET database file: writes to it are refused
 * and a missing file is not created. It does NOT govern writes to OTHER
 * files — `VACUUM INTO '<path>'` copies the whole database to an arbitrary
 * server path from a read-only handle on both adapters. That is what
 * `query_only` refuses, and why it is re-asserted per statement rather than
 * only at open: a statement can turn it off, but `prepare()` compiles exactly
 * one statement, so the disable and the write can never ride in the same call.
 */
export function assertQueryOnlyEnabled(readback: unknown[]): void {
  const value = (readback[0] as { query_only?: unknown } | undefined)?.query_only;
  if (value !== 1) {
    throw new ConnectionError(
      `SQLite read-only profile could not enable query_only (read back ${JSON.stringify(value ?? null)})`,
      "sqlite",
    );
  }
}

// ============================================================================
// Per-table sizes (dbstat)
// ============================================================================

/** One table's measured page bytes, split between its own b-tree and its indexes. */
export interface SQLiteTableSizeBytes {
  tableSizeBytes: number;
  indexSizeBytes: number;
}

/**
 * Read per-object page bytes out of `dbstat`, or answer `null` when the driver has
 * no such table.
 *
 * `null` is the whole point: the two SQLite drivers disagree about dbstat (see
 * DBSTAT_SIZES_SQL), and `LIBREDB_SQLITE_DRIVER` lets a user switch between them, so
 * both answers have to be right. What used to fill the gap was `rowCount * 100`
 * ("Assume 100 bytes average per row") which the Storage tab summed into the Data
 * figure it drew beside the measured database size.
 *
 * Takes the database handle as a parameter, and is exported, so that BOTH answers are
 * testable in-process under Bun with a stand-in handle, whichever one the running build
 * happens to give. `dbstat` sits behind SQLITE_ENABLE_DBSTAT_VTAB, a COMPILE-TIME option,
 * so its presence is a property of the BUILD and not of the driver's name: this was
 * written believing bun:sqlite could only ever answer `null`, and a Bun whose SQLite
 * carries dbstat answers the other one. Nothing here changes - both answers were already
 * right - but a test that reads the driver's name to predict which arm it is on is
 * reading the wrong thing.
 */
export function readDbstatSizes(db: SQLiteDatabase): Map<string, SQLiteTableSizeBytes> | null {
  let pages: { name: string; bytes: number }[];
  try {
    pages = db.prepare(DBSTAT_SIZES_SQL).all() as { name: string; bytes: number }[];
  } catch {
    return null;
  }

  const owners = db.prepare(DBSTAT_INDEX_OWNERS_SQL).all() as { name: string; tbl_name: string }[];
  const bytesByObject = new Map(pages.map((page) => [page.name, Number(page.bytes) || 0]));
  const indexNames = new Set(owners.map((owner) => owner.name));
  const sizes = new Map<string, SQLiteTableSizeBytes>();

  const entryFor = (tableName: string): SQLiteTableSizeBytes => {
    const existing = sizes.get(tableName);
    if (existing) return existing;
    const created = { tableSizeBytes: 0, indexSizeBytes: 0 };
    sizes.set(tableName, created);
    return created;
  };

  // Indexes first, so an index's pages land on its table rather than on a name of
  // their own - the Storage tab's index total is the per-TABLE figure.
  for (const owner of owners) {
    entryFor(owner.tbl_name).indexSizeBytes += bytesByObject.get(owner.name) ?? 0;
  }
  for (const [name, bytes] of bytesByObject) {
    if (!indexNames.has(name)) entryFor(name).tableSizeBytes += bytes;
  }

  return sizes;
}

/**
 * Build one table's stats row. `size` is `null` when this driver publishes no page
 * bytes, and then the byte fields are OMITTED rather than zeroed: a 0 reads as an
 * empty table on the Storage tab, which is the same fabrication the `rowCount * 100`
 * estimate was. `totalSize`/`totalSizeBytes` are still required by `TableStats`, so
 * they carry the "N/A" / 0 placeholder that `getIndexStats()` already uses for
 * `indexSize` (#469) - the tab keys off the absent `tableSizeBytes` and draws neither.
 *
 * Exported for the same reason as readDbstatSizes: the populated branch is only ever
 * reached under node:sqlite, and it is tested under Bun by being handed the sizes.
 */
export function buildTableStats(tableName: string, rowCount: number, size: SQLiteTableSizeBytes | null): TableStats {
  if (!size) {
    return { schemaName: "main", tableName, rowCount, totalSize: "N/A", totalSizeBytes: 0 };
  }

  const totalSizeBytes = size.tableSizeBytes + size.indexSizeBytes;

  return {
    schemaName: "main",
    tableName,
    rowCount,
    tableSize: formatBytes(size.tableSizeBytes),
    tableSizeBytes: size.tableSizeBytes,
    indexSize: formatBytes(size.indexSizeBytes),
    indexSizeBytes: size.indexSizeBytes,
    totalSize: formatBytes(totalSizeBytes),
    totalSizeBytes,
  };
}

// ============================================================================
// SQLite Provider
// ============================================================================

export class SQLiteProvider extends SQLBaseProvider {
  private db: SQLiteDatabase | null = null;
  /** True when this instance was opened under the agent read-only profile. */
  private readonly readOnlyProfile: boolean;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}, execution: ProviderExecutionContext = {}) {
    super(config, options);
    // Server-injected only (see ProviderExecutionContext): the shared editor
    // path builds providers from caller-supplied ProviderOptions, which has no
    // route to this flag in either direction.
    this.readOnlyProfile = execution.readOnly === true;
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: null,
      supportsExplain: true,
      explainFormat: "sqlite-queryplan",
      supportsConnectionString: false,
      supportsInlineRowEdit: true,
      // SQLite HAS transactions; this provider holds no session for one, so
      // POST /api/db/transaction refuses the call and the controls stay hidden.
      supportsTransactions: false,
      maintenanceOperations: ["vacuum", "analyze", "reindex", "check"],
      // `VACUUM` rewrites the whole database file and takes no object at all, and
      // `PRAGMA integrity_check` reads the whole file the same way - `runMaintenance`
      // ignores the target for both, so a per-table control there named one table and
      // acted on the database (#496). `ANALYZE` and `REINDEX` do take a bare name and
      // also run over everything without one.
      maintenanceOperationSpecs: {
        vacuum: { label: "Vacuum Database", perEntity: false, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        reindex: { label: "Reindex Table", perEntity: true, global: true },
        check: { label: "Integrity Check", perEntity: false, global: true },
      },
    };
  }

  /**
   * The slow-query empty state and the global reindex wording; every other label is
   * the SQL default and right.
   *
   * `getSlowQueries()` answers `[]` unconditionally, so the monitoring Queries panel
   * is ALWAYS empty here - and it used to tell the reader to install a PostgreSQL
   * extension (#463).
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      slowQueriesEmptyState: "SQLite keeps no statistics about finished statements, so there is nothing to enable.",
      reindexGlobalLabel: "Run Reindex",
      reindexGlobalTitle: "Rebuild Indexes",
      reindexGlobalDesc: "Runs bare REINDEX, rebuilding every index in the database file.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.database && !this.config.connectionString) {
      throw new DatabaseConfigError(
        'Database file path is required for SQLite (use "database" field or ":memory:" for in-memory)',
        "sqlite",
      );
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      // Dynamically load the runtime-appropriate SQLite driver
      const SQLiteDB = await loadSQLiteDriver();

      const dbPath = this.getDatabasePath();

      if (this.readOnlyProfile) {
        this.connectReadOnly(SQLiteDB, dbPath);
        return;
      }

      if (dbPath !== ":memory:") {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new SQLiteDB(dbPath, {
        create: true,
        readwrite: true,
      });

      // Enable WAL mode and foreign keys
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));

      // Typed refusals keep their own identity: wrapping them would strip the
      // config diagnosis / the profile's deny reason code.
      if (error instanceof DatabaseConfigError || error instanceof ExecutionProfileError) {
        throw error;
      }

      throw new ConnectionError(
        `Failed to open SQLite database: ${error instanceof Error ? error.message : error}`,
        "sqlite",
      );
    }
  }

  /**
   * Open the agent read-only handle (#328). Deliberately NOT the shared
   * sequence above:
   *
   * - no directory is created and no `create` flag is passed, so a missing
   *   target leaves the filesystem untouched (the read-only open itself
   *   refuses to create the file on both adapters);
   * - `PRAGMA journal_mode = WAL` is a write and fails outright on a read-only
   *   handle, so the shared pragma trio is skipped — none of it applies to a
   *   connection that cannot write;
   * - `query_only` is set and verified (a read-only open does not imply it).
   *
   * An in-memory target is refused: a read-only open of an anonymous database
   * can only ever yield an empty one (node:sqlite) or fail (bun:sqlite), so
   * vending it would hand the agent a silently useless target.
   */
  private connectReadOnly(SQLiteDB: Awaited<ReturnType<typeof loadSQLiteDriver>>, dbPath: string): void {
    if (dbPath === ":memory:") {
      throw new ExecutionProfileError(
        "The agent read-only execution profile cannot target an in-memory SQLite database",
        "PROFILE_UNSUPPORTED_TARGET",
      );
    }

    this.db = new SQLiteDB(dbPath, { readonly: true });
    try {
      this.enforceQueryOnly();
    } catch (error) {
      this.db.close();
      this.db = null;
      throw error;
    }

    this.setConnected(true);
  }

  /** Set `query_only` and refuse to continue unless it reads back enabled. */
  private enforceQueryOnly(): void {
    this.db!.exec(QUERY_ONLY_PRAGMA_SQL);
    assertQueryOnlyEnabled(this.db!.prepare(QUERY_ONLY_READBACK_SQL).all());
  }

  public async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.setConnected(false);
    }
  }

  private getDatabasePath(): string {
    let dbPath: string;
    if (this.config.connectionString) {
      dbPath = this.config.connectionString.startsWith("file:")
        ? this.config.connectionString.replace("file:", "")
        : this.config.connectionString;
    } else {
      dbPath = this.config.database || ":memory:";
    }

    // Allow :memory: without path validation
    if (dbPath === ":memory:") return dbPath;

    // Reject NUL bytes (never valid in a filesystem path), then resolve to an
    // absolute path. ".." segments are accepted by design: sqlite paths are
    // trusted server-side paths (docs/providers/sqlite.md).
    if (dbPath.includes("\0")) {
      throw new DatabaseConfigError("Invalid database path: NUL bytes are not allowed", "sqlite");
    }

    return path.resolve(dbPath);
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const isSelect = this.isReadOnlyQuery(sql);

          if (isSelect) {
            const stmt = this.db!.prepare(sql);
            const rows = params ? stmt.all(...params) : stmt.all();
            const fields = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            return {
              rows: (rows as unknown[]).map((row) => row as Record<string, unknown>) as Record<string, unknown>[],
              fields,
              changes: 0,
            };
          } else {
            const stmt = this.db!.prepare(sql);
            const info = params ? stmt.run(...params) : stmt.run();
            return {
              rows: [],
              fields: [],
              changes: info.changes,
            };
          }
        } catch (error) {
          throw mapDatabaseError(error, "sqlite", sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rows.length || result.changes,
        executionTime,
      };
    });
  }

  /**
   * Execute exactly one statement under SQLite's own read-only enforcement
   * (#328).
   *
   * The boundary is the database's own enforcement, not any inspection of
   * `sql`: a write reaching this method is executed and rejected by the
   * engine (see `assertQueryOnlyEnabled` for which control covers what). It is
   * therefore refused outright on a provider that was not opened under the
   * profile — a writable handle has no boundary to enforce, and silently
   * running the statement there would be exactly the fail-open this layer
   * exists to prevent.
   *
   * Statements are compiled with `prepare()`, never `exec()`: `exec()` runs
   * every statement of a multi-statement string, while `prepare()` compiles
   * only the first. Rejecting multi-statement input is the policy pipeline's
   * job — this method only guarantees the tail is never executed.
   */
  public async queryReadOnly(sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult> {
    this.ensureConnected();
    assertReadOnlyBudget(budget, "sqlite");
    if (!this.readOnlyProfile) {
      throw new QueryError(
        "Read-only execution requires a provider opened under the agent read-only profile",
        "sqlite",
        sql,
      );
    }
    // Per statement, not just at open: the profiled provider is pooled and
    // reused, so a previous statement's `PRAGMA query_only = false` would
    // otherwise persist for every later call on this connection.
    this.enforceQueryOnly();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return this.db!.prepare(sql).all() as Record<string, unknown>[];
        } catch (error) {
          throw mapDatabaseError(error, "sqlite", sql);
        }
      });

      if (result.length > budget.maxResultRows) {
        throw new QueryError(
          `Read-only execution exceeded the row budget: ${result.length} rows > ${budget.maxResultRows} allowed`,
          "sqlite",
          sql,
        );
      }
      const resultBytes = measureResultBytes(result);
      if (resultBytes > budget.maxResultBytes) {
        throw new QueryError(
          `Read-only execution exceeded the byte budget: ${resultBytes} bytes > ${budget.maxResultBytes} allowed`,
          "sqlite",
          sql,
        );
      }
      // SQLite has no transaction-local statement timeout, and neither adapter
      // exposes sqlite3_interrupt or a progress handler, so the budget's
      // timeout is a post-execution deadline: an overrunning statement is not
      // preempted, but its result is refused rather than returned as if it had
      // been within budget. Recorded as such in docs/providers/sqlite.md.
      if (executionTime > budget.statementTimeoutMs) {
        throw new QueryError(
          `Read-only execution exceeded the time budget: ${executionTime}ms > ${budget.statementTimeoutMs}ms allowed`,
          "sqlite",
          sql,
        );
      }

      return {
        rows: result,
        fields: result.length > 0 ? Object.keys(result[0]) : [],
        rowCount: result.length,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const tablesStmt = this.db!.prepare(SCHEMA_TABLES_SQL);
    const tables = tablesStmt.all() as { name: string }[];

    const schemas: TableSchema[] = [];

    for (const { name: tableName } of tables) {
      const countStmt = this.db!.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const countResult = countStmt.get() as { count: number };
      const rowCount = countResult?.count || 0;

      const columnsStmt = this.db!.prepare(`PRAGMA table_info("${tableName}")`);
      const columns = columnsStmt.all() as SQLiteColumnInfoRow[];

      const fkStmt = this.db!.prepare(`PRAGMA foreign_key_list("${tableName}")`);
      const foreignKeys = fkStmt.all() as SQLiteForeignKeyRow[];

      const indexStmt = this.db!.prepare(`PRAGMA index_list("${tableName}")`);
      const indexList = indexStmt.all() as SQLiteIndexListRow[];

      const indexes = [];
      for (const idx of indexList) {
        if (idx.name.startsWith("sqlite_")) continue;

        const indexInfoStmt = this.db!.prepare(`PRAGMA index_info("${idx.name}")`);
        const indexCols = indexInfoStmt.all() as Array<{ seqno: number; cid: number; name: string }>;

        indexes.push({
          name: idx.name,
          columns: indexCols.map((c) => c.name),
          unique: idx.unique === 1,
        });
      }

      let sizeBytes = 0;
      try {
        const pageCountStmt = this.db!.prepare(DB_PAGE_SIZE_SQL);
        const sizeResult = pageCountStmt.get() as { size: number };
        sizeBytes = sizeResult?.size || 0;
      } catch {
        // Ignore size calculation errors
      }

      schemas.push({
        name: tableName,
        rowCount,
        size: formatBytes(sizeBytes),
        columns: columns.map((col) => ({
          name: col.name,
          type: col.type || "TEXT",
          nullable: col.notnull === 0,
          isPrimary: col.pk === 1,
          defaultValue: col.dflt_value ?? undefined,
        })),
        indexes,
        foreignKeys: foreignKeys.map((fk) => ({
          columnName: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to,
        })),
      });
    }

    return schemas;
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const dbPath = this.getDatabasePath();

    let databaseSize = "N/A";
    if (dbPath !== ":memory:") {
      try {
        const stats = fs.statSync(dbPath);
        databaseSize = formatBytes(stats.size);
      } catch {
        databaseSize = "Unknown";
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(MEMORY_DB_SIZE_SQL);
        const result = sizeStmt.get() as { size: number };
        databaseSize = formatBytes(result?.size || 0);
      } catch {
        databaseSize = "N/A";
      }
    }

    let isHealthy = true;
    try {
      const integrityStmt = this.db!.prepare("PRAGMA integrity_check");
      const integrityResult = integrityStmt.get() as { integrity_check: string };
      isHealthy = integrityResult?.integrity_check === "ok";
    } catch {
      isHealthy = false;
    }

    let journalMode = "unknown";
    try {
      const journalStmt = this.db!.prepare("PRAGMA journal_mode");
      const journalResult = journalStmt.get() as { journal_mode: string };
      journalMode = journalResult?.journal_mode || "unknown";
    } catch {
      // Ignore
    }

    return {
      activeConnections: 1,
      databaseSize,
      // Same word as the performance panel's absent ratio, and now the same
      // constant, so the two cannot drift apart.
      cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [
        {
          query: `Integrity: ${isHealthy ? "OK" : "FAILED"}`,
          calls: 0,
          avgTime: "N/A",
        },
        {
          query: `Journal Mode: ${journalMode}`,
          calls: 0,
          avgTime: "N/A",
        },
      ],
      activeSessions: [
        {
          pid: process.pid,
          user: "sqlite",
          database: path.basename(dbPath),
          state: "active",
          query: "",
          duration: "N/A",
        },
      ],
    };
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      let sql = "";

      switch (type) {
        case "vacuum":
          sql = "VACUUM";
          break;
        case "analyze":
          sql = target ? `ANALYZE ${this.escapeIdentifier(target)}` : "ANALYZE";
          break;
        case "reindex":
          sql = target ? `REINDEX ${this.escapeIdentifier(target)}` : "REINDEX";
          break;
        case "check":
          const checkStmt = this.db!.prepare("PRAGMA integrity_check");
          const checkResult = checkStmt.get() as { integrity_check: string };
          return {
            success: checkResult?.integrity_check === "ok",
            message: checkResult?.integrity_check || "Unknown",
          };
      }

      // Unsupported types fall through the switch with sql left empty. A
      // `default:` label is deliberately avoided here: bun's coverage emits a
      // 0-hit line record for `default:` that no runtime execution ever
      // credits, which permanently poisons the merged lcov report.
      if (!sql) {
        throw new QueryError(`Unsupported maintenance type for SQLite: ${type}`, "sqlite");
      }

      this.db!.exec(sql);
      return { success: true, message: `${type.toUpperCase()} completed successfully` };
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    // Get SQLite version
    const versionStmt = this.db!.prepare("SELECT sqlite_version() as version");
    const versionResult = versionStmt.get() as { version: string };
    const version = `SQLite ${versionResult?.version || "Unknown"}`;

    // Get database size
    const dbPath = this.getDatabasePath();
    let databaseSizeBytes = 0;

    if (dbPath !== ":memory:") {
      try {
        const stats = fs.statSync(dbPath);
        databaseSizeBytes = stats.size;
      } catch {
        // File might not exist yet
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(MEMORY_DB_SIZE_SQL);
        const result = sizeStmt.get() as { size: number };
        databaseSizeBytes = result?.size || 0;
      } catch {
        // Ignore
      }
    }

    // Get table count
    const tableCountStmt = this.db!.prepare(TABLE_COUNT_SQL);
    const tableCountResult = tableCountStmt.get() as { count: number };
    const tableCount = tableCountResult?.count || 0;

    // Get index count
    const indexCountStmt = this.db!.prepare(INDEX_COUNT_SQL);
    const indexCountResult = indexCountStmt.get() as { count: number };
    const indexCount = indexCountResult?.count || 0;

    return {
      version,
      uptime: "N/A",
      activeConnections: 1,
      maxConnections: 1,
      databaseSize: formatBytes(databaseSizeBytes),
      databaseSizeBytes,
      tableCount,
      indexCount,
    };
  }

  /**
   * Only what SQLite can actually be asked, which is no cache hit ratio at all.
   *
   * SQLite's hit and miss counters live behind the C API
   * (`sqlite3_db_status()` with `SQLITE_DBSTATUS_CACHE_HIT` / `CACHE_MISS`), and
   * neither driver this provider can load surfaces them. Measured 2026-08-23 by
   * walking the prototype chain of a live handle: `bun:sqlite` 1.3.14 offers
   * `clearQueryCache, close, exec, fileControl, filename, handle, inTransaction,
   * loadExtension, prepare, query, run, serialize, transaction`, and
   * `node:sqlite` on Node 24.14.0 offers `aggregate, applyChangeset, close,
   * createSession, createTagStore, enableDefensive, enableLoadExtension, exec,
   * function, isOpen, isTransaction, loadExtension, location, open, prepare,
   * setAuthorizer`. No status call on either, and nothing SQL-reachable stands
   * in: `PRAGMA cache_hit` and `PRAGMA cache_miss` are not pragmas (SQLite
   * answers an unknown pragma with zero rows rather than an error, so they
   * *look* like empty readings), `PRAGMA stats` returned `[]` on both drivers,
   * and `PRAGMA cache_size` is the configured page budget - `-2000`, the 2 MiB
   * default, on both.
   *
   * That budget is what the old code turned into a ratio: it reported 95%
   * whenever `PRAGMA cache_size` came back truthy, which it always does, and 99%
   * otherwise. Both numbers were this provider's invention, and the panel rated
   * them "Excellent". A missing panel is honest; a populated wrong one is not
   * (#424), so the field is omitted - permanently, not pending a better query.
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    return {
      // `cacheHitRatio`, `queriesPerSecond` and `bufferPoolUsage` are all absent:
      // SQLite keeps no statement counter and no server-side buffer pool whose
      // usage could be read, so the monitoring tabs show "Not measured" for each.
      //
      // `deadlocks` is different, and stays. It is a statement about the engine
      // rather than a reading that failed: SQLite serializes writers behind a
      // single write lock and has no lock-wait graph to deadlock in - a second
      // writer is refused with SQLITE_BUSY instead - so there are no deadlocks to
      // count and 0 is the true count.
      deadlocks: 0,
    };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    // SQLite doesn't have built-in query statistics
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();

    const dbPath = this.getDatabasePath();

    // SQLite is single-connection, return current session
    return [
      {
        pid: process.pid,
        user: "sqlite",
        database: path.basename(dbPath),
        state: "active",
        query: "",
        duration: "N/A",
        durationMs: 0,
      },
    ];
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    const tablesStmt = this.db!.prepare(STATS_TABLES_SQL);
    const tables = tablesStmt.all() as { name: string }[];

    // One dbstat scan per call, not per table: it reads the whole database file.
    const sizes = readDbstatSizes(this.db!);
    const stats: TableStats[] = [];

    for (const { name: tableName } of tables) {
      // Get row count
      const countStmt = this.db!.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const countResult = countStmt.get() as { count: number };
      const rowCount = countResult?.count || 0;

      stats.push(buildTableStats(tableName, rowCount, sizes?.get(tableName) ?? null));
    }

    return stats;
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    const indexesStmt = this.db!.prepare(STATS_INDEXES_SQL);
    const indexes = indexesStmt.all() as { name: string; tbl_name: string }[];

    const stats: IndexStats[] = [];

    for (const { name: indexName, tbl_name: tableName } of indexes) {
      // Get index info
      const indexInfoStmt = this.db!.prepare(`PRAGMA index_info("${indexName}")`);
      const indexCols = indexInfoStmt.all() as { seqno: number; cid: number; name: string }[];

      // Get index uniqueness
      const indexListStmt = this.db!.prepare(`PRAGMA index_list("${tableName}")`);
      const indexList = indexListStmt.all() as { name: string; unique: number }[];
      const indexMeta = indexList.find((i) => i.name === indexName);

      stats.push({
        schemaName: "main",
        tableName,
        indexName,
        columns: indexCols.map((c) => c.name),
        isUnique: indexMeta?.unique === 1,
        isPrimary: false, // SQLite auto-creates rowid, explicit PKs are shown differently
        // SQLite publishes no per-index size: `dbstat` would give page counts but it
        // is a compile-time option (ENABLE_DBSTAT_VTAB) the build decides - always there
        // on node:sqlite, absent on bun:sqlite through Bun 1.3.14 ("no such table:
        // dbstat", measured 2026-08-23) - so it cannot be relied on for every install.
        // The size string already said so; the companion byte
        // count said 0, and the Storage tab summed those zeroes into an index total
        // that read as "every index is empty". The field is optional for this case.
        indexSize: "N/A",
        scans: 0, // SQLite doesn't track index usage
      });
    }

    return stats;
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const stats: StorageStats[] = [];
    const dbPath = this.getDatabasePath();

    // Main database file
    let mainSizeBytes = 0;
    if (dbPath !== ":memory:") {
      try {
        const fileStats = fs.statSync(dbPath);
        mainSizeBytes = fileStats.size;
      } catch {
        // File might not exist
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(MEMORY_DB_SIZE_SQL);
        const result = sizeStmt.get() as { size: number };
        mainSizeBytes = result?.size || 0;
      } catch {
        // Ignore
      }
    }

    stats.push({
      name: "Main Database",
      location: dbPath === ":memory:" ? ":memory:" : path.basename(dbPath),
      size: formatBytes(mainSizeBytes),
      sizeBytes: mainSizeBytes,
    });

    // WAL file (if exists)
    if (dbPath !== ":memory:") {
      const walPath = `${dbPath}-wal`;
      try {
        const walStats = fs.statSync(walPath);
        stats.push({
          name: "WAL",
          location: path.basename(walPath),
          size: formatBytes(walStats.size),
          sizeBytes: walStats.size,
          walSize: formatBytes(walStats.size),
          walSizeBytes: walStats.size,
        });
      } catch {
        // WAL might not exist
      }

      // SHM file (if exists)
      const shmPath = `${dbPath}-shm`;
      try {
        const shmStats = fs.statSync(shmPath);
        stats.push({
          name: "Shared Memory",
          location: path.basename(shmPath),
          size: formatBytes(shmStats.size),
          sizeBytes: shmStats.size,
        });
      } catch {
        // SHM might not exist
      }
    }

    return stats;
  }
}
