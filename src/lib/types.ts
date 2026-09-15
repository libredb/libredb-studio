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
  // IBM Db2 for Linux, UNIX and Windows (Db2 LUW). A proprietary relational engine
  // reached over the DRDA binary protocol, so - unlike the driver-free HTTP providers
  // - it carries a NATIVE driver (`ibm_db`, an N-API addon whose install step fetches
  // the IBM CLI driver). There is a first-class HTTP path (the Db2 REST service's
  // `/v1/services/execsql`), but it is a separately deployed container that is
  // commonly disabled, so an IDE that must reach any standard Db2 uses the driver the
  // way DBeaver/DataGrip do. Standard SQL: double-quoted identifiers and
  // `FETCH FIRST n ROWS ONLY` pagination are both correct, so this extends
  // `SQLBaseProvider` and overrides only `prepareQuery()`, mirroring Oracle. The
  // connection's `database` field pins one database; a Db2 SCHEMA is the namespace
  // level, read as the connecting user's schema by default the way Oracle reads its
  // owner. `supportsExplain` is false initially (the same posture as Oracle and SQL
  // Server, #126): Db2 EXPLAIN populates explain tables rather than returning a plan
  // from one statement, so the single-statement explain path cannot express it yet.
  | "db2";

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
 * `rejectUnauthorized: true` there and each provider doc says so.
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
 * `src/lib/storage/connection-secrets.ts` - and each of them answers a question about what a
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
  managed?: boolean; // true = admin-controlled, read-only in UI
  seedId?: string; // stable reference to seed config ID
  agentUser?: string; // optional least-privilege role for the agent read-only execution profile (#328)
  agentPassword?: string; // password for agentUser; secret-classified, sealed at rest by connection-secrets
}

export interface ForeignKeySchema {
  columnName: string;
  referencedTable: string;
  referencedColumn: string;
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
  isExecuting: boolean;
  type: "sql" | "mongodb" | "redis" | "libredb";
  viewMode?: "results" | "explain" | "history" | "saved";
  explainPlan?: unknown;
  // Pagination state
  currentOffset?: number;
  isLoadingMore?: boolean;
  allRows?: Record<string, unknown>[];
  /**
   * Present exactly on a Source tab (#789 Phase 2).
   *
   * An optional FIELD and deliberately not a fifth member of `type`. Every member of that
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
   * `diffSchemas` therefore keeps comparing BY NAME, as Task 25c measured: an old snapshot
   * carries no kind, so keying on kind would report every object in it as removed and
   * re-added the first time it was opened against a current reading. Nothing migrates these
   * records and nothing needs to.
   */
  schema: StoredObject[];
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
