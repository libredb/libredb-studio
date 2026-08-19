/**
 * Elasticsearch / OpenSearch HTTP transport (issue #424, Phase 1)
 *
 * The only implementation of the `SearchTransport` seam, and the only file in the
 * provider allowed to know how either product encodes a request or an answer: the
 * endpoint paths, the query strings, the success-envelope keys
 * (`columns`/`rows` against `schema`/`datarows`/`total`/`size`), the two failure
 * envelopes and the engine fault names inside them, the `_cat` column names, the
 * mapping keys, and `fetch` itself. `seam-guard.test.ts` fails the build the moment
 * any of that vocabulary appears elsewhere in the directory, which is what keeps
 * "the official client library is one new file" true rather than aspirational.
 *
 * Zero runtime dependency: every call is one request through the runtime's own
 * `fetch`, and ONE class serves both products - everything they disagree about is
 * a row in {@link DIALECTS}. Two near-identical code paths would have made the
 * seam pointless, so the rule enforced below is that no method branches on
 * `this.dialect`; it reads `this.spec`.
 *
 * Everything asserted here was measured on 2026-08-19 against Elasticsearch 9.1.4
 * (basic licence, security disabled) and OpenSearch 3.8.0 (security disabled), on
 * a stock single node. The measurements that shaped the code, in the order they
 * cost the most design:
 *
 * 1. **Duplicate output names diverge.** `SELECT 1 AS c, 2 AS c, 3 AS c` answers
 *    HTTP 200 on Elasticsearch with THREE columns all named `c`
 *    (`{"columns":[{"name":"c",...},{"name":"c",...},{"name":"c",...}],"rows":[[1,2,3]]}`),
 *    and is REFUSED outright by OpenSearch - HTTP 400,
 *    `IllegalArgumentException`, "Multiple entries with same key: c=3 and c=2".
 *    So the seam's uniqueness invariant is load-bearing on exactly one of the two
 *    products, and `disambiguate` below is what upholds it; on OpenSearch it can
 *    never fire, which is a fact about that engine and not dead code.
 * 2. **Rows are positional on both** (`rows` / `datarows` are arrays of arrays), so
 *    a row is rebuilt against the declared column list rather than read as an
 *    object. That is also why the declared order is authoritative.
 * 3. **The status code misclassifies, in both directions.** A missing index is
 *    HTTP **400** on Elasticsearch (`verification_exception`, "line 1:15: Unknown
 *    index [nope_missing]") and HTTP **404** on OpenSearch
 *    (`IndexNotFoundException`) - so a status-driven classifier would call the same
 *    typo a bad request on one product and a missing endpoint on the other. In the
 *    other direction, `SELECT 1/0` is HTTP **500** on Elasticsearch
 *    (`arithmetic_exception`, "/ by zero") for what is a user's arithmetic. Both
 *    are the #264 ClickHouse lesson again: categorisation is body-driven.
 * 4. **A string-valued `error` means the request never reached the SQL engine.**
 *    Measured: `POST /_plugins/_sql` against Elasticsearch answers HTTP 400 with
 *    `{"error":"no handler found for uri [/_plugins/_sql] and method [POST]"}`, and
 *    `POST /_sql` against OpenSearch answers HTTP 405 with
 *    `{"error":"Incorrect HTTP method for uri [/_sql?format=json] ...","status":405}`.
 *    Both spell `error` as a STRING where a real engine failure spells it as an
 *    OBJECT, which makes the JSON type of one field a reliable "the SQL plugin is
 *    not installed / this is not that product" discriminator.
 * 5. **`_cat` numbers are strings, and `null` for a closed index.** Even with
 *    `bytes=b`, `docs.count` and `pri.store.size` arrive quoted ("5913"), and a
 *    closed index answers JSON `null` for every one of them while still reporting
 *    `"status":"close"`. Both are parsed here; a caller sees a number or an
 *    admission that there is none.
 * 6. **ES's own `DESCRIBE` is the specification for the flattening.** On an index
 *    whose mapping has an object and a multi-field, `DESCRIBE probe_shapes` answers
 *    exactly `address`/STRUCT, `address.city`/VARCHAR, `note`/VARCHAR,
 *    `note.keyword`/VARCHAR - containers included, dotted, in that shape - and
 *    `SELECT note.keyword, address.city` then works. `flattenProperties` reproduces
 *    that set from `_mapping`, which is why a multi-field is emitted as a child
 *    rather than merely flagged.
 *
 * On authentication: both probe clusters run with security DISABLED, and it was
 * measured that a bogus `Basic` header is IGNORED there (HTTP 200 on both), so no
 * 401/403 body could be captured. Rather than invent one, `auth` is decided on the
 * HTTP status alone - the one signal whose meaning is fixed by HTTP itself - and
 * no unmeasured fault name is listed in the tables below.
 */

import type { DatabaseConnection } from "@/lib/db/types";
import {
  type SearchClusterHealth,
  type SearchDialectId,
  type SearchErrorCategory,
  type SearchIndexInfo,
  type SearchMappingField,
  type SearchQueryResult,
  type SearchRow,
  type SearchTransport,
  SearchTransportError,
} from "./transport";

// ============================================================================
// Constants: paths and wire field names shared by both products
// ============================================================================

const DEFAULT_HOST = "localhost";

/**
 * One default port for both products and both schemes, deliberately.
 *
 * Both ship on 9200 out of the box, and a TLS deployment serves TLS on that SAME
 * port rather than on a second well-known one - unlike ClickHouse (#264), there is
 * no 8443-shaped alternative to fall back to, and inventing one would send
 * credentials somewhere nothing is listening. The connection form prefills this,
 * so it is a floor rather than a guess.
 */
