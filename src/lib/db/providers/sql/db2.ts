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
import { formatBytes, formatDuration } from "../../utils/pool-manager";
import { logger } from "@/lib/logger";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio } from "@/lib/monitoring-cache-ratio";

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

// Per-table stats for the admin Operations/Monitoring "Tables" panel. Read from the
// catalog, not fabricated: CARD is the row count and STATS_TIME is when RUNSTATS last
// wrote them. Both are only as current as that RUNSTATS — a table that has never had it
// reports CARD = -1 and STATS_TIME = NULL, which the mapper turns into "no stats" (row
// count 0, no lastAnalyze) rather than surfacing -1. Sizes are deliberately NOT read
// here: the only per-table size Db2 publishes is SYSPROC.ADMIN_GET_TAB_INFO, a table
// function called one table at a time, and running it across a whole schema (measured too
// slow on a large real catalog) is too heavy for a panel read. Size is a follow-up.
const TABLE_STATS_SQL = `SELECT TABSCHEMA, TABNAME, CARD, STATS_TIME
         FROM SYSCAT.TABLES
         WHERE TABSCHEMA = CURRENT SCHEMA AND TYPE = 'T'
         ORDER BY TABNAME`;

// Live monitoring reads. Every one of these is a MON_GET_* table function or a
// SYSIBMADM.* administrative view, and every one is permission-gated (they need SYSMON
// authority or an explicit grant). The provider runs each in its own try/catch and
// returns an empty result on failure rather than throwing: a locked-down account that
// cannot read them sees an empty panel, exactly as the DatabaseProvider contract requires
// for a permission-gated source, while a monitoring-authorized account sees real data.
// Measured readable on Db2 v11.5.9.0. Documented in docs/providers/db2.md §6.

// Active connections, the Sessions panel. -2 = every member; NULL handle = all.
const SESSIONS_SQL = `SELECT APPLICATION_HANDLE, APPLICATION_NAME, CLIENT_IPADDR,
           SYSTEM_AUTH_ID, TOTAL_APP_COMMITS
         FROM TABLE(MON_GET_CONNECTION(NULL, -2)) AS T
         ORDER BY APPLICATION_HANDLE
         FETCH FIRST 200 ROWS ONLY`;

// Statement cache with timings, the slow-query panel. Db2 only accumulates per-statement
// execution TIMES when the database's `mon_req_metrics`/`mon_act_metrics` config is on;
// with it off (the default on many installs), `NUM_EXEC_WITH_METRICS` is 0 and every time
// column reads 0. Filtering on `NUM_EXEC_WITH_METRICS > 0` keeps the panel honest: it shows
// real timings when the server collects them and an empty state (not a list of 0.00 ms
// rows) when it does not. TOTAL_ACT_TIME is milliseconds of activity across the metrics-
// bearing executions; the average is derived per row.
const SLOW_QUERIES_SQL = `SELECT STMT_TEXT, NUM_EXECUTIONS, NUM_EXEC_WITH_METRICS, TOTAL_ACT_TIME, ROWS_READ
         FROM TABLE(MON_GET_PKG_CACHE_STMT(NULL, NULL, NULL, -2)) AS T
         WHERE STMT_TEXT IS NOT NULL AND NUM_EXEC_WITH_METRICS > 0
         ORDER BY TOTAL_ACT_TIME DESC
         FETCH FIRST 50 ROWS ONLY`;

// Buffer-pool hit ratio source. NOTE: MON_GET_BUFFERPOOL only accumulates read counters
// when the database's mon_obj_metrics config is on (measured NONE on a real server, so
// every counter read 0). SYSIBMADM.BP_HITRATIO is the older snapshot-monitor view and
// reports real logical/physical reads regardless of that config, so it is the reliable
// source for a hit ratio. Summed across pools: (logical - physical) / logical.
const BUFFERPOOL_SQL = `SELECT SUM(TOTAL_LOGICAL_READS) AS LOGICAL_READS,
           SUM(TOTAL_PHYSICAL_READS) AS PHYSICAL_READS
         FROM SYSIBMADM.BP_HITRATIO`;

