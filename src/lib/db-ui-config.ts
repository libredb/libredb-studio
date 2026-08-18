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
  )[];
}

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
  mongodb: {
    icon: MongoDBIcon,
    color: "text-emerald-400",
    label: "MongoDB",
    defaultPort: "27017",
    showConnectionStringToggle: true,
    connectionFields: ["host", "port", "user", "password", "database", "connectionString"],
  },
  redis: {
    icon: RedisIcon,
    color: "text-rose-400",
    label: "Redis",
    defaultPort: "6379",
    showConnectionStringToggle: false,
    connectionFields: ["host", "port", "password", "database"],
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