const DEFAULT_PORT = 9200;

/** Measured: without it BOTH products answer HTTP 406, "Content-Type header [application/x-www-form-urlencoded] is not supported". */
const JSON_CONTENT_TYPE = "application/json";

/** The version payload (fixtures `es-root.json`, `os-root.json`). */
const ROOT_PATH = "/";

/**
 * The index listing. `bytes=b` asks for machine-readable sizes; the default is
 * human-formatted ("5.6kb") and unparseable without re-implementing the
 * formatter, which is the trap the seam records (fixtures `es-cat-indices.json`
 * against `es-cat-indices-bytes.json`).
 *
 * No `expand_wildcards`: measured, a CLOSED index is already listed by default
 * (`{"status":"close","index":"probe_empty","docs.count":null,...}`), so asking
 * for more would only add aliases this listing deliberately does not report.
 */
const CAT_INDICES_PATH = "/_cat/indices";
const CAT_INDICES_QUERY = "format=json&bytes=b";

/** Cluster health (fixtures `es-cluster-health.json`, `os-cluster-health.json`). */
const CLUSTER_HEALTH_PATH = "/_cluster/health";

/**
 * Where the cluster-wide store size lives - health carries no size at all on
 * either product. Measured on both: `indices.store.size_in_bytes` (5913 on the
 * Elasticsearch probe, 178811 on the OpenSearch one), as a real JSON NUMBER, which
 * is the one place in this file where a count is not a string.
 */
const CLUSTER_STATS_PATH = "/_cluster/stats";

/** The mapping of one index (fixtures `es-mapping.json`, `os-mapping.json`). */
const MAPPING_SUFFIX = "/_mapping";

/**
 * The paging token an engine attaches when it has not sent every row.
 *
 * Measured on Elasticsearch 9.1.4: present on an AGGREGATION result even though no
 * `fetch_size` was requested - a `GROUP BY` over 1500 distinct values answered 1000
 * rows plus this field. Both products spell it the same way.
 */
const CURSOR_FIELD = "cursor";

/**
 * How many pages one statement may follow before the transport refuses.
 *
 * The engine decides when to stop sending pages, so this is the bound that keeps a
 * seam method from becoming an unbounded remote loop. At the measured page size of
 * 1000 rows this is a million-row ceiling: it exists to fail loudly on a
 * pathological statement, not to trim a normal result.
 */
const MAX_PAGES = 1000;

/**
 * The `_cat/indices` columns this transport reads, by their wire spelling.
 *
 * `pri.store.size` rather than `store.size`: the seam promises PRIMARY store size,
 * and the two differ the moment a replica is assigned. Measured on the probe
 * clusters they happen to be equal, which is exactly why the choice has to be made
 * deliberately here instead of discovered later.
 */
const CAT_FIELDS = Object.freeze({
  NAME: "index",
  STATUS: "status",
  DOC_COUNT: "docs.count",
  PRIMARY_SIZE: "pri.store.size",
} as const);

/** The version payload's nesting, measured identical on both products. */
const VERSION_FIELDS = Object.freeze({
  VERSION: "version",
  NUMBER: "number",
  /**
   * OpenSearch sends `"distribution":"opensearch"`; Elasticsearch sends no such
   * field at all. The fork added it precisely so a client could tell the two
   * apart, so its ABSENCE is Elasticsearch's signature and the fallback below is
   * a reading of the payload rather than a guess about it.
   */
  DISTRIBUTION: "distribution",
} as const);

/** Product name to report when the version payload names no distribution. */
const UNDISTRIBUTED_PRODUCT = "elasticsearch";

/** `_cluster/health` fields, measured present on both (OpenSearch adds others we ignore). */
const HEALTH_FIELDS = Object.freeze({
  STATUS: "status",
  CLUSTER_NAME: "cluster_name",
  NODE_COUNT: "number_of_nodes",
  ACTIVE_SHARDS: "active_shards",
  UNASSIGNED_SHARDS: "unassigned_shards",
} as const);

/** `_cluster/stats` nesting for the one number this transport takes from it. */
const STATS_FIELDS = Object.freeze({
  INDICES: "indices",
  STORE: "store",
  SIZE_IN_BYTES: "size_in_bytes",
} as const);

/**
 * Mapping payload nesting, measured identical on both products:
 * `{"<index>":{"mappings":{"properties":{...}}}}`, where a leaf carries `type`, a
 * container carries `properties`, and a multi-field carries `fields`.
 */
const MAPPING_FIELDS = Object.freeze({
  MAPPINGS: "mappings",
  PROPERTIES: "properties",
  FIELDS: "fields",
  TYPE: "type",
} as const);

/**
 * The type name given to a mapping node that declares none.
 *
 * Measured: `address` in `{"address":{"properties":{"city":{"type":"keyword"}}}}`
 * has NO `type`, and Elasticsearch's own `DESCRIBE` calls that node an `object`. So
 * this is the engine's word for the node, not our label for a gap.
 */
const CONTAINER_TYPE = "object";

/** Error-envelope fields. Both products nest under `error`; the members differ. */
const ERROR_FIELDS = Object.freeze({
  ENVELOPE: "error",
  /** The fault name on both - an ES snake_case type, an OpenSearch Java class. */
  TYPE: "type",
  /** Human text on both. On OpenSearch it is a constant banner, hence `DETAILS`. */
  REASON: "reason",
  /**
   * OpenSearch only, and the ONLY member carrying anything specific: measured,
   * `reason` is the literal string "Invalid SQL query" for a mistyped keyword, an
   * unknown column and an unparseable LIMIT alike, while `details` holds "Query
   * must start with SELECT, DELETE, SHOW or DESCRIBE: SELEKT 1" /
   * "can't resolve Symbol(namespace=FIELD_NAME, name=nosuchfield) in type env" /
   * "For input string: \"abc\"".
   */
  DETAILS: "details",
} as const);

