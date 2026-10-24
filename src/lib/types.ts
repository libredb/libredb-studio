/*
  This module type-imports from `src/lib/db`, which is the opposite of the usual direction,
  and it is deliberate (#789).

  `SchemaSnapshot.schema` stores what the consumer actually held, and that shape is
  `StoredObject`, which is `DetailedObject` with the two fields a record written before the
  object model could not carry. The alternative is a second declaration of the same shape
  here, which is precisely the drift the field's own docblock records: the declaration said
  `TableSchema` while the stored JSON carried two more fields, and a later reader trusted the
  type instead of the data. One declaration, imported, cannot drift.

  It is TYPE-ONLY in both directions and there is no runtime edge: `detailed-object.ts` imports
  `ColumnSchema`, `ForeignKeySchema` and `IndexSchema` from this file, so the two are a type
  cycle that TypeScript resolves and every bundler erases. Nothing is imported for a value, so
  no module graph is created by it.
*/
import type { StoredObject } from "@/lib/db/detailed-object";
import type { ObjectSourceDocument } from "@/lib/db/types";
import type { VectorColumn } from "@/lib/db/vector/types";

export type DatabaseType =
  | "postgres"
  | "bigquery"
  | "snowflake"
  | "mysql"
  | "sqlite"
  | "mongodb"
  | "redis"
  | "oracle"
  | "mssql"
  // IBM Db2 for Linux, UNIX and Windows (issue #786), reached through a Rust DRDA client shipped
  // as native N-API addons, so no IBM client library is installed anywhere. Db2 for z/OS
  // and Db2 for IBM i speak the same protocol and are out of scope: neither has been connected
  // to, and their catalogs are not the `SYSCAT` views this provider reads.
  | "db2"
  | "libredb"
  | "couchbase"
  | "clickhouse"
  | "druid"
  // Two type-ids, ONE provider implementation (issue #424 Phase 1,
  // `src/lib/db/providers/sql/search/index.ts`): the two products speak the same
  // shape of SQL over HTTP and differ only in wire detail. They stay separate ids
  // because a connection has to say which product is listening - the SQL endpoint
  // path is product-specific and the wrong one never reaches a SQL engine - and
  // because their grammars really do disagree (OFFSET, string escapes, `#`, `[…]`).
  | "elasticsearch"
  | "opensearch"
  // Apache Cassandra (issue #424 Phase 4). A wide-column store whose CQL is
  // SQL-SHAPED but not SQL: no JOIN, no OFFSET, no EXPLAIN and no subquery are in
  // the grammar at all (each measured on 5.0.9). It is still a `SQLBaseProvider`
  // dialect, because what the editor sends IS the statement text and the shared
  // limiter's `LIMIT n` is correct CQL. The connection's `database` field pins one
  // KEYSPACE, and `localDataCenter` is a field only this engine has - the driver
  // refuses to connect without it.
  | "cassandra"
  // Trino (issue #424 Phase 2). A QUERY ENGINE rather than a store: what the
  // connection's `database` field pins is a Trino CATALOG (`tpch`, `hive`, `iceberg`),
  // the way a PostgreSQL connection pins a database, and the schemas inside it are the
  // schema level. PrestoDB is deliberately NOT this id - the transport builds its
  // header names from a dialect descriptor's prefix, so that fork is a descriptor away
  // rather than a rewrite.
  | "trino"
  // libSQL (issue #424 Phase 5). SQLite's dialect over a network: a self-hosted
  // libSQL server (`sqld`) and Turso Cloud are the SAME id, because they speak the
  // same protocol and embed the same SQLite - the cloud is that server managed, and
  // a connection to either differs only in host and token. It is separate from
  // `sqlite` for the reason the two cannot share a provider: the SQLite one holds a
  // FILE handle through a synchronous driver, and this one holds no handle at all.
  // The credential is a token rather than a password, so the form labels it that
  // way, and the server refuses `VACUUM`, `ANALYZE` and `PRAGMA query_only` - which
  // is why this id offers fewer maintenance operations than `sqlite` does.
  //
  // Turso Database, the Rust rewrite, is NOT this id and has no row anywhere yet: it
  // publishes no server image (`tursodatabase/turso`, `tursodb` and `turso-server`
  // were all unpullable on 2026-08-27) and ships as an in-process npm engine, so
  // there is nothing to connect to and #424 publishes no name it has not connected
  // to.
  | "libsql"
  // DuckDB (issue #424). An EMBEDDED analytical engine: the whole connection is a
  // file path (or `:memory:`), there is nothing listening on a port, and the driver
  // is a native N-API addon this app loads in its own process. It is separate from
  // `sqlite` for the reason those two cannot share a provider even though both open
  // a local file: the dialects disagree (`[1,2][1]` is a list index here, not a
  // quoted identifier; block comments nest; `X'…'` is a STRING rather than a blob),
  // the catalog is DuckDB's own `duckdb_*` table functions rather than
  // `sqlite_master`, and the file admits exactly ONE operating-system process - a
  // second one is refused even in read-only mode, which is why this provider
  // declares `singleWriterFile`.
  //
  // MotherDuck (`md:`), Quack and DuckLake are NOT this id and have no row anywhere
  // yet: each is a different connection story than a local path, and #424 publishes
  // no name it has not connected to.
  | "duckdb"
  // Prometheus (#1085). A metrics store queried in PromQL over its HTTP API, and the first
  // provider whose `queryLanguage` is neither `sql` nor `json`. The connection is a host, a port
  // and an optional credential: `user` and `password` are HTTP Basic, and a password with no
  // user is sent as a bearer token. VictoriaMetrics speaks the same API and is recorded as a
  // relative of this id, never as an id of its own.
  | "prometheus"
  // Apache Kafka (#1088). A message log browsed read-only over the Kafka protocol, the first
  // member of the `stream/` family. Its editor text is a JSON read request, so it declares
  // `queryLanguage: "json"` with a `queryDialect` of its own. The connection is one bootstrap
  // address plus TLS and an optional SASL credential, `saslMechanism` below naming how `user` and
  // `password` are checked; the client learns every other broker from the cluster's metadata.
  | "kafka"
  // etcd (#1089). A key-value store read and written over its gRPC API, the second member of the
  // `keyvalue/` family beside Redis. Its editor text is a subset of etcdctl's command line, so it
  // declares `queryLanguage: "json"` with a `queryDialect` of its own, as Redis does for its commands.
  // The connection is one endpoint plus TLS and an optional password; a client certificate names the
  // user where etcd's RBAC is on, and `readOnly` below is a mode its provider enforces.
  | "etcd"
  // Neo4j (issue #424). A property graph queried in Cypher over Bolt, the first member of the
  // `graph/` family, served read-only on the shared graph layer in `src/lib/db/graph/`. The
  // connection is one Bolt endpoint plus TLS, a user and password, and an optional `database`;
  // with none, the server's home database is used. Every write is refused before it is sent,
  // whatever `readOnly` says.
  | "neo4j"
  // Milvus (vector-family spec 5). A vector database read over its gRPC API by a client of this repository's own,
  // the first member of the `vector/` family. Its editor text is Milvus's own `POST /v2/vectordb/<route>` request
  // with one JSON body, so it declares `queryLanguage: "json"` with a `queryDialect` of its own. The connection is
  // one endpoint plus TLS, an optional user and a password or token, and an optional database; `readOnly` is a mode
  // its provider enforces.
  | "milvus"
  // Qdrant (vector-family spec 6). A vector database read over its REST API by a client of this repository's own on
  // the shared node transport (`src/lib/db/http/node-transport.ts`), a member of the `vector/` family. Its editor
  // text is Qdrant's own `METHOD /path` request with one JSON body, so it declares `queryLanguage: "json"` with a
  // `queryDialect` of its own. The connection is one REST endpoint plus TLS and an API key or JWT in `password`;
  // there is no user and no database, and `readOnly` is a mode its provider enforces.
  | "qdrant"
  // Weaviate (#1566). A vector database read over its REST API, and over GraphQL for the searches of a server below
  // 1.39.7, by a client of this repository's own on the shared node transport, a member of the `vector/` family. Its
  // editor text is Weaviate's own `METHOD /v1/path` request with one JSON body, so it declares `queryLanguage:
  // "json"` with a `queryDialect` of its own. The connection is one endpoint plus TLS and an API key or OIDC access
  // token in `password`; there is no user and no database, and `readOnly` is a mode its provider enforces.
  | "weaviate"
  // InfluxDB (InfluxDB spec I2). A time-series store read over the v1 `/query` endpoint, as a form POST (R14), in
  // InfluxQL: the TSM generation (1.x, and 2.x through its virtual DBRP mappings) and InfluxDB 3 through its
  // v1-compatible handler. It declares `queryLanguage: "influxql"`. The connection is a host, a port, an optional
  // user, a password or token, and an optional database; it is read-only whatever `readOnly` says.
  | "influxdb"
  // InfluxDB 3 (InfluxDB spec I2). InfluxDB 3 Core and Enterprise read over `POST /api/v3/query_sql` in Apache
  // DataFusion SQL, extending `SQLBaseProvider`. The connection is a host, a port, a token in `password` and an
  // optional database, the one session database whose tables are top-level objects (R1, R16); there is no user.
  // Served from the same directory as `influxdb` (I2, I23), and read-only whatever `readOnly` says.
  | "influxdb3"
  // Oxia (CNCF Sandbox), a sharded key-value store read over its gRPC client API by a client of this repository's
  // own (`src/lib/db/providers/keyvalue/oxia/`). Its editor text is one `oxia client` read command. Read-only in
  // this version whatever `readOnly` says. The connection's Database field is the namespace and Password is a bearer
  // token; `dataServers` lists a cluster's data servers.
  | "oxia"
  // Databend, a cloud data warehouse read and written over its HTTP query API (`POST /v1/query`) by a client of this
  // repository's own (`src/lib/db/providers/sql/databend/`), extending `SQLBaseProvider`. Self-hosted Databend and
  // Databend Cloud are the same id: a Cloud connection differs in host, TLS and the `warehouse` below. The
  // connection's Database field is the session database, inside the `default` catalog.
  | "databend"
  // S3-compatible object storage, read over the S3 REST API with path-style addressing and SigV4 signing by a client of
  // this repository's own on the shared node transport (`src/lib/db/providers/objectstore/s3/`). Its editor text is one
  // command of an AWS CLI subset. Read-only in this version whatever `readOnly` says. The connection's User field is
  // the access key ID, Password the secret access key, Database an optional pinned bucket, and `region` below the
  // signing region; a blank key pair sends unsigned requests, never this server's own credentials.
  | "s3"
  // Kubernetes, one cluster read over the API server's REST API by a client of this repository's own on the shared
  // node transport (`src/lib/db/providers/platform/kubernetes/`). Not a database: a Lens-like, read-only browser and a
  // kubectl-subset console beside the databases. Read-only in this version whatever `readOnly` says. The connection's
  // Password field is a bearer token, Database the default namespace, and `apiPath`, `namespaces` and `tlsServerName`
  // are its own fields; a client certificate rides in the SSL panel.
  | "kubernetes"
  // MQTT (#1635). A broker's topic tree, read only, over MQTT 5.0 on TCP or TLS by a client of this
  // repository's own (`src/lib/db/providers/keyvalue/mqtt/`). MQTT has no command that lists topics, so the tree
  // is built from what a subscription delivers and the provider never claims a read was complete; what it can
  // prove it reports, and nothing else. The connection is one broker address plus TLS and an optional
  // credential, with the discovery filter below naming what to subscribe to. Read-only is structural rather
  // than a mode: the outbound path can encode only CONNECT, SUBSCRIBE, UNSUBSCRIBE, PINGREQ and DISCONNECT, so
  // no PUBLISH and no Will exists to send.
  | "mqtt"
  // Google Cloud Firestore in Native mode, read only, over Firestore REST v1 by a client of this repository's own on
  // the shared node transport (`src/lib/db/providers/document/firestore/`). The editor text is one statement of a
  // read-only subset of the Admin SDK's query chain. Read-only whatever `readOnly` says: the client builds only the
  // read requests of its closed request table. The connection's Database field is the project id, Schema the
  // database id (empty for `(default)`), and Password a service-account key, an ADC JSON or an access token; empty,
  // the credential comes from an emulator server or an operator-seeded server identity.
  | "firestore"
  // RabbitMQ (#1656), one broker read only: virtual hosts, streams, queues and exchanges from the management HTTP API,
  // and a bounded, non-destructive read of a stream's messages over AMQP 0-9-1 by a client of this repository's own
  // (`src/lib/db/providers/stream/rabbitmq/`). Never takes a message from a queue and never writes to the broker. The
  // connection's Port is the management port, `amqpPort` the AMQP port of stream reads (empty means browse only), and
  // `apiPath` the management API's path prefix.
  | "rabbitmq"
  // OPC UA (#1677). A plant's address space, read only, over `opc.tcp` by `node-opcua-client`
  // (`src/lib/db/providers/industrial/opcua/`), the first member of the `industrial/` family. One connection is
  // one endpoint URL, which carries its own host and port; `securityMode` and `serverCertificateThumbprint`
  // below are its own fields. Read-only is structural rather than a mode: the client seam names eight read
  // services and none of them writes, so there is no Write, Call or HistoryUpdate to send.
  | "opcua"
  // Apache Spark (#1736): Spark SQL over Spark Connect (gRPC with Arrow results) for self-hosted Spark 4.1 and later
  // (`src/lib/db/providers/sql/spark/`). One Spark session per request, released at its end, plus a provider-owned
  // session for the tree and the panels that never runs user text. The connection's Password is the server's
  // spark.connect.authenticate.token, Database the catalog and Schema the namespace.
  | "spark"
  // MTConnect (#1722). One agent read only over HTTP: the probe document's device model, its current and sample
  // observations, and its asset documents, by a client of this repository's own on the shared node transport
  // (`src/lib/db/providers/industrial/mtconnect/`), the second member of the `industrial/` family. One connection is
  // one agent address, and `apiPath`, the field RabbitMQ already carries, holds the path prefix a reverse proxy puts
  // in front of it. There is no credential field: the agent's own interface takes none, and a proxy that asks for
  // Basic answers with an HTML 401 rather than an MTConnect document, which the provider reports as what it is.
  // Read-only is structural rather than a mode: the request table holds nine routes and every one of them is a GET,
  // so there is nothing to send that writes.
  | "mtconnect"
  // Modbus TCP (#1723), the third member of the `industrial/` family. A device or a gateway in
  // front of serial devices, read only: the encoder names four read function codes and device
  // identification, and there is no code here that can build a write - read-only is structural
  // rather than a mode, as it is for the two above. Modbus has NO DISCOVERY: no request lists
  // what a device holds, and no register carries a name, a type or a unit, so the object tree is
  // built from a register map the user supplies with the connection rather than from the device.
  // One connection is one device address and one unit id; `mbaps`, the protocol's TLS form on
  // port 802, rides on the SSL panel the other engines already use.
  | "modbus"
  // NETCONF (issue #1724), the configuration protocol RFC 6241 defines, read over SSH on port 830
  // with `ssh2` and no NETCONF library: this provider writes its own framing, both of RFC 6242's
  // forms, and sends five operations and nothing else - `get`, `get-config`, `get-data`,
  // `get-schema` and `close-session`. Read-only is structural rather than a mode, as it is for the
  // three above: there is no function here that can encode an `edit-config`, a `lock` or a
  // `commit`. A device's tree is addressed by datastore and then by YANG module, which is the only
  // engine here whose container levels are two kinds of thing rather than one. The module list and
  // every namespace come from the device's own YANG library, never from a guess, because a wrong
  // namespace answers an empty document rather than an error on both servers measured.
  | "netconf"
  | "snmp"
  // Eclipse Sparkplug B (#1720). One MQTT subscription read only, the third member of the `industrial/` family,
  // with its own bounded session (`src/lib/db/providers/industrial/sparkplug/`) rather than the shipped MQTT read,
  // because that read returns a map keyed by topic while a Sparkplug read depends on the ORDER of successive
  // messages on one topic: a sequence gap is read from two consecutive data messages, a rebirth replaces a
  // definition mid-read, and the specification warns a death can arrive after the next birth. One connection is
  // one broker. Read-only is structural rather than a mode: the provider's encoder has no function that writes a
  // PUBLISH, and its CONNECT takes no will parameter, because 5.4 registers an edge node's death certificate as
  // its MQTT will and a reader that set one would publish a death when its own socket dropped.
  | "sparkplug";

