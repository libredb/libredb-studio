/**
 * Base Database Provider
 * Abstract class implementing common provider functionality
 */

import {
  type DatabaseProvider,
  type DatabaseType,
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type PoolConfig,
  type ConnectionState,
  type MonitoringData,
  type MonitoringOptions,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
  type ProviderCapabilities,
  type ProviderLabels,
  type PreparedQuery,
  type QueryPrepareOptions,
  DEFAULT_QUERY_TIMEOUT,
} from "./types";
import { DatabaseConfigError, mapDatabaseError } from "./errors";
import { mergePoolConfig, formatDuration } from "./utils/pool-manager";

// ============================================================================
// Connection String Redaction
// ============================================================================

/**
 * Substrings that mark a connection-string parameter as carrying a credential.
 * They are matched case-insensitively anywhere inside the parameter NAME, so a
 * driver-specific spelling is covered too: `password` also catches libpq's
 * `sslpassword`, and `token` also catches `authToken` and `accessToken`. The mask
 * deliberately errs towards hiding, because a non-secret hidden costs a reader one
 * value while a secret missed costs a leak that looks redacted.
 */
const CREDENTIAL_PARAM_SUBSTRINGS = ["password", "token", "sslkey", "secret"];

/**
 * Redact the credentials a connection string carries, in the two places engines put them.
 *
 * PostgreSQL and MongoDB put the credential in the authority
 * (`scheme://user:password@host`), while libSQL carries the whole token in the query
 * string (`libsql://<db>-<org>.turso.io?authToken=<jwt>`) and libpq accepts `password`,
 * `sslpassword` and `sslkey` as URI parameters as well. An ADO-style string
 * (`Server=host;Database=db;Password=pw`) has neither a scheme nor a query string and
 * puts its parameters in arbitrary order, so the first parameter is as likely to be the
 * credential as the last.
 *
 * Nothing here parses the input as a URL: a connection string is not always a valid one,
 * and a redaction that throws on the input it was handed is worse than none.
 *
 * What is NOT covered is an authority password containing a character RFC 3986 requires
 * to be percent-encoded there, because each one collides with a shape that carries no
 * secret and no regex separates them:
 * - `@` (`scheme://user:p@ss@host`) leaves the tail after the first `@` visible, because
 *   the authority's end cannot be located without it;
 * - `/`, `?` or `#` (`scheme://user:p/w@host/db`) is not masked at all. `/` is the
 *   instructive one: `scheme://host:5432/tenant@acme` has exactly the same shape, and
 *   masking it would hide the port behind a `***` asserting a credential the string never
 *   carried - a fabricated reading rather than a mask, which is the worse of the two. `?`
 *   and `#` end the authority for the same reason and are excluded with it.
 *
 * A scheme-relative string (`//user:pass@host/db`) is not covered either, and no driver
 * here accepts one.
 */
