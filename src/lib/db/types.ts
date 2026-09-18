/**
 * Database Provider Types & Interfaces
 * Strategy Pattern implementation for multi-database support
 */

// Re-export common types from main types file
export type {
  DatabaseType,
  DatabaseConnection,
  ColumnSchema,
  // `ObjectDetail` below is defined over these two, so a provider implementing
  // `describeObject` needs them from here rather than reaching past this module (#789).
  IndexSchema,
  ForeignKeySchema,
  QueryResult,
  QueryWarning,
} from "../types";

import type {
  DatabaseType,
  DatabaseConnection,
  QueryResult,
  ColumnSchema,
  IndexSchema,
  ForeignKeySchema,
} from "../types";

// ============================================================================
// Pool Configuration
// ============================================================================

export interface PoolConfig {
  /** Minimum number of connections in pool (default: 2) */
  min: number;
  /** Maximum number of connections in pool (default: 10) */
  max: number;
  /** Close idle connections after this time in ms (default: 30000) */
  idleTimeout: number;
  /** Wait for connection timeout in ms (default: 60000) */
  acquireTimeout: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 2,
  max: 10,
  idleTimeout: 30000,
  acquireTimeout: 60000,
};

/** Query timeout in milliseconds (default: 60 seconds) */
export const DEFAULT_QUERY_TIMEOUT = 60000;

// ============================================================================
// Health Information
// ============================================================================

export interface SlowQuery {
  query: string;
  calls: number;
  avgTime: string;
}

export interface ActiveSession {
  pid: number | string;
  user: string;
  database: string;
  state: string;
  query: string;
  duration: string;
}

export interface HealthInfo {
  /**
   * The count of connections currently open, or absent when the engine cannot
   * measure it at all.
   *
   * Optional for the same reason `DatabaseOverview.activeConnections` is: absence
   * and zero are different facts, and a provider that cannot read the figure must
   * omit the key rather than send a fabricated 0. This is the field the agent's
   * curated "health" reading forwards to the model (`src/lib/agent/tools.ts`), so a
   * fabricated 0 here is not a display quirk - it is telling the model a fact about
   * a server it could not measure. Most providers compose this straight from
   * `DatabaseOverview.activeConnections`, which is where the absence already comes
   * from (ScyllaDB has no `system_views` keyspace; a Cassandra role can be denied
   * the grant); no `?? 0` fallback belongs at that seam.
   */
  activeConnections?: number;
  databaseSize: string;
  cacheHitRatio: string;
  slowQueries: SlowQuery[];
  activeSessions: ActiveSession[];
}

// ============================================================================
// Maintenance Operations
// ============================================================================

export type MaintenanceType = "vacuum" | "analyze" | "reindex" | "kill" | "optimize" | "check";

export interface MaintenanceResult {
  success: boolean;
  executionTime: number;
  message: string;
}

/**
 * What ONE maintenance operation can be pointed at on ONE engine, declared next to
 * that engine's own wording for it.
 *
 * `maintenanceOperations` says only that an operation EXISTS here, and #427 measured
 * what a surface built on that alone offers. Oracle declares `optimize`, so the
 * per-table button sent `optimize` with a TABLE name - and `oracle.ts` built
 * `ALTER INDEX "<target>" REBUILD` from it, so every click answered ORA-01418
 * (reproduced 2026-08-25 against Oracle AI Database 26ai Free before this change). The target
 * grammar differs between engines that declare the SAME `MaintenanceType`, so a
 * generic label-to-operation mapping is wrong by construction and the declaration has
 * to travel with the provider.
 *
 * `perEntity` and `global` are independent because both halves occur: Couchbase's
 * `reindex` is BUILD INDEX for ONE keyspace and has no whole-database form (its global
 * card answered *"The reindex operation requires a target"*), while SQLite's `VACUUM`
 * rewrites the whole file and ignores a target entirely (a per-table control there
 * names one table and vacuums the database). An operation whose target is a session or
 * query id - every engine's `kill` - is `false` for both: the Sessions panel supplies
 * that id, and no table or global control can.
 */
export interface MaintenanceOperationSpec {
  /** This engine's own wording for a control that runs the operation. */
  label: string;
  /** Runs against ONE object the browser lists: a table, a collection, a keyspace. */
  perEntity: boolean;
  /** Runs with no target at all, over the whole database. */
  global: boolean;
}

/** Where a surface wants to put a control: on one row, or on a whole-database card. */
export type MaintenancePlacement = "perEntity" | "global";

/**
 * Whether ONE maintenance control may be offered in ONE place, and the wording to
 * give it - the single gate both maintenance surfaces ask, so that they cannot
 * disagree about what a provider declared.
 *
 * `label` is undefined rather than a fallback string on purpose: only the provider
 * may name the operation, so a caller that gets no name keeps its own generic word.
 * That is also the whole of the compatibility story for the optional
 * `maintenanceOperationSpecs` - a provider that declares no spec is offered in both
 * placements under the caller's own wording, which is what both surfaces did before
 * #U9.
 */
export function maintenanceControl(
  capabilities: ProviderCapabilities | undefined,
  type: MaintenanceType,
  placement: MaintenancePlacement,
): { offered: boolean; label?: string } {
  // Unknown capabilities are not a permission: `/api/db/provider-meta` answers with
  // nothing both while it is in flight and when it failed, and failing open there
  // puts the dead buttons back on exactly the connections the #272/#282 gates exist
  // for.
  if (capabilities?.supportsMaintenance !== true || !capabilities.maintenanceOperations.includes(type)) {
    return { offered: false };
  }

  const spec = capabilities.maintenanceOperationSpecs?.[type];
  if (spec === undefined) {
    return { offered: true };
  }

  return { offered: spec[placement], label: spec.label };
}

// ============================================================================
// Provider Capabilities & Labels
// ============================================================================

/**
 * Dialect discriminant for client-side EXPLAIN handling (issue #194).
 * Each id selects one strategy module in `src/lib/explain`. Extended per
 * provider as explain support lands.
 */
export type ExplainFormat =
  | "postgres-json"
  | "postgres-text"
  | "postgres-text-analyze"
  | "mysql-json"
  | "mysql-text"
  | "sqlite-queryplan"
  | "couchbase-json"
  | "clickhouse-json"
  | "druid-native"
  | "trino-json"
  | "duckdb-json";

/**
 * How deep an engine's container chain is, in the TYPE rather than only in a derivation.
 *
 * Phase 1's tree models zero, one or two levels and `containerDepth()` answers `0 | 1 | 2`, so a
 * provider declaring a third level used to have it silently clamped away: the level would exist in
 * the declaration, `ContainerLevelSpec.level` indices would still point at it, and nothing would
 * read it. Spelling the ceiling as a tuple union makes that declaration a compile error at the
 * provider that writes it, which is where the person who meant to add it is standing. No engine in
 * this repository declares three; the first one that needs to is a Phase 2 question about the tree,
 * not a number to widen here (#789).
 */
export type ContainerLevels =
  | readonly []
  | readonly [ContainerLevelSpec]
  | readonly [ContainerLevelSpec, ContainerLevelSpec];

