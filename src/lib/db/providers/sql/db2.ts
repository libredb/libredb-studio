/**
 * IBM Db2 for Linux, UNIX and Windows (Db2 LUW) Database Provider
 *
 * Reached over the DRDA binary protocol through the native `ibm_db` driver (an N-API
 * addon whose install step fetches the IBM CLI driver). There is a first-class HTTP
 * path — the Db2 REST service's `/v1/services/execsql` endpoint — but it is a
 * separately deployed container that is commonly disabled, so an IDE that must reach
 * ANY standard Db2 uses the driver the way DBeaver/DataGrip do. See
 * `docs/providers/db2.md` for the driver's distribution cost and the REST alternative.
 *
 * Standard SQL: double-quoted identifiers and `FETCH FIRST n ROWS ONLY` pagination are
 * both correct Db2, so this extends `SQLBaseProvider` and inherits `escapeIdentifier()`
 * unchanged, overriding only `prepareQuery()` — the same shape as Oracle.
 *
 * `ibm_db` exposes a callback API. This module holds ONE connection handle (the driver
 * has no pool of its own worth the surface here for an editor), serialises queries onto
 * it, and wraps every callback in a promise at the driver boundary. Connection pooling,
 * failover and retry are the code the driver would otherwise own and are deliberately
 * not written — acceptable for an editor, and stated in the doc rather than hidden.
 */

