# LibreDB Provider

> Embedded key-value store support for LibreDB Studio, built on the
> [`@libredb/libredb`](https://github.com/libredb/libredb-database) package.
> This document is the single reference point for the LibreDB provider: design, architecture,
> usage, and tests. If you are reading the code, extending LibreDB support, or authoring a new
> provider, start here.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `libredb` |
| **Family** | Embedded / Key-Value (`src/lib/db/providers/embedded/`) |
| **Driver** | `@libredb/libredb` (lazy dynamic import) |
| **Query language** | `json` (small command grammar — NOT SQL) |
| **Default port** | None (embedded in-process, no network) |
| **Connection pooling** | None — single in-process file handle |
| **Source** | [`src/lib/db/providers/embedded/libredb.ts`](../../src/lib/db/providers/embedded/libredb.ts) |
| **Tests** | [`tests/integration/db/libredb-provider.test.ts`](../../tests/integration/db/libredb-provider.test.ts) |
| **Design spec** | [`docs/superpowers/specs/2026-06-24-libredb-embedded-provider-design.md`](../superpowers/specs/2026-06-24-libredb-embedded-provider-design.md) |

---

## 1. Overview

LibreDB is an embedded, ordered key-value store with no server and no wire protocol. A `.libredb`
file is raw ordered key-value bytes on disk; the `@libredb/libredb` package opens and operates on
that file in-process, synchronously. LibreDB Studio is a SQL-oriented IDE, so the central design
problem is the same one the Redis provider faced:

> **How do you present a key-value store through the same `DatabaseProvider` interface that
> PostgreSQL, MySQL, and the rest implement — without emulating SQL and without leaking
> database-specific concepts into the shared UI?**

The answer is **mapping by convention, not emulation**. The provider does not pretend LibreDB is
relational. Instead it maps LibreDB concepts onto the slots the interface already exposes, and
relabels the UI through the provider-metadata hooks (`getCapabilities()` / `getLabels()`) so the
generic components render LibreDB-appropriate wording.

### Concept mapping

| `DatabaseProvider` slot | LibreDB realisation | Mechanism |
|-------------------------|---------------------|-----------|
| "Table" (`TableSchema`) | A **key prefix** (e.g. `user:*`) | `kv.range` scan + prefix grouping |
| "Row" | A **key** | — |
| `query(input)` | A command (`get`/`put`/`delete`/`prefix`/`range`) | `kv` lens methods |
| `getHealth()` / `getOverview()` | File stats | `fs.statSync` + prefix count |
| `getStorageStats()` | File path and size on disk | `fs.statSync` |
| `getSlowQueries()` | Not applicable | returns `[]` |
| `getActiveSessions()` | Not applicable (single embedded process) | returns `[]` |
| `runMaintenance(type)` | Not supported (throws) | — |
| Indexes / table stats | Not applicable | returns `[]` |

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. Every provider implements the
[`DatabaseProvider`](../../src/lib/db/types.ts) interface, and most shared mechanics live in the
abstract [`BaseDatabaseProvider`](../../src/lib/db/base-provider.ts). Providers are grouped by
family on disk:

```
src/lib/db/
├── base-provider.ts          # abstract base: state, helpers, default metadata, getMonitoringData()
├── types.ts                  # DatabaseProvider interface + all DTOs
├── errors.ts                 # DatabaseError hierarchy + mapDatabaseError()
├── factory.ts                # createDatabaseProvider() — dynamic import per type + provider cache
└── providers/
    ├── sql/                  # postgres, mysql, sqlite, oracle, mssql (extend SQLBaseProvider)
    ├── document/             # mongodb
    ├── keyvalue/             # redis
    └── embedded/
        └── libredb.ts        # <- LibreDBProvider (this document)
```

### 2.2 Class hierarchy

```
DatabaseProvider (interface, types.ts)
        ^
        | implements
BaseDatabaseProvider (abstract, base-provider.ts)
        ^
        | extends
LibreDBProvider (libredb.ts)
```

`LibreDBProvider` extends `BaseDatabaseProvider` directly (the same pattern as `RedisProvider`).
It overrides every abstract method plus the three metadata hooks (`getCapabilities`, `getLabels`,
`prepareQuery`). It inherits `getMonitoringData()`, which fans the individual monitoring methods
out in parallel.

### 2.3 What the base class gives you for free

`LibreDBProvider` reuses these inherited members rather than reimplementing them:

- **State machine** — `setConnected()`, `setError()`, `isConnected()`, `ensureConnected()`.
- **Instrumentation** — `trackQuery()` (active-query counter) and `measureExecution()` (wall-clock timing).
- **Helpers** — `formatDuration()`, `getSafeConfig()` (password-stripped logging), `logError()`.
- **Default `getMonitoringData()`** — orchestrates `getOverview` + `getPerformanceMetrics` +
  `getSlowQueries` + `getActiveSessions` (+ optional tables/indexes/storage) concurrently.

### 2.4 Registration & lifecycle

The factory wires LibreDB in via a dynamic import so the `@libredb/libredb` driver is only loaded
when a LibreDB connection is actually opened
([`factory.ts:104`](../../src/lib/db/factory.ts)):

```ts
case 'libredb': {
  const { LibreDBProvider } = await import('./providers/embedded/libredb');
  return new LibreDBProvider(connection, options);
}
```

The package is loaded lazily and the result is cached in a module-level variable — repeated
`connect()` calls do not re-import. API routes use `getOrCreateProvider()`, which caches the
connected provider per `connection.id` and evicts it after 30 minutes idle. `disconnect()` is
called on eviction and on graceful shutdown (`SIGTERM` / `SIGINT`).

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 File path in `config.database`, not a custom field

The `DatabaseConnection` type already has a `database` field. Rather than introduce a custom
`path` field (which would require UI / API / type changes), the provider reuses `database` for the
file path — the same pattern used by the SQLite provider. A missing `database` is a
`DatabaseConfigError` at `validate()` time; there is no in-memory fallback.

### 3.2 No in-memory connections

`open()` without a path creates an ephemeral in-memory store that is discarded when the process
closes. This offers no durable value for a GUI tool, so the provider explicitly requires a file
path and throws rather than silently opening an in-memory database.

### 3.3 Key-prefix grouping as "tables"

`groupName()` ([`libredb.ts:195`](../../src/lib/db/providers/embedded/libredb.ts)) takes
everything before the first `:` and appends `:*` — so `user:1` and `user:2` both collapse into
the `user:*` group. A key with no colon (e.g. `config`) becomes its own single-key group named
`config`. This is the same convention as the Redis provider.

`getSchema()` scans up to `MAX_SCAN = 10000` keys via `kv.range('', '\u{10FFFF}')` — a
half-open interval that covers the entire keyspace. The resulting `TableSchema` list is sorted by
descending row count so the largest groups appear first. Each synthetic table has two columns:
`key` (string, primary) and `value` (string, nullable).

### 3.4 Synchronous package, async provider contract

The `@libredb/libredb` API is synchronous. All calls are wrapped in `async` methods that resolve
immediately, satisfying the `DatabaseProvider` async contract without any overhead. `trackQuery`
and `measureExecution` still record wall-clock time accurately even for synchronous operations.

### 3.5 Command grammar, not SQL

The provider defines a small five-verb command language over the kv lens. Tokenization is
quote-aware: single and double quotes are honored, an unmatched quote is rejected with a
`QueryError`, and consecutive whitespace outside quotes is collapsed to a single token boundary.
The tokenizer is `private tokenize()` in the provider class.

### 3.6 JSON pretty-printing for values

`renderValue()` attempts `JSON.parse` on every value string. If it succeeds, the value is
re-serialized with `JSON.stringify(parsed, null, 2)` for readability in the grid. Non-JSON
strings are returned as-is. This mirrors how the Redis provider handles structured values.

### 3.7 Monitoring is file-stat-based

Unlike Redis (`INFO`) or PostgreSQL (system catalogs), LibreDB has no server introspection API.
Overview and storage stats derive entirely from `fs.statSync` (file size in bytes) and a schema
scan (prefix group count). There are no sessions, slow queries, or index statistics — those
methods return empty arrays.

---

## 4. Connection

### 4.1 Configuration fields

LibreDB uses the `database` field of `DatabaseConnection` for the file path. All other network
fields are ignored.

| Field | Required | Notes |
|-------|----------|-------|
| `database` | Yes | Absolute path to the `.libredb` file on the Studio server's filesystem. Throws `DatabaseConfigError` if absent. |

No `host`, `port`, `user`, `password`, or `connectionString` fields are used. The `supportsConnectionString`
capability is `false`.

```ts
const connection = {
  id: 'libredb-1',
  name: 'App Data',
  type: 'libredb',
  database: '/data/app.libredb',
  createdAt: new Date(),
};
```

### 4.2 File must exist on the Studio server

The `.libredb` file must be accessible on the filesystem of the machine running the Studio server.
Remote LibreDB is not possible — the database has no server or wire protocol by design. If the
file does not exist at `connect()` time, the `@libredb/libredb` package will create it (an empty
ordered-KV store). If the path is missing entirely, `connect()` throws `DatabaseConfigError`
before attempting to open anything.

---

## 5. Query interface

### 5.1 Command grammar

The query input is a plain text command, not SQL. The supported verbs are:

```
get <key>
put <key> <value>
delete <key>
prefix <prefix>
range <start> <end>
```

Rules:

- Verb matching is case-insensitive (`GET`, `get`, and `Get` all work).
- Arguments are split on whitespace. Single and double quotes preserve whitespace within a token
  (`put k "hello  world"` stores the value `hello  world` with two spaces).
- An unmatched quote is rejected immediately with a `QueryError`.
- Consecutive whitespace outside quotes is collapsed — `put key hello  world` stores
  `hello world` (one space), not `hello  world`.
- `range` is half-open: `[start, end)` — the start key is included, the end key is excluded.
- An empty command or an unknown verb raises `QueryError` listing the supported verbs.

### 5.2 Result shaping

| Command | `fields` | Example row |
|---------|----------|-------------|
| `get` (found) | `key`, `value` | `{ key: 'user:1', value: 'Ada' }` |
| `get` (missing) | `key`, `value` | (zero rows) |
| `put` | `changed` | `{ changed: 1 }` |
| `delete` | `changed` | `{ changed: 1 }` (or `0` if the key did not exist) |
| `prefix` | `key`, `value` | one row per matching key |
| `range` | `key`, `value` | one row per key in `[start, end)` |

JSON values in the `value` column are pretty-printed with two-space indentation when they parse
successfully. Non-JSON strings are left as-is.

---

## 6. Schema introspection

`getSchema()` returns one `TableSchema` per key-prefix group:

```
1. Iterate kv.range('', '\u{10FFFF}')     <- covers the entire keyspace
2. For each key:
     prefix = substring before first ':'   -> append ':*'  (or the key itself if no colon)
     increment prefix.count
   Stop after 10 000 keys (MAX_SCAN)
3. Emit TableSchema per prefix, sorted by rowCount desc
```

Each synthetic `TableSchema` has two columns: `key` (string, primary, not null) and `value`
(string, nullable). `indexes` is always `[]`. `rowCount` is the number of keys observed in that
prefix group (up to the scan cap).

A `.libredb` file has no on-disk schema — the lens and any relational table definitions live in
application code. `getSchema()` therefore reflects the honest raw-KV view, not a reconstructed
relational schema. Faithful per-kind catalog views are deferred to a future database-side catalog
(see [Limitations](#9-known-limitations--future-work)).

---

## 7. Monitoring & health

All monitoring derives from `fs.statSync` (file size) and a schema scan (prefix group count).
There is no embedded stats API.

| Method | Source | Returns |
|--------|--------|---------|
| `getHealth()` | `fs.statSync` | `activeConnections: 1`, file size as `databaseSize`, `cacheHitRatio: 100.0` |
| `getOverview()` | `fs.statSync` + schema scan | `version`, file size, prefix-group count as `tableCount`, `indexCount: 0` |
| `getPerformanceMetrics()` | — | `cacheHitRatio: 100` |
| `getSlowQueries()` | — | `[]` (N/A) |
| `getActiveSessions()` | — | `[]` (N/A — single embedded process) |
| `getStorageStats()` | `fs.statSync` | one entry: file path + size |
| `getTableStats()` | — | `[]` (N/A) |
| `getIndexStats()` | — | `[]` (N/A) |

`getOverview().tableCount` calls `getSchema()` internally — it is a full scan, so it honors the
10 000-key cap and may undercount for very large files.

---

## 8. Maintenance

No maintenance operations are supported. `runMaintenance(type)` always throws:

```
QueryError: Maintenance operation "<type>" is not supported for LibreDB
```

This is reflected in `getCapabilities().supportsMaintenance = false` and
`maintenanceOperations = []`. The UI disables the maintenance actions for this provider.

---

## 9. Capabilities & labels

### `getCapabilities()`

| Capability | Value |
|------------|-------|
| `queryLanguage` | `json` |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsMaintenance` | `false` |
| `maintenanceOperations` | `[]` |
| `supportsConnectionString` | `false` |
| `defaultPort` | `null` |
| `schemaRefreshPattern` | `\\b(put\|delete)\\b` |

`schemaRefreshPattern` tells the UI which executed commands should trigger a schema (key-pattern)
refresh — `put` and `delete` both add or remove keys.

### `getLabels()`

The label map relabels the generic schema-explorer UI for key-value semantics: entity ->
"Key Prefix", row -> "key", select -> "Scan Keys", generate -> "Generate Command",
analyze -> "Key Info", search placeholder -> "Search keys...", etc.

---

## 10. Error handling

The provider raises the shared error classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts):

| Situation | Error |
|-----------|-------|
| Missing `database` path at construction | `DatabaseConfigError` |
| `@libredb/libredb` package not installed | `DatabaseConfigError` — install instructions in message |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails to open the file | `ConnectionError` |
| Empty command | `QueryError` — *"Empty command"* |
| Unknown verb | `QueryError` — lists supported verbs |
| Wrong argument count for a verb | `QueryError` — usage hint (e.g. *"Usage: get <key>"*) |
| Unmatched quote | `QueryError` — *"Unmatched quote in command"* |
| `runMaintenance(type)` | `QueryError` — *"Maintenance operation ... is not supported for LibreDB"* |

All `QueryError`s carry the `QUERY_ERROR` API code and surface to the client as `400 Bad Request`.

---

## 11. Testing

### 11.1 How the tests work

Integration tests live in
[`tests/integration/db/libredb-provider.test.ts`](../../tests/integration/db/libredb-provider.test.ts).
Unlike the Redis tests, these use the **real `@libredb/libredb` package** against a temporary
file — there is no `mock.module()`. Each test suite creates a fresh temp file via
`os.tmpdir()`, seeds it with a few keys across three prefix groups (`user:*`, `order:*`,
`config`), and deletes it in `afterEach`.

Because there is no `mock.module()`, this suite is exempt from the mock-isolation hazard
described in `CLAUDE.md`. It can be run alongside other tests in the same process without
cross-contamination.

### 11.2 Coverage

The suite covers: validation (missing path), connect/disconnect (real file + idempotent
disconnect), capabilities, labels, `getSchema` (prefix grouping, column definition, sort order),
all five query commands (`get` found, `get` missing, `prefix`, `range`, `put`, `delete`),
multi-word values, error paths (unknown verb, unmatched quote), and monitoring (`getOverview` file
size + group count, `getStorageStats` path + size, `runMaintenance` unsupported).

### 11.3 Run it

```bash
# Just this file
bun test tests/integration/db/libredb-provider.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

---

## 12. Usage examples

### 12.1 Connection object

```ts
const connection = {
  id: 'libredb-1',
  name: 'App Data',
  type: 'libredb',
  database: '/data/app.libredb',
  createdAt: new Date(),
};
```

### 12.2 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'ldb1', name: 'App Data', type: 'libredb',
  database: '/data/app.libredb', createdAt: new Date(),
});

await provider.connect();

// Read a single key
await provider.query('get user:1');
// -> { rows: [{ key: 'user:1', value: 'Ada' }], rowCount: 1, fields: ['key', 'value'] }

// Read all keys under a prefix
await provider.query('prefix user:');
// -> { rows: [{ key: 'user:1', value: '...' }, { key: 'user:2', value: '...' }], ... }

// Range scan (half-open: [start, end))
await provider.query('range user:1 user:2');
// -> { rows: [{ key: 'user:1', value: 'Ada' }], rowCount: 1, ... }

// Write a key
await provider.query('put session:abc token123');
// -> { rows: [{ changed: 1 }], rowCount: 1, fields: ['changed'] }

// Write a value with spaces (use quotes)
await provider.query('put note "hello world"');
// -> { rows: [{ changed: 1 }], ... }

// Write a JSON value (stored as-is; read back pretty-printed)
await provider.query('put user:3 {"name":"Grace","age":45}');
// get user:3 -> value: '{\n  "name": "Grace",\n  "age": 45\n}'

// Delete a key
await provider.query('delete session:abc');
// -> { rows: [{ changed: 1 }], rowCount: 1, fields: ['changed'] }

// Browse the schema (prefix groups as tables)
const schema = await provider.getSchema();
// -> [{ name: 'user:*', rowCount: 3, columns: [{name:'key',...},{name:'value',...}] }, ...]

await provider.disconnect();
```

### 12.3 Over the API

`POST /api/db/query` with the command in the `sql` field — see
[`docs/API_DOCS.md`](../API_DOCS.md) for the full request/response contract.

---

## 13. Known limitations & future work

- **No multi-key transactions in the query UI.** The `@libredb/libredb` kernel exposes a
  `transact()` method for atomic multi-key writes, but it is not surfaced through the provider's
  command grammar in v1. Deferred to a future release.
- **No in-memory connections.** A missing `database` path throws rather than silently opening an
  ephemeral in-memory store, which would be discarded on disconnect and offer no durable value.
- **Faithful per-kind catalog views are deferred.** A `.libredb` file is raw ordered KV bytes;
  the lens (kv / document / relational) and any relational table schema live in application code,
  not on disk. `getSchema()` therefore shows the honest raw-prefix view. When the database-side
  catalog ships (see design spec §9), this provider can read `catalog(db)` and present real
  document collections and relational tables.
- **Schema scan capped at 10 000 keys.** Prefix groups that only appear beyond the cap won't show
  as "tables". This is a deliberate bound, not a bug.
- **File must be on the Studio server's filesystem.** There is no remote LibreDB connection model.
  The database has no server or wire protocol; embedded-in-process is the only supported mode.

---

## 14. References

- Design spec: [`docs/superpowers/specs/2026-06-24-libredb-embedded-provider-design.md`](../superpowers/specs/2026-06-24-libredb-embedded-provider-design.md)
- Driver: [`@libredb/libredb`](https://github.com/libredb/libredb-database)
- Source: [`src/lib/db/providers/embedded/libredb.ts`](../../src/lib/db/providers/embedded/libredb.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/libredb-provider.test.ts`](../../tests/integration/db/libredb-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