export type ConnectionEnvironment = "production" | "staging" | "development" | "local" | "other";

export const ENVIRONMENT_COLORS: Record<ConnectionEnvironment, string> = {
  production: "#ef4444",
  staging: "#eab308",
  development: "#22c55e",
  local: "#3b82f6",
  other: "#6b7280",
};

export const ENVIRONMENT_LABELS: Record<ConnectionEnvironment, string> = {
  production: "PROD",
  staging: "STAGING",
  development: "DEV",
  local: "LOCAL",
  other: "",
};

/**
 * How much TLS a connection asks for.
 *
 * `disable` sends plaintext. `require` encrypts and verifies NOTHING: every provider that
 * has the knob maps it to `rejectUnauthorized: false`, because a self-hosted server
 * ordinarily presents a self-signed certificate and refusing it would make the ordinary
 * local TLS deployment unreachable.
 *
 * `verify-system` encrypts AND verifies, with nothing to paste: the chain is checked against
 * the trust store the runtime already has (Node's bundled roots plus whatever the host adds)
 * and the certificate must name the host we dialled - `rejectUnauthorized: true` with no
 * `ca`. It is deliberately NOT "verify-ca with the field left blank": `verify-ca` and
 * `verify-full` exist to pin a chain against a `caCert` PEM the user supplies, which is the
 * only way to reach a server whose certificate no public root signs, and a form that asks
 * for a file the user does not have is a connection they cannot complete. `verify-system` is
 * what a managed endpoint (Neon, Supabase, Atlas, RDS, Capella) can satisfy as pasted, which
 * is why it is the mode a boolean `?ssl=true` / `?tls=true` in a connection string maps onto
 * (see `readBooleanTLS` in src/lib/connection-string-parser.ts for the rule).
 *
 * `verify-ca` checks the chain and `verify-full` also the server name. That split is honoured
 * only where the driver exposes the name check on its own - Oracle's `sslServerDNMatch` is
 * the one that does; the Node TLS drivers cannot separate the two, so both land on
 * `rejectUnauthorized: true` there and each provider doc says so. etcd's gRPC adapter could
 * separate them and checks the name in both all the same, by decision, so that one mode means
 * one thing across engines (#1089 E5).
 *
 * Adding a member here widens a published type (src/exports/types.ts), so every switch and
 * lookup table over SSLMode has to answer for it: the providers listed above, the seed schema
 * (src/lib/seed/types.ts), the PostgreSQL storage backend and the connection form.
 */
