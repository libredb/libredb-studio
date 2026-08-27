/**
 * Elasticsearch Provider Integration Tests (issue #424, Phase 1)
 *
 * globalThis.fetch is replaced per test and restored in afterEach, so the real
 * transport, the real introspection and the real provider all run - only the
 * server is fake. mock.module() is deliberately not used: it is process-wide in
 * bun and would poison sibling test files.
 *
 * Every payload below was captured from a live Elasticsearch 9.1.4 server
 * (basic licence, security disabled; indices `probe_orders`, `probe_shapes`,
 * `probe_buckets`), measured 2026-08-19, so the fake speaks exactly what the
 * server speaks. That matters more here than in a typical mock, because six
 * behaviours the provider depends on are the opposite of what a JSON API teaches:
 *
 * - An AGGREGATION is paged by the engine even though no page size was ever
 *   requested: `GROUP BY` over 1500 distinct values answers 1000 rows plus a
 *   `cursor`, and page two carries its rows and NO column declaration at all. A
 *   transport that stopped at page one would report two thirds of the groups as a
 *   complete answer.
 * - `SELECT 1 AS c, 2 AS c, 3 AS c` is HTTP 200 with THREE columns all named `c`,
 *   so the seam's uniqueness invariant is upheld while the positional row is
 *   rebuilt - and the same statement is REFUSED by OpenSearch, which is why the
 *   disambiguation is measured here and not there.
 * - The HTTP status misclassifies in both directions: a missing index is 400 and a
 *   user's `SELECT 1/0` is 500, so nothing classifies on the status.
 * - A string-valued `error` is not an engine fault at all - it means the request
 *   never reached a SQL engine, i.e. this is not that product.
 * - `_cat` numbers arrive QUOTED even under `bytes=b`, and are JSON `null` for a
 *   closed index - whose status is the word "close", not "closed".
 * - `LIMIT n OFFSET m` is a hard `parsing_exception`, so the shared limiter's
 *   second page cannot be served at all and is refused rather than silently
 *   turned back into page one.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import { ElasticsearchProvider } from "@/lib/db/providers/sql/search";
import { generateTableQuery } from "@/lib/query-generators";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";

// ============================================================================
// Connection
// ============================================================================

const ELASTICSEARCH: DatabaseType = "elasticsearch";

/** The statement `connect()` proves the cluster with, live-verified as valid. */
const CONNECT_PROBE = "SELECT 1";

/** Both the endpoint path and the query string are product-specific (measured). */
const SQL_PATH = "/_sql?format=json";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "es-1",
    name: "Elasticsearch",
    type: ELASTICSEARCH,
    host: "127.0.0.1",
    port: 9200,
    createdAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// SQL payloads (captured from Elasticsearch 9.1.4 over POST /_sql?format=json)
// ============================================================================

/**
 * `SELECT 1` - the connect probe. The column is named after the expression
 * itself, so an unaliased literal really is called `1`.
 */
const PROBE_BODY = '{"columns":[{"name":"1","type":"integer"}],"rows":[[1]]}';

/**
 * `SELECT id, customer, total, created, note FROM probe_orders`.
 *
 * The declared types are MAPPING types rather than SQL types - `keyword`,
 * `double`, `datetime`, `text` - which is the vocabulary the schema tree also
 * reports for the same fields.
 */
const ORDERS_BODY =
  '{"columns":[{"name":"id","type":"long"},{"name":"customer","type":"keyword"},' +
  '{"name":"total","type":"double"},{"name":"created","type":"datetime"},{"name":"note","type":"text"}],' +
  '"rows":[[1,"acme",9.5,"2026-08-19T00:00:00.000Z","hi"]]}';

/** `SELECT id, customer FROM probe_orders WHERE 1 = 0` - still fully declared. */
const NO_ROWS_BODY = '{"columns":[{"name":"id","type":"long"},{"name":"customer","type":"keyword"}],"rows":[]}';

/**
 * `SELECT 1 AS c, 2 AS c, 3 AS c` - HTTP 200, three columns of the SAME name.
 *
 * The row is positional, so all three values are on the wire; a `SearchRow` is a
 * record, so the second and third would vanish BEFORE the seam without the
 * disambiguation the transport applies while the row is rebuilt.
 */
const DUPLICATE_COLUMN_BODY =
  '{"columns":[{"name":"c","type":"integer"},{"name":"c","type":"integer"},{"name":"c","type":"integer"}],' +
  '"rows":[[1,2,3]]}';

/**
 * `SELECT customer AS who FROM probe_orders` - the alias IS the name here.
 *
 * OpenSearch declares `{"name":"customer","alias":"who"}` for the same statement,
 * which is why the transport has an `aliasKey` at all; on this product there is no
 * separate member to prefer.
 */
const ALIASED_BODY = '{"columns":[{"name":"who","type":"keyword"}],"rows":[["acme"]]}';

/** A declaration with no `type` member: the type channel must stay absent. */
const UNTYPED_BODY = '{"columns":[{"name":"id"}],"rows":[[1]]}';

// ============================================================================
// The cursor-paged aggregation (the measurement that shaped `query()`)
// ----------------------------------------------------------------------------
// `SELECT k, COUNT(*) FROM probe_buckets GROUP BY k` over an index holding 1500
// distinct values, with NO fetch_size requested anywhere:
//
//   page one -> HTTP 200, {"columns":[...],"rows":[1000 rows],"cursor":"x5OsB..."}
//   page two -> HTTP 200, {"rows":[500 rows]}          <- rows only. No columns.
//
// The rows are generated here rather than pasted because 1500 of them is the point
// and the shape of each was measured: ["key0000", 1] ... ["key1499", 1].
// ============================================================================

/** The declaration page one sends, and the ONLY one either page sends. */
const AGGREGATION_COLUMNS = '"columns":[{"name":"k","type":"text"},{"name":"COUNT(*)","type":"long"}]';

/**
 * The paging token, truncated to its measured 48-character prefix.
 *
 * It is an opaque 324-byte base64 blob that only this file's fake ever consumes,
 * and the transport reads nothing but its presence and emptiness, so the head of
 * the real one is enough to keep the payload recognisable.
 */
const AGGREGATION_CURSOR = "x5OsBERGTABijGJgTGZgZORMzs8tyC/OLEllTy/KLy1IqmRg";

function bucketRows(from: number, count: number): string {
  return Array.from({ length: count }, (_unused, offset) => {
    // The index really does hold one document per key, so every count is 1.
    return `["key${String(from + offset).padStart(4, "0")}",1]`;
  }).join(",");
}

/** Page one: the declaration, the engine's default 1000 rows, and the cursor. */
const AGGREGATION_PAGE_ONE = `{${AGGREGATION_COLUMNS},"rows":[${bucketRows(0, 1000)}],"cursor":"${AGGREGATION_CURSOR}"}`;

/** Page two: the remaining 500 rows, no declaration and no cursor - so the loop ends. */
const AGGREGATION_PAGE_TWO = `{"rows":[${bucketRows(1000, 500)}]}`;

/** A page that keeps asking for another one, which is what MAX_PAGES bounds. */
const ENDLESS_PAGE = `{"rows":[${bucketRows(0, 1)}],"cursor":"${AGGREGATION_CURSOR}"}`;

/** `POST /_sql/close` with a valid cursor. The endpoint exists on this product. */
const CURSOR_CLOSED_BODY = '{"succeeded":true}';

// ============================================================================
// Introspection payloads (fixtures es-root.json, es-cat-indices-bytes.json,
// es-cat-indices-closed.json, es-cluster-health.json, es-cluster-stats.json,
// es-mapping*.json - re-measured together on 2026-08-19 so the listing, the
// health and the store size describe ONE cluster: three indices, 84703 bytes)
// ============================================================================

/**
 * `GET /` - and note what is NOT here: no `distribution` member.
 *
 * The fork added that field precisely so a client could tell the two products
 * apart, so its absence is this product's signature. The provider still labels the
 * overview from the connection rather than from this payload, because the connect
 * probe already proved which product is listening.
 */
const ROOT_BODY = JSON.stringify({
  name: "97a829334108",
  cluster_name: "docker-cluster",
  cluster_uuid: "Z5Z3E3ZOS--1J6Wb-XxOOQ",
  version: {
    number: "9.1.4",
    build_flavor: "default",
    build_type: "docker",
    lucene_version: "10.2.2",
  },
  tagline: "You Know, for Search",
});

/**
 * `GET /_cat/indices?format=json&bytes=b`.
 *
 * Every number is QUOTED even though `bytes=b` was asked for, which is the trap the
 * seam records: the default listing formats them ("5.6kb") and even the
 * machine-readable form arrives as a string.
 */
const CAT_INDICES_BODY = JSON.stringify([
  {
    health: "yellow",
    status: "open",
    index: "probe_buckets",
    uuid: "wJ_z-fM7Qb2p4QWmgIVx6w",
    pri: "1",
    rep: "1",
    "docs.count": "1500",
    "docs.deleted": "0",
    "store.size": "68855",
    "pri.store.size": "68855",
    "dataset.size": "68855",
  },
  {
    health: "yellow",
    status: "open",
    index: "probe_shapes",
    uuid: "IyMkixBBQKKN0PpDJ1i8ZA",
    pri: "1",
    rep: "1",
    "docs.count": "2",
    "docs.deleted": "0",
    "store.size": "9935",
    "pri.store.size": "9935",
    "dataset.size": "9935",
  },
  {
    health: "yellow",
    status: "open",
    index: "probe_orders",
    uuid: "ArZ2X__TSEqj8KjbAtIhvg",
    pri: "1",
    rep: "1",
    "docs.count": "1",
    "docs.deleted": "0",
    "store.size": "5913",
    "pri.store.size": "5913",
    "dataset.size": "5913",
  },
]);

/**
 * A CLOSED index, listed by the very same default listing (no `expand_wildcards`
 * needed) - fixture `es-cat-indices-closed.json` verbatim.
 *
 * Every count is JSON `null` while the row still names the index, and the status is
 * the word "close" rather than "closed".
 */
const CAT_INDICES_CLOSED_BODY = JSON.stringify([
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
    "dataset.size": null,
  },
]);

/**
 * The same closed index BESIDE an open one, so the cluster-wide aggregate can be
 * asserted rather than inferred: `StorageTab`'s `tableSizeKnown` is
 * `tables.every((t) => t.tableSizeBytes !== undefined)`, so one index that
 * published no size takes the Data figure away from every index that did.
 */
const CAT_INDICES_MIXED_BODY = JSON.stringify([
  {
    health: "yellow",
    status: "open",
    index: "probe_orders",
    uuid: "ArZ2X__TSEqj8KjbAtIhvg",
    pri: "1",
    rep: "1",
    "docs.count": "1",
    "docs.deleted": "0",
    "store.size": "5913",
    "pri.store.size": "5913",
    "dataset.size": "5913",
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
    "dataset.size": null,
  },
]);

/**
 * An index the engine keeps for itself, CONSTRUCTED - and the one listing row here
 * that is not a capture, because it cannot be: this node runs with security
 * disabled, so it has created no `.security-*` index and `_cat` lists no system
 * index at all. The dot prefix is both products' own convention for their
 * bookkeeping (http-transport.ts:255-264), and only the NAME decides the flag, so
 * the rest of the row is an ordinary open index.
 */
