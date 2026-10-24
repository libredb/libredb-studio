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
import { connectPhase, DatabaseConfigError, ExecutionProfileError } from "./errors";
import { createSSHTunnel, closeSSHTunnel, hasTunnel } from "@/lib/ssh/tunnel";
import type { TunnelInfo } from "@/lib/ssh/tunnel";
import { readSecret } from "@/lib/storage/encryption";
import { providerCacheKey, providerOwner } from "./provider-cache-key";
import { registerOwnerRemoval } from "./owner-removal";
import { READ_ONLY_ENFORCED, READS_FILE_ACCESS_POSTURE, SHIPPED_DATABASE_TYPES } from "./compatibility";
import { TUNNEL_FAR_END, type DatabaseType, type WithTunnelFarEnd } from "@/lib/types";
import { logger } from "@/lib/logger";
import { runShutdownHooks } from "@/lib/shutdown";
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
 *   profile's context as `executionContextFor` builds it, and `getOrCreateProvider` and the routes that build their own
 *   provider pass the editor file-access posture `editorExecutionContext` derived from
 *   the verified session and the resolved connection. What each provider establishes with `readOnly` and
 *   `sendsStatements` is stated once, on `ProviderExecutionContext` (types.ts); DuckDB reads
 *   `allowExternalFileAccess` on its editor handle, and SQLite refuses to open at all when it is
 *   `false`, a profiled handle included. On DuckDB, ABSENT MEANS DENY: called without a context, as an
 *   embedder that predates the posture calls it, a DuckDB handle opens with
 *   `enable_external_access: 'false'`, so `read_csv`, `COPY`, `ATTACH` of a file and
 *   `INSTALL` are refused outside its private temp directory and its database's own file
 *   names (docs/providers/duckdb.md section 3.16) while the database stays writable; pass
 *   `{ allowExternalFileAccess: true }` for the full editor reach. SQLite refuses only an explicit
 *   `false`, so called without a context it opens with the trusted reach. An `owner` makes the provider
 *   that user's own (docs/GOVERNANCE.md#per-user-providers): its pool opens with `min: 0` and `max: ownerPoolMax`.
 * @returns Promise<DatabaseProvider> instance
 * @throws DatabaseConfigError if connection type is not supported or is left out of a set
 *   `LIBREDB_ENABLED_PROVIDERS` (see assertProviderEnabled), if its `readOnly` cannot be
 *   honoured (see assertReadOnlyHonoured), or if an owner comes without a whole `ownerPoolMax`
 *   from 1 (see assertOwnerPoolHonoured)
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
 * Refuse a connection with no id, before the cache key is computed (#1539).
 *
 * The provider's own `validate()` raises `DatabaseConfigError("Connection ID is required")` for this
 * record, but `getOrCreateProvider` and `acquireExecutionProfileProvider` compute their cache key
 * first, and `providerCacheKey` length-frames `connection.id`: a missing id crashed there with a
 * `TypeError`, which `createErrorResponse` answered as a 500 `INTERNAL_ERROR` on every route that
 * opens a cached provider (query, health and multi-query were measured). The same record reaching the
 * provider through `createDatabaseProvider`, as `POST /api/db/test-connection` builds it, was already
 * refused with a 400 `CONFIG_ERROR`. The refusal is raised here instead, as the same
 * `DatabaseConfigError` the provider would have raised, so the key never sees a record the provider
 * would refuse, and no fallback key is invented for a missing id.
 */
function assertConnectionIdPresent(connection: DatabaseConnection): void {
  if (!connection.id) {
    throw new DatabaseConfigError("Connection ID is required", connection.type);
  }
}

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
 * provider without refusing it. `assertProviderEnabled` stands beside it in all four places for the same
 * reason: a type `LIBREDB_ENABLED_PROVIDERS` leaves out must never reach a cache lookup or dial a bastion.
 * Exported for the tests; the published factory's three entry points raise it (`src/exports/providers.ts`).
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

/**
 * Refuse an owner without a pool size its provider can open with (docs/GOVERNANCE.md#per-user-providers), before
 * anything is built or dialled.
 *
 * An owned provider opens its pool with `min: 0` and `max: ownerPoolMax`, so the size must be a whole number from 1.
 * pg would refuse nothing else: it opens its default of 10 for 0, NaN or no size at all, and a pool with a negative
 * size never hands out a connection, so the owner's share would be lifted, or the provider wedged, without a word.
 * It runs where `assertReadOnlyHonoured` runs and for the reason that function gives: `getOrCreateProvider` and
 * `acquireExecutionProfileProvider` open the SSH tunnel before they build the provider. `editorExecutionContext`
 * always sets the owner and the size together, so the refusal reaches only a context built elsewhere.
 */
function assertOwnerPoolHonoured(connection: DatabaseConnection, execution: ProviderExecutionContext): void {
  if (execution.owner === undefined) return;
  const max: unknown = execution.ownerPoolMax;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    throw new DatabaseConfigError(
      "ownerPoolMax must be a whole number from 1 when an owner is given: it is the most connections the owner's provider may open.",
      connection.type,
    );
  }
}

// ============================================================================
// Enabled providers (LIBREDB_ENABLED_PROVIDERS)
// ============================================================================

/** Every connection type id, the embedded LibreDB store included: the exhaustive shipped set. */
const CONNECTION_TYPE_IDS: ReadonlySet<string> = new Set<string>(SHIPPED_DATABASE_TYPES);

/**
 * The connection types this server may open: `LIBREDB_ENABLED_PROVIDERS` as a comma list, trimmed, with empty
 * entries dropped and each type kept once in first-seen order, or `null` when the variable is unset or blank, which
 * enables every provider. The VS Code extension is the one channel that sets it, in its backend process; the web app,
 * Docker, Helm, npx and the desktop launchers leave it unset. Read on every call, never cached.
 *
 * @throws DatabaseConfigError naming the entry when an entry is not a connection type id, or when a set value lists none.
 */
