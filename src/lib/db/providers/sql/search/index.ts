/**
 * Elasticsearch / OpenSearch Database Provider (issue #424, Phase 1)
 *
 * SQL over a search cluster's HTTP surface with no runtime dependency: every
 * statement, every schema read and every metric goes through the
 * `SearchTransport` seam, so this file names no endpoint, no envelope key, no
 * product fault name and no status code, and `seam-guard.test.ts` fails the build
 * if it starts to. The wire lives in `http-transport.ts`; the mapping-driven schema
 * lives in `introspect.ts`.
 *
 * ONE implementation serves TWO type-ids. Everything the two products disagree
 * about on the wire is a row in the transport's dialect table; everything they
 * disagree about HERE is a field of {@link SearchProduct}, and there is exactly one
 * such field (see `prepareQuery`). The two exported classes are therefore thin by
 * construction - a subclass that only names its product - which is the shape that
 * makes "a third fork is one more constant" true rather than aspirational.
 *
 * It extends `SQLBaseProvider` because the query language really is SQL on both
 * products (measured: `POST` the statement, get columns and positional rows back,
 * on a basic licence and on a stock OpenSearch node alike) and because the shared
 * limiter's `LIMIT n` is correct on both. ES|QL is deliberately unused: OpenSearch
 * has none at all, and a surface only one product has cannot be the shared query
 * language.
 *
 * Everything asserted below was measured on 2026-08-19 against Elasticsearch 9.1.4
 * (basic licence, security disabled) and OpenSearch 3.8.0 (security disabled), on
 * stock single nodes with one index of one document. The measurements that shaped
 * the code, in the order they cost the most design:
 *
 * 1. **`OFFSET` exists on one product only.** `SELECT customer FROM probe_orders
 *    LIMIT 2 OFFSET 1` is HTTP 200 on OpenSearch and HTTP 400 on Elasticsearch
 *    (`parsing_exception`, "line 1:43: mismatched input 'OFFSET' expecting <EOF>"),
 *    with or without an `ORDER BY` in front of it. The inherited limiter emits
 *    exactly that clause for any page after the first, so on Elasticsearch the
 *    editor's "load more" would turn a working statement into a syntax error.
 *    `prepareQuery` refuses to produce it - see the method for why it refuses
 *    LOUDLY rather than by leaving the statement alone.
 * 2. **Neither product's SQL writes.** `CREATE TABLE t (id BIGINT)` and
 *    `UPDATE probe_orders SET customer = 'x' WHERE id = 1` are both HTTP 400 on
 *    both: Elasticsearch answers `parsing_exception` ("mismatched input 'CREATE'
 *    expecting {'(', 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW',
 *    'SYS', 'WITH'}" - the grammar lists everything it accepts, and no mutation is
 *    among them) and OpenSearch answers `SQLFeatureNotSupportedException` ("Query
 *    must start with SELECT, DELETE, SHOW or DESCRIBE: ..."). So
 *    `supportsCreateTable` and `supportsInlineRowEdit` are false as a fact about
 *    the grammars, not as an unimplemented feature. Documents change through the
 *    document APIs, which this provider does not expose.
 * 3. **An index has no schema above it, and both products say so in SQL.**
 *    Elasticsearch's `SHOW TABLES` answers a `catalog` of `docker-cluster` (the
 *    cluster name) and OpenSearch's answers `TABLE_CAT` `docker-cluster` with
 *    `TABLE_SCHEM` **null**. The catalog is not addressable either - measured,
 *    `SELECT customer FROM "docker-cluster".probe_orders` is a
 *    `parsing_exception` - so the monitoring rows carry NO schema name rather than
 *    a namespace this provider made up. See {@link SEARCH_SCHEMA_NAME}.
 * 4. **Nothing on this surface returns a plan.** `supportsExplain` is false and no
 *    `explainFormat` is declared, so the UI hides the Explain button and tab and
 *    `src/lib/explain/` is untouched. (Elasticsearch does answer `EXPLAIN <select>`
 *    with its internal plan text, but OpenSearch's SQL plugin does not, and a tab
 *    that works on one of two products behind one code path is worse than no tab.)
 * 5. **The wire carries no timing and no cancellation.** Neither answer contains a
 *    duration, so `executionTime` is this process's measurement of the exchange -
 *    the only number in existence. And the seam's own header records that an abort
 *    closes the client's socket while the cluster keeps working, so the deadline
 *    below is a CLIENT deadline and nothing else; `cancelQuery` is deliberately not
 *    implemented, because a method named "cancel" that cancels nothing server-side
 *    is a promise this provider cannot keep.
 *
 * Positional parameters are refused rather than emulated. Both endpoints really do
 * bind them - measured, `{"query":"... WHERE id = ?","params":[1]}` on
 * Elasticsearch and `{"query":"... WHERE id = ?","parameters":[{"type":"integer",
 * "value":"1"}]}` on OpenSearch both answer HTTP 200 - but they spell the request
 * differently, the seam carries the statement alone, and inlining the values here
 * to work around that would be building a SQL-injection site inside a provider.
 * Refusing is the same call `clickhouse/index.ts` makes for the same reason (#264).
 */

