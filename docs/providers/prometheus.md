# Prometheus Provider

> Prometheus support for LibreDB Studio, over the Prometheus HTTP API (`/api/v1/*`, port `9090`) with **no driver dependency of any kind**.
> Every call is one HTTP request through the runtime's own `fetch`, or through `node:https` when TLS material is configured.
> This is the first provider to declare a `queryLanguage` of its own, `promql` beside `sql` and `json`: the editor sends PromQL to the server unchanged.
> This document is the single reference for the Prometheus provider: design, architecture, usage and tests.

`DB_HTTP_BLOCK_PRIVATE_HOSTS=true` blocks loopback, private, link-local and other non-public HTTP destinations; it is off by default so local connections work.

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
A surface counts as answering only where it passed and held data wherever Prometheus did, the rule that keeps ScyllaDB `partial` ([cassandra.md §11](./cassandra.md#11-scylladb-is-a-partial-relative-one-absent-keyspace-cost-five-surfaces-until-2026-08-24)).
So an empty folder does not count, and neither does the monitoring read or the object count when one of its panels or counts failed, and by that rule 20 of the 36 surfaces above the query rows answer here, where Prometheus answers all 36.
The metric, scrape pool and target reads ran on one named object that both servers hold, so the two columns compare the same thing: the metric `prometheus_http_requests_total`, the pool `prometheus` and a target of that pool.
The cancel row runs `sum(count_over_time(label_replace({__name__=~".+"}, "probe_name", "$1", "__name__", "(.+)")[1h:250ms]))` and cancels it 50 ms in, while it still runs on both servers.

| Surface | Prometheus 3.13.3 | VictoriaMetrics v1.152.0 |
|---|---|---|
| `connect` | answered | answered |
| `getHealth` | answered | answered |
| `getOverview` | answered | failed: `QueryError` The server does not serve /api/v1/status/flags: it answered HTTP 400 naming that path as unsupported, as VictoriaMetrics answers a Prometheus API path it does not implement. |
| `getPerformanceMetrics` | answered | answered |
| `getMonitoringData` | answered | answered, with its overview and storage panels failed on the 400s above |
| `getSlowQueries` | answered | answered |
| `getActiveSessions` | answered | answered |
| `getTableStats` | answered, 50 metrics | answered, 10 metrics |
| `getIndexStats` | answered | answered |
| `getStorageStats` | answered | failed: `QueryError` The server does not serve /api/v1/status/runtimeinfo: it answered HTTP 400 naming that path as unsupported, as VictoriaMetrics answers a Prometheus API path it does not implement. |
| `listContainers` | answered | answered |
| `countObjects` | answered | answered, with the scrape pool count unavailable on the `listObjects:scrape_pool` message |
| `listObjects:metric` | answered | answered |
| `describeObject:metric` | answered | answered |
| `describeObjects:metric` | answered | answered |
| `readObjectSource:metric` | answered | answered, with no `unit` |
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
| `listObjects:scrape_pool` | answered | failed: `QueryError` The server does not serve /api/v1/scrape_pools: it answered HTTP 400 naming that path as unsupported, as VictoriaMetrics answers a Prometheus API path it does not implement. |
| `describeObject:scrape_pool` | answered | skipped: listObjects did not list the scrape pool prometheus to describe |
| `describeObjects:scrape_pool` | answered | answered |
| `readObjectSource:scrape_pool` | answered | skipped: listObjects did not list the scrape pool prometheus to read |
| `listObjects:target` | answered, one target down and one unknown | answered, two targets down |
| `describeObject:target` | answered | answered |
| `describeObjects:target` | answered | answered |
| `readObjectSource:target` | answered | answered, with no `scrapeInterval` or `scrapeTimeout` |
| `query:vector` | answered | answered |
| `query:matrix-range` | answered | answered |
| `query:matrix-subquery` | answered, 30 rows on whole minutes | answered, 31 rows counted back from the evaluation time |
| `query:scalar` | answered | answered |
| `query:string` | answered | answered, empty |
| `query:notice` | answered, with the engine's PromQL info | answered, with no notice |
| `query:bad-data` | refused as expected: `QueryError` | refused as expected: `QueryError` |
| `query:comment-only` | refused as expected: `QueryError` | refused as expected: `QueryError` |
| `query:bound-params` | refused as expected: `DatabaseConfigError` | refused as expected: `DatabaseConfigError` |
| `cancelQuery:long-query` | cancelled as expected: `QueryCancelledError` | cancelled as expected: `QueryCancelledError` |

**The editor and the metric tree work as they do on Prometheus.**
Instant vectors, range selectors, subqueries and scalars answer, a subquery on timestamps of its own (below).
The three refusals (a parse error, a buffer holding only `#` comments, bound values) end in the same classes, and Cancel ends a running query as cancelled.
A metric's columns are the same on both servers: `prometheus_http_requests_total` has `__name__`, `code`, `handler`, `instance`, `job`, `timestamp` and `value` on each.

**The Overview and Storage tabs and the Scrape pools folder fail, on three endpoints VictoriaMetrics does not serve.**
`/api/v1/status/runtimeinfo`, `/api/v1/status/flags` and `/api/v1/scrape_pools` answer `400` with the plain text `unsupported path requested: "<the path>"`.
The overview reads the first two at once, beside the build and TSDB status reads, so its message names whichever of the two answered first, which can differ from one call to the next: `getOverview` named `/api/v1/status/flags` in the pass above, as the overview panel of the monitoring read did, and `/api/v1/status/runtimeinfo` in an earlier pass the same day.
The storage row reads the first, and the Scrape pools folder the third, whose count then reads unavailable with the folder's message.
The storage row also needs the head statistics, which the TSDB status below does not carry, and the provider refuses a status without them as unmeasured rather than show an empty head (`storageStatsFrom` in `monitoring.ts`).
Each of the three refusals is the server's own answer, so each is a `QueryError` saying the server does not serve that path, not a `ConnectionError`, which would read as a server Studio could not reach.
The transport reads a `400` that way only when its whole body is VictoriaMetrics' text for the path the request was sent to, `unsupported path requested: "<the path>"` and a newline (`unsupportedPathText` in `http-transport.ts`); a `400` with any other body, which a proxy or a login page answers too, stays the `ConnectionError` of [section 10](#10-error-handling).
The class and message in those three rows are re-read on 2026-10-31 against the same image by digest, after the classification changed, where the overview named `/api/v1/status/runtimeinfo`, the other of its two paths; every other row is the 2026-09-23 pass.
On the agent path the refusals are a reason rather than a failure ([section 14.4](#144-values-and-what-each-path-reads)).

**Three documents lack a member Prometheus sends, and are read without it.**
Each of those members only describes its object, so the provider reads the document without it and puts nothing in its place, while a member that identifies or classifies an object stays required (`transport.ts`).
The TSDB status holds VictoriaMetrics' own statistics (`totalSeries`, `totalLabelValuePairs`, `seriesCountByMetricName` and four more) and no `headStats`, and it cuts its ranked lists at `topN`, not `limit`: `limit=3` and `limit=50` each answered its default ten, and `limit=50&topN=50` answered fifty (measured 2026-09-27, `tsdb-status-50-topn.json`).
The provider sends the cut under both names, and Prometheus ignores `topN`: its four ranked lists read the same with it and without it.
So the Tables tab lists up to fifty metrics here, as on Prometheus, and 49 of the fifty series counts matched Prometheus's for the same metric; `prometheus_engine_query_duration_seconds` read 9 series here and 12 there.
A metadata entry carries `type` and `help` and no `unit`, so a metric's Source tab shows the family, its type and its help and no unit, where Prometheus sends `"unit": ""`.
A target carries no `scrapeInterval` and no `scrapeTimeout`, and keeps them as `__scrape_interval__` and `__scrape_timeout__` among its discovered labels, so the Targets folder lists all five targets and a target's Source tab leaves the two members out, while its discovered labels show both.

**A target not yet scraped reads as down.**
`studio-unscraped`, the fixture's target scraped once a day, answered `"health":"down"` with `"lastError":""` and `"lastScrape":"1970-01-01T00:00:00Z"`, where Prometheus answered `"health":"unknown"` and `"lastScrape":"0001-01-01T00:00:00Z"`.
So the Targets folder marks two targets down, where Prometheus marks one down and one unknown.

**The rule folders are empty, and that is the deployment rather than a defect.**
A single-node server evaluates no rules: alerting and recording rules belong to vmalert, and `/api/v1/rules` answers from vmalert only when the server is started with `-vmalert.proxyURL`.
Here it answered `{"status":"success","data":{"groups":[]}}`, so the rule group, recording rule and alerting rule folders open onto nothing, and a question about alerts has nothing to read here.

**A string expression returns no rows.**
`"libredb"` answers an empty vector, `{"resultType":"vector","result":[]}`, where Prometheus answers a `string` result, so the grid shows nothing.

**A subquery's points are counted back from its evaluation time.**
`avg_over_time(up[5m])[30m:1m]` answered 30 rows on Prometheus, the first at `17:08:00.000`, and 31 here, the first at `17:07:34.000`, thirty minutes before the evaluation time.
Asked of both servers at one explicit time, `2026-09-23T17:34:36.5Z`, `avg_over_time(up{job="prometheus"}[5m])[30m:1m]` answered 30 points from `17:05:00.000` to `17:34:00.000` on Prometheus, on whole multiples of the step, and 31 from `17:04:36.500` to `17:34:36.500` here, each a whole step back from that time with both ends of the window kept.
The grid and the chart show the points the engine sent, so the same subquery gives one more row here, on different timestamps.

**No PromQL info or warning appears.**
VictoriaMetrics answered `rate(up[5m])` with no notice where Prometheus 3.13.3 attaches `PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "up" (1:6)`, and none of the 69 answers captured from it in `tests/fixtures/prometheus/victoriametrics-v1.152.0/` carries one either.
It also ignores `limit` on `/api/v1/query`: `limit=1` returned all four `up` series, so the series cap is applied by this provider alone, once the answer has arrived ([§5.4](#54-caps-warnings-and-truncation)).

**No panel shows a version.**
`/api/v1/status/buildinfo` answers `2.24.0`, the Prometheus version VictoriaMetrics advertises for Grafana, which is why the registry records the build as `VictoriaMetrics v1.152.0 (advertises Prometheus 2.24.0)`.
Its own build, `v1.152.0`, is in its `/metrics` as `vm_app_version`, which the provider does not read, and the overview, the one panel that would show a version, fails as above.

The relative is claimed for PromQL only: nothing written in MetricsQL, VictoriaMetrics' own query language, was measured.
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
Every reader was classified when the union widened (#1085, section 3.2): the editor has a `promql` tab type and a Monarch tokenizer (`src/lib/db/providers/timeseries/prometheus/editor-syntax.ts`), the two generators have a PromQL arm built through `promql.ts`, and the profile route refuses a language it cannot profile.
On a metric row both row menus withhold Profile and Code Generator, through `offersColumnProfiling` and `offersCodeGeneration`, which offer neither for `promql`, and Generate Test Data, because no kind declares `acceptsRowWrites`; the tree's menu for a metric keeps Generate Query and View Source.
Both menus also withhold Generate Count Query, through `offersCountQuery` (#702): PromQL's `count()` counts series at an instant, which is not the row count that action promises.
A plan-mode draft is fenced with the canonical type-id, `prometheus`, which `ENGINE_FENCE_TAGS` accepts; a block tagged `promql` is accepted too, and that alias names the `prometheus` type-id (`ALIAS_ENGINES` in `src/lib/sql/fence-tags.ts`), because every PromQL server this product reaches, VictoriaMetrics included, connects through it.
So a `promql` block is not the statement of a plan run on another engine, the rule a `mysql` block on a PostgreSQL run already follows.
Widening a published union breaks an external consumer's exhaustive switch over it, and that ships with a release note rather than a compatibility layer.

### 3.2 One PromQL builder

The v3.13.3 lexer matches keywords and aggregators case-insensitively and lexes `inf` and `nan` as numbers, so a legal metric named `nan` evaluates as a scalar.
Every word of the lexer's `key` table, with `inf` and `nan`, was sent bare and as `{__name__="<word>"}` in each context this provider writes a selector in: alone, followed by `[5m]`, inside `count(...)`, inside `rate(...[5m])[1h:1m]`, and upper-cased alone (fixture README, "The lexer's reserved words (#1085 S4)").
On Prometheus 3.13.3 the bare form did not answer like `{__name__="<word>"}` in some context for: `atan2`, `bool`, `group_left`, `group_right`, `ignoring`, `inf`, `nan`, `on`; it did in every context for: `anchored`, `and`, `avg`, `bottomk`, `by`, `count`, `count_values`, `end`, `fill`, `fill_left`, `fill_right`, `group`, `limit_ratio`, `limitk`, `max`, `max_of`, `min`, `min_of`, `offset`, `or`, `quantile`, `range`, `smoothed`, `start`, `stddev`, `stdvar`, `step`, `sum`, `topk`, `unless`, `without`.
So a metric named `sum` selects bare on this version, which #1085 S4 had expected to fail to parse.
`PROMQL_RESERVED_WORDS` is the lexer's whole `key` table plus `inf` and `nan`, a superset of the words whose bare form differs, pinned by a test to that table as captured at the tag (`tests/fixtures/prometheus/v3.13.3/lexer-words.json`).
So `promql.ts` writes the bare selector only for a legacy name (`^[a-zA-Z_:][a-zA-Z0-9_:]*$`) whose lowercase form is not in that set, which is where every parser this provider meets reads it as a metric; every other name becomes `{__name__=<its PromQL string>}`, which parses on 2.x, 3.x and MetricsQL.
A PromQL string is `JSON.stringify` of the text with one exception: a U+FFFD in a name is written as the escape `\ufffd` (backslash, u, f, f, f, d), because the v3.13.3 lexer reads a literal U+FFFD as an invalid rune; every other character is exactly what `JSON.stringify` writes, and `JSON.parse` reads the string back to the same text.
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
Neither bounds the result the query route sends, because every row repeats every field name, so the rows and fields of a vector or a matrix are also held to `RESULT_BYTE_BUDGET` bytes of JSON (M14, [§3.8](#38-measurements)): 500 series carrying 25 label names of their own are about 200 KB on the wire and, whole, 500 rows of 12,502 fields.

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
A header value containing a line feed makes `fetch` throw a `TypeError`, whose message contained the whole header through Bun 1.4.2 (from 1.4.4 it names only the header), and error messages reach both the log and the client.
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
The grid shows them as the engine wrote them, by maintainer decision (#1085, section 5.3): a `null` in their place would claim the series had no sample there.
The chart tab reads them otherwise: it types a column as numbers when more than 80% of its filled cells are numbers (`analyzeField` in `src/components/DataCharts.tsx`) and draws each cell of such a column that is not a number at 0, so a `NaN` or `Inf` among numbers is drawn at 0, and so is a `null`, an instant with no sample ([§5.2](#52-result-shaping)).
A column whose strings are 20% or more of its filled cells is not typed as numbers and is not offered as a series.
It is typed categorical only while it holds at most 50 distinct values, each number and each of `NaN`, `+Inf` and `-Inf` counted once, and only then does the first categorical column in field order replace `timestamp` as the chart's default x axis; past 50, as in a mostly-`NaN` latency ratio over `[6h:1m]`, it is typed unknown and `timestamp` stays the default.
An answer with no numeric column draws no chart.
Filtering the non-finite values in PromQL (`x > -Inf < +Inf`, or `x == x` for `NaN`) takes them out of the answer, which keeps a single series a line with no row at those instants, while in a matrix of several series each filtered cell holds `null` and is drawn at 0 as well.
The chart is unchanged by #1085, and `docs/BACKLOG.md` U44 records its zeros.

### 3.8 Measurements

Every number below was decided by the measurement its last column names: M7's limit is read from the code, and every other entry is recorded in [`tests/fixtures/prometheus/README.md`](../../tests/fixtures/prometheus/README.md), section "Measurements", taken against the compose `prometheus` service, except M14, which ran the provider itself in the image's runtime.
The constants are read by [`tests/unit/db/prometheus/provider-doc.test.ts`](../../tests/unit/db/prometheus/provider-doc.test.ts), so a row that disagrees with the code fails the build, and so does a measured constant whose recorded decision names another value.

| Item | What it decides | Value | Where it was measured |
|---|---|---|---|
| M1 | Whether `cancelQuery` exists | Observed: aborting a long query ended its evaluation on the server, so the method exists ([§5.5](#55-timeout-and-cancellation)) | Fixture README, M1 |
| M2 | The overview's metric count | The head block's distinct metric names: the value of the `__name__` entry of `labelValueCountByLabelName` in `/api/v1/status/tsdb`, read with `TSDB_LABEL_SCAN_LIMIT` (`10000`); that value is exact whenever the entry is listed, at any length of the list, because the endpoint cuts only the list and each kept entry carries its label's full count; absent from a list shorter than the limit it is `0`, an empty head; and only when a full list of that many label names omits it is the overview refused as unmeasurable; never a capped list's length | Fixture README, M2 |
| M3 | The wide matrix's cell budget | `MATRIX_SAMPLE_BUDGET` = `250000` cells of the wide grid, distinct instants times kept series; for a stepped subquery, whose series share their instants, the cells are about its samples | Fixture README, M3 |
| M5 | Credentials the server does not need | A stock server with no web config answers 200 with a bogus credential and with none; with basic auth configured, a wrong credential answers 401 with `WWW-Authenticate: Basic` and the plain-text body `Unauthorized` | Fixture README, M5 |
| M7 | Whether plan mode grounds every kind within the provider path's bounds | Not on a large server: the grounding walk stops at the first truncated `describeObjects` batch, and the metric batch, the first the walk reads, is truncated past `METRIC_LIST_CAP` metric names or `DESCRIBE_SERIES_CAP` series in the hour, so plan mode there grounds metrics only (`docs/BACKLOG.md` B84); the compose server is far below both caps, which is why the limit is recorded from the code | `walkObjectInventory` in `src/lib/agent/tools.ts`, and the PR's live plan run |
| M8 | How truncation is detected from the server | Prometheus sends the warning `results truncated due to limit` for `/api/v1/query`, the label values and the series listing when a `limit` bites; where no warning arrives, receiving more items than the cap (each read asks for cap + 1) is the signal | Fixture README, M8 |
| M10 | The metric list cap | `METRIC_LIST_CAP` = `2000` names: it bounds the one label-values read that lists metrics, and past it the tree's Metrics count is a floor, badged `2,000+`; it keeps plan mode no room for the other kinds, because past it the metric batch, bounded at the listing's length, is marked truncated and the grounding walk stops there, so on a server with 2,001 to 4,999 names and at most `DESCRIBE_SERIES_CAP` series in the hour it is this cap, not the inventory's budget of 5,000 objects, that leaves plan mode with metrics only (M7, `docs/BACKLOG.md` B84) | Fixture README, M10 |
| M11 | Queries in flight per connection | `QUERY_CONCURRENCY_LIMIT` = `4`: with four heavy queries in flight for 60 s, every rule group kept its evaluation interval and no iteration was missed | Fixture README, M11 |
| M12 | The response byte cap | `RESPONSE_BYTE_CAP` = `33554432` bytes (32 MiB) | Fixture README, M12 |
| M13 | The series cap of a whole-folder describe | `DESCRIBE_SERIES_CAP` = `20000` series | Fixture README, M13 |
| M14 | The result byte budget | `RESULT_BYTE_BUDGET` = `16777216` bytes of rows and fields as JSON: each answer shaped against it completed through the provider in the image's runtime, under its 384 MiB heap and the chart's `512Mi` memory limit, while three quarters of the heap was held live; the bodies of responses waiting to be sent are outside it, and nothing bounds how many wait (`docs/BACKLOG.md` D112) | Fixture README, M14 |

### 3.9 Shared records with no `prometheus` entry, and why

Adding the type-id meant classifying every hit of the three searches `docs/ADDING_A_PROVIDER.md` names.
The exhaustive records all have an entry, because the compiler refuses one without it.
These partial records deliberately have none:

| Record | Where | Why there is no entry |
|---|---|---|
| `export.ddlTypes` (`STANDARD_DDL_TYPES`) | `src/lib/db/providers/timeseries/prometheus/sql-writing.ts` | An export's column types map SQL DDL spellings; PromQL has no DDL, so the standard spellings stand |
| The engine overlays' `catalogCapture` | `src/lib/agent/languages/sql/engines/` | Plan mode grounds Prometheus through the provider's own object surface, not through composed catalog statements |
| The engine overlays' `catalogRead`, `planEstimate` | `src/lib/agent/languages/sql/engines/` | They are SQL composers; agent mode reads Prometheus in its own `promql` statement language ([§14](#14-agent-mode)), which composes no catalog read and no estimating plan |
| The engine overlays' `statistics` | `src/lib/agent/languages/sql/engines/` | Prometheus holds no table statistics a run knows how to read; its series counts are TSDB top-N figures, not estimates |
| `ENGINE_URI_SCHEMES` | `src/lib/db/connection-string/index.ts` | No connection string ([§4.5](#45-no-connection-string)) |
| `createTable` | `src/lib/db/types.ts` (`CreateTableSpec`) | Only engines that declare a `createTable` reach the Create Table form; Prometheus declares none |
| `SQL_GRAMMAR` | `src/lib/db/sql-grammar/` | PromQL is not SQL, and the `prometheus` row declares `readsSqlText: false` ([§5.7](#57-sql-grammar)). Nothing on the run path reads PromQL under a SQL grammar: the confirmation gate answers from the `prometheus` row of `NON_SQL_DESTRUCTIVE_VOCABULARY` before any SQL reading ([§5.1](#51-the-call)), the multi-statement route is taken only where `queryLanguage` is `sql`, and the provider's own `prepareQuery` returns the text unchanged |

`src/lib/sql/identifier.ts` is a `switch` with a `default` and needs no case.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Used | Notes |
|---|---|---|
| `host` | Yes | A hostname or an IP literal; anything carrying URL syntax is refused before any request (#1085 S1) |
| `port` | Yes | Default `9090` |
| `user` | Optional | Labelled "User" in the dialog. Selects Basic authentication ([§4.2](#42-authentication)) |
| `password` | Optional | Labelled "Password or token" in the dialog, with the hint "Leave User empty to send this as a bearer token." |
| `database` | No | No Database box renders: a Prometheus server is one TSDB, so there is nothing to select |
| TLS panel | Yes | [§4.4](#44-tls) |

The two dialog strings are declared on the `prometheus` entry of `CONNECTION_FORM` in `src/lib/db/connection-form.ts` (`fieldLabels`, `fieldHints`) rather than chosen by a type test in the dialog.
Every engine's dialog labels, placeholders and hints come from that declaration.
No new `DatabaseConnection` field exists, so the bearer token rides `password`, which the connection store already classifies as a secret.

### 4.2 Authentication

| `user` | `password` | Header sent |
|---|---|---|
| set | set | `Authorization: Basic` over `user:password`. This is Grafana Cloud's scheme for its hosted Prometheus, with the instance id as the user and an access-policy token as the password, but its query API sits under a path prefix, so this version cannot reach it ([§4.5](#45-no-connection-string)) |
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
`tests/unit/db/prometheus/provider.test.ts` repeats four of them through the provider's own composition, with nothing injected, so the panel is proven to reach that request function.

### 4.5 No connection string

`showConnectionStringToggle: false`: `http://` and `https://` already parse as ClickHouse through its connection string row, and two engines cannot own one scheme.
There is no path-prefix field either, so Grafana Mimir (`/prometheus`), Grafana Cloud's hosted Prometheus (its query URL ends in `/api/prom` or `/prometheus`), GreptimeDB (`/v1/prometheus`) and proxies that mount the API under a prefix are not reachable in this version (maintainer decision, 2026-09-23).
The host field cannot carry the prefix instead: a host holding `/` is refused before any request is sent.

### Connection string

`prometheus` has no connection string scheme, no `readTls`, no `paste` and no seed load check: every field of its row in `CONNECTION_STRING` is `null` ([`connection-string.ts`](../../src/lib/db/providers/timeseries/prometheus/connection-string.ts)).

### Execution UI

The rolled-back notice names `COMMIT` as the keyword that keeps an open transaction, and `prometheus` has no consent deadline, so the agent's consent card shows no deadline chip or sentence for it.
Its row in `EXECUTION_UI` is declared in [`execution-ui.ts`](../../src/lib/db/providers/timeseries/prometheus/execution-ui.ts).
What a tree click and Generate Query write is `PROMQL_GENERATORS`, the `promql` row of `LANGUAGE_GENERATORS`, declared in [`generators.ts`](../../src/lib/db/providers/timeseries/prometheus/generators.ts) and read by the engine-agnostic dispatcher in `src/lib/query-generators.ts`.
Its editor language, `promql`, is the row in `EDITOR_LANGUAGES` declared in [`editor-language.ts`](../../src/lib/db/providers/timeseries/prometheus/editor-language.ts): how the editor registers and tints it, and its completion source and formatter where it has one.

---

## 5. Query interface

### 5.1 The call

The editor text goes to `POST /api/v1/query` as a form body (`query`, `timeout` in seconds, `limit`) with no `time` parameter, so the server evaluates at now.
`#` comments are PromQL syntax and are sent as written.
A text that is empty once comments and whitespace are removed is refused before any request, with a `QueryError` saying so.
A comment runs to the next `\r` or `\n`, as the lexer reads it, so a Unicode line separator inside one does not end it.
Bound `params` are refused with a `DatabaseConfigError`: PromQL has no binding, and ignoring them would run a different statement from the one the caller built.
Ranges are written in PromQL itself: `x[1h]` returns raw samples and `rate(x[5m])[1h:1m]` a stepped series; there is no `query_range` path.
`supportsResultPagination` and `supportsExternalQueryLimiting` are both `false`, as on Redis and MongoDB.

A row click in the tree runs the metric's selector as an instant query, the action the labels name "Run Instant Query".
Generate Query writes that selector as the one runnable line, below the two range forms as `#` comments, so the buffer run whole is exactly one expression.
The execution confirmation gate never asks on a Prometheus connection.
PromQL has no statement that writes, and editor text only ever reaches `POST /api/v1/query`, so the `prometheus` row of `NON_SQL_DESTRUCTIVE_VOCABULARY` (`src/lib/db/providers/timeseries/prometheus/destructive.ts`, collected in `src/lib/db/destructive-commands.ts`) names no operation and is the gate's whole answer.
The gate's SQL keyword test, which still reads a MongoDB or Redis buffer first, never reads PromQL: a metric may legally be named `update`, `delete` or `drop`, and read as SQL its bare selector is a write.
On a PromQL tab there is no formatter: no Format button, no Format SQL entry in the editor's menu, and the format shortcut does nothing.
In the standalone app the run shortcut on a PromQL tab sends the selection when there is one and otherwise the whole buffer, never cut at a `;`.
In the embedded `StudioWorkspace` the run shortcut, the Run Query menu entry and Run Selected reach no listener, so only the toolbar Run sends, and it sends the whole buffer (`docs/BACKLOG.md` U47).
Both shells type a Prometheus connection's tabs from its declared `queryLanguage`, the embedded `StudioWorkspace` as the standalone app does, and the editor reads its shortcuts' handlers when one is invoked, so a tab mounted before the connection's capabilities arrived behaves as a PromQL tab once it is one.
The editor's tokenizer (`src/lib/db/providers/timeseries/prometheus/editor-syntax.ts`) colours a `#` comment wherever the lexer starts one: at the top level, inside `{}` and inside a range's `[]`; inside a raw string, between backticks, a `#` is text.

### 5.2 Result shaping

| Data type | Rows | Fields |
|---|---|---|
| `vector` | one per series | `__name__` first when present, the remaining label names sorted, then `timestamp`, `value` |
| `matrix` | one per timestamp (wide) | `timestamp`, then one column per series |
| `scalar` | one | `timestamp`, `value` |
| `string` | one | `timestamp`, `value` |

A label literally named `timestamp` or `value`, or a label name that is not a legacy identifier such as `service.name`, becomes the field `JSON.stringify(name)`, so the fields stay unique; the same function (`vectorFieldNames`) names a metric's columns in the tree, so the tree and the grid agree.
Two answers are refused as protocol failures, a `ConnectionError`, rather than shaped: a vector series that does not hold exactly one point, and a matrix holding two series with one label set, because neither is an answer of a shape this build reads.
A wide matrix names each series column by the labels that distinguish it from the other series kept, in PromQL label notation (`{job="api"}`).
A series a bound leaves alone is named by the labels that tell it from every series of the answer, so the grid still says which one it shows; only an answer that held one series names its column `value`.
When that name, written in every row, would take the grid past `RESULT_BYTE_BUDGET` while `value` would not, the series is kept under `value` instead, and a notice names it once, in the same notation, with the budget.
The rows are the sorted union of every series' timestamps, and a series with no sample at one holds `null` there, so a raw range selector gives sparse rows and a stepped subquery aligned ones.
The wide shape is what lets the existing chart tab draw each series as its own line with no change to the chart.
For a stepped subquery whose series have a sample at every step, it charts as lines over the timestamps without false zeros: the tab opens on the first series, more are added from the Y-Axis menu, one line each, and at most eight, the palette's size (`MAX_SERIES` in `src/components/DataCharts.tsx`), are drawn at once, past which it says "Showing first 8 of N series".
The chart tab draws a `null` at 0, though ([§3.7](#37-nan-and-inf-stay-strings-and-what-the-chart-does-with-them)), so a raw range over targets scraped at their own offsets, whose rows each hold few of its series' samples, charts the rest at 0 on each row, and a series that starts or stops inside a subquery's window drops to 0 where it has no sample.
Measured through the provider's shaper and the chart's own mapping, `up[5m]` from the compose server shaped into 29 rows of 4 series with 87 of its 116 cells `null`, each drawn at 0, which for `up` reads as a target that was down; `docs/BACKLOG.md` U44 records it.

### 5.3 Value encoding

- Timestamps are float seconds on the wire and ISO-8601 UTC strings with millisecond precision in the grid, which the chart tab recognises as dates.
- Finite values are numbers; `NaN`, `+Inf` and `-Inf` are strings ([§3.7](#37-nan-and-inf-stay-strings-and-what-the-chart-does-with-them)).
- A native histogram stays `{count, sum, buckets}`, rendered by the grid's JSON cell.
- A `string` result's value stays its text, `"42"` included.

### 5.4 Caps, warnings and truncation

- Series are capped at `DEFAULT_QUERY_LIMIT` (500) for vector and matrix alike, sent as `limit` one above the cap (501), so a cut is seen even when the engine drops its own notice among more than ten annotations; at most 500 series are shown, and the cap is enforced locally as well, because only Prometheus 3.2.0 and later honour `limit`.
- The series notice names an exact total only when the server sent more series than it was asked for; otherwise it says "more than" the number shown, because the server's own cut carries no total.
- A wide matrix is also held to `MATRIX_SAMPLE_BUDGET` cells (M3), distinct instants times kept series, because a raw range over targets scraped at their own offsets gives nearly every sample its own row; whole series are kept in engine order while they fit, and the notice names the kept and total series and cells.
- The rows and fields of a vector or a matrix are held to `RESULT_BYTE_BUDGET` bytes of JSON as well, counted exactly before any row is built, because every row repeats every field name; whole series are kept in engine order while they fit, a vector's fields are the label names of the series kept, and the notice names the kept and offered series and the budget.
  A matrix's column names are counted as they are written, and a series kept alone is named against the whole answer ([§5.2](#52-result-shaping)), which can cost more than two series named among themselves, so two or more series are kept while they fit, one only when no two fit, under its name or else under `value`, and none only when even `value` does not fit.
  The budget was measured in the image's runtime, under its 384 MiB heap (`--max-old-space-size=384` in the `Dockerfile`) and the chart's `512Mi` memory limit (M14, [§3.8](#38-measurements)), and M3's representative subquery takes 14,346,726 bytes of it at the compose server's label sets, so on a server with longer label sets that subquery is cut by bytes while its 30,000 cells are far below the cell budget.
- A truncated result carries a `QueryWarning` naming what was cut and how much, and reports itself limited on its own `pagination`, `wasLimited: true` with `hasMore: false`, which `POST /api/db/query` keeps (#1085, section 5.4).
  So the stats strip shows the "limited" badge, whose sentence, "Studio bounded this result. Anything beyond the bound is not in it.", names neither rows nor fetching, because these bounds leave out whole series, which in a matrix are columns, and the cell and byte budgets leave out series the provider already received; no next page is offered, because the cut is this provider's own bound and no offset advances it.
  The export menu over such a result says it writes the rows shown and that the result was cut.
- The envelope's `warnings` and `infos` (for example "metric might not be a counter") become `QueryWarning` entries in the engine's own words, ahead of this provider's own.

### 5.5 Timeout and cancellation

The configured query timeout is sent as the `timeout` parameter, which the server caps at its own `--query.timeout` (default `2m`), and is enforced on the client with an `AbortSignal` as well.
It covers the request, not the wait before it: a query waiting for one of the connection's `QUERY_CONCURRENCY_LIMIT` slots ([§3.4](#34-the-servers-query-slots-are-shared)) has no timer of its own, and starts its timeout only once it holds a slot.
The wait still ends, because each query ahead of it finishes or times out: measured on 2026-09-24 against a server that never answered, nine queries sent at once under a 2-second timeout ended at 2, 4 and 6 seconds, four at a time.
The reported execution time leaves the wait out on purpose, so it measures the server.
`cancelQuery(queryId)` aborts that query's request.
Prometheus derives the evaluation context from the HTTP request and checks it at fixed points during evaluation, so an abort ends the evaluation at the next checkpoint.
That was observed on the live server before the method was added (M1): the `prometheus_engine_queries` gauge fell back once the request was aborted, and the aborted query's own query-log line recorded it as canceled.
Both the cancel route and the query route detect cancellation by presence (`supportsQueryCancel` in `src/lib/db/query-cancel.ts`), which is why the method exists only because that measurement held.

### 5.6 EXPLAIN

None: `supportsExplain` is `false`, and the plan view is not offered.

---

### 5.7 SQL grammar

How this engine's statement text is read is declared once, in [`src/lib/db/providers/timeseries/prometheus/sql-grammar.ts`](../../src/lib/db/providers/timeseries/prometheus/sql-grammar.ts), the `prometheus` row of the SQL grammar registry in `src/lib/db/sql-grammar/`.
`readsSqlText` is `false`: `prometheus` takes a PromQL expression (#1085), whose strings escape with a backslash, so a SQL span reader reads `'it\'s'` as a literal that never closes, the false prompt #297 measured on Redis; the provider extends `BaseDatabaseProvider`.
The confirmation gate therefore answers from this engine's row of `NON_SQL_DESTRUCTIVE_VOCABULARY` (`src/lib/db/providers/timeseries/prometheus/destructive.ts`, collected in `src/lib/db/destructive-commands.ts`) instead of a SQL reading.
Its grammar is `DEFAULT_SQL_GRAMMAR`, the compatibility default, since no SQL grammar of its own applies to this text.
Redaction is `none`: a redacted statement is stored as `?`, because a reader guessing where a literal ends in a language it does not read can store the literal.

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
`scrape_pool` declares `countIsListing`, since its count is its listing: where the count was refused, as VictoriaMetrics refuses `/api/v1/scrape_pools`, the agent's grounding walk sends no listing and carries the refusal as the kind's reason, so the inventory keeps every other kind.
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
| TSDB | `GET /api/v1/status/tsdb?limit&topN`, both the same cut: Prometheus reads `limit`, VictoriaMetrics `topN` |

### 6.2 Object source (#789)

Every source is JSON, serialised with `JSON.stringify`, `language: "json"`, `form: "complete"`, `origin: "rendered"`, whose shipped caption, "A structured definition, rendered here as JSON", is true of it.
Server text is data: a rule annotation, a HELP string or a target error is shown exactly as the server sent it and cannot forge structure.

| Kind | Read | Parts |
|---|---|---|
| `metric` | metadata by the exact name, then by the family name with `_bucket`, `_sum`, `_count`, `_total` or `_created` removed | One part per distinct metadata entry (`family`, `type`, `help`, and `unit` only where the engine sends one); past the `SOURCE_PART_LIMIT` (`8`) parts the source route accepts, parts 1 to 7 are single entries and part 8 is one JSON array holding the rest, so nothing the engine answered is dropped; with none, a refusal part that reads "The server holds no metadata for this name: metadata is collected per metric family from active scrape targets, so recording-rule outputs, ALERTS and classic histogram series have none." |
| `rule_group` | the rules listing entry (`exclude_alerts=true`), which already carries every field the source renders | `file`, `name`, `interval`, `limit`, `evaluationTime`, `lastEvaluation`, the rule count |
| `recording_rule` | the rules listing entry (`exclude_alerts=true`), which already carries every field the source renders | `name`, `query`, `labels`, `health`, `lastError`, `evaluationTime`, `lastEvaluation` |
| `alerting_rule` | the listing entry for the definition, then `rule_group[]`, `file[]` and `rule_name[]` without `exclude_alerts` for its live alerts, the rule picked by its occurrence among same-named rules | Part 1, the definition (`name`, `query`, `duration`, `keepFiringFor`, `labels`, `annotations`, `health`, `lastError`); part 2, the live `state` and the active alerts |
| `scrape_pool` | the pools listing, which decides that the pool exists, then the pool's active targets | Target counts by health |
| `target` | the pool read | `scrapeUrl`, `health`, `lastError`, `lastScrape`, `lastScrapeDuration`, `scrapeInterval` and `scrapeTimeout` where the engine sends them, `labels`, `discoveredLabels` |

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
| `getTableStats()` | `/api/v1/status/tsdb?limit=&topN=`, `seriesCountByMetricName` | Real series counts for the top `TSDB_TOP_METRICS` (`50`) metrics by head series, with the size "N/A" beside the 0 the required `totalSizeBytes` carries (`docs/BACKLOG.md` D105); the provider's `tableStatsCaption`, "The metrics with the most head series, at most 50", heads the Tables tab, which then counts the rows as listed, under "Listed" rather than "Tables", and answers a search that matches none of them with "No listed table matches the search."; the caption heads the admin Operations list the same way, which then titles the rows "Listed (N)" rather than "Tables (N)" and answers a filter that matches none of them with "No listed table matches the filter."; it heads the agent's table-stats reading too, which hands a model that 0 as each row's `totalSizeBytes`; the endpoint truncates silently and refuses a `limit` above 10,000; a schema filter naming any schema but the empty one answers `[]` without a read |
| `getStorageStats()` | `status/tsdb` `headStats` (series, chunks, min and max time), `runtimeinfo.storageRetention` | One row named `Head block: N series, M chunks`, with the head span and the retention as its location, and "no samples" as the span of an empty head; size "N/A" with `sizeBytes` 0, because the type requires a number (`docs/BACKLOG.md` D105); a TSDB status with no head statistics, the one VictoriaMetrics answers, is refused with a `QueryError` saying "The server reports no head block statistics: its TSDB status carries none, so the storage row has no series count, chunk count or sample span to show", because an empty list or a row of zeros would claim a measurement the server never sent |
| `getSlowQueries()`, `getActiveSessions()` | none | `[]`, with the empty-state sentences from `getLabels()` saying Prometheus publishes no query log and no session list over its HTTP API |
| `getIndexStats()` | none | `[]`: a Prometheus TSDB has no secondary index object to describe |
| `getPoolStats()` | not implemented | The route detects it by presence and shows its fallback |

The `operations` agent workflow reads these surfaces on every engine in both modes, so agent runs reach the monitored server through them too.
On a handle opened for an agent-mode profile the overview, performance, slow-query, session and index readings answer their reason instead ([§14.4](#144-values-and-what-each-path-reads)).

---

## 8. Maintenance

None.
`supportsMaintenance` is `false` and `maintenanceOperations` is empty, so `maintenanceControl()` places no control, and the required maintenance labels are never rendered.
A direct call of `runMaintenance` is refused with a `QueryError` saying that compaction and statistics are the server's own and that the admin API is never called.

---

## 9. Capabilities & labels

### `getCapabilities()` ([`index.ts`](../../src/lib/db/providers/timeseries/prometheus/index.ts))

- `queryLanguage: "promql"`, no `queryDialect`.
- `createTable`: absent; the provider declares no `createTable`.
- `supportsExplain`, `supportsTransactions`, `supportsMaintenance`, `supportsInlineRowEdit`, `supportsTestDataGeneration`, `supportsResultPagination`, `supportsExternalQueryLimiting`, `supportsConnectionString`: all `false`.
- `declaresForeignKeys: false`, `statementTerminator: "none"`, `defaultPort: 9090`, `containerLevels: []`, `maintenanceOperations: []`, and the six object kinds of [§6.1](#61-the-object-surface-789).
- `schemaRefreshPattern: "(?!)"`, the empty lookahead, which matches nothing: no PromQL statement changes what the tree shows, because the provider calls read endpoints only and the metric catalogue moves with what the server scrapes.

### `getLabels()` ([`index.ts`](../../src/lib/db/providers/timeseries/prometheus/index.ts))

`entityName` "Metric" and "Metrics", `rowName` and `rowNamePlural` "series" and "series", `selectAction` "Run Instant Query", `generateAction` "Generate Query", `statementLanguage` "PromQL", and the two empty-state sentences of [§7](#7-monitoring--health).
The maintenance labels carry PromQL-true wording although they are never rendered.

### SQL writing

[`prometheus/sql-writing.ts`](../../src/lib/db/providers/timeseries/prometheus/sql-writing.ts) declares how a generated statement spells a literal, a name and a bind for this engine, and it is this engine's row of `SQL_WRITING` ([`src/lib/db/sql-writing/index.ts`](../../src/lib/db/sql-writing/index.ts)), which the readers in [`src/lib/sql/values.ts`](../../src/lib/sql/values.ts) and [`src/lib/sql/identifier.ts`](../../src/lib/sql/identifier.ts) look up.
A literal is written by `literalStandard` and read back by `unquoteStandard`: the quote is doubled and a backslash is data.
A name is quoted by `identifierDoubleQuoted`, the SQL standard form: a double-quoted name with an inner double quote doubled.
There is no placeholder (`placeholder: null`), so a generator quotes the value with `quoteLiteral` instead of emitting a bind.
PromQL is not SQL (#1085), so this is the same reading as the engines that declare `queryLanguage: "json"`.
A PromQL string escapes with a backslash, but that is not a SQL literal and nothing here builds one.
Inline row editing reads a key column's kind through the shared `INSTANT_TYPE_NAMES`, `FLOAT64_TYPE_NAMES` and `EXACT_DECIMAL_TYPE_NAMES` of the module's `inlineEdit`, and binds every edit as typed.

The module's `export` field writes a result export's CREATE TABLE and INSERT from the shared building blocks alone: `STANDARD_DDL_TYPES` for the column types, `NOTHING_STANDS_ALONE` and `NO_BARE_SPELLING`, so every bare declared name is re-spelled from its family, `NULL_NON_FINITE` for NaN and the infinities, and `binaryStandardHex` for a binary cell (`X'0102'`).
The engine declares `queryLanguage: "promql"`, so no SQL statement is ever built for it to read, and a file exported from it is meant to run somewhere else: every bare name in it is re-spelled portably rather than kept as one engine's private word.

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
| a `400` whose whole body is `unsupported path requested: "<the path>"` and a newline, for the path the request was sent to, the answer VictoriaMetrics gives a path it does not serve | `QueryError` saying the server does not serve that path |
| a body that is not the API envelope (a proxy's HTML page, a 502, or the plain-text 503 the server's own ready gate, `testReady` in `web/web.go`, answers while it starts up or shuts down) | `ConnectionError` naming the path and the status and the sources such an answer can have, without choosing one and without quoting the body |
| a response past `RESPONSE_BYTE_CAP` | `QueryError` naming the cap |
| an overview whose metric count cannot be measured (M2), or a storage row whose TSDB status carries no head statistics | `QueryError` |
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
- **No path prefix**, so Mimir, Grafana Cloud's hosted Prometheus, GreptimeDB and prefix-mounted proxies are out of reach ([§4.5](#45-no-connection-string)).
- **The query timeout does not cover the wait for a query slot** ([§5.5](#55-timeout-and-cancellation)).
- **No AWS Managed Prometheus**: it needs SigV4 signing for the `aps` service.
- **No EXPLAIN**, because the only parse endpoint is experimental.
- **Agent mode reads instant queries only** ([§14](#14-agent-mode)): no range query and no request parameter is written by the model, so a window is a range vector or a subquery inside the expression.
- **On a server past `METRIC_LIST_CAP` metric names or `DESCRIBE_SERIES_CAP` series in the hour, plan mode grounds metrics only**, because the grounding walk stops at the metric folder's truncated batch (M7, `docs/BACKLOG.md` B84).
- **A listed metric whose series went quiet before the hour is left out of the bulk column read**, and the inventory carries it with no columns ([§6.1](#metric-columns), `docs/BACKLOG.md` D107).
- **The overview's metric count is unavailable only when a full list of `TSDB_LABEL_SCAN_LIMIT` label names omits the `__name__` entry** (M2), and a listed entry is the full count at any length of that list.
- **The chart tab draws a missing sample, and a `NaN` or `Inf` among numbers, at 0**, so a raw range over targets scraped at their own offsets charts false zeros, while a stepped subquery charts correctly as long as every series has a sample at every step; a column 20% or more `NaN` or `Inf` is not drawn as a series, and becomes the default x axis only while it holds at most 50 distinct values ([§3.7](#37-nan-and-inf-stay-strings-and-what-the-chart-does-with-them), [§5.2](#52-result-shaping), `docs/BACKLOG.md` U44).
- **Queries compete with the server's own rule evaluation** ([§3.4](#34-the-servers-query-slots-are-shared)).

---

## Migration DDL

[`PROMETHEUS_MIGRATION_DDL`](../../src/lib/db/providers/timeseries/prometheus/migration-ddl.ts) is what the schema-diff migration generator writes for `prometheus`, read through `migrationDdlFor` in `src/lib/db/migration-ddl/`.
It declines the whole diff: `refusal` is the one line the migration prints after its header, in place of any DDL, and `transactionWrapper` is `null`.
`prometheus` text is PromQL, not SQL (`readsSqlText: false`, [§5.7](#57-sql-grammar)), so there is no table DDL to wrap (#284, #1085).

The refusal reason it prints, verbatim:

- "A metric is written by scrapes and recording rules, not declared with columns, so there is no column definition to change."

---

## 14. Agent mode

Agent mode reads Prometheus through `queryReadOnly` in [`index.ts`](../../src/lib/db/providers/timeseries/prometheus/index.ts), in its own statement language, `promql`.
The expression reader is [`agent-statement.ts`](../../src/lib/db/providers/timeseries/prometheus/agent-statement.ts), the counting, the budgets and the wording of a failure are [`agent-read.ts`](../../src/lib/db/providers/timeseries/prometheus/agent-read.ts), what an agent-mode handle keeps of the server's answers is [`agent-projection.ts`](../../src/lib/db/providers/timeseries/prometheus/agent-projection.ts), and every other surface of an agent-mode handle is [`agent-surface.ts`](../../src/lib/db/providers/timeseries/prometheus/agent-surface.ts).
Every claim below about a server cites the capture [`tests/fixtures/prometheus/v3.13.3/agent-boundary/boundary.json`](../../tests/fixtures/prometheus/v3.13.3/agent-boundary/boundary.json), recorded by its `run.sh` against a fresh `prom/prometheus:v3.13.3` by digest, started with `--web.enable-admin-api`, `--web.enable-remote-write-receiver` and `--web.enable-lifecycle` and with `--query.max-samples` lowered to 100000, and a fresh VictoriaMetrics v1.152.0 by digest, and written by [`tests/live/prometheus-agent-boundary.ts`](../../tests/live/prometheus-agent-boundary.ts).
Its scrape targets carry a token in their query string and a user name and password in an address, generated per run outside the repository; the script refuses to write a capture that holds either value or any URL with a query token or userinfo, and records a raw target by which of its fields carry one, never by a value.

### 14.1 The boundary

The boundary is a structural closed table: the transport ([`http-transport.ts`](../../src/lib/db/providers/timeseries/prometheus/http-transport.ts)) builds requests only to the paths of its own table, every one of them a GET of a read endpoint except the instant query, `POST /api/v1/query`, and PromQL has no construct that writes.
An agent read is sent through the console's own request builder, so its form carries the expression, `timeout` and `limit` and nothing else.
So no admin (`delete_series`, `clean_tombstones`, `snapshot`), remote-write, OTLP or lifecycle (`/-/reload`, `/-/quit`) endpoint, and none of VictoriaMetrics' import or admin endpoints, can be reached on the agent path.
[`agent-provider.test.ts`](../../tests/unit/db/prometheus/agent-provider.test.ts) pins each read's full request (method, path, URL parameters and form body) and drives every read an agent-mode handle can make, holding each request it sends to the table; [`agent-boundary.test.ts`](../../tests/unit/db/prometheus/agent-boundary.test.ts) replays the capture.

No credential can be the boundary: the server the capture measured took every raw admin and lifecycle request the capture script sent (`rawRequests`, sent by the script and never by Studio): `delete_series` answered 204 and removed the seeded series' samples, `clean_tombstones` 204, `snapshot` 200 with a snapshot's name, `/-/reload` 200 with a new configuration time, and `/-/quit` 200, stopping the server; the remote-write receiver answered an empty body 400, having read it, and OTLP, which was off, 404.
VictoriaMetrics took `/api/v1/import` (204), its own `delete_series` (204), `/snapshot/create` and `/internal/force_merge` (200) the same way.
Studio's own reads left the state as it was (`studioLeftStateUnchanged`: the start time, the last configuration time, the seeded series' samples at a fixed instant and the head block, read before and after).

### 14.2 What an agent read may be

One PromQL expression, written as the console writes it and evaluated as an instant query at the server's own now, the way the console runs it ([section 5.1](#51-the-call)).
A window is a range vector or a subquery inside the expression (`rate(x[5m])`, `max_over_time(x[1h])`); `query_range` is not on the table, and the agent writes no time, range, step, limit or other parameter.
The reader mirrors the top level of the v3.13.3 lexer (`lexStatements` and `lexInsideBraces` in `promql/parser/lex.go`): the closed table of what may start a token there, `#` comments, the three string forms, numbers and durations, identifiers, the operators and the brackets, whose nesting it checks.
So a character the lexer has no row for (`&`, `?`, `;`, `\`, `|`), a dashboard variable such as `$__range`, `$__interval` or `$__rate_interval`, which is a dashboard's time-range directive that only a dashboard expands, a JSON request (refused at the colon inside its braces), an unterminated string and an unbalanced bracket are refused before anything is sent, with the reader's sentence followed by agent mode's list of reads.
The admission also refuses an expression longer than 4,096 characters.
`@` and `offset` are admitted: they move the instant the expression is evaluated at, and the answer is counted whatever instant it covers.

The server's `timeout` is the read's time budget, and the same budget is the deadline of the whole read, the wait for one of the connection's query slots ([section 3.4](#34-the-servers-query-slots-are-shared)) included.
A vector counts one row per series and a matrix one row per sample, float and native histogram points alike; a scalar and a string count one.
The query asks for one series past the row budget (`limit`), so a server that cut its answer there is seen, and an answer past the row budget is refused, never cut (`Read-only execution exceeded the row budget: 2 rows > 1 allowed`, measured); VictoriaMetrics ignores `limit`, so its whole answer is read, under the response byte cap, and counted (`4 rows > 1 allowed`).
An answer the console's grid would cut ([section 5.4](#54-caps-warnings-and-truncation)) and one past the byte budget are refused the same way.
An evaluation's cost on the server is bounded by its time-out and by the server's own sample limit, and neither is a cut: a refusal of either is a refusal of the read.

A failure is worded by its category.
Studio's own refusals say they are Studio's: the row, byte and time budgets (`Read-only execution exceeded the time budget: no answer within 1ms, the read's time budget, so Studio stopped the read and refused it. This is Studio's refusal, not the server's answer.`, measured), and an answer past the response cap.
A time-out the server reached at the deadline Studio sent, and an evaluation the server refused (`execution`, its own `--query.max-samples` among them, measured), are named by their category with the time budget and never in the server's own text.
A parse error keeps the server's sentence, which describes the expression the model wrote.
VictoriaMetrics names a category by its HTTP status, `400` for a parse error and `422` for its own points limit (measured), and the agent reads those as `bad_data` and `execution`.

### 14.3 What an agent-mode handle withholds

Samples, label values, rule and target state are the server's monitoring data, so the agent reads them, answered as the console renders them, inside the untrusted-content fence.
On every handle opened for an agent-mode profile the transport is wrapped by the projection, so the object surface, the grounding walk and the monitoring readings read its answers and nothing else:

- The server's command-line flags are withheld whole, before anything is sent: they carry file paths, listen addresses, URLs and local configuration (the capture lists 73 flag names, `config.file`, `storage.tsdb.path` and `web.external-url` among them). The overview, which reads its connection ceiling from them, is withheld with that reason.
- Every URL a target, a rule, an alert or a PromQL answer carries keeps only its scheme, host, port and path, followed by `[userinfo, query string and fragment withheld]` when it lost any of them: a target's scrape URL and last error, every label and discovered label, a rule's expression, labels and last error, an alert's labels and annotations, and every label of a series a PromQL answer carries. An address written with userinfo (`user:password@host:port/path`) keeps its host, port and path, and a URL with no scheme (`//host/path`) its host and path, never a query string or a fragment. A URL that does not parse, and a word whose `://` has no scheme in front of it, are withheld whole.
- Every scrape parameter among a target's discovered labels (`__param_<name>`) is withheld.

Measured raw, a target with a token parameter carries it in its scrape URL, its global URL, its last error and as `__param_token`, and a target whose address holds userinfo carries it in `__address__` and `instance` (and, on VictoriaMetrics, in its scrape URL) (`rawTargets`); the agent's target names carry neither (`surfaces.targets`).
The projection runs on the decoded answer, so a target's path segment, its scrape URL and a digest of its labels, is built from the projected answer and carries nothing withheld, not even as a digest.
A PromQL answer's labels are projected the same way, so `up` names a target whose address holds userinfo by its host and port.
The projection goes by a value's shape, so what it cannot reach is a label value an expression rewrites (`label_replace`) so that it no longer reads as a URL or an address, and a matcher that selects on a stored value; both stay with what the server stores, the posture and the grounding name both, and the residual is recorded in [B161](../BACKLOG.md#b161-prometheuss-agent-reads-withhold-the-flags-and-url-secrets-and-it-has-no-mcp-statement-read).

### 14.4 Values, and what each path reads

| Path | Handle | What it reads |
| --- | --- | --- |
| Investigation and data-analysis reads | agent read-only profile | one expression of [section 14.2](#142-what-an-agent-read-may-be) |
| Investigation grounding, plan-mode grounding and the operations workflow's inventory | either agent profile | the metric names of the last hour with their label names, the rule groups and rules, and the scrape pools and targets, by name, through the projection; the series' label sets are read to learn their label names, and the names alone are kept; a server that does not serve the scrape pool listing, VictoriaMetrics, leaves that kind out with its refusal as the kind's reason, and every other kind is read |
| Health, storage and table readings | either agent profile | the server's own answers, as on an editor handle, never the flags; the server publishes no byte count, and the storage and table readings' shape requires one, so each byte figure is a 0 with the text beside it saying it is a placeholder, not a measurement; on VictoriaMetrics the storage reading is refused with the server not serving `/api/v1/status/runtimeinfo` (`surfaces.storage` in the capture), a reason the model reads, so an operations run that takes it goes on to its report |
| Console, overview, performance, slow-query, session and index readings | either agent profile | nothing: each is refused with its reason, never answered with Studio's own figures or an empty reading |

### 14.5 Agent language pack

Statement-language family: `promql`.
Overlay: [`src/lib/agent/languages/promql/engines/prometheus.ts`](../../src/lib/agent/languages/promql/engines/prometheus.ts), with its client row in [`src/lib/agent/languages/promql/engines/client.ts`](../../src/lib/agent/languages/promql/engines/client.ts).
The agent reads it through `runServerPack` and `agentEnginePack`.
Both overlays are empty, so the engine resolves to the `promql` family pack itself.
The `promql` statement-language family has no dialect-bound member.
This overlay overrides no Shared member, so every Shared member is the `promql` statement-language family's own.
The family offers the investigation and the data analysis, through `run_read_query` with one expression, and the operations workflow; it offers no query optimization or database assessment, since the server composes no plan an agent can be shown and Studio no table profile, and no workflow hands an answer to the editor.
Plan mode's safety strip is the family's own (`posture.plan` in [`client.ts`](../../src/lib/agent/languages/promql/client.ts)): "the server's read endpoints ground it, and no PromQL it drafted is evaluated", because the grounding is several read endpoints rather than one schema read; plan mode follows the provider's `statementLanguage` label, `PromQL`.
The editor language id stays `promql`, and the fence alias `promql` names this engine.
VictoriaMetrics is served by the same provider and the same type-id, so it takes the same agent path; it was measured beside Prometheus in the capture, and its own admin and import endpoints are not on the table either.
A pack does not open agent mode: execution is gated by `AGENT_EXECUTION_ENGINES` and the execution-profile check.
No MCP tool runs PromQL: the family declares no MCP facet and `MCP_STATEMENT_READ.prometheus` is false ([B161](../BACKLOG.md#b161-prometheuss-agent-reads-withhold-the-flags-and-url-secrets-and-it-has-no-mcp-statement-read)); `MCP_EXPOSABLE.prometheus` stays true for the metadata tools, which read through the same projection, and `READ_ONLY_ENFORCED.prometheus` is unchanged.

---

## 15. References

- Source: [`src/lib/db/providers/timeseries/prometheus/`](../../src/lib/db/providers/timeseries/prometheus/)
- Editor language: [`src/lib/db/providers/timeseries/prometheus/editor-syntax.ts`](../../src/lib/db/providers/timeseries/prometheus/editor-syntax.ts)
- Design: [#1085](https://github.com/libredb/libredb-studio/issues/1085)
- Prometheus HTTP API: <https://prometheus.io/docs/prometheus/3.13/querying/api/>
- PromQL: <https://prometheus.io/docs/prometheus/3.13/querying/basics/>
- Upstream source read for the design, at tag `v3.13.3`: `web/api/v1/api.go`, `promql/parser/lex.go`, `promql/parser/functions.go`, `promql/engine.go`, `rules/group.go`, `scrape/target.go`, `tsdb/head_read.go`, `tsdb/querier.go`, `tsdb/index/postings.go`
