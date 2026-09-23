# Prometheus Provider

> Prometheus support for LibreDB Studio, over the Prometheus HTTP API (`/api/v1/*`, port `9090`) with **no driver dependency of any kind**.
> Every call is one HTTP request through the runtime's own `fetch`, or through `node:https` when TLS material is configured.
> This is the first provider whose query language is neither SQL nor JSON: the editor sends PromQL to the server unchanged.
> This document is the single reference for the Prometheus provider: design, architecture, usage and tests.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `prometheus` |
| **Family** | Time series (`src/lib/db/providers/timeseries/prometheus/`), the first provider in that family |
| **Driver** | None, HTTP only (`fetch` and `node:https`, both runtime built-ins) |
| **Query language** | `promql`, a third `queryLanguage` beside `sql` and `json`, with no `queryDialect` ([§3.1](#31-a-third-query-language-not-a-json-dialect)) |
| **Default port** | `9090`, the port the HTTP API and the web UI share. The same number is the default under TLS, because a secured server serves on whatever port its operator chose |
| **Connection pooling** | None. Each call is one stateless request; queries share a per-connection limit instead ([§3.4](#34-the-servers-query-slots-are-shared)) |
| **Connection string** | Not supported. `http://` and `https://` already parse as ClickHouse ([§4.5](#45-no-connection-string)) |
| **EXPLAIN** | None. `/api/v1/parse_query` is experimental upstream, so no plan view is offered |
| **Writes** | None, and none are offered. Studio calls only the read endpoints listed in [§6.1](#every-endpoint-call-with-its-parameters) |
| **Transactions** | Not applicable |
| **Maintenance** | None. The admin API (series deletion, snapshots, tombstones) and the lifecycle endpoints (`/-/quit`, `/-/reload`) are never called |
| **Query cancellation** | Yes: `cancelQuery(queryId)` aborts that query's request, and the server ends the evaluation at its next checkpoint; a query still waiting for one of the connection's query slots leaves the queue without reaching the server (M1, [§5.5](#55-timeout-and-cancellation)) |
| **Verified against** | **Prometheus 3.13.3**, the official `prom/prometheus:v3.13.3` image (the LTS line, supported to 2027-07-31), started by the `prometheus` and `prometheus-auth` services in `database-compose.yml` with the configuration in `docker/prometheus/`. Measured 2026-09-23 |
| **Source** | [`src/lib/db/providers/timeseries/prometheus/`](../../src/lib/db/providers/timeseries/prometheus/) |
| **Tests** | [`tests/integration/db/prometheus-provider.test.ts`](../../tests/integration/db/prometheus-provider.test.ts) + [`tests/unit/db/prometheus/`](../../tests/unit/db/prometheus/) + [`e2e/prometheus-provider.spec.ts`](../../e2e/prometheus-provider.spec.ts) |
| **Tracking issue** | [#1085, the approved design](https://github.com/libredb/libredb-studio/issues/1085), under [#424](https://github.com/libredb/libredb-studio/issues/424) |

---

## 1. Overview

Prometheus is a time-series database with its own query language, PromQL.
It is not SQL-shaped: there are no tables, no rows written by a client, and no statement that changes anything.
What a user browses is what the server scrapes and evaluates: metrics, the rules it evaluates, and the targets it scrapes.
The teams this product is built for query their metrics next to their databases, which is why it ships here (#1085, section 1).

### Concept mapping

| Studio concept | Prometheus concept |
|---|---|
| Relation (a row in the tree with columns) | A metric name; its columns are the label names its series carry, then `timestamp` and `value`, the fields an instant query of it returns |
| Row | A series (`rowName` "series") |
| Statement | One PromQL expression |
| Grouping folder | A rule group, or a scrape pool |
| Configuration object | A recording rule, an alerting rule, or a scrape target |
| Object source | The engine's own JSON for that object, re-serialised with `JSON.stringify` |
| Container | None: `containerLevels: []`, the Elasticsearch and SQLite shape |

### VictoriaMetrics

VictoriaMetrics answers the Prometheus HTTP API, so this provider connects to it unchanged: pick Prometheus in the connection dialog and give the VictoriaMetrics port, `8428` on a stock single node.
It is a wire-compatible relative, not a provider of its own, and what it gives a user was measured rather than assumed.
Every surface below was called separately through `createDatabaseProvider({ type: "prometheus" })` on 2026-09-23 against `victoriametrics/victoria-metrics:v1.152.0`, a single node scraping the compose fixture's targets with `-promscrape.config`, with `prom/prometheus:v3.13.3` probed in the same pass as the baseline.
The result is the `partial` entry in `src/lib/db/compatibility.ts` and its row in the [compatibility table](./README.md#wire-compatible-engines); this section says why each difference is what it is.
A surface that answers empty where Prometheus answers data is counted as not answering, the rule that keeps ScyllaDB `partial` ([cassandra.md §11](./cassandra.md#11-scylladb-is-a-partial-relative-one-absent-keyspace-cost-five-surfaces-until-2026-08-24)), and by that rule 16 of the 36 surfaces that answer on Prometheus answer here.
The metric, scrape pool and target reads ran on one named object that both servers hold, so the two columns compare the same thing: the metric `prometheus_http_requests_total`, the pool `prometheus` and a target of that pool.
The cancel row runs `sum(count_over_time(label_replace({__name__=~".+"}, "probe_name", "$1", "__name__", "(.+)")[1h:250ms]))` and cancels it 50 ms in, while it still runs on both servers.

| Surface | Prometheus 3.13.3 | VictoriaMetrics v1.152.0 |
|---|---|---|
| `connect` | answered | answered |
| `getHealth` | answered | answered |
| `getOverview` | answered | failed: `ConnectionError` Prometheus answered /api/v1/status/runtimeinfo with HTTP 400 and a body that is not a Prometheus API response, so something other than the Prometheus API answered at this address, such as a proxy or a login page. The body is not shown. |
| `getPerformanceMetrics` | answered | answered |
| `getMonitoringData` | answered | answered, empty |
| `getSlowQueries` | answered | answered |
| `getActiveSessions` | answered | answered |
| `getTableStats` | answered | failed: `ConnectionError` Prometheus answered /api/v1/status/tsdb with a document this client cannot read: expected an object at the head block statistics |
| `getIndexStats` | answered | answered |
| `getStorageStats` | answered | failed: `ConnectionError` Prometheus answered /api/v1/status/runtimeinfo with HTTP 400 and a body that is not a Prometheus API response, so something other than the Prometheus API answered at this address, such as a proxy or a login page. The body is not shown. |
| `listContainers` | answered | answered |
| `countObjects` | answered | answered |
| `listObjects:metric` | answered | answered |
| `describeObject:metric` | answered | answered |
| `describeObjects:metric` | answered | answered |
| `readObjectSource:metric` | answered | failed: `ConnectionError` Prometheus answered /api/v1/metadata with a document this client cannot read: expected text at unit in a metadata entry |
| `listObjects:rule_group` | answered | answered, empty |
| `describeObject:rule_group` | answered | skipped: listObjects returned no object to describe |
| `describeObjects:rule_group` | answered | answered |
| `readObjectSource:rule_group` | answered | skipped: listObjects returned no object to read |
| `listObjects:recording_rule` | answered | answered, empty |
| `describeObject:recording_rule` | answered | skipped: listObjects returned no object to describe |
| `describeObjects:recording_rule` | answered | answered |
| `readObjectSource:recording_rule` | answered | skipped: listObjects returned no object to read |
| `listObjects:alerting_rule` | answered | answered, empty |
| `describeObject:alerting_rule` | answered | skipped: listObjects returned no object to describe |
| `describeObjects:alerting_rule` | answered | answered |
| `readObjectSource:alerting_rule` | answered | skipped: listObjects returned no object to read |
| `listObjects:scrape_pool` | answered | failed: `ConnectionError` Prometheus answered /api/v1/scrape_pools with HTTP 400 and a body that is not a Prometheus API response, so something other than the Prometheus API answered at this address, such as a proxy or a login page. The body is not shown. |
| `describeObject:scrape_pool` | answered | skipped: listObjects did not list the scrape pool prometheus to describe |
| `describeObjects:scrape_pool` | answered | answered |
| `readObjectSource:scrape_pool` | answered | skipped: listObjects did not list the scrape pool prometheus to read |
| `listObjects:target` | answered | failed: `ConnectionError` Prometheus answered /api/v1/targets with a document this client cannot read: expected text at scrapeInterval in a target |
| `describeObject:target` | answered | skipped: listObjects did not list a target of the scrape pool prometheus to describe |
| `describeObjects:target` | answered | answered |
| `readObjectSource:target` | answered | skipped: listObjects did not list a target of the scrape pool prometheus to read |
| `query:vector` | answered | answered |
| `query:matrix-range` | answered | answered |
| `query:matrix-subquery` | answered | answered |
| `query:scalar` | answered | answered |
| `query:string` | answered | answered, empty |
| `query:notice` | answered, with the engine's PromQL info | answered, with no notice |
| `query:bad-data` | refused as expected: `QueryError` | refused as expected: `QueryError` |
| `query:comment-only` | refused as expected: `QueryError` | refused as expected: `QueryError` |
| `query:bound-params` | refused as expected: `DatabaseConfigError` | refused as expected: `DatabaseConfigError` |
| `cancelQuery:long-query` | cancelled as expected: `QueryCancelledError` | cancelled as expected: `QueryCancelledError` |

**The editor and the metric tree work as they do on Prometheus.**
Instant vectors, range selectors, subqueries and scalars answer, the three refusals (a parse error, a buffer holding only `#` comments, bound values) end in the same classes, and Cancel ends a running query as cancelled.
A metric's columns are the same on both servers: `prometheus_http_requests_total` has `__name__`, `code`, `handler`, `instance`, `job`, `timestamp` and `value` on each.

**The Overview and Storage tabs and the Scrape pools folder fail, on three endpoints VictoriaMetrics does not serve.**
`/api/v1/status/runtimeinfo`, `/api/v1/status/flags` and `/api/v1/scrape_pools` answer `400` with the plain text `unsupported path requested: "<the path>"`.
The overview reads the first two and the storage row the first, each beside the TSDB status below, so both fail whole, and the Scrape pools folder fails while its count reads unavailable.
The message a user sees says that something other than the Prometheus API answered, such as a proxy or a login page, because that is how this provider reads any answer that is not the API envelope; here it is the server's own refusal of a path it does not implement.

**Three documents lack a field the provider requires.**
Each is refused whole as an envelope of the wrong shape, the `protocol` category of `transport.ts`, which `errors.ts` maps to `ConnectionError`.
The TSDB status holds VictoriaMetrics' own statistics (`totalSeries`, `totalLabelValuePairs`, `seriesCountByMetricName` and four more) and no `headStats`, so the Tables tab fails with `expected an object at the head block statistics`.
A metadata entry carries `type` and `help` but no `unit`, so a metric's Source tab fails with `expected text at unit in a metadata entry`, and the type and help it does send are not shown either.
A target carries no `scrapeInterval` and no `scrapeTimeout`, which it keeps as `__scrape_interval__` and `__scrape_timeout__` among its discovered labels, so the Targets folder fails with `expected text at scrapeInterval in a target` and its count reads unavailable.

**The rule folders are empty, and that is the deployment rather than a defect.**
A single-node server evaluates no rules: alerting and recording rules belong to vmalert, and `/api/v1/rules` answers from vmalert only when the server is started with `-vmalert.proxyURL`.
Here it answered `{"status":"success","data":{"groups":[]}}`, so the rule group, recording rule and alerting rule folders open onto nothing, and a question about alerts has nothing to read here.

**A string expression returns no rows.**
`"libredb"` answers an empty vector, `{"resultType":"vector","result":[]}`, where Prometheus answers a `string` result, so the grid shows nothing.

**No PromQL info or warning appears.**
VictoriaMetrics answered `rate(up[5m])` with no notice where Prometheus 3.13.3 attaches `PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "up" (1:6)`, and none of the 69 answers captured from it in `tests/fixtures/prometheus/victoriametrics-v1.152.0/` carries one either.
It also ignores `limit` on `/api/v1/query`: `limit=1` returned all four `up` series, so the series cap is applied by this provider alone, once the answer has arrived ([§5.4](#54-caps-warnings-and-truncation)).

**No panel shows a version.**
`/api/v1/status/buildinfo` answers `2.24.0`, the Prometheus version VictoriaMetrics advertises for Grafana, which is why the registry records the build as `VictoriaMetrics v1.152.0 (advertises Prometheus 2.24.0)`.
Its own build, `v1.152.0`, is in its `/metrics` as `vm_app_version`, which the provider does not read, and the overview, the one panel that would show a version, fails as above.

The relative is claimed for PromQL only: MetricsQL is a superset of it, and nothing beyond PromQL was measured.
`v1.152.0` is the release probed.
The v1.136 line was not: `victoriametrics/victoria-metrics:v1.136.15` answered 404 on Docker Hub on 2026-09-23, where `v1.136.15-enterprise` is published, and every patch release of that line from `v1.136.1` to `v1.136.18` has an `-enterprise` tag there and no plain one.
Reproduce the pass with `docker compose -f database-compose.yml --profile compat up -d victoriametrics` and a connection to `localhost:8428` with no user and no password.

---

## 2. Architecture

### 2.1 Where it sits

```
src/lib/db/providers/timeseries/prometheus/
├── index.ts           PrometheusProvider extends BaseDatabaseProvider: lifecycle and composition only
├── transport.ts       THE SEAM: PrometheusTransport, the seam data types, PrometheusTransportError. No I/O
├── http-transport.ts  The only file that knows the wire: headers, the envelope, every endpoint's parameters
├── request.ts         How a request leaves the process: fetch or node:https, redirects refused, byte cap
├── promql.ts          The one builder for every PromQL fragment and label path written from a name
├── results.ts         Pure: query data to rows and fields
├── objects.ts         Kind declarations and the object surface
├── monitoring.ts      Pure mappings for build, runtime, flags and TSDB status, plus their readers
├── errors.ts          Transport error category to the repository's error classes
└── concurrency.ts     The per-connection limit on in-flight queries
```

Each module has one reason to change (#1085, section 3.5).
`index.ts` holds no wire format, no result shaping, no PromQL building, no URL building and no error table; it delegates each to the module that owns it.
`objects.ts` and `monitoring.ts` receive a read-only slice of the transport (`ObjectsTransport`, `MonitoringTransport`), never the whole transport or the provider.
`http-transport.ts` receives the request function (`SendRequest`) and the URL builder (`PrometheusEndpoint`) by injection, and the clock that bounds every time window is injected too, so every unit test is deterministic without replacing a global.
`tests/unit/db/prometheus/seam-guard.test.ts` fails the build the moment wire vocabulary appears outside `http-transport.ts`, or a module other than `request.ts` reaches the network, on the Trino template.

Nothing outside this directory is imported from another provider: the Couchbase TLS helpers are the reference for the TLS mapping and not a dependency ([§3.6](#36-tls-is-its-own-implementation)).
The endpoint and redirect rules are not this directory's own: `index.ts` builds each connection's `PrometheusEndpoint` from `httpOrigin` and `endpointUrl` of [`src/lib/db/http/endpoint.ts`](../../src/lib/db/http/endpoint.ts), the module every HTTP transport here uses, and `request.ts` refuses a 3xx on both request paths with that module's `rejectRedirect`, so host and port validation, the check of each built URL and the redirect rule are that module's and not a copy (#1085 S1 and #1085 S2, sections 3.6 and 13).

### 2.2 Class hierarchy

```
DatabaseProvider (interface)
└── BaseDatabaseProvider
    └── PrometheusProvider
```

`BaseDatabaseProvider` directly, as for MongoDB, Redis, Couchbase and LibreDB: PromQL is not SQL, so nothing `SQLBaseProvider` adds would be true here.

### 2.3 What the base class gives for free

Connection-state bookkeeping, the configured query timeout, and the error logging every provider shares.
Nothing PromQL-specific lives in the base class.

### 2.4 Registration & lifecycle

The factory builds it through `createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)) with a dynamic import, so no other engine loads this module.
Its `DB_UI_CONFIG` entry draws it in `text-hue-fuchsia`, because the flame orange of its mark is Couchbase's identity hue already, and `SHOWCASE_RANK` places it on the login showcase behind Trino and ahead of libSQL.
`connect()` builds the endpoint from `host` and `port` through the shared endpoint validation (#1085 S1, sections 3.6 and 13), validates the credentials, and builds the request function from the TLS panel, so an invalid value is refused before any request leaves the process.
It then reads `/api/v1/status/buildinfo` once, which proves the server answers the API envelope at that address with that credential.
There is no server-side session: `disconnect()` ends every query still running or waiting for a slot as a cancellation, and releases only what the provider holds in the process.

---

## 3. Design decisions

### 3.1 A third query language, not a JSON dialect

`ProviderCapabilities.queryLanguage` was the closed union `"sql" | "json"`, with `queryDialect` separating the JSON-shaped command languages (`libredb`, `redis`).
Prometheus widens `queryLanguage` to `"sql" | "json" | "promql"` and declares no `queryDialect`, because `queryDialect` distinguishes kinds of JSON and PromQL is not JSON.
A third member is not neutral by default: a reader written `=== "json"` sends it into its SQL branch, and one written `!== "sql"` sends it into its MongoDB branch.
Every reader was classified when the union widened (#1085, section 3.2): the editor has a `promql` tab type and a Monarch tokenizer (`src/lib/editor/promql-language.ts`), the two generators have a PromQL arm built through `promql.ts`, and the profile route refuses a language it cannot profile.
On a metric row both row menus withhold Profile and Code Generator, through `offersColumnProfiling` and `offersCodeGeneration`, which offer neither for `promql`, and Generate Test Data, because no kind declares `acceptsRowWrites`; the tree's menu for a metric keeps Generate Query and View Source.
A plan-mode draft is fenced with the canonical type-id, `prometheus`, which `ENGINE_FENCE_TAGS` accepts; `promql` is accepted as a query alias only (`QUERY_FENCE_ALIASES` in `src/lib/sql/fence-tags.ts`, the `cql` precedent), because other stores speak PromQL too and an alias claims no engine.
Widening a published union breaks an external consumer's exhaustive switch over it, and that ships with a release note rather than a compatibility layer.

### 3.2 One PromQL builder

The v3.13.3 lexer matches keywords and aggregators case-insensitively and lexes `inf` and `nan` as numbers, so a legal metric named `nan` evaluates as a scalar.
Every word of the lexer's `key` table, with `inf` and `nan`, was sent bare and as `{__name__="<word>"}` in each context this provider writes a selector in: alone, followed by `[5m]`, inside `count(...)`, inside `rate(...[5m])[1h:1m]`, and upper-cased alone (fixture README, "The lexer's reserved words (#1085 S4)").
On Prometheus 3.13.3 the bare form did not answer like `{__name__="<word>"}` in some context for: `atan2`, `bool`, `group_left`, `group_right`, `ignoring`, `inf`, `nan`, `on`; it did in every context for: `anchored`, `and`, `avg`, `bottomk`, `by`, `count`, `count_values`, `end`, `fill`, `fill_left`, `fill_right`, `group`, `limit_ratio`, `limitk`, `max`, `max_of`, `min`, `min_of`, `offset`, `or`, `quantile`, `range`, `smoothed`, `start`, `stddev`, `stdvar`, `step`, `sum`, `topk`, `unless`, `without`.
So a metric named `sum` selects bare on this version, which #1085 S4 had expected to fail to parse.
`PROMQL_RESERVED_WORDS` is the lexer's whole `key` table plus `inf` and `nan`, a superset of the words whose bare form differs, pinned by a test to that table as captured at the tag (`tests/fixtures/prometheus/v3.13.3/lexer-words.json`).
So `promql.ts` writes the bare selector only for a legacy name (`^[a-zA-Z_:][a-zA-Z0-9_:]*$`) whose lowercase form is not in that set, which is where every parser this provider meets reads it as a metric; every other name becomes `{__name__=<its PromQL string>}`, which parses on 2.x, 3.x and MetricsQL.
A PromQL string is `JSON.stringify` of the text with one exception: a U+FFFD in a name is written as the escape `�` (backslash, u, f, f, f, d), because the v3.13.3 lexer reads a literal U+FFFD as an invalid rune; every other character is exactly what `JSON.stringify` writes, and `JSON.parse` reads the string back to the same text.
A name holding an unpaired surrogate is not well-formed text: `JSON.stringify` writes the surrogate as an escape the lexer refuses as an invalid code point, so the server refuses such a selector as `bad_data`, a parse error, and it never selects another metric.
The same escaping writes label values in matchers and the wide matrix's column names (`seriesNotation`), so column naming stays injective.
A label name that is not a legacy identifier, or that starts with `U__`, is `U__`-escaped in a label-values path, because the server unescapes any name starting with `U__`; the one such path this provider reads is `__name__`'s, where the escape is the name itself.
`escapeLabelNameForPath` refuses, with a `RangeError`, a label name holding a code point above U+FFFFF or an unpaired surrogate, because the server cannot read either back from an escaped segment (prometheus/common v0.69.0, the version v3.13.3 pins).
Server-supplied text placed after a `#` in generated text goes through the generators' `commentName` helper, so a newline in a name cannot start a new line of PromQL.

### 3.3 Every response is bounded

A single matrix response can reach gigabytes (`--query.max-samples` defaults to 50,000,000), and every Studio user shares one process.
`request.ts` enforces a streaming byte cap, `RESPONSE_BYTE_CAP`, on every response on both paths and aborts past it, and `errors.ts` reports a `QueryError` that names the cap and suggests a narrower range or a larger step.
Every request, not only a query, carries an `AbortSignal` and a timeout.
The series cap and the matrix cell budget then apply to what was parsed ([§5.4](#54-caps-warnings-and-truncation)).

### 3.4 The server's query slots are shared

Rule evaluation and API queries share one engine and one active-query tracker on the monitored server, and `--query.max-concurrency` defaults to 20 (#1085 S6).
Every Studio user's PromQL, including the query a tree click runs on its own, competes with the server's alerting-rule evaluation for those slots.
So `concurrency.ts` limits in-flight queries per connection to `QUERY_CONCURRENCY_LIMIT` and queues the rest first in first out.
The one PromQL evaluation the object surface sends, the existence read of [§6.2](#62-object-source-789), waits for one of those slots too; the other object and monitoring reads evaluate no PromQL and take none.
A query cancelled while it waits leaves the queue without reaching the server and ends as `QueryCancelledError`.
The bound is per connection, and the server's ceiling is shared by every connection to it and by its own rule evaluation, so several Studio connections to one server hold that many slots each.
Point Studio at a production Prometheus knowing that a query it runs is a query the server's own alerting waits behind.

### 3.5 No redirects, and credentials never echoed

`fetch` follows redirects by default, and a 307 or 308 replays a POST and its body wherever `Location` points, keeping the `Authorization` header on a same-origin hop.
Every request here refuses redirects on both paths, through the shared `rejectRedirect` of `src/lib/db/http/endpoint.ts`: any 3xx is a `ConnectionError` naming the status and the `Location` origin only, and its body is released unread (#1085 S2).
A header value containing a line feed makes `fetch` throw a `TypeError` whose message contains the whole header, and error messages reach both the log and the client.
So before any header is built the transport refuses CR, LF, NUL and any character outside the token68 set in a bearer token, and `:` in a Basic user (RFC 7617), with a `DatabaseConfigError` that never contains the value (#1085 S3).
Nothing is trimmed silently, credentials never appear in a URL, and a response body that is not the API envelope is never copied into an error message.

### 3.6 TLS is its own implementation

`request.ts` sends plaintext through `fetch` and TLS through `node:https`, with `ca`, `cert`, `key` and `rejectUnauthorized` mapped from the TLS panel by the Couchbase rule, `rejectUnauthorized = ssl.rejectUnauthorized ?? ssl.mode !== "require"`.
It is a second implementation of that mapping by maintainer decision (the PR touches no other provider), recorded in `docs/BACKLOG.md` D37, whose consolidation covers it.
It differs from the Couchbase helper where this provider needs more: an `AbortSignal` and timeout, the byte cap, and IPv6 literals, which are passed to `node:https` without brackets through `url.urlToHttpOptions` (the Couchbase path fails on them, `docs/BACKLOG.md` D104).
Neither follows a redirect: Prometheus refuses one on both paths through the shared `rejectRedirect` of `src/lib/db/http/endpoint.ts`, and Couchbase does on its `fetch` path since #1086, while its `node:https` path reports a 3xx as an HTTP failure (`docs/providers/couchbase.md` section 4.4).
The TLS path runs under Bun in the test suite and under Node in production, a gap `docs/BACKLOG.md` D106 records.
A handshake or verification failure is a `ConnectionError` carrying the Node error code, and nothing is retried over plain HTTP (#1085 S8).

### 3.7 `NaN` and `Inf` stay strings, and what the chart does with them

Finite sample values become JavaScript numbers; Prometheus writes the shortest round-tripping float, so nothing is lost.
`NaN`, `+Inf` and `-Inf` stay the engine's strings, because JSON transport would turn a `NaN` number into `null`, and in the wide matrix shape `null` already means "no sample at this instant".
The cost is that a column holding both numbers and one of those strings is mixed, and the chart tab may classify such a column as categorical rather than drawing it as a line.
That is accepted by maintainer decision (#1085, section 5.3): a chart that plots a `NaN` as a gap would claim the series had no sample there.
Filter the non-finite values in PromQL (`x > -Inf < +Inf`, or `x == x` for `NaN`) when a line chart matters more than seeing them.

### 3.8 Measurements

Every number below was decided by a live measurement against the compose `prometheus` service, recorded in [`tests/fixtures/prometheus/README.md`](../../tests/fixtures/prometheus/README.md), section "Measurements".
The constants are read by [`tests/unit/db/prometheus/provider-doc.test.ts`](../../tests/unit/db/prometheus/provider-doc.test.ts), so a row that disagrees with the code fails the build.

| Item | What it decides | Value | Where it was measured |
|---|---|---|---|
| M1 | Whether `cancelQuery` exists | Observed: aborting a long query ended its evaluation on the server, so the method exists ([§5.5](#55-timeout-and-cancellation)) | Fixture README, M1 |
| M2 | The overview's metric count | The head block's distinct metric names: the value of the `__name__` entry of `labelValueCountByLabelName` in `/api/v1/status/tsdb`, read with `TSDB_LABEL_SCAN_LIMIT` (`10000`); that value is exact whenever the entry is listed, at any length of the list, because the endpoint cuts only the list and each kept entry carries its label's full count; absent from a list shorter than the limit it is `0`, an empty head; and only when a full list of that many label names omits it is the overview refused as unmeasurable; never a capped list's length | Fixture README, M2 |
| M3 | The wide matrix's cell budget | `MATRIX_SAMPLE_BUDGET` = `250000` cells of the wide grid, distinct instants times kept series; for a stepped subquery, whose series share their instants, the cells are about its samples | Fixture README, M3 |
| M5 | Credentials the server does not need | A stock server with no web config answers 200 with a bogus credential and with none; with basic auth configured, a wrong credential answers 401 with `WWW-Authenticate: Basic` and the plain-text body `Unauthorized` | Fixture README, M5 |
| M7 | Whether plan mode grounds every kind within the provider path's bounds | Not on a large server: the grounding walk stops at the first truncated `describeObjects` batch, and the metric batch, the first the walk reads, is truncated past `METRIC_LIST_CAP` metric names or `DESCRIBE_SERIES_CAP` series in the hour, so plan mode there grounds metrics only (`docs/BACKLOG.md` B84); the compose server is far below both caps, which is why the limit is recorded from the code | `walkObjectInventory` in `src/lib/agent/tools.ts`, and the PR's live plan run |
| M8 | How truncation is detected from the server | Prometheus sends the warning `results truncated due to limit` for `/api/v1/query`, the label values and the series listing when a `limit` bites; where no warning arrives, receiving more items than the cap (each read asks for cap + 1) is the signal | Fixture README, M8 |
| M10 | The metric list cap | `METRIC_LIST_CAP` = `2000` names, below the inventory's 5000 so plan mode keeps room for the other kinds | Fixture README, M10 |
| M11 | Queries in flight per connection | `QUERY_CONCURRENCY_LIMIT` = `4`: with four heavy queries in flight for 60 s, every rule group kept its evaluation interval and no iteration was missed | Fixture README, M11 |
| M12 | The response byte cap | `RESPONSE_BYTE_CAP` = `33554432` bytes (32 MiB) | Fixture README, M12 |
| M13 | The series cap of a whole-folder describe | `DESCRIBE_SERIES_CAP` = `20000` series | Fixture README, M13 |

### 3.9 Shared records with no `prometheus` entry, and why

Adding the type-id meant classifying every hit of the three searches `docs/ADDING_A_PROVIDER.md` names.
The exhaustive records all have an entry, because the compiler refuses one without it.
These partial records deliberately have none:

| Record | Where | Why there is no entry |
|---|---|---|
| `DIALECT_TYPES` | `src/lib/export/result-export.ts` | An export's column types map SQL DDL spellings; PromQL has no DDL, so the standard spellings stand |
| `CATALOG_PLANS`, `COMPOSED_KIND_WORDS` | `src/lib/agent/context-snapshot.ts` | Plan mode grounds Prometheus through the provider's own object surface, not through composed catalog statements |
| `CATALOG_COMPOSERS`, `ESTIMATING_EXPLAIN_PREFIX` | `src/lib/agent/composed-sql.ts` | They serve `AGENT_EXECUTION_ENGINES`, and agent execute mode is out of scope for PromQL (#1085, section 2) |
| `ESTIMATE_BUILDERS` | `src/lib/agent/schema-stats.ts` | Prometheus holds no table statistics a run knows how to read; its series counts are TSDB top-N figures, not estimates |
| `ENGINE_URI_SCHEMES` | `src/lib/connection-string-parser.ts` | No connection string ([§4.5](#45-no-connection-string)) |
| `NON_SQL_DESTRUCTIVE_VOCABULARY` | `src/lib/db/destructive-commands.ts` | PromQL has no statement that writes, deletes or changes state, so there is no destructive vocabulary to confirm |
| `DIALECTS` | `src/components/CreateTableModal.tsx` | Only engines with `supportsCreateTable: true` reach that form |
| `SQL_GRAMMARS` | `src/lib/sql/grammar.ts` | PromQL is not SQL: `prometheus` is in `NON_SQL_DIALECTS`, so no SQL grammar fact applies |
| `NO_PORTABLE_INDEX_DDL`, `NO_FOREIGN_KEYS`, `FOREIGN_KEY_ONLY_IN_CREATE_TABLE` | `src/lib/schema-diff/migration-generator.ts` | They qualify index and foreign-key DDL for engines that have table DDL at all; how the generator treats `prometheus` as a whole is recorded in `MODIFIED_COLUMN_COVERAGE` and `TRANSACTION_WRAPPER_COVERAGE` in `tests/unit/schema-diff/migration-generator.test.ts` |
| `AGENT_EXECUTION_ENGINES` | `src/lib/agent/engine-support.ts` | Agent execute mode is a non-goal; plan mode and the `operations` workflow still reach the server |

`src/lib/sql/identifier.ts` is a `switch` with a `default` and needs no case.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Used | Notes |
|---|---|---|
| `host` | Yes | A hostname or an IP literal; anything carrying URL syntax is refused before any request (#1085 S1) |
| `port` | Yes | Default `9090` |
| `user` | Optional | Selects Basic authentication ([§4.2](#42-authentication)) |
| `password` | Optional | Labelled "Password or token" in the dialog, with the hint "Leave User empty to send this as a bearer token." |
| `database` | No | No Database box renders: a Prometheus server is one TSDB, so there is nothing to select |
| TLS panel | Yes | [§4.4](#44-tls) |

The two dialog strings are declared on the `prometheus` entry of `DB_UI_CONFIG` (`fieldLabels`, `fieldHints`) rather than chosen by a type test in the dialog; `docs/BACKLOG.md` U36 records moving the older engines onto the same declaration.
No new `DatabaseConnection` field exists, so the bearer token rides `password`, which the connection store already classifies as a secret.

### 4.2 Authentication

| `user` | `password` | Header sent |
|---|---|---|
| set | set | `Authorization: Basic` over `user:password`. Grafana Cloud's hosted Prometheus works this way, with the instance id as the user and an access-policy token as the password |
| empty | set | `Authorization: Bearer <password>`, the libSQL precedent, for a token-guarded proxy |
| set | empty | `Authorization: Basic` with an empty password, the ClickHouse behaviour |
| empty | empty | No header |

Every value passes the validation of [§3.5](#35-no-redirects-and-credentials-never-echoed) first.
A stock Prometheus with no web config ignores a credential it does not need, so a wrong one still connects there (M5); a server with basic auth configured answers 401, which surfaces as an `AuthenticationError`.

### 4.3 Credentials over plain HTTP

A credential is sent over plain HTTP when the TLS panel is off, and is not refused.
Prometheus accepts it, in-cluster plaintext is common, and ClickHouse behaves the same way.
The exposure is real: a Basic header is base64, not encryption, and a bearer token is sent as written, so anything that can read the traffic between Studio and the server can read the credential.
Enable TLS for any server reached across a network you do not control.

### 4.4 TLS

| `ssl.mode` | What happens |
|---|---|
| `disable`, or no TLS panel | Plaintext through `fetch` |
| `require` | `node:https`, encrypted, certificate not verified unless `rejectUnauthorized` is set |
| `verify-system`, `verify-ca`, `verify-full` | `node:https`, certificate and server name verified, against the supplied CA or, without one, the runtime's trust store |

The three verifying modes come out the same, because Node checks the server name whenever it verifies, so `verify-ca` cannot skip that check here.
`ssl.caCert`, `ssl.clientCert` and `ssl.clientKey` reach the request as `ca`, `cert` and `key`, an empty field is left out, and `ssl.rejectUnauthorized` overrides the mode's default either way.
Each case is exercised by a real handshake against a local `node:https` server in `tests/unit/db/prometheus/request.test.ts`.

### 4.5 No connection string

`showConnectionStringToggle: false`: `http://` and `https://` already parse as ClickHouse in `src/lib/connection-string-parser.ts`, and two engines cannot own one scheme.
There is no path-prefix field either, so Grafana Mimir (`/prometheus`), GreptimeDB (`/v1/prometheus`) and proxies that mount the API under a prefix are not reachable in this version (maintainer decision, 2026-09-23).

---

## 5. Query interface

### 5.1 The call

The editor text goes to `POST /api/v1/query` as a form body (`query`, `timeout` in seconds, `limit`) with no `time` parameter, so the server evaluates at now.
`#` comments are PromQL syntax and are sent as written.
A text that is empty once comments and whitespace are removed is refused before any request, with a `QueryError` saying so.
Bound `params` are refused with a `DatabaseConfigError`: PromQL has no binding, and ignoring them would run a different statement from the one the caller built.
Ranges are written in PromQL itself: `x[1h]` returns raw samples and `rate(x[5m])[1h:1m]` a stepped series; there is no `query_range` path.
`supportsResultPagination` and `supportsExternalQueryLimiting` are both `false`, as on Redis and MongoDB.

A row click in the tree runs the metric's selector as an instant query, the action the labels name "Run Instant Query".
Generate Query writes that selector as the one runnable line, below the two range forms as `#` comments, so the buffer run whole is exactly one expression.
The editor's tokenizer (`src/lib/editor/promql-language.ts`) colours a `#` comment wherever the lexer starts one: at the top level, inside `{}` and inside a range's `[]`; inside a raw string, between backticks, a `#` is text.

### 5.2 Result shaping

| Data type | Rows | Fields |
|---|---|---|
| `vector` | one per series | `__name__` first when present, the remaining label names sorted, then `timestamp`, `value` |
| `matrix` | one per timestamp (wide) | `timestamp`, then one column per series |
| `scalar` | one | `timestamp`, `value` |
| `string` | one | `timestamp`, `value` |

A label literally named `timestamp` or `value`, or a label name that is not a legacy identifier such as `service.name`, becomes the field `JSON.stringify(name)`, so the fields stay unique; the same function (`vectorFieldNames`) names a metric's columns in the tree, so the tree and the grid agree.
Two answers are refused as protocol failures, a `ConnectionError`, rather than shaped: a vector series that does not hold exactly one point, and a matrix holding two series with one label set, because neither is an answer of a shape this build reads.
A wide matrix names each series column by the labels that distinguish it from the others, in PromQL label notation (`{job="api"}`); a single series with nothing to distinguish is named `value`.
The rows are the sorted union of every series' timestamps, and a series with no sample at one holds `null` there, so a raw range selector gives sparse rows and a stepped subquery aligned ones.
The wide shape is what lets the existing chart tab draw one line per series with no change to the chart.

### 5.3 Value encoding

- Timestamps are float seconds on the wire and ISO-8601 UTC strings with millisecond precision in the grid, which the chart tab recognises as dates.
- Finite values are numbers; `NaN`, `+Inf` and `-Inf` are strings ([§3.7](#37-nan-and-inf-stay-strings-and-what-the-chart-does-with-them)).
- A native histogram stays `{count, sum, buckets}`, rendered by the grid's JSON cell.
- A `string` result's value stays its text, `"42"` included.

### 5.4 Caps, warnings and truncation

- Series are capped at `DEFAULT_QUERY_LIMIT` (500) for vector and matrix alike, sent as `limit` one above the cap (501), so a cut is seen even when the engine drops its own notice among more than ten annotations; at most 500 series are shown, and the cap is enforced locally as well, because only Prometheus 3.2.0 and later honour `limit`.
- The series notice names an exact total only when the server sent more series than it was asked for; otherwise it says "more than" the number shown, because the server's own cut carries no total.
- A wide matrix is also held to `MATRIX_SAMPLE_BUDGET` cells (M3), distinct instants times kept series, because a raw range over targets scraped at their own offsets gives nearly every sample its own row; whole series are kept in engine order while they fit, and the notice names the kept and total series and cells.
- A truncated result carries a `QueryWarning` naming what was cut and how much, and reports itself limited on its own `pagination`, `wasLimited: true` with `hasMore: false`, which `POST /api/db/query` keeps (#1085, section 5.4).
  So the stats strip shows the "limited" badge, and no next page is offered, because the cut is this provider's own bound and no offset advances it.
  The export menu over such a result still says it writes all the rows, which `docs/BACKLOG.md` U42 records.
- The envelope's `warnings` and `infos` (for example "metric might not be a counter") become `QueryWarning` entries in the engine's own words, ahead of this provider's own.

### 5.5 Timeout and cancellation

The configured query timeout is sent as the `timeout` parameter, which the server caps at its own `--query.timeout` (default `2m`), and is enforced on the client with an `AbortSignal` as well.
`cancelQuery(queryId)` aborts that query's request.
Prometheus derives the evaluation context from the HTTP request and checks it at fixed points during evaluation, so an abort ends the evaluation at the next checkpoint.
That was observed on the live server before the method was added (M1): the `prometheus_engine_queries` gauge fell back once the request was aborted, and the aborted query's own query-log line recorded it as canceled.
Both the cancel route and the query route detect cancellation by presence (`"cancelQuery" in provider`), which is why the method exists only because that measurement held.

### 5.6 EXPLAIN

None: `supportsExplain` is `false`, and the plan view is not offered.

---

## 6. Schema introspection

### 6.1 The object surface (#789)

#### Kinds, folders and identity

The tree draws one flat root folder per declared kind, and a child's row name says which parent it belongs to, because listing is container-scoped and `childKinds` draws no folder.

| Kind | Role | Path | Row name | Columns | Source | `status` |
|---|---|---|---|---|---|---|
| `metric` | `relation` | `[name]` | the metric name | yes | metadata | never |
| `rule_group` | `group`, `childKinds: [recording_rule, alerting_rule]` | `[groupKey]` | the group name | no | the group's evaluation facts | never |
| `recording_rule` | `config`, `attachedTo: rule_group` | `[groupKey, ruleSegment]` | `<record> (<group>)` | no | the rule | never |
| `alerting_rule` | `config`, `attachedTo: rule_group` | `[groupKey, ruleSegment]` | `<alert> (<group>)` | no | the rule, then its live alerts | `firing` or `pending`, the engine's word |
| `scrape_pool` | `group`, `childKinds: [target]` | `[pool]` | the pool name | no | target counts by health | never |
| `target` | `config`, `attachedTo: scrape_pool` | `[pool, targetSegment]` | `<instance> (<pool>)` | no | the target | `down` or `unknown`, the engine's word |

The declaration order is the agent walk's order: metric, rule_group, recording_rule, alerting_rule, scrape_pool, target (M7).
Identity is the engine's own, decided from the upstream source:

- `groupKey` is `<file>;<group>`, the key Prometheus uses, because group names need not be unique across files.
  A path is resolved against the rules listing rather than split on `;`, because either part may contain one.
- `ruleSegment` is the rule's 1-based position in its group, a colon, then its name (`3:NodeFilesystemSpaceFillingUp`), because shipped rule sets repeat a rule name inside one group.
  An alerting rule's live alerts come from a read filtered by `rule_name[]`, which returns only the rules of that name, so there the rule is picked by its occurrence among the group's same-named rules.
- `targetSegment` is the target's `scrapeUrl`, a space, then the first 12 hex digits of a SHA-256 over its sorted label set, because two targets in one pool can share `instance`.
  The digest covers the public labels only: two targets that differ only in a `__`-prefixed label the API does not report share a segment.

Dropped targets are not listed; on Kubernetes they can number in the tens of thousands.

#### Metric columns

A metric's columns are its label names over the last hour (`INVENTORY_WINDOW_MS` (`3600000`), from the injected clock), then `timestamp` and `value`, and the `value` column's type reads `float64 or histogram`, the data model's two sample kinds.
A label column is a `string`, nullable except `__name__`, which every series of the metric carries.
`describeObject([name], "metric")` reads `/api/v1/labels` with the metric's selector.
A metric for which that read names no label is one the server holds no series of for the window, and it is described with no columns rather than with a `timestamp` and a `value` no series holds.
`describeObjects([], "metric", limit)` is one `/api/v1/series` read over every metric, grouped by `__name__`, capped at `DESCRIBE_SERIES_CAP` series (M13), and the caller's `limit` bounds the metrics it describes.
When the series cap bites, the batch's `truncated` names the series bound in these words: "the series read stopped at 20,000 series, so a metric may be missing from this batch or described without a label only its unread series carry".
That sentence is joined with the caller's own when both bite, and no partial column list is presented as complete.
The batch takes its metrics from its `/api/v1/series` read and not from the listing, and on Prometheus 3.13.3 the two can disagree: the head block answers the listing and the labels read with no per-series time filter, while the series read skips a series with no sample in the window.
So a metric whose series all stopped sampling before the hour, while the head still holds them, is listed and `describeObject` answers its columns, yet the batch leaves it out without marking itself truncated, and the inventory carries it with no columns (`docs/BACKLOG.md` D107).
The other five kinds have no columns, and describing one sends no read.

#### Listing, counting and scale

One reader per kind feeds both `countObjects` and `listObjects`, so the count is the listed length.
One `countObjects` call sends each of its four listings once, the metric names, the rules listing its three rule-shaped kinds share, the scrape pools and the active targets, and a listing that is refused, a redirect included, marks only the kinds it feeds while the others still count.
Metric names come from `/api/v1/label/__name__/values` over the last hour, capped at `METRIC_LIST_CAP` (M10).
A truncation warning from the server, or one name more than the cap, makes the count a floor, which the tree badges `2,000+` with the title "At least 2,000: counted from one label-values read capped at 2,000 names".
A capped listing is not the alphabetically first names: the head cuts its label values in the order it first saw them, and the API sorts what is left.
A metric row carries no row count: a list read does not measure series, and an estimate published as a count is the defect #424 records for Citus and TimescaleDB.

#### Every endpoint call, with its parameters

Each is pinned by a unit test in `tests/unit/db/prometheus/http-transport.test.ts`.

| Purpose | Call |
|---|---|
| Query | `POST /api/v1/query`, form body `query`, `timeout`, `limit` |
| Metric names | `GET /api/v1/label/__name__/values?start&end&limit` |
| One metric's labels | `GET /api/v1/labels?match[]&start&end` |
| All metrics' labels | `GET /api/v1/series?match[]={__name__=~".+"}&start&end&limit` |
| Metadata | `GET /api/v1/metadata?metric&limit=1` |
| Rules listing | `GET /api/v1/rules?exclude_alerts=true` |
| An alerting rule's live alerts | `GET /api/v1/rules?rule_group[]&file[]&rule_name[]`, without `exclude_alerts` |
| Pools | `GET /api/v1/scrape_pools` |
| Targets | `GET /api/v1/targets?state=active[&scrapePool]` |
| Health | `GET /-/healthy`, `GET /-/ready`; `GET /health` only after a 404 from `/-/healthy` |
| Build, runtime, flags | `GET /api/v1/status/buildinfo`, `/api/v1/status/runtimeinfo`, `/api/v1/status/flags` |
| TSDB | `GET /api/v1/status/tsdb?limit` |

### 6.2 Object source (#789)

Every source is JSON, serialised with `JSON.stringify`, `language: "json"`, `form: "complete"`, `origin: "rendered"`, whose shipped caption, "A structured definition, rendered here as JSON", is true of it.
Server text is data: a rule annotation, a HELP string or a target error is shown exactly as the server sent it and cannot forge structure.

| Kind | Read | Parts |
|---|---|---|
| `metric` | metadata by the exact name, then by the family name with `_bucket`, `_sum`, `_count`, `_total` or `_created` removed | One part per distinct metadata entry (`family`, `type`, `help`, `unit`); past the `SOURCE_PART_LIMIT` (`8`) parts the source route accepts, parts 1 to 7 are single entries and part 8 is one JSON array holding the rest, so nothing the engine answered is dropped; with none, a refusal part that reads "Prometheus holds no metadata for this name: metadata is collected per metric family from active scrape targets, so recording-rule outputs, ALERTS and classic histogram series have none." |
| `rule_group` | the rules listing entry (`exclude_alerts=true`), which already carries every field the source renders | `file`, `name`, `interval`, `limit`, `evaluationTime`, `lastEvaluation`, the rule count |
| `recording_rule` | the rules listing entry (`exclude_alerts=true`), which already carries every field the source renders | `name`, `query`, `labels`, `health`, `lastError`, `evaluationTime`, `lastEvaluation` |
| `alerting_rule` | the listing entry for the definition, then `rule_group[]`, `file[]` and `rule_name[]` without `exclude_alerts` for its live alerts, the rule picked by its occurrence among same-named rules | Part 1, the definition (`name`, `query`, `duration`, `keepFiringFor`, `labels`, `annotations`, `health`, `lastError`); part 2, the live `state` and the active alerts |
| `scrape_pool` | the pools listing, which decides that the pool exists, then the pool's active targets | Target counts by health |
| `target` | the pool read | `scrapeUrl`, `health`, `lastError`, `lastScrape`, `lastScrapeDuration`, `scrapeInterval`, `scrapeTimeout`, `labels`, `discoveredLabels` |

A name that does not exist answers a `QueryError` naming the segment.
For a metric, existence is decided by the listing, because `/api/v1/metadata` answers `{}` both for an unknown name and for a real metric with no metadata.
A name outside a complete listing does not exist; a name outside a capped one is asked about with a `count(last_over_time(<selector>[1h]))` instant query over the listing's own hour, which takes one of the connection's query slots ([§3.4](#34-the-servers-query-slots-are-shared)).

### 6.3 Object edit (#789)

Nothing to write, for a reason that is the engine's and the product's at once.
No kind declares `acceptsRowWrites` or `acceptsSourceEdits`: the only way to change what Prometheus holds is its configuration files, its remote-write receiver or its admin API, and this product offers none of the three (#1085, section 2).
The absence is `prometheus`'s entry in `EXPECTED_EDIT_ABSTAINERS` (`tests/helpers/object-edit-expectation.ts`), and `tests/isolated/object-edit-declarations.test.ts` is what holds that entry and this section together.

---

## 7. Monitoring & health

Each surface reads the HTTP API only, and a surface that cannot give an honest number is left empty rather than filled.

| Method | Source | Notes |
|---|---|---|
| `getHealth()` | `/-/healthy` and `/-/ready`, then `buildinfo` | Driven by the answers, never by identifying the product: `/health` is tried only after a 404 from `/-/healthy`; the first probe answering neither 200 nor a `/-/healthy` 404 that the `/health` probe superseded is named with its path and status, and ends the read before `buildinfo` is sent; a 401 or 403 is an `AuthenticationError` |
| `getOverview()` | `buildinfo` (version), `runtimeinfo` (`startTime` and `serverTime`: uptime is the server's own clock minus its start time), `status/flags` (`web.max-connections`, a real `maxConnections`), `status/tsdb` (the metric count, M2) | `databaseSize` is "N/A" with `databaseSizeBytes` absent, because the API does not measure it; `tableCount` is the metric count and `indexCount` is 0; a server clock behind its start time reads the uptime "N/A"; a full label list that omits `__name__` refuses the overview with a `QueryError` rather than report a count it did not measure |
| `getPerformanceMetrics()` | none | `cacheHitRatio` is absent and the panel renders unavailable |
| `getTableStats()` | `/api/v1/status/tsdb?limit=`, `seriesCountByMetricName` | Real series counts for the top `TSDB_TOP_METRICS` (`50`) metrics by head series, with the size "N/A"; the Tables panel counts those rows as tables and does not say the list is cut, because that tab takes no provider labels; the endpoint truncates silently and refuses a `limit` above 10,000; a schema filter naming any schema but the empty one answers `[]` without a read |
| `getStorageStats()` | `status/tsdb` `headStats` (series, chunks, min and max time), `runtimeinfo.storageRetention` | One row named `Head block: N series, M chunks`, with the head span and the retention as its location, and "no samples" as the span of an empty head; size "N/A" with `sizeBytes` 0, because the type requires a number (`docs/BACKLOG.md` D105) |
| `getSlowQueries()`, `getActiveSessions()` | none | `[]`, with the empty-state sentences from `getLabels()` saying Prometheus publishes no query log and no session list over its HTTP API |
| `getIndexStats()` | none | `[]`: a Prometheus TSDB has no secondary index object to describe |
| `getPoolStats()` | not implemented | The route detects it by presence and shows its fallback |

The `operations` agent workflow reads these surfaces on every engine in both modes, so agent runs reach the monitored server through them too.

---

## 8. Maintenance

None.
`supportsMaintenance` is `false` and `maintenanceOperations` is empty, so `maintenanceControl()` places no control, and the required maintenance labels are never rendered.
A direct call of `runMaintenance` is refused with a `QueryError` saying that compaction and statistics are the server's own and that the admin API is never called.

---

## 9. Capabilities & labels

### `getCapabilities()` ([`index.ts`](../../src/lib/db/providers/timeseries/prometheus/index.ts))

- `queryLanguage: "promql"`, no `queryDialect`.
- `supportsExplain`, `supportsCreateTable`, `supportsTransactions`, `supportsMaintenance`, `supportsInlineRowEdit`, `supportsResultPagination`, `supportsExternalQueryLimiting`, `supportsConnectionString`: all `false`.
- `declaresForeignKeys: false`, `statementTerminator: "none"`, `defaultPort: 9090`, `containerLevels: []`, `maintenanceOperations: []`, and the six object kinds of [§6.1](#61-the-object-surface-789).
- `schemaRefreshPattern: "(?!)"`, the empty lookahead, which matches nothing: no PromQL statement changes what the tree shows, because the provider calls read endpoints only and the metric catalogue moves with what the server scrapes.

### `getLabels()` ([`index.ts`](../../src/lib/db/providers/timeseries/prometheus/index.ts))

`entityName` "Metric" and "Metrics", `rowName` and `rowNamePlural` "series" and "series", `selectAction` "Run Instant Query", `generateAction` "Generate Query", `statementLanguage` "PromQL", and the two empty-state sentences of [§7](#7-monitoring--health).
The maintenance labels carry PromQL-true wording although they are never rendered.

---

## 10. Error handling

Mapped from the envelope's `errorType`, not from the HTTP status, as Druid and Trino map from an engine category: the status is unreliable for classification (`canceled` answers 499 and `execution` 422, for example).

| `errorType` or condition | Class |
|---|---|
| `bad_data`, `execution` | `QueryError` |
| `timeout`, or the client-side timeout | `TimeoutError` |
| `canceled`, or a cancellation from `cancelQuery` or `disconnect()` | `QueryCancelledError` |
| `unavailable`, `internal` | `ConnectionError` |
| 401 or 403 with no envelope (web config basic auth, a proxy) | `AuthenticationError` |
| any 3xx | `ConnectionError` naming the status and the `Location` origin |
| TLS handshake or verification failure | `ConnectionError` carrying the Node error code |
| refused connection, reset, DNS failure | `ConnectionError` |
| a body that is not the API envelope (a proxy's HTML page, a 502) | `ConnectionError` that never quotes the body |
| a response past `RESPONSE_BYTE_CAP` | `QueryError` naming the cap |
| an overview whose metric count cannot be measured (M2) | `QueryError` |
| an invalid `host`, `port` or credential | `DatabaseConfigError` that never echoes the value |

An `errorType` this build does not know is carried verbatim as the transport error's category and becomes a `QueryError` carrying the engine's message (the default arm of `errors.ts`), which covers `not_found` and `not_acceptable` on v3.13.3.

---

## 11. Testing

### 11.1 How the tests work

| File | Owns |
|---|---|
| [`tests/integration/db/prometheus-provider.test.ts`](../../tests/integration/db/prometheus-provider.test.ts) | The provider end to end through the real composition; `globalThis.fetch` is replaced per test and restored in `afterEach`, with payloads captured from the live server |
| `tests/unit/db/prometheus/` | One file per module: `promql`, `transport`, `results`, `request` (real TLS handshakes against a local `node:https` server), `concurrency`, `http-transport` (every endpoint's exact URL), `monitoring`, `errors`, `objects`, `provider`, `provider-endpoint` (the endpoint the real composition builds, against a local server), `seam-guard`, and `provider-doc` (this document against the constants) |
| `tests/unit/editor/promql-language.test.ts` | The editor's tokenizer, its word lists pinned to the lexer and function tables captured at the tag |
| [`e2e/prometheus-provider.spec.ts`](../../e2e/prometheus-provider.spec.ts) | The connection dialog: the driver is selectable, `9090` is the default, no Database box renders, the password field's label and hint |

No `mock.module()` anywhere in this suite: it is process-wide in bun.
The captured payloads live in [`tests/fixtures/prometheus/v3.13.3/`](../../tests/fixtures/prometheus/v3.13.3/), and the fixture README says how each was taken.
The TLS private keys are committed as JWK JSON and converted to PEM at test start, because a PEM key trips the required Secret Scan.
[`tests/fixtures/tls/README.md`](../../tests/fixtures/tls/README.md) describes the set, and `tests/fixtures/tls/generate.sh` remakes it.

### 11.2 Run it

```bash
# Just this provider, one process per file
bun tests/run-tests.ts tests/unit/db/prometheus/promql.test.ts tests/unit/db/prometheus/results.test.ts tests/integration/db/prometheus-provider.test.ts

# Everything, CI-equivalent
bun run test
```

### 11.3 Reproducing the live pass

```bash
docker compose -f database-compose.yml up -d prometheus
docker compose -f database-compose.yml --profile prometheus-auth up -d prometheus-auth
curl -s 'localhost:9090/api/v1/query?query=up'
```

The configuration in `docker/prometheus/` produces every kind, status and identity edge above: a self-scrape job, an unreachable target, a target not scraped yet, two targets sharing an `instance`, a recording rule, a firing and a pending alert, two alerts with one name in one group, two files declaring a group of the same name, a UTF-8 label name, and metrics named like PromQL keywords.
`prometheus-auth` (port 9091) is the same image with basic auth, for the 401 path.

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from "@/lib/db/factory";

const provider = await createDatabaseProvider({
  id: "metrics",
  name: "Prometheus",
  type: "prometheus",
  host: "prometheus.monitoring.svc",
  port: 9090,
  // user + password: Basic. password alone: a bearer token.
});

await provider.connect();

const result = await provider.query("rate(prometheus_http_requests_total[5m])[30m:1m]");
console.log(result.fields, result.rows.length);

const metrics = await provider.listObjects([], "metric");
await provider.disconnect();
```

### 12.2 Over the API

```bash
curl -X POST http://localhost:3000/api/db/query \
  -H 'Content-Type: application/json' \
  -H 'Cookie: auth-token=<jwt>' \
  -d '{"connectionId":"seed:metrics-prom","sql":"up"}'
```

`seed:metrics-prom` is the Prometheus seed example of [`docs/SEED_CONNECTIONS.md`](../SEED_CONNECTIONS.md); an inline `connection` object works as well.
See [`docs/API_DOCS.md`](../API_DOCS.md) for the full request and response contract.

---

## 13. Known limitations & future work

- **No time-range picker and no `query_range`.**
  Ranges are written in PromQL ([§5.1](#51-the-call)); a picker is a maintainer decision not taken (2026-09-23).
- **No path prefix**, so Mimir, GreptimeDB and prefix-mounted proxies are out of reach ([§4.5](#45-no-connection-string)).
- **No AWS Managed Prometheus**: it needs SigV4 signing for the `aps` service.
- **No EXPLAIN**, because the only parse endpoint is experimental.
- **No agent execute mode for PromQL**, out of scope for the whole #424 epic; plan mode grounds through the object surface and drafts PromQL for the user to run.
- **On a server past `METRIC_LIST_CAP` metric names or `DESCRIBE_SERIES_CAP` series in the hour, plan mode grounds metrics only**, because the grounding walk stops at the metric folder's truncated batch (M7, `docs/BACKLOG.md` B84).
- **A listed metric whose series went quiet before the hour is left out of the bulk column read**, and the inventory carries it with no columns ([§6.1](#metric-columns), `docs/BACKLOG.md` D107).
- **The overview's metric count is unavailable only when a full list of `TSDB_LABEL_SCAN_LIMIT` label names omits the `__name__` entry** (M2), and a listed entry is the full count at any length of that list.
- **The export menu says it writes all the rows of a result the series cap cut** ([§5.4](#54-caps-warnings-and-truncation), `docs/BACKLOG.md` U42).
- **A column mixing numbers and `NaN` or `Inf` may chart as categorical** ([§3.7](#37-nan-and-inf-stay-strings-and-what-the-chart-does-with-them)).
- **Queries compete with the server's own rule evaluation** ([§3.4](#34-the-servers-query-slots-are-shared)).

---

## 14. References

- Source: [`src/lib/db/providers/timeseries/prometheus/`](../../src/lib/db/providers/timeseries/prometheus/)
- Editor language: [`src/lib/editor/promql-language.ts`](../../src/lib/editor/promql-language.ts)
- Design: [#1085](https://github.com/libredb/libredb-studio/issues/1085)
- Prometheus HTTP API: <https://prometheus.io/docs/prometheus/3.13/querying/api/>
- PromQL: <https://prometheus.io/docs/prometheus/3.13/querying/basics/>
- Upstream source read for the design, at tag `v3.13.3`: `web/api/v1/api.go`, `promql/parser/lex.go`, `promql/parser/functions.go`, `promql/engine.go`, `rules/group.go`, `scrape/target.go`, `tsdb/head_read.go`, `tsdb/querier.go`, `tsdb/index/postings.go`
