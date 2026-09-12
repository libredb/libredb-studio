/**
 * OpenSearch Provider Integration Tests (issue #424, Phase 1)
 *
 * globalThis.fetch is replaced per test and restored in afterEach, so the real
 * transport, the real introspection and the real provider all run - only the
 * cluster is fake. mock.module() is deliberately not used: it is process-wide in
 * bun and would poison sibling test files.
 *
 * Every payload below was captured from a live OpenSearch 3.8.0 cluster on
 * 2026-08-19 (security disabled, stock single node, indices `probe_orders` and
 * `probe_shapes`), so the fake speaks exactly what the server speaks.
 *
 * THIS FILE'S JOB IS THE DIVERGENCE. One implementation serves two type-ids
 * (`src/lib/db/providers/sql/search/index.ts:11-16`), and the Elasticsearch
 * sibling covers the behaviour the two share; what is asserted here is what
 * OpenSearch does DIFFERENTLY, so that "two type-ids, one implementation" is a
 * tested claim rather than an assumption. The seven measured differences the
 * assertions below are built on:
 *
 * - The success envelope is `schema`/`datarows` with `total` and `size` beside it,
 *   not Elasticsearch's `columns`/`rows` with no count at all
 *   (`http-transport.ts:357-364`).
 * - `SELECT customer AS who` declares `{"name":"customer","alias":"who"}` here and
 *   `{"name":"who"}` on Elasticsearch, so reading `name` alone would put the WRONG
 *   label on the same statement's column (`http-transport.ts:285-295`).
 * - A missing index is HTTP **404** (`IndexNotFoundException`) where Elasticsearch
 *   answers HTTP 400 - the same typo, two statuses, which is why categorisation is
 *   body-driven (`http-transport.ts:35-42`).
 * - The SQL plugin names its faults with JAVA CLASSES
 *   (`SQLFeatureNotSupportedException`, `SemanticCheckException`,
 *   `EOFParserException`, ...) while the CORE REST layer keeps Elasticsearch's
 *   lineage and answers `index_not_found_exception` in snake_case, so one product
 *   speaks both vocabularies depending on which endpoint replied
 *   (`http-transport.ts:377-384`).
 * - `SELECT 1 AS c, 2 AS c` is REFUSED here (`IllegalArgumentException`, "Multiple
 *   entries with same key") and answers 200 with three columns named `c` on
 *   Elasticsearch, so the seam's uniqueness invariant is load-bearing on exactly
 *   one of the two products (`http-transport.ts:24-31`).
 * - `LIMIT n OFFSET m` is accepted here and is a syntax error on Elasticsearch,
 *   which is the one behavioural difference ABOVE the wire (`index.ts:225-230`).
 * - A stock node ships system indices the dot rule alone does not catch:
 *   `.plugins-ml-config` AND `top_queries-<date>-<n>`, so two of four indices on a
 *   cluster holding two probe indices are not the user's
 *   (`http-transport.ts:252-264`).
 *
 * Where a divergence is only visible below the provider - a fault CATEGORY, for
 * instance, since four of them collapse onto one `QueryError` by design
 * (`index.ts:685-689`) - the transport is driven directly. That is the seam the
 * categorisation lives on, and asserting it through a class that erases it would
 * have tested nothing.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { ElasticsearchProvider, OpenSearchProvider } from "@/lib/db/providers/sql/search";
import { SearchHttpTransport } from "@/lib/db/providers/sql/search/http-transport";
import { type SearchErrorCategory, SearchTransportError } from "@/lib/db/providers/sql/search/transport";
import type { ProviderCapabilities } from "@/lib/db/types";
import { ConnectionError, QueryError } from "@/lib/db/errors";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

// ============================================================================
// Connection
// ============================================================================

const OPENSEARCH: DatabaseType = "opensearch";
const ELASTICSEARCH: DatabaseType = "elasticsearch";

/** The probe cluster: OpenSearch 3.8.0 on 9201, security disabled. */
function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "os-1",
    name: "OpenSearch",
    type: OPENSEARCH,
    host: "127.0.0.1",
    port: 9201,
    createdAt: new Date(),
    ...overrides,
  };
}

function transport(): SearchHttpTransport {
  return new SearchHttpTransport("opensearch", makeConnection());
}

// ============================================================================
// Success envelopes (captured verbatim from OpenSearch 3.8.0)
// ----------------------------------------------------------------------------
// `schema` / `datarows` / `total` / `size` / `status`, all five, on every answer.
// Elasticsearch's answer to the same statements carries `columns` / `rows` and
// nothing else - the asymmetry `SearchQueryResult.totalHits` is nullable for.
// ============================================================================

/** `SELECT 1` - the connect probe. Measured: one column literally named `1`. */
const PROBE_BODY = JSON.stringify({
  schema: [{ name: "1", type: "integer" }],
  datarows: [[1]],
  total: 1,
  size: 1,
  status: 200,
});

/**
 * `SELECT customer AS who FROM probe_orders`.
 *
 * The alias is a SEPARATE member here. Elasticsearch answers
 * `{"name":"who","type":"keyword"}` for the same statement, so a transport reading
 * `name` alone would label this column `customer` - the name the user aliased AWAY.
 */
const ALIASED_BODY = JSON.stringify({
  schema: [{ name: "customer", alias: "who", type: "keyword" }],
  datarows: [["acme"]],
  total: 1,
  size: 1,
  status: 200,
});

/** `SELECT id, customer, total FROM probe_orders` - mapping types, not SQL types. */
const ORDERS_BODY = JSON.stringify({
  schema: [
    { name: "id", type: "long" },
    { name: "customer", type: "keyword" },
    { name: "total", type: "double" },
  ],
  datarows: [[1, "acme", 99.5]],
  total: 1,
  size: 1,
  status: 200,
});

/**
 * `SELECT address, items FROM probe_shapes` - and it SUCCEEDS.
 *
 * Elasticsearch refuses the same projection ("Cannot use field [address] type
 * [object] only its subfields", HTTP 400). `introspect.ts:70-80` deliberately does
 * NOT branch on that: the starter query projects leaves on both products, because a
 * query that works on one type-id and fails on the other is worse than one that
 * works on both. The schema assertions below are what hold that decision in place.
 */
const CONTAINERS_BODY = JSON.stringify({
  schema: [
    { name: "address", type: "object" },
    { name: "items", type: "nested" },
  ],
  datarows: [[{ city: "Ankara" }, [{ sku: "A1" }]]],
  total: 1,
  size: 1,
  status: 200,
});

// ----------------------------------------------------------------------------
// Paging, measured by walking a cursor to its end
// ----------------------------------------------------------------------------
// `{"query":"SELECT id FROM top_queries-2026.08.18-74305","fetch_size":30}` over
// 67 documents answered THREE pages: 30 rows + cursor + total, then 30 rows +
// cursor and NOTHING else, then 7 rows and no cursor. So a later page carries no
// `schema`, no `total` and no `size` - exactly the shape Elasticsearch's later
// pages have, under the other rows key. The provider sends no `fetch_size`, so a
// cursor is not the normal case here; the loop is asserted because the rows key
// it rebuilds against is the one thing that differs.
// ----------------------------------------------------------------------------

const CURSOR_ONE = "d:eyJwIjoib18tN1FRRWNkRzl3WDNGMVpYSnBaWE10";
const CURSOR_TWO = "d:eyJwIjoiYlhrdGMyVmpiMjVrTFhCaFoyVXRZM1Z5";