export type SSLMode = "disable" | "require" | "verify-system" | "verify-ca" | "verify-full";

export interface SSLConfig {
  mode: SSLMode;
  caCert?: string;
  clientCert?: string;
  clientKey?: string;
  rejectUnauthorized?: boolean;
}

export interface SSHTunnelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /**
   * The bastion host key this connection trusts, in OpenSSH's presentation
   * (`SHA256:` + unpadded base64, exactly what `ssh-keygen -lf` prints).
   *
   * The durable half of the trust-on-first-use policy in `src/lib/ssh/tunnel.ts`: when
   * set it is authoritative and a bastion offering any other key fails the connection.
   * Public key material, so it is stored and displayed in the clear.
   */
  hostKeyFingerprint?: string;
}

/**
 * Where an SSH tunnel's local endpoint actually forwards to: the address the record named
 * before `src/lib/db/factory.ts` rewrote `host` and `port` (X23).
 *
 * SYMBOL-KEYED ON PURPOSE, and that is the whole of its access control. A plan's seal is
 * `connectionFingerprint(provider.config)` and this value decides it, so it must not be
 * settable by whoever stores or posts a connection. Every connection this app resolves has
 * come through `JSON.parse` - out of `localStorage`, out of the storage provider, off a
 * request body - and `JSON.parse` can produce no symbol key at all, while `JSON.stringify`
 * drops one on the way back. So the only writer is server code holding this exported symbol,
 * which is the footing `ProviderExecutionContext` was given for the same reason: a value the
 * seal depends on cannot live somewhere a caller fills in.
 *
 * It is NOT the bastion. `SSHTunnelConfig` is still framed separately by `tunnelRoute`, so the
 * same `db:5432` reached through two different machines stays two different digests - and what
 * makes that the machine the bytes traverse rather than only the one the record names is the
 * tunnel pool, which keys a forward on that same `tunnelRoute` string (D86). Framed here and
 * shared there, a record can only be handed a forward through the bastion it names.
 */
export const TUNNEL_FAR_END: unique symbol = Symbol("libredb.tunnelFarEnd");

/**
 * The far side of an SSH forward AS THE FORWARD REACHES IT: the `remoteHost` and `remotePort`
 * the factory reads back off `TunnelInfo`, which is the address `forwardOut` dials for every
 * socket the tunnel accepts.
 *
 * It is deliberately not the address the factory ASKED for. The two could differ while
 * `createSSHTunnel` pooled by connection id alone, and a provider on a reused tunnel then
 * sealed a machine its statements never reached (D86). The pool keys on the far end and the
 * bastion route now, and the measurement that closed it is on `tunnelledConnection` in
 * `src/lib/db/factory.ts`.
 */
export interface TunnelFarEnd {
  readonly host: string;
  readonly port: number;
}

/**
 * Carries {@link TUNNEL_FAR_END} alongside a connection, and is deliberately NOT a field on
 * `DatabaseConnection` itself.
 *
 * `keyof DatabaseConnection` is a WRITE LIST with three exhaustive readers -
 * `FIELD_OWNERSHIP` in `src/hooks/use-connection-form.ts`, `CONNECTION_RELEVANCE` in
 * `src/hooks/use-connection-payload.ts` and `CONNECTION_FIELDS` in
 * `src/lib/storage/secret-fields.ts` - and each of them answers a question about what a
 * USER may fill in, send and have stored. This value is none of those things, so adding it
 * there would have made all three classify something they never see. Intersecting instead keeps
 * the optional property assignable in both directions: a plain `DatabaseConnection` satisfies
 * it, and a carrier is still a `DatabaseConnection` everywhere one is asked for.
 */
export interface WithTunnelFarEnd {
  readonly [TUNNEL_FAR_END]?: TunnelFarEnd;
}

