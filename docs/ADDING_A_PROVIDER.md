# Adding a Database Provider

> How to add support for a new database to LibreDB Studio, and how to decide whether it needs a
> driver dependency at all. For the architecture this plugs into — the Strategy Pattern, the
> provider hierarchy, the shared interface and base classes — see
> [`DATABASE_PROVIDERS.md`](./DATABASE_PROVIDERS.md). For the per-provider reference index, see
> [`providers/README.md`](./providers/README.md).
>
> The Strategy Pattern keeps provider *logic* self-contained: no route, no shared component and no
> existing provider needs to know your engine exists. It does not remove the integration work. The
> union, the exhaustive UI maps, the factory, the connection-string parser, the query generators and
> the explain registry each carry one entry per provider, and Couchbase touched every one of them.

---

## Prerequisites

Three decisions. The first is the consequential one, which is why it is first.

1. **Does it need a driver at all?** Score the engine against the rubric below. A database with a
   first-class HTTP API can be supported with no dependency at all, and that is worth real effort to
   establish before you start. Twelve shipped type-ids need no driver: SQLite uses the built-in
   `bun:sqlite`/`node:sqlite` via `sqlite-driver.ts`, and the rest reach the engine over HTTP with
   nothing but `fetch`/`node:https`. Couchbase goes over the documented REST endpoints
   ([couchbase.md](./providers/couchbase.md)), ClickHouse over its HTTP interface
   ([clickhouse.md](./providers/clickhouse.md)), Apache Druid over `POST /druid/v2/sql`
   ([druid.md](./providers/druid.md)), Elasticsearch and OpenSearch over their SQL endpoints
   ([elasticsearch.md](./providers/elasticsearch.md) · [opensearch.md](./providers/opensearch.md)),
   Trino over its own client protocol ([trino.md](./providers/trino.md)), libSQL over the
   Hrana protocol, `POST /v2/pipeline` ([libsql.md](./providers/libsql.md)), Prometheus over its
   HTTP API, `/api/v1/*` ([prometheus.md](./providers/prometheus.md)), Qdrant over its REST API
   ([qdrant.md](./providers/qdrant.md)), and InfluxDB and InfluxDB 3 over the v1 `/query` API and
   `/api/v3/query_sql` ([influxdb.md](./providers/influxdb.md) · [influxdb3.md](./providers/influxdb3.md)).
   If it does need one, it will be something like `pg`, `mysql2`, `mongodb`, `ioredis`, `oracledb`,
   `mssql` or `db2-node`.

