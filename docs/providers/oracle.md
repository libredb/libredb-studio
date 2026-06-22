# Oracle Provider

> Oracle Database support for LibreDB Studio, built on the [`oracledb`](https://github.com/oracle/node-oracledb)
> driver in **Thin mode** (pure JavaScript — no Oracle Instant Client required).
> This document is the single reference point for the Oracle provider: design, architecture, usage,
> and tests. Oracle is a SQL-family provider sharing `SQLBaseProvider`; read the
> [PostgreSQL doc](./postgres.md) first for the canonical SQL walkthrough, then this doc for the
> Oracle-specific deltas.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `oracle` |
| **Family** | SQL (relational) |
| **Driver** | `oracledb` — **Thin mode** (no Instant Client) |
| **Query language** | `sql` |
| **Default port** | `1521` |
| **Connection pooling** | Yes — `oracledb` pool (`poolMin`/`poolMax`/`poolTimeout`) |
| **Connection string** | Supported (EZConnect `host:port/service` or `oracle://`) |
| **Transactions** | Yes — explicit begin/commit/rollback (**no** auto-rollback timeout) |
| **Query cancellation** | Yes — tracked connection + `connection.break()` |
| **SSL** | Not configured by the provider (TLS via connect string / Oracle wallet) |
| **Source** | [`src/lib/db/providers/sql/oracle.ts`](../../src/lib/db/providers/sql/oracle.ts) |
| **Base** | [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) |
| **Tests** | [`tests/integration/db/oracle-provider.test.ts`](../../tests/integration/db/oracle-provider.test.ts) |

---

## 1. Overview

Oracle is a relational database that maps onto the `DatabaseProvider` interface like the other SQL
providers, with several Oracle-isms that are worth knowing before reading the code. Read this as a
**diff against the [PostgreSQL provider](./postgres.md)** (the SQL reference implementation):

| Aspect | PostgreSQL | Oracle |
|--------|------------|--------|
| Driver mode | `pg` | `oracledb` **Thin** (no Instant Client) |
| Pagination | `LIMIT … OFFSET` | `FETCH FIRST n ROWS ONLY` / `OFFSET m ROWS FETCH NEXT n` |
| Schema scope | all non-system schemas | the connecting **user's** schema (`OWNER = USER`) |
| Schema queries | 1 `MATERIALIZED`-CTE round-trip | **5 bulk** `ALL_*` queries grouped in memory |
| Maintenance | vacuum / analyze / reindex / kill | `analyze` (DBMS_STATS) / `optimize` (index rebuild) / `kill` |
| Transaction timeout | 5-minute auto-rollback | **none** |
| Cancellation | `pg_cancel_backend(pid)` | `connection.break()` (tracked connection) |
| SSL | `buildSSLConfig()` + cloud auto-detect | **not handled** — TLS via connect string / wallet |
| Monitoring source | `pg_stat_*` | `V$` views (privilege-gated, each guarded) |
| UI labels | default SQL | **overridden** (Gather Statistics / Rebuild Indexes) |

### Thin mode

The constructor ([oracle.ts:57](../../src/lib/db/providers/sql/oracle.ts)) forces pure-JS Thin mode
(`initOracleClient = undefined`), sets `outFormat = OUT_FORMAT_OBJECT` (rows as objects), and
`autoCommit = true` globally. Thin mode means **no native Oracle client** has to be installed in the
container — a real deployment win.

---

## 2. Architecture

Same Strategy-Pattern hierarchy as the other SQL providers:

```
DatabaseProvider (interface) → BaseDatabaseProvider → SQLBaseProvider → OracleProvider
```

`OracleProvider` inherits the shared SQL helpers from
[`sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) — see the
[PostgreSQL doc §2.2](./postgres.md#22-what-sqlbaseprovider-provides). It **overrides** three of
them: `getCapabilities()`, `getLabels()`, and `prepareQuery()` (Oracle pagination). Note
`escapeIdentifier()` from the base produces `"ident"` quoting, but Oracle maintenance largely uses
**inline-escaped** literals instead (see [§9](#9-maintenance)).

### Registration

Loaded on demand by the factory ([`factory.ts:81`](../../src/lib/db/factory.ts)):

```ts
case 'oracle': {
  const { OracleProvider } = await import('./providers/sql/oracle');
  return new OracleProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 EZConnect connect string (service name, not database)

Oracle connects to a **service**, not a database name. `getConnectString()`
([oracle.ts:112](../../src/lib/db/providers/sql/oracle.ts)) returns the raw `connectionString` if
given, otherwise builds `host:port/serviceName` where `serviceName = config.serviceName ??
config.database ?? 'ORCL'`. Accordingly, `validate()` requires only `host` (not `database`) when no
connection string is present.

### 3.2 `FETCH FIRST` instead of `LIMIT`

Oracle has no `LIMIT`, so `prepareQuery()` ([oracle.ts:230](../../src/lib/db/providers/sql/oracle.ts))
overrides the base and appends `FETCH FIRST n ROWS ONLY` (or `OFFSET m ROWS FETCH NEXT n ROWS ONLY`
when an offset is set) to bare `SELECT`s that don't already have a limit. Default page size
`DEFAULT_QUERY_LIMIT = 500`; unlimited caps at `MAX_UNLIMITED_ROWS = 100000`.

### 3.3 Owner-scoped, five-query schema introspection

`getSchema()` ([oracle.ts:328](../../src/lib/db/providers/sql/oracle.ts)) runs **five bulk queries**
over the `ALL_*` data-dictionary views — tables, columns, primary keys, foreign keys, indexes —
all filtered by `OWNER = :1` (the connecting user, upper-cased) and then **grouped in memory** by
table. This is neither the Postgres single-CTE approach nor MySQL's per-table N+1: it is a fixed
5 round-trips regardless of table count. There is no `getSchemaList()`/`getSchemaRelations()`
(no two-phase split), and the returned `TableSchema` has **no `size` field** (only `rowCount` from
`NUM_ROWS`, an optimizer estimate that can be stale/`NULL`).

### 3.4 No transaction auto-rollback timeout

Unlike the Postgres and MySQL providers (which arm a 5-minute auto-rollback timer),
`beginTransaction()` ([oracle.ts:263](../../src/lib/db/providers/sql/oracle.ts)) simply checks out a
connection and marks the transaction active — **there is no timeout**. An abandoned transaction
holds its connection (and locks) until explicitly committed/rolled back or the connection is
reclaimed by the pool.

### 3.5 No SSL config path

The Oracle provider **does not read `connection.ssl`** and has no `buildSSLConfig()` /
cloud-auto-detect. Transport security is expected to be configured outside the provider — via a TLS
(`tcps`) connect string or an Oracle wallet. (So, unlike Postgres/MySQL, there is no
`rejectUnauthorized: false` auto-detect caveat here.)

### 3.6 Privilege-resilient monitoring

Oracle monitoring reads `V$` dynamic-performance views, which require privileges a typical app user
may lack. Every monitoring sub-query is wrapped in its own try/catch and degrades to a default
(`N/A`, `0`, or `[]`) rather than failing the whole call — so the dashboard still renders for a
low-privilege user, just with gaps.

---

## 4. Connection

### 4.1 Configuration

```ts
// Discrete fields — host required; service comes from serviceName ?? database ?? 'ORCL'
const a = { id: 'or-1', name: 'XE', type: 'oracle',
  host: 'localhost', port: 1521, serviceName: 'XEPDB1',
  user: 'app', password: 'secret', createdAt: new Date() };

// Connection string (EZConnect or oracle://)
const b = { id: 'or-1', name: 'XE', type: 'oracle',
  connectionString: 'localhost:1521/XEPDB1',
  user: 'app', password: 'secret', createdAt: new Date() };
```

`validate()` ([oracle.ts:98](../../src/lib/db/providers/sql/oracle.ts)) requires `host` only when no
`connectionString` is given; `database` is **not** required (Oracle uses the service name).

### 4.2 Connection pooling

`connect()` builds an `oracledb` pool ([oracle.ts:124](../../src/lib/db/providers/sql/oracle.ts)):

| `oracledb` pool option | Value | Source |
|------------------------|-------|--------|
| `poolMin` | 2 | `ProviderOptions.pool.min` |
| `poolMax` | 10 | `ProviderOptions.pool.max` |
| `poolTimeout` | 30 (s) | `ProviderOptions.pool.idleTimeout` ÷ 1000 |

> ⚠️ `acquireTimeout` (from `DEFAULT_POOL_CONFIG`) and `queryTimeout` (a **separate**
> `ProviderOptions` option, defaulting to `DEFAULT_QUERY_TIMEOUT`) are **not** mapped — there is no
> provider-driven server-side query timeout (cancellation is explicit, [§5.2](#52-query-cancellation)).

`connect()` is idempotent; `getPoolStats()` ([oracle.ts:642](../../src/lib/db/providers/sql/oracle.ts))
exposes `{ total: connectionsOpen, idle, active: connectionsInUse, waiting: 0 }`.

### 4.3 SSL / TLS

Not handled by the provider — see [§3.5](#35-no-ssl-config-path). Use a `tcps://` connect string or
an Oracle wallet for encrypted transport.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([oracle.ts:171](../../src/lib/db/providers/sql/oracle.ts)) checks
out a pooled connection, optionally stores the **connection object** under `queryId` for
cancellation, runs `conn.execute(sql, binds, { outFormat: OUT_FORMAT_OBJECT, autoCommit: true })`,
and returns:

```ts
{ rows, fields: metaData.map(m => m.name), rowCount: rows.length, executionTime }
```

`rowCount` is `rows.length`. Non-`SELECT` statements (INSERT/UPDATE/DELETE/DDL) return no `rows`
array, so `rows` defaults to `[]` and **`rowCount` is `0`** — Oracle's `rowsAffected` is not
surfaced. Bind parameters use Oracle's `:1`-style placeholders (`getPlaceholder()` from the base).
Native errors are normalised through `mapDatabaseError()` (see [§11](#11-error-handling)).

### 5.2 Query cancellation

A query issued with a `queryId` stores its connection in a `Map`. `cancelQuery(queryId)`
([oracle.ts:213](../../src/lib/db/providers/sql/oracle.ts)) calls `connection.break()` on it —
interrupting the in-flight OCI call — and returns `true` on success (it does not verify a query was
actually running). Exposed via `POST /api/db/cancel`.

### 5.3 Data-type handling (LOBs & NUMBER) ⚠️

node-oracledb returns several Oracle types as non-primitive values, and the provider does **not**
currently configure `fetchAsString`/`fetchAsBuffer`/`fetchInfo`:

- **`CLOB`/`NCLOB`/`BLOB`** are returned as `Lob` **stream objects**, not strings/buffers — so a
  result row containing a LOB column does not serialize cleanly into the JSON grid. (Contrast the
  MySQL provider's `sanitizeRow` Buffer→hex conversion.) Oracle schemas commonly use LOBs, so this
  is a real gap — see [Known limitations](#14-known-limitations--future-work).
- **`NUMBER`** is returned as a JavaScript `number`; values beyond 2^53 (e.g. `NUMBER(38)` ids or
  high-precision decimals) **lose precision**. Fetching such columns as strings would preserve them.

---

## 6. Transactions

Explicit lifecycle on a dedicated connection checked out from the pool ([oracle.ts:263](../../src/lib/db/providers/sql/oracle.ts)).
Oracle starts a transaction implicitly on the first DML, so `beginTransaction()` just holds the
connection. **No auto-rollback timeout** (see [§3.4](#34-no-transaction-auto-rollback-timeout)).
Surfaced via `POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction()` | Checks out a connection, marks active. Throws if one is active. |
| `queryInTransaction(sql, params?)` | Runs on that connection with `autoCommit: false`. Throws if none active. |
| `commitTransaction()` / `rollbackTransaction()` | `commit()`/`rollback()`, then closes the connection. Throws if none active. |
| `isInTransaction()` | Current state. |

---

## 7. Schema introspection

`getSchema()` returns one `TableSchema` per table owned by the connecting user. Five `ALL_*` queries
(`OWNER = :user`), grouped client-side:

| Data | Source view(s) |
|------|----------------|
| Tables + row estimate | `ALL_TABLES` (`NUM_ROWS`) |
| Columns | `ALL_TAB_COLUMNS` (`isPrimary` derived from PK set; `nullable` = `NULLABLE = 'Y'`) |
| Primary keys | `ALL_CONSTRAINTS` + `ALL_CONS_COLUMNS` (`CONSTRAINT_TYPE = 'P'`) |
| Foreign keys | `ALL_CONSTRAINTS` (type `'R'`) joined to the referenced constraint's columns |
| Indexes | `ALL_INDEXES` + `ALL_IND_COLUMNS` (`unique` = `UNIQUENESS = 'UNIQUE'`) |

No `getSchemaList()`/`getSchemaRelations()`; no `size` on the returned tables (see [§3.3](#33-owner-scoped-five-query-schema-introspection)).

---

## 8. Monitoring & health

All from `V$`/`USER_*` views; `getMonitoringData()` (inherited) fans them out in parallel. Each
sub-query is independently privilege-guarded ([§3.6](#36-privilege-resilient-monitoring)).

| Method | Primary source | Notes / degradation |
|--------|----------------|---------------------|
| `getHealth()` | `V$SESSION`, `USER_SEGMENTS`, `V$SYSSTAT`, `V$SQL` | each block guarded → `N/A`/`0`/`[]` if no privilege |
| `getOverview()` | `V$VERSION`, `V$INSTANCE`, `V$SESSION`, `V$PARAMETER`, `USER_SEGMENTS`, `USER_TABLES`/`USER_INDEXES` | each guarded |
| `getPerformanceMetrics()` | `V$SYSSTAT` | **only** `cacheHitRatio` + `bufferPoolUsage` (no QPS/deadlocks); defaults to `100` if denied |
| `getSlowQueries()` | `V$SQL` (top-N by `ELAPSED_TIME`) | `sharedBlksHit`=`BUFFER_GETS`, `sharedBlksRead`=`DISK_READS`; `[]` on failure |
| `getActiveSessions()` | `V$SESSION` ⋈ `V$SQL` | `pid` = `"SID,SERIAL#"`; wait class/event; `[]` on failure |
| `getTableStats()` | `ALL_TABLES` + `USER_SEGMENTS` | sizes + `lastAnalyze`; no live/dead tuples, no bloat; `[]` on failure |
| `getIndexStats()` | `ALL_INDEXES` + `USER_SEGMENTS` + `ALL_IND_COLUMNS` | **`scans` always `0`** (no usage counter exposed); `isPrimary` always `false`; `[]` on failure |
| `getStorageStats()` | `DBA_DATA_FILES` → fallback `USER_SEGMENTS` | per-tablespace size; DBA view falls back to user segments without privilege |

---

## 9. Maintenance

`runMaintenance(type, target?)` ([oracle.ts:578](../../src/lib/db/providers/sql/oracle.ts)):

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `DBMS_STATS.GATHER_TABLE_STATS(USER, '<t>')` | `DBMS_STATS.GATHER_SCHEMA_STATS(USER)` |
| `optimize` | `ALTER INDEX "<t>" REBUILD` | rebuild **every** normal user index (`USER_INDEXES`, each in its own try/catch) |
| `kill` | `ALTER SYSTEM KILL SESSION '<SID,SERIAL#>'` | throws (`SID,SERIAL#` required) |

`getCapabilities().maintenanceOperations = ['analyze', 'optimize', 'kill']`. Targets are
**inline-escaped** (single quotes doubled for the PL/SQL string literal; double quotes doubled for
the quoted index identifier) rather than routed through `escapeIdentifier()`, because they sit
inside `DBMS_STATS` arguments / `ALTER` identifiers that can't take bind parameters.

---

## 10. Capabilities & labels

### `getCapabilities()` ([oracle.ts:70](../../src/lib/db/providers/sql/oracle.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'optimize', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `1521` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

### Labels — overridden ([oracle.ts:80](../../src/lib/db/providers/sql/oracle.ts))

Oracle **overrides** the default SQL labels so the UI uses Oracle vocabulary:
`analyzeAction` → *"Gather Statistics"*, `vacuumAction` → *"Rebuild Indexes"*, and the matching
global labels (*"Gather Stats"*, *"Rebuild All Indexes"*).

---

## 11. Error handling

`mapDatabaseError()` ([errors.ts](../../src/lib/db/errors.ts)) has **Oracle-specific** branches:

| Situation | Error |
|-----------|-------|
| Missing `host` (no connection string) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` (carries host/port) |
| `ORA-01017` / *invalid username/password* | `AuthenticationError` |
| `ORA-12541` / `ORA-12154` / `TNS:` | `ConnectionError` |
| `ORA-00942` (table or view does not exist) | `QueryError` |
| Driver message contains *timeout* / *timed out* | `TimeoutError` |
| `connection.break()`-interrupted query | maps via the generic path (the driver's `ORA-01013` / "user requested cancel"); other `ORA-*` codes fall through to `QueryError`/`DatabaseError` with the original message |

There is **no** provider-driven server-side query timeout (no `queryTimeout` wiring), so a
`TimeoutError` only arises from a driver-level timeout message.

---

## 12. Testing

### 12.1 How the tests work

Integration tests live in
[`tests/integration/db/oracle-provider.test.ts`](../../tests/integration/db/oracle-provider.test.ts).
The `oracledb` module is replaced with an in-process mock via `mock.module('oracledb', …)` **before**
the provider is imported — there is no live Oracle in the suite. The mock pool/connection returns
canned `{ rows, metaData }` results, exercising the same code paths as the real driver.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide; files mocking different drivers
> cross-contaminate in a shared process. A **single file** is safe (one file = one process). The
> full `bun run test` script runs the core group in **one** process and is load-order flaky, so
> **CI does not use it** — the deterministic runner is **`bun run test:ci`** (per-file isolation via
> `tests/run-core.sh`); the coverage workflow uses `bun run test:coverage`. See [`CLAUDE.md`](../../CLAUDE.md).

### 12.2 Coverage

The suite covers: validation, connect/disconnect, query, capabilities, **labels override**,
**`prepareQuery` FETCH FIRST / OFFSET-FETCH**, `getSchema` (columns/PKs/FKs/indexes grouping),
health, maintenance (analyze/optimize/kill), pool stats, the transaction lifecycle, query
cancellation (`break()`), overview, performance metrics, slow queries, active sessions,
table/index/storage stats, and error mapping.

### 12.3 Run it

```bash
bun test tests/integration/db/oracle-provider.test.ts   # just this file (single process — safe)
bun run test:ci                                          # CI publish gate — per-file isolation (tests/run-core.sh)
bun run test:coverage                                    # CI coverage workflow — per-file core + components
```

### 12.4 Optional: verifying against a live Oracle

```bash
docker run --rm -e ORACLE_PASSWORD=secret -p 1521:1521 gvenzl/oracle-free:slim
# then connect to localhost:1521 / FREEPDB1 (user system, password secret) in the Studio UI
```

---

## 13. Usage examples

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'or1', name: 'XE', type: 'oracle',
  host: 'localhost', port: 1521, serviceName: 'XEPDB1',
  user: 'app', password: 'secret', createdAt: new Date(),
});

await provider.connect();
const res = await provider.query('SELECT id, email FROM users WHERE active = :1', [1]);
const schema = await provider.getSchema();   // 5 ALL_* queries, grouped in memory
await provider.disconnect();
```

Over the API: `POST /api/db/query`, `POST /api/db/transaction`, `POST /api/db/cancel`,
`POST /api/db/maintenance` (admin), `POST /api/db/schema/list` (falls back to `getSchema()`).

---

## 14. Known limitations & future work

- **CLOB/BLOB columns don't render.** No `fetchAsString`/`fetchAsBuffer` is configured, so LOB
  columns come back as `Lob` stream objects rather than text/bytes ([§5.3](#53-data-type-handling-lobs--number)).
  *Future:* set `oracledb.fetchAsString = [oracledb.CLOB]` / `fetchAsBuffer = [oracledb.BLOB]` (or
  per-query `fetchInfo`), and stream genuinely large LOBs instead of buffering.
- **Large `NUMBER` precision loss** — returned as a JS `number`; `NUMBER` values beyond 2^53 should
  be fetched as strings to stay exact.
- **`EXPLAIN` is advertised but not implemented for Oracle.** `getCapabilities().supportsExplain` is
  `true`, but the UI's EXPLAIN builder only handles Postgres/MySQL — for Oracle the *Explain* action
  runs the **unmodified** query instead of producing a plan. *Future:* build
  `EXPLAIN PLAN FOR …` followed by `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY())`.
- **No server-side query timeout.** `queryTimeout` is not wired into the pool; runaway queries must
  be cancelled explicitly via `cancelQuery()` (`connection.break()`). *Future:* set
  `connection.callTimeout` (node-oracledb's per-round-trip timeout) from `queryTimeout`.
- **`kill` and full monitoring require elevated privileges.** `ALTER SYSTEM KILL SESSION` needs the
  `ALTER SYSTEM` privilege; the `V$` monitoring views need `SELECT` on the `V_$` views. A
  least-privilege application user can neither kill sessions nor read most monitoring (the queries
  degrade to `N/A`/`0`/`[]`).
- **Module-global driver settings.** The constructor sets `oracledb.outFormat`/`autoCommit` on the
  shared `oracledb` module singleton (not per-pool/connection) — fine for a single embedding, but a
  process-wide side effect to be aware of if Oracle is ever used alongside another `oracledb` consumer.
- **No transaction auto-rollback timeout** (unlike Postgres/MySQL) — an abandoned transaction holds
  its connection/locks until committed, rolled back, or pool-reclaimed.
- **Schema is owner-scoped** to the connecting user (`OWNER = USER`); objects in other schemas the
  user can see are not listed, and tables carry no size field.
- **`getIndexStats().scans` is always `0`** and `isPrimary` always `false` — Oracle index usage
  counters aren't read here.
- **Row counts (`NUM_ROWS`) are optimizer estimates** populated by `DBMS_STATS`; they can be stale
  or `NULL` until stats are gathered.
- **Monitoring depends on `V$` privileges.** A low-privilege app user silently gets `N/A`/`0`/`[]`
  for the views it can't read. `getPerformanceMetrics()` reports only cache-hit ratio (no
  QPS/deadlocks).
- **No two-phase schema loading** — `/api/db/schema/list` falls back to the full `getSchema()`.

---

## 15. References

- Driver: [`node-oracledb`](https://github.com/oracle/node-oracledb) (Thin mode)
- Source: [`src/lib/db/providers/sql/oracle.ts`](../../src/lib/db/providers/sql/oracle.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors (incl. `ORA-*` mapping): [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/oracle-provider.test.ts`](../../tests/integration/db/oracle-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Redis](./redis.md)