const PAGE_ONE_BODY = JSON.stringify({
  schema: [{ name: "id", type: "keyword" }],
  cursor: CURSOR_ONE,
  total: 67,
  datarows: [["b7d2a470-2ba6-435c-a345-7991c20f0d86"], ["ed6ff224-3167-496c-a41c-d954421e0765"]],
  size: 2,
  status: 200,
});

/** Page two: rows and a cursor, and no column declaration to read them against. */
const PAGE_TWO_BODY = JSON.stringify({
  cursor: CURSOR_TWO,
  datarows: [["d5aca9b5-e1d9-43d9-a476-f065717d9a46"], ["16d4c3f4-86c3-48e7-a289-fee6d21135dc"]],
});

/** The last page: `datarows` alone. The loop terminates on the engine's word. */
const PAGE_THREE_BODY = JSON.stringify({ datarows: [["3c1f1d19-0a4b-4a52-9f6a-2b1c0d3e4f50"]] });

// ============================================================================
// Failure envelopes (captured verbatim)
// ----------------------------------------------------------------------------
// `reason` is a CONSTANT banner here ("Invalid SQL query") and `details` holds the
// only text specific to the failure, which is the reverse of Elasticsearch, whose
// `reason` is the good text ("line 1:15: Unknown index [nope_missing]") and which
// has no `details` at all. `http-transport.ts:600-611` prefers the detail for
// exactly that reason.
// ============================================================================

function sqlFault(type: string, details: string, status: number): Reply {
  return { status, body: JSON.stringify({ error: { reason: "Invalid SQL query", details, type }, status }) };
}

/**
 * The missing-index answer, HTTP **404** - Elasticsearch answers HTTP 400 for the
 * same typo. The trailing sentence is OpenSearch's own advice about re-sending the
 * request in another format, and `OPENSEARCH_DETAILS_FOOTER` strips it.
 */
const MISSING_INDEX_BODY = JSON.stringify({
  error: {
    reason: "Error occurred in OpenSearch engine: no such index [nope_missing]",
    details:
      "[nope_missing] IndexNotFoundException[no such index [nope_missing]]\n" +
      "For more details, please send request for Json format to see the raw response from OpenSearch engine.",
    type: "IndexNotFoundException",
  },
  status: 404,
});

/**
 * `GET /nope_missing/_mapping`, HTTP 404 - and the fault name is snake_case.
 *
 * The SQL plugin above answers `IndexNotFoundException` for the same missing
 * index; the CORE REST layer keeps Elasticsearch's lineage. Both are measured, and
 * `http-transport.ts:395-401` lists both spellings for that reason.
 */
const MAPPING_NOT_FOUND_BODY = JSON.stringify({
  error: {
    root_cause: [{ type: "index_not_found_exception", reason: "no such index [nope_missing]" }],
    type: "index_not_found_exception",
    reason: "no such index [nope_missing]",
    index: "nope_missing",
    "resource.type": "index_or_alias",
    index_uuid: "_na_",
  },
  status: 404,
});

/**
 * What OpenSearch answers a request for ELASTICSEARCH's SQL endpoint: HTTP 405,
 * and `error` as a STRING where a real engine fault spells it as an object. That
 * JSON type is the "this is not that product / the SQL plugin is not installed"
 * discriminator (`http-transport.ts:43-50`).
 */
const WRONG_ENDPOINT_BODY = JSON.stringify({
  error: "Incorrect HTTP method for uri [/_sql?format=json] and method [POST], allowed: [PUT, DELETE, HEAD, GET]",
  status: 405,
});

// ============================================================================
// Introspection and monitoring payloads (captured verbatim)
// ============================================================================

/**
 * `GET /_cat/indices?format=json&bytes=b`.
 *
 * Two facts this listing carries, both measured: every number is a STRING even
 * under `bytes=b`, and two of these four indices are the engine's own - one
 * dot-prefixed, one date-suffixed with no dot anywhere in it. Elasticsearch's
 * equivalent listing on a stock node has none of either.
 *
 * A third fact, not asserted because the transport deliberately sends no
 * `expand_wildcards`: this cluster also holds `.opensearch-sap-log-types-config`
 * (455 documents), which the default listing does NOT report because it is hidden.
 * So the provider's inventory is the visible indices, and that is what the numbers
 * below are.
 *
 * The last row is the data stream's BACKING INDEX, and it is here because the whole
 * argument for declaring `stream` as its own kind rests on it: a backing index is
 * `.ds-`-prefixed, so the index listing's own dot rule already hides it, which is why
 * a data stream is reachable through nothing in the tree without that kind AND why
 * counting both kinds double-counts nothing. Without this row that premise is prose;
 * with it, `index` is still 2 and `stream` is still 1.
 */
const CAT_INDICES_BODY = JSON.stringify([
  {
    health: "yellow",
    status: "open",
    index: ".ds-probe_stream-000001",
    uuid: "NzcJ_j43QlaXdvqSuGPRrA",
    pri: "1",
    rep: "1",
    "docs.count": "1",
    "docs.deleted": "0",
    "store.size": "5211",
    "pri.store.size": "5211",
  },
  {
    health: "green",
    status: "open",
    index: ".plugins-ml-config",
    uuid: "4qPAl0CbQwKHmLmfNwpS0w",
    pri: "1",
    rep: "0",
    "docs.count": "1",
    "docs.deleted": "0",
    "store.size": "4783",
    "pri.store.size": "4783",
  },
  {
    health: "yellow",
    status: "open",
    index: "probe_orders",
    uuid: "e4QJ354KTqyCX763SC2eag",
    pri: "1",
    rep: "1",
    "docs.count": "1",
    "docs.deleted": "0",
    "store.size": "4807",
    "pri.store.size": "4807",
  },
  {
    health: "yellow",
    status: "open",
    index: "probe_shapes",
    uuid: "ixRPSJQRTp2P1hyzU-HbGg",
    pri: "1",
    rep: "1",
    "docs.count": "2",
    "docs.deleted": "0",
    "store.size": "6070",
    "pri.store.size": "6070",
  },
  {
    health: "green",
    status: "open",
    index: "top_queries-2026.08.18-74305",
    uuid: "KhZng745RK2TcVooSMqQ0Q",
    pri: "1",
    rep: "0",
    "docs.count": "67",
    "docs.deleted": "0",
    "store.size": "119107",
    "pri.store.size": "119107",
  },
]);

/**
 * The same listing with one OPEN index and one CLOSED one, so the cluster-wide
 * aggregate has both inputs. Constructed from this product's measured closed-index
 * shape (status word `close`, counts as JSON `null` - docs/providers/opensearch.md
 * §6); the open row is the captured `probe_orders` verbatim.
 */
const CAT_INDICES_MIXED_BODY = JSON.stringify([
  {
    health: "yellow",
    status: "open",
    index: "probe_orders",
    uuid: "e4QJ354KTqyCX763SC2eag",
    pri: "1",
    rep: "1",
    "docs.count": "1",
    "docs.deleted": "0",
    "store.size": "4807",
    "pri.store.size": "4807",
  },
  {
    health: "yellow",
    status: "close",
    index: "probe_closed",
    uuid: "Pjif3CuaTwW2pmgHmRr8iQ",
    pri: "1",
    rep: "1",
    "docs.count": null,
    "docs.deleted": null,
    "store.size": null,
    "pri.store.size": null,
  },
]);

