/**
 * The legacy adapter's open (issue #2537): the open of an engine whose record offers a legacy provider, and the only
 * core module that constructs a legacy provider class. `openEngine` (../open-engine) calls `openLegacyEngine` after the
 * one ordered open check (`assertOpenable` in src/lib/db/open-check.ts) passed the connection, so nothing here repeats
 * what that check refuses; the provider factory's entry points (src/lib/db/factory.ts) open through `openEngine`.
 *
 * After two host defect guards, in this order:
 * 1. the process's egress decision, which the check took, read again to hand to the provider
 *    (src/lib/db/egress-decision.ts);
 * 2. the copy the provider is built from (`providerConnection` in src/lib/db/provider-connection.ts);
 * 3. the local file and the host paths core admits (`admittedFileConnection` and `admittedHostPathConnection` in
 *    src/lib/db/provider-files.ts), each refused by name before any provider exists;
 * 4. the build context: a copy of the execution context with core's egress decision and, for an engine whose record's
 *    `connection.readsTrustMaterial` is true, core's trust material (src/lib/db/trust-material.ts);
 * 5. the log line `[DB] Creating <type> provider for "<name>"`;
 * 6. the options: the connection's query timeout unless the caller's options name one, and an owner's pool;
 * 7. the switch: one case per legacy engine, each importing its provider module from src/lib/db/providers/ and
 *    constructing its class. A build connects nothing: the caller connects the provider it is answered.
 *
 * The switch has no `default`: the record's id is a `DatabaseType` (`legacyProviderType` in
 * src/lib/db/server-catalog.ts), and the compiler holds the switch exhaustive over that union, so a type id without a
 * case fails the typecheck (TS2366). Each case's dynamic import names its module by a literal specifier, which every
 * build output (Next.js, the library build and the VS Code backend child) traces into a chunk of its own and loads on
 * demand.
 */
import { egressDecision } from "@/lib/db/egress-decision";
import { providerConnection } from "@/lib/db/provider-connection";
import { admittedFileConnection, admittedHostPathConnection, opcuaPkiRoot } from "@/lib/db/provider-files";
import { type EngineConnection, type EngineRecord, legacyProviderType } from "@/lib/db/server-catalog";
import { trustMaterial } from "@/lib/db/trust-material";
import { quoteTypeId } from "@/lib/db/type-id";
import type { DatabaseProvider, ProviderBuildContext, ProviderExecutionContext, ProviderOptions } from "@/lib/db/types";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/** Strips the control characters a log line's framing is made of from a caller-supplied value. */
const sanitize = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/**
 * Whether `connection` is a connection of `type`: its type is the one member by which an `EngineConnection` differs
 * from a `DatabaseConnection` (src/lib/db/server-catalog.ts).
 */
function namesType(connection: EngineConnection, type: DatabaseType): connection is DatabaseConnection {
  return connection.type === type;
}

/**
 * Builds the legacy provider of `engine` for `given`, unconnected; see the module's docblock for the steps. The caller
 * ran the one ordered open check on `given` and `execution`.
 *
 * @throws {Error} A host defect, before anything is read or built: when `engine`'s record offers no legacy provider, or
 * when `given`'s type is not the record's id.
 * @throws {DatabaseConfigError} When the local file or a host path the connection names is refused, when the trust
 * material an engine that reads it needs is invalid, or when an OPC UA connection is built while
 * `LIBREDB_OPCUA_PKI_ROOT` is relative; or a provider constructor's own error.
 */
