# Redis Provider

> Key-value store support for LibreDB Studio, built on [`ioredis`](https://github.com/redis/ioredis).
> This document is the single reference point for the Redis provider: design, architecture,
> usage, and tests. If you are reading the code, extending Redis support, or authoring a new
> provider, start here.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `redis` |
| **Family** | Key-Value |
| **Driver** | `ioredis` (`^5.9.2`) |
| **Query language** | `json` (plain command **or** JSON command object) |
| **Default port** | `6379` |
| **Connection pooling** | None — single lazy connection |
| **Source** | [`src/lib/db/providers/keyvalue/redis.ts`](../../src/lib/db/providers/keyvalue/redis.ts) |
| **Tests** | [`tests/integration/db/redis-provider.test.ts`](../../tests/integration/db/redis-provider.test.ts) |
| **Tracking issue** | [#7 — Implement Redis Provider](https://github.com/libredb/libredb-studio/issues/7) |

---

## 1. Overview

Redis is an in-memory key-value store. It has no tables, no rows, no SQL, and no relational
schema. LibreDB Studio is a SQL-oriented IDE, so the central design problem is:

> **How do you present a key-value store through the same `DatabaseProvider` interface that
> PostgreSQL, MySQL, and the rest implement — without emulating SQL and without leaking
> Redis-specific concepts into the shared UI?**

The answer is **mapping by convention, not emulation**. The provider does not pretend Redis is
relational. Instead it maps Redis concepts onto the slots the interface already exposes, and
relabels the UI through the provider-metadata hooks (`getCapabilities()` / `getLabels()`) so the
generic components render Redis-appropriate wording.

### Concept mapping

| `DatabaseProvider` slot | Redis realisation | Redis primitive used |
|-------------------------|-------------------|----------------------|
| "Table" (`TableSchema`) | A **key prefix** (e.g. `user:*`) | `SCAN` + prefix grouping |
| "Row" | A **key** | — |
| `query(sql)` | A Redis command (plain text or JSON) | generic `client.call()` |
| `getHealth()` / `getOverview()` | Server stats | `INFO` |
| `getSlowQueries()` | Slow command log | `SLOWLOG GET` |
| `getActiveSessions()` | Connected clients | `CLIENT LIST` |
| `getStorageStats()` | Memory usage | `INFO memory` |
| `runMaintenance('analyze')` | Server info snapshot | `INFO` |
| Indexes / table stats | Not applicable | returns `[]` |

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. Every provider implements the
[`DatabaseProvider`](../../src/lib/db/types.ts) interface, and most of the shared mechanics live
in the abstract [`BaseDatabaseProvider`](../../src/lib/db/base-provider.ts). Providers are grouped
by family on disk:

```
src/lib/db/
├── base-provider.ts          # abstract base: state, helpers, default metadata, getMonitoringData()
├── types.ts                  # DatabaseProvider interface + all DTOs
├── errors.ts                 # DatabaseError hierarchy + mapDatabaseError()
├── factory.ts                # createDatabaseProvider() — dynamic import per type + provider cache
└── providers/
    ├── sql/                  # postgres, mysql, sqlite, oracle, mssql (extend SQLBaseProvider)
    ├── document/             # mongodb
    └── keyvalue/
        └── redis.ts          # ← RedisProvider (this document)
```

### 2.2 Class hierarchy

```
DatabaseProvider (interface, types.ts)
        ▲
        │ implements
BaseDatabaseProvider (abstract, base-provider.ts)
        ▲
        │ extends
RedisProvider (redis.ts)
```

`RedisProvider` extends `BaseDatabaseProvider` directly (unlike the SQL providers, which extend an
intermediate `SQLBaseProvider`). It overrides every abstract method plus the three metadata hooks
(`getCapabilities`, `getLabels`, `prepareQuery`). It inherits `getMonitoringData()`, which fans the
individual monitoring methods out in parallel — see [`base-provider.ts:102`](../../src/lib/db/base-provider.ts).

### 2.3 What the base class gives you for free

`RedisProvider` reuses these inherited members rather than reimplementing them:

- **State machine** — `setConnected()`, `setError()`, `isConnected()`, `ensureConnected()`.
- **Instrumentation** — `trackQuery()` (active-query counter) and `measureExecution()` (wall-clock timing).
- **Helpers** — `formatDuration()`, `getSafeConfig()` (password-stripped logging), `logError()`.
- **Default `getMonitoringData()`** — orchestrates `getOverview` + `getPerformanceMetrics` +
  `getSlowQueries` + `getActiveSessions` (+ optional tables/indexes/storage) concurrently.

### 2.4 Registration & lifecycle

The factory wires Redis in via a dynamic import so the `ioredis` driver is only loaded when a Redis
connection is actually opened ([`factory.ts:98`](../../src/lib/db/factory.ts)):

```ts
case 'redis': {
  const { RedisProvider } = await import('./providers/keyvalue/redis');
  return new RedisProvider(connection, options);
}
```

API routes use `getOrCreateProvider()`, which caches the connected provider per `connection.id` and
evicts it after 30 minutes idle. `disconnect()` is called on eviction and on graceful shutdown
(`SIGTERM`/`SIGINT`).

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 `SCAN`, never `KEYS *`

Schema discovery uses cursor-based `SCAN` with `COUNT 100`, **not** `KEYS *`
([`redis.ts:322`](../../src/lib/db/providers/keyvalue/redis.ts)). `KEYS *` is O(N) and blocks the
entire Redis server until it completes — catastrophic on a production instance with millions of
keys. `SCAN` is incremental and non-blocking. The scan is also capped at `maxScan = 1000` keys so
schema introspection stays bounded regardless of keyspace size.

### 3.2 Key-prefix grouping as "tables"

`getKeyPrefix()` ([`redis.ts:371`](../../src/lib/db/providers/keyvalue/redis.ts)) takes everything
before the first `:` and appends `:*` — so `user:123` and `user:456` both collapse into the
`user:*` "table". Keys without a colon are their own group. For each prefix the provider probes
keys with `TYPE` until it has observed up to **3 distinct** value-types — it may inspect more than
3 keys when they share a type — to populate the synthetic column metadata. The resulting
`TableSchema` list is sorted by descending key count so the busiest prefixes surface first.

### 3.3 Generic command dispatch via `call()`

Rather than hand-coding a method per Redis command, the provider funnels everything through
`ioredis`'s low-level `client.call(command, ...args)` ([`redis.ts:220`](../../src/lib/db/providers/keyvalue/redis.ts)).
This means **any** Redis command works without code changes — `GET`, `LPUSH`, `XADD`, `JSON.GET`,
module commands, etc. The trade-off is that there is no per-command validation; an unknown or
mis-arity command surfaces as a Redis-side error wrapped in `QueryError`.

### 3.4 Two query formats, one parser

The query string is dispatched by its first character ([`redis.ts:157`](../../src/lib/db/providers/keyvalue/redis.ts)):

- Starts with `{` → parsed as a **JSON command object** `{ "command": "GET", "args": ["k"] }`.
- Anything else → parsed as a **plain command** with a small quote-aware tokenizer that preserves
  single/double-quoted arguments (so `SET k "hello world"` is two args, not three).

### 3.5 Reply normalisation into the shared grid

Redis replies are heterogeneous (status strings, integers, nil, flat arrays, hash arrays, bulk
`INFO` text). `formatResult()` ([`redis.ts:233`](../../src/lib/db/providers/keyvalue/redis.ts))
normalises each into the standard `{ rows, fields, rowCount }` envelope so the existing
`ResultsGrid` renders them unchanged. See the [reply table](#52-result-shaping) below.

### 3.6 No connection pool

Redis is single-threaded and a single multiplexed connection is the idiomatic client model, so the
provider holds **one** `ioredis` client and ignores the `PoolConfig`. `connect()` uses
`lazyConnect: true` and then calls `connect()` explicitly so connection failures surface
deterministically at `connect()` time rather than on first command.

---

## 4. Connection

### 4.1 Configuration fields

Redis uses the discrete-field form of `DatabaseConnection` (not `connectionString`):

| Field | Required | Notes |
|-------|----------|-------|
| `host` | ✅ | Validated in `validate()` — throws `DatabaseConfigError` if missing |
| `port` | — | Defaults to `6379` |
| `password` | — | Sent as `password`; omit for unauthenticated instances |
| `database` | — | Logical DB index, parsed as int; defaults to `0` |

```ts
const connection = {
  id: 'redis-1',
  name: 'Cache',
  type: 'redis',
  host: 'localhost',
  port: 6379,
  password: 'secret',   // optional
  database: '0',         // logical DB index
  createdAt: new Date(),
};
```

### 4.2 Connection-string nuance ⚠️

`getCapabilities().supportsConnectionString` is **`false`** — the provider itself only consumes
discrete fields. However, the UI connection-string parser
([`src/lib/connection-string-parser.ts`](../../src/lib/connection-string-parser.ts)) *does*
recognise `redis://` and `rediss://` URLs and **decomposes** them into `host` / `port` (default
`6379`) / `password` / `database` before they reach the provider. So a user can paste a
`redis://:pw@host:6379/0` URL into the modal, but the provider never sees the raw string.

---

## 5. Query interface

### 5.1 Accepted formats

```text
# Plain command (quote-aware)
HGETALL user:1
SET greeting "hello world"
KEYS user:*

# JSON command object
{ "command": "HGETALL", "args": ["user:1"] }
{ "command": "SET", "args": ["greeting", "hello world"] }
```

### 5.2 Result shaping

`formatResult()` maps each Redis reply type onto grid columns:

| Redis reply | `fields` | Example cell |
|-------------|----------|--------------|
| Simple string / status (`GET`, `PING`, `SET`) | `result` | `OK`, `PONG`, `hello-world` |
| Integer (`DEL`, `DBSIZE`, `INCR`) | `result` | `(integer) 42` |
| `nil` | `result` | `(nil)` (rowCount `0`) |
| Empty array | `result` | `(empty list)` (rowCount `0`) |
| Array (`KEYS`, `SMEMBERS`, `LRANGE`) | `index`, `value` | `1 \| user:1` |
| Hash (`HGETALL`) | `field`, `value` | `email \| a@b.com` |
| `INFO` | `section`, `key`, `value` | `Server \| redis_version \| 7.2.4` |

`INFO` is special-cased: `parseInfoResult()` splits the bulk reply into one row per metric, tagging
each with its `# Section` header ([`redis.ts:284`](../../src/lib/db/providers/keyvalue/redis.ts)).

---

## 6. Schema introspection

`getSchema()` ([`redis.ts:312`](../../src/lib/db/providers/keyvalue/redis.ts)) returns one
`TableSchema` per key prefix:

```
1. cursor = "0"
2. loop:
     [cursor, keys] = SCAN cursor COUNT 100
     for each key:
        prefix = substring before first ':' + ':*'   (or the whole key)
        increment prefix.count
        if prefix has < 3 sampled types: TYPE key → add to prefix.types
   until cursor == "0"  OR  totalScanned >= 1000
3. emit TableSchema per prefix, sorted by rowCount desc
```

Each synthetic `TableSchema` has three columns: `key` (string, primary), `value` (typed by the
sampled Redis types, e.g. `string/hash`), and `type`. `indexes` is always empty (`getIndexStats()`
and `getTableStats()` return `[]` — Redis has no indexes or table statistics).

---

## 7. Monitoring & health

All monitoring derives from Redis introspection commands. `parseRedisInfo()` turns the `INFO` bulk
string into a flat `key → value` map that the methods below read from.

| Method | Source command | Returns |
|--------|----------------|---------|
| `getHealth()` | `INFO` | `connected_clients`, `used_memory_human`, hit ratio |
| `getOverview()` | `INFO` + `DBSIZE` | version, uptime, clients, maxclients, memory, key count (`tableCount`) |
| `getPerformanceMetrics()` | `INFO` | cache hit ratio, `instantaneous_ops_per_sec` → `queriesPerSecond` |
| `getSlowQueries()` | `SLOWLOG GET 10` | per-entry id, command text, duration (µs → ms) |
| `getActiveSessions()` | `CLIENT LIST` | one session per client (id, addr, db, flags, cmd, idle) |
| `getStorageStats()` | `INFO memory` | `used_memory_human`, optional `usagePercent` vs `maxmemory` |
| `getTableStats()` | — | `[]` (N/A) |
| `getIndexStats()` | — | `[]` (N/A) |

**Cache hit ratio** is computed as `keyspace_hits / (keyspace_hits + keyspace_misses) * 100`,
defaulting to `100.0` when there has been no traffic ([`redis.ts:547`](../../src/lib/db/providers/keyvalue/redis.ts)).

The monitoring methods that depend on optional Redis features (`SLOWLOG`, `CLIENT LIST`) are wrapped
in try/catch and degrade to `[]` rather than throwing — a restricted ACL that forbids those commands
won't break the monitoring dashboard.

---

## 8. Maintenance

Redis exposes a single maintenance operation:

| Type | Behaviour |
|------|-----------|
| `analyze` | Runs `INFO` and reports the number of lines in the output as a snapshot. Non-destructive. |
| anything else | Throws `QueryError` (`Unsupported maintenance type for Redis`) |

This is reflected in `getCapabilities().maintenanceOperations = ['analyze']`. The UI relabels these
actions for Redis via `getLabels()` (e.g. *"Memory Doctor"*, *"Run Info"*).

---

## 9. Capabilities & labels

### `getCapabilities()` ([`redis.ts:56`](../../src/lib/db/providers/keyvalue/redis.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `json` |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze']` |
| `supportsConnectionString` | `false` |
| `defaultPort` | `6379` |
| `schemaRefreshPattern` | `(DEL\|FLUSHDB\|FLUSHALL\|RENAME)\b` |

`schemaRefreshPattern` tells the UI which executed commands should trigger a schema (key-pattern)
refresh — i.e. commands that add or remove keys.

### `getLabels()` ([`redis.ts:70`](../../src/lib/db/providers/keyvalue/redis.ts))

The label map relabels the generic schema-explorer UI for key-value semantics: entity → *"Key
Pattern"*, row → *"key"*, select → *"Scan Keys"*, analyze → *"Key Info"*, vacuum → *"Memory
Doctor"*, search placeholder → *"Search keys…"*, etc.

---

## 10. Error handling

The provider raises the shared error classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts):

| Situation | Error |
|-----------|-------|
| Missing `host` at construction | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` |
| Malformed JSON command | `QueryError` — *"Invalid JSON command format"* |
| JSON without `command` | `QueryError` — *"Command is required…"* |
| Empty command | `QueryError` — *"Empty command"* |
| Redis-side command failure | `QueryError` — *"Redis error: …"* |

All `QueryError`s carry the `QUERY_ERROR` API code and surface to the client as `400 Bad Request`.

---

## 11. Testing

### 11.1 How the tests work

Integration tests live in
[`tests/integration/db/redis-provider.test.ts`](../../tests/integration/db/redis-provider.test.ts).
In keeping with the project's test architecture, the `ioredis` driver is replaced with an in-process
mock via `mock.module('ioredis', …)` **before** the provider is imported — there is no live Redis
container in the suite. The mock simulates a Redis 7.2.x server (`redis_version:7.2.4`,
`INFO`/`SCAN`/`CLIENT LIST`/`call()` responses), which exercises the same code paths as a real
Redis 6.0+ instance.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide. Run the suite with
> `bun run test` (which isolates execution groups), **never** bare `bun test` across multiple
> files — see the note in [`CLAUDE.md`](../../CLAUDE.md). The Redis file mocks `ioredis`, which
> would otherwise leak into any other test sharing the process.

### 11.2 Coverage

The suite covers: validation, connect/disconnect, capabilities, labels, `prepareQuery`, all query
formats (JSON, plain, empty, `HGETALL`, `INFO`, nil), error handling (malformed JSON, missing
`command`, Redis-side error, disconnected provider), schema scanning, health, overview, performance,
slow queries, active sessions, table/index/storage stats, `getMonitoringData`, maintenance, and a
battery of common commands (`KEYS`, `SET`, `DEL`, `PING`, `DBSIZE`).

### 11.3 Run it

```bash
# Just this file
bun test tests/integration/db/redis-provider.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

### 11.4 Optional: verifying against a live Redis

The committed tests are mock-based by design. To smoke-test against a real server during
development:

```bash
docker run --rm -p 6379:6379 redis:7-alpine
# then point a connection at localhost:6379 in the Studio UI and run e.g. `INFO`, `SCAN 0`
```

---

## 12. Usage examples

### 12.1 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'r1', name: 'Cache', type: 'redis',
  host: 'localhost', port: 6379, createdAt: new Date(),
});