export interface DatabaseConnection {
  id: string;
  name: string;
  type: DatabaseType;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Trino: the session schema used to resolve unqualified table names. */
  schema?: string;
  connectionString?: string;
  /** Query timeout in milliseconds. Unset uses the provider default of 60 seconds. */
  queryTimeout?: number;
  createdAt: Date;
  color?: string;
  environment?: ConnectionEnvironment;
  group?: string;
  ssl?: SSLConfig;
  sshTunnel?: SSHTunnelConfig;
  serviceName?: string; // Oracle: service name (e.g. ORCL, XEPDB1)
  instanceName?: string; // MSSQL: named instance (e.g. SQLEXPRESS)
  /**
   * Cassandra: the local data centre the driver balances against (e.g. `datacenter1`).
   *
   * Not an optimisation and not an optional refinement: `cassandra-driver` REFUSES to
   * connect without it ("'localDataCenter' is not defined in Client options and also
   * was not specified in constructor", measured on 4.9.0), and names the data centres
   * it did find when the value is wrong. No other engine here needs a topology answer
   * from the connection, which is why it is a field of its own rather than a reuse of
   * `serviceName`.
   */
  localDataCenter?: string;
  /**
   * MongoDB: the database the credentials live in (`?authSource=admin`).
   *
   * Not the same question as `database`, which is the one being opened. MongoDB
   * stores users in a database of their own, and the driver authenticates against
   * whichever database the URI names when nothing says otherwise - so the ordinary
   * deployment, users in `admin` and data elsewhere, could not be reached through the
   * form fields at all: it failed as a credentials error, which is what it looks like
   * and is not what it is. No other engine here separates the two, which is why this
   * is a field of its own rather than a reuse of `database`.
   */
  authSource?: string;
  /**
   * Kafka: the SASL mechanism that checks `user` and `password`, absent meaning none (#1088).
   *
   * A mechanism NAME, never a credential, and not a refinement either: a broker keeps a SCRAM
   * credential per mechanism, so the same user and password are a different principal's secret
   * under each, and a credential sent with no mechanism has no way to be sent at all, which the
   * provider refuses rather than dropping. PLAIN and both SCRAM mechanisms require TLS there.
   * OAUTHBEARER and GSSAPI are not offered.
   */
  saslMechanism?: "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";
  /**
   * Db2: connect with no TLS although the password then crosses the network in cleartext (#786).
   *
   * An explicit acceptance of a risk, and never a default. A stock Db2 server without TLS offers
   * only DRDA SECMEC 3, user and cleartext password, so the Db2 provider REFUSES a connection with
   * no TLS unless this is `true`, and then asks db2-node for that mechanism by name, which 1.0.24
   * and later refuse to fall back to otherwise (`docs/providers/db2.md`, section 3.3). Read by Db2 and by both
   * InfluxDB types (`influxdb`, `influxdb3`, InfluxDB spec I7), each of which refuses a non-empty secret
   * with TLS off, to a host that is not loopback and outside a tunnel, unless this is `true`. Oxia reads
   * it too (DECISIONS O7): its bearer token crosses the network on every call, so an Oxia connection with
   * a token and no TLS to a host other than this machine is refused unless this is `true`. Databend reads it
   * for its password, which it refuses to send with no TLS to a host that is not loopback unless this is `true`.
   * S3-compatible object storage reads it for the connection itself: the secret access key signs and is never
   * sent, but listings and previews are, so a connection with no TLS to a host that is not loopback and outside
   * a tunnel is refused unless this is `true`, signed or unsigned. RabbitMQ reads it for both endpoints, the
   * management API and the AMQP port: a password without TLS to a host that is not this machine is refused on both
   * unless this is `true`. Read by no other engine: each of those either encrypts the password itself or follows its
   * own driver's default.
   */
  allowInsecureAuth?: boolean;
  /**
   * Oxia only (DECISIONS O6): the public addresses of a cluster's data servers, as `host:port` entries separated by
   * commas or whitespace, at most 64. A shard leader the server advertises is dialled only when it equals the
   * address the connection's own bootstrap call was sent to, or one of these entries; every listed leader gets the
   * connection's TLS mode, CA and client pair and its own host as TLS identity, and the bearer token with them.
   * Exact entries only, never a pattern: a pattern would send the token to any address it matches. Absent and empty
   * are one value. Refused together with an SSH tunnel, because the leaders would bypass the tunnel. Read by no
   * other engine.
   */
  dataServers?: string;
  /**
   * Databend and Snowflake: the warehouse the statements of this connection run on. Databend sends it as the
   * `X-DATABEND-WAREHOUSE` header; Databend Cloud requires one and resumes a suspended warehouse on the first
   * statement, billing while it runs, and self-hosted Databend leaves it empty. Snowflake sends it as the `warehouse`
   * field of every request body; it is optional there, and empty means the user's default warehouse. It picks
   * compute, not the catalog, and it is not a secret. Absent and empty are one value. Read by no other engine.
   */
  warehouse?: string;
  /**
   * S3-compatible object storage only: the region every request is signed for, the region part of the SigV4 credential
   * scope. Absent and empty are one value, meaning `us-east-1`. Garage refuses every request signed for a region
   * other than its `s3_region`; MinIO started with `MINIO_SITE_REGION` refuses bucket and object requests signed for
   * another region but answers ListBuckets signed for `us-east-1`; RustFS accepts any region. The provider's refusal
   * names the region the server expects. It names no credential and no address, and it is not a secret. Read by no
   * other engine.
   */
  region?: string;
  /**
   * Kubernetes and RabbitMQ: a server path prefix every API request is sent under, each with its own rule, which the
   * provider applies before any request. Kubernetes: such as `/k8s/clusters/c-1` behind a Rancher proxy; it starts
   * with `/` and names segments of letters, digits, dots, hyphens, underscores, tildes, colons or `@`, with no `api`,
   * `apis`, `proxy`, `namespaces`, `nodes`, `services`, `pods`, `openapi` or `version` segment, no `//`, `.` or `..`
   * segment, `%`, query or fragment. RabbitMQ, labelled Path prefix: the management API's path, for
   * `management.path_prefix` or a reverse proxy location such as `/rabbitmq`; it starts with `/` and takes a plain
   * path with no `%`, `?` or `#`, no empty, `.` or `..` segment, and no segment `api`. For both, one trailing `/` is
   * removed, so `/` alone is no prefix. It picks which cluster or broker answers behind one host and port, so it is part
   * of the connection's identity. Absent and empty are one value. Read by no other engine.
   */
  apiPath?: string;
  /**
   * Kubernetes only: the namespaces the object tree lists, at most 1,000 DNS-1123 labels separated by commas or
   * spaces. When set, the provider makes no namespace list call, which a namespace-bound identity may not make. It
   * changes what is shown, not which cluster is asked or as whom. Absent and empty are one value. Read by no other
   * engine.
   */
  namespaces?: string;
  /**
   * Kubernetes only: the host name the API server's certificate is checked against and sent as SNI, a kubeconfig's
   * `tls-server-name`, where it differs from Host. Absent and empty mean Host, or the SSH tunnel's far end. Read by
   * no other engine.
   */
  tlsServerName?: string;
  /**
   * OPC UA only: the security mode the connection asks the server for, None, Sign or SignAndEncrypt.
   *
   * Studio's own `SSLMode` does not map onto these. `require` and `verify-full` have no meaning to a
   * server that offers three modes with a policy each, so the field is OPC UA's own name rather than
   * a translation, and a mode the server does not offer is refused rather than quietly weakened.
   * Read by no other engine.
   */
  securityMode?: string;
  /**
   * OPC UA only: the SHA-256 thumbprint the server's certificate must present, 64 hexadecimal
   * characters.
   *
   * Pinned per connection because the library's default trusts a server on first sight: measured, a
   * SignAndEncrypt connect to an unknown server succeeded and wrote its certificate into the trust
   * store, and after the server was recreated with a new certificate the next connect trusted that
   * one too. Part 4 6.1.3 says the opposite: "Applications shall never communicate with another
   * application that they do not trust." Read by no other engine.
   */
  serverCertificateThumbprint?: string;
  /**
   * OPC UA only, and a SEED FILE'S field rather than a dialog's: the security policy to insist on,
   * and the client certificate and private key to present.
   *
   * There is no box for these three in the connection dialog and there is not meant to be. A policy
   * URI is a string nobody types correctly from memory, and a certificate and key are files on the
   * host the server runs against: both are deployment facts, which is what `seed-connections.json`
   * is for (`docs/SEED_CONNECTIONS.md`). The pair is supplied together or not at all - a certificate
   * with no key cannot open a secured channel - and absent, the library generates a client
   * certificate under the PKI root, which is stable for as long as that directory is.
   *
   * Read by no other engine.
   */
  securityPolicyUri?: string;
  clientCertificatePath?: string;
  clientPrivateKeyPath?: string;
  /**
   * BigQuery only: where its jobs run (`EU`, `US`, `europe-west3`, ...). Absent, the provider takes the default
   * dataset's location, else the one most datasets share. Absent and empty are one value. Read by no other engine.
   */
  location?: string;
  /** RabbitMQ only: the AMQP 0-9-1 port of stream reads; empty means browse only. Read by no other engine. */
  amqpPort?: string;
  /**
   * Snowflake only: how the connection signs in, `keypair` (a key-pair JWT signed with `privateKey`) or `pat` (a
   * programmatic access token in `password`). Absent reads as `keypair`. Read by no other engine, and not the SSH
   * tunnel's `sshTunnel.authMethod`, which is a field of another feature.
   */
  authMethod?: "keypair" | "pat";
  /**
   * Snowflake only: the contents of the PEM private key the key-pair JWT is signed with, PKCS#8 or PKCS#1, encrypted
   * or not. Never a path: the provider reads no file. A secret. Read by no other engine; `ssl.clientKey` and the SSH
   * tunnel's `privateKey` are other features' fields. NETCONF (#1724) reads the same two fields for
   * the device's SSH key, because they hold the same thing: a private key and its passphrase.
   */
  privateKey?: string;
  /** Snowflake and NETCONF: the passphrase of an encrypted `privateKey`. A secret. Absent and empty are one value. */
  privateKeyPassphrase?: string;
  /**
   * NETCONF only (#1724): the device's SSH host key fingerprint, in OpenSSH's presentation, which
   * is `SHA256:` and forty-three unpadded base64 characters, exactly what `ssh-keygen -lf` prints.
   *
   * NOT the same field as `sshTunnel.hostKeyFingerprint`, which pins a BASTION this connection
   * passes through. This one pins the device itself, and a connection may carry both: a device
   * behind a bastion has two identities to check and they are checked by different code.
   *
   * Required rather than optional in practice: the dial refuses before opening a socket when it is
   * empty, because an SSH client that does not know the key it expects cannot tell the device from
   * anything else answering on that port. Public key material, so it is stored and shown in the
   * clear.
   */
  hostKeyFingerprint?: string;
  /**
   * Snowflake only: the role every statement of this connection runs as, sent on every request, case preserved; a
   * double-quoted name is exact, a bare one is folded to upper case by Snowflake. Required by the provider. It decides
   * what the connection can read and change, so it is part of the connection's identity. Read by no other engine.
   */
  role?: string;
  /**
   * Read no catalog when this connection opens.
   *
   * For a connection whose owner holds tens of thousands of objects, even the two cheap
   * reads first paint makes are worth deferring, and a user who only wants to run one
   * statement should not wait for either (#765, asked for by the reporter as "not
   * preloading anything ... at db connection level"). The editor and query execution
   * are fully usable while this is set; the object panel shows a load action instead of
   * a scan, and pressing it reads exactly what opening the connection would have.
   *
   * A per-connection answer rather than a global setting, because the connection is
   * what knows: the same deployment holds a five-table SQLite sample and a 40,000-object
   * Oracle owner, and the flag follows the one that hurts.
   */
  skipObjectScan?: boolean;
  /**
   * Refuse every write on this connection, before any request (#1089): the provider answers a write
   * command, an object edit and a maintenance operation with a refusal that names the read-only mode
   * and where it was set, and sends nothing.
   *
   * Accepted only on an engine whose provider enforces it, which `READ_ONLY_ENFORCED` in
   * `src/lib/db/compatibility.ts` records and a census holds equal to
   * `ProviderCapabilities.enforcesReadOnly`. On any other engine `true` is refused, by the seed schema
   * at load and by `assertReadOnlyHonoured` in `src/lib/db/factory.ts` before anything is built or
   * dialled, because a mode the provider ignores would list the connection as read-only and send its
   * writes. A value that is not a boolean is refused on every engine.
   *
   * What it binds depends on who holds the credentials. On a managed seed it is the operator's rule:
   * the server re-resolves a `seed:` id from the operator's file and discards what the caller sent,
   * and the seed schema refuses the field on a seed that is not managed. On a connection of the user's
   * own it is a safety rail the user can turn off.
   *
   * `false` and absent are one mode, and the form writes nothing for `false`. It is the fourth part of
   * `providerCacheKey`, so a read-only and a read-write connection never share a cached provider, and
   * part of no identity digest (`connectionFingerprint`, `credentialDigest`, `connectionIdentity`),
   * because it changes neither the server a connection reaches, nor as whom, nor which database.
   */
  readOnly?: boolean;
  managed?: boolean; // true = admin-controlled, read-only in UI
  seedId?: string; // stable reference to seed config ID
  agentUser?: string; // optional least-privilege role for the agent read-only execution profile (#328)
  agentPassword?: string; // password for agentUser; secret-classified, sealed at rest by connection-secrets
  /**
   * Elasticsearch only (#708): an API key pair, sent as `Authorization: ApiKey
   * base64(apiKeyId:apiKeySecret)` in preference to `user`/`password` when both halves
   * are set (each half trimmed first). Half a pair (one field with no other) is not a
   * shorter key, so it falls back to `user`/`password` rather than sending a key built
   * from an empty secret. OpenSearch refuses the pair: nothing has measured whether
   * its security plugin accepts the same scheme.
   *
   * `apiKeyId` is classified `secret` in secret-fields.ts, not `public` the way
   * `user` is: unlike a name an operator chose, it is one generated, opaque half of a
   * credential pair, and leaving it readable narrows what a leak has to guess.
   */
  apiKeyId?: string;
  apiKeySecret?: string;
  /**
   * Modbus only: the register map, as the JSON document the provider parses. A point names a unit,
   * a table, a zero-based PDU address, a type and the orders a value wider than one register needs.
   *
   * WHY IT IS A FIELD. Modbus has no discovery: the protocol offers no request that lists what a
   * device holds, so the map is the only thing that can name a point, and the user is who writes
   * it. `keyof DatabaseConnection` is the write list of what a user may fill in, send and have
   * stored (see `WithTunnelFarEnd`, which is deliberately NOT a field because nobody fills it in),
   * and a document the user writes belongs on it. The length is no argument against that: BigQuery
   * carries a whole key file's JSON in `password`.
   *
   * WHY NOT `password`. It is not a secret. `password` is classified `secret` in
   * `secret-fields.ts`, which would mask the map in the dialog and store it as a credential,
   * and a reader cannot correct a document they cannot see.
   *
   * WHY `resolution` IN `CONNECTION_RELEVANCE`, and it is NOT the summary criterion there. That
   * record's docblock asks which database a connection reaches and as whom, and this field answers
   * neither: the same device answers, and Modbus TCP authenticates nobody. The reason is what READS
   * the key. `use-provider-metadata` makes `connectionResolutionKey` part of its `readKey`,
   * `use-connection-pulse` keys the pulse on it and `SchemaDiff` keys its snapshot on it, so a map
   * that changed while the key did not would leave the PREVIOUS map's points drawn on screen.
   *
   * And the map DEFINES the names rather than filtering them, which is why Kubernetes' namespace
   * list is `cosmetic` and this is not: that list narrows names the cluster itself defines, while
   * `volts` is unit 1, holding register 100 under one document and can be unit 3, coil 5 under the
   * next. Two such maps are not two views of one answer.
   *
   * Bounded by `MAX_REGISTER_MAP_BYTES` at the parser rather than here, so a seed file and a
   * dialog answer the same way. Read by no other engine.
   */
  registerMap?: string;
}