export async function openLegacyEngine(
  engine: EngineRecord,
  given: EngineConnection,
  execution: ProviderExecutionContext,
  options: ProviderOptions,
): Promise<DatabaseProvider> {
  const type = legacyProviderType(engine);
  if (type === undefined) {
    throw new Error(
      `The engine ${quoteTypeId(engine.id)} offers no legacy provider, so the legacy adapter opens nothing for it: a caller that opens it here is a host defect.`,
    );
  }
  if (!namesType(given, type)) {
    throw new Error(
      `A connection of type ${quoteTypeId(given.type)} reached the legacy adapter's open of the engine ${quoteTypeId(engine.id)}: a caller that opens a connection through another engine's record is a host defect.`,
    );
  }
  // The decision the check took, read again to hand to the provider: the process keeps it.
  const egress = egressDecision();
  // Every provider is built from the connection `providerConnection` answers: a copy holding only the fields its engine
  // declares and core's markers, the tunnel's route under `TUNNEL_ROUTE` for a record that carries a tunnel, so no
  // provider receives the tunnel or its password, private key or passphrase, the agent credential or a field its engine
  // does not declare (FND-2, docs/SECURITY.md 3.41). When core opens a tunnel (getOrCreateProvider,
  // acquireExecutionProfileProvider, withOneShotTunnel), it dials with those before it calls this function; a tunnel
  // that is on and was not opened was refused by the check, except for readProviderDeclarations, which never hands its
  // provider out.
  let connection: DatabaseConnection = providerConnection(given);
  // A SQLite, DuckDB or LibreDB connection (`GRANTED_OPENS_LOCAL_FILE`) is handed the file core admitted, resolved
  // against the working directory now; one of Studio's own storage files, a path the reserved check cannot read, a NUL
  // byte, a connection string that names no file after `file:` or a name that is not text is refused here, by name,
  // before any provider exists (FND-2 slice 3, docs/SECURITY.md 3.45). Every other connection passes unchanged.
  connection = admittedFileConnection(connection);
  // The files on Studio's host a connection's `GRANTED_HOST_PATH_FIELDS` name (OPC UA's client certificate and key)
  // are admitted the same way, each refused by name with its field, and handed to the provider as absolute paths.
  connection = admittedHostPathConnection(connection);
  // What every provider that takes a context is handed: a copy of the caller's execution context, plain data as the
  // open check checked it, the process's egress decision, which a guarded provider hands its guard, and, for an engine
  // whose record's `connection.readsTrustMaterial` is true, the trust material core read from the file
  // NODE_EXTRA_CA_CERTS names, which that provider's own TLS library would never read (FND-2, the provider plugins
  // design section 0.1). The material is read only for such an engine, so an invalid bundle refuses that build here,
  // before the log line, and no other. One rule for every case below, and never a caller's `egress` or `trust`: both
  // are set here, last.
  const context: ProviderBuildContext = {
    ...execution,
    egress,
    trust: engine.connection.readsTrustMaterial ? trustMaterial() : undefined,
  };
  console.log(`[DB] Creating ${sanitize(connection.type)} provider for "${sanitize(connection.name || "")}"`);

  // Explicit overrides (such as the connectivity probe) take precedence over saved settings.
  options = { ...options, queryTimeout: options.queryTimeout ?? connection.queryTimeout };
  // An owned provider serves one user (docs/GOVERNANCE.md#per-user-providers): its pool opens nothing until that user
  // asks, and never more than the user's share, whatever size the caller's options name. The rest of the caller's pool
  // options stand.
  if (execution.owner !== undefined) {
    options = { ...options, pool: { ...options.pool, min: 0, max: execution.ownerPoolMax } };
  }

  // No `default`: the guards above held the connection's type to the record's id, a `DatabaseType`, and the compiler
  // holds this switch exhaustive over that union, so a type id without a case fails the typecheck (TS2366) rather than
  // reaching the end of the function at run time.
  switch (connection.type) {
    // SQL Databases - dynamically imported to reduce memory
    case "postgres": {
      const { PostgresProvider } = await import("@/lib/db/providers/sql/postgres");
      return new PostgresProvider(connection, options, context);
    }

    case "mysql": {
      const { MySQLProvider } = await import("@/lib/db/providers/sql/mysql");
      return new MySQLProvider(connection, options, context);
    }

    case "sqlite": {
      const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
      return new SQLiteProvider(connection, options, context);
    }

    case "duckdb": {
      const { DuckDBProvider } = await import("@/lib/db/providers/sql/duckdb");
      return new DuckDBProvider(connection, options, context);
    }

    case "libsql": {
      const { LibSQLProvider } = await import("@/lib/db/providers/sql/libsql");
      return new LibSQLProvider(connection, options, context);
    }

    case "oracle": {
      const { OracleProvider } = await import("@/lib/db/providers/sql/oracle/index");
      return new OracleProvider(connection, options, context);
    }

    case "db2": {
      const { Db2Provider } = await import("@/lib/db/providers/sql/db2/index");
      return new Db2Provider(connection, options, context);
    }

    case "mssql": {
      const { MSSQLProvider } = await import("@/lib/db/providers/sql/mssql");
      return new MSSQLProvider(connection, options, context);
    }

    case "clickhouse": {
      // The explicit /index specifier keeps this dynamic import statically analysable: a bare directory resolves
      // only at runtime, which the bundler cannot trace into a chunk. The execution context's `readOnly` and
      // `sendsStatements` together are what the open-time proof keys on.
      const { ClickHouseProvider } = await import("@/lib/db/providers/sql/clickhouse/index");
      return new ClickHouseProvider(connection, options, context);
    }

    case "druid": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { DruidProvider } = await import("@/lib/db/providers/sql/druid/index");
      return new DruidProvider(connection, options, context);
    }

    case "trino": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { TrinoProvider } = await import("@/lib/db/providers/sql/trino/index");
      return new TrinoProvider(connection, options, context);
    }

    case "databend": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The constructor validates
      // nothing and opens nothing; the connection's rules run in connect(), before any socket.
      const { DatabendProvider } = await import("@/lib/db/providers/sql/databend/index");
      return new DatabendProvider(connection, options, context);
    }

    case "bigquery": {
      const { BigQueryProvider } = await import("@/lib/db/providers/sql/bigquery/index");
      return new BigQueryProvider(connection, options, context);
    }

    case "snowflake": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The build context is third;
      // the transport deps are a fourth argument, a test's seam this open never passes, and the origin comes from
      // the Account field alone.
      const { SnowflakeProvider } = await import("@/lib/db/providers/sql/snowflake/index");
      return new SnowflakeProvider(connection, options, context);
    }

    case "spark": {
      // The explicit /index specifier keeps this dynamic import statically analysable. Two arguments only: the
      // third, the wire transport, is a test's seam this open never passes.
      const { SparkProvider } = await import("@/lib/db/providers/sql/spark/index");
      return new SparkProvider(connection, options);
    }

    case "cassandra": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { CassandraProvider } = await import("@/lib/db/providers/sql/cassandra/index");
      return new CassandraProvider(connection, options, context);
    }

    // Search engines - two type-ids, ONE implementation module (issue #424 Phase 1).
    // The explicit /index specifier keeps this dynamic import statically
    // analysable: a bare directory resolves only at runtime, which the bundler
    // cannot trace into a chunk.
    case "elasticsearch": {
      const { ElasticsearchProvider } = await import("@/lib/db/providers/sql/search/index");
      return new ElasticsearchProvider(connection, options, context);
    }

    case "opensearch": {
      const { OpenSearchProvider } = await import("@/lib/db/providers/sql/search/index");
      return new OpenSearchProvider(connection, options, context);
    }

    // Document Databases - dynamically imported. The execution context reaches the
    // MongoDB constructor like the SQL engines' and Kubernetes': its `readOnly` and
    // `sendsStatements` together are what the connect-time verification keys on (issue #1614).
    case "mongodb": {
      const { MongoDBProvider } = await import("@/lib/db/providers/document/mongodb");
      return new MongoDBProvider(connection, options, context);
    }

    case "couchbase": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { CouchbaseProvider } = await import("@/lib/db/providers/document/couchbase/index");
      return new CouchbaseProvider(connection, options, context);
    }

    case "firestore": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context decides
      // whether the handle answers agent reads, and every surface of an agent-mode handle reads metadata only.
      const { FirestoreProvider } = await import("@/lib/db/providers/document/firestore/index");
      return new FirestoreProvider(connection, options, context);
    }

    // Key-Value Stores - dynamically imported
    case "redis": {
      const { RedisProvider } = await import("@/lib/db/providers/keyvalue/redis");
      return new RedisProvider(connection, options, context);
    }

    case "etcd": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The
      // execution context rides along, so an execution profile opens it read-only (#1089 E6).
      const { EtcdProvider } = await import("@/lib/db/providers/keyvalue/etcd/index");
      return new EtcdProvider(connection, options, context);
    }

    case "oxia": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context rides
      // along, so a refusal names the read-only mode an execution profile set (O1).
      const { OxiaProvider } = await import("@/lib/db/providers/keyvalue/oxia/index");
      return new OxiaProvider(connection, options, context);
    }

    // Time-series stores - dynamically imported
    case "prometheus": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk. The execution context decides whether the handle answers agent reads.
      const { PrometheusProvider } = await import("@/lib/db/providers/timeseries/prometheus/index");
      return new PrometheusProvider(connection, options, context);
    }

    // Two type-ids served by one directory, one per query language (InfluxDB spec I2, I23). Both are read-only
    // whatever the flag says. The execution context decides whether the open proves the principal reads only, for
    // the agent read-only profile.
    case "influxdb": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { InfluxDBProvider } = await import("@/lib/db/providers/timeseries/influxdb/index");
      return new InfluxDBProvider(connection, options, context);
    }

    case "influxdb3": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { InfluxDB3Provider } = await import("@/lib/db/providers/timeseries/influxdb/index");
      return new InfluxDB3Provider(connection, options, context);
    }

    // Message logs - dynamically imported
    case "kafka": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { KafkaProvider } = await import("@/lib/db/providers/stream/kafka/index");
      return new KafkaProvider(connection, options, context);
    }

    // Graph databases - dynamically imported
    case "neo4j": {
      // The explicit /index specifier keeps this dynamic import statically
      // analysable: a bare directory resolves only at runtime, which the bundler
      // cannot trace into a chunk.
      const { Neo4jProvider } = await import("@/lib/db/providers/graph/neo4j/index");
      // The execution context decides whether the open proves the user reads only, for the agent read-only profile.
      return new Neo4jProvider(connection, options, context);
    }

    // Vector databases - dynamically imported
    case "milvus": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context
      // rides along, so an execution profile opens it read-only (vector-family spec E8).
      const { MilvusProvider } = await import("@/lib/db/providers/vector/milvus/index");
      return new MilvusProvider(connection, options, context);
    }

    case "qdrant": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context
      // rides along, so an execution profile opens it read-only, as etcd's does.
      const { QdrantProvider } = await import("@/lib/db/providers/vector/qdrant/index");
      return new QdrantProvider(connection, options, context);
    }

    case "weaviate": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context
      // rides along, so an execution profile opens it read-only, as Qdrant's does.
      const { WeaviateProvider } = await import("@/lib/db/providers/vector/weaviate/index");
      return new WeaviateProvider(connection, options, context);
    }

    // Object storage - dynamically imported
    case "s3": {
      // The explicit /index specifier keeps this dynamic import statically analysable. The execution context rides
      // along, so an execution profile opens it read-only, as Qdrant's does.
      const { S3Provider } = await import("@/lib/db/providers/objectstore/s3/index");
      return new S3Provider(connection, options, context);
    }

    // MQTT: a key-value provider beside the platforms, its Keys panel the whole surface and no query console
    // of its own. The execution context decides whether the handle answers agent reads.
    case "mqtt": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { MqttProvider } = await import("@/lib/db/providers/keyvalue/mqtt/index");
      return new MqttProvider(connection, options, context);
    }

    // RabbitMQ: the second member of the stream family, read-only whatever the flag says. It reads the execution
    // context for its agent read path; no seam is passed: it runs on its production transport, AMQP dial and clock.
    case "rabbitmq": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { RabbitMQProvider } = await import("@/lib/db/providers/stream/rabbitmq/index");
      return new RabbitMQProvider(connection, options, context);
    }

    // OPC UA: an address space browsed level by level, read-only by its seam of eight read services. The execution
    // context decides whether the handle answers agent reads; an agent-mode handle holds no session.
    case "opcua": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { OpcuaProvider } = await import("@/lib/db/providers/industrial/opcua/index");
      // THE LIBRARY IS IMPORTED BY THE FIRST CONNECT, NOT BY CONSTRUCTION, and that is measured
      // rather than tidy: `node-opcua-hostname` calls `prepareFQDN()` at import time, un-awaited,
      // and its `dns.lookupService` throws inside a callback where the library's own try/catch
      // cannot see it. Under Node 24.14.0 here the hostname resolves to `::1` and nothing happens;
      // under Bun 1.4.2 it resolved to a zone-indexed link-local address
      // (`fe80::…%15`) and the error surfaced as an uncaught one. Constructing a provider must not
      // depend on that, so the import happens when a session is actually opened.
      //
      // The PKI root is core's decision (FND-2 slice 3): `LIBREDB_OPCUA_PKI_ROOT`, or `opcua-pki` under Studio's data
      // directory, read now and handed over, so nothing the environment says at connect reaches the provider; a
      // relative
      // variable is refused here, before the provider is built.
      return new OpcuaProvider(
        connection,
        options,
        context,
        async (read) => {
          const { openLibrarySession } = await import("@/lib/db/providers/industrial/opcua/library");
          return openLibrarySession(read);
        },
        opcuaPkiRoot(connection.type),
      );
    }

    // MTConnect: an agent in front of machine tools, read over HTTP, read-only by its closed table of nine GET routes.
    // The execution context decides whether the handle answers agent reads. No library: the client is this
    // repository's own over the shared transport, so the import is the provider module and nothing else.
    case "mtconnect": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { MTConnectProvider } = await import("@/lib/db/providers/industrial/mtconnect/index");
      return new MTConnectProvider(connection, options, context);
    }
    // SNMP: an agent on a device, read over UDP by this repository's own client through the shared egress rule.
    // Read-only by construction: the outgoing valve parses every datagram and refuses any PDU that is not a Get,
    // GetNext or GetBulk, so a Set never reaches the socket. No library, so the import is the provider module itself.
    // The execution context decides whether the handle answers agent reads; an agent-mode handle refuses the console.
    case "snmp": {
      const { SnmpProvider } = await import("@/lib/db/providers/network/snmp/index");
      return new SnmpProvider(connection, options, context);
    }

    // Modbus TCP: a device or a gateway, read over a raw socket by this repository's own client through the shared
    // egress rule. Read-only by construction: the valve refuses every function code but the four reads and 43/14. No
    // library, so the import is the provider module. The execution context decides whether the handle answers agent
    // reads; an agent-mode handle refuses the console and paces the device.
    case "modbus": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { ModbusProvider } = await import("@/lib/db/providers/industrial/modbus/index");
      return new ModbusProvider(connection, options, context);
    }

    // Platforms - dynamically imported
    case "kubernetes": {
      // The explicit /index specifier keeps this dynamic import statically analysable. Read-only whatever the flag
      // says; the execution context rides along, so `queryReadOnly` answers only under an agent profile.
      const { KubernetesProvider } = await import("@/lib/db/providers/platform/kubernetes/index");
      return new KubernetesProvider(connection, options, {}, context);
    }

    // Network devices - dynamically imported
    case "netconf": {
      // The explicit /index specifier keeps this import statically analysable; the context gates agent reads.
      const { NetconfProvider } = await import("@/lib/db/providers/network/netconf/index");
      return new NetconfProvider(connection, options, context);
    }

    // Sparkplug B (#1720), the third member of the `industrial/` family. Its own bounded MQTT session rather than the
    // shipped MQTT read, which returns one row per topic, since a Sparkplug read depends on the order of successive
    // messages on one topic. The execution context decides whether the handle answers agent reads.
    case "sparkplug": {
      // The explicit /index specifier keeps this dynamic import statically analysable.
      const { SparkplugProvider } = await import("@/lib/db/providers/industrial/sparkplug/index");
      return new SparkplugProvider(connection, options, context);
    }

    // Embedded databases - dynamically imported
    case "libredb": {
      // The execution context decides the open: an acquisition that sends statements opens the file through the
      // read-only adapter, with no writer lock, beside the editor's writer.
      const { LibreDBProvider } = await import("@/lib/db/providers/embedded/libredb");
      return new LibreDBProvider(connection, options, context);
    }
  }
}