export interface ProviderCapabilities {
  queryLanguage: "sql" | "json";
  /**
   * Optional client-side query dialect. `queryLanguage` only says SQL vs JSON;
   * for non-SQL providers the query generators otherwise assume MongoDB syntax.
   * A provider sets `queryDialect` to opt its tables into a custom client-side
   * generator (see `query-generators.ts`), and it is checked BEFORE
   * `queryLanguage` everywhere. Left undefined by SQL and MongoDB, so their
   * generation is unchanged; Redis declares `"redis"` because it too says
   * `queryLanguage: "json"` while speaking neither MongoDB JSON nor SQL, and
   * silently got MongoDB commands its own driver rejected (#427).
   */
  queryDialect?: "libredb" | "redis";
  supportsExplain: boolean;
  /**
   * Present iff supportsExplain is true (enforced by provider tests).
   * Undefined = no explain support; the UI hides the Explain button and tab.
   */
  explainFormat?: ExplainFormat;
  supportsExternalQueryLimiting: boolean;
  supportsCreateTable: boolean;
  /**
   * Whether this engine accepts the single-table row update the results grid's
   * inline editor builds — `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>`
   * (`src/hooks/use-inline-editing.ts`). False hides the editing affordance
   * entirely rather than offering a control that can only produce an error
   * (issue #269): ClickHouse spells a row mutation `ALTER TABLE ... UPDATE`,
   * Druid SQL has no row-level DML, and the JSON-language providers have no
   * `UPDATE` statement at all.
   *
   * Optional because this interface is published (`src/exports/types.ts`) and a
   * required field added after the fact stops every external implementer from
   * compiling. Every provider in this repo declares it; the UI gates on
   * `=== true`, so an absent flag reads as unsupported rather than inheriting a
   * permissive default.
   */
  supportsInlineRowEdit?: boolean;
  supportsResultPagination?: boolean;
  /**
   * Whether THIS PROVIDER implements the interactive transaction session that
   * `POST /api/db/transaction` drives — `beginTransaction()` / `commitTransaction()`
   * / `rollbackTransaction()` over one held connection. It is a statement about the
   * provider's surface, not about whether the engine has a transaction concept
   * somewhere: SQLite has `BEGIN`, and this provider still declares `false`, because
   * it holds no session for one and the route refuses the call.
   *
   * It exists because the route's own gate is `isTransactionProvider(provider)`, a
   * runtime shape check no client can read. `Studio.tsx` therefore supplied
   * BEGIN/COMMIT/ROLLBACK — and SANDBOX, which auto-rolls-back through the same
   * route — on every connection. Measured 2026-08-19 on OpenSearch: HTTP 400,
   * "Transaction control is not supported for this database type", for both `begin`
   * and `rollback`. Elasticsearch, Druid, Couchbase, MongoDB, Redis, Trino,
   * Cassandra, SQLite and LibreDB were all in that position.
   *
   * Optional for the same published-interface reason as `supportsInlineRowEdit`
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Every provider in this repo declares it, and the
   * UI gates on `=== true`, so an absent flag — and an unresolved `metadata` — reads
   * as no transactions rather than inheriting a permissive default.
   */
  supportsTransactions?: boolean;
  /**
   * Whether this engine has foreign keys to declare at all — not whether any
   * particular schema declares one, and not whether the current role can see them.
   *
   * It exists because an empty foreign-key list means two different things
   * and the reader cannot tell them apart. On PostgreSQL an empty list means this
   * schema declares none, or that the role this connection reads with cannot see the
   * ones it declares — an empty read cannot tell those two apart, which is why the
   * agent's relations block reports neither of them as fact; on MongoDB, Redis, LibreDB, Druid, ClickHouse and Couchbase it means the
   * engine has no such constraint in its model, so no reading of any kind could ever
   * return one. A consumer that hedges between "the schema is like that" and "the
   * application enforces them" is wrong in BOTH branches on those six, and #414 hit
   * that when grounding reached them. Reading `connection.type` at the consumer was
   * the alternative and is forbidden by `CLAUDE.md`: engine behaviour is declared by
   * the provider that has it.
   *
   * Optional for the same published-interface reason as `supportsInlineRowEdit`
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Consumers therefore gate on `=== false`, so an
   * absent flag reads as "this engine may declare foreign keys" — the weaker claim,
   * which keeps the existing hedge rather than asserting an absence nobody declared.
   */
  declaresForeignKeys?: boolean;
  /**
   * Whether this provider's relation-shaped rows are objects the engine holds, or
   * groupings this server derived from a bounded scan of what it found.
   *
   * True on Redis and LibreDB and nowhere else. Neither engine has a schema to read:
   * the walk scans a bounded slice of the keyspace — 1000 keys on Redis, 10000 on
   * LibreDB — and collapses the real key names it found into one row per common
   * prefix. So a row named `user:*` is not a key, was never named by anybody, and no
   * command can be given it; and the set of rows is what that one scan happened to
   * reach rather than everything the database holds.
   *
   * It exists because a consumer cannot tell the two apart from the inventory itself,
   * and #414 measured what that costs: plan mode, grounded on a seeded Redis with 17
   * real prefixes, drafted `KEYS user:*` and `ZCARD user:*` against rows it had been
   * handed under the word "table". Both name a key that does not exist. The model was
   * not wrong to treat them as addressable — nothing it was shown said they were not,
   * and only this server knows, because the grouping is this server's own.
   *
   * Optional for the same published-interface reason as `declaresForeignKeys`
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Consumers therefore gate on `=== true`, so an
   * absent flag reads as "these rows are real objects" — the ordinary case, and the
   * one every SQL engine and every document engine is in. Reading `connection.type` at
   * the consumer was the alternative and is forbidden by `CLAUDE.md` for the reason
   * this pair of engines demonstrates: the two that answer true are not the two a
   * reader would guess, and a third would be added to a provider and forgotten here.
   */
  tablesAreDerivedGroupings?: boolean;
  /**
   * True when the engine admits exactly ONE open handle per database FILE, because
   * opening the file takes an exclusive lock: a second open of a file this process
   * already holds does not return a second handle, it throws.
   *
   * `libredb` is the only engine that declares it. `lib.open({ path })` takes an
   * exclusive `<path>.lock` sidecar and a second open of the same path throws
   * `LibreDbError` with `code: "LOCKED"` - measured 2026-08-25 against
   * `@libredb/libredb` 0.2.2, in one process. SQLite is the engine a reader would
   * expect beside it and does NOT belong: measured the same day on `bun:sqlite`, a
   * second `new Database(path, { readwrite: true })` on a WAL file this process
   * already holds both opens and writes, because SQLite takes its file locks per
   * transaction rather than at open.
   *
   * It exists because three code paths open a SECOND handle on a file the connection's
   * own cached provider is already holding, and on this engine the lock defeated every
   * one of them every time (#498): `POST /api/db/test-connection`
   * reported the lock as a failed connection test - which made the built-in LibreDB
   * sample impossible to EDIT, because the dialog tests before it saves;
   * `acquireExecutionProfileProvider` lost every agent grounding read on the
   * connection to it, silently, since a `ConnectionError` becomes an unavailable
   * capture rather than a failure; and `POST /api/db/schema-snapshot` answered 503, so
   * the Schema Diff tab could not snapshot a schema the sidebar was listing.
   * `findOpenSingleWriterProvider` (`factory.ts`) now hands all three the handle that
   * is already open, keyed by the RESOLVED FILE PATH rather than the connection id: the
   * second opener is usually a different connection record pointing at the same file.
   *
   * Optional for the same published-interface reason as `supportsInlineRowEdit`
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Consumers therefore gate on `=== true`, so an
   * absent flag reads as "this engine serves as many handles as we open" - the
   * ordinary case, and the one every client-server engine is in. Reading
   * `connection.type` at the consumer was the alternative and is forbidden by
   * `CLAUDE.md`.
   */
  singleWriterFile?: boolean;
  supportsMaintenance: boolean;
  maintenanceOperations: MaintenanceType[];
  /**
   * Per-operation targeting for the operations above, keyed by `MaintenanceType`.
   *
   * Optional for the published-interface reason `supportsInlineRowEdit` records
   * (`src/exports/types.ts`): a required field added after the fact stops every
   * external implementer compiling. Absent means "gate on `maintenanceOperations`
   * alone", which is what both maintenance surfaces did before #U9 - so an
   * implementation that declares nothing here behaves exactly as it did.
   */
  maintenanceOperationSpecs?: Partial<Record<MaintenanceType, MaintenanceOperationSpec>>;
  supportsConnectionString: boolean;
  defaultPort: number | null;
  /**
   * How this engine quotes an identifier, when the port cannot say.
   *
   * `src/lib/query-generators.ts` has always derived the dialect from
   * `defaultPort`, which worked only because every engine had a distinct one. That
   * assumption broke with #424 Phase 1: Elasticsearch and OpenSearch BOTH ship on
   * 9200 and they disagree about the quote character, so one port had to answer for
   * two dialects. The consequence was measured, and it is the worst kind: on
   * OpenSearch 3.8.0 a double-quoted identifier is a STRING LITERAL, so
   * `SELECT customer FROM probe_orders WHERE "customer" = 'acme'` answers HTTP 200
   * with `total: 0` - a generated query silently returning no rows instead of
   * failing. Backticks return the row.
   *
   * Absent means "keep deriving it from the port", so no existing provider changes
   * and nothing about the old behaviour moves. A provider sets this when the port
   * is not a faithful proxy for its dialect - which is any engine that shares a
   * default port with a differently-quoting one.
   */
  identifierQuoting?: "double" | "backtick";
  /**
   * Whether a statement this product runs may end with `;`.
   *
   * Absent means it may, which is every engine that shipped before #424 Phase 1 and
   * is what `src/lib/query-generators.ts` has always emitted. `"none"` says the
   * terminator is not in the grammar at all.
   *
   * Measured 2026-08-19 on Elasticsearch 9.1.4: the generator's own
   * `SELECT * FROM orders LIMIT 50;` - the query behind "Select Top 50 Documents",
   * the first thing a user clicks on an index - answered `parsing_exception`,
   * "line 1:30: extraneous input ';' expecting <EOF>". The same shape without the
   * `;` returns the rows. OpenSearch 3.8.0 accepts both spellings, so the two
   * products need no separate answer: omitting it runs everywhere, and declaring it
   * here keeps `query-generators.ts` from having to know which engine it is
   * generating for.
   *
   * Oracle is the second product that declares it, and for a different reason worth
   * keeping apart: `;` is a SQL*Plus convention rather than Oracle SQL, and node-oracledb
   * sends one statement with no terminator in it. Measured on Oracle AI Database 26ai Free
   * on 2026-09-12 by clicking a table in the object browser -
   * `SELECT * FROM app_customers FETCH FIRST 50 ROWS ONLY;` answers ORA-00933 "SQL command
   * not properly ended" and the same statement without the `;` returns the rows (#789).
   *
   * This bounds the GENERATORS only. A user who types a `;` still has it stripped
   * by the editor's statement reader before the statement is sent, and the raw API
   * passes text through untouched - neither of those is this field's business.
   */
  statementTerminator?: "none";
  /**
   * The container levels this engine nests its objects in, outermost first (#789).
   *
   * Absent or empty means the engine has none, and that is a claim about the engine
   * rather than a gap in the declaration: SQLite, libSQL, Elasticsearch, OpenSearch and
   * LibreDB address every object by a bare name, so the tree draws objects directly
   * under the connection. One level is a database, a keyspace or a bucket; two is a
   * catalog plus a schema. The per-engine inventory each provider declares from is on
   * the epic, issue #789.
   *
   * Read it through `containerDepth()` in `src/lib/db/object-kinds.ts` and never by
   * length here, so the empty and the absent cases cannot be answered differently by
   * two callers.
   *
   * Optional for the same published-interface reason as `supportsInlineRowEdit`
   * (`src/exports/types.ts`): a required field added after the fact stops every external
   * implementer compiling.
   */
  containerLevels?: ContainerLevels;
  /**
   * Every object kind this engine has, each declared in full by the provider that has
   * it (#789).
   *
   * Absent means no object kind is declared, so the tree stays empty for this engine
   * rather than falling back to a table-shaped default. The permissive default is wrong
   * here for the reason the flat model was replaced: it would claim a concept on an
   * engine nobody asked: Druid has no view, no materialized view, no routine and no
   * trigger, Cassandra has no view, and MySQL has never had a materialized view. The
   * per-engine inventory behind those absences is on issue #789.
   *
   * A kind that is absent from this list is a different fact from a kind that is
   * declared and holds nothing, which is what `KindCount` carries. Read this through
   * `declaredKinds()` in `src/lib/db/object-kinds.ts`.
   *
   * Optional for the same published-interface reason as `containerLevels` above.
   *
   * WHAT AN EMPTY DECLARATION COSTS, said here because the type is what an external
   * implementer of this interface reads. Since the flat schema reading was deleted, this
   * list is the ONLY thing that grounds a database: a provider declaring no kind draws no
   * folder in the object browser, and its agent runs are ungrounded. That is refused
   * LOUDLY rather than silently - `readObjectInventoryForGrounding()` answers
   * `unsupported` before it spends a statement, and the run is told
   * "the provider declares no object kinds, so there is nothing to list" as a
   * `CATALOG_READ_REFUSED` capture - so a run is never handed an empty inventory as
   * though it were an empty database. It is deliberately not a construction-time throw:
   * every one of the seventeen shipped type ids declares kinds, so the shape is
   * unreachable here, and refusing to CONNECT over it would take a connection away from
   * an implementer whose query editor works perfectly well while their catalog reading is
   * still being written (#789).
   */
  objectKinds?: readonly ObjectKindSpec[];
  schemaRefreshPattern: string;
}

export interface ProviderLabels {
  entityName: string;
  entityNamePlural: string;
  rowName: string;
  rowNamePlural: string;
  selectAction: string;
  generateAction: string;
  analyzeAction: string;
  vacuumAction: string;
  /**
   * Which operation `vacuumAction` and the `vacuumGlobal*` triad actually NAME.
   *
   * Four providers point that wording at something that is not `vacuum`: ClickHouse's
   * *"Optimize Table"* and SQL Server's, Oracle's and MySQL's *"Rebuild Indexes"* /
   * *"Optimize Table"* each stand for the `optimize` the provider declares. MySQL
   * rendered the base default *"Vacuum Table"* for an engine whose operations
   * are `analyze`/`optimize`/`check`/`kill`. The global vacuum card was gated on the
   * literal `vacuum`, so every one of those provider's own words was written and never
   * shown, and the per-row item named an operation the page behind it could not run.
   *
   * Absent means `vacuum`, so no provider that really vacuums declares anything - and
   * a provider whose vacuum wording names NOTHING it can run leaves this absent too:
   * Couchbase's *"Compact"* says in its own description that the server compacts
   * automatically and there is no manual equivalent, so `vacuum` stays undeclared and
   * the card stays withheld, which is the honest outcome rather than pointing the
   * words at the unrelated `reindex` it does declare.
   * `analyzeAction` needs no twin of this, but not because every engine's analyze
   * wording stands for `analyze`: read across the providers, three point it at nothing
   * runnable - Trino's *"Table Statistics"*, the search family's *"Index Statistics"*
   * and the embedded LibreDB's *"Key Info"*. What makes the twin unnecessary is the
   * other half of each of those three: none of them declares an `analyze` operation
   * (`maintenanceOperations` is `['kill']` on Trino and `[]` on the other two), so the
   * control is withheld there by the declaration alone. Not one provider points its
   * analyze wording at a DIFFERENT operation it does declare, which is the only case a
   * twin field would resolve.
   */
  vacuumActionOperation?: MaintenanceType;
  searchPlaceholder: string;
  analyzeGlobalLabel: string;
  analyzeGlobalTitle: string;
  analyzeGlobalDesc: string;
  vacuumGlobalLabel: string;
  vacuumGlobalTitle: string;
  vacuumGlobalDesc: string;
  /**
   * The Operations tab's global Reindex card, in this engine's own terms.
   *
   * The analyze and vacuum cards have carried per-provider wording since #427; the
   * reindex card stayed hardcoded to PostgreSQL's "Run Reindex" / "Rebuild Indexes" /
   * "Reconstructs all indexes in the database." Three providers declare the `reindex`
   * maintenance operation — Postgres, SQLite and Couchbase — and on Couchbase that
   * copy is wrong the way the analyze copy was wrong for Redis: its reindex builds
   * deferred GSI indexes, which is not a table reindex.
   *
   * Optional, unlike the `analyzeGlobal*` and `vacuumGlobal*` triads above, because
   * `ProviderLabels` is published (`src/exports/types.ts`) and a required field added
   * after the fact stops every external implementer compiling — the rule
   * `supportsInlineRowEdit` records, and the one the newer `statementLanguage` and
   * `slowQueriesEmptyState` follow. `OperationsTab` keeps the hardcoded strings as
   * its fallback, which it needs anyway: `metadata` may carry capabilities with no
   * labels at all.
   */
  reindexGlobalLabel?: string;
  reindexGlobalTitle?: string;
  reindexGlobalDesc?: string;
  /**
   * What a statement for this engine is WRITTEN IN, named for a model rather than
   * for a person, and declared only where the engine's own name misleads one.
   *
   * Read by the agent's plan contract (`src/lib/agent/investigation.ts`). Every
   * other engine leaves it absent: a connection stamped `postgres` needs nobody to
   * add that its statements are PostgreSQL SQL, and a sentence saying so would spend
   * prompt on a fact the dialect line already carries.
   *
   * It exists because `queryLanguage: "sql"` is not always believable from outside.
   * Measured 2026-08-19: a plan run on an OpenSearch connection, asked for one
   * runnable statement, produced a native aggregation body - correct for the
   * product, unrunnable through a SQL endpoint - and the two search engines are the
   * only shipped engines whose names carry a stronger prior than their capability.
   * A provider sets this when a model asked for "a statement" would reasonably write
   * the wrong language.
   */
  statementLanguage?: string;
  /**
   * Why the monitoring Queries tab's "Slowest Queries" panel is empty on this
   * engine, in that engine's own terms.
   *
   * Read by `QueriesTab`, which defaults to PostgreSQL's "Enable
   * pg_stat_statements extension to see query stats." — the sentence it hardcoded
   * for every engine until #U12, measured 2026-08-19 in Chrome telling an
   * OpenSearch cluster to install a PostgreSQL extension. `postgres` therefore
   * declares nothing, and so does any engine whose statement store really is an
   * extension away.
   *
   * A provider sets this when the Postgres sentence is actively false for it:
   * either the engine keeps no aggregate of finished statements at all, or the
   * one it keeps is switched on somewhere else entirely. One field, not one per
   * sentence — the panel's badge names an extension rather than a category, so it
   * is dropped where this label is set instead of being re-worded from it.
   */
  slowQueriesEmptyState?: string;