export function enabledProviderTypes(): readonly DatabaseType[] | null {
  const raw = process.env.LIBREDB_ENABLED_PROVIDERS;
  if (raw === undefined || raw.trim() === "") return null;
  const entries = [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
  ];
  if (entries.length === 0) {
    throw new DatabaseConfigError(
      "LIBREDB_ENABLED_PROVIDERS is set but lists no connection type id. Leave it unset to enable every provider.",
    );
  }
  const unknown = entries.find((entry) => !CONNECTION_TYPE_IDS.has(entry));
  if (unknown !== undefined) {
    throw new DatabaseConfigError(
      `LIBREDB_ENABLED_PROVIDERS names ${JSON.stringify(unknown)}, which is not a connection type id. List type ids such as postgres, separated by commas.`,
    );
  }
  return entries as DatabaseType[];
}

/**
 * Refuse a connection whose type `LIBREDB_ENABLED_PROVIDERS` leaves out, before anything is built, loaded or dialled.
 *
 * It is set membership inside the provider layer and names no type id, so `tests/unit/lib/no-engine-branches.test.ts`
 * needs no entry for it. It runs before the `switch` of `createDatabaseProvider`, so the provider module of a refused
 * type, and its driver, is never imported. Unset or blank returns at once; a value that names something other than a
 * type id raises the reader's `DatabaseConfigError`, so every connection fails with that entry named.
 */
function assertProviderEnabled(connection: DatabaseConnection): void {
  const enabled = enabledProviderTypes();
  if (enabled === null || enabled.includes(connection.type)) return;
  throw new DatabaseConfigError(
    `The ${sanitize(connection.type)} provider is not available in this distribution of LibreDB Studio.`,
    connection.type,
  );
}

