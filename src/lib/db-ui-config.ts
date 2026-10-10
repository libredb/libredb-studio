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
  InfluxDBIcon,
  OxiaIcon,
  DatabendIcon,
  S3Icon,
} from "@/components/icons/db-icons";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
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
    // Db2 (#786), both InfluxDB types (InfluxDB spec I7), Oxia for its token, Databend for its password, and
    // S3-compatible object storage for the connection itself: the consent to connect without TLS, drawn as a checkbox
    // while SSL Mode is disable, under the sentence the type declares in `fieldHints`. The provider refuses a
    // connection with no TLS unless it is set.
    | "allowInsecureAuth"
    // Oxia only (O6): a cluster's data-server addresses, one text box.
    | "dataServers"
    // Databend only (design 6.1): the warehouse every statement runs on, one text box.
    | "warehouse"
    // S3-compatible object storage only: the signing region, one text box.
    | "region"
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
   * The connection dialog's placeholder for a field, where this engine's example differs from the dialog's own.
   * Read through `connectionFieldPlaceholder`; the `database` and `region` boxes read it.
   */
  fieldPlaceholders?: Partial<Record<ConnectionField, string>>;
  /**
   * The sentence under the connection dialog's Read-only toggle, where this engine's mode differs from
   * the dialog's own sentence, which says the mode can be turned off. Neo4j declares one because its
   * connections are read-only whether or not the box is ticked (spec A7). Read through `readOnlyHint`.
   */
  readOnlyHint?: string;
  /**
   * The checks the connection dialog runs on a field before Test Connection and Save send anything, each refusal a
   * sentence that names the field and never repeats its value. Read through `connectionFieldRefusal`. The provider
   * runs the same checks again at connect, because a seed or an API call never passes the dialog; this declaration
   * says them before a request is made.
   */
  fieldRules?: Partial<Record<ConnectionField, ConnectionFieldRule>>;
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

/** A check the connection dialog runs on one field before Test Connection and Save (`fieldRules`). */
export interface ConnectionFieldRule {
  /** The refusal of a blank field; absent, a blank field passes. */
  readonly required?: string;
  /** A field that is not blank must match `pattern` whole, or `sentence` is the refusal. */
  readonly format?: { readonly pattern: RegExp; readonly sentence: string };
  /** A field that is not blank and passes `format` must hold `min` to `max` characters, or `sentence` is the refusal. */
  readonly charRange?: { readonly min: number; readonly max: number; readonly sentence: string };
}

/**
 * Databend's form checks (design 6.3), in the provider's own sentences. The provider module is server code the dialog
 * cannot import, so the warehouse pattern is a copy of its `WAREHOUSE_NAME`, and tests/unit/lib/db-ui-config.test.ts
 * holds the copy, and both sentences, to the provider's.
 */
export const DATABEND_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  user: {
    required:
      "User is required: Databend signs in every request as a SQL user, root on a fresh self-hosted node. Nothing was sent.",
  },
  warehouse: {
    format: {
      pattern: /^[A-Za-z0-9_-]{1,63}$/,
      sentence:
        "Warehouse must be 1 to 63 letters, digits, hyphens or underscores, as the warehouse is named in Databend Cloud. Nothing was sent.",
    },
  },
});

/**
 * The sentences the connection dialog draws under Databend's fields (design 6.1), exported so the docs and the form's
 * own refusals can be held to the same words.
 */
export const DATABEND_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  host: "A host name or address, or a pasted https:// address, which is split into Host and Port. Databend Cloud: the host from Connect in the Cloud console, on port 443 with SSL mode verify-system. Self-hosted: the query node, port 8000 unless http_handler_port was changed.",
  user: "A SQL user. On Databend Cloud: cloudapp, or a user created with CREATE USER; the email you sign in to the Cloud console with is not a SQL user.",
  database: "The current database for names a statement does not qualify. Empty means default.",
  warehouse:
    "Databend Cloud: the warehouse= value of the DSN from Connect. A suspended warehouse resumes on the first statement, opening the connection included, because it reads the object tree, and is billed while it runs; with Warehouse set, Studio sends no background health checks. Self-hosted: leave empty unless your cluster routes requests by warehouse.",
  allowInsecureAuth:
    "Ticked, the password crosses the network in cleartext to this host. Databend Cloud never needs this: it serves HTTPS on port 443.",
});