/**
 * The trailing sentence OpenSearch appends to `details`, and the reason it is
 * removed: it instructs the reader to re-send the request in another format to see
 * the raw engine response, which is advice about OpenSearch's own REST API and not
 * about the statement the user just wrote. Measured verbatim in
 * `os-sql-missing-index.json`.
 */
const OPENSEARCH_DETAILS_FOOTER = /\s*For more details, please send request for Json format[\s\S]*$/;

/** HTTP statuses whose meaning HTTP itself fixes, so no body is needed. See the header. */
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/**
 * Index names the engine created for its own bookkeeping.
 *
 * Both products mark their own with a leading dot by convention. The exception,
 * measured on a stock OpenSearch 3.8.0 with nothing indexed by hand, is the
 * query-insights index `top_queries-2026.08.18-74305` - dateless-prefix, date, and
 * a numeric suffix - which carries no dot at all. Two of the three indices on that
 * empty cluster were therefore not the user's, and one of them is only
 * recognisable by name shape, which is why the seam exposes a FLAG the provider
 * decides about rather than a filter applied here.
 */
const DOT_PREFIXED = /^\./;
const OPENSEARCH_QUERY_INSIGHTS = /^top_queries-\d{4}\.\d{2}\.\d{2}-\d+$/;

// ============================================================================
// The dialect table: everything the two products disagree about
// ============================================================================

/**
 * One product's wire dialect.
 *
 * Every field here is something that was MEASURED to differ. Anything the two
 * agree on is a module constant above, so this table stays a list of real
 * disagreements rather than a duplicated configuration of the whole protocol.
 */
interface SearchDialectSpec {
  /** How the product spells its own name in a message the user reads. */
  readonly label: string;
  /** The SQL endpoint, and the query string it needs (empty when it needs none). */
  readonly sqlPath: string;
  readonly sqlQuery: string;
  /** The success envelope's declared-columns key. */
  readonly columnsKey: string;
  /**
   * The declared-column member holding the user's alias, or null when the product
   * puts the alias in `name` itself.
   *
   * Measured 2026-08-19, `SELECT customer AS who FROM probe_orders`:
   * Elasticsearch declares `{"name":"who","type":"keyword"}` - the alias IS the
   * name - while OpenSearch declares `{"name":"customer","alias":"who",...}`. So
   * reading `name` alone labels the same statement's column `who` on one product
   * and `customer` on the other, which is a wrong label rather than a missing one.
   */
  readonly aliasKey: string | null;
  /** The success envelope's positional-rows key. */
  readonly rowsKey: string;
  /** The matching-document count key, or null when the product sends none. */
  readonly totalKey: string | null;
  /** The error member holding text specific to this failure, if any. */
  readonly detailKey: string | null;
  /** Fault name -> category, exact match. Only measured names appear. */
  readonly faults: Readonly<Record<string, SearchErrorCategory>>;
  /**
   * A last-resort shape rule for fault names this product generates from a
   * grammar, or null when it needs none.
   */
  readonly syntaxTypePattern: RegExp | null;
}

/**
 * The whole product difference, as data.
 *
 * Elasticsearch's `format=json` is not cosmetic: without it the endpoint answers
 * its own tabular text format, which has no column types in it at all. OpenSearch
 * needs no parameter - its default (`jdbc`) IS the `schema`/`datarows` envelope
 * parsed below (measured).
 */
