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
| **SSL** | Yes — `connection.ssl` → `tls` + Node's `ca`/`cert`/`key` ([§4.1](#41-ssl--tls)) |
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
{ "collection": "products", "operation": "distinct", "field": "category", "filter": {"active": true} }
{ "collection": "users", "operation": "insertOne", "documents": [{"name": "John"}] }
```

`distinct` is the one operation with a key of its own: `field`, the driver's own parameter name, and
it is **required**. The example above answers one row per category, shaped `{ "category": <value> }`.
A missing or non-string `field` is a `QueryError` naming the key it wanted — it used to read the
field from the first key of `options.projection` and fall back to `_id`, so
`{"operation": "distinct", "field": "category"}` answered 120 rows of `_id` (measured 2026-08-22 on
`mongo:latest`, 120 products in five categories). `options.projection` is **not** an alias for it.

Supported operations: `find`, `findOne`, `aggregate`, `count`, `distinct`, `insertOne`, `insertMany`,
`updateOne`, `updateMany`, `deleteOne`, `deleteMany`. See the
[`API_DOCS.md` MongoDB Query Format](../API_DOCS.md) section (under `POST /api/db/query`) and
[`CLAUDE.md`](../../CLAUDE.md) for the request shape.

Since S8 the **execution confirmation gate reads this same shape**:
`src/lib/db/destructive-commands.ts` names `deleteOne`, `deleteMany`, `updateOne`, `updateMany` and
the top-level `$out` / `$merge` aggregate stages as the destructive operations here - so each of
them asks before it runs, exactly as a `DELETE FROM` does on a SQL engine, and a payload the reader
cannot read as a document with a string `operation` (mongosh syntax such as
`db.users.deleteMany({})`, a half-typed object) asks as well rather than staying silent.

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
`mongodb://<user>:<password>@<host>:<port>/<database>[?authSource=<authSource>]` (credentials and
the auth database are URL-encoded; the `<user>:<password>@` segment is omitted when no credentials
are set, and the query string when no `authSource` is).

**`authSource` is the database the credentials live in, and it is not always the one being opened.**
MongoDB creates users inside a database, and the driver checks them against whichever database the
URI names when nothing says otherwise — so the ordinary deployment, users in `admin` and data
elsewhere, could not be reached through the discrete fields at all: it failed as a credentials
error, which is what it looks like and is not what it is. Leave the field empty when the user
was created in the database being opened. A pasted `connectionString` is used verbatim and carries
its own `?authSource=`, so the form offers no separate input in that mode.

```ts
// Connection string (SRV or standard)
const a = { id: 'mg-1', name: 'App', type: 'mongodb',
  connectionString: 'mongodb+srv://user:pass@cluster.example.net/app', createdAt: new Date() };

// Discrete fields
const b = { id: 'mg-1', name: 'App', type: 'mongodb',
  host: 'localhost', port: 27017, database: 'app',
  user: 'admin', password: 'secret', createdAt: new Date() };

// Discrete fields, user created in `admin` — the ordinary deployment
const c = { id: 'mg-1', name: 'App', type: 'mongodb',
  host: 'localhost', port: 27017, database: 'shop',
  user: 'app', password: 'secret', authSource: 'admin', createdAt: new Date() };
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

### 4.1 SSL / TLS

`buildTLSOptions()` ([mongodb.ts:275](../../src/lib/db/providers/document/mongodb.ts)) maps
`connection.ssl` onto the driver's TLS options. `tls`, `ca`, `cert`, `key` and `rejectUnauthorized`
are all on the driver's own allow-list (`LEGAL_TLS_SOCKET_OPTIONS` in `mongodb/lib/cmap/connect.js`)
and reach `tls.connect` under Node's names, so the material maps exactly as it does for PostgreSQL,
MySQL and Couchbase:

| `ssl.mode` | Options added |
|------------|---------------|
| absent / `disable` | none — the client is built as before |
| `require` | `tls: true`, `rejectUnauthorized: false` |
| `verify-system` | `tls: true`, `rejectUnauthorized: true`, and **no** `ca` |
| `verify-ca` / `verify-full` | `tls: true`, `rejectUnauthorized: true` |

`caCert` / `clientCert` / `clientKey` become `ca` / `cert` / `key` when set, each independently — a
cluster can demand mutual TLS while presenting a self-signed certificate itself. An explicit
`ssl.rejectUnauthorized` always wins over the mode. `require` does not check the chain because a
self-hosted replica set presents a self-signed certificate by default; `verify-system` is the same
handshake with verification on and nothing to paste, which is what an Atlas cluster needs (its
certificate is signed by a public root the runtime already trusts). The driver exposes no separate
host-name check, so `verify-ca` and `verify-full` build the same options object.

#### `tls=true` in a pasted URI (D26)

The paste box now reads the URI's own TLS options, and maps them by the rule stated in
`readBooleanTLS` — a boolean TLS spelling lands on the mode that matches what the driver does with it:

| In the pasted URI | SSL Mode set on the form |
|-------------------|--------------------------|
| `tls=true` / `ssl=true` | `verify-system` — the driver enables TLS **with** chain verification |
| `tls=false` / `ssl=false` | `disable` |
| `mongodb+srv://` with no TLS parameter | `verify-system` — SRV implies TLS in the driver itself |
| `tlsInsecure=true` / `tlsAllowInvalidCertificates=true` alongside TLS | `require` — both turn `rejectUnauthorized` off |
| a non-boolean value (`tls=maybe`) | nothing; the paste banner quotes the parameter |

