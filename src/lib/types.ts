export type DatabaseType =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "mongodb"
  | "redis"
  | "oracle"
  | "mssql"
  | "libredb"
  | "couchbase"
  | "clickhouse"
  | "druid";

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

export type SSLMode = "disable" | "require" | "verify-ca" | "verify-full";

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
  connectionString?: string;
  createdAt: Date;
  color?: string;
  environment?: ConnectionEnvironment;
  group?: string;
  ssl?: SSLConfig;
  sshTunnel?: SSHTunnelConfig;
  serviceName?: string; // Oracle: service name (e.g. ORCL, XEPDB1)
  instanceName?: string; // MSSQL: named instance (e.g. SQLEXPRESS)
  managed?: boolean; // true = admin-controlled, read-only in UI
  seedId?: string; // stable reference to seed config ID
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys?: ForeignKeySchema[];
  rowCount?: number;
  size?: string;
}

export interface ForeignKeySchema {
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
}

/**
 * Heavy relationship/index data for a table, loaded separately from the fast
 * structural schema (see getSchemaList / getSchemaRelations) and merged on the
 * client by `name`. Keeping it separate prevents a slow stats query from
 * blocking the table list.
 */
export interface TableRelations {
  name: string;
  foreignKeys: ForeignKeySchema[];
  indexes: IndexSchema[];
}

export interface ColumnSchema {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  defaultValue?: string;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
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
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  rowCount: number;
  executionTime: number;
  explainPlan?: unknown;
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
}

export interface QueryTab {
  id: string;
  name: string;
  query: string;
  result: QueryResult | null;
  isExecuting: boolean;
  type: "sql" | "mongodb" | "redis" | "libredb";
  viewMode?: "results" | "explain" | "history" | "saved";
  explainPlan?: unknown;
  // Pagination state
  currentOffset?: number;
  isLoadingMore?: boolean;
  allRows?: Record<string, unknown>[];
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
  schema: TableSchema[];
  createdAt: Date;
  label?: string;
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