  /**
   * Why the monitoring Sessions panel and the admin Operations session list are
   * empty on this engine, in that engine's own terms.
   *
   * The counterpart of `slowQueriesEmptyState` for the other half of the same
   * absence (#518). Both panels default to "No active sessions found.", which a
   * reader takes as "nothing is running right now" - true on PostgreSQL, and false
   * on an engine that publishes no session list at all and can never show a row.
   *
   * A provider sets this when its `getActiveSessions()` can only ever answer `[]`.
   * The failure branch beside it is a different fact: it renders a reason only when
   * the READ failed (`activeSessions` absent from the payload, the reason under
   * `errors`), and an absence is not an error.
   */
  sessionsEmptyState?: string;
}

/**
 * Enforcement caps for a single statement executed through an agent read-only
 * execution profile (#328). The timeout is enforced database-side
 * (transaction-local), the row/byte caps result-side after the statement
 * returns. Every field must be a positive integer — queryReadOnly refuses the
 * whole call otherwise (fail closed).
 */
export interface ReadOnlyStatementBudget {
  statementTimeoutMs: number;
  maxResultRows: number;
  maxResultBytes: number;
}

export interface PreparedQuery {
  query: string;
  wasLimited: boolean;
  limit: number;
  offset: number;
}

export interface QueryPrepareOptions {
  limit?: number;
  offset?: number;
  unlimited?: boolean;
}

// ============================================================================
// Provider Interface (Strategy Pattern)
// ============================================================================

/**
 * What `endOpenQueryTransaction()` found and did: `"none"` when the session carried no
 * open transaction, `"rolled-back"` when it did and the transaction has been discarded.
 *
 * Discarded rather than committed, deliberately. A script that opened a transaction and
 * never said COMMIT did not ask for its work to be kept, and committing on its behalf
 * would write changes on an authority nobody gave. The caller is expected to tell the
 * user which of the two happened; silence is what shipped, and silence is what let a
 * script's unfinished transaction reach another user.
 */
export type OpenQueryTransactionOutcome = "none" | "rolled-back";

/**
 * A fresh name for one caller's call scope (D87). One per request, minted by the route
 * that will also end it, so that the token cannot collide with another request's and
 * cannot be supplied by the client: a caller-chosen scope would let one request end
 * another's transaction, which is the defect this parameter exists to close.
 */
export function newQueryCallScope(): string {
  return crypto.randomUUID();
}

/**
 * Whether this provider can end a transaction its own `query()` path left open.
 *
 * A runtime shape check, the same one `POST /api/db/transaction` uses for the interactive
 * session: the method is optional on `DatabaseProvider` because only a provider that can
 * name the session its statements ran on can answer truthfully (`endOpenQueryTransaction`'s
 * declaration argues why). `postgres`, `sqlite`, `duckdb` and `redis` implement it; on the
 * rest a caller leaves the handle exactly as it found it, because inventing a rollback
 * there would be guessing at another engine's state. Shared by the two routes that end
 * what they opened, so they cannot disagree about who can be asked.
 */
export function endsOpenQueryTransactions(
  provider: DatabaseProvider,
): provider is DatabaseProvider & Required<Pick<DatabaseProvider, "endOpenQueryTransaction">> {
  return typeof provider.endOpenQueryTransaction === "function";
}

export interface DatabaseProvider {
  /** Database type identifier */
  readonly type: DatabaseType;

  /** Connection configuration */
  readonly config: DatabaseConnection;

  /**
   * Initialize connection pool or single connection
   */
  connect(): Promise<void>;

  /**
   * Close all connections and cleanup resources
   */
  disconnect(): Promise<void>;

  /**
   * Check if provider is currently connected
   */
  isConnected(): boolean;

  /**
   * Execute a SQL query
   * @param sql - SQL query string
   * @param params - Optional query parameters for prepared statements
   * @param queryId - The caller's own name for this run, so that `cancelQuery(queryId)`
   *   can reach the statement while it is still on the wire. Declared here because six
   *   providers already take it as their third parameter and the query route reached it
   *   through a cast; a provider that cannot cancel ignores it.
   * @param scope - The caller's own name for the CALL SCOPE this statement belongs to,
   *   which is what makes `endOpenQueryTransaction(scope)` able to name the session this
   *   request ran on rather than whichever one anybody touched last (D87). One request
   *   mints one scope and passes the same one to every statement it runs and to the
   *   ender; two concurrent requests on the same cached provider therefore never see
   *   each other's sessions. Absent means "this caller will not end anything", and a
   *   provider then records nothing for it.
   * @returns Query result with rows, fields, and execution time
   */
  query(sql: string, params?: unknown[], queryId?: string, scope?: string): Promise<QueryResult>;

  /**
   * Execute exactly one statement under the DATABASE's own read-only
   * enforcement (#328): the engine, not a parser, rejects writes through this
   * path. Optional on purpose — only providers with a verified database-native
   * boundary implement it, and execution-profile acquisition
   * (`acquireExecutionProfileProvider` in factory.ts) refuses provider types
   * that lack it rather than falling back to `query()` (fail closed).
   */
  queryReadOnly?(sql: string, budget: ReadOnlyStatementBudget): Promise<QueryResult>;

  /**
   * End a transaction that a statement run through `query()` left open on the session
   * `query()` runs on, and say whether there was one (D71).
   *
   * WHY IT EXISTS. `getOrCreateProvider` caches one provider per `connection.id` for the
   * whole process, so a transaction that outlives the request belongs to whoever borrows
   * that handle next. Measured 2026-09-13 through the product's own routes:
   * `POST /api/db/multi-query` with `BEGIN; CREATE TABLE ...; SELECT * FROM <missing>`
   * stops on the third statement and leaves the first one's transaction open. On
   * PostgreSQL 17 the next request — a DIFFERENT user, on `POST /api/db/query` — answered
   * HTTP 500 "current transaction is aborted, commands ignored until end of transaction
   * block", and so did `POST /api/db/maintenance` minutes later; on SQLite and DuckDB the
   * next user's INSERT answered 200 and read its own row back while an independent reader
   * saw nothing, and a later ROLLBACK destroyed it with no error anywhere.
   *
   * WHY IT IS ONE CALL AND NOT AN ASK FOLLOWED BY A ROLLBACK. Two engines cannot separate
   * them. On PostgreSQL the answer lives on ONE pooled client (`pg`'s ReadyForQuery status)
   * and a rollback issued through a second pool checkout is not guaranteed to reach the
   * same one, so the ask and the act have to name the same client. On DuckDB v1.5.5 there
   * is no ask at all: `current_transaction_id()` answers in both states,
   * `transaction_timestamp()` is an alias of `get_current_timestamp()`, and the client
   * context carries only a connection id, so the engine's own refusal of a ROLLBACK is the
   * only reading available. The RESULT still answers the question, which is what the
   * caller needs in order to tell the user what became of the transaction they opened.
   *
   * `"none"` is an ANSWER, never a failure: an unconditional ROLLBACK is not an option
   * because a rollback with nothing to roll back raises — measured on bun:sqlite 1.4.2 and
   * DuckDB v1.5.5, both "cannot rollback - no transaction is active".
   *
   * OPTIONAL, for the reason `queryReadOnly` is: only a provider that can name the session
   * its own `query()` ran on can answer truthfully, and a provider that cannot must say
   * nothing rather than guess. `postgres`, `sqlite`, `duckdb` and `redis` implement it: the
   * first three are the engines D71 was measured on, and `redis` was added by D75, which
   * walked every remaining type-id and wrote the absence down where it could not. A caller
   * shape-checks for it; there is no default, because a default that answered `"none"` would
   * certify an absence nobody read. Every type-id that does NOT implement it says which
   * absence it is in its own `docs/providers/<type-id>.md`.
   *
   * `scope` IS THE WHOLE CONTRACT, and an earlier form of this surface took no argument.
   * It said the method "does NOT touch the interactive transaction session
   * `POST /api/db/transaction` drives", because that session holds a connection of its own.
   * MEASURED FALSE on 2026-09-15 (D87), on PostgreSQL 18.4 through `pg` 8.23: a provider
   * that records one client per PROVIDER records it for every concurrent caller at once,
   * and `pg`'s LIFO idle list hands `beginTransaction()` the very object a previous
   * `query()` recorded, so the ender rolled an interactive session's committed CREATE TABLE
   * away while `commit` still answered "Transaction committed", and a plain read's ender
   * rolled back a concurrent multi-statement script mid-flight while the script was told
   * all four of its statements had succeeded. So the caller now NAMES its own call scope:
   * the same string it passed to every `query()` it made, and nothing this scope did not
   * run on can be ended here. A scope that left nothing open answers `"none"`.
   *
   * An implementer that holds ONE session for the whole provider — `sqlite`, `duckdb` and
   * `redis` do — has nothing to disambiguate and takes no argument at all, which is exactly
   * assignable to this declaration. The parameter is required rather than optional because
   * an unnamed call on a POOLED implementer has no truthful answer, and answering `"none"`
   * there would certify an absence nobody read.
   */
  endOpenQueryTransaction?(scope?: string): Promise<OpenQueryTransactionOutcome>;