export async function createDatabaseProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {},
  execution: ProviderExecutionContext = {},
): Promise<DatabaseProvider> {
  assertProviderEnabled(connection);
  assertReadOnlyHonoured(connection);
  assertOwnerPoolHonoured(connection, execution);
  console.log(`[DB] Creating ${sanitize(connection.type)} provider for "${sanitize(connection.name || "")}"`);

  // Explicit overrides (such as the connectivity probe) take precedence over saved settings.
  options = { ...options, queryTimeout: options.queryTimeout ?? connection.queryTimeout };
  // An owned provider serves one user (docs/GOVERNANCE.md#per-user-providers): its pool opens nothing until that user
  // asks, and never more than the user's share, whatever size the caller's options name. The rest of the caller's pool
  // options stand.
  if (execution.owner !== undefined) {
    options = { ...options, pool: { ...options.pool, min: 0, max: execution.ownerPoolMax } };
  }

  switch (connection.type) {
    // SQL Databases - dynamically imported to reduce memory
    case "postgres": {
      const { PostgresProvider } = await import("./providers/sql/postgres");
      return new PostgresProvider(connection, options, execution);
    }

    case "mysql": {
      const { MySQLProvider } = await import("./providers/sql/mysql");
      return new MySQLProvider(connection, options, execution);
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
      return new OracleProvider(connection, options, execution);
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

    case "databend": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The constructor validates
      // nothing and opens nothing; the connection's rules run in connect(), before any socket.
      const { DatabendProvider } = await import("./providers/sql/databend/index");
      return new DatabendProvider(connection, options);
    }

    case "bigquery": {
      const { BigQueryProvider } = await import("./providers/sql/bigquery/index");
      return new BigQueryProvider(connection, options);
    }

    case "snowflake": {
      // The explicit /index specifier keeps this dynamic import statically analysable. Two arguments only: the
      // transport deps are a test's seam, and the origin comes from the Account field alone.
      const { SnowflakeProvider } = await import("./providers/sql/snowflake/index");
      return new SnowflakeProvider(connection, options);
    }

    case "spark": {
      // The explicit /index specifier keeps this dynamic import statically analysable. Two arguments only: the
      // third, the wire transport, is a test's seam the factory never passes.
      const { SparkProvider } = await import("./providers/sql/spark/index");
      return new SparkProvider(connection, options);
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

    // Document Databases - dynamically imported. The execution context reaches the
    // MongoDB constructor like the SQL engines' and Kubernetes': its `readOnly` and
    // `sendsStatements` together are what the connect-time verification keys on (issue #1614).
    case "mongodb": {
      const { MongoDBProvider } = await import("./providers/document/mongodb");
      return new MongoDBProvider(connection, options, execution);
    }

    case "couchbase": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { CouchbaseProvider } = await import("./providers/document/couchbase/index");
      return new CouchbaseProvider(connection, options);
    }

    case "firestore": {
      // The explicit /index specifier keeps this dynamic import statically analysable. Read-only whatever the flag
      // says, so no execution context rides along, as for Neo4j.
      const { FirestoreProvider } = await import("./providers/document/firestore/index");
      return new FirestoreProvider(connection, options);
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

    case "weaviate": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context
      // rides along, so an execution profile opens it read-only, as Qdrant's does.
      const { WeaviateProvider } = await import("./providers/vector/weaviate/index");
      return new WeaviateProvider(connection, options, execution);
    }

    // Object storage - dynamically imported
    case "s3": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context rides
      // along, so an execution profile opens it read-only, as Qdrant's does.
      const { S3Provider } = await import("./providers/objectstore/s3/index");
      return new S3Provider(connection, options, execution);
    }

    // MQTT: a key-value provider, placed here beside the platforms because its Keys panel is the whole
    // surface and it has no query console of its own.
    case "mqtt": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { MqttProvider } = await import("./providers/keyvalue/mqtt/index");
      return new MqttProvider(connection, options);
    }

    // RabbitMQ: the second member of the stream family, read-only whatever the flag says. No seam is passed: the
    // provider runs on its production management transport, AMQP dial and clock.
    case "rabbitmq": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { RabbitMQProvider } = await import("./providers/stream/rabbitmq/index");
      return new RabbitMQProvider(connection, options);
    }

    // OPC UA: an industrial address space, browsed level by level. Read-only whatever the flag says,
    // so no execution context rides along, as for Neo4j.
    case "opcua": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { OpcuaProvider } = await import("./providers/industrial/opcua/index");
      // THE LIBRARY IS IMPORTED BY THE FIRST CONNECT, NOT BY CONSTRUCTION, and that is measured
      // rather than tidy: `node-opcua-hostname` calls `prepareFQDN()` at import time, un-awaited,
      // and its `dns.lookupService` throws inside a callback where the library's own try/catch
      // cannot see it. Under Node 24.14.0 here the hostname resolves to `::1` and nothing happens;
      // under Bun 1.4.2 it resolved to a zone-indexed link-local address
      // (`fe80::…%15`) and the error surfaced as an uncaught one. Constructing a provider must not
      // depend on that, so the import happens when a session is actually opened.
      return new OpcuaProvider(connection, options, async (read) => {
        const { openLibrarySession } = await import("./providers/industrial/opcua/library");
        return openLibrarySession(read);
      });
    }

    // MTConnect: an agent in front of machine tools, read over HTTP. Read-only whatever the flag says,
    // so no execution context rides along, as for OPC UA. No library: the client is this repository's
    // own over the shared transport, so the import is the provider module and nothing else.
    case "mtconnect": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { MTConnectProvider } = await import("./providers/industrial/mtconnect/index");
      return new MTConnectProvider(connection, options);
    }
    // SNMP: an agent on a device, read over UDP by this repository's own client through the
    // shared egress rule. Read-only not by a flag but by construction: the outgoing valve parses
    // every datagram and refuses any PDU that is not a Get, GetNext or GetBulk, so a Set never
    // reaches the socket. No library, so the import is the provider module itself.
    case "snmp": {
      const { SnmpProvider } = await import("./providers/network/snmp/index");
      return new SnmpProvider(connection, options);
    }

    // Modbus TCP: a device or a gateway, read over a raw socket by this repository's own client
    // through the shared egress rule. Read-only whatever the flag says, as for the two above, so
    // no execution context rides along. No library: the client is ours, so the import is the
    // provider module and nothing else.
    case "modbus": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { ModbusProvider } = await import("./providers/industrial/modbus/index");
      return new ModbusProvider(connection, options);
    }

    // Platforms - dynamically imported
    case "kubernetes": {
      // The explicit /index specifier keeps this dynamic import statically analysable. Read-only whatever the flag
      // says; the execution context rides along, so `queryReadOnly` answers only under an agent profile.
      const { KubernetesProvider } = await import("./providers/platform/kubernetes/index");
      return new KubernetesProvider(connection, options, {}, execution);
    }

    // Network devices - dynamically imported
    //
    // Before `libredb` on purpose, and the reason is in the tests rather than in style: five
    // regexes in `tests/isolated/factory.test.ts` anchor on `libredb$`, so a case appended after
    // it breaks checks that have nothing to do with this engine.
    case "netconf": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { NetconfProvider } = await import("./providers/network/netconf/index");
      return new NetconfProvider(connection, options);
    }

    // Sparkplug B (#1720), the third member of the `industrial/` family. Its own bounded MQTT session
    // rather than the shipped MQTT read, because that read returns one row per topic and a Sparkplug
    // read depends on the order of successive messages on one topic.
    case "sparkplug": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { SparkplugProvider } = await import("./providers/industrial/sparkplug/index");
      return new SparkplugProvider(connection, options);
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
        `Unknown database type: ${connection.type}. Supported types: postgres, mysql, sqlite, duckdb, libsql, oracle, db2, mssql, clickhouse, druid, trino, databend, bigquery, snowflake, spark, cassandra, elasticsearch, opensearch, mongodb, couchbase, firestore, redis, etcd, oxia, prometheus, influxdb, influxdb3, kafka, neo4j, milvus, qdrant, weaviate, s3, mqtt, opcua, mtconnect, modbus, snmp, rabbitmq, kubernetes, netconf, sparkplug, libredb`,
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
  assertProviderEnabled(connection);
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
   * The user this entry was opened for (docs/GOVERNANCE.md#per-user-providers), the `owner` its key frames, or
   * undefined for an entry every caller of the connection shares. Recorded for the reason `connectionId` is: the key is
   * a digest and cannot be read back, so "which entries are this user's" matches on this field. An entry with an owner
   * is torn down when it goes (`teardownProvider`), never only disconnected.
   */
  owner?: string;
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
    // which engines, so this is not a `connection.type` branch (CLAUDE.md); today DuckDB and SQLite do, and
    // of the two only DuckDB is a single-writer engine.
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
 * which leaves the writer's file and write-ahead log alone (`src/lib/api/test-connection.ts`).
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
// Keyed by (connection id, execution profile), plus the requester's posture for SQLite and DuckDB.
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
 * The requester's file-access posture is in it too, for an engine that reads one, exactly as in
 * the writable key: SQLite refuses a denied requester at connect, so a handle a trusted requester
 * opened must never answer a denied requester's key. Absent reads as denied. So is the requester's
 * owner (docs/GOVERNANCE.md#per-user-providers), as in the writable key: one user's acquisition is never served
 * another's.
 *
 * Exported for one caller that must join concurrent first acquisitions on exactly this key
 * without deriving a second one: src/lib/mcp/context.ts.
 */
export async function profiledCacheKey(
  connection: DatabaseConnection,
  profile: ExecutionProfile,
  requester: EditorExecutionContext = {},
): Promise<string> {
  const key = await providerCacheKey(connection, requester.allowExternalFileAccess === true, requester.owner);
  return withProfile(profile, key);
}

/**
 * `key`, a key of the writable cache, with `profile` framed onto it: the key the profiled cache holds the entry of that
 * profile under. {@link profiledCacheKey} keys an acquisition with it, and the key scope of `removeProvider` names the
 * profiled entries of one record with it, so the two never frame a profile differently.
 */
function withProfile(profile: string, key: string): string {
  return `${profile.length}:${profile}${key}`;
}

/** True when any provider — shared or profiled — still serves this connection. */
function connectionStillServed(connectionId: string): boolean {
  if (Array.from(providerCache.values()).some((entry) => entry.connectionId === connectionId)) return true;
  return Array.from(profiledProviderCache.values()).some((entry) => entry.connectionId === connectionId);
}

// ============================================================================
// Teardown of an owned provider (docs/GOVERNANCE.md#per-user-providers)
// ============================================================================

/**
 * How long a teardown waits for the rollback of an owned provider's open transaction
 * (docs/GOVERNANCE.md#per-user-providers).
 */
const TEARDOWN_ROLLBACK_MS = 5_000;
/**
 * How long a teardown waits for an owned provider's disconnect before it abandons the pool
 * (docs/GOVERNANCE.md#per-user-providers).
 */
const TEARDOWN_DISCONNECT_MS = 10_000;

/** What `within` answers for work that did not settle before its deadline. */
const TIMED_OUT = Symbol("timed out");

/**
 * Waits for `work` at most `ms`: answers once it resolves, or TIMED_OUT once `ms` pass first, and throws what it
 * rejects with before then. A rejection after the deadline is already handled by the race, and the timer never holds
 * the process open.
 */
async function within(work: Promise<void>, ms: number): Promise<void | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The interactive transaction session that `POST /api/db/transaction` drives, on a provider that implements one. */
interface TransactionSession {
  isInTransaction(): boolean;
  rollbackTransaction(): Promise<void>;
}

/** The provider's transaction session while it holds a transaction open, or null. */
function openTransaction(provider: DatabaseProvider): TransactionSession | null {
  const session = provider as DatabaseProvider & Partial<TransactionSession>;
  if (typeof session.isInTransaction !== "function" || typeof session.rollbackTransaction !== "function") return null;
  return session.isInTransaction() ? (session as TransactionSession) : null;
}

/**
 * Tear down an owned provider (docs/GOVERNANCE.md#per-user-providers): the provider of one user, closed because that
 * user's access changed or the provider went idle. Its entry is deleted from `cache` first, so no request is handed the
 * provider while it closes; an open transaction is rolled back, waited for at most TEARDOWN_ROLLBACK_MS; and the
 * provider is disconnected, waited for at most TEARDOWN_DISCONNECT_MS. The rollback comes first because the disconnect
 * would otherwise wait on the very session the transaction holds: `pg`'s `pool.end()` waits for every checked-out
 * client.
 *
 * A rollback or a disconnect that fails is logged, and a disconnect that does not finish in time is logged and its pool
 * abandoned, because a client stuck in a statement, or in a rollback that never answered, never comes back. So the
 * teardown ends within 15 s whatever the user's database does, and it never rejects.
 */
async function teardownProvider(cache: Map<string, CachedProvider>, key: string, entry: CachedProvider): Promise<void> {
  cache.delete(key);
  const { provider, connectionId: id } = entry;
  try {
    // Inside the try, as `keepsRunInFlight` guards `hasRunsInFlight`: a provider that throws here is not left open.
    const session = openTransaction(provider);
    if (session !== null) {
      const rollback = await within(session.rollbackTransaction(), TEARDOWN_ROLLBACK_MS);
      if (rollback === TIMED_OUT) {
        logger.warn(
          `[DB] The open transaction of an owned provider of ${sanitize(id)} did not roll back within ${TEARDOWN_ROLLBACK_MS} ms, so the provider is closed with it open.`,
          { connectionId: id },
        );
      } else {
        const line = `[DB] Rolled back the open transaction of an owned provider of ${sanitize(id)} before closing it.`;
        logger.info(line, { connectionId: id });
      }
    }
  } catch (error) {
    logger.warn(
      `[DB] The open transaction of an owned provider of ${sanitize(id)} failed to roll back, so the provider is closed with it open.`,
      { connectionId: id, error: String(error) },
    );
  }
  try {
    if ((await within(provider.disconnect(), TEARDOWN_DISCONNECT_MS)) === TIMED_OUT) {
      logger.warn(
        `[DB] Abandoned the pool of owned provider ${sanitize(id)}: its disconnect did not finish within ${TEARDOWN_DISCONNECT_MS} ms.`,
        { connectionId: id },
      );
    }
  } catch (error) {
    logger.warn(`[DB] Error disconnecting owned provider ${sanitize(id)}`, { connectionId: id, error: String(error) });
  }
}

/** Idle timeout: evict providers unused for 30 minutes */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Sweep interval: check for idle providers every 5 minutes */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Whether an idle entry's provider reports a run in flight, so the sweep keeps it for the next sweep.
 * A throw is the provider's defect: logged at error, and the entry is evicted as one without the method, because
 * rethrowing would abandon the rest of the sweep and reading it as busy would let such a provider pin its entry.
 */
function keepsRunInFlight(
  provider: DatabaseProvider,
  id: string,
  noun: "idle provider" | "idle profiled provider",
): boolean {
  if (provider.hasRunsInFlight === undefined) return false;
  try {
    return provider.hasRunsInFlight() === true;
  } catch (error) {
    logger.error(`[DB] hasRunsInFlight() threw for ${noun} ${sanitize(id)}, so it is evicted as idle.`, error, {
      connectionId: id,
    });
    return false;
  }
}

/**
 * Evict providers that have been idle longer than maxIdleMs.
 * Called by the periodic sweep timer, but also exported for direct testing.
 * An owned provider (docs/GOVERNANCE.md#per-user-providers) is torn down (`teardownProvider`), so an open transaction
 * it still holds is rolled back and a pool that hangs is abandoned; a provider every caller shares is disconnected as
 * before.
 *
 * @returns number of evicted providers
 */
export async function evictIdleProviders(maxIdleMs: number = IDLE_TIMEOUT_MS): Promise<number> {
  const now = Date.now();
  let evicted = 0;

  for (const [key, entry] of providerCache) {
    if (now - entry.lastUsed >= maxIdleMs) {
      const id = entry.connectionId;
      const idleMinutes = Math.round((now - entry.lastUsed) / 60000);
      if (keepsRunInFlight(entry.provider, id, "idle provider")) {
        logger.info(
          `[DB] Keeping idle provider ${sanitize(id)} (idle ${idleMinutes}min): it reports a run in flight, so the next sweep checks it again.`,
        );
        continue;
      }
      logger.info(`[DB] Evicting idle provider: ${sanitize(id)} (idle ${idleMinutes}min)`);
      if (entry.owner !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- the tunnel below may close only once this provider has closed.
        await teardownProvider(providerCache, key, entry);
      } else {
        try {
          await entry.provider.disconnect();
        } catch (error) {
          logger.warn(`[DB] Error disconnecting idle provider ${sanitize(id)}`, {
            connectionId: id,
            error: String(error),
          });
        }
        providerCache.delete(key);
      }
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
      if (keepsRunInFlight(entry.provider, entry.connectionId, "idle profiled provider")) {
        logger.info(
          `[DB] Keeping idle profiled provider ${sanitize(entry.connectionId)}: it reports a run in flight, so the next sweep checks it again.`,
        );
        continue;
      }
      logger.info(`[DB] Evicting idle profiled provider: ${sanitize(entry.connectionId)}`);
      if (entry.owner !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- the tunnel below may close only once this provider has closed.
        await teardownProvider(profiledProviderCache, key, entry);
      } else {
        try {
          await entry.provider.disconnect();
        } catch (error) {
          logger.warn(`[DB] Error disconnecting idle profiled provider ${sanitize(entry.connectionId)}`, {
            connectionId: entry.connectionId,
            error: String(error),
          });
        }
        profiledProviderCache.delete(key);
      }
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
 * The owner fields a cached provider is built with (docs/GOVERNANCE.md#per-user-providers): the owner its key frames
 * and the requester's pool size, or nothing for a provider every caller shares, so a context without an owner reaches
 * the provider exactly as it did before owners existed. `owner` is what `providerOwner` answered for the connection.
 */
function ownerContext(owner: string | undefined, requester: EditorExecutionContext): EditorExecutionContext {
  return owner === undefined ? {} : { owner, ownerPoolMax: requester.ownerPoolMax };
}

/**
 * Get or create a database provider with caching
 * Useful for API routes to reuse connections
 *
 * @param connection - Database connection configuration
 * @param options - Optional provider options
 * @param execution - The DuckDB editor file-access posture (non-admin DuckDB file access), and under governance the
 *   owner of a per-user provider (docs/GOVERNANCE.md#per-user-providers), and nothing else. Studio's
 *   routes derive it with `editorExecutionContext` from the verified session and the resolved
 *   connection. ABSENT MEANS DENY: called without it, as an embedder that predates the posture
 *   calls it, a DuckDB handle opens with `enable_external_access: 'false'`, so `read_csv`,
 *   `COPY`, `ATTACH` of a file and `INSTALL` are refused outside its private temp directory and
 *   its database's own file names (docs/providers/duckdb.md section 3.16) while the database
 *   stays writable. Pass
 *   `{ allowExternalFileAccess: true }` for the full editor reach. SQLite refuses a denied handle at
 *   connect, since its drivers cannot confine a statement's file access; every other engine ignores it.
 *   With an `owner`, the provider is that user's own: cached apart from every other user's, opened
 *   with the pool of `ownerPoolMax`, and its entry records the owner; an engine that keeps one handle
 *   per file shares that handle whatever the owner (`providerOwner`).
 *   A `readOnly` in it is refused (`DatabaseConfigError`): this cache holds writable providers,
 *   and a read-only one comes from `createDatabaseProvider` or an execution profile.
 * @returns Cached or new DatabaseProvider instance
 */
export async function getOrCreateProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {},
  execution: EditorExecutionContext = {},
): Promise<DatabaseProvider> {
  // First, ahead of the cache lookup and of any tunnel (#1089): see assertReadOnlyHonoured. The id
  // refusal shares the place: the cache key length-frames connection.id, so a missing id must be
  // refused before the key is computed, as the DatabaseConfigError the provider would have raised (#1539).
  assertConnectionIdPresent(connection);
  assertProviderEnabled(connection);
  assertReadOnlyHonoured(connection);
  assertOwnerPoolHonoured(connection, execution);
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
  // SQLite and DuckDB read it; engines without that capability ignore it.
  const allowExternalFileAccess = execution.allowExternalFileAccess === true;
  // The user this provider is opened for under governance (docs/GOVERNANCE.md#per-user-providers), or undefined for the
  // provider every caller shares: the provider, the entry and the key `editorCacheKey` frames all take this value, so
  // they never disagree.
  const owner = providerOwner(connection, execution.owner);
  const cacheKey = await editorCacheKey(connection, execution);

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

  // A single-writer engine keeps ONE writable handle per file per process. We are about to open one
  // under `cacheKey`, so a handle of THIS connection record on the SAME file under a DIFFERENT key would
  // be a second handle on one file. That happens whenever one record's key changes while its handle is
  // open: an operator edits a DuckDB seed's roles across the admin-only line while Studio runs (the seed
  // file hot-reloads), which flips its file-access posture; an edit changes what the key frames (the
  // fingerprint, the credentials, the read-only mode) and keeps the file; or, on an inline DuckDB
  // connection, an admin and a non-admin present the same client connection id (a browser profile the
  // two accounts share, or a copied id), and then each request closes the other's handle. On DuckDB a
  // second read-write handle keeps its own copy of the catalog and checkpoints it over the file when it
  // closes, losing the first handle's committed rows on Linux and macOS and corrupting the file after a
  // bulk write, and Windows refuses the second open; LibreDB, the other engine that declares
  // `singleWriterFile`, refuses it on every platform. So every such stale handle is closed first, as the
  // query-timeout change above closes its own, leaving this open as the file's only handle; the session
  // state on a closed handle (temporary tables, SET values) goes with it. Entries of a DIFFERENT
  // connection id on the same file are the separate, pre-existing D240 case and are left alone here.
  // `singleWriterFile` is set only for single-writer engines, so this is a no-op for the rest without a
  // type-id branch.
  const openFileIdentity = fileIdentity(connection);
  if (openFileIdentity !== null) {
    // Not the key we are about to open under (any entry still there is disconnected, since a connected
    // one would have returned above), and only this record on this file.
    const stale = [...providerCache].filter(
      ([key, entry]) =>
        key !== cacheKey && entry.connectionId === connection.id && entry.singleWriterFile === openFileIdentity,
    );
    // All of them are closed before the open below. A close that fails is logged and its entry dropped
    // all the same, as the query-timeout change above does.
    const closes = await Promise.allSettled(stale.map(([, entry]) => entry.provider.disconnect()));
    stale.forEach(([key], index) => {
      const close = closes[index];
      if (close.status === "rejected") {
        logger.warn(`[DB] Error disconnecting a stale single-writer handle before reopening`, {
          connectionId: connection.id,
          error: String(close.reason),
        });
      }
      providerCache.delete(key);
    });
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
  // and owner are handed on, so the handle opens under exactly what its key frames; every provider but
  // DuckDB and SQLite ignores the posture: DuckDB closes file access under a denied posture, and SQLite
  // refuses to open under one. An owner opens the pool of that user's share
  // (docs/GOVERNANCE.md#per-user-providers).
  const provider = await createDatabaseProvider(effectiveConnection, options, {
    allowExternalFileAccess,
    ...ownerContext(owner, execution),
  });
  try {
    await connectPhase(() => provider.connect());
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
    owner,
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

/**
 * The key `getOrCreateProvider` caches the provider of `connection` under for `execution`: {@link providerCacheKey} of
 * the connection, of its file-access posture as a definite boolean, absent read as deny, and of the owner that
 * `providerOwner` answers. A connection without an id is refused before the key frames it, as in `getOrCreateProvider`
 * (#1539).
 *
 * Exported for two callers that must name a cached entry without deriving a second key, as `profiledCacheKey` is for its
 * own. The transaction route records the key a governed `begin` resolved, and a later request that resolves another
 * one, because the owner's grant level or the connection's credential changed, has the transaction rolled back on the
 * provider {@link findCachedProvider} answers for the recorded key (docs/GOVERNANCE.md#per-user-providers). And without
 * governance the disconnect route removes only the entries the caller's own record names, its editor entry and its
 * execution-profile entries, by the key scope of `removeProvider` (docs/SECURITY.md, note 0.9). The package does not
 * re-export it.
 */
export async function editorCacheKey(
  connection: DatabaseConnection,
  execution: EditorExecutionContext = {},
): Promise<string> {
  assertConnectionIdPresent(connection);
  return providerCacheKey(
    connection,
    execution.allowExternalFileAccess === true,
    providerOwner(connection, execution.owner),
  );
}

/**
 * The provider the writable cache holds under `key`, which {@link editorCacheKey} answers, or null when it holds none
 * there: the idle sweep, a disconnect or a teardown removed it, and disconnected it on the way out. A lookup, not a
 * use: it opens nothing and leaves the entry's idle clock alone. For `cachedEditorProvider` in
 * src/lib/api/editor-provider.ts, on which the transaction route rolls back a transaction whose owner's credential
 * changed (docs/GOVERNANCE.md#per-user-providers); the package does not re-export it.
 */
export function findCachedProvider(key: string): DatabaseProvider | null {
  return providerCache.get(key)?.provider ?? null;
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
 * statements, so it is served only where the provider can bound one (in one of the three
 * forms the `queryReadOnly` docblock in `src/lib/db/types.ts` names: the engine's own read-only
 * handle or transaction, a least-privilege principal the server's own answers prove, or a
 * Studio-enforced request allowlist plus the identity's own authorization), and only the
 * providers of AGENT_EXECUTION_ENGINES implement that: PostgreSQL, SQLite,
 * DuckDB, SQL Server, MySQL, Kubernetes and MongoDB (`src/lib/agent/engine-support.ts`). `agent-operations` sends no statement
 * at all — it calls the curated reporting methods every provider implements — so
 * requiring a read-only STATEMENT path of it would refuse an engine over a capability
 * the profile never uses. `agent-handover` sends a statement too — the one a run
 * already answered with, replayed in the user's editor — so it takes the same gate as
 * `agent-read-only`; it is a separate row because it carries a different BUDGET
 * (`AGENT_HANDOVER_BUDGET`), and a shared row would have made a later change to one
 * path silently move the other.
 *
 * What all three profiles share is what keeps an acquisition apart from the editor: the
 * same `readOnly: true` (on PostgreSQL and SQL Server that still verifies the role or
 * principal at open, under every profile), the same `agentUser` credential resolution, and
 * the same profiled cache, so neither an operations run nor an editor replay is ever handed
 * the editor's writable pool. What they need not share is a proof a provider keys on
 * `sendsStatements`, the flag `executionContextFor` derives from the second field: such a
 * provider (MongoDB) proves its statement boundary at open for `agent-read-only` and
 * `agent-handover`, and opens `agent-operations`, which sends no statement, with neither the
 * proof nor its refusal.
 */
interface ProfileAcquisition {
  readonly context: ProviderExecutionContext;
  /**
   * Refuse the provider unless it implements a read-only statement path (`queryReadOnly`). Also
   * the source of the context's `sendsStatements`.
   */
  readonly requiresReadOnlyStatements: boolean;
}

const PROFILE_ACQUISITION: Record<ExecutionProfile, ProfileAcquisition> = {
  "agent-read-only": { context: { readOnly: true }, requiresReadOnlyStatements: true },
  "agent-operations": { context: { readOnly: true }, requiresReadOnlyStatements: false },
  "agent-handover": { context: { readOnly: true }, requiresReadOnlyStatements: true },
};

const EXECUTION_PROFILES: ReadonlySet<string> = new Set(Object.keys(PROFILE_ACQUISITION));

/**
 * The execution context a provider is opened with under `profile`, for the requester the acquisition serves.
 *
 * `sendsStatements` is derived from the profile's `requiresReadOnlyStatements` rather than declared in a second column,
 * so the proof a provider runs at open and the engine gate below cannot come to disagree: a profile the gate serves
 * without a read-only statement path is one that sends no statement, and a provider that proves its statement
 * boundary at open does not prove it there. `allowExternalFileAccess` is the requester's posture, absent read as
 * denied.
 *
 * An unknown profile is refused here, never defaulted: the table is a plain object, so a name such as `toString`
 * would read an inherited member and answer a context with no `readOnly` in it. This is the acquisition's refusal:
 * `acquireExecutionProfileProvider`, the one caller, calls this ahead of its cache key and has no check of its own.
 * Exported for the tests.
 */
export function executionContextFor(
  profile: ExecutionProfile,
  requester: EditorExecutionContext = {},
): ProviderExecutionContext {
  if (!EXECUTION_PROFILES.has(profile)) {
    throw new ExecutionProfileError(`Unknown execution profile: ${String(profile)}`, "UNSUPPORTED_PROFILE");
  }
  const acquisition = PROFILE_ACQUISITION[profile];
  return {
    ...acquisition.context,
    sendsStatements: acquisition.requiresReadOnlyStatements,
    allowExternalFileAccess: requester.allowExternalFileAccess === true,
  };
}

/**
 * Resolves the optional least-privilege agent credential from the connection
 * (the connection-secrets seam: `agentPassword` may arrive sealed and is
 * opened with readSecret). Fail closed on every misconfiguration:
 *
 * - both fields absent → null (the profile runs under the connection's own
 *   credentials, still on a read-only statement path under a declared
 *   boundary: the engine's own read-only session, or on Kubernetes Studio's
 *   request allowlist with the connection token's RBAC);
 * - only one field present → deny, unless the engine declares
 *   `agentCredential: "token"` and the field is `agentPassword`: that engine
 *   takes the agent's bearer token alone, and refuses an `agentUser` beside it.
 *   A half-configured credential must not silently degrade to the more
 *   privileged default. The form is the provider's declaration, so it is
 *   decided by `assertAgentCredentialForm` once the provider is built and
 *   before it connects; this function only reads what the fields hold;
 * - a sealed password that does not open → deny, never a plaintext fallback;
 * - combined with a connection string → deny: buildPoolConfig ignores
 *   user/password fields when a connection string is present, so the
 *   credential would be silently dropped and the agent would run as the more
 *   privileged embedded user.
 */
function resolveAgentCredential(connection: DatabaseConnection): { user?: string; password?: string } | null {
  const { agentUser, agentPassword } = connection;
  if (agentUser === undefined && agentPassword === undefined) return null;
  if (connection.connectionString) {
    throw new ExecutionProfileError(
      `Connection "${connection.id}" configures an agent credential alongside a connection string; the credential cannot be applied, so acquisition is refused`,
      "AGENT_CREDENTIAL_WITH_CONNECTION_STRING",
    );
  }
  if (!agentPassword) return { user: agentUser };
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
 * Refuses an agent credential whose form the built provider does not take, before it connects. An engine declaring
 * `agentCredential: "token"` takes `agentPassword` alone; every other engine takes `agentUser` and `agentPassword`
 * together. Read from the provider rather than from `connection.type`, which `CLAUDE.md` forbids here.
 */
function assertAgentCredentialForm(connection: DatabaseConnection, provider: DatabaseProvider): void {
  const { agentUser, agentPassword } = connection;
  const tokenOnly = provider.getCapabilities().agentCredential === "token";
  if (tokenOnly && agentUser !== undefined) {
    throw new ExecutionProfileError(
      `Connection "${connection.id}" configures an agent user, and this engine takes the agent's token alone: clear the agent user`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
  if (!agentPassword || (!tokenOnly && !agentUser)) {
    throw new ExecutionProfileError(
      `Connection "${connection.id}" configures an incomplete agent credential (user and password are both required)`,
      "AGENT_CREDENTIAL_UNRESOLVABLE",
    );
  }
}

/**
 * Acquire a provider for (connection id, execution profile). Never touches
 * the shared writable cache in either direction: the profiled provider has
 * its own keyed lifecycle, so an agent execution can never be handed the
 * editor's fully-privileged pool, and an editor request can never be handed a
 * read-only one.
 *
 * Whether a provider without a read-only statement path is refused is the
 * PROFILE's decision, not this function's: under `agent-read-only` it is refused
 * rather than silently served `query()` (fail closed), and under `agent-operations`
 * it is served, because that profile sends no statement for a read-only wrapper to
 * bound. See `PROFILE_ACQUISITION` for the whole of that argument.
 *
 * `requester` is the editor posture of the caller this acquisition serves, as
 * `editorExecutionContext` derives it (non-admin DuckDB file access). It reaches the profiled
 * handle and its cache key, as the editor's posture does: SQLite's drivers cannot confine a
 * statement's file access even on a read-only handle, so a denied requester is refused at connect
 * here too, while DuckDB's read-only profile already closes file access whatever the posture. It
 * also decides which open single-writer handle an `agent-operations` acquisition may borrow:
 * one opened under that same posture, so an admin's agent is grounded from the admin's
 * own editor handle as before, and a requester is never lent a handle wider than its own.
 * Absent means deny, like everywhere else on this channel. Its owner (docs/GOVERNANCE.md#per-user-providers) makes the
 * profiled provider that user's own, as in the writable cache, with the pool of `ownerPoolMax`.
 */
export async function acquireExecutionProfileProvider(
  connection: DatabaseConnection,
  profile: ExecutionProfile,
  options: ProviderOptions = {},
  requester: EditorExecutionContext = {},
): Promise<DatabaseProvider> {
  // First, ahead of the profiled cache lookup and of any tunnel (#1089): see assertReadOnlyHonoured.
  // The id refusal shares the place for the same reason: the profiled key frames connection.id (#1539).
  assertConnectionIdPresent(connection);
  assertProviderEnabled(connection);
  assertReadOnlyHonoured(connection);
  assertOwnerPoolHonoured(connection, requester);
  // Refuses an unknown profile ahead of the cache key, which frames the profile.
  const execution = executionContextFor(profile, requester);

  // The requester's own provider under governance (docs/GOVERNANCE.md#per-user-providers), as in the writable cache:
  // `profiledCacheKey` frames the same owner, and the provider and its entry take it from here.
  const owner = providerOwner(connection, requester.owner);
  const cacheKey = await profiledCacheKey(connection, profile, requester);
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

  // A partial credential is overlaid as it stands so the provider can be built and asked for its form; one it does
  // not take is refused below, before any connect.
  let effectiveConnection: DatabaseConnection = credential
    ? {
        ...connection,
        ...(credential.user === undefined ? {} : { user: credential.user }),
        ...(credential.password === undefined ? {} : { password: credential.password }),
      }
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

  const provider = await createDatabaseProvider(effectiveConnection, options, {
    ...execution,
    ...ownerContext(owner, requester),
  });
  if (credential !== null) {
    try {
      assertAgentCredentialForm(connection, provider);
    } catch (error) {
      await closeFreshTunnel();
      throw error;
    }
  }
  if (acquisition.requiresReadOnlyStatements && typeof provider.queryReadOnly !== "function") {
    await closeFreshTunnel();
    throw new ExecutionProfileError(
      `Provider type "${connection.type}" implements no read-only statement path (queryReadOnly)`,
      "PROFILE_UNSUPPORTED_BY_PROVIDER",
    );
  }

  try {
    await connectPhase(() => provider.connect());
  } catch (error) {
    await closeFreshTunnel();
    throw error;
  }

  profiledProviderCache.set(cacheKey, { provider, lastUsed: Date.now(), connectionId: connection.id, owner });
  startIdleSweep();

  return provider;
}

/**
 * Remove the cached providers of `connectionId` and disconnect them, from the writable cache and the execution-profile
 * cache alike: a deleted or re-credentialed connection must not leave a stale agent pool running under the old
 * configuration. The scope decides which entries of the connection go, and no scope ever reaches another connection's:
 *
 * - Without a scope, every entry of the connection in both caches, and then its SSH tunnel, as before owners existed.
 * - With an owner scope, every entry of either cache opened for `scope.owner`, and no other. Under governance every
 *   user's providers are their own (docs/GOVERNANCE.md#per-user-providers), so one user's disconnect must not tear down
 *   another user's pool, session state or transaction. An engine that keeps one handle per file records no owner on it
 *   (`providerOwner`), so its one handle, which every owner shares, is left to the removal without a scope.
 * - With a key scope, the entry the writable cache holds under `scope.key`, which {@link editorCacheKey} answers for one
 *   record of the connection, and the entries the profiled cache holds under that key with a profile framed onto it
 *   (`withProfile`), the record's own execution-profile providers. No other entry goes: one opened with another record
 *   of the same id, or under another file-access posture, is cached under another key. Without governance every caller
 *   of a connection shares its provider, so a disconnect may remove only what the caller's own record names
 *   (docs/SECURITY.md, note 0.9). The key frames the server and the credentials, so naming a connection id reaches
 *   nothing.
 *
 * The SSH tunnel serves every entry of the connection, so a scoped removal closes it only once no entry of either cache
 * still serves the connection, as the idle sweep does. A scope that names neither an owner nor a key as a string, or
 * names both, is refused before anything is removed: matching on a missing owner would remove the entries every caller
 * shares.
 *
 * An owned entry is torn down (`teardownProvider`): it leaves the cache first, an open transaction on it is rolled
 * back, and a pool that hangs is abandoned, so the removal of a user's providers, which the governance loader asks for
 * when a grant is taken away or changed (`src/lib/db/owner-removal.ts`), ends within 15 s. The owned entries are torn
 * down at once, and before the tunnel goes. An entry every caller shares is disconnected as before.
 */
export async function removeProvider(
  connectionId: string,
  scope?: { owner: string; key?: never } | { key: string; owner?: never },
): Promise<void> {
  const owner: unknown = scope?.owner;
  const scopedKey: unknown = scope?.key;
  const byKey = typeof scopedKey === "string" && owner === undefined;
  if (scope !== undefined && !byKey && !(typeof owner === "string" && scopedKey === undefined)) {
    throw new DatabaseConfigError(
      "removeProvider takes a scope only with the owner whose providers it removes or the cache key of the record whose providers it removes, as a string, and never with both.",
    );
  }
  // A key scope names the record's writable entry by the key itself, and its profiled entries by the key with each
  // profile framed onto it.
  const profiledKeys: ReadonlySet<string> = new Set(
    byKey ? Array.from(EXECUTION_PROFILES, (profile) => withProfile(profile, scopedKey)) : [],
  );
  const removes = (entry: CachedProvider, keyed: boolean): boolean =>
    entry.connectionId === connectionId && (scope === undefined || (byKey ? keyed : entry.owner === owner));
  const teardowns: Promise<void>[] = [];

  // A connection can hold more than one entry now - one per distinct server-and-credentials
  // it was opened with - so this removes every entry serving it, the way the profiled loop
  // below always has.
  for (const [key, entry] of providerCache) {
    if (!removes(entry, key === scopedKey)) continue;
    if (entry.owner !== undefined) {
      teardowns.push(teardownProvider(providerCache, key, entry));
      continue;
    }
    try {
      await entry.provider.disconnect();
    } catch (error) {
      logger.warn(`Error disconnecting provider ${sanitize(connectionId)}`, { connectionId, error: String(error) });
    }
    providerCache.delete(key);
  }

  for (const [key, entry] of profiledProviderCache) {
    if (!removes(entry, profiledKeys.has(key))) continue;
    if (entry.owner !== undefined) {
      teardowns.push(teardownProvider(profiledProviderCache, key, entry));
      continue;
    }
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
  await Promise.all(teardowns);

  // The entries the scope left, another owner's or another record's, keep the tunnel they reach the connection through.
  if (scope !== undefined && connectionStillServed(connectionId)) return;

  // Close SSH tunnel if exists
  try {
    await closeSSHTunnel(connectionId);
  } catch (error) {
    logger.warn(`Error closing SSH tunnel for ${sanitize(connectionId)}`, { connectionId, error: String(error) });
  }
}

// Every copy of this module a process loads registers its owner-scoped removal, because the governance loader runs in
// another Next.js bundle than the route handlers that fill these caches (src/lib/db/owner-removal.ts).
registerOwnerRemoval(removeProvider);

/**
 * Clear all cached providers (shared and execution-profile), all at once.
 * An owned provider (docs/GOVERNANCE.md#per-user-providers) is torn down (`teardownProvider`), so an open transaction
 * it holds is rolled back before it closes, and it is waited for at most 15 s; a provider every caller shares is
 * disconnected as before.
 */
export async function clearProviderCache(): Promise<void> {
  // Stop idle sweep
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  const disconnectPromises: Promise<void>[] = [];

  for (const [key, entry] of providerCache) {
    if (entry.owner !== undefined) {
      disconnectPromises.push(teardownProvider(providerCache, key, entry));
      continue;
    }
    disconnectPromises.push(
      entry.provider.disconnect().catch((error) => {
        // The id is an argument, never part of the first one: `console.error`'s first argument
        // is a format string, and a constant cannot be a format attack (js/tainted-format-string).
        console.error("[DB] Error disconnecting provider", sanitize(entry.connectionId), error);
      }),
    );
  }
  for (const [key, entry] of profiledProviderCache) {
    if (entry.owner !== undefined) {
      disconnectPromises.push(teardownProvider(profiledProviderCache, key, entry));
      continue;
    }
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
 * The hooks other modules registered with `onShutdown()` (src/lib/shutdown.ts), such as the governance
 * listener's close, run first, cut at their 5 s deadline, and the providers are closed after them.
 */
export function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = async (signal: string) => {
    logger.info(`[DB] Received ${signal}, closing all database connections...`);
    await runShutdownHooks();
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
