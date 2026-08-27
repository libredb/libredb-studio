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
  )[];
}

/** One addressing field, named by the same list that decides whether a save writes it. */
export type ConnectionField = DatabaseUIConfig["connectionFields"][number];

export const DB_UI_CONFIG: Record<DatabaseType, DatabaseUIConfig> = {
  postgres: {
    icon: PostgreSQLIcon,
    color: "text-blue-400",
    label: "PostgreSQL",
    defaultPort: "5432",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database"],
  },
  mysql: {
    icon: MySQLIcon,
    color: "text-amber-400",
    label: "MySQL",
    defaultPort: "3306",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database"],
  },
  sqlite: {
    icon: SQLiteIcon,
    color: "text-cyan-400",
    label: "SQLite",
    defaultPort: "",
    showConnectionStringToggle: false,
    connectionFields: ["database"],
  },
  duckdb: {
    icon: DuckDBIcon,
    // DuckDB's own mark is a bright yellow (#FFF000), and `text-yellow-400` is already
    // ClickHouse's. yellow-300 is the nearest free shade, and the distinct-colour
    // assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out.
    color: "text-yellow-300",
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
    color: "text-emerald-300",
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
    color: "text-emerald-400",
    label: "MongoDB",
    defaultPort: "27017",
    showConnectionStringToggle: true,
    connectionFields: ["host", "port", "user", "password", "database", "connectionString", "authSource"],
  },
  redis: {
    icon: RedisIcon,
    color: "text-rose-400",
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
    color: "text-red-400",
    label: "Oracle",
    defaultPort: "1521",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database", "serviceName"],
  },
  mssql: {
    icon: MSSQLIcon,
    color: "text-sky-400",
    label: "SQL Server",
    defaultPort: "1433",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "user", "password", "database", "instanceName"],
  },
  couchbase: {
    icon: CouchbaseIcon,
    color: "text-orange-400",
    label: "Couchbase",
    // Management port. The query ports are discovered from the cluster at connect
    // time (issue #262, decision 3), so only this one is ever stored.
    defaultPort: "8091",
    showConnectionStringToggle: true,
    connectionFields: ["host", "port", "user", "password", "database", "connectionString"],
  },
  clickhouse: {
    icon: ClickHouseIcon,
    color: "text-yellow-400",
    label: "ClickHouse",
    // The HTTP interface port. The provider speaks HTTP only, so the native
    // protocol port 9000 is never a valid value here (issue #264).
    defaultPort: "8123",
    showConnectionStringToggle: true,
    connectionFields: ["host", "port", "user", "password", "database", "connectionString"],
  },
  druid: {
    icon: DruidIcon,
    // Issue #265 specified text-sky-400, which mssql already owns; the distinct-colour
    // assertion in tests/unit/lib/db-ui-config.test.ts rules a duplicate out. teal-400
    // is the nearest free shade and is closer to Druid's own petrol-teal mark anyway.
    color: "text-teal-400",
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
    color: "text-teal-300",
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
    connectionFields: ["host", "port", "user", "password"],
  },
  opensearch: {
    icon: OpenSearchIcon,
    // OpenSearch's Pacific Blue (#005EB8) is deeper and bluer than postgres' own
    // blue-400, which already owns "blue" here; indigo-400 is the nearest free shade.
    color: "text-indigo-400",
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
    color: "text-pink-400",
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
    connectionFields: ["host", "port", "user", "password", "database"],
  },
  cassandra: {
    icon: CassandraIcon,
    // Cassandra's own mark is a mid-cyan eye (#1287B1). sky-400 is mssql's and the
    // distinct-colour assertion in tests/unit/lib/db-ui-config.test.ts rules a
    // duplicate out, so sky-300 is the nearest free shade.
    color: "text-sky-300",
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
  libredb: {
    icon: LibreDBIcon,
    color: "text-violet-400",
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