/**
 * The form checks of S3-compatible object storage, in the provider's own sentences. The provider module
 * is server code the dialog cannot import, so the three patterns and the access key ID's range are copies of the
 * exports of src/lib/db/providers/objectstore/s3/connection-options.ts and constants.ts, and
 * tests/unit/lib/db-ui-config.test.ts holds each copy, and each sentence, to the provider's.
 */
export const S3_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = Object.freeze({
  user: {
    format: {
      pattern: /^[\x21-\x2b\x2d\x2e\x30-\x3c\x3e-\x7e]+$/,
      sentence:
        "Access key ID must be printable ASCII without spaces, commas, equals signs or slashes, because it is sent inside the signed Authorization header. Nothing was sent.",
    },
    charRange: {
      min: 3,
      max: 512,
      sentence:
        "Access key ID holds 3 to 512 characters, because S3 servers issue no shorter ID and it is sent inside the signed Authorization header. Nothing was sent.",
    },
  },
  database: {
    format: {
      pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/,
      sentence:
        "Bucket must be 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit. Nothing was sent.",
    },
  },
  region: {
    format: {
      pattern: /^[A-Za-z0-9_-]{1,64}$/,
      sentence: "Region must be 1 to 64 letters, digits, hyphens or underscores, such as us-east-1. Nothing was sent.",
    },
  },
});

/**
 * The sentences the connection dialog draws under the fields of S3-compatible object storage, exported so
 * the docs and the tests can be held to the same words.
 */
