/**
 * Database Provider Factory
 * Creates appropriate provider instance based on connection type
 * Uses dynamic imports to reduce memory footprint - providers are loaded on demand
 */

import {
  type DatabaseProvider,
  type DatabaseConnection,
  type EditorExecutionContext,
  type ProviderOptions,
  type ProviderExecutionContext,
} from "./types";
import { DatabaseConfigError, ExecutionProfileError } from "./errors";
import { createSSHTunnel, closeSSHTunnel, hasTunnel } from "@/lib/ssh/tunnel";
import type { TunnelInfo } from "@/lib/ssh/tunnel";
import { readSecret } from "@/lib/storage/encryption";
import { providerCacheKey } from "./provider-cache-key";
import { READ_ONLY_ENFORCED, READS_FILE_ACCESS_POSTURE } from "./compatibility";
import { TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { logger } from "@/lib/logger";
import * as path from "path";

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create a database provider based on connection configuration
 * Uses dynamic imports to load providers on-demand, reducing initial memory usage
 *
 * @param connection - Database connection configuration
 * @param options - Optional provider options (pooling, timeout, etc.)
 * @param execution - Server-injected execution context (#328, non-admin DuckDB file access). Never built
 *   from caller-supplied options. `acquireExecutionProfileProvider` passes the agent
 *   profile's context, and `getOrCreateProvider` and the routes that build their own
 *   provider pass the editor file-access posture `editorExecutionContext` derived from
 *   the verified session and the resolved connection. Providers whose read-only boundary
 *   is established at OPEN time read `readOnly` (SQLite); DuckDB additionally reads
 *   `allowExternalFileAccess` on its editor handle; the rest establish theirs per
 *   statement and ignore both. ABSENT MEANS DENY: called without a context, as an
 *   embedder that predates the posture calls it, a DuckDB handle opens with
 *   `enable_external_access: 'false'`, so `read_csv`, `COPY`, `ATTACH` of a file and
 *   `INSTALL` are refused while the database stays writable; pass
 *   `{ allowExternalFileAccess: true }` for the full editor reach.
 * @returns Promise<DatabaseProvider> instance
 * @throws DatabaseConfigError if connection type is not supported, or if its `readOnly` cannot be
 *   honoured (see assertReadOnlyHonoured)
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
/**
 * Strip the control characters a log line's framing is made of, so a caller-supplied value
 * cannot write a line of its own.
 *
 * Hoisted out of `createDatabaseProvider`, where it guarded `type` and `name`, once
 * `connection.id` was established to be caller-supplied too (GHSA-3wh2-8x78-jfw4 - see
 * {@link providerCacheKey}). Every site below that INTERPOLATES an id into a message uses it;
 * the ids passed as structured logger FIELDS do not need it, because a field is never parsed
 * as part of the line.
 */
const sanitize = (v: string) => v.replace(/[\r\n]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/**
 * Refuse a `readOnly` this connection's engine cannot keep, before anything is built or dialled (#1089).
 *
 * A read-only connection is a promise its provider keeps by refusing every write before any request,
 * so it is accepted only on an engine `READ_ONLY_ENFORCED` names. Anywhere else the connection would
 * open able to write under a mode that says it cannot, which is refused rather than ignored. A value
 * that is not a boolean is refused on every engine, because a string read as true on one path and as
 * absent on another is two modes. The message names the field and never echoes the value.
 *
 * It reads the static map rather than `getCapabilities()` because it runs before a provider exists,
 * and `tests/unit/db/read-only-enforced-capability.test.ts` holds the map equal to every provider's
 * `enforcesReadOnly`.
 *
 * WHERE IT RUNS. The first statement of `createDatabaseProvider` and `withOneShotTunnel`, and of
 * `getOrCreateProvider` and `acquireExecutionProfileProvider`, ahead of their cache lookup and of
 * `createSSHTunnel`: those two open the tunnel before they call `createDatabaseProvider`, outside the
 * try that closes a fresh one, so a refusal raised only inside the factory would dial the bastion and
 * leave the pooled tunnel open. Ahead of the lookup too, because a mode that is not a boolean keys as
 * `read-write` (`providerCacheKey`), so the lookup would hand it the connection's cached read-write
 * provider without refusing it. Exported for the tests; the published factory's three entry points
 * raise it (`src/exports/providers.ts`).
 */
export function assertReadOnlyHonoured(connection: DatabaseConnection): void {
  const readOnly: unknown = connection.readOnly;
  if (readOnly === undefined) return;
  if (typeof readOnly !== "boolean") {
    throw new DatabaseConfigError("readOnly must be true or false.", connection.type);
  }
  if (readOnly && READ_ONLY_ENFORCED[connection.type] !== true) {
    throw new DatabaseConfigError(
      `readOnly: true is refused for ${sanitize(connection.type)}: its provider does not enforce a read-only mode, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`,
      connection.type,
    );
  }
}

export async function createDatabaseProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {},
  execution: ProviderExecutionContext = {},
): Promise<DatabaseProvider> {
  assertReadOnlyHonoured(connection);
  console.log(`[DB] Creating ${sanitize(connection.type)} provider for "${sanitize(connection.name || "")}"`);

  // Explicit overrides (such as the connectivity probe) take precedence over saved settings.
  options = { ...options, queryTimeout: options.queryTimeout ?? connection.queryTimeout };

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

    case "duckdb": {
      const { DuckDBProvider } = await import("./providers/sql/duckdb");
      return new DuckDBProvider(connection, options, execution);
    }

    case "libsql": {
      const { LibSQLProvider } = await import("./providers/sql/libsql");
      return new LibSQLProvider(connection, options);
    }

    case "oracle": {
      const { OracleProvider } = await import("./providers/sql/oracle");
      return new OracleProvider(connection, options);
    }

    case "db2": {
      const { Db2Provider } = await import("./providers/sql/db2/index");
      return new Db2Provider(connection, options);
    }

    case "mssql": {
      const { MSSQLProvider } = await import("./providers/sql/mssql");
      return new MSSQLProvider(connection, options, execution);
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

    case "trino": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { TrinoProvider } = await import("./providers/sql/trino/index");
      return new TrinoProvider(connection, options);
    }

    case "cassandra": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { CassandraProvider } = await import("./providers/sql/cassandra/index");
      return new CassandraProvider(connection, options);
    }

    // Search engines - two type-ids, ONE implementation module (issue #424 Phase 1).
    // The explicit /index specifier keeps this dynamic import statically
    // analysable: a bare directory resolves only at runtime, which the bundler
    // cannot trace into a chunk.
    case "elasticsearch": {
      const { ElasticsearchProvider } = await import("./providers/sql/search/index");
      return new ElasticsearchProvider(connection, options);
    }

    case "opensearch": {
      const { OpenSearchProvider } = await import("./providers/sql/search/index");
      return new OpenSearchProvider(connection, options);
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

    case "etcd": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The
      // execution context rides along, so an execution profile opens it read-only (#1089 E6).
      const { EtcdProvider } = await import("./providers/keyvalue/etcd/index");
      return new EtcdProvider(connection, options, execution);
    }

    case "oxia": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context rides
      // along, so a refusal names the read-only mode an execution profile set (O1).
      const { OxiaProvider } = await import("./providers/keyvalue/oxia/index");
      return new OxiaProvider(connection, options, execution);
    }

    // Time-series stores - dynamically imported
    case "prometheus": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { PrometheusProvider } = await import("./providers/timeseries/prometheus/index");
      return new PrometheusProvider(connection, options);
    }

    // Two type-ids served by one directory, one per query language (InfluxDB spec I2, I23). Both are read-only
    // whatever the flag says, so no execution context rides along, as for Neo4j.
    case "influxdb": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { InfluxDBProvider } = await import("./providers/timeseries/influxdb/index");
      return new InfluxDBProvider(connection, options);
    }

    case "influxdb3": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { InfluxDB3Provider } = await import("./providers/timeseries/influxdb/index");
      return new InfluxDB3Provider(connection, options);
    }

    // Message logs - dynamically imported
    case "kafka": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { KafkaProvider } = await import("./providers/stream/kafka/index");
      return new KafkaProvider(connection, options);
    }

    // Graph databases - dynamically imported
    case "neo4j": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { Neo4jProvider } = await import("./providers/graph/neo4j/index");
      return new Neo4jProvider(connection, options);
    }

    // Vector databases - dynamically imported
    case "milvus": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context
      // rides along, so an execution profile opens it read-only (vector-family spec E8).
      const { MilvusProvider } = await import("./providers/vector/milvus/index");
      return new MilvusProvider(connection, options, execution);
    }

    case "qdrant": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context
      // rides along, so an execution profile opens it read-only, as etcd's does.
      const { QdrantProvider } = await import("./providers/vector/qdrant/index");
      return new QdrantProvider(connection, options, execution);
    }

    // Embedded databases - dynamically imported
    case "libredb": {
      const { LibreDBProvider } = await import("./providers/embedded/libredb");
      return new LibreDBProvider(connection, options);
    }

    default:
      throw new DatabaseConfigError(
        // This list is NOT type-checked against the union - a new case above with no
        // entry here is silent - so it is kept in the same order as the cases and
        // tests/isolated/factory.test.ts pins individual names in it by regex.
        `Unknown database type: ${connection.type}. Supported types: postgres, mysql, sqlite, duckdb, libsql, oracle, db2, mssql, clickhouse, druid, trino, cassandra, elasticsearch, opensearch, mongodb, couchbase, redis, etcd, oxia, prometheus, influxdb, influxdb3, kafka, neo4j, milvus, qdrant, libredb`,
        connection.type,
      );
  }
}