2. **Which base class?**
   - **SQL databases → extend `SQLBaseProvider`.**
     [`sql-base.ts`](../src/lib/db/providers/sql/sql-base.ts) is pure SQL text helpers keyed off
     `this.type` — identifier and string escaping, `LIMIT` clause building,
     read-only and DDL detection — plus a `prepareQuery()` that applies the shared query limiter.
     None of it touches a pool, a driver or a connection, so **an HTTP transport is no reason to
     avoid it.** A standard-SQL engine reached over HTTP, such as ClickHouse, Apache Druid or Trino,
     should extend it and get all of that for free. Druid is the clearest case of how little is left over:
     double-quoted identifiers and `LIMIT n OFFSET m` are both correct Druid SQL, so
     `escapeIdentifier()` and `buildLimitClause()` are inherited unchanged and `prepareQuery()` is
     the only override — for a single dialect trap, not for the transport.
   - **Non-SQL databases → extend `BaseDatabaseProvider`** directly, like MongoDB and Redis.
   - **Graph databases that speak Cypher over Bolt → extend `GraphBaseProvider`**, which extends
     `BaseDatabaseProvider` and owns the query path; the engine supplies a profile
     ([Adding a graph engine](#adding-a-graph-engine)).
   - The one reason a SQL-speaking provider extends `BaseDatabaseProvider` anyway is a dialect the
     shared helpers cannot express. Couchbase is that case: SQL++ quotes identifiers with doubled
     backticks, which `escapeIdentifier()` produces for no existing type, so it owns its quoting in
     `keyspace.ts`. The cost is that it re-implements `prepareQuery()` to get the limiter back
     ([`index.ts`](../src/lib/db/providers/document/couchbase/index.ts)) — duplication worth
     avoiding if your dialect does fit.

3. **Query language?**
   - `'sql'` → Monaco editor uses SQL mode with autocomplete
   - `'json'` → Monaco editor uses JSON mode with MQL-style autocomplete
   - `'cypher'` → the graph layer's Cypher language, with completion from the schema and the engine's
     policy profile

### Why a driver-free provider is worth the effort

Most databases speak a binary protocol over TCP, and for those the vendor's driver is not optional.
PostgreSQL, MySQL, Oracle (TNS), SQL Server (TDS), MongoDB and Redis (RESP) are all in that
category — a browser could not talk to any of them, and neither can `fetch`.

A minority expose a **first-class HTTP API**. For those the provider needs nothing but the runtime's
own networking, and the saving is concrete rather than aesthetic:

- **No install step to fail.** The Couchbase SDK runs a postinstall that downloads a prebuilt binary
  or compiles from source; in an air-gapped or egress-restricted network that breaks `bun install`.
- **No growth in any distribution channel.** A native module lands in the Docker image, Snap,
  AppImage, Flatpak, deb/rpm, and in the published `@libredb/studio` package.
  For reference, the Couchbase SDK is 64.6 MB unpacked across 3765 files.
- **No supply-chain surface** added, and no N-API compatibility question for the Bun runtime.

The trade is real and worth stating plainly: **you take on the code the driver would have owned.**
Connection pooling, topology discovery, failover and retry are yours to write or to go without. The
Couchbase provider has no failover and no retry, which is acceptable for an editor and would not be
for a high-throughput application.

---

### Does it need a driver at all?

Score a candidate before writing code. Each criterion you fail becomes code you hand-write.

| # | Question | Why it matters |
|---|----------|----------------|
| 1 | **Is HTTP a first-class interface?** Do the vendor's own tools use it, or is it a bolt-on? | A bolt-on API lags the real protocol and loses features |
| 2 | **Is the query language SQL-shaped?** | `queryLanguage: "sql"` gives Monaco highlighting, the `sql` tab type and saved queries at no cost. The shared query limiter is separate — it comes from `SQLBaseProvider.prepareQuery()`, or you override `prepareQuery()` yourself; the base class default is a pass-through |
| 3 | **Is there catalog introspection over the same surface?** | Otherwise the object surface has nothing to read |
| 4 | **Is there monitoring data over the same surface?** | Decides how much of the monitoring panel is real rather than honestly empty |
| 5 | **Is there an EXPLAIN?** | Decides `supportsExplain` and whether a strategy is needed |
| 6 | **How complex is auth?** | Basic auth is three lines. SigV4, OAuth2 refresh or Kerberos is a library — and that is usually where the no-dependency promise ends |
| 7 | **Does the data model map onto containers, kinds and objects, and is an outer container level alone a real address?** | The object surface addresses an object by a path of segments, so a hierarchy is declared through `containerLevels` and `objectKinds` rather than flattened into a display name. Then choose `containerPathShapes` and declare it in `getCapabilities()`: `exact` when only the declared depth is an address (a PostgreSQL schema, a MongoDB database), `prefixes` when the outer levels alone are one too (a Trino catalog with no schema, a Couchbase bucket with no scope). An absent field reads as `exact`, and the provider's own check and the HTTP object routes both refuse by that one declaration through `acceptedContainerShapes()` in `src/lib/db/object-kinds.ts` |

A good sanity check for criterion 1: **can a browser talk to it?** Couchbase's own Web Console and
the Capella UI are browser applications, so every service had to be reachable over HTTP for the
vendor's own product to work at all. That is the strongest available evidence the API is first-class
rather than an afterthought.

---

## Driver-free providers: the transport seam

Provider logic must never call `fetch` directly. It goes through an interface with a single
implementation, so that adopting a native driver later is an additive change rather than a rewrite.
See `CouchbaseTransport`
([`transport.ts`](../src/lib/db/providers/document/couchbase/transport.ts)):

```ts
interface XTransport {
  readonly kind: "http" | "native";   // widen as implementations appear

  query(stmt: string, o?: QueryOpts): Promise<XQueryResult>;
  manage<T>(path: string): Promise<T>;
  close(): Promise<void>;
}
```

**Send the requests through the shared REST transport.**
A new provider that speaks HTTP builds the HTTP side of its transport seam on `createNodeTransport` in [`node-transport.ts`](../src/lib/db/http/node-transport.ts), so the provider's own transport file is a thin adapter.
It dials through `node:http` or `node:https` with one keep-alive Agent per connection, `maxSockets` set to the provider's in-flight bound and an idle socket closed after 4 s (below a server keep-alive such as Qdrant's 5 s, #1419), so no proxy variable can route a request, no redirect is followed, a request whose answer was lost is never sent again, and an answer stops at the byte cap the provider passes.
It maps the SSL / TLS panel through `nodeTlsMaterial`, the one TLS mapping a new provider takes, and checks the certificate against the far end of an SSH tunnel rather than the local forward.
With `DB_HTTP_BLOCK_PRIVATE_HOSTS` on, the egress guard's lookup runs on that Agent, so pooled sockets stay guarded.
The older HTTP providers keep their own transports until D37 in [`BACKLOG.md`](BACKLOG.md) moves them.

**Send gRPC calls through the shared gRPC transport.**
A new provider that speaks gRPC opens its channel with `openGrpcChannel` in [`channel.ts`](../src/lib/db/grpc/channel.ts) and reads its SSL / TLS panel with `readGrpcTlsPanel` and `grpcTlsIdentity` in [`tls.ts`](../src/lib/db/grpc/tls.ts), so its adapter holds only its RPC table, descriptor, metadata and error mapping.
It imports neither `@grpc/grpc-js` nor a TLS mapping of its own, and it adds its row to `tests/helpers/grpc-seam-holdings.ts`, which `tests/unit/db/grpc/seam-guard.test.ts` reads.

**Make the result type neutral, not the wire envelope.** An interface shaped like the HTTP response
(`{ results, signature, status, metrics, errors }`) would force any future driver adapter to
fabricate fields that only the REST API produces naturally. Define the shape both sources could
produce without inventing anything (`CouchbaseQueryResult` in
[`transport.ts`](../src/lib/db/providers/document/couchbase/transport.ts)):

```ts
interface XQueryResult {
  rows: unknown[];               // a wire row is not always an object - see the traps below
  fieldNames: string[] | null;   // null when the source cannot describe the rows
  executionTimeMs: number;
  mutationCount: number;
  warnings: XWarning[];
}
```

`rows` is `unknown[]` because a wire row is genuinely not always an object: `SELECT RAW` and
`SELECT VALUE` style projections return scalars, arrays or `null`. The provider narrows it to
`Record<string, unknown>[]` when it builds its `QueryResult`. The Couchbase transport currently
declares the narrower type and casts, which is unsound in exactly this way — the provider's
`normalizeRow()` is what makes it safe in practice, and tightening the declaration is a known
follow-up.

Errors follow the same rule: the transport throws one normalized error carrying a numeric code, so
the provider switches on a code instead of sniffing message strings.

**Carry what the source declares into the shared result.** `QueryResult` has two optional channels
for exactly this (issue #273): `warnings` for notices the engine attached to a statement it completed
— including a success that admits part of the data was unreachable — and `columnTypes` for the
declared type per column, keyed by its name in `fields`. If your source knows either, map it in
`toQueryResult()` instead of dropping it at the seam. **Absence is the signal** in both cases: omit
the field rather than sending an empty array or `{}`, so the UI never renders an affordance for
nothing.

**Guard the seam with a test.** The boundary is only worth something if it holds. Assert that the
wire-envelope identifiers appear in the transport file and nowhere else in the provider directory —
see `tests/unit/db/couchbase/seam-guard.test.ts`. Without that, the envelope leaks one field at a
time and the "one new file" estimate for a future adapter quietly stops being true.

**Normalize at the provider boundary, not in the transport,** when the raw payload has a second
consumer. Couchbase's `INFER` returns its payload as `rows[0]` and introspection reads that array
directly; reshaping rows inside the transport would have broken schema loading. The provider's
`toQueryResult()` normalizes instead.

---

## Adding a graph engine

A graph engine that speaks Cypher over Bolt joins the shared graph layer, [`src/lib/db/graph/`](../src/lib/db/graph/), instead of writing a provider from `BaseDatabaseProvider` up.
Neo4j is the one engine on it today ([neo4j.md](./providers/neo4j.md)); the layer was designed from Neo4j 5.26 and a probe of Memgraph 3.13.1, and a second engine is expected to find what that probe did not.

**The layers, and which way they may import.**

| Layer | Files | Runs | May import |
|---|---|---|---|
| Graph core | `cypher/` (lexer, statements, quoting, read policy, generators), `objects.ts`, `values.ts`, `profile.ts` | server and browser | nothing of `bolt/`, `graph-base-provider.ts` or `src/lib/db/providers/`, and no `node:` module |
| Bolt transport | `bolt/client.ts` (the `GraphClient` seam), `bolt/uri.ts`, `bolt/bolt-client.ts`, `bolt/record-values.ts` | server | the driver, in `bolt-client.ts` and `record-values.ts` only |
| Provider base | `graph-base-provider.ts` | server | the core and the transport |
| Engine | `src/lib/db/providers/graph/<type-id>/` | server, except its policy profile | the layer, never another provider |

`tests/unit/db/graph/seam-guard.test.ts` holds the direction and the driver members `bolt-client.ts` may call.

**`GraphBaseProvider`** implements the query path, the object surface, the cancel, health and the maintenance refusal: every statement passes the read policy, then the engine's statement gate, then one `GraphClient.run` in a READ session on the connection's one database, bounded by `DEFAULT_QUERY_LIMIT` rows and the query timeout, and a cancel aborts the run, which closes its session.
It leaves abstract `getCapabilities`, `getLabels` and the seven monitoring reads, so an engine provider is declarations, a profile and monitoring, as `src/lib/db/providers/graph/neo4j/index.ts` is.

**`GraphEngineProfile`** is what an engine supplies, and its four hooks are the four places where the Memgraph probe measured an engine differing from Neo4j:

| Hook | What it decides | Neo4j's answer |
|---|---|---|
| `readPolicy` | The denied words and namespaces, the allowlisted procedures, qualified functions and SHOW forms, and the refused prefixes the shared policy reads | `NEO4J_POLICY_PROFILE` in `neo4j/profile.ts`, pure, so the editor reads it too |
| `dialect` | Whether a `CYPHER <n>` prefix exists, and the offset keyword generators write | the prefix exists; `SKIP` |
| `statementGate` | The server's own classification of a statement the policy allowed, or none | `EXPLAIN` and `summary.queryType`, in `neo4j/statement-gate.ts` |
| `catalog` | The home database and the statements that list each kind, the properties and the indexes | `neo4j/catalog.ts` |

Beside them the profile carries `engineLabel`, `defaultPort` and `mapError`, the engine's error table.
Two seams the probe measured are deliberately not hooks: READ-mode enforcement and cancellation.
The transport has one execution strategy, an auto-commit `session.run` in a READ session that a closed session cancels, and Memgraph enforces READ mode only in an explicit transaction and stops a statement only on its timeout or `TERMINATE TRANSACTIONS <id>`.
So an engine that needs another strategy adds it to the Bolt transport in its own PR, and the profile gains a field then; it edits nothing under `src/lib/db/providers/graph/neo4j/`.
The Memgraph provider is filed as `docs/BACKLOG.md` D141.

**What a graph engine still registers** is the same as any engine (Steps 1 to 4): its type-id, its `DB_UI_CONFIG` entry, its factory case, and every record the checklist below names.
`queryLanguage: "cypher"` already has its readers, the editor language and the completion; a policy profile is looked up for the editor by type-id in `src/lib/db/graph-policy-profiles.ts`.

---

## Step 1: Register the Database Type

### 1.1 — Add to `DatabaseType` union

**File:** `src/lib/types.ts`

```typescript
// Before:
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'libsql' | 'duckdb' | 'mongodb' | 'redis' | 'oracle' | 'db2' | 'mssql' | 'libredb' | 'couchbase' | 'clickhouse' | 'druid' | 'elasticsearch' | 'opensearch' | 'trino' | 'cassandra' | 'prometheus' | 'kafka' | 'etcd' | 'neo4j' | 'milvus' | 'qdrant' | 'influxdb' | 'influxdb3' | 'oxia';

// After (example: adding CockroachDB):
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'libsql' | 'duckdb' | 'mongodb' | 'redis' | 'oracle' | 'db2' | 'mssql' | 'libredb' | 'couchbase' | 'clickhouse' | 'druid' | 'elasticsearch' | 'opensearch' | 'trino' | 'cassandra' | 'prometheus' | 'kafka' | 'etcd' | 'neo4j' | 'milvus' | 'qdrant' | 'influxdb' | 'influxdb3' | 'oxia' | 'cockroachdb';
```

A type-id may contain a digit: `db2` does.
A test or a script that parses type-ids out of source text matches them with `[a-z0-9]+`, never `[a-z]+`, or it reads `db2` as `db` and passes for the wrong reason.

### 1.2 — Add to `QueryTab.type` if needed

**File:** `src/lib/types.ts`

If your database uses a new editor mode (not `'sql'` or `'mongodb'`), add it:

```typescript
export interface QueryTab {
  // ...
  type: 'sql' | 'mongodb' | 'redis' | 'libredb' | 'promql' | 'kafka' | 'etcd' | 'cypher' | 'milvus' | 'qdrant' | 'influxql' | 'oxia';  // Add your type here if needed
}
```

For most SQL databases, the existing `'sql'` type is sufficient. You only need a new tab type if your database uses a fundamentally different query language.

A new tab type is reached one of two ways, and both are wired in `src/lib/editor/tab-language.ts` and its neighbours.
A language that is a kind of JSON declares a `queryDialect` on the provider and gets a record in `QUERY_DIALECTS` (`src/lib/db/query-dialects.ts`), whose `tabType` `resolveTabType()` reads **before** the `queryLanguage === 'json'` rung; skipping the dialect leaves the tab typed `mongodb`, which is exactly what #427 fixed.
A language that is neither SQL nor JSON widens `ProviderCapabilities.queryLanguage` instead, as PromQL did (#1085), and every reader of that union then needs an explicit arm or a test pinning that its branch is right, because a reader written `=== 'json'` sends the new member into its SQL branch and one written `!== 'sql'` into its JSON branch.
Either way the type gets a record in `DIALECT_EDITORS` (`src/lib/editor/dialect-editors.ts`), its Monaco language for `editorLanguageForTabType()` and its formatter, if any, for `QueryEditor`'s Format button, and that language module is registered in `QueryEditor`'s `handleBeforeMount` alongside `registerLibreDBLanguage`, `registerRedisLanguage`, `registerPromqlLanguage`, `registerEtcdLanguage`, `registerOxiaLanguage` and `registerCypherLanguage`.
A JSON kind may instead render in Monaco's built-in `json` mode and register no module, as Kafka's read request does (#1088).
Then the MongoDB completion provider `QueryEditor` registers for `json` must stay off it: it registers only where the declared capabilities name no JSON dialect, so its MongoDB snippets and column completions never reach a tab whose parser refuses them.

## Step 2: Create the Provider Class

Create the file under the right family folder, named by the canonical **type-id** —
`src/lib/db/providers/sql/<type-id>.ts` for SQL, `src/lib/db/providers/<family>/<type-id>.ts`
(e.g. `document/`, `keyvalue/`) for non-SQL.

**Start from the closest existing provider — it is the authoritative, code-verified template** (and
is kept in sync with its per-provider doc). Don't copy a skeleton from this guide; copy a real file:

| Your database is… | Extend | Copy as template | Reference |
|-------------------|--------|------------------|-----------|
| Pooled SQL (wire-protocol DB) | `SQLBaseProvider` | `postgres.ts` / `mysql.ts` | [postgres.md](./providers/postgres.md) · [mysql.md](./providers/mysql.md) |
| Embedded / file SQL | `SQLBaseProvider` | `sqlite.ts` | [sqlite.md](./providers/sqlite.md) |
| SQL database reached over HTTP (no driver) | `SQLBaseProvider` | `sql/clickhouse/`, `sql/druid/` or `sql/trino/` | [clickhouse.md](./providers/clickhouse.md) · [druid.md](./providers/druid.md) · [trino.md](./providers/trino.md) |
| SQL over HTTP where a **second product** speaks the same protocol | `SQLBaseProvider` | `sql/search/` (two ids, one module) or `sql/trino/` (one id, a dialect descriptor ready for the second) | [elasticsearch.md](./providers/elasticsearch.md) · [trino.md](./providers/trino.md) |
| Document store | `BaseDatabaseProvider` | `mongodb.ts` | [mongodb.md](./providers/mongodb.md) |
| Document store reached over HTTP/REST (no driver) | `BaseDatabaseProvider` | `document/couchbase/` | [couchbase.md](./providers/couchbase.md) |
| Key-value store | `BaseDatabaseProvider` | `redis.ts` | [redis.md](./providers/redis.md) |
| Embedded (in-process, no wire protocol) | `BaseDatabaseProvider` | `embedded/libredb.ts` | [libredb.md](./providers/libredb.md) |
| Graph database speaking Cypher over Bolt | `GraphBaseProvider` | `graph/neo4j/` | [neo4j.md](./providers/neo4j.md) |

**Implement the abstract methods** from the `DatabaseProvider` interface: `connect`, `disconnect`,
`query`, the five REQUIRED object methods (`listContainers`, `countObjects`, `listObjects`,
`describeObject`, `describeObjects`), `getHealth`, `runMaintenance`, plus the monitoring set (`getOverview`,
`getPerformanceMetrics`, `getSlowQueries`, `getActiveSessions`, `getTableStats`, `getIndexStats`,
`getStorageStats`). None of those can be omitted, but a method whose data your engine does not expose returns
a neutral value rather than throwing. Mind the return types: the list-valued ones
(`getSlowQueries`, `getActiveSessions`, `getTableStats`, `getIndexStats`, `getStorageStats`) return
`[]`, while `getOverview()` and `getPerformanceMetrics()` return DTOs and need a zeroed object.
`libredb.ts` is the reference for doing this honestly.

The sixth object method is the one exception to both halves of that sentence, and the next section
is about it: it is declared optional on the interface, it IS omitted by a provider whose engine
publishes no definition text, and a neutral value is the one thing it must never answer.

### `readObjectSource`: the sixth object method (#789)

This one is paired with a DECLARATION, which is what makes it different from the other five, and the
pairing is enforced. A kind offers a Source tab only if its `ObjectKindSpec` sets `hasSource: true`,
and a kind that sets it must also set `sourceLanguage`. Read the refusals off the declaration and
never off the kind id.

**It is OPTIONAL, and omitting it entirely is the right answer for an engine that publishes no
definition text.** `readObjectSource?` is declared optional on `DatabaseProvider` in
`src/lib/db/types.ts` for that reason: a provider with no source-bearing kind can never reach the
method, so requiring it would put an unreachable throw in each. Five shipped providers are exactly
that case and say so in their own docs, `druid`, `influxdb`, `influxdb3`, `libredb` and `neo4j`. If
yours is a sixth, declare `hasSource` on no kind, write no method, and add your type-id to the
committed ABSTAINER list in `tests/isolated/object-source-declarations.test.ts` beside those five.
Do NOT write the method answering an empty document, an empty string or any other neutral value: the
pairing fails by name on a method with no source-bearing kind, and an empty text is a RAISE
everywhere in the table below.

- **`hasSource: true`** on each kind whose definition text your engine really publishes. A kind
  whose text the engine does not hold simply does not set it, and the row then offers no View
  Source at all, which is the correct answer rather than a failure to read.
- **`sourceLanguage`** is a Monaco language id, handed straight to the editor as the model's
  language. Monaco does NOT raise on an id it never registered: it falls back to plain text, so a
  wrong id ships a Source tab that is simply not highlighted and nothing goes red. `plsql`, `tsql`
  and `cql` are not registered by the installed bundle, which is why Oracle, SQL Server and
  Cassandra all declare `sql`.
- **No fallback literal in the method.** A kind that declares `hasSource` and no `sourceLanguage`
  RAISES a `QueryError` naming the kind, before any round trip. Every provider that reads source
  does this, and the two that once wrote `?? "sql"` and `?? "lua"` were corrected: a literal there
  hides a deleted declaration behind a tab that has quietly stopped highlighting.
- **Check the path shape**, with the same function and the same sentence `describeObject` uses. The
  HTTP route bounds an empty path, but the method is published through `@libredb/studio` and is
  called by the embedded host seam and by the conformance helper, none of which sees the route.

**A REFUSAL and an ABSENCE are different answers and must not arrive as one.** This is the rule the
whole surface is built on:

| The engine… | The answer | Why |
|---|---|---|
| declined the read, and said so | a PART carrying `unavailable`, holding the engine's own sentence **unprefixed** and with no `text` | the reader needs the server's words to act on. A part is never both `unavailable` and `text` |
| holds no such object | RAISE a `QueryError` naming the object | a document invented for a dropped object is a claim the engine never made |
| answered nothing, or an empty text | RAISE | an empty text puts an empty editor over a definition nobody read, which is the shape this contract exists to make unrepresentable |
| never answered at all (a dropped socket, a timeout) | RAISE a `ConnectionError` | nobody answering is not the server answering "no", and a transport message rendered as this object's refusal is a symptom presented as a fact |

Emptiness is sometimes absence itself: measured on Redis 8.10.0,
`FUNCTION LIST LIBRARYNAME no_such_library WITHCODE` answers an empty array rather than an error, so
whatever reads it has to treat emptiness as the absence and raise.

**Every part carries `origin` and `form`, and both are facts about the TEXT rather than decoration:**

- `origin` is `stored` when the bytes are the author's own, as the engine kept them, and
  `regenerated` when the engine composed the statement from its catalog. Oracle's
  `DBMS_METADATA.GET_DDL` is `regenerated`; SQLite's `sqlite_schema.sql` is `stored`. Say which in
  the provider doc, with the measurement.
- `form` is `complete` when the text runs as given, and `partial` when it does not: a body without
  the `CREATE` statement around it, a bare SELECT, or a text the provider had to cut (the Db2
  provider marks a definition longer than 32672 bytes `partial`). A caller that pastes a `partial`
  text into an editor and runs it gets a syntax error, so the two must not be conflated. The type is
  `ObjectSourceForm` in `src/lib/db/types.ts`.

**The two isolated tests a new provider must satisfy**, neither of which any provider suite can
stand in for, because both read the WHOLE fleet at once:

- `tests/isolated/object-source-declarations.test.ts`, the census. THREE things move per new
  type-id, and the third is the one a contributor misses: add one row to `SOURCE_DECLARATIONS`,
  transcribed from what the engine publishes and not from your build; move the three committed
  totals; and, if your engine declares no source-bearing kind, add the type-id to
  `CENSUS_ABSTAINERS` as well. That list is asserted whole, so a new abstainer missing from it
  fails the population assertion rather than the declaration one. The file also pins the PAIRING: a
  type-id declares source-bearing kinds if and only if its built provider implements
  `readObjectSource`, so a declaration with no method and a method with no declaration each fail by
  name.
- `tests/isolated/monaco-language-ids.test.ts`, where every declared `sourceLanguage` is checked
  against the ids the INSTALLED editor bundle registers, extracted from the bundle rather than typed.

**Override the metadata hooks** so the shared UI renders correctly:

- `getCapabilities()` — query language (`sql` | `json`), `defaultPort`, supported `maintenanceOperations`, the `supportsExplain`/`supportsConnectionString`/`supportsCreateTable` flags, and `schemaRefreshPattern`.
- `getLabels()` — only if the generic SQL wording ("Table" / "row" / "Select Top 50" / …) doesn't fit. Non-relational providers relabel it (Redis → "Key Pattern"/"key", MongoDB → "Collection"/"document").
- `prepareQuery()` — only if your dialect needs non-standard pagination. SQL `LIMIT` injection is inherited from `SQLBaseProvider`; Oracle/SQL Server override it for `FETCH FIRST` / `TOP`; the non-SQL providers make it a metadata-only pass-through.

Wrap native driver errors with `mapDatabaseError(err, '<type-id>', query)` — the 3rd argument is the
raw query string (SQL **or** JSON, per `src/lib/db/errors.ts`) — so they normalise onto the shared
error classes. For the exact DTO shapes see [Reference: Interface Contracts](#reference-interface-contracts);
for worked, code-verified examples see each provider's **Design decisions** section in
[`docs/providers/`](./providers/README.md).


### A per-entity maintenance operation with a preview

An operation that runs on one object, and that an admin should see described before it runs, is declared rather than coded into a surface.

- Add it to `maintenanceOperations`, and give it a `maintenanceOperationSpecs` entry with `perEntity: true` and `global: false`.
  An operation outside the six of `MaintenanceType` then gets a control of its own on the Operations tab, the monitoring Tables tab and both row menus, after their own controls, in declaration order, under the spec's `label` and a generic icon; `declaredEntityOperations()` in `src/lib/db/types.ts` is its one reader.
- `confirmation: "typed-target"` makes that control ask for the object's own name, typed exactly and case-sensitively, before it sends anything.
  `tests/unit/db/maintenance-confirmation-capability.test.ts` holds such a spec to `perEntity: true` and `global: false`.
- `preview: true` makes the control's dialog read `POST /api/db/maintenance/preview` and show the answer before it offers the confirm button.
  `tests/unit/db/maintenance-confirmation-capability.test.ts` holds such a spec to `perEntity: true` and the provider to implementing `previewMaintenance`.
  Implement `previewMaintenance(type, path)` with it: `path` is the object's address, container levels then the object; the method reads only, checks that the object exists, raises a `QueryError` naming what is missing, and answers a `MaintenancePreview` whose `refusal`, when set, withholds the confirm button.
- Implement `engineUser()` when the engine has a principal to name: the maintenance route writes it on every audit row, as `engine_user` on the stdout line, so it is a user name and never any part of a secret.

`tests/unit/db/maintenance-surface-census.test.ts` pins what every shipped provider offers today, and that only Milvus declares any of this; a provider that adds such an operation updates its row there in the same change.

### What the base class gives you for free

| Method | What it does |
|--------|-------------|
| `isConnected()` | Returns `this.state.connected` |
| `getMonitoringData()` | Orchestrates `getOverview`, `getPerformanceMetrics`, etc. |
| `validate()` | Checks that `config.type` and `config.id` exist |
| `ensureConnected()` | Throws if not connected |
| `trackQuery()` | Increments/decrements active query counter |
| `measureExecution()` | Wraps a function and returns `{ result, executionTime }` |
| `mapError()` | Converts unknown errors to typed `DatabaseError` |
| `setConnected()` | Updates connection state |

### What SQLBaseProvider adds (SQL databases only)

| Method | What it does |
|--------|-------------|
| `escapeIdentifier()` | `"table_name"` (PostgreSQL/SQLite) or `` `table_name` `` (MySQL) |
| `buildLimitClause()` | `LIMIT 50 OFFSET 10` |
| `getDefaultSchema()` | A `switch (this.type)` over postgres, mysql, oracle and mssql; every other type-id answers `""` unless its provider overrides it, so a provider whose default schema matters overrides it or never relies on it |
| `shouldEnableSSL()` | Auto-detects cloud providers |
| `prepareQuery()` | Automatically injects LIMIT into SELECT queries |

Not in the list: a placeholder helper. `SQLBaseProvider` no longer has one (#304 removed it).

### Positional placeholders (shared module, not inherited)

| Function | What it does |
|----------|-------------|
| `positionalPlaceholder()` ([`src/lib/sql/values.ts`](../src/lib/sql/values.ts), not inherited) | `$1` (PostgreSQL, Couchbase), `?` (MySQL, SQLite, Druid), `:1` (Oracle), `@p1` (SQL Server), `null` where the engine has no positional form |

## Step 3: Register in the Factory

**File:** `src/lib/db/factory.ts`

Add a `case` to the `switch` statement:

```typescript
export async function createDatabaseProvider(
  connection: DatabaseConnection,
  options: ProviderOptions = {}
): Promise<DatabaseProvider> {
  switch (connection.type) {
    // ... existing cases ...

    case 'cockroachdb': {
      const { CockroachDBProvider } = await import('./providers/sql/cockroachdb');
      return new CockroachDBProvider(connection, options);
    }

    // ...
  }
}
```

> **Important:** Use dynamic `import()` to keep the initial bundle small.

## Step 4: Add UI Configuration

**File:** `src/lib/db-ui-config.ts`

Add an entry to `DB_UI_CONFIG`:

```typescript
import { /* existing imports */, Hexagon } from 'lucide-react';

const DB_UI_CONFIG: Record<DatabaseType, DatabaseUIConfig> = {
  // ... existing entries ...

  cockroachdb: {
    icon: Hexagon,                          // Pick a Lucide icon
    color: 'text-indigo-400',               // Tailwind color class
    label: 'CockroachDB',                   // Display name in ConnectionModal
    defaultPort: '26257',                   // Default port for host/port form
    showConnectionStringToggle: true,        // Show "Connection String" tab in modal
    connectionFields: ['host', 'port', 'user', 'password', 'database', 'connectionString'],
  },
};
```

Then add the type to the selectable list that drives the ConnectionModal picker:

**File:** `src/hooks/use-connection-form.ts`

```typescript
// Append to the existing list - do not retype it, or you will drop a provider from the picker.
const selectableTypes: DatabaseType[] = [
  'postgres', 'mysql', 'sqlite', 'oracle', 'mssql', 'mongodb', 'couchbase', 'redis', 'libredb',
  'clickhouse', 'druid', 'elasticsearch', 'opensearch', 'trino', 'cassandra', 'libsql', 'duckdb',
  'cockroachdb',
];
```

That's it. The ConnectionModal reads `getDBConfig(type)` for everything else — port, form fields, connection string toggle — automatically.

Two optional declarations on the same entry change what the dialog does with the Host box and the credential.
`hostAcceptsUri: ["http", "https"]` lets a user paste a whole address such as `https://host:443` into Host, for an engine whose own documentation writes its endpoint that way.
The dialog splits it into Host and Port, keeps an explicit port such as 443 or 80 as typed, takes 80 or 443 when the address names none, and never lowers the SSL mode: `https://` raises a disabled mode to `verify-system`.
An address with a user name or password, a path, a query string or a fragment is refused, naming the part to remove.
The connection-string box is a different reader and keeps reading `http://` and `https://` as ClickHouse, so the provider doc points users to the Host box.
The provider still validates the host and port with `validateHost` and `validatePort` when it connects.
Credential warnings are declared as the type's row of `CREDENTIAL_WARNINGS` in `src/lib/db/credential-warnings.ts`, a module with no React or Node import, and every entry's `credentialWarnings` reads that row by reference, so the dialog and the seed loader read one record and the entry itself declares nothing.
An entry is a `pair` (a published default user and password), a `jwt` (a token that declares no expiry, manage access, or no access claim) or `no-secret` (the engine accepts a connection with no secret).
The dialog draws a `pair` or `jwt` warning beside the password before Test Connection, and blocks nothing.
The seed loader refuses a `readOnly: true` seed whose literal credential matches a `pair` entry, or that has no password where the type declares `no-secret`, and the provider runs `readOnlySeedRefusal` on a seed connection once its references resolve, before it dials.
Add a test that the real record declares each entry you add.

## Step 5: Install the Driver

```bash
bun add <driver-package>

# Examples:
# bun add pg                  (PostgreSQL, CockroachDB)
# bun add mysql2              (MySQL)
# bun add mongodb             (MongoDB)
# bun add ioredis             (Redis)
# SQLite needs no driver — bun:sqlite / node:sqlite are runtime built-ins (see sqlite-driver.ts)
# Couchbase needs no driver — it speaks the Query and management REST APIs over fetch/node:https
# ClickHouse needs no driver — plain SQL over its HTTP interface (port 8123)
# Apache Druid needs no driver — plain SQL over POST /druid/v2/sql (Router 8888 or Broker 8082)
# Elasticsearch / OpenSearch need no driver — SQL over _sql / _plugins/_sql (port 9200)
# Trino needs no driver — SQL over its client protocol, POST /v1/statement (port 8080)
# libSQL needs no driver — SQLite's dialect over the Hrana protocol, POST /v2/pipeline (port 8080)
# bun add cassandra-driver  (Apache Cassandra — a binary protocol over TCP, so a driver is not
#                            optional; this one is pure JS, which is the next best thing)
# bun add @duckdb/node-api  (DuckDB — an embedded engine, so there is no protocol at all and no
#                            HTTP alternative; this one is a NATIVE N-API addon)
# bun add --exact db2-node    (Db2 LUW — DRDA is a binary protocol, so a driver is not optional;
#                            this one is a Rust NATIVE N-API addon with no IBM client)
# bun add --exact neo4j-driver-lite  (Neo4j: Bolt is a binary protocol; pure JS, and the graph
#                            layer's one transport, so a second graph engine adds no driver)
```

If your engine exposes a documented HTTP API, weigh it against the native driver before adding a
dependency: a native module lands in the Docker image, every native distribution channel, and the
published `@libredb/studio` package.

**DuckDB is the counter-example, and it is worth stating rather than hiding.** It has no first-class
HTTP query API to weigh — the engine is a library, not a server — so the native `@duckdb/node-api`
addon was the only route, and it costs about 68 MB of platform bindings per libc variant (measured:
138.7 MiB uncompressed on a Linux tree carrying both glibc and musl, and the AppImage build prunes
the musl half). Pay that only when there is genuinely nothing to weigh it against.

## Traps specific to HTTP databases

Each of these silently produces wrong output, and each was found by testing against a real server
rather than a mock.

**HTTP 200 does not mean success.** Couchbase returns syntax and semantic errors inside a 200
response with `status: "errors"`, and Trino does the same with a `QueryError` field. Check the
payload before the HTTP status, or a failed statement reads as "0 rows". This is not universal —
Apache Druid does use real 400 / 500 / 504 codes — so establish which behaviour applies before
writing the error path.

**Real status codes still misclassify.** Druid answers `SELECT 1/0` with **HTTP 500**,
`persona: "ADMIN"` and `category: "UNCATEGORIZED"`, message "/ by zero" — an ordinary user mistake
reported as an admin-facing server failure, so reading 5xx as "the cluster is broken" would tell the
user something false. ClickHouse has the same hazard: a denied grant is a 500 rather than a 403, and
its message says "Not enough privileges" while containing neither "access denied" nor "permission
denied". **Classify on the engine's own error category or code, never on the status and never by
sniffing message text.** Druid's `category` is present in both of the envelopes it uses (the
structured `druidException` and the legacy wrapper) and is a closed enum; ClickHouse's numeric
exception code is in its plain-text error body. Each provider branches on that one field and on
nothing else.

**64-bit integers can arrive as unquoted JSON numbers, and `JSON.parse` rounds them silently.**
ClickHouse turns `18446744073709551615` into `...552000`; Druid turns `9007199254740993` into
`9007199254740992`. No error is raised in either case, so the wrong number reaches the grid looking
exactly like the right one. Ask the server to quote them if it can — ClickHouse takes
`output_format_json_quote_64bit_integers=1` — and if it cannot, own the fix: Druid has no such
setting, so its transport runs a string-aware pass over the **raw body** before parsing and quotes
every integer literal outside `Number.MIN_SAFE_INTEGER … Number.MAX_SAFE_INTEGER`. String-aware is
the load-bearing part; a naive digit-run rewrite corrupts `"id: 9007199254740993"` inside a value.
Either way the number reaches the UI as an exact string, which is what the `pg` driver already does
for `int8`. The generalisable lesson: check the widest integer type your engine supports against
`Number.MAX_SAFE_INTEGER` before trusting `JSON.parse`, and expect to write the fix yourself when the
server offers no switch. Check the exact decimal type too: ClickHouse's 64-bit setting does not cover
`Decimal`, which needs `output_format_json_quote_decimals=1` as well, and a fraction cannot be rescued
from the text afterwards, because nothing in it tells a lossy decimal from a float printed in full.

**The response envelope does not always describe the rows.** Couchbase's `signature` is `"*"` for
`SELECT *`, and `{ id, "*" }` for a wildcard mixed with named projections. Taking those keys
verbatim names a literal `*` column and hides every field the wildcard expanded to. Derive the field
list from the rows whenever the envelope cannot describe them.

**Rows are not always objects.** `SELECT RAW` / `SELECT VALUE` style projections return scalars,
arrays or `null`. `Object.keys(null)` throws, and `Object.keys("text")` returns character indices.
Wrap anything that is not a plain object in a single named column.

**Name resolution can be implicit.** Couchbase reads a bare two-part name as `bucket.collection`, so
the explorer's `scope.collection` display name resolved to a non-existent bucket until the transport
pinned a query context to the connection's bucket. Check how the engine resolves an unqualified name
before generating one.

**Consistency defaults may not be read-your-writes.** Couchbase's query service defaults to
`not_bounded`: immediately after an `INSERT`, a `SELECT` returned zero rows. For an interactive
editor that is unacceptable, so the transport sends `request_plus` and accepts the latency.

**Pagination models differ, and the engine may page you without being asked.** Couchbase returns
everything in one response; Trino makes the client poll a `nextUri` until it is absent; the
Elasticsearch and OpenSearch SQL endpoints hand back a `cursor` you POST again. (`search_after`, which
this sentence used to name, belongs to the native search API — the SQL surface these providers use
does not offer it. Read the endpoint you are actually going to call.) The `query()` contract assumes
one shot, so a paging protocol needs a bounded loop inside the transport.

The Elasticsearch case is the one worth copying, because it is not opt-in. Measured on 9.1.4:
`SELECT k, COUNT(*) FROM probe_buckets GROUP BY k` over 1500 distinct values answers HTTP 200 with
**1000 rows and a `cursor`** with no `fetch_size` requested — an aggregation is paged by the engine's
own default. Dropping that cursor returns two thirds of the buckets and labels the result complete,
which is worse than an error, because nobody reading a `GROUP BY` can tell that 500 groups are
missing. Two traps come with following it: page two carries rows and **no** column declaration, so
the declaration has to be carried forward from page one; and the loop needs its own ceiling
(`MAX_PAGES` in `providers/sql/search/http-transport.ts`) plus a cursor-close on the way out, because
the terminating condition is the server's and an abandoned cursor is server-side state. Assume any
HTTP SQL endpoint may page, and probe an aggregation — not a plain `SELECT` — to find out.

**Statelessness has a hard edge.** With one HTTP request per statement there is no session, so
transactions, temp tables, `SET` and prepared statements all need explicit threading — a transaction
id carried on each request, or a session parameter. This is the real boundary of the pattern: right
for an editor, wrong for session-heavy workloads.

---

## Capability honesty

`getCapabilities()` drives what the UI offers, and a flag that is `true` but cannot work produces a
control that only emits invalid input. That is the defect class
[#194](https://github.com/libredb/libredb-studio/issues/194) and
[#201](https://github.com/libredb/libredb-studio/issues/201) were about. Two traps already hit:

- `supportsCreateTable` must be `false` for schemaless engines. `CreateTableModal` builds
  `CREATE TABLE` from a column list, which a schemaless collection cannot consume.
- `supportsInlineRowEdit` must be `false` unless the engine accepts
  `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>` — the one statement shape
  [`use-inline-editing.ts`](../src/hooks/use-inline-editing.ts) builds. ClickHouse was the trap
  ([#269](https://github.com/libredb/libredb-studio/issues/269)): it answers that statement with code
  `48` `NOT_IMPLEMENTED` because a row mutation there is `ALTER TABLE ... UPDATE`, and Druid has no
  row-level DML at all, so both offered an editor that could only fail.
- `supportsResultPagination` must answer one question and one only: does **your** `prepareQuery` really
  apply a positive `offset`? Do not read it off `supportsExternalQueryLimiting`, which answers whether
  a bound can be injected at all — Cassandra declares that one `true` and throws on any `offset > 0`,
  because CQL has no `OFFSET`. Call your own `prepareQuery(sql, { limit: 50, offset: 50 })` before you
  write the value: if it throws, pins the offset to 0, or returns the statement unchanged, the answer
  is `false`, and `false` hides the Load More control rather than offering one that can only re-fetch
  page one ([#816](https://github.com/libredb/libredb-studio/issues/816)). LibreDB was the quiet trap:
  it inherits the base `prepareQuery`, which echoes the requested offset back while applying nothing.
  `tests/unit/db/result-pagination-capability.test.ts` measures every type-id against its declaration,
  so a wrong value fails there rather than in a user's grid.
- If `supportsExplain` is `true`, `buildSql()` **must not** return `null` for the `analyze` mode. The
  direct Explain action always builds with `analyze`
  in `executeQuery()` ([`use-query-execution.ts`](../src/hooks/use-query-execution.ts)) and refuses
  the run when the
  strategy declines, so the button is dead while only the background pre-warm works. When the engine
  has no analyze equivalent, return the estimate for both modes — `sqlite-queryplan.ts` and
  `couchbase-json.ts` both do exactly that.
- **The `estimate` mode must never execute the statement.** The editor sends it in the background
  beside every run of a SELECT, so an executing estimate runs every SELECT twice. `postgres-json.ts`
  once ignored the mode and answered `EXPLAIN (ANALYZE, ...)` for both, and on PostgreSQL a single RUN
  of `SELECT nextval('s')` advanced the sequence by two (#1311). Only `analyze` may build an executing
  form; `tests/unit/lib/explain/registry.test.ts` checks every registered strategy's estimate for
  `ANALYZE`, and its format list is a `Record` so a new format cannot be left out of it.
- **Decide what is explainable with `classifySelectPrefix()`**
  ([`explain/select-prefix.ts`](../src/lib/explain/select-prefix.ts)), never with a fresh regex. It
  accepts a leading CTE and leading SQL comments as well as a bare `SELECT`, which every dialect here
  was live-verified to explain, and it returns `"select"` or `"with"` so a strategy can treat the two
  differently. Each of the six strategies used to carry its own `/^\s*SELECT\b/i`, and every one of
  them refused a CTE — while the shared `analyzeQuery` already classified `WITH … SELECT` as a SELECT
  and injected a `LIMIT` into one.
- **Ask whether your engine's EXPLAIN executes what it explains before widening anything.** This is
  the one place the six strategies genuinely differ. PostgreSQL's emits
  `EXPLAIN (ANALYZE, …)`, which runs the statement — so a data-modifying CTE is a write wearing a
  `WITH`, and explaining one performs it (verified: the row really landed). `postgres-json.ts`
  therefore pairs the shared classification with `hasDataModifyingStatement()`, and it applies that
  screen **only** to the `"with"` case, because a statement leading with `SELECT` cannot carry such a
  CTE and screening it too would strip the button off anything that merely mentions `insert`. The
  other five engines describe without running and need no screen. `classifySelectPrefix()` takes an
  optional grammar for the same reason: an explain run bypasses the confirmation dialog, so on the one
  engine whose EXPLAIN executes, a comment read by the wrong dialect's rule is a write executed with no
  prompt — `postgres-json.ts` therefore passes PostgreSQL's grammar (block comments nest there, and a
  flat reading of `/* a /* b */ SELECT 1 */ DELETE …` reports `SELECT`; verified on 18, the rows were
  deleted). If your engine's comment or quoting rules differ from the compatibility default, pass its
  grammar too.
- A capability can be absent because the **grammar** lacks it rather than because nobody implemented
  it, and the flag reads the same either way — so check, and then say so. Druid answers
  `CREATE TABLE t (id BIGINT)` with a syntax error, because `CREATE` is not one of its statements at
  all (a datasource comes into existence by being ingested into), so `supportsCreateTable` is
  `false`. Nothing in `MaintenanceType` has a SQL-reachable Druid analogue either — compaction and
  retention are Coordinator and task concerns, and `kill` has nowhere to get a query id from because
  Druid publishes no catalog of running queries — so `supportsMaintenance` is `false` with an empty
  operation list, rather than true with nothing behind it.

The same honesty rule governs monitoring: **a source the connected user cannot read returns empty,
it never throws.** Monitoring catalogs are frequently permission-gated, so a denial is the normal
case for a restricted user and must not break an otherwise working connection.

---

## Verify against a real server

Mock-based tests are the repo standard and they are **not sufficient on their own**. On the
Couchbase provider a live pass against a real cluster disproved a design decision — un-indexed
collections turned out to be queryable on Server 7.6+ through a sequential scan — and found three
defects the mocks had accepted without complaint. On Druid it overturned a verdict recorded in **this
guide** (see [Driver-free candidates](#driver-free-candidates)): the EXPLAIN output was predicted not
to fit the tree render model, and the real plan turned out to be a genuine nested tree.

Before opening the PR, drive the provider through the running application against a real server:

- full `INSERT` / `UPDATE` / `SELECT` / `DELETE`, including a `SELECT` immediately after a write, to
  catch read-your-writes problems — or establish that the engine has no write statement to test.
  Druid SQL has neither `UPDATE` nor `DELETE` in its grammar and rejects `INSERT`/`REPLACE` on the
  native engine, and each of those is a claim only an actual attempt can settle
- both error paths — a syntax error and a missing object — confirming each surfaces as an error
  rather than as zero rows
- schema introspection, checking column types and the object-naming rule
- the Explain button on a statement that has **never been run**, so a background pre-warm cannot mask
  a broken direct action
- every monitoring panel, and each maintenance operation

Add a service to `database-compose.yml` so the next person can repeat this — or a profile-gated set of
them, which is what a distributed engine needs. Druid has no single-container mode, so its seven
services all carry `profiles: ["druid"]`: a default `docker compose up -d` must not double for
everyone who is not working on Druid, and `docker compose --profile druid down` is then needed to
remove them again.

---

## Step 6: Verify

### Local gates

All six are mandatory before a commit, and they match CI:

```bash
bun run format     # Biome, lineWidth 120
bun run lint       # oxlint, then ESLint - 0 errors
bun run typecheck  # tsc --noEmit
bun run knip       # fails on unused files, exports and dependencies
bun run test       # every layer
bun run build      # production build
```

If your change adds executable lines, the coverage gate applies too — it is a required CI check and
it demands 100%:

```bash
bun run test:coverage && bun run coverage:check
```

Work test-first. Retrofitting tests afterwards is how coverage-gate fights start.

### Grep Check

Ensure you didn't introduce hardcoded type checks outside your provider:

```bash
# Should only appear in YOUR provider file and db-ui-config.ts:
grep -r "=== 'cockroachdb'" src/
```

If it appears in routes, components, or utilities — you're doing it wrong. Use capabilities/labels instead.

### Functional Checklist

| Feature | How to test |
|---------|-------------|
| Connection | Create connection in ConnectionModal, verify it connects |
| Schema | Sidebar shows tables/collections with columns and indexes |
| Query execution | Write a query, press Ctrl+Enter, verify results |
| EXPLAIN | If `supportsExplain: true`, verify EXPLAIN button works |
| Create Table | If `supportsCreateTable: true`, verify the + button appears |
| Inline row edit | If `supportsInlineRowEdit: true`, verify the EDIT toggle appears and one edited row runs one statement the engine accepts |
| Result pagination | If `supportsResultPagination: true`, open a table with more than 50 rows from the tree, click Load More once and verify the appended rows are ones you had not already seen; if `false`, verify no Load More appears |
| Transactions | If `supportsTransactions: true`, verify BEGIN/COMMIT/ROLLBACK and SANDBOX appear in the toolbar and that a BEGIN succeeds; if `false`, verify all four are absent |
| Maintenance | Open Database Maintenance, verify correct operations show |
| AI Explain | If `supportsExplain: true`, open Visual EXPLAIN and verify the AI explanation streams |
| Labels | Check all UI text uses your labels (entity names, actions, etc.) |
| Schema refresh | Run a write query, verify schema reloads if it matches `schemaRefreshPattern` |

## Reference: Interface Contracts

### ProviderCapabilities

Every field and what it controls:

| Field | Type | Controls |
|-------|------|----------|
| `queryLanguage` | `'sql' \| 'json' \| 'promql' \| 'cypher' \| 'influxql'` | Monaco editor language mode, AI prompt style, query template format. A closed union: a new member needs an arm, or a test pinning its branch, in every reader (#1085) |
| `queryDialect` | `'libredb' \| 'redis' \| 'kafka' \| 'etcd' \| 'milvus' \| 'qdrant' \| 'oxia' \| undefined` | Optional. Names the dialect's records in three registries, which the tab type, the Monaco language, the formatter, the generated statements and the Generate Code and Generate Count Query gates consult **before** `queryLanguage` (only Profile answers an SQL language first, `offersColumnProfiling` in `src/lib/db/types.ts`): `QUERY_DIALECTS` (`src/lib/db/query-dialects.ts`, the tab type and the row-menu gates), `DIALECT_EDITORS` (`src/lib/editor/dialect-editors.ts`, the Monaco language and the formatter) and `DIALECT_GENERATORS` (`query-generators.ts`, what a tree click and Generate Query write). A new dialect adds its three records, not a check in each reader: `queryLanguage: 'json'` alone means MongoDB, which is how Redis silently got MongoDB documents until #427. Left undefined by SQL and MongoDB |
| `supportsExplain` | `boolean` | EXPLAIN button visibility in QueryEditor toolbar |
| `explainFormat` | `ExplainFormat \| undefined` | **Required whenever `supportsExplain` is true.** Selects the strategy in `src/lib/explain/index.ts`. Setting the flag without the format leaves the control visible and dead — the UI resets out of explain mode when metadata lacks it |
| `supportsExternalQueryLimiting` | `boolean` | Whether route applies LIMIT to queries (SQL) or provider handles it (MongoDB) |
| `supportsCreateTable` | `boolean` | "Create Table" button in SchemaExplorer |
| `supportsInlineRowEdit` | `boolean?` | Whether the results grid offers inline row editing. `false` hides the EDIT toggle and every editable cell — set it where the engine has no `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>` statement, which is what `use-inline-editing.ts` builds. Optional only because the interface is published and a required addition breaks external implementers; every provider here declares it, and an absent flag reads as unsupported |
| `inlineEditRefusedColumns` | `{ type: string; reason: string }?` | The result columns the inline editor must not write where the engine takes its `UPDATE` for other columns. `type` is a regular expression source matched against the type the result declares for the column (`QueryResult.columnTypes`); each matching cell opens no editor and shows `reason`. Db2 sets it for CLOB, DBCLOB and BLOB, which db2-node does not write when bound (K24). Absent refuses no column |
| `supportsResultPagination` | `boolean?` | Whether your `prepareQuery` really applies a positive `offset`. `false` hides the results grid's Load More control. Not the same question as `supportsExternalQueryLimiting`; measure it, do not infer it. Optional and gated on `=== true` for the same published-interface reason as the flag above |
| `supportsTransactions` | `boolean?` | Whether THIS PROVIDER implements the interactive transaction session `POST /api/db/transaction` drives (`beginTransaction`/`commitTransaction`/`rollbackTransaction` over one held connection). `false` withholds the editor toolbar's BEGIN/COMMIT/ROLLBACK trio **and** the SANDBOX toggle, which auto-rolls-back through the same route. It is about the provider's surface, not the engine: SQLite has `BEGIN` and still declares `false`. Optional for the published-interface reason above; the UI gates on `=== true`, so an absent flag and an unresolved metadata fetch both read as no transactions (#464) |
| `implicitCommitStatements` | `readonly string[]?` | The statements that can END the open transaction on this engine beyond the `COMMIT`/`ROLLBACK`/`ABORT` every engine has, each an upper-cased sequence of leading words (`"CREATE"`, `"PREPARE TRANSACTION"`): implicitly committing DDL (MySQL, Oracle), a dialect's own COMMIT synonym (PostgreSQL's `END`), or code the provider cannot check afterwards (an Oracle PL/SQL block). SANDBOX refuses a text containing one before anything is sent, because the `ROLLBACK` it ends with would answer success and could undo nothing. Declare it only with `supportsTransactions: true`. A provider that can read the server's transaction state should also refuse a `BEGIN` that opened nothing and end its session when a statement ended the transaction, so the route can answer `inTransaction: false` (see `postgres.ts` and `mysql.ts`) |
| `implicitCommitExceptions` | `readonly string[]?` | Word sequences an `implicitCommitStatements` entry would match that do NOT end the transaction (Oracle's `ALTER SESSION`, MySQL's `CREATE TEMPORARY`). Read only together with that list |
| `declaresForeignKeys` | `boolean?` | Whether this engine has foreign keys in its model at all. `false` says an empty foreign-key list means "no such constraint exists here", not "this schema declares none" — set it on every engine without referential constraints. Optional for the published-interface reason above; consumers gate on `=== false`, so an absent flag reads as "may declare them" |
| `tablesAreDerivedGroupings` | `boolean?` | Whether the relation-shaped rows of this provider are objects the engine holds, or groupings this server derived from a bounded scan. `true` on Redis, LibreDB and etcd only. Where it is true the schema explorer hides the items that *address* the row, `Profile Table`, `Generate Count Query` and both per-row maintenance items, all of which name the row to a route that needs a real object, and keeps the ones that merely name it (`Select`, `Generate`, `Copy Name`, `Generate Code`). It does not gate `Generate Test Data`: since #1085 (decision D-M) both row menus offer that item only where the kind of the row declares `acceptsRowWrites` and the engine declares `supportsInlineRowEdit`. With `keyScan` beside it, it is also one half of the gate on `Browse Keys`, the row-menu item that opens the key-space panel with the row's own name as its pattern: a glob under `keyScan.pattern: "glob"` and a bare prefix under `"prefix"`: a prefix is only a glob on an engine whose rows are prefixes. The agent layer states it to a plan run in one sentence. Consumers gate on `=== true`, so an absent flag reads as "ordinary objects" |
| `enforcesReadOnly` | `true?` | Whether this provider refuses every write, object edit and maintenance operation before any request while the connection's `readOnly` is true, or while it was opened with `ProviderExecutionContext.readOnly`, naming the read-only mode in the refusal. Nothing under `src/` reads the field: the seed schema, `assertReadOnlyHonoured` in `factory.ts` and the connection form decide before a provider exists, so they read `READ_ONLY_ENFORCED` in `src/lib/db/compatibility.ts`, and `tests/unit/db/read-only-enforced-capability.test.ts` holds that map equal to this declaration for every type-id. Only the literal `true` is declared, so an absent flag reads as "a read-only connection is refused here" (#1089) |
| `supportsMaintenance` | `boolean` | Whether maintenance API accepts requests for this provider |
| `maintenanceOperations` | `MaintenanceOperation[]` | Which global cards and per-table buttons the admin Operations tab renders. `/api/db/maintenance` rejects anything not in this list, so a surface that ignored it could only offer a control answering HTTP 400. Both row menus read it too, through `maintenanceControl()` (#496): a per-row maintenance item is offered only for an operation declared here, and not where its `maintenanceOperationSpecs` entry sets `perEntity: false`. Both offer such an item to an admin only, and the schema explorer also withholds it from a derived grouping (`tablesAreDerivedGroupings`) |
| `supportsConnectionString` | `boolean` | Used for future connection validation logic |
| `defaultPort` | `number \| null` | Informational; actual UI port comes from `db-ui-config.ts` |
| `schemaRefreshPattern` | `string` | Regex to detect write/DDL queries that should trigger schema reload |

### ProviderLabels

Every field and where it appears. There is **no `MaintenanceModal` component** — earlier revisions of
this table named one for ten of these rows; `git grep MaintenanceModal src/` finds only a ClickHouse
comment. Three surfaces read labels today, plus the agent's prompt layer:

| Field | Where it appears |
|-------|-----------------|
| `entityName` | `SchemaExplorer` "Create {Table}" button title; `TableItem` "{Table} name copied" toast; lowercased by `inventoryNoun()` into the agent's prompt noun |
| `entityNamePlural` | Lowercased by `inventoryNoun()` (`src/lib/agent/inventory-noun.ts`) into the agent's prompt noun. No UI surface reads it |
| `rowName` / `rowNamePlural` | **Nothing reads these.** Declared, defaulted in `base-provider.ts`, set by several providers, consumed nowhere in `src/` |
| `selectAction` | `TableItem` row menu, first item ("Select Top 50" / "Find Documents" / "Scan Keys") |
| `generateAction` | `TableItem` row menu, second item ("Generate Query" / "Generate Find") |
| `analyzeAction` | `TableItem` row menu only, and only where the rows are not derived groupings. **The Operations tab does not read it.** That tab's per-table button takes its wording from `maintenanceOperationSpecs.analyze.label` through `maintenanceControl()`, and falls back to the generic verb "Analyze" where the provider declares no spec (#496) |
| `vacuumAction` | `TableItem` row menu only, under the same derived-groupings gate as `analyzeAction`, and not read by the Operations tab either. That button is gated on the literal `vacuum` and worded from `maintenanceOperationSpecs.vacuum.label`, so the five providers that point this label at `optimize` via `vacuumActionOperation` show a row item whose wording the tab does not repeat (#496) |
| `searchPlaceholder` | `SchemaExplorer` search input placeholder text |
| `analyzeGlobalLabel` | Admin Operations tab, analyze card's button text ("Run Analyze") |
| `analyzeGlobalTitle` | Admin Operations tab, analyze card title ("Update Statistics") |
| `analyzeGlobalDesc` | Admin Operations tab, analyze card description paragraph |
| `vacuumGlobalLabel` | Admin Operations tab, vacuum card's button text ("Run Vacuum") |
| `vacuumGlobalTitle` | Admin Operations tab, vacuum card title ("Reclaim Space") |
| `vacuumGlobalDesc` | Admin Operations tab, vacuum card description paragraph |
| `reindexGlobalLabel` (optional) | Admin Operations tab, reindex card's button text. Absent = the hardcoded *"Run Reindex"* |
| `reindexGlobalTitle` (optional) | Admin Operations tab, reindex card title. Absent = the hardcoded *"Rebuild Indexes"* |
| `reindexGlobalDesc` (optional) | Admin Operations tab, reindex card description paragraph. Absent = the hardcoded *"Reconstructs all indexes in the database."* Declare the triad wherever that sentence is false — on SQLite `reindex` is a bare `REINDEX`, which rebuilds every index in the file rather than reconstructing them per table (#464). Declaring it is pointless where the card cannot render: Couchbase's `reindex` spec sets `global: false`, so its triad reaches nothing |
| `statementLanguage` (optional) | The agent's plan contract (`src/lib/agent/investigation.ts`), stated verbatim to the model. No UI surface reads it. Declared only where the engine's own name misleads a model about what a "statement" is here |
| `slowQueriesEmptyState` (optional) | Monitoring **Queries** tab, the "Slowest Queries" empty state. Absent = PostgreSQL's *"Enable pg_stat_statements extension to see query stats."*, which is what the component hardcoded for every engine until #463. Declare it wherever that sentence is false, and the panel drops the `pg_stat_statements required` badge as well |

The `*Global*` triads reach only the card, never the per-table button, and only where the card
renders: the analyze card is gated on `analyze`, the vacuum card on the **literal** `vacuum`, the
reindex card on `reindex`. The `reindexGlobal*` triad is **optional** while the other two are
required, because `ProviderLabels` is published (`src/exports/types.ts`) and a required field added
after the fact stops every external implementer compiling; only the four providers that declare the
`reindex` operation (Postgres, SQLite, libSQL, Couchbase) set it, and the card keeps its old strings as the
fallback.

### PreparedQuery

Returned by `prepareQuery()`. The query route uses it directly:

```typescript
// In /api/db/query/route.ts — no type checks needed:
const provider = await getOrCreateProvider(connection);
const prepared = provider.prepareQuery(sql, { limit, offset, unlimited });
const result = await provider.query(prepared.query);
```

| Field | Purpose |
|-------|---------|
| `query` | The (possibly modified) query string to execute |
| `wasLimited` | Whether a LIMIT was injected. This preparation flag is unchanged for short results; the query and transaction routes report it on the response's `pagination.wasLimited` only when a row past the page came back (#1440), which the stats strip shows as the "limited" badge. A provider that bounds its own result instead, as the Prometheus provider cuts a vector at its series cap and the Kafka provider cuts a read at its row limit, its result byte budget and its cell limit, returns `false` here and reports its bound on `QueryResult.pagination.wasLimited`, which `POST /api/db/query` keeps (#1085, section 5.4); such a bound never sets `hasMore`, because no offset can advance it |
| `limit` | The effective row limit |
| `offset` | The effective offset |

## Reference: Existing Providers

For the authoritative, code-verified reference for each shipped provider (extends-which-base,
driver, pooling, capabilities, labels, `prepareQuery` behaviour, and limitations), see the prime
docs — they are the single source of truth and are kept in sync with the code:

**[docs/providers/](./providers/README.md)** → postgres · mysql · oracle · db2 · mssql · sqlite · libsql · duckdb · redis · mongodb · couchbase · clickhouse · druid · elasticsearch · opensearch · trino · cassandra · prometheus · influxdb · influxdb3 · kafka · etcd · neo4j · milvus · qdrant · oxia · libredb

When implementing a new provider, the closest existing analogue is the best template: a pooled SQL
provider (postgres/mysql), an embedded SQL provider (sqlite), a non-SQL provider (mongodb/redis), a
graph engine on the graph layer (neo4j), or a driverless provider reached over HTTP (clickhouse,
druid or trino for SQL, couchbase for a document store).

## Driver-free candidates

Assessed against the rubric in [Prerequisites](#prerequisites). Anything not listed almost certainly needs a driver.

Cassandra is the entry this table never had, and it is worth a paragraph for the opposite reason to
Druid's: nothing about the DRIVER decision was interesting - a binary protocol over TCP cannot be
reached by `fetch`, so `cassandra-driver` was never optional - and everything about the CAPABILITY
decisions was. Six of them came out "no", each with a measurement behind it: no EXPLAIN (the keyword
is not in the grammar), no cancellation (the protocol has no cancel frame and the driver publishes no
method), no maintenance (every operation is a `nodetool` action over JMX), no create-table (the modal
emits five type names CQL does not have), no inline row edit (CQL needs the WHOLE primary key
restricted and the editor guesses one column), and **no row count and no size anywhere** - the one
that shaped the whole provider, because Cassandra publishes figures that look exactly like both and
are neither. The generalisable lesson is the reverse of the driver rubric: score the CAPABILITIES the
same way, and count how many of them the engine can actually promise before writing the provider that
declares them. See [cassandra.md](./providers/cassandra.md).

**Shipped since this list was written:** Couchbase
([#263](https://github.com/libredb/libredb-studio/issues/263)), ClickHouse
([#264](https://github.com/libredb/libredb-studio/issues/264)), Apache Druid
([#265](https://github.com/libredb/libredb-studio/issues/265)), Elasticsearch + OpenSearch
([#424](https://github.com/libredb/libredb-studio/issues/424), Phase 1) Trino
([#424](https://github.com/libredb/libredb-studio/issues/424), Phase 2) and Apache Cassandra
([#424](https://github.com/libredb/libredb-studio/issues/424), Phase 4 - the first phase to add a
runtime dependency, and a pure-JS one).

Druid is worth a paragraph, because it **corrected this table's own verdict**. The entry that stood
here rated it strong but predicted that `EXPLAIN PLAN FOR` "returns a native-query translation rather
than an operator tree, so it does not fit the existing tree render model". The live plan disproved
that: `query.dataSource` recurses — `join` carries `left` and `right`, `query` carries one child,
`union` carries a list — so the native query **is** a nested tree, and it renders as
`{ kind: "tree" }` with nothing forced. What keeps that honest is the omission: Druid's planner emits
no cost and no row estimate, so no node carries `metrics`, and node labels name Druid's own query
types (`groupBy`, `scan`, `timeseries`, `topN`) rather than borrowing a relational-plan vocabulary.
The lesson for the next candidate is to read the engine's real EXPLAIN output before predicting the
render model from its documentation. See [druid.md](./providers/druid.md).

Elasticsearch and OpenSearch get a paragraph for the opposite reason: the entry that stood here was
**right about the question and wrong about the answer**. It said the pair "needs a dialect decision
first: the SQL endpoint is a subset, the native DSL is JSON", and that "OpenSearch is Apache 2.0 and
the cleaner primary target". The dialect decision was indeed the first one, and it went to the SQL
endpoint — both products expose one without a licence, and `SQLBaseProvider`'s `LIMIT n` is correct on
both, which no JSON DSL would have been. Elastic's ES|QL was rejected on the same test: it exists on
one of the two products only, so it cannot be the shared query language. But "primary target" turned
out to be the wrong shape entirely. Neither product is primary: **two type-ids share one provider
module**, because everything the two disagree about on the wire is one row of a dialect table
(`providers/sql/search/http-transport.ts`) and the one difference above the wire — Elasticsearch's SQL
has no `OFFSET` — is one declared trait rather than an `if`. The lesson for the next candidate: when a
fork and its upstream both qualify, price the shared seam before you pick a favourite, and let the
live probe decide how much the two actually differ. Measured, it was less than the licence history
suggests — and asymmetrically: the *same* mistyped keyword is a `parsing_exception` (`syntax`) on
Elasticsearch and a `SQLFeatureNotSupportedException` (`unsupported`) on OpenSearch, and a missing
index is HTTP 400 on one and 404 on the other, which is why that provider classifies errors from the
body and never from the status.

Trino closed the entry that had stood at the top of this table, and it is worth a paragraph because
**the product question really was the blocker, and the answer was a mapping rather than a feature**.
"A catalog is another system, so what a connection pins is a product question" was correct. The answer
is that the connection's `database` field pins **one catalog**, exactly as it pins one database on
PostgreSQL, and the tree stays two levels; the alternative — fanning `information_schema` across every
catalog — is unbounded in practice, because `jmx.current` alone publishes one table per MBean and one
sidebar refresh would then depend on every configured connector being reachable. Cross-catalog queries
still work, because a fully qualified name never needed the pin.

The `nextUri` polling this table warned about is real and worse than it sounds: the loop terminates on
the **absence of a link**, never on a state — `SELECT version()` takes five pages, a page reporting
`FINISHED` can still carry a link, and the column declaration and the rows arrive on different pages.
Two more measured traps generalise to any engine like it. A failed statement is an **HTTP 200** with
the failure in the document, so nothing may infer success from a status. And a request the server
refuses *before* it becomes a statement answers **plain text**, so an error path that `JSON.parse`s the
body throws a second, misleading error on top of the first.

The fragmented auth matrix turned into one hard rule: a password is a **TLS-only** credential, because
the coordinator answers `401 Password not allowed for insecure authentication` over plain HTTP even
with authentication switched off. Sending it anyway breaks a connection that works without it, so the
transport refuses that configuration rather than the server doing it later.

The lesson for the next candidate with a sibling product: **make the protocol's own naming a
descriptor before you need it.** Trino generates its header family from the product name
(`X-Trino-User`), and so does the transport — from `TrinoDialect.headerPrefix`, with no finished header
name written down anywhere. PrestoDB is therefore a new entry in a table rather than a second
transport, and it is a separate type-id when it comes. See [trino.md](./providers/trino.md).

| Candidate | Verdict |
|---|---|
| **PrestoDB** | Shipped-adjacent: the `trino` transport already builds its headers from a dialect prefix, so this is a descriptor, a doc and an integration test. A separate type-id, because `version()` and the fault vocabulary differ |
| **Snowflake / BigQuery / Databricks SQL** | REST SQL APIs exist and the data model fits; auth is the wall (key-pair JWT, service-account signing, OAuth) and that is where the no-dependency promise ends |
| **CouchDB, ArangoDB, SurrealDB, Weaviate** | All HTTP, all non-SQL or only partially SQL. Feasible, but each needs its own query grammar the way MongoDB and LibreDB do |

Contributions are welcome for any of these. Open an issue with the rubric score first, so the design
decisions are settled before code exists — that is what let the Couchbase, ClickHouse, Druid, Trino and
search providers each land as a single reviewable PR.

---

## Quick Reference Checklist

The integration points, all of which need an entry. This is the list the Strategy Pattern does
*not* spare you — provider logic stays self-contained, registration does not:

**Always:**

- [ ] `src/lib/types.ts` — add to the `DatabaseType` union
- [ ] `src/lib/db/providers/<family>/<type-id>.ts` (or a directory) — **new:** the provider class
- [ ] `src/lib/db/factory.ts` — add a `case` with a **dynamic** import
- [ ] `src/lib/db-ui-config.ts` — icon, colour, label, default port, connection fields
- [ ] `src/hooks/use-connection-form.ts` — **append** to `selectableTypes` (do not retype the array)
- [ ] `src/components/icons/db-icons.tsx` — the engine's mark (`strokeWidth={1.5}`, no HTML size attrs)
- [ ] `src/lib/seed/types.ts` — the seed-config `type` enum, or seeded connections fail validation
- [ ] `src/lib/db/compatibility.ts` — the `SHIPPED` record. It is an exhaustive
      `Record<DatabaseType, true>`, so the compiler refuses the omission rather than letting the
      published engine count silently undercount; it is listed here because the count in `README.md`
      and `docs/BRAND_MESSAGING.md` is derived from it and has to move in the same PR
- [ ] `package.json` — the driver, **if** it needs one. A driver-free provider leaves it untouched, and
      fourteen shipped ids do: `couchbase`, `clickhouse`, `druid`, `elasticsearch`, `opensearch`, `trino`,
      `libsql`, `sqlite`, `prometheus`, `qdrant`, `milvus`, `influxdb`, `influxdb3` and `oxia`
      each add nothing here (`milvus` and `oxia` only extend the `//dependencies` note)
- [ ] `database-compose.yml` — a service, so the next person can repeat the live pass. A distributed
      engine contributes a `profiles: [...]` set instead, as Druid's seven services do, so the default
      stack does not grow for everyone. An EMBEDDED engine gets no service at all — SQLite, DuckDB and
      LibreDB are files rather than servers — but say so in a comment there, or the next reader reads
      the absence as an oversight. Check what the image ships before writing a healthcheck: the
      ClickHouse image has no `curl` and the Trino image ships its own `health-check` script that waits
      for `"starting": false`, which a bare `curl /v1/info` would not

**Also always, and not named above until the Prometheus provider found them (#1085):** each is an exhaustive record or a hand-kept population.
Three searches reach them: the `git grep -l` of an earlier provider's type-id that the note below names, `git grep -n "Record<DatabaseType" -- src tests` with its two-line form `git grep -n -A1 -E "Record<\s*$" -- src tests | grep -B1 "DatabaseType,"`, and `git grep -n "DatabaseType\[\]" -- src tests`.
The compiler refuses the first seven without an entry; the last two are refused by a test.
Those three reach code and tests only; the four prose greps of the published block below reach what a new engine makes false in the docs and the listings.

- [ ] `src/lib/db/compatibility.ts`: the `EXTERNAL` record beside `SHIPPED`.
      It answers whether the new id is an external engine or an embedded store, and every published database count reads it.
- [ ] `src/lib/db-showcase.ts`: `SHOWCASE_RANK`, the login showcase's order.
- [ ] `src/lib/sql/fence-tags.ts`: `ENGINE_FENCE_TAGS`, the fence tags a plan-mode draft may carry.
- [ ] `src/lib/sql/values.ts`: `LITERAL_ESCAPE`.
- [ ] `src/lib/export/result-export.ts`: `STANDS_ALONE` and `BINARY_LITERAL`, plus a decision on the partial `DIALECT_TYPES`.
- [ ] `tests/helpers/census-connection.ts`: `CENSUS_CONNECTION`, the unconnected connection every census builds through the real factory.
- [ ] `tests/isolated/object-column-declarations.test.ts` (`EXPECTED_COLUMN_KINDS`), `tests/isolated/object-source-declarations.test.ts` (`SOURCE_DECLARATIONS`), `tests/unit/db/result-pagination-capability.test.ts` (`EXPECTED`), `tests/unit/db/container-path-shapes-capability.test.ts` (`EXPECTED_CONTAINER_PATH_SHAPES`), `tests/unit/schema-diff/migration-dialects.test.ts` (`COLUMN_GRAMMAR`), `tests/unit/schema-diff/migration-generator.test.ts` (`MODIFIED_COLUMN_COVERAGE`, `TRANSACTION_WRAPPER_COVERAGE`) and `tests/hooks/use-connection-form.test.ts` (`PICKER_COVERAGE`).
- [ ] `tests/unit/lib/db-ui-config.test.ts`: `ALL_TYPES`, which a test holds equal to the keys of `DB_UI_CONFIG`.
- [ ] `tests/helpers/object-edit-expectation.ts`: `EXPECTED_EDIT_ABSTAINERS`, when the new id declares no editable kind.
      That is a population, not a record, so the compiler says nothing; `tests/isolated/object-edit-declarations.test.ts` then requires an `Object edit (#789)` heading in the new provider doc naming which absence it is.

**Also always, and not named above until the Kafka provider found them (#1088):** each is a record, a population or a pinned list no search above prints by itself.

- [ ] `src/lib/db/destructive-commands.ts`: `NON_SQL_DESTRUCTIVE_VOCABULARY`, a row for every id `NON_SQL_DIALECTS` names, which `tests/unit/db/destructive-commands.test.ts` holds to exactly those ids.
      A text that cannot write takes the row that names no operation and decides alone, the Prometheus and Kafka shape.
- [ ] `src/lib/schema-diff/migration-generator.ts`: `NO_TABLE_DDL`, beside `NO_COLUMN_MODIFICATION` and `NO_TRANSACTION_WRAPPER`, for an engine whose diff gets no table DDL at all; every id in it is in `NO_TRANSACTION_WRAPPER` too.
- [ ] `tests/unit/lib/db-ui-config.test.ts`: `FIELD_CHECKLIST`, when the new id's connection fields include one the checklist does not hold.
- [ ] The pinned lists and per-dialect pins: `tests/components/ConnectionModal.test.tsx` (its mocks and its `SHIPPED` census), `tests/components/rich-text.test.tsx` and `tests/unit/lib/sql/fence-tags.test.ts` (the hand lists of canonical tags), `tests/unit/aws-listing-fields.test.ts` (`productNames`), `tests/unit/db/object-edit-expectation.test.ts` (the census counts), `tests/unit/lib/export/result-export.test.ts` and `tests/unit/sql/values.test.ts` (the literal and placeholder pins).
- [ ] `docs/API_DOCS.md`: the `type DatabaseType` line names every type-id.
- [ ] The `factory.ts` line citations that `tests/unit/lib/db/connection-fingerprint.test.ts` holds to the lines their anchors sit on: a new factory `case` moves every line below it.
- [ ] The untyped `Supported types:` string of `createDatabaseProvider` in `src/lib/db/factory.ts`, which no compiler checks: add the type-id to it.
- [ ] The `<!-- engines:N -->` marker of `deploy/aws/listing/listing-fields.md`, which `tests/unit/aws-listing-fields.test.ts` counts against `EXTERNAL_DATABASE_TYPES`.
- [ ] An E2E spec that drives Test Connection runs on the second Playwright server: add it to `SECOND_SERVER_SPECS` in `tests/unit/e2e-project-servers.test.ts`, to the `chromium` project's `testIgnore`, and to a project of its own on `offlinePort` in `playwright.config.ts`.
- [ ] The identity colour: `src/styles/theme.css` declares a finite set of hues, `tests/unit/lib/db-ui-config.test.ts` requires every engine's colour to differ, and a second step of a used hue must pass the separation test of `tests/unit/theme-accent-contrast.test.ts` by joining `IDENTITY_ALTS`, or be a new token with its theme and contrast entries.
- [ ] A read-write key-value engine may need the declarations etcd added: `ObjectKindSpec.enumeratedBy` and `countIsListing`, the `KeyScanCapability` shape fields, `READ_ONLY_ENFORCED`, `MCP_EXPOSABLE`, a declared maintenance card (`title`, `description`, `confirmation`), and a vocabulary row with `typedConfirmation` and `safetyAnalysis`; each is read by one helper and every existing engine's answer stays unchanged.

**For a JSON dialect**, a reader keyed on `"json"` alone treats the text as MongoDB (#427), so the dialect is one record in each of three registries, and the build fails until all three exist:

- [ ] `src/lib/db/query-dialects.ts`: a record in `QUERY_DIALECTS`, the dialect's tab type and its answers for the row menus' `offersColumnProfiling`, `offersCodeGeneration` and `offersCountQuery`.
      Profiling reads a dialect only beside `"json"`, while the count reads any declared dialect.
- [ ] `src/lib/editor/dialect-editors.ts`: a record in `DIALECT_EDITORS` for the dialect's tab type, the Monaco language it renders in and its formatter, if it has one.
      Tab types that render in one Monaco language share its formatter, which `tests/unit/editor/dialect-editors.test.ts` holds.
- [ ] `src/lib/query-generators.ts`: a record in `DIALECT_GENERATORS`, what a tree click and Generate Query write, read before the `json` arm, or a tree click auto-executes a MongoDB document.
      `docs/providers/kafka.md` section 3.1 is the worked case.
- [ ] `src/components/QueryEditor.tsx`: the MongoDB completion provider registers only where the declared capabilities name no JSON dialect.
- [ ] `tests/unit/lib/dialect-reader-allowlist.test.ts`: every other line under `src/` that compares `queryDialect`, reads `queryLanguage === "json"` or negates `queryLanguage` is on its closed list with its owner.
      A new reader goes into a registry, or onto the list with the reason it is not one.

**For a new connection field**, beside the three `Record<keyof DatabaseConnection, ...>` maps and `connection-filter.ts` that the note below names:

- [ ] `src/hooks/use-connection-form.ts`: the dialog keeps each field in its own state and rebuilds the connection from those states, so a declared field alone never reaches the saved connection.
      The field needs its state, its load on edit (always overwritten, so one connection's value never carries to the next), its reset on close, its line in `buildConnection` gated on `addressedFields`, its dependency entry and its returned pair.
- [ ] `src/lib/seed/types.ts`: `SeedConnectionSchema`, the zod object a seed file is validated against before `connection-filter.ts` maps it; zod strips a key the object does not declare, so an undeclared field is dropped with no error.
- [ ] `src/lib/seed/credential-resolver.ts`: `RESOLVABLE_FIELDS`, when the field is a credential or an address a deployment keeps out of the seed file; a name such as a SASL mechanism is neither, and takes a literal.
- [ ] `src/lib/db/provider-cache-key.ts`: `credentialDigest`, a hand-kept list of every field that changes who a connection authenticates as, so two connections that differ only in that field never share a cached provider.
- [ ] `docs/API_DOCS.md`: the `DatabaseConnection` block, which `tests/unit/api-docs-types.test.ts` compares with the interface as an ordered list of field names, so the field goes in at the same position in both.
- [ ] `src/lib/db-ui-config.ts`: `fieldOptions`, when the field is a choice the dialog renders as a select, and `showSshTunnel: false`, when the engine cannot run through a tunnel; the dialog and `buildConnection` both read the latter through `offersSshTunnel`, one rule for both readers.

**Conditionally, and each one is easy to miss because the code still compiles without it:**

- [ ] `src/lib/db/types.ts` — add to the **`ExplainFormat`** union whenever `supportsExplain` is true.
      The `Record<ExplainFormat, …>` registry is exhaustive, so this and the next item must land
      together or neither compiles
- [ ] `src/lib/explain/index.ts` — register the strategy
- [ ] `src/lib/connection-string-parser.ts` — the scheme(s), if `supportsConnectionString`
- [ ] `src/lib/query-generators.ts` — only if the dialect needs its own branch; the default is
      PostgreSQL-shaped, so check before assuming it fits
- [ ] `src/lib/schema-diff/migration-generator.ts` — same shape, same hazard: the modified-column
      chain's trailing `else` is PostgreSQL DDL, so an unlisted id silently inherits it (#269). Give the
      dialect a branch, or list it in `NO_COLUMN_MODIFICATION` to emit an honest comment instead. A new
      id also needs a decision in `NO_TRANSACTION_WRAPPER` (#284): does `BEGIN;`/`COMMIT;` wrap this
      engine's DDL at all, or does it belong in the set that gets no wrapper? An id absent from that
      set inherits the PostgreSQL-shaped wrapper by default, which is silently wrong for a non-SQL or
      non-transactional engine the same way the modified-column `else` used to be
- [ ] `src/lib/sql/grammar.ts` — **two decisions, neither of which the compiler can force.** First,
      whether your engine's query text is SQL at all (`NON_SQL_DIALECTS`): an id absent from that set is
      declared to write SQL, and the confirmation gate then applies a SQL span reader to it — which for
      a JSON or command-line grammar reports ordinary text as unreadable and prompts on every run (#297).
      Second, the four grammar facts (`SQL_GRAMMARS`): `#`, `[…]`, whether block comments nest, and
      whether `q'…'` is a literal. An id absent from that table reads under the compatibility default,
      which is SQL Server's bracket reading and MySQL-ish everything else — fine where your engine
      agrees, a lost row bound or a false prompt where it does not (that is what PostgreSQL's bracket
      row cost before it was established). Establish each fact from your engine's own documentation or
      its driver's tokenizer, never from a neighbouring dialect, and leave it at the default rather than
      guess. `tests/unit/sql/grammar.test.ts` holds `Record<DatabaseType, …>` maps for both decisions,
      so the compiler will at least stop you from *forgetting* that a decision exists
- [ ] `src/lib/db/types.ts`: `queryLanguage`, only when the engine's query text is neither SQL nor JSON.
      A new member is not neutral: a reader written `=== "json"` sends it into its SQL branch and one written `!== "sql"` into its MongoDB branch, so every reader needs an explicit arm or a test pinning that its branch is right.
      `grep -rn queryLanguage src` is not the whole population: `src/components/agent/AnswerCard.tsx` reads it through `editorLanguageForTabType`.
      `docs/providers/prometheus.md` section 3.1 is the worked case.
- [ ] `src/lib/db-ui-config.ts`: `fieldLabels` and `fieldHints`, when a connection field needs its own label or hint.
      Declare them there rather than adding a type test to `src/components/ConnectionModal.tsx`, which already carries five (`docs/BACKLOG.md` U36).
- [ ] `src/lib/db-ui-config.ts`: `hostAcceptsUri`, when the engine's documentation gives its endpoint as an `http://` or `https://` address; and the type's row of `CREDENTIAL_WARNINGS` in `src/lib/db/credential-warnings.ts`, which the entry's `credentialWarnings` reads by reference, when the engine ships a default credential, accepts no secret, or takes a token whose claims say how far it reaches.
      Each needs a test that the real record declares it, and a declared `pair` or `no-secret` entry needs the provider's own `readOnlySeedRefusal` check in `connect()` for a seed connection.

**Published where a human reads it, and this is the block with the fewest gates.** `readme:check`
compares the translated READMEs against `README.md` and `chart:check` compares versions. The catalog
files in `COPY_FILES` are now counted as well:
[`tests/unit/lib/catalog-copy-engine-count.test.ts`](../tests/unit/lib/catalog-copy-engine-count.test.ts)
walks them, refuses a numeral qualifying "engines" that is not `EXTERNAL_DATABASE_TYPES.length`, and
where that numeral introduces a list, refuses a list that does not name every one of them by its
`DB_UI_CONFIG` label (#D47 - added after three consecutive PRs corrected the same class by hand; the
#511 review found all nine stale after libSQL had already landed everywhere the compiler looks). The
files NOT in that walk have no numeral gate.
`DOCKERHUB.md` has one gate of another kind: `tests/unit/dockerhub-listing.test.ts` holds it to `FULL_DESCRIPTION_BUDGET` bytes, below Docker Hub's limit, so a new engine row can need room made elsewhere in the listing, and the counted listings have size gates of their own (`tests/unit/pcsc-listing.test.ts`, `tests/unit/build-azure-package.test.ts`, `tests/unit/caprover-template.test.ts`).
An abridged list ("and more", or a "from X to Y"
range) is still checked on its numeral only, deliberately, so that no numeral goes stale (#445):

- [ ] `charts/libredb-studio/Chart.yaml` — the `description`, which is what **ArtifactHub** shows, AND
      the `keywords` list, which is what ArtifactHub **searches**. An engine absent from the keywords is
      an engine nobody finds; the chart's own comment says a new engine's keyword belongs in the release
      that ships it, because #167 otherwise makes a keyword-only fix cost a chart version of its own.
      Two names are often right — the type-id and the product a user would type (`libsql` and `turso`)
- [ ] `operator/helm-charts/libredb-studio/Chart.yaml` — the operator's embedded copy, same edit
- [ ] `operator/config/manifests/bases/libredb-studio-operator.clusterserviceversion.yaml` — the CSV
      `description`, which is what **OperatorHub** shows. **Edit only this file and then run
      `make -C operator bundle`**: `operator/bundle/manifests/...` is generated from it, and the
      `Verify operator bundle is up to date` step re-runs the generator and diffs, so a hand-wrapped
      YAML folded scalar fails the gate even when the text is identical to what it wants
- [ ] `README.md` + the seven translations `bun run readme:check` gates (`README_zh.md`, `README_ja.md`, `README_es.md`, `README_ur.md`, `README_hi.md`, `README_pt.md`, `README_ru.md`), `DOCKERHUB.md`, `docs/BRAND_MESSAGING.md` — the
      engine tables and every prose numeral. **Separate the denominators before touching a numeral**:
      type-ids the factory builds, external drivers (that set minus the embedded store), wire-compatible
      relatives, and their sum. `connectableProductCount()` is the arithmetic's one definition — derive
      from it, and re-read each sentence to see which of the four it counts. A mechanical replace is
      how a correct number becomes wrong: the agent docs' count of the ids grounded through their provider is type-ids minus
      the two `CATALOG_PLANS` dialects and moved for a different reason than the driver count did.
      DuckDB is the sharpest illustration: it moved the type-id count and the driver count, left
      "the fourteen the read-only profile refuses" exactly where it was — because it implements
      `queryReadOnly`, so numerator and denominator both grew by one — and moved the
      `CATALOG_PLANS` remainder, because it is not one of those two dialects
- [ ] the marketplace listings under `deploy/` — a claim that enumerates engines is bound to the file
      that proves it, and the `marketplace-copy` test fails when a plan-capable engine is missing from
      one

Four prose greps find the statements a new engine or relative can make false in the docs and the listings, the way the Kafka provider found them (#1088): G1 the numerals that can count the fleet, in every language the READMEs are written in; G2 every line that names the closest earlier engine, where it joined an enumeration; G3 the JSON-language and dialect sets; G4 every line that names the latest relative.
Run them before the first edit and again before the commit, and re-derive each hit from the set it counts, never by incrementing it:

```bash
OUT=(docs CLAUDE.md CONTRIBUTING.md 'README*.md' DOCKERHUB.md snap packaging desktop deploy charts/libredb-studio operator/config e2e ':!docs/BACKLOG.md' ':!docs/llms')
git grep -n -I -i -E '\b(eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty[- ](one|two|three|four|five|six|seven|eight|nine)|forty[- ](four|five|six|seven|eight|nine)|fifty|fifty[- ](one|two|three|four))\b|\b(1[0-9]|2[0-9]|4[0-9]|5[0-4]) (database backends|database engines|engines|type-ids|providers|drivers)\b|十[七八九]|二十[一二三四五六七八]?|四十[四五六七八九]|五十[一二三四]?|Diecisiete|Dieciocho|Diecinueve|Veinte|veinte|veintiuno|veintidós|veintitrés|veinticinco|veintiséis|veintisiete|veintiocho|cincuenta y (tres|cuatro)|1[789]の|2[0-7]の|सत्रह|अठारह|उन्नीस|बीस|इक्कीस|बाईस|तेईस|पच्चीस|छब्बीस|सत्ताईस|سترہ|اٹھارہ|انیس|بیس|اکیس|بائیس|تئیس|پچیس|چھبیس|ستائیس|Dezoito|Dezenove|Vinte|vinte e (um|dois|três|cinco|seis|sete)|cinquenta e (três|quatro)|Восемнадцат|Девятнадцат|Двадцат|пятьдесят (три|четыре)' -- "${OUT[@]}"   # G1
git grep -n -I -E 'Oxia|oxia' -- "${OUT[@]}"   # G2, the closest earlier engine (Oxia, for the next provider)
git grep -n -I -i -E 'redis and libredb|redis, libredb|libredb and redis|mongodb and redis|mongodb, redis|redis and mongodb|dialect of (its|their) own|queryDialect' -- "${OUT[@]}"   # G3
git grep -n -I -E 'Redpanda|redpanda' -- "${OUT[@]}"   # G4, the latest relative
```

The numerals of G1 move with each engine, so widen its word list to the next one before running it.

**And the tests for every exhaustive map**, which are the real checklist — several are exhaustive
*by construction* (`Record<DatabaseType, …>` in `db-ui-config`, `PICKER_COVERAGE` in the
connection-form test), so the compiler and those tests refuse to pass until each is updated:
`tests/isolated/factory.test.ts`, `tests/unit/lib/db-ui-config.test.ts`,
`tests/unit/lib/db-icons.test.tsx`, `tests/unit/lib/connection-string-parser.test.ts`,
`tests/unit/lib/query-generators.test.ts`, `tests/unit/seed/types.test.ts`,
`tests/hooks/use-connection-form.test.ts`,
`tests/unit/schema-diff/migration-generator.test.ts` (`MODIFIED_COLUMN_COVERAGE` — classify the new id
as having its own dialect branch or as unable to express a column modification; and
`TRANSACTION_WRAPPER_COVERAGE` — classify it as `"wrapped"` or `"unwrapped"`, matching whatever you
chose in `NO_TRANSACTION_WRAPPER`),
`tests/unit/sql/grammar.test.ts` (`GRAMMAR_COVERAGE` and `SQL_TEXT_COVERAGE` — record whether the id
has an established grammar or reads at the default, and whether its query text is SQL).

> **`git grep -l <the-previous-provider-type-id> -- src/ tests/` is the authoritative checklist.**
> This list is maintained by hand and has been wrong before: it long claimed "no other files should
> need changes", while Couchbase (#263) and ClickHouse (#264) each touched 27 files under `src/` and
> `tests/`, and Druid (#265) roughly two dozen of its own. Trust the grep over this list.
>
> Cassandra (#424 Phase 4) found three surfaces the grep over `trino` reached and this list does not
> name, all of them because it added a connection FIELD (`localDataCenter`) rather than only a
> type-id: `src/hooks/use-connection-payload.ts` and `src/lib/storage/connection-secrets.ts` both
> carry an exhaustive `Record<keyof DatabaseConnection, …>` that stops compiling until the new field
> is classified, and `src/lib/seed/connection-filter.ts` maps seed fields onto a connection BY HAND,
> so a field omitted there is silently dropped from every managed connection. The first two fail
> `typecheck`; the third fails nothing at all, which is why it now has a test.

What the Strategy Pattern *does* spare you is **provider logic**: no route, no shared component and no
existing provider needs to know your engine exists. If you find yourself adding a `=== '<type-id>'`
check in a route, a component or a utility, that is the abstraction being bypassed — express it as a
capability or a label instead. Registration is the part it does not spare you, and the grep above is
how you find all of it.