const CAT_INDICES_SYSTEM_BODY = JSON.stringify([
  {
    health: "yellow",
    status: "open",
    index: ".probe_internal",
    uuid: "Tz5wq0nFSaOtxQ3n2Cq4Rw",
    pri: "1",
    rep: "1",
    "docs.count": "4",
    "docs.deleted": "0",
    "store.size": "5913",
    "pri.store.size": "5913",
    "dataset.size": "5913",
  },
]);

/** `GET /_cluster/health` - three shards active, three unassigned on one node. */
const CLUSTER_HEALTH_BODY = JSON.stringify({
  cluster_name: "docker-cluster",
  status: "yellow",
  timed_out: false,
  number_of_nodes: 1,
  number_of_data_nodes: 1,
  active_primary_shards: 3,
  active_shards: 3,
  relocating_shards: 0,
  initializing_shards: 0,
  unassigned_shards: 3,
  active_shards_percent_as_number: 50.0,
});

/**
 * `GET /_cluster/stats`, trimmed to the one number the transport takes from it -
 * the whole payload is 5 KB of node, JVM and analysis detail nothing here reads.
 *
 * This is the one count in the whole wire surface that is a real JSON NUMBER, and
 * 84703 is exactly 68855 + 9935 + 5913, i.e. the three indices above.
 */
const CLUSTER_STATS_BODY = JSON.stringify({
  cluster_name: "docker-cluster",
  indices: {
    count: 3,
    store: { size_in_bytes: 84703, total_data_set_size_in_bytes: 84703, reserved_in_bytes: 0 },
  },
});

/** `GET /probe_orders/_mapping` - fixture `es-mapping.json`. Five flat leaves. */
const ORDERS_MAPPING_BODY = JSON.stringify({
  probe_orders: {
    mappings: {
      properties: {
        created: { type: "date" },
        customer: { type: "keyword" },
        id: { type: "long" },
        note: { type: "text" },
        total: { type: "double" },
      },
    },
  },
});

/**
 * `GET /probe_shapes/_mapping` - fixture `es-mapping-multifield.json`.
 *
 * An `object` container and a `text` field with a `keyword` sub-field, which is the
 * pair Elasticsearch's own `DESCRIBE` flattens to exactly `address`/object,
 * `address.city`/keyword, `note`/text, `note.keyword`/keyword (measured verbatim).
 */
const SHAPES_MAPPING_BODY = JSON.stringify({
  probe_shapes: {
    mappings: {
      properties: {
        address: { properties: { city: { type: "keyword" } } },
        note: { type: "text", fields: { keyword: { type: "keyword" } } },
      },
    },
  },
});

/** `GET /probe_buckets/_mapping` - one `text` field with the default `keyword` sub-field. */
const BUCKETS_MAPPING_BODY = JSON.stringify({
  probe_buckets: {
    mappings: { properties: { k: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } } } },
  },
});

/**
 * `GET /probe_shapes2/_mapping` - fixture `es-mapping-nested-flattened.json`.
 *
 * `nested` is a container the engine refuses to project by name, and `flattened` is
 * a type this SQL surface cannot read at all while the mapping declares it like any
 * other field - the recorded limitation in `introspect.ts`.
 */
const NESTED_MAPPING_BODY = JSON.stringify({
  probe_shapes2: {
    mappings: {
      properties: { blob: { type: "flattened" }, items: { type: "nested", properties: { sku: { type: "keyword" } } } },
    },
  },
});

/**
 * An index with no mapping yet, CONSTRUCTED from the measurement the transport
 * records (http-transport.ts:944-946): the answer is a present, EMPTY `mappings`
 * object rather than an error or an absent key. It is not a live capture because
 * the closed probe index it stands in for was dropped after its `_cat` row was
 * captured, and creating one would change the listing every other probe reads.
 */
const EMPTY_MAPPING_BODY = '{"probe_closed":{"mappings":{}}}';

// ============================================================================
// Error envelopes (all captured; every one of them HTTP-misclassified in some way)
// ----------------------------------------------------------------------------
// `error` is an OBJECT for a real engine fault and a STRING for a request that
// never reached the SQL engine, which is what makes the JSON type of one field the
// "wrong product / no plugin" discriminator.
// ============================================================================

/**
 * The failure envelope, whose shape was measured identical for every fault this
 * product raised: the fault name and the human text appear TWICE - once inside
 * `root_cause` and once at the top of `error` - and only the top-level pair is read.
 *
 * Built rather than pasted so the measured MESSAGE stays legible, since it is the
 * only part that differs between these faults and the only part that reaches the
 * user. Two members of the live bodies are dropped because nothing reads them: the
 * parser faults ride with `"caused_by":{"type":"input_mismatch_exception",
 * "reason":null}`, and `index_not_found_exception` repeats the index name in four
 * `resource.*` members.
 */
function engineFault(status: number, type: string, reason: string): string {
  return JSON.stringify({ error: { root_cause: [{ type, reason }], type, reason }, status });
}

/** The grammar's own list of everything it would have accepted instead. */
const EXPECTED_STATEMENTS = "{'(', 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS', 'WITH'}";

/** `SELECT * FROM nope_missing` - HTTP **400**, not 404 (OpenSearch answers 404). */
const MISSING_INDEX = engineFault(
  400,
  "verification_exception",
  "Found 1 problem\nline 1:15: Unknown index [nope_missing]",
);

/** `SELECT nosuchfield FROM probe_orders` - HTTP 400, the same fault name. */
const UNKNOWN_COLUMN = engineFault(
  400,
  "verification_exception",
  "Found 1 problem\nline 1:8: Unknown column [nosuchfield]",
);

/** `SELEKT 1` - HTTP 400. A mistyped keyword and a rejected mutation are one fault here. */
const SYNTAX_ERROR = engineFault(
  400,
  "parsing_exception",
  `line 1:1: mismatched input 'SELEKT' expecting ${EXPECTED_STATEMENTS}`,
);

/** `CREATE TABLE t (id BIGINT)` - the grammar has no mutation in it at all. */
const CREATE_REFUSED = engineFault(
  400,
  "parsing_exception",
  `line 1:1: mismatched input 'CREATE' expecting ${EXPECTED_STATEMENTS}`,
);

/** `SELECT customer FROM probe_orders LIMIT 2 OFFSET 1` - HTTP 400. */
const OFFSET_REFUSED = engineFault(400, "parsing_exception", "line 1:43: mismatched input 'OFFSET' expecting <EOF>");

/** `SELECT customer FROM probe_orders;` - a trailing semicolon is a syntax error here. */
const SEMICOLON_REFUSED = engineFault(400, "parsing_exception", "line 1:34: extraneous input ';' expecting <EOF>");

/** `SELECT 1/0 AS z` - HTTP **500** for a user's own arithmetic. */
const DIVIDE_BY_ZERO = engineFault(500, "arithmetic_exception", "/ by zero");

/** `GET /nope_missing/_mapping` - HTTP 404, a different fault name for the same event. */
const MAPPING_NOT_FOUND = engineFault(404, "index_not_found_exception", "no such index [nope_missing]");

/**
 * `POST /_plugins/_sql` against THIS product - HTTP 400 and `error` as a STRING.
 *
 * This is what an `opensearch` connection pointed at an Elasticsearch node
 * produces, and it is the reason the connect probe proves the product as well as
 * the port: the request never reached any SQL engine.
 */
const NO_SUCH_HANDLER = '{"error":"no handler found for uri [/_plugins/_sql] and method [POST]"}';

/**
 * A denial, and the one envelope here that is not a capture, because it cannot be:
 * this node runs with security disabled and a bogus `Basic` header is IGNORED
 * (measured, HTTP 200 on both products), so no 401 or 403 body exists to capture.
 * The transport therefore decides `auth` on the HTTP status ALONE - the one signal
 * whose meaning HTTP itself fixes - which is why the body is deliberately empty
 * rather than invented.
 */
const NO_BODY = "";

// ============================================================================
// fetch harness
// ============================================================================

interface Reply {
  status?: number;
  body: string;
}

function ok(body: string): Reply {
  return { body };
}

function fail(status: number, body: string): Reply {
  return { status, body };
}

/** One request the provider made, as the fake server saw it. */
interface SentRequest {
  /** The whole target, so the scheme, the host and the port are observable. */
  url: string;
  /** Path and query string, which is where every product difference lives. */
  path: string;
  method: string;
  /** The parsed JSON request body, or null for the GETs. */
  body: Record<string, unknown> | null;
  auth: string | null;
}

const originalFetch = globalThis.fetch;
const originalAbortTimeout = AbortSignal.timeout;

let sent: SentRequest[] = [];
/** Every client-side deadline the provider armed, in the order it armed them. */
let armedDeadlines: number[] = [];
let networkFailure: Error | null = null;
/** When set, the deadline signal is handed over already aborted with this reason. */
let abortReason: { use: boolean; reason?: unknown } = { use: false };
let replyFor: (request: SentRequest) => Reply;

/** The SQL statement of a request, or null when it was a paging request or a GET. */
function statementOf(request: SentRequest): string | null {
  const query = request.body?.query;
  return typeof query === "string" ? query : null;
}

function cursorOf(request: SentRequest): string | null {
  const cursor = request.body?.cursor;
  return typeof cursor === "string" ? cursor : null;
}

/**
 * The whole read surface, keyed on the exact path the transport builds. Keying on
 * the full path rather than a substring means a routing miss is impossible: a
 * changed query string cannot silently be served another endpoint's payload.
 */
const PATH_BODIES: Record<string, string> = {
  "/": ROOT_BODY,
  "/_cat/indices?format=json&bytes=b": CAT_INDICES_BODY,
  "/_cluster/health": CLUSTER_HEALTH_BODY,
  "/_cluster/stats": CLUSTER_STATS_BODY,
  "/probe_orders/_mapping": ORDERS_MAPPING_BODY,
  "/probe_shapes/_mapping": SHAPES_MAPPING_BODY,
  "/probe_buckets/_mapping": BUCKETS_MAPPING_BODY,
  "/probe_shapes2/_mapping": NESTED_MAPPING_BODY,
  "/probe_closed/_mapping": EMPTY_MAPPING_BODY,
  "/.probe_internal/_mapping": ORDERS_MAPPING_BODY,
};

function defaultReply(request: SentRequest): Reply {
  const canned = PATH_BODIES[request.path];
  if (canned !== undefined) return ok(canned);

  if (request.path === `${SQL_PATH.split("?")[0]}/close`) return ok(CURSOR_CLOSED_BODY);
  if (cursorOf(request) !== null) return ok(AGGREGATION_PAGE_TWO);

  const sql = statementOf(request);
  if (sql === CONNECT_PROBE) return ok(PROBE_BODY);
  return ok(ORDERS_BODY);
}

/** Every read fails the way a cluster with a security plugin refuses a bad password. */
function denyEverything(): void {
  replyFor = () => fail(403, NO_BODY);
}

