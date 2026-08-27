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
   establish before you start. Seven shipped type-ids need no driver: SQLite uses the built-in
   `bun:sqlite`/`node:sqlite` via `sqlite-driver.ts`, and the rest reach the engine over HTTP with
   nothing but `fetch`/`node:https` — Couchbase over the documented REST endpoints
   ([couchbase.md](./providers/couchbase.md)), ClickHouse over its HTTP interface
   ([clickhouse.md](./providers/clickhouse.md)), Apache Druid over `POST /druid/v2/sql`
   ([druid.md](./providers/druid.md)), Elasticsearch and OpenSearch over their SQL endpoints
   ([elasticsearch.md](./providers/elasticsearch.md) · [opensearch.md](./providers/opensearch.md)),
   and Apache Trino over its own client protocol
   ([trino.md](./providers/trino.md)). If it does need one, it will be something like `pg`,
   `mysql2`, `mongodb`, `ioredis`, `oracledb` or `mssql`.

2. **Which base class?**
   - **SQL databases → extend `SQLBaseProvider`.** It is
     [153 lines](../src/lib/db/providers/sql/sql-base.ts) of pure SQL text helpers keyed off
     `this.type` — identifier and string escaping, `LIMIT` clause building, placeholder style,
     read-only and DDL detection — plus a `prepareQuery()` that applies the shared query limiter.
     None of it touches a pool, a driver or a connection, so **an HTTP transport is no reason to
     avoid it.** A standard-SQL engine reached over HTTP, such as ClickHouse, Apache Druid or Apache Trino,
     should extend it and get all of that for free. Druid is the clearest case of how little is left over:
     double-quoted identifiers and `LIMIT n OFFSET m` are both correct Druid SQL, so
     `escapeIdentifier()` and `buildLimitClause()` are inherited unchanged and `prepareQuery()` is
     the only override — for a single dialect trap, not for the transport.
   - **Non-SQL databases → extend `BaseDatabaseProvider`** directly, like MongoDB and Redis.
   - The one reason a SQL-speaking provider extends `BaseDatabaseProvider` anyway is a dialect the
     shared helpers cannot express. Couchbase is that case: SQL++ quotes identifiers with doubled
     backticks, which `escapeIdentifier()` produces for no existing type, so it owns its quoting in
     `keyspace.ts`. The cost is that it re-implements `prepareQuery()` to get the limiter back
     ([index.ts:336](../src/lib/db/providers/document/couchbase/index.ts)) — duplication worth
     avoiding if your dialect does fit.

3. **Query language?**
   - `'sql'` → Monaco editor uses SQL mode with autocomplete
   - `'json'` → Monaco editor uses JSON mode with MQL-style autocomplete

### Why a driver-free provider is worth the effort

Most databases speak a binary protocol over TCP, and for those the vendor's driver is not optional.
PostgreSQL, MySQL, Oracle (TNS), SQL Server (TDS), MongoDB and Redis (RESP) are all in that
category — a browser could not talk to any of them, and neither can `fetch`.

A minority expose a **first-class HTTP API**. For those the provider needs nothing but the runtime's
own networking, and the saving is concrete rather than aesthetic:

- **No install step to fail.** The Couchbase SDK runs a postinstall that downloads a prebuilt binary
  or compiles from source; in an air-gapped or egress-restricted network that breaks `bun install`.
- **No growth in any distribution channel.** A native module lands in the Docker image, Snap,
  AppImage, Flatpak, deb/rpm, and in the `@libredb/studio` package that libredb-platform inherits.
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
| 3 | **Is there catalog introspection over the same surface?** | Otherwise `getSchema()` has nothing to read |
| 4 | **Is there monitoring data over the same surface?** | Decides how much of the monitoring panel is real rather than honestly empty |
| 5 | **Is there an EXPLAIN?** | Decides `supportsExplain` and whether a strategy is needed |
| 6 | **How complex is auth?** | Basic auth is three lines. SigV4, OAuth2 refresh or Kerberos is a library — and that is usually where the no-dependency promise ends |
| 7 | **Does the data model flatten into `TableSchema`?** | The schema explorer renders a flat list, so a deeper hierarchy has to be flattened into the display name |

