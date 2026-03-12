/**
 * Database Provider Module
 * Strategy Pattern implementation for multi-database support
 *
 * @example
 * import { createDatabaseProvider, getOrCreateProvider } from '@/lib/db';
 *
 * // Create a provider directly
 * const provider = createDatabaseProvider(connection);
 * await provider.connect();
 * const result = await provider.query('SELECT * FROM users');
 * await provider.disconnect();
 *
 * // Or use cached provider (recommended for API routes)
 * const provider = await getOrCreateProvider(connection);
 * const result = await provider.query('SELECT * FROM users');
 */

// ============================================================================
// Factory (Primary API)
// ============================================================================

export {
  createDatabaseProvider,
  getOrCreateProvider,
  removeProvider,
  clearProviderCache,
  getProviderCacheStats,
  registerShutdownHandlers,
} from './factory';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type {
  DatabaseType,
  DatabaseConnection,
  DatabaseProvider,
  TableSchema,
  ColumnSchema,
  IndexSchema,
  ForeignKeySchema,
  QueryResult,
  HealthInfo,
  SlowQuery,
  ActiveSession,
  MaintenanceType,
  MaintenanceResult,
  PoolConfig,
  ProviderOptions,
  ConnectionState,
  ProviderCapabilities,
  ProviderLabels,
  PreparedQuery,
  QueryPrepareOptions,
} from './types';

export {
  DEFAULT_POOL_CONFIG,
  DEFAULT_QUERY_TIMEOUT,
} from './types';

// ============================================================================
// Error Classes
// ============================================================================

export {
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryError,
  QueryCancelledError,
  TimeoutError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isQueryCancelledError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from './errors';

// ============================================================================
// Base Provider (for extension)
// ============================================================================

export { BaseDatabaseProvider } from './base-provider';
export { DemoProvider } from './providers/demo';

// ============================================================================
// Provider Classes (Lazy Loaded)
// ============================================================================
// NOTE: Individual providers are NOT exported statically to reduce memory usage.
// They are dynamically imported when needed via createDatabaseProvider().
//
// If you need direct access to a provider class, import it explicitly:
//   import { PostgresProvider } from '@/lib/db/providers/sql/postgres';
//   import { MySQLProvider } from '@/lib/db/providers/sql/mysql';
//   import { SQLiteProvider } from '@/lib/db/providers/sql/sqlite';
//   import { MongoDBProvider } from '@/lib/db/providers/document/mongodb';
//   import { SQLBaseProvider } from '@/lib/db/providers/sql/sql-base';
// ============================================================================

// ============================================================================
// Utilities
// ============================================================================

export {
  withTimeout,
  withRetry,
  escapeIdentifier,
  formatBytes,
  formatDuration,
  mergePoolConfig,
  validatePoolConfig,
  type PoolStats,
  type PoolManager,
  type RetryOptions,
} from './utils/pool-manager';
