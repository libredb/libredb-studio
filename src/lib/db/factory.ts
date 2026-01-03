/**
 * Database Provider Factory
 * Creates appropriate provider instance based on connection type
 * Uses dynamic imports to reduce memory footprint - providers are loaded on demand
 */

import {
  type DatabaseProvider,
  type DatabaseConnection,
  type ProviderOptions,
} from "./types";
import { DatabaseConfigError } from "./errors";

// Only Demo Provider is imported statically (no native dependencies)
import { DemoProvider } from "./providers/demo";

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
  console.log(
    `[DB] Creating ${connection.type} provider for "${connection.name}"`
  );

  switch (connection.type) {
    // SQL Databases - dynamically imported to reduce memory
    case "postgres": {
      const { PostgresProvider } = await import("./providers/sql/postgres");
      return new PostgresProvider(connection, options);
    }

    case "mysql": {
      const { MySQLProvider } = await import("./providers/sql/mysql");
      return new MySQLProvider(connection, options);
    }

    case "sqlite": {
      const { SQLiteProvider } = await import("./providers/sql/sqlite");
      return new SQLiteProvider(connection, options);
    }

    // Document Databases - dynamically imported
    case "mongodb": {
      const { MongoDBProvider } = await import("./providers/document/mongodb");
      return new MongoDBProvider(connection, options);
    }

    // Key-Value Databases - dynamically imported
    case "redis": {
      const { RedisProvider } = await import("./providers/keyvalue/redis");
      return new RedisProvider(connection, options);
    }

    // Demo Mode - no native dependencies, statically imported
    case "demo":
      return new DemoProvider(connection, options);

    default:
      throw new DatabaseConfigError(
        `Unknown database type: ${connection.type}. Supported types: postgres, mysql, sqlite, mongodb, redis, demo`,
        connection.type
      );
  }
}

// ============================================================================
// Provider Cache (for connection reuse)
// ============================================================================

const providerCache = new Map<string, DatabaseProvider>();

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
  let provider = providerCache.get(cacheKey);

  if (provider && provider.isConnected()) {
    return provider;
  }

  // Create new provider (async - dynamically loads the provider module)
  provider = await createDatabaseProvider(connection, options);
  await provider.connect();

  // Cache it
  providerCache.set(cacheKey, provider);

  return provider;
}

/**
 * Remove a provider from cache and disconnect
 */
export async function removeProvider(connectionId: string): Promise<void> {
  const provider = providerCache.get(connectionId);

  if (provider) {
    try {
      await provider.disconnect();
    } catch (error) {
      console.error(
        `[DB] Error disconnecting provider ${connectionId}:`,
        error
      );
    }
    providerCache.delete(connectionId);
  }
}

/**
 * Clear all cached providers
 */
export async function clearProviderCache(): Promise<void> {
  const disconnectPromises: Promise<void>[] = [];

  for (const [id, provider] of providerCache) {
    disconnectPromises.push(
      provider.disconnect().catch((error) => {
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
export function getProviderCacheStats(): {
  size: number;
  connections: string[];
} {
  return {
    size: providerCache.size,
    connections: Array.from(providerCache.keys()),
  };
}
