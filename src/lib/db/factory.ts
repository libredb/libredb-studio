/**
 * Database Provider Factory
 * Creates appropriate provider instance based on connection type
 * Uses dynamic imports to reduce memory footprint - providers are loaded on demand
 */

import {
  type DatabaseProvider,
  type DatabaseConnection,
  type ProviderOptions,
} from './types';
import { DatabaseConfigError } from './errors';
import { createSSHTunnel, closeSSHTunnel } from '@/lib/ssh/tunnel';
import { logger } from '@/lib/logger';

// Only Demo Provider is imported statically (no native dependencies)
import { DemoProvider } from './providers/demo';

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create a database provider based on connection configuration
 * Uses dynamic imports to load providers on-demand, reducing initial memory usage
 *
 * @param connection - Database connection configuration
 * @param options - Optional provider options (pooling, timeout, etc.)
 * @returns Promise<DatabaseProvider> instance
 * @throws DatabaseConfigError if connection type is not supported
 *
 * @example
 * // SQL Database
 * const provider = await createDatabaseProvider({
 *   id: '1',
 *   name: 'My PostgreSQL',
 *   type: 'postgres',
 *   host: 'localhost',
 *   port: 5432,
 *   database: 'mydb',
 *   user: 'admin',
 *   password: 'secret',
 *   createdAt: new Date(),
 * });
 *
 * // MongoDB
 * const mongoProvider = await createDatabaseProvider({
 *   id: '2',
 *   name: 'My MongoDB',
 *   type: 'mongodb',
 *   connectionString: 'mongodb://localhost:27017/mydb',
 *   createdAt: new Date(),
 * });
 *
 * await provider.connect();
 * const result = await provider.query('SELECT * FROM users');
 * await provider.disconnect();
 */
export async function createDatabaseProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {}
): Promise<DatabaseProvider> {
  // Sanitize user-controlled values to prevent log injection
  const safeName = (connection.name || '').replace(/[\r\n]/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  console.log(`[DB] Creating ${connection.type} provider for "${safeName}"`);

  switch (connection.type) {
    // SQL Databases - dynamically imported to reduce memory
    case 'postgres': {
      const { PostgresProvider } = await import('./providers/sql/postgres');
      return new PostgresProvider(connection, options);
    }

    case 'mysql': {
      const { MySQLProvider } = await import('./providers/sql/mysql');
      return new MySQLProvider(connection, options);
    }

    case 'sqlite': {
      const { SQLiteProvider } = await import('./providers/sql/sqlite');
      return new SQLiteProvider(connection, options);
    }

    case 'oracle': {
      const { OracleProvider } = await import('./providers/sql/oracle');
      return new OracleProvider(connection, options);
    }

    case 'mssql': {
      const { MSSQLProvider } = await import('./providers/sql/mssql');
      return new MSSQLProvider(connection, options);
    }

    // Document Databases - dynamically imported
    case 'mongodb': {
      const { MongoDBProvider } = await import('./providers/document/mongodb');
      return new MongoDBProvider(connection, options);
    }

    // Demo Mode - no native dependencies, statically imported
    case 'demo':
      return new DemoProvider(connection, options);

    // Key-Value Stores - dynamically imported
    case 'redis': {
      const { RedisProvider } = await import('./providers/keyvalue/redis');
      return new RedisProvider(connection, options);
    }

    default:
      throw new DatabaseConfigError(
        `Unknown database type: ${connection.type}. Supported types: postgres, mysql, sqlite, oracle, mssql, mongodb, redis, demo`,
        connection.type
      );
  }
}

// ============================================================================
// Provider Cache (for connection reuse)
// ============================================================================

interface CachedProvider {
  provider: DatabaseProvider;
  lastUsed: number;
}

const providerCache = new Map<string, CachedProvider>();

/** Idle timeout: evict providers unused for 30 minutes */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Sweep interval: check for idle providers every 5 minutes */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Evict providers that have been idle longer than maxIdleMs.
 * Called by the periodic sweep timer, but also exported for direct testing.
 *
 * @returns number of evicted providers
 */
export async function evictIdleProviders(maxIdleMs: number = IDLE_TIMEOUT_MS): Promise<number> {
  const now = Date.now();
  let evicted = 0;

  for (const [id, entry] of providerCache) {
    if (now - entry.lastUsed >= maxIdleMs) {
      logger.info(`[DB] Evicting idle provider: ${id} (idle ${Math.round((now - entry.lastUsed) / 60000)}min)`);
      try {
        await entry.provider.disconnect();
      } catch (error) {
        logger.warn(`[DB] Error disconnecting idle provider ${id}`, { connectionId: id, error: String(error) });
      }
      providerCache.delete(id);
      // Also close SSH tunnel
      try {
        await closeSSHTunnel(id);
      } catch { /* ignore */ }
      evicted++;
    }
  }

  // Stop sweeping if cache is empty
  if (providerCache.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  return evicted;
}

function startIdleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { evictIdleProviders(); }, SWEEP_INTERVAL_MS);
  // Allow process to exit even if timer is running
  if (sweepTimer && typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
    sweepTimer.unref();
  }
}

