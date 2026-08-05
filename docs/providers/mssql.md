# Microsoft SQL Server Provider

> Microsoft SQL Server support for LibreDB Studio, built on the [`mssql`](https://github.com/tediousjs/node-mssql)
> driver (Tedious/TDS). This document is the single reference point for the SQL Server provider:
> design, architecture, usage, and tests. It is a SQL-family provider sharing `SQLBaseProvider`;
> read the [PostgreSQL doc](./postgres.md) first for the canonical SQL walkthrough, then this doc for
> the SQL-Server-specific deltas.
>
> **Naming:** the canonical type-id is **`mssql`** (matching the npm driver `mssql` and Microsoft's
> `mcr.microsoft.com/mssql/server` image). The product's display name is **"SQL Server"** (the UI
> label). This doc's filename mirrors the type-id; the prose uses the product name.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `mssql` |
| **Family** | SQL (relational) |
| **Driver** | `mssql` (node-mssql / Tedious) |
| **Query language** | `sql` (T-SQL) |
| **Default port** | `1433` |
| **Connection pooling** | Yes — `mssql.ConnectionPool` (`min`/`max`/`idleTimeoutMillis`) |
| **Connection string** | UI paste only (`mssql://` / `sqlserver://` decomposed to fields — see §4.4) |
| **Transactions** | Yes — `mssql.Transaction` (no auto-rollback timeout) |
| **Query cancellation** | Yes — tracked `Request` + `request.cancel()` |
| **Source** | [`src/lib/db/providers/sql/mssql.ts`](../../src/lib/db/providers/sql/mssql.ts) |
| **Base** | [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) |
| **Tests** | [`tests/integration/db/mssql-provider.test.ts`](../../tests/integration/db/mssql-provider.test.ts) |

---

## 1. Overview

SQL Server maps onto the `DatabaseProvider` interface like the other SQL providers, via the `mssql`
(node-mssql) driver. Read this as a **diff against the [PostgreSQL provider](./postgres.md)** (the
SQL reference implementation). SQL Server is in several respects the **most fully-wired** SQL
provider — and it has a couple of distinct gaps too:

| Aspect | PostgreSQL | SQL Server |
|--------|------------|------------|
| Pagination | `LIMIT … OFFSET` | `TOP n` (no offset) / `OFFSET m ROWS FETCH NEXT n` (auto-adds `ORDER BY`) |
| Pool + timeouts | `min`/`max`/`idle`/`acquire` + `statement_timeout` | `min`/`max`/`idle` + `connectTimeout` (acquire) + **`requestTimeout` (query timeout) wired** |
| `rowCount` | driver `rowCount` | **`rowsAffected[0]`** (real affected count for DML) |
| Encryption | opt-in | **`encrypt: true` by default** (Azure-aware `trustServerCertificate`) |
| Schema | 1 MATERIALIZED-CTE round-trip | **5 bulk `sys.*` queries** grouped in memory |
| Blocked-session detection | always `false` | **real** (`blocking_session_id > 0`) |
| Index `scans` | real (`pg_stat_user_indexes.idx_scan`) | real (`dm_db_index_usage_stats`) — both real, unlike Oracle (`0`)/MySQL (`CARDINALITY`) |
| Transaction timeout | 5-minute auto-rollback | **none** |
| `connectionString` | passed to driver | **ignored by the provider** (UI decomposes URLs to fields) |
| Maintenance | vacuum / analyze / reindex / kill | `analyze` / `check` / `optimize` / `kill` |
| UI labels | default SQL | **overridden** (Update Statistics / Rebuild Indexes) |

---

## 2. Architecture

Same Strategy-Pattern hierarchy as the other SQL providers:

```
DatabaseProvider (interface) → BaseDatabaseProvider → SQLBaseProvider → MSSQLProvider
```

