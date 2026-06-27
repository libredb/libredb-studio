/**
 * Database Provider Module
 * Strategy Pattern implementation for multi-database support
 *
 * @example
 * import { getOrCreateProvider } from '@/lib/db';
 *
 * // Use cached provider (recommended for API routes)
 * const provider = await getOrCreateProvider(connection);
 * const result = await provider.query('SELECT * FROM users');
 */

// ============================================================================
// Factory (Primary API)
// ============================================================================

export { getOrCreateProvider } from "./factory";

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
} from "./types";

// ============================================================================
// Utilities
// ============================================================================

export { type RetryOptions } from "./utils/pool-manager";