/** Serve one path differently and leave every other read alone. */
function overridePath(path: string, reply: Reply): void {
  replyFor = (request) => (request.path === path ? reply : defaultReply(request));
}

/** Answer only the SQL endpoint differently, so introspection still works. */
function overrideSql(reply: Reply): void {
  replyFor = (request) => (request.path === SQL_PATH ? reply : defaultReply(request));
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: SentRequest = {
      url: String(input),
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>),
      auth: new Headers(init?.headers).get("authorization"),
    };
    sent.push(request);

    // A real fetch handed an already-aborted signal rejects with the signal's
    // reason, which is the value `requestFailure` deliberately does NOT trust -
    // it consults `signal.aborted` first. Reproducing the rejection faithfully is
    // what makes that ordering observable.
    const signal = init?.signal;
    if (signal?.aborted === true) throw signal.reason;
    if (networkFailure) throw networkFailure;

    const reply = replyFor(request);
    return new Response(reply.body, {
      // Measured: every answer, success and failure alike, is JSON on this
      // endpoint - the failures included, which is why the body is what classifies.
      headers: { "content-type": "application/json" },
      status: reply.status ?? 200,
    });
  }) as typeof fetch;
}

/**
 * Record every client-side deadline, and optionally hand one over already
 * aborted.
 *
 * The deadline is the only signal the provider creates, and its REASON is what the
 * transport reads to tell a user's cancellation from an expired deadline - so a
 * test that only proved a signal was attached could not distinguish the two.
 */
function installAbortRecorder(): void {
  AbortSignal.timeout = ((ms: number) => {
    armedDeadlines.push(ms);
    if (!abortReason.use) return originalAbortTimeout.call(AbortSignal, ms);

    const controller = new AbortController();
    if (abortReason.reason === undefined) controller.abort();
    else controller.abort(abortReason.reason);
    return controller.signal;
  }) as typeof AbortSignal.timeout;
}

/** Every request the provider sent to the SQL endpoint, in order. */
function sqlRequests(): SentRequest[] {
  return sent.filter((request) => request.path === SQL_PATH);
}

function statementsSent(): string[] {
  return sqlRequests()
    .map(statementOf)
    .filter((sql): sql is string => sql !== null);
}

function pathsSent(): string[] {
  return sent.map((request) => request.path);
}

async function connectProvider(overrides: Partial<DatabaseConnection> = {}): Promise<ElasticsearchProvider> {
  const provider = new ElasticsearchProvider(makeConnection(overrides));
  await provider.connect();
  return provider;
}

beforeEach(() => {
  sent = [];
  armedDeadlines = [];
  networkFailure = null;
  abortReason = { use: false };
  replyFor = defaultReply;
  installFetch();
  installAbortRecorder();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortTimeout;
});

// ============================================================================
// Metadata
// ============================================================================

describe("ElasticsearchProvider metadata", () => {
  test("declares the capabilities Phase 1 settled on", () => {
    const capabilities = new ElasticsearchProvider(makeConnection()).getCapabilities();

    expect(capabilities).toEqual({
      queryLanguage: "sql",
      supportsExplain: false,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 9200,
      // Declared, not inferred: `query-generators.ts` derives its dialect from the
      // default port, and OpenSearch shares 9200 while quoting differently, so the
      // port alone can no longer answer for this. Elasticsearch takes the standard
      // double quote (measured: `WHERE "customer" = 'acme'` matches there).
      identifierQuoting: "double",
      // Declared for the same reason and measured the same way: this grammar has no
      // statement terminator, so the generated `SELECT * FROM orders LIMIT 50;`
      // answered "extraneous input ';' expecting <EOF>" and the schema tree's first
      // click failed. OpenSearch declares it too - see the shared-answer test there.
      statementTerminator: "none",
      schemaRefreshPattern: "\\b(DELETE)\\b",
    });
  });

  test("declares no statement terminator, which is what keeps the generated query runnable", () => {
    // The generator asks the capability rather than the engine name
    // (`src/lib/query-generators.ts`), so this is the whole of the fix: with the
    // terminator declared away, "Select Top 50 Documents" and "Generate Query" both
    // emit a statement this grammar accepts.
    const capabilities = new ElasticsearchProvider(makeConnection()).getCapabilities();

    expect(capabilities.statementTerminator).toBe("none");
    expect(generateTableQuery("orders", capabilities)).toBe("SELECT * FROM orders LIMIT 50");
  });

  test("declares no explain format at all, which is what hides the button and the tab", () => {
    // Elasticsearch does answer `EXPLAIN <select>` with its internal plan text, but
    // OpenSearch's SQL plugin does not, and one implementation serves both type-ids:
    // a tab that works on half the connections is worse than no tab. Declaring the
    // key at all would render an Explain affordance for a plan nothing can parse.
    const capabilities = new ElasticsearchProvider(makeConnection()).getCapabilities();

    expect(capabilities.supportsExplain).toBe(false);
    expect(capabilities.explainFormat).toBeUndefined();
    expect("explainFormat" in capabilities).toBe(false);
  });

  test("keeps supportsCreateTable false because CREATE is not in the grammar", () => {
    // Measured, and stronger than "unimplemented": `CREATE TABLE t (id BIGINT)`
    // answers HTTP 400 `parsing_exception`, "mismatched input 'CREATE' expecting
    // {'(', 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS',
    // 'WITH'}" - the grammar lists everything it accepts and no mutation is among
    // them. Indices are created through the index APIs.
    expect(new ElasticsearchProvider(makeConnection()).getCapabilities().supportsCreateTable).toBe(false);
  });

  test("keeps supportsInlineRowEdit false because UPDATE is not in the grammar either", () => {
    // Same class of refusal as CREATE, so the inline editor's statement could only
    // ever produce an error; false hides the affordance instead of offering it.
    // Documents change through the document APIs, which this provider does not expose.
    expect(new ElasticsearchProvider(makeConnection()).getCapabilities().supportsInlineRowEdit).toBe(false);
  });

  test("declares declaresForeignKeys false because the engine has no such constraint", () => {
    // Denormalization is the modelling advice and `nested`/`join` are containment
    // rather than reference, so the empty `foreignKeys` the schema tree reports means
    // "impossible here" rather than "none visible to this role" - the #414 distinction.
    expect(new ElasticsearchProvider(makeConnection()).getCapabilities().declaresForeignKeys).toBe(false);
  });

  test("offers no maintenance operation, because SQL reaches none of them", () => {
    // Refresh, force-merge and cache-clearing are index APIs rather than statements,
    // and `kill` is impossible for a second reason: an abort closes this client's
    // socket while the cluster keeps working (measured).
    const capabilities = new ElasticsearchProvider(makeConnection()).getCapabilities();

    expect(capabilities.supportsMaintenance).toBe(false);
    expect(capabilities.maintenanceOperations).toEqual([]);
  });

  test("declares no connection string, because the cluster is addressed by host and port", () => {
    // Like Druid, and for a second reason: `http://` / `https://` already resolve to
    // ClickHouse in the shared connection-string parser.
    expect(new ElasticsearchProvider(makeConnection()).getCapabilities().supportsConnectionString).toBe(false);
  });

  test("names the refresh trigger DELETE, the only statement that can change the tree", () => {
    // Elasticsearch's grammar has no DELETE at all, so on THIS product the pattern
    // never fires - exactly as Druid's `INSERT|REPLACE` never fires against its
    // native engine. It is here because one implementation serves both type-ids and
    // OpenSearch's grammar does have DELETE, behind a non-default setting.
    expect(new ElasticsearchProvider(makeConnection()).getCapabilities().schemaRefreshPattern).toBe("\\b(DELETE)\\b");
  });

  test("calls a table an Index and a row a document", () => {
    // Not decoration: `inventory-noun.ts` lowercases `entityName` into the noun the
    // agent reasons with, so a cluster described as holding "tables" of "rows"
    // invites statements written for a relational engine. "Indices" is the plural
    // both products use in their own APIs - and "indexes" is already this product's
    // word for the secondary-index objects an index does NOT have.
    const labels = new ElasticsearchProvider(makeConnection()).getLabels();

    expect(labels.entityName).toBe("Index");
    expect(labels.entityNamePlural).toBe("Indices");
    expect(labels.rowName).toBe("document");
    expect(labels.rowNamePlural).toBe("documents");
    expect(labels.selectAction).toBe("Select Top 50 Documents");
    expect(labels.searchPlaceholder).toBe("Search indices or fields...");
  });

  test("names the two maintenance entries after cluster concepts, since both still render", () => {
    // `supportsMaintenance` is false but the schema tree still offers both entries to
    // an admin, and both open a panel this engine has no operation for - so they name
    // the closest real cluster concept. `analyzeAction` avoids the bare word "Analyze"
    // because a search cluster's `_analyze` is text analysis, a different operation.
    const labels = new ElasticsearchProvider(makeConnection()).getLabels();

    expect(labels.analyzeAction).toBe("Index Statistics");
    expect(labels.vacuumAction).toBe("Merge Segments");
  });

  test("the empty slow-query panel says the slow log is a node file, not a missing extension", () => {
    // Measured 2026-08-19 in Chrome on an OpenSearch connection: the monitoring Queries
    // tab told a search cluster to enable `pg_stat_statements` (#463). `getSlowQueries()`
    // is empty by design on both products, so this panel is ALWAYS empty here, and the
    // sentence is the one §7 of the provider doc already used.
    const { slowQueriesEmptyState } = new ElasticsearchProvider(makeConnection()).getLabels();

    expect(slowQueriesEmptyState).toContain("slow log");
    expect(slowQueriesEmptyState).toContain("log file");
    expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });
});

// ============================================================================
// Validation and the connection model
// ============================================================================

