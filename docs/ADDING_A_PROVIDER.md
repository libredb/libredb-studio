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
   establish before you start. Two shipped providers need no driver: SQLite uses the built-in
   `bun:sqlite`/`node:sqlite` via `sqlite-driver.ts`, and Couchbase talks to the cluster over
   documented REST endpoints with `fetch`/`node:https` ([couchbase.md](./providers/couchbase.md)).
   If it does need one, it will be something like `pg`, `mysql2`, `mongodb`, `ioredis`, `oracledb`
   or `mssql`.

2. **Which base class?**
   - **SQL databases → extend `SQLBaseProvider`.** It is
     [153 lines](../src/lib/db/providers/sql/sql-base.ts) of pure SQL text helpers keyed off
     `this.type` — identifier and string escaping, `LIMIT` clause building, placeholder style,
     read-only and DDL detection — plus a `prepareQuery()` that applies the shared query limiter.
     None of it touches a pool, a driver or a connection, so **an HTTP transport is no reason to
     avoid it.** A standard-SQL engine reached over HTTP, such as ClickHouse, should extend it and
     get all of that for free.
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
| 2 | **Is the query language SQL-shaped?** | `queryLanguage: "sql"` gives Monaco highlighting, the `sql` tab type, NL2SQL and saved queries at no cost. The shared query limiter is separate — it comes from `SQLBaseProvider.prepareQuery()`, or you override `prepareQuery()` yourself; the base class default is a pass-through |
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
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'libredb' | 'couchbase';

