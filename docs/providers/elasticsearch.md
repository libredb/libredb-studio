# Elasticsearch Provider

> Elasticsearch support for LibreDB Studio, built on Elasticsearch's own SQL endpoint
> (`POST /_sql?format=json`, port `9200`) with **no driver dependency of any kind**: every statement is
> a JSON body and the answer comes back through the runtime's own `fetch`. This document is the single
> reference point for the `elasticsearch` type-id: design, architecture, usage, and tests. Its sibling
> [opensearch.md](./opensearch.md) is the prime reference for the fork — **one implementation serves
> both type-ids**, and the two documents deliberately disagree wherever the two products do.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `elasticsearch` |
| **Family** | SQL (`src/lib/db/providers/sql/search/` — shared with `opensearch`) |
| **Driver** | None — HTTP only (`fetch`, a runtime built-in) |
| **Query language** | `sql` (Elasticsearch SQL. **ES\|QL is deliberately unused** — see [§3.3](#33-sql-and-not-esql)) |
| **Default port** | `9200` for both schemes. A TLS deployment serves HTTPS on that **same** port, so unlike ClickHouse's `8123`→`8443` there is no second well-known number to fall back to ([§4.3](#43-tls)) |
| **Connection pooling** | None — each statement is one stateless HTTP request |
| **Connection string** | **Not supported** — addressed by host and port like Druid, and `http(s)://` is already ClickHouse's in the shared parser ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)) |
| **EXPLAIN** | **None.** `supportsExplain: false` and no `explainFormat`, so the button and the tab are hidden — even though this product *does* answer `EXPLAIN <select>` ([§3.10](#310-no-explain-even-though-elasticsearch-answers-one)) |
| **Writes** | **None are possible.** No `INSERT`, `UPDATE`, `DELETE`, `CREATE` or `ALTER` is in this grammar; documents change through the document APIs ([§5.6](#56-this-grammar-does-not-write)) |
| **Transactions** | Not exposed (Elasticsearch has none) |
| **Maintenance** | None — nothing in `MaintenanceType` has a SQL-reachable analogue ([§8](#8-maintenance)) |
| **Query cancellation** | No `cancelQuery`. An abort closes **this client's** socket; the cluster keeps working ([§3.8](#38-the-deadline-is-the-clients-and-only-the-clients)) |
| **Verified against** | **Elasticsearch 9.1.4**, image `docker.elastic.co/elasticsearch/elasticsearch:9.1.4` - the **default** build flavour, not `oss` (`GET /` reports `build_flavor` `default`), software licence **Elastic License 2.0** (the image's own `/usr/share/elasticsearch/LICENSE.txt`), subscription tier **basic** and self-generated (`GET /_license` reports type `basic`, status `active`, issuer `elasticsearch`), security disabled; indices `probe_orders` (1 doc), `probe_shapes` (2 docs, an object and a multi-field), `probe_buckets` (1500 docs), measured 2026-08-19 |
| **Source** | [`src/lib/db/providers/sql/search/`](../../src/lib/db/providers/sql/search/) |
| **Tests** | [`tests/integration/db/elasticsearch-provider.test.ts`](../../tests/integration/db/elasticsearch-provider.test.ts) + [`tests/unit/db/search/`](../../tests/unit/db/search/) |
| **Tracking issue** | [#424 — Search providers, Phase 1](https://github.com/libredb/libredb-studio/issues/424) |

---

## 1. Overview

Elasticsearch is a distributed search and analytics engine. Its **SQL surface is a first-party HTTP
endpoint** — `POST /_sql?format=json` — available on the basic tier with no plugin to install, and
that endpoint is the whole query surface this provider speaks. Schema and monitoring come from the
REST APIs instead (`_cat/indices`, `<index>/_mapping`, `_cluster/health`, `_cluster/stats`), because
the mapping is the index's own declaration while a `SELECT` only ever describes a statement
([§6](#6-schema-introspection)).

Three things are Elasticsearch-shaped, and most decisions below flow from one of them:

1. **The engine pages results on its own initiative.** Measured: `SELECT k, COUNT(*) FROM
   probe_buckets GROUP BY k` over 1500 distinct values answers **1000 rows plus a `cursor`** with no
   `fetch_size` ever requested, and page two carries rows and **no column declaration at all**.
   Dropping that cursor would report two thirds of the groups as a complete answer
   ([§3.5](#35-the-engine-pages-aggregations-by-itself)).
2. **The HTTP status misclassifies, in both directions.** A missing index is **400**
   (`verification_exception`) while `SELECT 1/0` — a user's arithmetic — is **500**
   (`arithmetic_exception`). Every failure is categorised from the **body**
   ([§3.6](#36-failures-are-read-from-the-body-never-from-the-status)).
3. **The grammar is narrower than SQL habit expects.** No `OFFSET`, no trailing semicolon, no
   backtick, no `#` comment, no write of any kind — each one measured as a `parsing_exception`
   ([§5.4](#54-dialect-traps-a-user-will-hit)).

### Concept mapping

| `DatabaseProvider` slot | Elasticsearch realisation | Mechanism |
|---|---|---|
| "Table" (`TableSchema`) | An **index**, displayed by its bare name | `GET /_cat/indices?format=json&bytes=b` |
| "Row" | A **document** | One positional array element in `rows` |
| Columns | The index's **mapped fields**, flattened to dotted paths, mapping types verbatim | `GET /<index>/_mapping` |
| Primary key | none — nothing a mapping declares is unique, and `_id` is not even selectable here (measured: `SELECT _id` → "Unknown column [_id]") | `isPrimary: false` on every column |
| `query(sql)` | One SQL statement, **no** parameters | `POST /_sql?format=json` |
| Indexes | none — every mapped field is inverted-indexed with no index *object* to name | always `[]` |
| Foreign keys | none (the engine has no such constraint) | always `[]`, plus `declaresForeignKeys: false` |
| `getOverview()` / storage | Version, cluster health, index count, cluster store bytes | `/`, `_cluster/health`, `_cluster/stats`, `_cat/indices` |
| `getActiveSessions()` | nothing — a request is one HTTP request, there is no session | always `[]` |
| `getSlowQueries()` | nothing — the slow log is a node **log file**, which no API returns | always `[]` |
| Maintenance | nothing SQL can reach | `runMaintenance()` throws with the reason |

---

## 2. Architecture

### 2.1 Where it sits

One directory serves **two type-ids**. The two products speak the same shape of SQL over HTTP and
differ only in wire detail, so everything they disagree about on the wire is a row in the transport's
dialect table ([http-transport.ts:319](../../src/lib/db/providers/sql/search/http-transport.ts)) and
everything they disagree about above it is one field of `SearchProduct`
([index.ts:211](../../src/lib/db/providers/sql/search/index.ts)):

```
src/lib/db/providers/sql/
├── sql-base.ts
├── clickhouse/
├── druid/
└── search/
    ├── index.ts             # SearchProvider (abstract) + ElasticsearchProvider + OpenSearchProvider
    ├── transport.ts         # SearchTransport interface + neutral result/error types (no I/O)
    ├── http-transport.ts    # the one implementation: both SQL endpoints, both envelopes
    └── introspect.ts        # mapping-driven schema (no SQL at all)
```

There is **no explain strategy**, because `supportsExplain` is `false` and `src/lib/explain/` is
untouched ([§3.10](#310-no-explain-even-though-elasticsearch-answers-one)).

### 2.2 Class hierarchy

```
DatabaseProvider (interface, types.ts)
        ^
BaseDatabaseProvider (abstract, base-provider.ts)
        ^
SQLBaseProvider (abstract, sql-base.ts)
        ^
SearchProvider (abstract, search/index.ts:367)   <- not exported
        ^
ElasticsearchProvider (search/index.ts:953)      OpenSearchProvider (search/index.ts:967)
```

`SearchProvider` extends `SQLBaseProvider` because the query language really is SQL — measured, the
endpoint answers a `POST`ed statement with declared columns and positional rows on the basic tier —
and because the shared limiter's `LIMIT n` is correct here. The abstract base is **not exported**: the
factory constructs a type-id, and a type-id is one of the two concrete classes, which is what keeps
both exports honestly thin (each one names its product and nothing else).

### 2.3 What `SQLBaseProvider` gives for free

| Member | Purpose here |
|---|---|
| `buildLimitClause()` | `LIMIT n`, which this grammar accepts (measured, including after `ORDER BY` / `GROUP BY` / `HAVING`). Its second form, `LIMIT n OFFSET m`, is a **syntax error** here, which is the one thing `prepareQuery()` overrides ([§5.5](#55-the-preparequery-override-there-is-no-second-page)) |
| `prepareQuery()` (base) | The shared query limiter; called first, then the `OFFSET` case is refused |
| `escapeIdentifier()` | Inherited and **never called** — this provider builds no SQL of its own, because the schema comes from the mapping rather than from a statement. Its default branch would double-quote, which happens to be right for this product ([§5.4](#54-dialect-traps-a-user-will-hit)) |
| `getPlaceholder()` | Inherited and never reached: positional parameters are refused outright ([§3.11](#311-positional-parameters-are-refused-not-emulated)) |
| `measureExecution()` / `trackQuery()` | The measured duration is the only timing in existence — neither the body nor the headers carry one |
| `shouldEnableSSL()` | Inherited but **never called**. TLS comes from the connection's own `ssl` config only ([§4.3](#43-tls)) |

### 2.4 Registration & lifecycle

The factory wires the type-id in via a dynamic import
([factory.ts:118](../../src/lib/db/factory.ts)):

```ts
case "elasticsearch": {
  const { ElasticsearchProvider } = await import("./providers/sql/search/index");
  return new ElasticsearchProvider(connection, options);
}
```

`connect()` ([index.ts:536](../../src/lib/db/providers/sql/search/index.ts)) proves the cluster with
one `SELECT 1` — measured HTTP 200, one column named `1` of type `integer`. It needs no index, so it
also succeeds on a cluster holding nothing yet. It proves the **product** as well as the port, and
that is not a side effect: the SQL endpoint path is product-specific, and `POST /_plugins/_sql`
against Elasticsearch is refused before it reaches any SQL engine
(`{"error":"no handler found for uri [/_plugins/_sql] and method [POST]"}`), so a connected transport
is evidence that this connection's type-id names the product actually listening.

`disconnect()` ([index.ts:559](../../src/lib/db/providers/sql/search/index.ts)) forgets the transport
and nothing else: every request is one `fetch` with no pool, no session and no cursor behind it, which
is why `SearchTransport` has no `close()` at all. API routes use `getOrCreateProvider()`, which caches
the connected provider per `connection.id` and evicts it after 30 minutes idle.

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 HTTP only — no driver, and what that costs

Elastic ships `@elastic/elasticsearch`, a first-class Node client. It is **not** a dependency here:
everything this provider needs is four REST paths and one SQL endpoint, so `package.json` is
untouched — no install step to fail, no native module in the Docker image or any distribution
channel, and no N-API question for the Bun runtime. This is the rubric in
[`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) applied unchanged, and the same call Couchbase
(#262), ClickHouse (#264) and Druid (#265) made.

What it costs, stated plainly:

- **No sniffing, no failover, no retry.** One statement is one `fetch` to one host. A refused socket
  surfaces as an error rather than being retried against another node. For an interactive editor that
  is the honest trade; a deployment that wants failover puts a load balancer in front, which is
  exactly the host a Studio connection points at.
- **No cursor paging offered to the user.** The transport follows the cursor the engine chooses to
  send ([§3.5](#35-the-engine-pages-aggregations-by-itself)) but never requests one, so there is no
  `fetch_size`, no server-side scroll to leak, and the editor's row limit is what bounds a result.
- **The whole body is buffered** (`await response.text()`) before it is parsed, so a deliberately huge
  result set is expensive in a way a streaming client would not be.
- **`ssl.caCert` / `ssl.clientCert` / `ssl.rejectUnauthorized` are not honoured**, because global
  `fetch` cannot carry a custom CA without an undici `Agent`, and undici is not a dependency
  ([§4.3](#43-tls)).

### 3.2 The transport seam: one interface, one implementation, two dialects

Provider logic never calls `fetch`. It goes through `SearchTransport`
([transport.ts:230](../../src/lib/db/providers/sql/search/transport.ts)) — five calls, each answering
one question:

```ts
interface SearchTransport {
  readonly dialect: SearchDialectId;                                  // "elasticsearch" | "opensearch"
  query(sql: string, signal?: AbortSignal): Promise<SearchQueryResult>;
  version(signal?: AbortSignal): Promise<{ version: string; product: string }>;
  indices(signal?: AbortSignal): Promise<SearchIndexInfo[]>;
  mapping(index: string, signal?: AbortSignal): Promise<SearchMappingField[]>;
  health(signal?: AbortSignal): Promise<SearchClusterHealth>;
}
```

The seam is what makes "two type-ids, one implementation" affordable rather than aspirational, and it
is also what makes adopting `@elastic/elasticsearch` later **one new file** rather than a rewrite of
the provider and its introspection.

`dialect` is the **only** product distinction that crosses it, and
[transport.ts:46-55](../../src/lib/db/providers/sql/search/transport.ts) is explicit about what it may
be used for: a word in a message, never a behaviour. Behaviour differences belong in the transport,
capability differences in `getCapabilities()`. `CLAUDE.md` forbids `=== 'mongodb'`-style branching
outside provider classes for the same reason, and `http-transport.ts` holds itself to the stronger
rule that no method branches on `this.dialect` at all — it reads `this.spec`.

> **Seam rule.** The wire vocabulary — `/_sql`, `/_plugins/_sql`, `format=json`, `/_cat/indices`,
> `/_cluster/health`, `/_cluster/stats`, `/_mapping`, the envelope keys (`columns`, `rows`, `schema`,
> `datarows`, `total`, `size`, `cursor`, `alias`, `properties`, `fields`, `mappings`, `docs.count`,
> `pri.store.size`, `cluster_name`, `size_in_bytes`, `root_cause`, `details`), the product fault names
> (`parsing_exception`, `verification_exception`, `IndexNotFoundException`,
> `SQLFeatureNotSupportedException`, …), the HTTP status numbers and `fetch` itself — must appear
> **only** in `http-transport.ts`.
> [`tests/unit/db/search/seam-guard.test.ts`](../../tests/unit/db/search/seam-guard.test.ts) parses
> every source in the directory with the TypeScript compiler API — not a grep — and fails the build
> the moment any of it appears elsewhere. It needs narrower treatment than Couchbase's or Druid's
> guard did, because the **neutral** seam deliberately reuses the wire's own English:
> `SearchQueryResult.rows`, `columnTypes`, `TableSchema.size`, `getSchema` and
> `SEARCH_CONTAINER_TYPES = ["object", "nested"]` are all legitimate, so `rows` / `schema` / `size`
> are matched only as exact **string literals** — the spelling envelope *parsing* produces — and a
> bare property access is left alone. HTTP **200** is deliberately outside the status set: it is the
> one status carrying no classification, and it is a plausible row limit.

### 3.3 SQL, and not ES|QL

ES|QL exists on this product (`POST /_query`, and it works on the basic tier — measured) and is
deliberately unused. **OpenSearch has no ES|QL at all**, and a surface only one of the two products
has cannot be the shared query language, while the SQL endpoint is available on both with no paid
tier. Declaring `queryLanguage: "sql"` also buys Monaco SQL highlighting, the shared limiter, the
`"sql"` tab type and saved queries with no additional code.

### 3.4 The success envelope: positional rows, and a duplicate name that must not vanish

Measured, `SELECT customer, total FROM probe_orders`:

```json
{"columns":[{"name":"customer","type":"keyword"},{"name":"total","type":"double"}],
 "rows":[["acme",9.5]]}
```

Three properties the code depends on:

- **Rows are positional**, so each row is rebuilt against the declared column list
  ([http-transport.ts:541](../../src/lib/db/providers/sql/search/http-transport.ts)) rather than read
  as an object. The declared **order** is therefore authoritative in a way object keys never are.
- **Duplicate output names are legal here.** Measured, `SELECT 1 AS c, 2 AS c, 3 AS c` answers HTTP
  200 with `[{"name":"c",…},{"name":"c",…},{"name":"c",…}]` and the row `[1,2,3]`. A `SearchRow` is a
  record, so without `disambiguate()`
  ([http-transport.ts:489](../../src/lib/db/providers/sql/search/http-transport.ts)) the second and
  third values would vanish **before** the seam. They reach the grid as `c`, `c (2)`, `c (3)`, and the
  suffix keeps climbing because `SELECT 1 AS c, 2 AS "c (2)", 3 AS c` is legal too. **The same
  statement is refused outright by OpenSearch**, so this invariant is load-bearing on exactly one of
  the two products — which is a fact about that engine, not dead code
  ([opensearch.md §3.4](./opensearch.md#34-the-success-envelope-schemadatarows-a-separate-alias-and-a-count)).
- **The alias is folded into `name`.** Measured, `SELECT customer AS who` declares
  `{"name":"who","type":"keyword"}` — the alias *is* the name — so `aliasKey` is `null` for this
  dialect ([http-transport.ts:320-356](../../src/lib/db/providers/sql/search/http-transport.ts)). The
  fork puts it in a separate member, and reading `name` alone would label the same statement's column
  `who` here and `customer` there.

**There is no `total` and no `size` in a successful answer** — measured, nowhere in the body — which
is why `SearchQueryResult.totalHits`
([transport.ts:106-114](../../src/lib/db/providers/sql/search/transport.ts)) is nullable rather than
defaulted: against this product it is `null`, and a caller must read that as "unknown", never as zero.

**An empty result still declares its columns.** Measured, `SELECT customer FROM probe_orders WHERE 1
= 0` answers `{"columns":[{"name":"customer","type":"keyword"}],"rows":[]}`. So a body that describes
no columns means something between the client and the engine rewrote it, and the transport answers
nulls (`fieldNames: null`, `columnTypes: null`) rather than fabricating names from the first row.

### 3.5 The engine pages aggregations by itself

**This is a correctness fix, not an optimisation**, and an earlier revision of the transport asserted
the opposite. Measured on 9.1.4:

```
$ curl -s -XPOST -H 'content-type: application/json' 'http://localhost:9200/_sql?format=json' \
    -d '{"query":"SELECT k, COUNT(*) AS c FROM probe_buckets GROUP BY k"}' | jq 'keys, (.rows|length)'
["columns","rows","cursor"]
1000
```

1500 distinct values, **1000 rows and a `cursor`**, with no `fetch_size` ever requested: an
aggregation is paged by the engine's own default. Dropping the cursor returned two thirds of the
buckets and labelled the result complete — worse than an error, because a user reading a `GROUP BY`
has no way to notice 500 missing groups.

The transport's `query()`
([http-transport.ts:864](../../src/lib/db/providers/sql/search/http-transport.ts)) follows it, and two
traps shape the loop, both measured on that same run:

- **Page two carries its rows and NO column declaration.** There is nothing on it to derive names
  from, so page one's declaration is carried forward and later pages are rebuilt against it
  (`rebuildRows()`, [http-transport.ts:568](../../src/lib/db/providers/sql/search/http-transport.ts)).
  That is also the only way the seam's "these names are exactly the key set of every row" invariant
  can hold across pages.
- **The loop is bounded** by `MAX_PAGES = 1000`
  ([http-transport.ts:151](../../src/lib/db/providers/sql/search/http-transport.ts)), because the
  terminating condition is the *server's* and a seam must not offer an unbounded remote loop. At the
  measured page size that is a million-row ceiling. Hitting it is **reported**, never silently
  accepted — the defect being fixed here is precisely a truncation nobody was told about — and the
  cursor still being held is closed on the way out through `POST /_sql/close`, because that one *is*
  server-side state.

The second page carried no cursor on the measured run, so the loop terminates on the engine's word.

### 3.6 Failures are read from the body, never from the status

Measured, both directions:

| statement | HTTP | body's `error.type` | category |
|---|---|---|---|
| `SELECT * FROM nope_missing` | **400** | `verification_exception` — "line 1:15: Unknown index [nope_missing]" | `unknown-object` |
| `SELEKT 1` | 400 | `parsing_exception` — "line 1:1: mismatched input 'SELEKT' expecting {'(', 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS', 'WITH'}" | `syntax` |
| `SELECT nosuchfield FROM probe_orders` | 400 | `verification_exception` — "Unknown column [nosuchfield]" | `unknown-object` |
| `SELECT sillyfunc(1)` | 400 | `verification_exception` — "Unknown function [sillyfunc]" | `unknown-object` |
| `GET /nope_missing/_mapping` | 404 | `index_not_found_exception` | `unknown-object` |
| `SELECT 1/0` | **500** | `arithmetic_exception` — "/ by zero" | `engine` |

A status-driven classifier would call the missing index a bad request here and a missing endpoint on
the fork (which answers **404** for the same typo), and would call a user's arithmetic a server
failure. So the whole classification lives in a table of measured fault names
([http-transport.ts:348-353](../../src/lib/db/providers/sql/search/http-transport.ts)) and an
unrecognised name becomes `engine` — "reached, understood, and refused" — rather than a guess. This is
the ClickHouse lesson from #264 arriving again.

Two deliberate consequences worth knowing:

- **A rejected mutation is reported as `syntax`, not `unsupported`.** `INSERT INTO …` answers
  `parsing_exception`, "mismatched input 'INSERT' expecting {…, 'SELECT', …}" — indistinguishable
  from a typo, because this grammar has no INSERT to be unsupported. Reporting `syntax` says what the
  engine said; `unsupported` would be our inference. The fork classifies the very same statement as
  `unsupported`, and the asymmetry is deliberately not papered over.
- **The engine's own wording is carried through verbatim.** "line 1:15: Unknown index
  [nope_missing]" locates the fault better than anything this provider could synthesize, so nothing is
  rewritten ([transport.ts:143-163](../../src/lib/db/providers/sql/search/transport.ts)).

### 3.7 A string-valued `error` means the request never reached the SQL engine

Measured: `POST /_plugins/_sql` (the fork's path) against Elasticsearch answers HTTP 400 with

```json
{"error":"no handler found for uri [/_plugins/_sql] and method [POST]"}
```

and a POST with no `content-type` answers HTTP 406 on both products. Both spell `error` as a
**string** where a real engine failure spells it as an **object**, which makes the JSON type of one
field a reliable "this is not that product / the SQL surface is not there" discriminator. It becomes
the `unreachable` category, which the provider maps to `ConnectionError` — so pointing an
`elasticsearch` connection at an OpenSearch node fails at the connection form, quoting the cluster's
own words, instead of failing later on a query.

`auth` is the one category decided on the **status** (401/403). Both probe clusters run with security
disabled and a bogus `Basic` header is *ignored* there (HTTP 200, measured), so no 401/403 body could
be captured — and rather than invent one, the code uses the one signal whose meaning HTTP itself fixes
([http-transport.ts:64-68](../../src/lib/db/providers/sql/search/http-transport.ts)).

### 3.8 The deadline is the client's, and only the client's

`deadline()` ([index.ts:609](../../src/lib/db/providers/sql/search/index.ts)) is one
`AbortSignal.timeout(this.queryTimeout)` **per operation**, not per request — the monitoring reads
below fan out several requests for one panel, and a panel that renders half its numbers after a stall
is not a better answer than one that reports the stall.

Aborting closes this client's socket and nothing else. **No cancellation request is sent**, because
neither product's SQL endpoint offers one for a *running* statement: `POST /_sql/close` exists here (a
bogus cursor answers HTTP 400 rather than "no handler found") but it closes a **paging cursor**. So
the cluster finishes the statement it was given, which is what the `cancelled` message must not
pretend otherwise about, and why `cancelQuery` is deliberately not implemented — a method named
"cancel" that cancels nothing server-side is a promise this provider cannot keep.

`AbortSignal.timeout` is used rather than a plain controller because its reason is a `TimeoutError`,
which is the one signal that tells a deadline apart from a user's cancellation. Measured on Node 24
and on Bun, that distinction cannot be made from the thrown value:

```
controller.abort()               -> DOMException, name "AbortError"
controller.abort(new Error("x")) -> that Error, verbatim: name "Error"
AbortSignal.timeout(1)           -> DOMException, name "TimeoutError"
```

so `requestFailure()`
([http-transport.ts:707](../../src/lib/db/providers/sql/search/http-transport.ts)) consults
`signal.aborted` **before** the thrown value. The signal knows; the error does not.

### 3.9 Columns are labelled with mapping types, not SQL types

Measured: `SELECT customer, total FROM probe_orders` declares `keyword` and `double` — not `VARCHAR`
and `DOUBLE` — and `SELECT note` declares `text`. That is the vocabulary a user wrote in their own
index mapping, so it is the honest label, and it is the **same** vocabulary `mapping()` reports, which
keeps the result grid and the schema tree speaking one language
([transport.ts:92-104](../../src/lib/db/providers/sql/search/transport.ts),
[introspect.ts:184-194](../../src/lib/db/providers/sql/search/introspect.ts)).

A column whose declaration carried no type name is **left out** of `columnTypes` rather than given a
placeholder: an invented type would be indistinguishable from one the engine sent.

### 3.10 No EXPLAIN, even though Elasticsearch answers one

`supportsExplain: false` and no `explainFormat` is declared, which is what hides the button and the
tab; `src/lib/explain/` is untouched. This product genuinely answers a plan — measured,
`EXPLAIN SELECT customer FROM probe_orders` returns one `plan` column of text:

```
Project[[probe_orders.customer{f}#629]]
\_EsRelation[probe_orders][created{f}#628, customer{f}#629, id{f}#630, note{f}..]
```

— but the fork's SQL plugin **refuses that statement form** (`SQLFeatureNotSupportedException`,
"Query must start with SELECT, DELETE, SHOW or DESCRIBE"), and one implementation serves both
type-ids. A tab that works on one of two products behind one code path is worse than no tab, so
neither declares it. The text form is also not the tree `src/lib/explain/` models, so this would be a
new strategy rather than a flag flip ([§13](#13-known-limitations--future-work)).

### 3.11 Positional parameters are refused, not emulated

The endpoint really does bind them — measured,
`{"query":"… WHERE id = ?","params":[1]}` answers HTTP 200 — but the fork spells the same request
differently (a `parameters` array of `{type,value}` objects), the seam carries the **statement
alone**, and inlining the values here to work around that would be building a SQL-injection site
inside a provider. `query()` therefore throws a `QueryError` when `params` is non-empty
([index.ts:625](../../src/lib/db/providers/sql/search/index.ts)), the same call
`clickhouse/index.ts` makes for the same reason (#264). `positionalPlaceholder()` in
[`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) returns `null` for this dialect to match, so no
shared generator emits a `?` this provider would then decline to fill.

---

## 4. Connection

### 4.1 Configuration fields

The form offers exactly four fields
([`db-ui-config.ts:138`](../../src/lib/db-ui-config.ts)): `host`, `port`, `user`, `password`.

| Field | Required | Notes |
|---|---|---|
| `host` | **Yes** | `validate()` ([index.ts:529](../../src/lib/db/providers/sql/search/index.ts)) throws `DatabaseConfigError` — "Elasticsearch requires a host". There is no connection string to substitute for it |
| `port` | No | Defaults to `9200` ([index.ts:151](../../src/lib/db/providers/sql/search/index.ts), and the transport applies the same floor at [http-transport.ts:99](../../src/lib/db/providers/sql/search/http-transport.ts)). One number for both schemes — see [§4.3](#43-tls) |
| `user` / `password` | No | Sent as HTTP Basic **only when `user` is set**, for the security plugin. Measured on a node with security disabled: a bogus `Basic` header is *ignored* (HTTP 200), so credentials are genuinely optional |
| `ssl` | No | Any mode but `disable` switches the transport to `https` ([§4.3](#43-tls)) |
| `database` | — | **Not offered, and ignored if set** — see below |

**There is no `database` field, and that is not an omission.** An index has no namespace above it, and
this product's own SQL says so: `SHOW TABLES` reports a `catalog` of `docker-cluster` — the cluster
name — and the catalog is not addressable in a statement (measured,
`SELECT customer FROM "docker-cluster".probe_orders` is a `parsing_exception`). So a database selector
would be a control with no effect, and worse, one implying a scoping decision the user does not have.
The monitoring rows carry an **empty** schema name for the same reason
([index.ts:167](../../src/lib/db/providers/sql/search/index.ts)), which renders as no prefix at all —
and which doubles as the only value the schema filter can match, so a caller asking for `public` gets
no rows rather than every row.

```ts
const connection = {
  id: 'es-1',
  name: 'Elasticsearch',
  type: 'elasticsearch',
  host: '127.0.0.1',
  port: 9200,
  createdAt: new Date(),
};
```

### 4.2 There is no connection string, and that is deliberate

`supportsConnectionString` is `false` and `showConnectionStringToggle` is `false`, so the form has no
paste tab. Two independent reasons, the same pair Druid records:

- **There is no URI convention for this HTTP surface.** A cluster is addressed by host and port; the
  official client takes a `node` URL, which is not a credential-carrying DSN the shared parser could
  round-trip.
- **`http://` and `https://` are already claimed by ClickHouse** in
  [`connection-string-parser.ts`](../../src/lib/connection-string-parser.ts) (#264), where an HTTP URL
  *is* the canonical connection target.

`connection-string-parser.ts` is therefore **not touched** by this provider, and the consequence is
recorded rather than hidden: pasting `http://localhost:9200` selects ClickHouse. The connection-form
hook says so too — its unparseable-string message lists the schemes that do exist and deliberately
omits these two ([`use-connection-form.ts:376`](../../src/hooks/use-connection-form.ts)).

### 4.3 TLS

`config.ssl` with any `mode` but `disable` switches the transport from `http` to `https`
([http-transport.ts:819](../../src/lib/db/providers/sql/search/http-transport.ts)). `ssl` is a
first-class `DatabaseConnection` field and independent of the form's `connectionFields`, so it applies
even though this form shows no TLS row of its own, and an explicit `disable` turns TLS **off** as
firmly as an explicit mode turns it on (the #264 lesson).

**The port is not changed by TLS**, unlike ClickHouse's `8123` → `8443`: this product serves HTTPS on
the same `9200`, so there is no second well-known number, and inventing one would send credentials to
a port nothing is listening on.

`ssl.caCert`, `ssl.clientCert` and `ssl.rejectUnauthorized` are **not honoured** — global `fetch`
cannot carry a custom CA or relax verification without an undici `Agent` as its `dispatcher`, and
undici is not a dependency. A cluster behind a **self-signed** certificate therefore fails
verification, which matters more here than for most providers: a secured Elasticsearch commonly ships
one. A publicly-trusted certificate works.

An IPv6 literal host is bracketed before it becomes a URL authority
([http-transport.ts:431](../../src/lib/db/providers/sql/search/http-transport.ts)).

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?)` ([index.ts:625](../../src/lib/db/providers/sql/search/index.ts)) sends one
statement under the client deadline from [§3.8](#38-the-deadline-is-the-clients-and-only-the-clients):

```ts
await provider.query('SELECT customer, total FROM probe_orders LIMIT 50');
await provider.query('SELECT k, COUNT(*) AS c FROM probe_buckets GROUP BY k');  // paged by the engine
```

A **write is not special-cased**: this grammar rejects every mutation and its message names
everything it *would* have accepted, which is more useful than anything substituted here
([§5.6](#56-this-grammar-does-not-write)).

### 5.2 Result shaping

`toQueryResult()` ([index.ts:275](../../src/lib/db/providers/sql/search/index.ts)):

| Source | `QueryResult` field | Notes |
|---|---|---|
| `rows` | `rows` | Rebuilt from the positional arrays, keyed by the disambiguated column names |
| `columns[].name` | `fields` | Declared order, made unique (`c`, `c (2)`); `[]` when the answer described no columns |
| — | `rowCount` | `rows.length`. There is no second number: no statement here mutates, so a mutation count could only ever be zero |
| the measured exchange | `executionTime` | Rounded milliseconds, **measured by this process**. Neither the body nor the headers carry any timing, so there is no server number to prefer |
| `columns[].type` | `columnTypes` | The engine's **mapping** types (`keyword`, `double`, `datetime`); **absent** when the answer declared none ([§3.9](#39-columns-are-labelled-with-mapping-types-not-sql-types)) |
| — | `warnings` | None are produced. See below |

**`totalHits` is dropped on purpose, and here it does not exist anyway.** The fork reports a
matching-document count beside every answer and this product reports none, so a "showing 50 of 4,812"
notice would appear on one product and never on the other for identical statements — and it would
restate what the route's own pagination already tells the UI (`hasMore`, `limit`, `offset`). A caveat
attached to every ordinary query is the fastest way to train a user to ignore the ones that matter,
which is the argument [druid.md](./druid.md) makes about its own warnings.

### 5.3 Row values arrive as the mapping's JSON

No value rewriting happens anywhere in this provider. A `date` field comes back as the engine's own
string, a `double` as a JSON number, and an object field is not selectable at all
([§5.4](#54-dialect-traps-a-user-will-hit)). There is no 64-bit-integer rewrite of the kind
`druid/http-transport.ts` needs, because nothing measured on this endpoint returns an integer outside
the safe range — a `long` field is a JSON number, and the only counts this provider reads from `_cat`
arrive as strings and are parsed explicitly
([http-transport.ts:450](../../src/lib/db/providers/sql/search/http-transport.ts)).

### 5.4 Dialect traps a user will hit

These are Elasticsearch's, not the provider's, and each is a real 400 a user can produce in the
editor. All were measured on 9.1.4.

**A trailing semicolon is a syntax error.**

```
SELECT 1;
-> 400  parsing_exception  "line 1:9: extraneous input ';' expecting <EOF>"
```

This one bit through the product's own affordances rather than only hand-typed SQL, and that is why
the provider declares it. The shared generators emitted `SELECT * FROM probe_orders LIMIT 50;` and
`SELECT … WHERE 1=1 LIMIT 100;` for a search connection — "Select Top 50 Documents" and "Generate
Query", the first two things a user clicks on an index — and both were refused here with the same
`extraneous input ';'` (measured in the browser, 2026-08-19). So
`ProviderCapabilities.statementTerminator` is `"none"` on both products and
[`query-generators.ts`](../../src/lib/query-generators.ts) asks the capability instead of the engine
name: the generated statement now ends at `LIMIT 50`. Both spellings run on the fork, which is why one
answer serves both type-ids rather than a branch on `dialect`.

A semicolon a **user** types is unaffected by that declaration and still runs, because the editor's
statement reader strips the terminator before the statement is sent. The raw `POST /api/db/query`
passes text through untouched, so a `;` sent there is refused by the engine — which is the honest
answer for an API that promises no rewriting.

**Backticks are refused, and double quotes are the identifier form.** Measured:
`` SELECT `customer` FROM probe_orders `` answers *"backquoted identifiers not supported; please use
double quotes instead"*, while `SELECT customer FROM "probe_orders"` and `SELECT "note.keyword" FROM
probe_shapes` are both HTTP 200. That is why `elasticsearch` is **not** in the backtick branch of
[`src/lib/sql/identifier.ts:36`](../../src/lib/sql/identifier.ts) and lands in the standard
double-quote default — the exact opposite of `opensearch`, which shares that branch with MySQL.

**`#` opens nothing.** `SELECT 1 # x` is a `parsing_exception` ("mismatched input '#'"), so the rest of
the line is *not* hidden. `ELASTICSEARCH_GRAMMAR.hash` is therefore `"code"`
([`grammar.ts:178`](../../src/lib/sql/grammar.ts)), which matters beyond cosmetics: reading `#` as a
comment would leave every `#` run ambiguous, and since #297 an unreadable span is a confirmation
**prompt** rather than silence — a prompt on a statement this engine simply refuses.

**`[` has no meaning at all.** `SELECT [1, 2]` and `SELECT [customer] FROM probe_orders` are both
"extraneous input '['", so it is neither an identifier quote nor a subscript. The grammar row leaves
`bracket` at the compatibility default deliberately rather than inferring one dialect's rule from
another's.

**String literals double the quote and read a backslash as data.** Measured: `SELECT 'a''b'` → `a'b`;
`SELECT 'a\\b'` → the two characters `a\b`; `SELECT 'a\'b'` is a `parsing_exception` at the character
*after* the backslash, which is only possible if the `\` did not escape the quote. Hence
`elasticsearch: "standard"` in [`src/lib/sql/values.ts:33`](../../src/lib/sql/values.ts) — and note
the fork does **both** forms, so the two ids do not share that row either.

**`_id` is not a column.** `SELECT _id FROM probe_orders` answers `verification_exception`, "Unknown
column [_id], did you mean [id]?". The fork returns it. So the document identity is not portable
between the two, which is one reason no column is ever marked primary
([§6](#6-schema-introspection)).

**An object or `nested` field breaks the whole statement, not one column.**
`SELECT address FROM probe_shapes` is 400, `verification_exception`, "line 1:8: Cannot use field
[address] type [object] only its subfields". Its leaf works: `SELECT note, note.keyword, address.city
FROM probe_shapes` is HTTP 200 for all three. This is the measurement that decides what counts as a
column ([§6](#6-schema-introspection)) — and the fork *allows* the container projection, which is
deliberately not branched on, because a starter query that works on one product and fails on the other
is worse than one that works on both.

### 5.5 The `prepareQuery()` override: there is no second page

Measured: `SELECT customer FROM probe_orders LIMIT 2 OFFSET 1` is HTTP 400,
`parsing_exception`, "line 1:43: mismatched input 'OFFSET' expecting <EOF>" — with or without an
`ORDER BY` in front of it. The inherited limiter emits exactly that clause for any page after the
first, so the editor's "load more" would turn a working statement into a syntax error.

`prepareQuery()` ([index.ts:505](../../src/lib/db/providers/sql/search/index.ts)) therefore **refuses
loudly**:

> Elasticsearch SQL has no OFFSET clause, so results after the first page cannot be requested here.
> Narrow the statement with a WHERE clause, or raise the row limit, instead of paging.

The alternatives are worse in a way that matters. Sending the clause anyway fails the query with an
engine message about a keyword the user never typed. **Silently dropping the OFFSET and sending
`LIMIT n` returns page ONE while the editor appends it to what it already shows** — duplicate rows
presented as new ones, a wrong *answer*, which is the one outcome worth throwing to avoid. Druid's
trailing-`OFFSET` case (#265) could leave the statement alone because there the cost was only extra
rows; here the cost is fabricated data.

The refusal is narrow on purpose: it fires only when the limiter actually produced the clause
(`prepared.wasLimited && prepared.offset !== 0`). A statement carrying its own `LIMIT` is left exactly
as the base class left it — untouched, `wasLimited: false` — because nothing was rewritten and the
user's own bound is what runs. The trait is declared per product (`acceptsOffsetClause`,
[index.ts:230](../../src/lib/db/providers/sql/search/index.ts)) rather than branched on the type-id,
so a third product declares its own answer instead of being added to a condition someone has to find.

### 5.6 This grammar does not write

Every one of these is HTTP 400 with `parsing_exception`, measured verbatim on 9.1.4:

| statement | reason |
|---|---|
| `INSERT INTO probe_orders …` | "mismatched input 'INSERT' expecting {'(', 'DEBUG', 'DESC', 'DESCRIBE', 'EXPLAIN', 'SELECT', 'SHOW', 'SYS', 'WITH'}" |
| `UPDATE probe_orders SET customer = 'x' WHERE id = 1` | same shape — `UPDATE` is not in the list either |
| `DELETE FROM probe_orders WHERE id = 99` | same — and note the fork *has* `DELETE` in its grammar, off by default |
| `CREATE TABLE t (id BIGINT)` | same — the grammar lists everything it accepts, and no DDL is among them |
| `ALTER TABLE probe_orders ADD COLUMN x INT` | same |

The grammar's own error message enumerating its accepted statements is the clearest possible statement
of the fact, which is why nothing is special-cased. Consequences elsewhere in the product:

- `supportsCreateTable: false` and `supportsInlineRowEdit: false` are facts about the grammar, not
  unimplemented features, so the EDIT toggle and the editable cell are not offered (#269).
- The schema-diff migration generator emits, in place of a column change:
  *"Elasticsearch SQL reads only; change a field by reindexing into an index whose mapping declares
  it."* ([`migration-generator.ts:81`](../../src/lib/schema-diff/migration-generator.ts)). It says
  *reindex* rather than "use the mapping API" for a reason: an existing field's type cannot be changed
  in place at all, even outside SQL.
- `schemaRefreshPattern` is `\b(DELETE)\b` ([index.ts:193](../../src/lib/db/providers/sql/search/index.ts)),
  which on **this** product can never fire — the grammar has no DELETE — exactly as Druid's
  `INSERT|REPLACE` never fires against its native engine. It is there for the fork, where a cluster
  that switches DELETE on really does change the document counts this provider reports.

Documents change through the document APIs (`_doc`, `_bulk`, `_delete_by_query`), which this seam does
not expose.

---

## 6. Schema introspection

`getSchema()` ([introspect.ts:355](../../src/lib/db/providers/sql/search/introspect.ts)) makes one
index listing plus **one mapping read per index**, at most
`SEARCH_MAPPING_CONCURRENCY = 4` at a time
([introspect.ts:102](../../src/lib/db/providers/sql/search/introspect.ts)) — the same trade-off
Couchbase's per-collection inference settled on, and `_mapping` is a cluster-state read rather than a
search, so it is cheap per call and not worth tuning past "not serial, not a flood".

| Data | Source |
|---|---|
| Indices (the "tables") | `GET /_cat/indices?format=json&bytes=b` |
| Columns | `GET /<index>/_mapping`, flattened to dotted paths |
| `rowCount` / `size` | `docs.count` / `pri.store.size` from the same listing, **omitted** when the server reported none |
| Indexes | always `[]` |
| Foreign keys | always `[]` |

**The schema comes from the MAPPING, not from SQL, and that is the load-bearing decision.**
`SELECT *` describes the *statement* rather than the index — measured, an index mapping `blob` as
`flattened` and `items` as `nested` answers `SELECT *` with `{"columns":[],"rows":[[]]}`, a table with
no columns at all — and `DESCRIBE` is a SQL surface whose availability is the very thing the tree must
not depend on. The mapping is the index's own declaration, is readable on a **closed** index
(measured), and is the document the user edits.

**The flattening is specified by this product's own `DESCRIBE`.** Measured on `probe_shapes`:

```
$ DESCRIBE probe_shapes
["address",      "STRUCT",  "object"]
["address.city", "VARCHAR", "keyword"]
["note",         "VARCHAR", "text"]
["note.keyword", "VARCHAR", "keyword"]
```

Containers appear, leaves appear, and a multi-field appears as a **child** — and `SELECT note.keyword,
address.city` then returns both columns, so the dotted child is genuinely selectable rather than a
display convenience. `flattenProperties()`
([http-transport.ts:776](../../src/lib/db/providers/sql/search/http-transport.ts)) reproduces exactly
that set from `_mapping`, descending both `properties` (objects) and `fields` (multi-fields). Nothing
outside `properties` is read, because a mapping carries siblings like `_meta` that are metadata about
the mapping rather than fields in it.

**Containers are not columns; a multi-field parent is.** `SEARCH_CONTAINER_TYPES = ["object",
"nested"]` ([introspect.ts:90](../../src/lib/db/providers/sql/search/introspect.ts)) are dropped,
because `query-generators.ts` builds its starter query by enumerating every declared column and a
container makes the whole statement fail ([§5.4](#54-dialect-traps-a-user-will-hit)). A `text` field
with a `keyword` sub-field is **kept**: `SELECT note` answers the text and `SELECT note.keyword` the
keyword, both 200, so "has sub-fields" is the wrong test — the field's own **type** is the test.

**Every column is nullable and none is primary**
([introspect.ts:195](../../src/lib/db/providers/sql/search/introspect.ts)):

- `nullable: true` is a measurement, not a hedge. A mapping declares how a field is indexed *if* a
  document carries it; there is no `NOT NULL` in the model, and a document indexed without `note`
  really does come back as `null`.
- `isPrimary: false` always. Nothing a mapping declares is unique — indexing the same body twice
  yields two documents — and the only unique thing in an index is `_id`, which is metadata rather
  than a mapped field and is **not even selectable here** ("Unknown column [_id]", measured). That
  matters because `isPrimary` is stated as *fact* wherever it is read: `sql-completions.ts` appends
  "(PK)", the agent's schema context puts " PK" into what a model reasons from, and `schema-diff`
  reports "Primary key changed". A key invented here becomes a key the product asserts.
- `defaultValue` is left undefined. A mapping's `null_value` is the closest thing and is **not** a
  default: it is the term substituted into the *index* for an explicit null so the value becomes
  searchable, and it changes no value any document carries.

**Column order is sorted by path**, by code unit, not by the server's order and not by locale
([introspect.ts:244](../../src/lib/db/providers/sql/search/introspect.ts)). This engine happens to
normalize mapping properties alphabetically even for a dynamically mapped index, but that is its
normalization and not a promise; the transport emits multi-fields after a level's own children; and a
mapping has no declaration order to preserve in the first place, because documents are unordered JSON.
Sorting by path also keeps `address.city` next to its siblings once the container is dropped.

**A closed index is kept, and reads honestly.** Measured, `_cat` for a closed index:

```json
[{"health":"yellow","status":"close","index":"probe_closed","docs.count":null,
  "pri.store.size":null, ...}]
```

The status word is **`close`**, not "closed"; the counts are JSON `null`; and the mapping still
answers in full. So the index is described completely with `rowCount` and `size` **omitted** rather
than zeroed — `TableSchema` makes both optional, which is what preserves the distinction. Dropping the
index would tell the user it is gone when it is merely closed, and a query against it gets the
engine's own refusal, which says exactly what happened.

**System indices are hidden by default.** The transport flags an index whose name is dot-prefixed, or
which matches the fork's date-suffixed query-insights shape
([http-transport.ts:263-264](../../src/lib/db/providers/sql/search/http-transport.ts)), and
`isSystemIndex()` ([introspect.ts:156](../../src/lib/db/providers/sql/search/introspect.ts)) is where
the product decides what to do with the flag. A stock Elasticsearch node ships none of these — the
measured cluster listed only the three probe indices — but the same code hides two of three on a stock
OpenSearch node, which is why the rule is a flag rather than a filter applied on the wire.
`SearchSchemaOptions.includeSystemIndices` exists because both answers are legitimate and the caller
knows which; `getSchema()` on the provider passes `{}`, i.e. hidden.

**A per-index failure costs one index's columns, not the tree.** Only `auth` and `unknown-object`
degrade to an empty column list
([`DEGRADABLE_MAPPING_FAILURES`, introspect.ts:119](../../src/lib/db/providers/sql/search/introspect.ts)):
a security plugin grants index privileges *per index*, so a role that lists twenty indices and may
describe nineteen is an ordinary configuration; and an index deleted between the listing and its
mapping read is a race, not a fault. Everything else propagates, because an unreachable cluster
rendering every index with zero columns reads as "these indices have no fields" — a fabricated schema,
and the failure mode that hides the real error forever.

`getSchemaList()` and `getSchemaRelations()` are deliberately **not implemented**. Both are optional
and the client falls back to `getSchema()`; the split exists so a slow relationship read cannot block
the table list, and here both halves are empty by construction, so a list would be byte-identical and
a relations pass would re-read every mapping to return the same empty arrays.

---

## 7. Monitoring & health

Every read goes through `guarded()`
([index.ts:694](../../src/lib/db/providers/sql/search/index.ts)), which maps a seam failure onto this
repo's error classes ([§10](#10-error-handling)). There is no per-category degradation table here as
Druid has one: the only read allowed to fail quietly is the cluster-wide store size
([§7.1](#71-the-one-swallowed-failure)).

| Method | Source | Mapping |
|---|---|---|
| `getOverview()` ([index.ts:751](../../src/lib/db/providers/sql/search/index.ts)) | `/`, `_cluster/health`, `_cat/indices` — **three seam calls in parallel** | `version` = `"Elasticsearch <number>"` from the connection's product plus the payload's version; `uptime` = **`"N/A"`**; `activeConnections` / `maxConnections` = **0**; `databaseSize(Bytes)` = the cluster's store from `_cluster/stats`; `tableCount` = **user** indices only; `indexCount` = **0** |
| `getPerformanceMetrics()` ([index.ts:811](../../src/lib/db/providers/sql/search/index.ts)) | — | **`{}`**, and it asks the cluster nothing |
| `getSlowQueries()` ([index.ts:831](../../src/lib/db/providers/sql/search/index.ts)) | — | **`[]`**. The slow log is written to the node's **log file**, which no API returns |
| `getIndexStats()` ([index.ts:844](../../src/lib/db/providers/sql/search/index.ts)) | — | **`[]`**. No secondary-index object exists |
| `getActiveSessions()` ([index.ts:860](../../src/lib/db/providers/sql/search/index.ts)) | — | **`[]`**. A request is one HTTP request; there is no session and no connection catalog |
| `getTableStats()` ([index.ts:873](../../src/lib/db/providers/sql/search/index.ts)) | `_cat/indices` | one row per **user** index: `rowCount` = `docs.count`, `tableSize(Bytes)` = `totalSize(Bytes)` = `pri.store.size`, `schemaName` = `""` |
| `getStorageStats()` ([index.ts:884](../../src/lib/db/providers/sql/search/index.ts)) | `_cluster/health` + `_cluster/stats` | **one row for the cluster**: `name` = `cluster_name`, `sizeBytes` = `indices.store.size_in_bytes`. **No row at all** when the size was unreported |
| `getHealth()` ([index.ts:898](../../src/lib/db/providers/sql/search/index.ts)) | the above, composed | `activeConnections`, `databaseSize`; `cacheHitRatio` = the repo's word for "not measured"; `slowQueries` = `[]`; `activeSessions` = `[]` |

**Two vocabulary collisions, both counted wrong by the obvious reading:**

- **`tableCount` counts INDICES** — an index *is* the table on this surface — and counts only the
  user's, matching what the schema tree shows by default. Counting engine bookkeeping would report a
  cluster holding data nobody put there (which is what would happen on the fork, where two of three
  indices on an empty node are the engine's).
- **`indexCount` is 0 and stays 0.** There is no secondary-index *object*: every mapped field is
  inverted-indexed as a property of being mapped, so there is nothing a user declared and nothing to
  name. The schema tree says the same thing from the other side with `indexes: []`.

**`databaseSizeBytes` is the CLUSTER's store including replicas**, while the per-index sizes in the
schema tree are **primaries only** (`pri.store.size`, chosen deliberately at
[http-transport.ts:161](../../src/lib/db/providers/sql/search/http-transport.ts)), so they do not sum
to it. On the measured single node with one replica requested they happen to be equal, which is
exactly why the choice had to be made deliberately rather than discovered later.

The honest empties, each with its reason:

- **`getPerformanceMetrics()` returns `{}`, not zeroes**, and this is load-bearing. `cacheHitRatio` is
  scored `direction: "below"` with `critical: 80` by `DEFAULT_THRESHOLDS`, so a "neutral" 0 would
  paint a red critical cache fault on every healthy cluster; the monitoring tabs default an **absent**
  ratio to a healthy 100 instead. Every other metric would read as a measurement of zero, which is a
  different and false claim — and **the tabs did read them that way** until the rule #448 settled for
  the Storage tab reached them: measured 2026-08-19 on OpenSearch, which is this same code path, the
  Overview showed *Buffer Pool 0%* and *Deadlocks 0* for two fields this payload omits. Both cards now
  read `N/A` beside *Not measured*, so the empty payload survives to the screen. The numbers do exist on this product's stats endpoints, so
  this is a recorded gap rather than an impossibility: widening the seam by one call is what a future
  phase would do, and doing it here would have meant reaching around the seam.
- **`getSlowQueries()` and `getActiveSessions()` return `[]` rather than throwing.** Nothing is broken
  and nothing is misconfigured, so a monitoring tab should render as quiet, not as failed. Only
  `runMaintenance()` throws, because that one is a *request to act*.
- **`activeConnections` / `maxConnections` are 0**, the same "not published" encoding `mssql.ts` and
  Druid use. The cluster counts open HTTP connections per node in its stats API, which is not one of
  this seam's five calls, and the shard and node counts that *are* here would be a different number
  wearing this field's name. The Connections card reads a zero maximum as "no limit published" rather
  than dividing by it.
- **`uptime` is `"N/A"`.** Neither the health nor the version payload carries one, and no other call
  in this seam does either. A `"0s"` would claim the cluster booted this instant.

**A closed index reads as zero in `getTableStats()` and is omitted in the schema tree**, and the
asymmetry is deliberate: `TableStats.rowCount` and the size fields are *required* numbers with no way
to say "unknown", while `TableSchema.rowCount` and `size` are optional. So the tree is the surface
that keeps the distinction ([index.ts:310-316](../../src/lib/db/providers/sql/search/index.ts)).

**Document counts exceed what a `SELECT` returns when a mapping has `nested` fields.** Measured on the
fork's `probe_shapes`, whose `items` field is `nested`: `_cat` reports **2** documents while
`SELECT COUNT(*)` answers **1**, because every nested element is stored as a document of its own. The
count reported here is the *cluster's* document count — which is what a "row" is on this surface — not
the number of rows a query would produce, so an index with nested fields always reads higher in these
panels than in the editor. Deriving it from SQL instead would mean a statement per index, on a surface
whose grammar the tree must not depend on, to answer a different question than the panel asks.

### 7.1 The one swallowed failure

`_cluster/stats` is heavier and more privileged than `_cluster/health`, so a cluster that answers
health and refuses stats is an ordinary configuration. `storeSizeBytes()`
([http-transport.ts:973](../../src/lib/db/providers/sql/search/http-transport.ts)) therefore catches
its own failure and returns `null` — the seam's "unknown" — because losing the health status over a
missing byte count would blank a panel that already had the important number.

Its null then propagates honestly: `getOverview()` shows `"N/A"` for the size, and
`getStorageStats()` returns **no row at all** rather than a row claiming the cluster stores zero
bytes.

---

## 8. Maintenance

**There is none.** `supportsMaintenance` is `false` and `maintenanceOperations` is `[]`, so no
maintenance control renders for this connection: `TablesTab.tsx` reads the connected provider's
capabilities (#272) and `OperationsTab.tsx` hides the whole Global Operations group where
`supportsMaintenance` is false (#282). That first tab's *Vacuum* summary card reads the same
declaration: it counted rows over a bloat ratio this provider never publishes, so it always said `0`
over a green **OK** — a clean bill of health for an operation named below as impossible here — and it
now says `N/A` over *Not supported*, with a dash in the per-row *Bloat* and *Last Vacuum* cells.

Every `MaintenanceType` is either an index API rather than a statement, or impossible on this surface
altogether:

- `vacuum` / `optimize` / `reindex` / `check` — the nearest analogues are `_refresh`, `_forcemerge`,
  `_reindex` and `_cache/clear`, all **index APIs on the cluster**, none of them a statement this SQL
  surface accepts.
- `analyze` — the cluster maintains its per-shard statistics itself as documents are indexed, and no
  statement recomputes them. (The engine's own `_analyze` is *text analysis*, an entirely different
  operation, which is why the labels below avoid the bare word "Analyze".)
- `kill` — impossible for a second, independent reason: an abort closes this client's socket while the
  cluster keeps working ([§3.8](#38-the-deadline-is-the-clients-and-only-the-clients)), and the task
  API that could really cancel a search is not part of this seam.

`runMaintenance(type)` ([index.ts:931](../../src/lib/db/providers/sql/search/index.ts)) exists because
the `DatabaseProvider` interface obliges every provider to implement it, and **not** because a request
reaches it: `/api/db/maintenance` checks `supportsMaintenance` and answers 400 first. So the message
below is what a *programmatic* caller of `@libredb/studio` sees:

> Elasticsearch has no SQL-reachable maintenance operation, so "\<type\>" cannot run here. Refreshing,
> merging segments and clearing caches are index APIs on the cluster rather than statements, and a
> running search cannot be cancelled through this surface.

Throwing rather than reporting a cheerful success is the point — a caller that asked for work must not
be told work happened.

---

## 9. Capabilities & labels

### `getCapabilities()` ([index.ts:388](../../src/lib/db/providers/sql/search/index.ts))

One answer for both products, because every flag here measured the same on both. The single
difference — `OFFSET` — has no field in `ProviderCapabilities` to declare it in, so it lives on
`SearchProduct` and is read by `prepareQuery()` alone.

| Capability | Value | Why |
|---|---|---|
| `queryLanguage` | `sql` | Elasticsearch SQL over the HTTP endpoint, no tier gate ([§3.3](#33-sql-and-not-esql)) |
| `supportsExplain` | **`false`** | No `explainFormat` is declared either, which hides both button and tab ([§3.10](#310-no-explain-even-though-elasticsearch-answers-one)) |
| `supportsExternalQueryLimiting` | `true` | `LIMIT n` is correct here; the one form that is not is refused by `prepareQuery()` ([§5.5](#55-the-preparequery-override-there-is-no-second-page)) |
| `supportsCreateTable` | **`false`** | Not in the grammar ([§5.6](#56-this-grammar-does-not-write)) |
| `supportsInlineRowEdit` | **`false`** | `UPDATE` is not in the grammar, so the editor's statement could only ever produce an error (#269) |
| `declaresForeignKeys` | **`false`** | The engine has no such constraint in its model, so the empty `foreignKeys` means "impossible here" rather than "none declared, or none visible to this role" — the distinction #414 was about |
| `supportsMaintenance` | **`false`** | Nothing in `MaintenanceType` is SQL-reachable ([§8](#8-maintenance)) |
| `maintenanceOperations` | `[]` | Consequence of the above |
| `supportsConnectionString` | **`false`** | No URI convention, and `http(s)://` is ClickHouse's ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)) |
| `defaultPort` | `9200` | Both schemes ([§4.3](#43-tls)) |
| `identifierQuoting` | **`double`** | Declared because the port cannot say: the fork ships on 9200 too and quotes differently, and a wrong guess there returns **no rows** rather than an error ([opensearch.md §5.4](./opensearch.md#54-dialect-traps-a-user-will-hit)) |
| `statementTerminator` | **`none`** | This grammar has no `;`, and the generated `SELECT * FROM probe_orders LIMIT 50;` was refused — the schema tree's first click ([§5.4](#54-dialect-traps-a-user-will-hit)) |
| `schemaRefreshPattern` | `\b(DELETE)\b` | Can never fire on this product — its grammar has no DELETE. It is there for the fork ([§5.6](#56-this-grammar-does-not-write)) |

`isGroupedKeyspace` is deliberately **absent**: an index is a real object the cluster holds, named by
whoever created it and addressable in a statement — not a grouping a server derived from a scan, which
is what Redis and LibreDB declare.

### `getLabels()` ([index.ts:455](../../src/lib/db/providers/sql/search/index.ts))

| Label | Value |
|---|---|
| `entityName` / `entityNamePlural` | **`Index`** / **`Indices`** |
| `rowName` / `rowNamePlural` | **`document`** / **`documents`** |
| `selectAction` | `Select Top 50 Documents` |
| `analyzeAction` / `analyzeGlobalLabel` | `Index Statistics` |
| `vacuumAction` / `vacuumGlobalLabel` | `Merge Segments` |
| `searchPlaceholder` | `Search indices or fields...` |
| `statementLanguage` | `Elasticsearch SQL, the product's own SQL endpoint - NOT the JSON query DSL, NOT an aggregation body, and NOT ES\|QL` |

`statementLanguage` is the one label here written for a **model** rather than for the UI, and it is
declared on these two engines alone. Measured in the browser on 2026-08-19: a plan run on a search
connection, told only "produce ONE runnable statement", answered with a native aggregation body —
`{"size":0,"aggs":{…},"query":{"term":{…}}}` — which is correct for the product and unrunnable through
the SQL endpoint this provider speaks to. The statement guard then declined to classify it
(`NO_STATEMENT`), so nothing ran; the user was still handed a plan they could not execute.
`queryLanguage: "sql"` was already true and settled nothing, because the engine's NAME carries the
stronger prior — so the label names what the language is **not**, and
[`investigation.ts`](../../src/lib/agent/investigation.ts) states it in the plan contract.

These are not decoration. `inventory-noun.ts` lowercases `entityName` into the noun the **agent**
reasons with, so a cluster described as holding "tables" of "rows" invites statements written for a
relational engine. "Indices" rather than "Indexes" because that is the plural the product's own API and
documentation use — and because "indexes" is the word this codebase already uses for the
secondary-index objects an index does **not** have (`TableSchema.indexes`, empty by construction
here).

The two maintenance actions are named even though `supportsMaintenance` is false, because they are
still rendered **where an engine has maintenance to run**, and their global descriptions say in words
that nothing runs from here.

They are no longer rendered in the **schema tree** on this engine. They used to be, and it was a dead
end: an index is addressable, so the `tablesAreDerivedGroupings` gate #427 added did not catch it, and
clicking "Merge Segments" navigated to `/admin/operations` — where the Global Operations card is gated
on `supportsMaintenance` and so was absent. No controls, no error, and none of the wording above, which
lives on the card that does not render (measured in the browser, 2026-08-19).
[`TableItem.tsx`](../../src/components/schema-explorer/TableItem.tsx) now asks for both an addressable
row **and** a declared maintenance capability.

---

## 10. Error handling

The transport normalizes every failure into
`SearchTransportError { category, message, engineType? }`
([transport.ts:153](../../src/lib/db/providers/sql/search/transport.ts)); `mapSearchError()`
([index.ts:671](../../src/lib/db/providers/sql/search/index.ts)) maps the **category** — never the
HTTP status — onto the shared classes in [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts). Every
category is listed and there is no `default`, so adding one to the seam fails the typecheck here
instead of being quietly swallowed as a query error.

| Category | Measured trigger on this product | Error raised |
|---|---|---|
| `auth` | HTTP 401/403 (status-decided; see [§3.7](#37-a-string-valued-error-means-the-request-never-reached-the-sql-engine)) | `AuthenticationError` |
| `unreachable` | A refused socket, an unresolvable host, or a **string-valued** `error` — the wrong endpoint path, the wrong method, a missing content type | `ConnectionError` carrying host and port |
| `timeout` | The client deadline expired (`AbortSignal.timeout`) | `TimeoutError` — and the cluster is *still working on the statement* |
| `cancelled` | The caller aborted | `QueryCancelledError` |
| `syntax` | `parsing_exception` — `SELEKT 1`, a trailing `;`, `OFFSET`, `INSERT`, `CREATE`, `ALTER` | `QueryError` |
| `unknown-object` | `verification_exception` (unknown index / column / function), `index_not_found_exception` from `_mapping` | `QueryError` |
| `unsupported` | *never produced on this product* — the fork's `SQLFeatureNotSupportedException` is what lands here | `QueryError` |
| `engine` | `arithmetic_exception` (`SELECT 1/0`, HTTP 500), any unrecognised fault name, the paging ceiling, an unreadable body | `QueryError` |

The four that collapse onto `QueryError` do so because they describe the same event to a user — the
cluster read the statement and refused it — and the engine's own wording, carried through verbatim, is
what distinguishes them on screen. A value that is **not** a seam error never came from the cluster
(an internal defect, an assertion) and goes to the shared message-based `mapError()`, exactly as
`druid/index.ts` and `clickhouse/index.ts` do.

The `unreachable` message quotes the cause from **both** places a runtime puts it, because this repo
runs on two: on Node a refused socket is `TypeError: fetch failed` whose `cause.code` is
`ECONNREFUSED`, while Bun throws `Error: Unable to connect. Is the computer able to access the url?`
with `code: "ConnectionRefused"` on the error **itself** and no cause at all. Neither runtime's
top-level message names the reason on its own
([http-transport.ts:677-729](../../src/lib/db/providers/sql/search/http-transport.ts)).

| Situation | Error |
|---|---|
| Missing `host` | `DatabaseConfigError` — "Elasticsearch requires a host" |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails on credentials | `AuthenticationError` — a rejected credential is not a connectivity problem, and saying so would send the user to check a host that answered perfectly well |
| `connect()` fails otherwise | `ConnectionError` — "Failed to connect to Elasticsearch: …", carrying the cluster's own words |
| `query(sql, params)` with parameters | `QueryError`, raised **before** anything leaves the process ([§3.11](#311-positional-parameters-are-refused-not-emulated)) |
| More result pages than `MAX_PAGES` | `QueryError` naming the ceiling and advising a narrower statement — after the abandoned cursor is closed ([§3.5](#35-the-engine-pages-aggregations-by-itself)) |

---

## 11. Testing

### 11.1 How the tests work

There is **no `mock.module()` anywhere in the search suite** — it is process-wide in bun and would
poison sibling files.

- [`tests/integration/db/elasticsearch-provider.test.ts`](../../tests/integration/db/elasticsearch-provider.test.ts)
  replaces `globalThis.fetch` per test and restores it in `afterEach`, so the real transport, the real
  introspection and the real provider all run — only the server is fake. Every payload was captured
  from a live 9.1.4 node (`probe_orders`, `probe_shapes`, `probe_buckets`), so the fake speaks exactly
  what the server speaks. It pins the endpoint path and query string too, because those are
  product-specific: a test that accepted any path would keep passing after the two dialects were
  crossed. This file carries the behaviour the **two products share** plus everything only this one
  does: the engine-initiated paging with its column-less second page, duplicate-column
  disambiguation, the 400/500 status inversion, the string-valued `error`, the quoted `_cat` numbers
  and the `close`-status index, and the refused `OFFSET`.
- [`tests/integration/db/opensearch-provider.test.ts`](../../tests/integration/db/opensearch-provider.test.ts)
  is the **divergence** suite: what the fork does differently, so that "two type-ids, one
  implementation" is a tested claim rather than an assumption.
- [`tests/unit/db/search/introspect.test.ts`](../../tests/unit/db/search/introspect.test.ts) drives
  introspection through a hand-built `SearchTransport` — the payoff of the seam: no `fetch` mocking
  and no server. Its fake's `query()` **throws on purpose**, because introspection reading a statement
  would be a design regression rather than a test failure.
- [`tests/unit/db/search/seam-guard.test.ts`](../../tests/unit/db/search/seam-guard.test.ts) is a
  parser, not a grep, and proves itself in both directions: it must fire on `http-transport.ts` (which
  is *supposed* to speak HTTP) and stay silent on a compliant sample, before it asserts the provider
  directory is clean.

### 11.2 Coverage

Validation (host required), capabilities and labels, connect/disconnect including the `SELECT 1` probe
surfacing a wrong endpoint or a rejected credential, query execution and result shaping (declared
order, duplicate-name disambiguation, the measured duration, the absent `totalHits`), engine-initiated
paging including the ceiling and the cursor close, the full category-to-error map including the
HTTP-500 user error, the `prepareQuery()` override in both directions, mapping-driven schema
(containers dropped, multi-fields dropped, closed index, system-index flag, the degradable per-index
failures), every monitoring method and its empties, and `runMaintenance()` refusing with its reason.

### 11.3 Run it

```bash
bun test tests/integration/db/elasticsearch-provider.test.ts
bun test tests/unit/db/search

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: reproducing the live pass

The committed tests never touch a cluster. To reproduce the measurements behind this document,
`database-compose.yml` carries the **exact build** this provider was verified against, and
deliberately **no profile** — unlike Druid's block — because these are shipped providers and a plain
`docker compose up` has to be able to reproduce their integration pass:

```bash
docker compose -f database-compose.yml up -d elasticsearch opensearch
```

Both services run together on purpose: every claim this document records is a claim about which of the
two answered differently, and that can only be re-measured side by side. `elasticsearch` publishes
**9200**; the fork publishes **9201** on the host, because both ship on 9200 in the container — a
collision on this machine, not a fact about the product. Security is **disabled** on both, which is
what makes the fixtures reproducible and is also the limit of what they can prove: a bogus `Basic`
header is ignored there, so no 401/403 body could ever be captured
([§3.7](#37-a-string-valued-error-means-the-request-never-reached-the-sql-engine)).

The health check waits for **yellow**, not green: a single node with a replica requested is yellow
forever, so waiting for green would hang.

**Which distribution, and under which licence.** The pinned image is the **default** build flavour -
`GET /` reports `build_flavor` `default`, not `oss` - and the licence it ships is **Elastic License
2.0**, the first line of `/usr/share/elasticsearch/LICENSE.txt` inside the image
(<https://www.elastic.co/licensing/elastic-license>). The limitation that bears on this question is
the one on providing the software to third parties as a hosted or managed service (the licence
states two others, on the licence-key functionality and on removing notices), and it binds a
would-be host of Elasticsearch rather than an HTTP client of one: this provider speaks HTTP to a
server the user runs, and links, bundles and redistributes nothing. The **basic** that
`GET /_license` reports (type `basic`, status `active`, issuer `elasticsearch`, issued to
`docker-cluster`) is a different thing again - a self-generated **subscription tier**, not the
software licence - and it is the tier the `_sql` endpoint is available on.

Seed the three probe indices with the document API — there is no `CREATE TABLE` here:

```bash
curl -s -XPOST -H 'content-type: application/json' \
  'http://localhost:9200/probe_orders/_doc?refresh=true' \
  -d '{"id":1,"customer":"acme","total":9.5,"note":"first order","created":"2026-08-19T00:00:00Z"}'

# an object and a multi-field, which is what §6's flattening is measured against
curl -s -XPUT -H 'content-type: application/json' 'http://localhost:9200/probe_shapes' \
  -d '{"mappings":{"properties":{"address":{"properties":{"city":{"type":"keyword"}}},
                                 "note":{"type":"text","fields":{"keyword":{"type":"keyword"}}}}}}'

# 1500 distinct values, which is what makes the engine page an aggregation (§3.5)
for i in $(seq 1 1500); do printf '{"index":{}}\n{"k":"k%s"}\n' "$i"; done \
  | curl -s -XPOST -H 'content-type: application/x-ndjson' \
      'http://localhost:9200/probe_buckets/_bulk?refresh=true' --data-binary @-
```

`probe_buckets` is the one that matters most: any smaller cardinality keeps the whole `GROUP BY` on
one page and makes the paging defect invisible.

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'es1', name: 'Elasticsearch', type: 'elasticsearch',
  host: '127.0.0.1', port: 9200,
  createdAt: new Date(),
});

await provider.connect();                              // proves the port AND the product

const rows   = await provider.query('SELECT * FROM probe_orders LIMIT 50');   // no trailing ';'
const groups = await provider.query('SELECT k, COUNT(*) AS c FROM probe_buckets GROUP BY k');
const schema = await provider.getSchema();             // indices + mapped fields; indexes always []
const stats  = await provider.getTableStats();         // documents and primary bytes per index

await provider.disconnect();
```

Two habits worth keeping, both from [§5.4](#54-dialect-traps-a-user-will-hit): **no trailing
semicolon**, and double quotes — never backticks — if an identifier needs quoting at all.

### 12.2 Over the API

`POST /api/db/query` with the statement in the `sql` field — the same contract every SQL provider
uses. `POST /api/db/maintenance` answers 400 before reaching the provider ([§8](#8-maintenance)). The
transaction and cancel routes do not apply: `/api/db/cancel` reports cancellation as unsupported
because the provider exposes no `cancelQuery` ([§3.8](#38-the-deadline-is-the-clients-and-only-the-clients)).

---

## 13. Known limitations & future work

- **No EXPLAIN.** `supportsExplain: false`, so the button and the tab are hidden. This product answers
  `EXPLAIN <select>` with plan **text** and the fork refuses that statement form entirely, so one code
  path cannot serve both; the text is also not the tree `src/lib/explain/` models
  ([§3.10](#310-no-explain-even-though-elasticsearch-answers-one)).
- **Aliases and data streams are not listed in the schema tree.** They come from other endpoints
  (`_alias`, `_data_stream`) that this seam does not carry, so a **queryable** alias does not appear in
  the sidebar even though SQL accepts it. Recorded on the seam itself
  ([transport.ts:205-219](../../src/lib/db/providers/sql/search/transport.ts)), and note the mapping
  read already tolerates the case: it takes the single entry of the payload rather than looking it up
  by the requested name, because an alias resolves to the concrete index behind it.
- **No maintenance operations at all** ([§8](#8-maintenance)).
- **No active sessions and no slow queries**, structurally rather than unimplemented: a request is one
  HTTP request, and the slow log is a node log file no API returns ([§7](#7-monitoring--health)).
- **An index whose mapping has `nested` fields reports more documents than a `SELECT` returns**,
  because every nested element is stored as its own document ([§7](#7-monitoring--health)). The
  monitoring panel reports the cluster's count; the editor reports the query's.
- **`totalHits` is unavailable on this product.** Nothing in a successful answer carries a
  matching-document count, so the seam's field is `null` here and a caller must read it as "unknown"
  ([§3.4](#34-the-success-envelope-positional-rows-and-a-duplicate-name-that-must-not-vanish)). It is
  dropped even where the fork supplies it, so no surface behaves differently between the two.
- **A trailing semicolon is a syntax error**, including in the statement
  `generateTableQuery()` produces for a search connection — measured, `SELECT * FROM probe_orders
  LIMIT 50;` answers `parsing_exception`, "extraneous input ';'"
  ([§5.4](#54-dialect-traps-a-user-will-hit)).
- **There is a paging ceiling.** A statement whose result the engine spreads over more than
  `MAX_PAGES = 1000` pages is **refused** rather than truncated, after the cursor is closed. At the
  measured page size that is a million rows ([§3.5](#35-the-engine-pages-aggregations-by-itself)).
- **No second page through the editor**, because this grammar has no `OFFSET`; the request is refused
  with the reason rather than silently answered with page one
  ([§5.5](#55-the-preparequery-override-there-is-no-second-page)).
- **No writes of any kind**, and no schema change: a field's type cannot be altered in place even
  outside SQL ([§5.6](#56-this-grammar-does-not-write)).
- **No positional parameters**, refused rather than inlined
  ([§3.11](#311-positional-parameters-are-refused-not-emulated)).
- **No `cancelQuery`.** An abort bounds this client's wait; the cluster finishes the statement
  ([§3.8](#38-the-deadline-is-the-clients-and-only-the-clients)).
- **Performance metrics are empty**, and this one *is* reachable: the numbers exist on this product's
  stats endpoints, so widening the seam by one call is the concrete follow-up
  ([§7](#7-monitoring--health)).
- **`ssl.caCert` / `ssl.clientCert` / `ssl.rejectUnauthorized` are not honoured**, so a self-signed
  certificate fails verification — common on a secured cluster ([§4.3](#43-tls)).
- **No connection string**, deliberately ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)).
- **A type the engine maps but its SQL surface cannot read is still listed as a column.** Measured:
  `flattened` is refused with "Cannot use field [blob] with unsupported type [flattened]" while the
  mapping declares it like any other field. The mapping does not say which types SQL supports, and
  enumerating them would be a per-version list this code cannot verify — one that would hide fields a
  future version reads perfectly well ([introspect.ts:46-52](../../src/lib/db/providers/sql/search/introspect.ts)).
- **The whole result body is buffered** before it is parsed
  ([§3.1](#31-http-only--no-driver-and-what-that-costs)).

---

## 14. References

- Source: [`src/lib/db/providers/sql/search/`](../../src/lib/db/providers/sql/search/)
- Sibling type-id (same implementation): [opensearch.md](./opensearch.md)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Connection form config: [`src/lib/db-ui-config.ts`](../../src/lib/db-ui-config.ts)
- Dialect facts elsewhere in the codebase: [`src/lib/sql/grammar.ts:178`](../../src/lib/sql/grammar.ts) (`#`, `[`, block comments) · [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) (double quotes) · [`src/lib/sql/values.ts:33`](../../src/lib/sql/values.ts) (literal escaping) · [`src/lib/sql/fence-tags.ts`](../../src/lib/sql/fence-tags.ts) (the fence tag)
- Local cluster: [`database-compose.yml`](../../database-compose.yml) (`elasticsearch` service, 9200)
- Tests: [`tests/integration/db/elasticsearch-provider.test.ts`](../../tests/integration/db/elasticsearch-provider.test.ts) · [`tests/unit/db/search/`](../../tests/unit/db/search/)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Adding a provider over HTTP: [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md)
- Tracking issue: [#424 — Search providers](https://github.com/libredb/libredb-studio/issues/424)
- Elasticsearch SQL: <https://www.elastic.co/guide/en/elasticsearch/reference/current/xpack-sql.html>
- SQL REST API: <https://www.elastic.co/guide/en/elasticsearch/reference/current/sql-rest.html>
- Mapping: <https://www.elastic.co/guide/en/elasticsearch/reference/current/mapping.html>
- `_cat/indices`: <https://www.elastic.co/guide/en/elasticsearch/reference/current/cat-indices.html>
- Elastic License 2.0: <https://www.elastic.co/licensing/elastic-license>
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [MongoDB](./mongodb.md) · [Couchbase](./couchbase.md) · [ClickHouse](./clickhouse.md) · [Apache Druid](./druid.md) · [Apache Trino](./trino.md) · [OpenSearch](./opensearch.md) · [Redis](./redis.md) · [LibreDB](./libredb.md)