const DIALECTS: Readonly<Record<SearchDialectId, SearchDialectSpec>> = Object.freeze({
  elasticsearch: {
    label: "Elasticsearch",
    sqlPath: "/_sql",
    sqlQuery: "format=json",
    columnsKey: "columns",
    // Elasticsearch folds the alias into `name`, so there is no separate member.
    aliasKey: null,
    rowsKey: "rows",
    // Measured: no `total` and no `size` anywhere in a successful answer, which is
    // why the seam makes `totalHits` nullable rather than defaulting it.
    totalKey: null,
    detailKey: null,
    /**
     * Measured, one probe per row:
     * - `SELEKT 1` and `INSERT INTO ...` -> `parsing_exception`. Both are the same
     *   fault to this engine: its grammar has no INSERT, so a rejected mutation is
     *   reported as "mismatched input 'INSERT' expecting {..., 'SELECT', ...}",
     *   indistinguishable from a typo. Calling that `syntax` reports what the
     *   engine actually said; calling it `unsupported` would be our inference.
     * - `SELECT * FROM nope_missing` and `SELECT nosuchfield FROM probe_orders` and
     *   `SELECT sillyfunc(1)` -> `verification_exception` ("Unknown index [...]",
     *   "Unknown column [...]", "Unknown function [...]"): the statement parsed and
     *   named something absent, which is `unknown-object` in all three cases.
     * - `GET /nope_missing/_mapping` -> `index_not_found_exception`, HTTP 404. Same
     *   category, different endpoint, which is why introspection needs it here.
     * - `SELECT 1/0` -> `arithmetic_exception` at HTTP **500**. Reached, understood
     *   and refused: `engine`, and emphatically not a transport fault.
     */
    faults: {
      parsing_exception: "syntax",
      verification_exception: "unknown-object",
      index_not_found_exception: "unknown-object",
      arithmetic_exception: "engine",
    },
    // Not needed: every grammar rejection measured here is `parsing_exception`.
    syntaxTypePattern: null,
  },
  opensearch: {
    label: "OpenSearch",
    sqlPath: "/_plugins/_sql",
    sqlQuery: "",
    columnsKey: "schema",
    aliasKey: "alias",
    rowsKey: "datarows",
    totalKey: "total",
    detailKey: ERROR_FIELDS.DETAILS,
    /**
     * Measured, one probe per row. The names are Java classes, so the table is
     * doing real work: nothing about `EOFParserException` reads as "syntax" to
     * anything but this table.
     * - `SELEKT 1`, `INSERT INTO ...` and `DELETE FROM probe_orders WHERE id = 99`
     *   -> `SQLFeatureNotSupportedException`, "Query must start with SELECT,
     *   DELETE, SHOW or DESCRIBE: ...". Note the ASYMMETRY this creates with
     *   Elasticsearch, which is not papered over: a mistyped leading keyword is
     *   `syntax` there and `unsupported` here, because that is what each engine
     *   claims about it. DELETE landing here also confirms the seam's note that
     *   OpenSearch's DELETE support is off by default.
     * - `SELECT * FROM nope_missing` -> `IndexNotFoundException`, HTTP 404.
     * - `GET /nope_missing/_mapping` -> `index_not_found_exception`, HTTP 404, in
     *   snake_case. Measured, and worth stating plainly: OpenSearch's SQL PLUGIN
     *   reports Java class names while its CORE REST layer keeps Elasticsearch's
     *   lineage and its snake_case names, so one product speaks both vocabularies
     *   depending on which endpoint answered. A live probe of `mapping()` is what
     *   caught this - the SQL fixtures alone would have left a missing index
     *   reported as an engine fault by introspection.
     * - `SELECT nosuchfield ...` -> `SemanticCheckException`, "can't resolve
     *   Symbol(namespace=FIELD_NAME, name=nosuchfield) in type env".
     * - `SELECT FROM probe_orders` -> `ParserException`; `SELECT * FROM x WHERE`
     *   -> `EOFParserException`; `... LIMIT abc` -> `NumberFormatException`. All
     *   three are the parser refusing text.
     * - `SELECT 1 AS c, 2 AS c` -> `IllegalArgumentException`, "Multiple entries
     *   with same key". `SELECT sillyfunc(1)` -> `NullPointerException` (a genuine
     *   engine-side NPE inside the parser). Neither is classifiable beyond
     *   "refused", so both land in `engine` by omission rather than by a guess.
     */
    faults: {
      SQLFeatureNotSupportedException: "unsupported",
      IndexNotFoundException: "unknown-object",
      index_not_found_exception: "unknown-object",
      SemanticCheckException: "unknown-object",
      NumberFormatException: "syntax",
    },
    /**
     * `ParserException` and `EOFParserException` were both measured; the shared
     * suffix is this product's own naming for parser faults, and matching it means
     * a third one (its grammar has several) is classified correctly the first time
     * a user hits it rather than reported as an engine fault.
     */
    syntaxTypePattern: /ParserException$/,
  },
});

// ============================================================================
// Pure helpers
// ============================================================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Bracket a bare IPv6 literal, which is otherwise not a legal URL authority. */
function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** A field the payload reported as usable text, or null when it reported none. */
function textField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A number the payload reported, or null when it reported nothing usable.
 *
 * String input is the NORMAL case, not a fallback: `_cat` quotes every number it
 * sends, even under `bytes=b` (measured, `"pri.store.size":"5913"`). A closed index
 * sends JSON `null` for the same fields, and `Number(null)` is 0, so the null and
 * empty-string cases are rejected explicitly - reporting a closed index as holding
 * zero bytes would be a claim the server never made.
 */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A count the payload sent as a real number, or 0 when it sent nothing usable. */
function toCount(value: unknown): number {
  return toNumberOrNull(value) ?? 0;
}

// ============================================================================
// The result envelope
// ============================================================================

/** What an answer that described no columns can honestly say about them. */
const UNDESCRIBED = Object.freeze({ fieldNames: null, columnTypes: null });

/** One declared column, as both products spell it inside their own columns key. */
interface DeclaredColumn {
  name?: unknown;
  type?: unknown;
}

/**
 * The declared names, made unique.
 *
 * Measured on Elasticsearch: `SELECT 1 AS c, 2 AS c, 3 AS c` answers HTTP 200 with
 * three columns all named `c` and the row `[1,2,3]`. A `SearchRow` is a record, so
 * without this the second and third values would vanish BEFORE the seam rather
 * than after it, and `columnTypes` would silently describe only the last of them.
 * The suffix keeps climbing because `SELECT 1 AS c, 2 AS "c (2)", 3 AS c` is legal
 * too, and uniqueness is the invariant the seam states.
 *
 * On OpenSearch this can never fire - the same statement is refused with
 * `IllegalArgumentException`, "Multiple entries with same key: c=3 and c=2" - which
 * is a difference between the engines, not a reason to make the transport branch.
 */
function disambiguate(declared: readonly string[]): string[] {
  const taken = new Set<string>();

  return declared.map((name) => {
    let unique = name;
    for (let repeat = 2; taken.has(unique); repeat += 1) unique = `${name} (${repeat})`;
    taken.add(unique);
    return unique;
  });
}

/**
 * Declared order and types, or nulls when the envelope described neither.
 *
 * The types are copied verbatim because they are MAPPING types, not SQL types
 * (measured: `SELECT customer, total FROM probe_orders` declares `keyword` and
 * `double` on both products, and `SELECT note` declares `text`). That is the same
 * vocabulary `mapping()` reports, which is what keeps the grid and the schema tree
 * speaking one language.
 */
