/**
 * libSQL Database Provider (issue #424 Phase 5)
 *
 * One type-id for two deployments of the same engine: a self-hosted libSQL server
 * (`sqld`) and Turso Cloud, which is that server managed. Both speak Hrana, both
 * embed SQLite 3.47.0, and everything the provider asks is SQL - so this file is
 * the SQLite dialect over a network rather than a second engine.
 *
 * It is NOT the SQLite provider with a different handle, and the differences are
 * measured rather than assumed (2026-08-27, sqld 0.24.33 and Turso Cloud):
 *
 * - `VACUUM`, `ANALYZE`, `PRAGMA optimize` and `PRAGMA wal_checkpoint` are refused
 *   by the server's statement allowlist on BOTH deployments, so this provider
 *   offers `reindex` and `check` and nothing else. Offering a vacuum that always
 *   fails is the Cloud Spanner shape - a control that reports success while
 *   nothing happens, or fails every time - and #424 refuses rows for it.
 * - `PRAGMA query_only = true` is refused as well, which is why this provider
 *   implements no `queryReadOnly`: the agent read-only profile delegates
 *   enforcement to the engine (`sqlite.ts`), and here there is nothing to delegate
 *   to. A read-only Turso token is an engine-side answer to the same question and
 *   is the right route if the profile is ever wanted - it is a credential the user
 *   mints, not a statement this provider can issue.
 * - `dbstat` IS available on both deployments, so per-table and per-index bytes are
 *   measured here - which `bun:sqlite` cannot do at all.
 * - There is no file to `stat` and no handle to hold: sizes come from the page
 *   counters, and there is no session to count anywhere.
 *
 * Zero runtime dependency: see `hrana-transport.ts`.
 */

import { SQLBaseProvider } from "../sql-base";
import {
  type DatabaseConnection,
  type ActiveSessionDetails,
  type DatabaseOverview,
  type HealthInfo,
  type IndexStats,
  type MaintenanceResult,
  type MaintenanceType,
  type PerformanceMetrics,
  type ProviderCapabilities,
  type ProviderLabels,
  type ProviderOptions,
  type QueryResult,
  type SlowQueryStats,
  type StorageStats,
  type TableSchema,
  type TableStats,
} from "@/lib/db/types";
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { LibSQLHranaTransport } from "./hrana-transport";
import {
  readActiveSessions,
  readHealth,
  readIndexStats,
  readOverview,
  readSchema,
  readSlowQueries,
  readStorageStats,
  readTableStats,
} from "./introspect";
import { type LibSQLStatementResult, type LibSQLTransport, LibSQLTransportError } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The cheapest statement that proves the server, the credential and the database
 * together. A libSQL server answers `/health` without looking at the token, so a
 * health route is not a connection test.
 */
const CONNECT_PROBE_SQL = "SELECT 1";

const INTEGRITY_CHECK_SQL = "PRAGMA integrity_check";

/**
 * The credential is a token rather than a password, and it arrives in the query
 * string rather than in the authority: `libsql://<db>.turso.io?authToken=<jwt>` is
 * the form Turso's own CLI prints.
 */
const AUTH_TOKEN_PARAM = "authToken";

/** Statuses a libSQL deployment answers a credential problem with. */
const AUTH_STATUSES = new Set([400, 401, 403]);

// ============================================================================
// Connection resolution
// ============================================================================

/**
 * The configuration with a hand-typed `libsql://` URL resolved into fields.
 *
 * `libsql://` implies TLS, which is why the scheme carries no second form here:
 * Turso serves every database over HTTPS on 443, and a self-hosted plaintext
 * server is reached through the host/port fields with TLS off. Inventing a
 * `libsql+http://` scheme no libSQL tool emits would be worse than that gap.
 */
function resolveConnection(config: DatabaseConnection): DatabaseConnection {
  if (!config.connectionString) return config;

  let url: URL;
  try {
    url = new URL(config.connectionString);
  } catch {
    // Left to `validate()` and to the transport to report: a string that is not a
    // URL is a configuration error, and swallowing it here would send the request
    // to whatever the form fields happened to hold.
    return config;
  }

  const token = url.searchParams.get(AUTH_TOKEN_PARAM);

  return {
    ...config,
    host: url.hostname || config.host,
    port: url.port === "" ? config.port : Number(url.port),
    password: token ?? (url.password === "" ? config.password : decodeURIComponent(url.password)),
    ssl: config.ssl ?? { mode: "require" },
  };
}

// ============================================================================
// Result mapping
// ============================================================================

