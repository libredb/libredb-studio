import { type LucideIcon } from "lucide-react";
import {
  PostgreSQLIcon,
  MySQLIcon,
  SQLiteIcon,
  MongoDBIcon,
  RedisIcon,
  OracleIcon,
  MSSQLIcon,
  LibreDBIcon,
  CouchbaseIcon,
  ClickHouseIcon,
  DruidIcon,
  ElasticsearchIcon,
  OpenSearchIcon,
  TrinoIcon,
  CassandraIcon,
  LibSQLIcon,
  DuckDBIcon,
  PrometheusIcon,
  KafkaIcon,
  EtcdIcon,
  Db2Icon,
  Neo4jIcon,
  QdrantIcon,
  MilvusIcon,
} from "@/components/icons/db-icons";
import type { DatabaseType } from "@/lib/types";
import type { HostUriScheme } from "@/lib/connection-host-uri";
import { CREDENTIAL_WARNINGS, type CredentialWarning } from "@/lib/db/credential-warnings";

// DB brand icons share the same interface as LucideIcon (className + SVG props)
export type DBIcon = LucideIcon | React.FC<React.SVGAttributes<SVGSVGElement> & { className?: string }>;

export interface DatabaseUIConfig {
  icon: DBIcon;
  color: string;
  label: string;
  defaultPort: string;
  showConnectionStringToggle: boolean;
  connectionFields: (
    | "host"
    | "port"
    | "user"
    | "password"
    | "database"
    | "schema"
    | "connectionString"
    | "serviceName"
    | "instanceName"
    // Cassandra only, and it is REQUIRED rather than advanced: `cassandra-driver`
    // refuses to construct a load-balancing policy without a local data centre, so a
    // connection with this empty cannot open at all.
    | "localDataCenter"
    // MongoDB only: the database its credentials live in, which the driver otherwise
    // assumes is the one being opened.
    | "authSource"
    // Elasticsearch only (#708): an API key pair, sent in preference to user/password.
    | "apiKeyId"
    | "apiKeySecret"
    // Kafka only (#1088): which SASL mechanism checks the user and password, drawn as the select
    // `fieldOptions` below declares.
    | "saslMechanism"
    // Db2 only (#786): the consent to send the password without TLS, drawn as a checkbox while SSL
    // Mode is disable. The provider refuses a connection with no TLS unless it is set.
    | "allowInsecureAuth"
  )[];
  /**
   * The connection dialog's label for a field, where this engine names the field differently from
   * the dialog's own word (#1085). Read through `connectionFieldLabel`, so an engine relabels a
   * field by declaring it here rather than by another per-type branch in `ConnectionModal.tsx`.
   * The branches that name Couchbase's bucket, Trino's catalog, Cassandra's keyspace and libSQL's
   * token predate this and stay where they are; moving them onto this declaration is a backlog item.
   */
  fieldLabels?: Partial<Record<ConnectionField, string>>;
  /**
   * A sentence the connection dialog draws under a field, where this engine needs one said before
   * the user reaches an error (#1085). Read through `connectionFieldHint`.
   */
  fieldHints?: Partial<Record<ConnectionField, string>>;
  /**
   * The sentence under the connection dialog's Read-only toggle, where this engine's mode differs from
   * the dialog's own sentence, which says the mode can be turned off. Neo4j declares one because its
   * connections are read-only whether or not the box is ticked (spec A7). Read through `readOnlyHint`.
   */
  readOnlyHint?: string;
  /**
   * The choices of a field the connection dialog draws as a select rather than a text box, each a
   * stored value and its label, offered after an empty "None" choice that stores nothing (#1088).
   * The dialog draws the select where the engine takes the field, the same condition
   * `buildConnection` writes it on, so an entry that declares options names the field in
   * `connectionFields` too. Only Kafka's SASL mechanism is declared this way; a per-type boolean in
   * `ConnectionModal.tsx` is what this replaces.
   */
  fieldOptions?: Partial<Record<ConnectionField, readonly { readonly value: string; readonly label: string }[]>>;
  /**
   * `false` where this engine's connections may not carry an SSH tunnel (#1088), absent meaning the
   * dialog offers the tunnel. Read through `offersSshTunnel`, never directly.
   */
  showSshTunnel?: false;
  /**
   * The schemes the connection dialog's Host box takes as a whole address, split into Host and Port on paste
   * and at save (src/lib/connection-host-uri.ts), absent meaning the box takes a host alone, as it always has.
   * Read through `hostUriSchemes`, never directly. The connection-string box is a different reader and keeps
   * `http://` and `https://` for ClickHouse.
   */
  hostAcceptsUri?: readonly HostUriScheme[];
  /**
   * The credentials this engine warns about, taken by reference from `CREDENTIAL_WARNINGS` in
   * src/lib/db/credential-warnings.ts through a getter every entry is given below, and never written out in an
   * entry, so the dialog's warning and the seed loader's refusal read one record. That module holds the data because this one imports React icons, which the seed
   * loader must not.
   */
  credentialWarnings?: readonly CredentialWarning[];
}