function describeColumns(
  spec: SearchDialectSpec,
  envelope: Record<string, unknown>,
): Pick<SearchQueryResult, "fieldNames" | "columnTypes"> {
  const declared = envelope[spec.columnsKey];
  if (!Array.isArray(declared)) return UNDESCRIBED;

  const columns = declared as DeclaredColumn[];
  // The alias is what the user typed and therefore what the grid must show. Only
  // OpenSearch keeps it separate from `name`; see `aliasKey` for the measurement.
  const fieldNames = disambiguate(
    columns.map((column) => {
      const alias = spec.aliasKey === null ? undefined : (column as Record<string, unknown>)[spec.aliasKey];
      return String(typeof alias === "string" && alias.length > 0 ? alias : column.name);
    }),
  );

  return {
    fieldNames,
    // A column whose declaration carried no type name is left OUT rather than
    // given a placeholder: an invented type would be indistinguishable from one
    // the engine sent.
    columnTypes: Object.fromEntries(
      fieldNames.flatMap((name, index) => {
        const type = columns[index]?.type;
        return typeof type === "string" ? [[name, type]] : [];
      }),
    ),
  };
}

/** One positional row, rebuilt as the record the seam promises. */
function toRow(fieldNames: readonly string[], row: unknown): SearchRow {
  const values = Array.isArray(row) ? (row as unknown[]) : [];

  // `?? null` normalizes a row shorter than its declaration: measured never to
  // happen, but the alternative is a key whose value is `undefined`, which the
  // seam's "exactly the key set of every row" invariant does not allow.
  return Object.fromEntries(fieldNames.map((name, column) => [name, values[column] ?? null]));
}

/**
 * The rows and their description.
 *
 * A body that describes no columns yields no rows either, and says so with nulls -
 * measured, both products answer every accepted statement with a full declaration
 * (`SELECT * FROM probe_orders WHERE 1 = 0` still declares its columns), so an
 * undescribed body means something between here and the engine rewrote it. Saying
 * "no columns" is honest; fabricating names from the first row would not be, and
 * the seam's note about an all-null first row is exactly that argument.
 */
/**
 * Rebuild a later page's rows against page one's column declaration.
 *
 * Measured: a second page carries its rows and NO column declaration at all, so
 * there is nothing on it to derive names from. The names therefore have to come
 * from the caller, which is also the only way the seam's "these names are exactly
 * the key set of every row" invariant can hold across pages.
 */
function rebuildRows(
  spec: SearchDialectSpec,
  envelope: Record<string, unknown>,
  fieldNames: readonly string[] | null,
): SearchRow[] {
  const rows = envelope[spec.rowsKey];
  if (fieldNames === null || !Array.isArray(rows)) return [];

  return (rows as unknown[]).map((row) => toRow(fieldNames, row));
}

function toQueryResult(spec: SearchDialectSpec, envelope: Record<string, unknown>): SearchQueryResult {
  const described = describeColumns(spec, envelope);
  const rows = envelope[spec.rowsKey];

  return {
    rows:
      described.fieldNames === null || !Array.isArray(rows)
        ? []
        : (rows as unknown[]).map((row) => toRow(described.fieldNames as string[], row)),
    ...described,
    // Null on Elasticsearch by construction (`totalKey` is null): the product
    // sends no count, and the seam requires "unknown" rather than zero.
    totalHits: spec.totalKey === null ? null : toNumberOrNull(envelope[spec.totalKey]),
  };
}

// ============================================================================
// Failures
// ============================================================================

/** Text that describes the failure without naming the endpoint that reported it. */
function faultMessage(spec: SearchDialectSpec, error: Record<string, unknown>): string | null {
  const detail = spec.detailKey === null ? null : textField(error, spec.detailKey);
  const reason = textField(error, ERROR_FIELDS.REASON);

  // The detail comes first because on OpenSearch the reason is a constant banner
  // ("Invalid SQL query") that identifies nothing; on Elasticsearch there is no
  // detail and the reason is the good text ("line 1:15: Unknown index [...]").
  if (detail === null) return reason;

  const trimmed = detail.replace(OPENSEARCH_DETAILS_FOOTER, "").trim();
  return trimmed === "" ? reason : trimmed;
}

/**
 * The category the body describes.
 *
 * Nothing here reads the HTTP status: see the header for the two measured
 * directions in which it lies. An unrecognised fault name becomes `engine`
 * ("reached, understood, and refused") rather than a guess, because the honest
 * report for a name this table has never seen is that the engine refused the
 * statement - not a claim about why.
 */
function categorize(spec: SearchDialectSpec, engineType: string | null): SearchErrorCategory {
  if (engineType === null) return "engine";
  if (engineType in spec.faults) return spec.faults[engineType] as SearchErrorCategory;

  return spec.syntaxTypePattern?.test(engineType) ? "syntax" : "engine";
}

/**
 * The failure a non-OK response describes.
 *
 * Three shapes, all measured, in the order they have to be tested:
 *
 * 1. HTTP 401/403 - `auth`, decided on the status because security is disabled on
 *    both probe clusters and no such body could be captured (see the header). This
 *    goes first precisely because it is the one case where the status is the
 *    evidence and the body is not.
 * 2. `error` as a STRING - `unreachable`. Measured only from requests that never
 *    reached the SQL engine at all: the wrong product's endpoint path (ES, HTTP
 *    400, "no handler found for uri [/_plugins/_sql]"), the wrong HTTP method
 *    (OpenSearch, HTTP 405) and a missing content type (both, HTTP 406). "The SQL
 *    plugin is not installed" is the seam's own wording for that category, and it
 *    is the same wire evidence.
 * 3. `error` as an OBJECT - the engine's own fault, classified by name.
 *
 * A body none of the three fits degrades to `engine` naming the status, because at
 * that point the status is the only thing that was actually observed.
 */