// ============================================================================
// SSH tunnel rewrite (#457, X23)
// ============================================================================

/**
 * The connection a provider is built with when its traffic goes through an SSH tunnel: `host`
 * and `port` point at the tunnel's LOCAL endpoint, which is where the driver must dial, and the
 * address that endpoint FORWARDS TO, read back off the tunnel, travels with them under
 * `TUNNEL_FAR_END`.
 *
 * The far end is carried because the rewrite alone made the whole tunnelled population unable to
 * edit anything (X23). A provider seals every object edit plan with
 * `connectionFingerprint(this.config)` and the edit routes recompute that digest from the record
 * the request resolved, so a config that says `127.0.0.1:<ephemeral>` and a record that says
 * `db.internal:5432` compared unequal on every attempt: the reader could open the object, could
 * read it, and could never edit it.
 *
 * It is NOT on `ProviderOptions`, for the reason `ProviderExecutionContext`'s docblock already
 * gives about a profile flag: options are caller-supplied and flow all the way into
 * `getOrCreateProvider`, and a value the seal depends on must not be settable by whoever builds
 * the options for a request. A symbol key is the same footing reached differently - see
 * `TUNNEL_FAR_END` in `src/lib/types.ts` for what stops a stored connection carrying one.
 *
 * `base` is the connection as the caller already holds it - `acquireExecutionProfileProvider` has
 * substituted the agent credential onto it by the time it gets here - and only `host` and `port`
 * are replaced. The far end is not read off it at all, which is the point of the paragraph below.
 *
 * THE FAR END COMES OFF THE TUNNEL, never off the record, and that is why this helper takes no
 * separate `farEnd` argument (D86). A pooled tunnel is not always the one this call opened, so
 * the address the caller ASKED to forward to and the address the forward reaches are two
 * different facts. MEASURED 2026-09-15 against the live bastion, no mocks: with the pool keyed
 * on the connection id alone, a provider built on the id of a tunnel to `pg-p3fix:5432` with the
 * record changed to `db-elsewhere.invalid:6543` dialled the existing forward, answered
 * `libredb_dev` at `172.23.0.2`, and sealed `db-elsewhere.invalid:6543` - which is exactly what
 * the edit routes recompute, so that plan verified against a machine the statement never reached.
 * Two things closed it: `TunnelInfo` now carries `remoteHost`/`remotePort`, and the pool keys on
 * them and on the bastion route, so a request for a forward nothing has opened opens its own.
 */
