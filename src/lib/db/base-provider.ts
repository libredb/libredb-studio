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
  DEFAULT_QUERY_TIMEOUT,
} from './types';
import { DatabaseConfigError, mapDatabaseError } from './errors';
import { mergePoolConfig, formatDuration } from './utils/pool-manager';

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

  protected constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {}
  ) {
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
   * This default implementation calls all monitoring methods in parallel
   * Subclasses can override for optimized implementations
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

    // Fetch core data in parallel
    const [overview, performance, slowQueries, activeSessions] = await Promise.all([
      this.getOverview(),
      this.getPerformanceMetrics(),
      this.getSlowQueries({ limit: slowQueryLimit }),
      this.getActiveSessions({ limit: sessionLimit }),
    ]);

    const result: MonitoringData = {
      timestamp: new Date(),
      overview,
      performance,
      slowQueries,
      activeSessions,
    };

    // Fetch optional data in parallel
    const optionalPromises: Promise<void>[] = [];

    if (includeTables) {
      optionalPromises.push(
        this.getTableStats({ schema: schemaFilter }).then((tables) => {
          result.tables = tables;
        })
      );
    }

    if (includeIndexes) {
      optionalPromises.push(
        this.getIndexStats({ schema: schemaFilter }).then((indexes) => {
          result.indexes = indexes;
        })
      );
    }

    if (includeStorage) {
      optionalPromises.push(
        this.getStorageStats().then((storage) => {
          result.storage = storage;
        })
      );
    }

    await Promise.all(optionalPromises);

    return result;
  }

  public validate(): void {
    if (!this.config.id) {
      throw new DatabaseConfigError('Connection ID is required', this.type);
    }

    if (!this.config.type) {
      throw new DatabaseConfigError('Database type is required', this.type);
    }

    // Subclasses should override for provider-specific validation
  }

  // ============================================================================
  // Protected Helpers
  // ============================================================================

  /**
   * Ensure provider is connected before operation
   */
  protected ensureConnected(): void {
    if (!this.state.connected) {
      throw new DatabaseConfigError(
        'Provider is not connected. Call connect() first.',
        this.type
      );
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
  protected async measureExecution<T>(
    fn: () => Promise<T>
  ): Promise<{ result: T; executionTime: number }> {
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
    console.error(
      `[DB:${this.type}] ${operation} failed:`,
      errorMessage,
      this.getSafeConfig()
    );
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
   */
  protected getConnectionInfo(): string {
    if (this.config.connectionString) {
      // Mask password in connection string
      return this.config.connectionString.replace(/:([^:@]+)@/, ':***@');
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
