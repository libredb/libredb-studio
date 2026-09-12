/**
 * Search-engine transport seam (issue #424, Phase 1)
 *
 * One provider implementation serves TWO type-ids, `elasticsearch` and
 * `opensearch`, because the two products speak the same shape of SQL over HTTP
 * and differ only in wire detail. This interface is where that stops being a
 * claim: provider logic, introspection and monitoring go through it, so
 * everything the two disagree about is confined to `http-transport.ts`.
 *
 * What the two disagree about, all live-measured on 2026-08-19 against
 * Elasticsearch 9.1.4 (basic licence) and OpenSearch 3.8.0:
 *
 * - the SQL endpoint path: `POST /_sql?format=json` against `POST /_plugins/_sql`
 * - the success envelope: `{columns:[{name,type}], rows:[[...]]}` against
 *   `{schema:[{name,type}], datarows:[[...]], total, size, status}`
 * - the failure envelope AND the discriminator inside it. Elasticsearch answers
 *   `{error:{root_cause,type,reason,caused_by}}` and names the fault in
 *   `error.type` (`parsing_exception`, `verification_exception`); OpenSearch
 *   answers `{error:{reason,details,type}}` where `type` is a Java class name
 *   (`SQLFeatureNotSupportedException`) and the useful text is in `details`.
 * - ES|QL exists on Elasticsearch (`POST /_query`, and it works on a basic
 *   licence) and does not exist on OpenSearch at all (405). It is deliberately
 *   NOT used: a surface only one of the two products has cannot be the shared
 *   query language, and the SQL endpoint is available on both without a licence.
 *
 * The status code misclassifies in BOTH directions, which is why categorisation is
 * body-driven. Measured: a missing index is HTTP **400** on Elasticsearch
 * (`verification_exception`) and HTTP **404** on OpenSearch
 * (`IndexNotFoundException`) - the same typo, two statuses, neither of which means
 * what the code says. In the other direction `SELECT 1/0` is HTTP **500** on
 * Elasticsearch for what is a user's arithmetic. This is the same lesson ClickHouse
 * taught in #264, where a permission denial arrives as 500.
 *
 * (An earlier revision of this header asserted 400 on both products. That was
 * written from the first fixture pair and refuted by the implementation's own
 * measurement of OpenSearch. The conclusion did not change; the reason it holds
 * got stronger.)
 *
 * Apart from the error type this file is purely structural: no I/O, and no wire
 * vocabulary. `seam-guard.test.ts` fails the build when a path, an envelope key
 * or a product error type appears anywhere in this directory except
 * `http-transport.ts` - that guard is what keeps "adding a second implementation
 * is one new file" true rather than aspirational.
 */

/**
 * Which product a connection points at.
 *
 * This is the ONLY product distinction that crosses the seam. It is a type-id,
 * not a feature flag: provider logic may use it to phrase a message or pick a
 * label, and must never use it to decide behaviour - behaviour differences belong
 * in the transport, and capability differences belong in `getCapabilities()`.
 * CLAUDE.md forbids `=== 'mongodb'`-style branching outside provider classes for
 * exactly this reason.
 */
export type SearchDialectId = "elasticsearch" | "opensearch";

/** One result row, keyed by the names in {@link SearchQueryResult.fieldNames}. */
export type SearchRow = Record<string, unknown>;

/**
 * Normalized outcome of one statement.
 *
 * There is deliberately NO mutation count. Live-measured: the SQL endpoint of
 * both products accepts `SELECT`, `SHOW` and `DESCRIBE`; OpenSearch also accepts
 * `DELETE` behind a non-default setting, and Elasticsearch rejects every mutation
 * in the grammar itself ("Query must start with SELECT..." / a parsing_exception).
 * A count here could only ever be zero for the statements we can run, and a field
 * that is always zero reads as "nothing changed" rather than "this cannot happen".
 * Writes go through the document APIs, which this seam does not expose.
 */
export interface SearchQueryResult {
  rows: SearchRow[];

  /**
   * Column order as the server declared it, or null when the source could not
   * describe the rows.
   *
   * Declared order is authoritative and object keys are not: both products send
   * rows POSITIONALLY (`rows` / `datarows` are arrays of arrays), so the
   * implementation rebuilds each row against this list. An all-null first row
   * therefore cannot be trusted to carry every key, which is why the order comes
   * from the declaration rather than from the data.
   *
   * INVARIANT the implementation must uphold: these names are UNIQUE and are
   * exactly the key set of every row. `SELECT 1 AS c, 2 AS c` really does declare
   * two columns named `c`, and a duplicate cannot survive into a `SearchRow`, so
   * the disambiguation has to happen while the row is rebuilt - before this seam.
   */
  fieldNames: string[] | null;