function tunnelledConnection(base: DatabaseConnection, tunnel: TunnelInfo): DatabaseConnection & WithTunnelFarEnd {
  return {
    ...base,
    host: tunnel.localHost,
    port: tunnel.localPort,
    [TUNNEL_FAR_END]: { host: tunnel.remoteHost, port: tunnel.remotePort },
  };
}

// ============================================================================
// One-shot tunnel scope (#457)
// ============================================================================

/**
 * Run `run` against a connection reachable through its SSH tunnel, then close the
 * tunnel unconditionally.
 *
 * This is the transport for callers that build a provider with
 * `createDatabaseProvider` directly - outside both provider caches - and connect it:
 * `POST /api/db/test-connection` and `POST /api/db/schema-snapshot`. Before #457 they
 * connected to the raw database host, so a tunnelled connection could never be tested
 * and therefore never be saved at all (the dialog gates its only save button on a
 * passing test), and the agent's grounding capture could not read a tunnelled schema.
 *
 * The tunnel is deliberately NOT pooled, unlike `getOrCreateProvider`'s. Those callers
 * cache nothing, so nothing would ever evict a pooled tunnel: `removeProvider` and the
 * idle sweep close the tunnel of a CACHED provider, and the connection dialog mints a
 * fresh id for every unsaved build - so each test click would strand an SSH client and
 * a listening local server for the life of the process. Ownership sits with this scope
 * instead, which is why `run` is a callback rather than a returned endpoint: the close
 * cannot be forgotten.
 *
 * The callback is NOT named `use`: `react-hooks/rules-of-hooks` reads a call to
 * anything named `use()` as React 19's hook and rejects it outside a component, and
 * inside a try block on top of that.
 *
 * A connection with no tunnel, or with no host and port to forward to (a
 * connection-string connection, or SQLite), passes straight through untouched - the
 * same rule the pooled paths apply.
 */
export async function withOneShotTunnel<T>(
  connection: DatabaseConnection,
  run: (effective: DatabaseConnection) => Promise<T>,
): Promise<T> {
  assertReadOnlyHonoured(connection);
  if (!connection.sshTunnel?.enabled || !connection.host || !connection.port) {
    return await run(connection);
  }

  const tunnel = await createSSHTunnel(connection.id, connection.sshTunnel, connection.host, connection.port, {
    shared: false,
  });

  try {
    return await run(tunnelledConnection(connection, tunnel));
  } finally {
    // Swallowed on purpose: a failing teardown must not replace the caller's error,
    // which is the one that says why the database connection did not work.
    await tunnel.close().catch(() => {});
  }
}

// ============================================================================
// Provider Cache (for connection reuse)
// ============================================================================