// `ibm_db`'s published typings are thin, so the driver surface this provider touches is
// declared here and the import is typed against it. The dynamic import in factory.ts is
// what keeps the native addon out of the initial bundle.
import { SQLBaseProvider } from "./sql-base";
import {
  type DatabaseConnection,
  type TableSchema,
  type ColumnSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type DatabaseOverview,
  type PerformanceMetrics,
  type TableStats,
  type IndexStats,
  type StorageStats,
  type PreparedQuery,
  type QueryPrepareOptions,
} from "../../types";
// IndexSchema and ForeignKeySchema are not re-exported by db/types.ts (the shared
// db-provider type surface), so they come straight from the app-wide type module.
import { type IndexSchema, type ForeignKeySchema } from "@/lib/types";
import { DatabaseConfigError, ConnectionError, mapDatabaseError } from "../../errors";
import { analyzeQuery, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../utils/query-limiter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// Driver surface (ibm_db)
// ============================================================================

/**
 * The slice of `ibm_db`'s callback API this provider uses, declared locally because the
 * package's own typings do not describe a promise surface and are incomplete.
 * `ibm_db.open` hands back a `Database` connection object; `query` runs a statement and
 * calls back with an array of row objects (keyed by column name). Errors arrive as the
 * first callback argument, Node-style.
 */
interface Db2Connection {
  query(sql: string, callback: (err: Error | null, rows: Record<string, unknown>[]) => void): void;
  query(sql: string, params: unknown[], callback: (err: Error | null, rows: Record<string, unknown>[]) => void): void;
  close(callback: (err: Error | null) => void): void;
}

interface Db2Driver {
  open(connStr: string, callback: (err: Error | null, conn: Db2Connection) => void): void;
}

// ============================================================================
// SQL statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution stays
// stable (repo pattern, see the SCHEMA_*_SQL consts in oracle.ts / mssql.ts).
//
// The schema reads target SYSCAT.*, the standard read-only catalog views every Db2 LUW
// exposes. `CURRENT SCHEMA` is Db2's session default schema — the connecting user's
// schema unless SET SCHEMA changed it — which is the namespace a bare table name
// resolves against, so it is the right filter for "this connection's tables".

const SCHEMA_COLUMNS_SQL = `SELECT TABNAME, COLNAME, TYPENAME, NULLS, "DEFAULT", COLNO
         FROM SYSCAT.COLUMNS
         WHERE TABSCHEMA = CURRENT SCHEMA
         ORDER BY TABNAME, COLNO`;

const SCHEMA_TABLES_SQL = `SELECT TABNAME, CARD AS ROW_COUNT
         FROM SYSCAT.TABLES
         WHERE TABSCHEMA = CURRENT SCHEMA AND TYPE = 'T'
         ORDER BY TABNAME`;

const SCHEMA_PRIMARY_KEYS_SQL = `SELECT kc.TABNAME, kc.COLNAME
         FROM SYSCAT.KEYCOLUSE kc
         JOIN SYSCAT.TABCONST tc
           ON kc.CONSTNAME = tc.CONSTNAME AND kc.TABSCHEMA = tc.TABSCHEMA AND kc.TABNAME = tc.TABNAME
         WHERE tc.TABSCHEMA = CURRENT SCHEMA AND tc.TYPE = 'P'`;

const SCHEMA_FOREIGN_KEYS_SQL = `SELECT r.TABNAME,
                fk.COLNAME,
                r.REFTABNAME AS REF_TABLE,
                pk.COLNAME AS REF_COLUMN
         FROM SYSCAT.REFERENCES r
         JOIN SYSCAT.KEYCOLUSE fk
           ON r.CONSTNAME = fk.CONSTNAME AND r.TABSCHEMA = fk.TABSCHEMA AND r.TABNAME = fk.TABNAME
         JOIN SYSCAT.KEYCOLUSE pk
           ON r.REFKEYNAME = pk.CONSTNAME AND r.REFTABSCHEMA = pk.TABSCHEMA
              AND pk.COLSEQ = fk.COLSEQ
         WHERE r.TABSCHEMA = CURRENT SCHEMA`;

const SCHEMA_INDEXES_SQL = `SELECT ic.INDNAME, ic.TABNAME, ic.UNIQUERULE, icu.COLNAME, icu.COLSEQ
         FROM SYSCAT.INDEXES ic
         JOIN SYSCAT.INDEXCOLUSE icu
           ON ic.INDNAME = icu.INDNAME AND ic.INDSCHEMA = icu.INDSCHEMA
         WHERE ic.TABSCHEMA = CURRENT SCHEMA
         ORDER BY ic.TABNAME, ic.INDNAME, icu.COLSEQ`;

const VERSION_SQL = `SELECT SERVICE_LEVEL FROM TABLE(SYSPROC.ENV_GET_INST_INFO()) AS T`;

// ============================================================================
// Row shapes
// ============================================================================

type ForeignKeyRow = { columnName: string; referencedTable: string; referencedColumn: string };

// ============================================================================
// Db2 Provider
// ============================================================================

export class Db2Provider extends SQLBaseProvider {
  private conn: Db2Connection | null = null;
  private driver: Db2Driver | null = null;

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
      defaultPort: 50000,
      // Disabled until a Db2 dialect explain flow exists (#126, same posture as Oracle
      // and SQL Server): Db2 EXPLAIN populates the explain tables (EXPLAIN_STATEMENT et
      // al.) rather than returning a plan from one statement, which the single-statement
      // explain path cannot express. Adding it later is additive — a new ExplainFormat
      // union member plus a strategy — and flips this flag with no rework here.
      supportsExplain: false,
      supportsConnectionString: true,
      // Db2 accepts the single-table `UPDATE <t> SET <col> = <val> WHERE <pk> = <val>`
      // the results grid's inline editor builds.
      supportsInlineRowEdit: true,
      // Not implemented in this provider yet: no held-connection transaction session is
      // wired to POST /api/db/transaction, so the toolbar trio and SANDBOX stay hidden
      // rather than offer a control the route would refuse. Db2 has transactions; this
      // is a statement about the provider's surface, exactly as SQLite's `false` is.
      supportsTransactions: false,
      // `analyze` is RUNSTATS; `optimize` is REORG TABLE. Both are declared per-entity
      // and NOT global: on Db2 LUW there is no single whole-database RUNSTATS or REORG
      // statement — each targets one table — so a global card would send the operation
      // with no target, which `runMaintenance` correctly refuses (the broken "Update
      // Statistics" button #… reported). Unlike Oracle, which has a real whole-schema
      // form (`DBMS_STATS.GATHER_SCHEMA_STATS`) and so declares `global: true`, Db2's
      // honest surface is per-table only. Doing "all tables" would mean iterating
      // SYSCAT.TABLES and issuing one statement each, and for REORG that is a slow,
      // lock-heavy operation across potentially thousands of tables — not something a
      // single global button should fire. So these are offered from the schema
      // explorer's per-table row menu, where a target exists, and no global card renders.
      // `check`, `kill` and index rebuild stay off the list until a live pass. Widen after.
      maintenanceOperations: ["analyze", "optimize"],
      maintenanceOperationSpecs: {
        analyze: { label: "Run Statistics", perEntity: true, global: false },
        optimize: { label: "Reorganize Table", perEntity: true, global: false },
      },
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Run Statistics",
      // Db2 has no VACUUM; the reclaim/reorg operation is REORG TABLE, which this
      // provider exposes as `optimize`. Point the vacuum slot at that operation so the
      // schema-explorer row menu sends `optimize` rather than a `vacuum` this provider
      // does not offer (the #496 shape).
      vacuumAction: "Reorganize Table",
      vacuumActionOperation: "optimize",
      // No analyzeGlobal*/vacuumGlobal* overrides: both operations declare `global: false`
      // (RUNSTATS/REORG are per-table on Db2), so the Operations tab renders no global card
      // for them and those label triads would never be read. The generic inherited strings
      // stay unused rather than stating a whole-database operation that does not exist.
      // `slowQueriesEmptyState` is intentionally omitted too — the monitoring Queries tab is
      // empty for a different reason on Db2 (MON_GET_* is not wired yet, §6), and pointing it
      // at a specific view would overclaim; the generic empty state is the honest one for now.
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for Db2", "db2");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for Db2", "db2");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * The DRDA connection string `ibm_db.open` expects: a semicolon-delimited list of
   * `KEY=VALUE` attributes. A pasted `connectionString` is returned unchanged so the
   * user's own attributes (SECURITY, Authentication, etc.) decide, exactly as the
   * Oracle and SQL Server providers return a pasted string untouched.
   *
   * SECURITY=SSL is Db2's own switch for TLS on the wire; it is added only when the SSL
   * mode is not `disable`. This is the audited shape of the attribute list, not a claim
   * about a verified TLS path — the live pass runs against a plaintext listener.
   */
  private buildConnectionString(): string {
    if (this.config.connectionString) {
      return this.config.connectionString;
    }

    const host = this.config.host || "localhost";
    const port = this.config.port || 50000;
    const parts = [
      `DATABASE=${this.config.database}`,
      `HOSTNAME=${host}`,
      `PORT=${port}`,
      "PROTOCOL=TCPIP",
      `UID=${this.config.user ?? ""}`,
      `PWD=${this.config.password ?? ""}`,
    ];

    if (this.config.ssl && this.config.ssl.mode !== "disable") {
      parts.push("SECURITY=SSL");
    }

    return parts.join(";") + ";";
  }

  private open(driver: Db2Driver, connStr: string): Promise<Db2Connection> {
    return new Promise((resolve, reject) => {
      driver.open(connStr, (err, conn) => {
        if (err) reject(err);
        else resolve(conn);
      });
    });
  }

  public async connect(): Promise<void> {
    if (this.conn) {
      return;
    }

    try {
      // Dynamic import keeps the native addon out of the initial bundle and off the
      // load path of every non-Db2 connection.
      const mod = (await import("ibm_db")) as unknown as Db2Driver;
      this.driver = mod;
      this.conn = await this.open(this.driver, this.buildConnectionString());
      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to Db2: ${error instanceof Error ? error.message : error}`,
        "db2",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.conn) {
      const conn = this.conn;
      this.conn = null;
      await new Promise<void>((resolve) => {
        conn.close(() => resolve());
      });
      this.setConnected(false);
    }
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  // `ibm_db`'s `query(sql, params, cb)` binds `params` to the statement's `?`
  // placeholders positionally. The driver reads a function in the params slot as
  // the callback (`cb = params; params = null`), so a no-params call must pass the
  // callback in the two-arg form rather than an empty array: some builds bind an
  // empty array against a statement that has no markers and raise CLI0100E, the
  // very "Wrong number of parameters" error a bound statement is meant to avoid.
  private run(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      };
      if (params !== undefined && params.length > 0) {
        this.conn!.query(sql, params, cb);
      } else {
        this.conn!.query(sql, cb);
      }
    });
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await this.run(sql, params);
        } catch (error) {
          throw mapDatabaseError(error, "db2", sql);
        }
      });

      // `ibm_db` hands back an array of row objects keyed by column name and does not
      // expose a declared-type name on its high-level query surface, so `fields` is
      // derived from the first row's keys and `columnTypes` is OMITTED rather than
      // guessed. Absence is the signal the grid reads (issue #273); adding declared
      // types is a verified follow-up through the driver's prepared-statement
      // describeColumns surface. Documented in docs/providers/db2.md.
      const rows = result as Record<string, unknown>[];
      const fields = rows.length > 0 ? Object.keys(rows[0]) : [];

      return {
        rows,
        fields,
        rowCount: rows.length,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Query Preparation (Db2 FETCH FIRST — same shape as Oracle)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query, this.type);

    if (queryInfo.type === "SELECT" && !queryInfo.hasLimit) {
      // Build on the statement's own text and re-attach whatever trailed it, declining
      // when the tail cannot be safely cut — the same guard Oracle's prepareQuery uses,
      // so a clause is never appended inside a trailing comment (#280). Db2 spells the
      // page `OFFSET n ROWS FETCH NEXT n ROWS ONLY` and the first page
      // `FETCH FIRST n ROWS ONLY`, identical to Oracle 12c+.
      const source = query.trim();
      const { end, rewritable } = readStatementEnd(source, resolveSqlGrammar(this.type));
      if (!rewritable) {
        return { query, wasLimited: false, limit: effectiveLimit, offset };
      }

      const head = source.slice(0, end);
      const trailing = source.slice(end);

      const clause =
        offset > 0
          ? `OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`
          : `FETCH FIRST ${effectiveLimit} ROWS ONLY`;

      return {
        query: `${head} ${clause}${trailing}`,
        wasLimited: true,
        limit: effectiveLimit,
        offset,
      };
    }

    return { query, wasLimited: false, limit: effectiveLimit, offset };
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const [tableRows, columnRows, pkRows, fkRows, indexRows] = await Promise.all([
      this.run(SCHEMA_TABLES_SQL),
      this.run(SCHEMA_COLUMNS_SQL),
      this.run(SCHEMA_PRIMARY_KEYS_SQL),
      this.run(SCHEMA_FOREIGN_KEYS_SQL),
      this.run(SCHEMA_INDEXES_SQL),
    ]);

    // Primary-key column set, keyed "table\0column" for O(1) isPrimary lookup.
    const pkSet = new Set<string>();
    for (const row of pkRows) {
      pkSet.add(`${String(row.TABNAME)}\0${String(row.COLNAME)}`);
    }

    // Columns grouped per table.
    const columnsByTable = new Map<string, ColumnSchema[]>();
    for (const row of columnRows) {
      const table = String(row.TABNAME);
      const name = String(row.COLNAME);
      const list = columnsByTable.get(table) ?? [];
      list.push({
        name,
        type: String(row.TYPENAME).toLowerCase(),
        // SYSCAT.COLUMNS.NULLS is 'Y' / 'N'.
        nullable: String(row.NULLS) === "Y",
        isPrimary: pkSet.has(`${table}\0${name}`),
        defaultValue: row.DEFAULT === null || row.DEFAULT === undefined ? undefined : String(row.DEFAULT),
      });
      columnsByTable.set(table, list);
    }

    // Foreign keys grouped per table.
    const fksByTable = new Map<string, ForeignKeyRow[]>();
    for (const row of fkRows) {
      const table = String(row.TABNAME);
      const list = fksByTable.get(table) ?? [];
      list.push({
        columnName: String(row.COLNAME),
        referencedTable: String(row.REF_TABLE),
        referencedColumn: String(row.REF_COLUMN),
      });
      fksByTable.set(table, list);
    }

    // Indexes grouped per table, then per index name (to collect ordered columns).
    const indexAccumulator = new Map<string, Map<string, { columns: string[]; unique: boolean }>>();
    for (const row of indexRows) {
      const table = String(row.TABNAME);
      const indexName = String(row.INDNAME);
      const perTable = indexAccumulator.get(table) ?? new Map();
      const entry = perTable.get(indexName) ?? {
        columns: [],
        // SYSCAT.INDEXES.UNIQUERULE: 'U' unique, 'P' primary, 'D' duplicates allowed.
        unique: String(row.UNIQUERULE) === "U" || String(row.UNIQUERULE) === "P",
      };
      entry.columns.push(String(row.COLNAME));
      perTable.set(indexName, entry);
      indexAccumulator.set(table, perTable);
    }

    const indexesByTable = new Map<string, IndexSchema[]>();
    for (const [table, perTable] of indexAccumulator) {
      const list: IndexSchema[] = [];
      for (const [name, entry] of perTable) {
        list.push({ name, columns: entry.columns, unique: entry.unique });
      }
      indexesByTable.set(table, list);
    }

    return tableRows.map((row) => {
      const name = String(row.TABNAME);
      const foreignKeys = fksByTable.get(name) ?? [];
      const schema: TableSchema = {
        name,
        columns: columnsByTable.get(name) ?? [],
        indexes: indexesByTable.get(name) ?? [],
        foreignKeys: foreignKeys as ForeignKeySchema[],
      };
      // SYSCAT.TABLES.CARD is the last-collected cardinality, -1 when RUNSTATS has never
      // run. Report it only when it is a real measurement.
      const card = Number(row.ROW_COUNT);
      if (Number.isFinite(card) && card >= 0) schema.rowCount = card;
      return schema;
    });
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    return {
      databaseSize: "N/A",
      cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [],
      activeSessions: [],
    };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    let version = "Unknown";
    try {
      const rows = await this.run(VERSION_SQL);
      if (rows.length > 0 && rows[0].SERVICE_LEVEL !== undefined && rows[0].SERVICE_LEVEL !== null) {
        version = String(rows[0].SERVICE_LEVEL);
      }
    } catch {
      // ENV_GET_INST_INFO is permission-gated; a denied read leaves the neutral default
      // rather than failing the whole overview.
    }

    return {
      version,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 0,
      indexCount: 0,
    };
  }

  /**
   * Db2's rich performance data lives in the MON_GET_* table functions and SYSIBMADM.*
   * administrative views, both permission-gated. Rather than claim figures unverified
   * against a live server, this returns a neutral object; the panels the data would
   * fill read absence as healthy (the `cacheHitRatio` omission is load-bearing —
   * DEFAULT_THRESHOLDS scores it `direction: "below"`, so a fabricated 0 would paint a
   * critical cache fault on every healthy database). Widening this is a verified
   * follow-up. See docs/providers/db2.md.
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    return {};
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    return [];
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * `analyze` → RUNSTATS, `optimize` → REORG TABLE. Both take a table name and both run
   * through the CALL ADMIN_CMD interface, which is how Db2 exposes these command-line
   * utilities to SQL.
   */
  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const start = Date.now();
    try {
      if (type === "analyze") {
        if (!target) {
          throw new DatabaseConfigError("A table name is required for RUNSTATS", "db2");
        }
        const table = this.escapeIdentifier(target);
        await this.run(
          `CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE ${table} WITH DISTRIBUTION AND DETAILED INDEXES ALL')`,
        );
        return { success: true, executionTime: Date.now() - start, message: `RUNSTATS completed on ${target}` };
      }

      if (type === "optimize") {
        if (!target) {
          throw new DatabaseConfigError("A table name is required for REORG", "db2");
        }
        const table = this.escapeIdentifier(target);
        await this.run(`CALL SYSPROC.ADMIN_CMD('REORG TABLE ${table}')`);
        return { success: true, executionTime: Date.now() - start, message: `REORG completed on ${target}` };
      }

      throw new DatabaseConfigError(`Unsupported maintenance operation for Db2: ${type}`, "db2");
    } catch (error) {
      throw mapDatabaseError(error, "db2");
    }
  }
}