  /**
   * The engine's own type name per column, keyed by the name in `fieldNames`.
   *
   * These are mapping types, not SQL types: live-measured, a `SELECT customer,
   * total` over an index declares `keyword` and `double`, not `VARCHAR` and
   * `DOUBLE`. That vocabulary is what a user reads in their own index mapping, so
   * it is the honest label for the column - and it is the same vocabulary
   * introspection reports, which keeps the grid and the schema tree consistent.
   *
   * A `Record` is lossless only because `fieldNames` is unique. Null when the
   * source could not describe the rows.
   */
  columnTypes: Record<string, string> | null;

  /**
   * Total matching documents when the server reported one, else null.
   *
   * OpenSearch sends `total` and `size` alongside every result; Elasticsearch
   * sends neither. So this is null against Elasticsearch, and a caller must treat
   * it as "unknown" rather than "zero" - the asymmetry is the reason it is
   * nullable rather than defaulted.
   */
  totalHits: number | null;
}

/**
 * Why a request failed, in terms the provider can map onto this repo's error
 * classes without knowing anything about HTTP or about either product.
 *
 * Categorisation is BODY-driven, never status-driven: see the file header for the
 * measured reason. The implementation owes each category a faithful decision; the
 * provider owes each category exactly one error class.
 */
export type SearchErrorCategory =
  /** The statement is not valid for the engine's SQL grammar. */
  | "syntax"
  /** The statement is valid but names something that does not exist. */
  | "unknown-object"
  /** The grammar accepts it, the engine does not implement it. */
  | "unsupported"
  /** Credentials were absent, wrong, or lack the privilege. */
  | "auth"
  /** The endpoint could not be reached, or the SQL plugin is not installed. */
  | "unreachable"
  /** The request was cancelled by the caller. */
  | "cancelled"
  /** The request outlived its deadline. */
  | "timeout"
  /** Reached, understood, and refused for a reason none of the above covers. */
  | "engine";

/**
 * A failure that crossed the seam.
 *
 * Carries the engine's own wording because the alternative - rewriting it - loses
 * the only text that tells a user which line of their query is wrong. The
 * measured messages are worth reading verbatim: Elasticsearch answers a bad
 * keyword with `line 1:1: mismatched input 'SELEKT' expecting {...}` and a bad
 * index with `line 1:15: Unknown index [nope_missing]`, both of which locate the
 * fault for the user better than anything we could synthesize.
 */
export class SearchTransportError extends Error {
  constructor(
    readonly category: SearchErrorCategory,
    message: string,
    /** The engine's own fault name, when it sent one. Diagnostic only. */
    readonly engineType?: string,
  ) {
    super(message);
    this.name = "SearchTransportError";
  }
}

/** A field in an index mapping, flattened to a path. */
export interface SearchMappingField {
  /**
   * Dotted path to the field, e.g. `customer` or `address.city`.
   *
   * Mappings nest arbitrarily and the SQL surface addresses nested fields by
   * dotted path, so the flattening happens in the implementation and the seam
   * carries the form the query language actually accepts.
   */
  path: string;
  /** The mapping type: `keyword`, `text`, `long`, `double`, `date`, `object`, ... */
  type: string;
  /**
   * True when the field has sub-fields (a `text` field with a `keyword` subfield,
   * or an `object`). Such a field is addressable in SQL only through a subfield,
   * so the tree must be able to show it without implying it is selectable.
   */
  hasSubfields: boolean;

  /**
   * True when this path is a MULTI-FIELD - a second analysis of its parent, living
   * under the mapping's `fields` rather than under `properties` (the classic case
   * being `note.keyword` beside a `text` field `note`).
   *
   * This distinction is not cosmetic, and it is here because measurement forced it.
   * Elasticsearch 9.1.4 selects `note.keyword` happily - its own `DESCRIBE` lists
   * the path as a column. OpenSearch 3.8.0 REFUSES it in every spelling: `SELECT
   * note.keyword` answers `SemanticCheckException`, "can't resolve
   * Symbol(namespace=FIELD_NAME, name=note.keyword) in type env", while an OBJECT
   * subfield (`addr.city`) selects fine on both.
   *
   * That asymmetry matters far more than it sounds: dynamic mapping gives EVERY
   * text field a `keyword` multi-field automatically, so a column list that
   * includes multi-fields produces a generated starter query that fails on
   * essentially any dynamically-mapped OpenSearch index. A consumer therefore has
   * to be able to tell the two kinds of child apart - `hasSubfields` on the parent
   * cannot say which kind the child is.
   */
  isMultiField: boolean;
}