// Tablespace sizing, the Storage panel. Bytes = used pages * page size.
const STORAGE_SQL = `SELECT TBSP_NAME, TBSP_TYPE, TBSP_TOTAL_PAGES, TBSP_USED_PAGES, TBSP_PAGE_SIZE
         FROM TABLE(MON_GET_TABLESPACE(NULL, -2)) AS T
         ORDER BY TBSP_USED_PAGES DESC`;

// Count of live connections, for the overview/health `activeConnections`. Same gated
// source as SESSIONS_SQL; a refused read leaves the count absent (never a fabricated 0).
const ACTIVE_CONNECTIONS_SQL = `SELECT COUNT(*) AS N FROM TABLE(MON_GET_CONNECTION(NULL, -2)) AS T`;

// Configured connection ceiling for the overview. `maxappls` is Db2's per-database limit
// on concurrent applications — the meaningful cap (the DBM-level `max_connections` is
// often -1 = automatic). SYSIBMADM.DBCFG is permission-gated, so a refusal leaves the
// overview's `maxConnections` at 0.
const MAX_CONNECTIONS_SQL = `SELECT VALUE FROM SYSIBMADM.DBCFG WHERE NAME = 'maxappls' FETCH FIRST 1 ROW ONLY`;

// Database-wide overview counts and the activation time. TABLE/INDEX counts come from the
// catalog (whole database, TYPE='T' for base tables); DB_CONN_TIME is when the database was
// activated, from which uptime is derived. Catalog counts are always readable; DB_CONN_TIME
// needs MON authority and is read separately so a refusal only costs the uptime figure.
const CATALOG_COUNTS_SQL = `SELECT
           (SELECT COUNT(*) FROM SYSCAT.TABLES WHERE TYPE = 'T') AS TABLE_COUNT,
           (SELECT COUNT(*) FROM SYSCAT.INDEXES) AS INDEX_COUNT
         FROM SYSIBM.SYSDUMMY1`;
// Uptime as elapsed SECONDS, computed by the database rather than in JS. DB_CONN_TIME is
// the database activation time in the server's own timezone; parsing that string in Node
// and subtracting from Date.now() goes wrong whenever the app and the server are in
// different timezones (measured: a UTC server read as local EDT produced a NEGATIVE
// uptime). Doing the arithmetic in Db2 against its own CURRENT_TIMESTAMP keeps both sides
// in the server's clock. DAYS + MIDNIGHT_SECONDS is exact (TIMESTAMPDIFF is an estimate).
const DB_UPTIME_SECONDS_SQL = `SELECT
           (DAYS(CURRENT_TIMESTAMP) - DAYS(DB_CONN_TIME)) * 86400
             + (MIDNIGHT_SECONDS(CURRENT_TIMESTAMP) - MIDNIGHT_SECONDS(DB_CONN_TIME)) AS UPTIME_SECONDS
         FROM TABLE(MON_GET_DATABASE(-2)) AS T`;

// Database-level counters for the Performance panel. DEADLOCKS is a real cumulative count
// since activation; a positive value is a genuine signal, a 0 is a measured 0 (not a
// fabricated absence). Permission-gated, so a refusal omits the field.
const DEADLOCKS_SQL = `SELECT DEADLOCKS FROM TABLE(MON_GET_DATABASE(-2)) AS T`;