A good sanity check for criterion 1: **can a browser talk to it?** Couchbase's own Web Console and
the Capella UI are browser applications, so every service had to be reachable over HTTP for the
vendor's own product to work at all. That is the strongest available evidence the API is first-class
rather than an afterthought.

---

## Driver-free providers: the transport seam

Provider logic must never call `fetch` directly. It goes through an interface with a single
implementation, so that adopting a native driver later is an additive change rather than a rewrite.
See [`couchbase/transport.ts:87`](../src/lib/db/providers/document/couchbase/transport.ts):

```ts
interface XTransport {
  readonly kind: "http" | "native";   // widen as implementations appear

  query(stmt: string, o?: QueryOpts): Promise<XQueryResult>;
  manage<T>(path: string): Promise<T>;
  close(): Promise<void>;
}
```

**Make the result type neutral, not the wire envelope.** An interface shaped like the HTTP response
(`{ results, signature, status, metrics, errors }`) would force any future driver adapter to
fabricate fields that only the REST API produces naturally. Define the shape both sources could
produce without inventing anything ([`transport.ts:45`](../src/lib/db/providers/document/couchbase/transport.ts)):

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

## Step 1: Register the Database Type

### 1.1 — Add to `DatabaseType` union

**File:** `src/lib/types.ts`

```typescript
// Before:
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'libsql' | 'duckdb' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'libredb' | 'couchbase' | 'clickhouse' | 'druid' | 'elasticsearch' | 'opensearch' | 'trino' | 'cassandra';

// After (example: adding CockroachDB):
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'libsql' | 'duckdb' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'libredb' | 'couchbase' | 'clickhouse' | 'druid' | 'elasticsearch' | 'opensearch' | 'trino' | 'cassandra' | 'cockroachdb';
```

### 1.2 — Add to `QueryTab.type` if needed

**File:** `src/lib/types.ts`

If your database uses a new editor mode (not `'sql'` or `'mongodb'`), add it:

```typescript
export interface QueryTab {
  // ...
  type: 'sql' | 'mongodb' | 'redis' | 'libredb';  // Add your type here if needed
}
```

For most SQL databases, the existing `'sql'` type is sufficient. You only need a new tab type if your database uses a fundamentally different query language.

A new tab type needs three things wired, all in `src/lib/editor/tab-language.ts` and its neighbours:
declare `queryDialect` on the provider, add the arm to `resolveTabType()` **above** the
`queryLanguage === 'json'` rung, and map the type to a Monaco language in
`editorLanguageForTabType()` — registering that language module in `QueryEditor`'s
`handleBeforeMount` alongside `registerLibreDBLanguage` / `registerRedisLanguage`. Skipping the
dialect leaves the tab typed `mongodb` and the arm unreachable, which is exactly what #427 fixed.

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

**Implement the abstract methods** from the `DatabaseProvider` interface: `connect`, `disconnect`,
`query`, `getSchema`, `getHealth`, `runMaintenance`, plus the monitoring set (`getOverview`,
`getPerformanceMetrics`, `getSlowQueries`, `getActiveSessions`, `getTableStats`, `getIndexStats`,
`getStorageStats`). None can be omitted, but a method whose data your engine does not expose returns
a neutral value rather than throwing. Mind the return types: the list-valued ones
(`getSlowQueries`, `getActiveSessions`, `getTableStats`, `getIndexStats`, `getStorageStats`) return
`[]`, while `getOverview()` and `getPerformanceMetrics()` return DTOs and need a zeroed object.
`libredb.ts` is the reference for doing this honestly.

**Override the metadata hooks** so the shared UI renders correctly:

- `getCapabilities()` — query language (`sql` | `json`), `defaultPort`, supported `maintenanceOperations`, the `supportsExplain`/`supportsConnectionString`/`supportsCreateTable` flags, and `schemaRefreshPattern`.
- `getLabels()` — only if the generic SQL wording ("Table" / "row" / "Select Top 50" / …) doesn't fit. Non-relational providers relabel it (Redis → "Key Pattern"/"key", MongoDB → "Collection"/"document").
- `prepareQuery()` — only if your dialect needs non-standard pagination. SQL `LIMIT` injection is inherited from `SQLBaseProvider`; Oracle/SQL Server override it for `FETCH FIRST` / `TOP`; the non-SQL providers make it a metadata-only pass-through.

Wrap native driver errors with `mapDatabaseError(err, '<type-id>', query)` — the 3rd argument is the
raw query string (SQL **or** JSON, per `src/lib/db/errors.ts`) — so they normalise onto the shared
error classes. For the exact DTO shapes see [Reference: Interface Contracts](#reference-interface-contracts);
for worked, code-verified examples see each provider's **Design decisions** section in
[`docs/providers/`](./providers/README.md).


### What the base class gives you for free

| Method | What it does |
|--------|-------------|
| `isConnected()` | Returns `this.state.connected` |
| `getTables()` | Calls `getSchema()` and extracts table names |
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
| `positionalPlaceholder()` ([`src/lib/sql/values.ts`](../src/lib/sql/values.ts), not inherited) | `$1` (PostgreSQL, Couchbase), `?` (MySQL, SQLite, Druid), `:1` (Oracle), `@p1` (SQL Server), `null` where the engine has no positional form |
| `shouldEnableSSL()` | Auto-detects cloud providers |
| `prepareQuery()` | Automatically injects LIMIT into SELECT queries |

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
# Apache Trino needs no driver — SQL over its client protocol, POST /v1/statement (port 8080)
# libSQL needs no driver — SQLite's dialect over the Hrana protocol, POST /v2/pipeline (port 8080)
# bun add cassandra-driver  (Apache Cassandra — a binary protocol over TCP, so a driver is not
#                            optional; this one is pure JS, which is the next best thing)
# bun add @duckdb/node-api  (DuckDB — an embedded engine, so there is no protocol at all and no
#                            HTTP alternative; this one is a NATIVE N-API addon)
```

If your engine exposes a documented HTTP API, weigh it against the native driver before adding a
dependency: a native module lands in the Docker image, every native distribution channel, and the
`@libredb/studio` package that libredb-platform consumes.

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
server offers no switch.

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
- If `supportsExplain` is `true`, `buildSql()` **must not** return `null` for the `analyze` mode. The
  direct Explain action always builds with `analyze`
  ([`use-query-execution.ts:165`](../src/hooks/use-query-execution.ts)) and refuses the run when the
  strategy declines, so the button is dead while only the background pre-warm works. When the engine
  has no analyze equivalent, return the estimate for both modes — `sqlite-queryplan.ts` and
  `couchbase-json.ts` both do exactly that.
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
| `queryLanguage` | `'sql' \| 'json'` | Monaco editor language mode, AI prompt style, query template format |
| `queryDialect` | `'libredb' \| 'redis' \| undefined` | Optional. Opts a provider's tables into a custom client-side query generator (see `query-generators.ts`) and picks the editor tab type and Monaco language. Checked **before** `queryLanguage` everywhere — `queryLanguage: 'json'` alone means MongoDB, which is how Redis silently got MongoDB documents until #427. Left undefined by SQL and MongoDB |
| `supportsExplain` | `boolean` | EXPLAIN button visibility in QueryEditor toolbar |
| `explainFormat` | `ExplainFormat \| undefined` | **Required whenever `supportsExplain` is true.** Selects the strategy in `src/lib/explain/index.ts`. Setting the flag without the format leaves the control visible and dead — the UI resets out of explain mode when metadata lacks it |
| `supportsExternalQueryLimiting` | `boolean` | Whether route applies LIMIT to queries (SQL) or provider handles it (MongoDB) |
| `supportsCreateTable` | `boolean` | "Create Table" button in SchemaExplorer |
| `supportsInlineRowEdit` | `boolean?` | Whether the results grid offers inline row editing. `false` hides the EDIT toggle and every editable cell — set it where the engine has no `UPDATE <table> SET <col> = <val> WHERE <pk> = <val>` statement, which is what `use-inline-editing.ts` builds. Optional only because the interface is published and a required addition breaks external implementers; every provider here declares it, and an absent flag reads as unsupported |
| `supportsTransactions` | `boolean?` | Whether THIS PROVIDER implements the interactive transaction session `POST /api/db/transaction` drives (`beginTransaction`/`commitTransaction`/`rollbackTransaction` over one held connection). `false` withholds the editor toolbar's BEGIN/COMMIT/ROLLBACK trio **and** the SANDBOX toggle, which auto-rolls-back through the same route. It is about the provider's surface, not the engine: SQLite has `BEGIN` and still declares `false`. Optional for the published-interface reason above; the UI gates on `=== true`, so an absent flag and an unresolved metadata fetch both read as no transactions (#464) |
| `declaresForeignKeys` | `boolean?` | Whether this engine has foreign keys in its model at all. `false` says an empty `TableSchema.foreignKeys` means "no such constraint exists here", not "this schema declares none" — set it on every engine without referential constraints. Optional for the published-interface reason above; consumers gate on `=== false`, so an absent flag reads as "may declare them" |
| `tablesAreDerivedGroupings` | `boolean?` | Whether `getSchema()`'s rows are objects the engine holds, or groupings this server derived from a bounded scan. `true` on Redis and LibreDB only. Where it is true the schema explorer hides every menu item that *addresses* the row — `Profile Table`, `Generate Test Data`, and both per-row maintenance items, all of which name the row to a route that needs a real object — and keeps the ones that merely name it (`Select`, `Generate`, `Copy Name`, `Generate Code`). The agent layer states it to a plan run in one sentence. Consumers gate on `=== true`, so an absent flag reads as "ordinary objects" |
| `supportsMaintenance` | `boolean` | Whether maintenance API accepts requests for this provider |
| `maintenanceOperations` | `MaintenanceType[]` | Which global cards and per-table buttons the admin Operations tab renders. `/api/db/maintenance` rejects anything not in this list, so a surface that ignored it could only offer a control answering HTTP 400. The schema explorer's row menu does **not** read it — its per-row maintenance items are gated on `isAdmin` and on `tablesAreDerivedGroupings`; see #496 for the mismatches that leaves |
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
| `vacuumAction` | `TableItem` row menu only, under the same derived-groupings gate as `analyzeAction`, and not read by the Operations tab either. That button is gated on the literal `vacuum` and worded from `maintenanceOperationSpecs.vacuum.label`, so the four providers that point this label at `optimize`/`reindex` via `vacuumActionOperation` show a row item whose wording the tab does not repeat (#496) |
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
after the fact stops every external implementer compiling; only the three providers that declare the
`reindex` operation (Postgres, SQLite, Couchbase) set it, and the card keeps its old strings as the
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
| `wasLimited` | Whether a LIMIT was injected (shown as warning badge in UI) |
| `limit` | The effective row limit |
| `offset` | The effective offset |

## Reference: Existing Providers

For the authoritative, code-verified reference for each shipped provider (extends-which-base,
driver, pooling, capabilities, labels, `prepareQuery` behaviour, and limitations), see the prime
docs — they are the single source of truth and are kept in sync with the code:

**[docs/providers/](./providers/README.md)** → postgres · mysql · oracle · mssql · sqlite · libsql · duckdb · redis · mongodb · couchbase · clickhouse · druid · elasticsearch · opensearch · trino · cassandra · libredb

When implementing a new provider, the closest existing analogue is the best template: a pooled SQL
provider (postgres/mysql), an embedded SQL provider (sqlite), a non-SQL provider (mongodb/redis), or
a driverless provider reached over HTTP (clickhouse, druid or trino for SQL, couchbase for a
document store).

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
([#424](https://github.com/libredb/libredb-studio/issues/424), Phase 1) Apache Trino
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
| **CouchDB, ArangoDB, SurrealDB, Qdrant, Weaviate** | All HTTP, all non-SQL or only partially SQL. Feasible, but each needs its own query grammar the way MongoDB and LibreDB do |

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
      seven shipped ids do: `couchbase`, `clickhouse`, `druid`, `elasticsearch`, `opensearch`, `trino`
      and `libsql`
      each add nothing here
- [ ] `database-compose.yml` — a service, so the next person can repeat the live pass. A distributed
      engine contributes a `profiles: [...]` set instead, as Druid's seven services do, so the default
      stack does not grow for everyone. An EMBEDDED engine gets no service at all — SQLite, DuckDB and
      LibreDB are files rather than servers — but say so in a comment there, or the next reader reads
      the absence as an oversight. Check what the image ships before writing a healthcheck: the
      ClickHouse image has no `curl` and the Trino image ships its own `health-check` script that waits
      for `"starting": false`, which a bare `curl /v1/info` would not

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
      dialect a branch, or list it in `NO_COLUMN_MODIFICATION` to emit an honest comment instead
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

**Published where a human reads it, and this is the block with the fewest gates.** `readme:check`
compares the translated READMEs against `README.md` and `chart:check` compares versions. Nine of the
catalog files below are now counted as well:
[`tests/unit/lib/catalog-copy-engine-count.test.ts`](../tests/unit/lib/catalog-copy-engine-count.test.ts)
walks them, refuses a numeral qualifying "engines" that is not `EXTERNAL_DATABASE_TYPES.length`, and
where that numeral introduces a list, refuses a list that does not name every one of them by its
`DB_UI_CONFIG` label (#D47 - added after three consecutive PRs corrected the same class by hand; the
#511 review found all nine stale after libSQL had already landed everywhere the compiler looks). The
files NOT in that walk have no gate at all, and an abridged list ("and more", or a "from X to Y"
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
- [ ] `README.md` + `README_zh.md` + `README_ja.md`, `DOCKERHUB.md`, `docs/BRAND_MESSAGING.md` — the
      engine tables and every prose numeral. **Separate the denominators before touching a numeral**:
      type-ids the factory builds, external drivers (that set minus the embedded store), wire-compatible
      relatives, and their sum. `connectableProductCount()` is the arithmetic's one definition — derive
      from it, and re-read each sentence to see which of the four it counts. A mechanical replace is
      how a correct number becomes wrong: the agent docs' "the other fifteen" counts type-ids minus
      the two `CATALOG_PLANS` dialects and moved for a different reason than the driver count did.
      DuckDB is the sharpest illustration: it moved the type-id count and the driver count, left
      "the fourteen the read-only profile refuses" exactly where it was — because it implements
      `queryReadOnly`, so numerator and denominator both grew by one — and moved the
      `CATALOG_PLANS` remainder, because it is not one of those two dialects
- [ ] the marketplace listings under `deploy/` — a claim that enumerates engines is bound to the file
      that proves it, and the `marketplace-copy` test fails when a plan-capable engine is missing from
      one

**And the tests for every exhaustive map**, which are the real checklist — several are exhaustive
*by construction* (`Record<DatabaseType, …>` in `db-ui-config`, `PICKER_COVERAGE` in the
connection-form test), so the compiler and those tests refuse to pass until each is updated:
`tests/unit/db/factory.test.ts`, `tests/unit/lib/db-ui-config.test.ts`,
`tests/unit/lib/db-icons.test.tsx`, `tests/unit/lib/connection-string-parser.test.ts`,
`tests/unit/lib/query-generators.test.ts`, `tests/unit/seed/types.test.ts`,
`tests/hooks/use-connection-form.test.ts`,
`tests/unit/schema-diff/migration-generator.test.ts` (`MODIFIED_COLUMN_COVERAGE` — classify the new id
as having its own dialect branch or as unable to express a column modification),
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
