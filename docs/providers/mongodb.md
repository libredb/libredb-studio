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
| **Server floor** | **MongoDB 4.4** — the driver removed 4.2 support in 7.6.0 and now *throws* when it connects to a server of 4.2 or older, so this is a hard floor rather than a degraded surface ([release notes](https://github.com/mongodb/node-mongodb-native/releases/tag/v7.6.0)) |
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
| "Table" (the relation kind) | A **collection** |
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

Loaded on demand by `createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)):

```ts
case 'mongodb': {
  const { MongoDBProvider } = await import('./providers/document/mongodb');
  return new MongoDBProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 JSON / MQL query format

`query()` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)) accepts a JSON object,
parsed by `parseQuery()` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)), which
requires `collection` and `operation`:

```json
{ "collection": "users", "operation": "find", "filter": {"age": {"$gt": 18}}, "options": {"limit": 10} }
{ "collection": "orders", "operation": "aggregate", "pipeline": [{"$group": {"_id": "$status", "count": {"$sum": 1}}}] }
{ "collection": "products", "operation": "distinct", "field": "category", "filter": {"active": true} }
{ "collection": "users", "operation": "insertOne", "documents": [{"name": "John"}] }
```

`database` names the database the command runs in, so `{ "database": "analytics", "collection": "events", "operation": "find" }` reads `analytics.events` and not the connected database's `events` (#843).
It is optional: absent means the connected database, which is what every statement written before the key existed means, the editor's snippets included.
A non-string or empty value is a `QueryError`, raised before any database is opened: `MongoClient.db()` opens any string it is given, and a database that does not exist answers every read with 0 rows.
A database the credentials cannot read raises the server's own sentence (`not authorized on analytics to execute command ...`), never an empty result.

Every statement the product writes for a collection carries the key: the tree click, Generate Query and the count query (`generateTableQuery`, `generateSelectQuery`, `generateCountQuery`), the profiler (`/api/db/profile`) and the test data generator.
All five read it through `jsonCommandAddress()` in [`query-generators.ts`](../../src/lib/query-generators.ts), which takes the segment the declaration assigns to the `schema` level rather than `path[0]` (standing ruling 5g) and refuses a path that does not match the declared levels.
Before #843 every one of them named the collection alone, so a collection outside the connected database read, profiled and was written as the connected database's same-named collection.

#### Extended JSON in the query

The statement is read as [MongoDB Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/), not as plain JSON, so `filter`, `pipeline`, `update` and `documents` can carry the values plain JSON has no syntax for, in every operation alike:

```json
{ "collection": "users", "operation": "find", "filter": {"_id": {"$oid": "650000000000000000000001"}} }
{ "collection": "events", "operation": "find", "filter": {"created": {"$gte": {"$date": "2020-01-01T00:00:00Z"}}} }
{ "collection": "events", "operation": "insertOne", "documents": [{"when": {"$date": "2025-01-01T00:00:00Z"}}] }
{ "collection": "users", "operation": "updateOne", "filter": {"_id": {"$oid": "650000000000000000000001"}}, "update": {"$set": {"seen": {"$date": 1735689600000}}} }
```

Before this, plain `JSON.parse` read the statement, and a document the grid shows could not be addressed by its `_id`: measured on MongoDB 8.2.12 (2026-10-03), the string `_id` matched 0 documents, `{"$oid": ...}` failed `unknown operator: $oid`, a `$date` range matched nothing, and an insert stored `when: { '$date': '2025-01-01T00:00:00Z' }` as a subdocument.

**How it is read.** `parseExtendedJson()` reads the text with plain `JSON.parse` and walks it. An object whose ONLY key is one of the wrappers below is handed to the driver's own `BSON.EJSON.parse` (no extra dependency) and replaced with the value it names; every other object is kept as written.
`EJSON.parse` is not run over the whole text because it replaces an object with a value as soon as any of its keys is one it knows, and drops the rest in silence: `{"name": {"$regex": "^a", "$nin": ["admin"]}}` would reach the server as `{"name": /^a/}`, so a `deleteMany` with it would delete `admin` too.

- **The wrappers recognised**, each alone in its object: `$oid`, `$date`, `$numberInt`, `$numberLong`, `$numberDouble`, `$numberDecimal`, `$binary` (the canonical `{"base64": ..., "subType": ...}` form), `$uuid`, `$regularExpression`, `$timestamp`, `$minKey` and `$maxKey`.
  Both forms are accepted: relaxed (`{"$date": "2025-01-01T00:00:00Z"}`, `{"$date": 1735689600000}`) and canonical (`{"$date": {"$numberLong": "1735689600000"}}`).
- **Not recognised, kept as literal subdocuments as before:** `$code`/`$scope`, `$symbol`, `$dbPointer`, a DBRef (`{"$ref", "$id", "$db"}`) and `$undefined`.
- **The legacy `{"$binary": "<base64>", "$type": "00"}` form is refused**, because `$type` shares the object with `$binary`. Use `{"$binary": {"base64": ..., "subType": ...}}` for binary data.
- **A wrapper must be alone in its object.** `{"$date": "...", "$lt": 5}` is a `QueryError` naming the path and the extra keys; to compare against a value, nest it: `{"$lt": {"$date": "..."}}`.
  The flip side: a stored subdocument that literally has a key such as `$oid` or `$date` can no longer be matched by equality, because the same object now names a value.
- **Query operators are untouched**, the legacy `{"$regex": "^a", "$options": "i"}` form included, and `$regex` beside `$nin`/`$ne` keeps every key.
- **A plain number is unchanged.** A number outside a wrapper stays the number `JSON.parse` read, so the driver writes it as before (int32 when it fits, a double otherwise) and `options.limit` stays a number.
- **`$numberLong` is exact within the 64-bit range.** It becomes a bigint, written as a 64-bit integer, so `{"$numberLong": "9007199254740993"}` is not rounded to `...992`. A value outside the range (`"9223372036854775808"`) is a `QueryError`; the parser would otherwise wrap it to a negative number.
- **`$numberDouble` stays a double**, `{"$numberDouble": "5"}` included: it alone is read in canonical mode.
- **A malformed wrapper is a `QueryError` carrying its path and the parser's reason** (`Invalid Extended JSON in the query at "filter._id": input must be a 24 character hex string, ...`), and a `$date` that names no instant (`{"$date": "next tuesday"}`) is refused the same way, because the driver would otherwise write it as 1970-01-01 in silence.
- **Results are unchanged** except for an echo of a typed `_id`: what comes back still passes through `serializeDocument()` ([§3.2](#32-bson-serialization-for-the-grid)), which now also renders a bigint as a number when it is exact and as its digits past 2^53, and a `Double` as a number. Only a write's `insertedId`/`insertedIds` can hold either, since the driver reads neither back; a bigint used to make the response fail after the write had committed.

FerretDB serves this same provider and parses the same way; the BSON values reach it over the same wire protocol.

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

`serializeDocument()` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)) recursively
normalises BSON types so documents render in the JSON grid: `ObjectId` → string, `Decimal128` →
string, `Date` → ISO-8601, `Binary` → `<Binary: N bytes>` (placeholder, not the raw bytes), and
nested objects/arrays are walked recursively, an array's entries by the same rules as a field. The
rest of the BSON classes are shown as text too (#1423): a `Long` the driver keeps as one (past 2^53)
→ its decimal digits, as other providers carry a 64-bit integer; a `Timestamp` →
`Timestamp(t, i)`, the shell's spelling; a regular expression (native `RegExp` or `BSONRegExp`) →
`/pattern/flags`; a subtype-4 `Binary` of 16 bytes (a UUID) → its dashed hex; an `Int32` → its
number; and every other class (`Code`, `MinKey`, `MaxKey`, `DBRef`, `BSONSymbol`) → its relaxed
Extended JSON text, such as `{"$minKey":1}`. Before #1423, measured on `mongo:8.2.12`, a `Long`
showed as `{"high":2097152,"low":1,"unsigned":false}`, a `Timestamp` the same way, a regular
expression as `{}` and a UUID as `<Binary: 16 bytes>`. A class is recognised by the `_bsontype` its
prototype carries, so a document's own field of that name stays data. A bigint or a `Double`
is reached only by a write echoing a typed `_id` the statement sent, and renders as a number (a
bigint past 2^53 as its digits) ([§3.1](#extended-json-in-the-query)).

### 3.3 Sampling-based schema inference, nested to three levels

MongoDB has no fixed schema, so the object surface ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts))
**infers** one: it lists collections (skipping `system.*`, capped at 200), and for each samples the
first **100 documents** to derive field types ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)).
Caveats baked into this approach:
- Fields absent from the sample (or appearing only in unsampled documents) won't show.
- **Subdocuments are expanded into dotted paths**, to `MAX_NESTED_FIELD_DEPTH = 3` counting the top
  level as 1 — so `shipping`, `shipping.city` and `shipping.geo.lat` are all listed, and
  `shipping.geo.deep.tooFar` is not. The container at the boundary is still named, so a reader can
  see that the nesting continues. `shipping.city` is a field name in MQL, and a schema that stopped
  at `shipping: object` did not name it: a plan run on 2026-08-22 grouped by `$shipping.region`, a
  path the database does not have, and MongoDB answers that with one null group rather than an
  error — so the plan read as runnable and was silently wrong.