export interface ForeignKeySchema {
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface ColumnSchema {
  name: string;
  type: string;
  /**
   * The type this column's declared type is BUILT ON, where the engine distinguishes the
   * two, and absent where it does not.
   *
   * SQL Server alias types are why it exists. `Person.PersonPhone.PhoneNumber` is declared
   * `Phone`, which is an alias over `nvarchar`, and `Person.Person.FirstName` is `Name` over
   * the same: the alias is what a person wants to SEE, and it is what `type` carries and
   * what the object browser renders. It is not what a reader can DECIDE on. Anything that
   * matches a declared type against a spelling it knows - which columns get a text shape
   * test, which cannot be counted, which have no equality operator - is matching a name the
   * schema's author invented, and it silently matches nothing.
   *
   * So a provider that can tell the two apart reports both, and a reader that is deciding
   * rather than displaying prefers this one. Optional because most engines have no such
   * distinction, and there an absent field is the honest answer rather than a copy of
   * `type` that would claim a provider had looked.
   */
  baseType?: string;
  /**
   * The type as the engine prints the declaration, modifier included, where that
   * spelling differs in kind from {@link type}.
   *
   * PostgreSQL is why it exists. `format_type(atttypid, NULL)` is the unqualified
   * base name (`character varying`, `numeric`, `vector`) and that is what `type`
   * stays, because a reader that matches a column against a spelling it knows —
   * autocomplete, migration DDL, the agent's schema capture, the diagram's numeric
   * test — is matching the base name. `format_type(atttypid, atttypmod)` is what a
   * person needs in order to write the column: `character varying(50)`,
   * `numeric(12,2)`, `vector(1536)`. The column tooltip and the object detail show
   * this field. A column with no modifier (`text`, `integer`, `text[]`) is given
   * the same string in both fields.
   *
   * Optional because an engine that already puts the modifier in `type` has nothing
   * further to record, and an absent field there is the honest answer rather than a
   * copy of `type`. It is not {@link baseType}: that one is the type an alias is
   * built on, and a reader that is deciding prefers it. This one is the declaration
   * a person is shown, and a reader that is displaying prefers it.
   */
  declaredType?: string;
  nullable: boolean;
  isPrimary: boolean;
  /**
   * What the column defaults to, as the provider reads it, and NOT one single kind of string
   * across the fleet.
   *
   * On most providers it is the engine's own catalog TEXT, copied out unchanged: PostgreSQL
   * reports `nextval('app.orders_id_seq'::regclass)` here, SQL Server `((0))`. On MySQL and
   * MariaDB it is the DECODED value, `abc` rather than `'abc'`, because MariaDB reports the
   * default as the expression its author wrote and showing that to a reader showed a default
   * nobody wrote (#795). SQLite, libSQL and DuckDB report it the same way MariaDB does and
   * decode it the same way (#1029).
   *
   * ClickHouse is neither. `readDefault` in `clickhouse/introspect.ts` answers the bare
   * expression for kind `DEFAULT` and CONSTRUCTS `MATERIALIZED a + b` for the other kinds,
   * so the field there names its own clause and is not pasteable after the word DEFAULT.
   * The migration generator has `clickhouseDefaultKind` for exactly that, and the half of it
   * that was never applied is issue #1032.
   *
   * Decoding is why {@link defaultExpression} exists: once a provider decodes, this field is
   * no longer something a reader can paste after the word DEFAULT, so the provider that
   * decoded carries the text alongside it.
   */
  defaultValue?: string;
  /**
   * The SQL TEXT that produces {@link defaultValue}, as the engine's own catalog spells it,
   * carried by a provider that DECODED the value out of it.
   *
   * It exists for the same reason `baseType` does: a reader that is DECIDING needs a
   * different field from a reader that is DISPLAYING. Where both are set, `defaultValue` is
   * the VALUE the column defaults to, which is what the object browser shows; this is what
   * goes after the word DEFAULT, and a reader EMITTING SQL must prefer it. The two are
   * genuinely different strings: MariaDB's `DEFAULT 'abc'` has the value `abc` and the
   * expression `'abc'`, and `CREATE TABLE t (note varchar(20) DEFAULT abc)` is ERROR 1054 on
   * that server while `DEFAULT 'abc'` is accepted (measured on 12.3.2).
   *
   * A provider sets it where it DECODED {@link defaultValue} out of the catalog text. Absence
   * is therefore not negligence and not "there is no expression": on the providers that copy
   * the catalog out unchanged it says `defaultValue` already IS the text, and a reader
   * emitting SQL should use that.
   *
   * Two engines are absent for their own reasons rather than that one. MySQL reports the
   * evaluated value with an EXTRA that cannot say whether the text is SQL - `abc` is a value,
   * `b'1'` and `0x616263` are SQL, all three carry an empty EXTRA - so it declares nothing
   * here rather than inventing a quoting rule, and what that costs is issue #1031. ClickHouse
   * builds a clause-naming string rather than a value, which is a third case this field does
   * not model; see {@link defaultValue} and issue #1032.
   */
  defaultExpression?: string;
  /**
   * How the engine knows this column: `"sampled"` where the provider inferred it from rows it read rather than
   * from a declaration the engine holds, so another row may carry a key this list lacks and a listed one may be
   * absent from most rows.
   *
   * Absent means declared, which is every column of every engine that shipped before the field existed. Optional
   * because this type is part of the published package surface. The object tree and the mobile column list show
   * "(sampled)" beside such a column's type; the Source is provider-authored and states the sample itself.
   * `machineColumns` in `src/lib/db/detailed-object.ts`
   * keeps a sampled column from every model and MCP surface, because its name was read out of the data.
   */
  provenance?: "sampled";
  /**
   * Whether this column can be named in a projection (a SELECT list).
   *
   * Search engines (Elasticsearch, OpenSearch) map types that their SQL surfaces refuse to project
   * by name — e.g. `flattened` on Elasticsearch, or `flat_object`, `unsigned_long` and `version`
   * on OpenSearch (#1459). Introspection lists the column so the schema tree is honest about the
   * mapping, but sets this to `false` so starter query generators leave it out of the SELECT list.
   *
   * Absent means projectable (`true`), which is the case for ordinary columns across all engines.
   */
  projectable?: boolean;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
}

/** A PostgreSQL EXCLUDE constraint: its name and `pg_get_constraintdef()` definition. */
export interface ExclusionConstraintSchema {
  name: string;
  definition: string;
}

export interface QueryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  totalReturned: number;
  wasLimited: boolean;
}