interface CachedProvider {
  provider: DatabaseProvider;
  lastUsed: number;
  /**
   * The connection this entry serves. It is NOT the cache key - see
   * {@link providerCacheKey} for why the key may not be a string the caller typed. Every
   * "which entries serve connection X" question matches on this field.
   */
  connectionId: string;
  /**
   * The file this entry holds open, when the provider declares
   * `ProviderCapabilities.singleWriterFile` - see `findOpenSingleWriterProvider`.
   * `null` on every other provider, which is all of them but one.
   */
  singleWriterFile?: string | null;
  /**
   * Whether this entry's DuckDB handle was opened with file access allowed (non-admin DuckDB file access): the
   * derived posture `getOrCreateProvider` opened it under. Only the single-writer borrow for
   * DuckDB reads it, so a handle is lent only to a caller of the same posture and nobody is
   * handed a handle wider than its own. It is the derived boolean, so it is `true`/`false`
   * rather than absent, and it is ignored for every engine but DuckDB (the borrow gates on it
   * only there).
   */
  allowExternalFileAccess?: boolean;
}

const providerCache = new Map<string, CachedProvider>();

// ============================================================================
// Single-writer file reuse (#498)
// ============================================================================

/**
 * The identity of a database FILE: the engine type plus the resolved absolute path.
 *
 * The path is what identifies the open handle, not the connection id, because the
 * second opener is usually a different connection record pointing at the same file -
 * which is exactly how D3 reproduced (the built-in "Sample (LibreDB)" holds the file
 * while the dialog tests the edited copy under a fresh id). The type is in the key so
 * two engines can never collide over one path.
 *
 * `null` when the connection carries no file path at all, which is every
 * client-server connection, every connection-string one, and every ANONYMOUS
 * IN-MEMORY one.
 *
 * That last case is not a nicety. `path.resolve(":memory:")` is a path in the working
 * directory, so two unrelated in-memory connections came out with ONE identity and the
 * second borrowed the first's open handle - reading a database nobody pointed it at.
 * It fires on the engines that declare `singleWriterFile`, which is where the borrow
 * lives: DuckDB accepts `:memory:` (LibreDB does not). An anonymous in-memory database
 * is per-handle by definition - there is no file to share, no lock to work around, and
 * therefore nothing a borrow could buy.
 *
 * The comparison is EXACT, matching `DuckDBProvider.getDatabasePath()` character for
 * character: that method treats `:memory:` and nothing else as in-memory, and resolves
 * every other spelling - `:MEMORY:`, ` :memory:`, DuckDB's own `:memory:named` - as a
 * relative file path. Two connections spelling one of those the same way really do
 * point at one file, and must keep matching. The narrowing here is only ever as wide as
 * the provider's own reading of the value.
 */
const ANONYMOUS_IN_MEMORY_DATABASE = ":memory:";

function fileIdentity(connection: DatabaseConnection): string | null {
  if (!connection.database) return null;
  if (connection.database === ANONYMOUS_IN_MEMORY_DATABASE) return null;
  return `${connection.type}::${path.resolve(connection.database)}`;
}

/**
 * The connected provider that already holds this connection's file, if there is one.
 *
 * Only a provider whose engine declares `ProviderCapabilities.singleWriterFile` ever
 * registers a file identity here (`getOrCreateProvider` below), so a match means the
 * engine admits ONE handle per file and the caller's alternative is not a second,
 * lesser handle - it is no handle at all. Borrowers must NOT disconnect what they get
 * back: the returned provider is owned by the writable cache and serves the user's
 * live connection.
 *
 * Deliberately reads only the writable cache. The reverse direction - handing an
 * editor request a provider opened under an execution profile - stays forbidden, so
 * profiled entries are not offered here.
 *
 * POSTURE-AWARE FOR DUCKDB (non-admin DuckDB file access). A DuckDB entry records the file-access posture it was
 * opened under, and a borrow matches only an entry opened under the caller's own posture, so a
 * caller is never lent a handle wider than its own. Both sides are normalised to `=== true`, so
 * an absent caller posture (no argument) reads as deny, matching the default
 * `getOrCreateProvider` records and keeping the fail-closed polarity. The gate is skipped for
 * every other engine (libredb), where no such posture exists, so their borrow is unchanged.
 * Under `editorExecutionContext` every role that can resolve one seed record gets the same
 * posture, so on a seed the gate never splits one record between two handles. When it finds
 * nothing to lend while the file is open, `isSingleWriterFileOpen` says so, and Test Connection
 * opens a read-only handle rather than a second read-write one.
 *
 * The cost of that is real and is paid by the editor. If an agent run reaches a
 * single-writer connection nobody has browsed yet, `acquireExecutionProfileProvider`
 * opens the file and caches the handle under the PROFILED key; `getOrCreateProvider`
 * then fails on the lock, so browsing that connection in the sidebar is refused until
 * the profiled entry is evicted (30 minutes idle). Lifting it would mean serving an
 * editor request a provider opened under an execution profile, which is the isolation
 * invariant `acquireExecutionProfileProvider` exists to keep - so the lockout is the
 * chosen side of that trade, not an oversight.
 */