function responseFailure(spec: SearchDialectSpec, status: number, text: string): SearchTransportError {
  const fallback = `${spec.label} rejected the request with HTTP ${status}`;
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return new SearchTransportError("auth", `${spec.label} refused the credentials (HTTP ${status})`);
  }

  const envelope = asRecord(parseJson(text))?.[ERROR_FIELDS.ENVELOPE];
  if (typeof envelope === "string") {
    return new SearchTransportError(
      "unreachable",
      `${spec.label} did not route the request to its SQL endpoint: ${envelope}`,
    );
  }

  const error = asRecord(envelope);
  if (error === null) return new SearchTransportError("engine", fallback);

  const engineType = textField(error, ERROR_FIELDS.TYPE);
  // The engine's own wording is carried through verbatim: it is the only text that
  // tells the user WHICH part of their statement is wrong, and rewriting it would
  // throw away "line 1:15: Unknown index [nope_missing]".
  return new SearchTransportError(
    categorize(spec, engineType),
    faultMessage(spec, error) ?? fallback,
    engineType ?? undefined,
  );
}

/**
 * The failure a thrown `fetch` describes.
 *
 * `signal.aborted` is consulted BEFORE the thrown value, because the thrown value
 * is not reliably an abort error. Measured on Node 24 and on Bun:
 *
 *     controller.abort()                  -> DOMException, name "AbortError"
 *     controller.abort(new Error("x"))    -> that Error, verbatim: name "Error"
 *     AbortSignal.timeout(1)              -> DOMException, name "TimeoutError"
 *
 * So a caller who aborts WITH a reason - which is the normal way to attach "the
 * user closed the tab" to a cancellation - produces a value with nothing
 * abort-shaped about it, and a name-only test would have reported that as an
 * unreachable cluster. The signal knows; the error does not.
 *
 * `timeout` is separated from `cancelled` by the reason's name, because the two
 * mean different things to the person reading the message: one is theirs, the
 * other is a deadline they may not have set.
 *
 * The unreachable case is measured too, and is why the message quotes the cause
 * from BOTH places a runtime puts it: on Node a refused socket is
 * `TypeError: fetch failed` whose `cause.code` is `ECONNREFUSED` (`ENOTFOUND` for
 * an unresolvable host), while Bun throws `Error: Unable to connect. Is the
 * computer able to access the url?` with `code: "ConnectionRefused"` on the error
 * ITSELF and no cause at all (an unresolvable host is `FailedToOpenSocket`, "Was
 * there a typo in the url or port?"). Neither runtime's top-level message names the
 * host or the reason on its own, and this repo runs on both (Bun in dev and in the
 * image, Node in the published package), so reading only one place would leave the
 * other runtime's users with a message that says nothing.
 */
function requestFailure(spec: SearchDialectSpec, cause: unknown, signal?: AbortSignal): SearchTransportError {
  if (signal?.aborted === true) {
    const reason = signal.reason as { name?: unknown } | undefined;
    const timedOut = reason?.name === "TimeoutError";

    return new SearchTransportError(
      timedOut ? "timeout" : "cancelled",
      timedOut
        ? `The ${spec.label} request ran past its deadline and was abandoned`
        : `The ${spec.label} request was cancelled`,
    );
  }

  const error = (cause instanceof Error ? cause : null) as (Error & { code?: unknown }) | null;
  const detail = [
    error?.message ?? String(cause),
    error?.code ?? (error?.cause as { code?: unknown } | undefined)?.code,
  ]
    .filter((part) => typeof part === "string" && part !== "")
    .join(": ");

  return new SearchTransportError("unreachable", `${spec.label} could not be reached: ${detail}`);
}

/** A body the server announced as JSON that is not the object this file parses. */
function unreadableBody(spec: SearchDialectSpec, what: string): SearchTransportError {
  return new SearchTransportError("engine", `${spec.label} answered ${what} the client could not read`);
}

// ============================================================================
// Introspection payloads
// ============================================================================

/** One row of the `_cat/indices` listing, as measured. */
function toIndexInfo(row: Record<string, unknown>): SearchIndexInfo {
  const name = String(row[CAT_FIELDS.NAME] ?? "");

  return {
    name,
    docCount: toNumberOrNull(row[CAT_FIELDS.DOC_COUNT]),
    sizeBytes: toNumberOrNull(row[CAT_FIELDS.PRIMARY_SIZE]),
    // Copied verbatim: the seam promises the engine's own word, and both products
    // say `open` / `close` (not "closed" - measured).
    status: String(row[CAT_FIELDS.STATUS] ?? ""),
    isSystem: DOT_PREFIXED.test(name) || OPENSEARCH_QUERY_INSIGHTS.test(name),
  };
}

/**
 * One mapping level, flattened to dotted paths.
 *
 * The output set is specified by Elasticsearch's own `DESCRIBE`, measured on an
 * index mapping `note` (text + `keyword` multi-field) and `address.city`:
 *
 *     address        STRUCT   object
 *     address.city   VARCHAR  keyword
 *     note           VARCHAR  text
 *     note.keyword   VARCHAR  keyword
 *
 * Containers appear, leaves appear, and a multi-field appears as a CHILD - and
 * `SELECT note.keyword, address.city FROM probe_shapes` then returns both columns,
 * so the dotted child is genuinely selectable and not a display convenience. Both
 * `properties` (objects) and `fields` (multi-fields) are therefore descended, and
 * either one makes `hasSubfields` true.
 *
 * Nothing outside `properties` is read. Measured: OpenSearch's own
 * `.plugins-ml-config` mapping carries a sibling `_meta` object at the same level,
 * which is metadata about the mapping rather than a field in it.
 */
