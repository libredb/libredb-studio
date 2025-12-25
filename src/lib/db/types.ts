/**
 * Database Provider Types & Interfaces
 * Strategy Pattern implementation for multi-database support
 */

// Re-export common types from main types file
export type {
  DatabaseType,
  DatabaseConnection,
  TableSchema,
  ColumnSchema,
  IndexSchema,
  ForeignKeySchema,
  QueryResult,
} from '../types';

import type {
  DatabaseType,
  DatabaseConnection,
  TableSchema,
  QueryResult,
} from '../types';

// ============================================================================
// Pool Configuration
// ============================================================================

export interface PoolConfig {
  /** Minimum number of connections in pool (default: 2) */
  min: number;
  /** Maximum number of connections in pool (default: 10) */
  max: number;
  /** Close idle connections after this time in ms (default: 30000) */
  idleTimeout: number;
  /** Wait for connection timeout in ms (default: 60000) */
  acquireTimeout: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 2,
  max: 10,
  idleTimeout: 30000,
  acquireTimeout: 60000,
};

/** Query timeout in milliseconds (default: 60 seconds) */
export const DEFAULT_QUERY_TIMEOUT = 60000;

// ============================================================================
// Health Information
// ============================================================================

export interface SlowQuery {
  query: string;
  calls: number;
  avgTime: string;
}

export interface ActiveSession {
  pid: number | string;
  user: string;
  database: string;
  state: string;
  query: string;
  duration: string;
}

export interface HealthInfo {
  activeConnections: number;
  databaseSize: string;
  cacheHitRatio: string;
  slowQueries: SlowQuery[];
  activeSessions: ActiveSession[];
}

// ============================================================================
// Maintenance Operations
// ============================================================================

export type MaintenanceType = 'vacuum' | 'analyze' | 'reindex' | 'kill' | 'optimize' | 'check';

export interface MaintenanceResult {
  success: boolean;
  executionTime: number;
  message: string;
}

// ============================================================================
// Provider Interface (Strategy Pattern)
// ============================================================================

export interface DatabaseProvider {
  /** Database type identifier */
  readonly type: DatabaseType;

  /** Connection configuration */
  readonly config: DatabaseConnection;

  /**
   * Initialize connection pool or single connection
   */
  connect(): Promise<void>;

  /**
   * Close all connections and cleanup resources
   */
  disconnect(): Promise<void>;

  /**
   * Check if provider is currently connected
   */
  isConnected(): boolean;

  /**
   * Execute a SQL query
   * @param sql - SQL query string
   * @param params - Optional query parameters for prepared statements
   * @returns Query result with rows, fields, and execution time
   */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  /**
   * Get full database schema
   * @returns Array of table schemas with columns, indexes, and foreign keys
   */
  getSchema(): Promise<TableSchema[]>;

  /**
   * Get list of table names
   */
  getTables(): Promise<string[]>;

  /**
   * Get health and performance metrics
   */
  getHealth(): Promise<HealthInfo>;

  /**
   * Get comprehensive monitoring data
   * @param options - What to include in the monitoring data
   */
  getMonitoringData(options?: MonitoringOptions): Promise<MonitoringData>;

  /**
   * Get database overview metrics
   */
  getOverview(): Promise<DatabaseOverview>;

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): Promise<PerformanceMetrics>;

  /**
   * Get slow query statistics
   * @param options - Query options (limit)
   */
  getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]>;

  /**
   * Get active sessions with details
   * @param options - Query options (limit)
   */
  getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]>;

  /**
   * Get table statistics
   * @param options - Query options (schema filter)
   */
  getTableStats(options?: { schema?: string }): Promise<TableStats[]>;

  /**
   * Get index statistics
   * @param options - Query options (schema filter)
   */
  getIndexStats(options?: { schema?: string }): Promise<IndexStats[]>;

  /**
   * Get storage/tablespace statistics
   */
  getStorageStats(): Promise<StorageStats[]>;

  /**
   * Run maintenance operations
   * @param type - Type of maintenance operation
   * @param target - Optional target (table name or process ID)
   */
  runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult>;

  /**
   * Validate provider configuration
   * @throws DatabaseConfigError if configuration is invalid
   */
  validate(): void;
}

