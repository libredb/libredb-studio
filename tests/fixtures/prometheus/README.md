# Prometheus fixtures

Verbatim answers of the compose `prometheus`, `prometheus-auth` and `victoriametrics` services, captured before any provider code was written (#1085, section 9, gate 4).
A test that needs a real server answer loads one of these files instead of writing its own.
The measurements at the end confirm or replace the provider's measured constants (#1085, section 10), each by the rule written beside it.
A local harness took every file and rendered this page from them and from its measurements, so no value below was typed by hand.

## Provenance

| Item | Value |
|---|---|
| Captured | 2026-09-23T10:16:48.509Z |
| Prometheus image | `prom/prometheus:v3.13.3`, `prom/prometheus@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7` |
| Prometheus build | `3.13.3`, revision `b273ae3adeb64ad630d65ef7f16440df95658410`, `go1.26.8`, built `20260907-11:42:33` |
| VictoriaMetrics image | `victoriametrics/victoria-metrics:v1.152.0`, `victoriametrics/victoria-metrics@sha256:86ca5fdb6d87d56ba047b044039019ba2bd9042b36e35f6ea34e437b6c825cef` |
| VictoriaMetrics build | `version="victoria-metrics-20260911-130322-tags-v1.152.0-0-g540b91da03", short_version="v1.152.0"`, the labels of its `vm_app_version` series |
| Harness | `probe-prometheus.ts` at the repository root, local and never committed (`/probe-*.ts` in `.gitignore`, the #424 gate-4 convention) |

The containers were created fresh, because the pending alert and the unscraped target exist only in a server's first hour:

```bash
docker compose -f database-compose.yml --profile prometheus-auth --profile compat up -d --force-recreate --renew-anon-volumes prometheus prometheus-auth victoriametrics
bun probe-prometheus.ts wait
bun probe-prometheus.ts capture
```

Every fixture records its own request, so any one of them can be taken again without the harness, for example `query-limited.json`:

```bash
curl -s -X POST --data-urlencode 'query=up' --data-urlencode 'limit=2' http://localhost:9090/api/v1/query
```

## The services

`prometheus` (host port 9090) runs `docker/prometheus/prometheus.yml` and the rule files in `docker/prometheus/rules/`, and each job and rule there says which edge of the provider's object model it exists for.
`prometheus-auth` (host port 9091) is the same image and configuration behind basic auth from `docker/prometheus/web-auth.yml`, with the documented test user `studio` and password `studio-probe`.
Its own scrape jobs read `/metrics` without a credential, so its self-scrape targets are `down` with a 401, and only its credential answers are kept here.
`victoriametrics` (host port 8428) scrapes the same targets through the compose network, from `docker/victoriametrics/scrape.yml`, and evaluates no rules, so the recording-rule metrics exist on Prometheus only.

## Fixtures

Each file holds `request` (method, path, query string, form body, and which credential was sent), `status`, `headers` (the headers of interest, `null` when absent), `bytes` (the decoded body's UTF-8 length), `durationMs`, `holds`, and `body`: the response text exactly as it arrived.
`body` stays text so a replay can hand over the server's exact bytes: the reader returns it verbatim as `text` and decoded as `body`.
A replay passes the reader's `text`, `status` and `headers`, which already leave out `content-length` and `content-encoding`, because those describe the wire rather than the decoded text.
`v3.13.3/` holds the `prometheus` answers and, under the `auth-` prefix, the `prometheus-auth` ones; `victoriametrics-v1.152.0/` holds the same requests asked of `victoriametrics`.
Tests read every file here through `tests/helpers/prometheus-fixtures.ts` and never build a path or parse a record themselves.
`capture(name)` and `captureVm(name)` return a capture's `status`, the headers that describe the decoded body, `body` decoded by its `content-type`, and `text`, the body exactly as it arrived; `captureBody(name)` and `captureVmBody(name)` return the decoded body alone.
Three documents are derived rather than captured: they hold no `request`, are not in the table below, and are read whole with `fixtureDocument(name)`.
`v3.13.3/lexer-words.json` is the `key` map of `promql/parser/lex.go` at v3.13.3 grouped by its section comments (37 words), with the 2 words `init()` keys as numbers.
`v3.13.3/promql-functions.json` is the keys of the `Functions` map of `promql/parser/functions.go` at v3.13.3 (89 names).
Both record the raw URL they were fetched from and the SHA-256 of the fetched file, so a fetch at the same tag can be compared byte for byte.
Each directory's `reserved-words.json` holds every lexer word asked bare and as a `{__name__="..."}` selector in each context the provider writes one in, each answer kept as `status`, `headers` and `body`, the way a capture keeps it.

| Fixture | Request | Prometheus | VictoriaMetrics | Holds |
|---|---|---|---|---|
| `query-vector.json` | `POST /api/v1/query query=up` | `200 success` | `200 success` | an instant vector: one series per target |
| `query-vector-reserved-labels.json` | `POST /api/v1/query query=studio_reserved_labels` | `200 success` | `200 success` | a vector whose labels are named value, timestamp and service.name |
| `query-vector-utf8-name.json` | `POST /api/v1/query query={__name__="studio.dotted.name"}` | `200 success` | `200 success` | a vector of a UTF-8 metric name |
| `query-vector-special.json` | `POST /api/v1/query query=label_replace(vector(0/0), "v", "nan", "__name__", ".*") or label_replace(vector(1/0), "v", "pos_inf", "__name__", ".*") or label_replace(vector(-1/0), "v", "neg_inf", "__name__", ".*")` | `200 success` | `200 success` | a vector holding NaN, +Inf and -Inf |
| `query-matrix-raw.json` | `POST /api/v1/query query=up{job="prometheus"}[1m]` | `200 success` | `200 success` | a raw range selector: samples at their scrape times |
| `query-matrix-raw-all.json` | `POST /api/v1/query query=up[5m]` | `200 success` | `200 success` | a raw range selector over every target: series at their own scrape offsets |
| `query-matrix-subquery.json` | `POST /api/v1/query query=rate(prometheus_http_requests_total[1m])[5m:30s]` | `200 success` | `200 success` | a stepped subquery: aligned timestamps, several series, no \_\_name\_\_ |
| `query-matrix-special.json` | `POST /api/v1/query query=(label_replace(vector(0/0), "v", "nan", "__name__", ".*") or label_replace(vector(1/0), "v", "pos_inf", "__name__", ".*") or label_replace(vector(-1/0), "v", "neg_inf", "__name__", ".*"))[1m:30s]` | `200 success` | `200 success` | a matrix holding NaN, +Inf and -Inf |
| `query-scalar.json` | `POST /api/v1/query query=scalar(count(up))` | `200 success` | `200 success` | a scalar |
| `query-scalar-nan.json` | `POST /api/v1/query query=0/0` | `200 success` | `200 success` | the scalar NaN |
| `query-scalar-pos-inf.json` | `POST /api/v1/query query=1/0` | `200 success` | `200 success` | the scalar +Inf |
| `query-scalar-neg-inf.json` | `POST /api/v1/query query=-1/0` | `200 success` | `200 success` | the scalar -Inf |
| `query-string.json` | `POST /api/v1/query query="studio"` | `200 success` | `200 success` | a string result |
| `query-native-histogram.json` | `POST /api/v1/query query=prometheus_http_request_duration_seconds{handler="/api/v1/query"}` | `200 success` | `200 success` | a vector of native histogram samples |
| `query-native-histogram-matrix.json` | `POST /api/v1/query query=prometheus_http_request_duration_seconds{handler="/api/v1/query"}[1m]` | `200 success` | `200 success` | a matrix of native histogram samples |
| `query-info-notice.json` | `POST /api/v1/query query=rate(go_goroutines[1m])` | `200 success` | `200 success` | an info notice: rate over a gauge |
| `query-warning-notice.json` | `POST /api/v1/query query=quantile(2, up)` | `200 success` | `200 success` | a warning notice: a quantile outside 0 to 1 |
| `query-limited.json` | `POST /api/v1/query query=up&limit=2` | `200 success` | `200 success` | a vector cut by limit=2, with the engine's truncation warning |
| `query-limited-matrix.json` | `POST /api/v1/query query=up[1m]&limit=2` | `200 success` | `200 success` | a matrix cut by limit=2, with the engine's truncation warning |
| `query-count-absent.json` | `POST /api/v1/query query=count(last_over_time(studio_no_such_metric[1h]))` | `200 success` | `200 success` | the existence read of a name that does not exist: an empty vector, not an error |
| `error-bad-data.json` | `POST /api/v1/query query=sum(` | `400 bad_data: invalid parameter "query": 1:5: parse error: unclosed left parenthesis` | `400 400: error when executing query="sum(" for (time=1790158578495, step=300000): singleExpr: unexpected toke` | the bad\_data envelope: a parse error |
| `error-execution.json` | `POST /api/v1/query query=up + on() up` | `422 execution: found duplicate series for the match group {} on the right hand-side of the operation: [{__name__="u` | `422 422: error when executing query="up + on() up" for (time=1790158578495, step=300000): cannot evaluate "up` | the execution envelope: many-to-many matching |
| `error-timeout.json` | `POST /api/v1/query query=count_over_time(absent(studio_no_such_metric)[1h:1ms])&timeout=50ms` | `503 timeout: query timed out in expression evaluation` | `422 422: too many points for the given start=1790154678494, end=1790158578496 and step=1: 3900003; the maximu` | the timeout envelope: timeout=50ms on a slow query |
| `label-values-names.json` | `GET /api/v1/label/__name__/values start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | every metric name of the last hour |
| `label-values-names-limited.json` | `GET /api/v1/label/__name__/values start=1790155008.337&end=1790158608.337&limit=5` | `200 success` | `200 success` | metric names cut by limit=5, with the engine's truncation warning |
| `label-values-names-unwindowed.json` | `GET /api/v1/label/__name__/values` | `200 success` | `200 success` | every metric name the TSDB holds, no window |
| `label-values-utf8-escaped.json` | `GET /api/v1/label/U__service_2e_name/values start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | the values of service.name through the U\_\_ escape |
| `label-values-utf8-raw.json` | `GET /api/v1/label/service.name/values start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | the values of service.name, unescaped in the path |
| `labels-one-metric.json` | `GET /api/v1/labels match[]=up&start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | the label names of up |
| `labels-reserved-labels-metric.json` | `GET /api/v1/labels match[]=studio_reserved_labels&start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | the label names of studio\_reserved\_labels |
| `labels-keyword-metric.json` | `GET /api/v1/labels match[]={__name__="sum"}&start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | the label names of the recording-rule output named sum |
| `labels-utf8-metric.json` | `GET /api/v1/labels match[]={__name__="studio.dotted.name"}&start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | the label names of a UTF-8 metric name |
| `labels-unknown-metric.json` | `GET /api/v1/labels match[]=studio_no_such_metric&start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | the label names of a metric that does not exist |
| `labels-all-unwindowed.json` | `GET /api/v1/labels` | `200 success` | `200 success` | every label name the TSDB holds, no window |
| `series-all.json` | `GET /api/v1/series match[]={__name__=~".+"}&start=1790155008.337&end=1790158608.337` | `200 success` | `200 success` | every series of the last hour |
| `series-all-limited.json` | `GET /api/v1/series match[]={__name__=~".+"}&start=1790155008.337&end=1790158608.337&limit=10` | `200 success` | `200 success` | series cut by limit=10, with the engine's truncation warning |
| `metadata-exact.json` | `GET /api/v1/metadata metric=prometheus_http_requests_total&limit=1` | `200 success` | `200 success` | the metadata read by the exact name of a counter |
| `metadata-family-suffixed.json` | `GET /api/v1/metadata metric=prometheus_http_request_duration_seconds_bucket&limit=1` | `200 success` | `200 success` | the metadata read by a classic histogram's \_bucket name |
| `metadata-family.json` | `GET /api/v1/metadata metric=prometheus_http_request_duration_seconds&limit=1` | `200 success` | `200 success` | the metadata read by that histogram's family name |
| `metadata-recording-rule.json` | `GET /api/v1/metadata metric=sum&limit=1` | `200 success` | `200 success` | the metadata read for a recording-rule output |
| `metadata-unknown.json` | `GET /api/v1/metadata metric=studio_no_such_metric&limit=1` | `200 success` | `200 success` | the metadata read for a name that does not exist |
| `metadata-all.json` | `GET /api/v1/metadata` | `200 success` | `200 success` | the metadata of every metric family, unfiltered |
| `rules-all.json` | `GET /api/v1/rules exclude_alerts=true` | `200 success` | `200 success` | every rule group, alerts excluded |
| `rules-all-with-alerts.json` | `GET /api/v1/rules` | `200 success` | `200 success` | every rule group with the live alerts of its alerting rules |
| `rules-one-group.json` | `GET /api/v1/rules rule_group[]=studio&file[]=/etc/prometheus/rules/studio-a.yml&exclude_alerts=true` | `200 success` | `200 success` | group studio of rule file A, alerts excluded |
| `rules-one-group-other-file.json` | `GET /api/v1/rules rule_group[]=studio&file[]=/etc/prometheus/rules/studio-b.yml&exclude_alerts=true` | `200 success` | `200 success` | the group of the same name in rule file B |
| `rules-firing-rule.json` | `GET /api/v1/rules rule_group[]=studio&file[]=/etc/prometheus/rules/studio-a.yml&rule_name[]=StudioAlwaysFiring` | `200 success` | `200 success` | one alerting rule with its firing alert |
| `rules-pending-rule.json` | `GET /api/v1/rules rule_group[]=studio&file[]=/etc/prometheus/rules/studio-a.yml&rule_name[]=StudioHeldPending` | `200 success` | `200 success` | one alerting rule with its pending alert |
| `rules-duplicate-name.json` | `GET /api/v1/rules rule_group[]=studio&file[]=/etc/prometheus/rules/studio-a.yml&rule_name[]=StudioTwin` | `200 success` | `200 success` | both alerting rules named StudioTwin in one group |
| `rules-unknown-group.json` | `GET /api/v1/rules rule_group[]=studio-no-such-group&file[]=/etc/prometheus/rules/studio-a.yml&exclude_alerts=true` | `200 success` | `200 success` | a rule group that does not exist |
| `scrape-pools.json` | `GET /api/v1/scrape_pools` | `200 success` | `400 "unsupported path requested: \"/api/v1/scrape_pools\"\n"` | every scrape pool |
| `targets-active.json` | `GET /api/v1/targets state=active` | `200 success` | `200 success` | every active target: up, down and unknown |
| `targets-one-pool.json` | `GET /api/v1/targets state=active&scrapePool=studio-twin` | `200 success` | `200 success` | the two targets that share one address and instance |
| `targets-unknown-pool.json` | `GET /api/v1/targets state=active&scrapePool=studio-no-such-pool` | `200 success` | `200 success` | a scrape pool that does not exist |
| `health-healthy.json` | `GET /-/healthy` | `200 "Prometheus Server is Healthy.\n"` | `200 "VictoriaMetrics is Healthy.\n"` | the health probe |
| `health-ready.json` | `GET /-/ready` | `200 "Prometheus Server is Ready.\n"` | `200 "VictoriaMetrics is Ready.\n"` | the readiness probe |
| `health-legacy.json` | `GET /health` | `404 "404 page not found\n"` | `200 "OK"` | the path the health fallback asks on a 404 |
| `buildinfo.json` | `GET /api/v1/status/buildinfo` | `200 success` | `200 success` | the build: version, revision, Go version |
| `runtimeinfo.json` | `GET /api/v1/status/runtimeinfo` | `200 success` | `400 "unsupported path requested: \"/api/v1/status/runtimeinfo\"\n"` | the runtime: start time, retention |
| `flags.json` | `GET /api/v1/status/flags` | `200 success` | `400 "unsupported path requested: \"/api/v1/status/flags\"\n"` | every command-line flag with its value |
| `tsdb-status-10.json` | `GET /api/v1/status/tsdb limit=10` | `200 success` | `200 success` | TSDB statistics at limit=10 |
| `tsdb-status-50.json` | `GET /api/v1/status/tsdb limit=50` | `200 success` | `200 success` | TSDB statistics at TSDB\_TOP\_METRICS (50) |
| `tsdb-status-10000.json` | `GET /api/v1/status/tsdb limit=10000` | `200 success` | `200 success` | TSDB statistics at the largest limit the server takes |
| `tsdb-status-over-limit.json` | `GET /api/v1/status/tsdb limit=10001` | `400 bad_data: limit must not exceed 10000` | `200 success` | the refusal of limit=10001 |
| `redirect-root.json` | `GET /` | `302 to /query` | `200 "<h2>Single-node VictoriaMetrics</h2></br>Version victoria-me"` | a redirect the server itself answers |
| `redirect-graph.json` | `GET /graph g0.expr=up` | `302 to /query?g0.expr=up` | `302 to graph/?g0.expr=up` | the old UI path's redirect, query string kept |
| `credential-bogus-basic.json` | `GET /api/v1/status/buildinfo (basic-bogus)` | `200 success` | `200 success` | a Basic credential the server does not need |
| `credential-bogus-bearer.json` | `GET /api/v1/status/buildinfo (bearer-bogus)` | `200 success` | `200 success` | a Bearer token the server does not need |
| `credential-none.json` | `GET /api/v1/status/buildinfo` | `200 success` | `200 success` | the same request with no credential |
| `auth-no-credentials.json` | `GET /api/v1/status/buildinfo` | `401 "Unauthorized\n"` | not asked | the refusal of a request with no credential |
| `auth-wrong-credentials.json` | `GET /api/v1/status/buildinfo (basic-wrong)` | `401 "Unauthorized\n"` | not asked | the refusal of a wrong password |
| `auth-bearer-credentials.json` | `GET /api/v1/status/buildinfo (bearer-right)` | `401 "Unauthorized\n"` | not asked | the refusal of the right password sent as a Bearer token |
| `auth-right-credentials.json` | `GET /api/v1/status/buildinfo (basic-right)` | `200 success` | not asked | the answer to the right Basic credential |
| `auth-healthy-no-credentials.json` | `GET /-/healthy` | `401 "Unauthorized\n"` | not asked | the health probe with no credential |

## Measurements

Each entry states its rule, what was measured, and the decision the rule gives, with the harness mode that measured it and the time it ran.

### M1. Cancellation

Measured by `bun probe-prometheus.ts m1` at 2026-09-23T10:17:56.012Z.
Rule (#1085 M1): `cancelQuery` exists if and only if aborting a long query is observed to end its evaluation on the server.
The evidence is either observation #1085 M1 names: the `prometheus_engine_queries` gauge of `GET /metrics` falling back, which the engine raises when a query starts and lowers when it ends (`exec` in `promql/engine.go`), read every 200 ms, or the aborted run's own query-log line, written when `exec` returns, ending as canceled more than 1 s before the natural run's logged `execTotalTime`.
Query: `count_over_time(absent(studio_no_such_metric)[6h:1ms])`, the first of `count_over_time(absent(studio_no_such_metric)[1h:1ms])` (610 ms), `count_over_time(absent(studio_no_such_metric)[2h:1ms])` (1291 ms), `count_over_time(absent(studio_no_such_metric)[4h:1ms])` (2333 ms), `count_over_time(absent(studio_no_such_metric)[6h:1ms])` (3642 ms) to run 3 s or longer.
It is slow in the per-step loop of `rangeEval`, which checks the request context at every step, so the result is not an artefact of a loop without a checkpoint.
Control: left to finish, it ran 3619 ms, and every reading from 300 ms after sending to 300 ms before the answer was 1 or more.
Aborted run: the client aborted at 1000 ms, the request ended with `AbortError: The operation was aborted.`, and the gauge first read 0 at 227 ms after the abort.
Query log (`/prometheus/query.log`): the finished run logged `execTotalTime` `3.618356742` s and no error, and the aborted run logged `execTotalTime` `1.019662876` s and the error `query was canceled in expression evaluation`.
Decision: observed by the gauge and the query log, so the provider implements `cancelQuery`.

### M2. The overview's metric count

Measured by `bun probe-prometheus.ts m2-m13` at 2026-09-23T10:17:59.925Z.
Rule (#1085 M2): the count comes from a source that is exact and cheap, never from a capped list's length.
The candidate is the `__name__` entry of `labelValueCountByLabelName` in one `GET /api/v1/status/tsdb?limit=10000`, in which each entry counts every value of its label and only the list is cut at `limit` (`MemPostings.Stats` in `tsdb/index/postings.go`), so the entry is exact for the head block whenever it is present.
The cut leaves the entry whole: `tsdb-status-10.json` lists 10 of the 37 label names of `tsdb-status-10000.json`, and its `__name__` entry is 344, the same as in `tsdb-status-10000.json`.
The cut shows in `tsdb-status-10.json`: its four lists hold 10, 10, 10, 10 entries, and the answer carries no `warnings` field.
Measured, all without a window: the list held 37 entries at `limit=10000`, `GET /api/v1/labels` counts 37 label names, the `__name__` entry is 344, and `GET /api/v1/label/__name__/values` counts 344 names.
Decision: exact on this server, so `metricNameCount` is the entry's value when present, 0 when it is absent from a list shorter than the limit, and no count only when it is absent from a list at the limit.

### M3. The matrix sample budget

Measured by `bun probe-prometheus.ts m3-m12` at 2026-09-23T11:21:55.935Z.
Rule: `MATRIX_SAMPLE_BUDGET` holds the representative subquery's grid cells, distinct instants times series, four times over, the headroom M3 and M12 share; a larger matrix is cut to the budget and flagged, whatever the number (#1085 5.4).
A stepped subquery's series share their instants, so its cells are about its samples; a raw range's are not, because each target is scraped at its own offset, which is why the budget counts cells rather than samples.
Representative subquery: `{__name__=~".+"}[1h:1m]` with `limit=500`, run once the head held 65.8 minutes of data: 500 series, 30000 grid cells, 29940 samples (floats and histograms together), 1930719 bytes, 64.5 bytes per sample.
Its notices: `results truncated due to limit`.
Decision: `MATRIX_SAMPLE_BUDGET` = `250000` (candidate `250000`, confirmed): 4 x the representative subquery's 30000 grid cells (distinct instants times series) is 120000.
A matrix of exactly the budget at this server's mix is about 15.4 MiB, below `RESPONSE_BYTE_CAP`, so the budget, not the byte cap, is what cuts such an answer.
The grid half of M3 needs the provider and is observed in the live browser pass, not here.

### M5. Credentials the server does not need

Measured by `bun probe-prometheus.ts capture` at 2026-09-23T10:16:48.509Z.
Asked twice against the stock server, with a bogus credential and then with none (#1085 gate 4): a bogus Basic credential answered `200`, a bogus Bearer token `200`, and no credential `200`.
So a stock server with no web config ignores a credential it does not need, and a wrong credential still connects there.
Against `prometheus-auth`: no credential answered `401`, a wrong password `401`, the right password sent as a Bearer token `401`, the right Basic credential `200`, and `/-/healthy` without a credential `401`.
Every refusal carried `WWW-Authenticate: Basic`, `Content-Type: text/plain; charset=utf-8` and the body `"Unauthorized\n"`, with no API envelope.
VictoriaMetrics, which runs with no auth flag here: a bogus Basic credential answered `200`, a bogus Bearer token `200`, and no credential `200`.

### M8. Truncation notices

Measured by `bun probe-prometheus.ts capture` at 2026-09-23T10:16:48.509Z.
`query-limited.json`, `up` with `limit=2` on `/api/v1/query`: Prometheus returned 2 of 4 with the warning `results truncated due to limit`; VictoriaMetrics returned 4 of 4 with no warning.
`query-limited-matrix.json`, `up[1m]` with `limit=2` on `/api/v1/query`: Prometheus returned 2 of 4 with the warning `results truncated due to limit`; VictoriaMetrics returned 4 of 4 with no warning.
`label-values-names-limited.json`, the metric names with `limit=5`: Prometheus returned 5 of 344 with the warning `results truncated due to limit`; VictoriaMetrics returned 5 of 329 with no warning.
`series-all-limited.json`, every series with `limit=10`: Prometheus returned 10 of 918 with the warning `results truncated due to limit`; VictoriaMetrics returned 10 of 858 with no warning.
So on Prometheus 3.13.3 each of the four reads reports its own truncation in the engine's words, and where VictoriaMetrics sends no warning, one item more than asked is the only signal (#1085 4.3).

### M10. The metric list cap

Measured by `bun probe-prometheus.ts capture` at 2026-09-23T10:16:48.509Z.
Rule (#1085 M10): 2000 stands unless the live tree or the agent walk shows it wrong; the agent-walk half is M7, which the live plan-mode run decides.
Measured: `label-values-names.json`, the last hour's metric names, holds 344 names.
Decision: `METRIC_LIST_CAP` = `2000` (candidate `2000`, confirmed): the compose server holds 344 metric names in the last hour, so the cap does not bite here.

### M11. Queries in flight per connection

Measured by `bun probe-prometheus.ts m11` at 2026-09-23T10:19:00.423Z.
Rule: with that many heavy queries in flight for 60 s, `prometheus_rule_group_iterations_missed_total` does not rise, and every group keeps evaluating at its interval: at least one evaluation per interval, and no gap between successive `prometheus_rule_group_last_evaluation_timestamp_seconds` values above 1.5 intervals.
The load counts only if `prometheus_engine_queries` reached that many at once, which the harness asserts before it judges.
Heavy query: `count_over_time(absent(studio_no_such_metric)[1h:1ms])`, each worker sending it again as soon as it answered, on a host with 20 CPUs (Prometheus reports `GOMAXPROCS` 20).

| In flight | Queries finished | Peak `prometheus_engine_queries` | Missed iterations | Per group: evaluations, largest gap in seconds, interval in seconds | Result |
|---|---|---|---|---|---|
| 4 | 306 | 4 | 0 | /etc/prometheus/rules/studio-a.yml;studio: 12, 5.01, 5<br>/etc/prometheus/rules/studio-a.yml;studio-names: 12, 5.015, 5<br>/etc/prometheus/rules/studio-b.yml;studio: 6, 10.001, 10 | kept its interval |

Decision: `QUERY_CONCURRENCY_LIMIT` = `4` (candidate `4`, confirmed): rule evaluation kept its interval with 4 heavy queries in flight.
The server's own ceiling is `--query.max-concurrency`, `20` here (`flags.json`), shared by every Studio connection and by rule evaluation (#1085 S6).

### M12. The response byte cap

Measured by `bun probe-prometheus.ts m3-m12` at 2026-09-23T11:21:55.935Z.
Rule: `RESPONSE_BYTE_CAP` holds the largest representative answer four times over.
Representative answers, in decoded bytes: the M3 subquery 1930719, `{__name__=~".+"}` with `limit=500` (500 series) 103439, and the whole series listing of the last hour (1214 series) 159443.
Decision: `RESPONSE_BYTE_CAP` = `33554432` (candidate `33554432`, confirmed): 4 x the largest representative answer (1930719 bytes) is 7722876 bytes.

### M13. The whole-folder series cap

Measured by `bun probe-prometheus.ts m2-m13` at 2026-09-23T10:17:59.925Z.
Rule: `DESCRIBE_SERIES_CAP` holds this server's whole series listing four times over, and a listing of exactly the cap fits `RESPONSE_BYTE_CAP` four times over.
Measured: `GET /api/v1/series?match[]={__name__=~".+"}` over the last hour answered 1213 series in 159367 bytes, 131.4 bytes per series.
Decision: `DESCRIBE_SERIES_CAP` = `20000` (candidate `20000`, confirmed): it must be at least 4 x 1213 = 4852 series and at most 33554432 / (4 x 131.4 bytes) = 63848.

### The lexer's reserved words (#1085 S4)

Measured by `bun probe-prometheus.ts words` at 2026-09-23T10:17:08.407Z.
Rule (#1085 S4): `PROMQL_RESERVED_WORDS` is every word of `v3.13.3/lexer-words.json` with its number words, lowercased, and every one of them is written as `{__name__="<word>"}`; this probe shows that form is a selector wherever the provider writes one.
The table: the `key` map of `promql/parser/lex.go` at v3.13.3, 37 words in Operators (4), Aggregators (14), Keywords (13), Preprocessors (6), and `inf`, `nan`, which `init()` keys as numbers, 39 words in all, fetched from https://raw.githubusercontent.com/prometheus/prometheus/v3.13.3/promql/parser/lex.go (SHA-256 `5ddb072d7b3352184095eb84235c6c3bd792f8b43ae3270e46e55ed808efb68c`).
Each was sent bare and as `{__name__="<word>"}` in every context the provider writes a selector in: alone, followed by `[5m]`, inside `count(...)`, inside `rate(...[5m])[1h:1m]`, and upper-cased alone.
Every braces form answered 200 with a success envelope of its context's result type, a vector alone, counted and upper-cased and a matrix after `[5m]` and in the subquery, which the harness asserts before it writes `v3.13.3/reserved-words.json`.
The controls `{__name__="sum"}` and `{__name__="nan"}` each answered a series (the `studio-names` rules), so a braces form does find a metric of that name.
Bare forms that did not answer like their braces form in some context on Prometheus 3.13.3: `atan2`, `bool`, `group_left`, `group_right`, `ignoring`, `inf`, `nan`, `on`.
Bare forms that answered like their braces form in every context: `anchored`, `and`, `avg`, `bottomk`, `by`, `count`, `count_values`, `end`, `fill`, `fill_left`, `fill_right`, `group`, `limit_ratio`, `limitk`, `max`, `max_of`, `min`, `min_of`, `offset`, `or`, `quantile`, `range`, `smoothed`, `start`, `stddev`, `stdvar`, `step`, `sum`, `topk`, `unless`, `without`.
On VictoriaMetrics, the bare forms that did not answer like their braces form (`victoriametrics-v1.152.0/reserved-words.json`): `inf`, `nan`.
The editor's function list is `v3.13.3/promql-functions.json`: 89 names, fetched from https://raw.githubusercontent.com/prometheus/prometheus/v3.13.3/promql/parser/functions.go (SHA-256 `d78b281888308eb1e1c44afee392ed06d1047c8d8ab1e6f036ea37428e77195b`).

### `U__` label-name escaping

Measured by `bun probe-prometheus.ts capture` at 2026-09-23T10:16:48.509Z.
Prometheus: `/api/v1/label/U__service_2e_name/values` answered 200 `["checkout"]`, and the unescaped `/api/v1/label/service.name/values` answered 200 `["checkout"]`.
VictoriaMetrics: the escaped path answered 200 `["checkout"]`, and the unescaped one 200 `["checkout"]`.

### VictoriaMetrics

Measured by `bun probe-prometheus.ts capture` at 2026-09-23T10:16:48.509Z.
The same requests asked of `victoriametrics`, answering the questions of #1085 section 7; the fixture table above sets every answer beside the Prometheus one.
Health: `/-/healthy` answered `200 "VictoriaMetrics is Healthy.\n"`, `/-/ready` `200 "VictoriaMetrics is Ready.\n"`, and `/health` `200 "OK"`.
Status: buildinfo answered 200 with version `2.24.0`, runtimeinfo answered `400 "unsupported path requested: \"/api/v1/status/runtimeinfo\"\n"`, flags `400 "unsupported path requested: \"/api/v1/status/flags\"\n"`, and the TSDB status `200 success`.
Limits and their notices: M8 above; the `U__` escape: the entry above.
Rules: `rules-all.json` answered `200 success` with 0 groups; single-node VictoriaMetrics evaluates no rules and runs here without `-vmalert.proxyURL`.
Targets: `targets-active.json` answered `200 success` with 5 active targets (2 down, 3 up), and `scrape-pools.json` `400 "unsupported path requested: \"/api/v1/scrape_pools\"\n"`.
