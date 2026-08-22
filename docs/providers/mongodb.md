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

Loaded on demand by the factory ([`factory.ts:88`](../../src/lib/db/factory.ts)):

```ts
case 'mongodb': {
  const { MongoDBProvider } = await import('./providers/document/mongodb');
  return new MongoDBProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 JSON / MQL query format

`query()` ([mongodb.ts:240](../../src/lib/db/providers/document/mongodb.ts)) accepts a JSON object,
parsed by `parseQuery()` ([mongodb.ts:366](../../src/lib/db/providers/document/mongodb.ts)), which
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

`serializeDocument()` ([mongodb.ts:388](../../src/lib/db/providers/document/mongodb.ts)) recursively
normalises BSON types so documents render in the JSON grid: `ObjectId` → string, `Decimal128` →
string, `Date` → ISO-8601, `Binary` → `<Binary: N bytes>` (placeholder, not the raw bytes), and
nested objects/arrays are walked recursively. **Only these types are special-cased** — other BSON
types (`Long`, `Timestamp`, `UUID`, `RegExp`, `Code`, `DBRef`) fall through as generic objects and
may render poorly ([Known limitations](#13-known-limitations--future-work)).

### 3.3 Sampling-based schema inference, nested to three levels

MongoDB has no fixed schema, so `getSchema()` ([mongodb.ts:476](../../src/lib/db/providers/document/mongodb.ts))
**infers** one: it lists collections (skipping `system.*`, capped at 200), and for each samples the
first **100 documents** to derive field types ([mongodb.ts:510](../../src/lib/db/providers/document/mongodb.ts)).
Caveats baked into this approach:
- Fields absent from the sample (or appearing only in unsampled documents) won't show.
- **Subdocuments are expanded into dotted paths**, to `MAX_NESTED_FIELD_DEPTH = 3` counting the top
  level as 1 — so `shipping`, `shipping.city` and `shipping.geo.lat` are all listed, and
  `shipping.geo.deep.tooFar` is not. The container at the boundary is still named, so a reader can
  see that the nesting continues. `shipping.city` is a field name in MQL, and a schema that stopped
  at `shipping: object` did not name it: a plan run on 2026-08-22 grouped by `$shipping.region`, a
  path the database does not have, and MongoDB answers that with one null group rather than an
  error — so the plan read as runnable and was silently wrong.
- **Arrays are named and left closed.** `items.sku` addresses one value *per array entry*, so it
  does not mean on an array what the same syntax means on a subdocument; listing it in a flat field
  list would invite exactly that confusion. Date/ObjectId/Binary/Decimal128 are scalars here and
  are never descended into.
- **The field list is capped at `MAX_INFERRED_FIELDS = 200` per collection**, applied after the
  sort, so what survives is a deterministic prefix and `_id` always survives. Nesting multiplies:
  60 subdocuments of 10 fields each is 661 rows in the schema tree and 661 lines in an agent run's
  context window, for one collection.
- A field with multiple observed types is reported as `mixed(a|b)`. `_id` is marked primary.

### 3.4 `find` is capped at 100; `aggregate` is not

A `find` with no explicit `options.limit` is capped at **100** documents
([mongodb.ts:259](../../src/lib/db/providers/document/mongodb.ts)). **`aggregate` passes none of
`options` to the cursor** (no `limit`/`skip`) and has no default cap, so a pipeline without a
`$limit` stage can return an unbounded result set.

`prepareQuery()` does **not** modify the query (it injects no limit — the JSON is passed through
unchanged), but it is **not** a true no-op: it returns `limit: options.limit || 100`, and the
`/api/db/query` route uses that returned `limit`/`wasLimited` for pagination metadata
(`hasMore = rows.length === prepared.limit`). The `unlimited` option is **not** honoured — see
[Known limitations](#13-known-limitations--future-work).

---

## 4. Connection

`connectionString` is used **directly** (this is a genuine connection-string provider, unlike
SQL Server). `buildConnectionString()` ([mongodb.ts:189](../../src/lib/db/providers/document/mongodb.ts))
returns `config.connectionString` if present, else assembles
`mongodb://<user>:<password>@<host>:<port>/<database>` (credentials are URL-encoded; the
`<user>:<password>@` segment is omitted when no credentials are set).