await provider.connect();
await provider.query('SET greeting "hello"');     // → OK
await provider.query('GET greeting');             // → hello
await provider.query('{ "command": "HGETALL", "args": ["user:1"] }');
const schema = await provider.getSchema();        // → key prefixes as "tables"
await provider.disconnect();
```

### 12.2 Over the API

`POST /api/db/query` with the Redis command in the `sql` field — see the
[Redis Query Format](../API_DOCS.md#redis-query-format) section of `API_DOCS.md` for the full
request/response contract.

---

## 13. Known limitations & future work

- **TLS (`rediss://`) is parsed but not connected.** The connection-string parser recognises
  `rediss://`, but it does not preserve the secure scheme, and `connect()` neither passes a `tls`
  option to `ioredis` nor reads `config.ssl`. The provider always attempts a **plaintext**
  connection, so a TLS-only endpoint will fail to connect rather than negotiate TLS. *Future:*
  thread `config.ssl` into the `ioredis` constructor.
- **No Cluster / Sentinel support.** Only a single standalone node is supported.
- **`SCAN` is capped at 1000 keys** for schema discovery — prefixes that only appear beyond the cap
  won't show as "tables". This is a deliberate bound, not a bug.
- **No read-only guard.** The generic `call()` dispatch executes write/destructive commands
  (`SET`, `DEL`, `FLUSHALL`, …) the same as reads. Access control is expected to be enforced by the
  Redis ACL / user role, not the provider.
