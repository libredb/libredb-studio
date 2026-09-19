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
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import { ElasticsearchProvider } from "@/lib/db/providers/sql/search";
import { generateTableQuery } from "@/lib/query-generators";
import { isSourcePartUnavailable } from "@/lib/db/object-kinds";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
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

const SQL_QUERY_OPTIONS = {
  field_multi_value_leniency: true,
} as const;

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
 *
 * The last row is the data stream's BACKING INDEX, and it is here because the whole
 * argument for declaring `stream` as its own kind rests on it: a backing index is
 * `.ds-`-prefixed, so the index listing's own dot rule already hides it, which is why
 * a data stream is reachable through nothing in the tree without that kind AND why
 * counting both kinds double-counts nothing. Without this row that premise is prose;
 * with it, `index` is still 3 and `stream` is still 1.
 */
const CAT_INDICES_BODY = JSON.stringify([
  {
    health: "yellow",
    status: "open",
    index: ".ds-probe_stream-2026.09.11-000001",
    uuid: "hVj2mS9dQ1O3hQxhIlP9Aw",
    pri: "1",
    rep: "1",
    "docs.count": "1",
    "docs.deleted": "0",
    "store.size": "6284",
    "pri.store.size": "6284",
    "dataset.size": "6284",
  },
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
 * A 404 that is a REFUSAL and not an empty set (#789).
 *
 * The pipeline endpoint's 404 means "there are none" only while the body is `{}`.
 * Measured on both products 2026-09-11, a genuine 404 on an object endpoint carries
 * the full error envelope - `GET /_data_stream/nope` answers
 * `index_not_found_exception`, "no such index [nope]" - so the body is what separates
 * a folder that holds nothing from a folder nobody may read. This one wears the same
 * fault name against the pipeline store, which is what a cluster missing that backing
 * index answers.
 */
const MISSING_PIPELINE_INDEX = engineFault(404, "index_not_found_exception", "no such index [nope_pipeline_store]");

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
// Object-surface payloads (#789)
// ============================================================================

/**
 * The four REST listings the object surface reads, captured from a live
 * Elasticsearch 9.1.4 node on 2026-09-11 with `docker/search-init/01-object-fixture.sh`
 * applied.
 *
 * The SQL endpoint is NOT where these objects live, and that is the reason this task
 * is separate from the SQL engines: neither product's SQL grammar has a CREATE
 * statement of any kind, so nothing here has a catalog query behind it. Every body
 * below is one GET.
 *
 * Each payload carries the engine's own bookkeeping beside the fixture's objects,
 * because the filter that removes it is the part a fixture-shaped test cannot see:
 * a stock node really does ship 21 pipelines and 61 index templates, all managed, and
 * a count that included them would report a user's single pipeline as 22.
 */
const ALIAS_BODY = JSON.stringify({
  // Keyed by INDEX, with an inner map of that index's aliases. An index carrying no
  // alias is still listed, with an empty map.
  probe_orders: { aliases: { probe_orders_alias: {}, shared_alias: {} } },
  probe_shapes: { aliases: {} },
  // The SAME alias on a second index. Measured: the listing names it under both, and
  // the tree addresses an alias by name, so the listing has to deduplicate or the
  // folder holds one object at two identical paths.
  probe_buckets: { aliases: { shared_alias: {} } },
  // A dot-prefixed alias, which a user CAN create (measured, `POST /_aliases` adding
  // `.dot_alias` answers acknowledged) and which the dot convention hides anyway -
  // the same cost the index listing already pays, recorded in both provider docs.
  ".probe_internal": { aliases: { ".probe_internal_alias": {} } },
});

/**
 * `GET /_ingest/pipeline`, trimmed to the members that decide anything.
 *
 * `_meta.managed` is the whole filter here: all 21 built-ins carry it and NONE of
 * them carries a dot, so a dot-only rule would show every one of them.
 */
const PIPELINES_BODY = JSON.stringify({
  "apm@pipeline": { version: 12, _meta: { managed: true }, processors: [] },
  "logs-apm.app@default-pipeline": { version: 101, _meta: { managed: true }, processors: [] },
  probe_pipeline: { description: "libredb object-surface fixture (#789)", processors: [] },
  // The two objects the SOURCE read (#789) needs, both created by
  // `docker/search-init/01-object-fixture.sh` and both listed here because the listing
  // is what the source walk takes its objects from. `probe pipe/slash` sorts FIRST of
  // the three (a space is below an underscore), so the conformance walk's first
  // pipeline is the one whose name has to be percent-encoded to be read at all.
  "probe pipe/slash": { description: "libredb source-read escaping fixture (#789)", processors: [] },
  probe_json_edges: { description: "libredb source-render fidelity fixture (#789)", processors: [] },
});

/**
 * `GET /_ingest/pipeline/probe_pipeline` - one object, keyed by its own id.
 *
 * Captured verbatim from Elasticsearch 9.1.4 on 2026-09-13. The per-object endpoint
 * answers the SAME wrapper the listing does, so the definition is the value under the
 * id key and never the whole body: rendering the body would show the reader a map with
 * their object's name as its only key.
 */
const PIPELINE_SOURCE_BODY =
  '{"probe_pipeline":{"description":"libredb object-surface fixture (#789)",' +
  '"processors":[{"set":{"field":"seen","value":"yes"}}]}}';

/**
 * `GET /_ingest/pipeline/probe_json_edges` - the renderer-fidelity object.
 *
 * Captured verbatim, and the three values in it are the ones a JSON re-serialisation
 * changes: `9223372036854775807` is past 2^53, `1.0E30` is the server's own spelling of
 * an exponent, and the `keys` map is ordered `zz, 10, 2, aa` on the wire. What this
 * product's renderer does to each is asserted below and recorded in both provider docs.
 */
const PIPELINE_JSON_EDGES_BODY =
  '{"probe_json_edges":{"description":"libredb source-render fidelity fixture (#789)",' +
  '"processors":[{"set":{"field":"big","value":9223372036854775807}},' +
  '{"set":{"field":"sci","value":1.0E30}},' +
  '{"set":{"field":"keys","value":{"zz":1,"10":"ten","2":"two","aa":2}}}]}}';

/** `GET /_ingest/pipeline/probe%20pipe%2Fslash` - the name that must be encoded. */
const PIPELINE_SLASH_SOURCE_BODY =
  '{"probe pipe/slash":{"description":"libredb source-read escaping fixture (#789)",' +
  '"processors":[{"set":{"field":"escaped","value":"yes"}}]}}';

/**
 * `GET /_index_template/probe_template`, captured verbatim.
 *
 * The per-object endpoint answers the LISTING shape - an array under one key - so the
 * definition is the `index_template` of the entry whose `name` equals the one asked
 * for. Measured on both products: `GET /_index_template/probe*` answers TWO entries, so
 * taking entry zero would render another object's definition as this one's.
 */
const TEMPLATE_SOURCE_BODY =
  '{"index_templates":[{"name":"probe_template","index_template":{"index_patterns":["probe-template-*"],' +
  '"template":{"mappings":{"properties":{"id":{"type":"long"}}}},"composed_of":[]}}]}';

/**
 * `GET /_index_template/probe_stream_template`, captured verbatim.
 *
 * The template that admits the data stream, and the one whose definition DIFFERS between
 * the two products: Elasticsearch expands `"data_stream": {}` to `hidden` and
 * `allow_custom_routing` while OpenSearch expands it to `timestamp_field` (both measured
 * 2026-09-13 from the same fixture line). It is the FIRST template of the folder by sort
 * order, so it is what the conformance walk and the declaration-driven read below take.
 */
const STREAM_TEMPLATE_SOURCE_BODY =
  '{"index_templates":[{"name":"probe_stream_template","index_template":{"index_patterns":["probe_stream*"],' +
  '"template":{"mappings":{"properties":{"@timestamp":{"type":"date"}}}},"composed_of":[],' +
  '"data_stream":{"hidden":false,"allow_custom_routing":false}}}]}';

/**
 * `GET /_index_template/no_such_template` - HTTP 404 carrying the FULL error envelope.
 *
 * Measured on Elasticsearch 9.1.4 and OpenSearch 3.8.0 on 2026-09-13, and it refutes the
 * rule the LISTING endpoints follow: on a single-object endpoint a 404 is absence
 * whatever the body carries, because the pipeline endpoint answers `{}` for exactly the
 * same event. Reading this envelope as a refusal would put "index template matching
 * [x] not found" in the Source pane as the cluster's refusal instead of raising.
 */
const TEMPLATE_ABSENT_BODY =
  '{"error":{"root_cause":[{"type":"resource_not_found_exception","reason":' +
  '"index template matching [no_such_template] not found"}],"type":"resource_not_found_exception",' +
  '"reason":"index template matching [no_such_template] not found"},"status":404}';

/**
 * `GET /_index_template`.
 *
 * Four of the 61 built-ins are NOT managed - `.monitoring-beats-mb`,
 * `.monitoring-kibana-mb`, `.monitoring-logstash-mb`, `.monitoring-es-mb` - and carry
 * a dot instead, which is why the rule reads both signals and one of them is here.
 */
const TEMPLATES_BODY = JSON.stringify({
  index_templates: [
    // Managed AND dot-free, which is what makes `_meta.managed` load-bearing: 43 of
    // the 61 built-ins carry no dot, so a dot-only rule leaves every one of them in.
    // The marker lives one level down, under `index_template`, not on the entry.
    {
      name: "logs-apm.error@template",
      index_template: { index_patterns: ["logs-apm.error-*"], _meta: { managed: true } },
    },
    { name: ".monitoring-es-mb", index_template: { index_patterns: [".monitoring-es-8-mb-*"] } },
    { name: "probe_template", index_template: { index_patterns: ["probe-template-*"] } },
    { name: "probe_stream_template", index_template: { index_patterns: ["probe_stream*"], data_stream: {} } },
  ],
});

/**
 * `GET /_data_stream`.
 *
 * The backing index is `.ds-`-prefixed, so the index listing hides it under the same
 * dot rule that hides an engine's own indices: without this listing a data stream is
 * reachable through nothing in the tree. Elasticsearch marks its own with
 * `"system": true`, which OpenSearch's payload omits entirely - and NEITHER member is
 * read: the dot rule already removes every engine-owned data stream that could be
 * measured, so the flag is carried here as the shape of the live payload and decides
 * nothing.
 */
const DATA_STREAMS_BODY = JSON.stringify({
  data_streams: [
    {
      name: "probe_stream",
      timestamp_field: { name: "@timestamp" },
      indices: [{ index_name: ".ds-probe_stream-2026.09.11-000001" }],
      generation: 1,
      status: "YELLOW",
      template: "probe_stream_template",
      hidden: false,
      system: false,
    },
    {
      name: ".fleet-actions-results",
      timestamp_field: { name: "@timestamp" },
      indices: [{ index_name: ".ds-.fleet-actions-results-2026.09.11-000001" }],
      generation: 1,
      status: "GREEN",
      template: ".fleet-actions-results",
      hidden: true,
      system: true,
    },
  ],
});

/** The mapping the alias and the data stream resolve to, both keyed by the concrete index. */
const ALIAS_MAPPING_BODY = JSON.stringify({
  probe_orders: { mappings: { properties: { customer: { type: "keyword" }, id: { type: "long" } } } },
});
/**
 * `GET /shared_alias/_mapping`, the SECOND alias, resolving to a DIFFERENT index.
 *
 * The two aliases of this fixture point at different indices here, which is what lets a
 * test tell an alias described from its own mapping from one handed the first alias's.
 */
const SHARED_ALIAS_MAPPING_BODY = JSON.stringify({
  probe_buckets: { mappings: { properties: { k: { type: "keyword" } } } },
});

/**
 * `GET /probe_buckets,probe_orders,probe_shapes/_mapping`, the whole index folder in one
 * request (#789).
 *
 * Keyed by the concrete index name, which for the INDEX kind is the name that was asked
 * for - that is the property the bulk read rests on, and the property an alias and a data
 * stream do not have.
 *
 * COMPOSED from the three single-index bodies rather than written again, so the bulk read
 * and the single read cannot be compared against two different servers: a fixture that
 * quietly gave the batch a smaller mapping would make "the two answers agree" pass while
 * they described different indices.
 */
function bulkMappingBody(...names: string[]): string {
  const single: Record<string, string> = {
    probe_buckets: BUCKETS_MAPPING_BODY,
    probe_orders: ORDERS_MAPPING_BODY,
    probe_shapes: SHAPES_MAPPING_BODY,
  };
  return JSON.stringify(Object.assign({}, ...names.map((name) => JSON.parse(single[name]) as Record<string, unknown>)));
}

const STREAM_MAPPING_BODY = JSON.stringify({
  ".ds-probe_stream-2026.09.11-000001": {
    mappings: { _data_stream_timestamp: { enabled: true }, properties: { "@timestamp": { type: "date" } } },
  },
});

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
  // The object-surface listings (#789). Each is one GET, and the key is the exact
  // path the transport builds, so a changed path cannot silently be served another
  // endpoint's payload.
  "/_alias": ALIAS_BODY,
  "/_ingest/pipeline": PIPELINES_BODY,
  "/_index_template": TEMPLATES_BODY,
  // The per-object source reads (#789). Each key is the exact path the transport
  // builds, percent-encoding included, so a name written into the URL unencoded cannot
  // silently be served the object it names.
  "/_ingest/pipeline/probe_pipeline": PIPELINE_SOURCE_BODY,
  "/_ingest/pipeline/probe_json_edges": PIPELINE_JSON_EDGES_BODY,
  "/_ingest/pipeline/probe%20pipe%2Fslash": PIPELINE_SLASH_SOURCE_BODY,
  "/_index_template/probe_template": TEMPLATE_SOURCE_BODY,
  "/_index_template/probe_stream_template": STREAM_TEMPLATE_SOURCE_BODY,
  "/_data_stream": DATA_STREAMS_BODY,
  "/probe_orders_alias/_mapping": ALIAS_MAPPING_BODY,
  "/shared_alias/_mapping": SHARED_ALIAS_MAPPING_BODY,
  "/probe_stream/_mapping": STREAM_MAPPING_BODY,
  // The bulk column read (#789): ONE `_mapping` request naming every index of the
  // folder, keyed by the concrete index name. The key is the exact path the transport
  // builds, so a changed separator or a changed order cannot be served this payload.
  "/probe_buckets,probe_orders,probe_shapes/_mapping": bulkMappingBody("probe_buckets", "probe_orders", "probe_shapes"),
  "/probe_buckets,probe_orders/_mapping": bulkMappingBody("probe_buckets", "probe_orders"),
};

function defaultReply(request: SentRequest): Reply {
  const canned = PATH_BODIES[request.path];
  if (canned !== undefined) return ok(canned);

  // A NAMED object on either source endpoint that the canned set above does not hold,
  // answered the way the cluster answers it (#789): the pipeline endpoint spells absence
  // as HTTP 404 with `{}` and the template endpoint spells the same event as HTTP 404
  // with the full error envelope. Both measured 2026-09-13, and the two spellings are
  // why absence is decided on the status alone for a named object.
  if (request.path.startsWith("/_ingest/pipeline/")) return fail(404, "{}");
  if (request.path.startsWith("/_index_template/")) return fail(404, TEMPLATE_ABSENT_BODY);

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
      // ZERO container levels and five object kinds (#789). Spelled out here rather
      // than only in the object-surface block, because this is the test that fails
      // when a capability is ADDED without a decision: an index is not inside
      // anything, and the kinds are the four REST-listed objects plus the index
      // itself. The roles are asserted where they were measured.
      containerLevels: [],
      objectKinds: [
        { id: "index", role: "relation", label: "Index", labelPlural: "Indices", acceptsRowWrites: true },
        { id: "alias", role: "relation", label: "Alias", labelPlural: "Aliases" },
        { id: "stream", role: "relation", label: "Data Stream", labelPlural: "Data Streams" },
        {
          id: "pipeline",
          role: "config",
          label: "Ingest Pipeline",
          labelPlural: "Ingest Pipelines",
          hasSource: true,
          sourceLanguage: "json",
        },
        {
          id: "template",
          role: "config",
          label: "Index Template",
          labelPlural: "Index Templates",
          hasSource: true,
          sourceLanguage: "json",
        },
      ],
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
    expect(generateTableQuery(["orders"], capabilities)).toBe("SELECT * FROM orders LIMIT 50");
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

  // #708. Not a live-cluster measurement: `Authorization: ApiKey base64(id:secret)` is
  // Elasticsearch's published wire contract for its own auth scheme (elastic.co/docs/
  // deploy-manage/api-keys/elasticsearch-api-keys), the same status the Basic-auth
  // tests above are in - they assert what THIS CODE sends, not what a server does with
  // it. OpenSearch is out of scope: nothing here has measured whether its security
  // plugin accepts the same scheme, and the UI never offers these fields for it (see
  // db-ui-config.ts), so there is no reachable state that would need one.
  test("sends an API key pair as an ApiKey header, in preference to user/password", async () => {
    const provider = await connectProvider({
      apiKeyId: "EWkMhKACjF5eHMlg6Car",
      apiKeySecret: "y9cTq7AQ4u16CO_sKM0Knp",
      user: "reader",
      password: "s3cret",
    });

    const header = sent[0].auth ?? "";
    expect(header.startsWith("ApiKey ")).toBe(true);
    expect(Buffer.from(header.replace("ApiKey ", ""), "base64").toString()).toBe(
      "EWkMhKACjF5eHMlg6Car:y9cTq7AQ4u16CO_sKM0Knp",
    );
    await provider.disconnect();
  });

  // A half-configured pair is not a shorter key, it is a broken one - falls back to
  // Basic/none exactly as a plain `user`/`password` connection would, rather than
  // sending `ApiKey base64("id:")` for a secret that was never actually set.
  test("falls back to user/password when the API key pair is only half set", async () => {
    const provider = await connectProvider({
      apiKeyId: "EWkMhKACjF5eHMlg6Car",
      user: "reader",
      password: "s3cret",
    });

    const header = sent[0].auth ?? "";
    expect(header.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("reader:s3cret");
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
  test("queries a multi-valued event_subindustry keyword field with SQL leniency enabled", async () => {
    const provider = await connectProvider();
    overrideSql(ok('{"columns":[{"name":"event_subindustry","type":"keyword"}],"rows":[["Healthcare"]]}'));

    const result = await provider.query("SELECT event_subindustry FROM probe_orders");

    expect(result.rows).toEqual([{ event_subindustry: "Healthcare" }]);
    expect(result.fields).toEqual(["event_subindustry"]);
    expect(sqlRequests()[1].body).toEqual({
      query: "SELECT event_subindustry FROM probe_orders",
      ...SQL_QUERY_OPTIONS,
    });
  });

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
    expect(paging[0].body).toEqual({
      query: "SELECT k, COUNT(*) FROM probe_buckets GROUP BY k",
      ...SQL_QUERY_OPTIONS,
    });
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
    expect(sqlRequests()[1].body).toEqual({
      query: "SELECT id FROM probe_orders",
      ...SQL_QUERY_OPTIONS,
    });
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

// ============================================================================
// The object surface (#789)
// ============================================================================

/**
 * What the fixture holds once the engine's own objects are filtered out.
 *
 * `index` is 3 because `CAT_INDICES_BODY` holds three user indices; the other four
 * come from the bodies above. Every number here is a COUNT of what the listing
 * returns, which is the same read - see the provider's `readKind`.
 */
const FIXTURE_OBJECT_COUNTS = { index: 3, alias: 2, pipeline: 3, template: 2, stream: 1 };

describe("object surface", () => {
  test("declares the kinds a search cluster has, at zero container levels", () => {
    const capabilities = new ElasticsearchProvider(makeConnection()).getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id).sort()).toEqual(["alias", "index", "pipeline", "stream", "template"]);
    // An index takes a document write through the document APIs, which is the per-KIND
    // half and is deliberately not conjoined with the engine-wide
    // `supportsInlineRowEdit: false` this provider declares for a grammar with no
    // UPDATE in it.
    expect(kinds.find((kind) => kind.id === "index")?.acceptsRowWrites).toBe(true);
    // An alias is a RELATION and not config, and that is measured rather than
    // classified by intuition: `SELECT customer FROM probe_orders_alias` answers rows
    // on both products. It takes no row write, because an alias over several indices
    // has no single write target and the engine refuses an index request against one.
    expect(kinds.find((kind) => kind.id === "alias")?.role).toBe("relation");
    expect(kinds.find((kind) => kind.id === "alias")?.acceptsRowWrites).toBeUndefined();
    // A data stream is a relation for the same measured reason, and is append-only:
    // the engine refuses a plain index request against one.
    expect(kinds.find((kind) => kind.id === "stream")?.role).toBe("relation");
    expect(kinds.find((kind) => kind.id === "stream")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((kind) => kind.id === "pipeline")?.role).toBe("config");
    expect(kinds.find((kind) => kind.id === "template")?.role).toBe("config");

    // Absent, not declared-and-zero. Neither product's SQL surface has CREATE VIEW,
    // OpenSearch's grammar has no CREATE statement at all, and neither has a
    // user-defined function, a stored procedure or a trigger. Elasticsearch 9.4's
    // ES|QL views API is a technical preview and gets no folder either.
    for (const absent of ["view", "function", "procedure", "trigger", "script"]) {
      expect(kinds.find((kind) => kind.id === absent)).toBeUndefined();
    }

    // Zero container levels: an index is not inside anything. Both products' own SQL
    // surfaces say so - OpenSearch answers `TABLE_SCHEM` null and Elasticsearch reports
    // only a cluster name that is not addressable in a statement.
    expect(capabilities.containerLevels).toEqual([]);
  });

  test("satisfies the shared object surface contract", async () => {
    const provider = await connectProvider();

    await assertObjectSurface(provider, {
      // A zero-level engine lists NO containers, and the helper addresses every object
      // at the root container. `[[]]` would assert that `listContainers()` answers one
      // container whose path is empty, which is a different and untrue claim.
      containers: [],
      kinds: FIXTURE_OBJECT_COUNTS,
      sampleObject: { path: ["probe_orders_alias"], kind: "alias" },
      // The absence raise, driven on the kind whose endpoint spells absence as an EMPTY
      // body. The template endpoint spells the same event with a full error envelope,
      // and both raises are asserted separately in the source block below.
      absentSource: { path: ["no_such_pipeline"], kind: "pipeline" },
    });
  });

  test("declares source on exactly the kinds that have a definition text", () => {
    const kinds = new ElasticsearchProvider(makeConnection()).getCapabilities().objectKinds ?? [];

    const declared = kinds
      .filter((kind) => kind.hasSource === true)
      .map((kind) => [kind.id, kind.sourceLanguage] as const)
      .sort();

    expect(declared).toEqual([
      ["pipeline", "json"],
      ["template", "json"],
    ]);
    // The other direction, so a kind added later cannot quietly gain a Source tab. Each
    // of these three is a different absence and each is recorded in
    // docs/providers/elasticsearch.md: an index's settings are the SERVER's own writing
    // and no round trip could be established, one alias over N indices has one definition
    // PER INDEX while the tree deduplicates those rows to one, and a data stream's
    // definition IS the matching index template, which is a different object in a
    // different folder.
    expect(
      kinds
        .filter((kind) => kind.hasSource !== true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual(["alias", "index", "stream"]);
  });
});

/**
 * The listings, the detail row and the refusals, kept out of the block above so
 * `-t "object surface"` still runs the shared contract on its own.
 */
describe("Elasticsearch object listings and detail", () => {
  test("there is no container level, so the tree opens straight onto the kind folders", async () => {
    const provider = await connectProvider();
    sent = [];

    // Empty rather than one root container, and answered without a round trip: a
    // search cluster has nothing above an index, so first paint costs one
    // `countObjects` and no container walk at all.
    expect(await provider.listContainers()).toEqual([]);
    // A nested call is the same statement about the same engine, not a different one.
    expect(await provider.listContainers(["anything"])).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("the count and the listing are the same read, filtered the same way", async () => {
    const provider = await connectProvider();

    const counts = await provider.countObjects([]);
    expect(counts).toEqual({
      index: { count: 3 },
      alias: { count: 2 },
      stream: { count: 1 },
      pipeline: { count: 3 },
      template: { count: 2 },
    });

    // Every number above is the length of the listing below, kind by kind. That is
    // ruling 5f held on a REST surface: both go through `readKind`.
    for (const [kind, count] of Object.entries(counts)) {
      const listed = await provider.listObjects([], kind);
      expect(listed).toHaveLength((count as { count: number }).count);
      expect(listed.every((object) => object.kind === kind)).toBe(true);
      expect(listed.every((object) => object.path.length === 1)).toBe(true);
    }
  });

  test("the engine's own objects are removed, and a dot is not the only signal", async () => {
    const provider = await connectProvider();

    // 21 managed ingest pipelines ship on a stock node and NONE of them carries a dot,
    // so a dot-only rule would report this user's single pipeline as a folder of 22.
    expect((await provider.listObjects([], "pipeline")).map((object) => object.name)).toEqual([
      "probe pipe/slash",
      "probe_json_edges",
      "probe_pipeline",
    ]);
    // And the reverse: `.monitoring-es-mb` is one of the four built-in templates that
    // carry NO managed marker, so a managed-only rule would leave it in.
    expect((await provider.listObjects([], "template")).map((object) => object.name)).toEqual([
      "probe_stream_template",
      "probe_template",
    ]);
    // `.fleet-actions-results` is removed by the DOT rule alone. Its `"system": true`
    // member is deliberately not read - `DATA_STREAM_FIELDS` says so, because M4
    // measured that no fixture can distinguish the two rules - so this assertion is
    // about the dot, and the payload's system flag is inert vocabulary beside it.
    expect((await provider.listObjects([], "stream")).map((object) => object.name)).toEqual(["probe_stream"]);
  });

  test("one alias on two indices is one object, and a dot-prefixed alias is the engine's", async () => {
    const provider = await connectProvider();

    // `shared_alias` is listed under `probe_orders` AND `probe_buckets` in the same
    // payload. The tree addresses an alias by name, so without the dedupe this folder
    // holds two rows at one identical path, which the conformance helper refuses.
    const aliases = await provider.listObjects([], "alias");

    expect(aliases.map((object) => object.name)).toEqual(["probe_orders_alias", "shared_alias"]);
    expect(new Set(aliases.map((object) => JSON.stringify(object.path))).size).toBe(aliases.length);
  });

  test("an index, an alias and a data stream are described from their mapping", async () => {
    const provider = await connectProvider();

    // An alias resolves to the index behind it and a data stream to its backing index,
    // and both come back keyed by the CONCRETE index name - which is why the detail
    // read cannot look the payload up by the name it asked for.
    const alias = await provider.describeObject(["probe_orders_alias"], "alias");
    expect(alias.path).toEqual(["probe_orders_alias"]);
    expect(alias.columns.map((column) => column.name)).toEqual(["customer", "id"]);

    const stream = await provider.describeObject(["probe_stream"], "stream");
    expect(stream.columns.map((column) => column.name)).toEqual(["@timestamp"]);

    // Empty by construction on every kind: every mapped field is inverted-indexed as a
    // property of being mapped, so no secondary-index object exists to name, and the
    // engine has no foreign key constraint in its model at all.
    expect(alias.indexes).toEqual([]);
    expect(alias.foreignKeys).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // describeObjects, the bulk column read (#789)
  // --------------------------------------------------------------------------

  test("reads a whole index folder's mappings in ONE request", async () => {
    const provider = await connectProvider();
    sent = [];

    const batch = await provider.describeObjects!([], "index");

    expect(batch.details.map((detail) => detail.path)).toEqual([["probe_buckets"], ["probe_orders"], ["probe_shapes"]]);
    expect(batch.truncated).toBeUndefined();
    // Each index carries ITS OWN fields, taken from the key the cluster answered under.
    // `k.keyword` is a multi-field and is dropped by the SAME rule the single read
    // applies, because OpenSearch cannot select one - so the two answers agree here too.
    expect(batch.details.map((detail) => detail.columns.map((column) => column.name))).toEqual([
      ["k"],
      ["created", "customer", "id", "note", "total"],
      ["address.city", "note"],
    ]);
    // ONE mapping request for the three, and it names all three: a loop over
    // `describeObject` would send three, each preceded by its own `_cat/indices` read.
    expect(pathsSent().filter((path) => path.endsWith("/_mapping"))).toEqual([
      "/probe_buckets,probe_orders,probe_shapes/_mapping",
    ]);
  });

  test("chunks the request so a wide folder cannot outgrow the cluster's request-line limit", async () => {
    // Measured on 9.1.4: a `_mapping` request whose index list is 3,999 characters answers
    // 200 and one of 4,499 answers HTTP 400, `too_long_http_line_exception`, "An HTTP line
    // is larger than 4096 bytes." So the whole folder in one URL is not an option, and the
    // chunking is bounded by BYTES rather than by a count of names, because an index name
    // may be up to 255 bytes.
    const wide = Array.from({ length: 60 }, (_, index) => `bench_${String(index).padStart(3, "0")}_${"x".repeat(80)}`);
    const provider = await connectProvider();
    // Every index has a mapping of its own, synthesised from whatever names the URL
    // carries, so the chunk boundaries are the only thing under test here.
    replyFor = (request) => {
      if (request.path === "/_cat/indices?format=json&bytes=b") {
        return ok(JSON.stringify(wide.map((index) => ({ index, status: "open", "docs.count": "1" }))));
      }
      if (request.path.endsWith("/_mapping")) {
        const names = decodeURIComponent(request.path.slice(1, -"/_mapping".length)).split(",");
        return ok(
          JSON.stringify(
            Object.fromEntries(names.map((name) => [name, { mappings: { properties: { a: { type: "long" } } } }])),
          ),
        );
      }
      return defaultReply(request);
    };
    sent = [];

    const batch = await provider.describeObjects!([], "index");

    expect(batch.details.map((detail) => detail.path[0])).toEqual([...wide].sort());
    const mappingPaths = pathsSent().filter((path) => path.endsWith("/_mapping"));
    expect(mappingPaths.length).toBeGreaterThan(1);
    // Every request stays well under the 4,096-byte line, and no name is asked for twice.
    for (const path of mappingPaths) expect(path.length).toBeLessThan(4000);
    const asked = mappingPaths.flatMap((path) => decodeURIComponent(path.slice(1, -"/_mapping".length)).split(","));
    expect(asked).toEqual([...wide].sort());
  });

  test("an alias and a data stream are read one at a time, because the answer is keyed by the INDEX", async () => {
    const provider = await connectProvider();
    sent = [];

    const aliases = await provider.describeObjects!([], "alias");

    expect(aliases.details.map((detail) => detail.path)).toEqual([["probe_orders_alias"], ["shared_alias"]]);
    expect(aliases.details.map((detail) => detail.columns.map((column) => column.name))).toEqual([
      ["customer", "id"],
      ["k"],
    ]);
    // TWO requests, one per alias, and that is measured rather than lazy: an alias
    // resolves to the index behind it, so a combined request comes back keyed by the
    // CONCRETE index and two aliases on one index answer ONE key (measured on 9.1.4,
    // `GET /probe_orders_alias,alias_two/_mapping` answers `{"probe_orders": ...}`).
    // There is nothing in that answer to attribute a mapping back to an alias with.
    expect(pathsSent().filter((path) => path.endsWith("/_mapping"))).toEqual([
      "/probe_orders_alias/_mapping",
      "/shared_alias/_mapping",
    ]);

    sent = [];
    const streams = await provider.describeObjects!([], "stream");
    expect(streams.details.map((detail) => detail.columns.map((column) => column.name))).toEqual([["@timestamp"]]);
    expect(pathsSent().filter((path) => path.endsWith("/_mapping"))).toEqual(["/probe_stream/_mapping"]);
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
    sent = [];

    const batch = await provider.describeObjects!([], "index", 2);

    expect(batch.details.map((detail) => detail.path)).toEqual([["probe_buckets"], ["probe_orders"]]);
    expect(batch.truncated).toEqual({
      limit: 2,
      reason: "the bulk column read was bounded at 2 objects by its caller",
    });
    // The bound reaches the WIRE: the third index is not in the URL at all.
    expect(pathsSent().filter((path) => path.endsWith("/_mapping"))).toEqual(["/probe_buckets,probe_orders/_mapping"]);
  });

  test("a bound the folder fits inside reports nothing, on either side of the boundary", async () => {
    const provider = await connectProvider();

    expect((await provider.describeObjects!([], "index", 3)).truncated).toBeUndefined();
    expect((await provider.describeObjects!([], "index", 4)).truncated).toBeUndefined();
  });

  test("a kind with no columns answers an empty batch with no round trip at all", async () => {
    const provider = await connectProvider();

    for (const kind of ["pipeline", "template"]) {
      sent = [];
      expect(await provider.describeObjects!([], kind)).toEqual({ details: [] });
      expect(sent).toEqual([]);
    }
  });

  test("an index the cluster answered nothing for is named, never described as empty", async () => {
    // A concrete `_mapping` request answers for every name it was given - a closed index
    // included, measured on 9.1.4 - and 404s outright for one that does not exist. So a
    // present answer with a name missing from it cannot come from the engine, and the
    // honest response is to say which index rather than to report it as a mapping-less
    // index, which is a real and different state.
    const provider = await connectProvider();
    overridePath(
      "/probe_buckets,probe_orders,probe_shapes/_mapping",
      ok(JSON.stringify({ probe_buckets: { mappings: {} }, probe_orders: { mappings: {} } })),
    );

    await expect(provider.describeObjects!([], "index")).rejects.toThrow(
      /answered no mapping for the index probe_shapes/,
    );
  });

  test("an undeclared kind is refused by the DECLARATION, naming the engine and the kind", async () => {
    const provider = await connectProvider();

    await expect(provider.describeObjects!([], "view")).rejects.toThrow(/declares no object kind "view"/);
  });

  test("a container path of the wrong shape is refused before anything is read", async () => {
    const provider = await connectProvider();
    sent = [];

    await expect(provider.describeObjects!(["nope"], "index")).rejects.toThrow(/container path has 0 segment\(s\)/);
    expect(sent).toEqual([]);
  });

  test("a limit that is not a positive whole number is refused, never clamped", async () => {
    const provider = await connectProvider();

    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(provider.describeObjects!([], "index", limit)).rejects.toThrow(
        /bulk column read limit must be a positive whole number/,
      );
    }
    // Guard ORDER: the declaration, then the container, then the limit.
    await expect(provider.describeObjects!([], "view", 0)).rejects.toThrow(/declares no object kind/);
    await expect(provider.describeObjects!(["nope"], "index", 0)).rejects.toThrow(/container path has 0 segment/);
  });

  test("a refused listing raises rather than answering an empty folder", async () => {
    const provider = await connectProvider();
    denyEverything();

    // The cluster's own refusal, mapped to this repo's class for it, and never an empty
    // folder: "nobody may read this" and "there is nothing here" are different facts.
    await expect(provider.describeObjects!([], "index")).rejects.toThrow(/refused the credentials/);
  });

  test("a pipeline and a template have no columns, and that is the right answer", async () => {
    const provider = await connectProvider();
    sent = [];

    const pipeline = await provider.describeObject(["probe_pipeline"], "pipeline");

    expect(pipeline).toEqual({ path: ["probe_pipeline"], columns: [], indexes: [], foreignKeys: [] });
    // And no mapping was read for it: a pipeline is a JSON document with no field list,
    // so a `_mapping` request would be asking the wrong endpoint about the wrong thing.
    expect(pathsSent().some((path) => path.endsWith("/_mapping"))).toBe(false);
  });

  test("the KIND decides what is looked up, not the name", async () => {
    const provider = await connectProvider();

    // `probe_orders` is a real index. Asking for it as a pipeline is a miss, because
    // the lookup runs against the PIPELINE listing.
    await expect(provider.describeObject(["probe_orders"], "pipeline")).rejects.toThrow(
      /No Elasticsearch pipeline named probe_orders/,
    );
    await expect(provider.describeObject(["probe_orders"], "pipeline")).rejects.toBeInstanceOf(QueryError);
  });

  test("an undeclared kind is refused by name, on both methods", async () => {
    const provider = await connectProvider();

    await expect(provider.listObjects([], "view")).rejects.toThrow(/declares no object kind "view"/);
    await expect(provider.describeObject(["anything"], "view")).rejects.toThrow(/declares no object kind "view"/);
  });

  test("a backing index is hidden by the dot rule, so a data stream is counted once", async () => {
    // The premise the `stream` kind rests on, asserted rather than argued: the listing
    // carries `.ds-probe_stream-2026.09.11-000001` and the index folder does not, so
    // the stream's data is reachable through the `stream` kind and through nothing
    // else, and the two kinds do not count the same bytes twice.
    const provider = await connectProvider();

    const indices = (await provider.listObjects([], "index")).map((object) => object.name);

    expect(indices).toEqual(["probe_buckets", "probe_orders", "probe_shapes"]);
    expect(indices.some((name) => name.startsWith(".ds-"))).toBe(false);
    expect(await provider.countObjects([])).toMatchObject({ index: { count: 3 }, stream: { count: 1 } });
  });

  test("a 404 carrying the engine's own error envelope is a refusal, not an empty folder", async () => {
    // The status alone cannot tell an empty set from a refusal, and both reach this
    // endpoint. Measured on both products 2026-09-11: the empty set carries `{}` and
    // nothing else, while a genuine 404 carries the error envelope this transport
    // categorises everywhere else (`GET /_data_stream/nope` answers 404 with
    // `index_not_found_exception`). A missing plugin, a denied endpoint and an
    // index-shaped 404 would all badge this folder 0 if the status were trusted alone.
    const provider = await connectProvider();
    overridePath("/_ingest/pipeline", fail(404, MISSING_PIPELINE_INDEX));

    const counts = await provider.countObjects([]);

    expect(counts.pipeline).toEqual({ unavailable: "no such index [nope_pipeline_store]" });
    expect(counts.pipeline).not.toEqual({ count: 0 });
    await expect(provider.listObjects([], "pipeline")).rejects.toThrow(/no such index \[nope_pipeline_store\]/);
    // And the other four folders are untouched: one endpoint's refusal is one kind's.
    expect(counts.index).toEqual({ count: 3 });
  });

  test("a 404 whose body is the empty set is still zero, on this product too", async () => {
    // The control for the test above, and it is not hypothetical upstream: a stock
    // node ships 21 managed pipelines, and after `DELETE /_ingest/pipeline/*` (HTTP
    // 200, acknowledged) `GET /_ingest/pipeline` answered HTTP 404 `{}` on
    // Elasticsearch 9.1.4, measured 2026-09-11. The two tests differ only in the body.
    const provider = await connectProvider();
    overridePath("/_ingest/pipeline", fail(404, "{}"));

    expect((await provider.countObjects([])).pipeline).toEqual({ count: 0 });
    expect(await provider.listObjects([], "pipeline")).toEqual([]);
  });

  test("a listing entry with no readable name is refused, never dropped", async () => {
    // Ruling 5a's failure shape reached from the payload: a dropped entry leaves the
    // count and the listing agreeing with each other (ruling 5f) and both short by
    // exactly the objects nobody can see, which is an absence that passes every gate.
    const provider = await connectProvider();
    overridePath("/_index_template", ok(JSON.stringify({ index_templates: [{ index_template: {} }] })));

    await expect(provider.listObjects([], "template")).rejects.toThrow(
      /Elasticsearch answered an index template listing the client could not read/,
    );
    expect((await provider.countObjects([])).template).toMatchObject({
      unavailable: expect.stringContaining("an index template listing"),
    });
  });

  test("a listing entry that is not an object, and a list key that is not an array, are refused too", async () => {
    const provider = await connectProvider();
    overridePath("/_data_stream", ok(JSON.stringify({ data_streams: ["probe_stream"] })));
    await expect(provider.listObjects([], "stream")).rejects.toThrow(/a data stream listing/);

    overridePath("/_data_stream", ok(JSON.stringify({ data_streams: { probe_stream: {} } })));
    await expect(provider.listObjects([], "stream")).rejects.toThrow(/a data stream listing/);
  });

  test("an alias payload member that is not an object is refused, never skipped", async () => {
    // Measured on both: an index carrying no alias is still listed, with a PRESENT and
    // empty map. So a member with no readable alias map is a body this client does not
    // understand, and skipping it would silently lose that index's aliases.
    const provider = await connectProvider();
    overridePath(
      "/_alias",
      ok(JSON.stringify({ probe_orders: { aliases: { probe_orders_alias: {} } }, probe_shapes: 7 })),
    );

    await expect(provider.listObjects([], "alias")).rejects.toThrow(/an alias listing/);
  });

  test("a declared kind with no reader fails the read instead of badging the folder", async () => {
    // Two defects in one shape. `SEARCH_OBJECT_READERS[kind]` indexes a plain object
    // literal, so a kind id spelled `toString` resolves up the prototype chain to a
    // function the provider then calls; and a per-kind catch that swallows everything
    // renders the resulting JS message on a folder badge, presented as the engine's
    // own sentence. Neither is something the cluster said.
    const provider = await connectProvider();
    const real = new ElasticsearchProvider(makeConnection()).getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [
        ...(real.objectKinds ?? []),
        { id: "toString", role: "config", label: "Stringifier", labelPlural: "Stringifiers" },
      ],
    });

    await expect(provider.countObjects([])).rejects.toThrow(/declares the object kind "toString" and has no reader/);
  });

  test("one kind's refusal is one kind's badge, and the other four still count", async () => {
    const provider = await connectProvider();
    // A security plugin grants privileges per endpoint, so a role that lists indices
    // and cannot read templates is an ordinary configuration - and losing the whole
    // tree over it would punish a usable connection.
    overridePath("/_index_template", fail(403, NO_BODY));

    const counts = await provider.countObjects([]);

    expect(counts.template).toMatchObject({ unavailable: expect.stringContaining("Elasticsearch") });
    expect(counts.index).toEqual({ count: 3 });
    expect(counts.pipeline).toEqual({ count: 3 });
    // The same refusal reaches `listObjects` as an error rather than an empty folder:
    // a caller that opened the folder must not be told it is empty.
    await expect(provider.listObjects([], "template")).rejects.toBeInstanceOf(AuthenticationError);
  });
});

/**
 * The source read (#789), which on this engine is a REST GET per object rather than a
 * catalog query, and whose text is a JSON document this product prints.
 *
 * Every body the fake answers here was captured from Elasticsearch 9.1.4 on 2026-09-13
 * with `docker/search-init/01-object-fixture.sh` applied, and every expected TEXT below
 * is written out rather than computed from the body, so a renderer that changed its
 * indent, its key order or its number spelling fails instead of agreeing with itself.
 */
describe("Elasticsearch object source", () => {
  /** What the pipeline that sorts FIRST renders as, character for character. */
  const SLASH_PIPELINE_TEXT = `{
  "description": "libredb source-read escaping fixture (#789)",
  "processors": [
    {
      "set": {
        "field": "escaped",
        "value": "yes"
      }
    }
  ]
}`;

  const PIPELINE_TEXT = `{
  "description": "libredb object-surface fixture (#789)",
  "processors": [
    {
      "set": {
        "field": "seen",
        "value": "yes"
      }
    }
  ]
}`;

  const TEMPLATE_TEXT = `{
  "index_patterns": [
    "probe-template-*"
  ],
  "template": {
    "mappings": {
      "properties": {
        "id": {
          "type": "long"
        }
      }
    }
  },
  "composed_of": []
}`;

  /** The data-stream template, whose `data_stream` member THIS product expands. */
  const STREAM_TEMPLATE_TEXT = `{
  "index_patterns": [
    "probe_stream*"
  ],
  "template": {
    "mappings": {
      "properties": {
        "@timestamp": {
          "type": "date"
        }
      }
    }
  },
  "composed_of": [],
  "data_stream": {
    "hidden": false,
    "allow_custom_routing": false
  }
}`;

  test("reads an ingest pipeline's definition and says what the text is", async () => {
    const provider = await connectProvider();
    sent = [];

    const document = await provider.readObjectSource!(["probe_pipeline"], "pipeline");

    expect(document.path).toEqual(["probe_pipeline"]);
    expect(document.kind).toBe("pipeline");
    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(false);
    if (isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.id).toBe("definition");
    expect(part.label).toBe("Definition");
    // The whole text, not a substring of it: the value under the id key and nothing of
    // the wrapper the endpoint answers.
    expect(part.text).toBe(PIPELINE_TEXT);
    expect(part.language).toBe("json");
    expect(part.form).toBe("complete");
    // PRINTED BY THIS PRODUCT. The cluster answers a JSON document, this renders it, and
    // the two are not byte-identical - see the fidelity test below.
    expect(part.origin).toBe("rendered");
    expect(part.truncated).toBeUndefined();
    // ONE request, and it names the object rather than reading the whole listing.
    expect(pathsSent()).toEqual(["/_ingest/pipeline/probe_pipeline"]);
  });

  test("reads an index template's definition, taken from the entry the NAME matches", async () => {
    const provider = await connectProvider();
    sent = [];

    const document = await provider.readObjectSource!(["probe_template"], "template");

    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the template read answered a refusal");
    expect(part.text).toBe(TEMPLATE_TEXT);
    expect(part.language).toBe("json");
    expect(part.form).toBe("complete");
    expect(part.origin).toBe("rendered");
    expect(pathsSent()).toEqual(["/_index_template/probe_template"]);
  });

  test("reads a text for every kind that DECLARES one, and the population is the declaration", async () => {
    // Recipe rule 6: the population comes from the declaration and never from a number
    // typed here, because a kind that quietly became a refusal passes every count.
    const provider = await connectProvider();
    const expected: Record<string, string> = {
      // The FIRST object of each folder, which is what the conformance walk reads too.
      pipeline: SLASH_PIPELINE_TEXT,
      template: STREAM_TEMPLATE_TEXT,
    };

    const declared = (provider.getCapabilities().objectKinds ?? []).filter((kind) => kind.hasSource === true);
    expect(declared.map((kind) => kind.id).sort()).toEqual(Object.keys(expected).sort());

    let read = 0;
    for (const kind of declared) {
      const [first] = await provider.listObjects([], kind.id);
      const document = await provider.readObjectSource!(first.path, kind.id);
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) {
        throw new Error(`the ${kind.id} read answered a refusal: ${part.unavailable}`);
      }
      expect(part.text).toBe(expected[kind.id]);
      read += 1;
    }
    // The loop's zero-iteration case certifies nothing, so it is refused BY NAME rather
    // than passing in silence.
    if (read !== declared.length || read === 0) {
      throw new Error(`the source walk read ${read} of ${declared.length} declared kinds`);
    }
  });

  test("renders the cluster's own JSON, and re-spells three things while doing it", async () => {
    // Recipe rule 10, measured rather than assumed. There is no extended-JSON writer for
    // a REST payload the way there is for BSON, so this product's renderer is
    // `JSON.parse` plus `JSON.stringify` and what that costs is asserted here and
    // recorded in both provider docs: a long past 2^53 loses precision, integer-like
    // keys are hoisted ahead of the others, and an exponent is re-spelled. Nothing is
    // DROPPED, which is the difference from the MongoDB regular expression that produced
    // the rule.
    const provider = await connectProvider();

    const document = await provider.readObjectSource!(["probe_json_edges"], "pipeline");
    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the fidelity read answered a refusal");

    // The wire carries the exact long; the rendered text carries the double nearest it.
    expect(PIPELINE_JSON_EDGES_BODY).toContain("9223372036854775807");
    expect(part.text).toContain("9223372036854776000");
    expect(part.text).not.toContain("9223372036854775807");
    // The server spells the exponent `1.0E30` and JavaScript spells it `1e+30`.
    expect(PIPELINE_JSON_EDGES_BODY).toContain("1.0E30");
    expect(part.text).toContain("1e+30");
    // The wire order is zz, 10, 2, aa. Integer-like keys come first in a JavaScript
    // object whatever order they arrived in.
    expect(part.text.indexOf('"2": "two"')).toBeLessThan(part.text.indexOf('"zz": 1'));
    expect(part.text.indexOf('"10": "ten"')).toBeLessThan(part.text.indexOf('"zz": 1'));
    // And the caption still says complete, which is true: every value is present.
    expect(part.form).toBe("complete");
  });

  test("percent-encodes the object's name, so a name holding a space and a slash is readable", async () => {
    // Measured on both products: a pipeline name may hold a space AND a slash, and
    // `GET /_ingest/pipeline/probe pipe/slash` with the slash unencoded is HTTP 400,
    // "no handler found for uri". So the escaper is `encodeURIComponent` and this object
    // is what makes that non-vacuous.
    const provider = await connectProvider();
    sent = [];

    const document = await provider.readObjectSource!(["probe pipe/slash"], "pipeline");

    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the escaped read answered a refusal");
    expect(part.text).toBe(SLASH_PIPELINE_TEXT);
    expect(pathsSent()).toEqual(["/_ingest/pipeline/probe%20pipe%2Fslash"]);
  });

  test("never renders another object's definition as this one's", async () => {
    // Measured on both products: a `*` in the name is a WILDCARD on both endpoints, and
    // `%2A` is decoded and wildcards too, so a name nobody created can answer HTTP 200
    // carrying someone else's definition. The pipeline read takes the value under the
    // EXACT id asked for and the template read takes the entry whose name matches, so
    // both are absences here rather than a wrong object rendered as a right one.
    const provider = await connectProvider();
    // The path is `probe*` and not `probe%2A`, because `encodeURIComponent` leaves the
    // asterisk alone - and encoding it would not help anyway: measured on both products,
    // `%2A` is decoded before the match and wildcards just the same. The EXACT-key match
    // is the whole guard, which is why the fake answers a real wildcard result here.
    overridePath("/_ingest/pipeline/probe*", ok(PIPELINE_SOURCE_BODY));

    await expect(provider.readObjectSource!(["probe*"], "pipeline")).rejects.toThrow(
      /No Elasticsearch pipeline named probe\*/,
    );

    overridePath("/_index_template/probe*", ok(TEMPLATE_SOURCE_BODY));
    await expect(provider.readObjectSource!(["probe*"], "template")).rejects.toThrow(
      /No Elasticsearch template named probe\*/,
    );
  });

  test("an object the cluster does not hold RAISES, and the two endpoints spell absence differently", async () => {
    // The measurement that refutes the design's row. `GET /_ingest/pipeline/no_such` is
    // HTTP 404 with the body `{}` and `GET /_index_template/no_such` is HTTP 404 with the
    // FULL error envelope, on both products (2026-09-13). Both are absence: the
    // empty-body-versus-envelope rule belongs to the LISTING endpoints, where a 404 can
    // also mean "there are none", and it does not carry to a named object.
    const provider = await connectProvider();
    overridePath("/_ingest/pipeline/no_such_pipeline", fail(404, "{}"));

    await expect(provider.readObjectSource!(["no_such_pipeline"], "pipeline")).rejects.toThrow(
      /No Elasticsearch pipeline named no_such_pipeline/,
    );

    overridePath("/_index_template/no_such_template", fail(404, TEMPLATE_ABSENT_BODY));
    await expect(provider.readObjectSource!(["no_such_template"], "template")).rejects.toThrow(
      /No Elasticsearch template named no_such_template/,
    );
  });

  test("a refusal is per ENDPOINT: the pipeline read is denied while the template read answers", async () => {
    // Neither refusal can be produced against the compose services - security is
    // disabled on both, a bogus Basic header is IGNORED and both answer HTTP 200
    // (measured) - so this drives the shape the transport builds from a status HTTP
    // itself fixes. Both provider docs say CANNOT rather than reporting around it.
    const provider = await connectProvider();
    overridePath("/_ingest/pipeline/probe_pipeline", fail(403, NO_BODY));

    const denied = await provider.readObjectSource!(["probe_pipeline"], "pipeline");
    const [part] = denied.parts;
    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.unavailable).toBe("Elasticsearch refused the credentials (HTTP 403)");
    // A part carrying BOTH keys narrows to the refusal arm and would put this sentence
    // over a definition the cluster returned, so the absence of a text is asserted.
    expect(Object.hasOwn(part, "text")).toBe(false);

    // The control, in the same test: the OTHER endpoint still answers a real definition,
    // which is what makes "per endpoint" a measurement rather than a phrase.
    const template = await provider.readObjectSource!(["probe_template"], "template");
    const [readable] = template.parts;
    if (isSourcePartUnavailable(readable)) throw new Error("the template read was denied too");
    expect(readable.text).toBe(TEMPLATE_TEXT);
  });

  test("a dropped socket RAISES rather than printing as the object's own refusal", async () => {
    // The cluster answering "no" and nobody answering at all are different facts. A
    // transport failure in the Source pane would read as this object's refusal, with no
    // raise and nothing to retry.
    const provider = await connectProvider();
    networkFailure = new Error("connect ECONNREFUSED 127.0.0.1:9200");

    await expect(provider.readObjectSource!(["probe_pipeline"], "pipeline")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("a kind that declares no source is refused by the DECLARATION, and so is an undeclared one", async () => {
    const provider = await connectProvider();
    sent = [];

    for (const kind of ["index", "alias", "stream", "view"]) {
      await expect(provider.readObjectSource!(["probe_orders"], kind)).rejects.toThrow(
        new RegExp(`Elasticsearch declares no readable source for the kind "${kind}"`),
      );
    }
    expect(sent).toEqual([]);
  });

  test("a path of the wrong shape is refused before anything is read", async () => {
    const provider = await connectProvider();
    sent = [];

    await expect(provider.readObjectSource!([], "pipeline")).rejects.toThrow(/has 1 segment\(s\), received \[\]/);
    await expect(provider.readObjectSource!(["a", "b"], "pipeline")).rejects.toThrow(/has 1 segment\(s\)/);
    expect(sent).toEqual([]);
  });

  test("the caller's bound cuts the text and marks it, and a text that fits is not marked", async () => {
    const provider = await connectProvider();

    const bounded = await provider.readObjectSource!(["probe_pipeline"], "pipeline", 20);
    const [part] = bounded.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the bounded read answered a refusal");
    expect(part.text).toBe(PIPELINE_TEXT.slice(0, 20));
    expect(part.truncated).toEqual({
      limit: 20,
      reason: "the source read was bounded at 20 characters by its caller",
    });

    const whole = await provider.readObjectSource!(["probe_pipeline"], "pipeline", PIPELINE_TEXT.length);
    const [full] = whole.parts;
    if (isSourcePartUnavailable(full)) throw new Error("the exact-bound read answered a refusal");
    expect(full.text).toBe(PIPELINE_TEXT);
    expect(full.truncated).toBeUndefined();
  });

  /**
   * `GET /_ingest/pipeline/probe_pipeline?nope=1`, HTTP 400, captured from
   * Elasticsearch 9.1.4 on 2026-09-13 (#789).
   *
   * The only refusal either source endpoint could be MADE to produce on a cluster with
   * security disabled. Both GETs answer `illegal_argument_exception` for every malformed
   * request found - an unrecognised parameter here, a `master_timeout=bogus` there - and
   * that name classifies as `engine`, so this is the refusal half of the read driven by
   * a body the cluster really sent rather than by a status alone.
   */
  const UNRECOGNIZED_PARAMETER = engineFault(
    400,
    "illegal_argument_exception",
    "request [/_ingest/pipeline/probe_pipeline] contains unrecognized parameter: [nope]",
  );

  test("a pipeline body this client cannot read is a REFUSAL and never an absence", async () => {
    // The two are different facts and only one of them is actionable. An unreadable body
    // reported as absence would put "No Elasticsearch pipeline named probe_pipeline" in
    // front of a user looking at a row the tree is currently showing, which says the
    // object is gone rather than that this client could not read what came back.
    const provider = await connectProvider();

    // The wrapper is not the object this file parses at all.
    overridePath("/_ingest/pipeline/probe_pipeline", ok("[]"));
    const [outer] = (await provider.readObjectSource!(["probe_pipeline"], "pipeline")).parts;
    if (!isSourcePartUnavailable(outer)) throw new Error("an unreadable wrapper was not refused");
    expect(outer.unavailable).toBe("Elasticsearch answered an ingest pipeline definition the client could not read");
    expect(Object.hasOwn(outer, "text")).toBe(false);

    // The key the caller asked for is there and the value under it is not a definition.
    overridePath("/_ingest/pipeline/probe_pipeline", ok('{"probe_pipeline":7}'));
    const [inner] = (await provider.readObjectSource!(["probe_pipeline"], "pipeline")).parts;
    if (!isSourcePartUnavailable(inner)) throw new Error("an unreadable definition was not refused");
    expect(inner.unavailable).toBe("Elasticsearch answered an ingest pipeline definition the client could not read");
    expect(Object.hasOwn(inner, "text")).toBe(false);

    // The control, so none of the above is a test of a broken fake: the same read
    // against the same path still answers a definition when the body is the real one.
    replyFor = defaultReply;
    const [readable] = (await provider.readObjectSource!(["probe_pipeline"], "pipeline")).parts;
    if (isSourcePartUnavailable(readable)) throw new Error("the control read was refused");
    expect(readable.text).toBe(PIPELINE_TEXT);
  });

  test("an index template entry this client cannot read is REFUSED rather than skipped", async () => {
    // Skipping an unreadable entry would walk off the end of the array and report the
    // object as ABSENT, which is the fact a user cannot act on: the tree is showing the
    // template, so "No Elasticsearch template named probe_template" is a claim about the
    // cluster where the truth is a claim about this client.
    const provider = await connectProvider();
    const unreadable: readonly (readonly [string, string])[] = [
      ["the list is not an array", '{"index_templates":{}}'],
      ["an entry is not an object", '{"index_templates":[7]}'],
      ["an entry carries no name", '{"index_templates":[{"index_template":{"index_patterns":["x"]}}]}'],
      [
        "the named entry's definition is not an object",
        '{"index_templates":[{"name":"probe_template","index_template":7}]}',
      ],
    ];

    let refused = 0;
    for (const [what, body] of unreadable) {
      overridePath("/_index_template/probe_template", ok(body));
      const [part] = (await provider.readObjectSource!(["probe_template"], "template")).parts;
      if (!isSourcePartUnavailable(part)) throw new Error(`${what}: the read answered a text`);
      expect(part.unavailable).toBe("Elasticsearch answered an index template definition the client could not read");
      expect(Object.hasOwn(part, "text")).toBe(false);
      refused += 1;
    }
    if (refused !== unreadable.length || refused === 0) {
      throw new Error(`${refused} of ${unreadable.length} unreadable bodies were refused`);
    }
  });

  test("every category the cluster ANSWERED in is a refusal, and it carries the cluster's own sentence", async () => {
    // Three of the five arms on the refusal side of `isClusterRefusal`, and the switch
    // is what decides whether a sentence the cluster wrote reaches the Source pane at
    // all: a category moved to the raising half throws instead, and the pane then shows
    // nothing. `auth` is driven by the per-endpoint test above.
    //
    // Only the FIRST body is a capture, and the other two are disclosed rather than
    // presented as measurements: on Elasticsearch 9.1.4 with security disabled, every
    // fault either source GET produces is `illegal_argument_exception`, so `syntax` and
    // `unknown-object` cannot be provoked on these endpoints at all. They are still
    // pinned, because the switch classifies the seam's CATEGORY and the seam is shared
    // with the SQL surface, where both names are measured (see the fault table above).
    const provider = await connectProvider();
    const answered: readonly (readonly [string, string, string])[] = [
      // engine, and this one is a capture.
      [
        "engine",
        UNRECOGNIZED_PARAMETER,
        "request [/_ingest/pipeline/probe_pipeline] contains unrecognized parameter: [nope]",
      ],
      // syntax.
      [
        "syntax",
        engineFault(400, "parsing_exception", "line 1:1: mismatched input '['"),
        "line 1:1: mismatched input '['",
      ],
      // unknown-object.
      [
        "unknown-object",
        engineFault(400, "verification_exception", "Found 1 problem\nline 1:15: Unknown index [nope_missing]"),
        "Found 1 problem\nline 1:15: Unknown index [nope_missing]",
      ],
    ];

    let refused = 0;
    for (const [category, body, sentence] of answered) {
      overridePath("/_ingest/pipeline/probe_pipeline", fail(400, body));
      const [part] = (await provider.readObjectSource!(["probe_pipeline"], "pipeline")).parts;
      if (!isSourcePartUnavailable(part)) throw new Error(`${category}: an answered fault was not a refusal`);
      // Unprefixed and unrewritten, which is what the docblock promises for every arm
      // but `auth` - where no body could be captured and the sentence is composed from
      // the status instead.
      expect(part.unavailable).toBe(sentence);
      expect(Object.hasOwn(part, "text")).toBe(false);
      refused += 1;
    }
    if (refused !== answered.length || refused === 0) {
      throw new Error(`${refused} of ${answered.length} answered faults became refusals`);
    }
  });

  test("an expired deadline and a cancellation RAISE, because nobody answered at all", async () => {
    // The other two thirds of the docblock's sentence, and the same defect MongoDB
    // shipped in this phase in the other direction. A deadline this client armed and a
    // cancellation this client made are not statements about the object, so printing
    // either in the Source pane as the object's own refusal would offer no raise, no
    // retry and nothing to tell it from a real denial.
    const provider = await connectProvider();

    abortReason = { use: true, reason: new DOMException("The operation timed out.", "TimeoutError") };
    const timedOut = provider.readObjectSource!(["probe_pipeline"], "pipeline");
    await expect(timedOut).rejects.toBeInstanceOf(TimeoutError);
    await expect(timedOut).rejects.toThrow(/ran past its deadline/);

    abortReason = { use: true };
    const cancelled = provider.readObjectSource!(["probe_pipeline"], "pipeline");
    await expect(cancelled).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(cancelled).rejects.toThrow(/was cancelled/);
  });

  test("a declaration this provider cannot honour is refused BY NAME, before any request", async () => {
    // Both guards compare the DECLARATION against this file, and the shipped declaration
    // agrees with it - so, exactly as ruling 5g does for the container depth, the
    // disagreement is swapped in through `getCapabilities`. Without the first guard a
    // `?? "json"` would render a text that is not JSON as JSON with nothing saying so;
    // without the second, a declared kind with no reader would call `undefined`.
    const provider = await connectProvider();
    const real = new ElasticsearchProvider(makeConnection()).getCapabilities();
    const kinds = real.objectKinds ?? [];
    const spy = spyOn(provider, "getCapabilities");
    sent = [];

    spy.mockReturnValue({
      ...real,
      objectKinds: kinds.map((kind) =>
        kind.id === "pipeline" ? { ...kind, hasSource: true, sourceLanguage: undefined } : kind,
      ),
    });
    await expect(provider.readObjectSource!(["probe_pipeline"], "pipeline")).rejects.toThrow(
      /Elasticsearch declares source for the kind "pipeline" and no sourceLanguage/,
    );

    spy.mockReturnValue({
      ...real,
      objectKinds: kinds.map((kind) =>
        kind.id === "index" ? { ...kind, hasSource: true, sourceLanguage: "json" } : kind,
      ),
    });
    await expect(provider.readObjectSource!(["probe_orders"], "index")).rejects.toThrow(
      /Elasticsearch declares source for the object kind "index" and has no reader for it/,
    );

    // Neither guard let a request out, which is the half that says they run before the
    // read rather than after it.
    expect(sent).toEqual([]);
    spy.mockRestore();
  });
});

/**
 * Standing ruling 5g (#789): every derivation over the declaration, pinned by handing
 * the provider a declaration its engine does not have.
 *
 * This engine declares ZERO container levels, which makes all three forbidden spellings
 * - a hardcoded length comparison, a positional bind for the object name, and
 * `path[0]` for the container - behaviour-identical here. That is exactly how they
 * survived three providers. So the derivations are driven with a TWO-LEVEL declaration
 * swapped in through `spyOn`, all the way to a BOUND VALUE rather than to a refusal:
 * the paths the listing constructs, the container the detail read slices off, and the
 * name it takes from the end.
 */
describe("Elasticsearch object paths are derived from the declaration, never from a position", () => {
  const TWO_LEVELS: ProviderCapabilities["containerLevels"] = [
    { id: "catalog", label: "Cluster", labelPlural: "Clusters" },
    { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
  ];

  /** The real declaration, with `containerLevels` replaced and nothing else. */
  function withLevels(provider: ElasticsearchProvider, containerLevels: ProviderCapabilities["containerLevels"]): void {
    const real = new ElasticsearchProvider(makeConnection()).getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({ ...real, containerLevels });
  }

  test("the real zero-level declaration refuses a container that has segments", async () => {
    const provider = await connectProvider();

    // The control. A hardcoded `container.length !== 0` would pass this too, which is
    // why it is the control and not the assertion.
    await expect(provider.countObjects(["nope"])).rejects.toThrow(/has 0 segment\(s\), received \["nope"\]/);
    await expect(provider.listObjects(["nope"], "index")).rejects.toThrow(/has 0 segment\(s\)/);
    await expect(provider.describeObject(["a", "b"], "index")).rejects.toThrow(/has 1 segment\(s\)/);
  });

  test("a two-level declaration moves every read with it, to a bound value", async () => {
    const provider = await connectProvider();
    withLevels(provider, TWO_LEVELS);

    // The depth check is DERIVED: a two-level declaration must now accept exactly two
    // segments and refuse zero, which is the opposite of what this engine accepts.
    await expect(provider.countObjects([])).rejects.toThrow(/has 2 segment\(s\)/);
    expect(await provider.countObjects(["prod", "search"])).toMatchObject({ index: { count: 3 } });

    // The listing CONSTRUCTS the path, which is the one position ruling 5g allows to be
    // written rather than derived - and it has to be written in the declared order or
    // the detail read cannot read it back.
    const listed = await provider.listObjects(["prod", "search"], "alias");
    expect(listed.map((object) => object.path)).toEqual([
      ["prod", "search", "probe_orders_alias"],
      ["prod", "search", "shared_alias"],
    ]);

    // And the round trip closes on a BOUND VALUE rather than a refusal: the container
    // is the first two segments by DEPTH and the name is the LAST segment, so the
    // detail read finds the same object and answers its real columns. A provider
    // reading `path[0]` as the name asks for a mapping of `prod` and finds nothing.
    const detail = await provider.describeObject(listed[0].path, "alias");
    expect(detail.path).toEqual(["prod", "search", "probe_orders_alias"]);
    expect(detail.columns.map((column) => column.name)).toEqual(["customer", "id"]);
    // The mapping was asked for by the object's own name, not by a container segment.
    expect(pathsSent()).toContain("/probe_orders_alias/_mapping");
  });

  test("the source read takes the name from the END of the path, under a declaration with levels", async () => {
    // Standing ruling 5g for `readObjectSource` (#789), driven to a BOUND VALUE: the URL
    // the transport builds. Under a two-level declaration the object's name is the third
    // segment, so a provider reading `path[0]` asks the cluster for `prod` and a
    // provider hardcoding a depth refuses the path outright. Both die here; on the real
    // zero-level declaration neither would.
    const provider = await connectProvider();
    withLevels(provider, TWO_LEVELS);
    sent = [];

    // The depth check moves with the declaration: one segment is now the wrong shape.
    await expect(provider.readObjectSource!(["probe_pipeline"], "pipeline")).rejects.toThrow(
      /"pipeline" path has 3 segment\(s\)/,
    );
    expect(sent).toEqual([]);

    const document = await provider.readObjectSource!(["prod", "search", "probe_pipeline"], "pipeline");

    expect(document.path).toEqual(["prod", "search", "probe_pipeline"]);
    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the two-level read answered a refusal");
    expect(part.text).toContain('"field": "seen"');
    // The bound value: the cluster was asked for the object's OWN name and for nothing
    // the container carries.
    expect(pathsSent()).toEqual(["/_ingest/pipeline/probe_pipeline"]);
  });

  test("a one-level declaration is a third depth, so nothing is pinned to two", async () => {
    const provider = await connectProvider();
    withLevels(provider, [{ id: "schema", label: "Namespace", labelPlural: "Namespaces" }]);

    expect(await provider.countObjects(["search"])).toMatchObject({ stream: { count: 1 } });
    expect((await provider.listObjects(["search"], "stream")).map((object) => object.path)).toEqual([
      ["search", "probe_stream"],
    ]);
    expect((await provider.describeObject(["search", "probe_stream"], "stream")).path).toEqual([
      "search",
      "probe_stream",
    ]);
  });
});

// ============================================================================
// endOpenQueryTransaction() (D75)
// ============================================================================

describe("endOpenQueryTransaction()", () => {
  /** The only three answers D75 accepts from a provider that does not implement the surface. */
  const ABSENCES = [
    "the engine has no transaction to leave open",
    "the driver cannot be asked",
    "nobody has measured it yet",
  ] as const;

  test("is not implemented, and the doc names WHICH absence that is", () => {
    const provider: DatabaseProvider = new ElasticsearchProvider(makeConnection());

    expect(provider.endOpenQueryTransaction).toBeUndefined();

    // A boundary nobody wrote down becomes a fallback the next reader trusts, so the
    // absence has to be readable in the doc as well as in the type. Exactly one of the
    // three: "one of these two" is not an answer, and a doc that names none has not
    // declared anything.
    const doc = readFileSync(join(import.meta.dir, "../../../docs/providers/elasticsearch.md"), "utf8");
    expect(doc).toContain("endOpenQueryTransaction");

    // The enumeration in the same sentence has to name every implementer. `redis` joined
    // them in this same wave, and a list that goes stale in silence is exactly the
    // boundary the next reader trusts. Matched over collapsed whitespace, so re-wrapping
    // the paragraph does not turn this red.
    expect(doc.replace(/\s+/g, " ")).toContain("implemented on `postgres`, `sqlite`, `duckdb` and `redis`");
    expect(ABSENCES.filter((absence) => doc.includes(absence))).toEqual([
      "the engine has no transaction to leave open",
    ]);
  });
});