```ts
// Connection string (SRV or standard)
const a = { id: 'mg-1', name: 'App', type: 'mongodb',
  connectionString: 'mongodb+srv://user:pass@cluster.example.net/app', createdAt: new Date() };

// Discrete fields
const b = { id: 'mg-1', name: 'App', type: 'mongodb',
  host: 'localhost', port: 27017, database: 'app',
  user: 'admin', password: 'secret', createdAt: new Date() };
```

`validate()` ([mongodb.ts:123](../../src/lib/db/providers/document/mongodb.ts)) requires either a
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
([mongodb.ts:240](../../src/lib/db/providers/document/mongodb.ts)). Reads (`find`/`findOne`/
`aggregate`/`count`/`distinct`) return documents; writes return an acknowledgement summary
(`insertedId`/`modifiedCount`/`deletedCount`, …). `rowCount = rows.length || affectedCount`, and
every returned document passes through `serializeDocument()`. There is no `prepareQuery` limit
injection, no transactions, and no `cancelQuery`. `EXPLAIN` is not supported
(`supportsExplain: false`).

**`options` handling differs per operation** (a real source of surprise — see
[Known limitations](#13-known-limitations--future-work)):

- **`find`** honours `projection` / `sort` / `skip` / `limit`.
- **`findOne`** honours **only `projection`** — a `sort` / `skip` / `limit` is **silently ignored**
  (so `{ "operation": "findOne", "options": { "sort": { "_id": -1 } } }` does *not* return the
  latest document).
- **`aggregate`** ignores `options` entirely (bound it with a `$limit` stage in the pipeline).
- **`distinct`** has **no dedicated field parameter**: the field is taken from the **first key of
  `options.projection`**, e.g. `{ "collection": "users", "operation": "distinct",
  "options": { "projection": { "country": 1 } } }` returns distinct `country` values (output shape
  `{ "country": <value> }`). With no projection it defaults to `_id`.

---

## 6. Schema introspection

`getSchema()` returns one `TableSchema` per collection:

| Data | Source |
|------|--------|
| Collections | `listCollections()` (skip `system.*`, cap 200) — **views included**, see below |
| Row count | `estimatedDocumentCount()` — **not asked of a view**; absent there |
| Size | `collStats` command (`size`) — **not asked of a view**; absent there |
| Columns | inferred from a 100-document sample ([§3.3](#33-sampling-based-schema-inference-nested-to-three-levels)), on a view exactly as on a collection |
| Indexes | `collection.indexes()` (`unique` flag, key fields) — **not asked of a view**; `[]` there |
| Foreign keys | always `[]` — MongoDB has none to declare, which the provider states as `declaresForeignKeys: false` ([§9](#9-capabilities--labels)) rather than leaving a reader to guess whether the read simply found none |

### Views are listed, and are asked less

`listCollections()` returns views alongside collections, and MongoDB rejects `count`, `listIndexes`
and `collStats` on a view with `CommandNotSupportedOnView` (code 166). Those three calls used to be
unguarded, so **one view in the database aborted the whole schema read** — the user lost every
collection, not just the view.

The fix guards them on `collInfo.type === "view"`, which the server has already reported, rather than
filtering views out of the listing. A view is an object the user created and expects to see, and its
fields are readable by the same document sample every collection gets; hiding it would answer "your
view does not exist" in order to keep three commands quiet. What a view genuinely cannot answer is
left **absent** rather than defaulted: no `rowCount` (a view holds no documents of its own, and `0`
would read as "empty") and no `size`, with `indexes: []` because the indexes its query uses belong to
the collection underneath it.

---

## 7. Monitoring & health

Rich, from `admin().serverStatus()`, `db.stats()`, `currentOp`, `$indexStats`, and the profiler.
Every method is wrapped in try/catch and degrades to a sensible default on permission errors.

| Method | Source | Notes |
|--------|--------|-------|
| `getHealth()` | `serverStatus`, `dbStats`, `currentOp`, `system.profile` | connections, data size, WiredTiger cache-hit %, current ops; slow queries need the profiler (placeholder row if disabled) |
| `getOverview()` | `serverStatus`, `buildInfo`, `dbStats`, `listCollections` | version, uptime, connections, collection/index counts |
| `getPerformanceMetrics()` | `serverStatus` (WiredTiger + opcounters) | cache-hit %, **ops/sec** (`query`+`insert`+`update`+`delete` opcounters ÷ uptime — *total operations, not just queries*), buffer-pool % (cache bytes), `deadlocks: 0` |
| `getSlowQueries()` | `system.profile` | per-op time/returned; **`[]` if the profiler isn't enabled** (`db.setProfilingLevel(1)`); sorted by `millis` (slowest) — note `getHealth()`'s slow-query block instead sorts by `ts` (most recent) and emits a placeholder row when disabled |
| `getActiveSessions()` | `currentOp` | opid, ns, lock waits, duration — ⚠️ the **`user` field is populated from `op.client`** (the client `host:port`), **not** an authenticated user |
| `getTableStats()` | `collStats` per collection | row count + data/index/total sizes |
| `getIndexStats()` | `$indexStats` + `indexes()` | **real `scans`** (`accesses.ops`); `indexSize` `N/A`; **`indexType` only distinguishes `text` vs `btree`** — `hashed`/`2dsphere`/`2d`/wildcard/clustered are all mislabelled `btree` |
| `getStorageStats()` | `dbStats` + WiredTiger | Data / Indexes / Storage / WiredTiger cache (with usage %) |

---

## 8. Maintenance

`runMaintenance(type, target?)` ([mongodb.ts:614](../../src/lib/db/providers/document/mongodb.ts))
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

### `getCapabilities()` ([mongodb.ts:81](../../src/lib/db/providers/document/mongodb.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `json` |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` — the query language is JSON commands, so there is no `UPDATE ... SET` for the results grid's inline editor to emit |
| `declaresForeignKeys` | `false` — MongoDB has no foreign key constraint at all, so an empty `foreignKeys` list here is the engine's model and not this database's shape |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['vacuum', 'analyze', 'check']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `27017` |
| `schemaRefreshPattern` | `"operation"\s*:\s*"(insert\|delete\|update)` |

`schemaRefreshPattern` matches write operations in the JSON query so the UI refreshes collections
after inserts/updates/deletes.

### Labels — overridden ([mongodb.ts:95](../../src/lib/db/providers/document/mongodb.ts))

Document vocabulary: entity → *Collection*, row → *document*, select → *Find Documents*, analyze →
*Validate Collection*, vacuum → *Compact Collection*, search → *Search collections or fields…*.

`statementLanguage` is the one label a person never sees: the agent's plan contract states it
verbatim to the model. It carries the JSON envelope of [§3.1](#31-json--mql-query-format) and names
**mongosh** as the form that is excluded. It exists for the reason the search products' does — told
to write "one runnable statement in this MongoDB database's own query language", a plan run on
2026-08-22 answered `db.orders.aggregate([{ $group: … }])`, which is correct MongoDB and unrunnable
here, because `query()` parses the JSON command object and nothing else. Naming only what the
language *is* did not survive contact with the model's prior; naming what it is not did.

`slowQueriesEmptyState` (*"Query stats come from the database profiler - run db.setProfilingLevel()
to start recording into system.profile."*) is the monitoring Queries panel's empty state. That
sentence was hardcoded to PostgreSQL's `pg_stat_statements` advice on every engine
(`docs/BACKLOG.md` U12); here `getSlowQueries()` reads `system.profile`
([§7](#7-monitoring--health)), which does not exist until the profiler is switched on.

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
> cross-contaminate in a shared process. CI runs the full suite via **`bun run test:ci`** (per-file
> process isolation via `tests/run-core.sh`) and **`bun run test:coverage`** for determinism. The
> `bun run test` pre-commit gate (per [`CLAUDE.md`](../../CLAUDE.md)) also works — it isolates the
> component group — but runs the core group in a single process, so prefer `test:ci` when isolation
> matters. Running a single file alone is always safe.

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

- **Schema is inferred from a 100-document sample.** Fields outside the sample don't appear;
  subdocuments are expanded only to depth 3 and only up to 200 fields per collection, and array
  elements' fields are never expanded ([§3.3](#33-sampling-based-schema-inference-nested-to-three-levels)).
- **`aggregate` results are unbounded.** Only `find` gets a default 100-document cap; an `aggregate`
  pipeline without `$limit` can return a very large result set
  ([§3.4](#34-find-is-capped-at-100-aggregate-is-not)). *Future:* inject a safety `$limit` / cap
  aggregate output.
- **No `EXPLAIN`.** MongoDB's `explain()` is not wired (`supportsExplain: false`).
- **No multi-document transactions.** MongoDB supports them on replica sets/sharded clusters, but the
  provider exposes no begin/commit/rollback API.
- **No `cancelQuery`.** A running operation can only be terminated via maintenance `killOp` (needs the
  opid and privileges).
- **No column modification in a generated migration.** Since
  [#269](https://github.com/libredb/libredb-studio/issues/269) the schema-diff migration generator
  answers a modified column per dialect; collections are schemaless, so it emits
  `-- MongoDB: Cannot alter column "<name>". ...` where it previously emitted PostgreSQL
  `ALTER TABLE ... ALTER COLUMN` DDL that means nothing here.
- **`collStats` is deprecated** in MongoDB 6.2+ (in favour of the `$collStats` aggregation stage);
  size/stats calls may warn or change on newer servers.
- **Monitoring needs privileges.** `serverStatus`/`currentOp`/`$indexStats` and the profiler require
  appropriate roles (`clusterMonitor`, etc.); without them fields degrade to `N/A`/`0`/`[]`, and slow
  queries require the profiler to be enabled.
- **`Binary` values are shown as a placeholder** (`<Binary: N bytes>`), not the raw bytes, and only
  a subset of BSON types are normalised (`Long`/`Timestamp`/`UUID`/`RegExp`/`Code`/`DBRef` render as
  generic objects).
- **`distinct` has no dedicated field parameter.** The field is derived from the first key of
  `options.projection` — an overload of `projection` (which normally means field inclusion). Users
  must know this incantation; *Future:* add an explicit `options.field`.
- **`findOne` silently ignores `sort`/`skip`/`limit`** (only `projection` is honoured), so it cannot
  be used to fetch "the latest" document by sort.
- **`aggregate` ignores `options.limit`/`skip`** and has no safety cap — only an in-pipeline
  `$limit` bounds the result set (`supportsExternalQueryLimiting: false`, so the route injects none).
- **The active-sessions `user` column shows the client address** (`op.client`, e.g. `host:port`),
  not an authenticated user. *Future:* map from `op.effectiveUsers`/`op.users` (MongoDB 5.0+).
- **`getIndexStats().indexType` only distinguishes `text` vs `btree`** — `hashed`, geospatial
  (`2dsphere`/`2d`), wildcard (`$**`), and clustered indexes are all reported as `btree`.
- **The `unlimited` query option is ignored.** `prepareQuery()` always returns `limit:
  options.limit || 100`; combined with the route's `hasMore = rows.length === prepared.limit`, an
  "unlimited" request can report an incorrect `hasMore`.
- **`getSchema()` issues serial round-trips** — up to ~4 calls (count + `collStats` + 100-doc sample
  + `indexes()`) per collection, across up to 200 collections, with no batching/timeout; the schema
  panel can be slow on a large or remote/loaded cluster. A view costs one call (the sample), since
  the other three are the ones MongoDB refuses on a view ([§6](#6-schema-introspection)).

---

## 14. References

- Driver: [`mongodb` (node-mongodb-native)](https://github.com/mongodb/node-mongodb-native)
- Source: [`src/lib/db/providers/document/mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/mongodb-provider.test.ts`](../../tests/integration/db/mongodb-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md) · query format also in [`CLAUDE.md`](../../CLAUDE.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [Apache Trino](./trino.md) · [Redis](./redis.md)