/** One addressing field, named by the same list that decides whether a save writes it. */
export type ConnectionField = DatabaseUIConfig["connectionFields"][number];

export const DB_UI_CONFIG: Record<DatabaseType, DatabaseUIConfig> = {
  postgres: {
    icon: PostgreSQLIcon,
    color: "text-hue-blue",
    label: "PostgreSQL",
    defaultPort: "5432",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database"],
  },
  mysql: {
    icon: MySQLIcon,
    color: "text-hue-amber",
    label: "MySQL",
    defaultPort: "3306",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database"],
  },
  sqlite: {
    icon: SQLiteIcon,
    color: "text-hue-cyan",
    label: "SQLite",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: ["database"],
  },
  duckdb: {
    icon: DuckDBIcon,
    // DuckDB's own mark is a bright yellow (#FFF000), and `hue-yellow` is already
    // ClickHouse's. `-alt` is the second step of that hue, kept apart from its base
    // in both palettes; the distinct-colour assertion in
    // tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
    color: "text-hue-yellow-alt",
    label: "DuckDB",
    // Embedded: nothing is listening anywhere, so there is no port to default.
    defaultPort: "",
    // No URI scheme exists to paste - DuckDB's own tooling takes a path - so the
    // provider declares `supportsConnectionString: false` and this toggle stays off.
    showConnectionStringToggle: false,
    // Exactly `["database"]`, which is the shape `isFileBased()` below tests for: it
    // is what makes ConnectionModal render "Database File Path" instead of a
    // host/user/password section. One extra field here would silently take the file
    // input away.
    connectionFields: ["database"],
  },
  libsql: {
    icon: LibSQLIcon,
    // Turso's own mark is a bright mint green (#4FF8D2). emerald-300 is the nearest
    // free shade - emerald-400 is MongoDB's, both teals are taken by Couchbase and
    // Elasticsearch, and the distinct-colour assertion in
    // tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
    color: "text-hue-emerald-alt",
    // The protocol's name rather than the product's: one connection here reaches a
    // self-hosted libSQL server OR Turso Cloud, and naming the managed product would
    // read as though the self-hosted one belonged somewhere else.
    label: "libSQL",
    // sqld's own default HTTP port. A Turso Cloud connection names no port at all -
    // it is TLS on 443, which the transport picks up from the ssl setting.
    defaultPort: "8080",
    // `libsql://<database>-<org>.turso.io?authToken=<jwt>` is the URL Turso's CLI
    // prints, so there IS a canonical form to paste - unlike Trino's JDBC URL.
    showConnectionStringToggle: true,
    // No `user`: libSQL has no user names at all, and the credential is a token the
    // server mints. No `database` either - the database IS the host on Turso Cloud,
    // and a self-hosted server serves one per namespace hostname. The form labels
    // `password` "Auth Token" (see ConnectionModal.tsx), because a field labelled
    // Password invites a password that no libSQL server has.
    connectionFields: ["host", "port", "password", "connectionString"],
  },
  mongodb: {
    icon: MongoDBIcon,
    color: "text-hue-emerald",
    label: "MongoDB",
    defaultPort: "27017",
    showConnectionStringToggle: true,
    connectionFields: ["host", "port", "user", "password", "database", "connectionString", "authSource"],
  },
  redis: {
    icon: RedisIcon,
    color: "text-hue-rose",
    label: "Redis",
    defaultPort: "6379",
    showConnectionStringToggle: false,
    // `user` is the Redis 6 ACL user. It belongs here because `RedisProvider.connect()`
    // authenticates with it (as ioredis's `username`) and docs/providers/redis.md has
    // documented it as a connection field all along - this list was the one place that
    // disagreed, and since it decides what a save WRITES, the value never reached the
    // driver that #502 taught to send it.
    connectionFields: ["host", "port", "user", "password", "database"],
  },
  oracle: {
    icon: OracleIcon,
    color: "text-hue-red",
    label: "Oracle",
    defaultPort: "1521",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database", "serviceName"],
  },
  // IBM Db2 LUW (#786). No connection-string toggle: a `db2://` paste fills the fields, the Oracle
  // precedent. No password hint: a declared hint is drawn whatever SSL Mode says, and the cleartext
  // warning belongs only to a connection without TLS, where the `allowInsecureAuth` box carries it.
  db2: {
    icon: Db2Icon,
    color: "text-hue-purple",
    label: "Db2 LUW",
    defaultPort: "50000",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
  },
  mssql: {
    icon: MSSQLIcon,
    color: "text-hue-sky",
    label: "SQL Server",
    defaultPort: "1433",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database", "instanceName"],
  },
  couchbase: {
    icon: CouchbaseIcon,
    color: "text-hue-orange",
    label: "Couchbase",
    // Management port. The query ports are discovered from the cluster at connect
    // time (issue #262, decision 3), so only this one is ever stored.
    defaultPort: "8091",
    showConnectionStringToggle: true,
    connectionFields: ["host", "port", "user", "password", "database", "connectionString"],
  },
  clickhouse: {
    icon: ClickHouseIcon,
    color: "text-hue-yellow",
    label: "ClickHouse",
    // The HTTP interface port. The provider speaks HTTP only, so the native
    // protocol port 9000 is never a valid value here (issue #264).
    defaultPort: "8123",
    showConnectionStringToggle: true,
    connectionFields: ["host", "port", "user", "password", "database", "connectionString"],
  },
  druid: {
    icon: DruidIcon,
    // Issue #265 specified sky, which mssql already owns; the distinct-colour
    // assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
    // `hue-teal` was free and is closer to Druid's own petrol-teal mark anyway.
    color: "text-hue-teal",
    label: "Apache Druid",
    // The Router port. The Broker on 8082 serves the identical POST /druid/v2/sql and
    // needs no different configuration (live-verified, issue #265); the Router is the
    // default only because it also fronts the console and the management-proxied APIs.
    defaultPort: "8888",
    // No URI convention exists for Druid's HTTP SQL API - its JDBC driver addresses
    // Avatica (jdbc:avatica:remote:url=...), and http:// / https:// already resolve to
    // ClickHouse in connection-string-parser.ts. There is nothing to paste.
    showConnectionStringToggle: false,
    // Deliberately no "database": INFORMATION_SCHEMA.SCHEMATA reports exactly one
    // catalog, always named `druid`, so a database selector would be a control with no
    // effect. Credentials stay offered because a cluster running druid-basic-security
    // needs them; a default install ignores the Authorization header entirely.
    connectionFields: ["host", "port", "user", "password"],
  },
  elasticsearch: {
    icon: ElasticsearchIcon,
    // The Elastic mark's own hues are teal (#00bfb3) and yellow (#fed10a); teal-400
    // and yellow-400 are already owned by druid and clickhouse, and the distinct-colour
    // assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out. teal-300
    // is the nearest free shade to the brand teal.
    color: "text-hue-teal-alt",
    label: "Elasticsearch",
    // 9200 for both products and both schemes: a TLS deployment serves HTTPS on the
    // SAME port rather than on a second well-known one, so unlike ClickHouse there is
    // no 8443-shaped alternative (the provider's SEARCH_DEFAULT_PORT says the same).
    defaultPort: "9200",
    // No URI convention to paste: the provider is addressed by host and port like
    // Druid, and http:// / https:// already resolve to ClickHouse in
    // connection-string-parser.ts. Nothing was added there for these two ids.
    showConnectionStringToggle: false,
    // Deliberately no "database": an index has no namespace above it - measured, ES's
    // SHOW TABLES reports only a catalog (the cluster name) and OpenSearch reports
    // TABLE_SCHEM null, and the catalog is not addressable in a statement - so a
    // database selector would be a control with no effect. Credentials stay offered
    // because a cluster running the security plugin needs them; a stock node ignores
    // the Authorization header entirely (measured).
    //
    // apiKeyId/apiKeySecret here and not on opensearch below (#708): the transport
    // sends them only when its dialect spec says the product accepts the ApiKey wire
    // scheme, which nothing has measured for OpenSearch. Offering the fields there
    // would let an operator fill in a pair the transport refuses rather than sends.
    connectionFields: ["host", "port", "user", "password", "apiKeyId", "apiKeySecret"],
  },
  opensearch: {
    icon: OpenSearchIcon,
    // OpenSearch's Pacific Blue (#005EB8) is deeper and bluer than postgres' own
    // blue-400, which already owns "blue" here; indigo-400 is the nearest free shade.
    color: "text-hue-indigo",
    label: "OpenSearch",
    // Same 9200 floor, same reason - the fork kept the port.
    defaultPort: "9200",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password"],
  },
  trino: {
    icon: TrinoIcon,
    // Trino's own mark is a magenta-pink (#DD00A1); pink-400 is the nearest free
    // shade, and the distinct-colour assertion in tests/unit/lib/db-ui-config.test.ts
    // rules a duplicate out.
    color: "text-hue-pink",
    // The product's own name, with no vendor word in front of it: "Trino" is what the
    // project calls itself, unlike "Apache Druid".
    label: "Trino",
    // The coordinator's HTTP port, and the SAME number under TLS: a secured cluster
    // serves on whatever port its operator chose, so inventing a well-known HTTPS
    // alternative would point credentials at a port nothing is listening on.
    defaultPort: "8080",
    // No URI to paste. Trino's canonical URL is a JDBC one
    // (`jdbc:trino://host:port/catalog/schema`), which the shared parser does not
    // accept, and http:// / https:// already resolve to ClickHouse in
    // connection-string-parser.ts. Two engines cannot own one scheme.
    showConnectionStringToggle: false,
    // `database` IS offered here, which is where this id parts company with Druid and
    // the two search engines: a coordinator fronts MANY catalogs (measured on 476,
    // `SHOW CATALOGS` answers jmx, memory, system, tpcds, tpch) and a connection pins
    // one, the way a PostgreSQL connection pins a database. The form labels it
    // "Catalog" rather than "Database" - see ConnectionModal.tsx.
    connectionFields: ["host", "port", "user", "password", "database", "schema"],
  },
  cassandra: {
    icon: CassandraIcon,
    // Cassandra's own mark is a mid-cyan eye (#1287B1). sky-400 is mssql's and the
    // distinct-colour assertion in tests/unit/lib/db-ui-config.test.ts rules a
    // duplicate out, so sky-300 is the nearest free shade.
    color: "text-hue-sky-alt",
    // The project's own name, vendor word included, exactly as "Apache Druid" is
    // spelled here: the ASF name is how this engine is universally written.
    label: "Apache Cassandra",
    // The native protocol port. There is no second protocol to reach: the old Thrift
    // port (9160) is gone from 4.0 onwards, and 7000/7001 are internode.
    defaultPort: "9042",
    // No URI to paste. The driver takes contact points plus a REQUIRED
    // `localDataCenter`, and no URI convention in use carries the second; `cassandra://`
    // is in no branch of connection-string-parser.ts, so the toggle would promise a
    // paste the form cannot honour.
    showConnectionStringToggle: false,
    // `database` IS offered and it holds a KEYSPACE - the same mapping Trino makes
    // onto a catalog. Measured on 5.0.9: with no keyspace pinned, `SELECT … FROM
    // customers` answers "No keyspace has been specified. USE a keyspace, or
    // explicitly specify keyspace.tablename", and a keyspace that does not exist
    // fails the CONNECT rather than the first statement. The form labels it
    // "Keyspace" - see ConnectionModal.tsx.
    connectionFields: ["host", "port", "user", "password", "database", "localDataCenter"],
  },
  prometheus: {
    icon: PrometheusIcon,
    // Prometheus's own mark is a flame orange (#E6522C), and `hue-orange` is Couchbase's. The
    // theme has no second orange identity step, and adding one would be a palette change with a
    // separation test of its own (tests/unit/theme-accent-contrast.test.ts); `hue-fuchsia` is a
    // declared identity hue no engine here carries, and the distinct-colour assertion in
    // tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
    color: "text-hue-fuchsia",
    label: "Prometheus",
    // The port the HTTP API and the web UI share. The same number under TLS: a secured server
    // serves on whatever port its operator chose, so inventing an HTTPS alternative would point
    // credentials at a port nothing is listening on.
    defaultPort: "9090",
    // No URI convention to paste, and http:// / https:// already resolve to ClickHouse in
    // connection-string-parser.ts. Two engines cannot own one scheme.
    showConnectionStringToggle: false,
    // Deliberately no "database": the server holds one TSDB and every API read is addressed to
    // it, so a selector would be a control with no effect (#1085 6.1), the Druid shape. `user` and
    // `password` are HTTP Basic; a password with no user is sent as a bearer token.
    connectionFields: ["host", "port", "user", "password"],
    // Declared here rather than as one more boolean in ConnectionModal.tsx (#1085 3.3): the
    // password box is the one field whose meaning depends on another field being empty. The user
    // box is "User" because the hint and the provider's credential refusal both name it so.
    fieldLabels: { user: "User", password: "Password or token" },
    fieldHints: { password: "Leave User empty to send this as a bearer token." },
  },
  kafka: {
    icon: KafkaIcon,
    // Kafka's own mark is black, which is no identity hue at all. `hue-green` is a declared base
    // identity hue no engine here carries (purple, the other free one, is VisualExplain's AI accent),
    // and the distinct-colour assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
    color: "text-hue-green",
    label: "Apache Kafka",
    // The broker port a stock install listens on, and the same number under TLS: a secured
    // listener serves on whatever port its operator chose.
    defaultPort: "9092",
    // No URI convention to paste: a Kafka client takes a bootstrap address, and nothing in
    // connection-string-parser.ts reads a Kafka URI.
    showConnectionStringToggle: false,
    // No SSH tunnel: a tunnel forwards one address, and a Kafka client reads from every broker at
    // the address the broker advertises (docs/providers/kafka.md). Read through offersSshTunnel, so
    // the dialog neither offers a tunnel nor sends one left in its state; the provider still
    // refuses a tunnelled connection that arrives another way.
    showSshTunnel: false,
    // No database field: one connection is one cluster (docs/providers/kafka.md). The SASL
    // mechanism is a select declared here, not an isKafka branch in the dialog.
    connectionFields: ["host", "port", "saslMechanism", "user", "password"],
    fieldLabels: { saslMechanism: "SASL mechanism" },
    fieldHints: { saslMechanism: "PLAIN and SCRAM require TLS" },
    fieldOptions: {
      saslMechanism: [
        { value: "PLAIN", label: "PLAIN" },
        { value: "SCRAM-SHA-256", label: "SCRAM-SHA-256" },
        { value: "SCRAM-SHA-512", label: "SCRAM-SHA-512" },
      ],
    },
  },
  etcd: {
    icon: EtcdIcon,
    // etcd's own mark is a mid blue (#419EDA). `hue-blue` is PostgreSQL's; its `-alt` step is a
    // second identity only if it clears the separation test, which is why `blue` joined
    // IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry (KE9).
    color: "text-hue-blue-alt",
    label: "etcd",
    // The client port etcd listens on.
    defaultPort: "2379",
    // No URI convention to paste: etcdctl takes endpoints, which Host and Port hold (#1089 6.1).
    showConnectionStringToggle: false,
    // No database field: one connection is one cluster. User and Password are etcd's password sign-in; with
    // both empty, a client certificate under SSL / TLS signs in as its Common Name. The hints below say which
    // field decides which, since a refusal of E1 or E2 is otherwise the first the user hears of it.
    connectionFields: ["host", "port", "user", "password"],
    fieldHints: {
      host: "A name or address only. For etcdctl's --endpoints=https://10.0.0.5:2379, type 10.0.0.5 here, 2379 in Port, and choose an SSL mode under SSL / TLS.",
      user: "Leave User and Password empty to sign in with the client certificate under SSL / TLS (shown in verify-ca and verify-full): etcd uses its Common Name as the user when the server runs with --client-cert-auth. When both are set, etcd uses the password.",
      password:
        "etcd receives the password, then a token on every call, so a password needs an SSL mode other than disable, with or without an SSH tunnel.",
    },
  },
  neo4j: {
    // A generic graph glyph, never Neo4j's logo (spec E12).
    icon: Neo4jIcon,
    // No identity hue is free. `hue-fuchsia` is Prometheus's; its `-alt` step is a second identity only
    // because it clears the separation test, which is why `fuchsia` joined IDENTITY_ALTS in
    // tests/unit/theme-accent-contrast.test.ts with this entry, as `blue` did with etcd's.
    color: "text-hue-fuchsia-alt",
    label: "Neo4j",
    // The Bolt port. The HTTP port (7474) serves the browser and the HTTP API, which this provider never uses.
    defaultPort: "7687",
    // No URI scheme to paste: the provider builds its bolt:// URI from Host, Port and the SSL panel, and
    // connection-string-parser.ts reads no Neo4j URI (spec 6.1).
    showConnectionStringToggle: false,
    // The SSL panel and the SSH tunnel stay offered: a bolt:// URI dials the one server it names, unlike a
    // routing neo4j:// URI, which this provider never builds. An empty database is the server's home database.
    connectionFields: ["host", "port", "user", "password", "database"],
    fieldHints: { database: "Leave empty to use the server's home database." },
    // The dialog's own sentence says the mode can be turned off, which is false here (spec A7).
    readOnlyHint:
      "Neo4j connections are read-only in this version, whether or not this is ticked: this user's write privileges are never used.",
  },
  milvus: {
    // A mark drawn for Studio, never the project's logo or any vendor or Attu asset (vector-family spec 10.3).
    icon: MilvusIcon,
    // Milvus's own mark is a blue. `hue-blue` is PostgreSQL's and its `-alt` etcd's, and `hue-sky` and its `-alt`
    // are taken; `hue-cyan-alt` fails the separation test and `hue-indigo-alt` clears it, which is why `indigo`
    // joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry (vector-family spec 10.3).
    color: "text-hue-indigo-alt",
    label: "Milvus",
    // One endpoint carries gRPC with TLS on or off (vector-family spec 5.2); 9091 is the management port, never dialled.
    defaultPort: "19530",
    // The connection-string box reads http:// and https:// as ClickHouse, so a pasted vendor address belongs in the
    // Host box, which splits it (hostAcceptsUri below, vector-family spec 3.12).
    showConnectionStringToggle: false,
    // The database is optional and sent with every call; the provider reads `config.user` and `config.database`,
    // which the write-list test of tests/unit/lib/db-ui-config.test.ts holds.
    connectionFields: ["host", "port", "user", "password", "database"],
    // The Prometheus precedent: one password box also carries a token when User is empty (vector-family spec 5.2).
    fieldLabels: { password: "Password or token" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address such as a Zilliz Cloud endpoint, which is split into Host and Port. Port 9091 is Milvus's management port, which Studio never dials.",
      database: "Optional; empty means default. A dbName in a request body overrides it.",
      user: "Optional. At most 32 characters, starting with a letter. Leave it empty to put a token in Password or token.",
      password:
        "Milvus receives the password or token on every call, so a password needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection.",
    },
    hostAcceptsUri: ["http", "https"],
  },
  qdrant: {
    // A mark drawn for Studio, never the vendor's logo (vector-family spec 10.3).
    icon: QdrantIcon,
    // Qdrant's own mark is a crimson. `hue-rose` is Redis's; its `-alt` step is a second identity only because it
    // clears the separation test, which is why `rose` joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts
    // with this entry, as `fuchsia` did with Neo4j's.
    color: "text-hue-rose-alt",
    label: "Qdrant",
    // The REST port. 6334 is gRPC and 6335 the cluster's internal port, neither of which the provider dials (vector-family spec 4.4).
    defaultPort: "6333",
    // The connection-string box reads http:// and https:// as ClickHouse, so the vendor's address belongs in the
    // Host box, which splits it (hostAcceptsUri below, vector-family spec 3.12).
    showConnectionStringToggle: false,
    // No Database box: Qdrant has no container level. No User field: Qdrant has no user name, and the provider
    // refuses a non-empty one from a seed or the API naming the field (vector-family spec 4.4). The key or JWT is the password.
    connectionFields: ["host", "port", "password"],
    fieldLabels: { password: "API key or JWT" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address such as http://localhost:6333, which is split into Host and Port. Studio dials this REST port only, never Qdrant's gRPC port 6334 or its cluster port 6335.",
      password:
        "Qdrant receives the API key or JWT on every request, so a key needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection. A read-only or collection-scoped key with an expiry is the safest choice.",
    },
    hostAcceptsUri: ["http", "https"],
  },
  libredb: {
    icon: LibreDBIcon,
    color: "text-hue-violet",
    label: "LibreDB",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: ["database"],
  },
};