function flattenProperties(
  properties: Record<string, unknown>,
  prefix: string,
  /**
   * True while descending a `fields` object, so every path produced below it is
   * marked as a multi-field. It is inherited rather than recomputed because a
   * multi-field's own children are still multi-fields as far as SQL is concerned.
   */
  underMultiField = false,
): SearchMappingField[] {
  return Object.entries(properties).flatMap(([name, raw]) => {
    const definition = asRecord(raw);
    if (definition === null) return [];

    const path = prefix === "" ? name : `${prefix}.${name}`;
    const children = asRecord(definition[MAPPING_FIELDS.PROPERTIES]);
    const multiFields = asRecord(definition[MAPPING_FIELDS.FIELDS]);
    const declared = definition[MAPPING_FIELDS.TYPE];

    const self: SearchMappingField = {
      path,
      // A node with children and no `type` is the implicit object the engine
      // itself calls `object`; see CONTAINER_TYPE.
      type: typeof declared === "string" ? declared : CONTAINER_TYPE,
      hasSubfields: children !== null || multiFields !== null,
      isMultiField: underMultiField,
    };

    return [self].concat(
      children === null ? [] : flattenProperties(children, path, underMultiField),
      // Everything below `fields` is a multi-field, whatever it is nested in.
      multiFields === null ? [] : flattenProperties(multiFields, path, true),
    );
  });
}

// ============================================================================
// Transport
// ============================================================================

export class SearchHttpTransport implements SearchTransport {
  public readonly dialect: SearchDialectId;

  private readonly spec: SearchDialectSpec;
  private readonly origin: string;
  private readonly authorization: string | undefined;

  constructor(dialect: SearchDialectId, config: DatabaseConnection) {
    this.dialect = dialect;
    this.spec = DIALECTS[dialect];
    // `ssl` is a first-class connection field and independent of the form's
    // `connectionFields`, and an explicit `disable` has to turn TLS OFF as well as
    // an explicit mode turns it on (the #264 lesson). No connection-string parsing:
    // this provider is configured by host and port, like Druid.
    const secure = config.ssl !== undefined && config.ssl.mode !== "disable";
    const host = formatHost(config.host ?? DEFAULT_HOST);
    this.origin = `${secure ? "https" : "http"}://${host}:${config.port ?? DEFAULT_PORT}`;
    // Measured on both probe clusters, which run with security disabled: a bogus
    // `Basic` header is IGNORED (HTTP 200), so credentials are optional and sending
    // none is the normal local case. When they are configured they are for the
    // product's security plugin, whose refusal this transport reads off the status.
    this.authorization = config.user
      ? `Basic ${Buffer.from(`${config.user}:${config.password ?? ""}`).toString("base64")}`
      : undefined;
  }

  /**
   * Run one SQL statement, following the engine's pages until it stops sending
   * them.
   *
   * The paging is NOT an optimisation, it is a correctness fix, and it exists
   * because an earlier version of this file asserted the opposite. Measured
   * 2026-08-19 on Elasticsearch 9.1.4: `SELECT k, COUNT(*) FROM probe_buckets
   * GROUP BY k` over an index holding 1500 distinct values answers HTTP 200 with
   * **1000 rows and a `cursor`** even though no `fetch_size` was ever requested -
   * an aggregation is paged by the engine's own default. Dropping that cursor
   * returned two thirds of the buckets and labelled the result complete, which is
   * worse than an error: a user reading a GROUP BY has no way to notice 500
   * missing groups. Following it retrieves exactly the remaining 500 and the
   * second page carries NO cursor, so the loop terminates on the engine's word.
   *
   * Two traps the loop has to respect, both measured on that same run:
   * - page two answers with rows and NO `columns` member at all, so the column
   *   declaration comes from page one and must be carried forward rather than
   *   re-read;
   * - `MAX_PAGES` bounds the loop because the terminating condition is the
   *   server's, and a seam must not offer an unbounded remote loop. Hitting it is
   *   reported rather than silently accepted - the failure mode being fixed here
   *   is precisely a truncation nobody was told about.
   *
   * On the abort the seam asks about: aborting closes the CLIENT's socket and
   * nothing else. No cancellation request is sent, because neither product's SQL
   * endpoint offers one for a RUNNING statement - measured, Elasticsearch's
   * `POST /_sql/close` exists (a bogus cursor answers HTTP 400 rather than "no
   * handler found") but it closes a paging cursor. So the cluster finishes the
   * query it was given after a cancellation, which is what the `cancelled` message
   * must not pretend otherwise about. A cursor this method is still holding when it
   * stops early is closed on the way out, because that one IS server-side state.
   */
  public async query(sql: string, signal?: AbortSignal): Promise<SearchQueryResult> {
    const path = `${this.spec.sqlPath}${this.spec.sqlQuery === "" ? "" : `?${this.spec.sqlQuery}`}`;

    const first = asRecord(await this.request(path, signal, JSON.stringify({ query: sql })));
    if (first === null) throw unreadableBody(this.spec, "a SQL result");

    const result = toQueryResult(this.spec, first);
    let cursor = textField(first, CURSOR_FIELD);
    let pages = 1;

    while (cursor !== null && cursor !== "" && pages < MAX_PAGES) {
      const next = asRecord(await this.request(path, signal, JSON.stringify({ cursor })));
      if (next === null) throw unreadableBody(this.spec, "a SQL result page");

      // The column declaration is page one's; `result.fieldNames` is what the rows
      // of every later page are rebuilt against.
      result.rows.push(...rebuildRows(this.spec, next, result.fieldNames));
      cursor = textField(next, CURSOR_FIELD);
      pages += 1;
    }

    if (cursor !== null && cursor !== "") {
      // Close the cursor we are abandoning, then say so. Silence here would
      // reintroduce the exact defect this loop was written to remove.
      await this.closeCursor(cursor, signal);
      throw new SearchTransportError(
        "engine",
        `${this.spec.label} returned more result pages than this connection will follow (${MAX_PAGES}). ` +
          `Narrow the statement - add a LIMIT or a tighter WHERE - so the result fits.`,
      );
    }

    return result;
  }