export const S3_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = Object.freeze({
  host: "A host name or address, or a pasted http:// or https:// endpoint such as http://localhost:9000, which is split into Host and Port. The endpoint only: a bucket goes under Bucket, never in the address. MinIO and RustFS serve on port 9000 unless configured otherwise, Garage on 3900. If Studio runs in a container, localhost is that container: use host.docker.internal.",
  user: "The access key ID. It is stored and shown in the clear, like a user name. Leave both keys empty only for a bucket that allows anonymous reads: Studio then sends unsigned requests, never this server's own cloud credentials.",
  password:
    "The secret access key. Studio's server signs every request with it and never sends it to the S3 server. Fill in both keys, or neither.",
  database:
    "Optional. With a bucket here, Studio reads only that bucket and never lists the others, which a key limited to one bucket needs. Empty: every bucket this key can list.",
  region:
    "The region every request is signed for. Empty means us-east-1, which MinIO accepts unless it was started with a region of its own. Garage: its s3_region setting. AWS: the bucket's region.",
  allowInsecureAuth:
    "Ticked, Studio connects to this host over plain HTTP. The secret access key is never sent to this server, but bucket and object names, listings and previewed contents travel in the clear, readable by anyone on the path, and a captured request can be replayed for several minutes. Choose an SSL mode under SSL / TLS, or an SSH tunnel, wherever the server offers one.",
});

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
    // `user` is for a self-hosted server started with SQLD_HTTP_AUTH, which checks a
    // user name and password as HTTP Basic: the transport sends Basic whenever a
    // connection names a user and the bearer token otherwise. The form still labels
    // `password` "Auth Token" (see ConnectionModal.tsx), the credential Turso Cloud and
    // a JWT-checking server take, and the hint below says when that box is a password.
    // No `database`: the database IS the host on Turso Cloud, and a self-hosted server
    // serves one per namespace hostname.
    connectionFields: ["host", "port", "user", "password", "connectionString"],
    fieldHints: {
      user: "Only for a self-hosted libSQL server started with SQLD_HTTP_AUTH, which checks a user name and password as HTTP Basic: the Auth Token box then takes the password. Leave it empty for Turso Cloud and for a server that checks tokens.",
    },
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
  // The consent box's sentence is declared here too, so a second engine that takes the box says its own.
  db2: {
    icon: Db2Icon,
    color: "text-hue-purple",
    label: "Db2 LUW",
    defaultPort: "50000",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
    fieldHints: {
      allowInsecureAuth:
        "With no SSL mode this driver sends the password in cleartext, so the connection is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the server offers one.",
    },
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
  influxdb: {
    // A generic time-series mark drawn for Studio, never InfluxData's logo (InfluxDB spec E19), shared by both types.
    icon: InfluxDBIcon,
    // `hue-purple` is Db2's; its `-alt` step is a second identity only because it clears the separation test, which
    // is why `purple` joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry.
    color: "text-hue-purple-alt",
    // One connection type per query language: this one sends InfluxQL over the v1 /query API of 1.x, 2.x and 3.x.
    label: "InfluxDB (InfluxQL)",
    defaultPort: "8086",
    // The connection-string box reads http:// and https:// as ClickHouse, so a pasted address belongs in the Host
    // box, which splits it (hostAcceptsUri below).
    showConnectionStringToggle: false,
    // The Prometheus precedent: one password box carries a 1.x password or, with User empty, a 2.x or 3.x token. The
    // last field is the consent to send it without TLS, drawn while SSL Mode is disable (InfluxDB spec I7).
    connectionFields: ["host", "port", "user", "password", "database", "allowInsecureAuth"],
    fieldLabels: { password: "Password or token" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443.",
      password: "1.x: the user's password. 2.x and InfluxDB 3: an API token, with User empty.",
      database:
        'A 1.x database, a 2.x bucket, or an InfluxDB 3 database: the default for a run, not a filter. Empty: the only database the credential can list, or name it in the statement as "db".."measurement".',
      allowInsecureAuth:
        "Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked.",
    },
    // The dialog's own sentence says the mode can be turned off, which is false here: Studio sends no write.
    readOnlyHint: "InfluxDB connections are read-only whether or not this is ticked: Studio sends no write.",
    hostAcceptsUri: ["http", "https"],
  },
  influxdb3: {
    // The same mark as the InfluxQL type: one product, two connection types.
    icon: InfluxDBIcon,
    // The first hue with no identity `-alt` before it whose `-alt` step clears the separation test, which is why
    // `violet` joined IDENTITY_ALTS in tests/unit/theme-accent-contrast.test.ts with this entry (InfluxDB spec K-D4).
    color: "text-hue-violet-alt",
    // InfluxDB 3 Core's SQL over /api/v3/query_sql.
    label: "InfluxDB 3 (SQL)",
    defaultPort: "8181",
    showConnectionStringToggle: false,
    // No User field: InfluxDB 3 has no user name, its token is the password, and the connection layer refuses a user
    // from a seed or the API naming the field.
    connectionFields: ["host", "port", "password", "database", "allowInsecureAuth"],
    fieldLabels: { password: "Token" },
    fieldHints: {
      host: "A name or address, or a pasted http:// or https:// address, which is split into Host and Port. InfluxDB Cloud endpoints are https on port 443.",
      password:
        "Empty only for a server started with --without-auth. On InfluxDB 3 Core every token is an admin token.",
      database:
        "The one InfluxDB 3 database this connection reads. Empty: the only database the token can list; with more than one, set it here.",
      allowInsecureAuth:
        "Ticked, the password or token crosses the network in cleartext to this host. On InfluxDB 3 Core every token is an admin token that reaches server-side code. Prefer TLS or an SSH tunnel; SSL mode require sends the token to a server whose certificate is not checked.",
    },
    readOnlyHint: "InfluxDB connections are read-only whether or not this is ticked: Studio sends no write.",
    hostAcceptsUri: ["http", "https"],
  },
  oxia: {
    // A mark drawn for Studio, never Oxia's logo (DECISIONS O16).
    icon: OxiaIcon,
    // `hue-orange` is Couchbase's; its `-alt` step joins IDENTITY_ALTS with this entry, measured in
    // tests/unit/theme-accent-contrast.test.ts next to InfluxDB's `purple-alt` and `violet-alt` (O16, O17).
    color: "text-hue-orange-alt",
    label: "Oxia",
    // The client port of `oxia standalone` and of every data server's public listener (R01, R02 12).
    defaultPort: "6648",
    // No URI convention: the CLI takes `-a host:port`, which Host and Port hold (DECISIONS O5).
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "password", "database", "dataServers", "allowInsecureAuth"],
    fieldLabels: { password: "Token", database: "Namespace", dataServers: "Data servers" },
    // The namespace an empty Namespace means, where the dialog would show "db" (ruling R34).
    fieldPlaceholders: { database: "default" },
    fieldHints: {
      host: "A name or address only. For Pulsar's oxia://host:6648/ns, type host here, 6648 in Port and ns in Namespace. If Studio runs in a container, localhost is that container: use host.docker.internal.",
      password:
        "An OIDC token, sent as a bearer token on every call; empty for a server without authentication. A token grants read and write on every namespace: Oxia has no authorization. A token needs an SSL mode other than disable, unless the host is this machine or an SSH tunnel carries the connection.",
      database:
        "Empty means default, the only namespace of oxia standalone. Names are case sensitive, and a cluster's namespaces are in its coordinator configuration.",
      dataServers:
        "Only for a cluster that advertises other addresses: every data server's public address (servers[].public in the coordinator configuration) as host:port, separated by commas or spaces, at most 64. List every server, not only today's leaders. Patterns are not accepted, because the token would follow any address a pattern matches. Leave empty for oxia standalone.",
      allowInsecureAuth:
        "Oxia receives the token on every call, so with no SSL mode it crosses the network in cleartext, to the host and to every data server. A token sent without TLS to a host that is not this machine is refused unless this is ticked. Choose an SSL mode under SSL / TLS instead wherever the server offers one.",
    },
    readOnlyHint:
      "Oxia connections are read-only in this version, whether or not this is ticked: Studio sends Oxia no write.",
  },
  databend: {
    // Databend's published icon in its own colours, at the Databend team's request (databendlabs/databend-docs#3512).
    icon: DatabendIcon,
    // `hue-red` is Oracle's; its `-alt` step joins IDENTITY_ALTS with this entry, the first of the hues with no
    // identity `-alt` to clear tests/unit/theme-accent-contrast.test.ts. The icon has fixed fills, so this class no
    // longer paints it; the entry still needs a distinct one.
    color: "text-hue-red-alt",
    label: "Databend",
    // Self-hosted's HTTP handler port. Port 443 comes from a DSN or an https:// paste, never from the SSL mode or a host
    // heuristic, so a Databend Cloud connection filled in by hand sets it.
    defaultPort: "8000",
    // The connection-string box reads http:// and https:// as ClickHouse, so a pasted address belongs in the Host box,
    // which splits it (hostAcceptsUri below); a databend:// DSN is the paste handler's.
    showConnectionStringToggle: false,
    // The SSL panel and the SSH tunnel stay offered. The last field is the consent to send the password without TLS,
    // drawn while SSL Mode is disable.
    connectionFields: ["host", "port", "user", "password", "database", "warehouse", "allowInsecureAuth"],
    fieldLabels: { warehouse: "Warehouse" },
    fieldPlaceholders: { user: "root", database: "default" },
    fieldHints: DATABEND_FIELD_HINTS,
    fieldRules: DATABEND_FIELD_RULES,
    hostAcceptsUri: ["http", "https"],
  },
  s3: {
    // A generic bucket drawn for Studio, never a vendor's logo.
    icon: S3Icon,
    // `hue-green` is Kafka's; of the hues with no identity `-alt` (amber, pink, green, cyan), `green-alt` left the light
    // set's minimum where it was within 0.0006 and the dark one unchanged, which is why `green` joined IDENTITY_ALTS in
    // tests/unit/theme-accent-contrast.test.ts with this entry.
    color: "text-hue-green-alt",
    // "S3-compatible": the servers this provider was verified on are named in docs/providers/s3.md, and AWS is not one.
    label: "S3-compatible object storage",
    // The API port MinIO and RustFS serve on by default. Garage serves on 3900 and an https:// paste sets 443.
    defaultPort: "9000",
    // No URI mode: an s3:// URI names a bucket and a key, never an endpoint and a credential, and the connection-string
    // box reads http:// and https:// as ClickHouse, so a pasted endpoint belongs in the Host box, which splits it.
    showConnectionStringToggle: false,
    // The SSL panel and the SSH tunnel stay offered. The last field is the consent to plain HTTP, drawn while SSL Mode
    // is disable.
    connectionFields: ["host", "port", "user", "password", "database", "region", "allowInsecureAuth"],
    fieldLabels: {
      host: "Endpoint host",
      user: "Access key ID",
      password: "Secret access key",
      database: "Bucket",
      region: "Region",
      allowInsecureAuth: "Connect without TLS",
    },
    // What an empty box means, as Oxia's "default" (ruling R34 there).
    fieldPlaceholders: { database: "all buckets", region: "us-east-1" },
    fieldHints: S3_FIELD_HINTS,
    fieldRules: S3_FIELD_RULES,
    // The dialog's own sentence says the mode can be turned off, which is false here.
    readOnlyHint:
      "S3-compatible connections are read-only in this version, whether or not this is ticked: Studio sends no write.",
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

/** The connection dialog's placeholder for one field: the engine's declared one, or the dialog's own example. */
export function connectionFieldPlaceholder(config: DatabaseUIConfig, field: ConnectionField, fallback: string): string {
  return config.fieldPlaceholders?.[field] ?? fallback;
}

/**
 * The sentence the connection dialog draws under one field, or `undefined` where the engine
 * declares none (#1085). There is no fallback: a field with no declared hint draws nothing new,
 * and the per-type hints `ConnectionModal.tsx` already writes stay beside it.
 */
export function connectionFieldHint(config: DatabaseUIConfig, field: ConnectionField): string | undefined {
  return config.fieldHints?.[field];
}

/**
 * The first refusal of the engine's `fieldRules` for a connection as the dialog built it, or `undefined` when every
 * declared check passes. The fields are checked in `connectionFields` order, so the dialog names the first box to fix.
 * A blank field is one the dialog wrote no value for, or an empty one.
 */
export function connectionFieldRefusal(config: DatabaseUIConfig, connection: DatabaseConnection): string | undefined {
  const values = connection as Partial<Record<ConnectionField, unknown>>;
  for (const field of config.connectionFields) {
    const rule = config.fieldRules?.[field];
    if (rule === undefined) continue;
    const value = values[field];
    if (value === undefined || value === "") {
      if (rule.required !== undefined) return rule.required;
      continue;
    }
    if (rule.format !== undefined && !rule.format.pattern.test(String(value))) return rule.format.sentence;
    if (
      rule.charRange !== undefined &&
      (String(value).length < rule.charRange.min || String(value).length > rule.charRange.max)
    ) {
      return rule.charRange.sentence;
    }
  }
  return undefined;
}

/** The sentence under the Read-only toggle: the engine's own where it declares one, else the dialog's. */
export function readOnlyHint(config: DatabaseUIConfig): string {
  return (
    config.readOnlyHint ??
    "Writes, value edits and maintenance are refused on this connection. You can turn this off here, so on your own connection it is a safety rail, not a permission."
  );
}