describe("ElasticsearchProvider validation", () => {
  test("requires a host", () => {
    expect(() => new ElasticsearchProvider(makeConnection({ host: undefined }))).toThrow(DatabaseConfigError);
  });

  test("ignores the connection's database field entirely", async () => {
    // The connection form renders a Database Name input for every non-file-based
    // type, so an Elasticsearch connection CAN carry one - and a cluster has no
    // namespace above its indices (measured: OpenSearch's own `SHOW TABLES` reports
    // TABLE_SCHEM null, and Elasticsearch's catalog is the cluster name and is not
    // addressable), so the field can only ever be noise.
    const provider = await connectProvider({ database: "nope" });

    expect(sent[0].url).toBe(`http://127.0.0.1:9200${SQL_PATH}`);
    expect(statementsSent()).toEqual([CONNECT_PROBE]);
    await provider.disconnect();
  });

  test("falls back to 9200 when the connection names no port", async () => {
    // Both products ship on 9200 out of the box, so this is a floor rather than a
    // guess - and the connection form prefills the same number.
    const provider = await connectProvider({ port: undefined });

    expect(sent[0].url).toBe(`http://127.0.0.1:9200${SQL_PATH}`);
    await provider.disconnect();
  });

  test("speaks TLS on the same port when the connection asks for it", async () => {
    // One default port for both schemes, deliberately: a secured deployment serves
    // HTTPS on 9200 rather than on a second well-known port, so - unlike ClickHouse -
    // there is no 8443-shaped alternative to fall back to, and inventing one would send
    // credentials somewhere nothing is listening.
    const provider = await connectProvider({ ssl: { mode: "require" } });

    expect(sent[0].url).toBe(`https://127.0.0.1:9200${SQL_PATH}`);
    await provider.disconnect();
  });

  test("turns TLS off for an explicit disable, as firmly as a mode turns it on", async () => {
    // The #264 lesson: an `ssl` object whose mode is `disable` must not be read as
    // "ssl is configured, so use https".
    const provider = await connectProvider({ ssl: { mode: "disable" } });

    expect(sent[0].url).toBe(`http://127.0.0.1:9200${SQL_PATH}`);
    await provider.disconnect();
  });

  test("sends no credentials when the connection carries none", async () => {
    // Measured on a stock node with security disabled: a bogus `Basic` header is
    // IGNORED (HTTP 200), so credentials are optional and sending none is the normal
    // local case.
    const provider = await connectProvider();

    expect(sent[0].auth).toBeNull();
    await provider.disconnect();
  });

  test("sends configured credentials as HTTP basic auth", async () => {
    const provider = await connectProvider({ user: "reader", password: "s3cret" });

    const header = sent[0].auth ?? "";
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("reader:s3cret");
    await provider.disconnect();
  });

  test("sends a user with no password rather than refusing the connection", async () => {
    const provider = await connectProvider({ user: "reader" });

    const header = sent[0].auth ?? "";
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("reader:");
    await provider.disconnect();
  });

  test("brackets a bare IPv6 host, which is otherwise not a legal URL authority", async () => {
    const provider = new ElasticsearchProvider(makeConnection({ host: "::1" }));
    await provider.connect();

    expect(sent[0].url).toBe(`http://[::1]:9200${SQL_PATH}`);
    await provider.disconnect();
  });
});

// ============================================================================
// Lifecycle
// ============================================================================

