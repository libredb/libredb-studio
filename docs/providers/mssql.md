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
(T-SQL pagination). Bind placeholders are `@p1`, `@p2`, ….

### Registration

Loaded on demand by `createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)):

```ts
case 'mssql': {
  const { MSSQLProvider } = await import('./providers/sql/mssql');
  return new MSSQLProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 Encryption on by default, Azure-aware

`buildConfig()` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) sets `encrypt: true` by
default (SQL Server 2022+ and the `mssql` v12 driver require encryption), and
`trustServerCertificate = !isAzure` — i.e. for **non-Azure** hosts it encrypts but **trusts a
self-signed certificate** (so on-prem dev servers connect without a CA), while **Azure**
(`*.database.windows.net`) validates the certificate. See [§4.3](#43-encryption--ssl) for the
explicit-`ssl` overrides and the [security caveat](#14-known-limitations--future-work).

### 3.2 T-SQL pagination: `TOP` and `OFFSET … FETCH`

`prepareQuery()` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) overrides the base. For a
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

`getSchema()` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) runs **five bulk queries**
(tables via `sys.tables`/`sys.partitions`, columns via `INFORMATION_SCHEMA.COLUMNS`, primary keys,
foreign keys via `sys.foreign_keys`, indexes via `sys.indexes`) over the connected database, then
groups them in memory keyed by `schema.table`. Tables in the **`dbo`** schema are shown by bare
name; tables in any other schema are prefixed (`sales.orders`). There is no
`getSchemaList()`/`getSchemaRelations()` (no two-phase split) and no `size` field on the returned
tables. Row counts come from `SUM(sys.partitions.rows)`.

### 3.4 `rowsAffected` is surfaced

Unlike the MySQL/Oracle providers (which report `rows.length`), `query()` sets
`rowCount = result.rowsAffected?.[0] ?? recordset.length` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)),
and `queryInTransaction()` repeats the same expression, so a non-`SELECT` statement returns its real
affected-row count.

### 3.5 A query timeout *is* wired (driver-enforced)

`buildConfig()` maps `ProviderOptions.queryTimeout` to the driver's `requestTimeout` and
`pool.acquireTimeout` to `connectTimeout`. So — unlike MySQL and Oracle, which wire no query timeout
at all — SQL Server **does** impose a request timeout: `requestTimeout` is enforced **client-side by
the `mssql`/Tedious driver** (it aborts the request and signals the server), not a server-enforced
statement timeout like Postgres's `statement_timeout`. An overrunning query still surfaces as a
`TimeoutError`.

### 3.6 No transaction auto-rollback timeout

Like Oracle (and unlike Postgres/MySQL), transactions use an `mssql.Transaction` with **no**
5-minute auto-rollback timer (`beginTransaction()`, [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)).

### 3.7 Named-instance support

If `config.instanceName` is set, it is passed as `options.instanceName` and the explicit `port` is
**deleted** — the SQL Server Browser service negotiates the port (`buildConfig()`, [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)).

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

