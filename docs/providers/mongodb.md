# MongoDB Provider

> Document-database support for LibreDB Studio, built on the official
> [`mongodb`](https://github.com/mongodb/node-mongodb-native) Node.js driver.
> This document is the single reference point for the MongoDB provider: design, architecture, usage,
> and tests. MongoDB is a **document** database — not relational — so, like the [Redis provider](./redis.md),
> it extends `BaseDatabaseProvider` directly (not `SQLBaseProvider`) and speaks a **JSON query
> language**, not SQL.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `mongodb` |
| **Family** | Document |
| **Driver** | `mongodb` (official Node.js driver) |
| **Query language** | `json` (MQL — Mongo Query Language as a JSON object) |
| **Default port** | `27017` |
| **Connection pooling** | Yes — the driver's built-in `MongoClient` pool |
| **Connection string** | ✅ Supported and used directly (`mongodb://` / `mongodb+srv://`) |
| **Transactions** | ❌ no explicit begin/commit/rollback API |
| **Query cancellation** | ❌ no `cancelQuery` (operations can be killed via maintenance `killOp`) |
| **Source** | [`src/lib/db/providers/document/mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts) |
| **Tests** | [`tests/integration/db/mongodb-provider.test.ts`](../../tests/integration/db/mongodb-provider.test.ts) |

---

## 1. Overview

MongoDB stores schemaless BSON documents in collections. It maps onto the `DatabaseProvider`
interface by **convention** (like Redis), relabelling the generic UI for document semantics and
accepting queries as JSON rather than SQL.

### Concept mapping

| `DatabaseProvider` slot | MongoDB realisation |
|-------------------------|---------------------|
| "Table" (`TableSchema`) | A **collection** |
| "Row" | A **document** |
| Columns | **Inferred** field types from a 100-document sample |
| `query(sql)` | A JSON **MQL** command (`{collection, operation, …}`) |
| Foreign keys | none (MongoDB has no FKs) |
| Maintenance | `validate` / `compact` / `dbCheck` (mapped to analyze/vacuum/check) |
| Monitoring | `serverStatus`, `dbStats`, `currentOp`, `$indexStats`, the profiler |

Unlike Redis (a key-value store), MongoDB is genuinely query-rich: `find`, `aggregate`, `count`,
`distinct`, and the full set of write operations are supported.

---

## 2. Architecture

```
DatabaseProvider (interface) → BaseDatabaseProvider → MongoDBProvider
```

`MongoDBProvider` extends `BaseDatabaseProvider` directly and overrides `getCapabilities()`,
`getLabels()`, and `prepareQuery()`. It inherits the base's `getMonitoringData()` orchestration and
state/instrumentation helpers (see [Redis doc §2.3](./redis.md) for the shared base behaviour).

### Registration

Loaded on demand by the factory ([`factory.ts:92`](../../src/lib/db/factory.ts)):

```ts
case 'mongodb': {
  const { MongoDBProvider } = await import('./providers/document/mongodb');
  return new MongoDBProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 JSON / MQL query format

`query()` ([mongodb.ts:233](../../src/lib/db/providers/document/mongodb.ts)) accepts a JSON object,
parsed by `parseQuery()` ([mongodb.ts:359](../../src/lib/db/providers/document/mongodb.ts)), which
requires `collection` and `operation`:

```json
{ "collection": "users", "operation": "find", "filter": {"age": {"$gt": 18}}, "options": {"limit": 10} }
{ "collection": "orders", "operation": "aggregate", "pipeline": [{"$group": {"_id": "$status", "count": {"$sum": 1}}}] }
{ "collection": "users", "operation": "insertOne", "documents": [{"name": "John"}] }
```

Supported operations: `find`, `findOne`, `aggregate`, `count`, `distinct`, `insertOne`, `insertMany`,
`updateOne`, `updateMany`, `deleteOne`, `deleteMany`. See the
[`API_DOCS.md` MongoDB Query Format](../API_DOCS.md) section (under `POST /api/db/query`) and
[`CLAUDE.md`](../../CLAUDE.md) for the request shape.

### 3.2 BSON serialization for the grid

`serializeDocument()` ([mongodb.ts:381](../../src/lib/db/providers/document/mongodb.ts)) recursively
normalises BSON types so documents render in the JSON grid: `ObjectId` → string, `Decimal128` →
string, `Date` → ISO-8601, `Binary` → `<Binary: N bytes>` (placeholder, not the raw bytes), and
nested objects/arrays are walked recursively.

### 3.3 Sampling-based, flat schema inference

MongoDB has no fixed schema, so `getSchema()` ([mongodb.ts:418](../../src/lib/db/providers/document/mongodb.ts))
**infers** one: it lists collections (skipping `system.*`, capped at 200), and for each samples the
first **100 documents** to derive field types ([mongodb.ts:469](../../src/lib/db/providers/document/mongodb.ts)).
Caveats baked into this approach:
- Fields absent from the sample (or appearing only in unsampled documents) won't show.
- Inference is **flat** — nested object fields are reported as type `object`, not expanded into
  dotted sub-fields (the recursion is intentionally disabled).
- A field with multiple observed types is reported as `mixed(a|b)`. `_id` is marked primary.

### 3.4 `find` is capped at 100; `aggregate` is not

A `find` with no explicit `options.limit` is capped at **100** documents
([mongodb.ts:251](../../src/lib/db/providers/document/mongodb.ts)). **`aggregate` has no default
limit** — a pipeline without a `$limit` stage can return an unbounded result set. `prepareQuery()`
is a no-op for MongoDB (no automatic limit injection), so the 100-cap applies only to `find`.

---

## 4. Connection

`connectionString` is used **directly** (this is a genuine connection-string provider, unlike
SQL Server). `buildConnectionString()` ([mongodb.ts:183](../../src/lib/db/providers/document/mongodb.ts))
returns `config.connectionString` if present, else assembles
`mongodb://<url-encoded user:pass@>host:port/database`.

```ts
// Connection string (SRV or standard)
const a = { id: 'mg-1', name: 'App', type: 'mongodb',
  connectionString: 'mongodb+srv://user:pass@cluster.example.net/app', createdAt: new Date() };

// Discrete fields
const b = { id: 'mg-1', name: 'App', type: 'mongodb',
  host: 'localhost', port: 27017, database: 'app',
  user: 'admin', password: 'secret', createdAt: new Date() };
```

`validate()` ([mongodb.ts:117](../../src/lib/db/providers/document/mongodb.ts)) requires either a
`connectionString` or both `host` and `database`. `connect()` builds a `MongoClient` whose built-in
pool is configured from `ProviderOptions.pool`:

| `MongoClient` option | Source |
|----------------------|--------|
| `maxPoolSize` | `pool.max` |
| `minPoolSize` | `pool.min` |
| `maxIdleTimeMS` | `pool.idleTimeout` |
| `connectTimeoutMS` | `pool.acquireTimeout` |
| `serverSelectionTimeoutMS` | `pool.acquireTimeout` |

The database name comes from `config.database`, else it is parsed out of the connection string, else
defaults to `test`. After connecting, a `{ ping: 1 }` command validates the connection.

---

## 5. Query interface

`query(jsonString)` parses the MQL object and dispatches on `operation`
([mongodb.ts:233](../../src/lib/db/providers/document/mongodb.ts)). Reads (`find`/`findOne`/
`aggregate`/`count`/`distinct`) return documents; writes return an acknowledgement summary
(`insertedId`/`modifiedCount`/`deletedCount`, …). `rowCount = rows.length || affectedCount`, and
every returned document passes through `serializeDocument()`. There is no `prepareQuery` limit
injection, no transactions, and no `cancelQuery`. `EXPLAIN` is not supported
(`supportsExplain: false`).

---

## 6. Schema introspection

`getSchema()` returns one `TableSchema` per collection:

| Data | Source |
|------|--------|
| Collections | `listCollections()` (skip `system.*`, cap 200) |
| Row count | `estimatedDocumentCount()` |
| Size | `collStats` command (`size`) |
| Columns | inferred from a 100-document sample ([§3.3](#33-sampling-based-flat-schema-inference)) |
| Indexes | `collection.indexes()` (`unique` flag, key fields) |
| Foreign keys | always `[]` (MongoDB has none) |

---

## 7. Monitoring & health

Rich, from `admin().serverStatus()`, `db.stats()`, `currentOp`, `$indexStats`, and the profiler.
Every method is wrapped in try/catch and degrades to a sensible default on permission errors.

| Method | Source | Notes |
|--------|--------|-------|
| `getHealth()` | `serverStatus`, `dbStats`, `currentOp`, `system.profile` | connections, data size, WiredTiger cache-hit %, current ops; slow queries need the profiler (placeholder row if disabled) |
| `getOverview()` | `serverStatus`, `buildInfo`, `dbStats`, `listCollections` | version, uptime, connections, collection/index counts |
| `getPerformanceMetrics()` | `serverStatus` (WiredTiger + opcounters) | cache-hit %, **queries/sec** (opcounters/uptime), buffer-pool % (cache bytes), `deadlocks: 0` |
| `getSlowQueries()` | `system.profile` | per-op time/returned; **`[]` if the profiler isn't enabled** (`db.setProfilingLevel(1)`) |
| `getActiveSessions()` | `currentOp` | opid, client, ns, lock waits, duration |
| `getTableStats()` | `collStats` per collection | row count + data/index/total sizes |
| `getIndexStats()` | `$indexStats` + `indexes()` | **real `scans`** (`accesses.ops`); `indexSize` `N/A` |
| `getStorageStats()` | `dbStats` + WiredTiger | Data / Indexes / Storage / WiredTiger cache (with usage %) |

---

## 8. Maintenance

`runMaintenance(type, target?)` ([mongodb.ts:610](../../src/lib/db/providers/document/mongodb.ts))
maps the generic operations onto MongoDB admin commands:

| Type | MongoDB action |
|------|----------------|
| `analyze` | `validate` (one collection, or every collection) |
| `vacuum` / `optimize` | `compact` (one collection, or best-effort all) |
| `check` | `dbCheck` (**requires** a collection target) |
| `kill` | `killOp` (**requires** an opid) |
| `reindex` | **unsupported** — returns a message (the `reIndex` command was removed in MongoDB 6.0+) |

`getCapabilities().maintenanceOperations = ['vacuum', 'analyze', 'check']` — so the UI surfaces those
three, though `runMaintenance` also accepts `optimize`/`kill`/`reindex` when invoked directly.

---

## 9. Capabilities & labels

### `getCapabilities()` ([mongodb.ts:75](../../src/lib/db/providers/document/mongodb.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `json` |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['vacuum', 'analyze', 'check']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `27017` |
| `schemaRefreshPattern` | `"operation"\s*:\s*"(insert\|delete\|update)` |

`schemaRefreshPattern` matches write operations in the JSON query so the UI refreshes collections
after inserts/updates/deletes.

### Labels — overridden ([mongodb.ts:89](../../src/lib/db/providers/document/mongodb.ts))

Document vocabulary: entity → *Collection*, row → *document*, select → *Find Documents*, analyze →
*Validate Collection*, vacuum → *Compact Collection*, search → *Search collections or fields…*.

---

## 10. Error handling

MongoDB uses the shared `mapDatabaseError()` ([errors.ts](../../src/lib/db/errors.ts)) with **no**
MongoDB-specific branches:

| Situation | Error |
|-----------|-------|
| Missing `host`/`database` (no connection string) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` (carries host/port) |
| Missing `collection`/`operation`, or invalid JSON | `QueryError` (with a format example) |
| Missing `documents`/`update` for a write op | `QueryError` |
| Authentication failure (message contains *authentication*) | `AuthenticationError` |
| Other driver errors | generic `QueryError` / `DatabaseError` with the original message |

---

## 11. Testing

Integration tests live in
[`tests/integration/db/mongodb-provider.test.ts`](../../tests/integration/db/mongodb-provider.test.ts),
mocking the `mongodb` driver via `mock.module('mongodb', …)` **before** the provider is imported. The
mock collection/cursor/admin returns canned documents and stats, exercising every operation, BSON
serialization, schema inference, monitoring, and maintenance.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide; files mocking different drivers
> cross-contaminate in a shared process. Run a single file alone, or the suite via **`bun run test:ci`**
> (per-file isolation via `tests/run-core.sh`); the coverage workflow uses `bun run test:coverage`.
> Never use the single-process `bun run test` for the full suite. See [`CLAUDE.md`](../../CLAUDE.md).

### Coverage

Validation, connect/disconnect, capabilities, labels, `prepareQuery`, every `query` operation
(find/aggregate/count/distinct/insert/update/delete), `getSchema` inference, health, maintenance,
overview, performance, slow queries, active sessions, table/index/storage stats, **BSON
serialization** (ObjectId/Binary/Decimal128/Date/nested), and `getMonitoringData`.

```bash
bun test tests/integration/db/mongodb-provider.test.ts   # just this file
bun run test:ci                                           # CI publish gate
bun run test:coverage                                     # CI coverage workflow
```

To smoke-test against a live server: `docker run --rm -p 27017:27017 mongo:7`, then connect to
`mongodb://localhost:27017/test` in the Studio UI.

---

## 12. Usage examples

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'mg1', name: 'App', type: 'mongodb',
  connectionString: 'mongodb://localhost:27017/app', createdAt: new Date(),
});

await provider.connect();
const res = await provider.query(JSON.stringify({
  collection: 'users', operation: 'find', filter: { active: true }, options: { limit: 50 },
}));
const schema = await provider.getSchema();   // collections + inferred fields
await provider.disconnect();
```

Over the API: `POST /api/db/query` (JSON MQL in the `sql` field) and `POST /api/db/maintenance`
(admin). Transaction/cancel routes do not apply.

---

## 13. Known limitations & future work

- **Schema is inferred from a 100-document sample, flat.** Fields outside the sample don't appear,
  and nested object fields are shown as `object` rather than expanded into sub-fields
  ([§3.3](#33-sampling-based-flat-schema-inference)).
- **`aggregate` results are unbounded.** Only `find` gets a default 100-document cap; an `aggregate`
  pipeline without `$limit` can return a very large result set
  ([§3.4](#34-find-is-capped-at-100-aggregate-is-not)). *Future:* inject a safety `$limit` / cap
  aggregate output.
- **No `EXPLAIN`.** MongoDB's `explain()` is not wired (`supportsExplain: false`).
- **No multi-document transactions.** MongoDB supports them on replica sets/sharded clusters, but the
  provider exposes no begin/commit/rollback API.
- **No `cancelQuery`.** A running operation can only be terminated via maintenance `killOp` (needs the
  opid and privileges).
- **`collStats` is deprecated** in MongoDB 6.2+ (in favour of the `$collStats` aggregation stage);
  size/stats calls may warn or change on newer servers.
- **Monitoring needs privileges.** `serverStatus`/`currentOp`/`$indexStats` and the profiler require
  appropriate roles (`clusterMonitor`, etc.); without them fields degrade to `N/A`/`0`/`[]`, and slow
  queries require the profiler to be enabled.
- **`Binary` values are shown as a placeholder** (`<Binary: N bytes>`), not the raw bytes.

---

## 14. References

- Driver: [`mongodb` (node-mongodb-native)](https://github.com/mongodb/node-mongodb-native)
- Source: [`src/lib/db/providers/document/mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/mongodb-provider.test.ts`](../../tests/integration/db/mongodb-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md) · query format also in [`CLAUDE.md`](../../CLAUDE.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [Redis](./redis.md)