/** One index, as introspection sees it. */
export interface SearchIndexInfo {
  name: string;
  /**
   * Document count, or null when the server did not report one.
   *
   * Live-measured: the count arrives as a STRING, and is absent for a closed
   * index. Both are the implementation's problem; a caller sees a number or an
   * admission that there isn't one.
   */
  docCount: number | null;
  /**
   * Primary-store size in BYTES, or null when unreported.
   *
   * Live-measured trap: the default listing reports this human-formatted
   * ("5.6kb"), and even when asked for bytes it arrives as a string ("5913"). A
   * caller must never see either form - parsing belongs to the implementation.
   */
  sizeBytes: number | null;
  /** `open` or `close`. A closed index answers no query, and the tree says so. */
  status: string;
  /**
   * True for an index the engine created for its own bookkeeping.
   *
   * Live-measured on a stock single node: OpenSearch 3.8.0 ships
   * `.plugins-ml-config` and `top_queries-<date>`, so two of three indices on an
   * empty cluster are not the user's. Both products mark their own with a leading
   * dot by convention, and the date-suffixed query-insights index is the exception
   * that makes this a judgement rather than a rule - hence a flag the provider
   * decides what to do with, rather than a filter applied here.
   *
   * NOTE what this list does NOT contain: aliases and data streams. They are a
   * different endpoint, and `getSchema()` still describes indices alone - so a
   * queryable alias does not appear in the SCHEMA tree. Since #789 it does appear in
   * the OBJECT tree, through {@link SearchTransport.aliases} and
   * {@link SearchTransport.dataStreams}, which is where that limitation was answered.
   */
  isSystem: boolean;
}

/**
 * One object that is neither an index nor a row: an alias, an ingest pipeline, a
 * composable index template, a data stream (issue #789).
 *
 * Two fields and no more, because the tree's folder needs a NAME and the provider
 * needs to know whose object it is. Everything else these endpoints carry - a
 * pipeline's processors, a template's patterns, a data stream's backing indices - is
 * a Phase 2 Source tab rather than anything a listing shows, and reading it here
 * would make the listing pay for a detail nobody opened.
 *
 * `isSystem` is decided on the wire side for the same reason `SearchIndexInfo` decides
 * it there: the signals are product payload members, and they differ per endpoint.
 * Measured on 2026-09-11, Elasticsearch 9.1.4 and OpenSearch 3.8.0:
 *
 * - a stock Elasticsearch node ships 21 ingest pipelines and 61 composable index
 *   templates, ALL of them the engine's own, while a stock OpenSearch node ships
 *   none of either. So an unfiltered pipelines folder would show a user with one
 *   pipeline a folder of 22 on one product and 1 on the other.
 * - the dot-prefix convention alone does not catch them: all 21 pipelines and 43 of
 *   the 61 templates carry no dot. `_meta.managed` catches the pipelines and 57 of
 *   the templates, and the remaining four (`.monitoring-*-mb`) carry the dot. So
 *   neither signal is sufficient alone and the transport reads both.
 */
export interface SearchObjectInfo {
  name: string;
  /** True for an object the engine created for its own bookkeeping. */
  isSystem: boolean;
}

/**
 * Everything the provider needs from a search cluster.
 *
 * Deliberately small: nine calls, each answering one question the provider asks.
 * A second implementation - the official client library, a proxy, a test double -
 * satisfies this and nothing else.
 *
 * The four object listings added for #789 return {@link SearchObjectInfo} rather
 * than anything richer, and each is ONE request: the provider's object surface has
 * ZERO container levels, so a count and a listing both read the whole cluster and
 * there is no per-container narrowing for them to disagree about.
 */
export interface SearchTransport {
  /** Which product this transport speaks to. */
  readonly dialect: SearchDialectId;

  /**
   * Run one SQL statement.
   *
   * @param signal aborts the request. Both products keep executing server-side
   *   after a client abort, so this bounds the CLIENT's wait, not the cluster's
   *   work - the distinction matters for the message a cancelled query shows.
   */
  query(sql: string, signal?: AbortSignal): Promise<SearchQueryResult>;

  /** The server's own version string, and the product it reports itself as. */
  version(signal?: AbortSignal): Promise<{ version: string; product: string }>;

