/**
 * Base Database Provider
 * Abstract class implementing common provider functionality
 */

import {
  type DatabaseProvider,
  type Container,
  type DatabaseObject,
  type KindCount,
  type ObjectDetail,
  type DescribeObjectsOptions,
  type ObjectReadOptions,
  type ObjectDetailBatch,
  type DatabaseType,
  type DatabaseConnection,
  type QueryResult,
  type HealthInfo,
  type MaintenanceOperation,
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
import { DatabaseConfigError } from "./errors";
import { engineFacetsFor } from "./engine-facets";
import { readDeclaredPanels, readPanel } from "./engine-facets/monitoring";
import { mapDatabaseError } from "./map-database-error";
import { mergePoolConfig, formatDuration } from "./utils/pool-manager";

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

  /*
    The object surface (#789). Abstract here rather than defaulted, because there is no
    honest default: what a container is, what kinds an engine has and how an object is
    addressed are facts only the provider holds. They replaced `getSchema`,
    `getSchemaList` and `getSchemaRelations`, which this class also declared abstract.
  */
  public abstract listContainers(parent?: readonly string[]): Promise<Container[]>;
  public abstract countObjects(
    container: readonly string[],
    options?: ObjectReadOptions,
  ): Promise<Record<string, KindCount>>;
  public abstract listObjects(
    container: readonly string[],
    kind: string,
    options?: ObjectReadOptions,
  ): Promise<DatabaseObject[]>;
  public abstract describeObject(path: readonly string[], kind: string): Promise<ObjectDetail>;
  public abstract describeObjects(
    container: readonly string[],
    kind: string,
    limit?: number,
    options?: DescribeObjectsOptions,
  ): Promise<ObjectDetailBatch>;

  public abstract getHealth(): Promise<HealthInfo>;
  public abstract runMaintenance(
    type: MaintenanceOperation,
    target?: string,
    container?: string,
  ): Promise<MaintenanceResult>;

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

  /**
   * Get comprehensive monitoring data: the panels the engine's `ENGINE_FACETS` row offers, read by
   * `readDeclaredPanels` through `readPanel` over this provider's own members, which states the four panel states and
   * the failure rule. A panel the engine does not offer is never read and is listed in `notOffered`.
   *
   * Core reads only declared panels, so no provider overrides this method;
   * `tests/isolated/monitoring-panels-census.test.ts` holds that across the fleet.
   */
  public async getMonitoringData(options: MonitoringOptions = {}): Promise<MonitoringData> {
    return readDeclaredPanels(
      (request) => readPanel(this, request),
      engineFacetsFor(this.type).monitoring,
      options,
      (error) => this.mapError(error, undefined),
    );
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
      // No `createTable`: a subclass offers the Create Table form only once it declares the
      // grammar the form writes, never one inherited in another engine's dialect (#648, #1822).
      supportsInlineRowEdit: true,
      // False, and NOT the permissive default the flag above takes: the `prepareQuery`
      // below returns the statement untouched and never applies an offset, so a subclass
      // that does not override BOTH would offer a page-two control its own query path
      // answers with page one (#816).
      supportsResultPagination: false,
      // False, unlike supportsInlineRowEdit above: this class implements no
      // transaction methods, so a subclass that does not add them has none, and
      // POST /api/db/transaction refuses the call. The four that hold a session for
      // one (postgres, mysql, oracle, mssql) override this.
      supportsTransactions: false,
      // False for the same reason: a subclass that inherits this default has not said its
      // engine takes the generator's rows, so the row menus do not offer it (#1468). The
      // engines that do override this.
      supportsTestDataGeneration: false,
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