// Every entry's `credentialWarnings` reads its type's array from the shared record on each access, so no entry
// writes one out or holds a copy, and a declaration added to the record is the entry's at once.
for (const type of Object.keys(DB_UI_CONFIG) as DatabaseType[]) {
  Object.defineProperty(DB_UI_CONFIG[type], "credentialWarnings", {
    get: () => CREDENTIAL_WARNINGS[type],
    enumerable: true,
  });
}

export function getDBConfig(type: DatabaseType): DatabaseUIConfig {
  return DB_UI_CONFIG[type];
}

export function getDBIcon(type: DatabaseType): DBIcon {
  return DB_UI_CONFIG[type].icon;
}

export function getDBColor(type: DatabaseType): string {
  return DB_UI_CONFIG[type].color;
}

/**
 * A file-based provider carries only a filesystem path (no host/port/credentials).
 * Derived from connectionFields so callers never hard-code provider type ids.
 */
export function isFileBased(type: DatabaseType): boolean {
  const fields = DB_UI_CONFIG[type].connectionFields;
  return fields.length === 1 && fields[0] === "database";
}

/**
 * Whether this engine takes a given addressing field at all.
 *
 * One list, two readers: `buildConnection` writes a field only when this says so, and the
 * connection modal renders an input for it only when this says so. They used to disagree -
 * the modal drew Username and Database for every networked engine while the write list
 * discarded them - so libSQL asked for a user name it has none of, and Druid and the two
 * search engines asked for a database they do not take. A box whose value is thrown away is
 * the UI equivalent of reporting an absence as a measurement.
 */