- **A projection built from this list names only the outermost paths.** The list holds a
  subdocument beside its own children, and MongoDB refuses a projection or `$project` that names
  both: `Path collision at address.city remaining portion city` (measured on `mongo:8.2.12`, where
  Generate Query and the profiler both failed on every collection with a subdocument).
  `outermostFieldPaths()` in [`query-generators.ts`](../../src/lib/query-generators.ts) drops every
  path whose ancestor is listed, so `address`, `address.city` and `address.geo.lat` project as
  `{ "address": 1 }`; `addressBook` is not a child of `address`. Generate Query (shown as Generate
  Find, `generateSelectQuery`) and the profiler's `$project` (`/api/db/profile`) both go through
  it, and the profiler reads a dotted column by walking the sampled document, so `address.city` is
  profiled from its real values rather than as absent. A top-level key that literally contains a
  dot is walked the same way, as a nested path, so it profiles as absent.
- **Generated test data reconstructs nested paths.** Both row menus offer Generate Test Data on a
  collection, because the provider declares `supportsTestDataGeneration: true` ([§9](#9-capabilities--labels)),
  and the dialog writes one `insertMany`. It treats dotted
  inferred columns as nested paths: when `address`, `address.city`, and `address.geo.lat` are
  present, only the leaf fields are generated and the resulting document is rebuilt as
  `{ address: { city, geo: { lat } } }`. A parent path with listed descendants does not receive a
  scalar value. An `object` field with no listed descendants is generated as `{}`.
  The generator is picked by the **leaf** of the path, so `address.city` is a city and
  `address.zip` a postal code rather than two street addresses, and the value takes the JSON type
  the inferred type names: `number`, `int` and `double` as JSON numbers, `boolean` as a boolean,
  `array` as `[]`, `null` as `null`, and `date`, `objectId`, `uuid`, `long` and `decimal` as the
  `$date`, `$oid`, `$uuid`, `$numberLong` and `$numberDecimal` wrappers, which the query reader
  ([§3.1](#extended-json-in-the-query)) turns into those BSON types. A `mixed(...)` field is written as its first non-null type.
  The driver reads both int32 and double as a JS number, so sampling reports `number` for both, and a `number`
  field is written as an integer (BSON int32) unless its leaf name picks a decimal-valued generator such as `price`.
  `_id` is left to the server. Measured on `mongo:7` on 2026-10-06: the generated command ran
  through the provider and `$type` read back `int`, `double`, `long`, `decimal`, `bool`, `array`,
  `date`, `objectId`, `binData` (UUID subtype 4) and `null`.

- **Arrays are named and left closed.** `items.sku` addresses one value *per array entry*, so it
  does not mean on an array what the same syntax means on a subdocument; listing it in a flat field
  list would invite exactly that confusion. Date, ObjectId, Binary, Decimal128 and every other
  BSON class are scalars here and are never descended into (#1423): a `Long` is typed `long`, a
  `Timestamp` `timestamp`, a regular expression `regex`, a UUID `uuid`, and the rest by MongoDB's
  own `$type` alias (`int`, `double`, `javascript`, `symbol`, `minKey`, `maxKey`) or `dbRef`.
  Before #1423 a `Long` and a `Timestamp` were typed `object`, so `big.high`, `big.low`,
  `big.unsigned` and `ts.high` were listed and reached Generate Find, the profiler and the agent's
  inventory.
- **The field list is capped at `MAX_INFERRED_FIELDS = 200` per collection**, applied after the
  sort, so what survives is a deterministic prefix and `_id` always survives. Nesting multiplies:
  60 subdocuments of 10 fields each is 661 rows in the schema tree and 661 lines in an agent run's
  context window, for one collection.
- A field with multiple observed types is reported as `mixed(a|b)`. `_id` is marked primary.
- **Nullable means "absent or `null` in at least one sampled document"** (#1456). MongoDB declares
  no nullability, and a field is empty in two ways, so inference counts in how many sampled
  documents each path is present and marks it nullable when that is fewer than the sample, or when
  a `null` was seen. `_id` follows the same rule: in an ordinary collection it is present and
  non-null in every document, so it reads not nullable, but a collection holding `{_id: null}`, or
  a `$group` view whose `_id` is `null`, reads nullable, because that is what the sample shows.
  Before #1456 only a `null` counted, so a field most documents lack read "Nullable: No" in Docs and
  `NN` in the ERD.
- **The profiler counts the same two cases as null.** In Profile Collection a sampled value that
  is absent or `null` adds to `nullCount`, and `null` is not a distinct value. The samples still
  show an explicit null, as `NULL`. Before #1456 documents `{a: 1}`, `{a: null}`, `{}` reported
  1 null and 2 distinct values for `a`; they now report 2 nulls and 1.

### 3.4 `find` is capped at 100; `aggregate` is not

A `find` with no explicit `options.limit` is capped at **100** documents
([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)). **`aggregate` passes none of
`options` to the cursor** (no `limit`/`skip`) and has no default cap, so a pipeline without a
`$limit` stage can return an unbounded result set.

`prepareQuery()` does **not** modify the query (it injects no limit, and the JSON is passed through unchanged), but it is **not** a true no-op: it returns `limit: options.limit || 100` and `wasLimited: false`, and the `/api/db/query` route builds its pagination metadata from them.
The route computes `hasMore = prepared.wasLimited && rows.length > prepared.limit` (a row past the page came back, #1440), so every MongoDB result answers `hasMore: false` and `wasLimited: false`, and the provider declares `supportsResultPagination: false`, so no Load More is offered.
Measured 2026-09-27 on MongoDB 8.3 through the route: a `find` over 150 documents returned 100 rows with `hasMore: false` and `wasLimited: false`, so a result the 100 cap cut carries no "limited" badge.
The `unlimited` option is **not** honoured; see [Known limitations](#13-known-limitations--future-work).

---

## 4. Connection

`connectionString` is used **directly** (this is a genuine connection-string provider, unlike
SQL Server). `buildConnectionString()` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts))
returns `config.connectionString` if present, else assembles
`mongodb://<user>:<password>@<host>:<port>/<database>[?authSource=<authSource>]` (credentials and
the auth database are URL-encoded; the `<user>:<password>@` segment is omitted when no credentials
are set, and the query string when no `authSource` is).
With no `database` the path is empty, `mongodb://<host>:<port>/`, and not a stand-in such as `/test`: the path database is also the driver's default auth database, so a stand-in would authenticate an `admin` user against it and fail as bad credentials.

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

`validate()` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)) requires either a
`connectionString` or a `host`.
`database` is optional in both modes (#843): it is only the default for a statement that names no database, and every statement the product writes names its own.
`connect()` builds a `MongoClient` whose built-in
pool is configured from `ProviderOptions.pool`:

| `MongoClient` option | Source |
|----------------------|--------|
| `maxPoolSize` | `pool.max` |
| `minPoolSize` | `pool.min` |
| `maxIdleTimeMS` | `pool.idleTimeout` |
| `connectTimeoutMS` | `pool.acquireTimeout` |
| `serverSelectionTimeoutMS` | 30 s, a constant in `mongodb.ts` (`MONGODB_SERVER_SELECTION_TIMEOUT_MS`), not configurable |

The database name comes from `config.database`, else from the connection string's path (after the authority, so `mongodb://host:27017` names none), else
defaults to `test`, the driver's own default; it is the database a statement with no `database` key reads.
After connecting, a `{ ping: 1 }` command validates the connection.

**Server selection is bounded at 30 seconds, and the bound is not connect-only (#1458).**
`serverSelectionTimeoutMS` is a `MongoClient` option, so the driver reads it when the client
connects and again for every query and write for the life of that client
(`mongodb/lib/sdam/topology.js`, `mongodb/lib/operations/execute_operation.js`). It therefore has
to clear a replica set election, not only the initial dial: MongoDB documents the median election
after an unplanned primary loss as up to 12 seconds and notes that network latency can extend it.
This provider used to hand that option `pool.acquireTimeout`, whose default is 60000
([`types.ts`](../../src/lib/db/types.ts)), so Test Connection to a host and port where nothing
listens held the spinner for a minute (`Test Connection` passes `queryTimeout: 10000`, which
`connect()` did not read). Measured here against a closed port on 127.0.0.1: 60.0 s before, 30.0 s
after. `connectTimeoutMS` did not bound it and does not: that option caps ONE TCP attempt, and a
refused connection fails its attempt at once.

30 s is the driver's own default and sits above the election window, so a write issued right after
an unplanned primary loss waits the election out instead of failing at the deadline. It is a
ceiling under abnormal discovery, not a latency budget: a healthy deployment selects a server well
before it, and a closed port used to be reported only after the full 30 s, half the old
minute. The value is a constant in
[`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts) rather than a second pool field,
because it governs the whole client and not only the connect; `connectTimeoutMS` keeps following
`pool.acquireTimeout` for the pool's own dial.

**The connect itself is bounded by the request's `queryTimeout` (#1573).** The 30 s selection
bound above is the client's, and a request that only wants to know whether the server is there
should not wait it out: `connect()` races `MongoClient.connect()` against the `queryTimeout` the
request already carries (10000 for Test Connection, `DEFAULT_QUERY_TIMEOUT` 60000 otherwise,
[`types.ts`](../../src/lib/db/types.ts)), and closes the client when the deadline wins. The
reported error is a `ConnectionError` naming the refusal the driver's monitoring saw (its last
heartbeat failure, read from the `serverHeartbeatFailed` events the client relays), not a generic
timeout. Two details the driver forces:

- With `mongodb+srv`, `MongoClient._connect` resolves the SRV record before it creates the
  topology and never checks `hasBeenClosed` (`mongo_client.js`), so a `close()` that lands during
  a slow DNS lookup is a no-op. The client is closed again once the connect promise settles, so
  no socket outlives the request either way.
- A failed `connect()` closes the client and clears it, rather than leaving `this.client` set
  with `this.db` null: on main the `connect()` guard only checks `this.client && this.db`, so a
  failed ping used to leave the half-open client behind and a later `connect()` returned as if
  it were connected.

Measured against a closed port on 127.0.0.1 with `queryTimeout: 10000`: the refusal
(`connect ECONNREFUSED`) arrives in 10.0 s instead of 30.0. The write path is unchanged: the
30 s client-wide bound still governs every operation after the connect, and no failover was
run to measure it here.

### 4.1 SSL / TLS

`buildTLSOptions()` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)) maps
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
| `tlsCAFile=<path>` alongside TLS | `verify-ca` — the chain is pinned to that CA, and the paste banner points at the CA field for its contents; the two relaxing options above still win |
| a non-boolean value (`tls=maybe`) | nothing; the paste banner quotes the parameter |

`tlsCAFile` stays in the URI, and the driver reads that path on the server when it connects, so in a container the console's `tlsCAFile=global-bundle.pem` fails with `ENOENT` (#842).
A certificate pasted into the CA field wins over it: the driver loads the file only when no `ca` option is set (`options.ca ??=` in mongodb 7.6.0's `mongo_client.js`).

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
([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts)). Reads (`find`/`findOne`/
`aggregate`/`count`/`distinct`) return documents; writes return an acknowledgement summary
(`insertedId`/`modifiedCount`/`deletedCount`, …). `rowCount = rows.length || affectedCount`, and
every returned document passes through `serializeDocument()`. There is no `prepareQuery` limit
injection, no transactions, and no `cancelQuery`. `EXPLAIN` is not supported
(`supportsExplain: false`).

**The result's `fields` (the grid columns, and the columns the CSV, SQL INSERT and DDL exports
write) are the union of the returned documents' keys, first seen first**
([`result-fields.ts`](../../src/lib/db/utils/result-fields.ts)). Documents of one collection need
not share a shape; until 2026-10 the columns were the first document's keys only, so measured on
mongo 8.2.12 a `find` over two differently shaped documents hid every key only the second one
carried from the grid and from those exports (the JSON export kept them). A uniform result still
answers exactly the first document's keys in their order. The union covers top-level keys only:
a subdocument stays one column.

**An empty top-level key is a column named `(No column name)`, and the rows carrying it are keyed under that name.**
BSON carries an empty key: `BSON.deserialize(BSON.serialize({ "": 1 }))` answers `{ "": 1 }` (measured in-process with the bundled driver on 2026-10-07; a live server was not measured).
Keyed by `""`, the grid could not take the column at all, so [`uniquelyKeyedRows`](../../src/lib/db/utils/result-fields.ts) names it through `uniqueFieldNames`, numbered past any key the documents already use (`(No column name) (2)` when one is literally called `(No column name)`).
Every other key, and every document without an empty key, is answered as read.

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

### `endOpenQueryTransaction()` is absent, and which absence it is (D75)

The optional provider surface that ends a transaction a statement left open on the session
`query()` runs on ([`types.ts`](../../src/lib/db/types.ts), implemented on `postgres`, `sqlite`,
`duckdb` and `redis`) is **not implemented here: on the session `query()` runs on,
the engine has no transaction to leave open.**

MongoDB really does have multi-document transactions on a replica set, so this is not an argument
from the engine's name. It is what the driver and this provider make reachable:

- A MongoDB transaction lives on a **`ClientSession`**: `startSession()` creates one,
  `session.startTransaction()` opens the transaction, `session.inTransaction()` is the reading, and
  an operation joins it only when that session is passed in its options (mongodb 7.6.0,
  `mongodb.d.ts`). This provider holds a `MongoClient` and a `Db` and never creates a session, so no
  operation it sends can be inside one.
- `query()` dispatches over the closed `SUPPORTED_OPERATIONS` set — `find`, `findOne`, `aggregate`,
  `count`, `distinct`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`,
  `deleteMany` — and refuses everything else. Measured 2026-09-15 against MongoDB 8 in a replica
  set: `startTransaction`, `commitTransaction`, `abortTransaction`, `runCommand` and `bulkWrite` are
  each refused with *"Unsupported operation: `<name>`"*, so the editor cannot open one at all.
- A transaction open elsewhere is invisible here rather than inherited. In the same run, a separate
  client held an uncommitted `insertOne` inside `session.inTransaction() === true` while this
  provider's `count` answered `0`.

So the surface would have nothing to report, and the absence is a declared boundary rather than a
fallback: the caller shape-checks for the method and this provider does not answer it.

---

## 6. Schema introspection

the object surface answers one object per collection:

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

### The object surface (#789)

The deleted flat reading answered one flat collection list, for the connected database only. The object
surface answers a lazy, per-kind tree across **every** database the connection can see, through four
methods: `listContainers`, `countObjects`, `listObjects` and `describeObject(path, kind)`.

MongoDB is the **first non-SQL engine** in #789 to get one. The four methods and the model are the
shared ones; what is different is that the catalog is a **command** rather than a query, which moves
the seam the contract's hardest rule guards — see [below](#where-the-count-and-the-listing-could-drift).

Everything in this section was measured on 2026-09-11 against a live **MongoDB 8.3.9** holding the
committed fixture, [`docker/mongodb-init/01-object-fixture.js`](../../docker/mongodb-init/01-object-fixture.js).
The recipe that applies it is in [§11](#11-testing), so every claim below can be re-measured rather
than trusted.

#### The declaration

One container level, the database, and two kinds:

| Kind | Role | Read from | Path | Declares `hasSource` |
|---|---|---|---|---|
| `collection` | relation, `acceptsRowWrites` | `listCollections`, every `type` that is not `view` | `[database, collection]` | No |
| `view` | relation | `listCollections`, `type: "view"` | `[database, view]` | Yes, `json` |

The `hasSource` column is [§6 Object source](#object-source-789).

`acceptsRowWrites` on `collection` is the **per-kind** half and is deliberately not conjoined with
this provider's engine-wide `supportsInlineRowEdit: false` ([§9](#9-capabilities--labels)). That flag
is about the results grid's `UPDATE … SET`, which has no MongoDB spelling; an import into a
collection is an ordinary `insertMany`, and so is Generate Test Data, which the engine declares on
its own with `supportsTestDataGeneration: true`. A view carries no such declaration: the server reports
`info.readOnly: true` on every one, on the same call that classifies it.

#### What is not declared, and why each absence is a measurement

- **No `index` kind.** An index name is unique **per collection**, not per database: creating
  `by_thing` on `app.customers` and again on `app.orders` both succeed, and creating it twice on one
  collection is refused with *An existing index has the same name as the requested index*. So the
  catalog does not model an index as a first-class container-level object, which is the test
  standing ruling 4 sets. An index appears in `describeObject`'s output, where it is. The fixture
  creates that duplicate name on purpose, so the reading stays refutable. (sqlite, Cassandra and
  Couchbase are the three engines that do declare the kind, and each earns it the same way.)
- **No routine kind of any shape.** `$function`, `$accumulator`, `$where` and `system.js` are all
  deprecated as of MongoDB 8.0, `mapReduce` since 5.0, and `db.eval` was removed in 4.2. Atlas
  Triggers and Atlas Functions are an **Atlas control-plane** feature, not a server one: the wire
  protocol this provider speaks cannot reach them at all.
- **No kind for an on-demand materialized view.** `$merge` and `$out` write an **ordinary
  collection** carrying no server-side marker of where it came from, so there is nothing to list and
  nothing that could be listed consistently.
- **No separate `timeseries` kind**, and that one is a decision rather than an absence in the engine.
  See the next subsection.

A kind an engine does not have is simply absent, never declared and counted zero: a declared kind
draws a folder, and a folder for something the engine cannot have is a lie the zero badge makes look
like a fact.

#### A time series collection is a collection, and the classifier says so the careful way

`listCollections` answers a **third** value for `type`: beside `collection` and `view` there is
`timeseries`, reported for a collection created with a `timeseries` option. Measured; the fixture
creates `app.readings` precisely so it is in the data.

The classifier is therefore written **"view versus everything else"** and never `type ===
"collection"`. The wrong spelling loses such an object from the **count and the listing at once**, so
the count would still equal the listing while an object a person created was invisible in the tree —
the absence that passes every gate. A test names that case, and the fixture is what makes the test
non-vacuous.

It is counted and listed as a `collection` rather than under a folder of its own because everything
the tree does with a collection it does with this one: it holds documents, `find` reads them,
`listIndexes` answers real indexes (`sensor_1_ts_1` on the fixture's) and `collStats` answers a size
— all measured. MongoDB's own `show collections` lists it beside the others. A third folder would
divide a person's collections by a storage detail.

#### Which databases and which namespaces are excluded

The server's own three databases — `admin`, `config` and `local` — are excluded **by exact name**,
never by prefix. Measured: databases named `configstore`, `localx` and `adminx` are all created
without complaint, so a prefix rule would hide a database a person made. The fixture creates
`configstore` so that spelling stays refuted rather than merely unattractive.

Inside a database, the reserved namespace prefix is **`system.` with the dot**. Measured:
`createCollection("system.mine")` is refused with *not authorized on app to execute command*, while
`systemetrics` is created without complaint. The fixture holds `systemetrics`, so a rule written on
the letters `system` without the dot fails a test by name. The two internal namespaces the fixture's
own listing contains are `system.views` (created the moment a view is) and
`system.buckets.readings` (the bucket collection behind the time series one). `getTableStats()`
applies the same prefix, so Monitoring's Tables list does not show either of them.

`listDatabases` is sent as `{ listDatabases: 1, nameOnly: true, authorizedDatabases: true }`. The
flag is load-bearing rather than tidy: the server's default for it depends on whether the connecting
role holds the cluster-wide `listDatabases` action, so a role granted only `read` on one database
would otherwise be at the mercy of a default this provider never stated. Measured both ways — with
the flag a root role still sees every database and a `read`-on-one role sees exactly its own.

FerretDB does not know the flag. Measured on FerretDB 2.7.0, the command above is refused with code 2
(`BadValue`), reading *authorizedDatabases is an unknown field*, while `{ listDatabases: 1, nameOnly:
true }` is accepted. So when, and only when, the server's own reply is `BadValue` naming
`authorizedDatabases` as an unknown field, the provider sends the command again without it, and the
object tree on FerretDB lists its databases. MongoDB accepts the flag, so it never takes that path and
keeps the least-privilege listing above. Any other refusal, such as code 13 `Unauthorized`, and any
transport failure is raised as it is, without a retry.

#### Where the count and the listing could drift

The rule is that the **listing must contain exactly what the count counted**, and four SQL providers
in this epic failed it on a first pass by letting a second `WHERE` clause drift from the first.

There is no `WHERE` clause here, so the seam moves to the **classifier**. `countObjects` tallies
`listCollections` rows by kind and `listObjects` filters the same rows by kind; written twice, those
two decisions would be free to disagree. `mongoObjectKind()` is the one place the decision is made
and the only reader of both the `type` field and the internal-namespace rule, and all of
`countObjects`, `listObjects` and `describeObject` route through it over rows from one shared
`listCollections` read. There is nothing left for the two answers to differ in.

`countObjects` seeds every declared kind at `{ count: 0 }` before reading rows, so a database holding
no views still draws a Views folder with a 0 badge instead of losing it. A refused read is a third
state, not a zero: a role with `read` on one database answers `listCollections` on any other with
*not authorized on `<db>` to execute command { listCollections: 1 … }*, and that sentence is carried
to the tree verbatim as `{ unavailable }` rather than reported as an empty database. Because both
kinds come from **one** command, a refusal is one fact about the whole database rather than the
per-kind privilege it is on an engine with one catalog table per kind.

#### What `describeObject` answers

The **kind** decides, and nothing reads the name to work out what it is holding: the lookup requires
the catalog row to classify as the kind that was asked for, so `describeObject(["app",
"active_customers"], "collection")` is a miss rather than a view described as a collection.

- **Columns** are inferred from a 100-document sample, exactly as the deleted flat reading inferred them and with
  the same bound ([§3.3](#33-sampling-based-schema-inference-nested-to-three-levels)), because
  MongoDB stores no schema to read. This works on a view exactly as it works on a collection, which
  is why a view is worth listing at all.
- **Indexes** come from `listIndexes` for a collection and are **always `[]` for a view**. That is
  measured, not defensive: `listIndexes` on a view is refused with `CommandNotSupportedOnView` (code
  166), and the indexes its pipeline actually uses belong to the collection underneath it, so
  claiming them here would misattribute them — the same reading [§6](#views-are-listed-and-are-asked-less)
  already applies to the object surface.
- **`foreignKeys`** is always `[]`, because MongoDB has no foreign key constraint at all. The same
  measurement is behind `declaresForeignKeys: false`.

Both kinds this provider declares, `collection` and `view`, declare `hasColumns: true`, so every
object row in the tree expands and none of them abstains; the fields behind that twisty are SAMPLED
from up to 100 documents rather than read from a schema, so they are what the sample happened to
carry and not a declaration the engine holds.

A listed object carries **no `rowCount` and no `sizeBytes`**, and that is a bound rather than a gap:
either would need `collStats` or `estimatedDocumentCount` **per collection**, one round trip each,
and this folder is the one a person opens to see what is there. `describeObject` is where a single
object's detail is paid for.

A view's `options` arrives on the same `listCollections` call that classified it, so the Source tab
below needs no second read. `describeObject` itself renders none of it.

#### What `describeObjects` answers, and the one half this engine cannot bulk-read

`describeObjects(container, kind, limit?)` is the bulk column read (#789): columns and indexes for
every object of one kind in one database. **The two halves of an `ObjectDetail` do not have the
same answer here**, and both answers are measurements, re-measured for this section on a
container this task created and removed, `mongo:latest`, which reports version 8.2.12.

**The columns can be bulk-read, in one aggregate per chunk.** There is no catalog of fields to
read, so the single read samples documents; `$unionWith` samples every collection in ONE pipeline,
one arm each, each arm bounded by the same 100-document limit the single read uses and tagging its
rows with the collection they came from (the chain answers one flat stream, so an untagged arm
would be unattributable). It works on a **view** and on a **time series collection** as readily as
on an ordinary one, measured against the committed fixture.

The chain is **chunked at 100 collections**, because one arm is one pipeline stage and MongoDB
bounds a pipeline's stage count (`internalPipelineLengthLimit`, 1,000 by default): a 5,000-
collection folder would be refused outright as one chain. Round trips grow as the folder divided by
the chunk. The number is measured rather than picked - over a 200-collection database, one 200-arm
aggregate took 81 ms, two 100-arm ones 67 ms and four 50-arm ones 55 ms - and 100 keeps a tenfold
margin under the server's own ceiling.

**The indexes cannot be bulk-read at all, and three separate measurements say so.**

1. `$listCatalog` is the only server-side bulk index listing, and its collectionless form must run
   against `admin` with `{aggregate: 1}`. A role holding `read` on one database - which
   `listCollections`, `listIndexes` and every other read in this surface accept - is refused it:
   `not authorized on admin to execute command { aggregate: 1, pipeline: [ { $listCatalog: {} } ... ] }`.
   Using it would make this one method need a cluster privilege the other four do not.
2. `$listCatalog` also answers the **wrong** indexes for a time series collection. It reports two
   entries for `readings`: `app.readings`, the namespace a person addresses, carrying **no indexes
   at all**, and `app.system.buckets.readings`, carrying `sensor_1_ts_1` under the bucket
   collection's rewritten keys (`meta`, `control.min.ts`, `control.max.ts`). `listIndexes` on the
   collection itself answers the index a person created, `sensor_1_ts_1` over `sensor` and `ts`.
   The single read answers that one, so the bulk read must too.
3. `$indexStats` needs a privilege this surface does not have. It CAN be folded into a `$unionWith`
   sub-pipeline - measured, the server accepts it and answers the arm's index rows, which refutes
   the `$indexStats is only valid as the first stage in a pipeline` reading of it - but a role
   holding `read` on one database is refused it both directly and inside the chain: `not authorized
   on app to execute command { aggregate: "customers", pipeline: [ { $indexStats: {} } ] }`. The
   same role runs `listIndexes` on the same collection without complaint.

So the index reads are **one per described object**, issued in parallel and bounded by the caller's
`limit`. This is the one place in the seventeen providers where a per-object read survives, and it
is still not the N+1 the inventory route removed: that was up to 5,000 **sequential** round trips
over a whole listing. Measured over 200 collections:

| Shape | Round trips | Time |
| --- | --- | --- |
| Sequential fan-out (a loop over `describeObject`) | 400 | 171 ms |
| Parallel fan-out | 400 | 67 ms |
| `$unionWith` samples plus parallel `listIndexes` (this) | 202 | 63 ms |

Through the provider itself against a `bench` database of 200 collections holding 120 documents
each: **108 ms for one `describeObjects` against 422 ms for the 200 `describeObject` calls it
replaces.**

A **view** folder pays none of the index half: a view has no indexes of its own, `listIndexes` on
one is refused with code 166, and nothing is sent. So a view folder's bulk read really is constant
per folder.

**No kind here answers an empty batch for want of columns.** The reference implementation's fourth
guard covers a routine, a trigger or a sequence, and MongoDB declares none. An empty folder still
sends nothing, and no guard is written for it: with no names there are no chunks and no index
reads, so an early return would be a branch no data can reach - a mutation deleting it failed
nothing, which is what dead means.

**One mapper, shared with the single read.** `objectDetailFrom()` builds both. Verified live: for
every object of every kind in `app`, `oddnames` and `configstore`, the bulk read's detail is
byte-identical to `describeObject()` for the same path.

**The bound is the caller's, and there is no `limit + 1`.** That extra row exists to tell a
saturated read from an exact one without a second count, and it is unnecessary here:
`listCollections` answers the whole catalog in one command, so the target set is COMPLETE before
anything is cut and the comparison is exact. The driver's cursor could not be bounded anyway -
`listCollections` takes no limit - so the cut is applied in code after the shared sort, which makes
a bounded read's membership `comparePaths`' rather than the server's. The bound reaches the
expensive half: only the objects that will be returned are sampled and only their indexes are read.

the object surface's silent `.slice(0, 200)` is **not** carried here. That is the reference's first "do
not copy": an unreported bound is the defect `truncated` exists to prevent.

#### Paths are derived, never indexed positionally

The database segment comes from the declared `ContainerLevelSpec` whose id is `schema`, the object's
own name is the last segment, and the expected depth comes from `containerDepth()`. MongoDB declares
one level, so `path[0]` and `container.length !== 1` are behaviour-identical here and silently wrong
on the two-level engines. The suite pins it anyway, by swapping a two-level declaration in through
`getCapabilities` and driving it all the way to the database name the driver was **bound** with,
rather than to a refusal.

The one place a path is constructed rather than read is `listContainers`, which builds `[name]`.

Both listings are **sorted by the path's segments**, never by `JSON.stringify(path)`. That spelling
sorts by the escape sequence rather than by the name, and a MongoDB collection name may hold both a
quote and a backslash: only the null byte and `$` are refused, measured. The fixture's `oddnames`
database holds `x"a`, `x-a` and `x\a` for exactly that reason - by code point they sort `x"a` (0x22),
`x-a` (0x2D), `x\a` (0x5C), and by `JSON.stringify` they sort `x-a`, `x"a`, `x\a`. The server's own
order for them is the JSON one, so a provider sorting the wrong way would pass by inheriting it.

`listDatabases` came back alphabetical in both live measurements and `listCollections` came back in
two **different** orders across two fresh containers holding the same fixture, so ordering is the
provider's own guarantee either way rather than something inherited from the server.

### Object source (#789)

`readObjectSource(path, kind, limit?)` answers one object's definition text.
Everything here was measured on 2026-09-13 against a live **MongoDB 8.2.12** holding the committed
fixture, [`docker/mongodb-init/01-object-fixture.js`](../../docker/mongodb-init/01-object-fixture.js),
applied through the mount by the recipe in [§11](#11-testing).

#### Per kind

| Kind | `hasSource` | Statement | What the text IS | Monaco language |
|---|---|---|---|---|
| `view` | Yes | the `listCollections` call this provider already makes, reading the row's `options` | `form: complete`, `origin: rendered`: the whole definition, printed as JSON **by this product** | `json` |
| `collection` | No | not read | see [the absence](#why-collection-declares-nothing) | not applicable |

There is no second statement and no second round trip: `listCollections` answers the definition on
the same row that classifies the object, so the source read looks at exactly the set `countObjects`
and `listObjects` look at. The driver takes the name as a **value**, so there is no identifier
escaper here and nothing to quote.

`origin` is `rendered` and not `stored`, and that is the honest arm rather than a modest one.
MongoDB stores no statement for a view: `options` is a BSON document, and the JSON a reader sees is
printed by this product. Calling it `stored` would show a reconstruction as an original.

#### The whole `options` document, not two fields of it

The first design of this read rendered `viewOn` and `pipeline` alone. **Measured, that is
incomplete.** A view created with a collation answers `options` carrying `collation` beside the
other two, expanded by the server from the two fields the fixture asked for to ten:

```
db.createCollection("dark_settings", { viewOn: "settings", pipeline: [...], collation: { locale: "tr", strength: 2 } })
```

so the row comes back with `locale`, `caseLevel`, `caseFirst`, `strength`, `numericOrdering`,
`alternate`, `maxVariable`, `normalization`, `backwards` and `version`. Rendering two fields would
drop all of it while still calling the text `complete`. The whole `options` document is rendered
instead, which is also exactly what `createCollection` was given. For an ordinary view `options`
holds `viewOn` and `pipeline` and nothing else, so the common case is unchanged.
`configstore.dark_settings` in the fixture is the view that carries the collation.

#### Extended JSON, because `JSON.stringify` loses a value in silence

A pipeline may hold BSON values, and `JSON.stringify` renders a regular expression as `{}`.
Measured on the fixture's `configstore.dark_settings`, whose pipeline holds `/^th/i` and a date:

| Value | `JSON.stringify` | `BSON.EJSON.stringify`, relaxed |
|---|---|---|
| `/^th/i` | `{}`, the pattern gone with no error anywhere | `{ "$regularExpression": { "pattern": "^th", "options": "i" } }` |
| `new Date("2026-01-01T00:00:00Z")` | `"2026-01-01T00:00:00.000Z"` | `{ "$date": "2026-01-01T00:00:00Z" }` |

So the read uses `BSON.EJSON.stringify` in **relaxed** mode. Relaxed rather than canonical because
canonical prints every integer as `$numberInt`, which would make an ordinary pipeline unreadable to
buy type fidelity a view definition does not turn on. For a pipeline holding no BSON value the two
renderings are byte-identical, which is why `app.active_customers` alone cannot tell them apart and
`configstore.dark_settings` exists.

#### The refusal is per DATABASE, not per object

This is unusual in this fleet and it follows from the read: both kinds come from **one**
`listCollections`, so a caller who cannot run it cannot read any object in that database rather
than this one. Measured with a role holding `read` on `configstore` only, asking `app`:

```
not authorized on app to execute command { listCollections: 1, filter: {}, cursor: {},
nameOnly: false, authorizedCollections: false, lsid: { ... }, $db: "app" }
```

That sentence is carried **unprefixed** into the part's `unavailable`, exactly as `countObjects`
carries it into `{ unavailable }`. The fixture creates the principal, so this is re-runnable rather
than a number in a report:

```bash
# The refusal, and then the control that makes it a fact about privilege rather than the connection
mongosh -u libredb_nolist -p libredb_nolist --authenticationDatabase admin \
  --eval 'db.getSiblingDB("app").getCollectionInfos()'          # not authorized on app
mongosh -u libredb_nolist -p libredb_nolist --authenticationDatabase admin \
  --eval 'db.getSiblingDB("configstore").getCollectionInfos()'  # reads normally
```

The `lsid` in the sentence is the session id and differs per connection, which is why the suite pins
a representative sentence and asserts the provider passes the server's own words through untouched
rather than pinning the UUID. It is not routed through this provider's error mapping, which
would put this product's words in front of the server's.

There is a **second refusal and its sentence is OURS rather than the server's**, declared here
rather than left for a reader to discover. When the read succeeds and the row it answered carries no
`viewOn` and `pipeline`, MongoDB has said nothing there is anything to carry, so the part reads:

```
The listCollections row MongoDB answered for <name> in <database> carries no "viewOn" and
"pipeline", so this <kind> has no definition to show
```

The reduced row that would produce it is real: measured, `listCollections` answers name and type
alone for `{ nameOnly: true, authorizedCollections: true }`, which is how a caller holding
collection-level privileges rather than a database-level `read` sees anything at all. This provider
sends **neither flag**, so on a MongoDB server that arm is unreachable and the integration suite is
what drives it. It exists because a catalog row is a DOCUMENT: a misspelt field name reads as
`undefined` rather than failing to compile, and an unguarded render would put `{}` in a reader's
editor as though it were the definition.

#### A transport failure raises, and is never printed as the engine's refusal

A refusal carries the sentence **the server said**. When nobody answered at all there is no such
sentence, so the read raises a `ConnectionError` naming the object and the database rather than
answering a document. Measured against **mongodb 7.6.0** and MongoDB 8.2.12, from a container
created for the measurement:

| What happened | `error.name` | Prototype chain | Message | Treated as |
|---|---|---|---|---|
| the server refused the command | `MongoServerError` | `MongoServerError < MongoError < Error` | `not authorized on app to execute command { listCollections: 1, ... }` (`code: 13`, `codeName: Unauthorized`) | a refusal part |
| nothing listening on the port | `MongoServerSelectionError` | `MongoServerSelectionError < MongoSystemError < MongoError < Error` | `connect ECONNREFUSED 127.0.0.1:27999` | raises |
| unroutable host | `MongoServerSelectionError` | as above | `Socket 'connect' timed out after 1502ms (connectTimeoutMS: 1500)` | raises |
| client closed underneath the read | `MongoNotConnectedError` | `MongoNotConnectedError < MongoAPIError < MongoDriverError < MongoError < Error` | `Client must be connected before running operations` | raises |

The test is the **name** rather than `instanceof`, because the integration suite replaces the whole
driver module and an `instanceof` against its export would be `instanceof undefined` there. The same
rule is written on the Redis read, which keys on `ReplyError`.

This is scoped to the source read. `countObjects` still reports **any** failed `listCollections` as
`{ unavailable }` on every kind, which is the Phase 1 behaviour of the whole fleet rather than
something measured here; a badge is a weaker surface than an editor pane, and changing it is a
fleet-wide decision rather than one provider's.

#### The language comes from the declaration, and a declaration missing it raises

The part's `language` is `view`'s declared `sourceLanguage` and is never defaulted. A kind that
declared `hasSource` and no `sourceLanguage` would raise here rather than be answered `json`, so a
Source tab can never open in a Monaco mode no declaration asked for.

#### Absence raises

A view simply **not being in the listing** is absence on this engine. There is no error to carry, so
`readObjectSource(["app", "no_such_view"], "view")` raises a `QueryError` naming the segment rather
than answering a refusal part, which would invent an engine sentence that was never said. The kind
decides the match exactly as it does in `describeObject`, so asking for a view by the name of a
collection is a miss rather than a collection rendered as a view.

#### Why `collection` declares nothing

Of the three absences, this is the second: MongoDB publishes something, and this product judges it
is not a definition. A collection's `options` is a **property sheet**, a validator, a capped size or a
time series spec, rather than a definition anybody authored, and measured on 8.2.12 an **ordinary
collection's `options` is `{}`**, so a Source tab on that kind would open on nothing for the common
case. A tab that can never fill is worse than no tab. What a collection's options do carry is
reachable through `describeObject`, which is where an object's properties belong.

---

### Object edit (#789)

This engine is a REFUSAL because it was NOT PROBED, and this section says so rather than implying a measurement.
The one question an editable `view` turns on, whether `collMod` preserves a view's collation when it rewrites the pipeline, was not run in either wave of #789.
This phase declares a kind editable only where a failure cannot lose the object and a success destroys nothing the user was not shown, and an unprobed engine cannot be shown to satisfy either half, so the declaration is withheld rather than guessed.
No kind here declares `acceptsSourceEdits`, and `tests/isolated/object-edit-declarations.test.ts` is what holds that absence and this section together.

## 7. Monitoring & health

Rich, from `admin().serverStatus()`, `db.stats()`, `currentOp`, `$indexStats`, and the profiler.
Every method is wrapped in try/catch. Degradation reports the absence rather than filling it in — see
[§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured).

| Method | Source | Notes |
|--------|--------|-------|
| `getHealth()` | `serverStatus`, `dbStats`, `currentOp`, `system.profile` | connections (**omitted**, never `0`, when the server publishes none, [§7.2](#72-a-connection-count-nobody-published-is-absent-not-zero)), data size (**`dataSize + indexSize`**, the same sum `getOverview()` publishes; **`"N/A"`**, never `"0 B"`, when `db.stats()` answers without either addend, [§7.3](#73-a-database-size-nobody-published-is-absent-not-0-b)), WiredTiger cache-hit % (`"N/A"` when unmeasurable, [§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured)), current ops; slow queries need the profiler (placeholder row if disabled) |
| `getOverview()` | `serverStatus`, `buildInfo`, `dbStats`, `listCollections` | version, uptime, connections (**omitted**, never `0`, on the same two paths as `getHealth()`, [§7.2](#72-a-connection-count-nobody-published-is-absent-not-zero)), database size (**`dataSize + indexSize`**, the database-level sums of the per-collection `collStats.size` and `totalIndexSize` the rows are built from, so a share's numerator and denominator are the same pair; `databaseSizeBytes` **omitted**, never `0`, when either addend is unpublished, [§7.3](#73-a-database-size-nobody-published-is-absent-not-0-b)), collection/index counts. `maxConnections` is `connections.current + connections.available`, or `0` (the repo's spelling of *no limit published*) when the server publishes no headroom |
| `getPerformanceMetrics()` | `serverStatus` (WiredTiger + opcounters) | cache-hit %, **ops/sec** (`query`+`insert`+`update`+`delete` opcounters ÷ uptime — *total operations, not just queries*), buffer-pool % (cache bytes), `deadlocks: 0`. **Every field is optional**: each one is present only if its reading was, and a failed `serverStatus` reports `{}` ([§7.1](#71-what-the-panel-shows-when-the-cache-cannot-be-measured)) |
| `getSlowQueries()` | `system.profile` | per-op time/returned; **`[]` if the profiler isn't enabled** (`db.setProfilingLevel(1)`); sorted by `millis` (slowest) — note `getHealth()`'s slow-query block instead sorts by `ts` (most recent) and emits a placeholder row when disabled |
| `getActiveSessions()` | `currentOp` | opid, ns, lock waits, duration — ⚠️ the **`user` field is populated from `op.client`** (the client `host:port`), **not** an authenticated user |
| `getTableStats()` | `collStats` per collection | row count + data/index/total sizes, `totalIndexSize` carried as the byte figure `indexSizeBytes` and not only as formatted text; a time series collection is **one** row, because the server's internal `system.buckets.<name>` duplicate is skipped rather than summed beside it; every other `system.*` namespace (`system.views` included) is skipped with the same `system.` prefix the object browser uses, so Monitoring lists the same collections the tree does. `systemetrics` does not start with that prefix and stays |
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
needs `HealthInfo.slowQueries` to become optional across all 17 type-ids.)

### 7.3 A database size nobody published is absent, not `0 B`

The byte figure travels the same two paths as the count above and had the same two spellings of a
fabrication. Both outlived the round that fixed the count, one field over in the same object:

- `getOverview()`'s outer catch returned a literal `databaseSizeBytes: 0`. Nothing was read on that
  path - `serverStatus`, `db.stats()`, `buildInfo` and `listCollections` are all inside the same
  `try`, so a user without `clusterMonitor` reaches it - and `DatabaseOverview.databaseSizeBytes` is
  **optional** precisely so that a provider with no byte figure can say so. The key is now omitted;
- both success paths formatted `dbStats.dataSize || 0`, which cannot tell a database that measures
  0 bytes from a `db.stats()` that answered without `dataSize`. Both are now `measuredNumber(...)`:
  absent, the field is omitted and `databaseSize` reads `"N/A"`; measured, a real `0` still formats
  as `"0 B"`. MongoDB's own
  [`dbStats` reference](https://www.mongodb.com/docs/manual/reference/command/dbStats/) documents
  `dataSize` unconditionally - the only output fields it gates are `freeStorageSize`,
  `indexFreeStorageSize` and `totalFreeStorageSize`, on the command's `freeStorage: 1` option - so
  this arm is **not** a deployment measured in this repo; it is the input `|| 0` could not
  distinguish, and the optional field exists to carry it.

**What `getOverview()` publishes is a sum**, `dataSize + indexSize`, and the reason is field parity
rather than a shared unit: `dbStats.dataSize` and `dbStats.indexSize` are documented as the
database-level sums of the collection-level `collStats.size` and `collStats.totalIndexSize`, which
are the two fields `getTableStats()` builds each row from, so the database figure is exactly the sum
of the row figures. That figure is the denominator of every share on the Storage tab and the
numerators carry both measures: a collection's row is `collStats.size + collStats.totalIndexSize`
and the *Indexes* card sums `totalIndexSize`. `dataSize` alone left index bytes in the numerator
only, so on MongoDB 8.2 the *Indexes* card read 1062.8% of the database and a `customers` collection
read 354.7% (#1455). `dbStats.totalSize` is the other candidate and the wrong one: it is
`storageSize + indexSize`, and `storageSize` is the on-disk footprint including pre-allocated space,
so it is not the measure the rows are in. When either addend is unpublished the key is omitted
rather than filled in: a sum of one reading and one guess is not a reading, and `dataSize` alone is
exactly the state the shares were wrong in. `getHealth()`'s `databaseSize` publishes the same sum,
because the admin fleet view prints it per row beside the overview's byte total, and both are one
database's size.

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

`runMaintenance(type, target?, container?)` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts))
maps the generic operations onto MongoDB admin commands:

A `container` is a DATABASE name (#772). The provider is bound to one database and no admin command
can retarget mid-command, so the bound name is accepted and any OTHER name is refused with
`bound to the database "<name>"` rather than quietly acted on against the wrong one. The comparison
uses `getDatabaseName()`, the name `connect()` opened - a connection-string connection sets no
`config.database`, and comparing with that alone refused the bound database itself.

| Type | MongoDB action |
|------|----------------|
| `analyze` | `validate` (one collection, or every collection; views skipped) |
| `vacuum` / `optimize` | `compact` (one collection, or every collection; views skipped) |
| `check` | `dbCheck` (**requires** a collection target) |
| `kill` | `killOp` (**requires** an opid) |
| `reindex` | **unsupported** — returns a message (the `reIndex` command was removed in MongoDB 6.0+) |

Without a target, `validate` and `compact` run on every entry `listCollections()` answers except
views, which the server refuses for both (#1408). A time series collection is attempted, not
dropped: the test is view versus everything else, as in the object tree. A refusal from one
collection is collected rather than ending the run, and the result names it:
`Validated 3 collections; skipped 1 view; failed on 1: users (<server message>)`, with `success`
false whenever anything failed. Before #1408 the first view aborted the validate loop with a 500,
and the compact loop swallowed every error into a bare "Compacted collections".

`getCapabilities().maintenanceOperations = ['vacuum', 'analyze', 'check']` — so the UI surfaces those
three, though `runMaintenance` also accepts `optimize`/`kill`/`reindex` when invoked directly.

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#496).

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

### `getCapabilities()` ([`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `json` |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` — the query language is JSON commands, so there is no `UPDATE ... SET` for the results grid's inline editor to emit |
| `supportsTestDataGeneration` | `true` - a separate fact from the flag above: the Generate Test Data dialog writes one `insertMany` command, which a collection takes ([§3.3](#33-sampling-based-schema-inference-nested-to-three-levels)), so both row menus offer it (#1468) |
| `supportsResultPagination` | `false` — `prepareQuery` pins `offset` to 0 and returns the command untouched, so page two would be page one. The find document's own `limit` stays the bound here (#816) |
| `supportsTransactions` | `false` — multi-document transactions need a client session this provider does not hold, so BEGIN/COMMIT/ROLLBACK and SANDBOX are not offered; they used to be, and answered HTTP 400 (#464) |
| `declaresForeignKeys` | `false` — MongoDB has no foreign key constraint at all, so an empty `foreignKeys` list here is the engine's model and not this database's shape |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['vacuum', 'analyze', 'check']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `27017` |
| `schemaRefreshPattern` | `"operation"\s*:\s*"(insert\|delete\|update)` |
| `containerLevels` | one level, `{ id: 'schema', label: 'Database' }` — the object surface's container ([§6](#the-object-surface-789)) |
| `containerPathShapes` | `exact`: only `[database]` addresses a container, so a shorter or a longer path is refused, by the object routes over HTTP and by this provider for a caller that reaches it directly (#1147) |
| `objectKinds` | `collection` (relation, `acceptsRowWrites`) and `view` (relation). No `index`, no routine kind, no `timeseries` kind; each absence is measured in [§6](#what-is-not-declared-and-why-each-absence-is-a-measurement) |

`schemaRefreshPattern` matches write operations in the JSON query so the UI refreshes collections
after inserts/updates/deletes.

### Labels — overridden (`getLabels()`, [`mongodb.ts`](../../src/lib/db/providers/document/mongodb.ts))

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
(#463); here `getSlowQueries()` reads `system.profile`
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
| A malformed Extended JSON wrapper (`$oid` not 24 hex digits, a `$date` that names no instant, a `$numberLong` outside 64 bits) or a wrapper sharing its object with another key | `QueryError` carrying the path and the reason ([§3.1](#extended-json-in-the-query)) |
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
> would cross-contaminate if they shared one. They never do: `bun run test` gives every test file its
> own bun process, so a single file is safe and so is the whole suite, which is the same command CI
> runs. `bun run test:coverage` is that runner with coverage on. See [`CLAUDE.md`](../../CLAUDE.md).

### Coverage

Validation, connect/disconnect, capabilities, labels, `prepareQuery`, every `query` operation
(find/aggregate/count/distinct/insert/update/delete), column inference, health, maintenance,
overview, performance, slow queries, active sessions, table/index/storage stats, **BSON
serialization** (ObjectId/Binary/Decimal128/Date/nested, and Long/Timestamp/RegExp/UUID with their inferred types, #1423), **Extended JSON input** (the BSON values
every operation hands the driver, asserted on the arguments the mocked collection receives), `getMonitoringData`, and **every `ssl.mode`
branch** asserted against the options object the `MongoClient` constructor received.

### The object-surface fixture

[`docker/mongodb-init/01-object-fixture.js`](../../docker/mongodb-init/01-object-fixture.js) is the
database the object-surface tests reason about, and it is a **committed deliverable** rather than
scaffolding: a live measurement nobody can re-run is not evidence. It is mounted in
[`database-compose.yml`](../../database-compose.yml) at `/docker-entrypoint-initdb.d`, which the
`mongo` image runs through `mongosh` **once, on a fresh data directory only** — an already
initialized container has to be recreated before an edit takes effect.

```bash
# Fresh container with the fixture applied through the mount
docker compose -f database-compose.yml up -d mongodb
docker logs libredb-mongodb 2>&1 | grep 'libredb object fixture applied'

# Or against a container that is already initialized, without recreating it
docker cp docker/mongodb-init/01-object-fixture.js <container>:/tmp/01-object-fixture.js
docker exec <container> mongosh -u <user> -p <password> --quiet --file /tmp/01-object-fixture.js

# What it builds: databases `app`, `configstore` and `oddnames`
#   app.customers, app.orders, app.systemetrics   collections
#   app.readings                                  a TIME SERIES collection (type: "timeseries")
#   app.active_customers                          a view on app.customers
#   by_thing                                      the SAME index name on two collections
#   configstore.settings                          a database whose name starts with "config"
#   configstore.dark_settings                     a view with a collation and BSON in its pipeline
#   libredb_nolist                                a user with `read` on configstore and nothing else
#   oddnames.{x"a, x-a, x\a}                      names that sort differently under JSON escaping
```

Connect the provider against the `app` database. Every object above exists to make one claim about
the engine re-measurable; [§6](#the-object-surface-789) says which claim each one carries.

```bash
bun test tests/integration/db/mongodb-provider.test.ts   # just this file
bun run test                                              # the whole suite, one process per file
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
const objects = await provider.listObjects(container, 'table');
const { details } = await provider.describeObjects(container, 'table');
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
  provider exposes no begin/commit/rollback API, and no statement it accepts can open one, which is
  why `endOpenQueryTransaction()` is absent ([§5](#endopenquerytransaction-is-absent-and-which-absence-it-is-d75)).
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
  17 type-ids.
- **`Binary` values are shown as a placeholder** (`<Binary: N bytes>`), not the raw bytes; a UUID
  (subtype 4) is the exception and is shown as its dashed hex ([§3.2](#32-bson-serialization-for-the-grid)).
- **`findOne` silently ignores `sort`/`skip`/`limit`** (only `projection` is honoured), so it cannot
  be used to fetch "the latest" document by sort.
- **`aggregate` ignores `options.limit`/`skip`** and has no safety cap — only an in-pipeline
  `$limit` bounds the result set (`supportsExternalQueryLimiting: false`, so the route injects none).
- **The active-sessions `user` column shows the client address** (`op.client`, e.g. `host:port`),
  not an authenticated user. *Future:* map from `op.effectiveUsers`/`op.users` (MongoDB 5.0+).
- **`getIndexStats().indexType` only distinguishes `text` vs `btree`** — `hashed`, geospatial
  (`2dsphere`/`2d`), wildcard (`$**`), and clustered indexes are all reported as `btree`.
- **The `unlimited` query option is ignored, and a `find` the 100 cap cut is not marked.** `prepareQuery()` always returns `limit: options.limit || 100` with `wasLimited: false`, so an "unlimited" `find` is still capped at 100 documents.
  The route then answers `hasMore: false` and `wasLimited: false`, so the result strip shows no "limited" badge for a result the cap cut ([§3.4](#34-find-is-capped-at-100-aggregate-is-not)).
- **A folder's columns are SAMPLED, and the sample is bounded per collection.** `describeObjects`
  reads a whole container-and-kind folder in one `$unionWith` chain rather than one call per
  collection, chunked at `SAMPLE_CHUNK_SIZE = 100` collections per pipeline so a wide folder cannot
  outgrow MongoDB's own pipeline-length ceiling. So the round trips grow as the folder divided by
  100, not with it. What the read still cannot tell you is a field no sampled document carried
  ([§6](#6-schema-introspection)).

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
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [SQLite](./sqlite.md) · [Trino](./trino.md) · [Redis](./redis.md)