/** `GET /probe_orders/_mapping`. */
const ORDERS_MAPPING_BODY = JSON.stringify({
  probe_orders: {
    mappings: { properties: { customer: { type: "keyword" }, id: { type: "long" }, total: { type: "double" } } },
  },
});

/**
 * `GET /probe_shapes/_mapping` - an object, a nested container and a multi-field.
 *
 * `SELECT address, items` succeeds here (see CONTAINERS_BODY) and fails on
 * Elasticsearch, and the schema tree is identical on both anyway: containers are
 * not columns, and `note.keyword` is.
 */
const SHAPES_MAPPING_BODY = JSON.stringify({
  probe_shapes: {
    mappings: {
      properties: {
        address: { properties: { city: { type: "keyword" } } },
        items: { type: "nested", properties: { sku: { type: "keyword" } } },
        note: { type: "text", fields: { keyword: { type: "keyword" } } },
      },
    },
  },
});

/**
 * `GET /` - and `version.distribution` is the member Elasticsearch does not send
 * at all. The fork added it so a client could tell the two apart, so its presence
 * here and its absence there are both readings of the payload
 * (`http-transport.ts:168-182`).
 */
const ROOT_BODY = JSON.stringify({
  name: "898fbd5c381a",
  cluster_name: "docker-cluster",
  cluster_uuid: "s6gmd4TDQT2z2JFFQvU-iQ",
  version: {
    distribution: "opensearch",
    number: "3.8.0",
    build_type: "tar",
    lucene_version: "10.5.0",
  },
  tagline: "The OpenSearch Project: https://opensearch.org/",
});

/** `GET /_cluster/health` - the same five members Elasticsearch sends, plus its own. */
const HEALTH_BODY = JSON.stringify({
  cluster_name: "docker-cluster",
  status: "yellow",
  timed_out: false,
  number_of_nodes: 1,
  number_of_data_nodes: 1,
  discovered_cluster_manager: true,
  active_primary_shards: 5,
  active_shards: 5,
  relocating_shards: 0,
  initializing_shards: 0,
  unassigned_shards: 2,
  active_shards_percent_as_number: 71.42857142857143,
});

/** `GET /_cluster/stats` - the one place a count arrives as a real JSON number. */
const STATS_BODY = JSON.stringify({
  cluster_name: "docker-cluster",
  indices: { count: 5, store: { size_in_bytes: 279104, reserved_in_bytes: 0 } },
});

// ============================================================================
// Object-surface payloads (#789), captured from OpenSearch 3.8.0 on 2026-09-11
// ============================================================================

/**
 * `GET /_alias`, keyed by INDEX with an inner map of that index's aliases.
 *
 * A stock node's own indices are listed too, each with an EMPTY alias map, so the
 * flattening has to tolerate an index that contributes nothing rather than assume
 * every entry yields a name.
 */
const ALIAS_BODY = JSON.stringify({
  "top_queries-2026.09.11-04089": { aliases: {} },
  ".plugins-ml-config": { aliases: {} },
  ".ds-probe_stream-000001": { aliases: {} },
  probe_orders: { aliases: { probe_orders_alias: {} } },
  ".opensearch-sap-log-types-config": { aliases: {} },
});

/**
 * `GET /_ingest/pipeline` on a node that HAS a pipeline.
 *
 * The whole listing is the user's, because this product ships no built-in pipeline
 * at all - which is what makes the empty case below a 404 rather than an empty set.
 */
const PIPELINES_BODY = JSON.stringify({
  probe_pipeline: {
    description: "libredb object-surface fixture (#789)",
    processors: [{ set: { field: "seen", value: "yes" } }],
  },
});

/**
 * `GET /_ingest/pipeline` on a node that has NONE - HTTP 404, body `{}`.
 *
 * THE measured difference between the two products this one implementation serves,
 * and it is not a difference in the wire contract: both answer 404 for an empty set.
 * It is a difference in what a stock cluster HOLDS. A stock Elasticsearch node ships
 * 21 managed pipelines, so reaching this state there took `DELETE /_ingest/pipeline/*`
 * and the built-ins returned about twenty seconds later (measured 2026-09-11); a stock
 * OpenSearch node ships none, so this IS the ordinary first-run answer here. A transport that classified on
 * the status would put "unavailable" on the Ingest Pipelines folder of every fresh
 * OpenSearch cluster, when the truth is zero.
 */
const PIPELINES_ABSENT_BODY = "{}";

/** `GET /_index_template`. This product ships none, so both entries are the fixture's. */
const TEMPLATES_BODY = JSON.stringify({
  index_templates: [
    { name: "probe_template", index_template: { index_patterns: ["probe-template-*"], composed_of: [] } },
    {
      name: "probe_stream_template",
      index_template: { index_patterns: ["probe_stream*"], data_stream: {}, composed_of: [] },
    },
  ],
});

/**
 * `GET /_data_stream`.
 *
 * Measured shorter than Elasticsearch's: no `system`, no `hidden`, no `index_mode`,
 * and the backing index name carries no date. `name` and the backing indices are the
 * members both products share, and `name` is the only one the listing reads - through
 * this product's OWN name key, which is why the constant exists rather than the
 * template listing's being borrowed for both.
 */
const DATA_STREAMS_BODY = JSON.stringify({
  data_streams: [
    {
      name: "probe_stream",
      timestamp_field: { name: "@timestamp" },
      indices: [{ index_name: ".ds-probe_stream-000001", index_uuid: "NzcJ_j43QlaXdvqSuGPRrA" }],
      generation: 1,
      status: "YELLOW",
      template: "probe_stream_template",
    },
  ],
});

/** The mapping an alias and a data stream resolve to, keyed by the CONCRETE index. */
const ALIAS_MAPPING_BODY = JSON.stringify({
  probe_orders: { mappings: { properties: { customer: { type: "keyword" }, id: { type: "long" } } } },
});
const STREAM_MAPPING_BODY = JSON.stringify({
  ".ds-probe_stream-000001": {
    mappings: { _data_stream_timestamp: { enabled: true }, properties: { "@timestamp": { type: "date" } } },
  },
});

// ============================================================================
// Fake cluster
// ============================================================================

interface Reply {
  status?: number;
  body: string;
}

const originalFetch = globalThis.fetch;

let sentPaths: string[] = [];
let sentBodies: (Record<string, unknown> | null)[] = [];
let replyFor: (path: string, body: Record<string, unknown> | null) => Reply;

function ok(body: string): Reply {
  return { body };
}