`MSSQLProvider` inherits the shared SQL helpers from
[`sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) (see
[PostgreSQL doc §2.2](./postgres.md#22-what-sqlbaseprovider-provides)) and **overrides**
`getCapabilities()`, `getLabels()`, `escapeIdentifier()` (bracket quoting), and `prepareQuery()`
(T-SQL pagination). Bind placeholders are `@p1`, `@p2`, … (`getPlaceholder()` from the base).

### Registration

Loaded on demand by the factory ([`factory.ts:82`](../../src/lib/db/factory.ts)):

```ts
case 'mssql': {
  const { MSSQLProvider } = await import('./providers/sql/mssql');
  return new MSSQLProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 Encryption on by default, Azure-aware

`buildConfig()` ([mssql.ts:111](../../src/lib/db/providers/sql/mssql.ts)) sets `encrypt: true` by
default (SQL Server 2022+ and the `mssql` v12 driver require encryption), and
`trustServerCertificate = !isAzure` — i.e. for **non-Azure** hosts it encrypts but **trusts a
self-signed certificate** (so on-prem dev servers connect without a CA), while **Azure**
(`*.database.windows.net`) validates the certificate. See [§4.3](#43-encryption--ssl) for the
explicit-`ssl` overrides and the [security caveat](#14-known-limitations--future-work).

### 3.2 T-SQL pagination: `TOP` and `OFFSET … FETCH`

`prepareQuery()` ([mssql.ts:557](../../src/lib/db/providers/sql/mssql.ts)) overrides the base. For a
limit-less `SELECT`: with no offset it injects `TOP n` right after `SELECT [DISTINCT]`; with an
offset it appends `OFFSET m ROWS FETCH NEXT n ROWS ONLY` — and because T-SQL requires an `ORDER BY`
for `OFFSET … FETCH`, it injects `ORDER BY (SELECT NULL)` when the query has none.

The two branches differ in where a **trailing** comment can reach them. `TOP` is spliced into the
head, so `SELECT * FROM t -- note` has always come back as `SELECT TOP n * FROM t -- note` and is
unchanged. The `OFFSET … FETCH` branch appends at the tail, so a trailing `-- note` used to swallow
its clause while this method reported `wasLimited: true`; it now appends at the end of the statement
as `src/lib/sql/statement-end.ts` delimits it, before any trailing comment and before the `;`, both
of which are re-attached verbatim. Whitespace written before the terminator is now preserved rather
than dropped, which is the only emitted-SQL difference on the `TOP` branch.

That reader also answers whether the end may be **cut**, and until #292 it could not answer it for a
statement ending in a `#` run — `SELECT * FROM #tmp` is everyday T-SQL, and the shared scanner had to
read it as a MySQL comment because nothing in the *text* distinguishes the two. The appending branch
therefore declined, and a temp-table page whose bound was followed by trailing trivia
(`… FETCH NEXT 10 ROWS ONLY -- daily`) hid that bound from the end-anchored probe, so a `TOP` was
spliced alongside an `OFFSET … FETCH` — which SQL Server rejects outright (Msg 10741).

`prepareQuery()` now passes its own `type` to the shared readers, and under T-SQL's grammar `#` is
never a comment: `#name` and `##name` are local and global temp tables. So the run is the statement's
own text, the end is cuttable, and both halves close together:

- `SELECT * FROM #tmp` still comes back as `SELECT TOP 500 * FROM #tmp` (the `TOP` splice writes into
  the head and never depended on the cut);
- `SELECT * FROM #tmp ORDER BY id` now takes a real page —
  `… OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY` — instead of being returned untouched;
- `SELECT * FROM #tmp … FETCH NEXT 10 ROWS ONLY -- daily` is recognised as already bounded and
  collects no `TOP`.

See
[Which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading).

That closed the common half of the same hazard. The other half is not about the hash at all: **wherever
the end may not be cut, no already-bounded probe is reading the statement's real tail.** Those probes
are anchored at the end of the statement's own text, and a refused cut reports the terminator strip as
that text — trailing whitespace and `;` removed and nothing else — so a real page written *before* a
trailing comment sits away from the anchor and reads as absent. A `TOP` was then spliced beside it and
SQL Server rejected the statement (Msg 10741): the query **failed** while this method reported a limit.
Reading a page that is not there is harmless (the statement is left alone); missing one that is there
is not, so where the cut is refused this provider asks the weaker question the situation allows — does
the text mention an `OFFSET` or a `FETCH` at all? — and declines when it does. The check is unanchored
and deliberately blunt: a column named `offset`, or a page belonging to a subquery, is enough to
decline, so such a statement keeps its full result set and is reported honestly as unbounded (#293).

One page form was invisible even where the end **is** cuttable: **`OFFSET n ROWS` with no `FETCH`
tail** is a complete T-SQL page, and the shared probes recognise only a `FETCH … ROWS ONLY` tail or a
bare `OFFSET n`. `SELECT … ORDER BY id OFFSET 10 ROWS` therefore collected a `TOP` — and with an offset
requested, a second `OFFSET … FETCH` appended beside the first. It is now read here rather than in the
shared limiter, since the form is this dialect's own and no other dialect's probes should move for it:
`OFFSET n ROW` and `OFFSET n ROWS` at the end of the statement are a page, and the statement is
returned untouched. The count must be a literal, exactly as the shared probes read — `OFFSET @skip
ROWS` is not recognised, so a parameterised page still collects a `TOP`, which is a known limitation
rather than a decision.

The same channel carries this dialect's bracket reading, and T-SQL's is the one the shared reader always
applied: **`[…]` is a delimited identifier**, everything between the brackets is the name (apostrophe,
comment marker and semicolon included), and a `]` inside one is written doubled — which is exactly what
`escapeIdentifier()` emits. That is now the dialect's stated answer rather than a shared default:
ClickHouse spells a nestable array with the same characters and gets the opposite reading (#295), and
teaching one scan to step over string literals inside the brackets — the naive way to serve both —
would have broken `SELECT [it's] FROM users`, which is legal here.

The `SELECT` it splices after is located with `src/lib/sql/leading-keyword.ts`, so a T-SQL comment
before the statement (`-- note` or `/* note */`) is skipped rather than defeating the injection. That
shared helper also skips `#`, which is a comment in MySQL only; T-SQL rejects a statement opening with
one either way, so skipping it changes which syntax error the server reports and nothing else.

**Block comments NEST here** — "Slash Star (Block Comment) (Transact-SQL)" states that a `/*` anywhere
inside a comment starts a nested one and requires its own `*/`, and that a missing closer is an error.
The shared reader used to end every comment at its first `*/`, and on this provider that mattered more
than a lost bound, because the `TOP` splice writes into the **head** at an index that reading chose:
`SELECT /* a /* b */ DISTINCT */ name FROM t` was read as a comment ending after `/* a /* b */`,
followed by a `DISTINCT` — which is inside the comment — so the `TOP` was spliced in after it, inside
the comment too. SQL Server saw `SELECT name FROM t` and ran it unbounded while this method reported
`wasLimited: true`. Under T-SQL's grammar the whole run is one comment, so the `TOP` goes before it,
and a `DISTINCT` written *after* the comment still takes the `TOP` after itself (#300). The same fact
bounds a read behind a leading nested comment (`/* a /* b */ x */ SELECT name FROM t`), declines on a
write a nested comment hid inside a CTE list, and declines where the comment carries one opener too
many and therefore never closes. Pinned in `tests/integration/db/mssql-provider.test.ts`.

`prepareQuery` **declines** rather than splicing in two cases, reporting `wasLimited: false` and
returning the statement untouched. It never reports a limit while handing back the statement unchanged.

- **No leading `SELECT`** — with no offset, a CTE, whose `TOP` belongs to the trailing `SELECT` that
  finding would need a parser. (With an offset a CTE takes the `OFFSET … FETCH` branch, which appends
  and so is genuinely bounded.)
- **A `TOP` already at the insertion point** — the statement is bounded but the shared already-bounded
  probe missed it, because that probe wants literal whitespace between `SELECT` and `TOP`, which both a
  comment (`SELECT/* c */TOP 10 …`) and a `DISTINCT` defeat. Splicing would emit `SELECT TOP n TOP 10`
  and a syntax error.
- **A T-SQL page at the end of the statement** (`… ORDER BY id OFFSET 10 ROWS`) — a bound the shared
  probes do not recognise, and a clause beside it is a rejected statement.
- **An end that may not be cut, in a statement mentioning `OFFSET` or `FETCH`** — the already-bounded
  probes cannot be trusted there, so a page cannot be ruled out.

The `OFFSET … FETCH` branch declines in one further case of its own: **any end that may not be cut** —
a trailing `#` run under the dialect-less reading, a quote behind an odd backslash run, an unterminated
comment or bracket. It has nowhere to append; the `TOP` branch, which splices into the head, keeps
bounding such a statement unless the rule above applies to it.

### 3.3 Five-query schema introspection, cross-schema

`getSchema()` ([mssql.ts:369](../../src/lib/db/providers/sql/mssql.ts)) runs **five bulk queries**
(tables via `sys.tables`/`sys.partitions`, columns via `INFORMATION_SCHEMA.COLUMNS`, primary keys,
foreign keys via `sys.foreign_keys`, indexes via `sys.indexes`) over the connected database, then
groups them in memory keyed by `schema.table`. Tables in the **`dbo`** schema are shown by bare
name; tables in any other schema are prefixed (`sales.orders`). There is no
`getSchemaList()`/`getSchemaRelations()` (no two-phase split) and no `size` field on the returned
tables. Row counts come from `SUM(sys.partitions.rows)`.

### 3.4 `rowsAffected` is surfaced

Unlike the MySQL/Oracle providers (which report `rows.length`), `query()` sets
`rowCount = result.rowsAffected?.[0] ?? recordset.length` ([mssql.ts:241](../../src/lib/db/providers/sql/mssql.ts)),
so a non-`SELECT` statement returns its real affected-row count.

### 3.5 A query timeout *is* wired (driver-enforced)

`buildConfig()` maps `ProviderOptions.queryTimeout` to the driver's `requestTimeout` and
`pool.acquireTimeout` to `connectTimeout`. So — unlike MySQL and Oracle, which wire no query timeout
at all — SQL Server **does** impose a request timeout: `requestTimeout` is enforced **client-side by
the `mssql`/Tedious driver** (it aborts the request and signals the server), not a server-enforced
statement timeout like Postgres's `statement_timeout`. An overrunning query still surfaces as a
`TimeoutError`.

### 3.6 No transaction auto-rollback timeout

Like Oracle (and unlike Postgres/MySQL), transactions use an `mssql.Transaction` with **no**
5-minute auto-rollback timer ([mssql.ts:303](../../src/lib/db/providers/sql/mssql.ts)).

### 3.7 Named-instance support

If `config.instanceName` is set, it is passed as `options.instanceName` and the explicit `port` is
**deleted** — the SQL Server Browser service negotiates the port ([mssql.ts:150](../../src/lib/db/providers/sql/mssql.ts)).

---

## 4. Connection

### 4.1 Configuration

```ts
const conn = {
  id: 'ms-1', name: 'Reporting', type: 'mssql',
  host: 'localhost', port: 1433, database: 'AdventureWorks',
  user: 'sa', password: 'secret',
  instanceName: 'SQLEXPRESS',   // optional named instance (port then auto-negotiated)
  createdAt: new Date(),
};
```

`validate()` ([mssql.ts:94](../../src/lib/db/providers/sql/mssql.ts)) requires `host` **and**
`database` (when no connection string is set — but note [§4.4](#44-connection-string-nuance)).
SQL authentication only (`user`/`password`); Windows/AAD auth is not wired.

### 4.2 Connection pooling

`connect()` builds an `mssql.ConnectionPool` and validates it with `SELECT 1`. Mapping
([mssql.ts:111](../../src/lib/db/providers/sql/mssql.ts)):

| `mssql` config | Value | Source |
|----------------|-------|--------|
| `pool.min` | 2 | `ProviderOptions.pool.min` |
| `pool.max` | 10 | `ProviderOptions.pool.max` |
| `pool.idleTimeoutMillis` | 30000 | `ProviderOptions.pool.idleTimeout` |
| `options.connectTimeout` | 60000 | `ProviderOptions.pool.acquireTimeout` |
| `options.requestTimeout` | 60000 | `ProviderOptions.queryTimeout` |

This is the most complete pool/timeout mapping of any SQL provider. `getPoolStats()`
([mssql.ts:702](../../src/lib/db/providers/sql/mssql.ts)) exposes
`{ total: size, idle: available, active, waiting: pending }`.

#### Pool errors are handled, not fatal

`mssql.ConnectionPool` is an `EventEmitter` and emits `error` in two situations: a background
connection failure (a tedious connection error that is not `ESOCKET`) and a failed acquire. An
`error` event with no listener is an uncaught exception, so `connect()` attaches a listener the
moment the pool is constructed — otherwise either situation would take the whole server process
down. The listener only reports (bracketed-prefix `console.error`, this file's convention): a failed
acquire **also** rejects the caller's promise, so nothing may be swallowed here.

PostgreSQL carries the same guard for its idle clients
([postgres.md](./postgres.md#42-connection-pooling)). MySQL and Oracle do not, because mysql2 and
oracledb expose no pool-level `error` event — that audit result is recorded at each of those
providers' `connect()`.

### 4.3 Encryption / SSL

`buildConfig()` resolves transport encryption from `connection.ssl`:

| `connection.ssl.mode` | `encrypt` | `trustServerCertificate` |
|-----------------------|-----------|--------------------------|
| *(unset)* | `true` | `false` for Azure, **`true`** for non-Azure |
| `disable` | `false` | — |
| `require` | `true` | `true` (encrypt, skip cert validation) |
| `verify-ca` / `verify-full` | `true` | `false` (validate the certificate) |

See the [non-Azure trust caveat](#14-known-limitations--future-work).

### 4.4 Connection-string nuance ⚠️

`getCapabilities().supportsConnectionString` is `true` and the UI parser accepts both `mssql://` and
`sqlserver://` URLs — but it **decomposes them into discrete fields** (`host`/`port`/`user`/`password`/
`database`) before they reach the provider. `buildConfig()` itself **never reads
`config.connectionString`**; it always builds from the discrete fields (defaulting `host` to
`localhost`). So a config carrying *only* a raw `connectionString` would be built against
`localhost` with the other fields unset — i.e. it targets an unintended server (and would likely
fail on the missing user/password/database) rather than honouring the URL. In practice the
connection always has discrete fields because the UI populates them.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([mssql.ts:203](../../src/lib/db/providers/sql/mssql.ts)) takes a
`Request` from the pool, optionally records it under `queryId` for cancellation, binds params as
`@p1`, `@p2`, … via `request.input()`, runs the query, and returns:

```ts
{ rows: recordset, fields, rowCount: rowsAffected[0] ?? recordset.length, executionTime }
```

Native `mssql` errors are normalised through `mapDatabaseError()` (see [§11](#11-error-handling)).

### 5.2 Query cancellation

A query issued with a `queryId` stores its `Request`. `cancelQuery(queryId)`
([mssql.ts:247](../../src/lib/db/providers/sql/mssql.ts)) returns `false` if no `Request` is tracked
for that id; otherwise it calls `request.cancel()` and returns `true` as long as that call doesn't
throw — it does **not** confirm the cancellation actually took effect. Exposed via `POST /api/db/cancel`.

### 5.3 Data-type & parameter handling ⚠️

- **Parameters are bound without an explicit SQL type.** `query()` calls
  `request.input(\`p${i+1}\`, value)` ([mssql.ts:218](../../src/lib/db/providers/sql/mssql.ts)) and
  lets `mssql` **infer** the TDS type from the JS value. Inference is convenient but a known
  foot-gun: `null` params, very large integers, and `VARCHAR` vs `NVARCHAR` intent can be guessed
  wrong. Callers needing exact typing would have to bind explicitly (not currently exposed).
- **Numeric precision.** `BIGINT`, `DECIMAL`/`NUMERIC`, and `MONEY` are surfaced as JavaScript
  `number`s and can **lose precision** beyond 2^53 / at high scale (the same class of issue as
  Oracle's `NUMBER`). Fetching them as strings would preserve fidelity.
- **Binary** (`VARBINARY`/`IMAGE`/`rowversion`) comes back as a Node `Buffer` and is **not**
  sanitized to a hex string (contrast the MySQL provider's `sanitizeRow`).
- **Only the first result set is returned.** `query()` reads `result.recordset` (singular), so a
  multi-statement batch or a stored procedure returning several result sets surfaces just one.

---

## 6. Transactions

Explicit lifecycle via `mssql.Transaction` ([mssql.ts:303](../../src/lib/db/providers/sql/mssql.ts)),
**no auto-rollback timeout** ([§3.6](#36-no-transaction-auto-rollback-timeout)). Surfaced via
`POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction()` | `new mssql.Transaction(pool)` + `begin()`. Throws if one is active. |
| `queryInTransaction(sql, params?)` | Runs on a `new mssql.Request(transaction)`. Throws if none active. |
| `commitTransaction()` / `rollbackTransaction()` | `commit()`/`rollback()`. Throws if none active. |
| `isInTransaction()` | Current state. |

---

## 7. Schema introspection

Five bulk queries grouped in memory (see [§3.3](#33-five-query-schema-introspection-cross-schema)):

| Data | Source |
|------|--------|
| Tables + row count | `sys.tables` + `sys.partitions` (`SUM(rows)`, `index_id IN (0,1)`) |
| Columns | `INFORMATION_SCHEMA.COLUMNS` (`isPrimary` from the PK set) |
| Primary keys | `sys.indexes` (`is_primary_key = 1`) + `sys.index_columns` |
| Foreign keys | `sys.foreign_keys` + `sys.foreign_key_columns` |
| Indexes | `sys.indexes` (`is_primary_key = 0`) + `sys.index_columns` |

No two-phase split; `dbo` tables are bare, other schemas prefixed.

---

## 8. Monitoring & health

All from `sys.dm_*` DMVs (and `sys.database_files`); `getMonitoringData()` (inherited) fans them out
in parallel. Each sub-query is independently privilege-guarded (DMVs need `VIEW SERVER STATE`).

| Method | Primary source | Notes |
|--------|----------------|-------|
| `getHealth()` | `dm_exec_sessions`, `database_files`, `dm_os_performance_counters`, `dm_exec_query_stats` | connections, size, buffer-cache-hit %, top-5 slow queries, 10 sessions; each block guarded → `N/A`/`0`/`[]` |
| `getOverview()` | `@@VERSION`, `dm_os_sys_info`, `dm_exec_sessions`, `sys.configurations`, `database_files`, `sys.tables`/`indexes` | `user connections = 0` → reported as 32767 (unlimited) |
| `getPerformanceMetrics()` | `dm_os_performance_counters` | **only** cache-hit ratio + buffer-pool usage (no QPS/deadlocks); defaults `100` |
| `getSlowQueries()` | `dm_exec_query_stats` ⋈ `dm_exec_sql_text` | `sharedBlksHit`=logical reads, `sharedBlksRead`=physical reads; `[]` on failure |
| `getActiveSessions()` | `dm_exec_sessions` ⋈ `dm_exec_requests` ⋈ `dm_exec_sql_text` | **`blocked` is real** (`blocking_session_id > 0`); wait types; `[]` on failure |
| `getTableStats()` | `sys.tables`/`partitions`/`allocation_units` | sizes + `lastAnalyze` (`STATS_DATE`); no live/dead tuples; `[]` on failure |
| `getIndexStats()` | `sys.indexes`/`allocation_units` + `dm_db_index_usage_stats` | **`scans` is real** (seeks+scans+lookups); `[]` on failure |
| `getStorageStats()` | `sys.database_files` | per-file name/path/size; `[]` on failure |

SQL Server is the only provider that reports **real blocked-session detection** (`blocking_session_id`;
Postgres/Oracle/MySQL report `blocked: false`). For **index scan counts** it joins
`dm_db_index_usage_stats` — real usage data, the same calibre as Postgres's `pg_stat_user_indexes.idx_scan`
(whereas Oracle reports `0` and MySQL substitutes `CARDINALITY`).

---

## 9. Maintenance

`runMaintenance(type, target?)` ([mssql.ts:637](../../src/lib/db/providers/sql/mssql.ts)); targets
are bracket-escaped (`]` → `]]`):

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `UPDATE STATISTICS [<t>]` | `EXEC sp_updatestats` |
| `check` | `DBCC CHECKDB WITH NO_INFOMSGS` | same (target ignored) |
| `optimize` | `ALTER INDEX ALL ON [<t>] REBUILD` | rebuild every user table's indexes via generated `sp_executesql` |
| `kill` | `KILL <spid>` | throws (SPID required) |

`getCapabilities().maintenanceOperations = ['analyze', 'check', 'optimize', 'kill']`. `kill`
validates the target parses as an integer SPID.

---

## 10. Capabilities & labels

### `getCapabilities()` ([mssql.ts:57](../../src/lib/db/providers/sql/mssql.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | **`false`** (intentionally disabled — see [Known limitations](#14-known-limitations--future-work)) |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core T-SQL DML |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'check', 'optimize', 'kill']` |
| `supportsConnectionString` | `true` (UI-only — see [§4.4](#44-connection-string-nuance)) |
| `defaultPort` | `1433` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

### Labels — overridden ([mssql.ts:67](../../src/lib/db/providers/sql/mssql.ts))

`analyzeAction` → *"Update Statistics"*, `vacuumAction` → *"Rebuild Indexes"*, plus the matching
global labels. The UI display name for the database type is *"SQL Server"* (`db-ui-config.ts`).

---

## 11. Error handling

`mapDatabaseError()` ([errors.ts](../../src/lib/db/errors.ts)) has **SQL-Server-specific** branches:

| Situation | Error |
|-----------|-------|
| Missing `host`/`database` (no connection string) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` (carries host/port) |
| Message contains *login failed* | `AuthenticationError` |
| *Cannot open database* | `ConnectionError` |
| Cancellation messages (*canceling statement*, *query was cancelled*, *query execution was interrupted*, *kill query*) | `QueryCancelledError` — matched **before** the timeout check |
| `requestTimeout` exceeded (message contains *timeout*) | `TimeoutError` |
| Other errors | generic `QueryError` / `DatabaseError` with the original message |

Because `requestTimeout` *is* wired ([§3.5](#35-a-query-timeout-is-wired-driver-enforced)) — even
though it's driver-enforced rather than server-side — an overrunning query genuinely produces a
`TimeoutError` here (contrast MySQL/Oracle, which wire no query timeout).

---

## 12. Testing

### 12.1 How the tests work

Integration tests live in
[`tests/integration/db/mssql-provider.test.ts`](../../tests/integration/db/mssql-provider.test.ts).
The `mssql` module is replaced with an in-process mock via `mock.module('mssql', …)` **before** the
provider is imported — there is no live SQL Server in the suite. The mock's pool/request returns
canned `{ recordset, rowsAffected }` results, exercising the same code paths as the real driver.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide; files mocking different drivers
> cross-contaminate in a shared process. A **single file** is safe (one file = one process). The
> full `bun run test` script runs the core group in **one** process and is load-order flaky, so
> **CI does not use it** — the deterministic runner is **`bun run test:ci`** (per-file isolation via
> `tests/run-core.sh`); the coverage workflow uses `bun run test:coverage`. See [`CLAUDE.md`](../../CLAUDE.md).

### 12.2 Coverage

The suite covers: validation, connect/disconnect, query, capabilities, **labels override**,
**`prepareQuery` TOP / OFFSET-FETCH**, `getSchema` (columns/PKs/FKs/indexes grouping), health,
maintenance (analyze/check/optimize/kill + SPID validation), pool stats, the transaction lifecycle,
query cancellation, overview, performance metrics, slow queries, active sessions (incl. blocked),
table/index/storage stats, and error mapping.

### 12.3 Run it

```bash
bun test tests/integration/db/mssql-provider.test.ts   # just this file (single process — safe)
bun run test:ci                                         # CI publish gate — per-file isolation (tests/run-core.sh)
bun run test:coverage                                   # CI coverage workflow — per-file core + components
```

### 12.4 Optional: verifying against a live SQL Server

```bash
docker run --rm -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Str0ng!Passw0rd' \
  -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
# then connect to localhost:1433 (user sa) in the Studio UI
```

---

## 13. Usage examples

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'ms1', name: 'Reporting', type: 'mssql',
  host: 'localhost', port: 1433, database: 'AdventureWorks',
  user: 'sa', password: 'secret', createdAt: new Date(),
});

await provider.connect();
const res = await provider.query('SELECT id, email FROM users WHERE active = @p1', [1]);
const schema = await provider.getSchema();   // 5 sys.* queries, grouped in memory
await provider.disconnect();
```

Over the API: `POST /api/db/query`, `POST /api/db/transaction`, `POST /api/db/cancel`,
`POST /api/db/maintenance` (admin), `POST /api/db/schema/list` (falls back to `getSchema()`).

---

## 14. Known limitations & future work

- **`connectionString` is ignored by the provider.** `getCapabilities().supportsConnectionString` is
  `true` and the UI accepts `mssql://`/`sqlserver://`, but `buildConfig()` builds only from discrete
  fields and never reads `config.connectionString` ([§4.4](#44-connection-string-nuance)). A
  config carrying only a raw connection string would connect to `localhost`. *Future:* pass a raw
  connection string through to the driver, or set the capability honestly.
- **`EXPLAIN` is intentionally disabled for SQL Server until a dialect wrapper exists.**
  `supportsExplain` is `false`, so the UI hides the *Explain* action. The UI's EXPLAIN builder only
  handles Postgres/MySQL; before the flag was flipped, the *Explain* action silently ran the
  **unmodified** query instead of a plan. *Future:* `SET SHOWPLAN_XML ON` (or `SET STATISTICS
  XML ON`) around the statement, then re-enable the capability.
- **Non-Azure default trusts the server certificate.** With no explicit `connection.ssl`, non-Azure
  hosts use `encrypt: true` + `trustServerCertificate: true` — encrypted but **not** authenticated
  (MITM-exposed). For verified TLS, set `connection.ssl` mode `verify-ca`/`verify-full`. (Azure hosts
  validate by default.)
- **Binary columns aren't sanitized.** `VARBINARY`/`IMAGE`/`rowversion` come back as Node `Buffer`s
  and serialize to the grid as `Buffer` JSON (no `0x…` hex conversion like the MySQL provider) — see
  [§5.3](#53-data-type--parameter-handling).
- **Numeric precision loss** — `BIGINT`/`DECIMAL`/`NUMERIC`/`MONEY` are returned as JS `number`s and
  can lose precision; they would need to be fetched as strings to stay exact ([§5.3](#53-data-type--parameter-handling)).
- **Parameters bound without explicit types** — relies on `mssql` type inference, which can mis-type
  `null`/large-integer/`NVARCHAR` values ([§5.3](#53-data-type--parameter-handling)).
- **A parameterised page is not recognised as one.** The already-bounded probes read a literal count,
  so `… OFFSET @skip ROWS [FETCH NEXT @take ROWS ONLY]` still looks unbounded and collects a `TOP`,
  which SQL Server rejects beside it (Msg 10741) — the statement fails rather than returning too many
  rows ([§3.2](#32-t-sql-pagination-top-and-offset--fetch)). *Future:* accept a variable or an
  expression as the count.
- **No Always On / high-availability options.** `MultiSubnetFailover` (fast failover to an
  availability-group listener) and `ApplicationIntent=ReadOnly` (read-only routing to a readable
  secondary) are not set — both are common requirements for enterprise HA SQL Server. *Future:*
  surface them as connection options.
- **Azure SQL caveats.** Some server-scoped DMVs and `DBCC CHECKDB` behave differently or are
  restricted on Azure SQL Database, so parts of monitoring/maintenance silently degrade
  (`N/A`/`0`/`[]`) there.
- **SQL authentication only** — Windows Integrated / Azure AD auth is not wired.
- **No two-phase schema loading** — `/api/db/schema/list` falls back to the full `getSchema()`.
- **DMV monitoring needs `VIEW SERVER STATE`**; a least-privilege user silently gets `N/A`/`0`/`[]`.
  `getPerformanceMetrics()` reports only cache-hit ratio (no QPS/deadlocks).

---

## 15. References

- Driver: [`node-mssql`](https://github.com/tediousjs/node-mssql) (Tedious / TDS)
- Source: [`src/lib/db/providers/sql/mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors (incl. SQL Server mapping): [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/mssql-provider.test.ts`](../../tests/integration/db/mssql-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [Redis](./redis.md)