/**
 * Get or create a database provider with caching
 * Useful for API routes to reuse connections
 *
 * @param connection - Database connection configuration
 * @param options - Optional provider options
 * @returns Cached or new DatabaseProvider instance
 */
export async function getOrCreateProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {}
): Promise<DatabaseProvider> {
  const cacheKey = connection.id;

  // Check cache
  const cached = providerCache.get(cacheKey);

  if (cached?.provider.isConnected()) {
    cached.lastUsed = Date.now();
    return cached.provider;
  }

  // If SSH tunnel is configured, create tunnel first and rewrite connection
  let effectiveConnection = connection;
  let tunnel: Awaited<ReturnType<typeof createSSHTunnel>> | null = null;
  if (connection.sshTunnel?.enabled && connection.host && connection.port) {
    tunnel = await createSSHTunnel(
      connection.id,
      connection.sshTunnel,
      connection.host,
      connection.port
    );
    // Rewrite connection to point to local tunnel endpoint
    effectiveConnection = {
      ...connection,
      host: tunnel.localHost,
      port: tunnel.localPort,
    };
  }

  // Create new provider (async - dynamically loads the provider module)
  const provider = await createDatabaseProvider(effectiveConnection, options);
  try {
    await provider.connect();
  } catch (error) {
    // Clean up SSH tunnel if provider connect fails to prevent FD leak
    if (tunnel) {
      await tunnel.close().catch(() => {});
    }
    throw error;
  }

  // Cache it
  providerCache.set(cacheKey, { provider, lastUsed: Date.now() });

  // Start idle sweep if not already running
  startIdleSweep();

  return provider;
}

/**
 * Remove a provider from cache and disconnect
 */
export async function removeProvider(connectionId: string): Promise<void> {
  const cached = providerCache.get(connectionId);

  if (cached) {
    try {
      await cached.provider.disconnect();
    } catch (error) {
      logger.warn(`Error disconnecting provider ${connectionId}`, { connectionId, error: String(error) });
    }
    providerCache.delete(connectionId);
  }

  // Close SSH tunnel if exists
  try {
    await closeSSHTunnel(connectionId);
  } catch (error) {
    logger.warn(`Error closing SSH tunnel for ${connectionId}`, { connectionId, error: String(error) });
  }
}

/**
 * Clear all cached providers
 */
export async function clearProviderCache(): Promise<void> {
  // Stop idle sweep
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  const disconnectPromises: Promise<void>[] = [];

  for (const [id, entry] of providerCache) {
    disconnectPromises.push(
      entry.provider.disconnect().catch((error) => {
        console.error(`[DB] Error disconnecting provider ${id}:`, error);
      })
    );
  }

  await Promise.all(disconnectPromises);
  providerCache.clear();
}

/**
 * Get cache statistics
 */
export function getProviderCacheStats(): { size: number; connections: string[] } {
  return {
    size: providerCache.size,
    connections: Array.from(providerCache.keys()),
  };
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

let shutdownRegistered = false;

/**
 * Register process signal handlers for graceful shutdown.
 * Safe to call multiple times — handlers are only registered once.
 */
export function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = async (signal: string) => {
    logger.info(`[DB] Received ${signal}, closing all database connections...`);
    try {
      await clearProviderCache();
      logger.info('[DB] All database connections closed gracefully');
    } catch (error) {
      logger.error('[DB] Error during graceful shutdown', { error: String(error) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Auto-register on server-side (not during tests)
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
  registerShutdownHandlers();
}
