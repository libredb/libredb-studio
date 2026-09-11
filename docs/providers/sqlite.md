# SQLite Provider

> File-based SQLite support for LibreDB Studio, using the runtime's **built-in SQLite driver**:
> `bun:sqlite` under Bun, `node:sqlite` under Node (see [Runtime](#runtime--driver-selection)).
> This document is the single reference point for the SQLite provider: design, architecture, usage,
> and tests. It is a SQL-family provider sharing `SQLBaseProvider`; read the
> [PostgreSQL doc](./postgres.md) first for the canonical SQL walkthrough, then this doc for the
> SQLite-specific deltas and — importantly — its **deployment constraints**.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `sqlite` |
| **Family** | SQL (relational, **embedded / file-based**) |
| **Driver** | **`bun:sqlite`** under Bun / **`node:sqlite`** under Node (both runtime built-ins, selected by the [`sqlite-driver`](../../src/lib/db/providers/sql/sqlite-driver.ts) adapter) — *not* `better-sqlite3` |
| **Query language** | `sql` |
| **Default port** | `null` (no network listener) |
| **Connection** | A **server-local file path** (or `:memory:`) — **not** a network endpoint |
| **Connection string** | `false` (capability) — but a `file:`/path string is accepted in the `connectionString` field |
| **Transactions** | ❌ no explicit begin/commit/rollback API |
| **Query cancellation** | ❌ none (synchronous, embedded) |
| **Pooling** | ❌ none (single connection) |
| **Agent read-only profile** | Yes — separate read-only OPEN (no file create) + verified `query_only` (#328, §12) |
| **Source** | [`src/lib/db/providers/sql/sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts) |
| **Tests** | [`tests/integration/db/sqlite-provider.test.ts`](../../tests/integration/db/sqlite-provider.test.ts) |

---

## 0. Read this first — what SQLite is (and isn't) here

SQLite shows up in this codebase in **two unrelated roles**. Don't conflate them:

1. **Storage backend for Studio's own data** (`STORAGE_PROVIDER=sqlite`) — persists connections,
   history, and settings. Uses **`better-sqlite3`** (Node-compatible, works in the production
   runner). This is internal infrastructure, documented under the storage layer, **not** this doc.
2. **A target database you connect to and query** (`type: 'sqlite'`) — *this* document. Uses the
   runtime's built-in driver (**`bun:sqlite`** or **`node:sqlite`**, see
   [Runtime](#runtime--driver-selection)).

### Deployment constraint (the strategic bit)

⚠️ SQLite is an **embedded, file-based** engine with **no network protocol**. Two hard consequences
for a web-based editor:

- **The database file must live on the server's filesystem.** A remote user of a hosted/SaaS
  deployment cannot point Studio at a SQLite file on *their own* machine — there is nothing to
  connect to over the network. SQLite-as-target therefore fits **self-hosted / Docker / local-dev /
  edge** deployments (where the file is co-located with Studio) and **zero-config trials** (instant,
  no server to provision) — it is **not** a multi-tenant SaaS target.
- **It works under both Bun and Node.** The provider selects the runtime's built-in driver at
  connect time — see [Runtime & driver selection](#runtime--driver-selection). All packaged
  distribution channels — the official Docker image, `npx @libredb/studio`, the Homebrew tap, the
  `.deb`/`.rpm` packages, and the standalone tarballs — run the built app with `node server.js` (the
  Docker image's runner stage is `node:26.8.1-trixie-slim`; the other channels bundle their own pinned
  Node 24 runtime), so they all use `node:sqlite`. `bun:sqlite` is used for local development
  (`bun dev`) and the test suite, where Next.js runs directly under Bun. Only on a runtime with
  neither driver does `connect()` throw a `DatabaseConfigError`.

Position it accordingly: a developer-friendly, works-everywhere, frictionless-onboarding feature —
not an enterprise/SaaS headline.

### Runtime & driver selection

The provider talks to a tiny internal driver adapter,
[`sqlite-driver.ts`](../../src/lib/db/providers/sql/sqlite-driver.ts), which picks the embedded
SQLite driver by runtime:

| Runtime | Driver | Notes |
|---------|--------|-------|
| Bun (`typeof Bun !== "undefined"`) | `bun:sqlite` | Bun built-in |
| Node | `node:sqlite` (`DatabaseSync`) | Node built-in: unflagged from 22.13, stable on the Node 24 LTS floor |

- **Override:** set `LIBREDB_SQLITE_DRIVER=bun|node` to force a driver (used by the integration
  tests for determinism); any other value falls back to runtime detection.
- **Lazy:** both drivers load via dynamic import inside `connect()`, so neither is touched unless a
  sqlite connection is actually used.
- **Identical behaviour:** the adapter exposes the exact `bun:sqlite`-shaped surface the provider
  uses (`exec` / `prepare().all/get/run` / `close`) and bridges the small `node:sqlite` deltas
  (`get()` miss returns `null` not `undefined`; `run().changes` normalized to `number`), so results
  and error mapping are the same under both runtimes.
- **Why not `better-sqlite3`?** Bun refuses to load it outright, and its native binding must match
  the installing runtime's ABI (a bun-installed binding fails under Node). The built-in drivers
  need no native dependency at all. (`better-sqlite3` remains the *storage-layer* driver.)

---

## 1. Overview

As a relational engine SQLite maps cleanly onto the interface, but as an *embedded* engine it omits
everything that assumes a server. Read this as a **diff against the [PostgreSQL provider](./postgres.md)**:

| Aspect | PostgreSQL | SQLite |
|--------|------------|--------|
| Connection | network host/port | **server-local file** (or `:memory:`) |
| Driver | `pg` | **`bun:sqlite`** / **`node:sqlite`** (runtime built-ins) |
| Pooling | `pg.Pool` | none (one `Database` handle) |
| Transactions API | begin/commit/rollback + auto-rollback | **none exposed** |
| Cancellation | `pg_cancel_backend` | **none** |
| `EXPLAIN` | `true` | `true` (EXPLAIN QUERY PLAN) |
| Connection string | `true` | `false` (path accepted in the field, but flagged unsupported) |
| Schema scope | many schemas | single (`main`) |
| Monitoring | rich `pg_stat_*` | minimal (PRAGMAs + file stats; many fields `N/A`, no cache-hit ratio at all) |

---

## 2. Architecture

Standard SQL hierarchy:

```
DatabaseProvider (interface) → BaseDatabaseProvider → SQLBaseProvider → SQLiteProvider
```

`SQLiteProvider` inherits the shared SQL helpers (see
[PostgreSQL doc §2.2](./postgres.md#22-what-sqlbaseprovider-provides)). It does **not** override
`prepareQuery()`: SQLite uses standard `LIMIT`, so the base's `LIMIT` injection works. `getLabels()`
is overridden for **two** things only — the slow-query empty state and the global reindex wording
([§9](#9-capabilities--labels)) — because the rest of the default SQL wording fits (*Vacuum Table* /
*Analyze Table*, since SQLite has real `VACUUM`/`ANALYZE`).

### Dynamic driver load

The driver is imported lazily via `loadSQLiteDriver()`
([sqlite-driver.ts](../../src/lib/db/providers/sql/sqlite-driver.ts)), which caches the constructor
(and any load failure) per driver name. Selection is runtime-based (`bun:sqlite` under Bun,
`node:sqlite` under Node) with a `LIBREDB_SQLITE_DRIVER=bun|node` override — see
[Runtime & driver selection](#runtime--driver-selection). If the selected driver cannot load, a
`DatabaseConfigError` is thrown.

### Registration

```ts
// factory.ts
case "sqlite": {
  const { SQLiteProvider } = await import("./providers/sql/sqlite");
  return new SQLiteProvider(connection, options, execution);
}
```

`execution` is the server-injected [`ProviderExecutionContext`](../../src/lib/db/types.ts) — empty
on the normal path, and carrying the read-only flag only when
`acquireExecutionProfileProvider` builds an agent provider ([§12](#12-agent-read-only-execution-profile-328)).

---

## 3. Design decisions

### 3.1 File path resolution & the admin-trusted path model

`getDatabasePath()` ([`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts)) resolves the target:
`connectionString` (stripping a `file:` prefix) → else `database` → else `:memory:`. Non-`:memory:`
paths are `path.resolve()`-d to an absolute path and **rejected if they contain a NUL byte**. Parent
directories are created on connect.

> **NUL rejection is the only path validation — by design.** `../` segments are legal and simply
> resolve into the absolute path. This follows the feature's trust model: a connection's
> `database`/`connectionString` path is set by whoever configures the connection (an
> authenticated user of this Studio instance) — pointing Studio at an arbitrary server-side file is
> the intended capability, not attacker-controlled input from an untrusted client. There is
> currently **no** option to sandbox resolvable paths to a base directory. See
> [Known limitations](#14-known-limitations--future-work).

### 3.2 PRAGMAs on connect

`connect()` ([`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts)) opens the file with
`{ create: true, readwrite: true }` and sets
`PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`
— FK enforcement on, WAL for better
concurrency, NORMAL sync for a speed/durability balance. The agent read-only profile runs a
different open sequence entirely — `journal_mode = WAL` is itself a write and fails on a read-only
handle ([§12.1](#121-where-the-boundary-is)).

### 3.3 Read vs write dispatch

`query()` ([`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts)) branches on
`isReadOnlyQuery(sql)` (inherited): reads use `stmt.all()` and return rows; writes use `stmt.run()`
and return `{ changes }`. `rowCount = rows.length || changes`. Both drivers are **synchronous** —
the provider wraps them in the async signature but there is no real concurrency or cancellation.

The inherited predicate reads the statement's first keyword past any leading comment
(`src/lib/sql/leading-keyword.ts`), so an annotated `SELECT` takes the read branch. It previously
took the **write** branch and returned an empty result with `changes: 0` for a query that has rows.

### 3.4 No transactions API, no cancellation, no pool

Unlike every networked SQL provider, SQLite exposes **no** `beginTransaction`/`commit`/`rollback`/
`queryInTransaction`, **no** `cancelQuery`, and **no** pool/`getPoolStats`. It is a single embedded
handle. (`POST /api/db/transaction` and `/api/db/cancel` are therefore not applicable to SQLite.)

Since #464 the client can see that: `supportsTransactions: false`
([§9](#9-capabilities--labels)) is what withholds BEGIN/COMMIT/ROLLBACK and the auto-rolled-back
SANDBOX toggle from the editor toolbar here. Before that flag existed the only gate was
`isTransactionProvider(provider)` inside the route — a runtime shape check the browser cannot read —
so the controls rendered on every connection and the route answered HTTP 400.

---

## 4. Connection

```ts
// On-disk file (server-local path)
const a = { id: 'lite-1', name: 'App', type: 'sqlite',
  database: '/data/app.db', createdAt: new Date() };

// In-memory (ephemeral; great for trials/tests)
const b = { id: 'lite-2', name: 'Scratch', type: 'sqlite',
  database: ':memory:', createdAt: new Date() };

// file: URL form (via the connectionString field)
const c = { id: 'lite-3', name: 'App', type: 'sqlite',
  connectionString: 'file:/data/app.db', createdAt: new Date() };
```

`validate()` ([`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts)) requires either `database`
or `connectionString` (else "Database file path is required … or `:memory:`"). Note
`getCapabilities().supportsConnectionString` is `false`, yet `connectionString` *is* honoured as a
path by `getDatabasePath()` — the flag reflects that there is no network DSN, not that the field is
ignored.

**From the UI.** SQLite is offered in the connection modal's type picker
([`src/hooks/use-connection-form.ts`](../../src/hooks/use-connection-form.ts)). Because its
`connectionFields` entry is just `["database"]`, `isFileBased()`
([`src/lib/db-ui-config.ts`](../../src/lib/db-ui-config.ts)) collapses the form to a single
**"Database File Path"** input — no host, port, user, or password. Two things to be clear about with
users:

- **The path is resolved on the server, not in the browser.** It is passed through to
  `getDatabasePath()` in the Studio process, so `/data/app.db` means that path on the machine
  running Studio. A remote user of a hosted deployment cannot reach a file on their own laptop —
  see [Deployment constraint](#deployment-constraint-the-strategic-bit).
- **`:memory:` is accepted here too**, which makes the modal a zero-setup way to get a scratch
  database for trying out the editor.

Exposing the type in the picker grants no new server-side reach: the connection travels in the
request body and `resolveConnection()` accepts `type: "sqlite"` regardless of what the form offers,
so the picker was never a security control. What it does change is **discoverability**. On a shared
self-hosted instance, every authenticated user now sees a field for typing an arbitrary server-side
path, where reaching the same capability previously took a hand-crafted API call. The reachable set
of files is identical either way — see
[No path sandboxing](#14-known-limitations--future-work) — but operators of multi-user deployments
should treat "any logged-in user can open any SQLite file the Studio process can read" as an
explicit assumption to check against their threat model, not a corner case. Where that assumption
does not hold, the mitigations available today are OS-level: run Studio as a user with a narrow
read scope, or isolate it in a container whose mounts contain only the databases it should serve.
An optional in-app base-dir allowlist is tracked in
[issue #125](https://github.com/libredb/libredb-studio/issues/125).

### 4.1 Embedded sample database (standalone mode)

On standalone startup (never when embedded in libredb-platform),
[`src/lib/seed/sqlite-sample.ts`](../../src/lib/seed/sqlite-sample.ts) copies the vendored
employees database ([`seed-assets/sqlite/employee.db`](../../seed-assets/sqlite/employee.db),
from [bytebase/employee-sample-database](https://github.com/bytebase/employee-sample-database)
`dataset_small`, originally [datacharmer/test_db](https://github.com/datacharmer/test_db) — see
[`seed-assets/sqlite/ATTRIBUTION.md`](../../seed-assets/sqlite/ATTRIBUTION.md)) to
`<data dir>/sample-employees.db` and `getManagedConnections()` advertises it as an editable,
dismissable "Sample (Employees)" connection (`type: "sqlite"`, `managed: false`, `roles: ["*"]`).

Unlike the LibreDB sample, the copy runs **asynchronously and fail-open**: `register()`
fires-and-forgets the seed (start/completion/duration are logged), boot never waits on it, and a
failure only logs a warning — the sample is then silently absent. While the copy is in flight the
managed-connections API reports the seed id in `pendingSeeds` and the client polls (1s, up to 30
attempts) so the connection appears in the sidebar without a page refresh.

Env vars:

| Variable | Default | Notes |
|----------|---------|-------|
| `SQLITE_EMBEDDED_SAMPLE` | `true` | Only the literal `false` disables |
| `SQLITE_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample-employees.db` | Runtime copy location |
| `SQLITE_EMBEDDED_SAMPLE_TEMPLATE` | `<cwd>/seed-assets/sqlite/employee.db` | Vendored template location (packaging overrides) |

The template ships as a top-level `seed-assets/` directory in every distribution payload
(Docker image, standalone tarball, and everything derived from it: npx, deb/rpm, snap,
Homebrew). Each channel is browser-verified by
[`scripts/channel-embedded-sample-e2e.sh`](../../scripts/channel-embedded-sample-e2e.sh)
(see [`docs/DISTRIBUTION.md`](../DISTRIBUTION.md)).

---

## 5. Query interface

`query(sql, params?)` — positional params via the driver's `all()`/`run()`. There is no
`prepareQuery()` override, so the inherited base injects a `LIMIT` into bare `SELECT`s
(`DEFAULT_QUERY_LIMIT = 500`). No transactions, no cancellation ([§3.4](#34-no-transactions-api-no-cancellation-no-pool)).

The inherited path reads the statement under **SQLite's** grammar, which the base passes down from the
provider's own `type` ([`grammar.ts`](../../src/lib/sql/grammar.ts)). SQLite has two comment forms,
`--` and `/* … */`; `#` opens neither. Its own tokenizer (the amalgamation bundled with
`better-sqlite3` classifies `#` as `CC_VARALPHA`) reads `#name` as a bind variable, i.e. code. The
shared reader used to guess MySQL's rule here, which swallowed the rest of the line and cost the
statement its bound, so `SELECT * FROM users WHERE id = #id` returned every row; it is now bounded,
emitted intact (#292). See
[Which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading).

The same tokenizer settles this dialect's second grammar fact: `[` is `CC_QUOTE2` there — "`[...]` style
quoted ids", the Microsoft-style form SQLite accepts for compatibility — so **`[…]` is a quoted name
here**, not ClickHouse's nestable array (#295). Everything between the brackets is the name, apostrophe
and comment marker included, so `SELECT [it's] FROM users` and `SELECT [a--b] FROM users` are both
bounded with the clause written after the whole name. One deliberate divergence: SQLite's tokenizer
stops at the FIRST `]` and has no escape, while this reader honours SQL Server's doubled bracket, so
`[a]]b]` reads as one name where SQLite reads `[a]` followed by junk. SQLite rejects that text either
way, so the longer reading can only ever cost a bound — and, where the doubled bracket swallows the
real closer so the run never terminates (`SELECT [a]] FROM t`), a confirmation prompt as well, since
#297 asks about text the reader cannot resolve. Both are on statements the server refuses, and both are
pinned by tests rather than left to be discovered.
`EXPLAIN QUERY PLAN` is supported (`supportsExplain: true`, `explainFormat: "sqlite-queryplan"`) — the UI renders the plan as a tree; SQLite reports no per-node cost or timing metrics, so none are shown.

---

## 6. Schema introspection

`getSchema()` ([`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts)) reads `sqlite_master`
(excluding `sqlite_*` internal objects) and, per table, runs the SQLite PRAGMAs:

| Data | Source |
|------|--------|
| Tables | `sqlite_master` (`type = 'table'`) |
| Row count | `SELECT COUNT(*)` per table |
| Columns | `PRAGMA table_info` (`isPrimary` = `pk = 1`, `nullable` = `notnull = 0`) |
| Foreign keys | `PRAGMA foreign_key_list` |
| Indexes | `PRAGMA index_list` + `PRAGMA index_info` (skips `sqlite_*` auto-indexes) |
| Size | `pragma_page_count * pragma_page_size` (whole-DB, not per-table) |

There is one schema (`main`); no schema prefixing, no two-phase split.

Two defects in that table are real and filed as `D52` in [`docs/BACKLOG.md`](../BACKLOG.md): `PRAGMA
table_info` drops generated columns, and `pk = 1` demotes the second column of a composite primary
key. The object surface below reads neither of those ways. Both surfaces are live through Phase 1 of
#789.

### 6.1 The object surface (#789)

`getSchema()` above is the flat model: one list of tables, no views, no indexes as objects, no
triggers at all. The object surface replaces it with four container-aware methods
(`listContainers`, `countObjects`, `listObjects`, `describeObject`) declared in
[`types.ts`](../../src/lib/db/types.ts) and implemented in
[`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts). The phase that removes `getSchema()` is
#789's last task.

#### SQLite is the ZERO-CONTAINER engine, and `[]` is an answer

`containerLevels` is `[]`, `containerDepth()` answers 0, and `listContainers()` answers `[]`. That
is the engine speaking, not a refusal and not a gap: a SQLite connection opens one database file and
every object in it is addressed by a bare name, so `DatabaseObject.path` for a table is `['orders']`
and for a trigger `['orders', 'orders_stamp']`. The tree reads the same declaration, sees depth 0 and
draws the kind folders at the ROOT under the empty container path; `enumerateContainers()` in
[`object-route.ts`](../../src/lib/api/object-route.ts) answers `[[]]` for the same engines.

No synthetic `main` container is invented to make the shape match the other sixteen engines. A
container row that names nothing a user can act on is a row in the way.

#### `main`, `temp` and ATTACH: what is in scope, and why

**Only `main`.** Every count and every listing is restricted to the schema SQLite calls `main`,
which is the database file the connection was configured for. `temp` and any `ATTACH`ed database are
out of scope for Phase 1, deliberately and for three reasons:

1. They are SESSION state on one handle. `containerLevels` is a STATIC declaration, read by
   `POST /api/db/provider-meta` off a provider it never connects (#457), so it cannot describe a
   schema that exists only after somebody ran `ATTACH` in the editor.
2. An `ATTACH`ed file is a different database than the connection names. The connection dialog
   configures one path; a second one reached through a statement has no credentials, no name and no
   row in the sidebar.
3. Measured, it is not merely untidy. `PRAGMA table_list` spans every attached schema AND `temp`, so
   with `CREATE TEMP TABLE orders(id)` live beside `main.orders` an unrestricted listing answers two
   objects with ONE path, and the tree addresses a row by path plus kind.

The same restriction is applied to the counts and to the listings, so a badge can never disagree with
the folder it sits on. If a later phase wants attached databases, the shape is a `schema` container
level and `listContainers()` reading `pragma_database_list`; nothing here blocks that.

The restriction is expressed differently in the two catalogs, and both are measured:

| Catalog | How `main` is named | Measurement |
| --- | --- | --- |
| `PRAGMA table_list` | `WHERE t.schema = ?`, bound | The pragma's table-valued form takes max 1 argument, so it has no schema parameter; it publishes a `schema` column instead |
| `sqlite_schema` | nothing, it is already `main` | Unqualified `sqlite_schema` resolves to `main.sqlite_schema` even with a database ATTACHed; `temp` objects live in the separate `sqlite_temp_schema` |
| `pragma_table_xinfo`, `index_list`, `index_info`, `foreign_key_list` | bound SECOND argument | Load-bearing, not decoration: with `CREATE TEMP TABLE main_only(ttt)` live, `pragma_table_info('main_only')` answers the TEMP table's columns and `pragma_table_info('main_only','main')` answers the file's |

#### The four kinds

| Kind | `role` | Catalog | Selector | Note |
|---|---|---|---|---|
| `table` | `relation` | `PRAGMA table_list` | `type IN ('table','virtual')` | `acceptsRowWrites: true` |
| `view` | `relation` | `PRAGMA table_list` | `type = 'view'` | not a row-write target |
| `index` | `config` | `sqlite_schema` | `type = 'index'` | first-class here, unlike on four other engines |
| `trigger` | `attached` | `sqlite_schema` | `type = 'trigger'` | `attachedTo: 'table'`, path `[parent, name]` |

**No `procedure` and no `function`, in any spelling.** An application-defined SQLite function is
registered against a connection by the HOST PROCESS through `sqlite3_create_function()` and is never
written to the database file, so nothing survives the connection to be listed. A kind an engine does
not have is ABSENT from the declaration rather than declared and counted zero, because a folder
badged 0 is a claim that the file holds none of something it could hold.

**`index` IS declared**, unlike on [postgres](./postgres.md), [mysql](./mysql.md), mssql and
[oracle](./oracle.md). The test is whether the engine's own catalog models an index as a first-class
named object at container level, and SQLite's does: an index is a row in `sqlite_schema` beside the
tables, addressed by a bare name that shares ONE namespace with tables and views. Measured:
`CREATE INDEX t ON u(id)` against an existing table `t` answers *"there is already a table named t"*.

A trigger's parent is not always a table. SQLite allows an `INSTEAD OF` trigger on a VIEW, and
`sqlite_schema.tbl_name` then names the view; the count and the listing both carry it rather than one
of them dropping it. `attachedTo` names the kind a trigger usually hangs off.

A trigger name is unique per DATABASE, measured (`trigger trg_t already exists` when the second one
is on another table), so `[parent, name]` is more address than SQLite strictly needs. It is the shape
the declaration states and the shape that groups a table's triggers under it in the tree.

#### `PRAGMA table_list`, and why a naive `sqlite_schema` scan inflates every count

`sqlite_schema.type` carries exactly `table`, `index`, `view` and `trigger`, and for the first of
those it is too coarse to count with. An FTS5 table is ONE object a user selects from plus five
SHADOW tables the module owns (`<name>_data`, `_idx`, `_content`, `_docsize`, `_config`); an R-Tree
is one plus three. `sqlite_schema` types every one of them `table`. Measured on a fixture holding
three real tables, one FTS5 table and one R-Tree, a naive scan answers **12**.

`PRAGMA table_list` (SQLite 3.37+, 2021) separates them. Its `type` column carries exactly four
documented values and every one has a rule here:

| `table_list.type` | Kind | Why |
| --- | --- | --- |
| `table` | `table` | an ordinary table, `WITHOUT ROWID` and `STRICT` included |
| `virtual` | `table` | the FTS5 or R-Tree table itself: a user selects from it and writes rows to it |
| `view` | `view` | |
| `shadow` | none | storage a virtual-table module owns; nothing selects from it directly |

That vocabulary is taken from SQLite's own documentation and NOT from a `SELECT DISTINCT type` over
a fixture, which would only ever enumerate the fixture. The fixture in
[`sqlite-provider.test.ts`](../../tests/integration/db/sqlite-provider.test.ts) is built to contain
all four values, and a guard test asserts the engine answers exactly those four, so the day SQLite
adds a fifth the rule fails by name instead of the new type falling silently out of both the count
and the listing.

#### Names SQLite reserves for itself

Every population excludes `name NOT LIKE 'sqlite\_%' ESCAPE '\'`. This can never hide a user's
object: the engine refuses the name outright, `CREATE TABLE sqlite_foo` answering *"object name
reserved for internal use: sqlite_foo"*. What it removes appears without being asked for -
`sqlite_schema` and `sqlite_temp_schema` are rows in `PRAGMA table_list`, `sqlite_sequence` appears
the moment a table declares `AUTOINCREMENT`, `sqlite_stat1` the moment `ANALYZE` runs, and
`sqlite_autoindex_<table>_<n>` the moment a column declares `UNIQUE`.

`ESCAPE` is load-bearing rather than decoration: `_` is LIKE's single-character wildcard, so the
unescaped `'sqlite_%'` also excludes `sqliteXledger`, which is a name a user CAN create.

#### `describeObject()` reads for the two relation kinds only

An `index` and a `trigger` answer three empty arrays without a round trip, which is a true fact about
those kinds rather than a failed read: measured, `pragma_table_xinfo` answers zero rows for both an
index name and a trigger name. An index's own key list is deliberately NOT published there either,
because `IndexSchema.columns` is a list of column NAMES and an index on an expression has none -
measured, `index_info` answers `name = NULL, cid = -2` - so half an engine's indexes would describe
themselves and the other half would silently describe themselves wrongly. A trigger's body is source
text, which is Phase 2's Source tab.

For a `table` and a `view`:

| Data | Source | Note |
| --- | --- | --- |
| Columns | `pragma_table_xinfo(?, ?)` where `hidden <> 1` | `table_xinfo` and not `table_info`, which DROPS a generated column in both spellings (`VIRTUAL` is `hidden = 2`, `STORED` is `hidden = 3`). `hidden = 1` is the other direction: a virtual table module's own interface columns, which on an FTS5 table are the table's own name and `rank`, and which the table does not declare |
| `isPrimary` | `pk > 0` | `pk` is a 1-BASED RANK and not a flag, so `= 1` reports the second column of a composite primary key as ordinary |
| `type` | as answered | The empty string where a column declares no type and on a virtual table's columns. `getSchema()` writes `"TEXT"` there, which is a guess about affinity |
| Indexes | `pragma_index_list(?, ?)` + `pragma_index_info(?, ?)` | Same `sqlite_` exclusion as the Indexes folder, so the two surfaces agree about what an index is. An expression key publishes a null column name and is left out rather than labelled |
| Foreign keys | `pragma_foreign_key_list(?, ?)` | `referencedTable` is a bare name: SQLite resolves a foreign key's parent inside the same database, so there is no cross-schema case |

`REFERENCES customers` with no column list answers `to = NULL`, which SQLite reads as the parent's
PRIMARY KEY. `ForeignKeySchema.referencedColumn` is a string, so the parent's key columns are read
(at most once per parent, and only when some constraint needs them) rather than a null being put in
a typed string field. A parent with no primary key at all is a schema SQLite accepts and rejects only
on INSERT (*"foreign key mismatch"*); there is nothing to name, and the field is empty.

Zero columns IS a failed read and raises: SQLite refuses `CREATE TABLE t()`, so every table and every
view has at least one column and an empty answer means nothing of that name is in `main`.

#### No `rowCount` and no `sizeBytes` on a listed object

Both absences are facts about SQLite. There is no catalog row estimate at all: `sqlite_stat1` exists
only after somebody ran `ANALYZE`, so a count per object would be a full table scan per row of a
listing. Per-object bytes come only from `dbstat`, which scans the whole database file
([§7.2](#72-per-table-size-depends-on-the-sqlite-build-behind-the-driver)) and is absent on a build
without `SQLITE_ENABLE_DBSTAT_VTAB`. A fabricated 0 in either field reads as an empty object, which
is the estimate #469 removed from the Storage tab.

#### `PRAGMA table_list` needs SQLite 3.37, and a build below it refuses rather than guesses

`countObjects()` answers `{ unavailable: "no such table: pragma_table_list" }` for all four kinds,
which is SQLite's own sentence with no product prefix in front of it, and `listObjects()` raises. A
refused read is never 0: the two are different facts and `KindCount` is the type that keeps them
apart. Both drivers this provider selects between are far above that floor (`bun:sqlite` 3.53.2,
`node:sqlite` 3.51.2, measured 2026-09-11), and the object surface is exercised under both.

#### The fixture, and running it

`tests/integration/db/sqlite-provider.test.ts` builds the fixture by DDL against a real `:memory:`
database, so every assertion is measured against the engine rather than a mock. It holds one of every
declared kind, all four `table_list.type` values, a generated column, a composite primary key, an
`AUTOINCREMENT` table, an expression index, an `INSTEAD OF` trigger on a view, a `sqliteXledger`
table, and `orders` in all three of `main`, `temp` and an ATTACHed database.

```bash
bun test tests/integration/db/sqlite-provider.test.ts
```

---

## 7. Monitoring & health

Minimal by nature — SQLite keeps almost no server-style runtime statistics.

| Method | Source | Notes |
|--------|--------|-------|
| `getHealth()` | `fs.statSync` / page PRAGMAs, `PRAGMA integrity_check`, `PRAGMA journal_mode` | reports integrity + journal mode as info rows; `activeConnections: 1`, cache-hit `N/A` |
| `getOverview()` | `sqlite_version()`, file size, `sqlite_master` counts | `uptime: N/A`, `maxConnections: 1` |
| `getPerformanceMetrics()` | — | **no cache-hit ratio, no QPS, no buffer-pool usage** — all three are omitted, so both monitoring tabs show "N/A / Not measured" for them ([§7.1](#71-there-is-no-cache-hit-ratio-and-there-cannot-be)); only `deadlocks: 0` is reported, which is a fact about the engine |
| `getSlowQueries()` | — | always `[]` (SQLite has no query stats) |
| `getActiveSessions()` | — | the single current process session |
| `getTableStats()` | `COUNT(*)` per table, `dbstat` for the bytes | size is **measured page bytes wherever `dbstat` is compiled in, and absent where it is not** — see [§7.2](#72-per-table-size-depends-on-the-sqlite-build-behind-the-driver) |
| `getIndexStats()` | `PRAGMA index_list`/`index_info` | `scans` always `0` (no usage counter); `indexSize` is `N/A` and `indexSizeBytes` is **omitted** — SQLite publishes no per-index size, and a `0` was summed by the Storage tab as an empty index |
| `getStorageStats()` | `fs.statSync` on the DB / `-wal` / `-shm` files | per-file sizes (on disk only) |

### 7.1 There is no cache hit ratio, and there cannot be

SQLite's page-cache hit and miss counters exist only behind the C API —
`sqlite3_db_status()` with `SQLITE_DBSTATUS_CACHE_HIT` / `SQLITE_DBSTATUS_CACHE_MISS` — and **neither
driver this provider can load exposes it**. Measured 2026-08-23 by walking a live handle's prototype
chain:

| Driver | Surface | Status call? |
|--------|---------|--------------|
| `bun:sqlite` (Bun 1.3.14, SQLite 3.53.0) | `clearQueryCache, close, exec, fileControl, filename, handle, inTransaction, loadExtension, prepare, query, run, serialize, transaction` | none |
| `node:sqlite` (Node 24.14.0, SQLite 3.51.2) | `aggregate, applyChangeset, close, createSession, createTagStore, enableDefensive, enableLoadExtension, exec, function, isOpen, isTransaction, loadExtension, location, open, prepare, setAuthorizer` | none |

Nothing SQL-reachable stands in either. On both drivers:

| Attempt | Result |
|---------|--------|
| `PRAGMA cache_size` | `-2000` — the *configured* page budget (negative = KiB), not a hit count |
| `PRAGMA cache_hit`, `PRAGMA cache_miss` | `[]` — these are not pragmas; SQLite answers an unknown pragma with zero rows rather than an error, so they *look* like empty readings |
| `PRAGMA stats` | `[]` |
| `SELECT * FROM dbstat` | Behind `ENABLE_DBSTAT_VTAB`, so it depends on the build: always available under `node:sqlite`, `no such table: dbstat` under `bun:sqlite` through Bun 1.3.14. Either way it reports page layout, not cache hits — which is what [§7.2](#72-per-table-size-depends-on-the-sqlite-build-behind-the-driver) reads it for |

So the field is **omitted permanently**, not pending a better query. Through 0.13.1 this provider
reported `95` whenever `PRAGMA cache_size` came back truthy — which it always does — and `99`
otherwise, and the Performance panel rated that invented figure "Excellent". A missing panel is
honest; a populated wrong one is not: the number was this provider's, not SQLite's. `getHealth()`
says the same thing in its own string field: `cacheHitRatio` is `N/A`.

### 7.2 Per-table size depends on the SQLite build behind the driver

SQLite has no catalog column for a table's size. The only source is `dbstat`, a virtual table that
reports one row per b-tree page group, and it is behind the compile-time
`SQLITE_ENABLE_DBSTAT_VTAB` option — which the two drivers do not agree on. Measured 2026-08-24 on
the same seeded database (200 rows of 4 KB text in `big` with an index on it, 200 short rows in
`small`, file 1,761,280 B):

| Driver | `SELECT name, SUM(pgsize) FROM dbstat GROUP BY name` |
|--------|------------------------------------------------------|
| `bun:sqlite` (Bun 1.3.14, SQLite 3.53.0) | `no such table: dbstat` |
| `node:sqlite` (Node 24.14.0, SQLite 3.51.2) | `big 823296`, `idx_big 929792`, `small 4096` |

**The divergence closed on Bun 1.4.0 — on the builds that carry Bun's own SQLite.** That
Bun bundles SQLite 3.53.2 with `SQLITE_ENABLE_DBSTAT_VTAB` compiled in, so `bun:sqlite`
answers where 1.3.14 raised `no such table: dbstat`, and the pinned runtime moved to it on
2026-08-31. Re-measured that day **on Linux x86_64** on a freshly seeded file (200 rows of a
4096-character payload in `big` with an index on `payload`, 200 short rows in `small`), the
two drivers returned **byte-identical** `getTableStats()` output under the same Bun 1.4.0:

```
# both LIBREDB_SQLITE_DRIVER unset (bun:sqlite) and LIBREDB_SQLITE_DRIVER=node
{"tableName":"big","rowCount":200,"tableSize":"904 KB","tableSizeBytes":925696,
 "indexSize":"908 KB","indexSizeBytes":929792,"totalSize":"1.77 MB","totalSizeBytes":1855488}
{"tableName":"small","rowCount":200,"tableSize":"4 KB","tableSizeBytes":4096,
 "indexSize":"0 B","indexSizeBytes":0,"totalSize":"4 KB","totalSizeBytes":4096}
```

The bytes differ from the 2026-08-24 row above because the seed is not the same file, not
because the drivers disagree — that comparison is a separate measurement, kept as the
record of what Bun 1.3.14 did. The 1.3.14 row is not history: an install pinned to an
older image still behaves that way, which is why the absent-field arm below stays.

**The pin moved on to Bun 1.4.2 on 2026-09-07 and none of the above moved with it.**
Re-measured that day on Linux x86_64: `bun:sqlite` still reports `sqlite_version()`
3.53.2 and `dbstat` still answers. So the 1.4.0 rows are the current behaviour as well
as the record of what 1.4.0 did, and nothing here needed rewriting for the new pin.
macOS is still unmeasured, on 1.4.2 exactly as on 1.4.0.

**macOS is not covered by the row above.** There `bun:sqlite` dlopens Apple's
`/usr/lib/libsqlite3.dylib` instead of the amalgamation Bun links on Linux and Windows —
[oven-sh/bun#16717](https://github.com/oven-sh/bun/issues/16717), open, reproduced by Bun's own
triage bot, and the reason `sqlite_version()` still reads `3.43.2` there on 1.4.0. So what
`dbstat` does under `bun:sqlite` on macOS is Apple's build's answer, and nothing in this
document measures it. Read the empty arm below as live on any build without `dbstat`, macOS
included until someone measures it.

The absent arm is therefore still shipped, and `LIBREDB_SQLITE_DRIVER`
([§2](#runtime--driver-selection)) is what moves a connection between the two drivers. When the
build behind `bun:sqlite` has no `dbstat`, the same connection reports different things depending
on that variable — verbatim from `getTableStats()`, captured on Bun 1.3.14:

```
# LIBREDB_SQLITE_DRIVER=node
{"tableName":"big","rowCount":200,"tableSize":"804 KB","tableSizeBytes":823296,
 "indexSize":"908 KB","indexSizeBytes":929792,"totalSize":"1.67 MB","totalSizeBytes":1753088}

# bun:sqlite (the default under Bun), where dbstat is absent
{"tableName":"big","rowCount":200,"totalSize":"N/A","totalSizeBytes":0}
```

Under `node:sqlite` an index's pages are added to **its table's** `indexSizeBytes`, implicit
`sqlite_autoindex_*` ones included, because the Storage tab builds its index total from the
per-table figure. Where `dbstat` is missing, `tableSize` and `tableSizeBytes` are **omitted** — the
Storage tab shows "N/A" for the Tables/Indexes cards and the breakdown, and "-" for each table's
share, rather than a figure. `dbstat` is read once per `getTableStats()` call, since it scans the whole
database file.

Through 0.13.3 this was `rowCount * 100` — "Assume 100 bytes average per row" — and the Storage tab
summed it into the Data figure it draws beside the measured database size. On the database above
that estimate answered 20,000 B for both tables: 40× under for `big` (804 KB of pages) and 5× over
for `small` (4 KB), a guess presented as a measurement. A `0` would have been the same
fabrication in a different digit, which is why the fields are absent rather than zero.
`totalSize`/`totalSizeBytes` remain required by `TableStats`, so they carry the same `"N/A"` / `0`
placeholder `indexSize` already used, and every consumer gates on the absent `tableSizeBytes`.

---

## 8. Maintenance

`runMaintenance(type, target?)` ([`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts)); `analyze`
and `reindex` targets are quoted via `escapeIdentifier()`:

| Type | Action |
|------|--------|
| `vacuum` | `VACUUM` (rewrites/compacts the whole file) |
| `analyze` | `ANALYZE [<target>]` |
| `reindex` | `REINDEX [<target>]` |
| `check` | `PRAGMA integrity_check` (returns ok / failure detail) |

`getCapabilities().maintenanceOperations = ['vacuum', 'analyze', 'reindex', 'check']`. There is no
`kill` — SQLite has no sessions to terminate. Quoting the target prevents identifier injection in
`ANALYZE`/`REINDEX` statements (which cannot use bind parameters for object names).

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#496).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available - `{type:"vacuum", target:"users"}` is
that request here.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `vacuum` | Vacuum Database | no | yes | `VACUUM` rewrites the whole file and `runMaintenance` drops the target, so a per-table control named one table and acted on the database |
| `analyze` | Analyze Table | yes | yes | `ANALYZE [<t>]` |
| `reindex` | Reindex Table | yes | yes | `REINDEX [<t>]` |
| `check` | Integrity Check | no | yes | `PRAGMA integrity_check` reads the whole file, target ignored |

**The schema explorer's row menu reads the same declaration.** It is the third surface that
renders this wording, and it used to gate on `supportsMaintenance` alone — so it offered
*"Vacuum Table"* for ONE table here while the monitoring Tables tab correctly withheld that
control, and the click deep-linked to a page where no such control exists. `TableItem.tsx`
now asks `maintenanceControl(capabilities, …, 'perEntity')` for each of its two items, so on
SQLite the row menu offers *"Analyze Table"* and no vacuum item at all. Unknown capabilities
read as a denial there, as they already did on the other two surfaces: `/api/db/provider-meta`
answers with nothing both while it is in flight and when it failed.

---

## 9. Capabilities & labels

### `getCapabilities()` ([`sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `explainFormat` | `"sqlite-queryplan"` |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core SQLite DML |
| `supportsTransactions` | **`false`** — SQLite HAS `BEGIN`, but this provider holds no session across two requests, so `POST /api/db/transaction` refuses the call. The flag describes the provider's surface, not the engine, and the trio and SANDBOX toggle are withheld rather than offered and then failed (#464) |
| `declaresForeignKeys` | `true` — inherited from the base capabilities; `PRAGMA foreign_key_list` reads them whether or not enforcement is on |
| `singleWriterFile` | **absent (not `true`)** — SQLite is a file engine and is *not* single-writer at OPEN. Measured 2026-08-25 on `bun:sqlite`: a second `new Database(path, { readwrite: true })` on a WAL file this process already holds both opens and writes, because SQLite takes its file locks per transaction. LibreDB declares the flag and SQLite must not: the whole point of the agent profile here is a SECOND, `readonly: true` handle on the same file ([§12.1](#121-where-the-boundary-is)), and declaring it would have made the factory hand the agent the writable one instead |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['vacuum', 'analyze', 'reindex', 'check']` |
| `supportsConnectionString` | **`false`** |
| `defaultPort` | `null` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |
| `containerLevels` | **`[]`** — SQLite has no container level at all, which `containerDepth()` reads as 0 ([§6.1](#61-the-object-surface-789)) |
| `objectKinds` | `table`, `view`, `index`, `trigger` — no routine kind of any spelling ([§6.1](#61-the-object-surface-789)) |

### Labels

Default SQL labels — *Table* / *Select Top 50* / *Vacuum Table* / *Analyze Table*, which match
SQLite's real `VACUUM`/`ANALYZE`. `vacuumAction`'s *"Vacuum Table"* is the one word that is
narrower than the statement: `VACUUM` is not per-table, which is what
`vacuum: { perEntity: false, label: 'Vacuum Database' }` says, and the per-row surfaces take
their wording from that `label` rather than from this field.

One field is overridden: `slowQueriesEmptyState` → *"SQLite keeps no statistics about finished
statements, so there is nothing to enable."* `getSlowQueries()` answers `[]` unconditionally
([§7](#7-monitoring--health)), so the monitoring Queries panel is always empty here, and its sentence
was hardcoded to PostgreSQL's `pg_stat_statements` advice (#463).

Two overrides in total. The second is the Operations tab's global Reindex card, hardcoded to
PostgreSQL's *"Reconstructs all indexes in the database."* until #464. The global card
sends no target, so `runMaintenance('reindex')` here runs a bare `REINDEX`
([§8](#8-maintenance)), which rebuilds every index in the database **file**:

| Field | Value |
| --- | --- |
| `reindexGlobalLabel` | *Run Reindex* |
| `reindexGlobalTitle` | *Rebuild Indexes* |
| `reindexGlobalDesc` | *Runs bare REINDEX, rebuilding every index in the database file.* |

---

## 10. Error handling

SQLite uses the shared `mapDatabaseError()` ([errors.ts](../../src/lib/db/errors.ts)) with **no**
SQLite-specific branches:

| Situation | Error |
|-----------|-------|
| Missing `database` and `connectionString` | `DatabaseConfigError` |
| NUL byte in path | `DatabaseConfigError` ("Invalid database path: NUL bytes are not allowed") |
| Selected driver unavailable (no `bun:sqlite` / `node:sqlite` on this runtime) | `DatabaseConfigError` ("SQLite driver … is not available…") |
| Open failure | `ConnectionError` |
| Statement errors whose message matches a heuristic (e.g. *syntax error*, *no such column*) | `QueryError` |
| Other engine errors | generic `QueryError` / `DatabaseError` with the original message |

---

## 11. Testing

### 11.1 Real engine, no mocks

SQLite is the **only** provider whose integration tests run against a **real engine** — no
`mock.module()` needed
([`tests/integration/db/sqlite-provider.test.ts`](../../tests/integration/db/sqlite-provider.test.ts)).
**Both drivers are exercised:**

- **bun driver** — the main suite opens a `bun:sqlite` **`:memory:`** database in-process (tests
  run under Bun).
- **node driver** — Bun cannot load any non-bun SQLite driver in-process, so the core CRUD /
  schema / maintenance / error-mapping cases **and the agent read-only profile contract** run in a
  real **`node` subprocess**:
  [`sqlite-node-harness.ts`](../../tests/integration/db/sqlite-node-harness.ts) is bundled with
  `bun build --target=node` and executed with `LIBREDB_SQLITE_DRIVER=node` against a temp on-disk
  file (`mkdtempSync`), reporting its results as JSON on stdout. The subprocess test skips (with a
  warning) if `node` with `node:sqlite` is unavailable. This subprocess is the only place an
  adapter that accepted the read-only open flag and ignored it would be caught, so the profile
  cases are duplicated there deliberately rather than trusted from the bun run.
- **driver selection** — `resolveSQLiteDriverName()` is tested directly (runtime default, `bun`/
  `node` overrides, invalid-value fallback), restoring `LIBREDB_SQLITE_DRIVER` after each test.

Embedded + in-memory/tempfile means there is no server to provision, so the tests exercise actual
SQL execution, schema PRAGMAs, maintenance, and monitoring end-to-end.

> Mock-isolation still applies to the *suite* (other files mock their drivers process-wide), so run
> with `bun run test:ci` / `bun run test:coverage`, not the single-process `bun run test`. See
> [`CLAUDE.md`](../../CLAUDE.md).

### 11.2 Coverage

Validation, connect/disconnect, path handling (NUL rejection, `..` acceptance), query (read +
write), capabilities, `getSchema` (columns/PKs/FKs/indexes), health, maintenance
(vacuum/analyze/reindex/check), overview, performance, active sessions, slow queries,
table/index/storage stats, `getMonitoringData`, `prepareQuery`, and labels. For the object surface
([§6.1](#61-the-object-surface-789)): the declared kinds, the conformance contract, the tree's root
rows, the `table_list` vocabulary guard, shadow and virtual tables, reserved names, `temp` and
ATTACH exclusion, count-versus-listing agreement, trigger nesting, ordering, the detail reads, and
the refusals. For the agent profile
([§12](#12-agent-read-only-execution-profile-328)): rejected write / schema change / file create,
`query_only` read-back, the pragma-bypass case, row/byte/time budgets, multi-statement tail
suppression, `:memory:` refusal, and the refusal to run `queryReadOnly` on a writable handle — each
asserted behaviorally (did the write land? does the file exist?) rather than by driver error code,
since bun and node report read-only violations differently.

### 11.3 Run it

```bash
bun test tests/integration/db/sqlite-provider.test.ts   # real :memory: engine
bun run test:ci                                          # CI publish gate (per-file isolation)
bun run test:coverage                                    # CI coverage workflow
```

---

## 12. Agent read-only execution profile (#328)

The agent programme (epic #325) never talks to the shared, writable provider. It acquires a
**dedicated provider keyed by (connection id, execution profile)** via
`acquireExecutionProfileProvider` ([factory.ts](../../src/lib/db/factory.ts)) and runs every
statement through `queryReadOnly()`. See [postgres.md §12](./postgres.md#12-agent-read-only-execution-profile-328)
for the acquisition/caching rules, which are provider-independent; this section is the SQLite half.

### 12.1 Where the boundary is

PostgreSQL establishes read-only enforcement **per transaction**. SQLite has no such construct, so
it is established **at open time** instead — the profile opens a second, physically separate handle
to the same file with SQLite's own read-only flag (`readonly` under bun:sqlite, `readOnly` under
node:sqlite; the [driver adapter](../../src/lib/db/providers/sql/sqlite-driver.ts) maps between
them). Every write and DDL against the target database is refused by the engine, and a missing file
is not created — with no SQL inspected on the way.

The read-only open governs **the target database file, and only that file**. It does not stop a
statement that writes to a *different* file: `VACUUM INTO '<path>'` copies the whole database to an
arbitrary server path from a read-only handle on both adapters. That route is closed by the second
control below, which is why the profile does not rest on the open alone.

Because the flag is an open option rather than a runtime call, the intent has to reach the
constructor. It travels in `ProviderExecutionContext` ([types.ts](../../src/lib/db/types.ts)) — a
*server-injected* third constructor argument, deliberately **not** a member of `ProviderOptions`:
that object is caller-supplied and flows into `getOrCreateProvider`, so a profile flag living there
could be set — or cleared — by whoever assembles options for a request. Only
`acquireExecutionProfileProvider` passes it, and a test pins that the shared path stays writable
when a caller tries to smuggle the flag through options.

The read-only open deliberately skips the shared `connect()` sequence
([§3.2](#32-pragmas-on-connect)): no parent directory is created, no `create` flag is passed, and
the `journal_mode = WAL` pragma — itself a write, which fails outright on a read-only handle — is
not run. None of it applies to a connection that cannot write.

### 12.2 `query_only`, re-asserted before every statement

A read-only open does **not** imply `PRAGMA query_only`: it reads back `0` on both adapters until
set explicitly. The profile sets it and verifies the read-back — at open *and before every
statement* — refusing the handle otherwise (`assertQueryOnlyEnabled`).

Per statement, not once at open, for two reasons. The profiled provider is **pooled and reused**
across an agent run, and a statement is free to run `PRAGMA query_only = false` (nothing parses
it), which would otherwise persist for every later call on that connection. Re-asserting closes
that: `prepare()` compiles exactly one statement, so the disable and the write it would enable can
never ride in the same call, and the next call re-enables the pragma before running anything.

So the two controls cover different ground and neither is redundant — the open refuses writes to
the target database, `query_only` refuses writes to anything else. The suite asserts both,
including the `VACUUM INTO` case with `query_only` deliberately disabled first.

**Known limitation — empty files at an agent-chosen path.** SQLite creates the destination file
*before* refusing the `VACUUM INTO` copy, so an agent can still cause a zero-byte file to appear at
any path the server process can write to. No data reaches it (asserted on both adapters by file
size, not by existence). Closing this would need an authorizer callback, which `bun:sqlite` does
not expose at all.

### 12.3 Per-statement execution (`queryReadOnly`)

| Budget field | How SQLite honors it |
|---|---|
| `maxResultRows` | Result-side: rows are counted after execution; over budget throws, never truncates |
| `maxResultBytes` | Result-side, same rule (serialized size) |
| `statementTimeoutMs` | **Post-execution deadline only** — see the limitation below |

Statements are compiled with `prepare()`, never `exec()`. `exec()` runs *every* statement of a
multi-statement string; `prepare()` compiles only the first and drops the tail, so a smuggled
trailing write is never executed. Rejecting multi-statement input outright remains the policy
pipeline's job — silent truncation is not treated as a pass.

An in-memory (`:memory:`) target is refused under this profile: a read-only open of an anonymous
database can only ever yield an empty one (node:sqlite) or fail outright (bun:sqlite), so vending
it would hand the agent a silently useless target. The refusal is an `ExecutionProfileError` with
reason code **`PROFILE_UNSUPPORTED_TARGET`** ([errors.ts](../../src/lib/db/errors.ts)) — the same
typed deny surface acquisition uses for `UNSUPPORTED_PROFILE` /
`PROFILE_UNSUPPORTED_BY_PROVIDER`, so a caller can branch on the code instead of a message, and
`connect()` deliberately does not wrap it into a generic `ConnectionError`.

**Known limitation — `ATTACH` contains writes, not reads.** Attaching a *missing* file fails and
creates nothing, and an *existing* file attaches with the read-only mode inherited, so writes
through it are refused (both asserted in the integration suite). Its **rows do become readable**,
and neither adapter offers a database-native control that would stop that — `bun:sqlite` exposes no
authorizer callback at all, and `node:sqlite`'s `setAuthorizer` is therefore not usable as a
cross-adapter control. Out-of-scope reads through `ATTACH` are consequently held off by the
input-stage denial in the operations layer
([statement-guard.ts](../../src/lib/db/operations/statement-guard.ts)) — defense in depth carrying a
gap the engine leaves, which is the honest description rather than a boundary claim. Residual risk:
a statement that reached the profile with that layer bypassed could read any SQLite file the server
process can open.

**Known limitation — the timeout cannot preempt.** SQLite has no transaction-local statement
timeout, and neither adapter exposes `sqlite3_interrupt` or a progress handler. `statementTimeoutMs`
is therefore enforced as a deadline *check*: an overrunning statement runs to completion and its
result is then refused, rather than being returned as if it had been within budget. Since the
drivers are synchronous, such a statement also blocks the runtime while it runs — the same property
as the normal SQLite query path ([§3.4](#34-no-transactions-api-no-cancellation-no-pool)).

### 12.4 What drives this profile (#329)

#328 built the profile and nothing called it. The agent tool layer
([`src/lib/agent/tools.ts`](../../src/lib/agent/tools.ts)) is the code written to drive it — see
[postgres.md §12.4](./postgres.md#124-what-drives-this-profile-329) for how the provider is acquired
and why nothing calls it yet at this commit.

**The catalog read goes through `sqlite_master`, and the guard is why.** The obvious way to read a
column list here is `SELECT … FROM pragma_table_info('t')`, and the operations layer refuses it:
`statement-guard.ts` rejects any word starting `PRAGMA_`, because SQLite exposes pragmas as
table-valued functions and some of them SET (`pragma_query_only(0)` was found while reviewing this
very profile). So `inspect_schema` composes
`SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') …`
([composed-sql.ts](../../src/lib/agent/composed-sql.ts)), whose projection is therefore each object's
own DDL text — a column list is there to be read out of a `CREATE TABLE` statement, rather than
arriving as rows. PostgreSQL gets a structured column inventory from `information_schema` instead.
The DDL is parsed by [`sqlite-ddl.ts`](../../src/lib/agent/sqlite-ddl.ts) (#329 T8), which reads four
things out of it and steps over the rest: the columns, which are `NOT NULL`, which form the primary
key, and where each `REFERENCES` points. Text it cannot read as a `CREATE TABLE` with a column list —
a view, most obviously — yields an EMPTY definition rather than a partial one, and the table is
rendered as having no derivable columns. (A `CREATE TABLE … AS SELECT` is *not* such a case: SQLite
stores a materialised column list for it, verified against a live engine in the parser's suite.)
The asymmetry is a real consequence of the guard's allowlist, not an oversight,
and it is not worked around: a tool that reached `pragma_table_info` outside the operations layer
would be exactly the bypass this milestone forbids. The internal `sqlite_%` objects are filtered with
`NOT LIKE 'sqlite@_%' ESCAPE '@'` — the escape character is `@` rather than a backslash because the
dialect-less span reader cannot settle `'\'`.

**Two catalog reads, not three.** `inspect_schema` takes a `kind` (#329 T8), and on this engine
`relations` composes the SAME statement as `columns`: a table's foreign keys are declared inside its
own `CREATE TABLE` text, so the object read already carries them and
`pragma_foreign_key_list` is refused for the reason above. `indexes` is the one extra statement —
`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL …`. The
`sql IS NOT NULL` clause is what excludes the indexes SQLite creates for a `UNIQUE` or `PRIMARY KEY`
constraint: they store no DDL at all, so an inventory that kept them would list an index nothing can
describe. Their columns are not lost — the constraint that created them is in the table's own DDL.

A `schema` selector is accepted only as `main`, and any other name is refused rather than silently
ignored — the composer raises `SELECTOR_UNSUPPORTED_BY_DIALECT`, which the tool reports to the model as
`INVALID_TOOL_INPUT` carrying that code as its detail. What makes `main` the right answer is the
statement, not a boundary claim: the composed read names `sqlite_master` unqualified, which IS `main`'s
own catalog whatever else is attached. The input-stage `ATTACH` denial is defense in depth on top of
that and is explicitly **not** a containment boundary — an `ATTACH` of an existing file still succeeds
on a read-only handle, which the known-limitations record states in full.

**The run deadline clamps the timeout but still cannot preempt.** The tool layer clamps
`statementTimeoutMs` down to the run's remaining wall clock before handing it over, which bounds what
is REPORTED, not what runs — the limitation above is unchanged, and anything that displays a budget
has to say so rather than imply preemption.

---

## 13. Usage examples

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'lite1', name: 'App', type: 'sqlite',
  database: '/data/app.db',   // server-local path; or ':memory:'
  createdAt: new Date(),
});

await provider.connect();      // works under Bun and Node (see Runtime & driver selection)
const res = await provider.query('SELECT id, name FROM users');
const schema = await provider.getSchema();
await provider.disconnect();
```

Over the API: `POST /api/db/query`, `POST /api/db/maintenance` (admin). Transaction/cancel routes do
not apply to SQLite ([§3.4](#34-no-transactions-api-no-cancellation-no-pool)).

---

## 14. Known limitations & future work

- **Server-local file only.** No network protocol; a hosted/SaaS user cannot reach a SQLite file on
  their own machine. SQLite-as-target suits self-hosted / local-dev / edge and zero-config trials.
- **Bun or Node 24+ runtime required** (`engines.node: ">=24.0.0"`). The provider needs a built-in
  SQLite driver (`bun:sqlite` or `node:sqlite`); on a runtime with neither, `connect()` throws a
  `DatabaseConfigError` with guidance. `node:sqlite` itself has been unflagged since Node 22.13, so
  the guard still fires correctly below the floor rather than assuming the module is present.
  See [Runtime & driver selection](#runtime--driver-selection).
- **No transactions / cancellation / pooling.** Single embedded handle; the transaction and cancel
  API routes don't apply.
- **No EXPLAIN plan metrics.** `EXPLAIN QUERY PLAN` returns step descriptions only — SQLite does not
  report per-node cost, row estimates, or timing data.
- **Absent monitoring:** there is **no cache-hit ratio, no queries-per-second and no buffer-pool
  usage** — the drivers expose no counters for them, so the panels say "Not measured"
  ([§7.1](#71-there-is-no-cache-hit-ratio-and-there-cannot-be)); index `scans` is always `0` and
  `getIndexStats()`'s per-index size is `N/A`; slow queries are unavailable.
- **Per-table size only under `node:sqlite`.** `dbstat` is compiled into that driver and out of
  `bun:sqlite`, so under Bun the byte fields are omitted rather than estimated
  ([§7.2](#72-per-table-size-depends-on-the-sqlite-build-behind-the-driver)). `getIndexStats()` still reports
  `indexSize: "N/A"` per index even where `dbstat` exists — the per-table index bytes it feeds the
  Storage tab are measured, the per-index rows are not yet.
- **`:memory:` is ephemeral** — data is lost on disconnect; intended for trials/tests.
- **Single schema (`main`)** — `ATTACH`ed databases are not surfaced.
- **No path sandboxing (by design).** `getDatabasePath()` validates only that the path contains
  no NUL byte; the resolved absolute path — `..` segments included — is used as-is. This grants an
  *unauthenticated* client no access: the path comes from an authenticated user's connection config,
  and reading arbitrary server-side files by path is the feature. The distinction that matters for
  multi-user installs is the next one down: **authenticated does not imply trusted with the host
  filesystem.** Since the type became selectable in the connection modal (#127), that path field is
  directly discoverable by every logged-in user — the reachable set of files did not grow, but the
  effort needed to reach it dropped from an API call to typing in a form. On a single-operator
  install this is the intended feature; on a shared instance it is a deployment decision, and until
  #125 lands the controls are OS-level (process user, container mounts). *Future:* an optional
  base-dir allowlist restricting resolvable paths (proposed in
  [issue #125](https://github.com/libredb/libredb-studio/issues/125)) was deliberately left out of
  this honesty fix — new security-configuration surface needs its own issue.

---

## 15. References

- Drivers: [`bun:sqlite`](https://bun.sh/docs/api/sqlite) (Bun built-in) · [`node:sqlite`](https://nodejs.org/api/sqlite.html) (Node built-in)
- Driver adapter: [`src/lib/db/providers/sql/sqlite-driver.ts`](../../src/lib/db/providers/sql/sqlite-driver.ts)
- Source: [`src/lib/db/providers/sql/sqlite.ts`](../../src/lib/db/providers/sql/sqlite.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Storage-layer SQLite (the *other* SQLite — `better-sqlite3`): [`src/lib/storage/providers/sqlite.ts`](../../src/lib/storage/providers/sqlite.ts)
- Tests: [`tests/integration/db/sqlite-provider.test.ts`](../../tests/integration/db/sqlite-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [Apache Trino](./trino.md) · [Redis](./redis.md)