/** The paths the transport asks for, answered as the live cluster answers them. */
function defaultReply(path: string, body: Record<string, unknown> | null): Reply {
  // Elasticsearch's endpoint, which this cluster refuses to route - and the refusal
  // is what proves an `elasticsearch` connection is pointed at the wrong product.
  if (path.startsWith("/_sql")) return { status: 405, body: WRONG_ENDPOINT_BODY };

  if (path.startsWith("/_plugins/_sql")) {
    if (typeof body?.cursor === "string") {
      return ok(body.cursor === CURSOR_ONE ? PAGE_TWO_BODY : PAGE_THREE_BODY);
    }
    return sqlReply(String(body?.query));
  }

  if (path === "/") return ok(ROOT_BODY);
  if (path.startsWith("/_cat/indices")) return ok(CAT_INDICES_BODY);
  if (path === "/_cluster/health") return ok(HEALTH_BODY);
  if (path === "/_cluster/stats") return ok(STATS_BODY);
  if (path === "/probe_orders/_mapping") return ok(ORDERS_MAPPING_BODY);
  if (path === "/probe_shapes/_mapping") return ok(SHAPES_MAPPING_BODY);
  // The object-surface listings (#789), each one GET against a REST endpoint rather
  // than the SQL surface: neither product's grammar can reach any of these objects.
  if (path === "/_alias") return ok(ALIAS_BODY);
  if (path === "/_ingest/pipeline") return ok(PIPELINES_BODY);
  if (path === "/_index_template") return ok(TEMPLATES_BODY);
  if (path === "/_data_stream") return ok(DATA_STREAMS_BODY);
  if (path === "/probe_orders_alias/_mapping") return ok(ALIAS_MAPPING_BODY);
  if (path === "/probe_stream/_mapping") return ok(STREAM_MAPPING_BODY);
  // The bulk column read (#789): ONE `_mapping` request naming the whole index folder,
  // answered by COMPOSING the single-index bodies rather than by writing a third one, so
  // the batch and the single read cannot be compared against two different servers.
  if (path === "/probe_orders,probe_shapes/_mapping") {
    return ok(JSON.stringify({ ...JSON.parse(ORDERS_MAPPING_BODY), ...JSON.parse(SHAPES_MAPPING_BODY) }));
  }

  // Every other index name: the core REST layer's snake_case 404.
  if (path.endsWith("/_mapping")) return { status: 404, body: MAPPING_NOT_FOUND_BODY };

  throw new Error(`the fake cluster was asked for an unrouted path: ${path}`);
}

/** Route a statement onto the measured answer for it. */
function sqlReply(sql: string): Reply {
  if (sql === "SELECT 1") return ok(PROBE_BODY);
  if (sql.includes("nope_missing")) return { status: 404, body: MISSING_INDEX_BODY };
  if (sql.includes(" AS who")) return ok(ALIASED_BODY);
  if (sql.includes("address")) return ok(CONTAINERS_BODY);
  if (sql.includes("top_queries")) return ok(PAGE_ONE_BODY);

  return ok(ORDERS_BODY);
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
    sentPaths.push(`${url.pathname}${url.search}`);
    sentBodies.push(body);

    const reply = replyFor(`${url.pathname}${url.search}`, body);
    return new Response(reply.body, {
      status: reply.status ?? 200,
      // Measured: every answer, success and failure alike, is JSON.
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Serve one path differently and leave every other read alone. */
function overridePath(match: string, reply: Reply): void {
  replyFor = (path, body) => (path.includes(match) ? reply : defaultReply(path, body));
}

/** The statement the provider sent that mentions `match`, or a failure naming it. */
function sqlWith(match: string): string {
  const sent = sentBodies.find((body) => typeof body?.query === "string" && body.query.includes(match));
  if (!sent) throw new Error(`no statement matching "${match}" was sent`);
  return String(sent.query);
}

async function connectProvider(): Promise<OpenSearchProvider> {
  const provider = new OpenSearchProvider(makeConnection());
  await provider.connect();
  return provider;
}

/** The seam error a rejected call threw, typed so its category can be read. */
async function faultOf(call: () => Promise<unknown>): Promise<SearchTransportError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof SearchTransportError) return error;
    throw error;
  }
  throw new Error("the call was expected to fail and did not");
}