`tls=true` was deliberately **ignored** before this: the only non-`disable` mode that needed no PEM
was `require`, i.e. `rejectUnauthorized: false`, and because the options object is a second channel
the driver prefers over the URI, setting it would have stopped an Atlas certificate being verified.
Leaving it unset had its own cost — the SSL panel read `disable` for a connection that was in fact
encrypted. `verify-system` removes the trade: the form now says what the URI says.
`tlsAllowInvalidHostnames` is not in the relaxing set, because this provider never sends
`checkServerIdentity`, so the URI's own relaxation survives next to a verifying mode.

Measured against a TLS-only server on 2026-08-23 (`mongo:latest --tlsMode requireTLS`): `disable` is
refused - the server logs *"The server is configured to only allow SSL connections"* - and `require`
connects in 20ms, with *"Ingress TLS handshake complete"* on the server side. Both arms matter, since
before the mode reached the driver `require` failed the same way `disable` does.

> Unlike `authSource`, this **is** applied alongside a pasted `connectionString`. The URI is returned
> verbatim, so a `tls=` cannot be appended to it, but the options object is a second channel the
> driver reads — and the connection dialog shows the SSL panel in connection-string mode too, so a
> selection made there has to mean something.

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
- **`distinct`** ignores `options` entirely and takes its field from the top-level **`field`** key,
  e.g. `{ "collection": "users", "operation": "distinct", "field": "country" }` returns distinct
  `country` values (output shape `{ "country": <value> }`). The key is required: a missing or
  non-string one is a `QueryError`, never a silent `_id`.

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
Every method is wrapped in try/catch. Degradation reports the absence rather than filling it in — see
[§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured).