  /**
   * Containers at `parent`, or the top level when `parent` is absent (#789).
   *
   * REQUIRED, along with the four below. They were optional through the phase that landed
   * them one provider at a time, and that phase is over: the flat reading they replaced
   * (`getSchema`, `getSchemaList`, `getSchemaRelations`) no longer exists, so a provider
   * that does not implement these answers nothing at all about what a database holds.
   * Optionality also bought a 501 the object routes had to carry for a provider gap, and a
   * gap that cannot occur is a guard nothing executes.
   */
  listContainers(parent?: readonly string[]): Promise<Container[]>;
  /** Per-kind counts for one container. A refused read is `{ unavailable }`, never 0. */
  countObjects(container: readonly string[]): Promise<Record<string, KindCount>>;
  /** Objects of one kind in one container. Names only: columns come from describeObject. */
  listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]>;
  /**
   * Columns, indexes and foreign keys for one object.
   *
   * `kind` is required, not a convenience. Without it a provider has to work out what it
   * is holding from what the path's last segment happens to match in a catalog, and
   * "answers nothing because no relation is called that" is not the same as "this is a
   * routine and routines have no columns" - the first is correct by accident and stops
   * being correct the moment a name collides. The caller always has the kind, because an
   * object is only ever reached through its kind's folder.
   */
  describeObject(path: readonly string[], kind: string): Promise<ObjectDetail>;

  /**
   * Columns, indexes and foreign keys for EVERY object of one kind in one container, in
   * one round trip (#789).
   *
   * The fifth method, and it exists because a consumer none of the other four serves was
   * measured rather than imagined: `src/lib/agent/tools.ts` read the agent's whole column,
   * index and foreign-key grounding through the flat reading, and deleting that reading
   * would otherwise have left the agent with no columns at all on fifteen engines. It is
   * the object-model-shaped successor of that method, not a new invention, so each provider
   * reshaped the old body rather than writing a new statement: those bodies carried which
   * catalog answers which fact, which system schemas are excluded and how an
   * extension-owned relation is hidden.
   *
   * ONE ROUND TRIP PER CONTAINER AND KIND, never one per object. `includeColumns` on the
   * inventory route was built as one `describeObject` per object, up to 5000 sequential
   * round trips, and removed as an N+1 this epic should not ship. A provider that loops
   * `describeObject` here has re-introduced it.
   *
   * The arguments are a container and a kind, the same pair `listObjects` takes, and not
   * a list of paths. Three reasons, in order of how much they cost. A caller's fan-out is
   * then bounded by the SAME container-and-kind product it already bounds for listing
   * (`INVENTORY_PAIR_LIMIT`), instead of by a second, differently shaped budget. A path
   * list would have to reach the engine as an IN list, which on a two-level engine is an
   * IN list over TUPLES and on a kind with mixed path depth (an Oracle schema-level
   * trigger against a table-level one) is two of them, so the statement's shape would
   * depend on the caller's selection rather than on the engine. And a caller holding 5000
   * paths would have to chunk them itself, which is a fan-out no bound in this repo
   * describes.
   *
   * `limit` bounds ONE read, which nothing else in the object surface does: the inventory
   * route's own docblock records that it can bound the number of listings and the number
   * of objects returned, and cannot bound a single listing from the outside. Absent means
   * unbounded, and a provider must not invent a cap of its own and stay silent about it -
   * it may cap, but then `truncated` says so.
   *
   * A kind that legitimately has no columns - a routine, a trigger, a sequence on some
   * engines - answers an empty `details` array without a round trip, exactly as
   * `describeObject` answers three empty arrays for one of them.
   */
  describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch>;

  /**
   * The definition text of ONE object, as a document of named parts (#789 Phase 2).
   *
   * OPTIONAL, unlike the five object methods above, and the asymmetry is argued rather than
   * inherited. Those five are required because a provider that does not implement them
   * answers nothing at all about what a database holds. A provider that does not implement
   * this one answers everything about what the database holds and simply declares no
   * source-bearing kind, which is the TRUE and measured state of `druid` and `libredb`:
   * neither has a kind with a definition text anywhere, so a required method would put an
   * unreachable throw in each, which is precisely the shape that got the 501 deleted.
   *
   * `kind` is required for the reason `describeObject`'s is: measured on MySQL, MariaDB and
   * DuckDB, one name addresses more than one object of different kinds in one container, so a
   * path alone reads the wrong object.
   *
   * `limit` bounds ONE PART's character count. Absent means unbounded. A provider may apply a
   * bound of its own, and must then set `truncated` on the part it bounded and never on a part
   * it read whole.
   *
   * The declaration and the method cannot disagree: `assertObjectSurface` asserts, in BOTH
   * directions, that a provider declares a kind with `hasSource` exactly when it implements
   * this method.
   */
  readObjectSource?(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument>;

  /**
   * Build the artifact an apply will send, or answer the engine fact that refuses one (#789
   * Phase 3).
   *
   * OPTIONAL for exactly the reason `readObjectSource` is optional and undefaulted: a provider
   * that omits it answers everything about what the database holds and simply declares no
   * editable kind, which is the TRUE and measured state of fourteen of the seventeen type ids on
   * day one. `BaseDatabaseProvider` declares no implementation, defaulted or otherwise, so a
   * provider either writes the method or the property is `undefined`.
   *
   * ONE OPTIONS OBJECT and not four positional arguments, and the reason is measured in this
   * repository rather than aesthetic: `requireSourceKind` takes its engine as
   * `{ displayName, type }` because "both are strings, a positional pair of them can be swapped
   * silently, and an object at the call site names each one". `(path, kind, partId, text)` is
   * three adjacent strings, two of them swappable with no compile error and one of them the
   * reader's entire definition.
   *
   * THE PROVIDER RE-READS THE OBJECT HERE, and that one read serves five purposes, none of which
   * can be taken from the document the pane is showing: it produces the revision, it is the
   * catalog fact a collateral consequence must be built from, it is the pre-image the preview's
   * left side needs, it answers the ownership pre-flight, and it is what refuses a part carrying
   * `truncated`. The editable predicate reads `truncated` and NEVER `form`: MEASURED on
   * PostgreSQL 18.4, `form` stays `"complete"` on a truncated part.
   *
   * Both methods or neither. `tests/helpers/object-surface-conformance.ts` asserts the pairing in
   * BOTH directions with both populations pinned: a build with no apply is a mandatory preview
   * with nothing behind it, and an apply with no build is ruling 1a violated.
   */
  buildObjectEdit?(request: ObjectEditRequest): Promise<ObjectEditBuild>;

  /**
   * Send the plan. Never the text again (ruling 1a).
   *
   * What this method may NOT do, each carried from a measurement rather than from a preference:
   *
   * - It may NOT call `beginTransaction()`/`rollbackTransaction()` on itself. MEASURED through
   *   the product: `txActive` is one flag per `connection.id`, a second Studio user's `begin` is
   *   refused 400 "Transaction already active", and their `rollback` then destroyed the first
   *   user's uncommitted write while answering HTTP 200.
   * - It may NOT leave a transaction open on the shared handle, and if it emits `BEGIN` it owns
   *   the matching GUARDED end in a `finally`. MEASURED on SQLite 3.53.2 that an unconditional
   *   `ROLLBACK` throws `cannot rollback - no transaction is active`, and MEASURED through the
   *   product on PostgreSQL that a dangling `BEGIN` poisons one pooled client for the whole
   *   process: every later request that lands on it, from any user on any route, answers HTTP 500
   *   "current transaction is aborted", until the 30-minute idle eviction.
   * - It may NOT leave session state behind. MEASURED with three controls: a `SET` by one Studio
   *   user was read back by another on the same backend. A plan's `pinned` session arm is issued
   *   inside the apply's own implicit transaction and is gone when the round trip ends; a bare
   *   `SET` is forbidden.
   * - It may NOT route through `/api/db/multi-query` or `splitStatements`. MEASURED: the splitter
   *   cuts a MySQL routine body into five fragments and a PostgreSQL `BEGIN ATOMIC` body into two,
   *   and `BEGIN ATOMIC` bodies exist on 18.4.
   */
  applyObjectEdit?(plan: ObjectEditPlan): Promise<ObjectEditOutcome>;

  /**
   * Get health and performance metrics
   */
  getHealth(): Promise<HealthInfo>;

  /**
   * Get comprehensive monitoring data
   * @param options - What to include in the monitoring data
   */
  getMonitoringData(options?: MonitoringOptions): Promise<MonitoringData>;

  /**
   * Get database overview metrics
   */
  getOverview(): Promise<DatabaseOverview>;

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): Promise<PerformanceMetrics>;

  /**
   * Get slow query statistics
   * @param options - Query options (limit)
   */
  getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]>;

  /**
   * Get active sessions with details
   * @param options - Query options (limit)
   */
  getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]>;

  /**
   * Get table statistics
   * @param options - Query options (schema filter)
   */
  getTableStats(options?: { schema?: string }): Promise<TableStats[]>;

  /**
   * Get index statistics
   * @param options - Query options (schema filter)
   */
  getIndexStats(options?: { schema?: string }): Promise<IndexStats[]>;

  /**
   * Get storage/tablespace statistics
   */
  getStorageStats(): Promise<StorageStats[]>;

  /**
   * Run maintenance operations
   * @param type - Type of maintenance operation
   * @param target - Optional target (table name or process ID)
   */
  runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult>;

  /**
   * Validate provider configuration
   * @throws DatabaseConfigError if configuration is invalid
   */
  validate(): void;

  /**
   * Get provider capabilities (query language, supported features, etc.)
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Get UI labels for this provider (entity names, action labels, etc.)
   */
  getLabels(): ProviderLabels;

  /**
   * Prepare a query for execution (apply limits, analyze query type, etc.)
   */
  prepareQuery(query: string, options?: QueryPrepareOptions): PreparedQuery;
}

// ============================================================================
// Provider Configuration Options
// ============================================================================

export interface ProviderOptions {
  /** Connection pool configuration */
  pool?: Partial<PoolConfig>;
  /** Query timeout in milliseconds */
  queryTimeout?: number;
  /** Enable SSL/TLS connection */
  ssl?: boolean | { rejectUnauthorized: boolean };
  /** Connection timezone */
  timezone?: string;
}

/**
 * Server-injected construction context for an execution-profile provider
 * (#328). Deliberately NOT a member of `ProviderOptions`: that object is
 * caller-supplied and flows all the way into `getOrCreateProvider`, so a
 * profile flag living there could be set — or cleared — by whoever builds the
 * options for a request. Only `acquireExecutionProfileProvider` passes this.
 */
export interface ProviderExecutionContext {
  /**
   * Open the connection under the database's own read-only enforcement.
   * Only providers whose read-only boundary is established at OPEN time read
   * this (SQLite); PostgreSQL establishes it per transaction inside
   * `queryReadOnly` instead, so its provider ignores the context.
   */
  readOnly?: boolean;
}

// ============================================================================
// Internal Types
// ============================================================================

export interface ConnectionState {
  connected: boolean;
  lastConnected?: Date;
  lastError?: Error;
  activeQueries: number;
}

// ============================================================================
// Monitoring Types (Extended)
// ============================================================================

/**
 * Database overview metrics
 */
export interface DatabaseOverview {
  version: string;
  uptime: string;
  startTime?: Date;
  /**
   * The count of connections currently open, or absent when the engine cannot
   * measure it at all.
   *
   * Optional for the same reason `databaseSizeBytes` below is: absence and zero are
   * different facts, and a provider that cannot read the figure must omit the key
   * rather than send a fabricated 0. ScyllaDB is the case that forced this - the
   * count lives in Cassandra's `system_views` keyspace, which ScyllaDB does not
   * have - and a Cassandra role denied that same grant has answered a fabricated 0
   * since the provider shipped (#476). `HealthInfo.activeConnections`
   * is optional for the identical reason and the absence travels THROUGH that seam:
   * a provider composing one from the other must carry the missing key across rather
   * than flatten it with `?? 0`, which is what the docblock on that field says and
   * what MSSQL, Oracle and MongoDB were corrected to do - all three initialised a
   * local to 0 and swallowed the read's failure into it, so a denied DMV, an
   * unprivileged `V$SESSION` and a whole failed `serverStatus` each reached the
   * agent's curated reading as a measured zero.
   */
  activeConnections?: number;
  /**
   * The published ceiling, where `0` MEANS "no limit published" rather than "no
   * capacity" - unlike `activeConnections` above, `0` and absence are the SAME fact
   * here, so this field stays a required number. See `OverviewTab.tsx`'s
   * `connectionLimit`.
   */
  maxConnections: number;
  databaseSize: string;
  /**
   * Total on-disk size in bytes, or absent when the engine publishes no byte figure
   * at all.
   *
   * Optional because absence and zero are different facts: a 0 is a measurement, and
   * the Storage tab formats whatever it is given. Apache Cassandra is the case - its
   * `system_views.disk_usage` reports whole mebibytes (measured: "1 MiB" for a
   * 19,476-byte table), so it omits this field rather than send a zero that renders
   * as "0 B" and a 0.0% breakdown (#424).
   */
  databaseSizeBytes?: number;
  tableCount: number;
  indexCount: number;
}

/**
 * Performance metrics for the database
 */
export interface PerformanceMetrics {
  /**
   * Cache hit ratio as percentage (0-100), or absent when the engine does not
   * measure one.
   *
   * Optional because "not measured" and "measured as zero" are different facts
   * and only one of them should raise an alarm. `DEFAULT_THRESHOLDS` treats this
   * metric as `direction: "below"` with `critical: 80`, so a provider that has no
   * ratio to report and substitutes a neutral-looking `0` makes every healthy
   * cluster show a red critical cache fault. Apache Druid is that case - its cache
   * statistics reach a metrics emitter and never a SQL-readable table - and the
   * monitoring tabs already read this field as optional, defaulting the THRESHOLD
   * to a healthy 100 when it is absent.
   */
  cacheHitRatio?: number;
  /** Transactions per second */
  transactionsPerSecond?: number;
  /** Queries per second */
  queriesPerSecond?: number;
  /** Buffer pool usage as percentage (0-100) */
  bufferPoolUsage?: number;
  /** Number of deadlocks */
  deadlocks?: number;
  /** Checkpoint write time */
  checkpointWriteTime?: string;
}

