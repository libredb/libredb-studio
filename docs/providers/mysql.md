# MySQL Provider

> MySQL support for LibreDB Studio, built on the [`mysql2`](https://github.com/sidorares/node-mysql2) driver.
> This document is the single reference point for the MySQL provider: design, architecture, usage,
> and tests. MySQL is a SQL-family provider; it shares `SQLBaseProvider` with PostgreSQL — read the
> [PostgreSQL doc](./postgres.md) first if you want the canonical SQL walkthrough, then this doc for
> the MySQL-specific deltas.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `mysql` |
| **Family** | SQL (relational) |
| **Driver** | `mysql2/promise` |
| **Query language** | `sql` |
| **Default port** | `3306` |
| **Connection pooling** | Yes — `mysql2` pool (`connectionLimit` = pool `max`, default 10) |
| **Connection string** | Supported (`mysql://`, via the pool `uri` option) |
| **Transactions** | Yes — explicit begin/commit/rollback with auto-rollback timeout |
| **Query cancellation** | Yes — thread-id tracking + `KILL QUERY` |
| **Source** | [`src/lib/db/providers/sql/mysql.ts`](../../src/lib/db/providers/sql/mysql.ts) |
| **Base** | [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) |
| **Tests** | [`tests/integration/db/mysql-provider.test.ts`](../../tests/integration/db/mysql-provider.test.ts) |

---

## 1. Overview

MySQL is a relational database and maps onto the `DatabaseProvider` interface much like PostgreSQL.
It extends the shared `SQLBaseProvider` (identifier quoting with backticks, automatic `LIMIT`
injection, `?` placeholders, cloud SSL auto-detection) and layers MySQL-specific introspection and
monitoring on top of `mysql2`.

The most useful way to read this doc is **as a diff against the [PostgreSQL provider](./postgres.md)**,
which is the SQL reference implementation. The headline differences:

| Aspect | PostgreSQL | MySQL |
|--------|------------|-------|
| Schema introspection | One `MATERIALIZED`-CTE round-trip + two-phase (`getSchemaList`/`getSchemaRelations`) | Single `getSchema()`, **N+1** (1 + 3 queries per table), **no** two-phase split |
| Schema scope | All non-system schemas, cross-schema FKs | **Single database** (`TABLE_SCHEMA = <db>`), bare table names |
| Maintenance ops | `vacuum`, `analyze`, `reindex`, `kill` | `analyze`, `optimize`, `check`, `kill` |
| Query timeout | `statement_timeout` from `queryTimeout` | **Not wired** — no server-side query timeout |
| Pool config honored | `min`/`max`/`idleTimeout`/`acquireTimeout` | **`max` only** (`connectionLimit`) |
| Queries-per-second metric | `undefined` (needs sampling) | Reported (`Queries`/`Uptime`) |
| BLOB/binary values | driver-native | sanitized to `0x…` hex strings |

---

## 2. Architecture

Same Strategy-Pattern hierarchy as the other SQL providers:

```
DatabaseProvider (interface) → BaseDatabaseProvider → SQLBaseProvider → MySQLProvider
```

`MySQLProvider` inherits the shared SQL helpers from
[`sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) — see the
[PostgreSQL doc §2.2](./postgres.md#22-what-sqlbaseprovider-provides) for the full table. The two
that matter most here:

- **`escapeIdentifier()`** quotes MySQL identifiers with **backticks** (`` `ident` ``), doubling any
  embedded backtick.
- **`prepareQuery()`** injects `LIMIT` into bare `SELECT`s; the underlying `analyzeQuery()` also
  understands MySQL's `LIMIT offset, count` syntax (see [§5.2](#52-automatic-limit-injection)).

### Registration

Loaded on demand by the factory ([`factory.ts:71`](../../src/lib/db/factory.ts)):

```ts
case 'mysql': {
  const { MySQLProvider } = await import('./providers/sql/mysql');
  return new MySQLProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 N+1 schema introspection (no MATERIALIZED CTEs, no two-phase split)

Unlike PostgreSQL, `getSchema()` ([mysql.ts:327](../../src/lib/db/providers/sql/mysql.ts)) runs one
query for the table list and then **three queries per table** (columns, foreign keys, indexes) —
the classic `1 + N*3` pattern. MySQL also does **not** implement `getSchemaList()` /
`getSchemaRelations()`, so the two-phase fast-tree loading that PostgreSQL uses is unavailable; the
`/api/db/schema/list` route falls back to the single `getSchema()`. On a very large schema this is
more round-trips than the Postgres approach — see [Known limitations](#14-known-limitations--future-work).

### 3.2 Single-database scope

Every introspection query is parameterized with `TABLE_SCHEMA = ?` bound to `config.database`. MySQL
"schemas" *are* databases, so the provider only ever sees the connected database, and table display
names are bare (no `schema.table` prefixing). There is no cross-schema FK resolution to worry about.

### 3.3 BLOB / binary values sanitized to hex

`sanitizeRow()` ([mysql.ts:175](../../src/lib/db/providers/sql/mysql.ts)) walks every result row and
converts `Buffer` values to `0x<hex>` strings (empty buffers → `''`). MySQL returns `BLOB`/`BINARY`
columns as Node `Buffer`s; without this they would not serialize cleanly to the JSON grid. This runs
on both `query()` and `queryInTransaction()`.

### 3.4 Prepared statements via `execute()`

Both query paths use `conn.execute(sql, params)` (mysql2 server-side prepared statements) rather than
`query()`, so parameterized queries are bound by the server. `rowCount` is derived from
`rows.length` (mysql2 does not return a separate affected-rows count on the `RowDataPacket[]` path).

### 3.5 No server-side query timeout

The pool config ([mysql.ts:119](../../src/lib/db/providers/sql/mysql.ts)) intentionally sets only
mysql2-specific options and **does not** translate `ProviderOptions.queryTimeout` into a server-side
timeout (MySQL has no direct `statement_timeout` pool option like Postgres). A runaway query is not
auto-killed by the provider; cancellation is explicit via [`cancelQuery()`](#53-query-cancellation).

### 3.6 Maintenance over all tables when no target

`analyze`/`optimize`/`check` without a target run against **all base tables** in the database
(`getAllTablesForMaintenance()`, capped at **50** tables, [mysql.ts:562](../../src/lib/db/providers/sql/mysql.ts)),
each name quoted via `escapeIdentifier()`. With a target, the single quoted table is used.

---

## 4. Connection

### 4.1 Configuration

Two forms (`validate()`, [mysql.ts:71](../../src/lib/db/providers/sql/mysql.ts)). `validate()`
requires `host` **and** `database` only when no `connectionString` is given — it does not reject
supplying both; if both are present the connection string is used (passed to the pool as `uri`).

```ts
// Discrete fields (host + database required when no connection string)
const a = { id: 'my-1', name: 'App DB', type: 'mysql',
  host: 'localhost', port: 3306, database: 'app',
  user: 'root', password: 'secret', createdAt: new Date() };

// Connection string
const b = { id: 'my-1', name: 'App DB', type: 'mysql',
  connectionString: 'mysql://root:secret@localhost:3306/app', createdAt: new Date() };
```

### 4.2 Connection pooling

`connect()` builds a `mysql2` pool and validates it by acquiring/releasing one connection. The pool
options ([mysql.ts:119](../../src/lib/db/providers/sql/mysql.ts)):

| mysql2 option | Value | Source |
|---------------|-------|--------|
| `connectionLimit` | pool `max` (default 10) | `ProviderOptions.pool.max` |
| `waitForConnections` | `true` | fixed |
| `queueLimit` | `0` (unbounded queue) | fixed |
| `enableKeepAlive` | `true` | fixed |
| `keepAliveInitialDelay` | `10000` ms | fixed |
| `timezone` | `'Z'` | `ProviderOptions.timezone ?? 'Z'` |

> ⚠️ Only `max` from `DEFAULT_POOL_CONFIG` is honored. `min`, `idleTimeout`, and `acquireTimeout`
> are **not** mapped (the mysql2 pool model differs from `pg`), and `queryTimeout` is **not** applied
> (see [§3.5](#35-no-server-side-query-timeout)).

`connect()` is idempotent. Unlike the PostgreSQL provider, MySQL exposes **no** `getPoolStats()`.

### 4.3 SSL

`buildSSLConfig()` ([mysql.ts:147](../../src/lib/db/providers/sql/mysql.ts)) — note `disable`
returns `undefined` (mysql2's "off"), not `false`:

1. **Explicit `connection.ssl`** (`SSLConfig`): `disable` → `undefined`; `verify-ca`/`verify-full` →
   `rejectUnauthorized: true` (otherwise `false`); `caCert`/`clientCert`/`clientKey` → `ca`/`cert`/`key`.
2. **`options.ssl === true` or cloud auto-detect** — `shouldEnableSSL()` (`options.ssl === true` *or*
   a known managed host) enables `{ rejectUnauthorized: false }`.
3. Otherwise `undefined`.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([mysql.ts:190](../../src/lib/db/providers/sql/mysql.ts)) acquires a
pooled connection, optionally records its `threadId` for cancellation, runs the prepared statement,
sanitizes binary values, and returns the standard envelope:

```ts
{ rows, fields: string[], rowCount: rows.length, executionTime }
```

Native `mysql2` errors are normalised via `mapDatabaseError()` into the shared
[`errors.ts`](../../src/lib/db/errors.ts) classes.

### 5.2 Automatic `LIMIT` injection

Inherited from `SQLBaseProvider.prepareQuery()` (see [PostgreSQL doc §5.2](./postgres.md#52-automatic-limit-injection)).
The shared `analyzeQuery()` recognises both standard `LIMIT n [OFFSET m]` and MySQL's
`LIMIT offset, count` form, so an already-limited MySQL query is respected rather than double-limited.
Default page size `DEFAULT_QUERY_LIMIT = 500`; unlimited caps at `MAX_UNLIMITED_ROWS = 100000`.

### 5.3 Query cancellation

A query issued with a `queryId` records its connection `threadId`. `cancelQuery(queryId)`
([mysql.ts:220](../../src/lib/db/providers/sql/mysql.ts)) issues `KILL QUERY <threadId>` and returns
`true` on success (it does not verify the target was actually mid-query). The killed query surfaces
to its caller as a `QueryCancelledError` (MySQL emits *"Query execution was interrupted"*, which
`mapDatabaseError()` classifies as cancellation). Exposed via `POST /api/db/cancel`.

---

## 6. Transactions

Identical lifecycle to PostgreSQL, on a **dedicated connection checked out from the pool and held
for the transaction's duration** (so every statement runs on the same connection; it is not returned
to the pool until commit/rollback). Surfaced via `POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction()` | `pool.getConnection()` + `beginTransaction()`, arms a **5-minute auto-rollback** timer ([mysql.ts:46](../../src/lib/db/providers/sql/mysql.ts)). Throws if one is active. |
| `queryInTransaction(sql, params?)` | Runs on the transaction's connection (with the same binary sanitization). Throws if none active. |
| `commitTransaction()` / `rollbackTransaction()` | Ends it, clears the timer, releases the connection. Throws if none active. |
| `expireTransaction()` | Timeout callback — auto-`rollback()` to prevent leaked locks. |
| `isInTransaction()` | Current state. |

---

## 7. Schema introspection

`getSchema()` returns one `TableSchema` per `BASE TABLE` in the connected database. Per table it
issues three follow-up queries:

| Data | Source | Notes |
|------|--------|-------|
| Tables | `information_schema.TABLES` | `TABLE_ROWS` (engine estimate), `DATA_LENGTH + INDEX_LENGTH` |
| Columns | `information_schema.COLUMNS` | first 100 (`LIMIT 100`); `isPrimary` = `COLUMN_KEY = 'PRI'` |
| Foreign keys | `information_schema.KEY_COLUMN_USAGE` | rows where `REFERENCED_TABLE_NAME IS NOT NULL` |
| Indexes | `information_schema.STATISTICS` | `GROUP_CONCAT` columns by `SEQ_IN_INDEX`; `unique` = `NOT NON_UNIQUE` |

There is no `getSchemaList()`/`getSchemaRelations()` — see [§3.1](#31-n1-schema-introspection-no-materialized-ctes-no-two-phase-split).

---

## 8. Monitoring & health

All monitoring reads from `SHOW STATUS`/`SHOW VARIABLES`, `information_schema`, and
`performance_schema`. `getMonitoringData()` (inherited) fans these out in parallel.

| Method | Primary source | Notes |
|--------|----------------|-------|
| `getHealth()` | `SHOW STATUS`, `information_schema.TABLES`/`PROCESSLIST`, `performance_schema` | connections, size (MB), InnoDB buffer hit %, top-5 slow queries, 10 sessions |
| `getOverview()` | `VERSION()`, `SHOW STATUS/VARIABLES`, `information_schema` | version, uptime, conns, max_conns, size, table/index counts |
| `getPerformanceMetrics()` | `performance_schema.global_status` | cache-hit %, **queries/sec** (`Queries`/`Uptime`), buffer-pool %, deadlocks |
| `getSlowQueries()` | `performance_schema.events_statements_summary_by_digest` | per-digest stats |
| `getActiveSessions()` | `information_schema.PROCESSLIST` | pid, user, db, host, command, duration |
| `getTableStats()` | `information_schema.TABLES` | sizes; bloat **estimated from `DATA_FREE`** (no live/dead tuples, no last-vacuum/analyze) |
| `getIndexStats()` | `information_schema.STATISTICS` (+ optional `INNODB_*`) | columns, unique/primary; **`scans` = `CARDINALITY`** (a proxy, not a real scan counter) |
| `getStorageStats()` | `information_schema.TABLES`, `SHOW BINARY LOGS` | Data size, Binary Logs (if enabled), InnoDB data file (size `N/A`) |

**Graceful degradation — note the *different* failure modes:**
- `getHealth()` slow-queries: try/catch → a single placeholder row (*"Performance schema not available"*).
- `getSlowQueries()`: try/catch → **empty array** `[]`.
- `getPerformanceMetrics()`: the whole method is wrapped — on any failure it returns **static defaults**
  (`cacheHitRatio: 99`, `queriesPerSecond/bufferPoolUsage/deadlocks: 0`). These defaults can read as
  "healthy" even when `performance_schema` is simply off — see [Known limitations](#14-known-limitations--future-work).

---

## 9. Maintenance

`runMaintenance(type, target?)` ([mysql.ts:507](../../src/lib/db/providers/sql/mysql.ts)); targets
are backtick-quoted via `escapeIdentifier()`:

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `ANALYZE TABLE <t>` | `ANALYZE TABLE <all base tables, ≤50>` |
| `optimize` | `OPTIMIZE TABLE <t>` | `OPTIMIZE TABLE <all base tables, ≤50>` |
| `check` | `CHECK TABLE <t>` | `CHECK TABLE <all base tables, ≤50>` |
| `kill` | `KILL <connection-id>` | throws (id required) |

`getCapabilities().maintenanceOperations = ['analyze', 'optimize', 'check', 'kill']`. `kill`
validates that the target parses as an integer connection id.

---

## 10. Capabilities & labels

### `getCapabilities()` ([mysql.ts:57](../../src/lib/db/providers/sql/mysql.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'optimize', 'check', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `3306` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

### Labels

MySQL uses the default SQL `getLabels()` from `BaseDatabaseProvider` (entity → *Table*, *Select Top
50*, etc.); it is not overridden. (The default `analyzeAction`/`vacuumAction` wording is generic SQL
phrasing; MySQL's actual maintenance verbs are optimize/check/analyze.)

---

## 11. Error handling

Native `mysql2` errors are mapped by the shared `mapDatabaseError()`
([errors.ts](../../src/lib/db/errors.ts)). What reliably maps for MySQL:

| Situation | Error |
|-----------|-------|
| Missing `host`/`database` (no connection string) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` (carries host/port) |
| Access denied (`ER_ACCESS_DENIED`, message contains *access denied*) | `AuthenticationError` |
| Connection refused / DNS (`ECONNREFUSED`, `getaddrinfo`) | `ConnectionError` |
| Killed query (*"Query execution was interrupted"*) | `QueryCancelledError` |
| Other server errors (most `ER_*` codes) | `QueryError` / `DatabaseError` carrying the original message |

> The mapper is **text-heuristic**, so MySQL `ER_*` codes that don't match a known phrase fall
> through to a generic `QueryError`/`DatabaseError` with the driver's message preserved. There is
> **no** provider-driven `TimeoutError` for queries, because no `statement_timeout` is configured
> ([§3.5](#35-no-server-side-query-timeout)).

---

## 12. Testing

### 12.1 How the tests work

Integration tests live in
[`tests/integration/db/mysql-provider.test.ts`](../../tests/integration/db/mysql-provider.test.ts).
The `mysql2/promise` module is replaced with an in-process mock via `mock.module('mysql2/promise', …)`
**before** the provider is imported — there is no live MySQL in the suite. The mock's pool/connection
returns canned `[rows, fields]` tuples, exercising the same provider code paths as a real server.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide, so files mocking different drivers
> cross-contaminate when they share a process. A **single file** is safe (one file = one process).
> The full `bun run test` script runs the core group in **one** process and is load-order flaky, so
> **CI does not use it** — the deterministic runner is **`bun run test:ci`** (per-file isolation via
> `tests/run-core.sh`); the coverage workflow uses `bun run test:coverage`. See [`CLAUDE.md`](../../CLAUDE.md).

### 12.2 Coverage

20+ describe blocks cover: validation (incl. connection-string bypass), connect/disconnect,
capabilities, `getSchema()` (columns/FKs/indexes, primary-key detection), health, maintenance (all
types + kill validation), the full transaction lifecycle, `queryInTransaction`, query cancellation,
overview, performance metrics, slow queries, active sessions, table/index/storage stats, every SSL
branch, `prepareQuery`, and error mapping (`ER_ACCESS_DENIED`, `ECONNREFUSED`).

### 12.3 Run it

```bash
bun test tests/integration/db/mysql-provider.test.ts   # just this file (single process — safe)
bun run test:ci                                         # CI publish gate — per-file isolation (tests/run-core.sh)
bun run test:coverage                                   # CI coverage workflow — per-file core + components
```

### 12.4 Optional: verifying against a live MySQL

```bash
docker run --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=app -p 3306:3306 mysql:8
# then point a connection at localhost:3306 (db=app, user=root) in the Studio UI
```

---

## 13. Usage examples

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'my1', name: 'App', type: 'mysql',
  host: 'localhost', port: 3306, database: 'app',
  user: 'root', password: 'secret', createdAt: new Date(),
});

await provider.connect();
const res = await provider.query('SELECT id, email FROM users WHERE active = ?', [1]);
const schema = await provider.getSchema();   // single call (no two-phase split)
await provider.disconnect();
```

Over the API: `POST /api/db/query`, `POST /api/db/transaction`, `POST /api/db/cancel`,
`POST /api/db/maintenance` (admin), and `POST /api/db/schema/list` (falls back to `getSchema()`).

---

## 14. Known limitations & future work

- **No server-side query timeout.** The pool ignores `queryTimeout`; a runaway query is not
  auto-killed (only explicit `cancelQuery()`/`KILL QUERY`). *Future:* set a session
  `MAX_EXECUTION_TIME` / `wait_timeout` from `queryTimeout`.
- **N+1 schema introspection, no two-phase loading.** `getSchema()` issues `1 + 3×tables` queries
  and there is no `getSchemaList()`/`getSchemaRelations()`, so large schemas are slower than the
  Postgres MATERIALIZED-CTE path and the tree cannot stream relationships in.
- **Pool tuning is limited** to `max` (`connectionLimit`); `min`/`idleTimeout`/`acquireTimeout` are
  ignored.
- **Index `scans` is `CARDINALITY`**, an estimate of distinct values — not a real index-usage/scan
  counter (MySQL has no `pg_stat_user_indexes.idx_scan` equivalent).
- **Row counts (`TABLE_ROWS`) are engine estimates** for InnoDB, not exact counts.
- **Table bloat is estimated from `DATA_FREE`** (free space), an approximation.
- **`getPerformanceMetrics()` falls back to static defaults** (`99`/`0`/`0`/`0`) when
  `performance_schema` is unavailable, which can misleadingly read as a healthy server.
- **`cancelQuery()` returns `true` on `KILL QUERY` success** without confirming the target was
  actually executing.
- **Cloud SSL auto-detect uses `rejectUnauthorized: false`** — encrypted but **not** authenticated
  (MITM-exposed). For verified TLS, set an explicit `connection.ssl` with mode `verify-ca`/`verify-full`
  and a `caCert`.

---

## 15. References

- Driver: [`mysql2`](https://github.com/sidorares/node-mysql2)
- Source: [`src/lib/db/providers/sql/mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/mysql-provider.test.ts`](../../tests/integration/db/mysql-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [Redis](./redis.md)