// ============================================================================
// Provider Configuration Options
// ============================================================================

export interface ProviderOptions {
  /** Connection pool configuration */
  pool?: Partial<PoolConfig>;
  /** Query timeout in milliseconds */
  queryTimeout?: number;
  /** Enable SSL/TLS connection */
  ssl?: boolean | { rejectUnauthorized: boolean };
  /** Connection timezone */
  timezone?: string;
}

// ============================================================================
// Internal Types
// ============================================================================

export interface ConnectionState {
  connected: boolean;
  lastConnected?: Date;
  lastError?: Error;
  activeQueries: number;
}

// ============================================================================
// Monitoring Types (Extended)
// ============================================================================

/**
 * Database overview metrics
 */
export interface DatabaseOverview {
  version: string;
  uptime: string;
  startTime?: Date;
  activeConnections: number;
  maxConnections: number;
  databaseSize: string;
  databaseSizeBytes: number;
  tableCount: number;
  indexCount: number;
}

/**
 * Performance metrics for the database
 */
export interface PerformanceMetrics {
  /** Cache hit ratio as percentage (0-100) */
  cacheHitRatio: number;
  /** Transactions per second */
  transactionsPerSecond?: number;
  /** Queries per second */
  queriesPerSecond?: number;
  /** Buffer pool usage as percentage (0-100) */
  bufferPoolUsage?: number;
  /** Number of deadlocks */
  deadlocks?: number;
  /** Checkpoint write time */
  checkpointWriteTime?: string;
}

/**
 * Slow query with detailed statistics
 */
export interface SlowQueryStats {
  queryId?: string;
  query: string;
  calls: number;
  totalTime: number;
  avgTime: number;
  minTime?: number;
  maxTime?: number;
  rows: number;
  sharedBlksHit?: number;
  sharedBlksRead?: number;
}

/**
 * Active session with detailed information
 */
export interface ActiveSessionDetails {
  pid: number | string;
  user: string;
  database: string;
  applicationName?: string;
  clientAddr?: string;
  state: string;
  query: string;
  queryStart?: Date;
  duration: string;
  durationMs: number;
  waitEventType?: string;
  waitEvent?: string;
  blocked?: boolean;
}

/**
 * Table statistics
 */
export interface TableStats {
  schemaName: string;
  tableName: string;
  rowCount: number;
  liveRowCount?: number;
  deadRowCount?: number;
  tableSize: string;
  tableSizeBytes: number;
  indexSize?: string;
  indexSizeBytes?: number;
  totalSize: string;
  totalSizeBytes: number;
  lastVacuum?: Date;
  lastAnalyze?: Date;
  bloatRatio?: number;
}

/**
 * Index statistics
 */
export interface IndexStats {
  schemaName: string;
  tableName: string;
  indexName: string;
  indexType?: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  indexSize: string;
  indexSizeBytes: number;
  scans: number;
  usageRatio?: number;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  name: string;
  location?: string;
  size: string;
  sizeBytes: number;
  usagePercent?: number;
  walSize?: string;
  walSizeBytes?: number;
}

/**
 * Comprehensive monitoring data combining all metrics
 */
export interface MonitoringData {
  timestamp: Date;
  overview: DatabaseOverview;
  performance: PerformanceMetrics;
  slowQueries: SlowQueryStats[];
  activeSessions: ActiveSessionDetails[];
  tables?: TableStats[];
  indexes?: IndexStats[];
  storage?: StorageStats[];
}

/**
 * Options for monitoring queries
 */
export interface MonitoringOptions {
  /** Include table statistics */
  includeTables?: boolean;
  /** Include index statistics */
  includeIndexes?: boolean;
  /** Include storage/tablespace info */
  includeStorage?: boolean;
  /** Limit for slow queries (default: 10) */
  slowQueryLimit?: number;
  /** Limit for active sessions (default: 50) */
  sessionLimit?: number;
  /** Schema filter (default: 'public' for PostgreSQL) */
  schemaFilter?: string;
}