/**
 * A non-fatal notice an engine attached to a statement it completed.
 *
 * The point of the channel is a response that succeeded and is still not the
 * whole truth: an analytics engine can answer 200 with rows missing, and a query
 * service can answer with advice about the statement it just ran. Without
 * somewhere to put those, a provider has to drop them and the result looks
 * complete.
 */
export interface QueryWarning {
  /** The notice itself, as the engine worded it. */
  message: string;
  /**
   * The engine's own identifier for the notice, when it reported one. Carried
   * verbatim rather than normalized - Couchbase numbers its warnings while other
   * engines label them with a string - and omitted entirely by an engine that
   * reports no identifier, rather than claiming a zero.
   */
  code?: number | string;
  /**
   * The level the engine raised it at, as the server spells it (`WARNING`, `NOTICE`), which
   * may be localized (`lc_messages`), when it reports one. A PostgreSQL-wire server sends
   * both levels through the same channel (#1401), and `table "t" does not exist, skipping`
   * is not a warning.
   */
  severity?: string;
}

/**
 * How one result is to be DRAWN. A specification, never a picture.
 *
 * Emitted by an agent run as its answer's presentation and re-exported from
 * `src/lib/agent/types.ts` under this name, but declared HERE: `DataCharts` draws it
 * and ships in the published package, and no agent module may be reachable from that
 * package's declarations (`tests/unit/agent-package-boundary.test.ts`). One
 * declaration both trees name beats two that can disagree.
 *
 * Every column it names is checked against the artifact's real columns before the
 * event carrying it is written, and against the delivered rows again before it is
 * drawn, because the component that renders it does not fail on a column holding no
 * numbers: `Number(value) || 0` turns one into a confident flat line of zeros. A
 * refused spec costs one turn; an unvalidated one puts this application's frame
 * around a wrong picture.
 *
 * What is absent is as load-bearing as what is here:
 *
 * - **`histogram` is excluded**, though `DataCharts` offers it. It bins raw values
 *   in the browser, so the picture would show something the artifact does not
 *   contain. A histogram wanted is a bucketing the SQL should do — and then it is a
 *   bar chart of an aggregate the run can cite.
 * - **No aggregation field.** `DataCharts` can aggregate; doing it here would be a
 *   second aggregation nobody recorded and nothing can check. Aggregation belongs in
 *   the statement, where it is on the ledger.
 * - **No colours, no titles, no sizes.** Presentation belongs to the app. `caption`
 *   is the model's own prose and is rendered as quoted model prose, never as a
 *   sentence the app is saying.
 */