describe("ElasticsearchProvider lifecycle", () => {
  test("connect proves the port AND the product with the cheapest statement there is", async () => {
    // `SELECT 1` needs no index, so it also succeeds on a cluster that holds nothing
    // yet. And the SQL endpoint path is product-specific, so a connected transport is
    // evidence that this connection's type-id names the product actually listening.
    const provider = await connectProvider();

    expect(provider.isConnected()).toBe(true);
    expect(statementsSent()).toEqual([CONNECT_PROBE]);
    expect(sent[0].method).toBe("POST");
  });

  test("connect arms one client-side deadline, and it is the only deadline there is", async () => {
    // There is no server-side half to pair it with: the seam sends the statement and
    // nothing else, and the cluster keeps executing after a client abort (measured).
    const provider = await connectProvider();

    expect(armedDeadlines).toEqual([60_000]);
    await provider.disconnect();
  });

  test("connect honours a configured query timeout", async () => {
    const provider = new ElasticsearchProvider(makeConnection(), { queryTimeout: 5_000 });
    await provider.connect();

    expect(armedDeadlines).toEqual([5_000]);
    await provider.disconnect();
  });

  test("connect maps a refused credential to an AuthenticationError", async () => {
    // Kept as an authentication failure rather than folded into a connectivity
    // problem: calling it connectivity would send the user to check a host that
    // answered perfectly well.
    replyFor = () => fail(401, NO_BODY);
    const provider = new ElasticsearchProvider(makeConnection({ user: "reader", password: "wrong" }));

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect maps a denied privilege to an AuthenticationError too", async () => {
    replyFor = () => fail(403, NO_BODY);
    const provider = new ElasticsearchProvider(makeConnection({ user: "reader", password: "s3cret" }));

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("connect reports the wrong product's endpoint as a ConnectionError, quoting the cluster", async () => {
    // The measured evidence that this is not that product: `POST /_plugins/_sql`
    // answers HTTP 400 with `error` as a STRING, "no handler found for uri
    // [/_plugins/_sql] and method [POST]". Nothing reached a SQL engine, so this is
    // `unreachable` rather than a statement fault - and the cluster's own wording is
    // what tells the user which mistake they made.
    replyFor = () => fail(400, NO_SUCH_HANDLER);
    const provider = new ElasticsearchProvider(makeConnection());

    const failure = provider.connect();

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow(/no handler found for uri/);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect maps an unreachable cluster to a ConnectionError naming the cause", async () => {
    // Both places a runtime puts the cause are read, because this repo runs on both:
    // Node puts `ECONNREFUSED` on `error.cause.code`, Bun puts `ConnectionRefused` on
    // the error itself, and neither top-level message names the reason on its own.
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    networkFailure = refused;
    const provider = new ElasticsearchProvider(makeConnection());

    const failure = provider.connect();

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow(/ECONNREFUSED/);
  });

  test("connect reports a cluster that answers something else as a ConnectionError", async () => {
    // A proxy in front of the node, a wrong port, a process that is not a search
    // cluster: the probe turns all of those into one failure at the moment the user is
    // still looking at the connection form.
    replyFor = () => fail(404, "<html><head><title>404 Not Found</title></head></html>");
    const provider = new ElasticsearchProvider(makeConnection({ port: 9201 }));

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("a failed connect leaves nothing open behind it", async () => {
    replyFor = () => fail(400, MISSING_INDEX);
    const provider = new ElasticsearchProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    await expect(provider.query(CONNECT_PROBE)).rejects.toBeInstanceOf(DatabaseConfigError);
  });

  test("disconnect releases the transport and is safe to call twice", async () => {
    // Nothing to close: every request is one `fetch` with no pool, no session and no
    // cursor behind it, so disconnecting is forgetting the transport.
    const provider = await connectProvider();

    await provider.disconnect();
    await provider.disconnect();

    expect(provider.isConnected()).toBe(false);
  });

  test("every read before connect is refused rather than answered", async () => {
    const provider = new ElasticsearchProvider(makeConnection());

    await expect(provider.query(CONNECT_PROBE)).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getSchema()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getOverview()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getTableStats()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getStorageStats()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getHealth()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(sent).toEqual([]);
  });

  test("the four constant reads answer without a connection, because they read nothing", async () => {
    // Deliberately not guarded by the connection check above: a search cluster's
    // cache counters, query log, index objects and sessions are all in stats or task
    // APIs that are not among this seam's five calls, so there is no request to send
    // and no answer a socket could change. Requiring one would turn an honest empty
    // into an error.
    const provider = new ElasticsearchProvider(makeConnection());

    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(sent).toEqual([]);
  });
});

// ============================================================================
// Query execution
// ============================================================================

describe("ElasticsearchProvider query", () => {
  test("returns the rows, the declared column order and a measured duration", async () => {
    // The duration is this process's measurement of the exchange, because neither
    // answer carries any server-side timing at all - it is the only number in
    // existence.
    const provider = await connectProvider();

    const result = await provider.query("SELECT id, customer, total, created, note FROM probe_orders");

    expect(result.rows).toEqual([
      { id: 1, customer: "acme", total: 9.5, created: "2026-08-19T00:00:00.000Z", note: "hi" },
    ]);
    expect(result.fields).toEqual(["id", "customer", "total", "created", "note"]);
    expect(result.rowCount).toBe(1);
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  test("labels each column with the engine's own MAPPING type, not a SQL type name", async () => {
    // Measured: `SELECT customer, total` declares `keyword` and `double`, not VARCHAR
    // and DOUBLE. That is the vocabulary the user wrote in their own index mapping and
    // the same one `getSchema` reports, which is what keeps the grid and the sidebar
    // speaking one language.
    const provider = await connectProvider();

    const result = await provider.query("SELECT id, customer, total, created, note FROM probe_orders");

    expect(result.columnTypes).toEqual({
      id: "long",
      customer: "keyword",
      total: "double",
      created: "datetime",
      note: "text",
    });
    expect(Object.keys(result.columnTypes ?? {})).toEqual(result.fields);
  });

  test("leaves the type channel absent when the declaration carried no types", async () => {
    // An invented type would be indistinguishable from one the engine sent, so a
    // column whose declaration has no `type` is left out - and an empty map ships as
    // no channel at all rather than as `{}`.
    const provider = await connectProvider();
    overrideSql(ok(UNTYPED_BODY));

    const result = await provider.query("SELECT id FROM probe_orders");

    expect(result.fields).toEqual(["id"]);
    expect(result.columnTypes).toBeUndefined();
    expect("columnTypes" in result).toBe(false);
  });

  test("describes the columns of a result set with no rows", async () => {
    // Measured: `WHERE 1 = 0` still declares every column, so an empty grid still
    // knows what it would have shown - which is also why an undescribed body is
    // reported as having no columns rather than having them guessed from a first row.
    const provider = await connectProvider();
    overrideSql(ok(NO_ROWS_BODY));

    const result = await provider.query("SELECT id, customer FROM probe_orders WHERE 1 = 0");

    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual(["id", "customer"]);
    expect(result.rowCount).toBe(0);
  });

  test("keeps all three columns of a duplicated output name", async () => {
    // Measured on 9.1.4: `SELECT 1 AS c, 2 AS c, 3 AS c` is HTTP 200 with three
    // columns all named `c` and the row [1,2,3]. A `SearchRow` is a record, so without
    // the disambiguation the second and third values would vanish BEFORE the seam and
    // `columnTypes` would silently describe only the last of them. The same statement
    // is REFUSED by OpenSearch (`IllegalArgumentException`, "Multiple entries with
    // same key"), so this invariant is load-bearing on exactly one of the two products.
    const provider = await connectProvider();
    overrideSql(ok(DUPLICATE_COLUMN_BODY));

    const result = await provider.query("SELECT 1 AS c, 2 AS c, 3 AS c");

    expect(result.fields).toEqual(["c", "c (2)", "c (3)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2, "c (3)": 3 }]);
    expect(result.columnTypes).toEqual({ c: "integer", "c (2)": "integer", "c (3)": "integer" });
    expect(result.rowCount).toBe(1);
  });

  test("shows the alias the user typed, which this product folds into the column name", async () => {
    // `SELECT customer AS who` declares `{"name":"who"}` here and
    // `{"name":"customer","alias":"who"}` on OpenSearch, so reading `name` alone
    // labels the same statement's column `who` on one product and `customer` on the
    // other - a wrong label rather than a missing one.
    const provider = await connectProvider();
    overrideSql(ok(ALIASED_BODY));

    const result = await provider.query("SELECT customer AS who FROM probe_orders");

    expect(result.fields).toEqual(["who"]);
    expect(result.rows).toEqual([{ who: "acme" }]);
  });

  test("follows the cursor an aggregation pages with, and concatenates the rows", async () => {
    // The measurement this whole loop exists for: `SELECT k, COUNT(*) FROM
    // probe_buckets GROUP BY k` over 1500 distinct values answers HTTP 200 with 1000
    // rows plus a `cursor` even though NO fetch_size was ever requested - an
    // aggregation is paged by the engine's own default. Dropping the cursor returned
    // two thirds of the buckets and labelled the result complete, which is worse than
    // an error: a user reading a GROUP BY has no way to notice 500 missing groups.
    const provider = await connectProvider();
    let page = 0;
    replyFor = () => {
      page += 1;
      return ok(page === 1 ? AGGREGATION_PAGE_ONE : AGGREGATION_PAGE_TWO);
    };

    const result = await provider.query("SELECT k, COUNT(*) FROM probe_buckets GROUP BY k");

    expect(result.rows).toHaveLength(1500);
    expect(result.rowCount).toBe(1500);
    // Concatenated in page order, page two's 500 after page one's 1000.
    expect(result.rows[0]).toEqual({ k: "key0000", "COUNT(*)": 1 });
    expect(result.rows[999]).toEqual({ k: "key0999", "COUNT(*)": 1 });
    expect(result.rows[1000]).toEqual({ k: "key1000", "COUNT(*)": 1 });
    expect(result.rows[1499]).toEqual({ k: "key1499", "COUNT(*)": 1 });
  });

  test("rebuilds page two against page one's declaration, because page two declares nothing", async () => {
    // Measured: the second answer is `{"rows":[...]}` and nothing else - no `columns`
    // member at all - so there is nothing on it to derive names from. The names have to
    // be carried forward, which is also the only way the seam's "these names are
    // exactly the key set of every row" invariant can hold across pages.
    const provider = await connectProvider();
    let page = 0;
    replyFor = () => {
      page += 1;
      return ok(page === 1 ? AGGREGATION_PAGE_ONE : AGGREGATION_PAGE_TWO);
    };

    const result = await provider.query("SELECT k, COUNT(*) FROM probe_buckets GROUP BY k");

    expect(result.fields).toEqual(["k", "COUNT(*)"]);
    expect(result.columnTypes).toEqual({ k: "text", "COUNT(*)": "long" });
    // Every later page's rows carry exactly page one's keys, not a subset of them.
    expect(Object.keys(result.rows[1400])).toEqual(["k", "COUNT(*)"]);
  });

  test("asks for a later page with the cursor alone, and stops when the engine sends none", async () => {
    // The loop terminates on the ENGINE's word: page two carries no cursor, so two
    // requests is the whole exchange. And a paging request carries the cursor instead
    // of the statement - re-sending the statement would restart the aggregation.
    const provider = await connectProvider();
    let page = 0;
    replyFor = () => {
      page += 1;
      return ok(page === 1 ? AGGREGATION_PAGE_ONE : AGGREGATION_PAGE_TWO);
    };

    await provider.query("SELECT k, COUNT(*) FROM probe_buckets GROUP BY k");

    const paging = sqlRequests().slice(1);
    expect(paging).toHaveLength(2);
    expect(paging[0].body).toEqual({ query: "SELECT k, COUNT(*) FROM probe_buckets GROUP BY k" });
    expect(paging[1].body).toEqual({ cursor: AGGREGATION_CURSOR });
    // Nothing else was asked: no /_sql/close, because no cursor was left holding.
    expect(pathsSent()).toEqual([SQL_PATH, SQL_PATH, SQL_PATH]);
  });

  test("refuses a statement that pages forever, and closes the cursor on the way out", async () => {
    // The terminating condition is the server's, so the loop is bounded - and hitting
    // the bound is REPORTED rather than silently accepted, because the failure being
    // fixed here is precisely a truncation nobody was told about. The abandoned cursor
    // is server-side state, so it is released before the refusal is raised.
    const provider = await connectProvider();
    overrideSql(ok(ENDLESS_PAGE));

    const failure = provider.query("SELECT k, COUNT(*) FROM probe_buckets GROUP BY k");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(/more result pages than this connection will follow \(1000\)/);
    // The bound really is the number of PAGES, so exactly 1000 answers were read - the
    // statement plus 999 paging requests - before the loop gave up.
    expect(sqlRequests().filter((request) => cursorOf(request) !== null)).toHaveLength(999);
    expect(pathsSent()).toContain("/_sql/close");
    expect(sent[sent.length - 1].body).toEqual({ cursor: AGGREGATION_CURSOR });
  });

  test("still serves the result when releasing the abandoned cursor fails", async () => {
    // Best-effort by design: the cleanup call cannot turn a produced answer into an
    // error, and the engine frees the cursor on its own keep-alive expiry anyway.
    const provider = await connectProvider();
    replyFor = (request) => (request.path === "/_sql/close" ? fail(400, DIVIDE_BY_ZERO) : ok(ENDLESS_PAGE));

    // The page bound is still what is reported - not the cleanup's failure.
    await expect(provider.query("SELECT k FROM probe_buckets")).rejects.toThrow(/more result pages/);
  });

  test("counts the rows it returned, because no statement on this surface mutates", async () => {
    // There is no written-row count to fall back on: every mutation is refused by the
    // grammar, so a second number could only ever be zero - which reads as "nothing
    // changed" rather than "this cannot happen".
    const provider = await connectProvider();

    const result = await provider.query("SELECT id FROM probe_orders");

    expect(result.rowCount).toBe(result.rows.length);
  });

  test("reports no matching-document count, because this product sends none", async () => {
    // OpenSearch sends `total` and `size` beside every answer and Elasticsearch sends
    // neither, so a "showing 50 of 4,812" notice would appear on one product and never
    // on the other for identical statements. The seam carries it as nullable and the
    // provider drops it knowingly; the route's own pagination already tells the UI.
    const provider = await connectProvider();

    const result = await provider.query("SELECT id FROM probe_orders");

    // The whole shape, so a count smuggled in under any name would fail here.
    expect(Object.keys(result).sort()).toEqual(["columnTypes", "executionTime", "fields", "rowCount", "rows"]);
    expect(sqlRequests()[1].body).toEqual({ query: "SELECT id FROM probe_orders" });
  });

  test("arms one deadline per statement, and it is the client's alone", async () => {
    const provider = await connectProvider();
    armedDeadlines = [];

    await provider.query("SELECT id FROM probe_orders");

    expect(armedDeadlines).toEqual([60_000]);
  });

  test("refuses positional parameters before anything leaves the process", async () => {
    // Both endpoints really do bind them, but they spell the request differently
    // (`params` against `parameters` with per-value types), the seam carries the
    // statement alone, and inlining the values here to work around that would be
    // building a SQL-injection site inside a provider. Same call as ClickHouse (#264).
    const provider = await connectProvider();
    sent = [];

    const failure = provider.query("SELECT customer FROM probe_orders WHERE id = ?", [1]);

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(/positional parameters cannot be used/);
    expect(sent).toEqual([]);
  });

  test("accepts an empty parameter array, which is how the app calls every provider", async () => {
    const provider = await connectProvider();

    await expect(provider.query("SELECT id FROM probe_orders", [])).resolves.toBeDefined();
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe("ElasticsearchProvider error mapping", () => {
  test("a missing index is the user's own error, at HTTP 400 rather than 404", async () => {
    // The measurement that made categorisation body-driven: the SAME typo is HTTP 400
    // `verification_exception` here and HTTP 404 `IndexNotFoundException` on
    // OpenSearch, so a status-driven classifier would call it a bad request on one
    // product and a missing endpoint on the other.
    const provider = await connectProvider();
    overrideSql(fail(400, MISSING_INDEX));

    const failure = provider.query("SELECT * FROM nope_missing");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionError);
    // The engine's own wording travels verbatim: it is the only text that locates the
    // fault in the user's statement.
    await expect(failure).rejects.toThrow("line 1:15: Unknown index [nope_missing]");
  });

  test("a mistyped column is the same category with the engine's own line and column", async () => {
    const provider = await connectProvider();
    overrideSql(fail(400, UNKNOWN_COLUMN));

    const failure = provider.query("SELECT nosuchfield FROM probe_orders");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("line 1:8: Unknown column [nosuchfield]");
  });

  test("a mistyped keyword is a syntax error carrying the grammar's own list", async () => {
    // `parsing_exception` covers a typo and a rejected mutation alike on this product:
    // its grammar has no INSERT, so both are reported as "mismatched input ...
    // expecting {..., 'SELECT', ...}". Calling that `syntax` reports what the engine
    // said; calling it `unsupported` would be our inference. On OpenSearch the SAME
    // statement is `SQLFeatureNotSupportedException`, and the asymmetry is not papered
    // over.
    const provider = await connectProvider();
    overrideSql(fail(400, SYNTAX_ERROR));

    const failure = provider.query("SELEKT 1");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(/mismatched input 'SELEKT' expecting/);
  });

  test("an HTTP 500 for a divide by zero is still the user's own error", async () => {
    // The other direction the status lies in, and the same lesson ClickHouse taught in
    // #264: `SELECT 1/0` answers HTTP 500 `arithmetic_exception` for an ordinary
    // mistake. Reading 5xx as "the cluster is broken" would tell the user something
    // false and send them to look at a healthy node.
    const provider = await connectProvider();
    overrideSql(fail(500, DIVIDE_BY_ZERO));

    const failure = provider.query("SELECT 1/0 AS z");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow("/ by zero");
  });

  test("a statement ending in OFFSET is refused by the engine, not rewritten by us", async () => {
    // `LIMIT 2 OFFSET 1` is HTTP 400 here and HTTP 200 on OpenSearch. A statement the
    // USER wrote that way reaches the engine untouched and gets the engine's own
    // wording, which names the exact column of the offending keyword; the case where
    // the shared limiter would have PRODUCED the clause is refused earlier, in
    // prepareQuery.
    const provider = await connectProvider();
    overrideSql(fail(400, OFFSET_REFUSED));

    const failure = provider.query("SELECT customer FROM probe_orders LIMIT 2 OFFSET 1");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("line 1:43: mismatched input 'OFFSET' expecting <EOF>");
  });

  test("a trailing semicolon is a syntax error here, and reaches the user as one", async () => {
    // Measured: `SELECT customer FROM probe_orders;` answers HTTP 400
    // `parsing_exception`, "extraneous input ';' expecting <EOF>" - while OpenSearch
    // accepts the same statement. Nothing in this provider strips it, so a user who
    // types the semicolon out of habit sees the engine's own complaint about the
    // character they typed rather than a rewritten statement.
    const provider = await connectProvider();
    overrideSql(fail(400, SEMICOLON_REFUSED));

    const failure = provider.query("SELECT customer FROM probe_orders;");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("extraneous input ';' expecting <EOF>");
  });

  test("a mutation the grammar has no room for surfaces the grammar's own answer", async () => {
    // Deliberately not special-cased: the engine's message lists every statement it
    // WOULD have accepted, which is more useful than anything the provider could
    // substitute for it.
    const provider = await connectProvider();
    overrideSql(fail(400, CREATE_REFUSED));

    const failure = provider.query("CREATE TABLE t (id BIGINT)");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(/mismatched input 'CREATE' expecting/);
  });

  test("a string-valued error is a connection failure, because nothing reached the engine", async () => {
    // The JSON TYPE of one field is the discriminator: a real engine fault spells
    // `error` as an OBJECT, and the two measured requests that never reached a SQL
    // engine at all - the wrong product's path (HTTP 400 here) and the wrong HTTP
    // method (HTTP 405 on OpenSearch) - both spell it as a STRING. "The SQL plugin is
    // not installed" is the same wire evidence.
    const provider = await connectProvider();
    overrideSql(fail(400, NO_SUCH_HANDLER));

    const failure = provider.query(CONNECT_PROBE);

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow(/did not route the request to its SQL endpoint/);
    await expect(failure).rejects.toThrow(/no handler found for uri \[\/_plugins\/_sql\]/);
  });

  test("a denial becomes an AuthenticationError, decided on the status alone", async () => {
    // The one case where the status IS the evidence: security is disabled on the probe
    // cluster and a bogus `Basic` header is ignored there, so no 401/403 body could be
    // captured - and rather than invent one, the transport reads the two statuses whose
    // meaning HTTP itself fixes.
    const provider = await connectProvider();
    denyEverything();

    await expect(provider.query("SELECT id FROM probe_orders")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a socket that never reached the cluster becomes a ConnectionError", async () => {
    const provider = await connectProvider();
    networkFailure = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });

    const failure = provider.query(CONNECT_PROBE);

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow(/ENOTFOUND/);
  });

  test("a Bun-shaped connection refusal is named too, from the code on the error itself", async () => {
    // Bun throws `Error: Unable to connect...` with `code: "ConnectionRefused"` on the
    // error and no `cause` at all, while Node uses `cause.code`. This repo runs on
    // both, so reading only one place would leave the other runtime's users with a
    // message that says nothing.
    const provider = await connectProvider();
    networkFailure = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    });

    await expect(provider.query(CONNECT_PROBE)).rejects.toThrow(/ConnectionRefused/);
  });

  test("an expired deadline becomes a TimeoutError, named by the abort reason", async () => {
    // `AbortSignal.timeout` aborts with a DOMException named "TimeoutError", which is
    // the one signal that tells a deadline apart from a user's cancellation. The
    // cluster is still working on the statement - the deadline that expired is this
    // client's and it is the only one there is.
    const provider = await connectProvider();
    abortReason = { use: true, reason: new DOMException("The operation timed out.", "TimeoutError") };

    const failure = provider.query("SELECT id FROM probe_orders");

    await expect(failure).rejects.toBeInstanceOf(TimeoutError);
    await expect(failure).rejects.toThrow(/ran past its deadline/);
  });

  test("a bare abort becomes a QueryCancelledError", async () => {
    const provider = await connectProvider();
    abortReason = { use: true };

    const failure = provider.query("SELECT id FROM probe_orders");

    await expect(failure).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(failure).rejects.toThrow(/was cancelled/);
  });

  test("an abort carrying a reason is still a cancellation, not an unreachable cluster", async () => {
    // The measured trap: `controller.abort(new Error("x"))` rejects with THAT error,
    // whose name is "Error" and which has nothing abort-shaped about it - so a
    // name-only test would report a user closing a tab as a broken cluster. The signal
    // knows; the thrown value does not, which is why `signal.aborted` is consulted
    // first.
    const provider = await connectProvider();
    abortReason = { use: true, reason: new Error("the user closed the tab") };

    const failure = provider.query("SELECT id FROM probe_orders");

    await expect(failure).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionError);
  });

  test("a proxy's HTML error page still surfaces as an error naming the status", async () => {
    // Not parseable as either envelope, so the status is the only thing that was
    // actually observed - and it is reported as exactly that.
    const provider = await connectProvider();
    overrideSql(fail(502, "<html><head><title>502 Bad Gateway</title></head></html>"));

    await expect(provider.query(CONNECT_PROBE)).rejects.toThrow(/HTTP 502/);
  });

  test("a 200 that is not the envelope this client parses is reported as unreadable", async () => {
    // Reporting an empty success instead would be far worse: the grid would show no
    // rows for a statement that may well have matched thousands.
    const provider = await connectProvider();
    overrideSql(ok("[]"));

    const failure = provider.query("SELECT id FROM probe_orders");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(/answered a SQL result the client could not read/);
  });
});

// ============================================================================
// Query preparation (the OFFSET refusal)
// ============================================================================

describe("ElasticsearchProvider query preparation", () => {
  const provider = () => new ElasticsearchProvider(makeConnection());

  test("applies the external row limit to a plain SELECT, which this product accepts", () => {
    // `LIMIT n` is correct SQL here (measured, HTTP 200 with the rows bounded), and
    // after ORDER BY, GROUP BY and HAVING as well, so the shared limiter's ordinary
    // output runs unchanged.
    const prepared = provider().prepareQuery("SELECT * FROM probe_orders", { limit: 25 });

    expect(prepared.query).toBe("SELECT * FROM probe_orders LIMIT 25");
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.limit).toBe(25);
    expect(prepared.offset).toBe(0);
  });

  test("defaults to the shared row ceiling when the caller names none", () => {
    const prepared = provider().prepareQuery("SELECT * FROM probe_orders");

    expect(prepared.query).toBe("SELECT * FROM probe_orders LIMIT 500");
  });

  test("refuses to page, because this product's grammar has no OFFSET", () => {
    // Measured: `SELECT customer FROM probe_orders LIMIT 2 OFFSET 1` is HTTP 400
    // `parsing_exception`, "mismatched input 'OFFSET' expecting <EOF>", with or without
    // an ORDER BY in front of it - while OpenSearch answers 200 with the rows the
    // offset asks for. The limiter emits exactly that clause for any page after the
    // first, so the editor's "load more" would turn a working statement into a syntax
    // error.
    //
    // Refusing LOUDLY is the point. Sending the clause anyway fails the query with an
    // engine message about a keyword the user never typed; silently dropping the OFFSET
    // returns page ONE while the editor appends it to what it already shows, i.e.
    // duplicate rows presented as new ones - a wrong ANSWER, which is the one outcome
    // worth throwing to avoid.
    const failing = () => provider().prepareQuery("SELECT * FROM probe_orders", { limit: 25, offset: 25 });

    expect(failing).toThrow(QueryError);
    expect(failing).toThrow(/Elasticsearch SQL has no OFFSET clause/);
    expect(failing).toThrow(/Narrow the statement with a WHERE clause, or raise the row limit/);
  });

  test("the refusal names this product, so the message matches the cluster on screen", () => {
    // The label comes from the product table rather than from the type-id, so the
    // sentence this file adds around the transport's own wording never disagrees with
    // it about what the cluster is called.
    expect(() => provider().prepareQuery("SELECT * FROM probe_orders", { offset: 10 })).toThrow(/^Elasticsearch SQL/);
  });

  test("leaves a statement carrying its own LIMIT exactly as the base class left it", () => {
    // The refusal is narrow on purpose: it fires only when the limiter actually
    // PRODUCED the clause. Nothing was rewritten here, the user's own bound is what
    // runs, and that is how every provider in this repo behaves for this case - so
    // even a paging request must not throw.
    const prepared = provider().prepareQuery("SELECT id FROM probe_orders LIMIT 3", { limit: 25, offset: 50 });

    expect(prepared.query).toBe("SELECT id FROM probe_orders LIMIT 3");
    expect(prepared.wasLimited).toBe(false);
  });

  test("leaves a statement that is not a SELECT alone, and does not refuse it either", () => {
    // Nothing was limited, so there is no produced OFFSET to refuse - and the engine's
    // own answer to the mutation is the more useful error.
    const prepared = provider().prepareQuery("DELETE FROM probe_orders WHERE id = 99", { offset: 25 });

    expect(prepared.query).toBe("DELETE FROM probe_orders WHERE id = 99");
    expect(prepared.wasLimited).toBe(false);
  });

  test("lifts the ceiling for an unlimited export, still without an OFFSET", () => {
    const prepared = provider().prepareQuery("SELECT * FROM probe_orders", { unlimited: true });

    expect(prepared.query).toBe("SELECT * FROM probe_orders LIMIT 100000");
    expect(prepared.limit).toBe(100000);
  });

  test("keeps a trailing semicolon the user typed, which this product will refuse", () => {
    // The limiter puts the bound between the statement and its trailing trivia and
    // re-attaches the trivia verbatim, so the semicolon survives - and measured, a
    // trailing `;` is a `parsing_exception` on Elasticsearch while OpenSearch accepts
    // it. Rewriting the user's text to hide that would mean the editor silently
    // executing something other than what is on screen; the engine's complaint names
    // the character instead.
    const prepared = provider().prepareQuery("SELECT * FROM probe_orders;", { limit: 25 });

    expect(prepared.query).toBe("SELECT * FROM probe_orders LIMIT 25;");
  });

  test("bounds a statement ending in a comment, before the comment", () => {
    const prepared = provider().prepareQuery("SELECT * FROM probe_orders -- daily check", { limit: 25 });

    expect(prepared.query).toBe("SELECT * FROM probe_orders LIMIT 25 -- daily check");
    expect(prepared.wasLimited).toBe(true);
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("ElasticsearchProvider schema", () => {
  test("getSchema lists every index with its MAPPED fields as columns", async () => {
    // The schema is the MAPPING, not SQL. `SELECT *` describes the statement rather
    // than the index - measured, an index mapping `flattened` and `nested` answers
    // `SELECT *` with `{"columns":[],"rows":[[]]}`, a table with no columns at all -
    // and `DESCRIBE` is a SQL surface whose availability is the very thing the tree
    // must not depend on.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["probe_buckets", "probe_shapes", "probe_orders"]);
    expect(schema[2].columns.map((column) => column.name)).toEqual(["created", "customer", "id", "note", "total"]);
    expect(schema[2].columns[1]).toEqual({
      name: "customer",
      // The engine's own mapping type, not a SQL type name: the grid labels the same
      // field `keyword` too, so the tree and the results speak one vocabulary.
      type: "keyword",
      nullable: true,
      isPrimary: false,
    });
  });

  test("getSchema reads the mapping of each index and nothing else", async () => {
    const provider = await connectProvider();
    sent = [];

    await provider.getSchema();

    expect(pathsSent().sort()).toEqual(
      [
        "/_cat/indices?format=json&bytes=b",
        "/probe_buckets/_mapping",
        "/probe_orders/_mapping",
        "/probe_shapes/_mapping",
      ].sort(),
    );
  });

  test("getSchema arms one deadline for the whole tree, not one per index", async () => {
    // One signal per OPERATION: a sidebar that renders half its indices after a stall
    // is not a better answer than one that reports the stall.
    const provider = await connectProvider();
    armedDeadlines = [];

    await provider.getSchema();

    expect(armedDeadlines).toEqual([60_000]);
  });

  test("getSchema drops a container and a multi-field, keeps the parent and the leaf", async () => {
    // Two measurements pulling in opposite directions. A container breaks the WHOLE
    // statement: `SELECT address FROM probe_shapes` is HTTP 400, "Cannot use field
    // [address] type [object] only its subfields", and `query-generators.ts` builds its
    // starter query by enumerating every declared column - so listing `address` would
    // hand the user a query that cannot run at all. But a multi-field PARENT is not a
    // container: `SELECT note` answers the text here, so "has sub-fields" is the wrong
    // test and the field's own type is the test.
    //
    // The multi-field CHILD is nonetheless dropped, and this is the one place the
    // provider offers less than Elasticsearch can do. `SELECT note.keyword` works here;
    // OpenSearch 3.8.0 refuses it in every spelling (`SemanticCheckException`, "can't
    // resolve Symbol(namespace=FIELD_NAME, name=note.keyword) in type env"), and
    // dynamic mapping creates such a child for EVERY text field - so one
    // implementation serving both type-ids either leaves it out or hands OpenSearch
    // users a starter query that fails on nearly every index. The loss is recorded in
    // `introspect.ts` rather than hidden, and typing `note.keyword` here still works.
    const provider = await connectProvider();

    const schema = await provider.getSchema();
    const shapes = schema.find((table) => table.name === "probe_shapes");

    expect(shapes?.columns.map((column) => column.name)).toEqual(["address.city", "note"]);
    expect(shapes?.columns.map((column) => column.type)).toEqual(["keyword", "text"]);
  });

  test("getSchema addresses an object sub-field by the dotted path SQL accepts", async () => {
    // The dotted path is an identifier, not a display convenience: `SELECT address.city
    // FROM probe_shapes` returns the column, measured on BOTH products. This assertion
    // deliberately names an object sub-field rather than `k.keyword`, because the
    // multi-field kind is dropped for a portability reason (see the test above) and
    // asserting on it would conflate the two decisions.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.find((table) => table.name === "probe_buckets")?.columns.map((column) => column.name)).toEqual(["k"]);
  });

  test("getSchema drops a nested container but still lists a type SQL cannot read", async () => {
    // `nested` is refused by name with the same wording as `object`, so it is not a
    // column. `flattened` IS listed even though `SELECT blob` is refused with "Cannot
    // use field [blob] with unsupported type [flattened]" - a recorded limitation, not
    // an oversight: the mapping does not say which types SQL supports, and enumerating
    // them would be a per-version list this code cannot verify, which would hide fields
    // a future version reads perfectly well.
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(JSON.stringify([{ index: "probe_shapes2", status: "open" }])));

    const schema = await provider.getSchema();

    expect(schema[0].columns.map((column) => column.name)).toEqual(["blob", "items.sku"]);
    expect(schema[0].columns.map((column) => column.type)).toEqual(["flattened", "keyword"]);
  });

  test("getSchema marks every column nullable and none of them primary", async () => {
    // Both are measurements rather than hedges. A mapping declares how a field is
    // indexed IF a document carries it - there is no NOT NULL in the model, and a
    // document indexed without the field really comes back as `null`. And nothing a
    // mapping declares is unique: the only unique thing in an index is the document
    // `_id`, which is metadata rather than a mapped field and which this product's SQL
    // does not even expose ("Unknown column [_id]", measured, while OpenSearch's
    // returns it). `isPrimary` is stated as FACT wherever it is read - autocomplete
    // appends "(PK)", the agent's schema context puts " PK" into what a model reasons
    // from - so a key invented here becomes a key the product asserts.
    const provider = await connectProvider();

    const schema = await provider.getSchema();
    const columns = schema.flatMap((table) => table.columns);

    expect(columns.every((column) => column.nullable)).toBe(true);
    expect(columns.filter((column) => column.isPrimary)).toEqual([]);
    expect(columns.every((column) => column.defaultValue === undefined)).toBe(true);
  });

  test("getSchema reports no indexes and no foreign keys, both empty by construction", async () => {
    // The word collision is the trap: an Elasticsearch index is the TABLE here. Every
    // mapped field is inverted-indexed as a property of being mapped, so there is
    // nothing a user declared and nothing to name - and no DDL exists that could
    // declare a reference.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.every((table) => table.indexes.length === 0)).toBe(true);
    expect(schema.every((table) => table.foreignKeys?.length === 0)).toBe(true);
  });

  test("getSchema carries the document count and the primary store size per index", async () => {
    // Documents are the rows on this surface, and the counts arrive as STRINGS even
    // under `bytes=b` - so a caller seeing numbers here is the parsing working.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.rowCount)).toEqual([1500, 2, 1]);
    expect(schema.map((table) => table.size)).toEqual(["67.24 KB", "9.7 KB", "5.77 KB"]);
  });

  test("getSchema keeps a closed index and omits the counts it has none of", async () => {
    // Measured: a closed index is listed by the default `_cat` call, its status is the
    // word "close", and every count arrives as JSON `null` - while its mapping still
    // answers in full. So it can be described completely and honestly, with the counts
    // ABSENT rather than zero; dropping it would tell the user their index is gone when
    // it is merely closed, and a zero would claim it holds nothing.
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(CAT_INDICES_CLOSED_BODY));

    const schema = await provider.getSchema();

    expect(schema).toHaveLength(1);
    expect(schema[0].name).toBe("probe_closed");
    expect(schema[0].rowCount).toBeUndefined();
    expect(schema[0].size).toBeUndefined();
    expect("rowCount" in schema[0]).toBe(false);
  });

  test("getSchema reports an index with no mapping as having no fields, not as an error", async () => {
    // An index created without a mapping answers a present, EMPTY `mappings` object.
    // That is a fact about the index - a brand-new index really has no fields - so an
    // empty column list is the honest answer.
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(CAT_INDICES_CLOSED_BODY));

    const schema = await provider.getSchema();

    expect(schema[0].columns).toEqual([]);
  });

  test("getSchema hides the indices the engine keeps for itself", async () => {
    // Hiding them is the default because a developer writing a query does not want two
    // thirds of the sidebar to be indices they have never heard of - measured on a
    // stock OpenSearch node, two of three indices on an EMPTY cluster are the engine's
    // own bookkeeping.
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(CAT_INDICES_SYSTEM_BODY));

    expect(await provider.getSchema()).toEqual([]);
    // And no mapping was read for an index that was never going to be shown.
    expect(pathsSent()).not.toContain("/.probe_internal/_mapping");
  });

  test("getTables lists the index names", async () => {
    const provider = await connectProvider();

    expect(await provider.getTables()).toEqual(["probe_buckets", "probe_shapes", "probe_orders"]);
  });

  test("an index that vanished between the listing and its mapping costs its columns only", async () => {
    // The listing is a snapshot, so an index deleted in between is a race that happens
    // on a live cluster rather than a fault - and this is the second vocabulary the one
    // product speaks: the SQL endpoint reports Java class names while the CORE REST
    // layer keeps Elasticsearch's snake_case lineage, so `index_not_found_exception` has
    // to be classified for the mapping endpoint too.
    const provider = await connectProvider();
    replyFor = (request) =>
      request.path === "/probe_shapes/_mapping" ? fail(404, MAPPING_NOT_FOUND) : defaultReply(request);

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["probe_buckets", "probe_shapes", "probe_orders"]);
    expect(schema[1].columns).toEqual([]);
    expect(schema[2].columns).toHaveLength(5);
  });

  test("a per-index denial costs that index's columns and not the sidebar", async () => {
    // A security plugin grants index privileges PER INDEX, so a role that lists twenty
    // indices and may describe nineteen is an ordinary configuration; failing the whole
    // sidebar over the twentieth would punish a perfectly usable connection.
    const provider = await connectProvider();
    replyFor = (request) => (request.path === "/probe_orders/_mapping" ? fail(403, NO_BODY) : defaultReply(request));

    const schema = await provider.getSchema();

    expect(schema).toHaveLength(3);
    expect(schema[2].columns).toEqual([]);
  });

  test("an unreachable cluster fails the tree instead of reporting empty indices", async () => {
    // Everything but `auth` and `unknown-object` propagates on purpose: rendering every
    // index with zero columns reads as "these indices have no fields", which is a
    // fabricated schema and the failure mode that hides the real error forever.
    const provider = await connectProvider();
    networkFailure = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

    await expect(provider.getSchema()).rejects.toBeInstanceOf(ConnectionError);
  });

  test("a denied index listing fails rather than presenting an empty cluster", async () => {
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", fail(403, NO_BODY));

    await expect(provider.getSchema()).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("declares neither getSchemaList nor getSchemaRelations", async () => {
    // Both are optional and the split exists so a slow relationship read cannot block
    // the table list - which this engine has neither half of: a list would be
    // byte-identical to getSchema and a relations pass would re-read every mapping to
    // answer two empty arrays per index. The client falls back to getSchema().
    const provider = await connectProvider();
    const surface = provider as unknown as Record<string, unknown>;

    expect(surface.getSchemaList).toBeUndefined();
    expect(surface.getSchemaRelations).toBeUndefined();
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("ElasticsearchProvider monitoring", () => {
  test("getOverview describes the cluster from three parallel reads", async () => {
    // Three rather than one: the version payload is unauthenticated on a stock node,
    // the index listing needs monitor privileges per index, and the cluster-wide store
    // size comes from a heavier read a restricted role may not hold at all.
    const provider = await connectProvider();

    const overview = await provider.getOverview();

    // The product name comes from the CONNECTION, not from the payload's distribution
    // field: the connect probe already proved which product is listening, and
    // `elasticsearch` in lowercase is a wire word rather than the name it goes by.
    expect(overview.version).toBe("Elasticsearch 9.1.4");
    // Neither the health nor the version payload carries an uptime, and no other call
    // in this seam does either. A "0s" would claim the cluster booted this instant.
    expect(overview.uptime).toBe("N/A");
    expect(overview.databaseSizeBytes).toBe(84703);
    expect(overview.databaseSize).toBe("82.72 KB");
    expect(overview.tableCount).toBe(3);
    // No secondary-index OBJECT to count, and no session or pool to report: the open
    // HTTP connections per node live in a stats API this seam does not carry, and the
    // shard and node counts would be a different number wearing this field's name.
    expect(overview.indexCount).toBe(0);
    // `in` rather than `toBeUndefined()`: a fabricated 0 and a missing key are the two
    // outcomes being told apart here, and only a presence check fails on the first.
    expect("activeConnections" in overview).toBe(false);
    // The ceiling is the opposite encoding on purpose: `DatabaseOverview.maxConnections`
    // is a required number where 0 MEANS "no limit published", which is why the
    // Connections card reads it as "no limit" rather than dividing by it.
    expect(overview.maxConnections).toBe(0);
  });

  test("getOverview counts indices, and only the user's", async () => {
    // `tableCount` counts INDICES because an index is the table here, and counts what
    // the schema tree shows by default - counting the engine's own bookkeeping would
    // report a cluster holding data nobody put there.
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(CAT_INDICES_SYSTEM_BODY));

    expect((await provider.getOverview()).tableCount).toBe(0);
  });

  test("getOverview says unknown rather than zero when the store size is refused", async () => {
    // `_cluster/stats` is heavier and more privileged than `_cluster/health`, so a
    // cluster that answers health and refuses stats is an ordinary configuration -
    // and losing the health status over a missing byte count would blank a panel that
    // had the important number already.
    const provider = await connectProvider();
    overridePath("/_cluster/stats", fail(403, NO_BODY));

    const overview = await provider.getOverview();

    expect(overview.databaseSize).toBe("N/A");
    // The string said "N/A" while the number said 0 bytes, in the SAME object
    // (docs/BACKLOG.md D44). `databaseSizeBytes` is optional so the absence can be said,
    // and the Storage tab draws its own refusal rather than a 0.0% breakdown from a 0.
    expect("databaseSizeBytes" in overview).toBe(false);
    expect(overview.tableCount).toBe(3);
  });

  test("getOverview OMITS activeConnections rather than sending a 0 that reads as a count", async () => {
    // Nothing in this seam's five calls carries a connection count: the cluster counts
    // open HTTP connections per node in a stats API this provider never calls, and the
    // shard and node counts that ARE here would be a different number wearing this
    // field's name. So there is no measurement to publish, which is the case the
    // optional field exists for (#517).
    const provider = await connectProvider();

    const overview = await provider.getOverview();

    expect("activeConnections" in overview).toBe(false);
    expect(overview.activeConnections).toBeUndefined();
  });

  test("getHealth omits the connection count too rather than flattening it to 0", async () => {
    // `HealthInfo.activeConnections` is optional for the identical reason, so the
    // absence has to survive the composition instead of being filled in by it.
    const provider = await connectProvider();

    const health = await provider.getHealth();

    expect("activeConnections" in health).toBe(false);
  });

  test("getOverview arms one deadline for the whole panel", async () => {
    const provider = await connectProvider();
    armedDeadlines = [];

    await provider.getOverview();

    expect(armedDeadlines).toEqual([60_000]);
  });

  test("a monitoring failure that is not a per-index denial propagates", async () => {
    const provider = await connectProvider();
    overridePath("/_cluster/health", fail(500, DIVIDE_BY_ZERO));

    await expect(provider.getOverview()).rejects.toBeInstanceOf(QueryError);
  });

  test("getPerformanceMetrics is EMPTY rather than zeroed, and asks the cluster nothing", async () => {
    // Emptiness is the load-bearing part: `cacheHitRatio` is scored `direction:
    // "below"` with `critical: 80` by DEFAULT_THRESHOLDS, so a "neutral" 0 would paint
    // a red critical cache fault on every healthy cluster - the monitoring tabs default
    // an ABSENT ratio to a healthy 100 instead. Every other metric would read as a
    // measurement of zero, which is a different and false claim. These numbers do exist
    // on both products' stats endpoints, so this is a recorded gap rather than an
    // impossibility.
    const provider = await connectProvider();
    sent = [];

    const performance = await provider.getPerformanceMetrics();

    expect(performance).toEqual({});
    expect("cacheHitRatio" in performance).toBe(false);
    expect(sent).toEqual([]);
  });

  test("getSlowQueries is empty and sends nothing, because no API returns finished queries", async () => {
    // Elasticsearch's slow log is written to the node's LOG FILE, which no API returns.
    // OpenSearch really does keep top-N queries in an index this provider hides as
    // bookkeeping - but reading it would be a monitoring surface that exists on one of
    // the two products behind one code path, i.e. exactly the branch on product
    // identity the seam forbids. Empty rather than thrown: nothing is broken, so the
    // tab should render as quiet, not as failed.
    const provider = await connectProvider();
    sent = [];
    const monitored: DatabaseProvider = provider;

    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await monitored.getSlowQueries({ limit: 5 })).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("getIndexStats is empty and sends nothing, because no index object exists", async () => {
    // Listing one row per field would report the same fact twice - once as a column in
    // the tree and once as an index here.
    const provider = await connectProvider();
    sent = [];
    const monitored: DatabaseProvider = provider;

    expect(await provider.getIndexStats()).toEqual([]);
    expect(await monitored.getIndexStats({ schema: "" })).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("getActiveSessions is empty and sends nothing, because there are no sessions", async () => {
    // A request is one HTTP request: there is no connection catalog and no session
    // concept in either product. The closest thing is a running search TASK, in a task
    // API this seam does not carry - and a search measured in milliseconds would be a
    // list that is empty whenever anybody looks at it.
    const provider = await connectProvider();
    sent = [];
    const monitored: DatabaseProvider = provider;

    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await monitored.getActiveSessions({ limit: 50 })).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("getTableStats reports documents and bytes per index, from the one listing", async () => {
    // Documents are the rows and the primary store is all the bytes an index has: the
    // inverted indexes live inside the shard's segments, so the table size and the
    // total size are the same number rather than one being the other plus an index
    // total. The count is the CLUSTER's own and counts more documents than a statement
    // can return - a `nested` element is stored as a document of its own - so this is
    // the index's document count and not the number of rows a SELECT would produce.
    const provider = await connectProvider();

    const stats = await provider.getTableStats();

    expect(stats).toEqual([
      {
        // No schema name: both products' own SQL surfaces say an index has no namespace
        // above it, and the empty string renders as no prefix at all.
        schemaName: "",
        tableName: "probe_buckets",
        rowCount: 1500,
        tableSize: "67.24 KB",
        tableSizeBytes: 68855,
        totalSize: "67.24 KB",
        totalSizeBytes: 68855,
      },
      {
        schemaName: "",
        tableName: "probe_shapes",
        rowCount: 2,
        tableSize: "9.7 KB",
        tableSizeBytes: 9935,
        totalSize: "9.7 KB",
        totalSizeBytes: 9935,
      },
      {
        schemaName: "",
        tableName: "probe_orders",
        rowCount: 1,
        tableSize: "5.77 KB",
        tableSizeBytes: 5913,
        totalSize: "5.77 KB",
        totalSizeBytes: 5913,
      },
    ]);
  });

  test("getTableStats omits the optional size fields for a closed index, and zeroes only the required ones", async () => {
    // A closed index reports neither a count nor a size. `TableStats.rowCount`, `totalSize`
    // and `totalSizeBytes` are required numbers, so those three have nowhere to read but
    // zero; `tableSize` and `tableSizeBytes` are OPTIONAL, and a 0 there is a fabricated
    // measurement rather than a forced one, so they are absent.
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(CAT_INDICES_CLOSED_BODY));

    const stats = await provider.getTableStats();

    expect(stats).toEqual([
      {
        schemaName: "",
        tableName: "probe_closed",
        rowCount: 0,
        totalSize: "0 B",
        totalSizeBytes: 0,
      },
    ]);
    // Absent, not zero: `toEqual` ignores an undefined value, so the key itself is the
    // assertion.
    expect("tableSize" in stats[0]).toBe(false);
    expect("tableSizeBytes" in stats[0]).toBe(false);
  });

  test("getTableStats lets one closed index take the cluster's Data figure away from an open one", async () => {
    // The visible consequence of the omission above, and why it needed a decision rather
    // than a patch: `StorageTab` gates its Data figure on
    // `tables.every((t) => t.tableSizeBytes !== undefined)`, so the open index's measured
    // bytes stop being summed as soon as one index in the cluster published nothing. That
    // is what the optional field prescribes - a partial sum reads as a measurement - and it
    // is still a change a user sees, so the aggregate is asserted here, not inferred.
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(CAT_INDICES_MIXED_BODY));

    const stats = await provider.getTableStats();

    expect(stats).toEqual([
      {
        schemaName: "",
        tableName: "probe_orders",
        rowCount: 1,
        tableSize: "5.77 KB",
        tableSizeBytes: 5913,
        totalSize: "5.77 KB",
        totalSizeBytes: 5913,
      },
      {
        schemaName: "",
        tableName: "probe_closed",
        rowCount: 0,
        totalSize: "0 B",
        totalSizeBytes: 0,
      },
    ]);
    expect(stats.every((row) => row.tableSizeBytes !== undefined)).toBe(false);
  });

  test("getTableStats answers a named schema without a round trip", async () => {
    // An index has no namespace above it, so any named schema selects nothing - and a
    // predicate that can never match is slower and less obviously right than not
    // asking. The empty string is the engines' own answer and the only value that
    // matches.
    const provider = await connectProvider();
    sent = [];

    expect(await provider.getTableStats({ schema: "public" })).toEqual([]);
    expect(sent).toEqual([]);
    expect(await provider.getTableStats({ schema: "" })).toHaveLength(3);
    expect(pathsSent()).toEqual(["/_cat/indices?format=json&bytes=b"]);
  });

  test("getTableStats excludes engine bookkeeping, exactly as the schema tree does", async () => {
    const provider = await connectProvider();
    overridePath("/_cat/indices?format=json&bytes=b", ok(CAT_INDICES_SYSTEM_BODY));

    expect(await provider.getTableStats()).toEqual([]);
  });

  test("getStorageStats reports the cluster as the one storage unit there is", async () => {
    // A search cluster has no tablespaces, no data files a user placed and no per-node
    // disk figure crossing this seam, so the honest unit is the cluster: its name and
    // the bytes its indices occupy including replicas. `usagePercent` is omitted rather
    // than zeroed because no capacity crosses the seam either, and a zero would render
    // as "0% used" of a disk nobody measured.
    const provider = await connectProvider();

    const storage = await provider.getStorageStats();

    expect(storage).toEqual([{ name: "docker-cluster", size: "82.72 KB", sizeBytes: 84703 }]);
    expect("usagePercent" in storage[0]).toBe(false);
  });

  test("getStorageStats reports NO row when the size was not published", async () => {
    // A row claiming the cluster stores zero bytes would be a statement the cluster
    // never made - worse than an empty panel that says nothing.
    const provider = await connectProvider();
    overridePath("/_cluster/stats", fail(403, NO_BODY));

    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("getHealth says the cache ratio is unavailable rather than inventing one", async () => {
    // The field is a STRING, so it can say so - and a fabricated low number would trip
    // the cache-ratio threshold into reporting a fault that does not exist. The three
    // empty fields are the same facts the methods above state.
    const provider = await connectProvider();

    const health = await provider.getHealth();

    expect(health.cacheHitRatio).toBe("N/A");
    expect("activeConnections" in health).toBe(false);
    expect(health.databaseSize).toBe("82.72 KB");
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
  });

  test("getMonitoringData fills every panel that has a source on a healthy cluster", async () => {
    const provider = await connectProvider();

    const data = await provider.getMonitoringData();

    expect(data.overview?.version).toBe("Elasticsearch 9.1.4");
    expect(data.tables).toHaveLength(3);
    expect(data.storage).toHaveLength(1);
    expect(data.performance).toEqual({});
    expect(data.slowQueries).toEqual([]);
    expect(data.activeSessions).toEqual([]);
    expect(data.indexes).toEqual([]);
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("ElasticsearchProvider maintenance", () => {
  test.each<[string]>([["vacuum"], ["analyze"], ["reindex"], ["kill"], ["optimize"], ["check"]])(
    "refuses %s, because no SQL statement reaches it",
    async (operation) => {
      // Absent from `maintenanceOperations`, and `/api/db/maintenance` answers 400
      // before it would call this - so the refusal exists for a programmatic caller of
      // the package. Throwing rather than reporting a cheerful success is the point: a
      // caller that asked for work must not be told work happened. Refresh, force-merge
      // and cache clearing are index APIs rather than statements, and `kill` is
      // impossible for a second reason - an abort closes this client's socket while the
      // cluster keeps working.
      const provider = await connectProvider();
      sent = [];

      const failure = provider.runMaintenance(operation as "vacuum");

      await expect(failure).rejects.toBeInstanceOf(QueryError);
      await expect(failure).rejects.toThrow(operation);
      await expect(failure).rejects.toThrow(/no SQL-reachable maintenance operation/);
      expect(sent).toEqual([]);
    },
  );
});