`validate()` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) requires `host` **and**
`database` (when no connection string is set — but note [§4.4](#44-connection-string-nuance)).
SQL authentication only (`user`/`password`); Windows/AAD auth is not wired.

### 4.2 Connection pooling

`connect()` builds an `mssql.ConnectionPool` and validates it with `SELECT 1`. Mapping
(`buildConfig()`, [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)):

| `mssql` config | Value | Source |
|----------------|-------|--------|
| `pool.min` | 2 | `ProviderOptions.pool.min` |
| `pool.max` | 10 | `ProviderOptions.pool.max` |
| `pool.idleTimeoutMillis` | 30000 | `ProviderOptions.pool.idleTimeout` |
| `options.connectTimeout` | 60000 | `ProviderOptions.pool.acquireTimeout` |
| `options.requestTimeout` | 60000 | `ProviderOptions.queryTimeout` |

This is the most complete pool/timeout mapping of any SQL provider. `getPoolStats()`
([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) exposes
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
| `verify-system` / `verify-ca` / `verify-full` | `true` | `false` (validate the certificate) |

The three verifying modes are **one call** here, and deliberately: tedious exposes a single knob,
`trustServerCertificate`, and turning it off already means "validate the chain and the name against
the host's own trust store". There is no separate CA channel — `connection.ssl.caCert` is not read by
this provider at all — so `verify-system` (D26) needs nothing added, and `verify-ca`/`verify-full` do
not deliver the CA pinning their names promise. Pinned by
`tests/integration/db/mssql-provider.test.ts` ("the TLS options handed to tedious"), so a future
mode cannot fall through to the trusting branch unnoticed.

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

The decomposition includes TLS. An ADO.NET keyword string
(`Server=host,1433;Database=db;Encrypt=True;TrustServerCertificate=True;`) and the query-string form
(`mssql://host/db?encrypt=true&trustServerCertificate=true`) both reach the form with SSL Mode set,
values matched case-insensitively because ADO.NET writes `True`:

| `Encrypt` | `TrustServerCertificate` | SSL Mode | Why |
|-----------|--------------------------|----------|-----|
| `False` / `No` | any | `disable` | Not encrypted |
| `True` / `Yes` | `True` / `Yes` | `require` | Encrypted, chain unchecked |
| `True` / `Yes` | `False` / `No` / absent | `verify-full` | The documented default validates chain **and** name |
| `Strict` | ignored | `verify-full` | TDS 8.0 always validates |
| absent | any | *unset* | `System.Data.SqlClient` defaults it to false, `Microsoft.Data.SqlClient` 4.0+ to true — the string does not carry the answer |

Any other spelling of either keyword is reported in the paste banner and leaves the form's SSL Mode
untouched rather than falling back to `disable`.

`verify-system` is not produced by this parser: `Encrypt=True` with `TrustServerCertificate` off is
`verify-full` already, and since all three verifying modes build the same tedious call, translating it
to the newer name would change the wording on the form without changing a single option on the wire.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) takes a
`Request` from the pool, optionally records it under `queryId` for cancellation, binds params as
`@p1`, `@p2`, … via `request.input()`, runs the query, and returns:

```ts
{ rows: recordset, fields, rowCount: rowsAffected[0] ?? recordset.length, executionTime, columnTypes? }
```

Native `mssql` errors are normalised through `mapDatabaseError()` (see [§11](#11-error-handling)).

### 5.2 Query cancellation

A query issued with a `queryId` stores its `Request`. `cancelQuery(queryId)`
([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) returns `false` if no `Request` is tracked
for that id; otherwise it calls `request.cancel()` and returns `true` as long as that call doesn't
throw — it does **not** confirm the cancellation actually took effect. Exposed via `POST /api/db/cancel`.

### 5.3 Data-type & parameter handling ⚠️

- **Parameters are bound without an explicit SQL type.** `query()` calls
  `request.input(\`p${i+1}\`, value)` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) and
  lets `mssql` **infer** the TDS type from the JS value. Inference is convenient but a known
  foot-gun: `null` params, very large integers, and `VARCHAR` vs `NVARCHAR` intent can be guessed
  wrong. Callers needing exact typing would have to bind explicitly (not currently exposed).
- **Numeric precision.** `BIGINT`, `DECIMAL`/`NUMERIC`, and `MONEY` are surfaced as JavaScript
  `number`s and can **lose precision** beyond 2^53 / at high scale (the same class of issue as
  Oracle's `NUMBER`). Fetching them as strings would preserve fidelity.
- **Binary** (`VARBINARY`/`IMAGE`/`rowversion`) comes back as a Node `Buffer` and is **not**
  stringified by the provider, so it reaches the client as the JSON shape a `Buffer` serializes to and
  is rendered as hex there (§7). Every provider answers this way since 2026-08-24, when MySQL and
  Cassandra stopped spelling their bytes `0x…` in the provider.
- **Only the first result set is returned.** `query()` reads `result.recordset` (singular), so a
  multi-statement batch or a stored procedure returning several result sets surfaces just one.

### 5.4 Declared column types

`mssql` attaches a `columns` map to the recordset, and each entry's `type` carries a `declaration` -
T-SQL's own lowercase spelling. That is passed through into `QueryResult.columnTypes`
([column-types.ts](../../src/lib/db/providers/sql/column-types.ts)) by both `query()` and
`queryInTransaction()`, keyed by the column name. `type` is a factory FUNCTION for some of the
driver's types and a plain object for others; `declaration` is on both.

Measured on SQL Server 2022 CU26 over the probe table:

| declared | `type.name` | `type.declaration` |
|---|---|---|
| `BIGINT` | `BigInt` | `bigint` |
| `DECIMAL(10,2)` | `Decimal` | `decimal` (with `precision: 10, scale: 2` beside it) |
| `FLOAT` | `Float` | `float` |
| `BIT` | `Bit` | `bit` |
| `NVARCHAR(40)` | `NVarChar` | `nvarchar` (`length: 80` - bytes, not characters) |
| `VARCHAR(MAX)` | `VarChar` | `varchar` (`length: 65535`, a sentinel rather than the real 2^31-1) |
| `DATETIME2` / `DATE` | `DateTime2` / `Date` | `datetime2` / `date` |
| `UNIQUEIDENTIFIER` | `UniqueIdentifier` | `uniqueidentifier` |
| `VARBINARY(50)` | `VarBinary` | `varbinary` |

`declaration` rather than `type.name`, because it is the word T-SQL uses:
`INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` answers `bigint`, not `BigInt`, for every one of those
columns, so a declared type reads like the schema tree's entry. The length, precision and scale are
left out of the name for the reason the `length` column above shows - they are reported in units that
do not survive being spelled back (80 bytes for 40 characters, a sentinel for `MAX`).

This is the only source of a type for a computed column or an ad-hoc projection. It matters here
because `BIGINT` and `DECIMAL` reach the browser as strings (§5.3): measured before this existed, the
probe table's `BIGINT` and `UNIQUEIDENTIFIER` columns both exported as `NVARCHAR(MAX)` and its
`DECIMAL(10,2)` as `FLOAT`. Both execution paths fill it from the same column map - including
`queryInTransaction()`, which had the map available all along and simply never read it.

---

## 6. Transactions

Explicit lifecycle via `mssql.Transaction` (`beginTransaction()`, [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)),
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

### The object surface (#789)

`getSchema()` above is the flat model: five bulk reads, tables only, one flat list of names. The
object surface replaces it with four container-aware methods (`listContainers`, `countObjects`,
`listObjects`, `describeObject`) declared in [`types.ts`](../../src/lib/db/types.ts) and implemented
in [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts). Both surfaces are live through Phase 1; the
phase that removes `getSchema()` is #789's last task.

Everything measured below was measured against **SQL Server 2022 CU26 (16.0.4265.3)** on Linux with
the fixture in [`docker/mssql-init/01-object-fixture.sql`](../../docker/mssql-init/01-object-fixture.sql).

#### Two container levels, which is a first in #789

```ts
containerLevels: [
  { id: 'catalog', label: 'Database', labelPlural: 'Databases' },
  { id: 'schema',  label: 'Schema',   labelPlural: 'Schemas'   },
]
```

An instance holds databases and each database holds schemas, and both are reachable from ONE
connection: a three-part name (`[other_db].sys.schemas`) reads another database's catalog views, so
the outer level is a real container here rather than a second connection. Every engine in #789
before this one declared at most one level, so two consequences that no single-level provider can
distinguish are pinned here for the whole fleet (standing ruling 5g):

- `describeObject` binds **the last path segment** as the object's name, never `path[1]`. On a
  one-level engine those are the same expression; here `path[1]` is the SCHEMA, and binding it as
  the name reads a table called `app` and reports an object that exists as missing.
- The container helpers read **`containerDepth()`** rather than comparing a length to a literal. A
  `container.length !== 1` is correct on every single-level engine and refuses every schema-level
  read on this one.
- A path becomes **named segments** through `containerSegments()`, which cuts it to
  `containerDepth()` and keys each segment by its declared `ContainerLevelSpec.id`. Nothing reads
  `container[0]` or `path[0]` for the catalog or `path[1]` for the schema: this is the spelling that
  survived two providers, because it is depth-identical wherever the schema really is at index 0.

All three are pinned by assertions that reach the BIND rather than stopping at a refusal: the
detail reads assert `{ schema, name }` for `app.orders` and again for `reporting.daily`, where the
catalog, the schema and the object name are three different strings.

A segment a declaration has no level for is a refusal and never an interpolated `undefined`: a copy
of this provider declaring only a `schema` level would pass the length check and then have no
catalog to three-part name with, and `[undefined].sys.objects` asks a real server about a database
nobody has.

Two smaller shapes come from the same ruling. A kind id is an open string, so the type lookup is
`Object.hasOwn` and not a bare index, or `MSSQL_OBJECT_TYPES['toString']` would answer a function
off the prototype chain and carry it into a statement. And paths are ordered **segment by segment**,
never through `JSON.stringify`: this engine puts `[db, name]` and `[db, schema, table, name]` rows
in one trigger folder, and a serialised key sorts the deeper path before its own prefix (`,` is
0x2C, `]` is 0x5D) and re-orders exotic names on characters JSON invented - `a"b` serialises to
`a\"b` and sorts after `a0b`, while the segments sort the other way. Both names are legal DDL
trigger names, measured.

A container path may be a database alone or a database and a schema, and both are true questions:
the tree draws kind folders only at the deepest level
([`flatten.ts`](../../src/components/object-tree/flatten.ts)), but `assertContainerDepth` in
[`object-route.ts`](../../src/lib/api/object-route.ts) admits any path down to the declared depth and
the shared conformance helper reads counts at the OUTER one. A database-level read answers for the
whole database, and for every kind except `trigger` it equals the sum over the schemas
`listContainers` lists. Measured on the fixture:

| Read | table | view | procedure | function | trigger | synonym | sequence |
|---|---|---|---|---|---|---|---|
| `countObjects(['libredb_objects'])` | 5 | 1 | 1 | 3 | **4** | 1 | 1 |
| `countObjects(['libredb_objects','app'])` | 4 | 1 | 1 | 3 | 1 | 1 | 1 |
| `countObjects(['libredb_objects','reporting'])` | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| sum over the listed schemas | 5 | 1 | 1 | 3 | **2** | 1 | 1 |

Four of those five tables are in `app`, and two of the four are the halves of the temporal pair
below: a table count of 3 here would be this table describing a fixture that no longer exists.
The only column that does not add up is `trigger`, for the reason underneath.

That trigger column is the engine: the two DATABASE-scoped DDL triggers belong to no schema, so
they are counted at the database level only, which is also the depth their address has.

#### Seven kinds, and the catalog that answers for each

| Kind | `role` | `sys.objects.type` | Listing read | Note |
|---|---|---|---|---|
| `table` | `relation` | `U` | `sys.objects` ⋈ `sys.schemas` (+ `sys.partitions` for the row count) | `acceptsRowWrites: true` |
| `view` | `relation` | `V` | `sys.objects` ⋈ `sys.schemas` | not a row-write target; no `rowCount` key at all |
| `procedure` | `routine` | `P`, `PC`, `X` | `sys.objects` ⋈ `sys.schemas` | SQL, CLR and extended |
| `function` | `routine` | `FN`, `IF`, `TF`, `FS`, `FT`, `AF` | `sys.objects` ⋈ `sys.schemas` | one kind, six spellings |
| `trigger` | `attached` | **none** | `sys.triggers`, with `sys.objects` OUTER joined for the parent | `attachedTo: 'table'`; carries `status` |
| `synonym` | `config` | `SN` | `sys.objects` ⋈ `sys.schemas` | |
| `sequence` | `config` | `SO` | `sys.objects` ⋈ `sys.schemas` | |

`MSSQL_OBJECT_TYPES` in [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts) holds that third
column once; the counting statement's `CASE`, its `IN` list and every listing's `IN` list are all
derived from it, so a kind added to `objectKinds` without an entry fails loudly instead of drawing a
folder nothing can fill.

#### The vocabulary is the ENGINE's, not the fixture's

Standing ruling 5a (#789) asks which of the two a provider derived its type set from, so: **this one
is derived from Microsoft's documented `sys.objects.type` list**, with a decision recorded in
`MSSQL_OBJECT_TYPES` for every documented spelling. It is NOT a `SELECT DISTINCT` over a fixture,
and the difference is measurable here: that query over this repo's fixture server answers eighteen
spellings and **none of the six CLR ones**, because no assembly is registered on it. A vocabulary
taken from what happened to be present would drop a CLR stored procedure out of the count AND the
listing, invisible in the tree while ruling 5f still held, which is the defect task 10 found on
MariaDB.

Four documented spellings are user objects with no declared kind, and they are a **known gap**
rather than an oversight: `R` (a rule), `PG` (a plan guide), `RF` (a replication filter procedure)
and `TT` (a table type). The first three have no folder anywhere. `TT` is different and measured:
`CREATE TYPE ... AS TABLE` writes a `sys.objects` row named `TT_<type>_<hex>` carrying
`is_ms_shipped = 1`, so the predicate already drops it, and the object a person wrote lives in
`sys.types` rather than in `sys.objects` at all.

The table kind needed no widening for the variants that worry a reader, and that is measured rather
than assumed: a graph node or edge table, a memory-optimized table, an external table and **both
halves of a system-versioned temporal pair** are each `type = 'U'` with a flag beside it. The
fixture carries a temporal pair for exactly that reason, and both halves are counted and listed:

```
libredb_objects / app / order_audit           SYSTEM_VERSIONED_TEMPORAL_TABLE
libredb_objects / app / order_audit_history   HISTORY_TABLE
```

**No `index` kind**, on the same line PostgreSQL and Oracle are read against: `sys.indexes` is keyed
by `object_id` and an index cannot exist without one, so an index stays in `describeObject()`'s
output beside that object's columns rather than becoming a folder.

**No materialized view either**, because SQL Server has none. An indexed view is a `VIEW` with a
clustered index on it, so it is already in the Views folder with its index in the detail row.

**`name` is the last path segment for every kind here.** SQL Server has no routine overloading at
all - `CREATE FUNCTION app.order_total` with a second signature answers Msg 2714 - so no kind needs
the disambiguated segment a PostgreSQL routine needs.

#### A trigger is not in `sys.objects`, and that is the trap

Measured on the fixture: **`sys.objects` holds 2 triggers and `sys.triggers` holds 4.** A DDL
trigger is excluded from `sys.objects` entirely, so a count taken from `sys.objects` alone is short
by exactly the DDL triggers, and no assertion written against `sys.objects` can see it. Both the
count and the listing read `sys.triggers`, which is what standing ruling 5f requires: the listing
holds exactly what the count counted.

`sys.triggers` is the spine of the listing and `sys.objects` is OUTER joined for the parent, for the
same reason. A DML trigger has `parent_class = 1` and `parent_id` pointing at its base object; a
DATABASE-scoped DDL trigger has `parent_class = 0` and `parent_id = 0`, so there is no row to join
and both parent columns arrive NULL together. The two therefore sit at two DEPTHS in one folder:

```
libredb_objects / app / orders / stamp_order      a DML trigger, under its base object
libredb_objects / ddl_audit                       a DDL trigger, under the database
```

`describeObject` accepts both shapes. A trigger name is unique per SCHEMA on SQL Server rather than
per table as on PostgreSQL - a second `stamp_order` in one schema answers Msg 2714 - so the base
object segment is there because `attachedTo: 'table'` says the object hangs off it, not because
uniqueness needs it. The base object may also be a VIEW (an `INSTEAD OF` trigger), which the `table`
in `attachedTo` does not distinguish.

**`status` carries `ENABLED` / `DISABLED` for a trigger and nothing for any other kind.**
`sys.triggers.is_disabled` is the only state SQL Server publishes about an object of any declared
kind: there is no VALID / INVALID here, so there is no second vocabulary for the field to collide
with, which is why Oracle deliberately keeps ENABLED / DISABLED out of the same field and this
provider carries it.

**A SERVER-level DDL trigger is not addressable in Phase 1.** `sys.server_triggers` is server-wide
and visible from every database, so counting its rows under a database would report one trigger
once per catalog and give it an address it does not have. The tree has no level above a database, so
those triggers are absent from both the count and the listing. Tracked on #789.

#### `listContainers()`: the databases this login can open, then one database's schemas

```sql
SELECT d.name, CASE WHEN d.database_id = DB_ID() THEN 1 ELSE 0 END AS is_session_default
FROM sys.databases d
WHERE HAS_DBACCESS(d.name) = 1
  AND (SERVERPROPERTY('EngineEdition') <> 5 OR d.database_id = DB_ID())
ORDER BY d.name
```

`HAS_DBACCESS` is the engine's own answer to "can this login use this database", and it covers more
than permissions: measured, a database taken OFFLINE keeps its `sys.databases` row and answers 0
here. Listing it would draw a container whose schemas can never be read. `DB_ID()` rather than the
configured database name marks `Container.isSessionDefault`, because it is the server's own answer
for which database the session is in.

**Azure SQL Database (`EngineEdition = 5`) lists exactly the connected database.** It cannot run a
cross-database query at all, so every other catalog would draw a container that opens onto an error,
and answering an empty list there would be a lie about the database the caller is connected to. The
arm lives in the statement rather than in TypeScript so one read serves both editions. Managed
Instance (`8`) can query across databases and is deliberately NOT in that arm.

> **UNVERIFIED against a live Azure SQL Database.** No Azure instance was available, so this is
> implemented from the documented behaviour. What WAS measured is the arm itself: with the edition
> it tests inverted to `3` - what this fixture server reports - `listContainers()` answered exactly
> `libredb_objects` where the unmutated statement answers six databases.

The nested read is three-part named at the **caller's** database rather than at the connected one. A
database name cannot be bound as a parameter, so the catalog is interpolated through
`escapeIdentifier` (the same `]` doubling `runMaintenance` uses); a provider that dropped the segment
would answer the connected database's schemas under every catalog in the tree and look healthy doing
it. Measured: `listContainers(['libredb_objects_two'])` answers `db_owner, dbo, guest, warehouse`
while `listContainers(['libredb_objects'])` answers `app, dbo, guest, reporting`.

**The schema level marks `isSessionDefault` too, for the connected database only.**

```sql
SELECT s.name,
       CASE WHEN s.name = SCHEMA_NAME() THEN 1 ELSE 0 END AS is_session_schema,
       DB_NAME() AS connected_database
FROM [caller_db].sys.schemas s ...
```

`SCHEMA_NAME()` is the session's own default schema, `dbo` for a login that has not been given
another, and it is evaluated in the database the session is IN whichever catalog the statement is
three-part named at. So the flag is only about the connected database, and `DB_NAME()` travels back
with the rows for the provider to apply that restriction against the catalog it asked for. Comparing
in TypeScript rather than in SQL avoids interpolating a database NAME as a string literal beside the
identifier that is already interpolated as a name.

Why the level needs it at all: first paint walks the container chain down to the session default at
the DEEPEST declared level and reads the counts there (#789). An engine that marks only its outer
level opens a database and stops, with no folder and no count. This is the only two-level engine, so
it is the only one where the distinction exists.

> **UNVERIFIED against a live server.** The two columns are implemented from Microsoft's documented
> behaviour of `SCHEMA_NAME()` and `DB_NAME()`; no SQL Server was available when they were added. The
> fixture in `tests/integration/db/mssql-provider.test.ts` states what that behaviour produces, and
> the restriction itself is pinned there in both directions: `dbo` is marked under
> `libredb_objects` and no schema is marked under `libredb_objects_two`. Task 27 measures it live.

Two schemas are excluded, and both exclusions are measured rather than tidied:

| Excluded | Why | Measured |
|---|---|---|
| `sys`, `INFORMATION_SCHEMA` | can hold nothing a person wrote | `CREATE TABLE sys.probe` and `CREATE TABLE INFORMATION_SCHEMA.probe` both answer Msg 2760, and across every accessible database not one object in either schema has `is_ms_shipped = 0` |
| the nine fixed-role schemas (`db_owner`, `db_datareader`, …) **unless one holds a user object** | they exist to own permissions | `is_fixed_role` on the owning principal is the engine's own answer, so there is no name list and no `schema_id >= 16384` magic number. `CREATE TABLE db_owner.t` IS legal, so the `EXISTS` arm brings such a schema back: the fixture's `libredb_objects_two` lists `db_owner` because `db_owner.audit_log` is in it |

That `EXISTS` arm is also what keeps the sum rule above true: a schema this statement drops holds
nothing to count.

Below the last declared level the answer is `[]` rather than a refusal, because "nothing nests under
a schema" is a true statement about SQL Server and not a caller mistake.

#### `is_ms_shipped = 0` is load-bearing, not hygiene

Measured, `msdb`: **476 stored procedures, 145 tables, 78 views, 38 triggers, 58 functions and 10
synonyms, every one of them shipped by Microsoft.** A fresh user database holds 72 system tables, 36
internal tables and 3 service queues in the same view. Both statement arms filter on
`is_ms_shipped = 0`, and with the predicate dropped `countObjects(['msdb','dbo'])` answers 145
tables, 78 views and 454 procedures where the truth is zero of each.

#### `describeObject()`: the kind decides, and on this engine that is not theoretical

Only the two `relation` kinds have columns, indexes or foreign keys. A routine, a synonym, a
sequence and a trigger answer three empty arrays **without a round trip**, which is a true fact
about those kinds rather than a failed read.

Without the kind the same answer would come out by accident here, and the accident is reachable:
measured, `CREATE TRIGGER orders ON DATABASE` succeeds while the table `app.orders` exists, because
a DDL trigger is not in the schema namespace - while `CREATE PROCEDURE app.orders`,
`CREATE SEQUENCE app.orders` and `CREATE TRIGGER app.orders ON app.customers` each answer Msg 2714.
A detail read keyed on the name alone would hand that trigger the table's four columns.

Four narrow reads, each bound to one schema and one object, on Oracle's precedent in this epic:

| Read | Source | Note |
|---|---|---|
| columns | `sys.columns` ⋈ `sys.types` ⋈ `sys.default_constraints` | `sys.types.name` is the same spelling `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` gives, verified column by column on `app.orders`, so this surface and the flat tree name a type identically while both are live. `definition` matches `COLUMN_DEFAULT` including its parentheses (`((0))`) |
| primary key | `sys.indexes` (`is_primary_key = 1`) ⋈ `sys.index_columns` | feeds `isPrimary` on the columns |
| foreign keys | `sys.foreign_keys` ⋈ `sys.foreign_key_columns` | `sys.foreign_key_columns` already pairs both sides in one row, so there is no position join to get wrong |
| indexes | `sys.indexes` (`is_primary_key = 0`, `name IS NOT NULL`) ⋈ `sys.index_columns` | the same rule `SCHEMA_INDEXES_SQL` uses, so one screen never shows an index the other hides |

None of them uses `OBJECT_NAME()` or `COL_NAME()`, which the flat schema query does: those resolve
in the CURRENT database and would answer for the connected one while this read is three-part named
at another.

`referencedTable` is bare within the object's own schema and QUALIFIED outside it, because
`ForeignKeySchema` carries one string through Phase 1 and a bare name for the crossing case
addresses a table in the wrong schema - which is what the flat query's `OBJECT_NAME()` answers for
it. Measured on the fixture: `app.orders` reports `customers`, and `reporting.daily` reports
`app.customers`. SQL Server has no cross-DATABASE foreign key, so the catalog never needs naming.

**Zero column rows is a failed read, not an empty detail.** A table and a view each hold at least
one column on SQL Server (`CREATE TABLE t ()` is a syntax error), so no rows means the object is not
there, and `describeObject` raises rather than rendering a dropped table as a table with no columns.

#### What is not carried

- **No `sizeBytes`.** `DatabaseObject.sizeBytes` is optional and only carried where the engine
  publishes one cheaply; a size here needs `sys.allocation_units` joined per object, which
  `getTableStats()` already does for the monitoring screen.
- **`rowCount` only for a table**, from `sys.partitions` with `index_id IN (0, 1)` - the same
  expression `SCHEMA_TABLES_SQL` uses, so the number reads the same in both surfaces. It is the
  approximation the engine maintains rather than a `COUNT(*)`.
- **No `GO` anywhere in a provider statement.** `GO` is a client convention that never reaches the
  server, and `node-mssql` takes one batch per `query()`: the fixture file uses it because sqlcmd is
  what runs that file.

---

## 8. Monitoring & health

All from `sys.dm_*` DMVs (and `sys.database_files`); `getMonitoringData()` (inherited) fans them out
in parallel. Each sub-query is independently privilege-guarded (DMVs need `VIEW SERVER STATE`).

| Method | Primary source | Notes |
|--------|----------------|-------|
| `getHealth()` | `dm_exec_sessions`, `database_files`, `dm_os_performance_counters`, `dm_exec_query_stats` | connections (**omitted**, never `0`, when the DMV is denied — [§7.2](#72-when-the-connection-count-is-not-measurable)), size, buffer-cache-hit % (`N/A`, never `0%`, when unreadable — [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable)), top-5 slow queries, 10 sessions; each block guarded → absent/`N/A`/`[]` |
| `getOverview()` | `@@VERSION`, `dm_os_sys_info`, `dm_exec_sessions`, `sys.configurations`, `database_files`, `sys.tables`/`indexes` | `user connections = 0` → reported as 32767 (unlimited); `databaseSizeBytes` is **omitted** and `databaseSize` stays `N/A`, never a `0`, when the size statement fails — [§7.3](#73-when-the-database-size-is-not-measurable) |
| `getPerformanceMetrics()` | `dm_os_performance_counters` | **only** the cache-hit ratio, and it is **omitted** when the DMV cannot be read (no QPS/deadlocks/buffer-pool) — [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable) |
| `getSlowQueries()` | `dm_exec_query_stats` ⋈ `dm_exec_sql_text` | `sharedBlksHit`=logical reads, `sharedBlksRead`=physical reads; `[]` on failure |
| `getActiveSessions()` | `dm_exec_sessions` ⋈ `dm_exec_requests` ⋈ `dm_exec_sql_text` | **`blocked` is real** (`blocking_session_id > 0`); wait types; `[]` on failure |
| `getTableStats()` | `sys.tables`/`partitions`/`allocation_units` | sizes + `lastAnalyze` (`STATS_DATE`); no live/dead tuples; `[]` on failure |
| `getIndexStats()` | `sys.indexes`/`allocation_units` + `dm_db_index_usage_stats` | **`scans` is real** (seeks+scans+lookups); `[]` on failure |
| `getStorageStats()` | `sys.database_files` | per-file name/path/size; `[]` on failure |

### 7.1 When the cache hit ratio is not measurable

Two states, both ordinary:

- **The login lacks the server-level grant.** Measured 2026-08-23 on SQL Server 2022 CU26 against a
  login with nothing beyond `CONNECT`:

  ```
  Msg 300, Level 14, State 1, Line 1
  VIEW SERVER PERFORMANCE STATE permission was denied on object 'server', database 'master'.
  ```

  This is also the Azure SQL Database case, where server-scoped DMVs are restricted.

- **The counter base is zero.** `NULLIF(..., 0)` guards the division, so the query returns one row
  whose single column is `NULL`. Measured 2026-08-23 on the same instance:

  ```
  hit_ratio
  ---------
       NULL
  ```

In both cases **`getHealth().cacheHitRatio` is `"N/A"` and `getPerformanceMetrics()` omits
`cacheHitRatio`** (returning `{}`), and the Overview and Performance tabs render "Not measured". A
ratio measured as `0` is kept and shown as `0.0%`.

`getHealth()` previously published `"0%"` for an unreadable ratio and `getPerformanceMetrics()`
defaulted to `100`. The `0%` was the worse of the two: the Overview card rates a low ratio "Needs
tuning", so a least-privilege login saw a cache fault SQL Server never reported.

`bufferPoolUsage` is **no longer reported**. It was assigned `cacheHitRatio` itself — the same number
under a second name, drawn and rated as an independent gauge. SQL Server does publish pool occupancy,
through `sys.dm_os_buffer_descriptors` against `max server memory`, but this method does not query it
and that scan is not free.

SQL Server is the only provider that reports **real blocked-session detection** (`blocking_session_id`;
Postgres/Oracle/MySQL report `blocked: false`). For **index scan counts** it joins
`dm_db_index_usage_stats` — real usage data, the same calibre as Postgres's `pg_stat_user_indexes.idx_scan`
(whereas Oracle reports `0` and MySQL substitutes `CARDINALITY`).

### 7.2 When the connection count is not measurable

`sys.dm_exec_sessions` is server-scoped, so reading every session needs the server-state grant, and
which grant that is depends on the version. Microsoft's reference for the view states it directly:
*"In SQL Server 2019 (15.x) and earlier versions, requires `VIEW SERVER STATE` to see all sessions on
the server. In SQL Server 2022 (16.x) and later versions, requires `VIEW SERVER PERFORMANCE STATE`
permission on the server"*, and on Azure SQL Database it requires `VIEW DATABASE STATE`, which cannot
be granted in `master`
([sys.dm_exec_sessions](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-sessions-transact-sql)).
`VIEW SERVER STATE` is the covering grant either way: the 2022 split made
`VIEW SERVER PERFORMANCE STATE` a permission *implied by* `VIEW SERVER STATE`
([GRANT Server Permissions](https://learn.microsoft.com/en-us/sql/t-sql/statements/grant-server-permissions-transact-sql)),
so granting it still works, and it is the coarser choice.

On SQL Server 2022 CU26 - the instance the §7.1 refusal was measured on 2026-08-23, against a login
with nothing beyond `CONNECT` - that makes the session DMV's requirement the **same** permission as
the performance-counter DMV's, not a sibling. The refusal shape we measured there
([§7.1](#71-when-the-cache-hit-ratio-is-not-measurable)) is therefore what a denied session count
looks like too:

```
Msg 300, Level 14, State 1, Line 1
VIEW SERVER PERFORMANCE STATE permission was denied on object 'server', database 'master'.
```

The refusal on `sys.dm_exec_sessions` itself is **not** measured here - only the sibling DMV's is, on
the same login and the same instance. Azure SQL Database restricts the same server-scoped DMVs.

`HealthInfo.activeConnections` is **optional** for this case, so the denied count is **omitted** from
`getHealth()` - the key is absent from the object and from the `POST /api/db/health` body, and the
admin fleet-health row drops its `N conn` figure rather than printing `0 conn`
([`src/components/admin/tabs/OverviewTab.tsx`](../../src/components/admin/tabs/OverviewTab.tsx)).
It used to be initialised to `0` and the guard left that `0` standing, which mattered most to the
agent: its curated `health` reading forwards this figure to the model, so a refused DMV arrived as a
*measured* "no connections open" about a server SQL Server had said nothing about.

`DatabaseOverview.activeConnections` is **optional** for the identical reason, and `getOverview()`
now omits it on the same refusal. It did not until #515: the block was guarded, but the local was
initialised to `0`, so the denial was swallowed into a reading and travelled on as one. The count
itself is the *same* `COUNT(*) FROM sys.dm_exec_sessions`, only bundled with the `sys.configurations`
ceiling lookup - and that bundling is not cosmetic: it gives the statement a second object carrying
its own, version-dependent permission requirement, so the two counts do not necessarily fail together
([below](#which-half-of-the-overview-read-refuses-and-the-case-nothing-catches)).

The monitoring **Connections** card
([`src/components/monitoring/tabs/OverviewTab.tsx`](../../src/components/monitoring/tabs/OverviewTab.tsx))
is what the difference buys: on the absence it renders `N/A` over *"not published"* and drops the
sample from the connection-trend chart, whereas the `0` printed as the figure `0` on that card - a
busy server reported as idle on the strength of a permission error - and, because that tab keeps a
history, every refresh added a real `0` point to the connection sparkline, which plots present
samples and drops absent ones.

**No percentage was involved on this path.** The ceiling comes from the *same* statement, and its
assignment lives inside the `try` that threw, so a refused read left `maxConnections` at its `0`
initialiser; the card requires `connectionLimit > 0` for both the `/{limit}` suffix and the
`<Progress>` + *"N% used"* branch, so what it drew was a bare `0` over *"no limit published"* - no
ceiling, no bar. A `0/32767` with *"0% used"* is what a **successful** read of an idle instance
draws, and this fix does not change that rendering.

Nor does this figure reach the model. `getHealth()` runs its own
`COUNT(*) FROM sys.dm_exec_sessions` rather than composing from `getOverview()`, and the agent's
curated `health` reading is `getHealth()` as well (`method: "getHealth"` in
[`src/lib/agent/tools.ts`](../../src/lib/agent/tools.ts); nothing under `src/lib/agent` reads
`getOverview()`). This count's readers are the monitoring card, its trend chart, and the
connection-threshold rating that colours the card.

`maxConnections` is deliberately **not** made absent alongside it. It stays a required number because
`0` there already *means* "no limit published" rather than "no capacity", so absence and zero are the
same fact for the ceiling and different facts for the count; a denied read therefore leaves the count
absent and the ceiling `0`.

#### Which half of the overview read refuses, and the case nothing catches

`getOverview()`'s connection read names two objects, and Microsoft documents their permissions
differently - and differently *per version*:

| Object | SQL Server 2019 and earlier | SQL Server 2022 and later |
|--------|-----------------------------|---------------------------|
| `sys.dm_exec_sessions` | *"Everyone can see their own session information."* … *"requires `VIEW SERVER STATE` to see all sessions on the server"* | same first sentence; *"requires `VIEW SERVER PERFORMANCE STATE` permission on the server"* to see all sessions |
| `sys.configurations` | *"Requires membership in the **public** role."* | *"Requires VIEW SERVER PERFORMANCE STATE permission on the server."* |

(Permissions sections of
[sys.dm_exec_sessions](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-sessions-transact-sql)
and
[sys.configurations](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-configurations-transact-sql),
read 2026-08-27.)

So the version decides the *shape* an ungranted login gets, and only one of the two shapes is a
refusal at all:

- **SQL Server 2022 and later** - the `sys.configurations` subquery alone needs the server grant, so
  the whole statement is refused, the guard runs, and the count is correctly **absent**. This is the
  path #515 fixes, and it is why the ceiling is absent-shaped too: one statement, one catch.
- **SQL Server 2019 and earlier** - `sys.configurations` needs only `public`, so the ceiling lookup
  succeeds; and the session DMV is not documented as *refusing* an ungranted login at all, only as
  showing it its own session. Taken literally, that login gets a row-filtered `COUNT(*)` - its own
  connection rather than the server's - and the card draws a confident `1/32767` under a *"0% used"*
  bar. **That is a wrong measurement, not an absence, and nothing here catches it: the statement
  succeeded.**

The second case is **not fixed** by #515 and is **not measured** on a live instance - it is what
Microsoft's Permissions wording implies, not an observation. What this round did measure is the
sibling performance-counter DMV's refusal on 2022 CU26, which is why the caveat above stands
unchanged: the refusal on `sys.dm_exec_sessions` itself is not measured here, and neither is its
row-filtering. Distinguishing the two would need a separate probe - the grant itself
(`HAS_PERMS_BY_NAME`), or a count cross-checked against a source that cannot be row-filtered - not a
`try`/`catch`. The same wording applies one layer up: `getHealth()`'s count reads that DMV *alone*,
with no `sys.configurations` arm to refuse on any version, so its own permission-denial path is the
less likely of the two shapes there.

A count that really is `0` - an instance with no user sessions - is a reading and is reported as `0`,
in `getOverview()` as in `getHealth()`.
The absence is spelled `measuredNumber(...)` plus a conditional spread, never `|| undefined`.

### 7.3 When the database size is not measurable

`getOverview()` sizes the database with one statement over a **database-scoped catalog view**:

```sql
SELECT SUM(CAST(size AS BIGINT)) * 8 * 1024 AS size_bytes FROM sys.database_files
```

That is a different story from [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable) and
[§7.2](#72-when-the-connection-count-is-not-measurable), and the difference is the point.
`sys.database_files` is a catalog view scoped to the connected database
([sys.database_files](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-database-files-transact-sql)),
not one of the server-scoped DMVs those sections turn on, so the `Msg 300` refusal measured there is
**not** what fails here - and **no failure of this statement has been measured on a live instance at
all**. That is precisely why the guard names no cause: the client-side `requestTimeout` of
[§3.5](#35-a-query-timeout-is-wired-driver-enforced) firing as a `TimeoutError` on a busy instance, a
pool fault between this statement and the one before it, and a deployment whose T-SQL surface does
not carry the view all arrive at the same `catch` in the same shape. A `catch` cannot tell them
apart. It knows only that no figure arrived.

So the figure is **omitted**, not zeroed. `DatabaseOverview.databaseSizeBytes` is optional exactly so
this can be said - *"absence and zero are different facts"*, its docblock in
[`src/lib/db/types.ts`](../../src/lib/db/types.ts) - and until #565 this method could not say it: the
local was initialised to `0` and the `catch` was empty, so a statement that never answered published
a measured-looking zero, indistinguishable from an empty database.

The monitoring **Storage** tab
([`src/components/monitoring/tabs/StorageTab.tsx`](../../src/components/monitoring/tabs/StorageTab.tsx))
is what the difference buys: it keys its entire breakdown off `databaseSizeBytes !== undefined`, so
on the absence it renders *"No storage size information available."* On the fabricated `0` it drew
the breakdown instead - and drew it against a total that contradicted its own rows. The Tables and
Indexes figures come from `getTableStats()`, a **separate** read that does not share the size
statement's failure, so real per-table bytes sat under a database reported as `0 B`: every share is
gated on `totalSize > 0`, so all three bars stayed empty, and `0 - tables - indexes` went negative,
which the remainder row refuses as `N/A`. What the tab presented as a measurement was therefore a
breakdown whose every element either disagreed with the total or declined to answer.

**`databaseSize`, the formatted string, moves with the figure.** It is initialised to `"N/A"` and
only `formatBytes()` replaces it, so an unanswered statement now leaves `"N/A"` where it used to
leave `"0 bytes"`. That is not cosmetic: both the monitoring Overview card and the Storage tab's own
header render this string as the headline size (`overview?.databaseSize || "N/A"`), so the old
initialiser printed a confident `0 bytes` directly above *"No storage size information available."*
`getHealth()` in this same file initialises its own `databaseSize` to `"N/A"`, so `getOverview()`
was the odd one out; #569 (libSQL) and #517 (the search provider) merged the same
pairing.

A database that really measures `0` is a **reading** and is kept. `SUM(...)` over no input answers
one row of `NULL`, which the provider maps to `0`; the tab then formats the `0 B` it was given. If
the driver returns no row, no expected column, or a non-finite value, the measurement is absent and
the string stays `N/A`. The shared `measuredNullableAggregate()` ([`measured-aggregate.ts`](../../src/lib/db/utils/measured-aggregate.ts))
boundary preserves those states without a falsy test that would erase a genuine zero.

---

## 9. Maintenance

`runMaintenance(type, target?)` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)); targets
are bracket-escaped (`]` → `]]`):

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `UPDATE STATISTICS [<t>]` | `EXEC sp_updatestats` |
| `check` | `DBCC CHECKDB WITH NO_INFOMSGS` | same (target ignored) |
| `optimize` | `ALTER INDEX ALL ON [<t>] REBUILD` | rebuild every user table's indexes via generated `sp_executesql` |
| `kill` | `KILL <spid>` | throws (SPID required) |

`getCapabilities().maintenanceOperations = ['analyze', 'check', 'optimize', 'kill']`. `kill`
validates the target parses as an integer SPID.

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#496).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available - `{type:"check", target:"Orders"}` is
that request here.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `analyze` | Update Statistics | yes | yes | `UPDATE STATISTICS [<t>]`, or every table without a target |
| `check` | Check Database | no | yes | `DBCC CHECKDB` takes no object: `runMaintenance` ignores the target, so a per-table control would name one table and check the database |
| `optimize` | Rebuild Indexes | yes | yes | `ALTER INDEX ALL ON [<t>] REBUILD`, or every table without a target |
| `kill` | Kill Session | no | no | the target is a SPID from the Sessions panel |

`vacuumAction` has said *"Rebuild Indexes"* since this provider shipped, and that is
`optimize`: `vacuumActionOperation: 'optimize'` says so, which is what lets the global card
render those words and send an operation SQL Server declares (#496).

---

## 10. Capabilities & labels

### `getCapabilities()` ([`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | **`false`** (intentionally disabled — see [Known limitations](#14-known-limitations--future-work)) |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core T-SQL DML |
| `supportsTransactions` | `true` — the `mssql` package's `Transaction` over one held pool connection, so the trio and the SANDBOX toggle are offered (#464) |
| `declaresForeignKeys` | `true` — inherited from the base capabilities; read from `sys.foreign_keys`, so an empty list is about the schema or the role, not the engine |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'check', 'optimize', 'kill']` |
| `supportsConnectionString` | `true` (UI-only — see [§4.4](#44-connection-string-nuance)) |
| `defaultPort` | `1433` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |
| `containerLevels` | **two**: `catalog` (Database) then `schema` - the first two-level engine in #789 ([§7](#the-object-surface-789)) |
| `objectKinds` | seven: table, view, procedure, function, trigger, synonym, sequence. No `index` kind and no materialized view ([§7](#the-object-surface-789)) |

### Labels — overridden (`getLabels()`, [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts))

`analyzeAction` → *"Update Statistics"*, `vacuumAction` → *"Rebuild Indexes"*, plus the matching
global labels. The UI display name for the database type is *"SQL Server"* (`db-ui-config.ts`).

`slowQueriesEmptyState` → *"Query stats come from sys.dm_exec_query_stats, which needs the VIEW
SERVER STATE permission."* The monitoring Queries panel's empty state was hardcoded to PostgreSQL's
`pg_stat_statements` advice on every engine (#463); `getSlowQueries()` here reads
that DMV ([§8](#8-monitoring--health)) and returns `[]` when the read is refused, so the permission
is the thing a DBA can act on.

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

It also covers **the object surface** (#789): the seven declared kinds and their roles, the shared
conformance contract (`tests/helpers/object-surface-conformance.ts`), both container depths, the
caller-named catalog, the trigger read that `sys.objects` cannot answer, the mixed-depth trigger
listing, and the detail row. The object-surface mock answers per READ rather than per statement
text, and it takes its schema filter from the statement rather than from the bound parameter:
a mock that filtered on the bind kept passing for a listing that had lost its `WHERE` clause.

### 12.3 Run it

```bash
bun test tests/integration/db/mssql-provider.test.ts   # just this file (single process — safe)
bun run test:ci                                         # CI publish gate — per-file isolation (tests/run-core.sh)
bun run test:coverage                                   # CI coverage workflow — per-file core + components
```

### 12.4 Optional: verifying against a live SQL Server

```bash
docker run --rm -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Str0ng!Passw0rd' \
  -p 1433:1433 --cpus 4 mcr.microsoft.com/mssql/server:2022-latest
# then connect to localhost:1433 (user sa) in the Studio UI
```

`--cpus 4` is not decoration on a many-core host: SQL Server asserts on the processor topology in a
container, which is the same reason `database-compose.yml` pins `2022-latest`.

For the object surface, apply the fixture first. The image has **no init-script directory** (no
`/docker-entrypoint-initdb.d`, no `/container-entrypoint-initdb.d`), so it cannot be mounted the way
the PostgreSQL, MySQL and Oracle fixtures are:

```bash
docker cp docker/mssql-init/01-object-fixture.sql <container>:/tmp/fixture.sql
docker exec <container> /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'Str0ng!Passw0rd' -C -b -i /tmp/fixture.sql
```

It is idempotent (it drops and recreates every database it owns) and it seeds two databases with
DIFFERENT schema sets, one object of every declared kind, a disabled trigger, two DDL triggers, one
of them named exactly like a table, a cross-schema foreign key, a user table in a fixed-role schema
and an OFFLINE database. Every one of those is there because some claim in
[§7](#the-object-surface-789) cannot be measured without it.

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
  (MITM-exposed). For verified TLS, set `connection.ssl` mode `verify-system` (or `verify-ca`/
  `verify-full`, which build the same call here). (Azure hosts
  validate by default.)
  - **A paste that worked before can now fail against a self-signed on-prem server.**
    `Encrypt=True` with `TrustServerCertificate` absent maps to `verify-full`
    ([§4.4](#44-connection-string-nuance)), which is faithful to `Microsoft.Data.SqlClient` 4.0+ but
    **changes an outcome**: before the paste box read TLS, such a string left the form on `disable`,
    the explicit-`ssl` branch never ran, and the default above trusted the certificate. Measured
    2026-08-25 against SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) with its
    generated self-signed certificate: `{ encrypt: true, trustServerCertificate: true }` connected
    (`sys.dm_exec_connections.encrypt_option = TRUE`) while `{ encrypt: true,
    trustServerCertificate: false }` — what `verify-full` builds
    (`buildConfig()`, [`mssql.ts`](../../src/lib/db/providers/sql/mssql.ts)) — was refused with *"Failed to connect
    to 127.0.0.1:1433 - self signed certificate"*. If your on-prem server has no trusted certificate,
    paste `TrustServerCertificate=True` alongside `Encrypt=True`, or set SSL Mode to `require` on the
    form after pasting.
- **Binary columns aren't sanitized.** `VARBINARY`/`IMAGE`/`rowversion` come back as Node `Buffer`s
  and cross the wire as `{"type":"Buffer","data":[…]}` (no `0x…` hex conversion like the MySQL
  provider) — see [§5.3](#53-data-type--parameter-handling). The client recovers them: the results
  grid, the row detail sheet and the CSV export all classify that shape as binary and render `\x…`
  hex (`src/lib/export/binary.ts`), so what remains is the response size — about four bytes of JSON
  digits per byte of data.
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
  restricted on Azure SQL Database, so parts of monitoring/maintenance silently degrade there:
  `N/A`/`[]` where the shape can say "not measured", and, for the health connection count, nothing
  at all ([§7.2](#72-when-the-connection-count-is-not-measurable)). The monitoring Overview's
  `getOverview()` connection count is the exception and still degrades to `0`.
- **The Azure SQL Database container list is UNVERIFIED against Azure.** `EngineEdition = 5` lists
  exactly the connected database ([§7](#the-object-surface-789)), which is implemented from the
  documented inability to run a cross-database query there and probed by inverting the edition the
  statement tests, not by connecting to Azure. *Future:* run the object surface against an Azure SQL
  Database and against a Managed Instance, which is edition `8` and deliberately not in that arm.
- **Four user object types have no folder:** a rule (`R`), a plan guide (`PG`), a replication
  filter procedure (`RF`) and a table type (`TT`, whose `sys.objects` row is Microsoft-shipped and
  whose real home is `sys.types`). Each is a documented `sys.objects.type` this provider decides
  about and declines to fold into a kind it is not
  ([§7](#the-vocabulary-is-the-engines-not-the-fixtures)). *Future:* a Types folder, and a
  Programmability folder for the other three, if a user asks for one.
- **A SERVER-level DDL trigger is not addressable.** `sys.server_triggers` is server-wide, and the
  object tree has no level above a database, so those triggers appear in no count and no listing
  ([§7](#the-object-surface-789)). *Future:* a server-scoped container level, which every other
  engine would then have to answer for.
- **SQL authentication only** — Windows Integrated / Azure AD auth is not wired.
- **No two-phase schema loading** — `/api/db/schema/list` falls back to the full `getSchema()`.
- **DMV monitoring needs `VIEW SERVER STATE`** (`VIEW SERVER PERFORMANCE STATE` on SQL Server 2022
  and later, which `VIEW SERVER STATE` implies — [§7.2](#72-when-the-connection-count-is-not-measurable));
  a least-privilege user silently gets `N/A`/`[]` and,
  for the health connection count, nothing at all ([§7.2](#72-when-the-connection-count-is-not-measurable)).
  `getPerformanceMetrics()` reports only the cache-hit ratio (no QPS, deadlocks, or buffer-pool
  usage), and **omits even that** when `dm_os_performance_counters` is unreadable rather than
  substituting a figure — [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable).

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
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [Apache Trino](./trino.md) · [Redis](./redis.md)