export interface AgentChartSpec {
  readonly type: "bar" | "line" | "area" | "pie" | "scatter" | "stacked-bar";
  /** One column of the artifact, by the name the result actually carries. */
  readonly x: string;
  /** One or more columns of the artifact. Numeric in the delivered rows, or refused. */
  readonly y: readonly [string, ...string[]];
  /**
   * No series split. `DataCharts` has none — several series ARE several `y` columns
   * there — so a `series` field would be a field the contract invites, the server
   * validates and the ledger records, and the renderer then silently discards. The
   * multi-series shapes are reachable by naming several `y` columns instead.
   */
  /** The model's own words about what the chart shows. Rendered quoted. */
  readonly caption: string;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  /**
   * The result's columns, in order. Every name is non-empty and no two are the same, and rows key their
   * values by these names, so no two columns read one value.
   * Providers keep the names apart in one of three ways. Most name the columns through `uniqueFieldNames`
   * (`src/lib/db/utils/result-fields.ts`): a SQL provider reads its rows positionally and keys them by those
   * names, and a document store renames an empty key (`uniquelyKeyedRows`). Oracle's driver numbers a repeat
   * itself (`ID_1`). Cassandra refuses a result with a repeated name, because its driver has already kept
   * only one of the values.
   */
  fields: string[];
  rowCount: number;
  executionTime: number;
  explainPlan?: unknown;
  /**
   * Set by the client, only when SANDBOX ran this statement and the server CONFIRMED the
   * rollback. The write's affected-row count is then said to be rolled back (#1425).
   */
  rolledBack?: boolean;
  pagination?: QueryPagination;
  /**
   * Notices the engine attached to this run. **Absent** when it reported none -
   * never an empty array, so the UI can decide whether to render anything from
   * the field's presence alone.
   */
  warnings?: QueryWarning[];
  /**
   * The declared type of each column, keyed by its name in `fields`, spelled the
   * way the engine spells it (`Nullable(String)`, `BIGINT`).
   *
   * This is the type the wire format declared for THIS result, which is the only
   * source for a computed column or an ad-hoc projection - the schema tree has no
   * catalog entry to answer with. Absent when the source declared none.
   */
  columnTypes?: Record<string, string>;
  /**
   * The columns of this result that hold vectors, keyed by their names in `fields`: each one's kind, element type,
   * dimension and, for a sparse column, its cell encoding. A cell of a declared column holds its engine's native
   * form and renders as a vector cell, and Copy Cell copies it whole, as search data for the same engine; a column
   * that is not declared renders as before, whatever its cells hold.
   *
   * **Absent** when the result has no vector column, never an empty object.
   */
  vectorColumns?: Readonly<Record<string, VectorColumn>>;
  /**
   * Every result set the text produced, in order, when it produced MORE than one: a T-SQL
   * batch sent as one request (#1312), or a procedure that returns several. `rows`, `fields`
   * and `columnTypes` above stay the first set's, as they always were. **Absent** for a text
   * with one result set or none.
   *
   * The multi-statement route reads it to show a batch's last result with rows, the same
   * rule it applies across a script's statements; `POST /api/db/query` and `POST /api/db/transaction` do not send it.
   */
  resultSets?: QueryResultSet[];
}

/** One result set of a text that produced several (`QueryResult.resultSets`). */
export interface QueryResultSet {
  rows: Record<string, unknown>[];
  /** As `QueryResult.fields`: non-empty, unique, and the keys every row carries. */
  fields: string[];
  columnTypes?: Record<string, string>;
}

/**
 * A Source tab's whole state: an ADDRESS, what has been read against it, and which part is
 * shown (#789 Phase 2).
 *
 * No connection id, deliberately. Tabs are already scoped per connection by the persistence
 * key `libredb_workspace_tabs_v1:${connection.id}`, and the shell renders the active
 * connection beside the active tab, so an id here would be a third copy of a fact two places
 * already hold and the three could disagree.
 *
 * The ADDRESS is the only half that is persisted, and `PersistedTabState` in
 * `src/hooks/use-tab-manager.ts` is where that is enforced and argued. A restored Source tab
 * therefore carries `path` and `kind` alone and RE-READS, which is also why every other field
 * here is optional: absent is the state a freshly opened and a freshly restored tab share, and
 * it is what tells the viewer to issue a read.
 */
export interface SourceTabState {
  readonly path: readonly string[];
  readonly kind: string;
  /** Absent while loading and after a failed read. Never persisted: see `PersistedTabState`. */
  readonly document?: ObjectSourceDocument;
  /** The route's own sentence. */
  readonly failure?: string;
  readonly activePartId?: string;
  /** The catalog-change counter's value when this document was read. */
  readonly readAtToken?: number;
  /**
   * The wall-clock moment this document was read (`Date.now()`), so "Stored by the engine as it
   * was submitted. Complete as shown." is anchored in time rather than left to mean "at some
   * point" (#1407). Not persisted either, for the same reason `readAtToken` is not: a restored
   * tab re-reads, so there is no prior read to date.
   */
  readonly readAt?: number;
  /**
   * WHICH part the reader is editing, and never a boolean (#789 Phase 3, discussion #778).
   *
   * Per part and not per tab, so two parts of one Oracle package can hold two independent drafts,
   * the writable buffer can only ever be the part on screen, and a part switch is what leaves edit
   * mode. A boolean would have to be read together with `activePartId` at every site, and the pair
   * can disagree.
   *
   * NOT PERSISTED, like every other field here but the address. The unsaved text itself lives in
   * its own bounded store keyed by address and part, so a restored tab re-reads and then offers
   * the draft back rather than reopening in a writable state nothing has re-checked.
   */
  readonly editingPartId?: string;
  /**
   * Whether the buffer differs from the text the engine answered. Not persisted either.
   *
   * The tab bar is the reader of it, and the pane writes it ONLY when the boolean flips, so it
   * costs one render per transition rather than one per keystroke.
   */
  readonly dirty?: boolean;
}