function toQueryResult(result: LibSQLStatementResult, measuredMs: number): QueryResult {
  const reportedMs = Math.round(result.executionTimeMs);

  return {
    rows: result.rows,
    fields: result.fieldNames,
    // A write returns no rows, so its count is what the engine says it changed.
    rowCount: result.rows.length > 0 ? result.rows.length : result.affectedRowCount,
    // The engine's own measurement when it is at least a millisecond, and the
    // wall-clock one otherwise: a statement that really took 0.02 ms would
    // otherwise be reported as having taken no time at all.
    executionTime: reportedMs > 0 ? reportedMs : measuredMs,
    // Declared types travel with the result (#273) and are omitted when the engine
    // declared none - which it does for every computed column and every PRAGMA, so
    // an empty map is the common case rather than a failure.
    ...(Object.keys(result.columnTypes).length > 0 ? { columnTypes: result.columnTypes } : {}),
  };
}

// ============================================================================
// libSQL Provider
// ============================================================================

export class LibSQLProvider extends SQLBaseProvider {
  private transport: LibSQLTransport | null = null;

  private readonly connection: DatabaseConnection;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.connection = resolveConnection(config);
    this.validate();
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      // sqld's own default. Turso Cloud serves on 443, which the TLS branch of the
      // transport picks up - a connection there names no port at all.
      defaultPort: 8080,
      supportsExplain: true,
      // The same plan SQLite produces, because it IS SQLite: `EXPLAIN QUERY PLAN`
      // answers the id/parent/notused/detail shape on both deployments.
      explainFormat: "sqlite-queryplan",
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // libSQL HAS transactions - `BEGIN` is accepted and Hrana keeps an
      // interactive stream alive with a `baton` to continue one - but this provider
      // closes its stream in the same request as the statement, so it holds no
      // session for a transaction to live in. POST /api/db/transaction refuses the
      // call and the controls stay hidden, which is the SQLite provider's position
      // for the same reason.
      supportsTransactions: false,
      // Measured on BOTH deployments: `VACUUM`, `ANALYZE`, `PRAGMA optimize` and
      // `PRAGMA wal_checkpoint` are all refused by the server's statement
      // allowlist ("unsupported statement" on sqld, "SQL not allowed statement" on
      // Turso Cloud). `REINDEX` and `PRAGMA integrity_check` are accepted, and they
      // are the only two offered here.
      maintenanceOperations: ["reindex", "check"],
      maintenanceOperationSpecs: {
        reindex: { label: "Reindex Table", perEntity: true, global: true },
        check: { label: "Integrity Check", perEntity: false, global: true },
      },
      // Every statement is a fresh request, so a `CREATE TABLE` typed in the editor
      // behaves exactly as it does against a file.
      supportsCreateTable: true,
      schemaRefreshPattern: "(CREATE|DROP|ALTER|TRUNCATE|REINDEX)\\b",
    };
  }

  /**
   * The two labels the engine's own gaps require, and no others: `tables` and
   * `rows` are the right words for SQLite.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      slowQueriesEmptyState: "libSQL keeps no statistics about finished statements, so there is nothing to enable.",
      reindexGlobalLabel: "Run Reindex",
      reindexGlobalTitle: "Rebuild Indexes",
      reindexGlobalDesc: "Runs bare REINDEX, rebuilding every index in the database.",
    };
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  public validate(): void {
    super.validate();

    if (!this.connection.host && !this.config.connectionString) {
      throw new DatabaseConfigError(
        'A host is required for libSQL (or a libsql:// URL in "connectionString")',
        "libsql",
      );
    }
  }

  // ==========================================================================
  // Connection management
  // ==========================================================================

  public async connect(): Promise<void> {
    if (this.transport) return;

    const transport = new LibSQLHranaTransport(this.connection);

    try {
      await transport.execute(CONNECT_PROBE_SQL, { timeoutMs: this.queryTimeout });
    } catch (error) {
      await transport.close();
      const failure = this.describeConnectFailure(error);
      this.setError(failure);
      throw failure;
    }

    this.transport = transport;
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.setConnected(false);
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const transport = this.requireTransport();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await transport.execute(sql, { params, timeoutMs: this.queryTimeout });
        } catch (error) {
          throw this.mapLibSQLError(error, sql);
        }
      });

      return toQueryResult(result, executionTime);
    });
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  public async getSchema(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    try {
      return await readSchema(transport);
    } catch (error) {
      throw this.mapLibSQLError(error);
    }
  }

  // ==========================================================================
  // Health and monitoring
  // ==========================================================================

  public async getHealth(): Promise<HealthInfo> {
    const transport = this.requireTransport();
    try {
      return await readHealth(transport);
    } catch (error) {
      throw this.mapLibSQLError(error);
    }
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const transport = this.requireTransport();
    try {
      return await readOverview(transport);
    } catch (error) {
      throw this.mapLibSQLError(error);
    }
  }

  /**
   * Only what libSQL can actually be asked, which is no cache hit ratio at all.
   *
   * SQLite's hit and miss counters live behind the C API (`sqlite3_db_status()`),
   * and no statement reaches them - so nothing over Hrana can either. The one
   * field kept is `deadlocks`, and it is a statement about the engine rather than a
   * reading that failed: SQLite serializes writers behind a single write lock and
   * refuses a second one with SQLITE_BUSY, so there are no deadlocks to count and 0
   * is the true count.
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    return { deadlocks: 0 };
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    this.ensureConnected();

    return readSlowQueries();
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();

    return readActiveSessions();
  }

  public async getTableStats(): Promise<TableStats[]> {
    const transport = this.requireTransport();
    try {
      return await readTableStats(transport);
    } catch (error) {
      throw this.mapLibSQLError(error);
    }
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    const transport = this.requireTransport();
    try {
      return await readIndexStats(transport);
    } catch (error) {
      throw this.mapLibSQLError(error);
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    const transport = this.requireTransport();
    try {
      return await readStorageStats(transport);
    } catch (error) {
      throw this.mapLibSQLError(error);
    }
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  /**
   * The two operations the server accepts, and an honest refusal for the rest.
   *
   * `check` reads the answer rather than the status: `PRAGMA integrity_check`
   * succeeds as a statement and reports the damage in its row, so a provider that
   * only checked for an exception would report a corrupt database as healthy.
   */
  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    const transport = this.requireTransport();

    const { result, executionTime } = await this.measureExecution(async () => {
      if (type === "check") {
        const check = await this.run(transport, INTEGRITY_CHECK_SQL);
        const verdict = check.rows[0]?.integrity_check;
        return { success: verdict === "ok", message: typeof verdict === "string" ? verdict : "Unknown" };
      }

      if (type === "reindex") {
        const sql = target ? `REINDEX ${this.escapeIdentifier(target)}` : "REINDEX";
        await this.run(transport, sql);
        return { success: true, message: "REINDEX completed successfully" };
      }

      // Everything else is refused HERE rather than sent and allowed to fail, so
      // the message names the reason instead of relaying "unsupported statement"
      // from a server the user did not ask to talk to. `maintenanceOperations`
      // already withholds these controls; this covers a direct API call.
      throw new QueryError(
        `libSQL servers do not accept ${type.toUpperCase()}: only REINDEX and PRAGMA integrity_check are allowed`,
        "libsql",
      );
    });

    return { success: result.success, executionTime, message: result.message };
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async run(transport: LibSQLTransport, sql: string): Promise<LibSQLStatementResult> {
    try {
      return await transport.execute(sql, { timeoutMs: this.queryTimeout });
    } catch (error) {
      throw this.mapLibSQLError(error, sql);
    }
  }

  private requireTransport(): LibSQLTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false), so
    // a connected provider always has one.
    return this.transport!;
  }

  private describeConnectFailure(error: unknown): Error {
    const mapped = this.mapLibSQLError(error);
    if (mapped instanceof AuthenticationError) return mapped;

    return new ConnectionError(
      `Failed to connect to libSQL: ${mapped.message}`,
      "libsql",
      this.connection.host,
      this.connection.port,
    );
  }

  /**
   * A transport failure as the error the rest of the app expects.
   *
   * The status carries the distinction, not the wording: the two deployments word
   * the same refusal differently ("unsupported statement" against "SQL not allowed
   * statement"), while a statement error is always a 200 and a credential problem
   * is always a 4xx. Matching on text would have been wrong on one of the two
   * deployments from the first day.
   */
  private mapLibSQLError(error: unknown, sql?: string): Error {
    if (!(error instanceof LibSQLTransportError)) {
      return error instanceof Error ? error : new QueryError(String(error), "libsql", sql);
    }

    if (AUTH_STATUSES.has(error.status)) {
      return new AuthenticationError(error.message, "libsql");
    }

    if (error.status === 0) {
      return new ConnectionError(error.message, "libsql", this.connection.host, this.connection.port);
    }

    return new QueryError(error.message, "libsql", sql);
  }
}
