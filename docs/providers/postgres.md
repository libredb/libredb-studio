# PostgreSQL Provider

> Full PostgreSQL support for LibreDB Studio, built on the [`pg`](https://github.com/brianc/node-postgres) driver.
> This document is the single reference point for the PostgreSQL provider: design, architecture,
> usage, and tests. PostgreSQL is the **reference implementation** for the SQL provider family — if
> you are authoring or maintaining another SQL provider, read this alongside the source.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `postgres` |
| **Family** | SQL (relational) |
| **Driver** | `pg` (node-postgres) |
| **Query language** | `sql` |
| **Default port** | `5432` |
| **Connection pooling** | Yes — `pg.Pool` (min 2 / max 10 by default) |
| **Connection string** | Supported (`postgres://` / `postgresql://`) |
| **Transactions** | Yes — explicit `BEGIN`/`COMMIT`/`ROLLBACK` with auto-rollback timeout |
| **Query cancellation** | Yes — PID tracking + `pg_cancel_backend` |
| **Agent read-only profile** | Yes — `BEGIN READ ONLY` + extended-protocol single statement (#328, §12) |
| **Source** | [`src/lib/db/providers/sql/postgres.ts`](../../src/lib/db/providers/sql/postgres.ts) |
| **Base** | [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) |
| **Tests** | [`tests/integration/db/postgres-provider.test.ts`](../../tests/integration/db/postgres-provider.test.ts) |

---

## 1. Overview

PostgreSQL is a fully relational database, so — unlike the [Redis provider](./redis.md) — it maps
onto the `DatabaseProvider` interface almost 1:1: tables are tables, rows are rows, and queries are
real SQL. The interesting engineering in this provider is not *mapping*, it is **doing relational
introspection and monitoring fast, safely, and resiliently**:

- **Schema introspection that scales** to hundreds of tables without timing out (the `MATERIALIZED`
  CTE story in [§6](#6-schema-introspection)).
- **Two-phase schema loading** so the table tree renders instantly and relationships stream in.
- **Connection pooling, transactions, and query cancellation** layered on top of `pg`.
- **Monitoring built on `pg_stat_*` views**, degrading gracefully when optional extensions
  (`pg_stat_statements`) or superuser-only views (WAL) are unavailable.

PostgreSQL is also the **canonical SQL provider**: the shared SQL mechanics (identifier quoting,
`LIMIT` injection, dialect placeholders, SSL auto-detection) live in `SQLBaseProvider`, and the
other SQL providers (MySQL, SQLite, Oracle, SQL Server) follow the patterns established here.

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. SQL providers add an intermediate abstract layer,
`SQLBaseProvider`, between the generic base and each concrete provider:

```
DatabaseProvider (interface, types.ts)
        ▲ implements
BaseDatabaseProvider (abstract — state, instrumentation, default monitoring orchestration)
        ▲ extends
SQLBaseProvider (abstract — identifier quoting, LIMIT injection, dialect helpers, SSL detection)
        ▲ extends
PostgresProvider (postgres.ts)
```

```
src/lib/db/
├── base-provider.ts              # generic base (see redis.md §2.3)
├── providers/sql/
│   ├── sql-base.ts               # ← SQLBaseProvider (shared SQL logic)
│   └── postgres.ts               # ← PostgresProvider (this document)
└── utils/
    ├── pool-manager.ts           # mergePoolConfig(), formatBytes(), formatDuration(), retry/timeout
    └── query-limiter.ts          # analyzeQuery(), applyQueryLimit() — auto-LIMIT for SELECTs
```

### 2.2 What `SQLBaseProvider` provides

`PostgresProvider` inherits these from [`sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
rather than reimplementing them:

| Member | Purpose |
|--------|---------|
| `escapeIdentifier()` ([sql-base.ts:33](../../src/lib/db/providers/sql/sql-base.ts)) | Dialect-aware quoting — `"ident"` for Postgres, `` `ident` `` for MySQL, `[ident]` for MSSQL; doubles embedded quote chars |
| `positionalPlaceholder()` ([values.ts](../../src/lib/sql/values.ts), shared rather than inherited) | `$1`-style placeholders for Postgres (`?` for MySQL/SQLite/Druid, `:n` Oracle, `@pn` MSSQL, `$n` Couchbase) |
| `shouldEnableSSL()` ([sql-base.ts:75](../../src/lib/db/providers/sql/sql-base.ts)) | Auto-enables SSL for known cloud hosts (supabase, neon, render, planetscale, aws, azure, gcp, …) |
| `getDefaultSchema()` ([sql-base.ts:91](../../src/lib/db/providers/sql/sql-base.ts)) | `public` for Postgres |
| `prepareQuery()` ([sql-base.ts:137](../../src/lib/db/providers/sql/sql-base.ts)) | Injects `LIMIT` into bare `SELECT`s — see [§5.2](#52-automatic-limit-injection) |

### 2.3 Registration & lifecycle

The factory loads the provider via dynamic import so the `pg` driver is only pulled in when a
PostgreSQL connection is opened ([`factory.ts:62`](../../src/lib/db/factory.ts)):

```ts
case 'postgres': {
  const { PostgresProvider } = await import('./providers/sql/postgres');
  return new PostgresProvider(connection, options);
}
```

API routes use `getOrCreateProvider()`, which caches the connected provider per `connection.id`,
evicts after 30 minutes idle, and disconnects on graceful shutdown — `disconnect()` calls
`pool.end()` to drain the pool.

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 `MATERIALIZED` CTEs for schema introspection

This is the single most important detail in the file. All schema-introspection CTEs are declared
`AS MATERIALIZED` ([postgres.ts:86–177](../../src/lib/db/providers/sql/postgres.ts)). PostgreSQL 12+
*inlines* single-reference CTEs by default, which lets the planner re-execute these
`information_schema`-based CTEs inside nested-loop joins (it estimates `rows=1` for them). On a
large schema (100+ tables/constraints/indexes) that explodes into minutes of planning/execution.
`MATERIALIZED` forces each CTE to compute exactly once:

> **~295s → ~2.6s on a 122-table schema.**

If you edit these queries, keep `MATERIALIZED` or you reintroduce the timeout.

### 3.2 Schema SQL hoisted to module scope

`SCHEMA_FULL_SQL`, `SCHEMA_LIST_SQL`, and `SCHEMA_RELATIONS_SQL` are module-level `const`s, not
inline template literals inside the methods ([postgres.ts:86–226](../../src/lib/db/providers/sql/postgres.ts)).
This is a **coverage** workaround: `bun`'s coverage instruments the interior lines of a multi-line
template literal *in a function body* as 0-hit in any test process that imports the file but does
not exercise that method, and the merged lcov then reports those SQL lines as uncovered. Evaluated
once at module load, these consts are reported as covered everywhere. The CTE fragments
(`CTE_TABLES_INFO`, `CTE_COLUMNS_INFO`, …) are also single-sourced and composed into the three
queries so the shared CTEs aren't duplicated (which would otherwise trip the duplication gate).

### 3.3 Two-phase schema loading

The schema tree is loaded in two independent calls so a slow or failing relationship query never
blocks the table list:

- **`getSchemaList()`** — tables + columns + primary keys + row counts/sizes. Renders the tree
  immediately. Excludes the expensive FK/index joins; returns `indexes: []`, `foreignKeys: []`.
- **`getSchemaRelations()`** — foreign keys + indexes only, keyed by table display name, merged
  into the tree asynchronously by the client.

`getSchema()` remains available as the single-round-trip "everything" query (it replaced an old
N+1 pattern of `1 + N*4` queries). The two-phase split is the path the UI actually uses (via
`/api/db/schema/list` and `/api/db/schema/relations`).

### 3.4 Cross-schema display names & FK references

Tables in the `public` schema are shown by bare name; tables in any other schema are prefixed
(`reporting.invoices`). The same rule is applied to **foreign-key referenced tables**, so a FK that
points across schemas renders correctly. The FK introspection CTE joins
`constraint_column_usage` on **both** `constraint_name` and `constraint_schema`
([postgres.ts:148–150](../../src/lib/db/providers/sql/postgres.ts)) — joining on name alone
mis-resolves same-named constraints in different schemas (this was a real bug; there is a
regression test for it).

### 3.5 Resilient monitoring

Monitoring never hard-fails on a missing optional feature:
- `pg_stat_statements` is wrapped in try/catch in both slow-query paths, but they degrade
  *differently*: `getSlowQueries()` falls back to a `pg_stat_activity` snapshot of
  currently-running queries when the extension isn't installed, whereas `getHealth()`'s lighter
  slow-query block returns a single placeholder row (`pg_stat_statements extension not enabled`).
- WAL size (`getStorageStats`) and `pg_stat_bgwriter` checkpoint times are superuser/version-gated;
  failures are swallowed and the field is simply omitted or reported as `N/A`. PostgreSQL 17 moved
  `checkpoint_write_time`/`checkpoint_sync_time` from `pg_stat_bgwriter` to `pg_stat_checkpointer`,
  so on 17+ the query throws and `checkpointWriteTime` is `"N/A"` — measured 2026-08-23 through this
  provider against `postgres:18`. It is never `"0.0s"` for an unread counter.
- A metric the statistics views did not publish is **omitted rather than defaulted**
  ([§7.1](#71-when-the-cache-hit-ratio-is-not-measurable)); `deadlocks` is absent when
  `pg_stat_database` has no row for the database, rather than reported as zero deadlocks.

### 3.6 Safe maintenance targets

`qualifyMaintenanceTarget()` ([postgres.ts:751](../../src/lib/db/providers/sql/postgres.ts)) quotes
maintenance targets through `escapeIdentifier()`: a bare name defaults to the `public` schema; a
`schema.table` target is quoted per-part. This prevents identifier injection in `VACUUM`/`ANALYZE`/
`REINDEX` statements (which cannot use bind parameters for object names).

---

## 4. Connection

### 4.1 Configuration

Two forms are accepted (`validate()`, [postgres.ts:264](../../src/lib/db/providers/sql/postgres.ts)).
`validate()` requires `host` **and** `database` only when no `connectionString` is given — it does
**not** reject supplying both. If both are present the **connection string wins**: `buildPoolConfig()`
uses it and ignores the discrete fields.

**Discrete fields** — `host` and `database` are both required (when no connection string):

```ts
const connection = {
  id: 'pg-1', name: 'Production', type: 'postgres',
  host: 'localhost', port: 5432, database: 'mydb',
  user: 'admin', password: 'secret',
  createdAt: new Date(),
};
```

**Connection string** — bypasses the host/database requirement:

```ts
const connection = {
  id: 'pg-1', name: 'Production', type: 'postgres',
  connectionString: 'postgresql://admin:secret@localhost:5432/mydb',
  createdAt: new Date(),
};
```

#### `sslmode` in a pasted URL

The paste box ([`connection-string-parser.ts`](../../src/lib/connection-string-parser.ts)) reads the
query string, so `postgresql://host/db?sslmode=verify-full` arrives on the form with SSL Mode already
set. `disable`, `require`, `verify-ca` and `verify-full` map one-to-one. `verify-system` is not in
that table: it is the form's own mode name, not a libpq one, so `?sslmode=verify-system` is reported
as a parameter we cannot honour rather than accepted.

`prefer` and `allow` are **not** mapped, and neither is any spelling the map does not know. Both mean
"encrypt if the server offers it", which no mode on the form can express, and both directions of
guess are wrong against a live server: measured on postgres 18 with no server certificate,
`?sslmode=prefer` connects with `pg_stat_ssl.ssl = f` while `?sslmode=require` is refused outright
("server does not support SSL, but SSL was required"). So the mode the form already holds is left
alone and the paste banner names the parameter it declined to act on — the string is never silently
downgraded to "disable". Set SSL Mode yourself in the SSL / TLS panel.

`?ssl=true` / `?ssl=false` (the JDBC and Heroku spelling) map to **`verify-system`** / `disable`,
since neither is opportunistic. The rule the parser states for every boolean TLS spelling is: it maps
onto the mode that matches what the engine's own driver does with it, never onto a weaker one. `pg`
given `ssl: true` connects with Node's default `rejectUnauthorized: true`, so `verify-system` — chain
and host name checked against the runtime's trust store, no PEM to paste — is that mode.

This used to map to `require`, which here means `rejectUnauthorized: false` (encrypted, chain **not**
verified), because the form had no mode that both verified and asked for nothing: `verify-ca` and
`verify-full` are the modes that want a CA certificate, so pointing `?ssl=true` at one of them turned
a working paste into a connection the user could not complete. `verify-system` is that missing mode
(D26), so a Neon / Supabase / RDS URL now arrives verified and complete. Pick `verify-ca`/`verify-full`
only when the server's certificate is signed by a CA the runtime does not already trust.

`sslrootcert`, `sslcert` and `sslkey` are ignored: they are paths on the machine
that wrote the string, while the panel holds PEM text and the process that opens the connection is the
server. Paste the certificate content instead.

### 4.2 Connection pooling

`connect()` builds a `pg.Pool` ([postgres.ts:281](../../src/lib/db/providers/sql/postgres.ts)) and
validates it by acquiring and releasing one client. Pool **sizing** comes from `ProviderOptions.pool`
merged over `DEFAULT_POOL_CONFIG`:

| `ProviderOptions.pool` setting | Default | `pg` mapping |
|--------------------------------|---------|--------------|
| `min` | 2 | `min` |
| `max` | 10 | `max` |
| `idleTimeout` | 30000 ms | `idleTimeoutMillis` |
| `acquireTimeout` | 60000 ms | `connectionTimeoutMillis` |

The statement timeout is **separate** from pool config: `ProviderOptions.queryTimeout` (default
`DEFAULT_QUERY_TIMEOUT` = 60000 ms) is applied as the pool's `statement_timeout`.

`connect()` is idempotent (a second call while a pool exists is a no-op). `getPoolStats()` exposes
live `{ total, idle, active, waiting }` counts. Every query acquires a client from the pool and
releases it in a `finally` block.

#### Idle-client failures are handled, not fatal

`connect()` attaches an `error` listener to the pool as soon as it is constructed. This is not
optional bookkeeping: a client that fails while **checked out** rejects its own query, but a client
that fails while **idle** (the server dropped it, the network went away) has no query to reject, so
`pg` removes and destroys it and emits `error` on the pool instead. An `error` event with no listener
is an uncaught exception — i.e. a long-running server process would die from a dropped idle
connection.

The listener reports the failure with the file's usual bracketed-prefix `console.error` and does
nothing else. `pg` has already discarded the client, so the handler exists to keep the event
non-fatal and visible, not to reconnect; the pool opens a fresh client on the next acquire.

The same guard is on the PostgreSQL **storage** pool (see [STORAGE.md](../STORAGE.md)), which is a
second long-lived `pg.Pool` when `STORAGE_PROVIDER=postgres`. Across the other pooled drivers, only
SQL Server needs the same treatment ([mssql.md](./mssql.md#42-connection-pooling)): mysql2 and
oracledb expose no pool-level `error` event at all, which is recorded at each provider's
`connect()`.

### 4.3 SSL

`buildSSLConfig()` ([postgres.ts:342](../../src/lib/db/providers/sql/postgres.ts)) resolves SSL with
this precedence:

1. **Explicit `connection.ssl`** (`SSLConfig`, mode = `disable` | `require` | `verify-system` |
   `verify-ca` | `verify-full`):
   - `disable` → no SSL.
   - `require` → `rejectUnauthorized: false` — the ONE mode that encrypts without verifying.
   - `verify-system` / `verify-ca` / `verify-full` → `rejectUnauthorized: true`. `verify-system`
     passes no `ca`, so Node's own trust store checks the chain and the host name; the other two
     verify against `caCert` when one is supplied. `pg` exposes no separate name check, so
     `verify-ca` and `verify-full` build the same object here.
   - `caCert` / `clientCert` / `clientKey` map to `ca` / `cert` / `key`.
2. **`options.ssl === true` or cloud auto-detect** — `shouldEnableSSL()` returns true when
   `options.ssl === true` *or* the host matches a known managed provider, enabling
   `{ rejectUnauthorized: false }`.
3. **`options.ssl === false`** → no SSL.
4. Otherwise `undefined` (driver default).

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([postgres.ts:378](../../src/lib/db/providers/sql/postgres.ts))
acquires a pooled client, optionally records its backend PID for cancellation, runs the
(optionally parameterized — `$1`, `$2`, …) statement, and returns the standard envelope:

```ts
{ rows, fields: string[], rowCount, executionTime, columnTypes? }
```

Native `pg` errors are normalised through `mapDatabaseError()` into the shared
[`errors.ts`](../../src/lib/db/errors.ts) classes (syntax → `QueryError`, auth → `AuthenticationError`,
timeout → `TimeoutError`, etc.).

### 5.2 Automatic `LIMIT` injection

`prepareQuery()` (inherited from `SQLBaseProvider`) protects the UI from runaway result sets. It
runs the query through `analyzeQuery()` ([query-limiter.ts:88](../../src/lib/db/utils/query-limiter.ts))
and, **only for `SELECT`/CTE-`SELECT` queries that don't already have a `LIMIT`**, appends one via
`applyQueryLimit()`:

- Default page size: `DEFAULT_QUERY_LIMIT = 500`.
- "Unlimited" mode caps at `MAX_UNLIMITED_ROWS = 100000`.
- Existing `LIMIT` / `FETCH FIRST … ROWS ONLY` / `TOP n` / `ROWNUM` is detected and respected
  (not double-limited).
- Non-`SELECT` statements (INSERT/UPDATE/DELETE/DDL) are returned unchanged.
- The statement type is read from its first keyword that is neither whitespace nor a **comment**
  ([`leading-keyword.ts`](../../src/lib/sql/leading-keyword.ts)), so `-- note`, `/* note */` and
  MySQL's `# note` before a `SELECT` are skipped and the limit is still applied — as is the
  already-limited check, so an annotated bounded query is not bounded twice. Before this, an
  annotated `SELECT` classified as an unknown statement type and returned **every** row while the
  UI badge reported it as not limited (#275).
- The statement's characters are read under **PostgreSQL's** grammar, which the provider passes down
  from its own `type` ([`grammar.ts`](../../src/lib/sql/grammar.ts)). PostgreSQL has exactly two
  comment forms, `--` and `/* … */`; `#` is an operator character (`#>` and `#>>` walk a jsonb path,
  `#-` deletes one, `##` is geometric, `#` is integer XOR). The shared reader used to approximate
  that with "a comment unless the next character makes an operator", which kept everyday jsonb queries
  bounded but read `SELECT flags # 5 AS x FROM t` as a statement that ends at the `#` — so it was not
  bounded. Both are bounded now, and the emitted text is unchanged apart from the appended clause
  (#292). See
  [Which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading).
- **`[…]` is a SUBSCRIPT here, not a quoted name.** `expression[subscript]` extracts an element and
  `expression[lower:upper]` a slice (manual 4.2.3), array constructors nest — the manual's own example
  is `SELECT ARRAY[[1,2],[3,4]]` (4.2.12) — and identifiers are quoted with double quotes (4.1.1), so
  `[` is never a name quote in this dialect. The run nests, nothing inside it is escaped, and a literal
  inside it is read as a literal, so a nested array (`SELECT ARRAY[[1,2],[3,4]] AS a FROM t`), a
  subscript key carrying a close bracket (`SELECT j['a]b'] FROM t`) and a nested subscript
  (`SELECT t.data[idx[0]] FROM t`) are all read whole: bounded, emitted intact, no prompt (#295).
  A run short of its closer (`SELECT ARRAY[[1,2] AS a FROM t`) is still undeterminable — not bounded,
  and the safety gate asks — which is the fail-safe direction and the only bracket shape that costs
  anything here. Pinned in `tests/integration/db/postgres-provider.test.ts`, including a statement that
  ENDS with a nested array (nothing after the run would catch a bound placed by a reader that lost
  track of where it closes), and on the gate side in `tests/components/QuerySafetyDialog.test.tsx`.
- **Block comments NEST here, and that is the dialect's own rule** — PostgreSQL's manual (4.1.5
  Comments) says they nest "as specified in the SQL standard but unlike C", precisely so a region that
  already contains comments can be commented out. The shared reader used to end every comment at its
  first `*/`, which handed everything between that marker and the comment's real end to the readers as
  code. On this provider that was the most expensive shape in the family, because a `)` written in that
  region closes a CTE body that is still open: `WITH recent AS (/* a /* b */ ) SELECT 1 */ SELECT id
  FROM logs) INSERT INTO archive (id) SELECT id FROM recent` typed as a `SELECT` and collected a bound,
  and on PostgreSQL that bound applies to the rows the INSERT **writes** — a partial commit reported as
  a truncated result set. Under PostgreSQL's grammar the comment is read whole, the statement is typed
  `INSERT`, and nothing is appended (#300). The read side improves too: `/* a /* b */ x */ SELECT id
  FROM logs` is now typed `SELECT` and bounded, comment emitted intact. A comment carrying one opener
  too many (`/* a /* b */ SELECT 1`) never closes here, so it is undeterminable: not bounded, and the
  safety gate asks — the fail-safe direction, since the same text is either an unterminated comment the
  server rejects or a comment hiding a statement nobody can see. Pinned in
  `tests/integration/db/postgres-provider.test.ts`.
- A statement leading with `WITH` is typed by the keyword its CTE list **operates**
  ([`operative-keyword.ts`](../../src/lib/sql/operative-keyword.ts)), so a data-modifying CTE
  (`WITH t AS (UPDATE … RETURNING …) INSERT INTO … SELECT …`) is **not** bounded. This matters most on
  PostgreSQL, where data-modifying CTEs are an everyday idiom and the appended `LIMIT` applied to the
  rows the statement *writes*: it committed at most 500 of them while reporting a truncated result
  set (#287). Undeterminable CTE shapes are likewise not bounded — an over-large read can be re-run,
  a partly committed write cannot. Asserted at the shared seam in `tests/unit/db/sql-base.test.ts`,
  since the behaviour is `SQLBaseProvider`'s for every SQL provider.
- The clause is inserted at the end of the **statement** as
  [`statement-end.ts`](../../src/lib/sql/statement-end.ts) delimits it — before any trailing comment
  and before the terminating `;`, both re-attached verbatim — and the already-limited probes read the
  same end. Appending after the trivia put the bound inside a trailing `-- note`, so the query ran
  unbounded while the badge said it was capped; reading the bound off the same text made
  `-- LIMIT 10` look like a real one, so nothing was injected (#280). A statement with no trailing
  trivia is emitted exactly as before. A statement whose end may not be **cut** is returned untouched
  with `wasLimited: false`, since a guess would place the bound after the `;` or in the middle of the
  statement. **On this dialect the shapes that reach it are a quote behind an odd backslash run** (MySQL
  and PostgreSQL close such a literal in different places, so the reader declines to guess), **a
  bracketed run short of its closer** (see the bullet above) **and any other
  run that never closes** — an unterminated comment or literal. A trailing `#`
  run used to reach it too and no longer does — under PostgreSQL's grammar `#` is code, not a comment
  marker, so `SELECT flags # 5` is cut and bounded like any other statement (#292); the refusal survives
  only for a caller that names no dialect. The backslash shape also asks for confirmation since #297 —
  an unresolvable run is text the safety gate cannot read either — see
  [query-optimization.md](../editor/query-optimization.md#text-the-reading-cannot-resolve-asks-and-says-so).

`prepareQuery()` is a *preparation* step (the UI calls it before `query()`); `query()` itself runs
exactly the SQL it is handed.

Which routes call it is a caller policy, not the provider's: `POST /api/db/query` and the transaction
route's `query` action prepare every statement they are given, while `POST /api/db/multi-query` prepares
the **last** statement of a script and only when it is a `SELECT` — so a non-final `SELECT` returns its
full result set, which that route's own
[section](../editor/query-optimization.md#multi-statement-runs) records rather than claims closed. It
decided "is this a `SELECT`" with its own `/^\s*SELECT\b/i` until #281 and so skipped preparation for a
comment-led final `SELECT`; it now reads `isSelectQuery()` from the same classifier as everything above.

### 5.3 Query cancellation

A query issued with a `queryId` records its backend PID in a `Map`. `cancelQuery(queryId)`
([postgres.ts:412](../../src/lib/db/providers/sql/postgres.ts)) looks the PID up and calls
`pg_cancel_backend(pid)` on a fresh pooled client, returning whether the cancel signalled. Exposed
via `POST /api/db/cancel`.

### 5.4 Declared column types

`pg` says exactly one thing about a column's type: `field.dataTypeID`, a `pg_type` OID. There is no
name on the wire, and no value-shaped guess can supply one — `numeric` arrives as the **string**
`"4.99"` so that its precision survives, `bigint` arrives as a string for the same reason, and a
`timestamp` is a string by the time the browser has read the JSON. Measured against the local
dvdrental before this existed, `SELECT rental_rate, last_update, film_id FROM film` exported as
`("rental_rate" TEXT, "last_update" TIMESTAMP, "film_id" BIGINT)`: a `numeric` typed as text, and an
`integer` widened. Guessing from the string's SHAPE is not the answer either — it would type a text
column holding `2026-01-01` as a timestamp.

So the OID is resolved to a name and reported in `QueryResult.columnTypes`, keyed by the name in
`fields` ([column-types.ts](../../src/lib/db/providers/sql/column-types.ts)). All three execution
paths do it: `query()`, `queryInTransaction()` and the agent's `queryReadOnly()`.

- **A static table, not a catalog lookup.** The built-in OIDs are compiled into the server
  (`pg_type.dat`) and are never reused, so a generated table is correct on every version — a newer
  server can only add OIDs it does not know. A lookup would also need a round trip that three of the
  four call sites cannot make: `query()` releases its pooled client before the result is assembled,
  and `queryReadOnly()` promises EXACTLY ONE statement inside `BEGIN READ ONLY` (§12) — a catalog
  `SELECT` smuggled in beside it would break that promise for a column label.
- **`format_type` supplies the spelling**, because it is what PostgreSQL itself prints: OID 20 is
  `bigint`, not the internal `int8` that `pg`'s own `types.builtins` is keyed by. The table's
  generating query is in the module's header comment.
- **A user-defined OID (>= 16384) is absent rather than wrong.** An enum, a composite or an
  extension type gets its OID per database, so no static table can name it. Measured by running
  `SELECT *` through `pg` over every table and view in dvdrental — 128 result columns — 125 are
  named, 0 wrongly, and 3 are absent: the `mpaa_rating` enum in `film` and the two views over it.
  Arrays are named (`text[]`). A **domain** does not reach that case at all: `film.release_year` is
  the domain `year` (OID 16516) in `pg_attribute`, and `pg` reports the column as OID 23 — its base
  type — so the result says `integer`, which is what the wire carries.

| `dataTypeID` | reported as |
|---|---|
| 20 / 23 / 21 | `bigint` / `integer` / `smallint` |
| 1700 | `numeric` |
| 701 | `double precision` |
| 16 | `boolean` |
| 1043 / 25 / 1042 | `character varying` / `text` / `character` |
| 1114 / 1184 / 1082 | `timestamp without time zone` / `timestamp with time zone` / `date` |
| 114 / 3802 | `json` / `jsonb` |
| 2950 / 17 | `uuid` / `bytea` |
| 1009 | `text[]` |
| >= 16384 | *absent* |

The names are the base type's, without the type modifier: `character varying`, not
`character varying(40)`. That is what `information_schema.columns.data_type` — the same source the
schema tree shows — answers for the same column, and the modifier is not on the wire in a form worth
reconstructing. `columnTypes` is consumed by the results grid's column labels, by the SQL-DDL export
(which prefers a declared type over its value-shaped guess) and by the agent's state summary.

---

## 6. Schema introspection

Three queries, one set of shared `MATERIALIZED` CTEs:

| Method | SQL const | Returns | Used by |
|--------|-----------|---------|---------|
| `getSchema()` | `SCHEMA_FULL_SQL` | tables + columns + PKs + FKs + indexes (one round-trip) | direct/full loads |
| `getSchemaList()` | `SCHEMA_LIST_SQL` | tables + columns + PKs (fast, no FK/index) | `/api/db/schema/list` |
| `getSchemaRelations()` | `SCHEMA_RELATIONS_SQL` | FKs + indexes keyed by table | `/api/db/schema/relations` |

Common behaviour:
- System schemas (`pg_catalog`, `information_schema`, `pg_toast`) are excluded; only `BASE TABLE`s.
- Row counts come from `pg_class.reltuples` (planner estimate, fast) and are clamped to ≥ 0
  (`reltuples` is `-1` on never-analyzed tables).
- Column lists are capped at the first 100 columns (`ordinal_position <= 100`).
- Sizes use `pg_total_relation_size` formatted by `formatBytes()`.
- Display names follow the public/qualified rule from [§3.4](#34-cross-schema-display-names--fk-references).

---

## 7. Monitoring & health

All monitoring reads from PostgreSQL's statistics views. `getMonitoringData()` (inherited from the
base) fans these out in parallel.

| Method | Primary source | Notes |
|--------|----------------|-------|
| `getHealth()` | `pg_stat_activity`, `pg_database_size`, `pg_statio_user_tables`, `pg_stat_statements` | connections, size, cache-hit % (`N/A` when unmeasurable — [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable)), top-5 slow queries (single placeholder row if the extension is absent), 10 sessions |
| `getOverview()` | `version()`, `pg_postmaster_start_time()`, `pg_settings`, `pg_database_size`, `pg_tables`/`pg_indexes` | version, uptime, conns, max_conns, size, table/index counts |
| `getPerformanceMetrics()` | `pg_statio_user_tables`, `pg_stat_database`, `pg_stat_bgwriter` | cache-hit % (omitted when unmeasurable), deadlocks, checkpoint write time (gated, `N/A`); **no buffer-pool %** — see [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable) |
| `getSlowQueries()` | `pg_stat_statements` → fallback `pg_stat_activity` | detailed per-statement stats; fallback shows live active queries |
| `getActiveSessions()` | `pg_stat_activity` | pid, user, state, query, wait events, duration; excludes own backend |
| `getTableStats()` | `pg_stat_user_tables` + size functions | live/dead tuples, sizes, last (auto)vacuum/analyze, bloat ratio |
| `getIndexStats()` | `pg_stat_user_indexes`, `pg_index`, `pg_am` | type, columns, unique/primary, size, scan count, usage ratio |
| `getStorageStats()` | `pg_tablespace`, WAL functions | per-tablespace size; WAL size (superuser-gated, swallowed if denied) |
| `getPgStatActivity()` | `pg_stat_activity` | raw passthrough for advanced views |

`getTableStats()` / `getIndexStats()` accept an optional `{ schema }` filter; with none they cover
all user schemas.

### 7.1 When the cache hit ratio is not measurable

The ratio comes from `pg_statio_user_tables`, and there are two ordinary states in which that view
has nothing to divide:

- **A database with no user tables.** The aggregate is `NULL`, not zero. Measured 2026-08-23 on
  `postgres:18`, on a freshly created database:

  ```
   heap_read | heap_hit | raw_ratio
  -----------+----------+-----------
             |          |
  ```

- **A table nothing has read yet.** `heap_blks_hit` and `heap_blks_read` are both `0`, so the ratio
  is `0/0` — a division by zero, which `NULLIF(..., 0)` turns into the same `NULL`.

In both cases **`getHealth().cacheHitRatio` is `"N/A"` and `getPerformanceMetrics().cacheHitRatio`
is absent from the object**, and the Overview and Performance tabs render "Not measured" rather
than a figure. A ratio that *is* measured as `0` is kept and shown as `0.0%`: a cold cache is a real
reading, and the one the panel most needs to show.

Both SQL statements used to wrap the `NULL` in `COALESCE(..., 100)`, so an unmeasured database
reported a perfect cache; the panels rated it "Excellent". A missing panel is honest; a populated
wrong one is not.

`bufferPoolUsage` is **not reported at all**. It used to be `blks_hit / (blks_hit + blks_read)` from
`pg_stat_database` — which is a cache hit ratio, not pool occupancy, so the Performance tab drew the
same quantity twice with one of the two mislabelled, and substituted `100` when both counters were
`0`. PostgreSQL publishes no buffer-pool occupancy without the `pg_buffercache` extension, which is
not installed by default and whose scan locks `shared_buffers`.

---

## 8. Transactions

PostgreSQL exposes an explicit transaction lifecycle on a **dedicated client checked out from the
pool and held for the transaction's duration** — so every statement runs on the same backend, and
the client is not returned to the pool until commit/rollback. Surfaced via `POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction()` | Acquires a client, runs `BEGIN`, arms a **5-minute auto-rollback** timer ([postgres.ts:461](../../src/lib/db/providers/sql/postgres.ts), duration set by `TX_TIMEOUT_MS`). Throws if one is already active. |
| `queryInTransaction(sql, params?)` | Runs on the transaction's client. Throws if none active. |
| `commitTransaction()` / `rollbackTransaction()` | Ends the transaction, clears the timer, releases the client. Throws if none active. |
| `expireTransaction()` | The timeout callback — auto-`ROLLBACK` to prevent leaked locks if a transaction is abandoned. |
| `isInTransaction()` | Current state. |

The auto-rollback timer is the key safety mechanism: a client that opens a transaction and
disconnects without committing would otherwise hold locks indefinitely.

`supportsTransactions: true` ([§10](#10-capabilities--labels)) is what tells the editor toolbar to
offer BEGIN/COMMIT/ROLLBACK and the auto-rolled-back SANDBOX toggle at all. It is declared rather
than inferred because the route's own gate is `isTransactionProvider(provider)`, a runtime shape
check no client can read, so before #464 those controls rendered on every
connection — including the ten providers that answer HTTP 400.

---

## 9. Maintenance

`runMaintenance(type, target?)` ([postgres.ts:762](../../src/lib/db/providers/sql/postgres.ts)),
with targets quoted via [§3.6](#36-safe-maintenance-targets):

| Type | With target | Without target |
|------|-------------|----------------|
| `vacuum` | `VACUUM ANALYZE <target>` | `VACUUM ANALYZE` (whole DB) |
| `analyze` | `ANALYZE <target>` | `ANALYZE` (whole DB) |
| `reindex` | `REINDEX TABLE <target>` | `REINDEX DATABASE <db>` |
| `kill` | `pg_terminate_backend(<pid>)` | throws (PID required) |

`getCapabilities().maintenanceOperations = ['vacuum', 'analyze', 'reindex', 'kill']`. `kill`
validates that the target parses as an integer PID.

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#496).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available. On PostgreSQL it never speaks, for the
same reason both surfaces were already right here: every declaration above is either both
placements or neither.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `vacuum` | Vacuum Table | yes | yes | `VACUUM ANALYZE <t>` and bare `VACUUM ANALYZE` both exist |
| `analyze` | Analyze Table | yes | yes | same, for `ANALYZE` |
| `reindex` | Reindex Table | yes | yes | `REINDEX TABLE <t>` / `REINDEX DATABASE <db>` |
| `kill` | Terminate Backend | no | no | the target is a backend PID, which only the Sessions panel lists |

PostgreSQL is the engine both surfaces were already right about - every statement here has
a one-table form and a whole-database form - so these declarations record the baseline the
other providers are measured against rather than a change in behaviour. `vacuumAction`
really means `vacuum` here, so `vacuumActionOperation` stays absent.

---

## 10. Capabilities & labels

### `getCapabilities()` ([postgres.ts:250](../../src/lib/db/providers/sql/postgres.ts))

Overrides the SQL base defaults:

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `explainFormat` | `postgres-json` |
| `supportsExternalQueryLimiting` | `true` |
| `supportsCreateTable` | `true` |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core PostgreSQL DML |
| `supportsTransactions` | `true` — `beginTransaction()` holds one pool client and runs `BEGIN` / `COMMIT` / `ROLLBACK` on it, so the editor's transaction trio and the auto-rolled-back SANDBOX toggle are offered here (#464) |
| `declaresForeignKeys` | `true` — inherited from the base capabilities; an empty `foreignKeys` list is then a fact about the schema or the reading role, never about the engine |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['vacuum', 'analyze', 'reindex', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `5432` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

### Labels

PostgreSQL keeps the default SQL vocabulary from `BaseDatabaseProvider` (entity → *Table*,
row → *row*, *Select Top 50*, *Vacuum Table*, *Analyze Table*, etc.) — the generic SQL wording
already fits.

`getLabels()` is overridden for **one** triad only: the Operations tab's global Reindex card, which
was hardcoded to *"Run Reindex"* / *"Rebuild Indexes"* / *"Reconstructs all indexes in the database."*
for every engine (#464). That wording was written for this engine — the global card
sends no target, so `runMaintenance('reindex')` here runs `REINDEX DATABASE`
([§9](#9-maintenance)) — so declaring it changes nothing on PostgreSQL and lets the two
other providers that offer `reindex` (SQLite, Couchbase) say what theirs does instead:

| Field | Value |
| --- | --- |
| `reindexGlobalLabel` | *Run Reindex* |
| `reindexGlobalTitle` | *Rebuild Indexes* |
| `reindexGlobalDesc` | *Runs REINDEX DATABASE, reconstructing every index in the database.* |

---

## 11. Error handling

Native `pg` errors are mapped by `mapDatabaseError()` ([errors.ts](../../src/lib/db/errors.ts)) onto
the shared hierarchy:

| Situation | Error |
|-----------|-------|
| Missing `host`/`database` (no connection string) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` (carries host/port) |
| SQL syntax / bad column / relation | `QueryError` (with position when available) |
| `statement_timeout` exceeded, or user cancel via `pg_cancel_backend` | `QueryCancelledError` — both emit *"canceling statement due to …"*, which `mapDatabaseError()` matches **before** its timeout check |
| Generic timeout / connection-acquire timeout (message contains "timeout"/"timed out", not "canceling statement") | `TimeoutError` |
| Bad password / authentication | `AuthenticationError` |
| Pool exhausted / too many connections | `PoolExhaustedError` |

`isRetryableError()` treats connection/timeout errors as retryable, but not auth, config, or
syntax errors.

---

## 12. Agent read-only execution profile (#328)

The agent programme (epic #325) never talks to the shared, fully-privileged provider. It acquires
a **dedicated provider keyed by (connection id, execution profile)** and runs every statement
through `queryReadOnly()`, where the DATABASE — not a SQL parser — is the boundary.

### 12.1 Acquisition (`acquireExecutionProfileProvider`, [factory.ts](../../src/lib/db/factory.ts))

- The profiled cache is physically separate from `getOrCreateProvider`'s cache: an agent
  acquisition never returns, inserts, or touches a shared writable entry (unit-tested in both
  directions), so an agent execution can never be handed the editor's pool — and vice versa.
- Provider types without a database-native read-only wrapper are refused with
  `PROFILE_UNSUPPORTED_BY_PROVIDER`; there is no fallback to `query()`. A provider that supports the
  profile but cannot apply it to *this* target refuses with `PROFILE_UNSUPPORTED_TARGET` (SQLite
  does this for `:memory:` — see [sqlite.md §12.3](./sqlite.md#123-per-statement-execution-queryreadonly)).
  Every refusal is an `ExecutionProfileError` carrying an `ExecutionProfileDenyCode`
  ([errors.ts](../../src/lib/db/errors.ts)), so callers branch on the code, never on a message.
- **The role is verified at open, not assumed** (see §12.3): a profile provider only connects if
  its role is genuinely least-privilege. This applies whichever credential resolves below, because
  an `agentUser` can be pointed at a superuser just as easily as a connection's own user can be one.
- Optional least-privilege credential: `agentUser` / `agentPassword` on the connection
  (`agentPassword` is secret-classified and sealed at rest by
  [connection-secrets](../../src/lib/storage/connection-secrets.ts)). Resolution fails closed:

  | Configuration | Outcome |
  |---|---|
  | Neither field set | Connection's own credentials — which must themselves pass the role check in §12.3 |
  | Both set, password resolves | Profile pool authenticates as `agentUser` |
  | Only one field set | `AGENT_CREDENTIAL_UNRESOLVABLE` — never a silent fallback to the more privileged default |
  | Sealed password that does not open | `AGENT_CREDENTIAL_UNRESOLVABLE` |
  | Combined with `connectionString` | `AGENT_CREDENTIAL_WITH_CONNECTION_STRING` — the pool config would silently drop the credential |

- Lifecycle: profiled providers idle out on the same 30-minute sweep, are removed alongside
  `removeProvider(connectionId)`, and share the connection's SSH tunnel (closed only once nothing
  serves the connection anymore).

### 12.2 Per-statement execution (`queryReadOnly`, [postgres.ts](../../src/lib/db/providers/sql/postgres.ts))

Each call runs:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = <budget.statementTimeoutMs>;  -- dies with the transaction
-- the single statement, sent on the extended query protocol
ROLLBACK;                                                   -- always; the profile never commits
DISCARD ALL;                                                -- session state a rollback keeps
```

`DISCARD ALL` is there because a rollback is not a full reset: an advisory lock taken inside the
transaction survives it (verified on PostgreSQL 18), and nothing on the agent path is *required* to
release one, so a pooled client would otherwise carry it into every later execution. It runs after the
rollback because it cannot run inside a transaction block. A client that fails either step is
destroyed rather than returned to the pool.

Two server-enforced properties carry the security claim:

1. **Writes are rejected by PostgreSQL itself** (SQLSTATE `25006`, *cannot execute … in a
   read-only transaction*). No SQL classification happens in this path.
2. **Single-statement is protocol-enforced**: the statement is sent with `queryMode: 'extended'`
   (pg ≥ 8.11), and the server refuses multi-command strings in a Parse message (SQLSTATE `42601`)
   before executing anything — so `SELECT 1; COMMIT; INSERT …` cannot commit its way out of the
   read-only transaction the way it could on the simple protocol.

A lone hostile statement cannot escape either — and the first of these is not theoretical:
`SET TRANSACTION READ WRITE` **is accepted inside `BEGIN READ ONLY` and does relax the transaction**
(verified on 18: a following `INSERT` committed), so what contains it is that it can only ever be
the transaction's only statement before the `ROLLBACK`. A session-level `SET` reverts with the
rollback (GUC changes are transactional); a bare `COMMIT` merely ends an empty read-only
transaction. A client whose cleanup fails is destroyed (`release(error)`), never returned to the
pool mid-transaction.

The `ReadOnlyStatementBudget` (`statementTimeoutMs`, `maxResultRows`, `maxResultBytes`,
[types.ts](../../src/lib/db/types.ts)) is validated as positive integers before any client is
acquired — the timeout is interpolated into `SET LOCAL`, which takes no bind parameters — and the
row/byte caps are enforced result-side after the statement returns.

`queryReadOnly()` exists only on a provider opened under the profile: called on an ordinary
provider it throws, because such a provider has had no role verification and would serve agent
semantics without the boundary that makes them true.

### 12.3 What the read-only transaction does NOT cover — and the role that does

A read-only transaction forbids changing the **database**. It does not forbid a statement from
reaching the **server**. Verified on PostgreSQL 18, all three of these succeeded inside
`BEGIN READ ONLY` as a superuser:

| Statement | What it did |
|---|---|
| `COPY (…) TO '<path>'` | wrote query results to an arbitrary server-side file |
| `COPY (…) TO PROGRAM '<cmd>'` | ran a shell command as the server's OS user |
| `SELECT pg_read_file('<path>')` | read an arbitrary server-side file |

As a role with only `CONNECT`/`USAGE`/`SELECT`, the same three are refused — by **privileges**
(`pg_write_server_files`, `pg_execute_server_program`, `pg_read_server_files` or superuser), not by
the transaction. Two consequences the profile implements rather than documents as advice:

1. **Opening the profile probes the role** and refuses with `PROFILE_PRIVILEGES_TOO_BROAD` unless
   superuser and all three predefined-role memberships read back false
   (`assertAgentRoleIsUnprivileged`, [postgres.ts](../../src/lib/db/providers/sql/postgres.ts)). The
   probe uses `to_regrole`, so a server missing a predefined role answers `false` rather than
   erroring. A server that answers nothing, or answers non-booleans, is refused too — an unproven
   boundary is not a boundary. Every catalog function the probe calls is written `pg_catalog`-
   qualified: `pg_catalog` is searched implicitly first only while it is not named in `search_path`,
   so a path that names it explicitly behind another schema lets a shadow `pg_has_role()` answer
   false for a superuser and defeat this check.

   What the probe proves is **non-membership and non-superuser**, not the absence of the capability:
   a role directly granted `EXECUTE` on `pg_read_file()` answers false to all four flags and can
   still read server files. That is why the recipe below says grant nothing else. The probe also
   runs **once, at open** — a profiled provider stays cached until the idle sweep, so a role granted
   new privileges afterwards keeps serving from the already-verified pool until it is evicted or
   `removeProvider` runs.
2. **`SET TRANSACTION READ WRITE` really works** inside `BEGIN READ ONLY` (also verified on 18: the
   following `INSERT` committed). What contains it is that it can only ever be the transaction's
   ONLY statement, after which the profile rolls back — so the single-statement rule in §12.2 is
   load-bearing, not decorative.

Recommended role for an agent target:

```sql
CREATE ROLE libredb_agent LOGIN PASSWORD '<secret>';
GRANT CONNECT ON DATABASE <db> TO libredb_agent;
GRANT USAGE ON SCHEMA <schema> TO libredb_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO libredb_agent;
-- Grant nothing else. In particular do NOT grant pg_read_server_files,
-- pg_write_server_files, pg_execute_server_program, or superuser.
```

Per-table `SELECT` grants are also what bound which rows an agent can READ: the policy layer's
catalog/schema allowlist screens the *declared* target, and only the grants bound what a hostile
statement could reach instead.

### 12.4 What drives this profile (#329)

#328 built the profile and nothing called it. The agent tool layer
([`src/lib/agent/tools.ts`](../../src/lib/agent/tools.ts)) is the code written to drive it, and it is
the only thing in the repository that will: every reach passes `executeAuditedOperation`, and the
provider comes from an execution-profile acquirer the layer is HANDED rather than one it imports,
always asked for `agent-read-only`.

Be precise about what is true at this commit, because the injection is easy to misread as wiring:
nothing in `src/` calls `acquireExecutionProfileProvider` yet. The acquirer is a parameter so that a
denial can be *proven* not to acquire anything (a test passes a spy and asserts it is never reached),
and the run loop ([`investigation.ts`](../../src/lib/agent/investigation.ts)) passes whatever its
caller handed it. There is a run service and a workflow but still no HTTP route (#329 T9), so the
path is reachable from server code and not from a request.

Four things about the PostgreSQL side of that layer are worth knowing here:

- **The catalog read is a composed bounded read**, not a new operation. `inspect_schema` takes a
  schema/table selector and the server writes
  `SELECT … FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', …)`, executed as
  `sql.query.read` like any other statement. The model never supplies that SQL. Selectors are quoted
  with `quoteLiteral` because `queryReadOnly` binds no parameters, and a selector carrying a
  backslash is refused outright rather than quoted — the dialect-less span reader treats it as an
  escape, so `'a\'` would read as an unterminated literal.
- **A run reads three catalog inventories at its start (#329 T8), not one.** `inspect_schema` takes
  a `kind` — `columns` (the default), `relations` (foreign keys, from `pg_constraint` with
  `unnest(conkey, confkey) WITH ORDINALITY` pairing the two sides) and `indexes` (from `pg_index`
  joined to `pg_class` and `pg_namespace`, with `indkey` unnested WITH ORDINALITY, carrying
  `indisunique` and `indisprimary`). The index read is also the only place on this path that says
  which columns are the primary key, since `information_schema.columns` does not carry it.
  **The relations read deliberately does not use the `information_schema` constraint views**
  (`table_constraints` / `key_column_usage` / `constraint_column_usage`): PostgreSQL restricts them
  to constraints on tables the role owns or holds a privilege on other than `SELECT`, so the
  least-privilege `libredb_agent` role read an empty graph — 0 rows on the seeded dvdrental where
  `pg_constraint WHERE contype = 'f'` holds 18. Those views also expose no ordinal, so a composite
  key came back as the cross-product of the two column lists, and a constraint name is unique per
  table rather than per schema, so two same-named constraints cross-matched; `pg_constraint` rows
  carry `conrelid` / `confrelid` and are identified by oid, which closes all three. Two properties
  of these projections worth knowing: an **expression index** appears with its expression in the
  written form `pg_get_indexdef(indexrelid, n, true)` emits, in the position `indkey` holds a 0 for,
  which is the same shape the SQLite side produces from the index DDL; and the *column* inventory is
  still the privilege-filtered one, since `information_schema.columns` shows a role only the tables it
  holds some privilege on — a smaller inventory on the agent path than the editor's is correct, not a
  defect, and it is the inventory a table has to appear in for the relation and index rows to attach
  to anything. All three are subject to the same row cap and are
  **refused, not truncated**, when a schema is wider than `maxResultRows`; the run then continues with
  no snapshot and is told to narrow `inspect_schema` itself.
- **Plan inspection uses `EXPLAIN (FORMAT JSON)`, never `EXPLAIN (ANALYZE, …)`.** The editor's
  Explain button emits the ANALYZE form deliberately (a user asked for real timings) and that form
  EXECUTES the statement, which on this engine performs a data-modifying CTE. The agent path is
  served by [`composed-sql.ts`](../../src/lib/agent/composed-sql.ts) instead, and the executing
  variant stays behind the approval-gated `sql.explain.analyze` descriptor that no tool reaches.
- **The statement timeout is clamped to the run's remaining wall clock** before it reaches
  `SET LOCAL statement_timeout`, so a statement cannot outlive the run that asked for it. Here that
  clamp really preempts; on SQLite it does not — see
  [sqlite.md §12](./sqlite.md#12-agent-read-only-execution-profile-328).

  Worth knowing what the preemption looks like coming back, because it is not what the name suggests:
  PostgreSQL reports it as `canceling statement due to statement timeout`, and `mapDatabaseError`
  matches `canceling statement` before its timeout branch, so it arrives as a `QueryCancelledError` and
  never as a `TimeoutError` on this engine. The agent tool layer treats it as a repairable statement
  failure — narrowing the read is the repair that helps — and the mapper discards the wording that
  would separate it from an operator cancel ([BACKLOG](../BACKLOG.md) B4), which is why a run
  cancellation is enforced by the run loop's own state rather than by that exception.

---

## 13. Testing

### 13.1 How the tests work

Integration tests live in
[`tests/integration/db/postgres-provider.test.ts`](../../tests/integration/db/postgres-provider.test.ts).
The `pg` driver is replaced with an in-process mock via `mock.module('pg', …)` **before** the
provider is imported — there is no live PostgreSQL in the suite. The mock's `Pool`/`Client` returns
canned result sets keyed by query shape, which exercises the same provider code paths as a real
server.

> **Mock isolation:** `bun`'s `mock.module()` is process-wide, so test files that mock different
> drivers (here `pg`, elsewhere `ioredis`, etc.) cross-contaminate when they share a process. Running
> a **single file** is safe (one file = one process). The full `bun run test` script runs the core
> group (`tests/unit tests/api tests/integration`) in **one process** and is therefore load-order
> flaky — so **CI does not use it**. The deterministic runner is **`bun run test:ci`** (per-file
> process isolation via `tests/run-core.sh`); the coverage workflow uses `bun run test:coverage`
> (also per-file). See [`CLAUDE.md`](../../CLAUDE.md).

### 13.2 Coverage

The suite (60+ tests) covers: validation (incl. connection-string bypass), connect/disconnect
idempotency, **every SSL precedence branch**, query + PID tracking + error mapping, query
cancellation, the full transaction lifecycle (incl. `expireTransaction` auto-rollback), all three
schema methods (PK detection, non-public prefixing, negative-`reltuples` clamping, empty-column
tables, cross-schema FK joins, null-column coercion), health (incl. the `pg_stat_statements`
placeholder path), maintenance (all types, identifier quoting, kill validation), overview/uptime
formatting, performance (incl. checkpoint fallback), slow queries (extension + `pg_stat_activity`
fallback), active sessions,
table/index/storage stats, pool stats, capabilities, and `pg_stat_activity` passthrough.

### 13.3 Run it

```bash
bun test tests/integration/db/postgres-provider.test.ts   # just this file (single process — safe)
bun run test:ci                                            # CI publish gate — per-file isolation (tests/run-core.sh)
bun run test:coverage                                      # CI coverage workflow — per-file core + components
```

### 13.4 Optional: verifying against a live PostgreSQL

The committed tests are mock-based by design. To smoke-test against a real server:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
# then point a connection at localhost:5432 (db=postgres, user=postgres) in the Studio UI
```

The E2E suite (`e2e/`) has been verified against PostgreSQL 18.x.

---

## 14. Usage examples

### 14.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'pg1', name: 'Prod', type: 'postgres',
  host: 'localhost', port: 5432, database: 'mydb',
  user: 'admin', password: 'secret', createdAt: new Date(),
});

await provider.connect();
const res = await provider.query('SELECT id, email FROM users WHERE active = $1', [true]);
const tree = await provider.getSchemaList();          // fast structural tree
const rels = await provider.getSchemaRelations();      // FKs + indexes to merge in
await provider.disconnect();
```

### 14.2 Over the API

- `POST /api/db/query` — run SQL (see [`API_DOCS.md`](../API_DOCS.md#post-apidbquery)).
- `POST /api/db/schema/list` and `POST /api/db/schema/relations` — two-phase schema.
- `POST /api/db/transaction` — begin/commit/rollback/query-in-tx.
- `POST /api/db/cancel` — cancel a running query by id.
- `POST /api/db/maintenance` — vacuum/analyze/reindex/kill (admin only).

---

## 15. Known limitations & future work

- **`transactionsPerSecond` / `queriesPerSecond` are not reported** (`undefined`) — they require
  time-based sampling of `pg_stat_database`, which the single-shot metric call doesn't do.
- **Row counts are planner estimates** (`pg_class.reltuples`), not exact `COUNT(*)` — fast but
  approximate, and `-1`/stale until the table is analyzed.
- **Slow-query history needs `pg_stat_statements`**; without the extension only a live snapshot of
  active queries is available.
- **WAL size and checkpoint times require elevated privileges** and are silently omitted otherwise.
- **Column introspection is capped at 100 columns** per table.
- **`blocked` on active sessions is always `false`** — lock-wait detection (`pg_locks`) is not yet
  wired in.
- **Cloud SSL auto-detect does not verify the server certificate.** When SSL is enabled by host
  heuristic (`shouldEnableSSL()`), it uses `rejectUnauthorized: false` — the connection is encrypted
  but **not authenticated**, so it is exposed to man-in-the-middle attacks. For verified TLS, set an
  explicit `connection.ssl` with mode `verify-system` (nothing to paste — the runtime's trust store
  checks the chain, which is what a managed provider's certificate needs) or `verify-ca`/`verify-full`
  with a `caCert`. *Future:* prefer verifying modes by default and treat the heuristic as
  encryption-only opportunistic TLS.

---

## 16. References

- Driver: [`pg` (node-postgres)](https://github.com/brianc/node-postgres)
- Source: [`src/lib/db/providers/sql/postgres.ts`](../../src/lib/db/providers/sql/postgres.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Pool manager: [`src/lib/db/utils/pool-manager.ts`](../../src/lib/db/utils/pool-manager.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/postgres-provider.test.ts`](../../tests/integration/db/postgres-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [Apache Trino](./trino.md) · [Redis](./redis.md)