  /** Every index, alias and data stream the credentials can see. */
  indices(signal?: AbortSignal): Promise<SearchIndexInfo[]>;

  /**
   * The mapping of one index, flattened.
   *
   * Mappings are the real schema: the SQL surface derives its columns from them,
   * so a column list built from a `SELECT *` would describe the query rather than
   * the index. An index with no mapping yet answers with an empty list, which is
   * a fact about the index and not an error.
   */
  mapping(index: string, signal?: AbortSignal): Promise<SearchMappingField[]>;

  /**
   * The mappings of MANY indices, keyed by the name the cluster answered under (#789).
   *
   * For a concrete index that key IS the name asked for, which is what lets one request
   * serve a whole folder. It is NOT true of an alias or a data stream: both resolve to
   * the index behind them and come back keyed by that index, so two aliases on one index
   * answer one key and nothing in the payload attributes it back. Those keep to
   * `mapping()`, one at a time.
   *
   * The implementation owes the caller one thing beyond the answer: the request line has
   * a length limit on the wire, so it must issue as many requests as that limit needs
   * rather than one that the cluster refuses.
   */
  mappings(indices: readonly string[], signal?: AbortSignal): Promise<Map<string, SearchMappingField[]>>;

  /**
   * Every alias in the cluster, by name, deduplicated (#789).
   *
   * One alias may point at MANY indices (measured: adding `shared_alias` to two
   * indices succeeds on both products and the listing then names it twice), and the
   * endpoint is keyed by INDEX rather than by alias, so the flattening and the
   * deduplication are the implementation's problem. What crosses the seam is the set
   * of alias names, which is what the tree addresses.
   *
   * An alias name cannot collide with an index or data stream name: measured on both
   * products, adding an alias called `probe_orders` while that index exists is refused
   * with "an index or data stream exists with the same name as the alias".
   */
  aliases(signal?: AbortSignal): Promise<SearchObjectInfo[]>;

  /**
   * Every ingest pipeline in the cluster (#789).
   *
   * The implementation owes one measured translation here, and it is the single
   * biggest behavioural difference this provider's two products showed: with NO
   * pipeline defined, the endpoint answers HTTP 404 with an empty body rather than an
   * empty set. That is the state of a STOCK OpenSearch node, which ships no pipelines at
   * all; upstream it takes deleting the 21 built-ins to reach, and they come back
   * within about twenty seconds - reachable on both, ordinary on one (measured
   * 2026-09-11). So a transport that let the status decide would report "unavailable"
   * for the ordinary OpenSearch case, and the seam's contract is that an empty cluster
   * answers `[]`. The status is not the whole signal either: a 404 carrying the error
   * envelope is a refusal, and the implementation owes that distinction as well, or a
   * folder badges zero where the engine would not answer.
   */
  pipelines(signal?: AbortSignal): Promise<SearchObjectInfo[]>;

  /**
   * Every COMPOSABLE index template in the cluster (#789).
   *
   * Composable only, and that is a measured boundary rather than a modern-API
   * preference: a legacy template and a composable template may carry the SAME name
   * on both products (measured, both `PUT`s answer `acknowledged: true`), so one kind
   * fed by both endpoints would hold two different objects at one path, which
   * `tests/helpers/object-surface-conformance.ts` invariant 5 refuses and a tree
   * cannot address.
   */
  templates(signal?: AbortSignal): Promise<SearchObjectInfo[]>;

  /**
   * Every data stream in the cluster (#789).
   *
   * A data stream is its own object and not a property of an index: its backing
   * indices are `.ds-`-prefixed, which {@link SearchIndexInfo.isSystem} already hides,
   * so without this call a data stream's data is reachable through nothing in the
   * tree at all - while `SELECT * FROM <stream>` answers on both products (measured).
   */
  dataStreams(signal?: AbortSignal): Promise<SearchObjectInfo[]>;

  /** Cluster health and counts, for the monitoring surfaces. */
  health(signal?: AbortSignal): Promise<SearchClusterHealth>;
}

/** Cluster health, normalized across the two products' health payloads. */
export interface SearchClusterHealth {
  /** `green`, `yellow` or `red`. Both products use the same three words. */
  status: string;
  clusterName: string;
  nodeCount: number;
  activeShards: number;
  unassignedShards: number;
  /**
   * Total store size in bytes across the cluster, or null when unreported.
   *
   * Health does not carry it on either product; it comes from a second call in
   * the implementation. Null rather than zero, so a monitoring panel can say
   * "unknown" instead of claiming an empty cluster.
   */
  storeSizeBytes: number | null;
}