/**
 * Slow query with detailed statistics
 */
export interface SlowQueryStats {
  queryId?: string;
  query: string;
  calls: number;
  totalTime: number;
  avgTime: number;
  minTime?: number;
  maxTime?: number;
  rows: number;
  sharedBlksHit?: number;
  sharedBlksRead?: number;
}

/**
 * Active session with detailed information
 */
export interface ActiveSessionDetails {
  pid: number | string;
  user: string;
  database: string;
  applicationName?: string;
  clientAddr?: string;
  state: string;
  query: string;
  queryStart?: Date;
  duration: string;
  durationMs: number;
  waitEventType?: string;
  waitEvent?: string;
  blocked?: boolean;
}

/**
 * Table statistics
 */
export interface TableStats {
  schemaName: string;
  tableName: string;
  rowCount: number;
  liveRowCount?: number;
  deadRowCount?: number;
  /**
   * The table's own bytes, and its formatted spelling. BOTH are omitted when the engine
   * publishes no per-table size at all: SQLite's per-object page counts live in the
   * `dbstat` virtual table, which is a compile-time option the build behind the driver
   * decides - present on node:sqlite, absent on bun:sqlite through Bun 1.3.14 ("no such
   * table: dbstat", measured 2026-08-24 on SQLite 3.53.0) and present again from Bun
   * 1.4.0 / SQLite 3.53.2 (re-measured 2026-08-31 on Linux x86_64, where both drivers
   * return identical bytes). Those are Bun's Linux/Windows builds: on macOS `bun:sqlite`
   * dlopens Apple's `/usr/lib/libsqlite3.dylib` rather than Bun's own amalgamation
   * (oven-sh/bun#16717, open, reproduced upstream), so the SQLite behind it there is
   * Apple's and is not measured by any row here. So the omission is a property of the
   * build, not of the driver's name, and
   * the fields stay optional for every build that still has nothing to read. It used to be
   * required, and what filled it was `rowCount * 100` ("Assume 100 bytes average per
   * row"), which the Storage tab then summed into the Data figure it draws beside the
   * measured database size: a guess presented as a measurement. A `0` would be the
   * same lie in a different digit, so absence is the answer, and every consumer of the
   * aggregate gates on it - see `StorageTab`'s `tableSizeKnown`.
   */
  tableSize?: string;
  tableSizeBytes?: number;
  indexSize?: string;
  indexSizeBytes?: number;
  totalSize: string;
  totalSizeBytes: number;
  lastVacuum?: Date;
  lastAnalyze?: Date;
  bloatRatio?: number;
}

/**
 * Index statistics
 */
export interface IndexStats {
  schemaName: string;
  tableName: string;
  indexName: string;
  indexType?: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  indexSize: string;
  /**
   * Omitted when the engine publishes no size for this index. MySQL keeps per-index sizes in
   * `mysql.innodb_index_stats`, which a restricted user cannot read and which holds no row for a
   * MyISAM table, so a `0` there would be a fabricated measurement rather than a small index.
   */
  indexSizeBytes?: number;
  scans: number;
  usageRatio?: number;
}

/**
 * Storage statistics
 */
export interface StorageStats {
  name: string;
  location?: string;
  size: string;
  sizeBytes: number;
  usagePercent?: number;
  walSize?: string;
  walSizeBytes?: number;
}

/**
 * Comprehensive monitoring data combining all metrics
 */
export interface MonitoringData {
  timestamp: Date;
  /**
   * Every panel is optional, and ABSENCE is not ZERO here - the same distinction the
   * `activeConnections` comment above draws for a single field, applied to a whole panel.
   * `getMonitoringData` reads the seven panels independently, so one read failing costs
   * only its own panel: the field it would have filled is left absent and its own message
   * is recorded under `errors`. An absent panel means "this engine could not answer",
   * which is a different fact from an empty array or a zero - StarRocks 3.3 has no
   * `information_schema.PROCESSLIST`, so `activeSessions` is absent there while an idle
   * PostgreSQL answers `[]`. Rendering the first as the second would claim a measurement
   * the engine refused to make (the very error QueriesTab.tsx:68 documents for
   * `slowQueries`). A consumer therefore gates on the field being present, and shows the
   * `errors` entry in place of that panel.
   */
  overview?: DatabaseOverview;
  performance?: PerformanceMetrics;
  slowQueries?: SlowQueryStats[];
  activeSessions?: ActiveSessionDetails[];
  tables?: TableStats[];
  indexes?: IndexStats[];
  storage?: StorageStats[];
  /**
   * Per-panel failure messages, keyed by the panel whose read rejected. The value is the
   * ENGINE's own sentence (`Error.message`, not a generic stand-in), because it is the only
   * text that tells the user what the database actually refused. Absence of a panel plus its
   * entry here is how a partial read is reported; a panel that is absent with no entry here
   * was simply not requested (`includeTables` and friends).
   */
  errors?: Partial<
    Record<"overview" | "performance" | "slowQueries" | "activeSessions" | "tables" | "indexes" | "storage", string>
  >;
}

/**
 * Options for monitoring queries
 */
export interface MonitoringOptions {
  /** Include table statistics */
  includeTables?: boolean;
  /** Include index statistics */
  includeIndexes?: boolean;
  /** Include storage/tablespace info */
  includeStorage?: boolean;
  /** Limit for slow queries (default: 10) */
  slowQueryLimit?: number;
  /** Limit for active sessions (default: 50) */
  sessionLimit?: number;
  /** Schema filter (default: 'public' for PostgreSQL) */
  schemaFilter?: string;
}

// ============================================================================
// Object Model
// ============================================================================

/**
 * Behaviour the UI may derive from an object. CLOSED on purpose: a new engine adds
 * kinds, never roles. The UI switches on this and never on `ObjectKindSpec.id`, which
 * is what keeps `CLAUDE.md`'s "never branch on the type id" rule true one level up.
 */
export type ObjectRole =
  | "relation" // has rows, is selected from
  | "routine" // is called, has source
  | "group" // holds routines: an Oracle package
  | "attached" // belongs to another object: a trigger
  | "config"; // defined by text or JSON: a dictionary, a lookup, a pipeline

/**
 * One object kind, declared in full by the provider that has it.
 *
 * `id` is an OPEN string, and that is the design rather than a shortcut. DBeaver's
 * `DBSObjectType`, CloudBeaver's `nodeType`, Azure Data Studio's `nodeType` and
 * pgAdmin's `node_type` are all open for the same reason, and JDBC's closed model is
 * the counter-example: it cannot express a trigger, a sequence, a materialized view or
 * a package at all. A ClickHouse dictionary, a Druid lookup and an Oracle package
 * therefore reach the tree through a provider-local declaration and no core change.
 */
export interface ObjectKindSpec {
  readonly id: string;
  readonly role: ObjectRole;
  /** The engine's own word, singular. Rendered as-is. */
  readonly label: string;
  readonly labelPlural: string;
  /** Phase 2. Absent means this kind has no readable definition, so no Source tab. */
  readonly hasSource?: boolean;
  /** Phase 2. The Monaco language id the source renders in. */
  readonly sourceLanguage?: string;
  /**
   * Phase 3. Whether an object of THIS KIND can have its definition text edited and applied
   * back (#789, discussion #778).
   *
   * Absent and undeclared both read as FALSE, and the name states the scope, for the reason
   * `acceptsRowWrites` states it: the permissive default is wrong when only the provider knows.
   * It is NOT conjoined with anything. Read through `kindAcceptsSourceEdits()`.
   *
   * THIS FIELD IS NOT A CLIENT GATE AND NOTHING IN THE BROWSER READS IT. MEASURED end to end
   * through two product routes against a live MariaDB 12.3.2: `POST /api/db/provider-meta`
   * answered the MySQL six for a server whose connected provider serves `package` in full,
   * because that route builds a provider it never connects while `objectKindsFor(version)`
   * resolves from a version measured in `connect()`. A client predicate built on the client's
   * capability copy therefore answers for the wrong server. The per-object affordance travels
   * with the READ instead, on `ObjectSourcePart.edit`; this field is the conformance anchor and
   * the census population.
   */
  readonly acceptsSourceEdits?: boolean;
  /** Kinds nested under an object of this kind: a package holds procedures. */
  readonly childKinds?: readonly string[];
  /** This kind hangs off another object rather than off the container: a trigger. */
  readonly attachedTo?: string;
  /**
   * Whether a row write against an object of this kind is meaningful.
   *
   * Absent reads as false, so a kind that declares nothing never appears as an import
   * or inline-edit target. The permissive default is wrong here: writing rows into a
   * view is meaningless on most engines and only sometimes possible on PostgreSQL, and
   * only the provider knows which.
   *
   * The engine-wide `supportsInlineRowEdit` stays, and it is a SEPARATE fact rather than
   * the other half of a conjunction. It has one reader, `src/components/Studio.tsx:144`,
   * where it gates the results grid's inline row editor and nothing else. MongoDB,
   * Couchbase and Cassandra declare it false, and #789 declares a kind that accepts row
   * writes on each of those three, so requiring both would refuse an import all three
   * engines do support.
   * Read this field through `kindAcceptsRowWrites()` in `src/lib/db/object-kinds.ts`,
   * whose name states that scope; a caller that needs the editor gate as well reads
   * both.
   */
  readonly acceptsRowWrites?: boolean;
}

/** One container level. Zero, one or two of these; the engine says which. */
export interface ContainerLevelSpec {
  /** Structural role, used for ordering only. */
  readonly id: "catalog" | "schema";
  /** The engine's own word: Schema, Keyspace, Bucket, Scope, User, Database. */
  readonly label: string;
  readonly labelPlural: string;
}

export interface Container {
  readonly path: readonly string[];
  readonly name: string;
  /** Index into `containerLevels`. */
  readonly level: number;
  /**
   * Whether this container is the one the session is already in (#789).
   *
   * Absent means the engine does not publish the fact, which is most of them: on
   * PostgreSQL a `search_path` names several schemas and none of them owns the session.
   * Oracle is the case this exists for, and there it is not decoration: the connecting
   * user IS a container, every other owner in `ALL_USERS` is a peer of it, and without
   * this a user connecting as `SYSADM` gets an alphabetical list with no indication which
   * entry is their own.
   */
  readonly isSessionDefault?: boolean;
}

/**
 * One object. `path` ADDRESSES it and `name` LABELS it, and they are allowed to differ.
 *
 * `path` is never a joined string: the old flat model spelled a qualified name
 * `"sales.orders"`, and `query-generators.ts` split it back on `.`, so a table literally
 * named `a.b` in `public` generated `"a"."b"`. An array cannot be misread that way.
 */