export function takesConnectionField(type: DatabaseType, field: ConnectionField): boolean {
  return DB_UI_CONFIG[type].connectionFields.includes(field);
}

const NO_HOST_URI_SCHEMES: readonly HostUriScheme[] = Object.freeze([]);

/**
 * The schemes the Host box takes as a whole address for this engine: its `hostAcceptsUri`, or none.
 *
 * One rule, two readers in `useConnectionForm`, as `offersSshTunnel` has: the host setter it returns, which
 * splits a pasted address on arrival, and `buildConnection`, which splits one that was typed and which no path
 * to a tested or saved connection bypasses. Loading a connection to edit reads neither, so its host shows as it
 * was saved.
 */
export function hostUriSchemes(type: DatabaseType): readonly HostUriScheme[] {
  return DB_UI_CONFIG[type].hostAcceptsUri ?? NO_HOST_URI_SCHEMES;
}

/**
 * Whether this engine's connections may carry an SSH tunnel: false only where the entry
 * declares `showSshTunnel: false`, which Kafka does, because a tunnel forwards one address and
 * a Kafka client reaches every broker at the address the broker advertises.
 *
 * One rule, two readers, as `takesConnectionField` is: the connection modal renders the SSH
 * toggle only when this says so, and `buildConnection` writes `sshTunnel` only when this says
 * so. The second reader is the one that matters: the dialog keeps a tunnel switched on under
 * another type in its state, and a hidden panel would leave no control to turn it off. A
 * file-based engine answers true and has its panel hidden by `isFileBased` instead; a tunnel
 * left in the dialog's state is saved on it but inert, because no tunnel opens for a
 * connection without a host and port (docs/BACKLOG.md records the dialog's SSH state).
 */