  /**
   * Release a paging cursor we are not going to finish reading.
   *
   * Best-effort by design: the statement already produced everything the caller
   * will see, and failing the whole query because a cleanup call failed would turn
   * a served result into an error. Elasticsearch frees the cursor on its own
   * keep-alive expiry anyway; this only shortens the window.
   */
  private async closeCursor(cursor: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.request(`${this.spec.sqlPath}/close`, signal, JSON.stringify({ cursor }));
    } catch {
      // Deliberately swallowed; see the doc comment.
    }
  }

  public async version(signal?: AbortSignal): Promise<{ version: string; product: string }> {
    const version = asRecord(asRecord(await this.request(ROOT_PATH, signal))?.[VERSION_FIELDS.VERSION]);
    if (version === null) throw unreadableBody(this.spec, "a version payload");

    return {
      version: textField(version, VERSION_FIELDS.NUMBER) ?? "",
      product: textField(version, VERSION_FIELDS.DISTRIBUTION) ?? UNDISTRIBUTED_PRODUCT,
    };
  }

  public async indices(signal?: AbortSignal): Promise<SearchIndexInfo[]> {
    const listing = await this.request(`${CAT_INDICES_PATH}?${CAT_INDICES_QUERY}`, signal);
    if (!Array.isArray(listing)) throw unreadableBody(this.spec, "an index listing");

    return (listing as unknown[]).flatMap((row) => {
      const record = asRecord(row);
      return record === null ? [] : [toIndexInfo(record)];
    });
  }

  public async mapping(index: string, signal?: AbortSignal): Promise<SearchMappingField[]> {
    const payload = asRecord(await this.request(`/${encodeURIComponent(index)}${MAPPING_SUFFIX}`, signal));
    if (payload === null) throw unreadableBody(this.spec, "a mapping");

    // Keyed by the CONCRETE index name, which is not necessarily the name asked
    // for - an alias resolves to the index behind it - so the single entry is
    // taken rather than looked up by `index`.
    const mappings = asRecord(asRecord(Object.values(payload)[0])?.[MAPPING_FIELDS.MAPPINGS]);
    const properties = asRecord(mappings?.[MAPPING_FIELDS.PROPERTIES]);
    // Measured on both: an index created with no mapping answers
    // `{"<index>":{"mappings":{}}}` - a present, EMPTY object. That is a fact about
    // the index, and the seam says an empty list, not an error.
    return properties === null ? [] : flattenProperties(properties, "");
  }

  public async health(signal?: AbortSignal): Promise<SearchClusterHealth> {
    const health = asRecord(await this.request(CLUSTER_HEALTH_PATH, signal));
    if (health === null) throw unreadableBody(this.spec, "a cluster health payload");

    return {
      status: String(health[HEALTH_FIELDS.STATUS] ?? ""),
      clusterName: String(health[HEALTH_FIELDS.CLUSTER_NAME] ?? ""),
      nodeCount: toCount(health[HEALTH_FIELDS.NODE_COUNT]),
      activeShards: toCount(health[HEALTH_FIELDS.ACTIVE_SHARDS]),
      unassignedShards: toCount(health[HEALTH_FIELDS.UNASSIGNED_SHARDS]),
      storeSizeBytes: await this.storeSizeBytes(signal),
    };
  }

  /**
   * Cluster-wide store size, from the second call health needs.
   *
   * Its failure is swallowed on purpose: `_cluster/stats` is a heavier, more
   * privileged call than `_cluster/health`, so a cluster that answers health and
   * refuses stats is an ordinary configuration - and losing the health status over
   * a missing byte count would blank a monitoring panel that had the important
   * number already. Null is the seam's "unknown", which is exactly what happened.
   */
  private async storeSizeBytes(signal?: AbortSignal): Promise<number | null> {
    try {
      const stats = asRecord(await this.request(CLUSTER_STATS_PATH, signal));
      const store = asRecord(asRecord(stats?.[STATS_FIELDS.INDICES])?.[STATS_FIELDS.STORE]);

      return toNumberOrNull(store?.[STATS_FIELDS.SIZE_IN_BYTES]);
    } catch {
      return null;
    }
  }

  /**
   * One request, and the only place `fetch` is called.
   *
   * The signal covers the request AND the body read: a response whose headers
   * arrive promptly can still stall mid-body, and awaiting `text()` is otherwise
   * unbounded. Passing it to `fetch` covers both, which a timer around `fetch`
   * alone would not.
   *
   * The body is drained as text before anything is parsed, so a failure envelope
   * and a result envelope are read the same way - and so a non-OK response is
   * described by its body rather than by its status.
   */
  private async request(path: string, signal?: AbortSignal, body?: string): Promise<unknown> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          // Sent on GETs too: harmless, and it keeps one header block for one
          // request helper. A POST without it is refused with HTTP 406 on both
          // products (measured).
          "content-type": JSON_CONTENT_TYPE,
          ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
        },
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
      });
      text = await response.text();
    } catch (error) {
      // A refused socket, an unresolvable host, an abort and a truncated body all
      // arrive here, and all have to leave as the seam's own error type.
      throw requestFailure(this.spec, error, signal);
    }

    if (!response.ok) throw responseFailure(this.spec, response.status, text);

    return parseJson(text);
  }
}
