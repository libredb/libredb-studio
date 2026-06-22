# PostgreSQL Provider

> Full PostgreSQL support for LibreDB Studio, built on the [`pg`](https://github.com/brianc/node-postgres) driver.
> This document is the single reference point for the PostgreSQL provider: design, architecture,
> usage, and tests. PostgreSQL is the **reference implementation** for the SQL provider family — if
> you are authoring or maintaining another SQL provider, read this alongside the source.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `postgres` |
| **Family** | SQL (relational) |
| **Driver** | `pg` (node-postgres) |
| **Query language** | `sql` |
| **Default port** | `5432` |
| **Connection pooling** | Yes — `pg.Pool` (min 2 / max 10 by default) |
| **Connection string** | Supported (`postgres://` / `postgresql://`) |
| **Transactions** | Yes — explicit `BEGIN`/`COMMIT`/`ROLLBACK` with auto-rollback timeout |
| **Query cancellation** | Yes — PID tracking + `pg_cancel_backend` |
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
| `escapeIdentifier()` ([sql-base.ts:38](../../src/lib/db/providers/sql/sql-base.ts)) | Dialect-aware quoting — `"ident"` for Postgres, `` `ident` `` for MySQL, `[ident]` for MSSQL; doubles embedded quote chars |
| `getPlaceholder()` ([sql-base.ts:73](../../src/lib/db/providers/sql/sql-base.ts)) | `$1`-style placeholders for Postgres (`?` for MySQL/SQLite, `:n` Oracle, `@pn` MSSQL) |
| `shouldEnableSSL()` ([sql-base.ts:83](../../src/lib/db/providers/sql/sql-base.ts)) | Auto-enables SSL for known cloud hosts (supabase, neon, render, aws, azure, gcp, …) |
| `getDefaultSchema()` ([sql-base.ts:111](../../src/lib/db/providers/sql/sql-base.ts)) | `public` for Postgres |
| `prepareQuery()` ([sql-base.ts:157](../../src/lib/db/providers/sql/sql-base.ts)) | Injects `LIMIT` into bare `SELECT`s — see [§5.2](#52-automatic-limit-injection) |

### 2.3 Registration & lifecycle

The factory loads the provider via dynamic import so the `pg` driver is only pulled in when a
PostgreSQL connection is opened ([`factory.ts:66`](../../src/lib/db/factory.ts)):

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
`AS MATERIALIZED` ([postgres.ts:77–81](../../src/lib/db/providers/sql/postgres.ts)). PostgreSQL 12+
*inlines* single-reference CTEs by default, which lets the planner re-execute these
`information_schema`-based CTEs inside nested-loop joins (it estimates `rows=1` for them). On a
large schema (100+ tables/constraints/indexes) that explodes into minutes of planning/execution.
`MATERIALIZED` forces each CTE to compute exactly once:

> **~295s → ~2.6s on a 122-table schema.**

If you edit these queries, keep `MATERIALIZED` or you reintroduce the timeout.

### 3.2 Schema SQL hoisted to module scope

`SCHEMA_FULL_SQL`, `SCHEMA_LIST_SQL`, and `SCHEMA_RELATIONS_SQL` are module-level `const`s, not
inline template literals inside the methods ([postgres.ts:70–75](../../src/lib/db/providers/sql/postgres.ts)).
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
- `pg_stat_statements` (slow queries) is wrapped in try/catch and falls back to a `pg_stat_activity`
  snapshot of currently-running queries when the extension isn't installed.
- WAL size (`getStorageStats`) and `pg_stat_bgwriter` checkpoint times are superuser/version-gated;
  failures are swallowed and the field is simply omitted or reported as `N/A`.

### 3.6 Safe maintenance targets

`qualifyMaintenanceTarget()` ([postgres.ts:748](../../src/lib/db/providers/sql/postgres.ts)) quotes
maintenance targets through `escapeIdentifier()`: a bare name defaults to the `public` schema; a
`schema.table` target is quoted per-part. This prevents identifier injection in `VACUUM`/`ANALYZE`/
`REINDEX` statements (which cannot use bind parameters for object names).

---

## 4. Connection

### 4.1 Configuration

Two mutually-exclusive forms are accepted (validated in `validate()`,
[postgres.ts:264](../../src/lib/db/providers/sql/postgres.ts)):

**Discrete fields** — `host` and `database` are both required:

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

### 4.2 Connection pooling

`connect()` builds a `pg.Pool` ([postgres.ts:281](../../src/lib/db/providers/sql/postgres.ts)) and
validates it by acquiring and releasing one client. Pool sizing comes from `ProviderOptions.pool`
merged over `DEFAULT_POOL_CONFIG`:

| Setting | Default | `pg` mapping |
|---------|---------|--------------|
| `min` | 2 | `min` |
| `max` | 10 | `max` |
| `idleTimeout` | 30000 ms | `idleTimeoutMillis` |
| `acquireTimeout` | 60000 ms | `connectionTimeoutMillis` |
| `queryTimeout` | 60000 ms | `statement_timeout` |

`connect()` is idempotent (a second call while a pool exists is a no-op). `getPoolStats()` exposes
live `{ total, idle, active, waiting }` counts. Every query acquires a client from the pool and
releases it in a `finally` block.

### 4.3 SSL

`buildSSLConfig()` ([postgres.ts:342](../../src/lib/db/providers/sql/postgres.ts)) resolves SSL with
this precedence:

1. **Explicit `connection.ssl`** (`SSLConfig`, mode = `disable` | `require` | `verify-ca` | `verify-full`):
   - `disable` → no SSL.
   - `verify-ca` / `verify-full` → `rejectUnauthorized: true`; otherwise `false`.
   - `caCert` / `clientCert` / `clientKey` map to `ca` / `cert` / `key`.
2. **Cloud auto-detect** — `shouldEnableSSL()` enables `{ rejectUnauthorized: false }` for known
   managed hosts.
3. **`options.ssl === false`** → no SSL.
4. Otherwise `undefined` (driver default).

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([postgres.ts:378](../../src/lib/db/providers/sql/postgres.ts))
acquires a pooled client, optionally records its backend PID for cancellation, runs the
(optionally parameterized — `$1`, `$2`, …) statement, and returns the standard envelope:

```ts
{ rows, fields: string[], rowCount, executionTime }
```

Native `pg` errors are normalised through `mapDatabaseError()` into the shared
[`errors.ts`](../../src/lib/db/errors.ts) classes (syntax → `QueryError`, auth → `AuthenticationError`,
timeout → `TimeoutError`, etc.).

### 5.2 Automatic `LIMIT` injection

`prepareQuery()` (inherited from `SQLBaseProvider`) protects the UI from runaway result sets. It
runs the query through `analyzeQuery()` ([query-limiter.ts:59](../../src/lib/db/utils/query-limiter.ts))
and, **only for `SELECT`/CTE-`SELECT` queries that don't already have a `LIMIT`**, appends one via
`applyQueryLimit()`:

- Default page size: `DEFAULT_QUERY_LIMIT = 500`.
- "Unlimited" mode caps at `MAX_UNLIMITED_ROWS = 100000`.
- Existing `LIMIT` / `FETCH FIRST … ROWS ONLY` / `TOP n` / `ROWNUM` is detected and respected
  (not double-limited).
- Non-`SELECT` statements (INSERT/UPDATE/DELETE/DDL) are returned unchanged.

`prepareQuery()` is a *preparation* step (the UI calls it before `query()`); `query()` itself runs
exactly the SQL it is handed.

### 5.3 Query cancellation

A query issued with a `queryId` records its backend PID in a `Map`. `cancelQuery(queryId)`
([postgres.ts:412](../../src/lib/db/providers/sql/postgres.ts)) looks the PID up and calls
`pg_cancel_backend(pid)` on a fresh pooled client, returning whether the cancel signalled. Exposed
via `POST /api/db/cancel`.

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
| `getHealth()` | `pg_stat_activity`, `pg_database_size`, `pg_statio_user_tables`, `pg_stat_statements` | connections, size, cache-hit %, top-5 slow queries (+fallback), 10 sessions |
| `getOverview()` | `version()`, `pg_postmaster_start_time()`, `pg_settings`, `pg_database_size`, `pg_tables`/`pg_indexes` | version, uptime, conns, max_conns, size, table/index counts |
| `getPerformanceMetrics()` | `pg_statio_user_tables`, `pg_stat_database`, `pg_stat_bgwriter` | cache-hit %, buffer-pool %, deadlocks, checkpoint write time (gated) |
| `getSlowQueries()` | `pg_stat_statements` → fallback `pg_stat_activity` | detailed per-statement stats; fallback shows live active queries |
| `getActiveSessions()` | `pg_stat_activity` | pid, user, state, query, wait events, duration; excludes own backend |
| `getTableStats()` | `pg_stat_user_tables` + size functions | live/dead tuples, sizes, last (auto)vacuum/analyze, bloat ratio |
| `getIndexStats()` | `pg_stat_user_indexes`, `pg_index`, `pg_am` | type, columns, unique/primary, size, scan count, usage ratio |
| `getStorageStats()` | `pg_tablespace`, WAL functions | per-tablespace size; WAL size (superuser-gated, swallowed if denied) |
| `getPgStatActivity()` | `pg_stat_activity` | raw passthrough for advanced views |

`getTableStats()` / `getIndexStats()` accept an optional `{ schema }` filter; with none they cover
all user schemas.

---

## 8. Transactions

PostgreSQL exposes an explicit transaction lifecycle on a **dedicated client held outside the pool**
(so all statements in a transaction run on the same backend). Surfaced via `POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction()` | Acquires a client, runs `BEGIN`, arms a **5-minute auto-rollback** timer ([postgres.ts:239](../../src/lib/db/providers/sql/postgres.ts)). Throws if one is already active. |
| `queryInTransaction(sql, params?)` | Runs on the transaction's client. Throws if none active. |
| `commitTransaction()` / `rollbackTransaction()` | Ends the transaction, clears the timer, releases the client. Throws if none active. |
| `expireTransaction()` | The timeout callback — auto-`ROLLBACK` to prevent leaked locks if a transaction is abandoned. |
| `isInTransaction()` | Current state. |

The auto-rollback timer is the key safety mechanism: a client that opens a transaction and
disconnects without committing would otherwise hold locks indefinitely.

---

## 9. Maintenance

`runMaintenance(type, target?)` ([postgres.ts:756](../../src/lib/db/providers/sql/postgres.ts)),
with targets quoted via [§3.6](#36-safe-maintenance-targets):

| Type | With target | Without target |
|------|-------------|----------------|
| `vacuum` | `VACUUM ANALYZE <target>` | `VACUUM ANALYZE` (whole DB) |
| `analyze` | `ANALYZE <target>` | `ANALYZE` (whole DB) |
| `reindex` | `REINDEX TABLE <target>` | `REINDEX DATABASE <db>` |
| `kill` | `pg_terminate_backend(<pid>)` | throws (PID required) |

`getCapabilities().maintenanceOperations = ['vacuum', 'analyze', 'reindex', 'kill']`. `kill`
validates that the target parses as an integer PID.

---

## 10. Capabilities & labels

### `getCapabilities()` ([postgres.ts:250](../../src/lib/db/providers/sql/postgres.ts))

Overrides the SQL base defaults:

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `supportsExternalQueryLimiting` | `true` |
| `supportsCreateTable` | `true` |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['vacuum', 'analyze', 'reindex', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `5432` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

### Labels

PostgreSQL uses the default SQL `getLabels()` from `BaseDatabaseProvider` (entity → *Table*,
row → *row*, *Select Top 50*, *Vacuum Table*, *Analyze Table*, etc.) — no override needed, since
the generic SQL wording already fits.

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
| `statement_timeout` exceeded | `TimeoutError` |
| Cancelled statement | `QueryCancelledError` |
| Bad password / authentication | `AuthenticationError` |
| Pool exhausted / too many connections | `PoolExhaustedError` |

`isRetryableError()` treats connection/timeout errors as retryable, but not auth, config, or
syntax errors.

---

## 12. Testing

### 12.1 How the tests work

Integration tests live in
[`tests/integration/db/postgres-provider.test.ts`](../../tests/integration/db/postgres-provider.test.ts).
The `pg` driver is replaced with an in-process mock via `mock.module('pg', …)` **before** the
provider is imported — there is no live PostgreSQL in the suite. The mock's `Pool`/`Client` returns
canned result sets keyed by query shape, which exercises the same provider code paths as a real
server.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide. Run with `bun run test`
> (isolated execution groups) — never bare `bun test` across files. See [`CLAUDE.md`](../../CLAUDE.md).

### 12.2 Coverage

The suite (60+ tests) covers: validation (incl. connection-string bypass), connect/disconnect
idempotency, **every SSL precedence branch**, query + PID tracking + error mapping, query
cancellation, the full transaction lifecycle (incl. `expireTransaction` auto-rollback), all three
schema methods (PK detection, non-public prefixing, negative-`reltuples` clamping, empty-column
tables, cross-schema FK joins, null-column coercion), health (incl. `pg_stat_statements` fallback),
maintenance (all types, identifier quoting, kill validation), overview/uptime formatting,
performance (incl. checkpoint fallback), slow queries (extension + fallback), active sessions,
table/index/storage stats, pool stats, capabilities, and `pg_stat_activity` passthrough.

### 12.3 Run it

```bash
bun test tests/integration/db/postgres-provider.test.ts   # just this file
bun run test                                               # full isolated suite (CI-equivalent)
```

### 12.4 Optional: verifying against a live PostgreSQL

The committed tests are mock-based by design. To smoke-test against a real server:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine
# then point a connection at localhost:5432 (db=postgres, user=postgres) in the Studio UI
```

The E2E suite (`e2e/`) has been verified against PostgreSQL 18.x.

---

## 13. Usage examples

### 13.1 Programmatic (via the factory)

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

### 13.2 Over the API

- `POST /api/db/query` — run SQL (see [`API_DOCS.md`](../API_DOCS.md#post-apidbquery)).
- `POST /api/db/schema/list` and `POST /api/db/schema/relations` — two-phase schema.
- `POST /api/db/transaction` — begin/commit/rollback/query-in-tx.
- `POST /api/db/cancel` — cancel a running query by id.
- `POST /api/db/maintenance` — vacuum/analyze/reindex/kill (admin only).

---

## 14. Known limitations & future work

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
  explicit `connection.ssl` with mode `verify-ca`/`verify-full` and a `caCert`. *Future:* prefer
  verifying modes by default and treat the heuristic as encryption-only opportunistic TLS.

---

## 15. References

- Driver: [`pg` (node-postgres)](https://github.com/brianc/node-postgres)
- Source: [`src/lib/db/providers/sql/postgres.ts`](../../src/lib/db/providers/sql/postgres.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Pool manager: [`src/lib/db/utils/pool-manager.ts`](../../src/lib/db/utils/pool-manager.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/postgres-provider.test.ts`](../../tests/integration/db/postgres-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [Redis](./redis.md)
