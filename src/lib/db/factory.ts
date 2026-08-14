/**
 * Database Provider Factory
 * Creates appropriate provider instance based on connection type
 * Uses dynamic imports to reduce memory footprint - providers are loaded on demand
 */

import {
  type DatabaseProvider,
  type DatabaseConnection,
  type ProviderOptions,
  type ProviderExecutionContext,
} from "./types";
import { DatabaseConfigError, ExecutionProfileError } from "./errors";
import { createSSHTunnel, closeSSHTunnel, hasTunnel } from "@/lib/ssh/tunnel";
import { readSecret } from "@/lib/storage/encryption";
import { logger } from "@/lib/logger";

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create a database provider based on connection configuration
 * Uses dynamic imports to load providers on-demand, reducing initial memory usage
 *
 * @param connection - Database connection configuration
 * @param options - Optional provider options (pooling, timeout, etc.)
 * @param execution - Server-injected execution context (#328). Never built
 *   from caller-supplied options; only acquireExecutionProfileProvider passes
 *   it. Providers whose read-only boundary is established at OPEN time read it
 *   (SQLite); the rest establish theirs per statement and ignore it.
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
  options: ProviderOptions = {},
  execution: ProviderExecutionContext = {},
): Promise<DatabaseProvider> {
  // Sanitize user-controlled values to prevent log injection
  const sanitize = (v: string) => v.replace(/[\r\n]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  console.log(`[DB] Creating ${sanitize(connection.type)} provider for "${sanitize(connection.name || "")}"`);

  switch (connection.type) {
    // SQL Databases - dynamically imported to reduce memory
    case "postgres": {
      const { PostgresProvider } = await import("./providers/sql/postgres");
      return new PostgresProvider(connection, options, execution);
    }

    case "mysql": {
      const { MySQLProvider } = await import("./providers/sql/mysql");
      return new MySQLProvider(connection, options);
    }

    case "sqlite": {
      const { SQLiteProvider } = await import("./providers/sql/sqlite");
      return new SQLiteProvider(connection, options, execution);
    }

    case "oracle": {
      const { OracleProvider } = await import("./providers/sql/oracle");
      return new OracleProvider(connection, options);
    }

    case "mssql": {
      const { MSSQLProvider } = await import("./providers/sql/mssql");
      return new MSSQLProvider(connection, options);
    }

    case "clickhouse": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { ClickHouseProvider } = await import("./providers/sql/clickhouse/index");
      return new ClickHouseProvider(connection, options);
    }

    case "druid": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { DruidProvider } = await import("./providers/sql/druid/index");
      return new DruidProvider(connection, options);
    }

    // Document Databases - dynamically imported
    case "mongodb": {
      const { MongoDBProvider } = await import("./providers/document/mongodb");
      return new MongoDBProvider(connection, options);
    }

    case "couchbase": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { CouchbaseProvider } = await import("./providers/document/couchbase/index");
      return new CouchbaseProvider(connection, options);
    }

    // Key-Value Stores - dynamically imported
    case "redis": {
      const { RedisProvider } = await import("./providers/keyvalue/redis");
      return new RedisProvider(connection, options);
    }

    // Embedded databases - dynamically imported
    case "libredb": {
      const { LibreDBProvider } = await import("./providers/embedded/libredb");
      return new LibreDBProvider(connection, options);
    }

    default:
      throw new DatabaseConfigError(
        `Unknown database type: ${connection.type}. Supported types: postgres, mysql, sqlite, oracle, mssql, clickhouse, druid, mongodb, couchbase, redis, libredb`,
        connection.type,
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

// ============================================================================
// Execution-profile provider cache (#328)
// ----------------------------------------------------------------------------
// Physically separate from providerCache on purpose: an agent acquisition must
// be able to prove it never read from nor wrote to the shared writable cache.
// Keyed by (connection id, execution profile).
// ============================================================================

interface ProfiledCachedProvider extends CachedProvider {
  connectionId: string;
}

const profiledProviderCache = new Map<string, ProfiledCachedProvider>();

function profiledCacheKey(connectionId: string, profile: ExecutionProfile): string {
  return `${profile}::${connectionId}`;
}

/** True when any provider — shared or profiled — still serves this connection. */
function connectionStillServed(connectionId: string): boolean {
  if (providerCache.has(connectionId)) return true;
  return Array.from(profiledProviderCache.values()).some((entry) => entry.connectionId === connectionId);
}

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
      // Close the shared tunnel only when nothing serves the connection
      // anymore — a live profiled provider still needs it.
      if (!connectionStillServed(id)) {
        try {
          await closeSSHTunnel(id);
        } catch {
          /* ignore */
        }
      }
      evicted++;
    }
  }

  // Profiled providers idle out on the same clock. The tunnel is shared per
  // connection id, so it is closed only once nothing serves that connection.
  for (const [key, entry] of profiledProviderCache) {
    if (now - entry.lastUsed >= maxIdleMs) {
      logger.info(`[DB] Evicting idle profiled provider: ${key}`);
      try {
        await entry.provider.disconnect();
      } catch (error) {
        logger.warn(`[DB] Error disconnecting idle profiled provider ${key}`, {
          connectionId: entry.connectionId,
          error: String(error),
        });
      }
      profiledProviderCache.delete(key);
      if (!connectionStillServed(entry.connectionId)) {
        try {
          await closeSSHTunnel(entry.connectionId);
        } catch {
          /* ignore */
        }
      }
      evicted++;
    }
  }

  // Stop sweeping if both caches are empty
  if (providerCache.size === 0 && profiledProviderCache.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  return evicted;
}

function startIdleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void evictIdleProviders();
  }, SWEEP_INTERVAL_MS);
  // Allow process to exit even if timer is running
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
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
  options: ProviderOptions = {},
): Promise<DatabaseProvider> {
  const cacheKey = connection.id;

  // Check cache
  const cached = providerCache.get(cacheKey);

  if (cached?.provider.isConnected()) {
    cached.lastUsed = Date.now();
    return cached.provider;
  }

  // If SSH tunnel is configured, create tunnel first and rewrite connection.
  // createSSHTunnel returns a pre-existing tunnel for the same connection id,
  // so remember whether this call actually created it — only a fresh tunnel
  // may be torn down on failure (a pre-existing one may still serve an
  // execution-profile provider).
  let effectiveConnection = connection;
  const tunnelPreexisted = hasTunnel(connection.id);
  let tunnel: Awaited<ReturnType<typeof createSSHTunnel>> | null = null;
  if (connection.sshTunnel?.enabled && connection.host && connection.port) {
    tunnel = await createSSHTunnel(connection.id, connection.sshTunnel, connection.host, connection.port);
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
    // Clean up a freshly created SSH tunnel if provider connect fails to prevent FD leak
    if (tunnel && !tunnelPreexisted) {
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

// ============================================================================
// Execution-profile provider acquisition (#328)
// ============================================================================

/**
 * The execution profiles this factory can vend. Two exist: `agent-read-only` for the
 * paths that send a model-authored statement, `agent-operations` for the curated
 * reading path that sends none. An unknown profile string is refused, never defaulted
 * (fail closed), and what each one means is stated once in `PROFILE_ACQUISITION`.
 */
export type ExecutionProfile = "agent-read-only" | "agent-operations";

/**
 * What a profile means at acquisition: the context the provider is opened under,
 * and whether the profile's calls go through `provider.queryReadOnly`.
 *
 * Single source of truth for the profile list, so a new profile cannot be accepted
 * without stating both. The second field is the engine gate, and it is a PROPERTY OF
 * THE PROFILE rather than of the factory: `agent-read-only` sends model-authored
 * statements, so it is served only where the engine itself can bound one, and only
 * `postgres.ts` and `sqlite.ts` implement that. `agent-operations` sends no statement
 * at all — it calls the curated reporting methods every provider implements — so
 * requiring a read-only STATEMENT path of it would refuse an engine over a capability
 * the profile never uses.
 *
 * What both profiles share is everything that makes the acquisition safe: the same
 * `readOnly: true` execution context (on PostgreSQL that still verifies the role is
 * unprivileged at open), the same `agentUser` credential resolution, and the same
 * profiled cache — so an operations run is never handed the editor's writable pool
 * either.
 */
interface ProfileAcquisition {
  readonly context: ProviderExecutionContext;
  /** Refuse the provider unless it exposes a database-native read-only statement path. */
  readonly requiresReadOnlyStatements: boolean;
}

const PROFILE_ACQUISITION: Record<ExecutionProfile, ProfileAcquisition> = {
  "agent-read-only": { context: { readOnly: true }, requiresReadOnlyStatements: true },
  "agent-operations": { context: { readOnly: true }, requiresReadOnlyStatements: false },
};

const EXECUTION_PROFILES: ReadonlySet<string> = new Set(Object.keys(PROFILE_ACQUISITION));

/**
 * Resolves the optional least-privilege agent credential from the connection
 * (the connection-secrets seam: `agentPassword` may arrive sealed and is
 * opened with readSecret). Fail closed on every misconfiguration:
 *
 * - both fields absent → null (the profile runs under the connection's own
 *   credentials, still inside the database-native read-only boundary);
 * - only one field present → deny; a half-configured credential must not
 *   silently degrade to the more privileged default;
 * - a sealed password that does not open → deny, never a plaintext fallback;
 * - combined with a connection string → deny: buildPoolConfig ignores
 *   user/password fields when a connection string is present, so the
 *   credential would be silently dropped and the agent would run as the more
 *   privileged embedded user.
 */
function resolveAgentCredential(connection: DatabaseConnection): { user: string; password: string } | null {
  const { agentUser, agentPassword } = connection;
  if (agentUser === undefined && agentPassword === undefined) return null;
  if (connection.connectionString) {
    throw new ExecutionProfileError(
      `Connection "${connection.id}" configures an agent credential alongside a connection string; the credential cannot be applied, so acquisition is refused`,
      "AGENT_CREDENTIAL_WITH_CONNECTION_STRING",
    );
  }
  if (!agentUser || !agentPassword) {
    throw new ExecutionProfileError(
      `Connection "${connection.id}" configures an incomplete agent credential (user and password are both required)`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
  const read = readSecret(agentPassword);
  if (read.kind === "undecryptable") {
    throw new ExecutionProfileError(
      `Connection "${connection.id}" configures an agent credential that cannot be resolved`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
  return { user: agentUser, password: read.value };
}

/**
 * Acquire a provider for (connection id, execution profile). Never touches
 * the shared writable cache in either direction: the profiled provider has
 * its own keyed lifecycle, so an agent execution can never be handed the
 * editor's fully-privileged pool, and an editor request can never be handed a
 * read-only one.
 *
 * Whether a provider without a database-native read-only wrapper is refused is the
 * PROFILE's decision, not this function's: under `agent-read-only` it is refused
 * rather than silently served `query()` (fail closed), and under `agent-operations`
 * it is served, because that profile sends no statement for a read-only wrapper to
 * bound. See `PROFILE_ACQUISITION` for the whole of that argument.
 */
export async function acquireExecutionProfileProvider(
  connection: DatabaseConnection,
  profile: ExecutionProfile,
  options: ProviderOptions = {},
): Promise<DatabaseProvider> {
  if (!EXECUTION_PROFILES.has(profile)) {
    throw new ExecutionProfileError(`Unknown execution profile: ${String(profile)}`, "UNSUPPORTED_PROFILE");
  }

  const cacheKey = profiledCacheKey(connection.id, profile);
  const cached = profiledProviderCache.get(cacheKey);
  if (cached?.provider.isConnected()) {
    cached.lastUsed = Date.now();
    return cached.provider;
  }

  const credential = resolveAgentCredential(connection);
  let effectiveConnection: DatabaseConnection = credential
    ? { ...connection, user: credential.user, password: credential.password }
    : connection;

  // The SSH tunnel is keyed by connection id and shared with the writable
  // provider (createSSHTunnel returns the existing one). Only a tunnel this
  // acquisition freshly created may be torn down on failure.
  const tunnelPreexisted = hasTunnel(connection.id);
  let tunnel: Awaited<ReturnType<typeof createSSHTunnel>> | null = null;
  if (connection.sshTunnel?.enabled && connection.host && connection.port) {
    tunnel = await createSSHTunnel(connection.id, connection.sshTunnel, connection.host, connection.port);
    effectiveConnection = { ...effectiveConnection, host: tunnel.localHost, port: tunnel.localPort };
  }

  const closeFreshTunnel = async () => {
    if (tunnel && !tunnelPreexisted) await tunnel.close().catch(() => {});
  };

  const acquisition = PROFILE_ACQUISITION[profile];
  const provider = await createDatabaseProvider(effectiveConnection, options, acquisition.context);
  if (acquisition.requiresReadOnlyStatements && typeof provider.queryReadOnly !== "function") {
    await closeFreshTunnel();
    throw new ExecutionProfileError(
      `Provider type "${connection.type}" has no database-native read-only execution profile`,
      "PROFILE_UNSUPPORTED_BY_PROVIDER",
    );
  }

  try {
    await provider.connect();
  } catch (error) {
    await closeFreshTunnel();
    throw error;
  }

  profiledProviderCache.set(cacheKey, { provider, lastUsed: Date.now(), connectionId: connection.id });
  startIdleSweep();

  return provider;
}

/**
 * Remove a provider from cache and disconnect. Also removes the connection's
 * execution-profile providers: a deleted or re-credentialed connection must
 * not leave a stale agent pool running under the old configuration.
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

  for (const [key, entry] of profiledProviderCache) {
    if (entry.connectionId !== connectionId) continue;
    try {
      await entry.provider.disconnect();
    } catch (error) {
      logger.warn(`Error disconnecting profiled provider ${key}`, { connectionId, error: String(error) });
    }
    profiledProviderCache.delete(key);
  }

  // Close SSH tunnel if exists
  try {
    await closeSSHTunnel(connectionId);
  } catch (error) {
    logger.warn(`Error closing SSH tunnel for ${connectionId}`, { connectionId, error: String(error) });
  }
}

/**
 * Clear all cached providers (shared and execution-profile)
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
      }),
    );
  }
  for (const [key, entry] of profiledProviderCache) {
    disconnectPromises.push(
      entry.provider.disconnect().catch((error) => {
        console.error(`[DB] Error disconnecting profiled provider ${key}:`, error);
      }),
    );
  }

  await Promise.all(disconnectPromises);
  providerCache.clear();
  profiledProviderCache.clear();
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

/**
 * Execution-profile cache statistics (observability for the isolation
 * invariant: agent acquisitions must never appear in getProviderCacheStats).
 */
export function getExecutionProfileCacheStats(): { size: number; connections: string[] } {
  return {
    size: profiledProviderCache.size,
    connections: Array.from(profiledProviderCache.values(), (entry) => entry.connectionId),
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
      logger.info("[DB] All database connections closed gracefully");
    } catch (error) {
      logger.error("[DB] Error during graceful shutdown", error, { route: "db/factory" });
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

// Auto-register on server-side (not during tests)
if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
  registerShutdownHandlers();
}
