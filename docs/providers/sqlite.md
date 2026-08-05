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
  Docker image's runner stage is `node:24.16.0-trixie-slim`; the other channels bundle their own pinned
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
| Node | `node:sqlite` (`DatabaseSync`) | Node built-in: unflagged from 22.13, stable on the recommended Node 24 LTS |

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
| Monitoring | rich `pg_stat_*` | minimal (PRAGMAs + file stats; many fields `N/A`/estimated) |

---

## 2. Architecture

Standard SQL hierarchy:

```
DatabaseProvider (interface) → BaseDatabaseProvider → SQLBaseProvider → SQLiteProvider
```

`SQLiteProvider` inherits the shared SQL helpers (see
[PostgreSQL doc §2.2](./postgres.md#22-what-sqlbaseprovider-provides)). It does **not** override
`prepareQuery()` or `getLabels()`: SQLite uses standard `LIMIT` (so the base's `LIMIT` injection
works) and the default SQL labels (*Vacuum Table* / *Analyze Table* fit, since SQLite has real
`VACUUM`/`ANALYZE`).

### Dynamic driver load

The driver is imported lazily via `loadSQLiteDriver()`
([sqlite-driver.ts](../../src/lib/db/providers/sql/sqlite-driver.ts)), which caches the constructor
(and any load failure) per driver name. Selection is runtime-based (`bun:sqlite` under Bun,
`node:sqlite` under Node) with a `LIBREDB_SQLITE_DRIVER=bun|node` override — see
[Runtime & driver selection](#runtime--driver-selection). If the selected driver cannot load, a
`DatabaseConfigError` is thrown.

### Registration

```ts
// factory.ts:72
case "sqlite": {
  const { SQLiteProvider } = await import("./providers/sql/sqlite");
  return new SQLiteProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 File path resolution & the admin-trusted path model

`getDatabasePath()` ([sqlite.ts:133](../../src/lib/db/providers/sql/sqlite.ts)) resolves the target:
`connectionString` (stripping a `file:` prefix) → else `database` → else `:memory:`. Non-`:memory:`
paths are `path.resolve()`-d to an absolute path and **rejected if they contain a NUL byte**. Parent
directories are created on connect.

> **NUL rejection is the only path validation — by design.** `../` segments are legal and simply
> resolve into the absolute path. This follows the feature's trust model: a connection's
> `database`/`connectionString` path is set by whoever configures the connection (an
> authenticated user of this Studio instance) — pointing Studio at an arbitrary server-side file is
> the intended capability, not attacker-controlled input from an untrusted client. There is
> currently **no** option to sandbox resolvable paths to a base directory. See
> [Known limitations](#13-known-limitations--future-work).

### 3.2 PRAGMAs on connect

`connect()` opens the file with `{ create: true, readwrite: true }` and sets
`PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `synchronous = NORMAL`
([sqlite.ts:104](../../src/lib/db/providers/sql/sqlite.ts)) — FK enforcement on, WAL for better
concurrency, NORMAL sync for a speed/durability balance.

### 3.3 Read vs write dispatch

`query()` ([sqlite.ts:159](../../src/lib/db/providers/sql/sqlite.ts)) branches on
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

`validate()` ([sqlite.ts:67](../../src/lib/db/providers/sql/sqlite.ts)) requires either `database`
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
[No path sandboxing](#13-known-limitations--future-work) — but operators of multi-user deployments
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

`getSchema()` ([sqlite.ts:203](../../src/lib/db/providers/sql/sqlite.ts)) reads `sqlite_master`
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

---

## 7. Monitoring & health

Minimal by nature — SQLite keeps almost no server-style runtime statistics.

| Method | Source | Notes |
|--------|--------|-------|
| `getHealth()` | `fs.statSync` / page PRAGMAs, `PRAGMA integrity_check`, `PRAGMA journal_mode` | reports integrity + journal mode as info rows; `activeConnections: 1`, cache-hit `N/A` |
| `getOverview()` | `sqlite_version()`, file size, `sqlite_master` counts | `uptime: N/A`, `maxConnections: 1` |
| `getPerformanceMetrics()` | `PRAGMA cache_size` | cache-hit is an **estimate** (95/99); QPS/buffer-pool `undefined`; `deadlocks: 0` |
| `getSlowQueries()` | — | always `[]` (SQLite has no query stats) |
| `getActiveSessions()` | — | the single current process session |
| `getTableStats()` | `COUNT(*)` per table | **size is a rough estimate** (`rows × 100 bytes`) — SQLite gives no per-table size |
| `getIndexStats()` | `PRAGMA index_list`/`index_info` | `scans` always `0` (no usage counter); `indexSize` `N/A` |
| `getStorageStats()` | `fs.statSync` on the DB / `-wal` / `-shm` files | per-file sizes (on disk only) |

---

## 8. Maintenance

`runMaintenance(type, target?)` ([sqlite.ts:377](../../src/lib/db/providers/sql/sqlite.ts)):

| Type | Action |
|------|--------|
| `vacuum` | `VACUUM` (rewrites/compacts the whole file) |
| `analyze` | `ANALYZE [<target>]` |
| `reindex` | `REINDEX [<target>]` |
| `check` | `PRAGMA integrity_check` (returns ok / failure detail) |

`getCapabilities().maintenanceOperations = ['vacuum', 'analyze', 'reindex', 'check']`. There is no
`kill` — SQLite has no sessions to terminate.

---

## 9. Capabilities & labels

### `getCapabilities()` ([sqlite.ts:133](../../src/lib/db/providers/sql/sqlite.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `explainFormat` | `"sqlite-queryplan"` |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core SQLite DML |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['vacuum', 'analyze', 'reindex', 'check']` |
| `supportsConnectionString` | **`false`** |
| `defaultPort` | `null` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

### Labels

Default SQL labels (not overridden) — *Table* / *Select Top 50* / *Vacuum Table* / *Analyze Table*,
which match SQLite's real `VACUUM`/`ANALYZE`.

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
  schema / maintenance / error-mapping cases run in a real **`node` subprocess**:
  [`sqlite-node-harness.ts`](../../tests/integration/db/sqlite-node-harness.ts) is bundled with
  `bun build --target=node` and executed with `LIBREDB_SQLITE_DRIVER=node` against a temp on-disk
  file (`mkdtempSync`). The subprocess test skips (with a warning) if `node` with `node:sqlite` is
  unavailable.
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
table/index/storage stats, `getMonitoringData`, `prepareQuery`, and labels.

### 11.3 Run it

```bash
bun test tests/integration/db/sqlite-provider.test.ts   # real :memory: engine
bun run test:ci                                          # CI publish gate (per-file isolation)
bun run test:coverage                                    # CI coverage workflow
```

---

## 12. Usage examples

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

## 13. Known limitations & future work

- **Server-local file only.** No network protocol; a hosted/SaaS user cannot reach a SQLite file on
  their own machine. SQLite-as-target suits self-hosted / local-dev / edge and zero-config trials.
- **Bun or Node 22.13+ runtime required** (Node 24 LTS recommended). The provider needs a built-in
  SQLite driver (`bun:sqlite` or `node:sqlite`); on a runtime with neither (e.g. Node < 22.13
  without the experimental flag), `connect()` throws a `DatabaseConfigError` with guidance.
  See [Runtime & driver selection](#runtime--driver-selection).
- **No transactions / cancellation / pooling.** Single embedded handle; the transaction and cancel
  API routes don't apply.
- **No EXPLAIN plan metrics.** `EXPLAIN QUERY PLAN` returns step descriptions only — SQLite does not
  report per-node cost, row estimates, or timing data.
- **Estimated/absent monitoring:** per-table size is `rows × 100 bytes` (a rough estimate); index
  `scans` is always `0`; cache-hit ratio is a fixed estimate; slow queries are unavailable.
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

## 14. References

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
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Oracle](./oracle.md) · [SQL Server](./mssql.md) · [Redis](./redis.md)
