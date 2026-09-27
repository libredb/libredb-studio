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
} from "@/components/icons/db-icons";
import type { DatabaseType } from "@/lib/types";

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
  libredb: {
    icon: LibreDBIcon,
    color: "text-hue-violet",
    label: "LibreDB",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: ["database"],
  },
};

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