export interface DatabaseObject {
  /**
   * The container path, then one segment per nesting level down to this object, each
   * segment being the identifier that is UNIQUE WITHIN ITS PARENT.
   *
   * Two consequences, and both are engines this repo serves rather than hypotheticals.
   * A kind that declares `attachedTo` nests under the object it is attached to, so a
   * PostgreSQL trigger is `[schema, table, trigger]`: a trigger name is unique per table
   * and not per schema, and `[schema, trigger]` gives two triggers on two tables one
   * address. A routine's segment carries the engine's own disambiguated form, so an
   * overloaded PostgreSQL function is `["app", "order_total(integer)"]`: PostgreSQL
   * identifies a routine by name AND ARGUMENT TYPES, and a bare `proname` gives two
   * overloads one address.
   *
   * That segment is the argument TYPES and never the parameter names. Overloads differ by
   * types and never by names, so a name adds nothing to identity while making the identity
   * change when somebody renames a parameter, and a segment carrying information
   * irrelevant to identity is wrong even where it round-trips through DDL. PostgreSQL's
   * `pg_get_function_identity_arguments()` is the obvious candidate and is the wrong one
   * for exactly that reason: measured on postgres:18 it answers
   * `order_total(order_id integer)`. See `src/lib/db/providers/sql/postgres.ts` for the
   * expression that is used instead.
   */
  readonly path: readonly string[];
  /**
   * The display label, which is NOT required to equal the last path segment.
   *
   * A tree renders this and addresses with `path`, so the disambiguation the path needs
   * never has to be read by a person: the overloaded function above shows as
   * `order_total` while its path stays unique. Where the two would be the same string,
   * they are, and every relation kind on every engine is in that case.
   */
  readonly name: string;
  readonly kind: string;
  /**
   * The engine's own word for a state a reader should act on, and PRESENT ONLY THEN (#789).
   *
   * Absence means ordinary, not unknown. Oracle publishes `VALID` for nearly every row in
   * a real schema and SQL Server calls almost every trigger `ENABLED`, so a provider that
   * set this field on every object put a badge beside every name that carried no
   * information, and a reader learns to skip a field that is always there. What survives
   * is `INVALID` on an Oracle object and `DISABLED` on a SQL Server trigger: the cases
   * somebody has something to do about.
   *
   * The decision belongs to the PROVIDER and cannot be moved to a reader. Only the
   * provider knows which of its engine's words is the ordinary one, and a renderer that
   * knew the strings `VALID` and `ENABLED` would be a branch on the database type moved up
   * a layer, which this codebase refuses inside `src/lib/db` for the same reason. So a new
   * provider sets this field where its engine reports something notable, in the engine's
   * own vocabulary rather than a normalised one, and leaves it unset otherwise.
   */
  readonly status?: string;
  /** Relations only, and only where the engine counts. */
  readonly rowCount?: number;
  readonly sizeBytes?: number;
}

/**
 * Four facts, not two.
 *
 * A kind that is not declared draws no folder at all: the engine has no such concept.
 * `{ count: 0 }` is the engine answering none. `{ unavailable }` is a read that was
 * refused, carrying the engine's own sentence. All three collapsed into an empty array
 * before this change, and `docs/providers/postgres.md` section 3.1.2 records what that
 * costs a reader on the monitoring side.
 *
 * The fourth is `{ count, sampledFrom }`: a number that is REAL but BOUNDED, because the
 * provider counted what a capped read saw rather than what the engine holds. It is a
 * FLOOR, so the tree badges it `1,204+` and never `1,204`. Two engines answer this way
 * and neither does so for all of its kinds, which is why the state is per KIND and not a
 * provider-wide flag: Redis counts its key groupings from a 1000-key `SCAN` while
 * `FUNCTION LIST` is complete, and LibreDB counts `table` and `collection` from a
 * persisted catalog while `keyspace` comes from the bounded key walk. MongoDB is NOT one
 * of them: its `countObjects` tallies a complete `listCollections` (#789).
 *
 * `sampledFrom` is the provider's own sentence for what bounded the read, phrased to
 * follow "counted from": `"one 1,000-key SCAN walk"`. It is the same discipline
 * `unavailable` carries, which is that the thing a person reads comes from whoever knows
 * the fact, not from the renderer.
 *
 * ADDITIVE ON PURPOSE. This type is published through `src/exports/types.ts`, so the two
 * existing spellings stay valid unchanged: a required field on `{ count }` would break
 * every external implementer of the provider surface. A consumer that has not heard of
 * the fourth state still reads `.count` off it and gets a number that is true, only
 * imprecise, rather than failing to narrow.
 */
export type KindCount =
  | { readonly count: number }
  | { readonly count: number; readonly sampledFrom: string }
  | { readonly unavailable: string };

export interface ObjectDetail {
  readonly path: readonly string[];
  readonly columns: readonly ColumnSchema[];
  readonly indexes: readonly IndexSchema[];
  readonly foreignKeys: readonly ForeignKeySchema[];
}

/**
 * What one bulk column read answered, and whether it was complete (#789).
 *
 * `details` is keyed by `ObjectDetail.path`, which is the only key this surface has: a
 * joined name is what `query-generators.ts` used to split back on `.`, and every
 * dot-splitting defect this epic fixed came from a name standing in for an address. A
 * caller matches these against the objects `listObjects` named, path against path.
 *
 * `truncated` carries the bound the provider actually applied and its own sentence for
 * why, the same two fields `POST /api/db/objects/inventory` answers with. It is present
 * whenever the read stopped short and absent whenever it did not, because a bounded read
 * handed over as a complete one is what makes its reader treat a missing table as an
 * absent one - the #414 defect, measured against the agent. `details.length` never
 * exceeds `truncated.limit`.
 *
 * `limit` is the bound where the bound IS an object count, which is every caller-bounded
 * read. Where the bound is not one - redis and libredb stop a key walk after a fixed
 * number of KEYS and derive their objects from what it saw - there is no object count to
 * report, and those two answer `details.length`, the number the read actually produced. So
 * read `limit` as an upper bound on `details.length` that a caller may not read back as a
 * cap somebody set: `reason` is the field that says WHICH bound bit, and it is the one to
 * show a person. Making the field optional was considered and refused: it is published
 * through `src/exports/types.ts`, every consumer compares against it, and an absent number
 * would buy accuracy on two engines by making the comparison conditional on all seventeen.
 *
 * `reason` is ONE SENTENCE for one event across every engine, and that is a rule rather
 * than a convention: build the caller's half with `callerBoundTruncationReason()` in
 * `src/lib/db/object-kinds.ts` and never spell it per provider. Eleven implementers wrote
 * three unrelated phrasings for the same bound before this was written down, so the same
 * event read three ways depending on which engine was open, and once the flat surface is
 * gone this sentence is the only thing explaining a short answer. A provider that applies
 * a SECOND bound of its own, a bounded key walk say, names that one in its own words and
 * joins the two: they are two different bounds, not two phrasings of one. The shared
 * conformance guard asks that a caller-bounded batch's reason CONTAIN the shared sentence,
 * never that it equal it.
 */
export interface ObjectDetailBatch {
  readonly details: readonly ObjectDetail[];
  /** Absent when every object of that kind in that container was described. */
  readonly truncated?: { readonly limit: number; readonly reason: string };
}

/**
 * What this text IS, so a reader is never shown a fragment that looks like a statement (#789).
 *
 * CLOSED: two arms, both with producers in the shipped fleet. `complete` runs as given;
 * `partial` is a body or a bare SELECT that does not. PostgreSQL's `pg_get_viewdef`, DuckDB's
 * `macro_definition` and Couchbase's `definition.text` are the measured `partial` producers.
 */
export type ObjectSourceForm = "complete" | "partial";

/**
 * Where this text came from, so a reader is never shown a reconstruction as an original (#789).
 *
 * CLOSED: three arms, each with at least one producer. `stored` is the author's own bytes
 * (SQL Server modules, SQLite's `sqlite_schema.sql`); `regenerated` is the engine rebuilding
 * from its catalog, which PostgreSQL documents as "a decompiled reconstruction, not the
 * original text of the command"; `rendered` is a structured definition this product prints as
 * JSON (a MongoDB view, a search pipeline or template).
 */
export type ObjectSourceOrigin = "stored" | "regenerated" | "rendered";

/**
 * One text belonging to one object, or the engine's own reason there is none (#789).
 *
 * A UNION and not one shape with an optional `text`, for the reason `KindCount` is a union: a
 * refusal and an empty answer are different facts, and a shape carrying `text?: string` makes
 * them the same value at every call site. The refused arm declares NO `text`, so a value
 * narrowed to it cannot reach an editor buffer. That composition is what DBeaver gets wrong:
 * measured in its source, an unreadable definition reaches a WRITABLE editor holding one
 * comment line.
 *
 * The union closes that path in ONE DIRECTION ONLY, and saying so here is what stops the next
 * implementer from trusting it for the other. MEASURED against tsc 6.0.3 with no cast
 * anywhere: a literal carrying `unavailable` BESIDE `text`, `language`, `form` and `origin`
 * COMPILES as an `ObjectSourcePart`, because TypeScript's excess-property check on a union
 * admits any property declared on ANY member of it. Such a part narrows to the refusal arm, so
 * a provider composing one (spreading a catalog row, or spreading a conditional
 * `{unavailable}` onto a bounded text) would put a refusal sentence over a definition the
 * engine really returned. `assertObjectSurface` refuses that part by name for our own
 * providers, and that is the ONLY refusal standing today. A HOST's answer is unguarded: the
 * embedded seam's runtime shape check, the one `isRenderableShape` in
 * `src/components/object-tree/use-tree-nodes.ts` is the precedent for, is later work in #789
 * Phase 2 and does not exist in this tree.
 *
 * `id` is provider-local. Core reads it as an identity WITHIN ONE DOCUMENT and for nothing
 * else: the part switcher's selection key, and the Source tab's remembered selection. Core
 * never compares it against a literal, never branches on it, and never carries it between two
 * documents.
 *
 * `text` is never empty and never whitespace only. TypeScript cannot express that, so it is a
 * runtime invariant, asserted in `assertObjectSurface` for our own providers and, for a host's
 * answer, by the same shape check that does not exist yet. Where an engine answers empty, the
 * provider emits a REFUSAL carrying the engine's own fact instead.
 */
export type ObjectSourcePart =
  | {
      readonly id: string;
      /** The engine's own word: "Package body", "Specification". Rendered as-is. */
      readonly label: string;
      readonly text: string;
      /** A Monaco language id the installed bundle registers. `plsql`, `tsql` and `cql` are not. */
      readonly language: string;
      readonly form: ObjectSourceForm;
      readonly origin: ObjectSourceOrigin;
      readonly truncated?: { readonly limit: number; readonly reason: string };
      /**
       * Whether THIS PART of THIS OBJECT can be submitted back, as the CONNECTED provider
       * answered it (#789 Phase 3).
       *
       * It lives on the document and not on the client's declaration for the reason
       * `language` does, and the reason is the same measurement: `provider-meta` never
       * connects, so the client's own copy of a declaration can be a different server's.
       *
       * PER PART and not per object, because the fleet has parts of one object with different
       * answers: MEASURED on MariaDB 12.3.2, a `package` SPEC replace destroys the BODY while
       * the BODY replaces cleanly, and MEASURED on Oracle 21.3 the two parts are independently
       * appliable.
       *
       * `offered: false` carries the PROVIDER'S OWN SENTENCE, unprefixed, the same grammar
       * `unavailable` and `truncated.reason` already use. Its day-one producer is the
       * PostgreSQL ownership pre-flight: MEASURED on 18.4, `CREATE OR REPLACE` on somebody
       * else's function is an OWNERSHIP check and not a privilege check, it answers
       * `must be owner of function order_total` with SQLSTATE 42501, and the shipped error
       * mapper turns that into HTTP 500 because the message matches none of its substrings. A
       * user who learns that before typing is the whole point of this field.
       *
       * ABSENT means this provider offers no edit for this part, and only a HOST or a provider
       * that declares no editable kind produces absence, because the route deletes the field
       * from any part whose kind fails `kindAcceptsSourceEdits` on the CONNECTED provider.
       */
      readonly edit?: ObjectPartEdit;
    }
  | {
      readonly id: string;
      readonly label: string;
      /** The engine's own sentence, unprefixed, never a rewrite of it. */
      readonly unavailable: string;
    };

/**
 * One object's definition, as its provider reads it (#789).
 *
 * `parts` is a NON-EMPTY tuple, which makes a zero-part document a compile error at every
 * provider: there is no shape in which the renderer is handed a document and has nothing to
 * draw. Two spellings satisfy it and no third is accepted: an array literal, and
 * `const parts: [ObjectSourcePart, ...ObjectSourcePart[]] = [first]` plus a conditional push.
 * `rows.map(...)` does not, and casting past it defeats the whole invariant.
 *
 * More than one part is not a special case for one engine: an Oracle package and a MariaDB
 * package are each ONE node over two texts, and core branches on `parts.length` and on nothing
 * else.
 */
export interface ObjectSourceDocument {
  readonly path: readonly string[];
  readonly kind: string;
  readonly parts: readonly [ObjectSourcePart, ...ObjectSourcePart[]];
}

export type ObjectPartEdit = { readonly offered: true } | { readonly offered: false; readonly reason: string };