function redactConnectionString(connectionString: string): string {
  // Anchoring the userinfo to `://` is what keeps this off a path: in
  // `postgres://host/db:owner@example.com` the only `:`+text+`@` sits in the path, and a
  // pattern that matched it would replace a path segment while hiding no secret. The
  // password is bounded by '/' as well for the reason the docblock gives, and the userinfo
  // before the ':' is bounded by it too, or the host would be swallowed.
  const withAuthorityMasked = connectionString.replace(
    /:\/\/([^:@/?#]*):([^@/?#]+)@/,
    (_whole: string, userinfo: string) => `://${userinfo}:***@`,
  );

  // Replace the VALUE of a credential-shaped parameter and keep its name, so the reader
  // can still see which knobs were set. Matching the name between a delimiter and '=' is
  // what stops a credential word sitting in somebody else's value from triggering a
  // replacement. ';' counts as a delimiter because ADO-style strings separate their
  // parameters with it, and `^` counts as one because such a string may LEAD with its
  // credential - `Password=pw;Server=host` is as valid as the reverse, and matching only
  // after a delimiter returned the leading one verbatim.
  return withAuthorityMasked.replace(
    /(^|[?&#;])([^=&#;?]*)=([^&#;]*)/g,
    (whole: string, delimiter: string, name: string, value: string) => {
      const isCredential = CREDENTIAL_PARAM_SUBSTRINGS.some((word) => name.toLowerCase().includes(word));
      // An empty value stays empty: '***' over a value the string never carried would
      // assert a secret that is not there, which is a fabricated reading, not a mask.
      return isCredential && value !== "" ? `${delimiter}${name}=***` : whole;
    },
  );
}

// ============================================================================
// Base Provider Class
// ============================================================================

export abstract class BaseDatabaseProvider implements DatabaseProvider {
  public readonly type: DatabaseType;
  public readonly config: DatabaseConnection;

  protected readonly poolConfig: PoolConfig;
  protected readonly queryTimeout: number;
  protected readonly options: ProviderOptions;
  protected state: ConnectionState;

  protected constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    this.type = config.type;
    this.config = config;
    this.options = options;
    this.poolConfig = mergePoolConfig(options.pool);
    this.queryTimeout = options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
    this.state = {
      connected: false,
      activeQueries: 0,
    };
  }

  // ============================================================================
  // Abstract Methods (must be implemented by subclasses)
  // ============================================================================

  public abstract connect(): Promise<void>;
  public abstract disconnect(): Promise<void>;
  public abstract query(sql: string, params?: unknown[]): Promise<QueryResult>;
  public abstract getSchema(): Promise<TableSchema[]>;
  public abstract getHealth(): Promise<HealthInfo>;
  public abstract runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult>;

  // Monitoring methods (must be implemented by subclasses)
  public abstract getOverview(): Promise<DatabaseOverview>;
  public abstract getPerformanceMetrics(): Promise<PerformanceMetrics>;
  public abstract getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]>;
  public abstract getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]>;
  public abstract getTableStats(options?: { schema?: string }): Promise<TableStats[]>;
  public abstract getIndexStats(options?: { schema?: string }): Promise<IndexStats[]>;
  public abstract getStorageStats(): Promise<StorageStats[]>;

  // ============================================================================
  // Common Implementations
  // ============================================================================

  public isConnected(): boolean {
    return this.state.connected;
  }

  public async getTables(): Promise<string[]> {
    const schema = await this.getSchema();
    return schema.map((table) => table.name);
  }

  /**
   * Get comprehensive monitoring data
   *
   * Every panel is read independently and a rejection costs only its own panel: the field
   * is left absent and the ENGINE's own sentence is recorded under `errors`. One failing
   * read used to discard the whole dashboard - `Promise.all` rejects on the first failure -
   * so StarRocks 3.3, which has no `information_schema.PROCESSLIST`, answered
   * "Unknown table 'information_schema.PROCESSLIST'" and cost the user the overview, the
   * performance panel, the slow queries, the tables, the indexes and the storage panel, all
   * six of which it had already answered (measured 2026-08-24 against StarRocks 3.3 on
   * 127.0.0.1:19030 through this provider).
   *
   * It still throws when ALL FOUR core reads reject, which is what a dead connection looks
   * like: the caller (/api/db/monitoring) keeps its error path, and the thrown message
   * carries the engine's own sentences rather than replacing them.
   *
   * Subclasses can override for optimized implementations.
   */
  public async getMonitoringData(options: MonitoringOptions = {}): Promise<MonitoringData> {
    const {
      includeTables = true,
      includeIndexes = true,
      includeStorage = true,
      slowQueryLimit = 10,
      sessionLimit = 50,
      schemaFilter, // undefined = all user schemas
    } = options;

    const result: MonitoringData = { timestamp: new Date() };
    const errors: NonNullable<MonitoringData["errors"]> = {};

    const record = (panel: keyof NonNullable<MonitoringData["errors"]>, reason: unknown): void => {
      errors[panel] = reason instanceof Error ? reason.message : String(reason);
    };

    // Read every panel independently, then fill in whatever answered.
    const [overview, performance, slowQueries, activeSessions, tables, indexes, storage] = await Promise.allSettled([
      this.getOverview(),
      this.getPerformanceMetrics(),
      this.getSlowQueries({ limit: slowQueryLimit }),
      this.getActiveSessions({ limit: sessionLimit }),
      includeTables ? this.getTableStats({ schema: schemaFilter }) : Promise.resolve(undefined),
      includeIndexes ? this.getIndexStats({ schema: schemaFilter }) : Promise.resolve(undefined),
      includeStorage ? this.getStorageStats() : Promise.resolve(undefined),
    ]);

    if (overview.status === "fulfilled") result.overview = overview.value;
    else record("overview", overview.reason);

    if (performance.status === "fulfilled") result.performance = performance.value;
    else record("performance", performance.reason);

    if (slowQueries.status === "fulfilled") result.slowQueries = slowQueries.value;
    else record("slowQueries", slowQueries.reason);

    if (activeSessions.status === "fulfilled") result.activeSessions = activeSessions.value;
    else record("activeSessions", activeSessions.reason);

    // The optional three: a panel that was not requested resolves to `undefined` and stays
    // absent with no error entry, which is how "not asked for" differs from "asked and refused".
    if (tables.status === "fulfilled") {
      if (tables.value !== undefined) result.tables = tables.value;
    } else record("tables", tables.reason);

    if (indexes.status === "fulfilled") {
      if (indexes.value !== undefined) result.indexes = indexes.value;
    } else record("indexes", indexes.reason);

    if (storage.status === "fulfilled") {
      if (storage.value !== undefined) result.storage = storage.value;
    } else record("storage", storage.reason);

    // All four core reads rejected: there is no dashboard to render, so this is a failure
    // and not a partial answer. The engine's own sentences travel in the thrown message.
    if (
      overview.status === "rejected" &&
      performance.status === "rejected" &&
      slowQueries.status === "rejected" &&
      activeSessions.status === "rejected"
    ) {
      const seen = new Set<string>();
      const sentences = [errors.overview, errors.performance, errors.slowQueries, errors.activeSessions].filter(
        (message): message is string => {
          if (message === undefined || seen.has(message)) return false;
          seen.add(message);
          return true;
        },
      );
      // One sentence for all four is what a dead connection looks like, and the first
      // rejection is already a mapped provider error carrying its own class and
      // ApiErrorCode. Rethrowing it verbatim keeps the status code /api/db/monitoring
      // answered before this change; re-wrapping would re-classify it from its text and
      // could downgrade an AuthenticationError to a generic DatabaseError.
      if (sentences.length === 1) throw overview.reason;
      throw this.mapError(new Error(sentences.join("; ")), undefined);
    }

    if (Object.keys(errors).length > 0) result.errors = errors;

    return result;
  }

  public validate(): void {
    if (!this.config.id) {
      throw new DatabaseConfigError("Connection ID is required", this.type);
    }

    if (!this.config.type) {
      throw new DatabaseConfigError("Database type is required", this.type);
    }

    // Subclasses should override for provider-specific validation
  }

  // ============================================================================
  // Provider Metadata (defaults — subclasses override)
  // ============================================================================

  public getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      supportsExplain: true,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: true,
      supportsInlineRowEdit: true,
      // False, unlike supportsInlineRowEdit above: this class implements no
      // transaction methods, so a subclass that does not add them has none, and
      // POST /api/db/transaction refuses the call. The four that hold a session for
      // one (postgres, mysql, oracle, mssql) override this.
      supportsTransactions: false,
      // The default is the SQL default: a relational engine has foreign keys whether
      // or not a given schema uses them. The engines that have none override this
      // (#414), which is the direction that carries the strong claim.
      declaresForeignKeys: true,
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "analyze", "reindex", "kill", "optimize", "check"],
      supportsConnectionString: false,
      defaultPort: null,
      schemaRefreshPattern: "(CREATE|DROP|ALTER|TRUNCATE)\\b",
    };
  }

  public getLabels(): ProviderLabels {
    return {
      entityName: "Table",
      entityNamePlural: "Tables",
      rowName: "row",
      rowNamePlural: "rows",
      selectAction: "Select Top 50",
      generateAction: "Generate Query",
      analyzeAction: "Analyze Table",
      vacuumAction: "Vacuum Table",
      searchPlaceholder: "Search tables or columns...",
      analyzeGlobalLabel: "Run Analyze",
      analyzeGlobalTitle: "Update Statistics",
      analyzeGlobalDesc:
        "Updates the planner's statistics for all tables in the database to improve query optimization.",
      vacuumGlobalLabel: "Run Vacuum",
      vacuumGlobalTitle: "Reclaim Space",
      vacuumGlobalDesc: "Removes dead rows from tables and returns space to the operating system.",
    };
  }

  public prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    return { query, wasLimited: false, limit: options.limit || 500, offset: options.offset || 0 };
  }

  // ============================================================================
  // Protected Helpers
  // ============================================================================

  /**
   * Ensure provider is connected before operation
   */
  protected ensureConnected(): void {
    if (!this.state.connected) {
      throw new DatabaseConfigError("Provider is not connected. Call connect() first.", this.type);
    }
  }

  /**
   * Track active query count
   */
  protected async trackQuery<T>(fn: () => Promise<T>): Promise<T> {
    this.state.activeQueries++;
    try {
      return await fn();
    } finally {
      this.state.activeQueries--;
    }
  }

  /**
   * Measure query execution time
   */
  protected async measureExecution<T>(fn: () => Promise<T>): Promise<{ result: T; executionTime: number }> {
    const startTime = performance.now();
    const result = await fn();
    const executionTime = Math.round(performance.now() - startTime);
    return { result, executionTime };
  }

  /**
   * Map native errors to DatabaseError
   */
  protected mapError(error: unknown, query?: string): Error {
    return mapDatabaseError(error, this.type, query);
  }

  /**
   * Log error with safe config
   */
  protected logError(operation: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Sanitize to prevent log injection via newlines/control chars
    const sanitize = (v: string) => v.replace(/[\r\n]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    console.error(`[DB:${sanitize(this.type)}] ${sanitize(operation)} failed: ${sanitize(errorMessage)}`);
  }

  /**
   * Get config without sensitive data for logging
   */
  protected getSafeConfig(): Record<string, unknown> {
    return {
      id: this.config.id,
      name: this.config.name,
      type: this.config.type,
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      // Never log password or connection string
    };
  }

  /**
   * Build connection info for health check
   *
   * A connection string is redacted in both of the places a credential can hide - the
   * authority and the query string - see `redactConnectionString`.
   */
  protected getConnectionInfo(): string {
    if (this.config.connectionString) {
      return redactConnectionString(this.config.connectionString);
    }
    return `${this.config.host}:${this.config.port}/${this.config.database}`;
  }

  /**
   * Format duration for display
   */
  protected formatDuration(ms: number): string {
    return formatDuration(ms);
  }

  /**
   * Update connection state
   */
  protected setConnected(connected: boolean): void {
    this.state.connected = connected;
    if (connected) {
      this.state.lastConnected = new Date();
      this.state.lastError = undefined;
    }
  }

  /**
   * Record connection error
   */
  protected setError(error: Error): void {
    this.state.lastError = error;
    this.state.connected = false;
  }
}