- **Binary values** are stringified via `String(...)`; non-UTF8 binary payloads may not render
  faithfully in the grid.

---

## 14. References

- Tracking issue: [#7 — Implement Redis Provider](https://github.com/libredb/libredb-studio/issues/7)
- Driver: [`ioredis`](https://github.com/redis/ioredis)
- Source: [`src/lib/db/providers/keyvalue/redis.ts`](../../src/lib/db/providers/keyvalue/redis.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/redis-provider.test.ts`](../../tests/integration/db/redis-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md#redis-query-format)

---

## 15. Appendix — checklist for authoring a new provider

This Redis provider is a good template for a non-relational backend. To add another provider:

1. **Create** `src/lib/db/providers/<family>/<name>.ts` extending `BaseDatabaseProvider`.
2. **Implement** the abstract methods (`connect`, `disconnect`, `query`, `getSchema`, `getHealth`,
   `runMaintenance`, and the seven monitoring methods). Return `[]` from the ones that don't apply.
3. **Override** `getCapabilities()`, `getLabels()`, and `prepareQuery()` so the shared UI renders
   the right wording and feature flags.
4. **Register** the type in the `factory.ts` switch (dynamic import) and add it to the
   `DatabaseType` union in `src/lib/types.ts`.
5. **Add** the driver dependency to `package.json`.
6. **Map** native driver errors onto the `errors.ts` classes (`ConnectionError`, `QueryError`, …).
7. **Test** with a `mock.module()`-based integration test mirroring the structure above.
8. **Document** the provider in `docs/providers/<name>.md` using this file as the template, and add
   the query format to `docs/API_DOCS.md`.