/**
 * The MECHANISM an apply uses, and never its consequence (#789 Phase 3).
 *
 * A CLOSED union of six, one member per shipping mechanism measured in wave 1a, and the two
 * destructive members of that vocabulary are deliberately absent so that no plan can carry one:
 * `capture-and-restore` CAN lose the object because the restore can fail, and `drop-then-create`
 * loses it by construction. Ruling 1b's first clause is therefore a compile-time property of
 * this union rather than a review checklist, and a later phase that wanted one would have to add
 * a member, which is a deliberate act with a failing census attached.
 *
 * `replace-in-place-with-collateral-loss` is NOT a member, for a stronger reason than economy: a
 * plan whose `consequences` is non-empty IS that class, so there is no innocent-looking label a
 * provider could pair with a silent collateral.
 *
 * CLOSED rather than an open string, against this repository's own precedent for
 * `ObjectKindSpec.id`, and the cost is that a host whose engine has a seventh mechanism has
 * nothing to name. It is closed anyway because `src/lib/db/operations/execution.ts:21-26` states
 * the audit's rule, that "the audited action is the registry-RESOLVED descriptor id, never the
 * caller's raw operation string", and this value is what an apply's audit event carries in
 * `action`.
 *
 * NOTHING IN `src/lib/db` OR IN CORE MAY SWITCH ON IT. Three things read it: the preview
 * caption, the audit's `action`, and the census. A member with no producer is therefore not a
 * line of code and costs nothing under the 100 percent line gate.
 *
 * Day-one producers: `guarded-atomic-batch` on PostgreSQL 18.4, `replace-in-place-statement` on
 * Trino 476, `replace-in-place-command` on Redis 8.10.0. The other three are named with their
 * first producer in the provider docs and in the census.
 */
export type ObjectEditStrategy =
  | "guarded-atomic-batch"
  | "transactional-replace"
  | "replace-in-place-statement"
  | "replace-in-place-command"
  | "alter-in-place"
  | "temp-name-test-create";

/**
 * Where one piece of the executed text came from (#789 Phase 3).
 *
 * `start` and `end` are 0-based UTF-16 code-unit offsets into the USER'S PART TEXT, the
 * half-open range the string methods take.
 *
 * A MAP and not a scalar prefix length, and the requirement is measured three times: on
 * PostgreSQL 18.4 the same body error is `position 23` bare and `position 63` assembled, prefix
 * 40; Trino 476 splices ` OR REPLACE` INSIDE the first line, so the user's text is not a suffix
 * of anything; and a temp-name test create REPLACES a range, which on Oracle 21.3 shifted
 * `USER_ERRORS.POSITION` from 45 to 63 for the same error, a delta a prefix cannot express.
 */
export type ObjectEditSegment =
  | { readonly from: "provider"; readonly text: string }
  | { readonly from: "user"; readonly start: number; readonly end: number };

/**
 * ONE ROUND TRIP. A round trip may carry more than one statement, and that distinction is
 * load-bearing rather than pedantic: MEASURED on PostgreSQL 18.4, a guard block and a
 * `CREATE OR REPLACE` travelling in ONE parameterless `client.query()` run inside the engine's
 * implicit transaction, so a failure anywhere aborts everything and the function keeps the same
 * `oid` and the same `xmin`.
 *
 * The plan NEVER carries parameters, and binding one does not degrade the atomicity, it refuses
 * it: MEASURED, `42601 cannot insert multiple commands into a prepared statement`. An identifier
 * position takes no bind on any engine and a routine body is not a value, so nothing is lost.
 *
 * `text` is AUTHORITATIVE and is what executes, per ruling 1a. `segments` is the coordinate map
 * and never a second source of the bytes, and `renderSegments` in `src/lib/db/object-edit.ts`
 * pins them together.
 */
export interface ObjectEditStep {
  readonly text: string;
  /** A Monaco language id the installed bundle registers, so the preview highlights what runs. */
  readonly language: string;
  readonly segments: readonly [ObjectEditSegment, ...ObjectEditSegment[]];
}

/**
 * The exact artifact ONE apply sends (#789 Phase 3).
 *
 * TWO ARMS AND NOT A STRING, needed on day one rather than deferred: Redis 8.10.0 is in the
 * day-one set and its apply is `FUNCTION LOAD REPLACE <library code>`, a COMMAND and not a
 * statement, whose reply is the library name the server read out of the shebang. Rendering that
 * as pseudo-SQL would be a lie about what runs, and `medium` is what stops the preview pane
 * having to guess.
 */
export type ObjectEditUnit =
  | { readonly medium: "statement"; readonly steps: readonly [ObjectEditStep, ...ObjectEditStep[]] }
  | {
      readonly medium: "command";
      /** The command verb as the engine names it: "FUNCTION". */
      readonly name: string;
      /** The literal tokens before the payload: ["LOAD", "REPLACE"]. */
      readonly arguments: readonly string[];
      /** The one argument carrying the user's text. */
      readonly payload: ObjectEditStep;
    };

/**
 * A session setting this plan depends on, and what the apply does about it (#789 Phase 3,
 * ruling 2e).
 *
 * Every field is the engine's own spelling: `setting` is the name the engine uses and `value` is
 * the value that was read, or the value that will be set.
 *
 * TWO ARMS, and the axis is WHAT THE APPLY DOES, because the two have different safety
 * properties and the preview has to say which one a reader is looking at.
 *
 * `asserted` is READ AT BUILD AND COMPARED AT APPLY, and it never writes. Day-one producer:
 * PostgreSQL's `check_function_bodies`, a GUC any borrower of the pooled connection can turn
 * off, and with it off the engine accepts a body it would otherwise reject, which would be a
 * successful apply storing a definition that cannot run.
 *
 * `pinned` is SET FOR THE DURATION OF THE APPLY'S OWN ROUND TRIP and is gone when it ends. Day-one
 * producer: PostgreSQL's `search_path`, and it exists because MEASURED on 18.4 a `LANGUAGE sql`
 * body and a `BEGIN ATOMIC` body are name-resolved at CREATE time against the session path,
 * while a `LANGUAGE plpgsql` body is not, and MEASURED through the product a `SET` issued by one
 * Studio user's request is read back by every later request on the same `connection.id`,
 * including another user's. So the same edit would succeed or fail depending on who used the
 * connection last. A deterministic refusal the user can act on beats a non-deterministic success.
 *
 * A `pinned` arm may NEVER be implemented with a bare `SET`. The pin is issued inside the same
 * implicit transaction as the write, which is what makes it invisible to the next borrower, and
 * `tests/integration/db/postgres-provider.test.ts` proves that by reading the setting back on the
 * SAME cached provider after the apply. `pg_proc.proconfig` is NULL for a function that does not
 * declare its own `SET search_path`, so there is no catalog fact to restore and nothing to
 * restore it to: the pin is the answer, not a workaround for a missing restore.
 *
 * The limit, stated because a reader will otherwise over-read the `asserted` arm: comparing
 * equality catches a session that MOVED between the build and the apply. It does not catch one
 * that was already polluted when the build read it.
 */
export type ObjectEditSessionPin =
  | { readonly mode: "asserted"; readonly setting: string; readonly value: string }
  | { readonly mode: "pinned"; readonly setting: string; readonly value: string };

/**
 * How this apply detects that the object moved between the read and the write (H3, #789 Phase 3).
 *
 * THREE STATES, and the axis is WHAT THE APPLY WILL DO rather than whether a token exists,
 * because that is the thing the user acts on and because two engines with a token have different
 * safety properties. `guarded` closes the window: the comparison and the write are one atomic
 * unit and a mismatch aborts before anything is written. `compared` narrows it: the apply
 * re-reads and compares in its own round trip, and another session can still get in between.
 * `unavailable` is said OUT LOUD and is never collapsed into absence, because `revision?: string`
 * cannot express "this provider cannot produce one" in either of its spellings.
 *
 * `basis` is the engine expression the comparison is over, so a reader of a plan can see what was
 * hashed and two tokens from two engines can never be compared by accident. Core never compares
 * two tokens, never parses one, and never carries one between two plans.
 *
 * `scope` exists because DuckDB v1.5.5's candidate token is `view_oid`/`function_oid` plus the
 * text and is valid only inside one connection, since the oid is reassigned at catalog load.
 * `connection` has NO day-one producer, and a later phase may not trust it without an identity
 * for the PROVIDER INSTANCE, which `getOrCreateProvider` does not mint: it caches one instance
 * per `connection.id` and a reconnect replaces it silently.
 *
 * Recorded plainly, as H3 requires: a token NARROWS the window and does not close it, only a
 * transaction or a lock closes it, and of the day-one three only PostgreSQL has one across the
 * read and the write. The `conflict` outcome exists because even a closed window is not enough:
 * MEASURED on 18.4, `tuple concurrently updated` refuses a well-formed, UP-TO-DATE apply purely
 * on timing.
 */
export type ObjectEditRevision =
  | {
      readonly check: "guarded";
      readonly token: string;
      readonly basis: string;
      readonly scope: "server" | "connection";
    }
  | {
      readonly check: "compared";
      readonly token: string;
      readonly basis: string;
      readonly scope: "server" | "connection";
    }
  | { readonly check: "unavailable"; readonly reason: string };

/** A catalog surface and the value it answered, both as the engine spells them. */
export interface ObjectEditCatalogFact {
  readonly source: string;
  /** Never empty. The route refuses an empty one: a NULL comment means NO consequence, not an empty one. */
  readonly observed: string;
}

/**
 * What a SUCCESSFUL apply of this shape destroys (ruling 1b amended, #789 Phase 3).
 *
 * Eight members, one per measured path, and the engine and version for each is in the comment
 * beside it so a reader never has to take the class name on trust.
 */
export type ObjectEditConsequenceClass =
  /** Redis 8.10.0: the unit is the LIBRARY, and a body registering fewer functions deletes the others and reports success. */
  | "replaces-whole-container"
  /** MariaDB 12.3.2: CREATE OR REPLACE PACKAGE on the SPEC destroys the BODY, on byte-identical spec text. */
  | "destroys-sibling-part"
  /** DuckDB v1.5.5: CREATE OR REPLACE MACRO replaces the NAME and deletes every other overload. */
  | "destroys-overloads"
  /** SQL Server 16.0.4265.3: an indexed view loses its clustered index on a byte-identical body. */
  | "destroys-index"
  /** DuckDB v1.5.5: a byte-identical view replace discards the view's COMMENT. */
  | "destroys-comment"
  /** PostgreSQL 18.4 and Trino 476: an ARGUMENT TYPE change creates a second object and every call site fails 42725. */
  | "forks-object"
  /** MySQL 26.7.0 and MariaDB 12.3.2: a stripped DEFINER moves the object to the pooled Studio credential, silently. */
  | "transfers-security-principal"
  /** SQL Server: an ANSI_NULLS OFF module applies cleanly and `equal` becomes `not-equal`, with no error. */
  | "changes-module-semantics";

/**
 * NO SENTENCE FIELD, on purpose, and this inverts the repository's usual grammar deliberately.
 *
 * Where a refusal carries the ENGINE'S own words (`KindCount.unavailable`,
 * `ObjectSourcePart.unavailable`), an engine produced the sentence. Here no engine produces one:
 * the warning is OUR inference from a catalog VALUE, and letting a provider write prose is
 * letting a provider write an inference in a measurement's voice. That exact defect is shipped in
 * this tree, in a security docblock, beside a real measurement about a different thing, and it is
 * MEASURED FALSE. So core renders the sentence, from the class and the fact, in
 * `describeConsequence()`.
 */
export interface ObjectEditConsequence {
  readonly loses: ObjectEditConsequenceClass;
  readonly fact: ObjectEditCatalogFact;
}

