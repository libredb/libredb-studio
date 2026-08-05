# Apache Druid Provider

> Apache Druid support for LibreDB Studio, built on Druid's SQL HTTP endpoint
> (`POST /druid/v2/sql`, port `8888` on the Router or `8082` on the Broker) with **no driver
> dependency of any kind**: every statement is a JSON body and the answer comes back through the
> runtime's own `fetch`. This document is the single reference point for the Druid provider: design,
> architecture, usage, and tests. If you are reading the code, extending Druid support, or authoring
> a new provider over HTTP, start here.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `druid` |
| **Family** | SQL (`src/lib/db/providers/sql/druid/`) |
| **Driver** | None — HTTP only (`fetch`, a runtime built-in) |
| **Query language** | `sql` (Apache Calcite dialect) |
| **Default port** | `8888` (the Router). `8082` (the Broker) serves the identical endpoint and needs no different configuration — see [§3.3](#33-router-8888-or-broker-8082--both-work-identically) |
| **Connection pooling** | None — each statement is one stateless HTTP request |
| **Connection string** | **Not supported** — Druid has no URI convention for its SQL API ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)) |
| **EXPLAIN** | `druid-native` — the native query plan as a tree. Druid's `EXPLAIN` never executes the statement, so there is no separate analyze mode |
| **Writes** | **None are possible.** Druid SQL has no `UPDATE`, no `DELETE` and no `CREATE TABLE`; `INSERT`/`REPLACE` need the MSQ task engine ([§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly)) |
| **Transactions** | Not exposed (Druid has none) |
| **Maintenance** | None — nothing in `MaintenanceType` has a SQL-reachable Druid analogue ([§8](#8-maintenance)) |
| **Query cancellation** | No `cancelQuery`; the server-side statement deadline is what stops a runaway query ([§13](#13-known-limitations--future-work)) |
| **Verified against** | **Apache Druid 37.0.0**, datasources `libredb_demo` (50 rows) and `libredb_rollup` (20 rows) |
| **Source** | [`src/lib/db/providers/sql/druid/`](../../src/lib/db/providers/sql/druid/) |
| **Tests** | [`tests/integration/db/druid-provider.test.ts`](../../tests/integration/db/druid-provider.test.ts) + [`tests/unit/db/druid/`](../../tests/unit/db/druid/) + [`tests/unit/lib/explain/druid-native.test.ts`](../../tests/unit/lib/explain/druid-native.test.ts) |
| **Tracking issue** | [#265 — Add Apache Druid provider](https://github.com/libredb/libredb-studio/issues/265) |

---

## 1. Overview

Apache Druid is a distributed real-time analytics database. Its **SQL layer is Apache Calcite over
Druid's own native query engine**, exposed as a plain JSON HTTP endpoint — the same one Druid's own
web console uses, and the one this provider speaks. That endpoint is the whole surface the provider
needs: querying, catalog introspection and monitoring are all SQL, over one path.

Three things are Druid-shaped, and nearly every decision below flows from one of them:

1. **Druid SQL is read-only.** Not "writes are unimplemented here" — `UPDATE` and `DELETE` are not in
   the grammar, `CREATE TABLE` is not in the grammar, and `INSERT`/`REPLACE` are rejected by the
   engine that answers this endpoint. A datasource comes into existence by being **ingested into**,
   and data is removed by marking segments unused and running a kill task
   ([§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly)).
2. **The JSON on the wire is not the JSON you would design.** The result is a *positional array
   behind three header rows*, because the obvious object form silently drops duplicate columns
   ([§3.4](#34-resultformat-array-because-the-object-form-loses-columns)); a 64-bit integer arrives as
   an unquoted number that `JSON.parse` rounds, with no server-side setting to fix it
   ([§3.6](#36-64-bit-integers-arrive-unquoted-and-druid-offers-no-server-side-fix)); and the error
   body's `error` field is a *discriminator* rather than a message
   ([§3.7](#37-two-error-envelopes-and-the-http-status-is-not-enough)).
3. **The HTTP status misclassifies, in both directions.** `SELECT 1/0` — an ordinary typo — answers
   **HTTP 500** with `persona: "ADMIN"`. Every failure in this provider is classified by the
   `category` Druid reports, never by the status code.

### Concept mapping

| `DatabaseProvider` slot | Druid realisation | Mechanism |
|---|---|---|
| "Table" (`TableSchema`) | A **datasource**, displayed by its bare name | `INFORMATION_SCHEMA.TABLES` where `TABLE_SCHEMA = 'druid'` |
| "Row" | One result row | One positional array element behind the header rows |
| Columns | The datasource's column list, SQL types verbatim | `INFORMATION_SCHEMA.COLUMNS` / the query response's header rows |
| Primary key | none — nothing in a datasource is unique | `isPrimary: false` on every column, `__time` included ([§6](#6-schema-introspection)) |
| `query(sql)` | One SQL statement, with `?` parameters bound | `POST /druid/v2/sql` |
| Indexes | none — every dimension is indexed inside its segment, with no index *object* | always `[]` |
| Foreign keys | none (Druid has none) | always `[]` |
| `getOverview()` / storage | Process identity, segment bytes, datasource count, running tasks | `sys.servers`, `sys.segments`, `INFORMATION_SCHEMA.TABLES`, `sys.tasks` |
| `getActiveSessions()` | **Ingestion tasks** — Druid has no query sessions | `sys.tasks` where `status IN ('RUNNING','PENDING')` |
| `getSlowQueries()` | nothing — Druid keeps no query log | always `[]` |
| Maintenance | nothing SQL can reach | `runMaintenance()` throws with the reason |

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. SQL providers add an intermediate abstract layer,
`SQLBaseProvider`, between the generic base and each concrete provider. Druid is a *directory* rather
than a single file, because the HTTP transport is a seam
([§3.2](#32-the-transport-seam-one-interface-one-implementation)) — the same layout ClickHouse uses:

```
src/lib/db/providers/sql/
├── postgres.ts
├── sql-base.ts
├── clickhouse/
└── druid/
    ├── index.ts             # DruidProvider - the SQLBaseProvider subclass
    ├── transport.ts         # DruidTransport interface + neutral result/error types (no I/O)
    ├── http-transport.ts    # the one implementation: POST /druid/v2/sql
    └── introspect.ts        # INFORMATION_SCHEMA + sys.* reads
```

The explain strategy lives with the other strategies, not with the provider:
[`src/lib/explain/druid-native.ts`](../../src/lib/explain/druid-native.ts).

### 2.2 Class hierarchy

```
DatabaseProvider (interface, types.ts)
        ^
        | implements
BaseDatabaseProvider (abstract, base-provider.ts)
        ^
        | extends
SQLBaseProvider (abstract, sql-base.ts)
        ^
        | extends
DruidProvider (druid/index.ts)
```

`DruidProvider` extends `SQLBaseProvider` — not `BaseDatabaseProvider` directly, the way Couchbase
does — because the dialect really is standard on the points the shared helpers care about:
double-quoted identifiers and `LIMIT n OFFSET m` are both correct Druid SQL, live-verified. This is
the case [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) names ClickHouse for. Only
`prepareQuery()` is overridden, for the one trap in
[§3.9](#39-the-preparequery-override-offset-with-no-limit).

### 2.3 What `SQLBaseProvider` gives for free

| Member | Purpose |
|---|---|
| `escapeIdentifier()` | Double-quoted, since `this.type` (`druid`) falls through to the default branch — the same quoting PostgreSQL uses, and correct here: `SELECT "id" FROM "libredb_demo"` parses. Quoting is not optional in generated SQL — see the reserved-word trap in [§5.4](#54-dialect-traps-a-user-will-hit) |
| `buildLimitClause()` | `LIMIT n` / `LIMIT n OFFSET m`, both accepted by Druid |
| `getPlaceholder()` | Returns `?`, which is exactly what Druid's positional parameters use ([§3.10](#310-positional-parameters-really-execute)) |
| `shouldEnableSSL()` | Inherited but **never called**, deliberately. It infers TLS from substrings in the host name, which would silently switch a self-hosted cluster whose hostname merely contains one. TLS here comes from the connection's own `ssl` config only ([§4.3](#43-tls)) |
| `prepareQuery()` (base) | The shared query limiter; `DruidProvider` calls it first and only overrides the `OFFSET`-with-no-`LIMIT` case |
| `getLabels()` (base) | Everything but the two entity labels ([§9](#9-capabilities--labels)) |

### 2.4 Registration & lifecycle

The factory wires Druid in via a dynamic import ([`factory.ts:95`](../../src/lib/db/factory.ts)):

```ts
case "druid": {
  // The explicit /index specifier keeps this dynamic import statically
  // analysable: a bare directory resolves only at runtime, which the bundler
  // cannot trace into a chunk.
  const { DruidProvider } = await import("./providers/sql/druid/index");
  return new DruidProvider(connection, options);
}
```

`connect()` proves the endpoint with one `SELECT 1`. That statement is live-verified as valid Druid
SQL — the planner answers it from a one-row inline datasource and names the column `EXPR$0` — so it
needs no datasource and succeeds on a cluster that has not ingested anything yet. Sending it at
connect time is what makes a wrong port, a proxy in front of the Broker, a Druid process that is not
a query endpoint, and a rejected credential surface while the user is still looking at the connection
form. `disconnect()` has nothing to release — there is no pool and no session — so it only clears the
cached transport reference. API routes use `getOrCreateProvider()`, which caches the connected
provider per `connection.id` and evicts it after 30 minutes idle.

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 HTTP only — no driver, and what that costs

Druid ships a JDBC driver, but it addresses **Avatica**
(`jdbc:avatica:remote:url=http://host:8888/druid/v2/sql/avatica/`), which needs a JVM client library;
there is no Node client in Druid's own distribution. Everything this provider needs — querying,
`INFORMATION_SCHEMA`, `sys.*` monitoring, `EXPLAIN` — is reachable over the documented SQL HTTP
endpoint, so the provider speaks that and nothing else. `package.json` is untouched: there is no
install step to fail, no native module in the Docker image or in any distribution channel, and no
N-API compatibility question for the Bun runtime. This is the rubric in
[`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) applied unchanged.

**What it costs, stated plainly**, because a driver is not free of charge in the other direction
either:

- **No failover and no retry.** One statement is one `fetch` to one host. A refused socket or a
  Broker restart surfaces as an error rather than being retried against a second Broker. For an
  interactive editor this is the right trade: the user sees the failure and presses the button again,
  which is more honest than a silent retry that hides a degraded cluster. A Druid deployment that
  wants failover puts the **Router** or a load balancer in front of its Brokers anyway, which is
  exactly the host a Studio connection points at.
- **No cursor paging.** The response body is read to the end (`await response.text()`), scanned once
  for unsafe integers, then parsed — so a result set is materialised as text and again as objects.
  The editor's `LIMIT 500` injection ([§5.1](#51-execution)) is what keeps that bounded; a statement
  that deliberately asks for millions of rows will be expensive here in a way a streaming client
  would not be.
- **No prepared statements, no session state.** Avatica offers both; the SQL endpoint offers neither,
  and neither is reachable from the editor's one-statement-per-execution model regardless.
- **No cancellation.** Abandoning the request client-side does not stop the query on the cluster,
  which is why a server-side deadline is always sent alongside the client one
  ([§3.8](#38-both-halves-of-the-timeout)). Druid *does* expose
  `DELETE /druid/v2/sql/{sqlQueryId}`, so a real `cancelQuery` is a concrete follow-up rather than an
  impossibility ([§13](#13-known-limitations--future-work)).

### 3.2 The transport seam: one interface, one implementation

Provider logic never calls `fetch`. It goes through `DruidTransport`
([transport.ts:156](../../src/lib/db/providers/sql/druid/transport.ts)), so adopting the Avatica
driver later — or any client that is not this endpoint — is one new file implementing the same
contract rather than a rewrite of the provider, the introspection and the explain strategy:

```ts
interface DruidTransport {
  readonly kind: "http";
  query(sql: string, opts?: DruidQueryOptions): Promise<DruidQueryResult>;
  close(): Promise<void>;
}
```

There is no second entry point next to `query()`, unlike Couchbase's `manage()`: every Druid metric,
task and storage statistic the provider needs is a `sys.*` table reachable by SQL
([§7](#7-monitoring--health)), so a permanent second HTTP surface would buy nothing.

The result type is deliberately **neutral** rather than the wire envelope
([transport.ts:47](../../src/lib/db/providers/sql/druid/transport.ts)):

```ts
interface DruidQueryResult {
  rows: Record<string, unknown>[];
  fieldNames: string[] | null;                  // declared order, made UNIQUE by the implementation
  sqlTypes: Record<string, string> | null;      // BIGINT, VARCHAR, TIMESTAMP, ARRAY, ... - the trustworthy pair
  nativeTypes: Record<string, string> | null;   // LONG, DOUBLE, ARRAY<STRING>, COMPLEX<HLLSketch>, ...
  executionTimeMs: number;                      // MEASURED here, never reported by the server
  unavailableSegments: number | null;           // how much of the data was out of reach; null = the source did not say
}
```

Three things this type says by what it omits:

- **No mutation count.** Druid SQL has no statement that mutates
  ([§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly)), so a count here could only ever
  be zero — and a field that is always zero reads as "nothing changed" rather than "this cannot
  happen".
- **No server-reported duration.** Live-verified: the endpoint answers with the rows and nothing
  else — no timing in the body, none in the response headers, only query ids. The transport times its
  own exchange, and the type's comment says so, so no reader mistakes it for the server's number.
- **`fieldNames` is required to be unique**, which is the transport's obligation rather than the
  wire's ([§3.4](#34-resultformat-array-because-the-object-form-loses-columns)).

And one thing it says by what it *includes*: **`unavailableSegments` is not optional and its null is
not a zero** (issue #273). Druid serves a query over data it cannot fully reach as an ordinary
success, so a short row set and a correct one are indistinguishable from the body alone — which makes
this the one fact only the source can supply. `0` means the source confirmed a whole answer, `null`
means it said nothing about availability, and only the first licenses trusting the row count. The
provider turns a positive count into a result warning ([§5.2](#52-result-shaping)).

> **Seam rule.** The wire vocabulary (`resultFormat`, `typesHeader`, `sqlTypesHeader`,
> `/druid/v2/sql`, `druidException`, `errorMessage`, `errorClass`, the `authorization` header, the
> `X-Druid-Response-Context` header with its `missingSegments` list, and
> `fetch` itself) must appear **only** in `http-transport.ts`.
> [`seam-guard.test.ts`](../../tests/unit/db/druid/seam-guard.test.ts) parses every source file in the
> directory with the TypeScript compiler API — not a grep — and fails the build the moment any of that
> vocabulary appears elsewhere, whether as a string, a property or a template. One token needs
> narrower treatment than ClickHouse's guard needed: the **neutral** error deliberately borrows
> Druid's own word `persona`, so `error.persona` is a legitimate read of `DruidTransportError` and is
> flagged only when spelled as a *string* (`body["persona"]`), which is what envelope parsing looks
> like. That hole is deliberate and is cheaper than a guard that cries wolf.

### 3.3 Router 8888 or Broker 8082 — both work identically

Live-verified on both ports of the same cluster: the same `POST /druid/v2/sql`, the same request
body, the same three-header-row envelope, the same error envelopes, and `sys.servers` returns the
same six rows from either.

```
$ curl -s -XPOST -H 'content-type: application/json' \
    -d '{"query":"SELECT COUNT(*) AS c FROM sys.servers","resultFormat":"array",
         "header":true,"typesHeader":true,"sqlTypesHeader":true}' \
    http://localhost:8082/druid/v2/sql
[["c"],["LONG"],["BIGINT"],[6]]
```

**The Router (8888) is the default only because it fronts more**: the SQL API, the web console, and —
when `druid.router.managementProxy.enabled` is set — the Coordinator and Overlord APIs, so one port
is enough for both querying and loading data. **A Broker-only deployment needs no different
configuration**: point the connection at the Broker's port and everything in this document works,
including every monitoring panel. Nothing in the provider knows which of the two it is talking to.

### 3.4 `resultFormat: "array"`, because the object form loses columns

**This is a correctness decision, not a preference.** Druid's `resultFormat: "object"` returns rows
as JSON objects, and duplicate output names — legal SQL, and what a join projecting two `id`s
produces — collide. Live-verified, the raw response text for `SELECT 1 AS c, 2 AS c`:

```
resultFormat "object"  ->  [{"c":null,"c":null},{"c":1,"c":2}]
resultFormat "array"   ->  [["c","c"],["LONG","LONG"],["INTEGER","INTEGER"],[1,2]]
```

The object form puts the duplicate key in the text, where **every** JSON parser keeps only the last
occurrence: the first column disappears before any code can see it. The array form is positional, so
it keeps both, and column order becomes authoritative in a way object keys never are.

The transport therefore always sends:

```json
{ "query": "...", "resultFormat": "array",
  "header": true, "typesHeader": true, "sqlTypesHeader": true }
```

and reads back **exactly three** header rows before the data — names, native types, SQL types, in
that order:

```json
[["__time","snowflake_id","id","name","region","qty","amount","row_count"],
 ["LONG","LONG","LONG","STRING","STRING","LONG","DOUBLE","LONG"],
 ["TIMESTAMP","BIGINT","BIGINT","VARCHAR","VARCHAR","BIGINT","DOUBLE","BIGINT"],
 ["2026-08-01T00:15:00.000Z",9007199254740993,1000,"alpha","emea",0,10.5,1]]
```

**A result set with no rows still carries all three header rows** (live-verified:
`SELECT id, name FROM libredb_demo WHERE 1=0` answers exactly
`[["id","name"],["LONG","STRING"],["BIGINT","VARCHAR"]]`), and a bare `SET` — the only other statement
form the grammar accepts — is rejected outright rather than answering short. So there is **no
legitimate way to receive fewer than three rows**, and the transport treats a shorter payload as a
failure rather than as an empty result.

That distinction matters more than it looks. What actually produces a short payload is a truncated
body or a proxy that rewrote the response, and answering `{ rows: [] }` there would render the most
convincing possible lie: a successful query, over the right datasource, that happens to have found
nothing. Data loss has to surface as an error, which is the same reason the mid-response truncation
case above raises instead of returning what it managed to read.

Rows are rebuilt from the declared names, and a repeat is **disambiguated rather than overwritten**:
`SELECT 1 AS c, 2 AS c` reaches the grid as columns `c` and `c (2)`, both with their values. The
suffix keeps climbing (`c (3)`, …) because `SELECT 1 AS c, 2 AS "c (2)", 3 AS c` is legal too. Without
this the array format would have been chosen and then thrown away one step later, since a row is a
`Record<string, unknown>`.

### 3.5 The SQL type labels the column, because the native type lies

Druid publishes two type names per column and they disagree. Live-verified:

| expression | native type | SQL type | value on the wire |
|---|---|---|---|
| `CURRENT_TIMESTAMP` | `LONG` | `TIMESTAMP` | `"2026-08-03T16:06:07.520Z"` |
| `(1 = 1)` | `LONG` | `BOOLEAN` | `true` |
| `ARRAY[1,2]` | `ARRAY<LONG>` | `ARRAY` | `"[1,2]"` |
| `ARRAY['alpha']` | `ARRAY<STRING>` | `ARRAY` | `"[\"alpha\"]"` |

The native type is `LONG` for a value that is an ISO timestamp string and for a value that is
`true`, so **the SQL type is the trustworthy one of the pair**. The native type is kept alongside it
in the neutral result rather than dropped: it is the vocabulary a Druid user reads in the web console
and in a segment's dimension list, so discarding it would make the editor describe columns in words
the user's other tools never use. It is *carried*, not trusted.

**Where each type actually travels**, because the two halves differ and it is easy to assume
otherwise:

- **The schema tree** shows `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` — also a SQL type — which
  introspection puts on `ColumnSchema.type`. That is the type a user sees on a catalogued column.
- **The result carries the SQL type per column** since issue #273 gave `QueryResult`
  ([src/lib/types.ts](../../src/lib/types.ts)) an optional `columnTypes` channel, keyed by the name in
  `fields`. `toQueryResult` maps `sqlTypes` into it and stops the native map here on purpose: the
  native type is the one that lies for an expression, and a column may only be labelled with the
  accurate half. The native map stays in the neutral result for the reason above — it is the
  vocabulary a Druid user reads elsewhere — and has no consumer today.

Full observed surface: native `LONG`, `DOUBLE`, `FLOAT`, `STRING`, `ARRAY<LONG>`, `ARRAY<STRING>`,
`COMPLEX<HLLSketch>` against SQL `BIGINT`, `INTEGER`, `DOUBLE`, `FLOAT`, `DECIMAL`, `VARCHAR`, `CHAR`,
`TIMESTAMP`, `BOOLEAN`, `ARRAY`, `OTHER`, `NULL`. Note that `SELECT 1` is SQL `INTEGER` while a
`BIGINT` column is `BIGINT`: the SQL type is the *expression's* type, not a normalised family.

### 3.6 64-bit integers arrive unquoted, and Druid offers no server-side fix

Live-verified on real ingested data. `libredb_demo.snowflake_id` holds **9007199254740993** — that is
2<sup>53</sup> + 1, the first integer JavaScript cannot represent — and it comes back as the
**unquoted JSON number** `9007199254740993`:

```
[... ,["2026-08-01T00:15:00.000Z",9007199254740993,1000,"alpha","emea",0,10.5,1]]
```

`JSON.parse` turns that into `9007199254740992` with no error and no warning. A displayed id that is
off by one is worse than an error, because nothing signals it.

**Druid has no server-side "quote longs" setting.** This is the one place the provider genuinely
diverges from ClickHouse (#264), which could push the problem to the server with
`output_format_json_quote_64bit_integers=1`. Here the only place left to fix it is the raw body,
before it is parsed — so `http-transport.ts` owns `quoteUnsafeIntegers()`
([http-transport.ts:264](../../src/lib/db/providers/sql/druid/http-transport.ts)), a single-pass,
**string-aware** scanner that wraps any integer literal outside
`Number.MIN_SAFE_INTEGER … Number.MAX_SAFE_INTEGER` in quotes. The value then reaches the UI as an
exact string — the same thing the `pg` driver already does for `int8`, so the grid renders it
correctly with no further change.

Properties it upholds, each with its own test:

- **Never rewrites inside a string literal.** A digit run in `"id: 9007199254740993"` is data the
  user is reading. This includes a string containing an escaped quote (`"a\"9007199254740993"`) — the
  escape must consume the next character, or the scanner desyncs and starts rewriting *inside* a
  string, producing invalid JSON.
- **Leaves safe integers, floats, exponent forms and `-0` alone.** A float is a double on both sides,
  so quoting one would turn a number the grid can sort into a string it cannot. Only integers lose
  exactness.
- **Handles the literal in every position** a JSON body can put it: negative, as an object value, as
  an array element, adjacent to `,` / `]` / `}` with and without whitespace.
- **Is a no-op on a body with no unsafe literal** — the common case returns the original string
  without allocating a copy.
- **The comparison is on digits, not numbers.** Converting the run to a number to find out whether
  converting it to a number is safe is the bug. A longer digit run always exceeds the range, and for
  two runs of equal length a lexical comparison *is* the numeric one — so the check needs no
  arithmetic at all. The sign never matters either, because the safe range is symmetric
  (`MIN_SAFE_INTEGER === -MAX_SAFE_INTEGER`).

Both encodings then reach every reader in the provider, because a `LONG` small enough stays an
unquoted number in the same response where a large `SUM(size)` arrives quoted.

### 3.7 Two error envelopes, and the HTTP status is not enough

Live-verified on 37.0.0. Both of these arrive from the same cluster, and the difference is not a
version skew — the modern shape is planning and validation, the legacy wrapper is a runtime failure a
data server reported.

**`druidException`** — planning, validation, unsupported statements:

```json
{ "error": "druidException", "errorCode": "invalidInput", "persona": "USER",
  "category": "INVALID_INPUT",
  "errorMessage": "Object 'nope' not found (line [1], column [15])",
  "context": { "sourceType": "sql", "line": "1", "column": "15",
               "endLine": "1", "endColumn": "18" } }
```

**Legacy-wrapped** — a runtime failure from a data server (here, a 1 ms deadline):

```json
{ "error": "Query timeout",
  "errorClass": "org.apache.druid.query.QueryTimeoutException",
  "host": "172.18.0.5:8083", "errorCode": "legacyQueryException",
  "persona": "OPERATOR", "category": "TIMEOUT",
  "errorMessage": "url[http://172.18.0.5:8083/druid/v2/] timed out",
  "context": { "host": "172.18.0.5:8083",
               "errorClass": "org.apache.druid.query.QueryTimeoutException",
               "legacyErrorCode": "Query timeout" } }
```

Four consequences the implementation honours:

1. **`error` is a discriminator, not a message.** In the modern shape its value is the literal string
   `"druidException"`. Showing `error` to a user prints *"druidException"* to the person who mistyped
   a datasource name. The transport always reads **`errorMessage`**, and falls back to `error` only
   when it is *not* that token (the legacy shape puts a real message in both).
2. **Classification is on `category`.** It is present in both shapes and is a closed enum, exported
   frozen as `DRUID_ERROR_CATEGORIES`
   ([transport.ts](../../src/lib/db/providers/sql/druid/transport.ts)) so no call site spells a token:
   `INVALID_INPUT`, `UNAUTHORIZED`, `FORBIDDEN`, `CAPACITY_EXCEEDED`, `CANCELED`, `RUNTIME_FAILURE`,
   `TIMEOUT`, `UNSUPPORTED`, `NOT_FOUND`, `UNCATEGORIZED`, `DEFENSIVE`. `errorCode` is secondary and
   coarser (`invalidInput`, `general`, `legacyQueryException` — the same code arrives with different
   categories), and the `errorClass` / `host` **fields** exist only in the legacy shape and are never
   read: a Java class name adds nothing for the person who wrote the statement.

   One honest caveat, because the distinction is easy to misread: not reading the `host` field is not
   the same as never showing the address. Druid writes it into `errorMessage` itself — the legacy
   timeout above reads `url[http://172.18.0.5:8083/druid/v2/] timed out` — and that message is
   surfaced verbatim. That is deliberate: which server timed out is the single most useful fact when
   one Historical is slow, and it is an address inside a cluster the user is already connected to.
   The alternative, preferring the legacy `error` value (`"Query timeout"`), is tidier and less
   useful.
3. **HTTP 500 can be a plain user error.** Live-verified:

   ```
   $ curl -s -XPOST -H 'content-type: application/json' \
       -d '{"query":"SELECT 1/0"}' http://localhost:8888/druid/v2/sql
   {"error":"druidException","errorCode":"general","persona":"ADMIN",
    "category":"UNCATEGORIZED","errorMessage":"/ by zero","context":{}}
   HTTP 500
   ```

   Dividing by zero is reported as a 500 with `persona: "ADMIN"`. Reading 5xx as "the cluster is
   broken" would tell the user something false and send them to check their host. `persona` is carried
   for display only and **never branched on**, for exactly this reason — Druid's own guess at who
   should read the message is wrong in the case that matters most. Timeout is **504** /
   `category: TIMEOUT`; everything else observed is **400**.
4. **A body that is not JSON at all** — a proxy's HTML error page, an empty body, a body that stopped
   arriving — still produces the seam's own error type, with a stand-in category
   (`TRANSPORT_FAILURE`) that is deliberately **not** one of Druid's. Reusing `UNCATEGORIZED` for it,
   tempting because that is what it means in English, would let a caller believe the server had
   spoken and classified the failure when nothing ever answered.

`DruidTransportError`
([transport.ts:256](../../src/lib/db/providers/sql/druid/transport.ts)) carries `category`,
`errorCode`, `persona` and the resolved message, and offers two predicates so no call site spells a
literal:

- `is(category)` — takes the closed union, so a misspelling does not compile.
- `isMonitoringUnavailable()` — true for `UNAUTHORIZED`, `FORBIDDEN` and `NOT_FOUND` **only**. Those
  three are the ordinary configurations of a locked-down cluster (`druid-basic-security` grants the
  `sys` schema table by table) or of a build where the table is simply absent. Anything else must keep
  propagating, or an empty monitoring panel hides the user's own mistake forever.

`category` is typed as a plain `string` on the error rather than the closed union, so a category a
later Druid adds arrives verbatim instead of being flattened onto `UNCATEGORIZED` — which is itself a
real category.

### 3.8 Both halves of the timeout

Two deadlines, both derived from `queryTimeout` (default 60 s), because neither covers the other:

- **Server side**: `context: { timeout: <ms> }`. Verified — `timeout: 1` answers 504 /
  `category: TIMEOUT` on a statement that otherwise takes milliseconds. Asking the server to stop is
  what actually frees the cluster's resources; abandoning the request client-side leaves the query
  running.
- **Client side**: an `AbortSignal.timeout(...)` on the `fetch`, which also bounds the **body read**.
  A server-side deadline only starts counting once the server has *accepted* the statement, so it
  cannot bound a stalled DNS lookup, TCP connect or TLS handshake, or a response body that stops
  arriving part-way. This is the #264 lesson applied.

The client deadline is deliberately the **later** of the two (`queryTimeout + 5 s`,
`CLIENT_DEADLINE_GRACE_MS`): a client that gave up first would abandon a query that is still running
and report a bare abort instead of the 504 Druid was about to send, with its category and its
message. Catalog and `sys` reads use a shorter 15 s bound on both halves
([`DRUID_SYSTEM_READ_TIMEOUT_MS`](../../src/lib/db/providers/sql/druid/introspect.ts)) — a hanging
panel is worse than an empty one.

### 3.9 The `prepareQuery()` override: `OFFSET` with no `LIMIT`

The inherited limiter is otherwise correct for Druid: `LIMIT 500` appends cleanly, an existing `LIMIT`
is left alone, and the shared `applyQueryLimit` inserts the bound at the end of the **statement**,
before the terminating semicolon and any trailing comment, which it then re-attaches — which matters,
because Druid accepts `SELECT 1 AS c1;` but rejects `SELECT 1 AS c1; LIMIT 2`, and the shared limiter
never produces the latter.

The one failure is a statement ending in **`OFFSET n` with no `LIMIT`**. The limiter appends `LIMIT`
after it, and Druid rejects the result outright (live-verified):

```
SELECT id FROM libredb_demo OFFSET 2 LIMIT 3
-> 400  "'OFFSET start LIMIT count' is not allowed under the current SQL conformance level"
```

`DruidProvider.prepareQuery()`
([index.ts:271](../../src/lib/db/providers/sql/druid/index.ts)) asks `analyzeQuery()` — the shared
analyzer, not a regex of its own, because it already reads the end of the statement (so the
terminating semicolon and any trailing comment are outside what its probes see) and already
distinguishes an `OFFSET` that follows a `LIMIT` (the ordinary paginated form, which the limiter
leaves alone anyway) from one that stands alone. When the statement has an `OFFSET` and no `LIMIT`, it
returns the query **untouched** with `wasLimited: false`.

Routing that decision through the shared analyzer is also what fixed `SELECT … OFFSET 2 -- paged`
here with no edit to this provider: the probe was anchored at the end of the raw text, so a trailing
comment hid the `OFFSET`, the limiter appended a bound and Druid answered `400`. The analyzer now
reads the end of the **statement** ([`statement-end.ts`](../../src/lib/sql/statement-end.ts)), and
this override inherits that (#280).

The bias is the same one ClickHouse's trailing-clause case takes, for the same reason: **rewriting
wrongly turns a working statement into a syntax error, while leaving it alone at worst returns more
rows than the page size.**

### 3.10 Positional parameters really execute

Unlike ClickHouse — whose HTTP interface binds only named `{name:Type}` parameters, so its provider
throws on positional ones — Druid takes `?` placeholders with a typed parameter list, live-verified:

```
{"query":"SELECT COUNT(*) AS c FROM libredb_demo WHERE region = ?",
 "parameters":[{"type":"VARCHAR","value":"emea"}]}
-> [["c"],[20]]
```

So `query(sql, params)` binds rather than refuses, and `getPlaceholder()` needs no override. The
mapping:

| JS value | Druid parameter type | Note |
|---|---|---|
| `string` | `VARCHAR` | |
| `number`, integral and safe | `BIGINT` | refused outside `Number.MAX_SAFE_INTEGER` — see below |
| `number`, non-integral | `DOUBLE` | |
| `bigint` | `BIGINT` | sent as a **raw unquoted literal** — see below |
| `boolean` | `BOOLEAN` | |
| `Date` | `TIMESTAMP` | epoch millis; verified, `{"type":"TIMESTAMP","value":0}` against `__time > ?` matches every row |
| `null` / `undefined` | `VARCHAR` with a `null` value | verified to execute and match the rows a null comparison should |

Anything else (a plain object, an array, a symbol) raises an error naming the unsupported type, and
`Infinity` / `NaN` are refused explicitly because `JSON.stringify` turns both into `null`, which the
server would read as a null comparison. Refusing beats sending a value the server will misread.

**The `bigint` case contradicted the plan, and the cluster won.** A `bigint` cannot be
`JSON.stringify`d, and the obvious encoding — send the digits as a string — is rejected:

```
{"type":"BIGINT","value":"9007199254740993"}   -> 500  RUNTIME_FAILURE  "Cannot handle query"
{"type":"BIGINT","value":9007199254740993}     -> matches the row exactly
```

So the literal has to reach the body unquoted. `JSON.rawJSON` would do it, but it is the ES2025 JSON
source-text proposal — V8 12.4 / Node 22.2 — while `package.json` declares
`engines.node: ">=20.9.0"`, so depending on it would throw a bare `TypeError` on a runtime the
package claims to support. Instead the **parameters array is serialized by hand** and spliced into the
envelope at its closing brace, whose position is known because `JSON.stringify` just produced it.
Everything that is not a `bigint` still goes through `JSON.stringify`, so user strings are escaped by
the runtime rather than by us.

That is deliberately structural rather than a marker-and-substitute pass. An earlier revision wrapped
the digits in a NUL sentinel and unquoted it with a regex over the finished body, which is unsound: a
sentinel is only as private as the values flowing through it, so a caller whose `VARCHAR` parameter
happened to contain that sentinel would have had their string silently unquoted into a number.
Emitting the literal in the first place cannot collide with anything, because no marker ever exists.

**An integral `number` outside the safe range is refused,** which looks strict until you notice the
value is already wrong. A caller writing `9007199254740993` as a number literal handed the transport
`9007199254740992` — JavaScript rounded it before any of this code ran — and nothing here can recover
the digit. Sending it would filter on a value the user never wrote and return a plausible wrong row
set, so the error names the fix: pass a `bigint`, which binds exactly. The same check catches an
integral double past Druid's own `BIGINT` range.

The design plan for this provider said a bigint travels "as a string value"; that is the one line of
it the live cluster disproved, and this is the record of why the code differs.

### 3.11 The three `false` capabilities are each impossible, not merely unimplemented

- **`supportsCreateTable: false`.** `CREATE TABLE t (id BIGINT)` is not unsupported — it is not in the
  grammar. Live: `400`, *"Incorrect syntax near the keyword 'CREATE' at line 1, column 1."*, and the
  parser then lists what it expected: `"INSERT"`, `"UPSERT"`, `"EXPLAIN"`, `"SET"`, `"RESET"`, … with
  no form of `CREATE` among them. A datasource comes into existence by being ingested into. Per the
  capability-honesty rule in [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md), a flag that is
  `true` but produces a control that can only emit invalid input is a defect, so it stays `false` and
  the Create Table modal never appears.
- **`supportsMaintenance: false`, `maintenanceOperations: []`.** Nothing in `MaintenanceType`
  (`vacuum`, `analyze`, `reindex`, `optimize`, `check`, `kill`) has a Druid analogue reachable from
  SQL. Compaction and retention are **Coordinator and task** concerns, out of scope for #265. `kill`
  is impossible for a second, independent reason: there is no `sys.queries` catalog, so there is
  nowhere honest for a user to read a cancellable query id from.
- **`supportsConnectionString: false`.** See
  [§4.2](#42-there-is-no-connection-string-and-that-is-deliberate).

`schemaRefreshPattern` is `\b(INSERT|REPLACE)\b` — the only two statements that could change a
datasource. The native engine rejects both, so in practice a query never refreshes the schema, which
is *correct*: a Druid schema changes through ingestion, not through the editor.

### 3.12 EXPLAIN: the native plan is genuinely a tree

`ExplainFormat` gains `"druid-native"`, with the strategy in
[`src/lib/explain/druid-native.ts`](../../src/lib/explain/druid-native.ts).

**What the plan is.** `EXPLAIN PLAN FOR <select>` returns **one row with three columns — `PLAN`,
`RESOURCES`, `ATTRIBUTES` — each a JSON *string***, so the envelope parse leaves three escaped blobs
behind and each needs a second parse. `PLAN` is an array of
`{ query, signature, columnMappings }` entries, where `query` is the **native** Druid query the
cluster will actually run. Live, for a join:

```json
{ "type": "join",
  "left":  { "type": "table", "name": "libredb_demo" },
  "right": { "type": "query", "query": { "queryType": "groupBy",
             "dataSource": { "type": "table", "name": "libredb_rollup" }, ... } },
  "rightPrefix": "j0.",
  "condition": "(\"region\" == \"j0.d0\")",
  "joinType": "INNER" }
```

**Why it renders as a tree honestly.** The recursion through `dataSource` **is** the operator tree —
a `query` dataSource wraps another native query, a `join` has a `left` and a `right`, a `union` has
`dataSources[]`, and `table` / `lookup` / `inline` / `external` are leaves. Rendering that as
`{ kind: "tree" }` describes what Druid will run; it is not a flat list forced into a tree shape.
Node labels name the **native query type** (`groupBy`, `scan`, `timeseries`, `topN`) and the
datasource, so a reader sees Druid's own vocabulary rather than a borrowed relational-plan one.

**What keeps it honest is what is left out: no `metrics` on any node.** Druid's planner emits **no
cost and no row estimate anywhere** in this payload — verified across scan, groupBy and join plans.
`ExplainTreeNode.metrics` is optional, so the tree carries structure and nothing it cannot support. A
fabricated cost would be worse than none: the render model shows metrics as measured facts.
`filter`, `dimensions`, `aggregations` and `granularity` are surfaced as **child rows** (the tree
renderer shows only labels, so what a reader needs to see has to be a label) — never as metrics:

```
groupBy
├── table libredb_demo
├── granularity: all
├── filter: range on qty
├── dimensions: region AS d0
└── aggregations: count AS a0
```

**What was rejected.** `useNativeQueryExplain: false` also works and returns an indented Calcite
`RelNode` text plan (`DruidJoinQueryRel` over two `DruidQueryRel`s). It was **not** chosen: it depends
on a non-default context flag, and it is indentation-parsed text where the default is structured
JSON.

Strategy details:

- `buildSql(sql, mode)` returns `EXPLAIN PLAN FOR ${sql}` for `SELECT` statements in **both** modes,
  and `null` for anything else. Druid's `EXPLAIN` never executes the statement, so the estimate is the
  only plan available either way — and returning `null` for `analyze` would not narrow the feature, it
  would **disable** it: the direct Explain action always builds with mode `analyze` and refuses to run
  when the strategy declines, so the button would go dead while only the background pre-warm worked.
  This is the defect found in review on #263, and `sqlite-queryplan.ts` and `couchbase-json.ts` make
  the same call for the same reason. A trailing semicolon survives —
  `EXPLAIN PLAN FOR SELECT 1 AS c1;` is live-verified as accepted.
- `extractPlan()` parses all three columns and stores `{ plan, resources, attributes }`, so the
  raw-JSON tab and the AI tab get a structure rather than three escaped blobs. Any column that is
  absent or will not parse is tolerated — the unparsed text is kept rather than dropped — and if none
  of the three is recognisable the rows are handed through unchanged rather than replaced by an object
  of three `undefined`s.
- `toRenderModel()` walks each entry's `query`, unwrapping up to four wrapper layers (stored JSON
  text, the `{ plan }` member, the entry array) so it accepts the plan at whichever depth the storage
  layer hands it back. Recursion depth is bounded at 32 and a truncation is **labelled** rather than
  silently cut. An unknown `dataSource` type renders as a leaf named by that type instead of being
  dropped — Druid adds dataSource types between releases, and a dropped node would make the tree
  quietly lie about what runs.
- **`PLAN` is an array and is not always length 1**: two aggregating branches of a `UNION ALL` come
  back as two independent native queries (live-verified). A synthetic root (`2 native queries`) is the
  only way to show both without pretending one is the parent of the other; a single query is its own
  root.

---

## 4. Connection

### 4.1 Configuration fields

The form offers exactly four fields
([`db-ui-config.ts:115`](../../src/lib/db-ui-config.ts)): `host`, `port`, `user`, `password`.

| Field | Required | Notes |
|---|---|---|
| `host` | **Yes** | `validate()` throws `DatabaseConfigError` ("Druid requires a host") when it is missing. There is no connection string to substitute for it |
| `port` | No | Defaults to `8888` (the Router). Use `8082` for a Broker ([§3.3](#33-router-8888-or-broker-8082--both-work-identically)). One default for both schemes on purpose: a TLS Druid serves on whatever `druid.tlsPort` the deployment chose, so there is no well-known HTTPS port to fall back to, and inventing one would send credentials to a port nothing is listening on |
| `user` / `password` | No | Sent as HTTP Basic **only when `user` is set**, for the `druid-basic-security` extension. A default install loads no security extension and **ignores the header entirely** — live-verified, a bogus `Basic` header still answers `200` — so credentials are genuinely optional |
| `ssl` | No | Any mode but `disable` switches the transport to `https` ([§4.3](#43-tls)) |
| `database` | — | **Not offered, and ignored if set** — see below |

**There is no `database` field, and that is not an omission.** Druid has no database or catalog to
select. `INFORMATION_SCHEMA.SCHEMATA` reports exactly **one catalog**, always named `druid`:

```
[["CATALOG_NAME","SCHEMA_NAME", ...],
 ["druid","druid", ...], ["druid","INFORMATION_SCHEMA", ...], ["druid","lookup", ...],
 ["druid","sys", ...], ["druid","view", ...]]
```

Five *schemas* exist under that one catalog, but only `druid` holds datasources, it is the **default**
schema, and the other four are fixed. So a database selector would be a control with no effect —
and, worse, a control that implies a scoping decision the user does not have. Because `druid` is the
default schema, `SELECT * FROM "libredb_demo"` resolves with no qualification at all, which is why
none of the Couchbase `query_context` problem arises here.

```ts
const connection = {
  id: 'druid-1',
  name: 'Druid',
  type: 'druid',
  host: '127.0.0.1',
  port: 8888,
  createdAt: new Date(),
};
```

### 4.2 There is no connection string, and that is deliberate

`supportsConnectionString` is `false` and `showConnectionStringToggle` is `false`, so the form has no
paste tab. Two independent reasons:

- **Druid has no URI convention for its HTTP SQL API.** Its own JDBC driver addresses Avatica
  (`jdbc:avatica:remote:url=http://host:8888/druid/v2/sql/avatica/`), which is not a URL the shared
  parser could round-trip into host/port/user/password. Inventing `druid://` would add a parser branch
  for a string no Druid user has ever typed.
- **`http://` and `https://` are already claimed by ClickHouse** in
  [`connection-string-parser.ts`](../../src/lib/connection-string-parser.ts) (#264), where an HTTP URL
  *is* the canonical connection target.

`connection-string-parser.ts` is therefore **not touched by this provider**, and
[`tests/unit/lib/connection-string-parser.test.ts`](../../tests/unit/lib/connection-string-parser.test.ts)
pins both halves of the absence so a future reader does not read it as a gap: `druid://` parses to
`null`, and `http://localhost:8888` still detects as `clickhouse`. The consequence is recorded rather
than hidden — pasting a Druid Router URL selects ClickHouse; a Druid connection is made through the
form fields instead, which is why its form has no paste toggle at all.

### 4.3 TLS

`config.ssl` with any `mode` but `disable` switches the transport from `http` to `https`. `ssl` is a
first-class `DatabaseConnection` field and is independent of the form's `connectionFields`, so it
applies even though the Druid form shows no TLS row of its own. An explicit `disable` turns TLS
**off** as firmly as an explicit mode turns it on (the #264 lesson).

The port is **not** changed by TLS, unlike ClickHouse's `8123` → `8443`: a TLS Druid serves on
whatever `druid.tlsPort` the deployment configured, and there is no well-known value to guess.

As with ClickHouse, `ssl.caCert`, `ssl.clientCert` and `ssl.rejectUnauthorized` are **not honoured**:
global `fetch` cannot carry a custom CA or relax verification without an undici `Agent` as its
`dispatcher`, and undici is not a dependency. A cluster behind a **self-signed** certificate therefore
fails verification; one with a publicly-trusted certificate works. Honouring them needs the
`node:https` path Couchbase already has, which is a follow-up rather than a limitation of the scheme.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?)` ([index.ts:328](../../src/lib/db/providers/sql/druid/index.ts)) sends one
statement under both deadlines from [§3.8](#38-both-halves-of-the-timeout), with its `?` parameters
bound ([§3.10](#310-positional-parameters-really-execute)):

```ts
await provider.query('SELECT id, name FROM "libredb_demo" LIMIT 50');
await provider.query('SELECT COUNT(*) AS c FROM "libredb_demo" WHERE region = ?', ['emea']);
```

`prepareQuery()` injects `LIMIT`/`OFFSET` through the shared limiter
(`supportsExternalQueryLimiting: true`) unless the statement ends in an `OFFSET` with no `LIMIT`
([§3.9](#39-the-preparequery-override-offset-with-no-limit)).

A write is **not special-cased**. Every write form Druid rejects, it rejects with a message that names
both the reason and the alternative, which is more useful than anything this provider would substitute
([§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly)).

### 5.2 Result shaping

| Source | `QueryResult` field | Notes |
|---|---|---|
| the data rows | `rows` | Rebuilt from the positional arrays, keyed by the disambiguated column names |
| header row 0 | `fields` | Declared column order, made unique (`c`, `c (2)`); `[]` when the payload carried no header |
| — | `rowCount` | `rows.length`. There is no second number: no Druid statement mutates, so a mutation count could only ever be zero |
| the measured exchange | `executionTime` | Rounded milliseconds, **measured by the transport**. The endpoint reports no timing whatsoever, so there is no server-side number this could be preferred over ([§3.2](#32-the-transport-seam-one-interface-one-implementation)) |
| header row 2 (SQL types) | `columnTypes` | Keyed by the same disambiguated names; **absent** when the payload declared no types. The native types (header row 1) deliberately do not travel — they lie for an expression ([§3.5](#35-the-sql-type-labels-the-column-because-the-native-type-lies)) |
| `X-Druid-Response-Context.missingSegments` | `warnings` | One warning naming how many segments were unavailable, and **absent** for a whole answer or an answer that said nothing about availability ([§13](#13-known-limitations--future-work)) |

### 5.3 `ARRAY` cells arrive as JSON strings

Druid's `sqlStringifyArrays` query context defaults to **true**, so an array column comes back as
text, live-verified:

```
SELECT ARRAY[1,2] AS a, ARRAY['alpha'] AS b
-> [["a","b"], ["ARRAY<LONG>","ARRAY<STRING>"], ["ARRAY","ARRAY"], ["[1,2]","[\"alpha\"]"]]
```

Setting `sqlStringifyArrays: false` genuinely returns real JSON arrays (`[["a"],[[1,2]]]`), and the
provider deliberately **keeps the default** and does **not** parse the strings back into arrays:
that is what every Druid client shows, so the grid matches the web console and any other tool the
user has open. The type is honest about it — the SQL type says `ARRAY` while the value is a string —
which is better than a silent re-parse that would disagree with the same query run anywhere else.

### 5.4 Dialect traps a user will hit

These are Druid's, not the provider's, and each one is a real 400 a user can produce in the editor.
None of them needs a code change; all three need to be documented, which is what this section is for.

**`ORDER BY` on a non-`__time` column of a plain table scan is rejected.** Live:

```
SELECT id FROM libredb_demo ORDER BY id LIMIT 2
-> 400  "Query could not be planned. A possible reason is [SQL query requires ordering
         a table by non-time column [[id]], which is not supported.]"
```

Ordering by `__time` works, and ordering *anything* works once there is a `GROUP BY`, because that is
an aggregation rather than a scan. Sort in the results grid, add a `GROUP BY`, or order by `__time`.
The provider's own generated SQL is safe by construction: `generateTableQuery` emits
`SELECT * FROM libredb_demo LIMIT 50;` with **no** `ORDER BY`, and no provider-generated statement may
ever add one to a scan — ordering by the primary key, the obvious thing for a generator to do, would
break every datasource browse.

**Calcite's reserved-word list is large and surprising.** `SELECT 1 AS one` is a syntax error:

```
-> 400  "Incorrect syntax near the keyword 'AS' at line 1, column 10."
        (the parser then lists everything it expected, including "AS" <QUOTED_IDENTIFIER>)
```

`one` is reserved. So are `rows`, `count`, `value`, `user`, `start`, `end` and `year` — every one of
those verified as a 400 in the form `SELECT 1 AS <word>` — and the full Calcite list is far longer.
That is why **every generated identifier and alias in this provider is double-quoted** as a blanket
habit rather than word by word (`SUM("size") AS "sizeBytes"`, `"type" AS "taskType"`): auditing a
projection against Calcite's list on every change is not a maintainable rule, and quoting is free.
Quoting is what makes the word an identifier — `SELECT 1 AS "one"` is accepted. If you hand-write a
statement and get an unexplained syntax error near a perfectly ordinary word, quote it.

**`LIMIT 5 LIMIT 2` is a syntax error**, and so is `SELECT 1 AS c1; LIMIT 2`. The shared limiter never
produces either: it preserves an existing `LIMIT`, and it inserts its own before the terminating
semicolon rather than after it.

### 5.5 Druid SQL cannot write, and the server says so clearly

Every one of these is **HTTP 400** and every message below is quoted verbatim from Apache Druid
37.0.0:

| statement | `errorMessage` |
|---|---|
| `INSERT INTO t SELECT ...` | `INSERT operations are not supported by requested SQL engine [native], consider using MSQ.` |
| `REPLACE INTO t OVERWRITE ALL SELECT ...` | `REPLACE operations are not supported by the requested SQL engine [native].  Consider using MSQ.` |
| `UPDATE t SET ...` | `Unsupported SQL statement [UPDATE]` |
| `DELETE FROM t WHERE ...` | `Unsupported SQL statement [DELETE]` |
| `CREATE TABLE t (id BIGINT)` | `Incorrect syntax near the keyword 'CREATE' at line 1, column 1.` — not in the grammar at all |

**The provider does not special-case any of them.** Druid's own message already names the reason and
the alternative, which is more useful than a substitute, and `mapDruidError()` surfaces it verbatim as
a `QueryError`. Note that `UPDATE` and `DELETE` are not "unimplemented on this endpoint" — they are
not in Druid SQL *anywhere*, on any engine.

**`INSERT` and `REPLACE` do exist, but only through the MSQ task engine on
`POST /druid/v2/sql/task`**, which is out of scope for #265: it is a submit/poll protocol that returns
a task id instead of rows, so it does not fit the `query()` contract at all. The synchronous endpoint
this provider uses rejects both even on a cluster where `druid-multi-stage-query` is loaded and fully
capable of running them — which is exactly the case the live fixture is configured to prove.

**How data is actually removed from Druid**, since no SQL statement can do it. Two steps, both through
the Coordinator (reachable on `8888` when the Router's management proxy is enabled):

1. **Mark the segments unused** — `POST /druid/coordinator/v1/datasources/{datasource}/markUnused`
   with an `interval` or a list of `segmentIds`. This makes the data invisible to queries immediately;
   it does not delete anything. Live, over an interval covering a two-segment datasource:
   `{"numChangedSegments":2,"segmentStateChanged":true}`.
2. **Submit a `kill` task** to the Overlord (`POST /druid/indexer/v1/task`) — that is what deletes the
   segment files from deep storage and the rows from the metadata store:

   ```json
   { "type": "kill", "dataSource": "libredb_docprobe",
     "interval": "1000-01-01T00:00:00Z/3000-01-01T00:00:00Z" }
   ```

Both steps were run end to end against the live cluster while writing this document, and step 1 alone
is enough to make the datasource **disappear from `INFORMATION_SCHEMA.TABLES` entirely** — which is
what the schema tree reflects, and why there is no empty-datasource case
([§6](#6-schema-introspection)).

### 5.6 EXPLAIN

The EXPLAIN button is available (`supportsExplain: true`) and renders the native plan tree described
in [§3.12](#312-explain-the-native-plan-is-genuinely-a-tree). Druid has no analyze mode, so the direct
action and the background pre-warm show the same plan — with no cost and no row estimates, because
Druid's planner publishes none.

---

## 6. Schema introspection

`getSchema()` ([introspect.ts:493](../../src/lib/db/providers/sql/druid/introspect.ts)) makes **two**
`INFORMATION_SCHEMA` reads in parallel with `Promise.all`, both through the transport seam:

| Data | Source |
|---|---|
| Datasources | `INFORMATION_SCHEMA.TABLES` where `TABLE_SCHEMA = 'druid'`, ordered by name |
| Columns | `INFORMATION_SCHEMA.COLUMNS` where `TABLE_SCHEMA = 'druid'`, ordered by `TABLE_NAME, ORDINAL_POSITION` |
| Indexes | always `[]` — Druid has no user-defined indexes |
| Foreign keys | always `[]` — Druid has no foreign keys anywhere |

**Only the `druid` schema is listed.** The same catalog also carries the four `INFORMATION_SCHEMA`
views and the six `sys` tables as `TABLE_TYPE = 'SYSTEM_TABLE'`, and a cluster with lookups or views
carries rows under a `lookup` / `view` schema besides. Live, on the fixture cluster:

```
["INFORMATION_SCHEMA","COLUMNS","SYSTEM_TABLE","NO","NO"]      ... 4 rows
["druid","libredb_demo","TABLE","NO","NO"]
["druid","libredb_rollup","TABLE","NO","NO"]
["sys","segments","SYSTEM_TABLE","NO","NO"]                    ... 6 rows
```

The schema predicate is the entire mechanism that keeps all of that out of the sidebar. Everything
excluded stays **queryable by typing SQL** — the monitoring panels read `sys` themselves — so nothing
is lost, only unlisted.

**`TableSchema.name` is the bare datasource name.** `druid` is the default schema, so
`SELECT * FROM "libredb_demo"` resolves without qualification. No prefix is added and none is needed.

**No column is primary — `__time` included.** It is mandatory in every datasource, it is the
partitioning key and the sort key within a segment, and it is the only column Druid reports as
`IS_NULLABLE = 'NO'`. Live, for `libredb_demo`:

```
["__time",1,"TIMESTAMP","NO",93,""]
["snowflake_id",2,"BIGINT","YES",-5,""]
["id",3,"BIGINT","YES",-5,""]
...
```

All of which makes `__time` tempting to mark `isPrimary`, and an earlier revision did. It is wrong,
because **a primary key is unique and `__time` is not**:

```
$ SELECT COUNT(*) AS total, COUNT(DISTINCT __time) AS distinct_times FROM libredb_demo
{"total":50,"distinct_times":30}
```

Nothing in a Druid datasource is unique, and `isPrimary` is not a hint — three consumers state it as
fact. `sql-completions.ts` appends `(PK)` in autocomplete, `use-ai-chat.ts` puts `, PK` into the
schema context the model reasons from, and `schema-diff/diff-engine.ts` reports
`Primary key changed` — so two datasources differing only in this would diff as a key change. What
`__time` actually is would need a partition/time-key concept distinct from a primary key, and
`ColumnSchema` has no such field. It stays identifiable the honest way: by name, and by being the one
column with `nullable: false`.
`COLUMN_DEFAULT` is `""` for every column of every datasource — a Druid column has no default (an
absent dimension is null) — so it is not read at all. `ORDINAL_POSITION` orders the read rather than
appearing in it: it *is* the declared column order, so it has no separate value to carry.

**`indexes: []` and `foreignKeys: []` are by construction, not by omission.** Druid indexes every
dimension inside its segment, but those indexes have no name, no size and no usage counter of their
own — there is no index *object* a row could describe — and no Druid DDL declares a foreign key.

### The catalog is a view of what is *servable*, not of what exists

This is the single most surprising thing about Druid introspection, and the one most likely to be
mistaken for a bug in the editor. Verified two independent ways on 37.0.0:

**1. Marking every segment unused removes the datasource from the catalog.**

```
$ curl -s -XPOST -H 'content-type: application/json' \
    -d '{"interval":"1000-01-01/3000-01-01"}' \
    http://localhost:8888/druid/coordinator/v1/datasources/libredb_rollup/markUnused
{"numChangedSegments":3,"segmentStateChanged":true}
```

`libredb_rollup` then vanishes from `INFORMATION_SCHEMA.TABLES` and from `sys.segments`, and
`markUsed` brings it back. So an empty result means "no *servable* datasources", and **there is no
empty-datasource case to render** — the exact opposite of Couchbase's empty-collection case. Do not
go looking for one.

**2. Stopping the Historical makes an existing datasource report as a typo.** With the process that
serves the segments down, and nothing else advertising them:

```
$ docker stop libredb-druid-historical
$ curl -s -XPOST -H 'content-type: application/json' \
    -d '{"query":"SELECT COUNT(*) FROM libredb_demo"}' http://localhost:8888/druid/v2/sql
HTTP 400
{"error":"druidException","errorCode":"invalidInput","persona":"USER",
 "category":"INVALID_INPUT",
 "errorMessage":"Object 'libredb_demo' not found (line [1], column [27])"}
```

The datasource still exists in the metadata store. The Broker simply has no server advertising its
segments, so it is not in the catalog — and the failure is classified **`INVALID_INPUT`, blaming the
statement**. It is indistinguishable, in both status and category, from genuinely mistyping the name
(§3.7 shows the same envelope for `SELECT * FROM nope`).

**What this means in practice:** if a datasource you know exists reports *"Object '&lt;name&gt;' not
found"* and disappears from the schema tree, suspect availability before suspecting your SQL. Check
`SELECT * FROM sys.servers` for a missing `historical` row, and the Coordinator for unassigned
segments. Nothing in this provider can improve the message — Druid owns both the classification and
the wording — so this paragraph is the mitigation.

`getSchemaList()` and `getSchemaRelations()` are deliberately **not implemented**. Both are optional
and the client falls back to `getSchema()`; the split exists so a slow relationship read cannot block
the table list, and Druid has neither half of that problem — a list would be byte-identical to
`getSchema()`, and a relations read would spend a round trip to answer two empty arrays per
datasource.

---

## 7. Monitoring & health

Every read below degrades to empty/zero when the failure `isMonitoringUnavailable()` —
`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND` and **only** those three
([§3.7](#37-two-error-envelopes-and-the-http-status-is-not-enough)). Anything else propagates and
becomes a message the user sees.

| Method | Source | Mapping |
|---|---|---|
| `getOverview()` ([introspect.ts:524](../../src/lib/db/providers/sql/druid/introspect.ts)) | `sys.servers`, `sys.segments`, `INFORMATION_SCHEMA.TABLES`, `sys.tasks` — **four separate reads** | `version` and `startTime` from the Coordinator's `sys.servers` row (Broker as fallback); `uptime` from `CURRENT_TIMESTAMP - start_time`; `databaseSizeBytes` = `SUM(size)` over active segments; `tableCount` = datasource count; `activeConnections` = count of `RUNNING` tasks; `maxConnections` = **0**; `indexCount` = **0** |
| `getPerformanceMetrics()` | — | **Zeroed, and sends no statement.** Druid's cache, query and ingestion metrics all reach a metrics *emitter* (statsd, Kafka, an HTTP endpoint, the log) and none reaches a SQL-readable table |
| `getSlowQueries()` | — | **`[]`**, and sends no statement. Druid keeps no query log at all |
| `getActiveSessions()` ([introspect.ts:609](../../src/lib/db/providers/sql/druid/introspect.ts)) | `sys.tasks` where `status IN ('RUNNING','PENDING')`, newest first | **Ingestion tasks, not query sessions** — see below |
| `getTableStats()` ([introspect.ts:649](../../src/lib/db/providers/sql/druid/introspect.ts)) | `sys.segments` where `is_active = 1`, grouped by `datasource` | `rowCount` = `SUM(num_rows)`; `tableSizeBytes` and `totalSizeBytes` both = `SUM(size)`; `schemaName` = `"druid"`. A `{ schema }` filter naming anything but `druid` returns `[]` without a round trip |
| `getIndexStats()` | — | **`[]`**, and sends no statement. No index objects exist |
| `getStorageStats()` ([introspect.ts:678](../../src/lib/db/providers/sql/druid/introspect.ts)) | `sys.servers` where `server_type = 'historical'` | one row per historical: `name` = `server`, `location` = `host`, `sizeBytes` = `curr_size`, `usagePercent` = `curr_size / max_size` |
| `getHealth()` ([introspect.ts:700](../../src/lib/db/providers/sql/druid/introspect.ts)) | the above, composed | `activeConnections`, `databaseSize`, up to 10 sessions; `cacheHitRatio` = **`"N/A"`**; `slowQueries` = `[]` |

**The Active Sessions panel shows ingestion TASKS, and this is deliberate.** Druid has **no query
sessions** — no `sys.queries`, no connection catalog, nothing that describes a client. Its tasks are
the only activity it can describe, and returning `[]` while a multi-hour ingestion saturates the
MiddleManagers would report a quiet cluster that is anything but. Each row is therefore made
self-describing rather than disguised as a connection:

| `ActiveSessionDetails` field | Druid value |
|---|---|
| `applicationName` | the constant **`"Druid ingestion task"`** — this is what stops the row being read as a client connection |
| `pid` | `task_id` |
| `database` | `datasource` (live-verified: a task with none, such as `noop`, reports the literal string `"none"`) |
| `state` | `status` — `RUNNING` or `PENDING` |
| `query` | the task **type** — `index_parallel`, `compact`, `kill` — the closest thing a task has to a statement |
| `user` | `"unknown"` — `sys.tasks` records no submitter identity (a `druid-basic-security` cluster puts it in the audit log), and borrowing the connection's user would credit it with a task it did not submit |
| `durationMs` | `CURRENT_TIMESTAMP - created_time`, **not** `sys.tasks.duration` |

The panel asks for 50 rows when the caller names no limit, and the health summary asks for 10. A
non-positive or fractional limit falls back to the default rather than being inlined into the
statement, so the row cap can only ever be a positive integer in the generated SQL.

The honest empties, each with its reason:

- **`getPerformanceMetrics()` is zeroed** because Druid's metrics do not reach SQL. `cacheHitRatio` is
  required by the type so it carries a neutral `0`; every other metric in that type is *optional*, so
  absence is expressible and they are left out entirely — a zero would read as a measurement of zero,
  which is a different and false claim.
- **`getHealth().cacheHitRatio` is the string `"N/A"`.** That field is a `string`, so it can say
  "not measured" — which is the truth. A fabricated low number would trip the cache-ratio threshold
  alert into reporting a fault that does not exist. `sqlite.ts` and `oracle.ts` already spell an
  unavailable ratio this way.
- **`getSlowQueries()` is `[]`** because there is nothing to ask. This is not a switched-off feature
  and not a permission gate, unlike ClickHouse's `system.query_log`: no `sys` table, no endpoint and
  no file holds finished queries. No statement is sent to discover that.
- **`getIndexStats()` is `[]`** and **`indexCount` is `0`** because no index object exists
  ([§6](#6-schema-introspection)).
- **`maxConnections` is `0`** because Druid publishes no connection limit anywhere in SQL — it has no
  pool. A number here would be invented.
- **`uptime` says `"unknown"`, not `"0ms"`**, when either clock reading is missing: an uptime of zero
  claims the cluster booted this instant, which is a statement the server never made. The branch is on
  the two *readings* rather than on their difference, so a cluster that genuinely came up this
  millisecond still reports a measured 0.

Five load-bearing live findings behind the code, each of which silently produces wrong output if
forgotten:

1. **A grouping-less aggregate over zero matching rows returns NO DATA ROW**, not a row of zeros:

   ```
   SELECT COUNT(*) AS c FROM sys.supervisors   ->   [["c"]]
   ```

   So every scalar read has to survive an *absent row*, not merely a null. (`sys.supervisors` is
   genuinely empty on a batch-only cluster, and is not read: streaming supervisors are out of scope.)
2. **`sys.tasks.duration` is `-1` for a task that has not finished** — which is every task the
   sessions read selects — so reporting that column would print `-1ms` on every row. It is not even
   projected, which is what stops someone reaching for it later; the age comes from two readings of
   the **server's own** clock instead.
3. **`sys.servers` reports `max_size = 0` for every process that is not a historical**, so the usage
   division meets a zero denominator in ordinary operation. It yields `0`, not a flattering `100` and
   not `NaN`. Live:

   ```
   [["server","server_type","version","curr_size","max_size"],
    ["172.18.0.7:8082","broker","37.0.0",0,0],
    ["172.18.0.4:8081","coordinator","37.0.0",0,0],
    ["172.18.0.5:8083","historical","37.0.0",19617,300000000000],
    ["172.18.0.6:8091","middle_manager","37.0.0",0,0],
    ["172.18.0.4:8081","overlord","37.0.0",0,0],
    ["172.18.0.8:8888","router","37.0.0",0,0]]
   ```

   The Coordinator and Overlord share one address (one process, `asOverlord` enabled), which is why
   the identity read orders by `server_type` and takes one row rather than assuming a row count.
4. **`is_active = 1` on every `sys.segments` read is not an optimisation.** That table describes every
   segment the metadata store knows about, including ones superseded by a compaction or a
   re-ingestion of the same interval. Summing those would count the same rows and bytes twice, so a
   re-ingested datasource would appear to double in size.
5. **A large `SUM(size)` arrives as a quoted decimal string**, because the transport quotes unsafe
   integer literals before parsing ([§3.6](#36-64-bit-integers-arrive-unquoted-and-druid-offers-no-server-side-fix)).
   Both encodings reach these mappers, and both are handled.

**Why four reads in `getOverview()` and not one joined statement**: `sys` permissions are granted per
table on a `druid-basic-security` cluster, so a role that declines `sys.tasks` must still get the
datasource count `INFORMATION_SCHEMA` answers happily. Combining them would throw away every panel a
restricted user *can* see. The schema tree goes further and touches **no `sys` table at all**, so a
cluster that merely declines to describe its servers still renders a full sidebar; the per-datasource
counts live in `getTableStats()`, where a denial costs one panel instead of the whole tree.

---

## 8. Maintenance

**There is none.** `supportsMaintenance` is `false` and `maintenanceOperations` is `[]`, so the
Maintenance panel offers no operation for a Druid connection.

**The monitoring Tables tab no longer offers one (issue #272).** It used to render
`Analyze` / `Vacuum` / `Reindex` per row unconditionally — `TablesTab.tsx` never read
`getCapabilities()` — so those three buttons were present for Druid and every click answered
`HTTP 400 {"error":"Maintenance operations not supported for this database"}`. That tab now takes the
connected provider's capabilities (`MonitoringDashboard.tsx` passes them down from
`useProviderMetadata`) and renders no maintenance control where `supportsMaintenance` is `false`, only
the declared operations where it is `true`, and none at all until the metadata has resolved. That was
never Druid-specific: `libredb.ts` also sets `supportsMaintenance: false` and had exactly the same
dead buttons, so the fix landed once in shared UI for every provider.

**The admin Operations tab still has the same gap.** `src/components/admin/tabs/OperationsTab.tsx`
renders its global `Run Analyze` / `Run Vacuum` / `Run Reindex` controls and its per-table
Analyze/Vacuum buttons without reading `getCapabilities()`, so those still answer 400 here. #272's
bar covers the monitoring Tables tab only; the Operations tab is tracked as
[#282](https://github.com/libredb/libredb-studio/issues/282). Stated
explicitly because a doc claiming "no control offers any operation" would be describing the intent
instead of the software.

`runMaintenance(type)` ([index.ts:471](../../src/lib/db/providers/sql/druid/index.ts)) exists because
the `DatabaseProvider` interface obliges every provider to implement it, and **not** because any
request reaches it: `/api/db/maintenance`
([route.ts](../../src/app/api/db/maintenance/route.ts)) checks `supportsMaintenance` and returns
`{ "error": "Maintenance operations not supported for this database" }` with status 400 before it
would ever call the provider. So the message below is what a *programmatic* caller of the
`@libredb/studio` package sees, not what the HTTP API returns — `docs/API_DOCS.md` documents the
route's own wording. It throws a `QueryError` naming the reason:

> Druid has no SQL-reachable maintenance operation, so "\<type\>" cannot run here. Compaction and
> retention are Coordinator and task concerns, and Druid publishes no catalog of running queries to
> cancel one from.

Both halves of that are real constraints, not scope cuts made lightly:

- `vacuum` / `optimize` / `reindex` / `check` — the nearest Druid analogue is **compaction**, which is
  a Coordinator auto-compaction config or a `compact` **task**, not SQL. Retention is a load rule on
  the Coordinator. Both are out of scope for #265 and would need a task-management surface that does
  not exist yet ([§13](#13-known-limitations--future-work)).
- `kill` — impossible for a second, independent reason: there is no `sys.queries` catalog, so there is
  nowhere honest for a user to read a cancellable query id from. (Druid *can* cancel by
  `sqlQueryId`, which is a different feature — see [§13](#13-known-limitations--future-work).)
- `analyze` — Druid needs none. A segment's statistics *are* its structure, current by construction,
  and unlike ClickHouse there is no per-table parts summary worth substituting: `getTableStats()`
  already reports rows and bytes per datasource in the monitoring panel.

---

## 9. Capabilities & labels

### `getCapabilities()` ([index.ts:151](../../src/lib/db/providers/sql/druid/index.ts))

| Capability | Value | Why |
|---|---|---|
| `queryLanguage` | `sql` | Calcite SQL over the native engine |
| `supportsExplain` | `true` | `EXPLAIN PLAN FOR` returns a structured native plan ([§3.12](#312-explain-the-native-plan-is-genuinely-a-tree)) |
| `explainFormat` | `druid-native` | The strategy id in `src/lib/explain/index.ts` |
| `supportsExternalQueryLimiting` | `true` | `LIMIT n` / `LIMIT n OFFSET m` are both correct Druid SQL |
| `supportsCreateTable` | **`false`** | `CREATE` is not in the grammar; a datasource is created by ingestion ([§3.11](#311-the-three-false-capabilities-are-each-impossible-not-merely-unimplemented)) |
| `supportsInlineRowEdit` | **`false`** | `UPDATE t SET ...` answers `Unsupported SQL statement [UPDATE]`; Druid SQL has no row-level DML ([§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly)) |
| `supportsMaintenance` | **`false`** | Nothing in `MaintenanceType` is reachable from Druid SQL ([§8](#8-maintenance)) |
| `maintenanceOperations` | `[]` | Consequence of the above |
| `supportsConnectionString` | **`false`** | Druid has no URI convention, and `http(s)://` is ClickHouse's ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)) |
| `defaultPort` | `8888` | The Router. `8082` (Broker) is equally valid ([§3.3](#33-router-8888-or-broker-8082--both-work-identically)) |
| `schemaRefreshPattern` | `\b(INSERT\|REPLACE)\b` | The only statements that could change a datasource — and the native engine rejects both, so in practice a query never refreshes the schema, which is correct |

### `getLabels()` ([index.ts:194](../../src/lib/db/providers/sql/druid/index.ts))

Exactly two overrides:

- `entityName` → **"Datasource"**, `entityNamePlural` → **"Datasources"**. Datasource is the Druid
  word for a table, and the sidebar is where a user meets it.

Everything else is inherited on purpose. **A Druid row is a row**, so renaming it would only make the
grid speak a dialect the cluster does not. The maintenance labels are irrelevant here
(`supportsMaintenance` is `false`, so no control ever shows them) and must still be strings, so they
stay as inherited rather than naming operations that do not exist. `selectAction` ("Select Top 50")
and the generate action are inherited unchanged and are correct for Druid.

---

## 10. Error handling

The transport normalizes every failure into `DruidTransportError { message, category, errorCode,
persona }`; `mapDruidError()`
([index.ts:358](../../src/lib/db/providers/sql/druid/index.ts)) maps that onto the shared classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts) — **keyed on `category`, never on the HTTP
status**:

| Category | Meaning | Error raised |
|---|---|---|
| `UNAUTHORIZED`, `FORBIDDEN` | Bad or missing credentials on a secured cluster | `AuthenticationError` |
| `TIMEOUT` | The statement deadline was hit (HTTP 504) | `TimeoutError` |
| `CANCELED` | The query was cancelled | `QueryCancelledError` |
| `INVALID_INPUT`, `UNSUPPORTED`, `NOT_FOUND`, `UNCATEGORIZED`, `RUNTIME_FAILURE`, `CAPACITY_EXCEEDED`, `DEFENSIVE` | A statement the cluster understood and rejected — including `SELECT 1/0`, which arrives as HTTP 500 | `QueryError` carrying Druid's own `errorMessage` |
| `TRANSPORT_FAILURE` (the stand-in — no server classified anything) | A refused socket, an abort, a proxy's HTML page, a truncated body, a parameter refused before the request left | Falls through to the shared message-based `mapError()`, exactly as `clickhouse/index.ts` does when the server named no exception code |

The stand-in is deliberately **not** read as "the cluster is unreachable": several of those causes are
the user's own doing, so the shared mapping decides.

| Situation | Error |
|---|---|
| Missing `host` | `DatabaseConfigError` — "Druid requires a host" |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails on credentials | `AuthenticationError` — a rejected credential is not a connectivity problem, and saying so would send the user to check their host |
| `connect()` fails otherwise | `ConnectionError` carrying host and port |
| A parameter value with no Druid type | An error naming the unsupported type, raised **before** anything leaves the process |

One shape worth knowing because it looks like a bug and is not: **a cancelled streamed query answers
HTTP 200 and then simply stops.** Live-reproduced on 37.0.0 — a large result cancelled through
`DELETE /druid/v2/sql/{sqlQueryId}` streamed 3.6 MB and cut off mid-value. The status line was
committed long before the failure, a large result is served `Transfer-Encoding: chunked` (verified),
and nothing in the headers can be revised after the fact, so **the truncated body is the only
evidence a client has** — and an HTTP trailer, the one place a chunked response could still say
something, is unreachable through `fetch` in any case. The transport reports it as *"Druid ended the
response before it was complete, so the result is incomplete"* rather than a JSON parse complaint
(which tells the person who ran the query nothing) or an empty success (which would be worse).

The mirror-image case was **verified not to happen** and is therefore deliberately not handled: a
failure the Broker learns of *before* it commits the status — `1/(id-1005)` after 35 MB of rows had
already crossed the cluster — still answers a clean 500 whose body is the error envelope **alone**,
with no partial result in front of it. That is the opposite of ClickHouse's buffered case (#264), so
there is nothing to trim.

---

## 11. Testing

### 11.1 How the tests work

There is **no `mock.module()` anywhere in the Druid suite**, so none of these files carries
process-wide contamination risk:

- [`tests/integration/db/druid-provider.test.ts`](../../tests/integration/db/druid-provider.test.ts)
  replaces `globalThis.fetch` per test and restores it in `afterEach`, so the real transport, the real
  introspection, the real explain strategy and the real provider all run — only the cluster is fake.
  Every payload in it was captured from a live Apache Druid 37.0.0 cluster (datasources
  `libredb_demo`, 50 rows, and `libredb_rollup`, 20 rows), so the fake speaks exactly what the server
  speaks. It also pins the exact statement each introspection read sends, by importing the exported
  SQL constants: a test that matched a substring would keep passing after a projection changed shape,
  which is precisely the change that breaks a mapper.
- [`tests/unit/db/druid/http-transport.test.ts`](../../tests/unit/db/druid/http-transport.test.ts)
  drives `DruidHttpTransport` against a faked `fetch`: request shape, endpoint construction
  (host/port/TLS/IPv6 bracketing), Basic auth presence and absence, the three-header-row result path,
  the empty-result path, duplicate-column disambiguation, `quoteUnsafeIntegers` as its own unit
  (string literals, escaped quotes, floats, exponents, negatives, every adjacency, and the no-op
  case), every parameter type including the `bigint` raw literal and the refusals, both error
  envelopes, the HTTP-500-that-is-a-user-error, a non-JSON body, and the truncated-body case.
- [`tests/unit/db/druid/introspect.test.ts`](../../tests/unit/db/druid/introspect.test.ts) drives the
  introspection and monitoring module through a hand-built query runner — the payoff of the seam in
  [§3.2](#32-the-transport-seam-one-interface-one-implementation): no fetch mocking, no server. It
  covers the absent-row aggregate, the `duration = -1` task, the `max_size = 0` denominator, the
  quoted-vs-unquoted `SUM`, the `__time` nullability flag, a malformed row costing one column instead of
  the tree, and every degradation path.
- [`tests/unit/db/druid/transport.test.ts`](../../tests/unit/db/druid/transport.test.ts) pins the
  frozen category table and the normalized error — including `is()` and
  `isMonitoringUnavailable()` — ahead of the transport and the provider, because a wrong category
  silently turns a degradation path into a thrown error or the reverse.
- [`tests/unit/db/druid/seam-guard.test.ts`](../../tests/unit/db/druid/seam-guard.test.ts) is a
  parser, not a grep, and proves itself in both directions: it must fire on `http-transport.ts`
  (which is *supposed* to speak HTTP) and stay silent on a compliant sample, before it asserts the
  real provider directory is clean.
- [`tests/unit/lib/explain/druid-native.test.ts`](../../tests/unit/lib/explain/druid-native.test.ts)
  covers the plan walker against a captured join plan: wrapper-depth unwrapping, every `dataSource`
  type including an unknown one, the depth bound and its visible truncation label, the attribute rows,
  and the multi-entry `UNION ALL` synthetic root.

### 11.2 Coverage

Validation (host required), capabilities and labels, connect/disconnect including the `SELECT 1` probe
surfacing a bad endpoint or a rejected credential, query execution and result shaping (declared column
order, duplicate-column disambiguation, the measured duration, parameter binding), the full
category-to-error map including the HTTP-500 user error and the transport stand-in, the
`prepareQuery()` override in both directions (statements that must be limited and the
`OFFSET`-with-no-`LIMIT` statement that must not be), schema introspection, every monitoring method
and its degraded path, `runMaintenance()` refusing with its reason, and the explain strategy end to
end through the registry.

### 11.3 Run it

```bash
# Just this provider
bun test tests/integration/db/druid-provider.test.ts
bun test tests/unit/db/druid
bun test tests/unit/lib/explain/druid-native.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: reproducing the live pass

The committed tests are mock-based by design and never touch a cluster. To reproduce the live
verification behind this document, `database-compose.yml` carries **seven services pinned to
`apache/druid:37.0.0`**, all gated behind a `druid` profile:

```bash
docker compose -f database-compose.yml --profile druid up -d
```

**Why a profile rather than the default `up -d`:** Druid is a distributed system with **no
single-container mode**. Five Druid processes (Coordinator+Overlord, Broker, Historical,
MiddleManager, Router) plus ZooKeeper plus its own metadata database is the minimum that can answer a
SQL query — and the metadata store is deliberately *not* the `postgres` service in the same file,
because sharing it would put Druid's internal tables into the demo database that connection browses.
Ungated, this would take the everyday fixture from 8 services to 15 and add about **4 GB of resident
memory** (measured with `docker stats` on the idle cluster: 1.4 GB Historical, 1.1 GB Broker, and the
rest between the other five). The profile makes that opt-in.

**Only two ports are published**: `8888` (Router) and `8082` (Broker) — the two the provider can talk
to, published so that the Broker-equivalence claim in
[§3.3](#33-router-8888-or-broker-8082--both-work-identically) can be *proven* rather than assumed.
The other five processes are cluster internals and publish nothing; `8091`, the MiddleManager's usual
port, is already taken by the `couchbase` service in the same file, which is a second reason not to.

Wait for the Router to become healthy (`docker compose ... ps`), then point a Studio connection at
`127.0.0.1:8888` with no credentials — a default install loads no security extension. Repeat with port
`8082` to exercise the Broker path.

**A datasource can only be created by ingestion.** There is no `CREATE TABLE` and no seed sidecar that
could substitute for one, so load data by submitting a **native batch task with an inline input
source** to the Overlord (through the Router's management proxy):

```bash
curl -s -XPOST -H 'content-type: application/json' \
  http://localhost:8888/druid/indexer/v1/task -d '{
  "type": "index_parallel",
  "spec": {
    "dataSchema": {
      "dataSource": "libredb_demo",
      "timestampSpec": { "column": "ts", "format": "iso" },
      "dimensionsSpec": {
        "dimensions": [
          { "type": "long",   "name": "snowflake_id" },
          { "type": "long",   "name": "id" },
          { "type": "string", "name": "name" },
          { "type": "string", "name": "region" },
          { "type": "long",   "name": "qty" },
          { "type": "double", "name": "amount" }
        ]
      },
      "granularitySpec": { "type": "uniform", "segmentGranularity": "DAY", "rollup": false }
    },
    "ioConfig": {
      "type": "index_parallel",
      "inputSource": {
        "type": "inline",
        "data": "{\"ts\":\"2026-08-01T00:15:00Z\",\"snowflake_id\":9007199254740993,\"id\":1000,\"name\":\"alpha\",\"region\":\"emea\",\"qty\":0,\"amount\":10.5}\n{\"ts\":\"2026-08-02T01:15:00Z\",\"snowflake_id\":9007199254740994,\"id\":1001,\"name\":\"beta\",\"region\":\"apac\",\"qty\":3,\"amount\":11.75}"
      },
      "inputFormat": { "type": "json" }
    },
    "tuningConfig": { "type": "index_parallel" }
  }
}'
```

That payload was run against the live cluster while writing this document — byte-identical except for
the `dataSource` name, which was `libredb_docprobe` so the two fixtures stayed untouched, and which was
then removed again with the two steps in
[§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly). It answers
`{"task":"index_parallel_libredb_demo_<suffix>"}`; follow it with
`GET /druid/indexer/v1/task/{id}/status` until `statusCode` is `SUCCESS` — a two-row inline task takes
a few seconds — and the datasource then appears in `INFORMATION_SCHEMA.TABLES` and is queryable. Two
details in that payload are load-bearing for reproducing this document's findings:

- **`snowflake_id` holds 9007199254740993** (2<sup>53</sup> + 1), which is the value that reproduces
  the `JSON.parse` rounding in
  [§3.6](#36-64-bit-integers-arrive-unquoted-and-druid-offers-no-server-side-fix). Any smaller id
  makes that bug invisible.
- **`rollup: false`** keeps the datasource a plain row store. The companion fixture,
  `libredb_rollup`, uses `"rollup": true` with a `metricsSpec` of `count` and `doubleSum`, which is
  what a Druid user's aggregating datasource looks like and what the join plan in
  [§3.12](#312-explain-the-native-plan-is-genuinely-a-tree) was captured against.

`docker compose -f database-compose.yml --profile druid down -v` resets the cluster to empty — the
named volumes hold deep storage and task history, so without `-v` a restart keeps both.

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'druid1', name: 'Druid', type: 'druid',
  host: '127.0.0.1', port: 8888,
  createdAt: new Date(),
});

await provider.connect();

const rows = await provider.query('SELECT * FROM "libredb_demo" LIMIT 50');
const one = await provider.query(
  'SELECT COUNT(*) AS "c" FROM "libredb_demo" WHERE region = ?', ['emea'],
);
const schema = await provider.getSchema();      // datasources + columns, indexes always []
const tasks  = await provider.getActiveSessions(); // RUNNING/PENDING ingestion tasks

await provider.disconnect();
```

Note the double quotes on the alias in the parameterized statement: `AS c` happens to be safe, but
`AS one` would be a syntax error ([§5.4](#54-dialect-traps-a-user-will-hit)), so quoting every
generated alias is the habit worth keeping.

### 12.2 Over the API

`POST /api/db/query` with the SQL statement in the `sql` field — the same contract every SQL provider
uses. `POST /api/db/maintenance` has nothing to accept for Druid and any call throws with the reason
([§8](#8-maintenance)). The transaction and cancel routes do not apply: `/api/db/cancel` reports
cancellation as unsupported because the provider exposes no `cancelQuery`
([§13](#13-known-limitations--future-work)).

---

## 13. Known limitations & future work

- **A partially-unavailable result is flagged as a warning** (issue #273 — this was a known gap until
  then). Every successful response carries `X-Druid-Response-Context: {"missingSegments":[]}`, and a
  non-empty array there means the row set is **incomplete** while the status is still 200. The
  transport counts that list into `unavailableSegments` and the provider turns a positive count into
  one `QueryResult` warning; a whole answer, and an answer that reported nothing about availability,
  carry none ([§5.2](#52-result-shaping)). Only the list's *length* is read — the descriptors name
  intervals, versions and partition numbers a client has no other business knowing, so respelling one
  cannot change what a partial answer reports. Note that the fixture cluster cannot reproduce a
  non-empty array: with a single Historical, losing it removes the datasource from the catalog instead
  ([§6](#the-catalog-is-a-view-of-what-is-servable-not-of-what-exists)), so the partial case needs a
  multi-server cluster where only *some* segments are unavailable — which is why the behaviour is
  pinned by feeding the declaring response
  ([tests/unit/db/druid/http-transport.test.ts](../../tests/unit/db/druid/http-transport.test.ts))
  rather than by a live probe.
- **No writes at all through this endpoint.** No `UPDATE`, no `DELETE`, no `CREATE TABLE`; `INSERT`
  and `REPLACE` need the MSQ task engine. This is Druid, not the provider — see
  [§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly), which also documents how data is
  actually removed (mark segments unused, then a kill task, both through the Coordinator).
- **MSQ ingestion is out of scope.** `POST /druid/v2/sql/task` would make `INSERT`/`REPLACE` work, but
  it returns a task id rather than rows and needs a submit/poll/status surface the `query()` contract
  does not model. A follow-up, not a small one: it implies task management in the UI.
- **The async statements endpoint is out of scope, and the answer to #265's question about it is no.**
  `POST /druid/v2/sql/statements` requires `executionMode: ASYNC` in the query context — verified, a
  plain POST answers `400` *"Execution mode is not provided to the sql statement api. Please set
  [executionMode] to [ASYNC] in the query context"* — it runs on the MSQ task engine rather than the
  native one, and it replaces one-shot execution with a submit/poll/paginate protocol. It is the right
  answer for a long analytical query and the wrong shape for the current provider interface.
- **No `cancelQuery`.** A client-side abort does **not** stop the query on the cluster; the server-side
  statement deadline is what does ([§3.8](#38-both-halves-of-the-timeout)). The follow-up is concrete
  rather than speculative: Druid echoes a caller-supplied `sqlQueryId` back in the
  `X-Druid-SQL-Query-Id` response header (verified), and `DELETE /druid/v2/sql/{sqlQueryId}` cancels
  by it — so setting our own id in the query context would give a real `cancelQuery`.
- **No supervisor or task management.** `sys.supervisors` is empty on a batch-only cluster (verified)
  and is not read; streaming ingestion supervisors and task submission/suspension/termination have no
  surface here. `sys.tasks` is read for the sessions panel only ([§7](#7-monitoring--health)).
- **Lookups are not listed in the sidebar.** The `lookup` schema is real — it is one of the five
  `INFORMATION_SCHEMA.SCHEMATA` rows on every cluster (verified) — and a lookup is addressable as
  `lookup.<name>` in typed SQL, but only the `druid` schema is listed, so a cluster using
  `druid-lookups-cached-global` shows no lookup entries in the tree. The same applies to the `view`
  schema. Listing either would need a second schema section in the explorer, which is a UI change
  rather than a provider one. (The fixture cluster defines no lookups and no views, so nothing here
  demonstrates a query against one.)
- **No compaction, retention or segment management.** All Coordinator and task concerns; see
  [§8](#8-maintenance).
- **Performance metrics and slow queries are structurally unavailable**, not merely unimplemented:
  Druid's metrics reach an emitter and it keeps no query log ([§7](#7-monitoring--health)).
- **`ORDER BY` on a non-`__time` column of a table scan fails**, and the provider does not work around
  it — no rewrite could preserve the user's intent ([§5.4](#54-dialect-traps-a-user-will-hit)).
- **`ARRAY` cells are JSON strings**, by Druid's default and on purpose
  ([§5.3](#53-array-cells-arrive-as-json-strings)).
- **`ssl.caCert` / `ssl.clientCert` / `ssl.rejectUnauthorized` are not honoured**, so a self-signed
  certificate fails verification ([§4.3](#43-tls)).
- **No connection string**, deliberately ([§4.2](#42-there-is-no-connection-string-and-that-is-deliberate)).
- **The whole result body is buffered** before it is parsed, so a deliberately huge result set is
  expensive in a way a streaming client would not be ([§3.1](#31-http-only--no-driver-and-what-that-costs)).
- **Two shared SQL-generating features were not dialect-aware**, both pre-existing and both tracked in
  [#269](https://github.com/libredb/libredb-studio/issues/269): the results grid's **inline row
  editing** emitted `UPDATE ... SET`, which Druid rejects as `Unsupported SQL statement [UPDATE]` —
  there is no Druid equivalent to substitute, so editing a Druid row is not possible at all, and since
  #269 this provider declares `supportsInlineRowEdit: false` so the control is not offered here (no
  EDIT toggle, no editable cell) — and the **schema-diff migration generator** used to hand a modified
  column PostgreSQL's `ALTER TABLE ... ALTER COLUMN`, which Druid has no statement for at all; since
  #269 it emits `-- Apache Druid: Cannot alter column "<name>". Druid SQL has no ALTER TABLE; rewrite
  the datasource with REPLACE INTO through an MSQ task.` in that statement's place. That advice names
  the MSQ task endpoint on purpose: `REPLACE INTO` through the interactive endpoint this provider uses
  is rejected ([§5.5](#55-druid-sql-cannot-write-and-the-server-says-so-clearly)), so a
  generated migration is run through Druid's own task API rather than pasted into the editor.

---

## 14. References

- Source: [`src/lib/db/providers/sql/druid/`](../../src/lib/db/providers/sql/druid/)
- Explain strategy: [`src/lib/explain/druid-native.ts`](../../src/lib/explain/druid-native.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Connection form config: [`src/lib/db-ui-config.ts`](../../src/lib/db-ui-config.ts)
- Local cluster: [`database-compose.yml`](../../database-compose.yml) (`--profile druid`)
- Tests: [`tests/integration/db/druid-provider.test.ts`](../../tests/integration/db/druid-provider.test.ts) · [`tests/unit/db/druid/`](../../tests/unit/db/druid/) · [`tests/unit/lib/explain/druid-native.test.ts`](../../tests/unit/lib/explain/druid-native.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Tracking issue: [#265 — Add Apache Druid provider](https://github.com/libredb/libredb-studio/issues/265)
- Druid SQL: <https://druid.apache.org/docs/latest/querying/sql>
- SQL HTTP endpoint and result formats: <https://druid.apache.org/docs/latest/api-reference/sql-api>
- Metadata tables (`INFORMATION_SCHEMA`, `sys`): <https://druid.apache.org/docs/latest/querying/sql-metadata-tables>
- `EXPLAIN PLAN FOR`: <https://druid.apache.org/docs/latest/querying/sql-translation>
- Native batch ingestion: <https://druid.apache.org/docs/latest/ingestion/native-batch>
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [MongoDB](./mongodb.md) · [Couchbase](./couchbase.md) · [ClickHouse](./clickhouse.md) · [Redis](./redis.md) · [LibreDB](./libredb.md)
