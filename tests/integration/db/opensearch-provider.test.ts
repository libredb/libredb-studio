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
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { ElasticsearchProvider, OpenSearchProvider } from "@/lib/db/providers/sql/search";
import { SearchHttpTransport } from "@/lib/db/providers/sql/search/http-transport";
import { type SearchErrorCategory, SearchTransportError } from "@/lib/db/providers/sql/search/transport";
import { ConnectionError, QueryError } from "@/lib/db/errors";

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
 */
const CAT_INDICES_BODY = JSON.stringify([
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
    // Neither grammar has BEGIN and both are reached over stateless HTTP (#U13).
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

describe("OpenSearchProvider schema", () => {
  test("hides both kinds of engine bookkeeping this product ships", async () => {
    // Two of the four visible indices on this cluster are the engine's own, and
    // only one of them is dot-prefixed: `top_queries-2026.08.18-74305` carries no
    // dot at all and is recognisable by name SHAPE. A stock Elasticsearch node
    // ships neither, so this is the case that makes the second rule necessary.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["probe_orders", "probe_shapes"]);
  });

  test("reports the string counts as numbers and the string bytes as a size", async () => {
    const provider = await connectProvider();

    const [orders] = await provider.getSchema();

    // `"docs.count":"1"` and `"pri.store.size":"4807"` - quoted even under
    // `bytes=b`, on both products.
    expect(orders.rowCount).toBe(1);
    expect(orders.size).toBe("4.69 KB");
  });

  test("omits containers as columns even though this product can project them, and omits multi-fields it cannot", async () => {
    // Two portability decisions, pulling in OPPOSITE directions, and neither branches
    // on the dialect - which is the point.
    //
    // Containers: `SELECT address, items FROM probe_shapes` is HTTP 200 here (the
    // object comes back as a sub-document, the nested field as an array) and HTTP 400
    // on Elasticsearch. So this product can do MORE, and the leaves are the columns on
    // both anyway, because a starter query enumerating every declared column has to run
    // on both.
    //
    // Multi-fields: this product can do LESS. `SELECT note.keyword` is
    // `SemanticCheckException`, "can't resolve Symbol(namespace=FIELD_NAME,
    // name=note.keyword) in type env", in every spelling, while Elasticsearch selects
    // it fine - and dynamic mapping gives every text field such a child, so listing
    // them would break the starter query on nearly every index here. Dropped on both,
    // for the same reason the container's leaves are kept on both.
    const provider = await connectProvider();

    const shapes = (await provider.getSchema())[1];

    expect(shapes.columns.map((column) => column.name)).toEqual(["address.city", "items.sku", "note"]);
    // Every field is nullable and none is a key: a mapping cannot require a field,
    // and nothing it declares is unique. `_id` is - measured, and this product's
    // SQL even returns it while Elasticsearch's answers "Unknown column [_id]" -
    // but it is metadata rather than a mapped field, so it is not a column here and
    // no column claims to be a key.
    expect(shapes.columns.every((column) => column.nullable && !column.isPrimary)).toBe(true);
    expect(shapes.columns.map((column) => column.type)).toEqual(["keyword", "keyword", "text"]);
  });

  test("costs one index its columns when its mapping answers the snake_case 404", async () => {
    // The listing is a snapshot, so an index deleted between the listing and its
    // mapping read is a race on a live cluster rather than a fault - and the fault
    // name that arrives is the CORE layer's snake_case one, which the SQL fault
    // table alone would not have recognised. Recognising it is what keeps the whole
    // sidebar from failing over one index.
    replyFor = (path, body) =>
      path === "/probe_shapes/_mapping" ? { status: 404, body: MAPPING_NOT_FOUND_BODY } : defaultReply(path, body);
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["probe_orders", "probe_shapes"]);
    expect(schema[0].columns).toHaveLength(3);
    expect(schema[1].columns).toEqual([]);
  });
});

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
    expect((await provider.getOverview()).databaseSize).toBe("N/A");
  });
});