export interface QueryTab {
  id: string;
  name: string;
  query: string;
  result: QueryResult | null;
  /**
   * The statement that produced `result`, as it was actually sent.
   *
   * Not the same thing as `query`, which is the EDITOR BUFFER and is rewritten on every
   * keystroke — and not always a prefix of it either, since a run takes the editor's
   * effective query, which may be a selection or the statement under the cursor. Inline
   * editing writes back to the table the displayed rows came from, so it has to read the
   * statement that fetched them rather than whatever is in the buffer now (#881).
   *
   * Absent on a tab whose result predates this field, and on one that has never run.
   */
  resultQuery?: string;
  /**
   * Why the tab's last NEW run failed, in the words the failure arrived with.
   *
   * Set together with `result: null`, so the results panel shows the failure in place of the
   * previous run's rows instead of leaving them up under a statement that did not produce them.
   * A failed Load More does not set it: the rows on screen are intact and only the next page did
   * not arrive. Cleared by the next run that lands. Absent on a tab whose last run succeeded, and
   * optional because this type is part of the published package surface.
   */
  runError?: string;
  isExecuting: boolean;
  type:
    | "sql"
    | "mongodb"
    | "redis"
    | "libredb"
    | "promql"
    | "kafka"
    | "etcd"
    | "cypher"
    | "milvus"
    | "qdrant"
    | "weaviate"
    | "influxql"
    | "oxia"
    | "s3"
    | "kubectl"
    | "mqtt"
    | "firestore"
    | "rabbitmq"
    | "opcua"
    | "mtconnect"
    | "modbus"
    | "netconf"
    | "snmp"
    | "sparkplug";
  viewMode?: "results" | "explain" | "history" | "saved";
  explainPlan?: unknown;
  // Pagination state
  currentOffset?: number;
  isLoadingMore?: boolean;
  allRows?: Record<string, unknown>[];
  /**
   * The numbered database this tab's statements belong to, when the tab was opened against one
   * that is NOT the connection's own session database.
   *
   * WHY THE TAB CARRIES IT. A key lives in exactly one numbered database, and Redis has no
   * database-qualified key syntax: the database is a property of the CONNECTION (`SELECT n`) and
   * never of the statement. `GET report:daily` therefore names the key and cannot name the database
   * it is in, so the same statement sent on a connection sitting in another database reads a
   * different key space and answers `(nil)` for a key that is right there. The panel that opened
   * this tab walked one database, and every run of the tab - the initial read, the next Run, a
   * selection, an inline edit, the next page - is about the same key, so the one fact travels with
   * the tab rather than with the call that opened it.
   *
   * ABSENT MEANS NO OVERRIDE, and is not database `0` or "the session's number": it is the ordinary
   * tab saying nothing, whose run reaches whatever database its connection names. Only this number
   * is overridden; the connection is otherwise the active one, whole.
   */
  databaseOverride?: number;
  /**
   * The object activation that opened this tab: the connection it was opened on, the object's
   * path, the database override it was opened with, and the statement it was opened on.
   *
   * WHAT LETS A SECOND ACTIVATION FOCUS THIS TAB instead of opening another and reading the same
   * rows again. The tab is reused only on the connection that opened it, since two connections
   * can hold the same path, and only while `query` still equals `origin.query`: a tab whose
   * statement the reader has edited is their work, and an activation must never capture it. A
   * reused tab whose `runError` is set is run again in place.
   *
   * NOT PERSISTED, so a tab restored from storage carries none and is never matched: a restored
   * tab opens a fresh one on the next activation, which is what every activation did before this.
   */
  origin?: {
    /** Absent when no connection was active; optional because this type is published. */
    readonly connectionId?: string;
    readonly path: readonly string[];
    readonly databaseOverride?: number;
    /** Set when the activation named one key rather than a group spelled the same, and only where that changed the statement (`handleTableClick`). */
    readonly namesKey?: true;
    readonly query: string;
    /**
     * The row action this activation ran (`KindRowAction.activates`), when it ran one rather than
     * opening the object's rows. Only an activation of the same action focuses such a tab, and a
     * data activation of the same path never does.
     */
    readonly rowAction?: string;
  };
  /**
   * Present exactly on a Source tab (#789 Phase 2).
   *
   * An optional FIELD and deliberately not another member of `type`. Every member of that
   * union is a QUERY DIALECT that `resolveTabType` may answer and that
   * `editorLanguageForTabType` maps onto `QueryEditor`'s closed language union, so a
   * `"source"` member would be an arm the resolver can never produce and the language mapper
   * would have to answer for, and it would put the per-object language decision back into the
   * two functions `CLAUDE.md` keeps it out of. The definition's own Monaco language travels on
   * the PART instead, which is where the provider put it.
   *
   * A Source tab therefore still carries a `type`, and it is the neutral default: nothing
   * reads it, because both surfaces that would branch on it, the tab bar's icon and the editor
   * pane, branch on the presence of this field first.
   */
  source?: SourceTabState;
}

export interface QueryHistoryItem {
  id: string;
  connectionId: string;
  connectionName?: string;
  tabName?: string;
  query: string;
  executionTime: number;
  status: "success" | "error";
  executedAt: Date;
  /**
   * Absent for an ordinary run. `"explain"` marks a run that asked for the statement's PLAN:
   * `query` is still the statement itself, and `rowCount` is omitted because the rows of a plan
   * are not the statement's rows (#1447). Entries stored before this field existed read as
   * ordinary runs.
   */
  kind?: "explain";
  rowCount?: number;
  errorMessage?: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  description?: string;
  connectionType: DatabaseType;
  createdAt: Date;
  updatedAt: Date;
  tags?: string[];
}

export interface SchemaSnapshot {
  id: string;
  connectionId: string;
  connectionName: string;
  databaseType: DatabaseType;
  /**
   * The objects as the consumer held them when the snapshot was taken (#789).
   *
   * `StoredObject` and NOT `DetailedObject`, and the difference is the whole compatibility
   * story of this record. A live reading now always carries `kind` and `path`, because the
   * flat surface it used to come from is gone, so `DetailedObject` declares both as facts.
   * A snapshot is not a live reading: these records sit in the user's own storage, and every
   * one written before the object model landed carries neither field. Declaring the stored
   * array as the live shape would be the same drift this field has already had once, where
   * the declaration said `TableSchema` and the stored JSON carried two more fields.
   *
   * `diffSchemas` therefore compares such a snapshot BY NAME, as Task 25c measured: an old
   * snapshot carries no kind and no path, so keying on either would report every object in it
   * as removed and re-added the first time it was opened against a current reading. Two
   * readings that both carry paths are compared by path below their roots (SF-047). Nothing
   * migrates these records and nothing needs to.
   */
  schema: StoredObject[];
  createdAt: Date;
  label?: string;
  /**
   * The container the objects were read from, when the read was narrowed to one (#1791).
   *
   * Absent means the whole connection, which is also every snapshot taken before this field existed, so an old one
   * reads as the unscoped snapshot it was.
   */
  scope?: string;
}

export type AggregationType = "none" | "sum" | "avg" | "count" | "min" | "max";
export type DateGrouping = "hour" | "day" | "week" | "month" | "year";

export interface SavedChartConfig {
  id: string;
  name: string;
  chartType: string;
  xAxis: string;
  yAxis: string[];
  query?: string;
  connectionId?: string;
  createdAt: Date;
  aggregation?: AggregationType;
  dateGrouping?: DateGrouping;
}