/**
 * What a preview IS, as a value: the exact artifact an apply will send, issued by the provider
 * that will send it (ruling 1a, #789 Phase 3).
 *
 * The preview is not a copy of this plan, it is a FIELD of it: the dialog renders `unit` and the
 * apply sends `unit`, so byte-identity between what the reader approved and what executed is
 * structural rather than asserted. Nothing here is re-derived at apply time, and that is not a
 * preference: MEASURED, a rebuild depends on the server version, on the object's current
 * definition and on session state another borrower of the same pooled connection can change
 * between the two calls, all of which move with no attacker and no bug.
 *
 * The plan is READABLE and UNFORGEABLE, which are different properties. "Opaque" in ruling 1a is
 * read as "the client may not MINT or ALTER a plan" rather than "the client may not READ one".
 * The integrity envelope is the ROUTE's (`planToken`) and not a field here, because an embedded
 * host returns this same type and has no key.
 *
 * `planVersion` is bumped whenever the digest walk changes, so a plan minted by one process and
 * applied against another inside the TTL is REFUSED rather than mis-verified.
 */
export interface ObjectEditPlan {
  readonly planVersion: 1;
  /** Server-minted, opaque, and the audit's correlationId. Identifies one edit and never a session or a user. */
  readonly planId: string;
  readonly issuedAt: string;
  /**
   * A digest of the SERVER this plan was built against, not of the connection's id.
   *
   * MEASURED, `src/lib/seed/resolve-connection.ts:21-23` returns an inline connection object
   * verbatim, `id` included, and the browser drove it: a made-up id with different credentials
   * connected as them. So `connection.id` is a string the caller typed on the majority path, and
   * binding to it would be vacuous for exactly the case the binding exists for. The fingerprint
   * is a hash over a length-framed walk of the RESOLVED connection's `type`, `host`, `port`,
   * `database` and `user`, which are the fields that decide which server and which principal.
   * Stated as a limit rather than left to be discovered: it does not catch a different server
   * that answers on the same host and port.
   */
  readonly connectionFingerprint: string;
  readonly type: DatabaseType;
  readonly path: readonly string[];
  readonly kind: string;
  /**
   * WHICH part. Required by the ENGINE and not by tidiness: MEASURED on Oracle 21.3 a package's
   * two parts are independently appliable and MEASURED on MariaDB 12.3.2 they are not, and both
   * facts are unstateable by a method that does not know which text it was handed.
   */
  readonly partId: string;
  readonly strategy: ObjectEditStrategy;
  readonly unit: ObjectEditUnit;
  readonly session: readonly ObjectEditSessionPin[];
  readonly revision: ObjectEditRevision;
  readonly consequences: readonly ObjectEditConsequence[];
}

/**
 * The definition the BUILD read, for the preview's LEFT side (#789 Phase 3).
 *
 * It is NOT a field of the plan and that placement is arithmetic rather than taste. The apply
 * request carries the plan, and MEASURED, Next 16.3.4 clones every request body for middleware at
 * exactly 10,485,760 bytes and TRUNCATES above it. One maximal part is 1,000,000 UTF-16 code
 * units, up to 4 MB as UTF-8 and up to 6 MB once JSON-escaped, so a plan carrying the unit AND the
 * pre-image would be about 12 MB inbound and would be silently cut. The build RESPONSE is outbound
 * and subject to no such clone, so the pre-image rides beside the plan in the response and never
 * inside it.
 *
 * Why it exists at all: the dialog's left side must be the definition the BUILD read and never the
 * text the tab has been showing. A left side taken from the tab hides a change somebody else made
 * while the tab sat open, which is the whole shape of the failure this phase exists to prevent.
 */
export interface ObjectEditPreimage {
  readonly text: string;
  readonly language: string;
  readonly truncated?: { readonly limit: number; readonly reason: string };
}

/** Why a build would not issue a plan. */
export type ObjectEditRefusalClass =
  /** The submitted text does not name the object the plan is addressed to. Day-one producer: all three engines. */
  | "identity"
  /** The caller may not write this object. Day-one producer: PostgreSQL ownership, MEASURED `must be owner of function order_total`, 42501. */
  | "privilege"
  /** The text is wrong, or would fork. Day-one producers: PostgreSQL 42601 and 42P13, Trino argument-type fork. */
  | "definition"
  /** A precondition this design placed failed: the revision moved inside the guard, or a session pin did not hold. */
  | "guard"
  /** The engine or the connector will not do this at all. MEASURED on Trino 476: NOT_SUPPORTED, errorCode 13, on `memory`. */
  | "unsupported";

/**
 * Where a refusal points, in the coordinates of the text the USER submitted (#789 Phase 3).
 *
 * THREE ARMS AND NOT AN OPTIONAL PAIR, and the third is the one that matters. MEASURED with a
 * control in a real browser: an UNCORRECTED coordinate handed to `setModelMarkers` did not throw,
 * did not warn and did not look wrong, because Monaco silently CLAMPED it to the end of the model,
 * and the marker sat at line 10 column 1 while the real error was at line 7 column 3. Nothing in
 * the platform catches that. So a coordinate the provider cannot place inside the user's own text
 * is `outside`, which the dialog renders as a sentence, and never a number the client will clamp.
 *
 * 1-based on both axes, which is what `IMarkerData.startLineNumber` and `startColumn` take. TWO
 * conversions sit between the engine and this value and BOTH are the provider's:
 * `model.getPositionAt()` is 0-based and PostgreSQL's `position` is a 1-based CHARACTER offset
 * that arrives as a STRING although `QueryError.position` is typed `number`.
 */
export type ObjectEditPosition =
  | { readonly within: "user"; readonly line: number; readonly column: number }
  | { readonly within: "outside" }
  | { readonly within: "none" };

export interface ObjectEditRefusal {
  readonly refusal: ObjectEditRefusalClass;
  /** The engine's own sentence where an engine spoke, unprefixed. The provider's where the provider refused. */
  readonly sentence: string;
  /** The engine's own identifier AS DATA: SQLSTATE "42P13", a Trino errorName, a MySQL errno. Absent where the engine publishes none. */
  readonly code?: string;
  /** The engine's own hint, kept because the shipped mapper destroys it: PostgreSQL's "Use DROP FUNCTION app.f_demo(integer) first." */
  readonly hint?: string;
  readonly at: ObjectEditPosition;
}

/**
 * What a build answered (#789 Phase 3).
 *
 * `refuse` is a first-class member of the strategy vocabulary and not the absence of one, so it is
 * an ARM and not a throw. The union narrows on a LITERAL discriminant rather than on property
 * presence, so a hybrid carrying both narrows to the arm it declares rather than to whichever
 * property a predicate tested first, and the route refuses the hybrid outright.
 */
export type ObjectEditBuild =
  | { readonly built: true; readonly plan: ObjectEditPlan; readonly preimage: ObjectEditPreimage }
  | { readonly built: false; readonly refusal: ObjectEditRefusal };

/** The server's text for that part as the conflict check read it, for the diff H3 requires. */
export interface ObjectEditCurrentText {
  readonly text: string;
  readonly language: string;
  readonly truncated?: { readonly limit: number; readonly reason: string };
}

/**
 * What an apply DID, as the engine answered it (#789 Phase 3).
 *
 * Seven arms and none of them is a boolean, because a boolean records the wrong fact three
 * different ways: a log saying `success` for an apply that also destroyed something the reader was
 * not shown is false; `tuple concurrently updated` refuses a well-formed, up-to-date apply purely
 * on timing; and an apply whose answer never arrived has no truth value at all.
 *
 * A PROVIDER DOES NOT THROW FOR A VERDICT ITS ENGINE REACHED. It RETURNS one of these, which is
 * what makes "a deliberate engine refusal is never a 500" a property of this type rather than of a
 * mapping table. MEASURED against the mapper this repository already has: `42501` becomes HTTP 401
 * "Authentication failed: permission denied for schema app" for a credential that is connected and
 * correct, `42P13` becomes HTTP 500, and SQLSTATE, `hint`, `severity`, `detail` and `where` are all
 * destroyed. Exceptions stay for what they are for, a programming error or an unexpected driver
 * fault.
 */
export type ObjectEditOutcome =
  /** The engine replaced the addressed object and destroyed nothing else. */
  | { readonly outcome: "applied"; readonly revision: ObjectEditRevision; readonly duration: number }
  /**
   * The engine replaced the addressed object AND destroyed something else, and the plan warned
   * about it and the caller acknowledged it.
   *
   * `lost` is a catalog fact READ AFTER the apply, never a restatement of the warning: the plan
   * said what WOULD be lost, this says what WAS. NON-EMPTY TUPLE, so an outcome that claims a
   * collateral and names none is a compile error at every provider.
   *
   * Day-one producer: Redis 8.10.0, where the provider reads `FUNCTION LIST LIBRARYNAME <n>`
   * before the load and after it and the difference is the set of functions that disappeared.
   * MEASURED: a body carrying only the edited function DELETED the sibling function and reported
   * success. No Lua parser is involved anywhere.
   */
  | {
      readonly outcome: "applied-with-collateral";
      readonly lost: readonly [ObjectEditConsequence, ...ObjectEditConsequence[]];
      readonly revision: ObjectEditRevision;
      readonly duration: number;
    }
  /**
   * The engine accepted the text and the ADDRESSED object is not what changed.
   *
   * MEASURED on Redis 8.10.0: a CONSISTENT rename of a library and its functions succeeds, the
   * reply is the NEW library name, and the original library is still there and still answering.
   * MEASURED on PostgreSQL 18.4: `CREATE OR REPLACE FUNCTION` with a changed argument type
   * produces a SECOND `pg_proc` row and leaves the original untouched, and every call site then
   * fails `42725 is not unique`. Without this arm the reader sees a success, the pane re-reads the
   * ORIGINAL address and shows the ORIGINAL text, their edit has vanished from the screen, and the
   * audit carries one row saying the addressed object was edited.
   *
   * `undone` says whether the engine let this design take it back. PostgreSQL's post-condition
   * raises inside the same implicit transaction, so the fork is rolled back and `undone` is true.
   * Trino has no transaction, so `undone` is false and the second object is there.
   */
  | {
      readonly outcome: "applied-elsewhere";
      readonly undone: boolean;
      /** The engine's own name for what it did write, where the engine says: Redis's reply is the library name it read from the shebang. */
      readonly wrote?: string;
      readonly duration: number;
    }
  /**
   * The object moved between the read and the write. NOTHING was executed.
   * `current` is REQUIRED: a detector that cannot show what it found asks the reader for trust,
   * and H3 asks for a diff.
   */
  | {
      readonly outcome: "conflict";
      readonly conflict: "object-changed";
      readonly current: ObjectEditCurrentText;
      readonly duration: number;
    }
  /**
   * The engine refused a well-formed, UP-TO-DATE apply on CONCURRENCY, not on content. Nothing
   * changed and the SAME plan may be sent again.
   *
   * A separate arm from `object-changed` because the reader's next action differs: this one is
   * "do it again" and that one is "look at the diff". MEASURED through the product: two
   * overlapping applies of one object answered `tuple concurrently updated`, HTTP 500
   * `DATABASE_ERROR`, after blocking for 2.8 seconds.
   */
  | {
      readonly outcome: "conflict";
      readonly conflict: "engine-refused-concurrent";
      readonly sentence: string;
      readonly code?: string;
      readonly duration: number;
    }
  /** The engine refused the write. Nothing changed. */
  | { readonly outcome: "refused"; readonly refusal: ObjectEditRefusal; readonly duration: number }
  /**
   * The statement was SENT and the engine's answer never arrived: a timeout, a cancellation, a
   * dropped socket, or any throw out of `applyObjectEdit`.
   *
   * `committed: "unknown"` is the day-one answer on all three engines, because no day-one strategy
   * wraps its own transaction. `"rolled-back"` may be claimed ONLY by a provider that opened and
   * closed the transaction itself, which is `transactional-replace`.
   *
   * There is NO `retryable` field on this type and no retry advice in it. MEASURED: a PostgreSQL
   * DDL timeout answers HTTP 499 `QUERY_CANCELLED` "Query was cancelled", and Trino mints a
   * `TimeoutError` directly (`trino/index.ts:680`) which the generic mapper answers 408
   * `retryable: true`. A client that retries an apply whose disposition is unknown applies twice.
   */
  | {
      readonly outcome: "interrupted";
      readonly committed: "unknown" | "rolled-back";
      readonly sentence: string;
      readonly duration: number;
    };

export interface ObjectEditRequest {
  readonly path: readonly string[];
  readonly kind: string;
  readonly partId: string;
  /** The reader's edited text for THAT part. Never assembled, never split, never escaped. */
  readonly text: string;
}
