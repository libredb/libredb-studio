/**
 * Oracle Database Provider
 * Full Oracle support with connection pooling (Thin mode - no Instant Client needed)
 */

import oracledb from "oracledb";
import { SQLBaseProvider } from "./sql-base";
import { oracleColumnTypes } from "./column-types";
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
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
  type PreparedQuery,
  type QueryPrepareOptions,
} from "../../types";
import { DatabaseConfigError, ConnectionError, QueryError, mapDatabaseError } from "../../errors";
import { formatBytes } from "../../utils/pool-manager";
import { analyzeQuery, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../utils/query-limiter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// SQL Statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution
// stays stable (repo pattern, see the SCHEMA_*_SQL consts in mssql.ts).

const SCHEMA_COLUMNS_SQL = `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT, COLUMN_ID
         FROM ALL_TAB_COLUMNS WHERE OWNER = :1
         ORDER BY TABLE_NAME, COLUMN_ID`;

const SCHEMA_PRIMARY_KEYS_SQL = `SELECT ac.TABLE_NAME, acc.COLUMN_NAME
         FROM ALL_CONSTRAINTS ac
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
         WHERE ac.OWNER = :1 AND ac.CONSTRAINT_TYPE = 'P'`;

const SCHEMA_FOREIGN_KEYS_SQL = `SELECT ac.TABLE_NAME,
                acc.COLUMN_NAME,
                rc.TABLE_NAME AS REF_TABLE,
                rcc.COLUMN_NAME AS REF_COLUMN
         FROM ALL_CONSTRAINTS ac
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
         JOIN ALL_CONSTRAINTS rc ON ac.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND ac.R_OWNER = rc.OWNER
         JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER
         WHERE ac.OWNER = :1 AND ac.CONSTRAINT_TYPE = 'R'`;

const SCHEMA_INDEXES_SQL = `SELECT ai.TABLE_NAME, ai.INDEX_NAME, ai.UNIQUENESS, aic.COLUMN_NAME, aic.COLUMN_POSITION
         FROM ALL_INDEXES ai
         JOIN ALL_IND_COLUMNS aic ON ai.INDEX_NAME = aic.INDEX_NAME AND ai.OWNER = aic.INDEX_OWNER
         WHERE ai.OWNER = :1
         ORDER BY ai.TABLE_NAME, ai.INDEX_NAME, aic.COLUMN_POSITION`;

// Shared by getHealth() and getPerformanceMetrics().
const CACHE_HIT_RATIO_SQL = `SELECT ROUND(
            (1 - (SUM(DECODE(NAME, 'physical reads', VALUE, 0)) /
                  NULLIF(SUM(DECODE(NAME, 'db block gets', VALUE, 0)) + SUM(DECODE(NAME, 'consistent gets', VALUE, 0)), 0)
            )) * 100, 2) AS HIT_RATIO
           FROM V$SYSSTAT
           WHERE NAME IN ('db block gets', 'consistent gets', 'physical reads')`;

const HEALTH_SLOW_QUERIES_SQL = `SELECT * FROM (
            SELECT SUBSTR(SQL_TEXT, 1, 100) AS QUERY,
                   EXECUTIONS AS CALLS,
                   ROUND(ELAPSED_TIME / NULLIF(EXECUTIONS, 0) / 1000, 2) || 'ms' AS AVGTIME
            FROM V$SQL
            WHERE EXECUTIONS > 0
            ORDER BY ELAPSED_TIME DESC
          ) WHERE ROWNUM <= 5`;

const HEALTH_ACTIVE_SESSIONS_SQL = `SELECT * FROM (
            SELECT SID, USERNAME, STATUS, SUBSTR(NVL(SQL_ID, ''), 1, 100) AS QUERY,
                   SCHEMANAME AS "DATABASE",
                   NVL(TO_CHAR(LOGON_TIME, 'HH24:MI:SS'), 'N/A') AS DURATION
            FROM V$SESSION
            WHERE TYPE = 'USER' AND STATUS = 'ACTIVE'
            ORDER BY LOGON_TIME DESC
          ) WHERE ROWNUM <= 10`;

const OVERVIEW_OBJECT_COUNTS_SQL = `SELECT
            (SELECT COUNT(*) FROM USER_TABLES) AS TABLE_COUNT,
            (SELECT COUNT(*) FROM USER_INDEXES) AS INDEX_COUNT
           FROM DUAL`;

// Interpolated before " WHERE ROWNUM <= <limit>" in getSlowQueries().
const SLOW_QUERIES_BODY_SQL = `SELECT * FROM (
          SELECT SQL_ID AS QUERY_ID,
                 SUBSTR(SQL_TEXT, 1, 500) AS QUERY,
                 EXECUTIONS AS CALLS,
                 ROUND(ELAPSED_TIME / 1000, 2) AS TOTAL_TIME,
                 ROUND(ELAPSED_TIME / NULLIF(EXECUTIONS, 0) / 1000, 2) AS AVG_TIME,
                 ROWS_PROCESSED AS ROW_CNT,
                 BUFFER_GETS AS BUF_GETS,
                 DISK_READS
          FROM V$SQL
          WHERE EXECUTIONS > 0
          ORDER BY ELAPSED_TIME DESC
        )`;

// Interpolated before " WHERE ROWNUM <= <limit>" in getActiveSessions().
const ACTIVE_SESSIONS_BODY_SQL = `SELECT * FROM (
          SELECT s.SID, s.SERIAL#, s.USERNAME, s.SCHEMANAME, s.PROGRAM,
                 s.MACHINE, s.STATUS, s.SQL_ID,
                 SUBSTR(sq.SQL_TEXT, 1, 500) AS QUERY,
                 s.LOGON_TIME,
                 ROUND((SYSDATE - s.LOGON_TIME) * 86400) AS DURATION_SECS,
                 s.WAIT_CLASS, s.EVENT
          FROM V$SESSION s
          LEFT JOIN V$SQL sq ON s.SQL_ID = sq.SQL_ID AND s.SQL_CHILD_NUMBER = sq.CHILD_NUMBER
          WHERE s.TYPE = 'USER'
          ORDER BY CASE s.STATUS WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.LOGON_TIME DESC
        )`;

const TABLE_STATS_SQL = `SELECT t.TABLE_NAME,
                NVL(t.NUM_ROWS, 0) AS ROW_COUNT,
                NVL(s.BYTES, 0) AS TABLE_SIZE_BYTES,
                NVL(idx_size.BYTES, 0) AS INDEX_SIZE_BYTES,
                t.LAST_ANALYZED
         FROM ALL_TABLES t
         LEFT JOIN USER_SEGMENTS s ON s.SEGMENT_NAME = t.TABLE_NAME AND s.SEGMENT_TYPE = 'TABLE'
         LEFT JOIN (
           SELECT TABLE_NAME, SUM(BYTES) AS BYTES
           FROM USER_SEGMENTS
           WHERE SEGMENT_TYPE = 'INDEX'
           GROUP BY TABLE_NAME
         ) idx_size ON idx_size.TABLE_NAME = t.TABLE_NAME
         WHERE t.OWNER = :1
         ORDER BY NVL(s.BYTES, 0) DESC`;

const INDEX_STATS_SQL = `SELECT ai.TABLE_NAME, ai.INDEX_NAME, ai.INDEX_TYPE, ai.UNIQUENESS,
                NVL(us.BYTES, 0) AS INDEX_SIZE_BYTES,
                ai.LEAF_BLOCKS, ai.DISTINCT_KEYS
         FROM ALL_INDEXES ai
         LEFT JOIN USER_SEGMENTS us ON us.SEGMENT_NAME = ai.INDEX_NAME AND us.SEGMENT_TYPE = 'INDEX'
         WHERE ai.OWNER = :1
         ORDER BY NVL(us.BYTES, 0) DESC`;

const INDEX_COLUMNS_SQL = `SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION
         FROM ALL_IND_COLUMNS WHERE INDEX_OWNER = :1
         ORDER BY INDEX_NAME, COLUMN_POSITION`;

const STORAGE_DBA_FILES_SQL = `SELECT TABLESPACE_NAME AS NAME,
                  SUM(BYTES) AS SIZE_BYTES
           FROM DBA_DATA_FILES
           GROUP BY TABLESPACE_NAME
           ORDER BY SUM(BYTES) DESC`;

const STORAGE_USER_SEGMENTS_SQL = `SELECT TABLESPACE_NAME AS NAME,
                    SUM(BYTES) AS SIZE_BYTES
             FROM USER_SEGMENTS
             GROUP BY TABLESPACE_NAME
             ORDER BY SUM(BYTES) DESC`;

/**
 * The indexes ONE table owns, for the `optimize` operation.
 *
 * `INDEX_TYPE = 'NORMAL'` is the filter the whole-schema form has always used, and it
 * is the one `ALTER INDEX ... REBUILD` can take: it excludes LOB and domain indexes,
 * which answer ORA-22864 / ORA-29868 to a rebuild, while keeping the B-tree indexes
 * that back UNIQUE and PRIMARY KEY constraints, which rebuild normally.
 */
const TABLE_INDEXES_SQL = `SELECT INDEX_NAME
           FROM USER_INDEXES
           WHERE TABLE_NAME = :tableName AND INDEX_TYPE = 'NORMAL'`;

const SCHEMA_NORMAL_INDEXES_SQL = `SELECT INDEX_NAME FROM USER_INDEXES WHERE INDEX_TYPE = 'NORMAL'`;

/**
 * Whether the schema owns a table by exactly this name - asked only to tell the two
 * causes of an empty `TABLE_INDEXES_SQL` answer apart.
 *
 * `USER_TABLES` is the right catalog and not a narrower one: measured on
 * ldb-oracle-r5 on 2026-08-25, a MATERIALIZED VIEW's container appears here under the
 * view's own name (and its indexes appear in `USER_INDEXES` keyed to that name), so
 * everything `USER_INDEXES` can be keyed to is visible. A plain VIEW is NOT here, and
 * that is the honest answer for it: a view owns no index, so there is nothing for
 * "Rebuild Indexes" to have done.
 */
const TABLE_IS_KNOWN_SQL = `SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME = :tableName`;

// ============================================================================
// Value shapes
// ============================================================================

/**
 * Fetch a LOB as its value instead of as a stream.
 *
 * By default oracledb answers a CLOB, an NCLOB and a BLOB with a `Lob` object -
 * a readable stream - and nothing downstream of the provider can read one.
 * Measured on 2026-08-24 against Oracle AI Database 26ai Free (oracledb 6.10.0, Thin) through
 * `createDatabaseProvider({type:"oracle"})`: all four LOB columns of a probe table
 * arrived as `Lob`, and serialising the row threw rather than producing a value -
 * `TypeError: Converting circular structure to JSON ... starting at object with
 * constructor 'NVPair'` under Node 24.14.0, `TypeError: JSON.stringify cannot
 * serialize cyclic structures` under Bun 1.3.14. `POST /api/db/query` builds its
 * answer with `NextResponse.json`, so a SELECT touching a LOB failed whole: the
 * grid, the CSV, the SQL export, the row detail sheet and the agent's summary all
 * had no row to read, not merely an unreadable cell.
 *
 * A BLOB becomes a `Buffer`, which is the shape the product's shared binary
 * contract already accepts (`asBytes` in src/lib/export/binary.ts takes both a
 * live `Uint8Array` and the `{type:"Buffer",data:[...]}` JSON it serialises to), so
 * a BLOB cell renders, previews and exports exactly like a Postgres `bytea` and a
 * MySQL `BLOB` with no further work.
 *
 * This is a per-call option rather than the process-wide `oracledb.fetchAsString` /
 * `fetchAsBuffer` globals on purpose: those would also change every schema and
 * monitoring read, and they outlive this provider - the embeddable library surface
 * runs inside a host application that may have its own oracledb consumers.
 *
 * The value is fetched whole, with no length cap, which is the same contract every
 * other provider here already has for a large value: Postgres `text`/`bytea` and
 * MySQL `BLOB` arrive whole too, and `DEFAULT_QUERY_LIMIT` bounds the row count,
 * not the cell. A cap was considered and rejected because a truncated CLOB looks
 * like a complete one in the grid and would be written into the target by the SQL
 * export - a silent corruption in place of a readable value. The cost is linear and
 * measured: a 16,384,000-character CLOB fetched as a string took 66 ms and
 * serialised to 16.4 MB of JSON in 18 ms. The ceiling is the runtime's own and it
 * fails loudly: a string longer than V8's 536,870,888-character maximum throws
 * `RangeError: Invalid string length`, which reaches the user as a failed query
 * rather than as a value that has quietly lost its tail.
 */
const lobFetchTypeHandler: oracledb.FetchTypeHandler = (metaData) => {
  if (metaData.dbType === oracledb.DB_TYPE_CLOB || metaData.dbType === oracledb.DB_TYPE_NCLOB) {
    return { type: oracledb.STRING };
  }
  if (metaData.dbType === oracledb.DB_TYPE_BLOB) {
    return { type: oracledb.BUFFER };
  }
  // Every other column keeps the driver's default: RAW already arrives as a
  // Buffer and VARCHAR2 as a string, and restating them here would put this
  // module in charge of types it has no reason to touch.
  return undefined;
};

/** Two digits minimum, which is the width Oracle's own default precision prints. */
const pad2 = (value: number): string => String(Math.abs(value)).padStart(2, "0");

/** One leading sign for the whole interval: every field of a negative one is negative. */
const intervalSign = (fields: readonly number[]): string => (fields.some((field) => field < 0) ? "-" : "+");

/**
 * `INTERVAL YEAR TO MONTH` as the literal Oracle accepts back: `+03-07`.
 *
 * Years are NOT capped at two digits - `INTERVAL '123456789-11' YEAR(9) TO MONTH`
 * round-trips as `+123456789-11` - so the padding is a minimum, not a width.
 */
const formatIntervalYM = (value: oracledb.IntervalYM): string =>
  `${intervalSign([value.years, value.months])}${pad2(value.years)}-${pad2(value.months)}`;

/**
 * `INTERVAL DAY TO SECOND` as the literal Oracle accepts back: `+05 06:07:08.9`.
 *
 * `fseconds` is NANOseconds, so the fraction is nine digits with the trailing zeros
 * trimmed - lossless for a `SECOND(9)` column, and no fraction at all for a
 * whole-second interval (`+09 08:07:06`).
 */
const formatIntervalDS = (value: oracledb.IntervalDS): string => {
  const sign = intervalSign([value.days, value.hours, value.minutes, value.seconds, value.fseconds]);
  const fraction = String(Math.abs(value.fseconds)).padStart(9, "0").replace(/0+$/, "");
  const clock = `${pad2(value.hours)}:${pad2(value.minutes)}:${pad2(value.seconds)}`;
  return `${sign}${pad2(value.days)} ${clock}${fraction === "" ? "" : `.${fraction}`}`;
};

/** How one column's interval values are spelled, paired with the column's name. */
type IntervalColumn = readonly [name: string, format: (value: unknown) => string];

/**
 * Oracle's two interval types, normalised to their own literals at the driver
 * boundary - the decision `docs/providers/cassandra.md` 3.8 already took for a CQL
 * `duration`, for the same reason and with the same shape.
 *
 * Measured 2026-08-24 against Oracle AI Database 26ai Free (oracledb 6.10.0, Thin): the driver
 * answers `INTERVAL '3-7' YEAR TO MONTH` with `{"months":7,"years":3}` and
 * `INTERVAL '5 6:7:8.9' DAY TO SECOND` with
 * `{"fseconds":900000000,"seconds":8,"minutes":7,"hours":6,"days":5}`. Both are
 * lossless and both are unreadable: nothing in the product reconstructs either
 * object, the grid shows a JSON blob where a duration belongs, and the SQL export
 * writes that blob into an INTERVAL column - which Oracle refuses
 * (`ORA-01867: the interval is invalid`), so the row is lost rather than wrong.
 *
 * A fetch type handler cannot do this instead: asking the driver for either type as a
 * string is refused outright - `NJS-119: conversion from type DB_TYPE_INTERVAL_YM to
 * type DB_TYPE_VARCHAR is not supported`, and `oracledb.fetchAsString` answers
 * `NJS-021: invalid type for conversion specified` for both. The literal has to be
 * composed here.
 *
 * Driven by `metaData[].dbType` rather than by the value's class: the columns are
 * known once per result, so a query with no interval column does no per-cell work at
 * all and keeps the driver's own rows array.
 */
const intervalColumns = (metaData: readonly oracledb.Metadata[] | undefined): IntervalColumn[] => {
  const columns: IntervalColumn[] = [];
  for (const column of metaData ?? []) {
    if (column.dbType === oracledb.DB_TYPE_INTERVAL_YM) {
      columns.push([column.name, (value) => formatIntervalYM(value as oracledb.IntervalYM)]);
    }
    if (column.dbType === oracledb.DB_TYPE_INTERVAL_DS) {
      columns.push([column.name, (value) => formatIntervalDS(value as oracledb.IntervalDS)]);
    }
  }
  return columns;
};

const normalizeIntervals = (
  rows: Record<string, unknown>[],
  metaData: readonly oracledb.Metadata[] | undefined,
): Record<string, unknown>[] => {
  const columns = intervalColumns(metaData);
  if (columns.length === 0) return rows;

  return rows.map((row) => {
    const normalized = { ...row };
    for (const [name, format] of columns) {
      const value = normalized[name];
      // A NULL interval stays null: the column is absent from the row, not zero.
      if (value !== null && value !== undefined) normalized[name] = format(value);
    }
    return normalized;
  });
};

// ============================================================================
// Oracle Provider
// ============================================================================

// node-oracledb's Thin/Thick client mode is a process-wide singleton:
// oracledb.initOracleClient() throws if called more than once, or after any
// connection/pool already exists. Track it at module scope so it runs at most
// once across every OracleProvider instance in this process, not once per
// constructor call.
let thickClientInitialized = false;

export class OracleProvider extends SQLBaseProvider {
  private pool: oracledb.Pool | null = null;

  // Transaction support: dedicated connection held outside pool
  private txConn: oracledb.Connection | null = null;
  private txActive = false;

  // Track running connections for cancellation
  private runningConns = new Map<string, oracledb.Connection>();

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    // Thin mode (pure JS, no Oracle Instant Client) is the unconditional default.
    // Thick mode is an explicit opt-in for servers older than Oracle Database 12.1,
    // which Thin mode cannot connect to (node-oracledb NJS-138).
    const libDir = process.env.ORACLE_CLIENT_LIB_DIR;
    if (libDir && !thickClientInitialized) {
      try {
        oracledb.initOracleClient({ libDir });
      } catch (error) {
        // A bad ORACLE_CLIENT_LIB_DIR (e.g. no Instant Client at that path) makes
        // node-oracledb throw a raw driver error (DPI-1047). Surface it as a
        // non-retryable configuration error that names the offending env var, so it
        // is actionable rather than looking like a transient failure.
        throw new DatabaseConfigError(
          `Failed to load the Oracle Instant Client from ORACLE_CLIENT_LIB_DIR=${libDir}: ${String(error)}. ` +
            "Verify the path points at an installed Oracle Instant Client 'lib' directory " +
            "(Instant Client 19c is required to reach Oracle 11.2 servers).",
          "oracle",
        );
      }
      thickClientInitialized = true;
    }
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    oracledb.autoCommit = true;
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 1521,
      // Disabled until an Oracle dialect wrapper exists (#126): a real plan flow needs
      // EXPLAIN PLAN FOR + DBMS_XPLAN, which the single-statement explain path cannot express.
      supportsExplain: false,
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // Oracle is always in a transaction; the held connection commits or rolls back.
      supportsTransactions: true,
      maintenanceOperations: ["analyze", "optimize", "kill"],
      // `optimize` now takes a TABLE and rebuilds that table's own indexes, which is
      // what SQL Server's identically worded control has always done. It used to take
      // an INDEX name, so the per-table button that #427 wired up sent a table and
      // every click answered ORA-01418 (reproduced against Oracle AI Database 26ai Free on
      // 2026-08-25, then fixed and re-run - see runMaintenance below).
      maintenanceOperationSpecs: {
        analyze: { label: "Gather Statistics", perEntity: true, global: true },
        optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
        kill: { label: "Kill Session", perEntity: false, global: false },
      },
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Gather Statistics",
      vacuumAction: "Rebuild Indexes",
      // Oracle has no VACUUM; this slot has always said "Rebuild Indexes", which is
      // `optimize`. Saying so is what lets the two surfaces send that operation
      // instead of a `vacuum` this provider rejects (#U9).
      vacuumActionOperation: "optimize",
      analyzeGlobalLabel: "Gather Stats",
      analyzeGlobalTitle: "Gather Statistics",
      analyzeGlobalDesc: "Collects optimizer statistics for all tables to improve query performance.",
      vacuumGlobalLabel: "Rebuild Indexes",
      vacuumGlobalTitle: "Rebuild All Indexes",
      vacuumGlobalDesc: "Rebuilds all indexes to reclaim space and improve performance.",
      // `getSlowQueries()` reads V$SQL, and a user without SELECT on the V$ views gets
      // `[]` from the swallowed failure. The panel used to name a PostgreSQL extension
      // there (#U12); the grant is the thing an Oracle DBA can act on.
      slowQueriesEmptyState: "Query stats come from V$SQL, which this user needs SELECT on to read.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for Oracle", "oracle");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  private getConnectString(): string {
    if (this.config.connectionString) {
      return this.config.connectionString;
    }

    const host = this.config.host || "localhost";
    const port = this.config.port || 1521;
    const serviceName = this.config.serviceName || this.config.database || "ORCL";

    // TCPS is how the Thin driver is told to negotiate TLS at all: it calls
    // `tls.connect` only when the resolved address protocol is TCPS (audited in the
    // installed package, `oracledb/lib/thin/sqlnet/ntTcp.js`). A pasted connect string
    // returns above unchanged, so its own protocol — or its full TNS descriptor —
    // decides for it; rewriting it would drop what only the user knows.
    const scheme = this.config.ssl && this.config.ssl.mode !== "disable" ? "tcps://" : "";

    return `${scheme}${host}:${port}/${serviceName}`;
  }

  /**
   * Oracle has no `rejectUnauthorized` equivalent: Thin mode calls `tls.connect` with
   * `rejectUnauthorized: true` unconditionally, so the chain is checked in every TCPS
   * connection and a self-signed server is reachable only by supplying its CA here.
   * What IS optional is the DN/hostname check, which `verify-full` asks for and
   * `require`/`verify-ca` do not — so those two map to `sslServerDNMatch: false`
   * rather than to a weaker chain check, which no knob offers.
   *
   * `walletContent` is the driver's single-PEM channel: it hands the same string to
   * `tls.createSecureContext()` as `cert`, `key` AND `ca`, so the form's three fields
   * are concatenated into one blob instead of mapped to three options.
   *
   * NOT exercised against a TLS listener (the probe instance speaks TCP), so this is
   * the audited shape of the driver's own attributes and no claim about a verified path.
   */
  private buildTLSAttributes(): Record<string, unknown> {
    const ssl = this.config.ssl;
    if (!ssl || ssl.mode === "disable") return {};

    const wallet = [ssl.caCert, ssl.clientCert, ssl.clientKey].filter(Boolean).join("\n");

    return {
      // `verify-system` asks for the same server-name match as `verify-full`; what it does
      // NOT ask for is a wallet, so with no PEM pasted `tls.connect` falls back to Node's
      // bundled roots for the chain - which is exactly what the mode means (D26).
      sslServerDNMatch: ssl.mode === "verify-full" || ssl.mode === "verify-system",
      ...(wallet ? { walletContent: wallet } : {}),
    };
  }

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      // No pool `error` listener here, unlike the PostgreSQL and SQL Server providers
      // (#298): oracledb's pool has no pool-level `error` event to listen for. Audited in
      // the installed package — `oracledb/lib/pool.js` extends EventEmitter but emits only
      // the internal `_afterPoolClose` and `_allCheckedIn`, and nothing under `oracledb/lib`
      // emits `error` at all. Connection failures surface through the awaiting call.
      this.pool = await oracledb.createPool({
        user: this.config.user,
        password: this.config.password,
        connectString: this.getConnectString(),
        poolMin: this.poolConfig.min,
        poolMax: this.poolConfig.max,
        poolTimeout: Math.floor(this.poolConfig.idleTimeout / 1000),
        ...this.buildTLSAttributes(),
      });

      // Test the connection
      const conn = await this.pool.getConnection();
      await conn.close();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      // NJS-138 (server predates Oracle 12.1, incompatible with Thin mode) is a permanent
      // configuration problem, not a transient connection failure — map it through
      // mapDatabaseError() so it surfaces as a non-retryable DatabaseConfigError instead of
      // the generic ConnectionError every other connect() failure falls back to below.
      const mapped = mapDatabaseError(error, "oracle");
      if (mapped instanceof DatabaseConfigError) {
        throw mapped;
      }
      throw new ConnectionError(
        `Failed to connect to Oracle: ${error instanceof Error ? error.message : error}`,
        "oracle",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close(0);
      } catch {
        // Force close on error
      }
      this.pool = null;
      this.setConnected(false);
    }
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  /**
   * Build the result envelope from one oracledb `Result`.
   *
   * oracledb answers a SELECT with a `rows` array and a non-SELECT with no `rows` at
   * all plus its own `rowsAffected` - so the row count of a DML statement is only
   * readable there. Measured 2026-08-24 against Oracle AI Database 26ai Free through
   * `createDatabaseProvider({type:"oracle"})`: `INSERT` of one row -> rowsAffected 1,
   * `INSERT ... SELECT` of three -> 3, `UPDATE` touching four -> 4, a `DELETE` that
   * matched nothing -> 0, `CREATE TABLE` and `TRUNCATE` -> 0, a PL/SQL block ->
   * undefined. Building the count from `rows.length` instead reported 0 for every one
   * of them while the statement had in fact been applied, which is the answer
   * that makes a user retry and double-apply it.
   *
   * Same shape as `buildQueryResult` in mysql.ts (#469): the non-rows branch answers
   * with an empty grid and the engine's own count, and states no column types because
   * there is no metadata to state them from.
   */
  private buildQueryResult(result: oracledb.Result, executionTime: number): QueryResult {
    if (!result.rows) {
      return {
        rows: [],
        fields: [],
        rowCount: result.rowsAffected ?? 0,
        executionTime,
      };
    }

    const rows = normalizeIntervals(result.rows as Record<string, unknown>[], result.metaData);

    return {
      rows,
      fields: result.metaData?.map((m) => m.name) ?? [],
      rowCount: rows.length,
      executionTime,
      ...oracleColumnTypes(result.metaData),
    };
  }

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        let conn: oracledb.Connection | undefined;
        try {
          conn = await this.pool!.getConnection();

          if (queryId) {
            this.runningConns.set(queryId, conn);
          }

          const bindParams = params || [];
          const res = await conn.execute(sql, bindParams, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: true,
            fetchTypeHandler: lobFetchTypeHandler,
          });

          return res;
        } catch (error) {
          throw mapDatabaseError(error, "oracle", sql);
        } finally {
          if (queryId) this.runningConns.delete(queryId);
          if (conn) {
            try {
              await conn.close();
            } catch {
              /* ignore */
            }
          }
        }
      });

      return this.buildQueryResult(result, executionTime);
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const conn = this.runningConns.get(queryId);
    if (!conn) return false;

    try {
      await conn.break();
      return true;
    } catch (error) {
      console.error("[Oracle] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Query Preparation (Oracle FETCH FIRST instead of LIMIT)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query, this.type);

    if (queryInfo.type === "SELECT" && !queryInfo.hasLimit) {
      // Both branches append at the tail, so both used to have their clause
      // swallowed by a trailing line comment while this method still reported
      // `wasLimited: true` - the statement reached Oracle unbounded and the UI
      // said it was capped (#280). The clause goes between the statement and its
      // trailing trivia instead, which also keeps the `;` out of the comment.
      // A statement whose end may not be cut has nowhere honest to take the
      // clause, so it is returned untouched rather than bounded on a guess. On
      // Oracle that is a literal Oracle and MySQL would close in different
      // places. `#` in an identifier (`ID#`) used to reach the same refusal and
      // no longer does: the end is read under Oracle's own grammar (#292), where
      // `#` is an identifier character and opens no comment.
      const source = query.trim();
      const { end, rewritable } = readStatementEnd(source, resolveSqlGrammar(this.type));
      if (!rewritable) {
        return { query, wasLimited: false, limit: effectiveLimit, offset };
      }

      const statement = source.slice(0, end);
      const trailing = source.slice(end);

      const clause =
        offset > 0
          ? `OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`
          : `FETCH FIRST ${effectiveLimit} ROWS ONLY`;

      return {
        query: `${statement} ${clause}${trailing}`,
        wasLimited: true,
        limit: effectiveLimit,
        offset,
      };
    }

    return { query, wasLimited: false, limit: effectiveLimit, offset };
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  public async beginTransaction(): Promise<void> {
    this.ensureConnected();
    if (this.txActive) throw new QueryError("Transaction already active", "oracle");
    this.txConn = await this.pool!.getConnection();
    // Oracle auto-starts a transaction; we just hold the connection
    this.txActive = true;
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "oracle");
    try {
      await this.txConn.commit();
    } finally {
      await this.txConn.close();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "oracle");
    try {
      await this.txConn.rollback();
    } finally {
      await this.txConn.close();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "oracle");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await this.txConn!.execute(sql, params || [], {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: false,
            fetchTypeHandler: lobFetchTypeHandler,
          });
        } catch (error) {
          throw mapDatabaseError(error, "oracle", sql);
        }
      });

      return this.buildQueryResult(result, executionTime);
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || "";

      // Get tables
      const tablesRes = await conn.execute(
        `SELECT TABLE_NAME, NUM_ROWS FROM ALL_TABLES WHERE OWNER = :1 ORDER BY TABLE_NAME`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      const tables = (tablesRes.rows || []) as Record<string, unknown>[];

      // Get columns
      const colsRes = await conn.execute(SCHEMA_COLUMNS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const allCols = (colsRes.rows || []) as Record<string, unknown>[];

      // Get primary keys
      const pkRes = await conn.execute(SCHEMA_PRIMARY_KEYS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const pkRows = (pkRes.rows || []) as Record<string, unknown>[];
      const pkMap = new Map<string, Set<string>>();
      for (const row of pkRows) {
        const tbl = String(row.TABLE_NAME || "");
        const col = String(row.COLUMN_NAME || "");
        if (!pkMap.has(tbl)) pkMap.set(tbl, new Set());
        pkMap.get(tbl)!.add(col);
      }

      // Get foreign keys
      const fkRes = await conn.execute(SCHEMA_FOREIGN_KEYS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const fkRows = (fkRes.rows || []) as Record<string, unknown>[];

      // Get indexes
      const idxRes = await conn.execute(SCHEMA_INDEXES_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const idxRows = (idxRes.rows || []) as Record<string, unknown>[];

      // Group columns, indexes, foreign keys by table
      const colsByTable = new Map<string, Record<string, unknown>[]>();
      for (const c of allCols) {
        const tbl = String(c.TABLE_NAME || "");
        if (!colsByTable.has(tbl)) colsByTable.set(tbl, []);
        colsByTable.get(tbl)!.push(c);
      }

      const fksByTable = new Map<string, Record<string, unknown>[]>();
      for (const fk of fkRows) {
        const tbl = String(fk.TABLE_NAME || "");
        if (!fksByTable.has(tbl)) fksByTable.set(tbl, []);
        fksByTable.get(tbl)!.push(fk);
      }

      const idxByTable = new Map<string, Map<string, { unique: boolean; columns: string[] }>>();
      for (const idx of idxRows) {
        const tbl = String(idx.TABLE_NAME || "");
        const idxName = String(idx.INDEX_NAME || "");
        if (!idxByTable.has(tbl)) idxByTable.set(tbl, new Map());
        const tableIdxs = idxByTable.get(tbl)!;
        if (!tableIdxs.has(idxName)) {
          tableIdxs.set(idxName, {
            unique: String(idx.UNIQUENESS || "") === "UNIQUE",
            columns: [],
          });
        }
        tableIdxs.get(idxName)!.columns.push(String(idx.COLUMN_NAME || ""));
      }

      return tables.map((t) => {
        const tableName = String(t.TABLE_NAME || "");
        const pks = pkMap.get(tableName) || new Set();

        const columns = (colsByTable.get(tableName) || []).map((c) => ({
          name: String(c.COLUMN_NAME || ""),
          type: String(c.DATA_TYPE || ""),
          nullable: String(c.NULLABLE || "") === "Y",
          isPrimary: pks.has(String(c.COLUMN_NAME || "")),
          defaultValue: c.DATA_DEFAULT ? String(c.DATA_DEFAULT).trim() : undefined,
        }));

        const foreignKeys = (fksByTable.get(tableName) || []).map((fk) => ({
          columnName: String(fk.COLUMN_NAME || ""),
          referencedTable: String(fk.REF_TABLE || ""),
          referencedColumn: String(fk.REF_COLUMN || ""),
        }));

        const tableIdxs = idxByTable.get(tableName) || new Map();
        const indexes = Array.from(tableIdxs.entries()).map(([name, info]) => ({
          name,
          columns: info.columns,
          unique: info.unique,
        }));

        return {
          name: tableName,
          rowCount: Number(t.NUM_ROWS || 0),
          columns,
          indexes,
          foreignKeys,
        };
      });
    } finally {
      if (conn) await conn.close();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      // Left UNDEFINED, and spread conditionally into the return below.
      // `HealthInfo.activeConnections` is optional precisely so a user who cannot read
      // V$SESSION omits the figure instead of sending a fabricated 0, and this is the
      // reading the agent forwards to the model (`src/lib/agent/tools.ts` projects it
      // with `?? null`), so an initial 0 made a refused view indistinguishable from an
      // idle instance. V$SESSION needs the same `V_$` grant as everything else here,
      // and that refusal was measured 2026-08-23 on Oracle AI Database 26ai Free
      // against a user granted only CREATE SESSION: `ORA-00942: table or view
      // "SYS"."V_$SYSSTAT" does not exist`. V_$SESSION answers ORA-00942 in the same
      // shape when the grant is missing.
      let activeConnections: number | undefined;
      let databaseSize = "N/A";
      let cacheHitRatio: string = CACHE_HIT_RATIO_UNAVAILABLE;
      const slowQueries: SlowQuery[] = [];
      const activeSessions: ActiveSession[] = [];

      // Active connections
      try {
        const connRes = await conn.execute(`SELECT COUNT(*) AS CNT FROM V$SESSION WHERE STATUS = 'ACTIVE'`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const rows = (connRes.rows || []) as Record<string, unknown>[];
        // measuredNumber, not `Number(... || 0)`: an instance with no ACTIVE session
        // answers 0 and that 0 is a reading, so the falsy test would have thrown away
        // the very figure it was meant to publish. Only an unanswered COUNT stays absent.
        activeConnections = measuredNumber(rows[0]?.CNT);
      } catch {
        /* V$SESSION requires privileges; the figure stays absent, never 0. */
      }

      // Database size
      try {
        const sizeRes = await conn.execute(
          `SELECT ROUND(SUM(BYTES) / 1024 / 1024, 2) AS SIZE_MB FROM USER_SEGMENTS`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        const sizeRows = (sizeRes.rows || []) as Record<string, unknown>[];
        const mb = Number(sizeRows[0]?.SIZE_MB || 0);
        databaseSize = mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
      } catch {
        /* ignore */
      }

      // Cache hit ratio. `|| 0` used to publish "0%" for a reading Oracle never
      // took, and the Overview card rates 0 as "Needs tuning" - so a user who
      // simply cannot read V$SYSSTAT saw a cache fault. The two ways the reading
      // goes absent, both measured 2026-08-23 on Oracle AI Database 26ai Free: a user granted
      // only CREATE SESSION gets `ORA-00942: table or view "SYS"."V_$SYSSTAT" does
      // not exist` (the catch below), and a zero counter denominator gives one row
      // of `<NULL>` through NULLIF (measuredNumber).
      try {
        const cacheRes = await conn.execute(CACHE_HIT_RATIO_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const cacheRows = (cacheRes.rows || []) as Record<string, unknown>[];
        const ratio = measuredNumber(cacheRows[0]?.HIT_RATIO);
        if (ratio !== undefined) cacheHitRatio = `${formatCacheHitRatio(ratio)}%`;
      } catch {
        /* V$SYSSTAT requires privileges; the initial "N/A" stands. */
      }

      // Slow queries
      try {
        const slowRes = await conn.execute(HEALTH_SLOW_QUERIES_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        for (const row of (slowRes.rows || []) as Record<string, unknown>[]) {
          slowQueries.push({
            query: String(row.QUERY || ""),
            calls: Number(row.CALLS || 0),
            avgTime: String(row.AVGTIME || "N/A"),
          });
        }
      } catch {
        /* V$SQL requires privileges */
      }

      // Active sessions
      try {
        const sessRes = await conn.execute(HEALTH_ACTIVE_SESSIONS_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        for (const row of (sessRes.rows || []) as Record<string, unknown>[]) {
          activeSessions.push({
            pid: String(row.SID || ""),
            user: String(row.USERNAME || "unknown"),
            database: String(row.DATABASE || ""),
            state: String(row.STATUS || "unknown"),
            query: String(row.QUERY || ""),
            duration: String(row.DURATION || "N/A"),
          });
        }
      } catch {
        /* ignore */
      }

      return {
        ...(activeConnections === undefined ? {} : { activeConnections }),
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } finally {
      if (conn) await conn.close();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      let conn: oracledb.Connection | undefined;
      try {
        conn = await this.pool!.getConnection();
        let sql = "";

        switch (type) {
          case "analyze":
            if (target) {
              sql = `BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, '${target.replace(/'/g, "''")}'); END;`;
            } else {
              sql = `BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(USER); END;`;
            }
            break;
          case "optimize":
            return await this.rebuildIndexes(conn, target);
          case "kill":
            if (!target) {
              throw new QueryError("Target SID,SERIAL# is required for kill operation", "oracle");
            }
            sql = `ALTER SYSTEM KILL SESSION '${target.replace(/'/g, "''")}'`;
            break;
        }

        // Unsupported types fall through the switch with sql left empty. A
        // `default:` label is deliberately avoided here: bun's coverage emits
        // a 0-hit line record for `default:` that no runtime execution ever
        // credits, which permanently poisons the merged lcov report.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type: ${type}`, "oracle");
        }

        await conn.execute(sql);
        return { success: true, message: `${type.toUpperCase()} completed successfully` };
      } finally {
        if (conn) await conn.close();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  /**
   * `optimize`: rebuild the indexes ONE table owns, or every normal index in the
   * schema when the caller named nothing.
   *
   * The target is a TABLE NAME, because a table name is the only thing the two
   * maintenance surfaces have to send - both take it from the object browser's rows.
   * This used to build `ALTER INDEX "<target>" REBUILD` straight from that argument,
   * so every per-table click answered *ORA-01418: specified index does not exist*
   * (reproduced against Oracle AI Database 26ai Free on 2026-08-25). SQL Server's identically
   * worded control is `ALTER INDEX ALL ON [<t>] REBUILD`, and this is that shape:
   * Oracle has no `ALTER INDEX ALL`, so the index names come from `USER_INDEXES`
   * first.
   *
   * A table with no rebuildable index succeeds having rebuilt nothing - "nothing to
   * do" is not a failure, and a heap table with no index is an ordinary state. One
   * index failing does not fail the run either (an offline tablespace or an unusable
   * partition stops that index alone), which is the choice the whole-schema form
   * already made and the reason each rebuild carries its own try/catch; the message
   * says how many of the table's indexes were rebuilt, because "success" alone cannot
   * distinguish 2 of 2 from 1 of 2.
   *
   * An EMPTY index list has a second cause, and it is not "nothing to do": a target the
   * catalog does not know. A name that is not a table of this schema - including a real
   * table spelled in the wrong case, since Oracle stores unquoted names folded to upper
   * case - answered `{"success": true}` in ~1 ms having done nothing at all (measured
   * against ldb-oracle-r5, Oracle AI Database 26ai Free Release 23.26.2.0.0, on
   * 2026-08-25). A target the catalog cannot resolve is a failed operation, so the two
   * are told apart with `TABLE_IS_KNOWN_SQL` - asked ONLY when the index list came back
   * empty, so the ordinary path stays at one catalog read.
   */
  private async rebuildIndexes(
    conn: oracledb.Connection,
    target?: string,
  ): Promise<{ success: boolean; message: string }> {
    // The table name is a bind here, unlike the inline-escaped literals elsewhere in
    // runMaintenance: this one sits in a WHERE clause, which does take a bind.
    const indexes = target
      ? await conn.execute(TABLE_INDEXES_SQL, [target], { outFormat: oracledb.OUT_FORMAT_OBJECT })
      : await conn.execute(SCHEMA_NORMAL_INDEXES_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

    const rows = (indexes.rows || []) as Record<string, unknown>[];

    if (target && rows.length === 0) {
      const known = await conn.execute(TABLE_IS_KNOWN_SQL, [target], { outFormat: oracledb.OUT_FORMAT_OBJECT });
      if (((known.rows || []) as unknown[]).length === 0) {
        return {
          success: false,
          // Two causes and one sentence, because the catalog cannot tell them apart from
          // here: a name that is nothing in this schema, and a name that is a VIEW or a
          // synonym - `USER_TABLES` holds neither, and rebuilding an index is not a thing
          // either can be asked to do. Measured on ldb-oracle-r5: a real view answers this
          // too, and blaming only the spelling would misdirect a caller who spelled it
          // right. `USER_TABLES` does hold a materialized view's container table, so that
          // case reaches the rebuild rather than this branch.
          message: `OPTIMIZE failed: this schema owns no TABLE named ${target}. A view or a synonym has no index to rebuild, and an unquoted name is folded to upper case, so a lower-case spelling will not match the catalog.`,
        };
      }
    }

    let rebuilt = 0;
    // The engine's first refusal, kept rather than discarded: with every rebuild failing,
    // "rebuilt 0 of 2" states the count and withholds the only part an operator can act
    // on. Measured on a table whose tablespace is READ ONLY (ldb-oracle-r5, Oracle AI
    // Database 26ai Free Release 23.26.2.0.0, 2026-08-25): every rebuild answers ORA-01647
    // and this reported success in 14 ms.
    let firstFailure: string | undefined;
    for (const row of rows) {
      try {
        await conn.execute(`ALTER INDEX "${String(row.INDEX_NAME).replace(/"/g, '""')}" REBUILD`);
        rebuilt++;
      } catch (error) {
        // One index failing is still a completed run (an offline tablespace or an unusable
        // partition stops that index alone), which is the choice the whole-schema form
        // already made - so the reason is recorded and the loop goes on.
        firstFailure ??= error instanceof Error ? error.message : String(error);
      }
    }

    // None of them rebuilding is a different fact from some of them rebuilding: nothing
    // the operation was asked to do happened, so it did not succeed. A table with no index
    // at all keeps its success above - `rows.length === 0` never enters this branch.
    if (rebuilt === 0 && rows.length > 0) {
      return {
        success: false,
        message: `OPTIMIZE failed: rebuilt 0 of ${rows.length} indexes. ${firstFailure ?? ""}`.trim(),
      };
    }

    return { success: true, message: `OPTIMIZE: rebuilt ${rebuilt} of ${rows.length} indexes.` };
  }

  // ============================================================================
  // Pool Statistics
  // ============================================================================

  public getPoolStats() {
    if (!this.pool) {
      return { total: 0, idle: 0, active: 0, waiting: 0 };
    }

    return {
      total: this.pool.connectionsOpen,
      idle: this.pool.connectionsOpen - this.pool.connectionsInUse,
      active: this.pool.connectionsInUse,
      waiting: 0,
    };
  }

  // ============================================================================
  // Extended Monitoring Methods
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      let version = "Oracle";
      let uptime = "N/A";
      let startTime: Date | undefined;
      // Left UNDEFINED, and spread conditionally into the return below - the same
      // shape `getHealth()` above uses, for the same reason. `DatabaseOverview.activeConnections`
      // is optional precisely so a user who cannot read V$SESSION omits the figure
      // instead of publishing a fabricated 0, and the monitoring Overview card reads
      // the absence as "N/A / not published" while a 0 is drawn as a real count and
      // added as a real sample to the connections trend
      // (`src/components/monitoring/tabs/OverviewTab.tsx`). The card's threshold rating
      // is the same either way: the V$PARAMETER ceiling is read inside the same try
      // below, so a refusal leaves maxConnections 0 as well and the card's percentage
      // is null on both paths. Oracle's Database Reference
      // states that after installation only SYS or a SYSDBA can read the dynamic
      // performance tables, so a plain schema user hitting ORA-00942 here is the
      // ordinary case rather than an exotic one.
      let activeConnections: number | undefined;
      // NOT made optional alongside it: `maxConnections` is a published ceiling where
      // 0 MEANS "no limit published", so 0 and absence are the SAME fact there.
      let maxConnections = 0;
      let databaseSize = "0 bytes";
      let databaseSizeBytes = 0;
      let tableCount = 0;
      let indexCount = 0;

      // Version and uptime
      try {
        const vRes = await conn.execute(`SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        const vRows = (vRes.rows || []) as Record<string, unknown>[];
        if (vRows[0]?.BANNER) version = String(vRows[0].BANNER);
      } catch {
        /* ignore */
      }

      try {
        const upRes = await conn.execute(
          `SELECT STARTUP_TIME, (SYSDATE - STARTUP_TIME) * 86400 AS UPTIME_SECS FROM V$INSTANCE`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );
        const upRows = (upRes.rows || []) as Record<string, unknown>[];
        if (upRows[0]) {
          const secs = Number(upRows[0].UPTIME_SECS || 0);
          const days = Math.floor(secs / 86400);
          const hours = Math.floor((secs % 86400) / 3600);
          const minutes = Math.floor((secs % 3600) / 60);
          uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
          if (upRows[0].STARTUP_TIME) startTime = new Date(String(upRows[0].STARTUP_TIME));
        }
      } catch {
        /* ignore */
      }

      // Connections
      try {
        const sessRes = await conn.execute(`SELECT COUNT(*) AS CNT FROM V$SESSION WHERE TYPE = 'USER'`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        // measuredNumber, not `Number(... || 0)`: a COUNT of 0 is a reading, so the
        // falsy test would have thrown away the very figure it was meant to publish.
        // Only an unanswered COUNT stays absent. The assignment deliberately precedes
        // the ceiling read below, so a refused V$PARAMETER cannot carry this count away.
        activeConnections = measuredNumber(((sessRes.rows || []) as Record<string, unknown>[])[0]?.CNT);

        const maxRes = await conn.execute(`SELECT VALUE FROM V$PARAMETER WHERE NAME = 'sessions'`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        maxConnections = Number(((maxRes.rows || []) as Record<string, unknown>[])[0]?.VALUE || 0);
      } catch {
        /* Both V$ views need privileges: a refused count stays absent, never 0, while a
           refused ceiling leaves the 0 that already means "no limit published". */
      }

      // Database size
      try {
        const sizeRes = await conn.execute(`SELECT SUM(BYTES) AS TOTAL FROM USER_SEGMENTS`, [], {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        });
        databaseSizeBytes = Number(((sizeRes.rows || []) as Record<string, unknown>[])[0]?.TOTAL || 0);
        databaseSize = formatBytes(databaseSizeBytes);
      } catch {
        /* ignore */
      }

      // Table and index counts
      try {
        const cntRes = await conn.execute(OVERVIEW_OBJECT_COUNTS_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const cntRows = (cntRes.rows || []) as Record<string, unknown>[];
        tableCount = Number(cntRows[0]?.TABLE_COUNT || 0);
        indexCount = Number(cntRows[0]?.INDEX_COUNT || 0);
      } catch {
        /* ignore */
      }

      return {
        version,
        uptime,
        startTime,
        ...(activeConnections === undefined ? {} : { activeConnections }),
        maxConnections,
        databaseSize,
        databaseSizeBytes,
        tableCount,
        indexCount,
      };
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      let cacheHitRatio: number | undefined;

      try {
        const cacheRes = await conn.execute(CACHE_HIT_RATIO_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const rows = (cacheRes.rows || []) as Record<string, unknown>[];
        cacheHitRatio = measuredNumber(rows[0]?.HIT_RATIO);
      } catch {
        /* V$SYSSTAT requires privileges; nothing was measured, so nothing is reported. */
      }

      return {
        ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
        // bufferPoolUsage is gone rather than merely absent. It used to be assigned
        // `cacheHitRatio` itself - the same number under a second name, which the
        // Performance tab then drew as a separate gauge and rated separately. Oracle
        // does publish buffer pool occupancy, but in V$BUFFER_POOL_STATISTICS /
        // V$SGASTAT, which this method does not query; until it does there is
        // nothing here to report.
      };
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      const res = await conn.execute(
        `${SLOW_QUERIES_BODY_SQL} WHERE ROWNUM <= ${Math.max(1, Math.trunc(Number(limit)) || 1)}`,
        [],
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        },
      );

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => ({
        queryId: String(r.QUERY_ID || ""),
        query: String(r.QUERY || ""),
        calls: Number(r.CALLS || 0),
        totalTime: Number(r.TOTAL_TIME || 0),
        avgTime: Number(r.AVG_TIME || 0),
        rows: Number(r.ROW_CNT || 0),
        sharedBlksHit: Number(r.BUF_GETS || 0),
        sharedBlksRead: Number(r.DISK_READS || 0),
      }));
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      const res = await conn.execute(
        `${ACTIVE_SESSIONS_BODY_SQL} WHERE ROWNUM <= ${Math.max(1, Math.trunc(Number(limit)) || 1)}`,
        [],
        {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
        },
      );

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const secs = Number(r.DURATION_SECS || 0);
        const durationStr =
          secs > 3600
            ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
            : secs > 60
              ? `${Math.floor(secs / 60)}m ${secs % 60}s`
              : `${secs}s`;

        return {
          pid: `${r.SID},${r["SERIAL#"]}`,
          user: String(r.USERNAME || "unknown"),
          database: String(r.SCHEMANAME || ""),
          applicationName: String(r.PROGRAM || ""),
          clientAddr: String(r.MACHINE || ""),
          state: String(r.STATUS || "unknown"),
          query: String(r.QUERY || r.SQL_ID || ""),
          queryStart: r.LOGON_TIME ? new Date(String(r.LOGON_TIME)) : undefined,
          duration: durationStr,
          durationMs: secs * 1000,
          waitEventType: r.WAIT_CLASS ? String(r.WAIT_CLASS) : undefined,
          waitEvent: r.EVENT ? String(r.EVENT) : undefined,
          blocked: false,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || "";

      const res = await conn.execute(TABLE_STATS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const tableSizeBytes = Number(r.TABLE_SIZE_BYTES || 0);
        const indexSizeBytes = Number(r.INDEX_SIZE_BYTES || 0);
        return {
          schemaName: owner,
          tableName: String(r.TABLE_NAME || ""),
          rowCount: Number(r.ROW_COUNT || 0),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          indexSizeBytes,
          totalSize: formatBytes(tableSizeBytes + indexSizeBytes),
          totalSizeBytes: tableSizeBytes + indexSizeBytes,
          lastAnalyze: r.LAST_ANALYZED ? new Date(String(r.LAST_ANALYZED)) : undefined,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || "";

      const res = await conn.execute(INDEX_STATS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      // Get columns for each index
      const colRes = await conn.execute(INDEX_COLUMNS_SQL, [owner], { outFormat: oracledb.OUT_FORMAT_OBJECT });

      const colMap = new Map<string, string[]>();
      for (const c of (colRes.rows || []) as Record<string, unknown>[]) {
        const idxName = String(c.INDEX_NAME || "");
        if (!colMap.has(idxName)) colMap.set(idxName, []);
        colMap.get(idxName)!.push(String(c.COLUMN_NAME || ""));
      }

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const idxName = String(r.INDEX_NAME || "");
        const idxSizeBytes = Number(r.INDEX_SIZE_BYTES || 0);
        return {
          schemaName: owner,
          tableName: String(r.TABLE_NAME || ""),
          indexName: idxName,
          indexType: String(r.INDEX_TYPE || ""),
          columns: colMap.get(idxName) || [],
          isUnique: String(r.UNIQUENESS || "") === "UNIQUE",
          isPrimary: false,
          indexSize: formatBytes(idxSizeBytes),
          indexSizeBytes: idxSizeBytes,
          scans: 0,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const results: StorageStats[] = [];

      // Try DBA tablespaces first, fallback to USER
      try {
        const tsRes = await conn.execute(STORAGE_DBA_FILES_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

        for (const row of (tsRes.rows || []) as Record<string, unknown>[]) {
          const sizeBytes = Number(row.SIZE_BYTES || 0);
          results.push({
            name: String(row.NAME || ""),
            size: formatBytes(sizeBytes),
            sizeBytes,
          });
        }
      } catch {
        // Fallback: user segments
        try {
          const segRes = await conn.execute(STORAGE_USER_SEGMENTS_SQL, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

          for (const row of (segRes.rows || []) as Record<string, unknown>[]) {
            const sizeBytes = Number(row.SIZE_BYTES || 0);
            results.push({
              name: String(row.NAME || ""),
              size: formatBytes(sizeBytes),
              sizeBytes,
            });
          }
        } catch {
          /* ignore */
        }
      }

      return results;
    } finally {
      if (conn) await conn.close();
    }
  }
}
