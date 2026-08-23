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
  // Apache Trino (issue #424 Phase 2). A QUERY ENGINE rather than a store: what the
  // connection's `database` field pins is a Trino CATALOG (`tpch`, `hive`, `iceberg`),
  // the way a PostgreSQL connection pins a database, and the schemas inside it are the
  // schema level. PrestoDB is deliberately NOT this id - the transport builds its
  // header names from a dialect descriptor's prefix, so that fork is a descriptor away
  // rather than a rewrite.
  | "trino";

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
  managed?: boolean; // true = admin-controlled, read-only in UI
  seedId?: string; // stable reference to seed config ID
  agentUser?: string; // optional least-privilege role for the agent read-only execution profile (#328)
  agentPassword?: string; // password for agentUser; secret-classified, sealed at rest by connection-secrets
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