beforeEach(() => {
  sentPaths = [];
  sentBodies = [];
  replyFor = defaultReply;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// The envelope
// ============================================================================

describe("OpenSearch envelope", () => {
  test("reads rows out of schema/datarows, which is not where Elasticsearch puts them", async () => {
    const result = await transport().query("SELECT id, customer, total FROM probe_orders");

    expect(result.fieldNames).toEqual(["id", "customer", "total"]);
    // Mapping types, not SQL types - the same vocabulary the schema tree shows.
    expect(result.columnTypes).toEqual({ id: "long", customer: "keyword", total: "double" });
    expect(result.rows).toEqual([{ id: 1, customer: "acme", total: 99.5 }]);
  });

  test("prefers the alias member over name, which Elasticsearch folds together", async () => {
    // Measured on both for `SELECT customer AS who FROM probe_orders`:
    //   OpenSearch     {"name":"customer","alias":"who","type":"keyword"}
    //   Elasticsearch  {"name":"who","type":"keyword"}
    // Reading `name` alone would label this column `customer` here - the name the
    // user aliased away - which is a wrong label rather than a missing one.
    const result = await transport().query("SELECT customer AS who FROM probe_orders");

    expect(result.fieldNames).toEqual(["who"]);
    expect(result.columnTypes).toEqual({ who: "keyword" });
    expect(result.rows).toEqual([{ who: "acme" }]);
  });

  test("reports the total member as totalHits, which Elasticsearch sends no counterpart for", async () => {
    const result = await transport().query("SELECT id, customer, total FROM probe_orders");

    // 1, and it is a number the SERVER stated. `SearchQueryResult.totalHits` is
    // nullable precisely because Elasticsearch states nothing here, so a caller
    // must read null as "unknown" rather than as zero.
    expect(result.totalHits).toBe(1);
  });

  test("targets the SQL plugin's own path, which Elasticsearch does not have", async () => {
    await transport().query("SELECT 1");

    // No query string either: the plugin's default format IS the envelope above,
    // while Elasticsearch needs `?format=json` or answers its own tabular text.
    expect(sentPaths).toEqual(["/_plugins/_sql"]);
  });

  test("follows a cursor and rebuilds pages that carry datarows and no schema", async () => {
    // Measured by walking `{"query":"SELECT id FROM top_queries-...","fetch_size":30}`
    // to its end: 30 rows + cursor + total, then 30 rows + cursor and NOTHING else,
    // then 7 rows and no cursor. Later pages have no column declaration on them, so
    // the names have to come from page one - and here they are rebuilt against the
    // OTHER rows key, which is the part that is specific to this product.
    const result = await transport().query("SELECT id FROM top_queries-2026.08.18-74305");

    expect(result.fieldNames).toEqual(["id"]);
    expect(result.rows).toHaveLength(5);
    expect(result.rows[4]).toEqual({ id: "3c1f1d19-0a4b-4a52-9f6a-2b1c0d3e4f50" });
    // Page one's count, unchanged by pages that report none of their own.
    expect(result.totalHits).toBe(67);
  });

  test("reads the distribution member as the product, which Elasticsearch omits", async () => {
    // The fork added `distribution` so a client could tell the two apart, so its
    // ABSENCE is Elasticsearch's signature and this presence is OpenSearch's.
    expect(await transport().version()).toEqual({ version: "3.8.0", product: "opensearch" });
  });
});

// ============================================================================
// Faults
// ============================================================================

describe("OpenSearch faults", () => {
  /**
   * Every name here is a JAVA CLASS, and every row was measured with one probe
   * against the live plugin. The table in `http-transport.ts:395-408` is doing real
   * work: nothing about `EOFParserException` reads as "syntax" to anything but that
   * table, and nothing about `SQLFeatureNotSupportedException` reads as the answer
   * to a MISTYPED keyword - which is what it is here, while Elasticsearch calls the
   * same typo a `parsing_exception`. The asymmetry is reported, not papered over.
   */
  test.each([
    [
      "SELEKT 1",
      "SQLFeatureNotSupportedException",
      "Query must start with SELECT, DELETE, SHOW or DESCRIBE: SELEKT 1",
      "unsupported",
    ],
    [
      "DELETE FROM probe_orders WHERE id = 99",
      "SQLFeatureNotSupportedException",
      "Query must start with SELECT, DELETE, SHOW or DESCRIBE: DELETE FROM probe_orders WHERE id = 99",
      // DELETE is in this grammar and off by default, so a stock node refuses it
      // here; Elasticsearch's grammar has no DELETE at all.
      "unsupported",
    ],
    [
      "SELECT nosuchfield FROM probe_orders",
      "SemanticCheckException",
      "can't resolve Symbol(namespace=FIELD_NAME, name=nosuchfield) in type env",
      "unknown-object",
    ],
    ["SELECT FROM probe_orders", "ParserException", "ERROR. token : FROM, pos : 11", "syntax"],
    // Matched by the `/ParserException$/` shape rule rather than by an entry, so a
    // third parser fault is classified correctly the first time a user hits it.
    ["SELECT * FROM probe_orders WHERE", "EOFParserException", "EOF", "syntax"],
    ["SELECT customer FROM probe_orders LIMIT abc", "NumberFormatException", 'For input string: "abc"', "syntax"],
    [
      "SELECT 1 AS c, 2 AS c",
      "IllegalArgumentException",
      "Multiple entries with same key: c=2 and c=1",
      // Not classifiable beyond "refused", so it lands in `engine` by omission from
      // the fault table rather than by a guess about what it means.
      "engine",
    ],
    [
      "SELECT sillyfunc(1)",
      "NullPointerException",
      'Cannot invoke "com.alibaba.druid.sql.ast.statement.SQLTableSource.getAlias()" because the return value of "com.alibaba.druid.sql.dialect.mysql.ast.statement.MySqlSelectQueryBlock.getFrom()" is null',
      "engine",
    ],
    // Typed as the seam's own category union rather than as `string`, so a category
    // that stops existing fails the typecheck here instead of the assertion.
  ] as [string, string, string, SearchErrorCategory][])(
    "classifies %s by its Java class name",
    async (sql, type, details, category) => {
      overridePath("/_plugins/_sql", sqlFault(type, details, 400));

      const fault = await faultOf(() => transport().query(sql));

      expect(fault.category).toBe(category);
      expect(fault.engineType).toBe(type);
      // The engine's own words, verbatim: they are the only text that locates the
      // fault, and the constant `reason` banner identifies nothing.
      expect(fault.message).toBe(details);
    },
  );

  test("reads a missing index off the body, not off its 404", async () => {
    // The same typo is HTTP 400 on Elasticsearch and HTTP 404 here, so a
    // status-driven classifier would call it a bad request on one product and a
    // missing endpoint on the other.
    const fault = await faultOf(() => transport().query("SELECT * FROM nope_missing"));

    expect(fault.category).toBe("unknown-object");
    expect(fault.engineType).toBe("IndexNotFoundException");
    // The footer OpenSearch appends - advice about re-sending the request in
    // another format - is stripped; it is about this REST API, not about the
    // statement the user wrote.
    expect(fault.message).toBe("[nope_missing] IndexNotFoundException[no such index [nope_missing]]");
  });

  test("classifies the mapping endpoint's snake_case fault, which the SQL plugin never sends", async () => {
    // The SQL plugin answers `IndexNotFoundException` for a missing index and the
    // CORE REST layer answers `index_not_found_exception` for the same one, so this
    // product speaks BOTH vocabularies depending on which endpoint replied. Only a
    // live probe of `mapping()` catches it: with the SQL spellings alone, a missing
    // index would reach introspection as an unclassified engine fault.
    const fault = await faultOf(() => transport().mapping("nope_missing"));

    expect(fault.category).toBe("unknown-object");
    expect(fault.engineType).toBe("index_not_found_exception");
    // The core layer puts its text in `reason` and sends no `details`, which is
    // Elasticsearch's shape rather than the plugin's.
    expect(fault.message).toBe("no such index [nope_missing]");
  });

  test("refuses duplicate output names instead of needing them disambiguated", async () => {
    // `SELECT 1 AS c, 2 AS c` answers HTTP 200 on Elasticsearch with TWO columns
    // named `c`, which is what `disambiguate` upholds the seam's uniqueness
    // invariant against. Here the engine refuses the statement outright, so that
    // code can never fire on this product - a fact about the engine, not dead code.
    overridePath(
      "/_plugins/_sql",
      sqlFault("IllegalArgumentException", "Multiple entries with same key: c=2 and c=1", 400),
    );

    const fault = await faultOf(() => transport().query("SELECT 1 AS c, 2 AS c"));

    expect(fault.message).toBe("Multiple entries with same key: c=2 and c=1");
  });

  test("reads a string-valued error as never having reached the SQL engine", async () => {
    // What this cluster answers a request for ELASTICSEARCH's endpoint: HTTP 405,
    // with `error` as a STRING where an engine fault spells it as an object. That
    // JSON type is the discriminator, and the status is not consulted at all.
    const fault = await faultOf(() => new SearchHttpTransport("elasticsearch", makeConnection()).query("SELECT 1"));

    expect(fault.category).toBe("unreachable");
    expect(fault.message).toContain("Incorrect HTTP method for uri [/_sql?format=json]");
  });
});

// ============================================================================
// One implementation, two type-ids
// ============================================================================

describe("OpenSearchProvider shares the Elasticsearch implementation", () => {
  test("declares the same capabilities as the other type-id, except the one declared divergence", () => {
    // The guard: one implementation serves both type-ids, so a capability that
    // differs without being deliberate means a behaviour difference was smuggled
    // into the wrong place. `identifierQuoting` is the ONE exception, and it is
    // subtracted here explicitly rather than by relaxing the comparison, so a
    // second divergence still fails this test.
    //
    // Why it diverges: measured on OpenSearch 3.8.0, a double-quoted identifier is
    // a STRING LITERAL, so `WHERE "customer" = 'acme'` answers HTTP 200 with
    // `total: 0` while the backtick form returns the row. `query-generators.ts`
    // derives its dialect from `defaultPort`, and both products are 9200 - so
    // without a declared quote style the generated query would silently return no
    // rows for data that exists.
    const { identifierQuoting: osQuoting, ...opensearch } = new OpenSearchProvider(makeConnection()).getCapabilities();
    const { identifierQuoting: esQuoting, ...elasticsearch } = new ElasticsearchProvider(
      makeConnection({ type: ELASTICSEARCH }),
    ).getCapabilities();

    expect(opensearch).toEqual(elasticsearch);
    expect(osQuoting).toBe("backtick");
    expect(esQuoting).toBe("double");
    expect(opensearch.queryLanguage).toBe("sql");
    expect(opensearch.supportsExplain).toBe(false);
    // Neither grammar has BEGIN and both are reached over stateless HTTP (#464).
    expect(opensearch.supportsTransactions).toBe(false);
    expect(opensearch.defaultPort).toBe(9200);
  });

  test("declares the same labels as the other type-id, except the one written for a model", () => {
    // Subtracted explicitly, the same way the capability divergence above is, so a
    // second difference in the UI vocabulary still fails this test.
    //
    // Why `statementLanguage` diverges while every button label does not: it is the
    // one label a MODEL reads rather than a person, and what it has to rule out is
    // per-product. This product ships PPL beside SQL and has no ES|QL; upstream is
    // the other way round. Naming the wrong language that actually exists on the
    // connected cluster is the whole point of the field - a live plan run answered
    // with a native aggregation body when it was told only "one runnable statement"
    // (2026-08-19).
    const { statementLanguage: osLanguage, ...opensearch } = new OpenSearchProvider(makeConnection()).getLabels();
    const { statementLanguage: esLanguage, ...elasticsearch } = new ElasticsearchProvider(
      makeConnection({ type: ELASTICSEARCH }),
    ).getLabels();

    expect(opensearch).toEqual(elasticsearch);
    expect(opensearch.entityNamePlural).toBe("Indices");
    // The engine #U12 was measured on: this panel told an OpenSearch cluster to enable
    // a PostgreSQL extension. Shared with upstream because the fact is shared - the
    // slow log is a node log file on both.
    expect(opensearch.slowQueriesEmptyState).toContain("slow log");
    expect(opensearch.slowQueriesEmptyState).not.toContain("pg_stat_statements");
    // Each names its own endpoint, and rules out its own product's alternatives.
    expect(osLanguage).toContain("OpenSearch SQL");
    expect(osLanguage).toContain("NOT PPL");
    expect(esLanguage).toContain("Elasticsearch SQL");
    expect(esLanguage).toContain("NOT ES|QL");
    // Both rule out the one a model actually reached for.
    expect(osLanguage).toContain("NOT the JSON query DSL");
    expect(esLanguage).toContain("NOT the JSON query DSL");
  });

  test("names OpenSearch in the messages it writes itself", async () => {
    const provider = await connectProvider();

    await expect(provider.query("SELECT 1", [1])).rejects.toThrow(/^OpenSearch binds statement parameters/);
    await expect(provider.runMaintenance("vacuum")).rejects.toThrow(
      /^OpenSearch has no SQL-reachable maintenance operation/,
    );
  });
});

// ============================================================================
// Query preparation - the one behavioural difference above the wire
// ============================================================================

describe("OpenSearchProvider query preparation", () => {
  const provider = () => new OpenSearchProvider(makeConnection());

  test("paginates with LIMIT n OFFSET m, which Elasticsearch refuses outright", () => {
    // Measured: `SELECT customer FROM probe_orders LIMIT 25 OFFSET 50` is HTTP 200
    // here and HTTP 400 on Elasticsearch (`parsing_exception`, "mismatched input
    // 'OFFSET' expecting <EOF>"). This is the one difference declared as a trait
    // (`acceptsOffsetClause`) rather than branched on.
    const prepared = provider().prepareQuery("SELECT customer FROM probe_orders", { limit: 25, offset: 50 });

    expect(prepared.query).toBe("SELECT customer FROM probe_orders LIMIT 25 OFFSET 50");
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.offset).toBe(50);
  });

  test("refuses the same page on the other type-id, so the divergence is the whole difference", () => {
    // The pair is asserted together on purpose: the same call, the same inherited
    // limiter, two outcomes. Elasticsearch cannot serve a second page through this
    // surface at all, and refusing is better than sending `LIMIT n` alone - that
    // would return page ONE while the editor appends it to what it already shows.
    const elasticsearch = new ElasticsearchProvider(makeConnection({ type: ELASTICSEARCH }));

    expect(() => elasticsearch.prepareQuery("SELECT customer FROM probe_orders", { limit: 25, offset: 50 })).toThrow(
      QueryError,
    );
    expect(() => elasticsearch.prepareQuery("SELECT customer FROM probe_orders", { limit: 25, offset: 50 })).toThrow(
      /Elasticsearch SQL has no OFFSET clause/,
    );
  });

  test("bounds the first page identically on both type-ids", () => {
    // `LIMIT n` alone is correct on both, so the shared limiter's ordinary output
    // needs no product to be right about.
    const opensearch = provider().prepareQuery("SELECT customer FROM probe_orders", { limit: 25 });
    const elasticsearch = new ElasticsearchProvider(makeConnection({ type: ELASTICSEARCH })).prepareQuery(
      "SELECT customer FROM probe_orders",
      { limit: 25 },
    );

    expect(opensearch.query).toBe("SELECT customer FROM probe_orders LIMIT 25");
    expect(elasticsearch.query).toBe(opensearch.query);
  });

  test("keeps a trailing semicolon, which OpenSearch accepts and Elasticsearch does not", () => {
    // Measured: `SELECT customer FROM probe_orders LIMIT 25;` is HTTP 200 here,
    // while a trailing semicolon is a syntax error on Elasticsearch. The shared
    // limiter emits the same text for both, so the statement that runs on this
    // product is the one the user typed plus a bound.
    const prepared = provider().prepareQuery("SELECT customer FROM probe_orders;", { limit: 25 });

    expect(prepared.query).toBe("SELECT customer FROM probe_orders LIMIT 25;");
    expect(prepared.wasLimited).toBe(true);
  });
});

// ============================================================================
// Query
// ============================================================================

describe("OpenSearchProvider query", () => {
  test("reports a missing index as a query error even though the answer is a 404", async () => {
    // A status-driven mapping would have made this a ConnectionError and sent the
    // user to check a cluster that answered perfectly well; the same statement on
    // Elasticsearch arrives as a 400. The category comes from the body on both.
    const provider = await connectProvider();

    const failure = provider.query("SELECT * FROM nope_missing");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("no such index [nope_missing]");
  });

  test("carries the plugin's own wording through, banner and footer removed", async () => {
    const provider = await connectProvider();
    // The connect probe has already run, so only the user's statement is refused.
    const unknownColumn = "can't resolve Symbol(namespace=FIELD_NAME, name=nosuchfield) in type env";
    overridePath("/_plugins/_sql", sqlFault("SemanticCheckException", unknownColumn, 400));

    // `reason` is the constant "Invalid SQL query" here, so the detail is the only
    // text that says which part of the statement is wrong. On Elasticsearch the
    // roles are reversed and `reason` is the good text.
    await expect(provider.query("SELECT nosuchfield FROM probe_orders")).rejects.toThrow(unknownColumn);
  });

  test("drops the total the answer carried, so both type-ids report one row count", async () => {
    // `total` is 67 on page one of the measured paged answer while the served rows
    // are 5. Elasticsearch reports no total at all, so surfacing it would put a
    // "showing 5 of 67" notice on one type-id and never on the other for identical
    // statements - which is why `toQueryResult` drops it knowingly.
    const provider = await connectProvider();

    const result = await provider.query("SELECT id FROM top_queries-2026.08.18-74305");

    expect(result.rowCount).toBe(5);
    expect(result.fields).toEqual(["id"]);
    expect(result.columnTypes).toEqual({ id: "keyword" });
    expect(result).not.toHaveProperty("totalHits");
  });

  test("connects on SELECT 1, which needs no index and proves the product", async () => {
    await connectProvider();

    // The plugin's path is product-specific and the wrong one never reaches a SQL
    // engine, so a connected transport is evidence that the type-id names the
    // product actually listening.
    expect(sqlWith("SELECT 1")).toBe("SELECT 1");
    expect(sentBodies[0]).toEqual({ query: "SELECT 1" });
    expect(sentPaths).toEqual(["/_plugins/_sql"]);
  });

  test("fails an Elasticsearch connection pointed at this cluster, quoting its refusal", async () => {
    // The measured cross-product mistake: `POST /_sql?format=json` answers HTTP 405
    // here. The connect probe is what turns a mis-typed connection into an error at
    // the connection form rather than at the user's first query.
    const wrongProduct = new ElasticsearchProvider(makeConnection({ type: ELASTICSEARCH }));

    const failure = wrongProduct.connect();

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow("Incorrect HTTP method for uri [/_sql?format=json]");
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("OpenSearchProvider schema", () => {});

// ============================================================================
// Monitoring
// ============================================================================

describe("OpenSearchProvider monitoring", () => {
  test("names the product from the connection, not from the distribution member", async () => {
    // The payload says `"distribution":"opensearch"` - a wire word - and the
    // connect probe already proved which product is listening, so the overview
    // reads the name this product goes by.
    const provider = await connectProvider();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("OpenSearch 3.8.0");
  });

  test("counts only the user's indices, which is half of what this cluster lists", async () => {
    const provider = await connectProvider();

    const overview = await provider.getOverview();

    // Four visible indices, two of them the engine's own. Counting everything
    // would report a cluster holding data nobody put there - and on a stock
    // Elasticsearch node the same count would be honest, which is exactly why the
    // filter has to be here rather than product-specific.
    expect(overview.tableCount).toBe(2);
    expect(overview.indexCount).toBe(0);
    expect(overview.databaseSize).toBe("272.56 KB");
    expect(overview.databaseSizeBytes).toBe(279104);
    // A cluster that publishes the figure keeps it, including a real measured 0: only an
    // unpublished size is absent.
    expect("databaseSizeBytes" in overview).toBe(true);
  });

  test("excludes the same bookkeeping indices from the table stats", async () => {
    const provider = await connectProvider();

    const stats = await provider.getTableStats();

    expect(stats.map((row) => row.tableName)).toEqual(["probe_orders", "probe_shapes"]);
    // No namespace above an index: this product's own `SHOW TABLES` answers
    // `TABLE_SCHEM` null, so the row carries no schema name rather than one this
    // provider made up.
    expect(stats.every((row) => row.schemaName === "")).toBe(true);
    expect(stats[1]).toMatchObject({ rowCount: 2, tableSizeBytes: 6070, totalSizeBytes: 6070 });
  });

  test("omits the optional size fields for a closed index, which takes the cluster's Data figure away", async () => {
    // The closed row's shape is this product's own, documented in docs/providers/opensearch.md
    // §6: the status word is `close` and `docs.count` / `pri.store.size` arrive as JSON null
    // while the listing still names the index. `TableStats.rowCount`, `totalSize` and
    // `totalSizeBytes` are required, so a closed index has nowhere to read but zero there;
    // `tableSize` and `tableSizeBytes` are OPTIONAL and are omitted, because a 0 would be a
    // fabricated measurement.
    const provider = await connectProvider();
    overridePath("/_cat/indices", ok(CAT_INDICES_MIXED_BODY));

    const stats = await provider.getTableStats();

    expect(stats).toEqual([
      {
        schemaName: "",
        tableName: "probe_orders",
        rowCount: 1,
        tableSize: "4.69 KB",
        tableSizeBytes: 4807,
        totalSize: "4.69 KB",
        totalSizeBytes: 4807,
      },
      {
        schemaName: "",
        tableName: "probe_closed",
        rowCount: 0,
        totalSize: "0 B",
        totalSizeBytes: 0,
      },
    ]);
    // The cluster-wide consequence, asserted rather than inferred: `StorageTab` gates its
    // Data figure on `tables.every((t) => t.tableSizeBytes !== undefined)`, so the open
    // index's measured 4807 bytes stop being drawn as a total the moment one index beside it
    // published nothing. A partial sum would read as a measurement.
    expect(stats.every((row) => row.tableSizeBytes !== undefined)).toBe(false);
    expect("tableSizeBytes" in stats[1]).toBe(false);
  });

  test("reports the cluster as the one storage unit there is", async () => {
    const provider = await connectProvider();

    expect(await provider.getStorageStats()).toEqual([
      { name: "docker-cluster", size: "272.56 KB", sizeBytes: 279104 },
    ]);
  });

  test("keeps the health status when the heavier stats read is refused", async () => {
    // `_cluster/stats` is a more privileged call than `_cluster/health`, so a
    // cluster that answers one and refuses the other is an ordinary configuration
    // on both products. Losing the status over a missing byte count would blank a
    // panel that had the important number already.
    replyFor = (path, body) => (path === "/_cluster/stats" ? { status: 403, body: "{}" } : defaultReply(path, body));
    const provider = await connectProvider();

    expect(await provider.getStorageStats()).toEqual([]);

    const overview = await provider.getOverview();

    expect(overview.databaseSize).toBe("N/A");
    // The number used to say 0 bytes while the string beside it said "N/A", in the same
    // object (docs/BACKLOG.md D44). `in` rather than `toBeUndefined()` because a
    // fabricated 0 is the other outcome being told apart, and it is not undefined.
    expect("databaseSizeBytes" in overview).toBe(false);
  });

  test("OMITS activeConnections rather than sending a 0 that reads as a count", async () => {
    // Nothing in this seam carries a connection count on either product: the open HTTP
    // connections per node live in a stats API this provider never calls. Absence is how
    // the optional field says "not published" (#517), and the composed
    // health summary has to carry it across rather than fill it in.
    const provider = await connectProvider();

    const overview = await provider.getOverview();
    const health = await provider.getHealth();

    expect("activeConnections" in overview).toBe(false);
    expect("activeConnections" in health).toBe(false);
    // The ceiling keeps its 0: for `maxConnections` the type says 0 and absence are the
    // SAME fact, and the Connections card reads it as "no limit published".
    expect(overview.maxConnections).toBe(0);
  });
});

// ============================================================================
// The object surface (#789)
// ============================================================================

/**
 * What the fixture holds on THIS product once the engine's own objects are removed.
 *
 * `index` is 2 of the four `_cat/indices` rows: `.plugins-ml-config` and
 * `top_queries-2026.08.18-74305` are the node's own, and the second carries no dot at
 * all, which is why the index listing's system rule is a name SHAPE and not just a
 * prefix. Every other number equals the Elasticsearch fixture's, because
 * `docker/search-init/01-object-fixture.sh` applies unchanged to both.
 */
const FIXTURE_OBJECT_COUNTS = { index: 2, alias: 1, pipeline: 1, template: 2, stream: 1 };

describe("object surface", () => {
  test("declares exactly what the other type-id declares", () => {
    // The two declarations are already pinned as EQUAL above, capability by
    // capability, so this test asserts the object model's own half rather than
    // restating it: the kinds, their roles and the zero container depth, all of which
    // are facts about a search cluster and not about either product.
    const capabilities = new OpenSearchProvider(makeConnection()).getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id).sort()).toEqual(["alias", "index", "pipeline", "stream", "template"]);
    expect(kinds.map((kind) => kind.role)).toEqual(["relation", "relation", "relation", "config", "config"]);
    expect(capabilities.containerLevels).toEqual([]);

    // OpenSearch's SQL grammar contains no CREATE statement of ANY kind - measured,
    // `CREATE TABLE t (id BIGINT)` answers `SQLFeatureNotSupportedException`, "Query
    // must start with SELECT, DELETE, SHOW or DESCRIBE" - so there is no view, no
    // function, no procedure and no trigger to declare. A stored script exists but has
    // no list-all API (`GET /_scripts` is refused outright on both products), and an
    // object that cannot be enumerated cannot be a tree node.
    for (const absent of ["view", "function", "procedure", "trigger", "script"]) {
      expect(kinds.find((kind) => kind.id === absent)).toBeUndefined();
    }
  });

  test("satisfies the shared object surface contract", async () => {
    const provider = await connectProvider();

    await assertObjectSurface(provider, {
      // A zero-level engine lists NO containers, and the helper addresses every object
      // at the root container. `[[]]` would assert that `listContainers()` answers one
      // container whose path is empty, which is a different and untrue claim.
      containers: [],
      kinds: FIXTURE_OBJECT_COUNTS,
      sampleObject: { path: ["probe_stream"], kind: "stream" },
    });
  });

  // --------------------------------------------------------------------------
  // describeObjects, the bulk column read (#789)
  // --------------------------------------------------------------------------

  test("reads the whole index folder's mappings in ONE request, and each alias in its own", async () => {
    const provider = await connectProvider();
    sentPaths = [];

    const indices = await provider.describeObjects!([], "index");

    expect(indices.details.map((detail) => detail.path)).toEqual([["probe_orders"], ["probe_shapes"]]);
    expect(indices.details.map((detail) => detail.columns.map((column) => column.name))).toEqual([
      ["customer", "id", "total"],
      ["address.city", "items.sku", "note"],
    ]);
    expect(sentPaths.filter((path) => path.endsWith("/_mapping"))).toEqual(["/probe_orders,probe_shapes/_mapping"]);

    // An alias and a data stream resolve to the index behind them, so their mappings come
    // back keyed by THAT index and a combined request cannot be attributed. Measured on
    // 3.8.0, the same as on Elasticsearch, which is why one provider serves both.
    sentPaths = [];
    const aliases = await provider.describeObjects!([], "alias");
    expect(aliases.details.map((detail) => detail.columns.map((column) => column.name))).toEqual([["customer", "id"]]);
    expect(sentPaths.filter((path) => path.endsWith("/_mapping"))).toEqual(["/probe_orders_alias/_mapping"]);
  });

  test("the bulk read spells an object exactly as the single read does", async () => {
    const provider = await connectProvider();

    for (const kind of ["index", "alias", "stream"]) {
      const listed = await provider.listObjects([], kind);
      const batch = await provider.describeObjects!([], kind);
      expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
      for (const detail of batch.details) {
        expect(detail).toEqual(await provider.describeObject(detail.path, kind));
      }
    }
  });

  test("the caller's bound cuts the sorted objects and reaches the mapping request", async () => {
    const provider = await connectProvider();
    sentPaths = [];

    const batch = await provider.describeObjects!([], "index", 1);

    expect(batch.details.map((detail) => detail.path)).toEqual([["probe_orders"]]);
    expect(batch.truncated).toEqual({
      limit: 1,
      reason: "the bulk column read was bounded at 1 object by its caller",
    });
    // Singular, because a bound of one object is one object. The bound reaches the wire:
    // `probe_shapes` is not in the URL.
    expect(sentPaths.filter((path) => path.endsWith("/_mapping"))).toEqual(["/probe_orders/_mapping"]);
    expect((await provider.describeObjects!([], "index", 2)).truncated).toBeUndefined();
  });

  test("a kind with no columns answers an empty batch with no round trip at all", async () => {
    const provider = await connectProvider();

    for (const kind of ["pipeline", "template"]) {
      sentPaths = [];
      expect(await provider.describeObjects!([], kind)).toEqual({ details: [] });
      expect(sentPaths).toEqual([]);
    }
  });

  test("the guards refuse in order: the declaration, the container, then the limit", async () => {
    const provider = await connectProvider();

    await expect(provider.describeObjects!([], "view", 0)).rejects.toThrow(/declares no object kind "view"/);
    await expect(provider.describeObjects!(["nope"], "index", 0)).rejects.toThrow(/container path has 0 segment/);
    await expect(provider.describeObjects!([], "index", 0)).rejects.toThrow(
      /bulk column read limit must be a positive whole number/,
    );
  });

  test("a backing index is hidden by the dot rule, so a data stream is counted once", async () => {
    // The premise the `stream` kind rests on, asserted rather than argued on this
    // product too: the listing carries `.ds-probe_stream-000001` and the index folder
    // does not, so the stream's data is reachable through the `stream` kind and
    // through nothing else, and the two kinds do not count the same bytes twice.
    const provider = await connectProvider();

    const indices = (await provider.listObjects([], "index")).map((object) => object.name);

    expect(indices).toEqual(["probe_orders", "probe_shapes"]);
    expect(indices.some((name) => name.startsWith(".ds-"))).toBe(false);
    expect(await provider.countObjects([])).toMatchObject({ index: { count: 2 }, stream: { count: 1 } });
  });

  test("a 404 carrying this product's error envelope is a refusal, not an empty folder", async () => {
    // The same rule from the other side, and the fork's envelope is its own: a Java
    // class name where Elasticsearch spells a snake_case type. Measured on OpenSearch
    // 3.8.0 2026-09-11, `GET /_data_stream/nope` answers HTTP 404 carrying the full
    // envelope while the empty pipeline set answers HTTP 404 carrying `{}` - so the
    // BODY is what separates a folder that holds nothing from one nobody may read.
    const provider = await connectProvider();
    overridePath("/_ingest/pipeline", {
      status: 404,
      body: JSON.stringify({
        error: {
          type: "IndexNotFoundException",
          reason: "Invalid SQL query",
          details: "no such index [nope_pipeline_store]",
        },
        status: 404,
      }),
    });

    const counts = await provider.countObjects([]);

    expect(counts.pipeline).toEqual({ unavailable: "no such index [nope_pipeline_store]" });
    expect(counts.pipeline).not.toEqual({ count: 0 });
    // And the control is the test below: the same status with `{}` is still zero.
    expect(counts.template).toEqual({ count: 2 });
  });

  test("a listing entry with no readable name is refused, never dropped", async () => {
    // Ruling 5a's failure shape reached from the payload rather than from a CASE arm:
    // a dropped entry leaves the count and the listing agreeing with each other
    // (ruling 5f) and both short by exactly the objects nobody can see.
    const provider = await connectProvider();
    overridePath("/_data_stream", ok(JSON.stringify({ data_streams: [{ template: "probe_stream_template" }] })));

    await expect(provider.listObjects([], "stream")).rejects.toThrow(
      /OpenSearch answered a data stream listing the client could not read/,
    );
  });

  test("an alias payload member that is not an object is refused, never skipped", async () => {
    // This product's listing is the one that names the engine's own indices with an
    // EMPTY alias map, so "an entry contributing nothing" and "an entry this cannot
    // read" are genuinely different here, and only the second is a refusal.
    const provider = await connectProvider();
    overridePath("/_alias", ok(JSON.stringify({ probe_orders: { aliases: { probe_orders_alias: {} } } })));
    expect((await provider.listObjects([], "alias")).map((object) => object.name)).toEqual(["probe_orders_alias"]);

    overridePath("/_alias", ok(JSON.stringify({ probe_orders: { aliases: { probe_orders_alias: {} } }, bad: 7 })));
    await expect(provider.listObjects([], "alias")).rejects.toThrow(/an alias listing/);
  });

  test("reads a 404 from the pipeline endpoint as an empty set, not a refusal", async () => {
    // The one behaviour that differs between the two products in practice, and it is
    // the stock state of THIS one: a node with no pipeline answers HTTP 404 with `{}`.
    // Counting it as a refusal would put the engine's own sentence on the Ingest
    // Pipelines folder of every fresh OpenSearch cluster.
    const provider = await connectProvider();
    overridePath("/_ingest/pipeline", { status: 404, body: PIPELINES_ABSENT_BODY });

    const counts = await provider.countObjects([]);

    expect(counts.pipeline).toEqual({ count: 0 });
    expect(await provider.listObjects([], "pipeline")).toEqual([]);
    // And the other folders are untouched: a 404 on one endpoint is one kind's answer
    // and not a fact about the cluster.
    expect(counts.template).toEqual({ count: 2 });
  });
});
