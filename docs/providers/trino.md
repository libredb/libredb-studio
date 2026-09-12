# Apache Trino Provider

> Apache Trino support for LibreDB Studio, built on Trino's own client protocol (`POST /v1/statement`,
> port `8080`) with **no driver dependency of any kind**: every statement is the body of an HTTP
> request and the answer is read by following a chain of `nextUri` links through the runtime's own
> `fetch`. This document is the single reference point for the Trino provider: design, architecture,
> usage, and tests. If you are reading the code, extending Trino support, adding PrestoDB, or
> authoring a new provider over HTTP, start here.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `trino` |
| **Family** | SQL (`src/lib/db/providers/sql/trino/`) |
| **Driver** | None — HTTP only (`fetch`, a runtime built-in) |
| **Query language** | `sql` |
| **Default port** | `8080` — the client protocol *and* the web UI share it. The same number is the default under TLS: a secured cluster serves on whatever port its operator chose, so no well-known HTTPS port is invented ([§4.3](#43-tls-and-the-password-rule)) |
| **Connection pooling** | None — each statement is one stateless exchange of HTTP requests |
| **Connection string** | Not supported. `jdbc:trino://host:port/catalog/schema` exists; the shared parser does not accept it ([§4.2](#42-there-is-no-connection-string--yet)) |
| **EXPLAIN** | `trino-json` — estimate only. `EXPLAIN (FORMAT JSON)` plans and never runs; `EXPLAIN ANALYZE` executes the statement, so it is deliberately never emitted ([§5.6](#56-explain-is-the-planning-form-only)) |
| **Writes** | Whatever the connector allows. The grammar has `INSERT`, `UPDATE`, `DELETE`, `MERGE` and `CREATE TABLE`; each catalog's connector decides for itself ([§5.5](#55-writes-belong-to-the-connector-not-to-the-engine)) |
| **Transactions** | Not exposed |
| **Maintenance** | `kill` only, via `CALL system.runtime.kill_query` ([§8](#8-maintenance)) |
| **Query cancellation** | Yes — `cancelQuery()` over `DELETE /v1/query/{id}` ([§3.7](#37-abandoning-a-request-does-not-stop-the-work)) |
| **Verified against** | **Apache Trino 476**, the official `trinodb/trino:476` image with authentication disabled, catalogs `tpch` / `tpcds` / `memory` / `system` / `jmx`; schema tree read against `tpch`, statistics against `tpch.tiny`. Measured 2026-08-20 |
| **Source** | [`src/lib/db/providers/sql/trino/`](../../src/lib/db/providers/sql/trino/) |
| **Tests** | [`tests/integration/db/trino-provider.test.ts`](../../tests/integration/db/trino-provider.test.ts) + [`tests/unit/db/trino/`](../../tests/unit/db/trino/) + [`tests/unit/lib/explain/trino-json.test.ts`](../../tests/unit/lib/explain/trino-json.test.ts) + [`e2e/trino-provider.spec.ts`](../../e2e/trino-provider.spec.ts) |
| **Tracking issue** | [#424 — Wire-compatibility and new engines](https://github.com/libredb/libredb-studio/issues/424), Phase 2 |

---

## 1. Overview

Trino is a distributed SQL **query engine**, not a database. It stores nothing: every table it can
name belongs to a system behind a *connector*, and a Trino deployment is a set of configured
*catalogs*, each one a connector pointed at something else — a Hive metastore, a PostgreSQL server,
a Kafka cluster, a JMX tree. Almost everything below follows from that single fact, because it means
half of what a provider normally reports (bytes on disk, indexes, keys, transactions, a vacuum
button) belongs to a system Trino only reads.

The three behaviours that shape the code, all measured on 476 and all the opposite of what an
ordinary JSON API teaches:

1. **A failed statement is an HTTP `200`.** `SELEKT 1`, a missing table, an unsupported DDL — every
   one answers `200` with the failure inside the document. Success is never inferred from a status
   ([§3.3](#33-a-failed-statement-arrives-as-http-200)).
2. **A statement is answered over many pages, and the loop ends on the absence of a link.** Even
   `SELECT version()` takes five. Column declarations and rows arrive on *different* pages, and a
   page with no `data` is mid-flight rather than the end
   ([§3.4](#34-the-loop-ends-on-the-absence-of-a-link-never-on-a-state)).
3. **A password over plain HTTP is refused by the server**, even with authentication switched off
   ([§3.6](#36-a-password-is-a-tls-only-credential)).

### Concept mapping

| `DatabaseProvider` slot | Trino realisation | Mechanism |
|---|---|---|
| "Database" (the connection's `database` field) | One **catalog**, pinned for the connection | `X-Trino-Catalog` on every request ([§3.2](#32-the-connections-database-field-pins-one-catalog)) |
| "Schema" | A schema inside that catalog | `information_schema.tables.table_schema` |
| "Table" (`TableSchema`) | A table, always displayed `schema.table` | `<catalog>.information_schema.tables` |
| "Row" | One result row | A positional `data` array element, keyed by the page's column declaration |
| Columns | The connector's declared columns, types rendered verbatim (`varchar(25)`, `array(integer)`, `row(x integer, y varchar)`) | `<catalog>.information_schema.columns` |
| Primary key | **Nothing.** Trino declares none, anywhere | — ([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)) |
| Foreign keys | **Nothing** | — ([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)) |
| Indexes | **Nothing** | — ([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)) |
| "Connection" (sessions panel) | A **statement in flight**. The protocol is stateless HTTP; there is no session object to count | `system.runtime.queries` |
| "Storage" | One row per **catalog**, named by its connector | `system.metadata.catalogs` ([§7](#7-monitoring--health)) |
| Server version | The bare string `"476"` — no product name, no semver | `system.runtime.nodes.node_version` |
| Uptime | The coordinator JVM's, and only when the `jmx` catalog is configured | `jmx.current."java.lang:type=runtime"` |

### PrestoDB is not this provider

Trino was forked from Presto, the two still speak a near-identical client protocol, and it is
tempting to serve both from one type-id. This provider does not. `presto` is a **separate future
type-id** with its own document, its own integration test and its own live probe, because the
tri-sync invariant is per type-id and because the two products disagree on things a user sees — most
visibly `version()`, which answers the bare `"476"` here and a `0.2xx`-shaped string there.

What this change *did* do is make that future a descriptor rather than a rewrite: no header name is
written down anywhere in the transport. Every one is generated as `X-<prefix>-<suffix>` from a
`TrinoDialect`, exactly the way `io.trino.client.ProtocolHeaders` generates it server-side
([§3.1](#31-the-header-prefix-is-data-so-prestodb-is-a-descriptor)). Adding PrestoDB is a new entry
in `TRINO_DIALECTS`, not a new transport.

---

## 2. Architecture

### 2.1 Where it sits

```
src/lib/db/providers/sql/trino/
├── index.ts           TrinoProvider extends SQLBaseProvider — lifecycle, capabilities, delegation
├── transport.ts       THE SEAM — types + TrinoTransportError + the dialect descriptor. No I/O.
├── http-transport.ts  The only file that knows the client protocol. Zero runtime dependency.
└── introspect.ts      Every read that is not the user's own statement: catalog tree + monitoring
```

The same four-file shape as `sql/clickhouse/`, `sql/druid/` and `sql/search/`, and for the same
reason: provider logic never calls `fetch`. `tests/unit/db/trino/seam-guard.test.ts` fails the build
the moment an endpoint path, a header name or a protocol field name appears outside
`http-transport.ts`.

### 2.2 Class hierarchy

```
DatabaseProvider (interface)
└── BaseDatabaseProvider
    └── SQLBaseProvider
        └── TrinoProvider
```

### 2.3 What `SQLBaseProvider` gives for free

Double-quoted identifiers are correct Trino SQL and `information_schema` is spelled the ANSI way, so
`escapeIdentifier()`, `getInformationSchemaName()`, `isReadOnlyQuery()` and `isSchemaModifyingQuery()`
are all inherited unchanged. This is the case `docs/ADDING_A_PROVIDER.md` names ClickHouse for.

Exactly one shared helper is wrong here, and it is overridden: `prepareQuery()`
([§3.5](#35-offset-comes-before-limit)). The transport absorbs the other grammar quirk a caller can
trip over on its own, the trailing semicolon ([§3.13](#313-a-trailing-semicolon-is-a-syntax-error)).

### 2.4 Registration & lifecycle

`connect()` constructs a `TrinoHttpTransport` and sends `SELECT 1` — a statement that needs no
catalog, deliberately, so a connection that pins a catalog the cluster does not have still connects
and fails later with a precise message rather than being refused at the form. `disconnect()` closes
the transport and forgets every recorded query id.

---

## 3. Design decisions

### 3.1 The header prefix is data, so PrestoDB is a descriptor

The client protocol's header family is generated, server-side, from the product name:
`X-Trino-User`, `X-Trino-Catalog`, `X-Trino-Source`, `X-Trino-Time-Zone`. The transport generates
them the same way, from `TrinoDialect.headerPrefix`, and stores only the **suffixes**. No finished
header name is a literal anywhere in the provider.

That is not aesthetics. The compatibility shim that would let one prefix serve both products
(`protocol.v1.alternate-header-name`) is `@Deprecated` in `io.trino.server.ProtocolConfig` and off by
default, so "send one prefix and hope" would be building on a deprecation. The descriptor also
carries `displayName`, `defaultPort` and `versionQuery`, because each of those genuinely differs
between the two products and nothing else does.

### 3.2 The connection's `database` field pins one catalog

Trino's hierarchy is **catalog → schema → table**, one level deeper than the schema tree's
database → schema → table. The mapping chosen here is the PostgreSQL one: the connection's
`database` field holds **the catalog**, exactly as a PostgreSQL connection pins one database, and
the schemas inside it are the schema level. The tree is two levels, and a table's display name is
always `schema.table`.

The alternative — fanning `information_schema` out across every catalog — is **unbounded in
practice**: `jmx.current` alone publishes one table per MBean, and one sidebar refresh would depend
on every connector the cluster has configured being reachable. `SHOW CATALOGS` is still useful, and
it is exposed where it belongs: the Storage panel lists one row per catalog with its connector
([§7](#7-monitoring--health)).

**Cross-catalog queries still work.** Nothing about this pin constrains the editor: `SELECT * FROM
other_catalog.some_schema.t JOIN tpch.tiny.nation ON …` runs exactly as typed, because the pinned
catalog only supplies the default for names that are not fully qualified. What the pin decides is
which catalog the *tree* shows.

A connection that names no catalog still connects and still runs every fully qualified statement,
plus the whole of `system.runtime`. What it cannot do is show a tree, and `getSchema()` says so:
*"This connection pins no Trino catalog, so there is no schema to list."*

### 3.3 A failed statement arrives as HTTP 200

Measured on 476 — the status is `200` for all of these:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Trino-User: libredb' \
    --data-binary 'SELEKT 1' http://localhost:8080/v1/statement
200
```

and the failure is inside the document:

```json
{"error": {"message": "line 1:1: mismatched input 'SELEKT'. Expecting: 'ALTER', 'ANALYZE', ...",
           "errorCode": 1, "errorName": "SYNTAX_ERROR", "errorType": "USER_ERROR",
           "errorLocation": {"lineNumber": 1, "columnNumber": 1},
           "failureInfo": { "... 19 Java stack frames, 3.3 KB ..." }}}
```

So the transport categorises **from the body**, never from the status. The status is consulted for
exactly one thing: a request the coordinator refused before it became a statement at all
([§3.6](#36-a-password-is-a-tls-only-credential)).

Two consequences worth stating:

- **The engine's own wording is kept verbatim**, because nothing we could synthesize locates the
  fault better: `line 1:15: Table 'tpch.tiny.nope' does not exist`. The 1-based `errorLocation`
  travels with it as `TrinoSourceLocation`, and is legitimately absent — measured, `NOT_SUPPORTED`
  on a `CREATE TABLE` reports it as null and `USER_CANCELED` omits the field.
- **The Java stack is dropped at the seam.** 19 frames and 3.3 KB for the simplest possible typo.
  The integration test asserts against that payload verbatim, so "the provider does not surface
  `io.trino` frames" is proved against the thing it must not surface.

### 3.4 The loop ends on the absence of a link, never on a state

The protocol says it out loud, and 476 behaves accordingly: *"The `status` field of the JSON
document is for human consumption only … It cannot be used to tell if the query is finished."*

Measured facts the page loop is built on:

- **`SELECT version()` takes five pages.** Four of them are empty `QUEUED` shells.
- **A page reporting `FINISHED` can still carry a `nextUri`**, and measured, the page that finally
  held the rows was one of those.
- **The column declaration and the rows arrive on different pages.** The declaration is captured
  from the first page that has one and held for the rest of the exchange.
- **A page with no `data` is mid-flight, not the end.**

`stats.state` is therefore carried across the seam as display text only, and the seam's own comment
says why a caller must not branch on it.

### 3.5 `OFFSET` comes before `LIMIT`

Trino's grammar is `[ OFFSET count ] [ LIMIT count ]`, and only that way round. Measured:

```
SELECT nationkey FROM tpch.sf1.nation LIMIT 3 OFFSET 1
  -> line 1:47: mismatched input 'OFFSET'. Expecting: <EOF>
SELECT nationkey FROM tpch.sf1.nation OFFSET 1 LIMIT 3
  -> rows
```

The shared limiter emits the first form for every page after the first, so **every paged read would
fail** without an override. `prepareQuery()` calls `super.prepareQuery()` and then *transposes* the
two clauses rather than rewriting the statement: the limiter already decided where the clause goes,
which is the hard part — it inserts before any trailing comment (#280) and refuses statements whose
end cannot be cut.

Which occurrence to transpose is decided by **reconstruction**, not by position, and that is not
defensive coding: because the clause goes in before a trailing comment, `lastIndexOf` finds the text
inside a comment on a statement that quotes its own bound, and `indexOf` finds a subquery's. Exactly
one occurrence is the appended one — the one whose removal, together with the single space in front
of it, yields the original statement back.

### 3.6 A password is a TLS-only credential

**Measured against a coordinator with authentication switched off entirely:**

```console
$ curl -s -i -H "Authorization: Basic $(printf 'user:password' | base64)" \
       -H 'X-Trino-User: libredb' --data-binary 'SELECT 1' http://localhost:8080/v1/statement
HTTP/1.1 401 Unauthorized
Content-Type: text/plain;charset=utf-8
WWW-Authenticate: Basic realm="Trino"

Password not allowed for insecure authentication
```

Sending a password over `http://` therefore **breaks a connection that would otherwise have
worked**. The transport constructor refuses that configuration up front, with a message that names
both ways out:

> *Trino refuses a password over plain HTTP. Enable TLS on the connection, or remove the password to
> connect as an unauthenticated user.*

The related measurement, and the reason error paths do not `JSON.parse` blindly: a request the
coordinator refuses **before** it becomes a statement answers **plain text**, not JSON.

```console
$ curl -s -i --data-binary 'SELECT 1' http://localhost:8080/v1/statement
HTTP/1.1 401 Unauthorized
Content-Type: text/plain;charset=utf-8

Basic authentication or X-Trino-Original-User or X-Trino-User must be sent
```

Parsing that as JSON throws a second, misleading error on top of the first. So a user header is
never omitted — a connection that names no user runs as `libredb`, which is also what the
coordinator's UI and `system.runtime.queries` will show.

### 3.7 Abandoning a request does not stop the work

Unlike every other HTTP provider in this repo, dropping the exchange here leaves the statement
**running on the cluster** until it finishes. So termination is an explicit act, and `cancel` is a
member of the seam rather than an absence:

- Every exit path of a statement that is not a completed answer terminates it explicitly.
- `cancelQuery(token)` exists on the provider. The Trino query id is learned *while the statement is
  still in flight* (`onQueryStarted`), because that is the only moment it exists for a caller who
  wants to cancel from a UI button.
- The wire act is `DELETE /v1/query/{id}` → **204 No Content**.

Two measured properties a caller must not misread. Cancellation is **idempotent and forgiving**:
cancelling a finished statement, and even an id that never existed, is accepted silently. And
polling immediately after the DELETE still reported state `QUEUED`, so nothing here asserts an
instant `FAILED`/`CANCELED`. `cancelQuery()` returning `true` means *the coordinator accepted the
termination*; `false` means only that nothing was ever recorded under that token.

### 3.8 No keys, no indexes — and why that is a fact about the engine

Not "none found". Trino's `information_schema` holds exactly eight views, measured:

```
applicable_roles  columns  enabled_roles  roles  schemata  table_privileges  tables  views
```

There is no `table_constraints` and no `key_column_usage`, so **no connector can declare a key
through it**, and no index object exists in any catalog. Whether the system *behind* a connector has
indexes is its own business and unreadable from here: a PostgreSQL table reached through the
PostgreSQL connector still has its indexes, and Trino will not name one of them.

What that produces, deliberately and consistently:

| Surface | Answer | Why |
|---|---|---|
| `getIndexStats()` | `[]`, and **no statement is sent** | The answer cannot vary with the connection, so there is nothing to ask |
| `TableSchema.indexes` / `.foreignKeys` | `[]` | Empty by construction, not by omission |
| `ColumnSchema.isPrimary` | `false` | No key is declared for any column |
| `declaresForeignKeys` | `false` | So the ER diagram draws boxes and no edges *as the engine's answer*, not as a schema that happens to be empty (#414) |
| `supportsInlineRowEdit` | `false` | The inline editor builds `UPDATE … WHERE <pk> = <val>`. With no column that identifies one row, an edit would silently rewrite every row that matches, so the control is not offered |
| `DatabaseOverview.indexCount` | `0` | — |

### 3.9 The bytes are somewhere else, so the size panels say so

Trino stores nothing. The only byte figure it publishes is `SHOW STATS.data_size`, which is per
table, an estimate, and **null for every fixed-width column** — measured on `tpch.tiny.region`, which
reports `34` and `330` for its two varchars and `null` for its `bigint`:

```
[["regionkey", null, 5.0, 0.0, null, "0", "4"],
 ["name",      34.0, 5.0, 0.0, null, null, null],
 ["comment",  330.0, 5.0, 0.0, null, null, null],
 [null,        null, null, null, 5.0, null, null]]     <- the summary row; column_name is null
```

So `DatabaseOverview.databaseSize` is the string `"N/A"`, and `HealthInfo.cacheHitRatio` is `"N/A"`
as well. Both fields are strings precisely so they can decline rather than report a zero that reads
as a measurement — and `cacheHitRatio` in particular is scored `direction: "below"` with
`critical: 80` by `DEFAULT_THRESHOLDS`, so a "neutral" `0` would paint every healthy cluster red.

`DatabaseOverview.databaseSizeBytes` is **not written at all** — the key is absent from the object
`getOverview()` returns, not present holding `0`. It is an optional field for exactly this reason:
absence and zero are different facts, a `0` is a measurement, and the Storage tab formats whatever
number it is given, so a zero rendered as "0 B" beside a 0.0% breakdown would be the fabricated
footprint this whole section exists to refuse. Until **2026-08-27** the object stated both at once:
`databaseSize: "N/A"` — the figure is unavailable — on the line above `databaseSizeBytes: 0` — the
database holds zero bytes. Apache Cassandra's `getOverview()` omits the key on the same argument for
a different cause (`system_views.disk_usage` reports whole mebibytes), and that is the precedent this
follows. There is no conditional spread here, unlike `startTime`: no read could ever supply the
value, so the key is simply never written.

`maxConnections` stays a plain `0` and is untouched by this: for that field `0` and absence are the
SAME fact — it means "no ceiling published", which is true, and the field is a required number.

### 3.10 Absent, never zeroed

`PerformanceMetrics` reports **one** field, `queriesPerSecond`, taken from a rate the coordinator
itself measures (`jmx.current."trino.execution:name=querymanager"`). Every other field is left
**absent**, and each absence is a different impossibility: Trino runs no transactions, holds no
buffer pool because it holds no pages, takes no locks so counts no deadlocks, writes no checkpoints,
and its caches belong to the connectors, which publish no hit ratio here.

The rate is read from JMX rather than derived from the query log on purpose: the log is a bounded
in-memory history the coordinator trims, so counting rows in it over a window would report a rate
that **falls to zero on a busy cluster** the moment the history wraps.

The panels keep the absences absent, which they did not always: the Overview and Performance tabs read
`bufferPoolUsage` and `deadlocks` as `?? 0` and so drew a `0 %` bar rated **Poor** in red and a `0`
deadlock count badged **Healthy** — a fault and a clean bill of health for two figures this provider
declines to publish. Both now read `N/A` beside the words *Not measured*, and their trend charts say
the same instead of tracing zero. The monitoring Tables tab's per-row *Bloat* column went the same
way: `getTableStats()` sets no bloat ratio, and a `0.0%` badge in the healthy variant reported a
measurement nobody made, so the cell is a dash.

### 3.11 Values are passed through exactly as the wire encodes them

Measured on 476, one statement:

```json
[["1.23", "AQI=", [1, 2], {"k": 1}, [1, "x"], "2020-01-01 10:00:00.000"]]
```

| Trino type | On the wire | Note |
|---|---|---|
| `decimal` | a **string** — `"1.23"` | Never a JS number: `JSON.parse` would round it |
| `bigint` | an **unquoted number** | The one value this seam rewrites, because the server does not quote it and `JSON.parse` rounds it (below) |
| `varbinary` | **base64** — `"AQI="` | |
| `array(T)` | a JSON array | |
| `map(K,V)` | a JSON object | |
| `row(…)` | a JSON **array**, positionally | The field names live in the rendered type, not in the value |
| `timestamp` | `"2020-01-01 10:00:00.000"` | Rendered in **UTC**, pinned by `X-Trino-Time-Zone` |

Nothing is re-interpreted, with one declared exception: an integer too wide for a double. The
timezone pin is deliberate: the protocol's default is "the timezone of the Trino cluster, and not the
timezone of the client", so leaving it unset makes the same statement produce different text
depending on where the coordinator happens to run.

**A wide `bigint` is rewritten before the page is parsed.** Measured on 2026-08-22,
`SELECT CAST(9223372036854775807 AS BIGINT)` puts the exact digits on the wire unquoted, and
`JSON.parse` answers `9223372036854776000` with no error to catch. Written into `memory` and read
back through this provider, a value the database held correctly reached the grid wrong. Trino has no
counterpart to ClickHouse's `output_format_json_quote_64bit_integers` (#264), so the raw text is the
only place left: `parseJson` runs `quoteUnsafeIntegers` (#265, shared with the Druid transport, which
is in the same position) over the page first, and both endpoints of the range arrive as strings,
`"9223372036854775807"` and `"-9223372036854775808"`. Anything a double holds exactly, `42`, is left
a number, and a `decimal` was never at risk because the server already quotes it.

The pass covers the whole envelope rather than `data` alone, because at that point the body is one
JSON text and splitting it would mean parsing it twice. The cost is bounded and stated: a `stats`
counter above 2^53 would arrive as a string and `numberField` would read it as absent, which needs
`processedBytes` past 9 PB in a single statement. An absent statistic is recoverable, a rounded
`bigint` in a result row is not, because nothing downstream can tell that it happened.

Column labels are taken from the page's declaration and **de-duplicated** — a second column called
`x` becomes `x (2)` — because the seam promises `fieldNames` is exactly the key set of every row.

### 3.12 Statelessness is a warning, not a silent surprise

Every statement is sent independently and none of the session the coordinator offers back is kept.
So `SET SESSION`, `USE`, `PREPARE` and `DEALLOCATE` all report success and then have **no effect on
the next statement**, and nothing else in the answer distinguishes them from a statement that worked.
Rather than let a user set a session property and watch the next query ignore it, those operations
attach a `QueryWarning`:

> *`"SET SESSION"` succeeded, but each statement is sent on its own connection, so it will not affect
> the next one. Set Catalog Name and Schema Name on the Trino connection for a persistent namespace,
> or qualify names in full.*

The engine's own remarks travel the same way — measured, a redundant `ORDER BY` in a subquery answers
with rows plus `REDUNDANT_ORDER_BY`. They are de-duplicated, because the same remark is repeated on
every page of the exchange (measured on all six pages of one statement) and a caller must not render
it six times.

### 3.13 A trailing semicolon is a syntax error

Measured: `SELECT 1;` answers `line 1:9: mismatched input ';'`. That is what
`statementTerminator: "none"` declares, and it is mandatory rather than cosmetic — without it the
shared query generators emit statements this engine refuses.

**The transport drops a single trailing semicolon before the statement leaves it**, so
`query("SELECT 1;")` and `query("SELECT 1")` reach the coordinator as the same bytes. Trailing
whitespace and a newline after the semicolon count as trailing, which is what a statement pasted out
of a file carries. This is the second Trino grammar quirk the provider absorbs for the caller — the
first is the `OFFSET`/`LIMIT` transposition ([§3.5](#35-offset-comes-before-limit)) — and absorbing
one and not the other was the inconsistency (#463). Nothing inside the product was
affected either way: `splitStatements()` consumes the semicolon as its delimiter, so the caller who
hit this was a consumer of the published package calling `query()` directly.

It is a **strip, not a splitter**, and the difference is the point:

| Statement | Reaches the wire as | Why |
| --- | --- | --- |
| `SELECT 1;` | `SELECT 1` | The terminator, dropped |
| `SELECT 1 ;\n` | `SELECT 1` | Whitespace and a newline after it are trailing too |
| `SELECT 1; SELECT 2` | unchanged | The endpoint takes exactly one statement, so this keeps failing |
| `SELECT 1;;` | unchanged | A doubled terminator is a second, empty statement |
| `SELECT ';';` | `SELECT ';'` | A semicolon inside a literal is data |
| `SELECT 1 -- done;` | unchanged | A semicolon inside a comment is prose |
| `SELECT 1; -- done` | unchanged | Declared limit: a terminator with a comment after it is left alone |

Where the statement ends comes from `lib/sql/statement-end` — the same reader the query limiter uses
(#280), which scans spans rather than matching `/;\s*$/` and refuses to cut a text whose literal or
comment never closes.

`identifierQuoting: "double"` is declared explicitly for the neighbouring reason (#424 Phase 1's
lesson): the generators otherwise derive the quote character from `defaultPort`, and `8080` is a
generic HTTP port that says nothing about a dialect. Trino quotes with `"`, and a backtick is not a
quote character in its grammar at all.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Meaning |
|---|---|---|
| `host` | **Yes** | The coordinator. The only validated requirement |
| `port` | No | Defaults to `8080`, for both `http://` and `https://` |
| `database` | No | **The catalog** to pin ([§3.2](#32-the-connections-database-field-pins-one-catalog)). Without it the editor works and the tree does not |
| `schema` | No | Session schema for unqualified table names, sent as `X-Trino-Schema` |
| `username` | No | Sent as `X-Trino-User`. Defaults to `libredb`; never omitted ([§3.6](#36-a-password-is-a-tls-only-credential)) |
| `password` | No | `Authorization: Basic`, **and only over TLS** ([§4.3](#43-tls-and-the-password-rule)) |
| `ssl` | No | Selects `https://` |

The connection form exposes **Catalog Name** and **Schema Name**. Set both to run
unqualified statements in the editor and Create Table: for example, Catalog `memory`
and Schema `default` let `SELECT * FROM widgets` and `CREATE TABLE t (id INTEGER NOT NULL)`
resolve inside `memory.default`. `SHOW SCHEMAS` lists the catalog's available schemas.
No schema is guessed: an omitted or empty value sends no schema header, so existing
connections keep their behavior until edited. Without a session schema, qualify table names.

Per-statement `TrinoQueryOptions.schema` overrides the connection default; an explicit empty
string omits the header for that statement. Headers still use the dialect's prefix. The schema
tree continues to list the whole catalog and qualify names as `schema.table`, so selecting a
table outside the session schema still targets that table. Fully qualified queries can still
reach other catalogs. The session schema is also supported in seeded connections.

### 4.2 There is no connection string — yet

`supportsConnectionString: false`. Trino's own JDBC URL — `jdbc:trino://host:port/catalog/schema` —
is a real and widely pasted form, but the shared parser in `src/lib/connection-string-parser.ts` does
not accept it. Advertising a field that would reject everything a user pastes is worse than not
offering it, so this stays false until that parser learns the scheme.

### 4.3 TLS and the password rule

`ssl: true` selects `https://`, on the same default port — a secured cluster listens wherever its
operator put it, and inventing a well-known HTTPS port would send credentials somewhere nothing is
listening.

**A password requires TLS.** This is the server's rule, not ours, and it holds even on a cluster with
authentication disabled ([§3.6](#36-a-password-is-a-tls-only-credential)). A password on a plain-HTTP
connection is refused by the transport constructor rather than sent and 401'd.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` submits the statement as `text/plain` and follows the `nextUri` chain
to completion. `executionTime` is the **coordinator's own** `elapsedTimeMillis`, not a client wall
clock: carrying both would invite a caller to compare two numbers that mean different things.

**Positional parameters are refused, not interpolated.** Trino does bind them, through
`PREPARE`/`EXECUTE` and a prepared-statement header this transport does not send, so this is a
bounded gap in the client rather than a property of the engine. Running the statement with unbound
placeholders, or splicing values into the SQL, are both worse than saying so.

### 5.2 Result shaping

| `QueryResult` field | Source |
|---|---|
| `rows` | The positional `data` arrays, keyed by the declaration |
| `fields` | The declared column names, de-duplicated. `[]` is a real declaration of no columns — what a `CREATE TABLE` answers |
| `columnTypes` | The **rendered** type strings verbatim: `bigint`, `varchar(25)`, `array(integer)` |
| `rowCount` | The rows returned, or — for a statement that returned none and changed something — `updateCount`. An `INSERT` reports both (measured: `updateCount` 3 beside a one-row result set saying 3) and the result set wins |
| `executionTime` | The coordinator's `elapsedTimeMillis` |
| `warnings` | The engine's remarks, plus the statelessness notice ([§3.12](#312-statelessness-is-a-warning-not-a-silent-surprise)) |

### 5.3 Value encoding

See [§3.11](#311-values-are-passed-through-exactly-as-the-wire-encodes-them).

### 5.4 Dialect traps a user will hit

- **No trailing semicolon** in the grammar — one written anyway is dropped by the transport
  ([§3.13](#313-a-trailing-semicolon-is-a-syntax-error)).
- **`OFFSET` before `LIMIT`** ([§3.5](#35-offset-comes-before-limit)).
- **Identifiers are double-quoted**; a backtick is not a quote character.
- **`SET SESSION` and `USE` do not persist** ([§3.12](#312-statelessness-is-a-warning-not-a-silent-surprise)).
- **`information_schema` is per catalog**, and it is hidden from the tree — the same eight views in
  every catalog would bury the user's own schemas. It stays reachable by typing SQL.

### 5.5 Writes belong to the connector, not to the engine

`supportsCreateTable: true`, because `CREATE TABLE` is in the grammar and was live-verified working on
the `memory` connector. Whether it works on **your** catalog is that connector's answer, and no
statement is special-cased here: measured, the same connector answers `UPDATE` with
`This connector does not support modifying table rows`. The connector's own message names the
boundary better than anything this provider could substitute.

### 5.6 EXPLAIN is the planning form only

`supportsExplain: true`, `explainFormat: "trino-json"`
([`src/lib/explain/trino-json.ts`](../../src/lib/explain/trino-json.ts)).

Trino has **two** explain forms, and they are not two renderings of one thing. Live-verified on 476
in the only way that settles it:

- `EXPLAIN (FORMAT JSON) INSERT INTO memory.default.probe VALUES (42)` finished, and `SELECT count(*)`
  on that table still answered **0**. It plans and never runs.
- `EXPLAIN ANALYZE INSERT INTO memory.default.probe VALUES (7)` took that count from **0 to 1**. It
  executes the statement.

So only the first form is emitted, **for both modes**, and either reason alone would be enough. The
background estimate fires on every `SELECT` a user runs, and a query engine's statements reach S3,
Iceberg and Hive — running one twice to draw a picture is a real bill, not a rounding error. And
`EXPLAIN ANALYZE` accepts no `FORMAT` option at all in 476 (`EXPLAIN ANALYZE (FORMAT JSON) …` is
`line 1:18: mismatched input 'FORMAT'`), so its output is the box-drawing **text** plan, which this
tree model could not read without a parser of its own.

The answer is one row of one column named `Query Plan`, whose cell is JSON text. The strategy ignores
the mode rather than declining it: the direct Explain action always asks for `analyze` and refuses
the run when a strategy returns null, so declining would switch the feature off instead of narrowing
it — the same reading the SQLite, Couchbase, ClickHouse and Druid strategies take.

---

## 6. Schema introspection

Two statements, run in parallel against the pinned catalog's `information_schema`: the table list and
the column list, both excluding `information_schema` itself, both ordered so the mapper never sorts.
`ordinal_position` orders the column read rather than appearing in it — it *is* the declared order.

A table's name is `schema.table`, always qualified
([§3.2](#32-the-connections-database-field-pins-one-catalog)). `indexes` and `foreignKeys` are `[]`
by construction ([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)).

`getSchemaList()` and `getSchemaRelations()` are **deliberately not implemented**. That split exists
so a slow relationship read cannot block the table list, and Trino has no relationship read at all: a
list would be byte-identical to `getSchema()` and a relations read would spend a round trip to answer
two empty arrays per table.

Measured against `tpch`: 72 tables, `column_default` projected and null for every connector probed
(kept because a connector with server-side defaults would report it there, and an absent value costs
nothing).

### The object surface (#789)

The flat list above is what `getSchema()` answers. Alongside it the provider implements the lazy,
container-aware object surface: `listContainers()`, `countObjects()`, `listObjects()` and
`describeObject(path, kind)`, in
[`objects.ts`](../../src/lib/db/providers/sql/trino/objects.ts) and
[`index.ts`](../../src/lib/db/providers/sql/trino/index.ts). Both surfaces are live through Phase 1
and they answer different questions: `getSchema()` is scoped to the one catalog the connection pins
([§3.2](#32-the-connections-database-field-pins-one-catalog)), while the object surface reaches
**every catalog the coordinator can see**, including the ones this connection did not name.

Everything below was measured against a live Trino 476 on 2026-09-11, running the `memory` and `tpch`
catalogs `database-compose.yml` configures plus an `iceberg` catalog on an Apache Hive 4.0.1
standalone metastore.

#### Two container levels, and a catalog is not a database

```ts
containerLevels: [
  { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
  { id: "schema",  label: "Schema",  labelPlural: "Schemas" },
]
```

Trino is the third two-level engine in #789, after SQL Server and DuckDB, and the outer level is the
one worth explaining: **a Trino catalog IS a named connector configuration**, not a database. Dropping
`iceberg.properties` into `/etc/trino/catalog` creates the catalog `iceberg`, and the same session
then addresses an Iceberg lake, a PostgreSQL server and a generated `tpch` dataset side by side. Two
consequences a reader has to carry:

* **`information_schema` is PER CATALOG.** `iceberg.information_schema.tables` says nothing about
  `memory`. Every statement below therefore names its catalog, and the catalog is quoted rather than
  bound: the client protocol sends no parameters ([§5.1](#51-execution)).
* **What a catalog can do is the connector's answer, not the engine's.** Two of the four kinds below
  exist only on some connectors, which is a fact about the deployment rather than about the model.

`system` and `jmx` are **listed like any other catalog** rather than filtered out. Trino publishes no
flag that separates a plumbing catalog from a data one, both are genuinely queryable, and a name
denylist is a boundary this repo has already found unmaintainable. `information_schema` IS excluded
from the schema list, which is the same exclusion `getSchema()` already makes: every catalog carries
one, and it holds only the tree's own plumbing. Measured with the exclusion removed, `memory` answers
`["app", "default", "information_schema"]`.

Both levels mark `isSessionDefault`, and both halves of the schema predicate are load-bearing: the
connection's schema names a schema in the connection's catalog, and several Trino connectors create a
schema called `default`, so comparing the schema name alone marks a row in every catalog on the
cluster.

#### Four kinds, and where each one's rows come from

| Kind | Role | Source | Note |
|---|---|---|---|
| `table` | relation | `<catalog>.information_schema.tables`, `table_type = 'BASE TABLE'` | `acceptsRowWrites: true` |
| `view` | relation | the same relation, `table_type = 'VIEW'` | No row writes: `INSERT INTO <view>` answers `Inserting into views is not supported` |
| `materialized_view` | relation | `system.metadata.materialized_views`, filtered to the catalog | Some connectors only. No row writes: `Inserting into materialized views is not supported` |
| `function` | routine | `SHOW FUNCTIONS FROM <catalog>.<schema>` | Per SCHEMA only, see below |

**No trigger, no stored procedure and no index**, because Trino has none of the three anywhere in its
model: `information_schema` holds eight views and neither `table_constraints` nor `key_column_usage`
is among them, and there is no index catalog at all
([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)). A declared kind draws a
folder, and a folder for something the engine cannot have is a lie its zero badge makes look like a
fact.

`describeObject` therefore answers `indexes: []` and `foreignKeys: []` for every kind, and every
column carries `isPrimary: false`. Those are the engine's answers and not defaults this provider
chose. `is_nullable` is the ANSI varchar `'YES'`/`'NO'` here rather than a boolean.

#### A materialized view is a BASE TABLE, so the table read has to subtract it

This is the one trap in the whole surface. Measured: with `iceberg.warehouse.order_totals` a
materialized view over `orders`, `iceberg.information_schema.tables` reports it as

| table_schema | table_name | table_type |
|---|---|---|
| `warehouse` | `order_totals` | `BASE TABLE` |
| `warehouse` | `orders` | `BASE TABLE` |

So a table count taken from `table_type` alone counts the materialized view twice over, once under
each kind, and the tree draws the same object in both folders. The relation reads carry a
`NOT EXISTS` anti-join against `system.metadata.materialized_views`, and the materialized views come
from that catalog rather than from `information_schema`, so neither source can lose a row the other
holds. Measured with the anti-join removed, the `iceberg` catalog answers three tables and one
materialized view for two objects, and `order_totals` appears in both listings.

The materialized-view read is filtered `WHERE catalog_name = <catalog>`, and that is **isolation
rather than an optimisation**. Two measurements, both against a live cluster:

* With the filter removed, the `memory` catalog lists `["memory", "warehouse", "order_totals"]` — a
  materialized view that lives in `iceberg`, handed a path in `memory` that resolves to nothing.
* An **unfiltered** read fails outright when any catalog on the cluster cannot list its own
  materialized views: with one deliberately broken Iceberg catalog present,
  `SELECT * FROM system.metadata.materialized_views` answers
  `Error listing materialized views for catalog brokenice: Failed to connect: …` while the filtered
  read still answers its row. Without the filter, one misconfigured catalog anywhere empties the
  Materialized Views folder of every catalog on the cluster.

Materialized views are supported by **some connectors only**, Iceberg among them, and neither the
Iceberg JDBC catalog nor the REST catalog will create one on 476 (`createMaterializedView is not
supported for Iceberg JDBC catalogs`). The kind is declared anyway: it exists in the engine's model
and `system.metadata.materialized_views` is an engine-level catalog, so a catalog holding none answers
an honest `{ count: 0 }`. "This engine has no such concept" and "this container holds none" are
different facts and #789's `KindCount` keeps them apart.

#### The `table_type` vocabulary is the ENGINE's, and an unmodelled spelling is made loud

`information_schema` is generated by the coordinator rather than by a connector, and it emits
`BASE TABLE` and `VIEW` and nothing else — measured across `tpch` (72 rows), `memory` and `iceberg`.
The count statement maps the two through a `CASE` whose **ELSE arm labels anything else
`unknown:<type>`**, which is a kind id no declaration holds, so the reader raises naming the spelling:

```
Trino counted objects under "unknown:LOCAL TEMPORARY", which this provider does not declare as an
object kind (#789)
```

The silent alternative, a `WHERE table_type IN (...)` that simply drops the row, would take the object
out of the count and out of the listing together, leaving the count and the listing in agreement while
the object is invisible in the tree. That is the shape of defect #789's standing rulings call the
worst this epic has, and it is why the guard exists rather than a comment.

**That raise reaches the caller as a raise.** `countObjects()` catches the READ and nothing else: a
statement the engine refused becomes `{ unavailable }` carrying the engine's own sentence for every
relation kind, because they all ride one `UNION ALL` and the statement failing genuinely loses all of
them, while an unmodelled `table_type` propagates. The two are different facts and the earlier code
spelled both as `{ unavailable }`, which had two costs: it filed a provider defect in a folder badge
as though the engine had refused a read it had answered, and it blanked the `materialized_view` count
as well, even though that count comes from `system.metadata.materialized_views` on the other arm of
the union and was never in doubt.

#### Functions are real here, and they are readable one schema at a time

Catalog-stored SQL functions exist from Trino 431, on the Hive and Memory connectors only. The kind is
declared because it was **confirmed on the build this repo runs**: measured on 476,

```sql
CREATE FUNCTION memory.app.plus_one(x bigint) RETURNS bigint RETURN x + 1;
SHOW FUNCTIONS FROM memory.app;
```

succeeds and lists it, and `database-compose.yml` configures the `memory` catalog. Leaving the kind
undeclared would make a function somebody wrote invisible in the tree, which is a worse absence than an
empty folder.

`SHOW FUNCTIONS FROM <catalog>.<schema>` is the **whole surface**, and it has three properties that
shape the implementation. It takes a schema and has no catalog form
(`SHOW FUNCTIONS FROM memory` answers `Catalog must be specified when session catalog is not set`); its
columns are named `Function`, `Return Type`, `Argument Types`, `Function Type`, `Deterministic` and
`Description`, with spaces, and no alias can rename them; and it cannot be wrapped in a subquery —
`SELECT * FROM (SHOW FUNCTIONS FROM memory.app)` is a syntax error. There is no relation to read
instead: `information_schema` has no routine catalog on this engine, and `system.jdbc.procedures`
answers zero rows for a schema holding three functions.

So a **catalog-level** function count is `{ unavailable }` carrying that reason, and a catalog-level
listing is refused with the same sentence, rather than fanning `SHOW FUNCTIONS` out over every schema
in the catalog — one full HTTP exchange each, unbounded on a Hive or Iceberg catalog. Open a schema to
see its functions. The two reads behind `countObjects` are caught **separately** for the same reason
they are two reads: `system.metadata` failing must not erase an honest function count, and a connector
without stored functions must not blank the table count.

A function's path segment carries its **argument types**, `plus_one(bigint)`, while its `name` stays
the bare `plus_one` a person reads. Measured: `plus_one(bigint)` and `plus_one(double)` coexist in one
schema, so a bare name gives two objects one address. The types and never the parameter names, which
is the rule #789 settled on PostgreSQL: overload resolution never depends on a name, so carrying one
would make an object's identity change when somebody renames an argument. On this engine the honest
form is also the only available one, because `SHOW FUNCTIONS` publishes no parameter names at all.

#### Hive-native views, and what Phase 1 does with them

A Hive-native view is **readable** through the Hive connector but not writable, and Trino guarantees no
round trip for one it did not create. Such a view appears in this listing exactly like any other, under
the `view` kind, because `information_schema.tables` reports it as `VIEW` and the surface reads what
the catalog reports. Phase 1 only ever lists and describes it, and neither `acceptsRowWrites` nor an
inline editor is offered on a view of any kind, so nothing here can attempt a write. A Phase 2 Source
tab is where the distinction starts to matter.

#### `describeObjects()` describes a whole folder in two statements (#789)

`describeObjects(container, kind, limit?)` answers the columns of EVERY object of one kind in one
container, in TWO round trips whatever the folder holds: the target read plus the column read. The
single read is one statement per object. Measured against a live Trino 476 over a 200-table schema of
the `memory` connector: **165 ms for one `describeObjects()` against 5,160 ms for 200
`describeObject()` calls**, the same 600 columns. On this engine the gap is the largest of the five in
this wave, because every statement is a full HTTP exchange with a coordinator that plans it.

The column read is `trinoObjectColumnsSql()` with the schema-and-name equality replaced by a join
against the target, and nothing else changed.

The five decisions this engine had to make for itself, each measured rather than reasoned:

**Which catalog.** The same two the folder already reads. The TARGET is the listing statement itself,
from whichever of the two catalogs publishes that kind: `information_schema.tables` for a table and a
view, `system.metadata.materialized_views` for a materialized view. The COLUMNS always come from
`information_schema.columns`, including for a materialized view, which answers there while being
reported as a `BASE TABLE` (measured on 476) - which is also why the relation target keeps its
anti-join. It is not `getSchema()`'s reading: that one spans the pinned catalog with no anti-join at
all, so it counts a materialized view as a table. MEMBERSHIP comes from the target read and never from
the column read, so an object the column read answered nothing for comes back with an empty column list
rather than missing, and this read does not repeat the single read's zero-column throw - there an empty
answer means the object is not there under that name, here the listing has just said it is.

**Which kinds have no columns.** `function` alone, the one non-relation kind, which answers
`{ details: [] }` with NO round trip - and it answers so at EITHER container depth. That is worth
stating, because `listObjects` REFUSES a catalog-level function read: `SHOW FUNCTIONS` is per schema and
the fan-out would be one HTTP exchange per schema, unbounded on a Hive or Iceberg catalog. There is no
fan-out here because a routine has no columns to read in the first place, so the bulk read answers the
same empty batch at both depths rather than inheriting a refusal it has no reason for.

**What bounds the read on the wire.** `LIMIT n` appended to the target, carrying `limit + 1` so a
saturated read is told from an exact one with no second count. The value is INTERPOLATED rather than
bound, because this transport sends a statement as text and has no parameter channel at all; it is safe
by construction, since the caller's value is refused unless it is a positive whole number. That guard
therefore protects the STATEMENT as well as the answer. The extra object is dropped in code and
`truncated` carries the CALLER's limit.

**What orders the cut, and under whose collation.** `ORDER BY "schemaName", "objectName"`, added by the
target and carried by neither listing: the listings deliberately have no `ORDER BY`, because four kinds
are read from three sources that cannot share one sort clause, and the ordering is done over the
produced PATH instead. A BOUND needs one all the same, or two calls could keep different subsets.
`schemaName` leads because a CATALOG-level container spans every schema under it. That sort runs under
the cluster's own varchar comparison, which is the UTF-8 BYTE order: measured on 476,
`U&'\+00E000' < U&'\+01F600'` is true, bytes `ee 80 80` below `f0 9f 98 80`, where a JavaScript sort
puts the surrogate `0xD83D` first. So the MEMBERSHIP of a bounded cut is the cluster's and the ORDER of
the answer is ours.

**Mixed path depth (ruling 5f).** Not in this engine's relation set. `objectRead()` refuses a kind
declaring `attachedTo`, there is no trigger anywhere in Trino's model, and every object of every
declared kind is addressed `[catalog, schema, name]` at either container depth.

The join is on BOTH the schema and the name, never on the name alone: a catalog-level container spans
every schema under it, and two schemas holding a table of one name is the ordinary case. A JOIN and not
a `(schema, name) IN (...)` tuple test, and both were measured accepted on 476; the join is the one
whose output order is the coordinator's rather than a semi-join's. The grouping key joins the two
segments with a NUL, which no Trino identifier can carry, so a schema called `a.b` holding `c` cannot
collide with a schema called `a` holding `b.c`.

#### Container shapes and the derivations behind them

Both depths are accepted by all four methods: a catalog alone answers "how many tables does this whole
catalog hold", and a schema answers the folder the tree actually draws. That matches SQL Server and
DuckDB, and `src/lib/api/object-route.ts` admits any path down to the declared depth.

Nothing reads a path by position. The container segments come from the declared `ContainerLevelSpec`
ids, the object name is `path[path.length - 1]`, and the depth is `containerDepth()` — never
`containerLevels.length` and never a hardcoded comparison. `trino-provider.test.ts` pins that by
handing the provider a declaration listing `schema` BEFORE `catalog` and driving it to a bound value:
with that declaration, `["beta", "alpha", "pin"]` addresses schema `beta` in catalog `alpha`, and a
provider binding `path[0]` as the catalog reads a different real relation rather than failing.

#### The fixture, and the half of it this repo cannot ship

Standing ruling 5i (#789): a live measurement you cannot re-run is not evidence. The object-surface
fixture is therefore `docker/trino-init/01-object-fixture.sql`, mounted into both the `trino` service
and a one-shot `trino-init` sidecar in `database-compose.yml`, so

```bash
docker compose -f database-compose.yml up -d trino trino-init
```

brings the cluster up and seeds it. The image ships no init-script convention of its own, so the sidecar is what applies the file,
running the CLI that ships in the same image against the coordinator. The mount is at `/fixtures` and
not at the `/docker-entrypoint-initdb.d` most services in that file use, because that name would
promise a start-up hook this image does not have.

**Re-apply it after every restart of the coordinator.** The `memory` connector keeps its schemas,
tables, views and functions in the coordinator's heap, so a restart loses all of them and the one-shot
sidecar does not run again by itself. The file is written to be re-runnable, every statement
`IF NOT EXISTS` or `OR REPLACE`:

```bash
docker exec libredb-trino trino --server localhost:8080 \
  --file /fixtures/01-object-fixture.sql
```

What that fixture holds, and what the provider then answers against the compose cluster, measured
through the provider itself on trinodb/trino:476:

| Container | table | view | materialized_view | function |
|---|---|---|---|---|
| `memory` | 2 | 1 | 0 | unavailable |
| `memory.app` | 2 | 1 | 0 | 3 |
| `tpch.tiny` | 8 | 0 | 0 | 0 |

`memory.app` holds `orders` and `customers`, the view `customer_names`, and the three functions
`plus_one(bigint)`, `plus_one(double)` and `label(bigint, varchar)`. The overloaded pair is the
fixture that makes the argument-type path segment observable rather than theoretical, and the server
returns `orders` before `customers`, which is what makes the provider's own sort observable rather
than incidental.

##### `materialized_view` is 0 on this cluster, and that is the true answer

**The compose cluster configures no Iceberg catalog**, so it can hold no materialized view at all: the
kind is an engine-level concept but only some connectors implement it, and on 476 only a
Hive-metastore-backed Iceberg catalog will CREATE one. The Iceberg JDBC and REST catalog types both
answer `createMaterializedView is not supported for Iceberg JDBC catalogs`, so "configure Iceberg and
you get materialized views" is wrong.

An Iceberg catalog here would mean a metastore service, a warehouse volume and a second image in
`database-compose.yml` for one object kind, which is a bigger change than the object surface owns. A
live probe against this cluster will therefore see `materialized_view: 0` in every container. **That
is the engine answering honestly, not a broken fixture**: the kind stays declared because the engine
has the concept and `system.metadata.materialized_views` is an engine-level catalog, and #789's
`KindCount` keeps "this engine has no such concept" and "this container holds none" apart.

##### Reproducing the Iceberg measurements

The materialized-view findings above were measured on a cluster built this way. It is written out in
full so the numbers stay checkable without the compose file carrying a metastore.

```bash
docker network create trino-iceberg
docker run -d --name trino-hms --network trino-iceberg \
  -e SERVICE_NAME=metastore apache/hive:4.0.1
mkdir -p /tmp/trino-iceberg/catalog
cat > /tmp/trino-iceberg/catalog/iceberg.properties <<'PROPS'
connector.name=iceberg
iceberg.catalog.type=hive_metastore
hive.metastore.uri=thrift://trino-hms:9083
iceberg.file-format=PARQUET
fs.hadoop.enabled=true
PROPS
docker run -d --name trino-iceberg-probe --network trino-iceberg -p 18099:8080 \
  -v /tmp/trino-iceberg/catalog/iceberg.properties:/etc/trino/catalog/iceberg.properties:ro \
  trinodb/trino:476
```

Then, once the coordinator is healthy:

```sql
CREATE SCHEMA iceberg.warehouse WITH (location = 'file:///tmp/warehouse');
CREATE TABLE iceberg.warehouse.orders (id bigint, total double);
INSERT INTO iceberg.warehouse.orders VALUES (1, 10.0), (2, 20.0);
CREATE MATERIALIZED VIEW iceberg.warehouse.order_totals AS
  SELECT id, total FROM iceberg.warehouse.orders;
```

Those statements produce the `iceberg` column of the original measurement:

| Container | table | view | materialized_view | function |
|---|---|---|---|---|
| `iceberg` | 2 | 0 | 1 | unavailable |
| `iceberg.warehouse` | 1 | 0 | 1 | 0 |

`iceberg`'s two tables are `warehouse.orders` and `system.iceberg_tables`, the latter published by the
connector itself, which is why the schema list carries no denylist beyond `information_schema`. The
materialized view is reported as `table_type = 'BASE TABLE'` by `information_schema.tables`, which is
the measurement the anti-join above exists for: it is why `iceberg` answers two tables and not three.

For the catalog-isolation finding, add a second catalog file pointing at a metastore that is not
there, `hive.metastore.uri=thrift://nosuchhost:9083`, and read
`SELECT * FROM system.metadata.materialized_views` unfiltered.

---

## 7. Monitoring & health

Everything comes from `system.runtime`, `system.metadata` and — for the two readings only it has —
`jmx`.

| Surface | Source | What it answers |
|---|---|---|
| `getOverview()` | `system.runtime.nodes`, `jmx.current."java.lang:type=runtime"`, `information_schema.tables`, `system.runtime.queries` | version `476`, uptime, start time, `activeConnections` = statements in flight, `tableCount` |
| `getPerformanceMetrics()` | `jmx.current."trino.execution:name=querymanager"` | `queriesPerSecond` only ([§3.10](#310-absent-never-zeroed)) |
| `getActiveSessions()` | `system.runtime.queries`, non-terminal states | The statements in flight |
| `getSlowQueries()` | `system.runtime.queries`, `FINISHED` rows by elapsed time | The coordinator's recent history |
| `getTableStats()` | `SHOW STATS FOR <table>`, one per table, for a scope of at most 25 tables | Real row counts and logical sizes, or a refusal — never a sample |
| `getStorageStats()` | `system.metadata.catalogs` | One row per catalog, `location` = the connector |
| `getIndexStats()` | — | `[]`, no statement sent — a MEASUREMENT, not a refusal: no index object exists in any Trino catalog, so zero is the true count |
| `getHealth()` | The three above | — |

Measured on the probe cluster: `tpch.tiny.lineitem` 60175 rows / 1.51 MB, `tpch.tiny.nation` 25 rows
/ 1.99 KB; storage rows for `jmx`, `memory`, `system`, `tpcds`, `tpch`.

**Uptime needs the `jmx` catalog.** Nothing in `system.runtime` records a start time, and the
coordinator's `/v1/info` — which does report one — is not a statement and so is unreachable through
the seam. A cluster without `jmx` configured gets `uptime: "unknown"` rather than a failure:
`CATALOG_NOT_FOUND` is a `USER_ERROR` the engine reports exactly as it reports a typo, so
`unknown-object` and `auth` are the two categories treated as *"this surface is not available here"*.
Every other failure propagates — a timeout hidden behind an empty panel is hidden forever.

Five honest blanks, each with its reason:

- **`ActiveSessionDetails.database` is `""`.** `system.runtime.queries` has no catalog column.
  Filling it with our pinned catalog would credit another client's statement with a catalog it may
  never have touched.
- **`SlowQueryStats.calls` is `1` and `rows` is `0`.** The table records **executions**, not
  statements, so there is nothing to aggregate and `totalTime === avgTime`. It has no row-count
  column at all, and `rows` is a required number with no way to say "unknown". The history is a
  bounded in-memory window a restart empties — a recent window, not a query log.
- **`getTableStats()` omits a table whose connector published no row count.** Measured,
  `SHOW STATS FOR system.runtime.nodes` returns the six columns with every value null, summary row
  included. `TableStats.rowCount` cannot say "unknown", and "0 rows" is a claim nobody made.
- **An empty table panel has four causes, and only one of them is an empty panel.** Since
  **2026-08-25** the ones that are refusals leave the panel ABSENT with a sentence under
  `MonitoringData.errors`, which is what `PanelUnavailable` renders, instead of an empty table that
  claims the engine answered "no tables":
  - the catalog's table list was **refused** (`unknown-object` or `auth`) — the panel carries the
    server's own wording;
  - the scope holds **more tables than one pass describes** — the panel names how many it holds and
    what, if anything, is narrow enough to ask for instead
    ([§7.1](#71-a-scope-too-large-for-one-pass-is-refused-not-sampled));
  - tables were examined and **none** published a row count — the panel names how many were asked,
    and that number is now a count rather than a bound, because an oversized scope is refused before
    any `SHOW STATS` is sent. Measured 2026-08-25 against Trino 476, the `jmx` catalog holds **379**
    tables in schema `current` and a 20-table random sample of them answered `SHOW STATS` with an
    empty `row_count`, 0 of 20 non-null — the jmx connector supplies no statistics at all. Since
    2026-08-27 that catalog is refused on **size** first, one cause earlier; the *"none published"*
    sentence is what a scope of 25 tables or fewer gets, as `tpch.sf10000` does;
  - the catalog genuinely holds **no table** — `[]`, which is a real measurement and keeps rendering
    as an empty panel. Live-verified 2026-08-27: the `memory` catalog of a fresh cluster holds 0 user
    tables and answers `[]` with no refusal.
- **`StorageStats.size` is `"N/A"` with `sizeBytes: 0`, and `usagePercent` is absent**
  ([§3.9](#39-the-bytes-are-somewhere-else-so-the-size-panels-say-so)). The rows are the catalogs,
  which is where the data really is; there is no capacity for a percentage to be a fraction of.

The active-query read **sees itself**, as a `RUNNING` row. That is not a defect to filter: the
coordinator really is running it, and the only id that could exclude it is one the statement does not
know while it is being planned.

### 7.1 A scope too large for one pass is refused, not sampled

`SHOW STATS` is **one statement per table** — the reference gives exactly two forms,
`SHOW STATS FOR <table>` and `SHOW STATS FOR ( <query> )`, with no batch form and no catalog of sizes
to aggregate — so N tables cost N statements and the pass is bounded at **25**.

Until **2026-08-27** that bound *truncated*: the pass described the first 25 tables of the scope and
returned those rows as the reading. No consumer could see it. `getTableStats()` answers
`TableStats[]`, `MonitoringData.tables` is that same array, and the agent's curated reading publishes
its length as `rowCount` — none of the three has a field a *"there were more"* marker could travel in,
so 25 rows out of 500 were indistinguishable from a catalog holding exactly 25. **A cap read as a
count is the absence lie one size up**, so the reading now **refuses** the oversized scope, which is
the answer the agent's own row bound already gives (`READING_OVER_BUDGET`) and for the same reason.

Live-verified **2026-08-27** against Trino 476 through this provider's own transport — and this is
the ordinary case, not the exotic one:

| Scope | User tables | Before | Now |
|---|---|---|---|
| `tpch` | 72 | 8 rows, presented as the catalog | refused, naming 72 |
| `tpch.tiny` | 8 | 8 rows when named, but **never reached by the catalog-wide pass** — `tiny` sorts last, behind 64 tables the 25 statements never got to | **8 rows** (`lineitem` 60,175, `nation` 25) |
| `tpch.sf1` | 8 | 8 rows | 8 rows (`lineitem` 6,001,215) |
| `system` | 26 | 25 examined | refused, naming 26 |
| `tpcds` | 250 | 25 examined | refused, naming 250 |
| `jmx.current` | 379 | 25 examined | refused, naming 379 |
| `memory` | 0 | `[]` | `[]` — a measurement, not a refusal |

The refusal is also **cheaper** than the cut it replaces: the table list has already answered the
whole question, so no `SHOW STATS` is sent at all. The bound applies to what was **asked for** and not
to what the catalog holds, so a schema *inside* the bound is describable in a catalog of any size —
which is how `tpch.tiny` became readable at all.

Its advice differs by scope, because advice a caller cannot act on is worse than none — and a schema
is refused by the same bound that refuses a catalog, which the table above measures: `jmx.current`
holds **379** tables, so "ask for a single schema" would have been a remedy that fails. The sentence
is therefore **conditional on a figure the reading already has**. The table list is one uncapped read
that has already answered for the whole catalog, so the per-schema counts are known before any
`SHOW STATS` is sent, and the refusal says how many schemas a narrowed pass really would describe:

- **Unnarrowed, with schemas inside the bound** — how many there are, and that a larger one is
  refused the same way. Narrowing is `MonitoringOptions.schemaFilter`, which `POST /api/db/monitoring`
  accepts, and the agent's curated reading takes a `schema` of its own. On the real `tpch` this reads
  *"9 of the schemas this catalog's tables are in"*: the connector publishes nine schemas — `tiny`,
  `sf1`, `sf100`, `sf300`, `sf1000`, `sf3000`, `sf10000`, `sf30000`, `sf100000` — of the same eight
  tables, which is where the 72 comes from and why every one of them is describable alone.
- **Unnarrowed, with none inside it** — that narrowing does not help here, plainly, with no scope
  offered that would be refused too. `jmx` is the shape that reaches this arm: its 379 tables are in
  `current`, and the `history` schema the connector also publishes carries a table only for an MBean
  named in `jmx.dump-tables`, so on a cluster that names none there is nothing narrower to send
  anyone to.
- **Already narrowed to a schema** — there is no narrower selection to offer, so the sentence gives
  the statement that answers for a single table: `SHOW STATS FOR "<catalog>"."<schema>"."<table>"`.

A schema holding **no** table is not counted among the describable ones — it is not in the table list
at all — which is why the sentence says "the schemas this catalog's tables are in" rather than
counting the catalog's schemas: an empty schema is not somewhere the advice could send anyone. Every
one of the three sentences ends in the per-table statement, because that is the one route no bound
applies to.

The monitoring dashboard sets no `schemaFilter` today, so on a catalog over the bound its Tables
panel is absent with this sentence. That is the intended trade: what it showed before was 8 rows for
a 72-table catalog, none of them the tables the fixtures use. The true table count is still on the
Overview panel, which reads it with `count(*)` in one statement, and the tables themselves are still
in the schema tree.

---

## 8. Maintenance

`supportsMaintenance: true`, `maintenanceOperations: ["kill"]`.

`kill` takes the query id the Sessions panel shows and runs
`CALL system.runtime.kill_query(query_id => '…', message => 'Terminated from LibreDB Studio')`.
Live-verified end to end on 476: the target's own exchange then fails with `ADMINISTRATIVELY_KILLED`
and carries the message. The result says *"Asked Trino to terminate …"* and not "terminated", because
the procedure returns as soon as the coordinator accepts the request.

An id that no longer exists answers `NOT_FOUND`, and that is deliberately **not** swallowed here —
unlike in `cancelQuery()`. A user who typed a query id into a maintenance panel has asked a direct
question, and *"that statement is not running"* is the answer.

Everything else in `MaintenanceType` is refused with the reason rather than mapped onto the
nearest-looking statement:

> *Trino has no "vacuum" operation. It owns no storage to reclaim and computes no statistics of its
> own — both belong to the connector behind each catalog — so the only maintenance it can perform is
> terminating a running statement.*

**`ANALYZE` is the interesting refusal.** It is in the grammar, so offering it looks defensible — but
every connector decides for itself whether it implements it, and measured, the `memory` connector
answers `This connector does not support analyze` and no connector on the probe cluster implements
it. A button that always fails is worse than a stated reason.

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#496).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available. On Trino it never speaks: `kill`
declares neither placement, which is not "takes no target" but "the target comes from somewhere
this field says nothing about", so the request passes through to the query id the Sessions
panel supplied.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `kill` | Terminate Query | no | no | the target is the query id the Sessions panel lists; neither a table nor a whole database can supply one |

So no maintenance control is offered anywhere on Trino - which is the same answer the
labels give in prose: *"Trino Owns No Storage"* and *"Statistics Belong to the Connector"*
name nothing this engine can run, and both stay unshown because the operations behind them
are undeclared.

---

## 9. Capabilities & labels

### `getCapabilities()` ([`trino/index.ts`](../../src/lib/db/providers/sql/trino/index.ts))

| Flag | Value | Why |
|---|---|---|
| `queryLanguage` | `"sql"` | |
| `supportsExplain` | `true` | ([§5.6](#56-explain-is-the-planning-form-only)) |
| `explainFormat` | `"trino-json"` | The planning form only; `EXPLAIN ANALYZE` executes the statement and is never emitted ([§5.6](#56-explain-is-the-planning-form-only)) |
| `supportsExternalQueryLimiting` | `true` | `LIMIT` is injected by the shared limiter, transposed ([§3.5](#35-offset-comes-before-limit)) |
| `supportsCreateTable` | `true` | In the grammar, live-verified on `memory` ([§5.5](#55-writes-belong-to-the-connector-not-to-the-engine)) |
| `supportsInlineRowEdit` | `false` | No primary key exists to build a one-row `WHERE` ([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)) |
| `supportsTransactions` | `false` | Trino has `START TRANSACTION`, but a transaction lives in an HTTP session header this provider does not carry between statements, so the trio and SANDBOX are not offered (#464) |
| `declaresForeignKeys` | `false` | Not in the model at all ([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)) |
| `supportsMaintenance` | `true` | |
| `maintenanceOperations` | `["kill"]` | The only operation the engine itself can promise ([§8](#8-maintenance)) |
| `supportsConnectionString` | `false` | The shared parser does not accept `jdbc:trino://` ([§4.2](#42-there-is-no-connection-string--yet)) |
| `defaultPort` | `8080` | Same under TLS ([§4.3](#43-tls-and-the-password-rule)) |
| `identifierQuoting` | `"double"` | Declared, not derived from a generic port ([§3.13](#313-a-trailing-semicolon-is-a-syntax-error)) |
| `statementTerminator` | `"none"` | `SELECT 1;` is a syntax error ([§3.13](#313-a-trailing-semicolon-is-a-syntax-error)) |

### `getLabels()` ([`trino/index.ts`](../../src/lib/db/providers/sql/trino/index.ts))

Table and row are already Trino's own words, so the provider spreads `...super.getLabels()` and
rewrites only the two maintenance blurbs. They must still be strings even though neither operation is
offered, and leaving the inherited copy would promise a user that the panel updates planner
statistics and reclaims space — neither of which Trino can do, because it owns neither the statistics
nor the storage.

| Label | Value |
|---|---|
| `analyzeGlobalTitle` | *Statistics Belong to the Connector* |
| `analyzeGlobalDesc` | *Trino reads the statistics its connectors publish and computes none of its own. Whether a catalog supports ANALYZE is that connector's answer, so nothing runs from here.* |
| `vacuumGlobalTitle` | *Trino Owns No Storage* |
| `vacuumGlobalDesc` | *Trino is a query engine: the bytes live in the systems its connectors reach, and reclaiming them is done there. Nothing runs from here.* |
| `slowQueriesEmptyState` | *Query stats come from system.runtime.queries, which holds only what this coordinator still remembers.* |

The last one is about the monitoring tab rather than maintenance: the Queries panel's empty state was
hardcoded to PostgreSQL's `pg_stat_statements` advice on every engine (#463), and
what Trino has instead is the coordinator's own bounded history ([§7](#7-monitoring--health)).

---

## 10. Error handling

The seam reports a **category**; the provider maps the category, never a status code
([§3.3](#33-a-failed-statement-arrives-as-http-200)).

| `TrinoErrorCategory` | Thrown | Typical engine fault |
|---|---|---|
| `auth` | `AuthenticationError` | The plain-text 401s of [§3.6](#36-a-password-is-a-tls-only-credential); `PERMISSION_DENIED` |
| `unreachable` | `ConnectionError` | Nothing answered, or what answered is not the client protocol |
| `timeout` | `TimeoutError` | The exchange outlived its deadline |
| `cancelled` | `QueryCancelledError` | `USER_CANCELED` |
| `syntax` | `QueryError` | `SYNTAX_ERROR` |
| `unknown-object` | `QueryError` | `TABLE_NOT_FOUND`, `CATALOG_NOT_FOUND`, `COLUMN_NOT_FOUND` |
| `unsupported` | `QueryError` | `NOT_SUPPORTED` — including a connector's own refusal |
| `resources` | `QueryError` | Memory, time, splits, stages |
| `engine` | `QueryError` | Everything reached, understood, and refused for another reason |

`TrinoTransportError.code` carries the engine's stable fault name (`SYNTAX_ERROR`, `TABLE_NOT_FOUND`,
`NOT_SUPPORTED`, `USER_CANCELED`) when one was sent. It is **diagnostic**: the category is what
callers branch on, so a fault name a later release adds arrives as text without needing the mapping
to change. The integer code the engine sends beside the name is deliberately dropped — it is the less
stable of the two, and no call site should be tempted to compare integers.

`ADMINISTRATIVELY_KILLED` — what `kill_query` leaves on its target's own exchange — is categorised
`cancelled`, not `engine`. A statement somebody else stopped is a cancellation from the running
client's point of view, so it surfaces as `QueryCancelledError` rather than as a failure the user
should go and debug.

Anything that is not a `TrinoTransportError` goes to the shared message-based mapping, exactly as
`clickhouse/index.ts` does: a bug in the provider's own mapping is not a database error and must not
be dressed as one.

---

## 11. Testing

### 11.1 How the tests work

| File | Owns |
|---|---|
| [`tests/integration/db/trino-provider.test.ts`](../../tests/integration/db/trino-provider.test.ts) | The provider end to end. `globalThis.fetch` is replaced per test, so the real provider, the real introspection **and the real HTTP transport** all execute; only the cluster is fake |
| [`tests/unit/db/trino/http-transport.test.ts`](../../tests/unit/db/trino/http-transport.test.ts) | The page loop, header generation, retries, cancellation, the failure document |
| [`tests/unit/db/trino/introspect.test.ts`](../../tests/unit/db/trino/introspect.test.ts) | Every catalog and monitoring read, against a hand-built runner |
| [`tests/unit/db/trino/transport.test.ts`](../../tests/unit/db/trino/transport.test.ts) | The seam's own types, dialect table and error class |
| [`tests/unit/db/trino/seam-guard.test.ts`](../../tests/unit/db/trino/seam-guard.test.ts) | That no protocol vocabulary leaks outside `http-transport.ts` |
| [`tests/unit/lib/explain/trino-json.test.ts`](../../tests/unit/lib/explain/trino-json.test.ts) | The `trino-json` explain strategy: the emitted prefix, the `Query Plan` cell, the tree it builds |
| [`e2e/trino-provider.spec.ts`](../../e2e/trino-provider.spec.ts) | The browser path — the connection form, the tree and the editor against the compose fixture |

**No `mock.module()` anywhere in this suite.** It is process-wide in bun and would poison sibling
files sharing the process, which is exactly the nondeterministic-CI failure mode `docs/TOOLCHAIN.md`
describes.

Every payload was **captured on 2026-08-20 from a live Trino 476** with the catalogs named in the
header table. One trimming is declared in the file's own docstring: a live exchange takes six to eight
pages, of which the first four are empty `QUEUED` shells, and the harness replays **two** — a verbatim
`QUEUED` page and the page that carries the answer — because the page loop itself is exhaustively
covered in the unit file and those are the only two shapes that differ.

### 11.2 Coverage

The integration file's `describe` blocks, in order: metadata · validation · lifecycle · query ·
cancellation · error mapping · query preparation · schema · monitoring · maintenance. Between them
they pin the five measured behaviours the docstring lists — the 200-with-a-failure (asserted against
the real 3.3 KB / 19-frame `failureInfo`, so "no Java stack is surfaced" is proved against the thing
it must not surface), `FINISHED` arriving with a `nextUri` still attached, the trailing semicolon the
transport drops before the engine can reject it, the `OFFSET`-before-`LIMIT` transposition, and the 204 that a cancellation of a
never-existent id still returns.

### 11.3 Run it

```bash
# Just this provider
bun test tests/unit/db/trino tests/unit/lib/explain/trino-json.test.ts tests/integration/db/trino-provider.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: reproducing the live pass

```bash
docker compose -f database-compose.yml up -d trino
```

One container is the whole cluster — the coordinator runs the worker in-process — and the image ships
the `tpch` catalog configured, so there is **no seed step**: `tpch.tiny.nation` (25 rows) and
`tpch.tiny.lineitem` (60175 rows) are queryable the moment the healthcheck passes, generated on read
rather than stored. `tpcds`, `memory`, `system` and `jmx` are configured too; leave `jmx` in place,
because it is what makes the overview's uptime readable.

Then point a Studio connection at `localhost:8080` with **no user, no password**, and `tpch` in the
Database field.

The healthcheck is the image's own `/usr/lib/trino/bin/health-check` rather than a `curl` at
`/v1/info`, and the compose comment says why. Measured on a cold start: the statement endpoint
answers at ~3.0 s, `/v1/info` starts answering `200` at ~5.9 s while still reporting
`"starting": true`, and only at ~8.8 s does it report `false`. A plain `curl -sf …/v1/info` would call
the service healthy three seconds before it can plan a query.

Anything in this document can be re-measured directly:

```bash
curl -s -H 'X-Trino-User: libredb' --data-binary 'SELECT version()' http://localhost:8080/v1/statement
```

Remember to follow `nextUri`: the first page carries no rows.

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from "@/lib/db/factory";

const provider = await createDatabaseProvider({
  id: "trino-analytics",
  name: "Trino (analytics)",
  type: "trino",
  host: "trino.internal",
  port: 8080,
  database: "hive", // the CATALOG
  username: "analyst",
  // password: only over TLS - see 4.3
});

await provider.connect();

const result = await provider.query("SELECT nationkey, name FROM tpch.tiny.nation ORDER BY 1");
console.log(result.fields, result.rows.length, result.executionTime);

const tables = await provider.getSchema(); // named "schema.table"
await provider.disconnect();
```

### 12.2 Over the API

```bash
curl -X POST http://localhost:3000/api/db/query \
  -H 'Content-Type: application/json' \
  -H 'Cookie: auth-token=<jwt>' \
  -d '{"connectionId":"trino-analytics","query":"SELECT * FROM tpch.tiny.region"}'
```

See [`docs/API_DOCS.md`](../API_DOCS.md) for the full request/response contract.

---

## 13. Known limitations & future work

- **PrestoDB is a separate type-id and is not covered here.** The transport is already prefix-driven,
  so adding it is a descriptor plus a doc plus an integration test — not a rewrite
  ([§3.1](#31-the-header-prefix-is-data-so-prestodb-is-a-descriptor)).
- **No `EXPLAIN ANALYZE`.** Never a rendering gap: that form *executes* the statement, and a plan
  view must not run the user's query ([§5.6](#56-explain-is-the-planning-form-only)).
- **No connection string.** Needs `connection-string-parser.ts` to learn `jdbc:trino://`
  ([§4.2](#42-there-is-no-connection-string--yet)).
- **No positional parameters.** Needs `PREPARE`/`EXECUTE` and the prepared-statement header
  ([§5.1](#51-execution)).
- **No transactions**, and none are planned: they belong to the connectors.
- **No indexes, no foreign keys, no primary keys — permanently.** Not a gap in the provider
  ([§3.8](#38-no-keys-no-indexes--and-why-that-is-a-fact-about-the-engine)).
- **No database size, and no per-catalog size**
  ([§3.9](#39-the-bytes-are-somewhere-else-so-the-size-panels-say-so)).
  `DatabaseOverview.databaseSizeBytes` is absent rather than `0`, because the field is optional and
  the absence is the honest answer. `StorageStats.sizeBytes` is still `0` beside `size: "N/A"` — it
  is a required number, so the row cannot decline; if a panel ever renders that as "0 B", the
  alternative is returning no rows at all, which would hide the catalog list too.
- **No uptime without the `jmx` catalog** ([§7](#7-monitoring--health)).
- **`getTableStats()` describes a scope of at most 25 tables**, and refuses a larger one rather than
  sampling it ([§7.1](#71-a-scope-too-large-for-one-pass-is-refused-not-sampled)). Ask for one schema
  that is itself inside the bound — a larger schema is refused too, and the refusal says how many of
  the catalog's schemas qualify. `SHOW STATS FOR <table>` in the editor answers for any scope.
- **Agent auto/operate mode is out of scope.** `queryReadOnly()` is not implemented, so
  `acquireExecutionProfileProvider` fails closed for this type-id — explicitly deferred by #424.
- **The spooled result protocol is refused, not read.** This client never advertises an encoding, and
  a server that sends segments anyway gets an honest refusal rather than rows silently read out of a
  segment index.

---

## 14. References

- Source: [`src/lib/db/providers/sql/trino/`](../../src/lib/db/providers/sql/trino/)
- Explain strategy: [`src/lib/explain/trino-json.ts`](../../src/lib/explain/trino-json.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/trino-provider.test.ts`](../../tests/integration/db/trino-provider.test.ts) · [`tests/unit/db/trino/`](../../tests/unit/db/trino/) · [`tests/unit/lib/explain/trino-json.test.ts`](../../tests/unit/lib/explain/trino-json.test.ts) · [`e2e/trino-provider.spec.ts`](../../e2e/trino-provider.spec.ts)
- Container fixture: [`database-compose.yml`](../../database-compose.yml) (service `trino`)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Tracking issue: [#424 — Wire-compatibility and new engines](https://github.com/libredb/libredb-studio/issues/424)
- Trino client protocol: <https://trino.io/docs/current/develop/client-protocol.html>
- `SHOW STATS`: <https://trino.io/docs/current/sql/show-stats.html>
- `EXPLAIN`: <https://trino.io/docs/current/sql/explain.html> · `EXPLAIN ANALYZE`: <https://trino.io/docs/current/sql/explain-analyze.html>
- The `system` connector, `system.runtime` and `kill_query`: <https://trino.io/docs/current/connector/system.html>
- The `jmx` connector: <https://trino.io/docs/current/connector/jmx.html>
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [MongoDB](./mongodb.md) · [Couchbase](./couchbase.md) · [ClickHouse](./clickhouse.md) · [Apache Druid](./druid.md) · [Elasticsearch](./elasticsearch.md) · [OpenSearch](./opensearch.md) · [Redis](./redis.md) · [LibreDB](./libredb.md)