// Per-index stats for the monitoring Indexes panel, scoped to CURRENT SCHEMA like the
// Tables panel. Structural columns (name, table, uniquerule, type, leaf pages, key columns)
// come from SYSCAT.INDEXES + SYSCAT.INDEXCOLUSE — always readable. Scan counts are LEFT
// JOINed from MON_GET_INDEX (real where an index has been used since activation, 0
// elsewhere); that table function is permission-gated, so the whole read goes through
// tryRun and an index simply reports 0 scans when the join finds nothing. Index size is not
// derived: NLEAF is leaf PAGES whose byte size depends on the index's tablespace page size,
// a per-object lookup too heavy for a panel read and meaningless until RUNSTATS has run
// (NLEAF = -1 before then), so the required `indexSize` carries the "N/A" placeholder and
// `indexSizeBytes` is omitted — the same honest-absence contract getTableStats uses.
const INDEX_STATS_SQL = `WITH SCANS AS (
           SELECT RTRIM(TABSCHEMA) AS TS, RTRIM(TABNAME) AS TN, IID, SUM(INDEX_SCANS) AS SCANS
           FROM TABLE(MON_GET_INDEX(NULL, NULL, -2)) AS M
           GROUP BY RTRIM(TABSCHEMA), RTRIM(TABNAME), IID
         )
         SELECT i.INDSCHEMA, i.INDNAME, i.TABNAME, i.UNIQUERULE, i.INDEXTYPE,
                (SELECT LISTAGG(RTRIM(ic.COLNAME), ',') WITHIN GROUP (ORDER BY ic.COLSEQ)
                 FROM SYSCAT.INDEXCOLUSE ic
                 WHERE ic.INDSCHEMA = i.INDSCHEMA AND ic.INDNAME = i.INDNAME) AS COLS,
                COALESCE(s.SCANS, 0) AS SCANS
         FROM SYSCAT.INDEXES i
         LEFT JOIN SCANS s
           ON s.TS = RTRIM(i.TABSCHEMA) AND s.TN = RTRIM(i.TABNAME) AND s.IID = i.IID
         WHERE i.TABSCHEMA = CURRENT SCHEMA
         ORDER BY i.TABNAME, i.INDNAME`;

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
      //
      // Db2's slow-query timings come from MON_GET_PKG_CACHE_STMT, but only once the database
      // config `mon_req_metrics`/`mon_act_metrics` is enabled (getSlowQueries filters out the
      // metric-less rows, §6). So the Queries panel's empty state is NOT "install
      // pg_stat_statements" — that Postgres wording is actively false here — it is "turn on
      // Db2's monitoring metrics". This label replaces it.
      slowQueriesEmptyState:
        "Db2 records per-statement timings only when the database's monitoring metrics are enabled. " +
        "To see slow queries here, a DBA can run: UPDATE DB CFG FOR <database> USING mon_req_metrics BASE " +
        "(or mon_act_metrics BASE). The slowest cached statements then appear on the next refresh.",
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

      // The DRDA connection string is a `KEY=VALUE;` attribute list with NO escaping for
      // its delimiter. A field value containing `;` would split into extra attributes:
      // a password `pa;ss` misparses (auth fails on `pa`), and a crafted value could
      // INJECT an attribute (`PWD=x;SECURITY=NONE` was shown to connect). There is no
      // brace/quote form the CLI driver honours (measured: `{value}` is taken literally),
      // so the only safe answer for the field-built path is to refuse the delimiter and
      // point the user at the connection-string field, which they own end to end.
      for (const [name, value] of [
        ["Host", this.config.host],
        ["Database name", this.config.database],
        ["Username", this.config.user],
        ["Password", this.config.password],
      ] as const) {
        if (typeof value === "string" && value.includes(";")) {
          throw new DatabaseConfigError(
            `${name} contains a ';', which Db2's connection-string format cannot carry safely. ` +
              "Use the connection-string field to pass it as a quoted DRDA attribute instead.",
            "db2",
          );
        }
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

  /**
   * Run a monitoring read that may be refused, returning `[]` instead of throwing.
   *
   * The MON_GET_* table functions and SYSIBMADM.* views are permission-gated (SYSMON
   * authority or an
   * explicit grant). The DatabaseProvider contract for a gated source is to return empty
   * rather than fail the panel, so a locked-down account degrades to a blank panel while a
   * monitoring-authorized account gets real data. The engine's own message is logged, not
   * surfaced, because the panel's own emptiness is the user-visible signal.
   */
  private async tryRun(sql: string): Promise<Record<string, unknown>[]> {
    try {
      return await this.run(sql);
    } catch (error) {
      logger.warn("[db2] monitoring read refused; returning empty", {
        route: "db2/monitoring",
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
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

  /**
   * A private reader for the active-connection count, absent (not 0) on a refused read.
   * Shared by `getHealth` and `getOverview` so the absence travels through both the way
   * the `DatabaseOverview.activeConnections`/`HealthInfo.activeConnections` docblocks
   * require: a denied MON_GET_CONNECTION must not reach the agent as a measured zero.
   */
  private async readActiveConnections(): Promise<number | undefined> {
    const rows = await this.tryRun(ACTIVE_CONNECTIONS_SQL);
    if (rows.length === 0) return undefined;
    const n = Number(rows[0].N);
    return Number.isFinite(n) ? n : undefined;
  }

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const cacheRatio = await this.readCacheHitRatio();
    const activeConnections = await this.readActiveConnections();

    return {
      databaseSize: "N/A",
      cacheHitRatio: cacheRatio === undefined ? CACHE_HIT_RATIO_UNAVAILABLE : formatCacheHitRatio(cacheRatio),
      slowQueries: [],
      activeSessions: [],
      ...(activeConnections === undefined ? {} : { activeConnections }),
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

    const activeConnections = await this.readActiveConnections();

    // Catalog counts are always readable; the activation time and tablespace sizing are
    // permission-gated, so each is read through tryRun and simply omitted (left "N/A"/0)
    // on refusal rather than failing the overview.
    let tableCount = 0;
    let indexCount = 0;
    const countRows = await this.tryRun(CATALOG_COUNTS_SQL);
    if (countRows.length > 0) {
      tableCount = Number(countRows[0].TABLE_COUNT) || 0;
      indexCount = Number(countRows[0].INDEX_COUNT) || 0;
    }

    // Configured connection ceiling (maxappls). Left 0 when the config read is refused —
    // 0 is the DatabaseOverview convention for "not known" on this required field.
    let maxConnections = 0;
    const maxConnRows = await this.tryRun(MAX_CONNECTIONS_SQL);
    if (maxConnRows.length > 0) {
      const parsed = Number(maxConnRows[0].VALUE);
      if (Number.isFinite(parsed) && parsed > 0) maxConnections = parsed;
    }

    // Uptime from the database activation time, computed in the DB (see DB_UPTIME_SECONDS_SQL:
    // doing it here would misfire across timezones). Negative or nonsensical values are
    // rejected rather than shown.
    let uptime = "N/A";
    const uptimeRows = await this.tryRun(DB_UPTIME_SECONDS_SQL);
    if (uptimeRows.length > 0) {
      const seconds = Number(uptimeRows[0].UPTIME_SECONDS);
      if (Number.isFinite(seconds) && seconds >= 0) {
        uptime = formatDuration(seconds * 1000);
      }
    }

    // Database size as the sum of used tablespace bytes — the same STORAGE_SQL the Storage
    // panel reads, so no extra source. Both the formatted string and the numeric byte
    // figure are set: fleet-health and the Overview total consume `databaseSizeBytes`
    // (absence, not 0, means "unpublished"), while the overview card shows the string.
    // Omitted ("N/A", bytes absent) when the read is refused.
    let databaseSize = "N/A";
    let databaseSizeBytes: number | undefined;
    const tbspRows = await this.tryRun(STORAGE_SQL);
    if (tbspRows.length > 0) {
      const totalBytes = tbspRows.reduce((sum, r) => {
        const usedPages = Number(r.TBSP_USED_PAGES) || 0;
        const pageSize = Number(r.TBSP_PAGE_SIZE) || 0;
        return sum + usedPages * pageSize;
      }, 0);
      if (totalBytes > 0) {
        databaseSize = formatBytes(totalBytes);
        databaseSizeBytes = totalBytes;
      }
    }

    return {
      version,
      uptime,
      maxConnections,
      databaseSize,
      ...(databaseSizeBytes === undefined ? {} : { databaseSizeBytes }),
      tableCount,
      indexCount,
      ...(activeConnections === undefined ? {} : { activeConnections }),
    };
  }

  /**
   * Buffer-pool cache hit ratio as a percentage, or `undefined` when it cannot be read.
   *
   * `(logical - physical) / logical` over every buffer pool: the fraction of page reads
   * served from memory rather than disk. `undefined` (not 0) on a refused read or a pool
   * with no reads yet, because `DEFAULT_THRESHOLDS` scores this `direction: "below"` and a
   * fabricated 0 would paint a critical cache fault on a healthy, idle database.
   */
  private async readCacheHitRatio(): Promise<number | undefined> {
    const rows = await this.tryRun(BUFFERPOOL_SQL);
    if (rows.length === 0) return undefined;
    const logical = Number(rows[0].LOGICAL_READS);
    const physical = Number(rows[0].PHYSICAL_READS);
    if (!Number.isFinite(logical) || logical <= 0) return undefined;
    const ratio = ((logical - physical) / logical) * 100;
    if (!Number.isFinite(ratio)) return undefined;
    // Clamp: a pool can report physical > logical transiently, which would push this past
    // 100 or below 0 — neither is a real hit ratio.
    return Math.max(0, Math.min(100, Math.round(ratio * 10) / 10));
  }

  /**
   * Real performance metrics from the buffer pools and database counters, not a neutral
   * empty. The cache hit ratio is omitted (never zeroed) when the read is refused or the
   * pools are idle. Deadlocks is a measured cumulative count since activation — a real 0
   * is kept (it is a fact), and only a refused read omits it.
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();
    const cacheHitRatio = await this.readCacheHitRatio();
    const deadlockRows = await this.tryRun(DEADLOCKS_SQL);
    const deadlocks = deadlockRows.length > 0 ? Number(deadlockRows[0].DEADLOCKS) : undefined;
    return {
      ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
      ...(deadlocks !== undefined && Number.isFinite(deadlocks) ? { deadlocks } : {}),
    };
  }

  /**
   * The costliest statements in the package cache, by activity time. Db2 only records
   * per-statement execution times when the database's `mon_req_metrics`/`mon_act_metrics`
   * config is enabled; with metrics off, `NUM_EXEC_WITH_METRICS` is 0 and the query filters
   * those rows out, so the panel shows real timings when the server collects them and its
   * empty state — not a list of misleading 0.00 ms rows — when it does not. `TOTAL_ACT_TIME`
   * is milliseconds across the metrics-bearing executions; the average is derived per row.
   * Refused reads return `[]` (see `tryRun`).
   */
  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const rows = await this.tryRun(SLOW_QUERIES_SQL);
    return rows.map((r) => {
      const calls = Number(r.NUM_EXECUTIONS) || 0;
      const totalTime = Number(r.TOTAL_ACT_TIME) || 0;
      return {
        query: String(r.STMT_TEXT ?? "").trim(),
        calls,
        totalTime,
        avgTime: calls > 0 ? Math.round((totalTime / calls) * 10) / 10 : 0,
        rows: Number(r.ROWS_READ) || 0,
      };
    });
  }

  /**
   * Live connections from `MON_GET_CONNECTION`. Db2 has no single "current statement" or
   * per-connection state column on this surface the way PostgreSQL's `pg_stat_activity`
   * does, so `state` is reported as `"active"` (the row exists because the connection is
   * live) and `query` is left empty rather than invented. Refused reads return `[]`.
   */
  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const rows = await this.tryRun(SESSIONS_SQL);
    return rows.map((r) => ({
      pid: String(r.APPLICATION_HANDLE ?? ""),
      user: String(r.SYSTEM_AUTH_ID ?? "").trim(),
      database: this.config.database ?? "",
      applicationName: r.APPLICATION_NAME ? String(r.APPLICATION_NAME).trim() : undefined,
      clientAddr: r.CLIENT_IPADDR ? String(r.CLIENT_IPADDR).trim() : undefined,
      state: "active",
      query: "",
      duration: "N/A",
      durationMs: 0,
    }));
  }

  /**
   * Real per-table stats from the catalog, not neutral empties like the other monitoring
   * surfaces: SYSCAT.TABLES publishes a row count (CARD) and the timestamp of the RUNSTATS
   * that produced it (STATS_TIME), so this returns them rather than hiding data the engine
   * has. The currency caveat is real and preserved rather than smoothed over: CARD is only
   * as fresh as the last RUNSTATS, which can be years old, and a table that never had
   * RUNSTATS reports CARD = -1 with STATS_TIME = NULL. Such a table is mapped to rowCount 0
   * with NO `lastAnalyze`, so a reader sees "no stats" instead of a fabricated -1; a table
   * with stats carries `lastAnalyze` so the age of the number is visible. Size fields are
   * omitted (the required `totalSize`/`totalSizeBytes` carry the "N/A"/0 placeholder the
   * SQLite provider established) because Db2's only per-table size is a one-table-at-a-time
   * table function — see TABLE_STATS_SQL. Documented in docs/providers/db2.md.
   */
  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();
    const rows = await this.run(TABLE_STATS_SQL);
    return rows.map((r) => {
      const card = Number(r.CARD);
      const rowCount = Number.isFinite(card) && card >= 0 ? card : 0;
      const statsTime = r.STATS_TIME;
      const lastAnalyze = statsTime ? new Date(String(statsTime)) : undefined;
      return {
        schemaName: String(r.TABSCHEMA).trimEnd(),
        tableName: String(r.TABNAME).trimEnd(),
        rowCount,
        totalSize: "N/A",
        totalSizeBytes: 0,
        ...(lastAnalyze && !Number.isNaN(lastAnalyze.getTime()) ? { lastAnalyze } : {}),
      };
    });
  }

  /**
   * Per-index stats for the Indexes panel, scoped to CURRENT SCHEMA. Structural fields are
   * real (SYSCAT), scan counts are real where MON_GET_INDEX has them (0 otherwise), and size
   * is left as the honest "N/A" placeholder — see INDEX_STATS_SQL. Refused reads return `[]`.
   */
  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();
    const rows = await this.tryRun(INDEX_STATS_SQL);
    return rows.map((r) => {
      const uniqueRule = String(r.UNIQUERULE ?? "").trim();
      const cols = String(r.COLS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const indexType = String(r.INDEXTYPE ?? "").trim();
      return {
        schemaName: String(r.INDSCHEMA ?? "").trim() || "",
        tableName: String(r.TABNAME ?? "").trim(),
        indexName: String(r.INDNAME ?? "").trim(),
        ...(indexType ? { indexType } : {}),
        columns: cols,
        // Db2 UNIQUERULE: 'P' primary key, 'U' unique, 'D' duplicates allowed.
        isUnique: uniqueRule === "P" || uniqueRule === "U",
        isPrimary: uniqueRule === "P",
        indexSize: "N/A",
        scans: Number(r.SCANS) || 0,
      };
    });
  }

  /**
   * Tablespace sizing from `MON_GET_TABLESPACE`: used pages × page size is the bytes on
   * disk, and used/total is the fill percentage. This is Db2's real storage breakdown
   * (SYSCATSPACE, USERSPACE1, temp spaces, …). Refused reads return `[]` (see `tryRun`).
   */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();
    const rows = await this.tryRun(STORAGE_SQL);
    return rows.map((r) => {
      const usedPages = Number(r.TBSP_USED_PAGES) || 0;
      const totalPages = Number(r.TBSP_TOTAL_PAGES) || 0;
      const pageSize = Number(r.TBSP_PAGE_SIZE) || 0;
      const sizeBytes = usedPages * pageSize;
      return {
        name: String(r.TBSP_NAME ?? "").trim(),
        size: formatBytes(sizeBytes),
        sizeBytes,
        ...(totalPages > 0 ? { usagePercent: Math.round((usedPages / totalPages) * 1000) / 10 } : {}),
      };
    });
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