export function findOpenSingleWriterProvider(
  connection: DatabaseConnection,
  allowExternalFileAccess?: boolean,
): DatabaseProvider | null {
  const identity = fileIdentity(connection);
  if (identity === null) return null;
  // Normalised so an absent caller posture reads as deny, matching the default entries
  // `getOrCreateProvider` records; the gate below only consults it for DuckDB.
  const wantAccess = allowExternalFileAccess === true;
  for (const entry of providerCache.values()) {
    if (entry.singleWriterFile !== identity || !entry.provider.isConnected()) continue;
    // A handle of an engine that opens under a file-access posture is borrowable only by a caller of
    // its own posture (the non-admin DuckDB file-access change). `READS_FILE_ACCESS_POSTURE` answers
    // which engines, so this is not a `connection.type` branch (CLAUDE.md); today only DuckDB does.
    if (READS_FILE_ACCESS_POSTURE[connection.type] && (entry.allowExternalFileAccess === true) !== wantAccess) {
      continue;
    }
    return entry.provider;
  }
  return null;
}

/**
 * Whether a connected handle in the writable cache holds this connection's file, whatever
 * file-access posture it was opened under (non-admin DuckDB file access).
 *
 * `findOpenSingleWriterProvider` answers only with a handle of the caller's own posture, so when it
 * answers null and this answers true, the file is held by a DuckDB handle of the OTHER posture. A
 * caller that would otherwise open its own read-write handle there must not: DuckDB serves one file
 * through one read-write handle per process, and a second one keeps its own copy of the catalog and
 * checkpoints it over the file when it closes, which loses the other handle's committed rows on Linux
 * and macOS and is refused outright on Windows. Test Connection opens a read-only handle instead,
 * which leaves the writer's file and write-ahead log alone (`src/app/api/db/test-connection/route.ts`).
 */
export function isSingleWriterFileOpen(connection: DatabaseConnection): boolean {
  const identity = fileIdentity(connection);
  if (identity === null) return false;
  return Array.from(providerCache.values()).some(
    (entry) => entry.singleWriterFile === identity && entry.provider.isConnected(),
  );
}

// ============================================================================
// Execution-profile provider cache (#328)
// ----------------------------------------------------------------------------
// Physically separate from providerCache on purpose: an agent acquisition must
// be able to prove it never read from nor wrote to the shared writable cache.
// Keyed by (connection id, execution profile).
// ============================================================================

type ProfiledCachedProvider = CachedProvider;

const profiledProviderCache = new Map<string, ProfiledCachedProvider>();

/**
 * The profiled cache's key, which is the shared cache's key with the profile framed onto it
 * (GHSA-3wh2-8x78-jfw4). It used to be `${profile}::${connection.id}`, so it carried the same
 * forgeable id and was reachable by the same forgery - reproduced on this path too, in
 * `tests/isolated/factory.test.ts`. {@link providerCacheKey} states the whole argument.
 *
 * The profile stays in the key because the two caches' isolation is per profile: an
 * `agent-read-only` acquisition may never be served what `agent-operations` opened.
 *
 * Exported for one caller that must join concurrent first acquisitions on exactly this key
 * without deriving a second one: src/lib/mcp/context.ts.
 */
export async function profiledCacheKey(connection: DatabaseConnection, profile: ExecutionProfile): Promise<string> {
  const key = await providerCacheKey(connection);
  return `${profile.length}:${profile}${key}`;
}