// After (example: adding CockroachDB):
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql' | 'libredb' | 'couchbase' | 'cockroachdb';
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
| `getPlaceholder()` | `$1` (PostgreSQL) or `?` (MySQL/SQLite) |
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
```

If your engine exposes a documented HTTP API, weigh it against the native driver before adding a
dependency: a native module lands in the Docker image, every native distribution channel, and the
`@libredb/studio` package that libredb-platform consumes.

## Traps specific to HTTP databases

Each of these silently produces wrong output, and each was found by testing against a real server
rather than a mock.

**HTTP 200 does not mean success.** Couchbase returns syntax and semantic errors inside a 200
response with `status: "errors"`, and Trino does the same with a `QueryError` field. Check the
payload before the HTTP status, or a failed statement reads as "0 rows". This is not universal —
Apache Druid uses real 400/500 codes — so establish which behaviour applies before writing the error
path.

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

**Pagination models differ.** Couchbase returns everything in one response; Trino makes the client
poll a `nextUri` until it is absent; Elasticsearch uses `search_after`. The `query()` contract
assumes one shot, so a polling protocol needs a bounded loop inside the transport.

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
- If `supportsExplain` is `true`, `buildSql()` **must not** return `null` for the `analyze` mode. The
  direct Explain action always builds with `analyze`
  ([`use-query-execution.ts:165`](../src/hooks/use-query-execution.ts)) and refuses the run when the
  strategy declines, so the button is dead while only the background pre-warm works. When the engine
  has no analyze equivalent, return the estimate for both modes — `sqlite-queryplan.ts` and
  `couchbase-json.ts` both do exactly that.

The same honesty rule governs monitoring: **a source the connected user cannot read returns empty,
it never throws.** Monitoring catalogs are frequently permission-gated, so a denial is the normal
case for a restricted user and must not break an otherwise working connection.

---

## Verify against a real server

Mock-based tests are the repo standard and they are **not sufficient on their own**. On the
Couchbase provider a live pass against a real cluster disproved a design decision — un-indexed
collections turned out to be queryable on Server 7.6+ through a sequential scan — and found three
defects the mocks had accepted without complaint.

Before opening the PR, drive the provider through the running application against a real server:

- full `INSERT` / `UPDATE` / `SELECT` / `DELETE`, including a `SELECT` immediately after a write, to
  catch read-your-writes problems
- both error paths — a syntax error and a missing object — confirming each surfaces as an error
  rather than as zero rows
- schema introspection, checking column types and the object-naming rule
- the Explain button on a statement that has **never been run**, so a background pre-warm cannot mask
  a broken direct action
- every monitoring panel, and each maintenance operation

Add a service to `database-compose.yml` so the next person can repeat this.

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
| Maintenance | Open Database Maintenance, verify correct operations show |
| AI Assistant | Open AI in QueryEditor, ask a question, verify correct syntax |
| Labels | Check all UI text uses your labels (entity names, actions, etc.) |
| Schema refresh | Run a write query, verify schema reloads if it matches `schemaRefreshPattern` |

## Reference: Interface Contracts

### ProviderCapabilities

Every field and what it controls:

| Field | Type | Controls |
|-------|------|----------|
| `queryLanguage` | `'sql' \| 'json'` | Monaco editor language mode, AI prompt style, query template format |
| `queryDialect` | `'libredb' \| undefined` | Optional. Opts a provider's tables into a custom client-side query generator (see `query-generators.ts`); left undefined by SQL/Mongo/Redis |
| `supportsExplain` | `boolean` | EXPLAIN button visibility in QueryEditor toolbar |
| `explainFormat` | `ExplainFormat \| undefined` | **Required whenever `supportsExplain` is true.** Selects the strategy in `src/lib/explain/index.ts`. Setting the flag without the format leaves the control visible and dead — the UI resets out of explain mode when metadata lacks it |
| `supportsExternalQueryLimiting` | `boolean` | Whether route applies LIMIT to queries (SQL) or provider handles it (MongoDB) |
| `supportsCreateTable` | `boolean` | "Create Table" button in SchemaExplorer |
| `supportsMaintenance` | `boolean` | Whether maintenance API accepts requests for this provider |
| `maintenanceOperations` | `MaintenanceType[]` | Which operation cards show in MaintenanceModal (vacuum, analyze, reindex, etc.) |
| `supportsConnectionString` | `boolean` | Used for future connection validation logic |
| `defaultPort` | `number \| null` | Informational; actual UI port comes from `db-ui-config.ts` |
| `schemaRefreshPattern` | `string` | Regex to detect write/DDL queries that should trigger schema reload |

### ProviderLabels

Every field and where it appears:

| Field | Where it appears |
|-------|-----------------|
| `entityName` | "Create {Table}" button title, "{Table} name copied", "{Table} Optimizer" |
| `entityNamePlural` | "{Tables} found" count in MaintenanceModal |
| `rowName` / `rowNamePlural` | "{rows}" count in MaintenanceModal table list |
| `selectAction` | SchemaExplorer dropdown: "Select Top 100" / "Find Documents" |
| `generateAction` | SchemaExplorer dropdown: "Generate Query" / "Generate Find" |
| `analyzeAction` | SchemaExplorer dropdown + MaintenanceModal button title |
| `vacuumAction` | SchemaExplorer dropdown + MaintenanceModal button title |
| `searchPlaceholder` | SchemaExplorer search input placeholder text |
| `analyzeGlobalLabel` | MaintenanceModal "Run Analyze" button text |
| `analyzeGlobalTitle` | MaintenanceModal card title ("Update Statistics") |
| `analyzeGlobalDesc` | MaintenanceModal card description paragraph |
| `vacuumGlobalLabel` | MaintenanceModal "Run Vacuum" button text |
| `vacuumGlobalTitle` | MaintenanceModal card title ("Reclaim Space") |
| `vacuumGlobalDesc` | MaintenanceModal card description paragraph |

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

**[docs/providers/](./providers/README.md)** → postgres · mysql · oracle · mssql · sqlite · redis · mongodb · couchbase · libredb

When implementing a new provider, the closest existing analogue is the best template: a pooled SQL
provider (postgres/mysql), an embedded SQL provider (sqlite), a non-SQL provider (mongodb/redis), or
a driverless provider reached over HTTP (couchbase).

## Driver-free candidates

Assessed against the rubric in [Prerequisites](#prerequisites). Anything not listed almost certainly needs a driver.

| Candidate | Verdict |
|---|---|
| **ClickHouse** ([#264](https://github.com/libredb/libredb-studio/issues/264)) | Scores on all seven, and easier than Couchbase was: a real declared schema so no inference step, a two-level model needing no flattening, and column types carried in the response |
| **Apache Druid** ([#265](https://github.com/libredb/libredb-studio/issues/265)) | Strong, and it returns errors with real HTTP status codes. `EXPLAIN PLAN FOR` returns a native-query translation rather than an operator tree, so it does not fit the existing tree render model |
| **Trino / Starburst** | Highest strategic value — one provider fronts S3, Iceberg, Delta and Hive. Unscheduled on purpose: a catalog is another *system*, so what a connection pins is a product question. Also a `nextUri` polling protocol and a fragmented auth matrix |
| **OpenSearch / Elasticsearch** | HTTP is the only protocol. Needs a dialect decision first: the SQL endpoint is a subset, the native DSL is JSON. OpenSearch is Apache 2.0 and the cleaner primary target |
| **Snowflake / BigQuery / Databricks SQL** | REST SQL APIs exist and the data model fits; auth is the wall (key-pair JWT, service-account signing, OAuth) and that is where the no-dependency promise ends |
| **CouchDB, ArangoDB, SurrealDB, Qdrant, Weaviate** | All HTTP, all non-SQL or only partially SQL. Feasible, but each needs its own query grammar the way MongoDB and LibreDB do |

Contributions are welcome for any of these. Open an issue with the rubric score first, so the design
decisions are settled before code exists — that is what let the Couchbase provider land as a single
reviewable PR.

---

## Quick Reference Checklist

The integration points, all of which need an entry. This is the list the Strategy Pattern does
*not* spare you — provider logic stays self-contained, registration does not:

- [ ] `src/lib/types.ts` — Add to `DatabaseType` union (if not already there)
- [ ] `src/lib/db/providers/<category>/<name>.ts` — **New file:** provider class
- [ ] `src/lib/db/factory.ts` — Add `case` with dynamic import
- [ ] `src/lib/db-ui-config.ts` — Add UI config entry
- [ ] `src/hooks/use-connection-form.ts` — Add to `selectableTypes` array
- [ ] `package.json` — Install driver (`bun add <driver>`; SQLite needs none — uses `bun:sqlite`/`node:sqlite`)

**No other files should need changes.** If you find yourself editing routes, components, or utilities — you're likely bypassing the abstraction. Use `getCapabilities()` and `getLabels()` instead.