| Method | Source | Notes |
|--------|--------|-------|
| `getHealth()` | `serverStatus`, `dbStats`, `currentOp`, `system.profile` | connections (**omitted**, never `0`, when the server publishes none — [§7.2](#72-a-connection-count-nobody-published-is-absent-not-zero)), data size (**`"N/A"`**, never `"0 B"`, when `db.stats()` answers without `dataSize` — [§7.3](#73-a-database-size-nobody-published-is-absent-not-0-b)), WiredTiger cache-hit % (`"N/A"` when unmeasurable, [§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured)), current ops; slow queries need the profiler (placeholder row if disabled) |
| `getOverview()` | `serverStatus`, `buildInfo`, `dbStats`, `listCollections` | version, uptime, connections (**omitted**, never `0`, on the same two paths as `getHealth()` — [§7.2](#72-a-connection-count-nobody-published-is-absent-not-zero)), database size (`databaseSizeBytes` **omitted**, never `0`, on those same two paths — [§7.3](#73-a-database-size-nobody-published-is-absent-not-0-b)), collection/index counts. `maxConnections` is `connections.current + connections.available`, or `0` — the repo's spelling of *no limit published* — when the server publishes no headroom |
| `getPerformanceMetrics()` | `serverStatus` (WiredTiger + opcounters) | cache-hit %, **ops/sec** (`query`+`insert`+`update`+`delete` opcounters ÷ uptime — *total operations, not just queries*), buffer-pool % (cache bytes), `deadlocks: 0`. **Every field is optional**: each one is present only if its reading was, and a failed `serverStatus` reports `{}` ([§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured)) |
| `getSlowQueries()` | `system.profile` | per-op time/returned; **`[]` if the profiler isn't enabled** (`db.setProfilingLevel(1)`); sorted by `millis` (slowest) — note `getHealth()`'s slow-query block instead sorts by `ts` (most recent) and emits a placeholder row when disabled |
| `getActiveSessions()` | `currentOp` | opid, ns, lock waits, duration — ⚠️ the **`user` field is populated from `op.client`** (the client `host:port`), **not** an authenticated user |
| `getTableStats()` | `collStats` per collection | row count + data/index/total sizes, `totalIndexSize` carried as the byte figure `indexSizeBytes` and not only as formatted text |
| `getIndexStats()` | `$indexStats` + `indexes()` | **real `scans`** (`accesses.ops`); `indexSize` `N/A`; **`indexType` only distinguishes `text` vs `btree`** — `hashed`/`2dsphere`/`2d`/wildcard/clustered are all mislabelled `btree` |
| `getStorageStats()` | `dbStats` + WiredTiger | Data / Indexes / Storage / WiredTiger cache (with usage %) |

### 7.1 What the panel shows when the cache cannot be measured

The cache hit ratio is computed from `serverStatus.wiredTiger.cache` — `pages read into cache` over
`pages requested from the cache`. Three things can make that unmeasurable, and none of them is a
number:

- the deployment publishes no `wiredTiger` section at all (`mongos`, the in-memory storage engine,
  the wire-compatible services);
- the section is there but `pages requested from the cache` is `0`, on a server that has served
  nothing yet — no hits and no misses, which is not a perfect hit rate;
- `serverStatus` fails outright, which is what an unprivileged user gets (`clusterMonitor` is the
  role it wants).

In all three the field is **omitted** from `getPerformanceMetrics()` and `getHealth()` reports the
string `"N/A"`; the Overview and Performance tabs then render *Cache Hit* as `N/A` beside *Not
measured*, and the card border stays neutral instead of being rated. `bufferPoolUsage` follows the
same rule for the same section. A **measured** `0` — a genuinely cold cache — is kept and rendered as
`0.0%`, because it is a fact the server reported.

This replaces a hardcoded `cacheHitRatio: 99` that both the no-`wiredTiger` path and the failed-
`serverStatus` path used to return: a figure the provider invented, indistinguishable at the panel
from a measurement (the rule [#424](https://github.com/libredb/libredb-studio/issues/424) exists to
enforce, and [#452](https://github.com/libredb/libredb-studio/pull/452) built the *unavailable*
rendering for).

### 7.2 A connection count nobody published is absent, not zero

`getHealth().activeConnections` and `getOverview().activeConnections` both come from
`serverStatus.connections.current`, and there are two ordinary ways that reading does not happen:

- the deployment publishes no `connections` section at all — an API-compatible service, or any
  deployment whose `serverStatus` answers without it. This is **not** [§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured)'s
  set: `connections` is a network-layer field of `serverStatus`, not a storage-engine sub-document
  like `wiredTiger`, so the reason that set omits `wiredTiger` does not carry here, and which
  deployments omit `connections` is not measured in this repo. The
  [`serverStatus` manual page](https://www.mongodb.com/docs/manual/reference/command/serverStatus/)
  offers no guarantee to measure it against either: it notes that "the output fields vary depending
  on the version of MongoDB, underlying operating system platform, the storage engine, and the kind
  of node, including `mongos`, `mongod` or replica set member", and describes `connections` only as
  "a document that reports on the status of the connections" — it promises no top-level field,
  `connections` included, on every deployment. So the provider treats a `serverStatus` that answers
  without the section as an ordinary answer, without ruling on which deployments answer that way;
- `serverStatus` (or `db.stats()`, or `currentOp`, or `buildInfo`) fails outright, which is what a
  user without `clusterMonitor` gets, and the whole read then falls into its outer catch.

`HealthInfo.activeConnections` and `DatabaseOverview.activeConnections` are both **optional** for
exactly this case, so in all four paths the key is now **omitted** — absent from the object, absent
from the `POST /api/db/health` body, absent from the monitoring payload, and the admin fleet-health
row drops its `N conn` figure rather than printing `0 conn`
([`src/components/admin/tabs/OverviewTab.tsx`](../../src/components/admin/tabs/OverviewTab.tsx)).
Every one of them used to answer `0`: `connections?.current || 0` on both success paths and a literal
`activeConnections: 0` in both outer catches. On the `getHealth()` side that reached the model: the
agent's curated `health` reading is `getHealth()` (`method: "getHealth"` in
[`src/lib/agent/tools.ts`](../../src/lib/agent/tools.ts), which projects this key with `?? null`), so
a MongoDB the caller could not query at all arrived as a *measured* "no connections open".
`getOverview()`'s count does **not** reach the model - nothing under `src/lib/agent` reads
`getOverview()` - and its readers are the monitoring **Connections** card, that card's trend chart,
and the connection-threshold rating that colours it. On the Overview tab the `0` was not merely a
blank in disguise: it printed as the figure `0` on the *Connections* card, and — because that tab
keeps a history — each refresh added a real `0` point to the connection sparkline, whose `flatMap`
drops absent samples and plots present ones. With the key absent the card reads `N/A` above *not
published* and the sample is dropped from the trend
([`src/components/monitoring/tabs/OverviewTab.tsx`](../../src/components/monitoring/tabs/OverviewTab.tsx)).
No percentage was ever involved on these paths: whenever `connections.current` is unmeasurable
`maxConnections` is `0` too, and the card only computes a share when a limit is published.

A server that really has `0` open connections keeps the `0` — it is a reading, and the absence is
spelled `measuredNumber(...)` plus a conditional spread, never `|| undefined` and never `|| 0`. The
`|| 0` form was in fact two defects on one line: it invented a figure where none was published *and*
flattened a genuinely idle server's measured `0` into the same value, so the two are
indistinguishable downstream.

Both outer catches still **resolve** rather than rethrowing, but for different reasons, and neither
reason licenses naming a figure:

- `getHealth()` resolves because `POST /api/db/health` serialises whatever it resolves with and
  `POST /api/admin/fleet-health` reads `healthy` from a read that returned, so rethrowing would
  report a server that is up as an error;
- `getOverview()` resolves because `getMonitoringData()`
  ([`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)) reads the panel through
  `Promise.allSettled`, so a rethrow would replace the whole overview with an `errors.overview`
  entry instead of the `"MongoDB Unknown"` / `"N/A"` placeholders the tab renders. That is a
  legitimate alternative rather than a bug, and it is left alone here: it is a cross-provider
  decision, since every provider's `getOverview()` degrades the same way.

(`getHealth()`'s `slowQueries: [{ query: "Error fetching health info" }]` placeholder is the same
class of fabrication one size down and is still there; it is tracked separately, because removing it
needs `HealthInfo.slowQueries` to become optional across all 15 type-ids.)

### 7.3 A database size nobody published is absent, not `0 B`

The byte figure travels the same two paths as the count above and had the same two spellings of a
fabrication. Both outlived the round that fixed the count, one field over in the same object:

- `getOverview()`'s outer catch returned a literal `databaseSizeBytes: 0`. Nothing was read on that
  path - `serverStatus`, `db.stats()`, `buildInfo` and `listCollections` are all inside the same
  `try`, so a user without `clusterMonitor` reaches it - and `DatabaseOverview.databaseSizeBytes` is
  **optional** precisely so that a provider with no byte figure can say so. The key is now omitted;
- both success paths formatted `dbStats.dataSize || 0`, which cannot tell a database that measures
  0 bytes from a `db.stats()` that answered without `dataSize`. Both are now
  `measuredNumber(dbStats.dataSize)`: absent, the overview omits `databaseSizeBytes` and reports
  `databaseSize: "N/A"`; measured, a real `0` still formats as `"0 B"`. MongoDB's own
  [`dbStats` reference](https://www.mongodb.com/docs/manual/reference/command/dbStats/) documents
  `dataSize` unconditionally - the only output fields it gates are `freeStorageSize`,
  `indexFreeStorageSize` and `totalFreeStorageSize`, on the command's `freeStorage: 1` option - so
  this arm is **not** a deployment measured in this repo; it is the input `|| 0` could not
  distinguish, and the optional field exists to carry it.

**What the absence buys is a whole panel.**
[`StorageTab.tsx`](../../src/components/monitoring/tabs/StorageTab.tsx) keys its entire breakdown off
`overview?.databaseSizeBytes !== undefined`. With the key present as `0` it treated the size as
**known** and drew the breakdown over a `0 B` total: the *Tables* and *Indexes* cards at `0.0%`, and
an *Other (unattributed)* row computed as `totalSize - totalTableSize - totalIndexSize`. That
remainder is the part a refused `serverStatus` makes visibly wrong rather than merely empty, because
the table read does **not** share the failure - `getTableStats()` goes through `listCollections` +
`collStats`, neither of which needs `clusterMonitor` - so its per-table byte figures arrive, both
`known` flags are true, and the row draws a **negative** byte count as a measurement. A 1 KB collection
with 512 B of indexes renders the literal string `-1536 B` (measured 2026-08-27 against the cascade
itself): the tab formats bytes with its own local threshold cascade, whose last arm returns whatever it
was given, so a negative passes through intact and reads as a figure the engine reported. With the key absent the tab draws its own *"No storage size
information available."* instead, and the *Tables* / *Indexes* cards read `N/A`. Both arms are pinned
in [`tests/components/monitoring/StorageTab.test.tsx`](../../tests/components/monitoring/StorageTab.test.tsx).

`getHealth()`'s size is a required string, so its absence is spelled `"N/A"` - the value that
method's own catch already returns. That one **does** reach the model: the curated `health` reading
projects `databaseSize` verbatim, so `"0 B"` told the model a database it could not measure holds
nothing.

Three `0`s stay in `getOverview()`'s catch, for two different reasons - and neither reason is that
something was measured:

- `maxConnections` stays `0` because there `0` *means* "no limit published" - absence and zero are
  the same fact for a published ceiling, which is why the field is a required number
  ([`DatabaseOverview` in types.ts](../../src/lib/db/types.ts));
- `tableCount` and `indexCount` are required numbers with no absence to spell, so `0` is the only
  value the type leaves for a path that counted nothing. They are the one place this object still
  states more than it read ([§13](#13-known-limitations--future-work)).

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

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#U9).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available - a targetless `{type:"check"}` is that
request here.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `vacuum` | Compact Collection | yes | yes | `{compact: <coll>}`, or every collection from `listCollections()` |
| `analyze` | Validate Collection | yes | yes | `{validate: <coll>}`, same loop without a target |
| `check` | Check Collection | yes | **no** | `{dbCheck: <coll>}` is not looped and throws without a collection name |

*"Compact Collection"* really is the `vacuum` this provider declares, so
`vacuumActionOperation` stays absent.

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
| `supportsTransactions` | `false` — multi-document transactions need a client session this provider does not hold, so BEGIN/COMMIT/ROLLBACK and SANDBOX are not offered; they used to be, and answered HTTP 400 (#U13) |
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
serialization** (ObjectId/Binary/Decimal128/Date/nested), `getMonitoringData`, and **every `ssl.mode`
branch** asserted against the options object the `MongoClient` constructor received.

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
  appropriate roles (`clusterMonitor`, etc.); without them the affected metrics are reported as
  *unavailable* rather than as numbers ([§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured)),
  the health connection count is omitted rather than reported as `0`
  ([§7.2](#72-a-connection-count-nobody-published-is-absent-not-zero)), the overview's byte figure is
  omitted rather than reported as `0`
  ([§7.3](#73-a-database-size-nobody-published-is-absent-not-0-b)), and slow queries require the
  profiler to be enabled.
- **A failed overview read still reports `tableCount: 0` and `indexCount: 0`.** Both fields are
  required numbers on `DatabaseOverview`, so `getOverview()`'s catch has no absence to spell for
  them and a denied `serverStatus` reports two counts nobody took
  ([§7.3](#73-a-database-size-nobody-published-is-absent-not-0-b)). *Future:* the same change the
  connection count and the byte figure got, which needs the two fields to become optional across all
  15 type-ids.
- **`Binary` values are shown as a placeholder** (`<Binary: N bytes>`), not the raw bytes, and only
  a subset of BSON types are normalised (`Long`/`Timestamp`/`UUID`/`RegExp`/`Code`/`DBRef` render as
  generic objects).
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
- MongoDB manual: [`serverStatus`](https://www.mongodb.com/docs/manual/reference/command/serverStatus/) · [`dbStats`](https://www.mongodb.com/docs/manual/reference/command/dbStats/) — the two commands §7.1–§7.3 read, and the pages the claims about which output fields are guaranteed come from
- Source: [`src/lib/db/providers/document/mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/mongodb-provider.test.ts`](../../tests/integration/db/mongodb-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md) · query format also in [`CLAUDE.md`](../../CLAUDE.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [Apache Trino](./trino.md) · [Redis](./redis.md)