/** True when any provider — shared or profiled — still serves this connection. */
function connectionStillServed(connectionId: string): boolean {
  if (Array.from(providerCache.values()).some((entry) => entry.connectionId === connectionId)) return true;
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

  for (const [key, entry] of providerCache) {
    if (now - entry.lastUsed >= maxIdleMs) {
      const id = entry.connectionId;
      logger.info(
        `[DB] Evicting idle provider: ${sanitize(id)} (idle ${Math.round((now - entry.lastUsed) / 60000)}min)`,
      );
      try {
        await entry.provider.disconnect();
      } catch (error) {
        logger.warn(`[DB] Error disconnecting idle provider ${sanitize(id)}`, {
          connectionId: id,
          error: String(error),
        });
      }
      providerCache.delete(key);
      // Close the shared tunnel only when nothing serves the connection
      // anymore — a live profiled provider still needs it, and so does another
      // entry of this connection opened with different credentials.
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
      logger.info(`[DB] Evicting idle profiled provider: ${sanitize(entry.connectionId)}`);
      try {
        await entry.provider.disconnect();
      } catch (error) {
        logger.warn(`[DB] Error disconnecting idle profiled provider ${sanitize(entry.connectionId)}`, {
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
 * @param execution - The DuckDB editor file-access posture (non-admin DuckDB file access), and nothing else. Studio's
 *   routes derive it with `editorExecutionContext` from the verified session and the resolved
 *   connection. ABSENT MEANS DENY: called without it, as an embedder that predates the posture
 *   calls it, a DuckDB handle opens with `enable_external_access: 'false'`, so `read_csv`,
 *   `COPY`, `ATTACH` of a file and `INSTALL` are refused while the database stays writable. Pass
 *   `{ allowExternalFileAccess: true }` for the full editor reach. Every other engine ignores it.
 *   A `readOnly` in it is refused (`DatabaseConfigError`): this cache holds writable providers,
 *   and a read-only one comes from `createDatabaseProvider` or an execution profile.
 * @returns Cached or new DatabaseProvider instance
 */
export async function getOrCreateProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {},
  execution: EditorExecutionContext = {},
): Promise<DatabaseProvider> {
  // First, ahead of the cache lookup and of any tunnel (#1089): see assertReadOnlyHonoured.
  assertReadOnlyHonoured(connection);
  // The writable cache never holds a read-only handle, and its key frames no such mode for an
  // execution context: a readOnly reaching the provider from here would be served to every later
  // editor request, or a read-only caller handed the writable one. The type has no such field; a
  // caller that passes one anyway is refused rather than silently given the writable provider.
  if ((execution as ProviderExecutionContext).readOnly !== undefined) {
    throw new DatabaseConfigError(
      "getOrCreateProvider takes no readOnly in its execution context: it caches writable providers, so a read-only one would be served to every later request. Build a read-only provider with createDatabaseProvider instead.",
      connection.type,
    );
  }
  // The DuckDB editor file-access posture, server-derived (non-admin DuckDB file access). A definite boolean, so the
  // handle it opens and the key it is cached under agree, and absent reads as deny (fail closed).
  // Only DuckDB reads it; the cache key and the single-writer borrow ignore it for other engines.
  const allowExternalFileAccess = execution.allowExternalFileAccess === true;
  const cacheKey = await providerCacheKey(connection, allowExternalFileAccess);

  // Check cache
  const cached = providerCache.get(cacheKey);

  // A saved timeout change must reach the next query, even when the connection is already open.
  if (cached && cached.provider.config.queryTimeout !== connection.queryTimeout) {
    try {
      await cached.provider.disconnect();
    } catch (error) {
      logger.warn(`[DB] Error disconnecting provider after query timeout change`, {
        connectionId: connection.id,
        error: String(error),
      });
    }
    providerCache.delete(cacheKey);
  } else if (cached?.provider.isConnected()) {
    cached.lastUsed = Date.now();
    return cached.provider;
  }

  // A single-writer engine (DuckDB) keeps ONE writable handle per file per process. We are about to
  // open a new one under `cacheKey`; a handle of THIS connection on the SAME file under a DIFFERENT
  // key would make a second read-write handle on one file. The one way that arises for a single
  // record is a file-access posture flip: an operator edits a seed's roles while Studio runs (the
  // seed file hot-reloads), which moves the record between the allow key and the deny key. A second
  // handle keeps its own copy of the catalog and checkpoints it over the file when it closes, losing
  // the first handle's committed rows on Linux and macOS and corrupting the file after a bulk write;
  // Windows refuses the second open. So close any such stale handle first, exactly as the
  // query-timeout change above does, leaving this open as the file's only writer. Entries of a
  // DIFFERENT connection id on the same file are the separate, pre-existing D240 case and are left
  // alone here. `singleWriterFile` is set only for single-writer engines, so this is a no-op for the
  // rest without a type-id branch.
  const openFileIdentity = fileIdentity(connection);
  if (openFileIdentity !== null) {
    for (const [key, entry] of providerCache) {
      // Skip the key we are about to open under (any entry still there is disconnected, since a
      // connected one would have returned above) and every entry that is not this record on this
      // file; what remains is the same record's handle under the other posture key.
      if (key === cacheKey || entry.connectionId !== connection.id || entry.singleWriterFile !== openFileIdentity)
        continue;
      try {
        await entry.provider.disconnect();
      } catch (error) {
        logger.warn(`[DB] Error disconnecting a stale single-writer handle before reopening`, {
          connectionId: connection.id,
          error: String(error),
        });
      }
      providerCache.delete(key);
    }
  }

  // If SSH tunnel is configured, create tunnel first and rewrite connection.
  // createSSHTunnel returns a pre-existing tunnel for the same connection id, bastion route
  // AND far end, so ask about exactly that forward — only a tunnel this call created may be
  // torn down on failure (a pre-existing one may still serve an execution-profile provider).
  let effectiveConnection = connection;
  let tunnelPreexisted = false;
  let tunnel: TunnelInfo | null = null;
  if (connection.sshTunnel?.enabled && connection.host && connection.port) {
    tunnelPreexisted = hasTunnel(connection.id, {
      ssh: connection.sshTunnel,
      farEnd: { host: connection.host, port: connection.port },
    });
    tunnel = await createSSHTunnel(connection.id, connection.sshTunnel, connection.host, connection.port);
    // Rewrite connection to point to local tunnel endpoint, keeping the far end for the seal
    effectiveConnection = tunnelledConnection(connection, tunnel);
  }

  // Create new provider (async - dynamically loads the provider module). Only the derived posture
  // is handed on, so the handle opens under exactly the posture its key frames; every provider but
  // DuckDB ignores it (non-admin DuckDB file access).
  const provider = await createDatabaseProvider(effectiveConnection, options, { allowExternalFileAccess });
  try {
    await provider.connect();
  } catch (error) {
    // Clean up a freshly created SSH tunnel if provider connect fails to prevent FD leak
    if (tunnel && !tunnelPreexisted) {
      await tunnel.close().catch(() => {});
    }
    throw error;
  }

  // Cache it, remembering the file when this engine admits only one handle on it -
  // that is what lets the callers that would otherwise open a second one find this.
  const singleWriterFile = provider.getCapabilities().singleWriterFile === true ? fileIdentity(connection) : null;
  providerCache.set(cacheKey, {
    provider,
    connectionId: connection.id,
    lastUsed: Date.now(),
    singleWriterFile,
    // Recorded so the single-writer borrow lends a DuckDB handle only to a caller of the same
    // posture (non-admin DuckDB file access); ignored for every engine but DuckDB.
    allowExternalFileAccess,
  });

  // Start idle sweep if not already running
  startIdleSweep();

  return provider;
}

// ============================================================================
// Execution-profile provider acquisition (#328)
// ============================================================================

/**
 * The execution profiles this factory can vend. Three exist: `agent-read-only` for
 * the paths that send a model-authored statement, `agent-operations` for the curated
 * reading path that sends none, and `agent-handover` for the editor replay of an
 * answer a run already produced. An unknown profile string is refused, never
 * defaulted (fail closed), and what each one means is stated once in
 * `PROFILE_ACQUISITION`.
 */
export type ExecutionProfile = "agent-read-only" | "agent-operations" | "agent-handover";

/**
 * What a profile means at acquisition: the context the provider is opened under,
 * and whether the profile's calls go through `provider.queryReadOnly`.
 *
 * Single source of truth for the profile list, so a new profile cannot be accepted
 * without stating both. The second field is the engine gate, and it is a PROPERTY OF
 * THE PROFILE rather than of the factory: `agent-read-only` sends model-authored
 * statements, so it is served only where the engine itself can bound one, and only
 * the providers of AGENT_EXECUTION_ENGINES implement that: PostgreSQL, SQLite, DuckDB
 * and SQL Server (`src/lib/agent/engine-support.ts`). `agent-operations` sends no statement
 * at all — it calls the curated reporting methods every provider implements — so
 * requiring a read-only STATEMENT path of it would refuse an engine over a capability
 * the profile never uses. `agent-handover` sends a statement too — the one a run
 * already answered with, replayed in the user's editor — so it takes the same gate as
 * `agent-read-only`; it is a separate row because it carries a different BUDGET
 * (`AGENT_HANDOVER_BUDGET`), and a shared row would have made a later change to one
 * path silently move the other.
 *
 * What all three profiles share is everything that makes the acquisition safe: the
 * same `readOnly: true` execution context (on PostgreSQL that still verifies the role
 * is unprivileged at open), the same `agentUser` credential resolution, and the same
 * profiled cache — so neither an operations run nor an editor replay is ever handed
 * the editor's writable pool.
 */
interface ProfileAcquisition {
  readonly context: ProviderExecutionContext;
  /** Refuse the provider unless it exposes a database-native read-only statement path. */
  readonly requiresReadOnlyStatements: boolean;
}

const PROFILE_ACQUISITION: Record<ExecutionProfile, ProfileAcquisition> = {
  "agent-read-only": { context: { readOnly: true }, requiresReadOnlyStatements: true },
  "agent-operations": { context: { readOnly: true }, requiresReadOnlyStatements: false },
  "agent-handover": { context: { readOnly: true }, requiresReadOnlyStatements: true },
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
 *
 * `requester` is the editor posture of the caller this acquisition serves, as
 * `editorExecutionContext` derives it (non-admin DuckDB file access). It never changes how a profiled handle
 * opens - every profile opens read-only with external access off - and is read only to
 * decide which open single-writer handle an `agent-operations` acquisition may borrow:
 * one opened under that same posture, so an admin's agent is grounded from the admin's
 * own editor handle as before, and a requester is never lent a handle wider than its own.
 * Absent means deny, like everywhere else on this channel.
 */
export async function acquireExecutionProfileProvider(
  connection: DatabaseConnection,
  profile: ExecutionProfile,
  options: ProviderOptions = {},
  requester: EditorExecutionContext = {},
): Promise<DatabaseProvider> {
  // First, ahead of the profiled cache lookup and of any tunnel (#1089): see assertReadOnlyHonoured.
  assertReadOnlyHonoured(connection);
  if (!EXECUTION_PROFILES.has(profile)) {
    throw new ExecutionProfileError(`Unknown execution profile: ${String(profile)}`, "UNSUPPORTED_PROFILE");
  }

  const cacheKey = await profiledCacheKey(connection, profile);
  const cached = profiledProviderCache.get(cacheKey);
  if (cached && cached.provider.config.queryTimeout !== connection.queryTimeout) {
    try {
      await cached.provider.disconnect();
    } catch (error) {
      logger.warn(`[DB] Error disconnecting provider after query timeout change`, {
        connectionId: connection.id,
        error: String(error),
      });
    }
    profiledProviderCache.delete(cacheKey);
  } else if (cached?.provider.isConnected()) {
    cached.lastUsed = Date.now();
    return cached.provider;
  }

  const credential = resolveAgentCredential(connection);
  const acquisition = PROFILE_ACQUISITION[profile];

  /*
    The single-writer exception (B49), and why it is safe HERE and nowhere else.

    On an engine that declares `singleWriterFile` the file admits one open handle, so
    opening a second one for this acquisition does not produce a less privileged
    handle - it throws, and the run continues silently ungrounded (a `ConnectionError`
    becomes an unavailable capture). Every agent grounding read on a LibreDB
    connection was lost that way from the moment anyone browsed it in the sidebar.

    Two bounds keep the isolation invariant intact. It is scoped to the profile that
    sends NO statement of the model's: `agent-operations` calls the curated reporting
    methods only, so there is nothing here for a read-only statement path to bound,
    and `agent-read-only` / `agent-handover` are still refused on such an engine
    rather than served the writable handle. And it is refused when the connection
    configures an agent credential, because the borrowed handle was opened under the
    connection's own - a reuse cannot silently substitute one principal for another.

    The provider is returned WITHOUT being cached under the profiled key: it is
    borrowed, and an entry there would let this cache's idle sweep - or a
    `removeProvider` for any connection sharing the file - close the file under the
    session that opened it.
  */
  if (!acquisition.requiresReadOnlyStatements && credential === null) {
    // Posture-aware for DuckDB (non-admin DuckDB file access): only a handle opened under the requester's own editor
    // posture is borrowed, so an admin's agent on a connection only admins use is grounded from
    // the admin's editor handle, and nobody is lent a handle wider than their own. Where none
    // matches it opens its own read-only handle, which is safe beside a writer. The posture is
    // ignored for libredb, the other single-writer engine, so its borrow is unchanged.
    const open = findOpenSingleWriterProvider(connection, requester.allowExternalFileAccess);
    if (open) return open;
  }

  let effectiveConnection: DatabaseConnection = credential
    ? { ...connection, user: credential.user, password: credential.password }
    : connection;

  // The SSH tunnel is keyed by connection id, bastion route and far end, and shared with the
  // writable provider (createSSHTunnel returns the existing one for that forward). Only a
  // tunnel this acquisition freshly created may be torn down on failure.
  let tunnelPreexisted = false;
  let tunnel: TunnelInfo | null = null;
  if (connection.sshTunnel?.enabled && connection.host && connection.port) {
    tunnelPreexisted = hasTunnel(connection.id, {
      ssh: connection.sshTunnel,
      farEnd: { host: connection.host, port: connection.port },
    });
    tunnel = await createSSHTunnel(connection.id, connection.sshTunnel, connection.host, connection.port);
    effectiveConnection = tunnelledConnection(effectiveConnection, tunnel);
  }

  const closeFreshTunnel = async () => {
    if (tunnel && !tunnelPreexisted) await tunnel.close().catch(() => {});
  };

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
  // A connection can hold more than one entry now - one per distinct server-and-credentials
  // it was opened with - so this removes every entry serving it, the way the profiled loop
  // below always has.
  for (const [key, entry] of providerCache) {
    if (entry.connectionId !== connectionId) continue;
    try {
      await entry.provider.disconnect();
    } catch (error) {
      logger.warn(`Error disconnecting provider ${sanitize(connectionId)}`, { connectionId, error: String(error) });
    }
    providerCache.delete(key);
  }

  for (const [key, entry] of profiledProviderCache) {
    if (entry.connectionId !== connectionId) continue;
    try {
      await entry.provider.disconnect();
    } catch (error) {
      logger.warn(`Error disconnecting profiled provider ${sanitize(connectionId)}`, {
        connectionId,
        error: String(error),
      });
    }
    profiledProviderCache.delete(key);
  }

  // Close SSH tunnel if exists
  try {
    await closeSSHTunnel(connectionId);
  } catch (error) {
    logger.warn(`Error closing SSH tunnel for ${sanitize(connectionId)}`, { connectionId, error: String(error) });
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

  for (const entry of providerCache.values()) {
    disconnectPromises.push(
      entry.provider.disconnect().catch((error) => {
        // The id is an argument, never part of the first one: `console.error`'s first argument
        // is a format string, and a constant cannot be a format attack (js/tainted-format-string).
        console.error("[DB] Error disconnecting provider", sanitize(entry.connectionId), error);
      }),
    );
  }
  for (const [key, entry] of profiledProviderCache) {
    disconnectPromises.push(
      entry.provider.disconnect().catch((error) => {
        console.error("[DB] Error disconnecting profiled provider", sanitize(entry.connectionId), error);
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
    // The ids, never the keys: a key is a digest, and this is observability for
    // "which connections are open".
    connections: Array.from(providerCache.values(), (entry) => entry.connectionId),
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
