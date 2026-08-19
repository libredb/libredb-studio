# OpenSearch Provider

> OpenSearch support for LibreDB Studio, built on the SQL plugin that ships with the distribution
> (`POST /_plugins/_sql`, port `9200`) with **no driver dependency of any kind**: every statement is a
> JSON body and the answer comes back through the runtime's own `fetch`. This document is the single
> reference point for the `opensearch` type-id: design, architecture, usage, and tests. Its sibling
> [elasticsearch.md](./elasticsearch.md) is the prime reference for the upstream product — **one
> implementation serves both type-ids**, and the two documents deliberately disagree wherever the two
> products do.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `opensearch` |
| **Family** | SQL (`src/lib/db/providers/sql/search/` — shared with `elasticsearch`) |
| **Driver** | None — HTTP only (`fetch`, a runtime built-in) |
| **Query language** | `sql` (the OpenSearch SQL plugin, bundled with the distribution — no install step). **There is no ES\|QL here at all**, which is why SQL is the shared language ([§3.3](#33-sql-because-there-is-no-esql-here)) |
| **Default port** | `9200` for both schemes. A TLS deployment serves HTTPS on that **same** port ([§4.3](#43-tls)). The container fixture publishes it on **9201** to avoid colliding with the upstream service |
| **Connection pooling** | None — each statement is one stateless HTTP request |
| **Connection string** | **Not supported** — addressed by host and port like Druid, and `http(s)://` is already ClickHouse's in the shared parser ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)) |
| **EXPLAIN** | **None.** `supportsExplain: false` and no `explainFormat`. `EXPLAIN <select>` as a *statement* is refused here; a plan exists only behind a second endpoint this seam does not carry ([§3.10](#310-no-explain-the-statement-form-is-refused)) |
| **Writes** | **None reach documents.** `DELETE` is in this grammar but **off by default**, and every other mutation is refused outright ([§5.6](#56-this-grammar-has-delete-and-it-is-off)) |
| **Transactions** | Not exposed (the engine has none) |
| **Maintenance** | None — nothing in `MaintenanceType` has a SQL-reachable analogue ([§8](#8-maintenance)) |
| **Query cancellation** | No `cancelQuery`. An abort closes **this client's** socket; the cluster keeps working ([§3.8](#38-the-deadline-is-the-clients-and-only-the-clients)) |
| **Verified against** | **OpenSearch 3.8.0** (security disabled, stock single node — `GET /` reported distribution `opensearch`, number `3.8.0`, build_date `2026-08-01`), indices `probe_orders` (1 doc) and `probe_shapes` (2 docs, an object, a `nested` and a multi-field), measured 2026-08-19 |
| **Source** | [`src/lib/db/providers/sql/search/`](../../src/lib/db/providers/sql/search/) |
| **Tests** | [`tests/integration/db/opensearch-provider.test.ts`](../../tests/integration/db/opensearch-provider.test.ts) + [`tests/unit/db/search/`](../../tests/unit/db/search/) |
| **Tracking issue** | [#424 — Search providers, Phase 1](https://github.com/libredb/libredb-studio/issues/424) |

---

## 1. Overview

OpenSearch is the Apache-2.0 fork of Elasticsearch 7.10. Its **SQL surface is a bundled plugin** —
`POST /_plugins/_sql`, present on a stock node with nothing to install and no licence to hold — and
that endpoint is the whole query surface this provider speaks. Schema and monitoring come from the
REST APIs instead (`_cat/indices`, `<index>/_mapping`, `_cluster/health`, `_cluster/stats`), because
the mapping is the index's own declaration while a `SELECT` only ever describes a statement
([§6](#6-schema-introspection)).

The fork shares the upstream product's REST layer and has replaced its SQL engine, and **that split is
the single most important thing to know about this provider**: the same cluster speaks two error
vocabularies depending on which endpoint answered ([§3.6](#36-two-fault-vocabularies-in-one-cluster)).
Three things are OpenSearch-shaped:

1. **The success envelope is its own**, `schema` / `datarows` with `total` and `size` beside it, and
   the user's alias lives in a **separate member** from the column name — so reading `name` alone puts
   the wrong label on a column ([§3.4](#34-the-success-envelope-schemadatarows-a-separate-alias-and-a-count)).
2. **The SQL plugin names its faults with Java class names** — `SQLFeatureNotSupportedException`,
   `SemanticCheckException`, `EOFParserException` — while the core REST layer keeps the upstream
   snake_case lineage ([§3.6](#36-two-fault-vocabularies-in-one-cluster)).
3. **A stock node is mostly not your data.** Measured on an empty 3.8.0 cluster, `.plugins-ml-config`
   and `top_queries-2026.08.18-74305` are already there — and the second carries **no leading dot**, so
   the dot convention alone does not catch it ([§6](#6-schema-introspection)).

### Concept mapping

| `DatabaseProvider` slot | OpenSearch realisation | Mechanism |
|---|---|---|
| "Table" (`TableSchema`) | An **index**, displayed by its bare name | `GET /_cat/indices?format=json&bytes=b` |
| "Row" | A **document** | One positional array element in `datarows` |
| Columns | The index's **mapped fields**, flattened to dotted paths, mapping types verbatim | `GET /<index>/_mapping` |
| Primary key | none — nothing a mapping declares is unique. `_id` *is* selectable here (measured, unlike upstream) but it is metadata rather than a mapped field | `isPrimary: false` on every column |
| `query(sql)` | One SQL statement, **no** parameters | `POST /_plugins/_sql` |
| Indexes | none — every mapped field is inverted-indexed with no index *object* to name | always `[]` |
| Foreign keys | none (the engine has no such constraint) | always `[]`, plus `declaresForeignKeys: false` |
| `getOverview()` / storage | Version, cluster health, index count, cluster store bytes | `/`, `_cluster/health`, `_cluster/stats`, `_cat/indices` |
| `getActiveSessions()` | nothing — a request is one HTTP request, there is no session | always `[]` |
| `getSlowQueries()` | nothing **read**, although this product really does keep top-N queries — see [§7](#7-monitoring--health) | always `[]` |
| Maintenance | nothing SQL can reach | `runMaintenance()` throws with the reason |

---

## 2. Architecture

### 2.1 Where it sits

One directory serves **two type-ids**. Everything the two products disagree about on the wire is a row
in the transport's dialect table
([http-transport.ts:357-409](../../src/lib/db/providers/sql/search/http-transport.ts)) and everything
they disagree about above it is one field of `SearchProduct`
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

They stay **two type-ids** rather than one with a runtime probe because a connection has to say which
product is listening: the SQL endpoint path is product-specific and the wrong one never reaches a SQL
engine (measured — `POST /_sql` against OpenSearch answers HTTP **405**,
`{"error":"Incorrect HTTP method for uri [/_sql?format=json] …"}`). Their grammars also genuinely
disagree — `OFFSET`, string escapes, `#`, `[…]`, backticks — which is recorded in
[`src/lib/types.ts`](../../src/lib/types.ts) where the union is declared.

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
OpenSearchProvider (search/index.ts:967)         ElasticsearchProvider (search/index.ts:953)
```

`OpenSearchProvider` is thin by construction — it names its product and nothing else
([index.ts:959-971](../../src/lib/db/providers/sql/search/index.ts)) — and the one behaviour it does
**not** share with upstream is that its grammar accepts `OFFSET`, which is declared as a trait
(`acceptsOffsetClause: true`) rather than branched on
([§5.5](#55-offset-works-here-which-is-why-paging-does)).

### 2.3 What `SQLBaseProvider` gives for free

| Member | Purpose here |
|---|---|
| `buildLimitClause()` | **Both** forms are correct here: `LIMIT n` and `LIMIT n OFFSET m` (measured, HTTP 200). So the shared limiter is right unmodified and `prepareQuery()` never refuses anything on this product ([§5.5](#55-offset-works-here-which-is-why-paging-does)) |
| `prepareQuery()` (base) | The shared query limiter, used as inherited |
| `escapeIdentifier()` | Inherited and **never called** — this provider builds no SQL of its own, because the schema comes from the mapping rather than from a statement. Worth knowing that its default branch would double-quote, which is **wrong for this product** ([§5.4](#54-dialect-traps-a-user-will-hit)); the codebase's own quoter gets it right instead ([`identifier.ts:36`](../../src/lib/sql/identifier.ts)) |
| `getPlaceholder()` | Inherited and never reached: positional parameters are refused outright ([§3.11](#311-positional-parameters-are-refused-not-emulated)) |
| `measureExecution()` / `trackQuery()` | The measured duration is the only timing in existence — neither the body nor the headers carry one |
| `shouldEnableSSL()` | Inherited but **never called**. TLS comes from the connection's own `ssl` config only ([§4.3](#43-tls)) |

### 2.4 Registration & lifecycle

The factory wires the type-id in via a dynamic import
([factory.ts:123](../../src/lib/db/factory.ts)):

```ts
case "opensearch": {
  const { OpenSearchProvider } = await import("./providers/sql/search/index");
  return new OpenSearchProvider(connection, options);
}
```

`connect()` ([index.ts:536](../../src/lib/db/providers/sql/search/index.ts)) proves the cluster with
one `SELECT 1` — measured HTTP 200, one column named `1` of type `integer`. It needs no index, so it
also succeeds on a cluster holding nothing yet. It proves the **product** as well as the port: pointing
an `opensearch` connection at an upstream node fails at the connection form, because
`POST /_plugins/_sql` there is refused with
`{"error":"no handler found for uri [/_plugins/_sql] and method [POST]"}` before it reaches any SQL
engine, and the transport reports that as `unreachable` quoting the cluster's own words
([§3.7](#37-a-string-valued-error-means-the-request-never-reached-the-sql-engine)).

`disconnect()` forgets the transport and nothing else: every request is one `fetch` with no pool, no
session and no cursor behind it, which is why `SearchTransport` has no `close()` at all. API routes use
`getOrCreateProvider()`, which caches the connected provider per `connection.id` and evicts it after 30
minutes idle.

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 HTTP only — no driver, and what that costs

OpenSearch ships `@opensearch-project/opensearch`, a first-class Node client. It is **not** a
dependency here: everything this provider needs is four REST paths and one SQL endpoint, so
`package.json` is untouched — no install step to fail, no native module in the Docker image or any
distribution channel, and no N-API question for the Bun runtime. Same rubric
([`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md)), same call Couchbase (#262), ClickHouse (#264)
and Druid (#265) made.

What it costs: no sniffing, no failover and no retry (one statement is one `fetch` to one host); the
whole body is buffered before it is parsed, so a deliberately huge result is expensive in a way a
streaming client would not be; and `ssl.caCert` / `ssl.clientCert` / `ssl.rejectUnauthorized` are not
honoured, because global `fetch` cannot carry a custom CA without an undici `Agent` and undici is not a
dependency ([§4.3](#43-tls)).

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

`dialect` is the **only** product distinction that crosses it, and
[transport.ts:46-55](../../src/lib/db/providers/sql/search/transport.ts) is explicit that it may pick a
word and never a behaviour. `http-transport.ts` holds itself to the stronger rule that no method
branches on `this.dialect` at all — it reads `this.spec`, one row of the dialect table — so the whole
product difference is data:

| dialect field | `opensearch` | `elasticsearch` |
|---|---|---|
| `sqlPath` / `sqlQuery` | `/_plugins/_sql`, **no query string** (its default `jdbc` format *is* this envelope) | `/_sql`, `format=json` (without it the answer is tabular text with no types) |
| `columnsKey` / `rowsKey` | `schema` / `datarows` | `columns` / `rows` |
| `aliasKey` | **`alias`** | `null` — the alias is folded into `name` |
| `totalKey` | **`total`** | `null` — no count is sent at all |
| `detailKey` | **`details`** — the only member with anything specific in it | `null` |
| `faults` | Java class names, plus one snake_case name from the core REST layer | snake_case exception types |
| `syntaxTypePattern` | `/ParserException$/` | `null` |

> **Seam rule.** The wire vocabulary — the two SQL endpoints, `/_cat/indices`, `/_cluster/health`,
> `/_cluster/stats`, `/_mapping`, the envelope keys (`schema`, `datarows`, `total`, `size`, `alias`,
> `columns`, `rows`, `cursor`, `properties`, `fields`, `mappings`, `docs.count`, `pri.store.size`,
> `cluster_name`, `size_in_bytes`, `details`, `root_cause`), the product fault names, the HTTP status
> numbers and `fetch` itself — must appear **only** in `http-transport.ts`.
> [`tests/unit/db/search/seam-guard.test.ts`](../../tests/unit/db/search/seam-guard.test.ts) parses
> every source in the directory with the TypeScript compiler API — not a grep — and fails the build the
> moment any of it appears elsewhere. This fork forces the guard to be narrower than Couchbase's or
> Druid's, because its envelope keys are ordinary English that the **neutral** seam legitimately uses:
> `schema` and `size` are simultaneously wire keys here and `options.schema` / `TableSchema.size`
> everywhere else, so those words are matched only as exact **string literals** — the spelling envelope
> *parsing* produces — and a bare property access is left alone.

Adopting `@opensearch-project/opensearch` later is one new file implementing the same interface.

### 3.3 SQL, because there is no ES|QL here

The upstream product has ES|QL (`POST /_query`); **this one has none at all** — the path answers 405.
A surface only one of the two products has cannot be the shared query language, while the SQL endpoint
is present on both with no licence, so `queryLanguage` is `sql` on both type-ids. That also buys Monaco
SQL highlighting, the shared limiter, the `"sql"` tab type and saved queries with no additional code.

### 3.4 The success envelope: `schema`/`datarows`, a separate alias, and a count

Measured, `SELECT customer AS who FROM probe_orders`:

```json
{"schema":[{"name":"customer","alias":"who","type":"keyword"}],
 "datarows":[["acme"]],
 "total":1,"size":1,"status":200}
```

Four properties the code depends on:

- **The alias is a separate member.** Upstream declares `{"name":"who"}` for the same statement — the
  alias *is* the name there — so reading `name` alone would label this column `customer`, which is a
  **wrong** label rather than a missing one. `describeColumns()`
  ([http-transport.ts:509](../../src/lib/db/providers/sql/search/http-transport.ts)) prefers the alias
  when the dialect declares an `aliasKey`, and the alias is what the user typed, so it is what the grid
  must show.
- **Rows are positional**, so each row is rebuilt against the declared column list rather than read as
  an object; the declared **order** is authoritative in a way object keys never are.
- **A duplicate output name is REFUSED, not disambiguated.** Measured, `SELECT 1 AS c, 2 AS c` answers
  HTTP 400, `IllegalArgumentException`, "Multiple entries with same key: c=2 and c=1" — where upstream
  answers 200 with two columns named `c`. So the seam's uniqueness invariant is load-bearing on exactly
  one of the two products, and `disambiguate()`
  ([http-transport.ts:489](../../src/lib/db/providers/sql/search/http-transport.ts)) can never fire
  here. That is a fact about this engine, not dead code.
- **`total` and `size` accompany every answer**, so `SearchQueryResult.totalHits` is a real number here
  and `null` upstream. It is deliberately **not used** by the provider
  ([§5.2](#52-result-shaping)).

**`status` inside the body is ignored.** It duplicates the HTTP status, and the HTTP status is not what
classifies a failure here either ([§3.6](#36-two-fault-vocabularies-in-one-cluster)).

### 3.5 Paging: the cursor is followed, never requested

Both products spell the paging token `cursor`, and the transport follows it until the engine stops
sending one, bounded by `MAX_PAGES = 1000`
([http-transport.ts:151](../../src/lib/db/providers/sql/search/http-transport.ts)). The measurement
that made this necessary came from upstream — an aggregation over 1500 distinct values answered 1000
rows plus a cursor with no page size ever requested, and page two carried **no column declaration** —
so the loop carries page one's declaration forward and rebuilds later pages against it
([elasticsearch.md §3.5](./elasticsearch.md#35-the-engine-pages-aggregations-by-itself)).

The code is dialect-neutral and applies here unchanged: nothing about it asks which product answered,
so a paged answer from this engine is followed the same way. No `fetch_size` is ever sent, so no
server-side page state is created on this provider's initiative; a cursor still held when the ceiling
is reached is closed on the way out before the ceiling is **reported** rather than silently accepted.

### 3.6 Two fault vocabularies in one cluster

This is the finding most likely to be mistaken for a bug in the provider. **The SQL plugin reports Java
class names while the core REST layer keeps the upstream snake_case lineage**, so which vocabulary you
see depends on which endpoint answered. Measured, one probe per row:

| request | HTTP | `error.type` | category |
|---|---|---|---|
| `SELECT * FROM nope_missing` | **404** | `IndexNotFoundException` | `unknown-object` |
| `GET /nope_missing/_mapping` | 404 | **`index_not_found_exception`** (snake_case!) | `unknown-object` |
| `SELECT nosuchfield FROM probe_orders` | 400 | `SemanticCheckException` — "can't resolve Symbol(namespace=FIELD_NAME, name=nosuchfield) in type env" | `unknown-object` |
| `SELEKT 1` / `INSERT INTO …` / `DELETE FROM probe_orders WHERE id = 99` | 400 | `SQLFeatureNotSupportedException` — "Query must start with SELECT, DELETE, SHOW or DESCRIBE: …" | **`unsupported`** |
| `SELECT FROM probe_orders` | 400 | `ParserException` | `syntax` |
| `SELECT * FROM probe_orders WHERE` | 400 | `EOFParserException` — details `"EOF"` | `syntax` |
| `SELECT customer FROM probe_orders LIMIT abc` | 400 | `NumberFormatException` — "For input string: \"abc\"" | `syntax` |
| `SELECT 1 AS c, 2 AS c` | 400 | `IllegalArgumentException` | `engine` |
| `SELECT sillyfunc(1)` | 400 | `NullPointerException` (a genuine engine-side NPE inside the parser) | `engine` |

Three consequences, all deliberate:

- **A missing index is 404 here and 400 upstream** — the same typo, two statuses — while a user's own
  arithmetic answers 500 upstream. So categorisation is **body-driven** everywhere in this provider
  ([transport.ts:26-32](../../src/lib/db/providers/sql/search/transport.ts)), the
  ClickHouse lesson from #264 arriving again.
- **A mistyped leading keyword is `unsupported` here and `syntax` upstream**, because that is what each
  engine claims about it. The asymmetry is not papered over: `unsupported` is mapped to `QueryError`
  rather than to a configuration error for exactly this reason — it describes a statement problem, not
  a deployment one ([§10](#10-error-handling)).
- **`ParserException` is matched by SHAPE**, not by name (`syntaxTypePattern: /ParserException$/`,
  [http-transport.ts:408](../../src/lib/db/providers/sql/search/http-transport.ts)). Two members of
  that family were measured and the grammar has several, so matching the suffix means a third is
  classified correctly the first time a user hits it rather than reported as an engine fault. Anything
  the table has never seen becomes `engine` — "reached, understood, and refused" — rather than a guess.

**The useful text is in `details`, not in `reason`.** Measured, `reason` is the literal constant
`"Invalid SQL query"` for a mistyped keyword, an unknown column and an unparseable LIMIT alike, while
`details` holds the sentence that names the fault. So `faultMessage()`
([http-transport.ts:600](../../src/lib/db/providers/sql/search/http-transport.ts)) prefers `details`
here and falls back to `reason`, and it strips one trailing sentence:

```json
{"error":{"reason":"Error occurred in OpenSearch engine: no such index [nope_missing]",
          "details":"[nope_missing] IndexNotFoundException[no such index [nope_missing]]\nFor more details, please send request for Json format to see the raw response from OpenSearch engine.",
          "type":"IndexNotFoundException"},
 "status":404}
```

That footer instructs the reader to re-send the request in another format to see the raw engine
response — advice about this product's REST API, not about the statement the user just wrote — so it is
removed ([`OPENSEARCH_DETAILS_FOOTER`, http-transport.ts:246](../../src/lib/db/providers/sql/search/http-transport.ts)).
Everything else is carried through **verbatim**, because the engine's own wording is the only text that
tells a user which part of their statement is wrong.

### 3.7 A string-valued `error` means the request never reached the SQL engine

Measured: `POST /_sql?format=json` (the upstream path) against OpenSearch answers HTTP **405** with

```json
{"error":"Incorrect HTTP method for uri [/_sql?format=json] and method [POST], allowed: [GET]","status":405}
```

and a POST with no `content-type` answers HTTP 406. Both spell `error` as a **string** where a real
engine failure spells it as an **object**, which makes the JSON type of one field a reliable "this is
not that product / the SQL plugin is not there" discriminator. It becomes the `unreachable` category,
which the provider maps to `ConnectionError` — so a mis-picked type-id fails at the connection form
rather than later on a query.

`auth` is the one category decided on the **status** (401/403). The probe cluster runs with the
security plugin disabled and a bogus `Basic` header is *ignored* there (HTTP 200, measured), so no
401/403 body could be captured — and rather than invent one, the code uses the one signal whose
meaning HTTP itself fixes
([http-transport.ts:64-68](../../src/lib/db/providers/sql/search/http-transport.ts)).

### 3.8 The deadline is the client's, and only the client's

`deadline()` ([index.ts:609](../../src/lib/db/providers/sql/search/index.ts)) is one
`AbortSignal.timeout(this.queryTimeout)` **per operation**, not per request — the monitoring reads
below fan out several requests for one panel, and a panel that renders half its numbers after a stall
is not a better answer than one that reports the stall.

Aborting closes this client's socket and nothing else: **no cancellation request is sent**, because the
SQL endpoint offers none for a running statement. So the cluster finishes the statement it was given,
which is what the `cancelled` message must not pretend otherwise about, and why `cancelQuery` is
deliberately not implemented.

`AbortSignal.timeout` is used rather than a plain controller because its reason is a `TimeoutError`,
which is the one signal that tells a deadline apart from a user's cancellation — measured on Node 24
and Bun, the thrown value cannot: `controller.abort(new Error("x"))` throws that Error verbatim, with
nothing abort-shaped about it. `requestFailure()`
([http-transport.ts:707](../../src/lib/db/providers/sql/search/http-transport.ts)) therefore consults
`signal.aborted` **before** the thrown value.

### 3.9 Columns are labelled with mapping types, not SQL types

Measured: `SELECT customer, total FROM probe_orders` declares `keyword` and `double` — not `VARCHAR`
and `DOUBLE`. That is the vocabulary a user wrote in their own index mapping, and it is the **same**
vocabulary `mapping()` reports, which keeps the result grid and the schema tree speaking one language
([transport.ts:92-104](../../src/lib/db/providers/sql/search/transport.ts)). A column whose declaration
carried no type name is **left out** of `columnTypes` rather than given a placeholder.

### 3.10 No EXPLAIN: the statement form is refused

`supportsExplain: false` and no `explainFormat` is declared, which is what hides the button and the
tab; `src/lib/explain/` is untouched.

Measured: `EXPLAIN SELECT customer FROM probe_orders` sent to the SQL endpoint is HTTP 400,
`SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE, SHOW or DESCRIBE" — the
statement form does not exist in this grammar. A plan **does** exist behind a separate endpoint,
`POST /_plugins/_sql/_explain`, which answers a tree (`ProjectOperator` over `OpenSearchIndexScan`,
measured), and upstream answers a statement-form `EXPLAIN` with plan **text** instead. Two different
shapes behind two different mechanisms, one of them not part of this seam at all, so neither type-id
declares the capability: a tab that works on one of two products behind one code path is worse than no
tab. Widening the seam by one call is the concrete follow-up
([§13](#13-known-limitations--future-work)).

### 3.11 Positional parameters are refused, not emulated

The endpoint really does bind them — measured,
`{"query":"… WHERE id = ?","parameters":[{"type":"integer","value":"1"}]}` answers HTTP 200 — but
upstream spells the same request differently (a bare `params` array), the seam carries the **statement
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
([`db-ui-config.ts:162`](../../src/lib/db-ui-config.ts)): `host`, `port`, `user`, `password`.

| Field | Required | Notes |
|---|---|---|
| `host` | **Yes** | `validate()` ([index.ts:529](../../src/lib/db/providers/sql/search/index.ts)) throws `DatabaseConfigError` — "OpenSearch requires a host" |
| `port` | No | Defaults to `9200` ([index.ts:151](../../src/lib/db/providers/sql/search/index.ts)); the fork kept the upstream port. The container fixture publishes **9201** on the host, which is a collision on that machine rather than a fact about the product |
| `user` / `password` | No | Sent as HTTP Basic **only when `user` is set**, for the security plugin. Measured with the plugin disabled: a bogus `Basic` header is *ignored* (HTTP 200), so credentials are genuinely optional. Note that a **default** distribution enables the plugin, serves HTTPS with a self-signed certificate and requires an admin password — see [§4.3](#43-tls) |
| `ssl` | No | Any mode but `disable` switches the transport to `https` ([§4.3](#43-tls)) |
| `database` | — | **Not offered, and ignored if set** — see below |

**There is no `database` field, and that is not an omission.** An index has no namespace above it, and
this product's own SQL says so: `SHOW TABLES LIKE %` answers `TABLE_CAT` `docker-cluster` with
`TABLE_SCHEM` **null** (measured). So a database selector would be a control with no effect, and worse,
one implying a scoping decision the user does not have. The monitoring rows carry an **empty** schema
name for the same reason ([index.ts:167](../../src/lib/db/providers/sql/search/index.ts)), which
renders as no prefix at all — and doubles as the only value the schema filter can match, so a caller
asking for `public` gets no rows rather than every row.

```ts
const connection = {
  id: 'os-1',
  name: 'OpenSearch',
  type: 'opensearch',
  host: '127.0.0.1',
  port: 9201,           // the fixture's host port; a real node is on 9200
  createdAt: new Date(),
};
```

### 4.2 There is no connection string, and that is deliberate

`supportsConnectionString` is `false` and `showConnectionStringToggle` is `false`, so the form has no
paste tab. Two independent reasons, the same pair Druid records: there is **no URI convention** for
this HTTP surface (the official client takes a `node` URL, which is not a credential-carrying DSN the
shared parser could round-trip), and **`http://` / `https://` are already claimed by ClickHouse** in
[`connection-string-parser.ts`](../../src/lib/connection-string-parser.ts) (#264).

`connection-string-parser.ts` is therefore **not touched** by this provider. The consequence is
recorded rather than hidden — pasting `http://localhost:9201` selects ClickHouse — and the
connection-form hook's unparseable-string message deliberately omits both search ids
([`use-connection-form.ts:376`](../../src/hooks/use-connection-form.ts)).

### 4.3 TLS

`config.ssl` with any `mode` but `disable` switches the transport from `http` to `https`
([http-transport.ts:819](../../src/lib/db/providers/sql/search/http-transport.ts)). `ssl` is a
first-class `DatabaseConnection` field and independent of the form's `connectionFields`, so it applies
even though this form shows no TLS row of its own, and an explicit `disable` turns TLS **off** as
firmly as an explicit mode turns it on (the #264 lesson).

**The port is not changed by TLS**: this product serves HTTPS on the same `9200`, so there is no
second well-known number to fall back to, and inventing one would send credentials to a port nothing is
listening on.

`ssl.caCert`, `ssl.clientCert` and `ssl.rejectUnauthorized` are **not honoured** — global `fetch`
cannot carry a custom CA or relax verification without an undici `Agent` as its `dispatcher`, and
undici is not a dependency. **This bites harder here than on most providers**: a stock distribution with
the security plugin enabled serves HTTPS with a **self-signed** certificate, which fails verification.
Such a cluster needs a publicly-trusted certificate, a terminating proxy, or the plugin disabled — which
is what the container fixture does (`DISABLE_SECURITY_PLUGIN: "true"`), and note that is the fork's own
switch, not the upstream key: the plugin is *installed* rather than a licensed feature, so it is
disabled by name.

An IPv6 literal host is bracketed before it becomes a URL authority
([http-transport.ts:431](../../src/lib/db/providers/sql/search/http-transport.ts)).

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?)` ([index.ts:625](../../src/lib/db/providers/sql/search/index.ts)) sends one
statement under the client deadline from [§3.8](#38-the-deadline-is-the-clients-and-only-the-clients):

```ts
await provider.query('SELECT customer, total FROM probe_orders LIMIT 50');
await provider.query('SELECT customer FROM probe_orders LIMIT 2 OFFSET 1');   // accepted here
```

A **write is not special-cased**: this grammar names everything it *would* have accepted in its own
error message, which is more useful than anything substituted here
([§5.6](#56-this-grammar-has-delete-and-it-is-off)).

### 5.2 Result shaping

`toQueryResult()` ([index.ts:275](../../src/lib/db/providers/sql/search/index.ts)):

| Source | `QueryResult` field | Notes |
|---|---|---|
| `datarows` | `rows` | Rebuilt from the positional arrays, keyed by the declared names |
| `schema[].alias ?? schema[].name` | `fields` | Declared order; the **alias wins** ([§3.4](#34-the-success-envelope-schemadatarows-a-separate-alias-and-a-count)) |
| — | `rowCount` | `rows.length`. There is no second number: no statement here reaches a document, so a mutation count could only ever be zero |
| the measured exchange | `executionTime` | Rounded milliseconds, **measured by this process**. Neither the body nor the headers carry any timing |
| `schema[].type` | `columnTypes` | The engine's **mapping** types; **absent** when the answer declared none ([§3.9](#39-columns-are-labelled-with-mapping-types-not-sql-types)) |
| `total` | — | **Deliberately dropped.** See below |
| — | `warnings` | None are produced |

**`totalHits` is available here and is deliberately unused.** The upstream product reports no
matching-document count at all, so a "showing 50 of 4,812" notice would appear on one product and never
on the other for identical statements — and it would restate what the route's own pagination already
tells the UI (`hasMore`, `limit`, `offset`). A caveat attached to every ordinary query is the fastest
way to train a user to ignore the ones that matter, which is the argument [druid.md](./druid.md) makes
about its own warnings. The count is dropped knowingly; `docs/BACKLOG.md` is where it belongs if a
surface for it ever exists ([index.ts:260-269](../../src/lib/db/providers/sql/search/index.ts)).

### 5.3 A container field comes back as its sub-document

Measured, and a real divergence from upstream: `SELECT * FROM probe_shapes` here answers HTTP 200 with
the container fields **and their values** —

```json
{"schema":[{"name":"items","type":"nested"},{"name":"note","type":"text"},{"name":"address","type":"object"}],
 "datarows":[[[{"sku":"A1"}],"hello there",{"city":"Ankara"}]]}
```

— while the same statement upstream expands to the **leaves only**, silently dropping every container:
measured on the same mapping, Elasticsearch answers
`{"columns":[{"name":"address.city","type":"keyword"},{"name":"note","type":"text"}], …}`, and a
container named **explicitly** there is a hard `verification_exception` ("Cannot use field [address]
type [object] only its subfields"). On an index whose mapping is *only* container and unsupported types
that expansion leaves nothing at all — `{"columns":[],"rows":[[]]}`, which is one of the two reasons
the schema never comes from a statement
([introspect.ts:9-16](../../src/lib/db/providers/sql/search/introspect.ts)).

This provider does **not** exploit the permissiveness: containers are excluded from the schema tree on
both products, because a starter query that works on one and fails on the other is worse than one that
works on both ([§6](#6-schema-introspection)). A statement the user types themselves is of course still served
exactly as this engine serves it — an object cell simply arrives as a JSON object in the grid, with the
mapping type (`object`, `nested`) as its label.

No value rewriting happens anywhere in this provider.

### 5.4 Dialect traps a user will hit

These are OpenSearch's, not the provider's. All were measured on 3.8.0, and **most of them are the
mirror image of the upstream product's** — which is exactly why the two docs are separate.

**Double quotes are a STRING LITERAL, not an identifier quote, and that is the dangerous one.**
Measured:

```
SELECT customer FROM "probe_orders"
-> 404  IndexNotFoundException  'no such index ["probe_orders"]'      (quotes and all)

SELECT "customer" FROM probe_orders
-> 200  {"schema":[{"name":"\"customer\"","type":"keyword"}],"datarows":[["customer"]]}
```

The second is worse than an error: it returns the **literal string** `customer` for every row, and a
predicate written that way (`WHERE "customer" = 'acme'`) compares two literals and answers 0 rows with
no failure at all. Backticks are the identifier form here — `` SELECT customer FROM `probe_orders` ``
is HTTP 200 — which is why `opensearch` shares MySQL's branch in
[`src/lib/sql/identifier.ts:36`](../../src/lib/sql/identifier.ts) while `elasticsearch` sits in the
double-quote default (it answers a backtick with *"backquoted identifiers not supported; please use
double quotes instead"*). The two search ids genuinely cannot share a quoting branch.

**`[…]` is also an identifier quote**, MySQL/SQL-Server style: `SELECT [customer] FROM probe_orders`
answers the field's value, while `SELECT [1, 2]` is refused with "All items between Brackets should be
identifiers, got:LITERAL_INT". So `OPENSEARCH_GRAMMAR.bracket` is `"quoted-identifier"`
([`grammar.ts:199`](../../src/lib/sql/grammar.ts)) — where `elasticsearch` leaves it at the default,
because `[` has no meaning in that grammar at all.

**`#` really is a line comment**, and this is where the fork's SQL plugin parts company with upstream.
Three probes, because "the statement still ran" is not enough to tell a comment from an ignored token:

```
SELECT 1 AS a # , 2 AS b            -> 200, ONE column: the rest was hidden
SELECT 1 AS a # hidden\n, 2 AS b    -> 200, TWO columns: the run ended at the newline
SELECT customer # FROM probe_orders -> SemanticCheckException: the FROM was hidden
```

So `hash: "comment"` here and `"code"` upstream. This matters beyond cosmetics: since #297 the
confirmation gate reads a statement's spans to decide whether a write is hiding behind a comment, and
an unreadable span is a **prompt** rather than silence.

**A trailing semicolon is accepted.** `SELECT 1;` is HTTP 200 here and a `parsing_exception` upstream —
so the generated statement (`SELECT * FROM probe_orders LIMIT 50;`) ran on this product and failed on
the other ([elasticsearch.md §5.4](./elasticsearch.md#54-dialect-traps-a-user-will-hit)). This product
nevertheless declares `statementTerminator: "none"` along with the upstream one, because the absence of
the terminator is accepted **here too** (measured) and one answer that runs on both beats a branch on
`dialect` — the same rule that keeps `getCapabilities()` a single answer for both type-ids.

**String literals accept BOTH escape forms.** Measured: `SELECT 'a''b'` → `a'b`, so doubling works;
`SELECT 'a\'b'` → `a'b` too, so a backslash escapes the quote; `SELECT 'a\\b'` → one backslash, so it
escapes itself; and `SELECT 'a\'` is a `ParserException`, because the trailing backslash escaped the
closing quote and left the literal open — which is exactly the defect #290 is about. Hence
`opensearch: "double-and-backslash"` in [`src/lib/sql/values.ts:55`](../../src/lib/sql/values.ts),
where `elasticsearch` is `"standard"` (a backslash there is data).

**`_id` is selectable here.** `SELECT _id FROM probe_orders` returns the document id; upstream answers
"Unknown column [_id]". It is still not reported as a column or as a key, because it is metadata rather
than a mapped field and because the same statement is not portable to the sibling type-id
([§6](#6-schema-introspection)).

**Block comments do not nest**, same as upstream: `SELECT /* a /* b */ 1 AS a` is HTTP 200, so the
first `*/` closed the run.

### 5.5 `OFFSET` works here, which is why paging does

Measured: `SELECT customer FROM probe_orders LIMIT 2 OFFSET 1` is HTTP 200 with the rows the offset
asks for. Upstream refuses it outright (`parsing_exception`, "mismatched input 'OFFSET' expecting
<EOF>"), and that single fact is **the one behavioural difference above the wire** between the two
type-ids.

It is declared as a trait, `acceptsOffsetClause: true`
([index.ts:239-243](../../src/lib/db/providers/sql/search/index.ts)), and read by `prepareQuery()`
alone ([index.ts:505](../../src/lib/db/providers/sql/search/index.ts)) — which therefore **never
refuses anything on this product** and returns exactly what the inherited limiter produced. A method
that asked `this.dialect === "opensearch"` would be the thing both the seam's rule and `CLAUDE.md`
exist to prevent; a method that reads `this.product.acceptsOffsetClause` states which capability it
depends on, and a third product declares its own answer instead of being added to a condition someone
has to find.

The practical consequence: **the editor's "load more" works on an OpenSearch connection and is refused
on an Elasticsearch one.** Same provider code, same UI, one measured grammar difference.

### 5.6 This grammar has `DELETE`, and it is off

Measured on a stock 3.8.0 node, every mutation is HTTP 400 with
`SQLFeatureNotSupportedException`, "Query must start with SELECT, DELETE, SHOW or DESCRIBE: …":

| statement | note |
|---|---|
| `INSERT INTO probe_orders …` | not in the grammar |
| `UPDATE probe_orders SET customer = 'x' WHERE id = 1` | not in the grammar |
| `CREATE TABLE t (id BIGINT)` | not in the grammar |
| `ALTER TABLE probe_orders ADD COLUMN x INT` | not in the grammar |
| `DELETE FROM probe_orders WHERE id = 99` | **is** in the grammar — the error names it — and is refused because the plugin's DELETE support is **off by default** |

The error message is the same for all five, which is worth knowing: it enumerates what the grammar
accepts, so "DELETE" appearing in a message about a refused DELETE is the plugin telling you the
statement form exists and the setting does not permit it.

Consequences elsewhere in the product:

- `supportsCreateTable: false` and `supportsInlineRowEdit: false` are facts about the grammar, not
  unimplemented features, so the EDIT toggle and the editable cell are not offered (#269).
- The schema-diff migration generator emits, in place of a column change: *"OpenSearch SQL reads only;
  change a field by reindexing into an index whose mapping declares it."*
  ([`migration-generator.ts:85`](../../src/lib/schema-diff/migration-generator.ts)). It says *reindex*
  rather than "use the mapping API" because an existing field's type cannot be changed in place at all,
  even outside SQL.
- `schemaRefreshPattern` is `\b(DELETE)\b`
  ([index.ts:193](../../src/lib/db/providers/sql/search/index.ts)) and **this is the product it exists
  for**: a cluster that switches DELETE on really does change the per-index document counts this
  provider reports, so a statement matching it refreshes the schema. Upstream has no DELETE in its
  grammar at all, so there the pattern never fires — exactly as Druid's `INSERT|REPLACE` never fires
  against its native engine.

Documents otherwise change through the document APIs (`_doc`, `_bulk`, `_delete_by_query`), which this
seam does not expose.

---

## 6. Schema introspection

`getSchema()` ([introspect.ts:355](../../src/lib/db/providers/sql/search/introspect.ts)) makes one
index listing plus **one mapping read per index**, at most
`SEARCH_MAPPING_CONCURRENCY = 4` at a time
([introspect.ts:102](../../src/lib/db/providers/sql/search/introspect.ts)) — the number Couchbase's
per-collection inference settled on for the same trade-off, and `_mapping` is a cluster-state read
rather than a search.

| Data | Source |
|---|---|
| Indices (the "tables") | `GET /_cat/indices?format=json&bytes=b` |
| Columns | `GET /<index>/_mapping`, flattened to dotted paths |
| `rowCount` / `size` | `docs.count` / `pri.store.size` from the same listing, **omitted** when the server reported none |
| Indexes | always `[]` |
| Foreign keys | always `[]` |

**The schema comes from the MAPPING, not from SQL.** Two independent reasons, and the second is
specific to this product: `SELECT *` describes the *statement* rather than the index, and the two
products do not even agree on what it describes — measured, `SELECT *` here returns the container
fields with their sub-documents while upstream expands the same mapping to its leaves only, and can
answer with no columns at all when a mapping has nothing but containers and unsupported types
([§5.3](#53-a-container-field-comes-back-as-its-sub-document)). A tree built on that
would differ per product for the same index. The mapping is the index's own declaration, is readable on
a closed index, and is the document the user edits.

**System indices are the thing to know about this product.** Measured on a stock 3.8.0 cluster with two
probe indices created by hand, `_cat/indices` listed **four**:

```
.plugins-ml-config              (engine bookkeeping, dot-prefixed)
probe_orders                    (the user's)
probe_shapes                    (the user's)
top_queries-2026.08.18-74305    (engine bookkeeping, NO leading dot)
```

On an *empty* cluster two of three indices are the engine's. The dot convention catches the first and
**not** the second, so the transport carries a second rule for the date-suffixed query-insights shape
(`/^top_queries-\d{4}\.\d{2}\.\d{2}-\d+$/`,
[http-transport.ts:264](../../src/lib/db/providers/sql/search/http-transport.ts)) — which makes this a
judgement rather than a rule, and is why the seam exposes a **flag** the provider decides about
(`isSystemIndex()`, [introspect.ts:156](../../src/lib/db/providers/sql/search/introspect.ts)) rather
than a filter applied on the wire. Hiding them is the default; `SearchSchemaOptions.includeSystemIndices`
exists because both answers are legitimate and the caller knows which — an operator debugging ML
inference wants `.plugins-ml-config` in the tree, and a developer writing a query does not want two
thirds of the sidebar to be indices they have never heard of.

Note also that `top_queries-2026.08.18-74305` carries hyphens and dots, so it is a name SQL needs
quoted. `TableSchema.name` is the index name **verbatim** — quoting belongs to whoever builds a
statement, not to the inventory ([introspect.ts:324-336](../../src/lib/db/providers/sql/search/introspect.ts)) —
and on this product the quote character is a **backtick** ([§5.4](#54-dialect-traps-a-user-will-hit)).

**The flattening.** `flattenProperties()`
([http-transport.ts:776](../../src/lib/db/providers/sql/search/http-transport.ts)) descends both
`properties` (objects) and `fields` (multi-fields), emitting containers, leaves and dotted children:
for `probe_shapes` that is `address`/object, `address.city`/keyword, `items`/nested, `items.sku`/keyword,
`note`/text, `note.keyword`/keyword. The output set is specified by the upstream product's own
`DESCRIBE` (measured, [elasticsearch.md §6](./elasticsearch.md#6-schema-introspection)), because that
is the stricter of the two surfaces and a column list valid there is valid here. Nothing outside
`properties` is read — measured, this product's own `.plugins-ml-config` mapping carries a sibling
`_meta` object at the same level, which is metadata about the mapping rather than a field in it.

**Containers are not columns; a multi-field parent is.** `SEARCH_CONTAINER_TYPES = ["object",
"nested"]` ([introspect.ts:90](../../src/lib/db/providers/sql/search/introspect.ts)) are dropped, and
this is the one place the provider is deliberately **stricter than this engine allows**: upstream
refuses `SELECT address` outright, this product answers it with the sub-document, and
`query-generators.ts` builds its starter query by enumerating every declared column. Projecting the
leaves works on both; listing the container would hand an Elasticsearch user a query that cannot run at
all. A `text` field with a `keyword` sub-field is **kept** as a column, because its own type is not a
container type and both `note` and `note.keyword` are separately queryable.

**Every column is nullable and none is primary**
([introspect.ts:195](../../src/lib/db/providers/sql/search/introspect.ts)):

- `nullable: true` is a measurement. A mapping declares how a field is indexed *if* a document carries
  it; there is no `NOT NULL` in the model, and a document indexed without a field comes back as `null`.
- `isPrimary: false` always. Nothing a mapping declares is unique — indexing the same body twice
  yields two documents — and the only unique thing in an index is `_id`, which is metadata rather than
  a mapped field. **This product does expose `_id` in SQL** while upstream does not, so treating it as
  a key here would also make the two type-ids disagree about the same index. And `isPrimary` is stated
  as *fact* wherever it is read: `sql-completions.ts` appends "(PK)", the agent's schema context puts
  " PK" into what a model reasons from, and `schema-diff` reports "Primary key changed" — a key
  invented here becomes a key the product asserts. `ColumnSchema` has no "document identity" field, and
  inventing one out of `isPrimary` would be a different concept wearing its name.
- `defaultValue` is left undefined. A mapping's `null_value` is not a default: it is the term
  substituted into the *index* for an explicit null so the value becomes searchable, and it changes no
  value any document carries.

**Column order is sorted by path**, by code unit, not by the server's order and not by locale
([introspect.ts:244](../../src/lib/db/providers/sql/search/introspect.ts)): a mapping has no
declaration order to preserve, because documents are unordered JSON. Sorting by path also keeps
`address.city` and `items.sku` next to their siblings once the containers are dropped.

**A closed index is kept, and reads honestly**: its `_cat` row reports the status word **`close`** (not
"closed") with `docs.count` and `pri.store.size` as JSON `null`, while `_mapping` still answers in
full. So it is described completely with `rowCount` and `size` **omitted** rather than zeroed —
`TableSchema` makes both optional, which is what preserves the distinction.

**A per-index failure costs one index's columns, not the tree.** Only `auth` and `unknown-object`
degrade to an empty column list
([`DEGRADABLE_MAPPING_FAILURES`, introspect.ts:119](../../src/lib/db/providers/sql/search/introspect.ts)):
the security plugin grants index privileges *per index*, so a role that lists twenty indices and may
describe nineteen is an ordinary configuration; and an index deleted between the listing and its
mapping read is a race, not a fault. **This is where the two fault vocabularies matter most**: a
missing index reported by `_mapping` is snake_case `index_not_found_exception` while the SQL endpoint
says `IndexNotFoundException`, and both are in the fault table
([http-transport.ts:395-401](../../src/lib/db/providers/sql/search/http-transport.ts)). A live probe of
`mapping()` is what caught that — the SQL fixtures alone would have left a missing index reported as an
engine fault by introspection, i.e. propagating and blanking the whole tree instead of degrading one
index.

`getSchemaList()` and `getSchemaRelations()` are deliberately **not implemented**: both are optional
and the client falls back to `getSchema()`; here both halves are empty by construction, so a list would
be byte-identical and a relations pass would re-read every mapping to return the same empty arrays.

---

## 7. Monitoring & health

Every read goes through `guarded()`
([index.ts:694](../../src/lib/db/providers/sql/search/index.ts)), which maps a seam failure onto this
repo's error classes ([§10](#10-error-handling)). The only read allowed to fail quietly is the
cluster-wide store size ([§7.1](#71-the-one-swallowed-failure)).

| Method | Source | Mapping |
|---|---|---|
| `getOverview()` ([index.ts:751](../../src/lib/db/providers/sql/search/index.ts)) | `/`, `_cluster/health`, `_cat/indices` — **three seam calls in parallel** | `version` = `"OpenSearch <number>"`; `uptime` = **`"N/A"`**; `activeConnections` / `maxConnections` = **0**; `databaseSize(Bytes)` = the cluster's store from `_cluster/stats`; `tableCount` = **user** indices only; `indexCount` = **0** |
| `getPerformanceMetrics()` ([index.ts:811](../../src/lib/db/providers/sql/search/index.ts)) | — | **`{}`**, and it asks the cluster nothing |
| `getSlowQueries()` ([index.ts:831](../../src/lib/db/providers/sql/search/index.ts)) | — | **`[]`** — and on this product that is a *choice*, not an absence. See below |
| `getIndexStats()` ([index.ts:844](../../src/lib/db/providers/sql/search/index.ts)) | — | **`[]`**. No secondary-index object exists |
| `getActiveSessions()` ([index.ts:860](../../src/lib/db/providers/sql/search/index.ts)) | — | **`[]`**. A request is one HTTP request; there is no session and no connection catalog |
| `getTableStats()` ([index.ts:873](../../src/lib/db/providers/sql/search/index.ts)) | `_cat/indices` | one row per **user** index: `rowCount` = `docs.count`, `tableSize(Bytes)` = `totalSize(Bytes)` = `pri.store.size`, `schemaName` = `""` |
| `getStorageStats()` ([index.ts:884](../../src/lib/db/providers/sql/search/index.ts)) | `_cluster/health` + `_cluster/stats` | **one row for the cluster**: `name` = `cluster_name`, `sizeBytes` = `indices.store.size_in_bytes`. **No row at all** when the size was unreported |
| `getHealth()` ([index.ts:898](../../src/lib/db/providers/sql/search/index.ts)) | the above, composed | `activeConnections`, `databaseSize`; `cacheHitRatio` = the repo's word for "not measured"; `slowQueries` = `[]`; `activeSessions` = `[]` |

**The slow-query panel is empty even though this product keeps top-N queries.** That is the sharpest
"deliberately unused" decision in the provider: a stock 3.8.0 node ships a `top_queries-<date>` index —
this provider *hides* it as engine bookkeeping ([§6](#6-schema-introspection)) — while upstream writes
its slow log to a node **log file** that no API returns. Reading it would be a monitoring surface that
exists on one of two products behind one code path, i.e. exactly the branch on product identity that
the seam and `CLAUDE.md` both forbid. **A slow-query panel populated for half the connections of one
provider type is worse than an honest empty one**
([index.ts:815-830](../../src/lib/db/providers/sql/search/index.ts)).

**Two vocabulary collisions, both counted wrong by the obvious reading:**

- **`tableCount` counts INDICES** — an index *is* the table here — and counts only the user's, matching
  what the schema tree shows by default. On the measured cluster that is 2 of 4; counting everything
  would report a cluster holding data nobody put there.
- **`indexCount` is 0 and stays 0.** There is no secondary-index *object*: every mapped field is
  inverted-indexed as a property of being mapped. The schema tree says the same from the other side
  with `indexes: []`.

**`databaseSizeBytes` is the CLUSTER's store including replicas**, while the per-index sizes are
**primaries only** (`pri.store.size`, chosen deliberately at
[http-transport.ts:161](../../src/lib/db/providers/sql/search/http-transport.ts)), so they do not sum to
it — and `_cluster/stats` is the one place in this transport where a count arrives as a real JSON
**number** (`indices.store.size_in_bytes`, measured unquoted on both products) rather than a quoted
string.

The honest empties, each with its reason:

- **`getPerformanceMetrics()` returns `{}`, not zeroes**, and this is load-bearing. `cacheHitRatio` is
  scored `direction: "below"` with `critical: 80` by `DEFAULT_THRESHOLDS`, so a "neutral" 0 would paint
  a red critical cache fault on every healthy cluster; the monitoring tabs default an **absent** ratio
  to a healthy 100 instead. Every other metric would read as a measurement of zero. The numbers exist
  on this product's stats endpoints, so this is a recorded gap rather than an impossibility.
- **`getSlowQueries()` and `getActiveSessions()` return `[]` rather than throwing.** Nothing is broken
  and nothing is misconfigured, so a monitoring tab should render as quiet, not as failed. Only
  `runMaintenance()` throws, because that one is a *request to act*.
- **`activeConnections` / `maxConnections` are 0**, the same "not published" encoding `mssql.ts` and
  Druid use. The cluster counts open HTTP connections per node in its stats API, which is not one of
  this seam's five calls, and the shard and node counts that *are* here would be a different number
  wearing this field's name.
- **`uptime` is `"N/A"`.** No call in this seam carries one; a `"0s"` would claim the cluster booted
  this instant.

**A closed index reads as zero in `getTableStats()` and is omitted in the schema tree.**
`TableStats.rowCount` and the size fields are *required* numbers with no way to say "unknown", while
`TableSchema.rowCount` and `size` are optional, so the tree is the surface that keeps the distinction
([index.ts:310-316](../../src/lib/db/providers/sql/search/index.ts)).

**Document counts exceed what a `SELECT` returns when a mapping has `nested` fields**, and this was
measured here: `probe_shapes` reports **2** documents in `_cat/indices` while `SELECT COUNT(*)` answers
**1**, because every nested element is stored as a document of its own. The panel reports the cluster's
document count — which is what a "row" is on this surface — not the number of rows a query produces, so
an index with nested fields always reads higher here than in the editor. Deriving it from SQL instead
would mean a statement per index, on a surface whose grammar the tree must not depend on, to answer a
different question than the panel asks.

### 7.1 The one swallowed failure

`_cluster/stats` is heavier and more privileged than `_cluster/health`, so a cluster that answers
health and refuses stats is an ordinary configuration. `storeSizeBytes()`
([http-transport.ts:973](../../src/lib/db/providers/sql/search/http-transport.ts)) therefore catches
its own failure and returns `null` — the seam's "unknown" — because losing the health status over a
missing byte count would blank a panel that already had the important number. Its null then propagates
honestly: `getOverview()` shows `"N/A"` for the size, and `getStorageStats()` returns **no row at all**
rather than a row claiming the cluster stores zero bytes.

---

## 8. Maintenance

**There is none.** `supportsMaintenance` is `false` and `maintenanceOperations` is `[]`, so no
maintenance control renders for this connection: `TablesTab.tsx` reads the connected provider's
capabilities (#272) and `OperationsTab.tsx` hides the whole Global Operations group where
`supportsMaintenance` is false (#282).

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

> OpenSearch has no SQL-reachable maintenance operation, so "\<type\>" cannot run here. Refreshing,
> merging segments and clearing caches are index APIs on the cluster rather than statements, and a
> running search cannot be cancelled through this surface.

Throwing rather than reporting a cheerful success is the point — a caller that asked for work must not
be told work happened.

---

## 9. Capabilities & labels

### `getCapabilities()` ([index.ts:388](../../src/lib/db/providers/sql/search/index.ts))

One answer for both products, because every flag here measured the same on both. The single
difference — `OFFSET` — has no field in `ProviderCapabilities` to declare it in, so it lives on
`SearchProduct` and is read by `prepareQuery()` alone
([§5.5](#55-offset-works-here-which-is-why-paging-does)).

| Capability | Value | Why |
|---|---|---|
| `queryLanguage` | `sql` | The bundled SQL plugin, present on a stock node ([§3.3](#33-sql-because-there-is-no-esql-here)) |
| `supportsExplain` | **`false`** | The statement form is refused here and the plan lives behind a second endpoint outside this seam ([§3.10](#310-no-explain-the-statement-form-is-refused)) |
| `supportsExternalQueryLimiting` | `true` | **Both** limiter forms are correct here, `LIMIT n` and `LIMIT n OFFSET m` |
| `supportsCreateTable` | **`false`** | Not in the grammar ([§5.6](#56-this-grammar-has-delete-and-it-is-off)) |
| `supportsInlineRowEdit` | **`false`** | `UPDATE` is not in the grammar, so the editor's statement could only ever produce an error (#269) |
| `declaresForeignKeys` | **`false`** | The engine has no such constraint in its model, so the empty `foreignKeys` means "impossible here" rather than "none declared, or none visible to this role" — the distinction #414 was about |
| `supportsMaintenance` | **`false`** | Nothing in `MaintenanceType` is SQL-reachable ([§8](#8-maintenance)) |
| `maintenanceOperations` | `[]` | Consequence of the above |
| `supportsConnectionString` | **`false`** | No URI convention, and `http(s)://` is ClickHouse's ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)) |
| `defaultPort` | `9200` | Both schemes; the fixture publishes 9201 on the host ([§4.1](#41-configuration-fields)) |
| `identifierQuoting` | **`backtick`** | The difference that fails silently: a double-quoted name here is a string literal, so a generated `WHERE "customer" = 'acme'` answers HTTP 200 with no rows ([§5.4](#54-dialect-traps-a-user-will-hit)) |
| `statementTerminator` | **`none`** | Declared even though this product accepts `;`: the absence runs here too, and the upstream grammar has no terminator at all, so one answer serves both ([§5.4](#54-dialect-traps-a-user-will-hit)) |
| `schemaRefreshPattern` | `\b(DELETE)\b` | **This is the product it exists for**: a cluster with DELETE enabled really changes the counts this provider reports ([§5.6](#56-this-grammar-has-delete-and-it-is-off)) |

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
| `statementLanguage` | `OpenSearch SQL, the SQL plugin's own dialect - NOT the JSON query DSL, NOT an aggregation body, and NOT PPL` |

`statementLanguage` is the one label written for a **model** rather than for the UI, and this product's
spelling differs from the upstream one because its alternatives do: the SQL plugin ships **PPL** beside
SQL, and ES|QL does not exist here. The run that made the field necessary was on *this* product — a
plan run answered with a native aggregation body, correct for the cluster and unrunnable through the
SQL endpoint (measured in the browser, 2026-08-19). See
[elasticsearch.md §9](./elasticsearch.md#9-capabilities--labels) for the mechanism, which is shared.

These are not decoration. `inventory-noun.ts` lowercases `entityName` into the noun the **agent**
reasons with, so a cluster described as holding "tables" of "rows" invites statements written for a
relational engine. "Indices" rather than "Indexes" because that is the plural this product's own API and
documentation use — and because "indexes" is the word this codebase already uses for the
secondary-index objects an index does **not** have (`TableSchema.indexes`, empty by construction here).

The two maintenance actions are named even though `supportsMaintenance` is false, because they are
still rendered **where an engine has maintenance to run**, and their global descriptions say in words
that nothing runs from here. They are no longer offered in this engine's schema tree: that was a dead
end into a page whose maintenance card is gated on the same capability, and
[`TableItem.tsx`](../../src/components/schema-explorer/TableItem.tsx) now requires both an addressable
row and a declared capability. See
[elasticsearch.md §9](./elasticsearch.md#9-capabilities--labels) for the measurement.

---

## 10. Error handling

The transport normalizes every failure into
`SearchTransportError { category, message, engineType? }`
([transport.ts:153](../../src/lib/db/providers/sql/search/transport.ts)); `mapSearchError()`
([index.ts:671](../../src/lib/db/providers/sql/search/index.ts)) maps the **category** — never the HTTP
status — onto the shared classes in [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts). Every category
is listed and there is no `default`, so adding one to the seam fails the typecheck here instead of being
quietly swallowed as a query error.

| Category | Measured trigger on this product | Error raised |
|---|---|---|
| `auth` | HTTP 401/403 (status-decided; see [§3.7](#37-a-string-valued-error-means-the-request-never-reached-the-sql-engine)) | `AuthenticationError` |
| `unreachable` | A refused socket, an unresolvable host, or a **string-valued** `error` — the upstream endpoint path (HTTP 405 here), a missing content type (406) | `ConnectionError` carrying host and port |
| `timeout` | The client deadline expired (`AbortSignal.timeout`) | `TimeoutError` — and the cluster is *still working on the statement* |
| `cancelled` | The caller aborted | `QueryCancelledError` |
| `syntax` | `ParserException`, `EOFParserException` (matched by suffix), `NumberFormatException` | `QueryError` |
| `unknown-object` | `IndexNotFoundException` (SQL, 404), `index_not_found_exception` (core REST, 404), `SemanticCheckException` | `QueryError` |
| `unsupported` | `SQLFeatureNotSupportedException` — a mistyped leading keyword, every refused mutation, a statement-form `EXPLAIN` | `QueryError` |
| `engine` | `IllegalArgumentException` (duplicate output names), `NullPointerException`, any unrecognised fault name, the paging ceiling, an unreadable body | `QueryError` |

The four that collapse onto `QueryError` do so because they describe the same event to a user — the
cluster read the statement and refused it — and the engine's own wording, carried through the seam
verbatim, is what distinguishes them on screen. **`unsupported` is mapped here rather than to a
configuration error for a measured reason**: on this product it is what a *mistyped* leading keyword
answers, which is a statement problem and nothing about the deployment
([index.ts:660-666](../../src/lib/db/providers/sql/search/index.ts)).

A value that is **not** a seam error never came from the cluster (an internal defect, an assertion) and
goes to the shared message-based `mapError()`, exactly as `druid/index.ts` and `clickhouse/index.ts`
do.

The `unreachable` message quotes the cause from **both** places a runtime puts it, because this repo
runs on two: on Node a refused socket is `TypeError: fetch failed` whose `cause.code` is
`ECONNREFUSED`, while Bun throws `Error: Unable to connect. Is the computer able to access the url?`
with `code: "ConnectionRefused"` on the error **itself** and no cause at all
([http-transport.ts:677-729](../../src/lib/db/providers/sql/search/http-transport.ts)).

| Situation | Error |
|---|---|
| Missing `host` | `DatabaseConfigError` — "OpenSearch requires a host" |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails on credentials | `AuthenticationError` — a rejected credential is not a connectivity problem |
| `connect()` fails otherwise | `ConnectionError` — "Failed to connect to OpenSearch: …", carrying the cluster's own words (which for the two commonest mistakes are the useful ones: a refused socket names the code, and the wrong endpoint path is quoted verbatim) |
| `query(sql, params)` with parameters | `QueryError`, raised **before** anything leaves the process ([§3.11](#311-positional-parameters-are-refused-not-emulated)) |
| More result pages than `MAX_PAGES` | `QueryError` naming the ceiling and advising a narrower statement — after the abandoned cursor is closed ([§3.5](#35-paging-the-cursor-is-followed-never-requested)) |

---

## 11. Testing

### 11.1 How the tests work

There is **no `mock.module()` anywhere in the search suite** — it is process-wide in bun and would
poison sibling files.

- [`tests/integration/db/opensearch-provider.test.ts`](../../tests/integration/db/opensearch-provider.test.ts)
  replaces `globalThis.fetch` per test and restores it in `afterEach`, so the real transport, the real
  introspection and the real provider all run — only the cluster is fake. Every payload was captured
  from a live 3.8.0 node (`probe_orders`, `probe_shapes`), so the fake speaks exactly what the server
  speaks. **This file's job is the DIVERGENCE**: one implementation serves two type-ids, the
  Elasticsearch sibling covers what the two share, and what is asserted here is what this product does
  *differently* — the `schema`/`datarows` envelope with its `total`, the separate `alias`, the 404
  missing index, the Java-class fault names beside the one snake_case name from the core REST layer,
  the **refused** duplicate output name, the accepted `OFFSET`, and the system indices the dot rule
  alone does not catch. That is what makes "two type-ids, one implementation" a tested claim rather
  than an assumption.
- [`tests/integration/db/elasticsearch-provider.test.ts`](../../tests/integration/db/elasticsearch-provider.test.ts)
  carries the shared behaviour and the upstream-only measurements (engine-initiated paging with its
  column-less second page, the duplicate-name disambiguation, the 400/500 status inversion).
- [`tests/unit/db/search/introspect.test.ts`](../../tests/unit/db/search/introspect.test.ts) drives
  introspection through a hand-built `SearchTransport` — the payoff of the seam: no `fetch` mocking and
  no server. Its fake's `query()` **throws on purpose**, because introspection reading a statement
  would be a design regression rather than a test failure.
- [`tests/unit/db/search/seam-guard.test.ts`](../../tests/unit/db/search/seam-guard.test.ts) is a
  parser, not a grep, and proves itself in both directions: it must fire on `http-transport.ts` and
  stay silent on a compliant sample before it asserts the provider directory is clean.

### 11.2 Coverage

Validation (host required), capabilities and labels, connect/disconnect including the `SELECT 1` probe
surfacing a wrong endpoint or a rejected credential, query execution and result shaping (the alias
preference, the declared order, the measured duration, the dropped `totalHits`), the full
category-to-error map across **both** fault vocabularies, `prepareQuery()` passing an `OFFSET`
statement through untouched, mapping-driven schema (containers dropped, multi-fields dropped, closed
index, both system-index rules, the degradable per-index failures), every monitoring method and its
empties, and `runMaintenance()` refusing with its reason.

### 11.3 Run it

```bash
bun test tests/integration/db/opensearch-provider.test.ts
bun test tests/unit/db/search

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: reproducing the live pass

The committed tests never touch a cluster. To reproduce the measurements behind this document,
`database-compose.yml` carries the **exact build** this provider was verified against, and deliberately
**no profile** — unlike Druid's block — because these are shipped providers and a plain
`docker compose up` has to be able to reproduce their integration pass:

```bash
docker compose -f database-compose.yml up -d elasticsearch opensearch
```

Both services run together on purpose: every claim this document records is a claim about which of the
two answered differently, and that can only be re-measured side by side. This service publishes
**9201** on the host because both products ship on 9200 in the container.

Two configuration details are load-bearing:

- `DISABLE_SECURITY_PLUGIN: "true"` — the fork's own switch, **not** the upstream
  `xpack.security.enabled` key, because the plugin is installed rather than a licensed feature.
  Without it the node serves HTTPS with a self-signed certificate and a default admin password, which
  this provider cannot verify ([§4.3](#43-tls)).
- The health check waits for **yellow**, not green: a single node with a replica requested is yellow
  forever, so waiting for green would hang.

The image is pinned, and here the reason is sharper than usual: **the SQL plugin's fault names are Java
class names that its own releases rename**, and the whole classification table
([§3.6](#36-two-fault-vocabularies-in-one-cluster)) is keyed on them.

There is **no seed sidecar**, and one thing to expect instead: a stock node ships its own indices, so
two thirds of an empty cluster's index listing is engine bookkeeping
([§6](#6-schema-introspection)). Seed the probe indices with the document API — there is no
`CREATE TABLE` here:

```bash
curl -s -XPOST -H 'content-type: application/json' \
  'http://localhost:9201/probe_orders/_doc?refresh=true' \
  -d '{"id":1,"customer":"acme","total":9.5}'

# an object, a nested array and a multi-field: what §6's flattening and the
# nested-document-count finding are measured against
curl -s -XPUT -H 'content-type: application/json' 'http://localhost:9201/probe_shapes' \
  -d '{"mappings":{"properties":{"address":{"properties":{"city":{"type":"keyword"}}},
                                 "items":{"type":"nested","properties":{"sku":{"type":"keyword"}}},
                                 "note":{"type":"text","fields":{"keyword":{"type":"keyword"}}}}}}'
curl -s -XPOST -H 'content-type: application/json' \
  'http://localhost:9201/probe_shapes/_doc?refresh=true' \
  -d '{"address":{"city":"Ankara"},"items":[{"sku":"A1"}],"note":"hello there"}'
```

`probe_shapes` is the one that matters: one document with one nested element is what makes `_cat`
report **2** while `SELECT COUNT(*)` answers **1** ([§7](#7-monitoring--health)).

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'os1', name: 'OpenSearch', type: 'opensearch',
  host: '127.0.0.1', port: 9201,
  createdAt: new Date(),
});

await provider.connect();                              // proves the port AND the product

const rows   = await provider.query('SELECT * FROM probe_orders LIMIT 50;');   // ';' is fine here
const page2  = await provider.query('SELECT customer FROM probe_orders LIMIT 50 OFFSET 50');
const quoted = await provider.query('SELECT customer FROM `top_queries-2026.08.18-74305`');
const schema = await provider.getSchema();             // indices + mapped fields; indexes always []
const stats  = await provider.getTableStats();         // documents and primary bytes per index

await provider.disconnect();
```

The habit worth keeping is the third line: **backticks, never double quotes**. A double-quoted name is
a string literal here, and in a projection it silently returns the name itself rather than the field
([§5.4](#54-dialect-traps-a-user-will-hit)).

### 12.2 Over the API

`POST /api/db/query` with the statement in the `sql` field — the same contract every SQL provider uses.
`POST /api/db/maintenance` answers 400 before reaching the provider ([§8](#8-maintenance)). The
transaction and cancel routes do not apply: `/api/db/cancel` reports cancellation as unsupported
because the provider exposes no `cancelQuery`
([§3.8](#38-the-deadline-is-the-clients-and-only-the-clients)).

---

## 13. Known limitations & future work

- **No EXPLAIN.** `supportsExplain: false`, so the button and the tab are hidden. `EXPLAIN <select>` as
  a statement is refused here (`SQLFeatureNotSupportedException`), and the plan that *does* exist lives
  behind `POST /_plugins/_sql/_explain` — a second endpoint outside this seam, whose tree shape is not
  what upstream returns either ([§3.10](#310-no-explain-the-statement-form-is-refused)). Widening the
  seam by one call is the concrete follow-up.
- **Aliases and data streams are not listed in the schema tree.** They come from other endpoints
  (`_alias`, `_data_stream`) that this seam does not carry, so a **queryable** alias does not appear in
  the sidebar even though SQL accepts it. Recorded on the seam itself
  ([transport.ts:205-219](../../src/lib/db/providers/sql/search/transport.ts)); the mapping read
  already tolerates the case, taking the single entry of the payload rather than looking it up by the
  requested name, because an alias resolves to the concrete index behind it.
- **No maintenance operations at all** ([§8](#8-maintenance)).
- **No active sessions, and no slow queries** — the second one by choice rather than by absence: this
  product's `top_queries-<date>` index really does hold them, and reading it would populate a panel for
  one of the two type-ids behind one code path ([§7](#7-monitoring--health)).
- **An index whose mapping has `nested` fields reports more documents than a `SELECT` returns.**
  Measured here: `probe_shapes` is 2 documents in `_cat/indices` and 1 row to `SELECT COUNT(*)`
  ([§7](#7-monitoring--health)).
- **`totalHits` is reported by this product and deliberately dropped**, so no surface behaves
  differently between the two type-ids — the upstream product sends no count at all
  ([§5.2](#52-result-shaping)).
- **A trailing semicolon is accepted here and fails upstream.** Recorded because it is a portability
  trap in the other direction: a statement written against this product may not run against the
  sibling type-id, and the shared `generateTableQuery()` output is exactly such a statement
  ([§5.4](#54-dialect-traps-a-user-will-hit)).
- **A double-quoted identifier is silently wrong.** `SELECT "customer"` returns the literal string,
  and `WHERE "customer" = 'acme'` compares two literals and answers 0 rows with no error. The
  codebase's own quoter emits backticks for this dialect
  ([`identifier.ts:36`](../../src/lib/sql/identifier.ts)), but a hand-typed statement has no such
  protection ([§5.4](#54-dialect-traps-a-user-will-hit)).
- **There is a paging ceiling.** A statement whose result the engine spreads over more than
  `MAX_PAGES = 1000` pages is **refused** rather than truncated, after the cursor is closed
  ([§3.5](#35-paging-the-cursor-is-followed-never-requested)).
- **No writes reach documents**, and `DELETE` — the one mutation in this grammar — is off by default
  ([§5.6](#56-this-grammar-has-delete-and-it-is-off)). A field's type cannot be altered in place even
  outside SQL.
- **No positional parameters**, refused rather than inlined
  ([§3.11](#311-positional-parameters-are-refused-not-emulated)).
- **No `cancelQuery`.** An abort bounds this client's wait; the cluster finishes the statement
  ([§3.8](#38-the-deadline-is-the-clients-and-only-the-clients)).
- **Performance metrics are empty**, and this one *is* reachable: the numbers exist on this product's
  stats endpoints, so widening the seam by one call is the concrete follow-up
  ([§7](#7-monitoring--health)).
- **`ssl.caCert` / `ssl.clientCert` / `ssl.rejectUnauthorized` are not honoured**, which matters more
  here than for most providers because a default distribution ships a self-signed certificate
  ([§4.3](#43-tls)).
- **No connection string**, deliberately ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)).
- **A type the engine maps but its SQL surface cannot read is still listed as a column**, because the
  mapping does not say which types SQL supports, and enumerating them would be a per-version list this
  code cannot verify
  ([introspect.ts:46-52](../../src/lib/db/providers/sql/search/introspect.ts)).
- **The whole result body is buffered** before it is parsed
  ([§3.1](#31-http-only--no-driver-and-what-that-costs)).

---

## 14. References

- Source: [`src/lib/db/providers/sql/search/`](../../src/lib/db/providers/sql/search/)
- Sibling type-id (same implementation): [elasticsearch.md](./elasticsearch.md)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Connection form config: [`src/lib/db-ui-config.ts`](../../src/lib/db-ui-config.ts)
- Dialect facts elsewhere in the codebase: [`src/lib/sql/grammar.ts:199`](../../src/lib/sql/grammar.ts) (`#`, `[…]`, block comments) · [`src/lib/sql/identifier.ts:36`](../../src/lib/sql/identifier.ts) (backticks) · [`src/lib/sql/values.ts:55`](../../src/lib/sql/values.ts) (both escape forms) · [`src/lib/sql/fence-tags.ts`](../../src/lib/sql/fence-tags.ts) (the fence tag)
- Local cluster: [`database-compose.yml`](../../database-compose.yml) (`opensearch` service, host port 9201)
- Tests: [`tests/integration/db/opensearch-provider.test.ts`](../../tests/integration/db/opensearch-provider.test.ts) · [`tests/unit/db/search/`](../../tests/unit/db/search/)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Adding a provider over HTTP: [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md)
- Tracking issue: [#424 — Search providers](https://github.com/libredb/libredb-studio/issues/424)
- OpenSearch SQL plugin: <https://docs.opensearch.org/latest/search-plugins/sql/index/>
- SQL/PPL API: <https://docs.opensearch.org/latest/search-plugins/sql/sql-ppl-api/>
- Mappings: <https://docs.opensearch.org/latest/field-types/>
- `_cat/indices`: <https://docs.opensearch.org/latest/api-reference/cat/cat-indices/>
- Query insights (`top_queries`): <https://docs.opensearch.org/latest/observing-your-data/query-insights/index/>
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [MongoDB](./mongodb.md) · [Couchbase](./couchbase.md) · [ClickHouse](./clickhouse.md) · [Apache Druid](./druid.md) · [Elasticsearch](./elasticsearch.md) · [Redis](./redis.md) · [LibreDB](./libredb.md)
