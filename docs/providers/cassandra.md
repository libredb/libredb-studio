# Apache Cassandra Provider

> Apache Cassandra support for LibreDB Studio, built on the native CQL protocol (port `9042`) through
> `cassandra-driver` — a **pure-JavaScript** client with no native module and no postinstall step.
> This document is the single reference point for the Cassandra provider: design, architecture, usage
> and tests. If you are reading the code, extending Cassandra support, or considering ScyllaDB, start
> here.
>
> Almost every decision below is a decision to offer **less**. Cassandra publishes a great deal that
> looks like a row count, a table size or a query plan and is none of those things, and issue
> [#424](https://github.com/libredb/libredb-studio/issues/424) exists because a wrong number on
> screen is worse than a missing one. Each refusal names the measurement behind it.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `cassandra` |
| **Family** | SQL (`src/lib/db/providers/sql/cassandra/`) |
| **Driver** | [`cassandra-driver`](https://www.npmjs.com/package/cassandra-driver) 4.9.0 — Apache-2.0, pure JS (no `binding.gyp`, no `.node`, no postinstall) ([§3.1](#31-a-driver-that-costs-no-distribution-channel-anything)) |
| **Query language** | `sql` — CQL is SQL-*shaped*: no JOIN, no subquery, no OFFSET, no EXPLAIN ([§5.4](#54-dialect-traps-a-user-will-hit)) |
| **Default port** | `9042` — the native protocol. Thrift (9160) is gone from 4.0 onwards; 7000/7001 are internode and 7199 is JMX |
| **Connection pooling** | The driver's own, one session per connection: core 1 connection per local host, 2048 requests in flight per connection |
| **Connection string** | Not supported — no URI convention carries `localDataCenter`, which the driver requires ([§4.2](#42-there-is-no-connection-string-and-why-that-is-not-fixable-by-inventing-one)) |
| **EXPLAIN** | **None.** `EXPLAIN` is not in the grammar at all ([§5.6](#56-there-is-no-explain-and-tracing-is-not-a-plan)) |
| **Writes** | `INSERT` / `UPDATE` / `DELETE` (all upserts, all primary-key-restricted), `TRUNCATE`, `BATCH` |
| **Transactions** | None. Lightweight transactions (`IF NOT EXISTS`, `IF <condition>`) are per-partition compare-and-set, not sessions |
| **Maintenance** | **None** — every operation is a `nodetool`/JMX action on a node ([§8](#8-maintenance)) |
| **Query cancellation** | **None** — the protocol has no cancel frame and `cancelQuery` is deliberately not implemented ([§3.7](#37-there-is-no-cancellation-so-none-is-offered)) |
| **Row counts / sizes** | **Not reported anywhere.** Neither figure can be honest ([§3.2](#32-there-is-no-honest-row-count-and-no-honest-size)) |
| **Verified against** | **Apache Cassandra 5.0.9** (`system.local.release_version`), the official `cassandra:5.0.9` image (the probe ran on the floating `cassandra:5.0` tag, and both tags resolve to the same amd64 manifest digest `sha256:4e806b4457fb`, so pinning the patch changed nothing that was measured), plus a second instance with `PasswordAuthenticator` + `CassandraAuthorizer` and materialized views enabled. Measured 2026-08-20, **before** any provider code existed |
| **Source** | [`src/lib/db/providers/sql/cassandra/`](../../src/lib/db/providers/sql/cassandra/) |
| **Tests** | [`tests/integration/db/cassandra-provider.test.ts`](../../tests/integration/db/cassandra-provider.test.ts) + [`tests/unit/db/cassandra/`](../../tests/unit/db/cassandra/) |
| **Tracking issue** | [#424 — Wire-compatibility and new engines](https://github.com/libredb/libredb-studio/issues/424), Phase 4 |

---

## 1. Overview

Cassandra is a distributed **wide-column** store. A table is a set of partitions, a partition is a
set of rows sharing a partition key, and every read is expected to name a partition. There is no
join, no subquery, no foreign key and no query planner worth explaining — the access path is decided
by the primary key you wrote in the DDL, which is why CQL refuses a `WHERE` clause it would have to
scan for rather than quietly scanning.

Three properties of that model drive everything below:

1. **Nothing counts rows.** A count is a full scan of the ring. What Cassandra publishes instead
   estimates *partitions* per token range from *flushed* SSTables, which is a different number that
   looks like the same one ([§3.2](#32-there-is-no-honest-row-count-and-no-honest-size)).
2. **Nothing plans.** `EXPLAIN` is not a keyword. The only introspection of a statement's execution
   is tracing, which happens *after* the statement ran
   ([§5.6](#56-there-is-no-explain-and-tracing-is-not-a-plan)).
3. **Everything operational is a node action.** Compaction, repair, flush, cleanup and snapshots are
   `nodetool` commands over JMX. A CQL session cannot reach any of them ([§8](#8-maintenance)).

### Concept mapping

| `DatabaseProvider` slot | Cassandra realisation | Mechanism |
|---|---|---|
| "Database" (the connection's `database` field) | One **keyspace**, pinned for the session | `keyspace` in the client options ([§3.3](#33-the-connections-database-field-pins-one-keyspace)) |
| "Table" (`TableSchema`) | A table, or a materialized view | `system_schema.tables` + `system_schema.views` |
| Columns | Partition key, clustering columns, regular and static columns | `system_schema.columns` ([§6.1](#61-declaration-order-is-not-recoverable)) |
| Indexes | Secondary indexes (`COMPOSITES`, SAI) | `system_schema.indexes`, `options.target` |
| Foreign keys | **Do not exist** | `declaresForeignKeys: false` |
| Row count / size | **Not reported** | [§3.2](#32-there-is-no-honest-row-count-and-no-honest-size) |
| Active sessions | The node's currently running requests | `system_views.queries` ([§7.3](#73-active-sessions-are-running-statements-with-no-owner)) |
| Slow queries | **Do not exist** | No aggregate of finished statements is readable from CQL |

---

## 2. Architecture

### 2.1 Where it sits

```
CassandraProvider (index.ts)          the DatabaseProvider contract, capabilities, prepareQuery
        │
        ├── introspect.ts             every CQL string, and every read over the seam
        │
        └── CassandraTransport (transport.ts)        the neutral seam: no driver type anywhere
                    │
                    └── CassandraDriverTransport (driver-transport.ts)
                                the ONLY file that imports cassandra-driver
```

`tests/unit/db/cassandra/seam-guard.test.ts` fails the build if the driver, its value classes or its
per-statement knobs are named in code outside `driver-transport.ts`. That is what makes the
integration suite possible: it runs the real provider, the real introspection **and the real driver
adapter** over a session stand-in that replays ResultSets a live 5.0.9 produced.

### 2.2 Class hierarchy

`CassandraProvider extends SQLBaseProvider extends BaseDatabaseProvider`.

`SQLBaseProvider` is the right base even though CQL is not SQL, because the helpers it carries are
about *text*, and on the points they cover CQL agrees:

- `escapeIdentifier()` emits `"name"`, which is CQL's own name quote — measured: `SELECT "id" FROM
  probe.customers` returns the column, a backtick is `no viable alternative at character '`'`, and a
  double-quoted string is a syntax error.
- `prepareQuery()` injects `LIMIT n`, which is correct CQL, and the three places it is *not* correct
  are the whole of the override in [§5.2](#52-the-row-bound-and-its-three-traps).

`buildLimitClause()` is **not** overridden, and the reason is worth recording because it is not
obvious: it has no caller in `src/` at all. The clause the limiter emits comes from
`applyQueryLimit()` in `db/utils/query-limiter.ts`, so `prepareQuery()` is the only place a dialect
can correct it.

### 2.3 Registration & lifecycle

| Surface | Entry |
|---|---|
| `src/lib/types.ts` | `"cassandra"` in `DatabaseType`, plus the `localDataCenter` field |
| `src/lib/db/factory.ts` | `case "cassandra"`, dynamic `import("./providers/sql/cassandra/index")` |
| `src/lib/db-ui-config.ts` | Icon, `text-sky-300`, "Apache Cassandra", port 9042, the `localDataCenter` field |
| `src/lib/sql/grammar.ts` | `CASSANDRA_GRAMMAR` — all four facts probed ([§5.4](#54-dialect-traps-a-user-will-hit)) |
| `src/lib/sql/values.ts` | `standard` literal escaping — doubling, backslash is data (measured) |
| `src/lib/db/compatibility.ts` | `SHIPPED.cassandra` |
| `src/lib/seed/types.ts` | The seed enum and `localDataCenter` |
| `next.config.ts`, `tsup.config.ts` | `cassandra-driver` external ([§3.1](#31-a-driver-that-costs-no-distribution-channel-anything)) |
| `database-compose.yml` | `cassandra:5.0.9`, port 9042, `nodetool status` healthcheck |

---

## 3. Design decisions

### 3.1 A driver that costs no distribution channel anything

`cassandra-driver` was checked against the rubric in
[`ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) before being adopted. Cassandra speaks a binary
protocol over TCP and has no first-class HTTP surface, so a driver is not optional — but this one
costs almost nothing that a native driver would:

- **Pure JavaScript.** No `binding.gyp`, no `.node`, no postinstall. Nothing to fail in an air-gapped
  install, and no N-API question for the Bun runtime.
- **Exercised under Bun before adoption**: three sessions, 2500 concurrent prepared inserts, a
  400-statement batch, `eachRow` auto-paging 500 rows and `stream()` over 2000, all on bun 1.3.14.
  The historical Bun segfault reports against this driver did not reproduce.

One catch, and it is the reason for two config entries: the driver does
`require('kerberos')` inside a `try`/`catch` as an optional dependency. Bundling it makes the build
try to resolve a module nobody installed, so the package is listed in `serverExternalPackages`
(`next.config.ts`) and in tsup's `external`.

### 3.2 There is no honest row count and no honest size

This is the decision the rest of the provider is shaped around, and it is the reason issue #424
exists. Cassandra publishes three things that look like the numbers a database browser wants:

| Source | What it actually is | Measured |
|---|---|---|
| `system.size_estimates` | **Partitions**, per token range (17 rows per table), from **flushed SSTables only**, refreshed every 5 minutes | 0 immediately after loading 500 rows; then 525 for those 500 rows, 2049 for 2000 — and **143 for a 500-row table** of 10 partitions × 50 clustering rows |
| `system_views.disk_usage` | Whole **mebibytes** | `1 MiB` for a 19,476-byte table; `0 MiB` for a table holding 500 rows that had not yet been flushed |
| `system_views.max_partition_size` | Whole mebibytes again | `1 MiB` for the same table |

A row count derived from the first is wrong by a factor that depends on how the table is modelled —
5% for a partition-per-row table, **71% low** for a clustered one — and no reader can tell which they
are looking at. A byte figure derived from the second is wrong by up to 50×.

So: no `rowCount` and no `size` on any `TableSchema`, `databaseSize` reported as `N/A` with
`databaseSizeBytes` **omitted entirely** — the field is optional on `DatabaseOverview`, because
absence and zero are different facts: a zero is a measurement, and the Storage tab read `?? 0`, so it
formatted a `0 B` total and divided a 0.0% breakdown out of it. With the field absent the tab's two
size cards read `N/A`, carry no percentage, and the breakdown is replaced by *"No storage size
information available."* A provider that publishes a real `0` (Trino, Druid) has measured one and is
unaffected. The **table, index and storage panels report nothing** — and for the table panel that
became true only when the same rule was applied there. Measured 2026-08-21 in Chrome against this
node, the monitoring **Tables** tab still summarised the empty `getTableStats()` as *Tables* `0` over
*0 rows*, *Size* `0 B` over *Total*, and *Vacuum* `0` over *OK*, in the very frame where the Overview
tab read *Tables 6 / 2 indexes* out of `system_schema`: the `0 B` was the sentinel this section had
just deleted, surviving one component over, and the *OK* was a clean bill of health for an operation
Cassandra does not have at all ([§7.4](#74-the-panels-that-report-nothing)). Two other engines are
recorded in `compatibility.ts` as failures for doing the opposite (Citus and TimescaleDB report row
counts and sizes that are wrong rather than missing), and this provider is not going to join them.

`SELECT COUNT(*)` is exact and is a full scan of the ring. A user can run one — it is a statement —
but nothing in the tree or the panels does, and there is a second reason beyond cost: measured on a
node with a 10ms read timeout, `SELECT COUNT(*) FROM probe.customers` was the one statement that
returned a server read timeout while every single-partition read succeeded.

### 3.3 The connection's `database` field pins one keyspace

Exactly as a PostgreSQL connection pins a database and a Trino connection pins a catalog. The form
labels it **Keyspace**.

It is pinned at connect time, which has two measured consequences worth knowing:

- Without it, an unqualified name resolves to nothing: `SELECT id FROM customers` answers `No
  keyspace has been specified. USE a keyspace, or explicitly specify keyspace.tablename`.
- A keyspace that does not exist fails the **connect**, not the first statement: `Keyspace
  'nosuchks' does not exist`. The provider surfaces that sentence rather than wrapping it in "failed
  to connect", because the one word the user has to change is in it.

A connection with no keyspace still runs every fully qualified statement. What it cannot do is show a
schema tree, and `getSchema()` says exactly that.

`USE <keyspace>` works and really does change the session's keyspace (measured) — unlike the
stateless HTTP providers in this repo, where a `USE` succeeds and then affects nothing.

### 3.4 `localDataCenter` is a required connection field, and nothing else here has one

`cassandra-driver` refuses to construct a load-balancing policy without it:

```
'localDataCenter' is not defined in Client options and also was not specified in constructor.
At least one is required. Available DCs are: [datacenter1]
```

and when the value is wrong it names the ones it found:

```
localDataCenter was configured as 'dc-does-not-exist', but only found hosts in data centers: [datacenter1]
```

So it is a real field on `DatabaseConnection`, in the connection form (in the open, **not** behind
the Advanced accordion that holds Oracle's service name — a hidden mandatory field is a connection
nobody can open), in the seed schema, and in `validate()`. A stock single-node install reports
`datacenter1`, which is the form's placeholder.

It is classified `public` in `connection-secrets.ts` (a data-centre name is not a credential) and
`resolution` in `use-connection-payload.ts` (it decides which nodes a statement reaches).

### 3.5 The error class is almost always the same one, so the classifier reads `innerErrors`

Measured: a refused credential, a wrong data centre, a refused socket, an unresolvable host name and
every unavailable-replica failure all arrive as **`NoHostAvailableError` with `code === undefined`**.
The fault that can be acted on is in `err.innerErrors[host]`. A classifier keyed on `err.code` puts
all of them in one bucket called "unknown".

The seam therefore unwraps the envelope first and classifies what is inside, by class name and — for
a `ResponseError` — by the protocol's own numeric code, read from the driver's `types.responseErrorCodes`
rather than transcribed:

| Category | Reached by | Provider error |
|---|---|---|
| `auth` | `AuthenticationError` inside the envelope; protocol `badCredentials` (256) | `AuthenticationError` |
| `permission` | 8448 — `User lowpriv has no SELECT permission on <table probe.orders> or any of its parents` | `QueryError` |
| `unreachable` | `ECONNREFUSED`, `DriverError: Connection timeout`, `No host could be resolved`, or any other per-host fault | `ConnectionError` |
| `config` | `ArgumentError` — the data-centre faults above | `DatabaseConfigError` |
| `client-timeout` | `OperationTimedOutError` — `The host 127.0.0.1:19042 did not reply before timeout 1 ms` | `TimeoutError` |
| `server-timeout` | 4608 read, 4352 write (`writeType: "BATCH_LOG"`) | `TimeoutError` |
| `unavailable` | 4096 — `Not enough replicas available for query at consistency TWO (2 required but only 1 alive)` | `QueryError` |
| `syntax` | 8192 | `QueryError` |
| `invalid` | 8704 | `QueryError` |
| `engine` | anything else, including code 0 `serverError` | `QueryError` |

`invalid` is one category because 8704 is one code. It covers an unknown keyspace, an unknown table,
an unknown column, a query that needs `ALLOW FILTERING`, a primary key in a `SET` part and a
materialized view on a server where they are disabled — and the server's own sentence is what tells
them apart. Splitting it finer would mean sniffing that sentence, which this repo forbids.

**One retry note.** With the driver's default `RetryPolicy`, a server read timeout was silently
retried and **succeeded**; the raw 4608 only appears under `FallthroughRetryPolicy`. The provider does
not change the retry policy, and no test depends on a retry outcome.

### 3.6 A monitoring surface degrades on a denial, and on one absent keyspace

Measured with a least-privilege role (`GRANT SELECT` on one table):

| Read | As `lowpriv` |
|---|---|
| `system_schema.tables` across every keyspace | **50 rows** — readable in full |
| `system.local`, `system.peers_v2` | readable — which is why the identity read does not degrade: the driver's own control connection reads `system.local` for the cluster topology before this provider sends anything |
| `system_views.clients` | 8448, refused |
| `system_views.caches`, `system_views.queries` | 8448, refused |
| `system.size_estimates` | **0 rows, no error** |

Two things follow. Every monitoring read degrades to empty on `permission`, and — since 2026-08-24, for the
one case below — on an **absent optional keyspace**. Nothing else: notably not an `invalid` naming a
table or a column, which is what a typo in this provider's own CQL produces, and an empty panel that
hides that hides it forever.

#### The second condition, and why it needs a name list

ScyllaDB has no `system_views` keyspace at all ([§11](#11-scylladb-is-a-partial-relative-one-absent-keyspace-cost-five-surfaces-until-d9)),
so the three virtual-table reads are refused by a server that is otherwise healthy. That is a fact
about the build, not about this provider's CQL — but the protocol does not say so. Measured 2026-08-24
through `cassandra-driver` 4.9.0, all four of these arrive as `ResponseError` with **code 8704** and
with the driver's own `keyspace` and `table` properties **`undefined`**:

| Sent | Server | Message | `absentKeyspace()` |
|---|---|---|---|
| `system_views.clients` | ScyllaDB 2026.2.4 | `Keyspace system_views does not exist` | `system_views` |
| `system_views.cliets` | Cassandra 5.0.9 | `table cliets does not exist` | `null` |
| `system_views.caches`, wrong column | Cassandra 5.0.9 | `Undefined column name hit_ratioo in table system_views.caches` | `null` |
| `system_viewz.clients` | Cassandra 5.0.9 | `keyspace system_viewz does not exist` | `system_viewz` |

So there is no structured discriminator and the sentence is all there is. Two things keep the reading
narrow. `CassandraTransportError.absentKeyspace()` reports the **name** the server refused rather than
a boolean — only the first and last rows are keyspace-shaped at all, and the case difference between
them (`Keyspace` / `keyspace`) is the servers', not a normalisation. And `introspect.ts` holds an
**allowlist of the keyspaces this provider knows are optional**, which is `system_views` and nothing
else. That is what separates the first row from the last: `system_viewz` is a typo in this file and
still fails loudly, and `system_schema` is not on the list at all, because it is readable on every
measured build and even by a least-privilege role, so a server refusing the whole of it is a fault the
tree must not hide.

One case the allowlist cannot separate, recorded rather than papered over: on a build with **no**
`system_views` keyspace, a typo in a `system_views` table name is refused with the keyspace message
too (measured — all three ScyllaDB rows above answer the same sentence), so it would degrade there.
The typo is caught on the engine that has the keyspace, which is the one this provider is developed
against.

And a security note worth stating plainly: **the object browser lists tables a restricted user cannot
read.** `system_schema` is world-readable, so the tree shows every table in the keyspace while the
statements against them fail with 8448. That is Cassandra's own permission model, not a defect here,
but it is not what a PostgreSQL user expects.

`system_auth.roles` is readable by a superuser and its rows carry bcrypt `salted_hash` digests.
Nothing in this provider reads that table, and no panel surfaces it.

### 3.7 There is no cancellation, so none is offered

The native protocol has no cancel frame, CQL has no `KILL`, and the driver's own client publishes no
cancel, abort or kill method (checked against its API surface: `connect`, `execute`, `eachRow`,
`stream`, `batch`, `getReplicas`, `getState`, `log`, `shutdown`).

`cancelQuery()` is therefore **not implemented**. Both routes detect support by the method's presence
(`"cancelQuery" in provider`), so its absence is what makes `/api/db/cancel` answer *"Query
cancellation is not supported for this database type"* — which is true — instead of reporting a
cancellation that silently failed. `search/index.ts` declined the same method for the same reason.

The only bound on a running statement is the client-side `readTimeout` (default 12000 ms, set from
the provider's query timeout). After it expires this client stops **waiting**; the coordinator carries
on. `USING TIMEOUT` — the per-statement server-side deadline — is **not in 5.0's grammar**: measured,
`SELECT * FROM probe.orders USING TIMEOUT 1ms` is `line 1:27 mismatched input 'USING' expecting EOF`.

### 3.8 Values are normalized once, at the driver boundary

Four traps, all measured, all silent. Three are still normalized here; the first is now handed on
untouched, and the sub-section below says why that is the same decision rather than a reversal:

| CQL type | Arrives as | `JSON.stringify` gives | Reported as |
|---|---|---|---|
| `blob` | `Buffer` | `{"type":"Buffer","data":[76,105,…]}` | the `Buffer` itself — see below |
| `vector<float,3>` | `Vector` | `{"0":1.5,"1":2.5,"2":3.5}` | `[1.5, 2.5, 3.5]` |
| `bigint` / `decimal` / `varint` | `Long` / `BigDecimal` / `Integer` | the exact digits | the exact digits, as a **string** |
| `duration` | `Duration` | `{"months":1,"days":2,"nanoseconds":"10800000000000"}` | `1mo2d3h` (its CQL literal) |

`Number()` on the third row is the silent one: the bigint maximum becomes `9223372036854776000` and a
20-digit decimal loses its last four digits. `COUNT(*)` is a `Long` too.

#### The `blob` row changed, and why the other three did not

**A `blob` is now spelled `\x4c69…` everywhere, not `0x4c69…`.** This row used to read
`0x4c69627265444200c3bf6279746573`: the value was stringified into its CQL literal here, at the
driver boundary, precisely *because* `JSON.stringify` on a `Buffer` gives the wire shape in the third
column. That reason has expired — `src/lib/export/binary.ts` (#469) reads exactly that shape, and it
is how a Postgres `bytea` reaches the binary cell renderer, the row detail sheet, the CSV and the
per-dialect binary literal the SQL export writes. Stringifying first was what kept a `blob` out of all
four, so the `Buffer` is handed on as itself and the grid now shows the same `\x…` for these bytes
that every other engine shows. The CQL literal is still `0x…`; the export builds it from the bytes.

Measured against Apache Cassandra 5.0.9 on 2026-08-24 — three rows in `probe.x10_blob (k int, c
blob)` holding `0x0102ab`, the empty blob `0x` and `null`, exported as `INSERT`s and replayed into the
same table:

| | grid / CSV | exported INSERT | replayed |
|---|---|---|---|
| before | `0x0102ab` | `VALUES (1, '0x0102ab')` | **refused**: `Invalid STRING constant (0x0102ab) for "c" of type blob` — both binary rows lost, only the `null` row landed |
| after | `\x0102ab` | `VALUES (1, 0x0102ab)` | all three rows back byte for byte, the empty blob (`0x`, shown `\x`) and the `null` included |

Cassandra is the engine where the old form did not silently corrupt but simply *refused* — MySQL, the
other provider that stringified, stored the eight characters `0x0102ab` into a `BLOB` and reported
success (`docs/providers/mysql.md` §3.3).

The other three rows keep their normalization, and each reason was re-measured rather than assumed:
`Vector` stringifies to `{"0":1.5,"1":2.5,"2":3.5}`, a numeric-keyed object no reader and no module
reconstructs; `Duration` to `{"months":1,"days":2,"nanoseconds":"10800000000000"}`, where `String()`
gives the CQL literal `1mo2d3h`. `Long`, `BigDecimal` and `Integer` are the one partial case worth
naming: each defines `toJSON`, so `JSON.stringify` alone already answers `"9223372036854775807"` —
the HTTP path would survive without this line. The in-process path would not: the embeddable
workspace and the agent's tools read a provider's rows directly, and there the live class instance
would reach the grid as an object. Normalizing once, at the boundary, is what makes both paths agree.

`timestamp` is left as a `Date`, because the grid already formats those. `time` becomes a string
because it carries nanoseconds a `Date` cannot hold. `set` arrives as an Array, `map` and a UDT as
plain objects, and all three are **walked** — a `map<text, bigint>` hides `Long` values one level
down.

**`duration` and `vector` both arrive with `type.code === 0` (custom)** and a Java class name in
`type.info`, and the driver's own `getDataTypeNameByCode` answers the literal string `"custom"` for
both. So the column-type map is keyed on the class name for those two, and an unmeasured custom type
is reported as the server spelled it rather than guessed into a CQL word.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Notes |
|---|---|---|
| `host` | Yes | One contact point. The driver discovers the rest of the ring itself |
| `port` | No (9042) | The native protocol |
| `localDataCenter` | **Yes** | [§3.4](#34-localdatacenter-is-a-required-connection-field-and-nothing-else-here-has-one) |
| `database` | No | The **keyspace**. Without it there is no schema tree |
| `user` / `password` | No | Sent only when a user is set. A stock install runs `AllowAllAuthenticator` and ignores credentials entirely (measured: supplying them to an open server connects fine) |
| `ssl` | No | Any mode but `disable` sends `sslOptions`: `rejectUnauthorized` from the mode, plus the form's CA (`ca`) and client keypair (`cert` / `key`) under Node's own TLS names, which is the same mapping the PostgreSQL, MySQL and Couchbase adapters use — the driver hands `sslOptions` to `tls.connect`. **Not exercised against a TLS cluster** — the probe instances speak plaintext — so it is the driver's documented option shape and no claim about a verified path, mutual TLS included |

### 4.2 There is no connection string, and why that is not fixable by inventing one

`supportsConnectionString: false`, and the form offers no paste toggle. The driver needs contact
points **plus** `localDataCenter`, and no URI convention in use carries the second — so a
`cassandra://host:9042/keyspace` form would parse into a connection that cannot open, which is worse
than no paste at all. `connection-string-parser.ts` has no branch for the scheme and
`ENGINE_URI_SCHEMES` no entry.

### 4.3 Connect is a session plus one statement

`connect()` opens the driver session, then runs the identity read
([§7.1](#71-overview)). The session's own `connect()` already fails on a refused socket, a wrong data
centre, a refused credential and a keyspace that does not exist — all measured — and one statement
afterwards proves the session can carry one. A probe that fails closes the session `connect()` had
already opened, before the failure is mapped, so a retried connection attempt leaves no pool, no
sockets and no reconnection timers behind — the same lifecycle as the Druid and Couchbase providers.

---

## 5. Query interface

### 5.1 Execution

One statement per `query()` call, `prepare: false`. Preparing a one-shot statement would add a round
trip and an entry to the server's prepared-statement cache (`system_views.cql_metrics` counts them)
for nothing.

**Positional parameters are refused.** CQL binds `?` and this driver binds an array against it —
through a prepared statement the transport deliberately does not send. Splicing values into the text
instead would be the one place this provider could inject CQL. `positionalPlaceholder()` returns
`null` for this dialect for the same reason (see `lib/sql/values.ts`).

A write answers **no column declaration and no rows** (measured on `INSERT`, `DELETE`, `ALTER TABLE`
and `USE`), and the protocol reports no affected-row count, so `rowCount` is the rows returned and
nothing is invented. `executionTime` is this process's measurement of the exchange — the only number
in existence, since the protocol carries no server-side duration.

### 5.2 The row bound, and its three traps

The shared limiter is right about *where* the clause goes and wrong about three things CQL alone
cares about. All six statements below were run against 5.0.9.

**1. `OFFSET` does not exist.**

```
SELECT id, name FROM probe.customers LIMIT 5 OFFSET 5
  -> line 1:45 mismatched input 'OFFSET' expecting EOF
SELECT id, name FROM probe.customers OFFSET 5
  -> line 1:37 mismatched input 'OFFSET' expecting EOF
```

So no page after the first can be requested, and `prepareQuery` **refuses** the request — for
every SELECT, including one that arrives with its own `LIMIT n` and is therefore never rewritten
here, because returning page one again is exactly the duplicate-row answer described next. The
alternatives are worse in a way that matters: sending the clause fails with an engine message about a
keyword the user never typed, and dropping it silently returns page **one** while the editor appends
it to what it already shows — duplicate rows presented as new ones, which is a wrong *answer*.
`search/index.ts` refuses Elasticsearch's identical gap the same way.

**2. `ALLOW FILTERING` must stay last.**

```
SELECT * FROM probe.orders WHERE amount > 5 LIMIT 3 ALLOW FILTERING   -> 3 rows
SELECT * FROM probe.orders WHERE amount > 5 ALLOW FILTERING LIMIT 3   -> line 1:60 mismatched input 'LIMIT'
```

The limiter appends, so the two clauses are **transposed** — with the writer's own spacing preserved.
This is strictly better than declining to bound the statement, which is the shape a user writes
precisely when a scan is about to happen.

**3. A line comment must be closed by a newline — and CQL has a third comment form.**

```
SELECT * FROM probe.customers LIMIT 3 -- note      -> line 1:45 mismatched character '<EOF>' expecting set null
SELECT * FROM probe.customers LIMIT 3 -- note\n    -> 3 rows
SELECT * FROM probe.customers LIMIT 3 // note\n    -> 3 rows
```

`//` is a line comment in CQL and the shared span readers know nothing about it. Both facts break the
limiter's insert-before-trailing-trivia rule (#280) in different ways: for `--` it re-attaches the
comment after the clause and the trim drops the newline that closed it, turning a **valid** statement
into a syntax error; for `//` it appends the clause *inside* the comment. So a statement whose
rewritten form would end inside a line comment is **left exactly as written**, `wasLimited: false`.
The check walks the shared span reader, so a `//` inside a string literal (`WHERE url =
'http://x'`) is not mistaken for a comment.

**One shape is knowingly left unbounded.** A statement whose last clause is `PER PARTITION LIMIT n`
reads as already bounded to the shared reader, so nothing is injected — `... PER PARTITION LIMIT 2
LIMIT 3` is valid CQL (measured), but forcing a bound would mean stripping the clause the reader
matched, which would corrupt the statement.

### 5.3 Result shaping

The **declaration** drives the row shape, not the row's own keys: it is the only source for the order
the statement projected. `fieldNames: null` (a write) and `fieldNames: []` are kept apart at the
seam and both collapse to no columns for the grid.

`columnTypes` carries the wire's declared type per column. Note that `text` reads back as `varchar`
and a column declared `varchar` reads back as `text` — they are one type on the wire — so this is
whatever the protocol declared rather than the DDL word. The schema tree reads
`system_schema.columns.type`, which **is** the declared spelling (`frozen<list<int>>`,
`vector<float, 3>`, `frozen<address>`).

### 5.4 Dialect traps a user will hit

| Written | 5.0.9 answers |
|---|---|
| `SELECT … JOIN …` | `line 1:27 mismatched input 'o' expecting EOF` — there is no join, and no table alias either |
| `EXPLAIN SELECT …` | `line 1:0 no viable alternative at input 'EXPLAIN'` |
| `SELECT * FROM t ORDER BY name` | `ORDER BY is only supported when the partition key is restricted by an EQ or an IN.` |
| `WHERE amount > 5` on a non-key column | `Cannot execute this query as it might involve data filtering … use ALLOW FILTERING` |
| `UPDATE t SET id = 2 WHERE id = 1` | `PRIMARY KEY part id found in SET part` |
| `UPDATE probe.events SET v = 'x' WHERE ck = 0` | `Some partition key parts are missing: pk` |
| `ALTER TABLE t ALTER name TYPE blob` | `Altering column types is no longer supported` |
| `ALTER TABLE t ADD COLUMN x text` | `mismatched input 'text' expecting EOF` — CQL spells it `ADD x text` |
| `CREATE MATERIALIZED VIEW …` | `Materialized views are disabled. Enable in cassandra.yaml to use.` |
| `LIMIT 0` | `LIMIT must be strictly positive` |
| `SELECT 1; SELECT 2;` | `mismatched input 'SELECT' expecting EOF` — one statement per request |

The four grammar facts in `src/lib/sql/grammar.ts` were all probed on this engine rather than read
off a neighbour:

| Fact | CQL | Probe |
|---|---|---|
| `#` | **code** (opens nothing) | `… id = 1 # trailing`, `SELECT # x`, `SELECT id#a` — all `no viable alternative at character '#'` |
| `[…]` | **subscript** | `SELECT [id] …` answers a column named `[id]` of type `list` holding `[1]`; `SELECT [1, 2]` is a *typing* complaint about a term already read; `SELECT [[id]]` answers `[[1]]`; `SELECT ['a]b']` reaches the same typing complaint, so the `]` inside the string did not close the run |
| block comments | **flat** | `SELECT /* a /* b */ id …` returns the row |
| `q'…'` | **not a literal** | `q'{it''s}'` is `no viable alternative at input '{it's}'` |

`cassandra` is deliberately **absent** from `NON_SQL_DIALECTS`. That set asks whether the text is
SQL-*shaped* so that a span reader can find where a literal ends and where a comment hides a write —
and CQL is written with the same statement keywords, the same `'…'` literals with doubled quotes, the
same `"…"` quoted names and the same `--` / `/* */` comments. The keywords it *lacks* are a smaller
vocabulary, not a different notation.

### 5.5 Writes, and what "upsert" costs a reader

`INSERT` and `UPDATE` are the same operation: both write the cells they name into the partition the
`WHERE`/`VALUES` clause identifies, whether or not a row was there. There is no "row not found", and
a `DELETE` writes a tombstone.

The results grid's **inline row editor is switched off**, and it is not a missing feature but a
missing guarantee. The editor builds `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>` against
**one** column it guesses from the result fields (`id`, or anything ending `_id`), while CQL needs the
**whole** primary key restricted by equality. Measured: `UPDATE probe.events SET v = 'x' WHERE ck = 0`
→ `Some partition key parts are missing: pk`, and `UPDATE probe.orders SET amount = 1 WHERE
customer_id = 3` — a plausible guess on a real table — → `Some partition key parts are missing: id`.

`supportsCreateTable` is `false` for the same class of reason. `CREATE TABLE probe.t (id int PRIMARY
KEY, name text)` works, but what `CreateTableModal` emits does not: its default column is `id SERIAL
PRIMARY KEY` (`Unknown type probe.serial`), its type list offers `VARCHAR(255)` and `DECIMAL(10,2)`
(syntax errors — CQL types carry no length) and `INTEGER` and `JSONB` (`Unknown type`), and its NOT
NULL, UNIQUE and DEFAULT options are each `no viable alternative at input`. DDL typed into the editor
works normally.

The **schema-diff migration generator refuses a Cassandra `CREATE TABLE` too**, for a second and
independent reason. A CQL primary key is two things — the partition key, which places a row, and the
clustering columns, which order it inside the partition — and only the brackets say which is which.
Measured: `probe.composite_pk` (`PRIMARY KEY ((tenant, day), ts)`) and `probe.pk_flat` (`PRIMARY KEY
(tenant, day, ts)`) differ by one pair of brackets and nothing else; `SELECT * FROM probe.pk_flat
WHERE tenant = 'a'` is served, while the same restriction on `probe.composite_pk` answers code 2200,
`Cannot execute this query as it might involve data filtering and thus may have unpredictable
performance`. `system_schema.columns` separates the two roles by `kind` (`partition_key` vs
`clustering`, measured on `composite_pk`), but `ColumnDiff` keeps only the boolean
`targetIsPrimary`, so both tables reduce to the same three key columns and the shared `PRIMARY KEY
(a, b, c)` serializer would silently pick the flat layout. `src/components/SchemaDiff.tsx` calls
`generateMigrationSQL` with the connection's type and never consults capabilities, so
`migration-generator.ts` declines there itself and emits `-- Apache Cassandra: Cannot generate
CREATE TABLE for "<table>". …` in place of DDL that would run and quietly repartition the data.
Two more shapes are left out of a Cassandra migration for the same reason. The **transaction
wrapper** is not emitted: `BEGIN;` is `line 1:5 mismatched input ';' expecting K_BATCH` and
`COMMIT;` is `no viable alternative at input 'COMMIT'` (measured), and CQL's only grouping,
`BEGIN BATCH … APPLY BATCH`, is not a transaction and takes no DDL — so there is nothing to
translate the wrapper into. **Foreign-key statements** are not emitted either: `ADD CONSTRAINT …
FOREIGN KEY` is `line 1:48 mismatched input 'FOREIGN' expecting EOF` and `DROP CONSTRAINT IF EXISTS`
is `mismatched input 'IF'`. That second one needs a branch even though [§6.2](#62-indexes-and-the-one-thing-they-never-are)
reports `declaresForeignKeys: false`, because the report never reaches the generator:
`SchemaDiff.tsx` takes the dialect from the **current connection** and the diff from a snapshot that
may belong to a **different** one, so a Cassandra connection compared against a PostgreSQL snapshot
carries relational keys into a CQL migration. Each is replaced by a comment naming the reason.

The `ALTER` paths **do** emit runnable CQL, and each spelling was probed: an added column becomes
`ALTER TABLE <t> ADD <col> <type>` because `ADD COLUMN extra TEXT` is `mismatched input 'TEXT'
expecting EOF` while `ADD extra text` parses, a removed one becomes `ALTER TABLE <t> DROP <col>` for
the same reason in reverse (`DROP COLUMN extra` is `mismatched input 'extra' expecting EOF`), and a
CQL column definition carries a name and a type only — `NOT NULL`, `UNIQUE` and `DEFAULT` are each
`no viable alternative at input`, so none of the three is appended. A **modified** column emits no
statement at all, only the reason: `ALTER TABLE t ALTER name TYPE blob` answers 8704, `Altering
column types is no longer supported` — the operation was removed from the engine rather than left
unimplemented, so there is nothing to generate.

### 5.6 There is no EXPLAIN, and tracing is not a plan

`EXPLAIN` is not in the grammar. `supportsExplain` is `false`, no `explainFormat` is declared, and
`src/lib/explain/` is untouched — so the button and the tab stay hidden rather than dead.

The only substitute Cassandra has is `{traceQuery: true}` plus `system_traces.sessions` /
`system_traces.events`, which records what a statement did **after it ran**: the coordinator's steps,
the replicas contacted, the microseconds each took. That is a profile of a completed execution, not a
plan of a pending one, and calling it a plan would be a claim the engine does not make. It is
deliberately left out of this provider; if it is ever exposed it must not be called EXPLAIN.

---

## 6. Schema introspection

Three reads, all against `system_schema`, all for the pinned keyspace:

```sql
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'probe'
SELECT view_name, base_table_name FROM system_schema.views WHERE keyspace_name = 'probe'
SELECT table_name, column_name, type, kind, position, clustering_order
  FROM system_schema.columns WHERE keyspace_name = 'probe'
SELECT table_name, index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = 'probe'
```

(Four statements; three sources — a view's columns are in the same `system_schema.columns` as a
table's, keyed by the view's name.)

### 6.1 Declaration order is not recoverable

`system_schema.columns.position` is **-1 for every regular and static column**, 0-based *within its
kind* for a partition-key or clustering column, and the server returns the rows sorted by column
name. So the DDL order cannot be reconstructed, and the tree does not pretend to: columns are ordered
**partition key (by position), then clustering columns (by position), then everything else
alphabetically** — which is how `DESCRIBE TABLE` prints a table and how the primary key has to be
written in a `WHERE` clause.

`nullable` is `false` for exactly the primary-key components: CQL has no `NOT NULL` to declare on
anything else, and every regular column of an existing row may be absent entirely.

### 6.2 Indexes, and the one thing they never are

`options.target` names the indexed column. `unique` is **always false**, and that is the engine's
answer rather than this schema's: `CREATE UNIQUE INDEX` is `no viable alternative at input 'UNIQUE'`
— the keyword is not in the grammar.

`foreignKeys` is always `[]`, with `declaresForeignKeys: false` so a reader knows that means "this
engine has none" rather than "this schema declares none". `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY
…` is a syntax error.

### 6.3 Materialized views are listed, and are usually absent

A view is **not** in `system_schema.tables`, its columns **are** in `system_schema.columns`,
`SELECT * FROM probe.orders_by_country` returns rows, and `INSERT INTO` one is refused with `Cannot
directly modify a materialized view`. All measured on the instance where they are enabled.

They are **disabled by default in 5.0** (`materialized_views_enabled: false`), so on a stock install
the view list is empty and the tree shows tables only. That is a property of the server, not of this
read — which is why the list is read rather than omitted, and why this paragraph exists rather than a
"Views" node that is always empty.

### 6.4 `DESCRIBE` works, and is not needed

`DESCRIBE TABLE`, `DESCRIBE KEYSPACE`, `DESCRIBE KEYSPACES` and `DESCRIBE CLUSTER` all work over the
native protocol on 5.0 and return a full `create_statement` — the complete DDL including every `WITH`
option. Worth knowing if DDL display is ever added: no hand-assembly is required. The schema tree
does not use it, because it needs one row per column rather than one blob per table.

---

## 7. Monitoring & health

Cassandra's `system_views` keyspace (4.0+) publishes 43 virtual tables. This provider reads four of
them, and the reason is the same each time: the rest report per-table percentile histograms, gossip
state, thread pools and cache internals that no panel in this product has a slot for — or they report
mebibytes ([§3.2](#32-there-is-no-honest-row-count-and-no-honest-size)).

### 7.1 Overview

```sql
SELECT release_version, cluster_name, data_center, gossip_generation,
       toTimestamp(now()) AS server_now FROM system.local
SELECT COUNT(*) AS count FROM system_views.clients
SELECT COUNT(*) AS count FROM system_schema.tables  WHERE keyspace_name = 'probe'
SELECT COUNT(*) AS count FROM system_schema.indexes WHERE keyspace_name = 'probe'
```

| Field | Source |
|---|---|
| `version` | `Apache Cassandra 5.0.9` — the product name plus `release_version` |
| `startTime` / `uptime` | `gossip_generation`, against the **server's** clock via `toTimestamp(now())` |
| `activeConnections` | `system_views.clients` — degrades to 0 on a refused grant, and on a build with no `system_views` keyspace ([§3.6](#36-a-monitoring-surface-degrades-on-a-denial-and-on-one-absent-keyspace)). The 0 is the residue that section records: the field is a required number, so "not published" cannot be said here |
| `maxConnections` | `0` — "no ceiling published". Cassandra's connection limit defaults to unlimited and is a config reading, not a live capacity |
| `databaseSize` | `N/A`; `databaseSizeBytes` **omitted**, not zeroed — [§3.2](#32-there-is-no-honest-row-count-and-no-honest-size) |
| `tableCount` / `indexCount` | `system_schema` |

**`gossip_generation` is the node's start time in epoch seconds**, and that is measured rather than
read off the field's name: on the primary instance it was `1787249337` against a container started at
`18:08:53.9Z` (the gossiper's first heartbeat, three seconds later), and the second instance's
generation differed from the first by 4997 s against a container start difference of 4998 s. It is
bumped on restart, which is what makes it a start time; where the gossiper has to advance it past a
stale value the reading can only be *later* than the real start, so the uptime is under-reported
rather than over.

`native_protocol_version` is deliberately **not** reported: `system.local` says `5` while
`system_views.clients.protocol_version` for the live session says `4`, so reporting it as the
session's protocol would be wrong.

### 7.2 Performance metrics

One field, `cacheHitRatio`, from the **key cache** row of `system_views.caches` (`0.8305…` → `83.05`).
It is a real measurement of a real cache; the row cache and counter cache are off by default and
reported a null ratio on a node that had served 500 reads.

Every other field of `PerformanceMetrics` is **omitted rather than zeroed**. Cassandra publishes
throughput and latency as per-table percentiles (`local_read_latency`, `coordinator_read_latency`)
rather than as a cluster rate, and `cql_metrics` counts prepared statements rather than statements per
second — there is no queries-per-second figure to read. `cacheHitRatio` itself is omitted when the
server reports null (an unused cache): `DEFAULT_THRESHOLDS` scores that metric `direction: "below"`
with `critical: 80`, so a substituted zero would paint an idle cluster red.

Two panels read those absences, and both used to fill them in. The Overview tab's Performance card
drew `bufferPoolUsage` as *0%* with an empty bar and `deadlocks` as a `0` badge in the healthy
variant; the Performance tab's Buffer card rated the same `0` **Poor** in red, and its Deadlocks card
badged `0` **Healthy** over *None detected* — a verdict on a measurement nobody made, and in the
deadlock case a verdict read off a counter this engine does not keep. Both now read `N/A` beside the
words *Not measured*, and the Buffer Pool and Deadlock trend charts say the same instead of drawing a
flat line along zero. `cacheHitRatio` is the one field here that was measured, so it keeps its gauge
and its rating.

### 7.3 Active sessions are running statements with no owner

```sql
SELECT thread_id, queued_micros, running_micros, task FROM system_views.queries
```

This is the only source, and what it does **not** publish decides the mapping: no user, no keyspace,
no client address, no start timestamp — only the request thread, the task text and two microsecond
readings. `user` and `database` are therefore `unknown` (Druid's own word for the same situation);
the connected role is deliberately not borrowed, because it would credit this connection with a
statement another client is running.

`durationMs` keeps its fraction — 1118 µs is 1.118 ms, and rounding it to 1 would throw away the only
precision the server offered. The read includes **itself**, which is honest: it is a snapshot of the
node's request threads.

`system_views.clients` is what the connection count comes from and it *does* carry a username, a
keyspace, a driver name and a protocol version — but no statement and no duration, so it is a
connection list rather than a session list.

### 7.4 The panels that report nothing

Each of these returns an empty list, and the second column is why. The third is what the panel does
with it: an empty list is the only way a required field can decline, so a panel that reduces one into
a total publishes a figure the engine refused to give — which is what the Tables and Queries tabs did
here until the rule of [§3.2](#32-there-is-no-honest-row-count-and-no-honest-size) reached them.

| Panel | Why empty | What it renders |
|---|---|---|
| Slow queries | There is no aggregate of finished statements anywhere CQL can read. `system_views.system_logs` is a tail of the node's log file (0 rows on this image), and the slow-query threshold that exists writes to that log. **No statement is sent** to discover this | *Queries*, *Avg Time* and *Slow* all read `N/A`. They used to read `0`, `0.00ms` and `0`, and an average over no statements is not zero milliseconds |
| Table statistics | `TableStats` needs a row count and a byte size; see [§3.2](#32-there-is-no-honest-row-count-and-no-honest-size). **No statement is sent** | *Tables* and *Size* read `N/A`, and the list below them says *No table statistics available.* rather than *No tables found.* The tab separates the two cases by the **required** `overview.tableCount`, which `system_schema` fills honestly (6 here): tables the engine knows about, with statistics for none of them, means the figures are not knowable rather than that the keyspace is empty |
| Index statistics | `system_schema.indexes` gives a name, a table and a target column — all of which the tree already shows — and `IndexStats` also wants a size and a scan count. Nothing reachable from CQL reports either, and a zeroed scan count reads as "never used" | There is no index panel; `IndexStats` feeds the Storage tab's *Indexes* card, which reads `N/A` on the absent `databaseSizeBytes` rather than on this list ([§3.2](#32-there-is-no-honest-row-count-and-no-honest-size)) |
| Storage statistics | The only storage figures a statement can read are whole mebibytes per table, so `databaseSizeBytes` is omitted rather than zeroed and the tab says so in words ([§3.2](#32-there-is-no-honest-row-count-and-no-honest-size)) | Both size cards read `N/A` with no percentage, and the breakdown is replaced by *No storage size information available.* |

---

## 8. Maintenance

`supportsMaintenance: false`, `maintenanceOperations: []`, and `runMaintenance()` refuses every type
with the reason.

Every member of `MaintenanceType` describes something Cassandra does to a **node**, not through a
session: compaction, cleanup, garbage collection, flush and repair are all `nodetool` commands over
JMX, and statistics are recomputed as a side effect of compaction. There is no `KILL` to map `kill`
onto, because the protocol has no cancellation at all
([§3.7](#37-there-is-no-cancellation-so-none-is-offered)).

`TRUNCATE` is the tempting one and is deliberately not wired: it is a data-loss operation, it is not
one of the six `MaintenanceType` values, and a user who wants it can type it.

The two label triads are rewritten anyway — the cards do not render, but the inherited copy would
promise a user that this panel updates planner statistics and reclaims space.

`supportsMaintenance: false` is read in one more place than the maintenance controls. The monitoring
**Tables** tab carries a *Vacuum* summary card, and it counted rows over a bloat ratio to decide
between *Need* and *OK* — with no rows it said `0` over **OK** in green, which is a clean bill of
health for an operation that does not exist here. Whether an engine *has* vacuum is a capability
question rather than a data question, so the card now reads the declared capability and says `N/A`
over *Not supported*. (The same tab's per-row *Last Vacuum* column now shows a dash rather than
*Never* on an engine that declares no `vacuum` — on PostgreSQL a null there is the measurement "never
vacuumed", elsewhere it is a history for an operation there is none of. No row of it renders here,
because there are no table statistics to list at all.)

---

## 9. Capabilities & labels

```ts
{
  queryLanguage: "sql",
  supportsExplain: false,            // EXPLAIN is not in the grammar (§5.6)
  supportsExternalQueryLimiting: true,
  supportsCreateTable: false,        // the modal cannot emit valid CQL, and a diff cannot derive the partition key (§5.5)
  supportsInlineRowEdit: false,      // one guessed key column is not a CQL primary key (§5.5)
  supportsTransactions: false,       // CQL has no transaction; BATCH is not one (#U13)
  declaresForeignKeys: false,        // the clause does not exist (§6.2)
  supportsMaintenance: false,        // every operation is a nodetool action (§8)
  maintenanceOperations: [],
  supportsConnectionString: false,   // no URI carries localDataCenter (§4.2)
  defaultPort: 9042,
  schemaRefreshPattern: "\\b(CREATE|DROP|ALTER)\\b",
}
```

`identifierQuoting` and `statementTerminator` are both **absent**, and each absence is measured
rather than assumed: 9042 is Cassandra's alone, so the generators' port heuristic is not being asked
to answer for two dialects and its default `"…"` branch is already correct here; and `SELECT id FROM
probe.customers WHERE id = 1;` returns the row, so the `;` the generators already emit is valid CQL.

`entityName`, `rowName` and the action labels are CQL's own words and are left inherited.
`statementLanguage` is declared — *"CQL (Cassandra Query Language) - no JOIN, no subquery, no
OFFSET"* — because a model asked for "a statement" against a connection called Cassandra will write
SQL, and each of those three is a syntax error here.

`slowQueriesEmptyState` is declared — *"Cassandra keeps no aggregate of finished statements: the
slow-query threshold writes to the node's log file rather than to a table."* — because
`getSlowQueries()` is empty by design ([§7](#7-monitoring--health)), so the monitoring Queries panel
is **always** empty here, and its hardcoded sentence used to tell the reader to enable
`pg_stat_statements` (`docs/BACKLOG.md` U12).

---

## 10. Testing

| File | Owns |
|---|---|
| [`tests/integration/db/cassandra-provider.test.ts`](../../tests/integration/db/cassandra-provider.test.ts) | The provider end to end. A session stand-in replays driver ResultSets captured from 5.0.9, so the real provider, the real introspection **and the real driver adapter** all execute |
| [`tests/unit/db/cassandra/wire.test.ts`](../../tests/unit/db/cassandra/wire.test.ts) | Value normalization, column-type naming and error classification — built with the driver's **own** `Long`, `BigDecimal`, `Duration` and `Vector` classes |
| [`tests/unit/db/cassandra/seam-guard.test.ts`](../../tests/unit/db/cassandra/seam-guard.test.ts) | That the driver, its value classes and its per-statement knobs appear in code only in `driver-transport.ts` |

The session stand-in **throws on an unknown statement** rather than answering empty: a provider whose
CQL drifts has to fail there, not quietly report no rows.

### Reproducing the live pass

```bash
docker compose -f database-compose.yml up -d cassandra
# READINESS TAKES ABOUT 206 SECONDS FROM COLD on this image. Do not write a fixed sleep;
# wait for the healthcheck (`nodetool status | grep -q '^UN'`).
docker compose -f database-compose.yml exec cassandra cqlsh -e "
  CREATE KEYSPACE probe WITH replication = {'class':'SimpleStrategy','replication_factor':1};
  CREATE TABLE probe.customers (id int PRIMARY KEY, name text, country text);
  CREATE INDEX customers_country_idx ON probe.customers (country);"
```

Then connect with host `localhost`, port `9042`, keyspace `probe`, local data centre `datacenter1`.

For the ScyllaDB pass ([§11](#11-scylladb-is-a-partial-relative-one-absent-keyspace-cost-five-surfaces-until-d9))
the service is `scylla` on host port `9142`, and the keyspace has to be created with
`replication = {'class':'NetworkTopologyStrategy','datacenter1':1}` — the 2026.2 line refuses
`SimpleStrategy` outright with `ConfigurationException: SimpleStrategy doesn't support tablet
replication`, so the recipe above does not run unchanged. Readiness is well under a minute rather
than the ~206 s the Cassandra image needs.

---

## 11. ScyllaDB is a `partial` relative: one absent keyspace cost five surfaces until 2026-08-24

ScyllaDB speaks the CQL wire protocol and this driver connects to it, and a live gate-4 probe says
what that buys. The pass below ran on 2026-08-21/22 and was re-run on 2026-08-24 after the degradation change
what five of the surfaces do; both readings are recorded here, because the difference between them is
the interesting part. Every one of the thirteen surfaces this provider offers was called separately
through `createDatabaseProvider({ type: "cassandra" })` against `scylladb/scylla:2026.2.4` (build
`2026.2.4-0.20260810.e54224b8cebb`) and, in the same pass, against `cassandra:5.0.9` as the baseline.
`scylladb/scylla:2025.1` (build `2025.1.14-0.20260612.103b84070f3b`) was probed too and behaved
**identically on every surface**, so the entry in `src/lib/db/compatibility.ts` describes both lines —
and only these two builds, on a single-node container.

**The whole delta is one cause: ScyllaDB has no `system_views` keyspace at all.** `system.local`,
`system_schema.*` and `system.size_estimates` all exist and answer; `system_views.clients`,
`.queries`, `.caches`, `.system_logs` and `.disk_usage` do not exist to be denied. Five surfaces
FAILED on it, each with the same verbatim error `Keyspace system_views does not exist`: `getOverview`,
`getPerformanceMetrics`, `getActiveSessions`, `getHealth` and `getMonitoringData`. On the 5.0.9
baseline all thirteen passed.

Thirteen rather than the fifteen the [compatibility table](./README.md#wire-compatible-engines)
counts, because two of the fifteen do not exist on this provider at all for either engine:
cancellation is not implemented ([§3.7](#37-there-is-no-cancellation-so-none-is-offered)) and
`supportsExplain` is false ([§5.6](#56-there-is-no-explain-and-tracing-is-not-a-plan)).

**Test Connection was the sixth casualty, and it was the one a user meets first.** `POST
/api/db/test-connection` calls `provider.getHealth()`
([`src/app/api/db/test-connection/route.ts`](../../src/app/api/db/test-connection/route.ts)), so the
dialog reported a failure for a connection whose statements run cleanly.

**And it was worse than a failing test button, which only a browser pass showed.** `handleConnect` in
[`src/hooks/use-connection-form.ts`](../../src/hooks/use-connection-form.ts) gated the SAVE on the
same request — `if (result.success) onConnect(conn)` — so **Establish Connection refused too and
nothing was stored**. A ScyllaDB connection could not be created through the dialog at all; the
browser pass behind this section reached the editor through a seeded, admin-managed connection
instead. Two other published relatives sat on the same gate, StarRocks and SingleStore, whose health
surface also fails; that neither row recorded it is the U14 lesson again — a gate-4 pass on the
provider's own boundary does not read the product surfaces the provider feeds.

What the failure looked like on the two surfaces that showed it: the monitoring dashboard rendered a
single **Connection Error** page reading `Keyspace system_views does not exist`, which the connection
is not (the same mislabelling the Cloudberry row records), and the header badge read **Slow** with
the title *Connection: degraded* rather than Online — the badge follows the health request, not
latency.

### 11.1 What the degradation change did, and what it deliberately did not

Two changes, and the second is not about Cassandra at all.

**The five reads degrade.** A monitoring read now answers empty when the server says the keyspace it
reads from does not exist AND that keyspace is one this provider knows is optional, which is
`system_views` and nothing else. The discriminator, the four measured error spellings it rests on and
the case it cannot separate are all in
[§3.6](#36-a-monitoring-surface-degrades-on-a-denial-and-on-one-absent-keyspace).

**The dialog's save no longer depends on the health surface.** A connection that `connect()`s is
usable — every provider's `connect()` reaches the server and is refused by a wrong host, port,
credential or database — so `POST /api/db/test-connection` now separates the two facts: a connect
failure is still `success: false`, and a health read that fails *after* a successful connect answers
`success: true, degraded: true` carrying the server's own sentence. `handleConnect` saves on that, but
not silently: the first click reports what the server refused and saves nothing, and only a second
click saves. This is not a Cassandra fix — StarRocks and SingleStore fail health for their own reason
(**D8**) and were unsaveable on the same gate.

Re-probed 2026-08-24, every surface separately, same method as the original pass:

| Surface | ScyllaDB 2026.2.4, before | ScyllaDB 2026.2.4, after | Cassandra 5.0.9 control |
|---|---|---|---|
| `getOverview` | `Keyspace system_views does not exist` | `Apache Cassandra 3.0.8`, uptime `23.76m`, 3 tables, 1 index, **connections 0** | version 5.0.9, connections 1 |
| `getPerformanceMetrics` | same error | `{}` — no cache ratio claimed | `{ cacheHitRatio: 88.24 }` |
| `getActiveSessions` | same error | `[]` | 1 running statement |
| `getHealth` | same error | answers; `cacheHitRatio` `N/A`, no sessions | answers with data |
| `getMonitoringData` | same error | answers | answers with data |
| the other eight | pass | pass | pass |

And the discriminator itself, measured through the real transport against both servers on the same
day (`category` / `absentKeyspace()`):

| Statement | Cassandra 5.0.9 | ScyllaDB 2026.2.4 |
|---|---|---|
| `SELECT COUNT(*) FROM system_views.clients` | OK | `invalid` / `"system_views"` → degrades |
| `SELECT COUNT(*) FROM system_views.cliets` | `invalid` / `null` → throws | `invalid` / `"system_views"` |
| `SELECT hit_ratioo FROM system_views.caches` | `invalid` / `null` → throws | `invalid` / `"system_views"` |
| `SELECT COUNT(*) FROM system_viewz.clients` | `invalid` / `"system_viewz"` → throws | `invalid` / `"system_viewz"` → throws |
| `SELECT COUNT(*) FROM system_schema.tables` | OK | OK |

**One number is still not honest, and it is recorded rather than fixed.** The overview's
`activeConnections` reads **0** on a build with no `system_views` keyspace, because
`DatabaseOverview.activeConnections` is a required `number`: there is no way to say "not published"
without widening the type and the Connections card that renders it. It is the same 0 a
permission-denied role has always produced, and it is the one figure here a reader could mistake for a
measurement.

What works:

- `connect`, `query`, `getSchema`, `disconnect` — the editor and the object browser in full, columns
  and index metadata included.
- `getSlowQueries`, `getTableStats`, `getIndexStats` and `getStorageStats` pass by sending nothing,
  exactly as they do on Cassandra ([§3.2](#32-there-is-no-honest-row-count-and-no-honest-size),
  [§7.4](#74-the-panels-that-report-nothing)). They are passes, not working panels: row counts, sizes
  and the slow-query figures read `N/A` here for the same reason they do on Cassandra, rather than a
  fabricated zero.
- All **18 CQL types round-tripped byte-identically** to the 5.0.9 baseline, compared field by field:
  `bigint` 9007199254740993 as a string, `decimal` 1.25, `duration` `3h20m`, `varint`
  123456789012345678901234567890, `blob` `0x00ff` (the stored value; both engines now report it as
  bytes rather than as that literal, [§3.8](#38-values-are-normalized-once-at-the-driver-boundary)),
  `inet`, `date`, `time` `12:00:00.123456789`,
  list/set/map, uuid, timestamp.
- Error **classes** are identical although the server's wording is not: a missing table is
  `unconfigured table no_such_table` here against Cassandra's `table no_such_table does not exist`,
  a missing column `Unrecognized name nope` against `Undefined column name nope in table
  probe.customers`. All three refusals still arrive as the recognised `QueryError` because
  `classifyCassandraError` reads the driver's error code and not the message text
  ([§3.5](#35-the-error-class-is-almost-always-the-same-one-so-the-classifier-reads-innererrors)).

Two differences a reader will see on screen. The object browser lists **one extra object per secondary
index, and the tree and the overview disagree about it**: ScyllaDB backs an index with a materialized
view, so `customers_country_idx_index` appears in `system_schema.views` — which the tree reads — and
NOT in `system_schema.tables`, which the overview's table count reads. Measured 2026-08-24 on a
`probe` keyspace of 3 user tables and 1 index: the tree lists 4 objects and `tableCount` says 3. (The earlier pass
recorded this as a `system_schema.tables` row; that was wrong, and the two-catalog split is why the
two panels disagree.) Cassandra lists neither. And the version now IS displayed, because the panel
carrying it answers: it reads Apache Cassandra **3.0.8**, the compatibility number
`system.local.release_version` publishes, not ScyllaDB 2026.2.4, which lives in `system.versions`
where this provider does not look.

Of the three doubts this section used to raise, two held and one was wrong. `system_views` is indeed
absent, and the version string is indeed not `release_version`-shaped. But **`gossip_generation`
exists on ScyllaDB and answers** — that doubt was unfounded.

The tier stays `partial`, and the reason has moved rather than gone. Not `full`, because five of the
thirteen surfaces answer with nothing: the monitoring dashboard here carries a version, an uptime and
two counts against Cassandra's full set, and `full` in this table means every surface *answered*, not
every surface returned. Not `query-only` either, because the object browser, the column metadata and
the index metadata all work — which is what separates this from Materialize and RisingWave, which have
none of it.