import { SQLBaseProvider } from "../sql-base";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import {
  type ActiveSessionDetails,
  type DatabaseConnection,
  type DatabaseOverview,
  type HealthInfo,
  type IndexStats,
  type MaintenanceResult,
  type MaintenanceType,
  type PerformanceMetrics,
  type PreparedQuery,
  type ProviderCapabilities,
  type ProviderLabels,
  type ProviderOptions,
  type QueryPrepareOptions,
  type QueryResult,
  type SlowQueryStats,
  type StorageStats,
  type TableSchema,
  type TableStats,
} from "@/lib/db/types";
import { formatCacheHitRatio } from "@/lib/monitoring-cache-ratio";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import { SearchHttpTransport } from "./http-transport";
import { getSchema as readSchema, isSystemIndex } from "./introspect";
import {
  type SearchClusterHealth,
  type SearchDialectId,
  type SearchIndexInfo,
  type SearchQueryResult,
  type SearchTransport,
  SearchTransportError,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * The cheapest statement either product will answer, sent at connect time so a
 * wrong port, a proxy in front of the cluster, a node whose SQL surface is absent
 * and a rejected credential all surface while the user is still looking at the
 * connection form rather than at their first query.
 *
 * Measured on both: HTTP 200, one column named `1` of type `integer`. It needs no
 * index, so it also succeeds on a cluster that holds nothing yet - which a
 * `SELECT` against a real index would not.
 *
 * It proves the PRODUCT as well as the port, and that is not a side effect: the
 * SQL endpoint path is product-specific, and the wrong one is refused before it
 * reaches any SQL engine (measured - the transport reports that as `unreachable`
 * and quotes the cluster's own wording). So a connected transport is evidence that
 * this connection's type-id names the product actually listening.
 */
const CONNECT_PROBE_SQL = "SELECT 1";

/**
 * The port the connection form prefills, and the same floor the transport applies
 * when a connection names none.
 *
 * Both products ship on 9200 out of the box, TLS included - a secured deployment
 * serves HTTPS on that same port rather than on a second well-known one - so there
 * is one number here rather than a plain/TLS pair. The literal is repeated rather
 * than imported because the transport's copy is wire configuration and this one is
 * a UI default; `druid/index.ts` and `clickhouse/index.ts` do the same.
 */
const SEARCH_DEFAULT_PORT = 9200;

/**
 * What the monitoring rows report as an index's schema: nothing.
 *
 * Both products' own SQL surfaces say an index has no namespace above it -
 * OpenSearch answers `TABLE_SCHEM` null and Elasticsearch reports only a `catalog`,
 * which is the cluster name and is not addressable in a statement (both measured;
 * see the file header, point 3). The empty string is therefore the engines' own
 * answer rather than a placeholder, and it renders as no prefix at all in the
 * monitoring tabs, which is exactly right for a surface with no schemas in it.
 *
 * It doubles as the only value the schema FILTER can match: a caller that asks for
 * `public` is asking for a namespace no index can be in, and the honest answer to
 * that is no rows rather than every row.
 */
const SEARCH_SCHEMA_NAME = "";

/**
 * What a value the cluster does not publish is called on screen.
 *
 * "N/A" is the spelling `sqlite.ts`, `oracle.ts`, `mssql.ts` and `druid` already use
 * for a reading they cannot take, so this is the repo's existing word rather than a
 * new one. Used for the two `DatabaseOverview` strings a search cluster has no
 * source for; every numeric field says so with a documented zero instead, because
 * the shape has nowhere else to put "unknown".
 */
const SEARCH_UNKNOWN_TEXT = "N/A";

/**
 * The one statement that can change what the schema tree shows.
 *
 * `DELETE` is in OpenSearch's SQL grammar and off by default - measured,
 * `DELETE FROM probe_orders WHERE id = 99` is refused with
 * `SQLFeatureNotSupportedException` on a stock node - and a cluster that switches
 * it on really does change the document counts this provider reports per index.
 * Elasticsearch's grammar has no DELETE at all, so on that product this pattern
 * never fires, exactly as Druid's `INSERT|REPLACE` never fires against its native
 * engine. Nothing else applies: mappings and indices are created and dropped
 * through the document and index APIs, and no statement this surface accepts can
 * reach them.
 */
const SEARCH_SCHEMA_REFRESH_PATTERN = "\\b(DELETE)\\b";

// ============================================================================
// The product table: everything the two products disagree about above the wire
// ============================================================================

/**
 * One product, as the PROVIDER sees it.
 *
 * Deliberately not `SearchDialectId` alone. `transport.ts` is explicit that the
 * type-id may pick a word and never a behaviour, and `CLAUDE.md` forbids
 * `=== 'mongodb'`-style branching outside a provider class for the same reason, so
 * the one behavioural difference above the wire is DECLARED here, per product, and
 * read as a trait. A method that asked `this.dialect === ...` would be the thing
 * both rules exist to prevent; a method that reads `this.product.acceptsOffsetClause`
 * states which capability it depends on, and a third product declares its own answer
 * instead of being added to a condition someone has to find.
 */
interface SearchProduct {
  /** Which transport dialect to construct, and the seam's own type-id. */
  readonly dialect: SearchDialectId;
  /**
   * How the product spells its own name in a message a user reads.
   *
   * The transport labels its own failures already; this is for the sentences this
   * file adds around them (a connect failure, a refused paging request), so the
   * two never disagree about what the cluster is called.
   */
  readonly label: string;
  /**
   * Whether `OFFSET n` is in this product's SQL grammar.
   *
   * Measured: OpenSearch 3.8.0 answers `LIMIT 2 OFFSET 1` with HTTP 200 (and with
   * the rows the offset asks for), Elasticsearch 9.1.4 answers HTTP 400
   * `parsing_exception`, "mismatched input 'OFFSET' expecting <EOF>".
   * `prepareQuery` is the only reader.
   */
  readonly acceptsOffsetClause: boolean;

  /**
   * How the product quotes an identifier - the second behavioural difference above
   * the wire, and the one that fails SILENTLY.
   *
   * Measured 2026-08-19 on OpenSearch 3.8.0: `WHERE "customer" = 'acme'` answers
   * HTTP 200 with `total: 0` because a double-quoted name there is a STRING
   * LITERAL, while the backtick form returns the row. Elasticsearch 9.1.4 accepts
   * the double-quoted form. So a generated query that guesses wrong does not raise
   * anything - it reports "no rows" for data that exists, which is worse than an
   * error because nothing tells the reader to distrust it.
   *
   * This crosses into `ProviderCapabilities.identifierQuoting` because
   * `query-generators.ts` derives the dialect from the DEFAULT PORT, and both
   * products ship on 9200 - the first time in this codebase that one port has had
   * to answer for two dialects.
   */
  readonly identifierQuoting: "double" | "backtick";

  /**
   * The product's SQL surface, named for a MODEL rather than for the UI.
   *
   * Read by `ProviderLabels.statementLanguage`, which the agent's plan contract
   * states verbatim. It exists because the engine's NAME is itself misleading:
   * asked for one runnable statement against a connection stamped
   * `elasticsearch`, a live plan run on 2026-08-19 answered with a native
   * aggregation body - `{"size":0,"aggs":{...},"query":{"term":{...}}}` - which is
   * correct Elasticsearch and unrunnable here, because this provider speaks to the
   * SQL endpoint alone. The statement guard then declined to classify it
   * (`NO_STATEMENT`), so nothing ran; what the user was handed was still a plan
   * they could not execute.
   *
   * Both spellings name the endpoint and rule out the alternatives by name, since
   * "SQL" alone did not survive contact with the model's prior about this engine.
   */
  readonly statementLanguage: string;
}

const ELASTICSEARCH_PRODUCT: SearchProduct = Object.freeze({
  dialect: "elasticsearch",
  label: "Elasticsearch",
  acceptsOffsetClause: false,
  identifierQuoting: "double",
  statementLanguage:
    "Elasticsearch SQL, the product's own SQL endpoint - NOT the JSON query DSL, NOT an aggregation body, and NOT ES|QL",
});

const OPENSEARCH_PRODUCT: SearchProduct = Object.freeze({
  dialect: "opensearch",
  label: "OpenSearch",
  acceptsOffsetClause: true,
  identifierQuoting: "backtick",
  statementLanguage:
    "OpenSearch SQL, the SQL plugin's own dialect - NOT the JSON query DSL, NOT an aggregation body, and NOT PPL",
});

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * The neutral seam result as the grid's row contract.
 *
 * Three things this does NOT do, each deliberate:
 *
 * - No mutation count. The seam carries none, because neither product's SQL
 *   endpoint has a statement that mutates (header point 2), so a second number
 *   here could only ever be zero - which reads as "nothing changed" rather than
 *   "this cannot happen".
 * - No server-reported duration to prefer over the measured one. Neither answer
 *   carries any timing at all, so the caller's measurement of the exchange is the
 *   only number in existence.
 * - No use of `totalHits`. OpenSearch reports the matching-document count beside
 *   every answer and Elasticsearch reports none, so a "showing 50 of 4,812" notice
 *   would appear on one product and never on the other for identical statements -
 *   and it would restate what the route's own pagination already tells the UI
 *   (`hasMore`, `limit`, `offset`). A caveat attached to every ordinary query is
 *   the fastest way to train a user to ignore the ones that matter, which is the
 *   argument `druid/index.ts` makes about its own warnings. The count is therefore
 *   dropped here, knowingly; `docs/BACKLOG.md` is where it belongs if a surface for
 *   it ever exists.
 *
 * The declared column order is used verbatim, and it is already unique: the
 * transport upholds the seam's uniqueness invariant, so a duplicated output name
 * reaches the grid as `c` and `c (2)` rather than overwriting.
 */
function toQueryResult(result: SearchQueryResult, executionTime: number): QueryResult {
  const columnTypes = result.columnTypes ?? {};

  return {
    rows: result.rows,
    // An answer the source could not describe has no columns rather than columns
    // guessed from the first row - the seam's own argument, and it survives here.
    fields: result.fieldNames ?? [],
    rowCount: result.rows.length,
    executionTime,
    // The engine's MAPPING types (`keyword`, `double`, `datetime`), which is what
    // both endpoints declare (measured) and what the schema tree shows for the same
    // field, so the grid and the sidebar speak one vocabulary. An empty map means
    // the answer declared no types, and stays absent rather than shipping a `{}`.
    ...(Object.keys(columnTypes).length > 0 ? { columnTypes } : {}),
  };
}

/**
 * One index as a monitoring row.
 *
 * Documents are the rows and the primary store is all the bytes an index has: the
 * inverted indexes live inside the shard's segments, so the "table" size and the
 * "total" size are the same number rather than one being the other plus an index
 * total. The optional index size stays absent for the same reason - a zero would be
 * a measurement of something that does not exist.
 *
 * The count is the cluster's own, and it counts more documents than a statement can
 * return: measured on OpenSearch, `probe_shapes` reports 2 documents while a count
 * over it answers 1, because its `items` field is `nested` and every nested element
 * is stored as a document of its own. So this number is the index's document count
 * as the cluster reports it, not the number of rows a `SELECT *` would produce, and
 * an index with nested fields will always read higher than its queries do. Deriving
 * it from SQL instead would be a statement per index, on a surface whose grammar the
 * tree must not depend on, to answer a different question than the panel asks.
 *
 * A CLOSED index reports neither a document count nor a size (measured: both arrive
 * as JSON null while the listing still names the index), and `TableStats` has no way
 * to say "unknown" - both fields are required numbers. So a closed index reads as
 * zero here, and the schema tree is the surface that keeps the distinction: its
 * `rowCount` and `size` are optional, so it OMITS them instead.
 */
function toTableStats(index: SearchIndexInfo): TableStats {
  const sizeBytes = index.sizeBytes ?? 0;

  return {
    schemaName: SEARCH_SCHEMA_NAME,
    tableName: index.name,
    rowCount: index.docCount ?? 0,
    tableSize: formatBytes(sizeBytes),
    tableSizeBytes: sizeBytes,
    totalSize: formatBytes(sizeBytes),
    totalSizeBytes: sizeBytes,
  };
}

/**
 * The cluster's own store, as the one storage row there is - or no row at all.
 *
 * A search cluster has no tablespaces, no data files a user placed and no per-node
 * disk figure crossing this seam, so the honest unit here is the cluster: its name,
 * and the bytes its indices occupy including replicas.
 *
 * `usagePercent` is omitted rather than zeroed because no capacity crosses the seam
 * either, and a zero would render as "0% used" of a disk nobody measured. And an
 * unreported size produces NO row: the seam returns null when the heavier stats read
 * was refused, and a row claiming the cluster stores zero bytes would be a statement
 * the cluster never made - worse than an empty panel that says nothing.
 */
function toStorageStats(health: SearchClusterHealth): StorageStats[] {
  if (health.storeSizeBytes === null) return [];

  return [
    {
      name: health.clusterName,
      size: formatBytes(health.storeSizeBytes),
      sizeBytes: health.storeSizeBytes,
    },
  ];
}

// ============================================================================
// Search Provider
// ============================================================================

/**
 * The behaviour both search products share, which is all of it but one clause.
 *
 * Not exported: the factory constructs a type-id, and a type-id is one of the two
 * concrete classes at the bottom of this file. Keeping the base internal is also
 * what keeps the two exports honestly thin - there is no third thing to import.
 */
abstract class SearchProvider extends SQLBaseProvider {
  private transport: SearchTransport | null = null;

  protected readonly product: SearchProduct;

  protected constructor(product: SearchProduct, config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.product = product;
    this.validate();
  }

  // ==========================================================================
  // Provider metadata
  // ==========================================================================

  /**
   * One answer for both products, because every flag here measured the SAME on
   * both. The single difference between them - `OFFSET` - has no field in
   * `ProviderCapabilities` to declare it in, so it lives on {@link SearchProduct}
   * and is read by `prepareQuery` alone.
   */
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "sql",
      // Neither product's SQL endpoint returns a plan tree this repo could render:
      // OpenSearch's plugin has no EXPLAIN of a shape `src/lib/explain/` models, and
      // Elasticsearch's returns its own internal plan text on one product only. No
      // `explainFormat` is declared, which is what hides the button and the tab.
      supportsExplain: false,
      // `LIMIT n` is correct SQL on both (measured, HTTP 200 with the rows bounded),
      // so the shared limiter's ordinary output runs everywhere. `prepareQuery`
      // handles the one form that does not.
      supportsExternalQueryLimiting: true,
      // Not unimplemented - not in either grammar. See the file header, point 2.
      supportsCreateTable: false,
      // Same measurement, same conclusion: `UPDATE` is refused by both grammars, so
      // the inline editor's statement could only ever produce an error. False hides
      // the affordance instead of offering it (#269).
      supportsInlineRowEdit: false,
      // Neither grammar has BEGIN; both are reached over stateless HTTP.
      supportsTransactions: false,
      // The engine has no such constraint in its model: denormalization is the
      // modelling advice, `nested` and `join` are containment rather than reference,
      // and no DDL exists to declare one. So the empty `foreignKeys` the schema tree
      // reports means "impossible here" rather than "none declared, or none
      // visible to this role" - the distinction #414 was about.
      declaresForeignKeys: false,
      // Absent deliberately: an index is a real object the cluster holds, named by
      // whoever created it and addressable in a statement. It is not a grouping this
      // server derived from a scan, which is what Redis and LibreDB declare.
      //
      // Nothing here has a SQL-reachable maintenance analogue. Refresh, force-merge
      // and cache-clearing are all index APIs rather than statements, and `kill` is
      // impossible for a second reason: an abort closes this client's socket while
      // the cluster keeps working (measured, recorded in the seam), and the task API
      // that could really cancel a search is not part of this seam.
      supportsMaintenance: false,
      maintenanceOperations: [],
      // No URI convention to paste: both products are addressed by host and port
      // like Druid, and `http://` / `https://` are already claimed by ClickHouse in
      // the shared connection-string parser.
      supportsConnectionString: false,
      defaultPort: SEARCH_DEFAULT_PORT,
      // Declared because the port cannot say: both products are 9200 and they
      // disagree. See SearchProduct.identifierQuoting for the measurement.
      identifierQuoting: this.product.identifierQuoting,
      // One answer for both products, and the safe one rather than the tolerant one.
      // Elasticsearch has no `;` in its grammar: the generator's own
      // `SELECT * FROM orders LIMIT 50;` - "Select Top 50 Documents", the first thing
      // a user clicks on an index - answered `parsing_exception`, "extraneous input
      // ';' expecting <EOF>" (measured 2026-08-19, both generated shapes). OpenSearch
      // accepts the terminator and also accepts its absence, so omitting it on both
      // keeps this a fact about the family instead of a branch on `dialect`.
      statementTerminator: "none",
      schemaRefreshPattern: SEARCH_SCHEMA_REFRESH_PATTERN,
    };
  }

  /**
   * A search cluster's vocabulary, everywhere the UI says a word.
   *
   * `Index` and `document` are not decoration: `inventory-noun.ts` lowercases
   * `entityName` into the noun the AGENT reasons with, so a cluster described as
   * holding "tables" of "rows" invites statements written for a relational engine.
   * The columns of an index are its mapped FIELDS, which is the word the user wrote
   * in their own mapping, so the search placeholder says so too.
   *
   * "Indices" rather than "Indexes" because that is the plural both products use in
   * their own APIs and documentation - and because "indexes" is the word this
   * product already uses for the secondary-index objects an index does NOT have
   * (`TableSchema.indexes`, empty by construction here).
   *
   * The two maintenance actions are named even though `supportsMaintenance` is
   * false, because they are still RENDERED: the schema tree offers both entries to
   * an admin and both open the Maintenance panel, which then offers this engine no
   * operation. So they name the closest real cluster concept rather than a
   * relational one. `analyzeAction` deliberately avoids the word "Analyze" on its
   * own - a search cluster's `_analyze` is text analysis, an entirely different
   * operation - and the global descriptions state plainly that nothing runs from
   * here, which is the only thing about them a user needs to be right about.
   */
  public override getLabels(): ProviderLabels {
    return {
      entityName: "Index",
      entityNamePlural: "Indices",
      rowName: "document",
      rowNamePlural: "documents",
      selectAction: "Select Top 50 Documents",
      generateAction: "Generate Query",
      // The one label here written for a MODEL and not for the UI. See
      // `SearchProduct.statementLanguage`: a plan run on this engine wrote a JSON
      // aggregation body when it was told only "produce one runnable statement".
      statementLanguage: this.product.statementLanguage,
      analyzeAction: "Index Statistics",
      vacuumAction: "Merge Segments",
      searchPlaceholder: "Search indices or fields...",
      analyzeGlobalLabel: "Index Statistics",
      analyzeGlobalTitle: "Statistics Are the Cluster's Own",
      analyzeGlobalDesc:
        "A search cluster maintains its per-shard statistics itself as documents are indexed, and exposes no statement that recomputes them. Nothing runs from here.",
      vacuumGlobalLabel: "Merge Segments",
      vacuumGlobalTitle: "Reclaim Deleted Documents",
      vacuumGlobalDesc:
        "A deleted document stays in its segment until the segments are merged. Merging is an index API on the cluster rather than a statement this SQL surface can send, so nothing runs from here.",
      // The monitoring Queries tab used to tell a search cluster to install a
      // PostgreSQL extension (#U12). Both products keep a slow log; `getSlowQueries()`
      // above says why neither is readable from here, and this is the same fact in the
      // panel's words.
      slowQueriesEmptyState:
        "The slow log is written to the node's own log file, which no API returns, so this SQL surface does not reach it.",
    };
  }

  /**
   * The inherited limiter is right for every statement on one product and for every
   * statement but one page on the other.
   *
   * It appends `LIMIT n` for the first page, which both products accept (measured,
   * including after `ORDER BY`, `GROUP BY` and `HAVING`), and `LIMIT n OFFSET m` for
   * every page after it - which Elasticsearch refuses outright with
   * `parsing_exception`, "mismatched input 'OFFSET' expecting <EOF>". So a product
   * whose grammar has no OFFSET cannot serve a second page at all through this
   * surface: Elasticsearch's own paging idiom is a cursor, and the seam deliberately
   * asks for none (no page size is sent, so no cursor comes back, so there is no
   * server-side state to leak or close).
   *
   * That leaves the request REFUSED, with the reason, and the alternatives are worse
   * in a way that matters. Sending the clause anyway fails the query with an engine
   * message about a keyword the user never typed. Silently dropping the OFFSET and
   * sending `LIMIT n` returns page ONE while the editor appends it to what it
   * already shows, i.e. duplicate rows presented as new ones - a wrong ANSWER,
   * which is the one outcome worth throwing to avoid. Druid's trailing-OFFSET case
   * (#265) could leave the statement alone because there the cost was only extra
   * rows; here the cost is fabricated data.
   *
   * The refusal is narrow on purpose: it fires only when the limiter actually
   * produced the clause. A statement carrying its own `LIMIT` is left exactly as the
   * base class left it - untouched, `wasLimited: false` - because nothing was
   * rewritten and the user's own bound is what runs, which is how every provider in
   * this repo behaves for that case.
   */
  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const prepared = super.prepareQuery(query, options);
    if (this.product.acceptsOffsetClause || !prepared.wasLimited || prepared.offset === 0) return prepared;

    throw new QueryError(
      `${this.product.label} SQL has no OFFSET clause, so results after the first page cannot be requested here. ` +
        "Narrow the statement with a WHERE clause, or raise the row limit, instead of paging.",
      this.type,
      query,
    );
  }

  // ==========================================================================
  // Validation and lifecycle
  // ==========================================================================

  /**
   * A host is the only requirement.
   *
   * No database is asked for, and the field is ignored even when the connection
   * form carries one: a cluster has no namespace above its indices (header point 3),
   * so there is nothing to select into. No connection string is accepted either -
   * see `supportsConnectionString`.
   */
  public override validate(): void {
    super.validate();
    if (!this.config.host) {
      throw new DatabaseConfigError(`${this.product.label} requires a host`, this.type);
    }
  }

  public async connect(): Promise<void> {
    const transport = new SearchHttpTransport(this.product.dialect, this.config);

    try {
      await transport.query(CONNECT_PROBE_SQL, this.deadline());
    } catch (error) {
      const failure = this.describeConnectFailure(error);
      this.setError(failure);
      throw failure;
    }

    this.transport = transport;
    this.setConnected(true);
  }

  /**
   * Nothing to close.
   *
   * Every request is one `fetch` with no pool, no session and no cursor behind it -
   * the seam has no `close()` for that reason - so disconnecting is forgetting the
   * transport. A no-op `close()` on the seam would only have made this line look
   * like it released something.
   */
  public disconnect(): Promise<void> {
    this.transport = null;
    this.setConnected(false);
    return Promise.resolve();
  }

  /**
   * Why the connect probe failed, in the vocabulary the connection form reads.
   *
   * A rejected credential stays an authentication failure: calling it a
   * connectivity problem would send the user to check a host that answered
   * perfectly well. Everything else becomes a connection failure carrying the
   * cluster's own words, which for the two most common mistakes are the useful ones
   * (a refused socket names the code, and the wrong product's endpoint path is
   * quoted verbatim by the cluster that did not route it).
   */
  private describeConnectFailure(error: unknown): Error {
    const mapped = this.mapSearchError(error);
    if (mapped instanceof AuthenticationError) return mapped;

    return new ConnectionError(
      `Failed to connect to ${this.product.label}: ${mapped.message}`,
      this.type,
      this.config.host,
      this.config.port,
    );
  }

  private requireTransport(): SearchTransport {
    this.ensureConnected();
    // Assigned before setConnected(true) and cleared after setConnected(false), so
    // a connected provider always has one.
    return this.transport!;
  }

  /**
   * The deadline for one operation, and it is the CLIENT's alone.
   *
   * There is no server-side half to pair it with: the seam sends the statement and
   * nothing else, and both products keep executing after a client abort (measured,
   * recorded in the seam). So this bounds how long this process waits - connect,
   * handshake, and a response body that stops arriving - and says nothing about
   * when the cluster stops working. `AbortSignal.timeout` is used rather than a
   * plain controller because its reason is a `TimeoutError`, which is the one signal
   * the transport uses to tell a deadline apart from a user's cancellation.
   *
   * One signal per OPERATION, not per request: the monitoring reads below fan out
   * several requests for one panel, and a panel that renders half its numbers after
   * a stall is not a better answer than a panel that reports the stall.
   */
  private deadline(): AbortSignal {
    return AbortSignal.timeout(this.queryTimeout);
  }

  // ==========================================================================
  // Query execution
  // ==========================================================================

  /**
   * One statement.
   *
   * Parameters are refused rather than inlined - see the file header. A write is not
   * special-cased either: both grammars reject every mutation and each one's message
   * names what it expected instead, which is more useful than anything substituted
   * here.
   */
  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const transport = this.requireTransport();
    if (params !== undefined && params.length > 0) {
      throw new QueryError(
        `${this.product.label} binds statement parameters through a request field this provider does not send, so positional parameters cannot be used`,
        this.type,
        sql,
      );
    }

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await transport.query(sql, this.deadline());
        } catch (error) {
          throw this.mapSearchError(error, sql);
        }
      });

      return toQueryResult(result, executionTime);
    });
  }

  /**
   * Normalized transport failure -> this repo's error vocabulary, one category to
   * exactly one class.
   *
   * The CATEGORY, never the HTTP status: the seam's header records the status lying
   * in both directions (a missing index is 400 on one product and 404 on the other,
   * while a user's `SELECT 1/0` is 500), so this is the same body-driven rule
   * ClickHouse arrived at in #264. Every category is listed and there is no
   * `default`, so adding one to the seam fails the typecheck here instead of being
   * quietly swallowed as a query error.
   *
   * The four that collapse onto `QueryError` do so because they describe the same
   * event to a user - the cluster read the statement and refused it - and the
   * engine's own wording, carried through the seam verbatim, is what distinguishes
   * them on screen ("line 1:15: Unknown index [nope_missing]" locates the fault far
   * better than a class name). `unsupported` is here rather than under a config
   * error for a measured reason: it is what OpenSearch answers for a MISTYPED
   * leading keyword, which is a statement problem and nothing about the deployment.
   *
   * A value that is not a seam error never came from the cluster (an internal
   * defect, an assertion) and goes to the shared message-based mapping, exactly as
   * `druid/index.ts` and `clickhouse/index.ts` do.
   */
  private mapSearchError(error: unknown, sql?: string): Error {
    if (!(error instanceof SearchTransportError)) return this.mapError(error, sql);

    switch (error.category) {
      case "auth":
        return new AuthenticationError(error.message, this.type);
      case "unreachable":
        return new ConnectionError(error.message, this.type, this.config.host, this.config.port);
      case "timeout":
        // The deadline that expired is this client's, and it is the only one there
        // is; the cluster is still working on the statement.
        return new TimeoutError(error.message, this.type, this.queryTimeout, sql);
      case "cancelled":
        return new QueryCancelledError(error.message, this.type, sql);
      case "syntax":
      case "unknown-object":
      case "unsupported":
      case "engine":
        return new QueryError(error.message, this.type, sql);
    }
  }

  /** Run a schema or monitoring read whose failures should surface as provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.mapSearchError(error);
    }
  }

  // ==========================================================================
  // Schema
  // ==========================================================================

  /**
   * Every index the credentials can see, with its mapped fields as columns.
   *
   * `getSchemaList` and `getSchemaRelations` are deliberately NOT implemented. Both
   * are optional and the client falls back to this method, and the split exists so a
   * slow relationship read cannot block the table list - which this engine has
   * neither half of: there are no secondary-index objects and no foreign keys, so a
   * list would be byte-identical to this and a relations pass would re-read every
   * mapping to answer two empty arrays per index.
   */
  public async getSchema(): Promise<TableSchema[]> {
    const transport = this.requireTransport();
    return this.guarded(() => readSchema(transport, {}, this.deadline()));
  }

  // ==========================================================================
  // Monitoring
  // ==========================================================================

  /**
   * What the cluster is and how much it holds.
   *
   * Three seam calls in parallel, because they answer three different questions and
   * a cluster can refuse one of them: the version payload is unauthenticated on a
   * stock node, the index listing needs monitor privileges per index, and the
   * cluster-wide store size comes from a heavier read that a restricted role may not
   * hold at all (the seam returns null rather than failing for exactly that case).
   *
   * The two vocabulary collisions in this shape are worth naming, because both are
   * counted wrong by the obvious reading:
   *
   * - `tableCount` counts INDICES - an index is the table on this surface - and
   *   counts only the user's, matching what the schema tree shows by default. On a
   *   stock OpenSearch node two of three indices are the engine's own bookkeeping
   *   (measured), so counting everything would report a cluster holding data nobody
   *   put there.
   * - `indexCount` is 0 and stays 0. There is no secondary-index OBJECT to count:
   *   every mapped field is inverted-indexed as a property of being mapped, so
   *   there is nothing a user declared and nothing to name. The schema tree says
   *   the same thing from the other side with `indexes: []`.
   *
   * `databaseSizeBytes` is the CLUSTER's store including replicas, which is what the
   * cluster occupies; the per-index sizes in the schema tree are primaries only, so
   * they deliberately do not sum to this number.
   */
  public async getOverview(): Promise<DatabaseOverview> {
    const transport = this.requireTransport();

    return this.guarded(async () => {
      const signal = this.deadline();
      const [version, health, indices] = await Promise.all([
        transport.version(signal),
        transport.health(signal),
        transport.indices(signal),
      ]);
      const sizeBytes = health.storeSizeBytes;

      return {
        // The product name comes from the connection, not from the payload's own
        // distribution field: the connect probe proved which product is listening
        // (the SQL endpoint path is product-specific and the wrong one never reaches
        // a SQL engine, both measured), and `elasticsearch` / `opensearch` in
        // lowercase are wire words rather than the names these products go by.
        version: `${this.product.label} ${version.version}`,
        // Neither the health nor the version payload carries an uptime, and no other
        // call in this seam does either, so this is unknown rather than a duration
        // computed from something else. A "0s" here would claim the cluster booted
        // this instant.
        uptime: SEARCH_UNKNOWN_TEXT,
        // Zero means "not published", the same encoding `mssql.ts` and `druid` use.
        // A search cluster has no sessions and no connection pool: it counts open
        // HTTP connections per node in its stats API, which is not part of this
        // seam, and the shard and node counts that ARE here would be a different
        // number wearing this field's name. The Connections card reads a zero
        // maximum as "no limit published" rather than dividing by it.
        activeConnections: 0,
        maxConnections: 0,
        databaseSize: sizeBytes === null ? SEARCH_UNKNOWN_TEXT : formatBytes(sizeBytes),
        databaseSizeBytes: sizeBytes ?? 0,
        tableCount: indices.filter((index) => !isSystemIndex(index)).length,
        indexCount: 0,
      };
    });
  }

  /**
   * Empty, and it asks the cluster nothing.
   *
   * Every field of `PerformanceMetrics` is optional, and a search cluster's query
   * cache, request cache and per-node counters live in its stats APIs - none of
   * which is one of this seam's five calls. So there is no statement to send and no
   * connection to require: the answer cannot vary with either, which is why this is
   * synchronous like Druid's.
   *
   * Emptiness rather than zeroes is the load-bearing part. `cacheHitRatio` is scored
   * `direction: "below"` with `critical: 80` by `DEFAULT_THRESHOLDS`, so a
   * "neutral" 0 would paint a red critical cache fault on every healthy cluster; the
   * monitoring tabs default an ABSENT ratio to a healthy 100 instead. Every other
   * metric would read as a measurement of zero, which is a different and false
   * claim.
   *
   * Recorded gap rather than an impossibility: these numbers do exist on both
   * products' stats endpoints, so widening the seam by one call is what a future
   * phase would do - and doing it here would have meant reaching around the seam.
   */
  public getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return Promise.resolve({});
  }

  /**
   * Empty: neither product exposes finished queries where this provider can read
   * them, so a row cap has nothing to cap.
   *
   * Elasticsearch's slow log is written to the node's LOG FILE, which no API returns.
   * OpenSearch really does keep top-N queries - measured, a stock 3.8.0 node ships a
   * `top_queries-<date>` index, and this provider hides it as engine bookkeeping -
   * but reading it would be a monitoring surface that exists on one of the two
   * products behind one code path, i.e. exactly the branch on product identity that
   * the seam and `CLAUDE.md` both forbid. A slow-query panel that is populated for
   * half the connections of one provider type is worse than an honest empty one.
   *
   * Empty rather than thrown, and the distinction is deliberate: nothing is broken
   * and nothing is misconfigured, so a monitoring tab should render as quiet, not as
   * failed. Only `runMaintenance` throws here, because that one is a REQUEST to act.
   */
  public getSlowQueries(): Promise<SlowQueryStats[]> {
    return Promise.resolve([]);
  }

  /**
   * Empty: no secondary-index object exists to describe.
   *
   * Every mapped field is inverted-indexed inside the shard's segments, with no
   * name, no size and no usage counter of its own, so there is nothing an index row
   * could report - and the collision of words is the whole trap: the INDEX in
   * "Elasticsearch index" is this provider's table, and it is already reported by
   * `getTableStats`. Listing one row per field would report the same fact twice.
   */
  public getIndexStats(): Promise<IndexStats[]> {
    return Promise.resolve([]);
  }

  /**
   * Empty: a search cluster has no sessions to list.
   *
   * There is no connection catalog and no session concept in either product - a
   * request is one HTTP request - so the closest thing is a running search TASK,
   * which lives in a task API this seam does not carry. Unlike Druid, whose
   * ingestion tasks are long-lived and worth showing in this panel, a search task
   * measured in milliseconds would be a list that is empty whenever anybody looks at
   * it, so nothing is invented to fill it.
   *
   * Empty rather than thrown, for the same reason as the slow queries above.
   */
  public getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return Promise.resolve([]);
  }

  /**
   * Documents and bytes per index, from the one listing that reports both.
   *
   * The schema filter is answered without a round trip whenever it names anything at
   * all: an index has no namespace above it (header point 3), so any named schema
   * selects nothing, and a predicate that can never match is slower and less
   * obviously right than not asking. Engine bookkeeping is excluded here exactly as
   * it is in the schema tree, so the two surfaces list the same indices.
   */
  public async getTableStats(options: { schema?: string } = {}): Promise<TableStats[]> {
    if (options.schema !== undefined && options.schema !== SEARCH_SCHEMA_NAME) return [];
    const transport = this.requireTransport();

    return this.guarded(async () => {
      const indices = await transport.indices(this.deadline());
      return indices.filter((index) => !isSystemIndex(index)).map(toTableStats);
    });
  }

  /** The cluster's own store, as the one storage unit a search cluster has. */
  public async getStorageStats(): Promise<StorageStats[]> {
    const transport = this.requireTransport();
    return this.guarded(async () => toStorageStats(await transport.health(this.deadline())));
  }

  /**
   * The health summary, composed from the reads that have a source.
   *
   * The three empty or unavailable fields are the same facts the methods above
   * state, and they are written out here rather than mapped from them: the summary
   * needs the narrower `SlowQuery` and `ActiveSession` shapes, and a mapper over a
   * list that is always empty would be a body no test can reach. `formatCacheHitRatio`
   * is what turns "not measured" into the repo's word for it in one place.
   */
  public async getHealth(): Promise<HealthInfo> {
    const overview = await this.getOverview();

    return {
      activeConnections: overview.activeConnections,
      databaseSize: overview.databaseSize,
      cacheHitRatio: formatCacheHitRatio(undefined),
      slowQueries: [],
      activeSessions: [],
    };
  }

  // ==========================================================================
  // Maintenance
  // ==========================================================================

  /**
   * Refused, with the reason.
   *
   * This exists because the interface obliges every provider to implement it, and it
   * is reached only by a programmatic caller of the package: `/api/db/maintenance`
   * checks `supportsMaintenance` and answers 400 before it would call this. The
   * admin Operations tab still does not read capabilities, so its buttons keep
   * hitting that 400 - which is why the labels above say in words that nothing runs
   * from there.
   *
   * Every operation in `MaintenanceType` is either an index API rather than a
   * statement (refresh, force-merge, cache clear) or impossible on this surface at
   * all: `kill` would need to stop a running search, and an abort here closes this
   * client's socket while the cluster keeps working (measured). Throwing rather than
   * reporting a cheerful success is the point - a caller that asked for work must
   * not be told work happened.
   */
  public async runMaintenance(type: MaintenanceType): Promise<MaintenanceResult> {
    throw new QueryError(
      `${this.product.label} has no SQL-reachable maintenance operation, so "${type}" cannot run here. ` +
        "Refreshing, merging segments and clearing caches are index APIs on the cluster rather than statements, and a running search cannot be cancelled through this surface.",
      this.type,
    );
  }
}

// ============================================================================
// The two type-ids
// ============================================================================

/**
 * Elasticsearch, over its SQL endpoint.
 *
 * Thin by design: everything but the product's name and its one grammatical
 * difference is shared with OpenSearch, and the wire difference is a row in the
 * transport's own dialect table. Measured on 9.1.4 with a basic licence - the SQL
 * endpoint is not licence-gated, which is what makes this the shared query language
 * rather than ES|QL.
 */
export class ElasticsearchProvider extends SearchProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(ELASTICSEARCH_PRODUCT, config, options);
  }
}

/**
 * OpenSearch, over its SQL plugin.
 *
 * The plugin ships with the distribution, so the endpoint is present on a stock node
 * (measured on 3.8.0). The one behaviour it does NOT share with Elasticsearch is
 * that its grammar accepts `OFFSET`, which is declared as a trait rather than
 * branched on.
 */
export class OpenSearchProvider extends SearchProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(OPENSEARCH_PRODUCT, config, options);
  }
}
