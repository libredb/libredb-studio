# ClickHouse Provider

> ClickHouse support for LibreDB Studio, built on the documented HTTP interface (port `8123`) with
> **no driver dependency of any kind**: every statement is the body of a `POST /` and the answer
> comes back through the runtime's own `fetch`. This document is the single reference point for the
> ClickHouse provider: design, architecture, usage, and tests. If you are reading the code, extending
> ClickHouse support, or authoring a new provider, start here.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `clickhouse` |
| **Family** | SQL (`src/lib/db/providers/sql/clickhouse/`) |
| **Driver** | None — HTTP only (`fetch`, a runtime built-in) |
| **Query language** | `sql` |
| **Default port** | `8123` (HTTP). `8443` when TLS is on. The native protocol port `9000` is never used — this provider does not speak it |
| **Connection pooling** | None — each statement is one stateless HTTP request |
| **Connection string** | Supported (`clickhouse://`, plain `http://` / `https://`) |
| **EXPLAIN** | `clickhouse-json` — estimate only; ClickHouse's `EXPLAIN` never executes the statement, so there is no separate analyze mode |
| **Transactions** | Not exposed (ClickHouse has no multi-statement transactions to expose) |
| **Query cancellation** | No `cancelQuery`; a running statement is killed via maintenance `kill` |
| **Source** | [`src/lib/db/providers/sql/clickhouse/`](../../src/lib/db/providers/sql/clickhouse/) |
| **Tests** | [`tests/integration/db/clickhouse-provider.test.ts`](../../tests/integration/db/clickhouse-provider.test.ts) + [`tests/unit/db/clickhouse/`](../../tests/unit/db/clickhouse/) + [`tests/unit/lib/explain/clickhouse-json.test.ts`](../../tests/unit/lib/explain/clickhouse-json.test.ts) |
| **Tracking issue** | [#264 — Add ClickHouse provider](https://github.com/libredb/libredb-studio/issues/264) |

---

## 1. Overview

ClickHouse is a column-oriented analytical database with a **first-class HTTP interface** — a
documented, fully-featured peer of the native protocol rather than a bolt-on, and the surface the
Play UI and most third-party integrations speak. (Its own `clickhouse-client` uses the *native*
protocol on `9000`, which this provider deliberately does not implement — see
[§3.1](#31-http-transport-only--no-native-dependency).) That makes it an
easier fit for this codebase than Couchbase was: the SQL dialect is close enough to standard that
the provider extends `SQLBaseProvider` directly and inherits identifier quoting and `LIMIT`
injection for free, tables have a real declared schema (no sampling or inference step), and the
query-response envelope already carries column types.

The two things that *are* ClickHouse-shaped, and which nearly every design decision below flows
from:

1. **The HTTP interface is honest about failure, except once.** A syntax error, an unknown table, or
   bad credentials all come back as real HTTP status codes with a numeric exception code in a
   header — until the first block of a streaming response has already gone out, at which point a
   failure arrives as a `200` with a truncated body and the real error fenced in a trailer
   ([§3.7](#37-a-mid-stream-failure-still-arrives-as-200)).
2. **A permission denial looks exactly like a server crash by status code alone.** `ACCESS_DENIED`
   answers HTTP `500`, not `403` or `401`. Every error path in this provider is classified by the
   numeric exception code, never by status or by sniffing the message text
   ([§3.3](#33-a-permission-denial-arrives-as-http-500-not-403)).

### Concept mapping

| `DatabaseProvider` slot | ClickHouse realisation | Mechanism |
|-------------------------|-------------------------|-----------|
| "Table" (`TableSchema`) | A table, displayed as `name` or `database.name` | `system.tables`, filtered to non-system databases |
| "Row" | One result row | JSON `data` array element |
| Columns | The declared column list, types verbatim | `system.columns` / the query response `meta` |
| Primary key | The MergeTree sparse primary index | `system.tables.primary_key`, `is_in_primary_key` |
| `query(sql)` | One SQL statement | `POST /?default_format=JSON` |
| Indexes | The primary key, the sorting key (when it differs), and data-skipping indexes | `system.tables` + `system.data_skipping_indices` |
| Foreign keys | none (ClickHouse has none) | always `[]` |
| `getOverview()` / storage | Server identity, connection counts, part sizes | `version()`, `uptime()`, `system.metrics`, `system.parts`, `system.disks` |
| `getSlowQueries()` / `getActiveSessions()` | Finished and in-flight statements | `system.query_log`, `system.processes` |
| Maintenance | `optimize` / `analyze` / `kill` | `OPTIMIZE TABLE ... FINAL`, a `system.parts` summary, `KILL QUERY ... SYNC` |

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. SQL providers add an intermediate abstract layer,
`SQLBaseProvider`, between the generic base and each concrete provider — the same layer PostgreSQL
and MySQL extend. ClickHouse is a *directory* rather than a single file, because the HTTP transport
is a seam ([§3.2](#32-the-transport-seam-one-interface-one-implementation)):

```
src/lib/db/providers/sql/
├── postgres.ts
├── sql-base.ts
└── clickhouse/
    ├── index.ts             # ClickHouseProvider - the SQLBaseProvider subclass
    ├── transport.ts         # ClickHouseTransport interface + neutral result types (no I/O)
    ├── http-transport.ts    # the one implementation: the HTTP interface on port 8123
    └── introspect.ts        # system.* catalog reads
```

The explain strategy lives with the other strategies, not with the provider:
[`src/lib/explain/clickhouse-json.ts`](../../src/lib/explain/clickhouse-json.ts).

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
ClickHouseProvider (clickhouse/index.ts)
```

`ClickHouseProvider` extends `SQLBaseProvider` — not `BaseDatabaseProvider` directly, the way
Couchbase does — because the dialect really is standard on the points the shared helpers care
about: double-quoted identifiers and `LIMIT n OFFSET m` are both correct here, live-verified
(`SELECT "id" FROM "probe"` and the bare unquoted form both parse). This is exactly the case
[`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) names ClickHouse for. Only `prepareQuery()`
is overridden, for the trailing-clause trap in [§3.8](#38-the-preparequery-override).

### 2.3 What `SQLBaseProvider` gives for free

`ClickHouseProvider` reuses these inherited members rather than reimplementing them:

| Member | Purpose |
|--------|---------|
| `escapeIdentifier()` | Double-quoted, since `this.type` (`clickhouse`) falls through to the default branch — the same quoting PostgreSQL uses. Both quoted and unquoted forms parse (live-verified) |
| `buildLimitClause()` | `LIMIT n` / `LIMIT n OFFSET m` |
| `getPlaceholder()` | Falls through to `?`, but is moot here: ClickHouse binds only named `{name:Type}` parameters over HTTP, and `query()` throws rather than send an unbound `?` ([§5.1](#51-execution)) |
| `shouldEnableSSL()` | Inherited but **never called**, and deliberately so. It infers TLS from substrings in the host (`cloud`, `aws`, …), which would silently switch a self-hosted node whose hostname merely contains one of them. TLS here comes from the connection's own `ssl` config or from an `https://` scheme, never from a guess ([§4.3](#43-tls)) |
| `prepareQuery()` (base) | The shared query limiter; `ClickHouseProvider` calls it first and only overrides the trailing-clause case |

### 2.4 Registration & lifecycle

The factory wires ClickHouse in via a dynamic import
([`factory.ts:87`](../../src/lib/db/factory.ts)):

```ts
case 'clickhouse': {
  // The explicit /index specifier keeps this dynamic import statically analysable:
  // a bare directory resolves only at runtime, which the bundler cannot trace into a chunk.
  const { ClickHouseProvider } = await import('./providers/sql/clickhouse/index');
  return new ClickHouseProvider(connection, options);
}
```

`connect()` proves the server, the credentials, and the database together with one `SELECT 1` —
the cheapest statement that exercises all three at once. This matters here specifically because a
non-existent `database` URL parameter is **not** checked when the connection is made; it fails
`404` / code `81` on the first statement that uses it (live-verified), so without the probe a bad
database would surface much later and somewhere else in the UI. `disconnect()` has nothing to
release — there is no pool and no session — so it only clears the cached transport reference. API
routes use `getOrCreateProvider()`, which caches the connected provider per `connection.id` and
evicts it after 30 minutes idle.

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 HTTP transport only — no native dependency

ClickHouse's own native protocol runs on port `9000` and needs a binary client; this provider never
speaks it. Every capability the provider needs — querying, catalog introspection, monitoring, and
maintenance — is reachable over the documented HTTP interface on `8123`, the same interface
`clickhouse-client --host ... --send_logs_level` and every third-party BI tool that supports
ClickHouse use. There is no install step to fail, no native module in the Docker image or any
distribution channel, and no N-API compatibility question for the Bun runtime — the same case
Couchbase makes in [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md).

### 3.2 The transport seam: one interface, one implementation

Provider logic never calls `fetch`. It goes through `ClickHouseTransport`
([transport.ts:114](../../src/lib/db/providers/sql/clickhouse/transport.ts)), so adopting the
native protocol later would be one new file implementing the same contract rather than a rewrite:

```ts
interface ClickHouseTransport {
  readonly kind: "http";
  query(sql: string, opts?: ClickHouseQueryOptions): Promise<ClickHouseQueryResult>;
  close(): Promise<void>;
}
```

There is no second entry point next to `query()`, unlike Couchbase's `manage()`: every ClickHouse
metric, session and storage statistic the provider needs is a `system.*` table reachable by SQL, so
a permanent second HTTP surface would buy nothing.

The result type is deliberately **neutral** rather than the HTTP response envelope
([transport.ts:37](../../src/lib/db/providers/sql/clickhouse/transport.ts)):

```ts
interface ClickHouseQueryResult {
  rows: Record<string, unknown>[];
  fieldNames: string[] | null;                 // null when the source cannot describe the rows
  columnTypes: Record<string, string> | null;  // declared type per column, verbatim
  executionTimeMs: number;
  mutationCount: number;                       // what the server says it wrote/changed
  rawText: string | null;                      // set only when the format was not JSON
}
```

`columnTypes` sits in the neutral type rather than behind the HTTP implementation because *any*
ClickHouse client — HTTP or native — knows the type of the columns it received; it is not a REST
artefact. `rawText` is neutral for the same reason: output formats are a server feature, not a REST
feature. Errors follow the same rule: the transport throws one normalized
`ClickHouseTransportError { code, name, message }`
([transport.ts:178](../../src/lib/db/providers/sql/clickhouse/transport.ts)), where `code` is
ClickHouse's own numeric exception code, so the provider switches on a number instead of sniffing
message strings.

> **Seam rule.** The HTTP envelope identifiers (`X-ClickHouse-Summary`,
> `X-ClickHouse-Exception-Code`, `X-ClickHouse-Exception-Tag`, `X-ClickHouse-Format`,
> `default_format`, `output_format_json_quote_64bit_integers`, `elapsed_ns`,
> `rows_before_limit_at_least`) must appear **only** in `http-transport.ts`.
> [`seam-guard.test.ts`](../../tests/unit/db/clickhouse/seam-guard.test.ts) parses every source file
> in the directory with the TypeScript compiler API — not a grep — and fails the build the moment
> any of that vocabulary is *read* anywhere else, whether as a string, a header lookup, or a
> destructured field. Two identifiers (`written_rows`, `statistics`) are also real column names on
> `system.processes` / `system.query_log` / `system.columns`, so the guard only flags them as a
> *payload read* (`summary.written_rows`), never as SQL text (`SELECT written_rows FROM
> system.query_log`) — both are legitimate and both are exercised by the introspection and
> monitoring code.

### 3.3 A permission denial arrives as HTTP 500, not 403

Verified with a purpose-made restricted user granted `SELECT` on one table only:

| Surface as a restricted user | Status | Code |
|---|---|---|
| `system.query_log`, `system.processes`, `system.metrics`, `system.data_skipping_indices` | **`500`** | `497` `ACCESS_DENIED` |
| `OPTIMIZE TABLE`, `KILL QUERY` | **`500`** | `497` |
| `system.tables`, `system.columns` | `200` | — implicitly filtered to what the user may see |
| `uptime()`, `version()` | `200` | — needs no grant |

The `497` message reads *"Not enough privileges. To execute this query, it's necessary to have
grant SELECT"* — it contains neither "access denied" nor "permission denied", so message sniffing
would miss it entirely. **Detecting** a failure is status-based (`!response.ok`, inside the
transport); **classifying** it is code-based, from `X-ClickHouse-Exception-Code`
([index.ts:637](../../src/lib/db/providers/sql/clickhouse/index.ts)). A permission problem looks
like a server fault by status alone, so any logic keyed on `403` would miss every real denial.

The upside is real: **the schema tree and the overview panel survive a restricted user** — only the
monitoring panels and maintenance operations that need their own grant degrade
([§7](#7-monitoring--health)).

### 3.4 `default_format=JSON` as a URL parameter, never appended to the SQL

`POST /?default_format=JSON` with the raw statement as the body returns the JSON envelope. User SQL
is never rewritten to add a format — the editor sends exactly what the user typed.

**An explicit `FORMAT` in the user's own SQL wins over `default_format`, live-verified.**
`SELECT 1 FORMAT TSV` genuinely comes back as TSV even with `default_format=JSON` on the URL. The
response header `X-ClickHouse-Format` reports the format the server actually used, and the transport
branches on it before parsing the body
([`toQueryResult`](../../src/lib/db/providers/sql/clickhouse/http-transport.ts)): when it is not
`JSON`, the raw text comes back as `rawText` rather than being parsed or thrown away — the user asked
for that format deliberately. The provider then surfaces it as one synthetic column,
`__text` ([`RAW_TEXT_COLUMN`, index.ts:102](../../src/lib/db/providers/sql/clickhouse/index.ts)),
the same convention Couchbase uses for a scalar projection.

### 3.5 64-bit integers are quoted on purpose, to stop `JSON.parse` from rounding them

By default `SELECT toUInt64(18446744073709551615)` returns the **unquoted** JSON number
`18446744073709551615`, which `JSON.parse` silently rounds to `18446744073709552000` — a real,
reproducible precision loss, not a theoretical one.

**Decision: the transport always sends `output_format_json_quote_64bit_integers=1`**
([`buildUrl`](../../src/lib/db/providers/sql/clickhouse/http-transport.ts)). Verified: a
`UInt64` then arrives as the string `"18446744073709551615"`, while an `Int32` or a `Float64` stays
an unquoted number. This matches the `pg` driver's existing `int8`-as-string behaviour, so the grid
already renders it correctly with no further change. Every reader in the provider and the
introspection module accepts both encodings, because `system.asynchronous_metrics` is `Float64` and
genuinely arrives unquoted in the same response cycle as a quoted `UInt64` counter elsewhere.

### 3.6 Writes return an empty 200 body; the row count lives in a header

A successful `INSERT`, `ALTER TABLE ... UPDATE`, or lightweight `DELETE FROM` answers `200` with
**no body at all**. Row counts appear only in `X-ClickHouse-Summary`, whose values are all
**strings**:

```
X-ClickHouse-Summary: {"read_rows":"2","written_rows":"2","result_rows":"2","elapsed_ns":"56463623", ...}
```

`written_rows` becomes `mutationCount` on the neutral result. The transport recognises the empty
body as success *before* it asks what format the response used
([`toQueryResult`](../../src/lib/db/providers/sql/clickhouse/http-transport.ts)) — a DDL
response carries no `X-ClickHouse-Format` header at all, so checking format first would
misclassify it.

**Honesty caveat, live-verified:** for `ALTER TABLE ... UPDATE` and a lightweight `DELETE FROM`,
`written_rows` is `0` even though the mutation genuinely applied — the row really did change,
verified independently. Both statement types are queued as background mutations rather than applied
synchronously, and ClickHouse counts no rows written for either. The provider reports this number
verbatim and never derives or fabricates a plausible-looking count in its place
([transport.ts:69](../../src/lib/db/providers/sql/clickhouse/transport.ts)).

### 3.7 A mid-stream failure still arrives as 200

Found during implementation and independently reproduced: once the first block of a streaming
response has been written, the status line is already committed as `200`, so a statement that fails
part-way through does not get to report a real status or exception-code header. What arrives
instead is:

- status **`200`**, with **no** `X-ClickHouse-Exception-Code` header
- a body **truncated mid-array** (not valid JSON on its own)
- the real exception fenced in a trailer at the end of the body:

```
        { "number": 180999 }
__exception__
rdlnavwamgbwoyjw
Code: 395. DB::Exception: boom: ... (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 26.7.1.1315 (official build))
286 rdlnavwamgbwoyjw
__exception__
```

Reproduced with `POST /?default_format=JSON&max_block_size=1000` and
`SELECT number, throwIf(number = 200000, 'boom') FROM numbers(1000000)`. Without special handling
the only symptom is a JSON parse complaint, which tells the person who wrote the statement nothing
about what actually happened.

**The transport checks for this trailer before it looks at the format and before it parses the body,
and treats it as authoritative on its own**
([`midstreamError`](../../src/lib/db/providers/sql/clickhouse/http-transport.ts)) — a statement can
fail after emitting a body that still happens to parse, and reporting that as a short successful
result would silently lose rows.

**The check has to precede the format branch, not just the parse.** The fence and its tag are
format-independent, so a statement carrying its own `FORMAT` that dies part-way through would
otherwise be handed back through the `rawText` path as a success, with the trailer buried in the
text: live-reproduced as 805000 lost rows reported as `rowCount 1`.

**There is a second variant, and it needs different handling.** Whether the failure streams or not
depends on how much output had been flushed, and JSON output is *buffered* so the server can count
`rows`. When the exception wins that race the response is instead:

- status **`500`**, **with** `X-ClickHouse-Exception-Code: 395`
- the half-built `meta`/`data` JSON, and the exception appended to it
- **no `__exception__` fence at all** — there is nothing to cut on

So the ordinary error path handles this one, and it trims the partial result off the front of the
message: without that, the failure is reported with several hundred characters of JSON in front of
the only line that says what went wrong. The trim deliberately does **not** anchor to a line start,
because whether a newline precedes the exception depends on how much of a row had been written —
anchoring silently failed for exactly the longest bodies.

**The fence is keyed on the per-request `X-ClickHouse-Exception-Tag` header**, sent on every
response including successful ones, rather than on the literal string `__exception__` alone:
`SELECT '__exception__'` is a legal statement whose result would otherwise be misread as a failure.
The tag is server-generated per request, so result data can never forge it, which is exactly why the
header exists and why the transport trusts it.

### 3.8 The `prepareQuery()` override

`SQLBaseProvider.prepareQuery()` appends `LIMIT n` at the very end of a statement. ClickHouse allows
`FORMAT x` and `SETTINGS ...` as **trailing** clauses, and `LIMIT` after either is a hard syntax
error, live-verified:

- `SELECT * FROM probe FORMAT TSV LIMIT 1` → `400` / code `62`, *"Expected one of: SETTINGS, ... end
  of query"*
- `SELECT * FROM probe SETTINGS max_threads=1 LIMIT 1` → `400` / code `62`

`SELECT * FROM probe LIMIT 1 FORMAT TSV` — limit before either clause — is the order that actually
works.

`ClickHouseProvider.prepareQuery()`
([index.ts:562](../../src/lib/db/providers/sql/clickhouse/index.ts)) detects a trailing `FORMAT` or
`SETTINGS` clause with two patterns anchored at the **end** of the statement — as
`src/lib/sql/statement-end.ts` delimits it, so the terminating semicolon and any trailing comment are
outside what the patterns read — and, when either matches, returns the query
**unchanged** with `wasLimited: false` rather than delegating to the inherited limiter. Anchoring at
the end is what keeps the check off a statement that merely mentions the word: `SELECT * FROM t
WHERE note = 'format'` and `SELECT name FROM system.settings` are ordinary statements that still get
limited normally, because neither ends in the clause pattern. A user who wrote a trailing `FORMAT`
or `SETTINGS` clause is expressing intent the editor must not silently rewrite, and the bias has to
favour not rewriting: rewriting wrongly turns a working statement into a syntax error, while leaving
it alone at worst returns more rows than the page size.

Both the detection and the inherited limiter read the statement under **ClickHouse's** grammar, which
this provider passes down from its own `type` ([`grammar.ts`](../../src/lib/sql/grammar.ts)).
ClickHouse's syntax reference lists `#` and `#!` beside `--` as single-line comment forms, and the
shared reader used to guess PostgreSQL's rule instead — a hash followed by `>`, `-` or `#` is an
operator — so a comment written that way was read as SQL, and an ordinary one at the end of a
statement made the bound unplaceable. `SELECT * FROM users # daily check` is now bounded before the
comment, exactly as the `--` form is, and `SELECT * FROM users # FORMAT TSV` is read as what it is: a
commented-out clause, not a trailing one (#292). See
[Which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading).

The same channel carries the second reading this dialect needs: **`[…]` is an array literal or a
subscript here, not a quoted name.** Arrays nest (`Array(Array(T))`) and nothing inside them is
escaped, while SQL Server's `[name]` ends at the first unpaired `]` and writes a bracket inside a name
by doubling it — two rules that cannot both hold, so the reading comes from the dialect (#295). Under
the name reading ClickHouse lost bounds in two everyday shapes: a subscript whose key text contains a
close bracket (`WITH m['a]b'] AS v SELECT v`) ended the run at that bracket, so the CTE element could
not be crossed and the statement typed as unknown; and a nested array (`SELECT [[1,2],[3,4]] AS a`)
ended with a doubled bracket read as an escape, so the run never closed and the statement's end was
not cuttable. Both are now bounded, emitted byte-intact. A run that genuinely never closes
(`SELECT [[1,2] AS a`) is still reported as undeterminable and the statement is passed through
untouched — the same fail-safe direction as an unterminated literal.

A third fact of the same record: **block comments nest here.** ClickHouse's syntax reference states
that C-style comments can be nested and gives a nested example, while the shared reader used to end
every comment at its first `*/` — handing everything between that marker and the comment's real end to
the readers as code, which cost the statement its bound. On this engine, whose whole point is scanning
more rows than a browser can hold, a missing bound is the entire cost: there is no data-modifying CTE
here, so no bound can land on a write. `/* a /* b */ x */ SELECT arrayJoin([1, 2]) AS n` and
`WITH /* a /* b */ x */ 1 AS one SELECT one FROM events` are now bounded, and a trailing nested comment
takes the bound before it rather than inside it. A comment carrying one opener too many
(`/* a /* b */ SELECT n FROM events`) never closes here, so it is undeterminable and the statement is
passed through untouched — the same fail-safe direction as an unclosed array, and it costs that
statement a confirmation prompt as well (#300).

A fourth fact of the same record, and the only one this dialect shares with another engine here:
**`//` is a single-line comment.** ClickHouse's syntax reference lists it beside `--` and `#`, and the
shared reader used to read the two slashes as code, so a comment written that way took the row bound
with it: `SELECT number FROM numbers(1000) // note` emitted `... // note LIMIT 5`, which the server
reads as an unbounded query inside a comment — measured on 26.7.1, that returned **1000 rows while the
result claimed it was limited to 5**. It now emits `... LIMIT 5 // note` and returns 5. Apache
Cassandra is the other engine with this form ([`cassandra.md`](cassandra.md)); every other dialect this
product reads treats the characters where they stand, PostgreSQL as an operator that does not exist
(#S1). A `;` behind the comment is not a separator either, which is what stops the multi-statement
route inventing a fragment out of commented-out text.

The same reading reaches the **destructive-statement confirmation**, because that predicate reads the
statement under the connection's dialect too. It gains prompts here: a nested array before a
destructive keyword (`WITH [[1,2],[3,4]] AS x DELETE FROM t`) used to leave the run unterminated and
everything after it invisible, so nothing asked. Nothing is lost either, since #297 closed the
narrowing this paragraph used to record: bracket text that does not *balance*
(`WITH [[1,2] AS x DELETE FROM t`) is undeterminable under the array reading, and unresolvable text
now asks — the confirmation dialog says the statement could not be fully read instead of staying
silent. The statement is a syntax error in ClickHouse either way. Both directions are pinned by tests.

A hand-rolled semicolon strip used to stand in for that reading, so `... FORMAT TSV -- note` read as
carrying no trailing clause at all. That was harmless only while the inherited limiter appended its
bound after the comment, where the server never saw it; now that the bound is placed **before** the
comment, the same miss would emit `... FORMAT TSV LIMIT n -- note` — the very `400` / code `62` above.
Detection and placement therefore read one shared definition of where a statement ends. Where that
reader refuses to let the statement be cut at all — an unterminated literal, or a trailing `#` run —
the inherited limiter declines on its own, so such a statement is passed through untouched whatever
this override answers.

One false positive is accepted on purpose rather than fixed: a statement ending in a string literal
that itself contains an assignment (`... WHERE note = 'SETTINGS foo = 1'`) is read as carrying a
trailing clause, because ruling it out needs a string-literal-aware tokenizer. The cost of that false
positive is only a missing row limit — the statement still runs and still returns correct rows —
whereas the other direction would produce a hard syntax error, which is why the bias sits where it
does.

**Expression-form CTEs are limited too.** A CTE is ordinarily written `WITH <expr> AS <alias>` here —
`WITH 1 AS one SELECT one, count(*) FROM events GROUP BY one`, `WITH now() AS t SELECT * FROM events
WHERE ts < t` — which is not the `name AS (body)` shape the other dialects use. The shared statement
typer (`src/lib/sql/operative-keyword.ts`) walks a CTE-list element in both shapes, so these type
`SELECT` and receive the inherited bound. While it walked only the standard shape they typed `OTHER`
and reached the server unbounded ([#291](https://github.com/libredb/libredb-studio/issues/291)) — on
the one engine here whose ordinary result set is larger than a browser can hold. Nothing is made
unsafe by reading the form: ClickHouse has no data-modifying CTE, so a missing bound was the whole
cost. Detection and typing still agree on the same statement — `WITH 1 AS one SELECT one FORMAT TSV`
comes back untouched, because the trailing-clause refusal above reads it as well.

### 3.9 Column types are the declared strings, verbatim

Types come back exactly as declared, with no normalization attempted:

`Int32` · `Nullable(String)` · `Array(UInt8)` · `Map(String,String)` · `Enum8('x'=1,'y'=2)` ·
`LowCardinality(String)` · `Decimal(10,3)` · `DateTime64(3)` · `UUID`

**Decision: `ColumnSchema.type` carries the declared type string unchanged**
([introspect.ts:290](../../src/lib/db/providers/sql/clickhouse/introspect.ts)). It is precise, it
is what a ClickHouse user already reads in `SHOW CREATE TABLE`, and collapsing it onto a generic
family would throw away the wrapper — which is exactly the part that says nullable, low-cardinality,
parameterised, or enumerated.

**Nullability is derived by testing for the `Nullable(...)` wrapper, not by a bare substring
search**, because the wrapper is not always outermost and not always the column's own:
`LowCardinality(Nullable(String))` is nullable (the wrapper comes *after* `LowCardinality`), while
`Array(Nullable(String))`, `Map(String, Nullable(String))`, and
`SimpleAggregateFunction(any, Nullable(UInt64))` all qualify an *inner* type and are not nullable
columns themselves
([introspect.ts:186](../../src/lib/db/providers/sql/clickhouse/introspect.ts)).

**There is a spacing inconsistency between the two surfaces that carry types**, and it matters
because they must never be compared as strings: the query-response `meta` array renders
`Map(String, UInt8)` with a space after the comma, while `system.columns.type` renders the same
type as `Map(String,String)` with no space.

### 3.10 `supportsCreateTable` is false — live-disproved the issue's own guess

The tracking issue expected `ENGINE` / `ORDER BY` to be the blocker for `CREATE TABLE`. They are
not: `CREATE TABLE t (id Int32, name String)` succeeds outright on ClickHouse 26.x, because it
defaults `default_table_engine = MergeTree` with an implied `ORDER BY tuple()`.

The real blocker is what `CreateTableModal` actually emits:

| Modal output | ClickHouse result (live-verified) |
|---|---|
| `id SERIAL PRIMARY KEY` (the modal's **default** column) | `Code: 50 ... Unknown data type family: SERIAL` |
| `email VARCHAR(255) UNIQUE` | `Code: 62 ... Syntax error ... (UNIQUE)` |
| `id Int32 PRIMARY KEY, name VARCHAR(255) NOT NULL` | works — `VARCHAR(255)` aliases to `String` |

The modal's *default* state produces invalid SQL before a user changes anything, and it offers no
ClickHouse type list. Per the capability-honesty rule in
[`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md#capability-honesty) — a flag that is `true`
but produces a control that can only emit invalid input is a defect, not a feature — the flag stays
`false`. DDL typed directly into the query editor works normally; that is how a ClickHouse user
creates a table today.

### 3.11 Statelessness: no `session_id` is pinned

`SET max_block_size = 4096` inside a ClickHouse `session_id` genuinely persists across requests —
verified `4096` inside the session versus the default `65409` outside it. The provider deliberately
does **not** pin one:

- One HTTP request per statement keeps the provider stateless and safely concurrent — nothing to
  coordinate, nothing to leak across users of a shared connection.
- A pinned session serializes requests server-side: ClickHouse rejects concurrent use of one
  `session_id`, which would break parallel schema introspection (`getSchema()` reads three catalogs
  at once with `Promise.all`).
- `SET` and temp tables are the only things lost to this, and neither is reachable from the editor's
  one-statement-per-execution model regardless.

Per-request settings are still sent as URL parameters (`ClickHouseQueryOptions.settings`), which is
everything the provider actually needs — a statement deadline via `max_execution_time`, for
instance.

### 3.12 EXPLAIN reuses the shared tree model

`ExplainFormat` gains `"clickhouse-json"`, with the strategy in
[`src/lib/explain/clickhouse-json.ts`](../../src/lib/explain/clickhouse-json.ts):

- `buildSql()` returns `EXPLAIN json = 1, indexes = 1 ${sql}` for `SELECT` statements, in **both**
  modes. ClickHouse's `EXPLAIN` never executes the statement — there is no `EXPLAIN ANALYZE` to ask
  for — so the estimate is the only plan available either way. Returning `null` for analyze mode
  would not narrow the feature, it would disable it: the direct Explain action always builds with
  mode `analyze` and refuses to run when the strategy declines, so the button would go dead while
  only the background pre-warm worked. This mirrors `sqlite-queryplan.ts` and `couchbase-json.ts`,
  which make the same call for the same reason.
- `actions = 1` is deliberately **not** requested: it multiplies plan size roughly tenfold (21 KB for
  a two-table join, live-measured) with expression internals the tree render model has no way to
  show.
- The result is one row, one `String` column named `explain`, whose *value* is the plan as a JSON
  **string** needing a second `JSON.parse` — `extractPlan()` does that parse so the stored value
  feeds the raw-JSON and AI tabs as a structure rather than one escaped blob. The parsed shape is an
  array of one `{ Plan: {...} }` object; `toPlanRoot()` unwraps up to five layers (cell text, the
  outer array, the `Plan` member, the node itself, plus one guard layer) so it accepts the plan at
  whichever depth the server or the storage layer hands it back.
- Children always live under **`Plans`**, always an array — there is no `~child` / `~children`
  duality to walk, unlike Couchbase.
- `indexes = 1` adds an `Indexes` array on `ReadFromMergeTree` nodes (`Type`, `Keys`, `Condition`,
  `Search Algorithm`, `Initial Parts`/`Selected Parts`, `Initial Granules`/`Selected Granules`).
  `toRenderModel()` renders each entry as its own child row rather than folding it into one detail
  string, because a MergeTree read can report up to four of them (Min-Max, Partition, PrimaryKey,
  and each data-skipping index) and each deserves its own line, with the selected-over-initial ratio
  shown when both counts are present.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Notes |
|-------|----------|-------|
| `host` | Yes (or `connectionString`) | `validate()` throws `DatabaseConfigError` when both are missing |
| `port` | No | Defaults to `8123`, or `8443` when `ssl.mode` is anything but `disable` |
| `user` / `password` | No | Sent as HTTP Basic **only when `user` is set**. Live-verified: an empty Basic username fails hard (*"Got an empty user name from Authorization HTTP header"*, code `516`), while sending no header at all resolves to the `default` user — the correct behaviour for a stock local install |
| `database` | No | Sent as the `database` URL parameter on every request. A connection that names none resolves against `default`, which always exists — a database is deliberately not required the way Couchbase requires a bucket |
| `connectionString` | No | `clickhouse://`, `http://`, `https://`; see [§4.2](#42-connection-strings) |
| `ssl` | No | Any mode but `disable` switches the transport to `https` and the default port to `8443` |

```ts
const connection = {
  id: 'ch-1',
  name: 'ClickHouse',
  type: 'clickhouse',
  host: '127.0.0.1',
  port: 8123,
  user: 'libredb',
  password: 'password123',
  database: 'demo',
  createdAt: new Date(),
};
```

### 4.2 Connection strings

`supportsConnectionString` is `true`. Two related but distinct paths exist:

- **A pasted URL** goes through the shared parser
  ([`connection-string-parser.ts:66`](../../src/lib/connection-string-parser.ts)), which decomposes
  it into discrete fields (host/port/user/password/database) before the provider ever sees it, and
  stores no `connectionString` on the connection.
- **A hand-typed connection string** (the ConnectionModal's URI tab clears host, port, user and
  password when it submits) is resolved by the provider itself,
  `resolveConnection()` ([index.ts:402](../../src/lib/db/providers/sql/clickhouse/index.ts)), which
  is not optional politeness: for a connection typed there, the URL is the *only* place any of those
  fields exist. Percent-encoded credentials are decoded (`p%40ss%2Fword` → `p@ss/word`), an
  unparsable string leaves every configured field untouched rather than emptying a working
  connection, and `https://` sets `ssl.mode = "require"` and switches the default port to `8443`.

| Input | host | port | database |
|-------|------|------|----------|
| `clickhouse://localhost:8123/demo` | `localhost` | `8123` | `demo` |
| `http://reader:s3cret@ch.internal:9123/analytics` | `ch.internal` | `9123` | `analytics` |
| `https://abc.clickhouse.cloud/default` | `abc.clickhouse.cloud` | `8443` (TLS default, none in URL) | `default` |

A bare `http://` or `https://` URL is treated as canonically ClickHouse — no other provider claims
those schemes — because the HTTP interface *is* the connection target here, unlike a wire-protocol
database where an HTTP URL would mean nothing.

### 4.3 TLS

`config.ssl` with any `mode` but `disable` switches the transport from `http` to `https` and the
default port from `8123` to `8443`
([the transport constructor](../../src/lib/db/providers/sql/clickhouse/http-transport.ts)). There is no
separate CA/client-certificate plumbing the way Couchbase's `node:https` path has: the transport
uses the runtime's own `fetch`, whose TLS trust follows the platform's default certificate store.

`verify-system` (D26) is the mode that DESCRIBES this transport: `fetch` always verifies the chain
against the platform's certificate store and cannot be told otherwise, so of the four non-`disable`
modes it is the only one whose name matches the handshake. `require` here does not mean "encrypt
without checking" the way it does on the driver-based providers — nothing in this transport can skip a
check — and `verify-ca`/`verify-full` cannot pin against a pasted CA. Nothing in the code branches on
which one is selected.

Two consequences worth stating plainly:

- **`ssl.caCert`, `ssl.clientCert` and `ssl.rejectUnauthorized` are not honoured.** Global `fetch`
  cannot carry a custom CA or relax verification without an undici `Agent` as its `dispatcher`, and
  undici is not a dependency. A self-hosted node behind a **self-signed** certificate therefore fails
  verification; ClickHouse Cloud and any node with a publicly-trusted certificate work. Honouring
  them needs the `node:https` path Couchbase already has, which is a follow-up rather than a
  limitation of the scheme.
- **A pasted `https://` URL keeps its TLS intent.** `parseConnectionString` returns
  `sslMode: "require"` for that scheme and the connection form applies it, because the parsed
  host/port fields alone cannot express TLS — without it the connection would go out as plaintext
  HTTP to the TLS port and fail with a bare `fetch failed`.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?)` ([index.ts:593](../../src/lib/db/providers/sql/clickhouse/index.ts)) sends one
statement under **two** deadlines, both derived from `queryTimeout` (default 60 seconds), because
neither covers the other:

- **`max_execution_time`**, server-side, so a runaway statement cannot hang the editor. It only
  starts counting once ClickHouse has *accepted* the statement.
- **`timeoutMs` on the transport seam**, client-side, armed as an `AbortSignal` on the request. This
  is what bounds everything the server-side limit cannot: a stalled DNS lookup, TCP connect or TLS
  handshake, and a response body that stops arriving part-way. The same signal covers the body read,
  since a response whose headers arrive promptly can still stall mid-stream. Without it the advertised
  query timeout would quietly not apply to transport failures at all.

Monitoring reads carry the same pair at a shorter 10-second bound — a hanging panel is worse than an
empty one.

```ts
await provider.query('SELECT id, email FROM users');
```

**Positional parameters are refused, not silently ignored.** ClickHouse's HTTP interface binds only
named `{name:Type}` parameters, so there is nowhere on the wire to put a positional value; a caller
that passed one would otherwise have the statement run with its placeholders unbound. `query(sql,
params)` throws a `QueryError` the moment `params` is non-empty. An empty array is accepted, because
that is how the rest of the application calls every provider uniformly.

`prepareQuery()` injects `LIMIT`/`OFFSET` through the shared limiter
(`supportsExternalQueryLimiting: true`) unless the statement carries a trailing `FORMAT` or
`SETTINGS` clause ([§3.8](#38-the-preparequery-override)).

### 5.2 Result shaping

| Source | `QueryResult` field | Notes |
|--------|----------------------|-------|
| `data` array | `rows` | Objects exactly as the server returned them |
| `meta` array | `fields` | Declared column order; `[]` when the source could not describe the rows (a non-JSON format, or a write) |
| — | `rowCount` | `rows.length` when there are rows; otherwise `mutationCount` from `X-ClickHouse-Summary`, verbatim, zero included ([§3.6](#36-writes-return-an-empty-200-body-the-row-count-lives-in-a-header)) |
| `X-ClickHouse-Summary.elapsed_ns` | `executionTime` | The server's own duration, preferred because it excludes network latency; falls back to the envelope's `statistics.elapsed` (seconds), then to the measured wall clock when neither source reported anything |
| a non-JSON `X-ClickHouse-Format` | `rows` / `fields` | One synthetic row `{ __text: "<raw body>" }` under the single column `__text` ([§3.4](#34-default_formatjson-as-a-url-parameter-never-appended-to-the-sql)) |
| `meta` array | `columnTypes` | The declared type per column, keyed by its name in `fields` and spelled exactly as ClickHouse spells it — `Nullable(String)`, `LowCardinality(String)`, `Enum8('x' = 1)` — because the wrapper is what tells the user the column is nullable or low-cardinality. **Absent** when the envelope described no columns: a write, a format the user chose, or a statement with no result set. For a computed column such as `count()` this is the only source of a type at all, since no catalog entry exists for it (issue #273) |

### 5.3 EXPLAIN

The EXPLAIN button is available (`supportsExplain: true`) and renders the plan tree described in
[§3.12](#312-explain-reuses-the-shared-tree-model). ClickHouse has no analyze mode, so both the
direct action and the background pre-warm show the same estimated plan.

---

## 6. Schema introspection

Three separate reads of the `system.*` catalogs, run in parallel with `Promise.all`, all through the
transport seam:

| Data | Source |
|------|--------|
| Tables | `system.tables` — name, `total_rows`, `total_bytes`, `sorting_key`, `primary_key`, filtered to non-system databases |
| Columns | `system.columns` — name, type, `is_in_primary_key`, `default_kind`/`default_expression`, ordered by declaration `position` |
| Indexes | `system.data_skipping_indices` — the nearest thing ClickHouse has to a secondary index object, plus the synthesized `PRIMARY KEY` / `ORDER BY` entries |
| Foreign keys | always `[]` — ClickHouse has no foreign-key concept anywhere: no engine, no table setting, no DDL declares one |

Non-system databases are `system`, `information_schema`, and `INFORMATION_SCHEMA` (the last exists
as its own separate row in `system.databases`, live-verified, so excluding only one leaves a
duplicate ANSI catalog in the tree). `default` is deliberately **kept** — it is an ordinary writable
database and the one a connection that names none lands in, so hiding it would empty the commonest
setup.

Load-bearing details:

- **`total_rows` / `total_bytes` are `Nullable(UInt64)` and really are null** for a view and for
  every non-MergeTree engine (live-verified). Null is reported as `undefined` — unknown — never
  coerced to zero; a table shown as "0 rows" when the server never said so is a number the explorer
  would have invented.
- **A key expression is a comma-separated list that can itself contain commas** —
  `a, b, cityHash64(c, c)` — so splitting is parenthesis-depth-aware, never a naive `.split(',')`.
  A one-element key renders as `(a)` while a multi-element one renders as `a, b`; the parser strips
  exactly one wrapping pair when the whole expression is parenthesized.
- **The primary key and the sorting key are reported as separate index entries only when they
  differ.** ClickHouse's primary index is a real sparse index over the sort order — reporting no
  index at all on a MergeTree table would be misleading — but `ORDER BY` may extend `PRIMARY KEY`
  with trailing columns that genuinely shape the on-disk order and the query plan, so those are
  surfaced as a second `ORDER BY` entry when they add anything the primary key entry does not
  already say (comparing the split element lists, because the server renders the same one-element
  key as `(a)` in one column and `a` in the other).
- **No index ClickHouse reports is unique** — not the data-skipping indexes, which only prune
  granules, and not the primary key either: live-verified, three identical values were accepted into
  a table declared `PRIMARY KEY (a)`.
- **Each catalog degrades independently.** `system.tables` and `system.columns` are pre-filtered to
  what the connected user may read and answer `200`; `system.data_skipping_indices` needs its own
  grant and answers `500` / code `497` without it (live-verified). A denied index catalog still
  yields a full table-and-column tree; only the data-skipping-index list is empty. Any *other*
  failure propagates rather than degrading — an empty tree standing in for a real error would hide
  it forever.

`getSchemaList()` defers the index catalog entirely so a third catalog read never blocks the table
list, exactly as the SQL providers' two-phase loading does; `getSchemaRelations()` reads it and
returns an entry — empty list included — for every table, so the client can merge indexes in
without losing a table that legitimately has none.

---

## 7. Monitoring & health

Every method below degrades to empty/zero on `ACCESS_DENIED` (497) or `UNKNOWN_TABLE` (60) — and
**only** those two codes; any other failure propagates, because those are the two live-verified
codes for "this surface does not exist for this user or this deployment" (a missing grant, or
`query_log` switched off on a given server), while anything else is the user's own mistake that must
keep surfacing.

| Method | Source | Notes |
|--------|--------|-------|
| `getOverview()` | `version()`, `uptime()`, `system.metrics`, `system.server_settings`, `system.parts`, `system.tables`, `system.data_skipping_indices` | Five separate reads on purpose: a restricted user gets `200` from `version()`/`uptime()` and `system.tables`, but `500`/497 from `system.metrics` and the two count queries — combining them into one statement would throw away the panels a restricted user CAN see |
| `getPerformanceMetrics()` | `system.events` (`MarkCacheHits`/`MarkCacheMisses`/`Query`), `system.asynchronous_metrics` (`MemoryResident`/`OSMemoryTotal`) | cache-hit ratio from the mark cache (ClickHouse's nearest buffer-cache equivalent); `queriesPerSecond` divides the lifetime `Query` counter by uptime, since neither is ever sampled twice in a single-shot read; buffer-pool usage is resident memory against total machine memory |
| `getSlowQueries()` | `system.query_log` where `type = 'QueryFinish'`, grouped by `normalized_query_hash` | Grouped the way `pg_stat_statements` groups — one row per statement *shape*, with its call count and min/max/avg duration, not one row per execution. Flushed **asynchronously**, so a statement that just ran may be absent for a few seconds |
| `getActiveSessions()` | `system.processes` | Excludes its own read (`query NOT LIKE '%system.processes%'`), the same trick `postgres.ts` applies to `pg_stat_activity`; every row is reported with a constant `state: "active"`, because ClickHouse has no idle-in-transaction equivalent to distinguish |
| `getTableStats()` / `getIndexStats()` | `system.parts` (active parts only) / `system.data_skipping_indices` | Accept an optional `{ schema }` filter; without one, every non-system database is covered. Index scan counts are always `0` — ClickHouse publishes no per-index usage counter anywhere, and a guessed number would be worse than an obvious zero |
| `getStorageStats()` | `system.disks` | Name, path, total/free bytes, and a usage percentage per configured disk |
| `getHealth()` | the four above, composed | connections, size, cache-hit ratio, top-5 slow queries, top-10 sessions |

Two honest zeroes in the overview, so neither reads as a measurement:

- **`maxConnections` is `0` where `system.server_settings` is unavailable.** It is an ordinary system
  table on self-managed builds (verified present on OSS 26.7.1), but it is recent enough that an older
  server may not have it, and it is grant-gated like every other `system.*` read. Either way the read
  degrades rather than failing the panel.
- **Index scan counts are always `0`**, because ClickHouse publishes no per-index usage counter that
  the HTTP interface can reach.

---

## 8. Maintenance

`runMaintenance(type, target?)`
([index.ts:920](../../src/lib/db/providers/sql/clickhouse/index.ts)). `optimize` and `kill` **require**
a target; `analyze` does not.

| Type | ClickHouse action | Notes |
|------|--------------------|-------|
| `optimize` | `OPTIMIZE TABLE <db>.<table> FINAL` | Merges the table down to one part per partition and applies pending mutations — the operation a ClickHouse user reaches for where another engine would vacuum. A target is mandatory, because `OPTIMIZE` names a table |
| `analyze` | Reports a `system.parts` summary (part count, row count, on-disk size) for the target, **or for the whole pinned database when no target is given** | ClickHouse has no `ANALYZE` and needs none: a MergeTree's statistics *are* its parts, and they are current by construction, so the honest equivalent is to report them rather than pretend something was recomputed. The targetless form exists because `MaintenanceModal`'s global Analyze button (labelled by `analyzeGlobalLabel`) sends no target — a live run showed it failing with "requires a target", i.e. a control the UI always offers that could never work. A scope with no active parts (a view, or a non-MergeTree engine) is reported as such rather than as an error |
| `kill` | `KILL QUERY WHERE query_id = '<target>' SYNC` | `SYNC` so the result is reported after the query has actually stopped, not after the kill was merely queued |

`vacuum`, `reindex` and `check` have no ClickHouse equivalent, so they are absent from
`maintenanceOperations` and neither tab that offers maintenance renders them — the monitoring Tables
tab since #272, the admin Operations tab since #282.
Calling `runMaintenance` with one directly throws a `QueryError` naming the three supported
operations. A target is qualified through
`escapeIdentifier()` (`"database"."table"`, defaulting the database to the pinned one when the
target names none), so a hostile or oddly-named table cannot break out of the generated statement.

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#U9).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available - a targetless `{type:"optimize"}` is
that request here, the API-side half of the withheld *"Merge Parts"* card.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `optimize` | Optimize Table | yes | **no** | `OPTIMIZE TABLE ... FINAL` names one table and `dispatchMaintenance` requires that target; ClickHouse has no "optimize database", and looping every table would merge the whole dataset behind one click |
| `analyze` | Table Statistics | yes | yes | `describeParts` deliberately accepts no target as well as one |
| `kill` | Cancel Query | no | no | the target is a query id from the Sessions panel |

`vacuumAction` says *"Optimize Table"*, so `vacuumActionOperation: 'optimize'` records that
the vacuum slot names `optimize` rather than a `vacuum` ClickHouse would reject. The global
*"Merge Parts"* card stays withheld even so, because `optimize` declares `global: false`.

That makes `vacuumGlobalLabel` / `vacuumGlobalTitle` / `vacuumGlobalDesc` **deliberately
unreachable here**: no surface can render them while `optimize` has no whole-database form.
They are kept rather than dropped because `ProviderLabels` requires all three and the
inherited default is PostgreSQL's *"Removes dead rows and returns space to the operating
system"* — a statement ClickHouse does not have — so the choice is between wording that is
wrong if it ever shows and wording that is right if it ever shows. What #U9 removed was
wording that was written and never shown *without saying so*; the unreachability is asserted
in `tests/integration/db/clickhouse-provider.test.ts` ("the global vacuum card cannot render,
so its wording is unreachable by design") so that a future spec change makes it visible
rather than silent.

---

## 9. Capabilities & labels

### `getCapabilities()` ([index.ts:461](../../src/lib/db/providers/sql/clickhouse/index.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `explainFormat` | `clickhouse-json` |
| `supportsExternalQueryLimiting` | `true` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` — a bare `UPDATE ... SET` is code `48` `NOT_IMPLEMENTED` here ([§13](#13-known-limitations--future-work)) |
| `supportsTransactions` | `false` — reached over stateless HTTP, and ClickHouse has no general transaction to wrap anyway, so the trio and SANDBOX are not offered (#U13) |
| `declaresForeignKeys` | `false` — `REFERENCES` parses in a column definition and enforces nothing, and `system.*` holds no constraint catalog to read one back from |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['optimize', 'analyze', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `8123` |
| `schemaRefreshPattern` | `\b(CREATE\|DROP\|ALTER\|RENAME\|TRUNCATE\|ATTACH\|DETACH)\b` |

`supportsCreateTable: false` is deliberate, not an oversight — see
[§3.10](#310-supportscreatetable-is-false--live-disproved-the-issues-own-guess).

### `getLabels()` ([index.ts:489](../../src/lib/db/providers/sql/clickhouse/index.ts))

Tables and rows are the right words here, so only the maintenance vocabulary changes — ClickHouse
has no VACUUM and no ANALYZE, and offering either by that name would describe an operation that does
not exist: `analyzeAction`/`analyzeGlobalLabel`/`analyzeGlobalTitle` → *"Table Statistics"*,
`vacuumAction` → *"Optimize Table"*, `vacuumGlobalLabel` → *"Optimize"*, `vacuumGlobalTitle` →
*"Merge Parts"*. The card descriptions name the substituted operation explicitly (`OPTIMIZE TABLE
... FINAL`) rather than reusing generic wording that would describe a command ClickHouse does not
have. Of those, only `analyzeAction`/`analyzeGlobal*` and `vacuumAction` are reachable — the
`vacuumGlobal*` triad is unreachable by design
([§8](#where-each-operation-may-be-offered-maintenanceoperationspecs)).

One more label, and it is about the monitoring tab rather than maintenance:
`slowQueriesEmptyState` → *"Query stats come from system.query_log, which records nothing while
log_queries is off."* The Queries panel's empty state was hardcoded to PostgreSQL's
`pg_stat_statements` advice for every engine (`docs/BACKLOG.md` U12), and `system.query_log`
([§7](#7-monitoring--health)) is what an operator here can actually act on.

---

## 10. Error handling

The transport normalizes every failure into `ClickHouseTransportError { code, name, message }`; the
provider maps that one numeric space onto the shared classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
([index.ts:637](../../src/lib/db/providers/sql/clickhouse/index.ts)):

| Code | Meaning | Error raised |
|------|---------|--------------|
| `516` `AUTHENTICATION_FAILED`, `497` `ACCESS_DENIED` | Bad credentials, or a missing grant | `AuthenticationError` |
| `159` `TIMEOUT_EXCEEDED`, `209` `SOCKET_TIMEOUT` | The statement deadline was hit | `TimeoutError` |
| `394` `QUERY_WAS_CANCELLED` | The statement was killed (by this provider's own `kill`, or by another client) | `QueryCancelledError` |
| `210` `NETWORK_ERROR` | The server itself reported a network fault reaching a remote replica | `ConnectionError` |
| `0` (no server code) | Nothing below the SQL layer answered — a refused socket, an abort, a rewritten response | Falls through to the shared message-based mapping (`mapError()`), which recognises a refused connection and a generic timeout by message text |
| anything else (e.g. `62` syntax, `60` unknown table, `81` unknown database, `48` not implemented) | A statement the server understood and rejected | `QueryError` carrying the server's own message |

| Situation | Error |
|-----------|-------|
| Missing `host` **and** `connectionString` | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails on credentials | `AuthenticationError` |
| `connect()` fails otherwise (including a non-existent database) | `ConnectionError` (carries host/port) |

A bare `UPDATE ... SET` — as opposed to `ALTER TABLE ... UPDATE` — is code `48` `NOT_IMPLEMENTED`
(HTTP `501`, live-verified), and the server's own message names the exact precondition (*"Lightweight
updates are supported only for tables with materialized \_block\_number column"*), which is more
useful than any wording this provider could add, so it is surfaced verbatim as a `QueryError`.

---

## 11. Testing

### 11.1 How the tests work

There is **no `mock.module()` anywhere in the ClickHouse suite**, so none of these files carry
process-wide contamination risk:

- [`tests/integration/db/clickhouse-provider.test.ts`](../../tests/integration/db/clickhouse-provider.test.ts)
  replaces `globalThis.fetch` per test and restores it in `afterEach`. Every payload in it —
  catalog rows, monitoring rows, exception bodies — was captured from a live ClickHouse
  26.7.1.1315 server (database `demo`), so the fake speaks exactly what the cluster speaks.
- [`tests/unit/db/clickhouse/http-transport.test.ts`](../../tests/unit/db/clickhouse/http-transport.test.ts)
  drives `ClickHouseHttpTransport` directly against a faked `fetch`: request shape, endpoint
  construction (host/port/TLS/IPv6 bracketing), the JSON result path, the write path (empty body,
  summary header, DDL with no format header), non-JSON formats, failures (status, version-suffix
  stripping, exception-name/code extraction), the mid-stream trailer, and transport-level failures
  (unparsable JSON, a refused connection, an abort).
- [`tests/unit/db/clickhouse/introspect.test.ts`](../../tests/unit/db/clickhouse/introspect.test.ts)
  tests the introspection module against a hand-written fake `ClickHouseTransport` — the payoff of
  the seam in [§3.2](#32-the-transport-seam-one-interface-one-implementation): the system-database
  filter, null-vs-zero row counts, comma-in-parentheses key splitting, primary/sorting-key
  synthesis, data-skipping-index reporting, cross-database table-name disambiguation, and every
  degradation path.
- [`tests/unit/db/clickhouse/seam-guard.test.ts`](../../tests/unit/db/clickhouse/seam-guard.test.ts)
  is a parser, not a grep, and proves itself in both directions: it must fire on the transport file
  (which is *supposed* to speak the wire vocabulary) and stay silent on a compliant sample, before
  it asserts the real provider directory is clean.
- [`tests/unit/lib/explain/clickhouse-json.test.ts`](../../tests/unit/lib/explain/clickhouse-json.test.ts)
  covers the plan walker: wrapper-depth unwrapping, the `Plans` array walk, `Indexes` rendering
  (including the selected/initial ratio and a degraded entry missing type/keys/counts), and
  rejecting shapes that are not ClickHouse plans at all.

### 11.2 Coverage

The suite covers: validation (host-or-connection-string), the connection model (pinned database as
a URL parameter, hand-typed connection-string resolution including percent-decoding and the
TLS-port switch), connect/disconnect (including the `SELECT 1` probe surfacing a bad database or bad
credentials immediately), query execution and result shaping (declared column order, the server's
own duration, write row counts including the `ALTER ... UPDATE` zero, the non-JSON-format synthetic
column, positional-parameter refusal), the full error-code map, the `prepareQuery()` trailing-clause
override (both directions — statements that must be limited and statements that must not), every
schema method, every monitoring method and its degraded path, and all three maintenance operations
including identifier quoting and literal escaping.

### 11.3 Run it

```bash
# Just this provider
bun test tests/integration/db/clickhouse-provider.test.ts
bun test tests/unit/db/clickhouse
bun test tests/unit/lib/explain/clickhouse-json.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: verifying against a live server

The committed tests are mock-based by design. `database-compose.yml` carries a `clickhouse`
service pinned to the exact build (`clickhouse/clickhouse-server:26.7.1.1315`) this document and the
design spec were verified against, so status codes, header names, and the mid-stream-failure
trailer stay reproducible:

```bash
docker compose -f database-compose.yml up clickhouse
# then point a Studio connection at localhost:8123, user libredb / password123, database demo
```

Port `9000` (the native protocol) is deliberately not exposed — there is no native-protocol
transport in this codebase to connect with it.

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'ch1', name: 'ClickHouse', type: 'clickhouse',
  host: '127.0.0.1', port: 8123,
  user: 'libredb', password: 'password123',
  database: 'demo',
  createdAt: new Date(),
});

await provider.connect();

const result = await provider.query('SELECT id, email FROM users LIMIT 50');
const schema = await provider.getSchema();           // tables + columns + indexes, one round trip
const list = await provider.getSchemaList();          // fast: tables + columns, no index catalog
const relations = await provider.getSchemaRelations(); // indexes to merge in

await provider.disconnect();
```

### 12.2 Over the API

`POST /api/db/query` with the SQL statement in the `sql` field — the same contract every SQL
provider uses. `POST /api/db/maintenance` (admin) accepts `optimize` / `analyze` / `kill`;
`optimize` and `kill` require a `target`, while `analyze` treats a missing one as "the whole pinned
database" ([§8](#8-maintenance)) — so a client should omit it rather than invent one for
database-wide statistics. Transaction and cancel routes do not apply — see
[§13](#13-known-limitations--future-work).

---

## 13. Known limitations & future work

- **No transactions.** ClickHouse has no multi-statement transaction model to expose over this
  interface, so there is no begin/commit/rollback API here.
- **No `cancelQuery`.** A running statement is terminated through maintenance `kill` with its
  `query_id`, which needs its own grant like any other `system.processes` operation.
- **No analyze-mode EXPLAIN.** ClickHouse's `EXPLAIN` never executes the statement; see
  [§3.12](#312-explain-reuses-the-shared-tree-model).
- **`ALTER TABLE ... UPDATE` and lightweight `DELETE FROM` report zero rows changed even on
  success.** This is the server's own number, not a provider limitation to fix — see
  [§3.6](#36-writes-return-an-empty-200-body-the-row-count-lives-in-a-header).
- **Two shared SQL-generating features were not dialect-aware.** Both live outside this provider's
  files, both were pre-existing rather than introduced by it, and both were tracked in
  [#269](https://github.com/libredb/libredb-studio/issues/269):
  - The results grid's **inline row editing** generated a bare `UPDATE ... SET ... WHERE`, which
    ClickHouse rejects outright (`NOT_IMPLEMENTED`, code `48`, HTTP `501`) rather than running as an
    `ALTER TABLE ... UPDATE`. Since #269 this provider declares `supportsInlineRowEdit: false`, so the
    control is no longer offered here at all — neither the EDIT toggle nor an editable cell — instead
    of offering an edit that can only fail. Use `ALTER TABLE ... UPDATE` in the editor instead. (The
    same change also stopped the hook joining several row updates into one request, which this server
    rejected on its own; see the multi-statement note at the end of this section.)
  - The **schema-diff migration generator** emitted PostgreSQL's
    `ALTER TABLE ... ALTER COLUMN ... TYPE` / `SET NOT NULL` for a modified column, because every type
    id without its own branch fell into that generator's PostgreSQL `else`. Since #269 it has a
    ClickHouse branch: a modified column becomes
    `ALTER TABLE "t" MODIFY COLUMN "c" <declared type>[ <default clause>]`, and a dropped default
    becomes a second `MODIFY COLUMN "c" REMOVE <kind>`. A nullability change needs no separate
    statement — nullability lives inside the type here (`Nullable(T)`), which is what
    [§3.9](#39-column-types-are-the-declared-strings-verbatim) reports for the column, so restating the
    declared type carries it. Identifier quoting was already correct (both dialects use `"`).
    Live-probed against the pinned build while that branch was written, all four worth knowing:
    a computed column's default is carried kind-first (`MATERIALIZED toYear(d)`, as this provider reads
    `system.columns.default_kind` / `default_expression` into one string), so the generator emits that
    clause verbatim — `DEFAULT MATERIALIZED toYear(d)` is a syntax error
    (code `62`); `MODIFY COLUMN` with no default clause leaves the previous default in place, which is
    why the explicit `REMOVE` is emitted at all; `REMOVE` accepts `DEFAULT`, `MATERIALIZED` and `ALIAS`
    but not `EPHEMERAL`, so an ephemeral property carrying an expression is reported in a comment instead
    (a bare `x String EPHEMERAL` has no expression, so it reaches the diff as no default at all and the
    generator never sees it); and `REMOVE DEFAULT`
    against a column that has none is itself an error (code `36`), so it is emitted only for a default
    that existed. Still approximate: the generator wraps its output in `BEGIN` / `COMMIT`, which this
    server has no transaction model for, so drop those two lines before running a generated migration
    here.
- **No native protocol.** Port `9000` and everything that needs it — the native wire format, some
  server-side settings only exposed there — is out of scope; see
  [§3.1](#31-http-transport-only--no-native-dependency).
- **No dictionaries or materialized-view management.** Both are visible through `system.tables` like
  any other object (a materialized view's target table shows up as an ordinary table), but there is
  no dedicated UI or API surface for creating, refreshing, or reloading either.
- **Index scan counts are always zero.** ClickHouse publishes no per-index usage counter anywhere
  the HTTP interface can reach, and a guessed number would be worse than an obvious zero — see
  [§7](#7-monitoring--health).
- **Row counts and table sizes are the server's own bookkeeping** (`system.tables.total_rows` /
  `total_bytes`), not `COUNT(*)` — fast, and null (reported as unknown) for views and non-MergeTree
  engines rather than a computed figure.
- **`query_log`-backed monitoring needs its own grant and may be switched off entirely** on a given
  deployment; both are ordinary, expected configurations and degrade to an empty panel rather than
  an error — see [§7](#7-monitoring--health).
- **Multi-statement SQL is rejected by the server itself** (`Multi-statements are not allowed`,
  code `62`), so the provider does no client-side statement splitting; a single trailing semicolon is
  accepted.
- **A dot inside a database or table name cannot be told apart from the qualifier separator.**
  ClickHouse accepts `` CREATE DATABASE `a.b` `` (verified), but a table outside the pinned database
  is displayed and generated as `database.table`, so `a.b` + `c` renders as `a.b.c` and every consumer
  that splits on the dot reads it as three parts. Introspection is internally safe — the grouping key
  joins on `NUL`, not a dot — so only the *display name* is ambiguous. This is the same limitation
  `postgres.ts` carries for schema-qualified names; removing it means giving `TableSchema` structured
  segments instead of one string, which is a cross-provider change rather than a ClickHouse one.
  Dotted database names are vanishingly rare in practice.

---

## 14. References

- Source: [`src/lib/db/providers/sql/clickhouse/`](../../src/lib/db/providers/sql/clickhouse/)
- Explain strategy: [`src/lib/explain/clickhouse-json.ts`](../../src/lib/explain/clickhouse-json.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/clickhouse-provider.test.ts`](../../tests/integration/db/clickhouse-provider.test.ts) · [`tests/unit/db/clickhouse/`](../../tests/unit/db/clickhouse/) · [`tests/unit/lib/explain/clickhouse-json.test.ts`](../../tests/unit/lib/explain/clickhouse-json.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Tracking issue: [#264 — Add ClickHouse provider](https://github.com/libredb/libredb-studio/issues/264)
- HTTP interface: <https://clickhouse.com/docs/en/interfaces/http>
- System tables: <https://clickhouse.com/docs/en/operations/system-tables/tables>,
  <https://clickhouse.com/docs/en/operations/system-tables/columns>,
  <https://clickhouse.com/docs/en/operations/system-tables/data_skipping_indices>
- EXPLAIN: <https://clickhouse.com/docs/en/sql-reference/statements/explain>
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [MongoDB](./mongodb.md) · [Couchbase](./couchbase.md) · [Apache Trino](./trino.md) · [Redis](./redis.md) · [LibreDB](./libredb.md)