export function offersSshTunnel(type: DatabaseType): boolean {
  return DB_UI_CONFIG[type].showSshTunnel !== false;
}

/**
 * The connection dialog's label for one field: the engine's declared `fieldLabels` entry, or the
 * dialog's own word when the engine declares none (#1085).
 *
 * The fallback is the caller's because the dialog's own words are not one table: the `database`
 * field alone reads "Database Name", "Database File Path" or "Database Name (optional override)"
 * by the mode the form is in, and the per-type branches still choose several. `port` shares the
 * host row's label and draws none of its own, so a label declared for it has nowhere to appear;
 * a hint declared for it does.
 */
export function connectionFieldLabel(config: DatabaseUIConfig, field: ConnectionField, fallback: string): string {
  return config.fieldLabels?.[field] ?? fallback;
}

/**
 * The sentence the connection dialog draws under one field, or `undefined` where the engine
 * declares none (#1085). There is no fallback: a field with no declared hint draws nothing new,
 * and the per-type hints `ConnectionModal.tsx` already writes stay beside it.
 */
export function connectionFieldHint(config: DatabaseUIConfig, field: ConnectionField): string | undefined {
  return config.fieldHints?.[field];
}

/** The sentence under the Read-only toggle: the engine's own where it declares one, else the dialog's. */
export function readOnlyHint(config: DatabaseUIConfig): string {
  return (
    config.readOnlyHint ??
    "Writes, value edits and maintenance are refused on this connection. You can turn this off here, so on your own connection it is a safety rail, not a permission."
  );
}
