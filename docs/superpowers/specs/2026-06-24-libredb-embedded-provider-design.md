# LibreDB Embedded Provider — Design Spec

> Status: approved design, ready for implementation planning.
> Supersedes the precursor sketch at `docs/providers/libredb-provider-design.md`.
> Adds a Studio database provider for the embedded `@libredb/libredb` package (the
> open-source database in the sibling `libredb-database` repo), letting the editor
> browse and write a local `.libredb` file in-process — the same embedded pattern
> Studio already uses for SQLite.

## 1. Goal and non-goals

**Goal.** Let a Studio user add a connection of type `libredb` that points at a
local `.libredb` file, browse its contents as prefix-grouped "tables", and run
read/write commands against it — without disturbing any existing provider.

**Non-goals (v1).**

- No SQL. LibreDB has no SQL surface; this is a NoSQL-style provider.
- No reconstruction of relational tables / document collections from disk. A
  `.libredb` file is raw ordered key-value bytes; the lens (kv/doc/relational)
  and any table schema live in application code, not on disk. v1 shows the
  honest raw-KV view (Option A). Faithful per-kind catalog views are deferred
  until the database-side catalog ships (see §9).
- No multi-key atomic `transact` exposed in the query UI (deferred).
- No in-memory (`open()` without a path) connections — the provider targets a
  persisted file.
- No networked/remote LibreDB — LibreDB has no server or wire protocol by
  deliberate design. Embedded-in-process is the only connection model.

## 2. Why embedded, not a wire connection

LibreDB is embedded-first with no server. Studio connects the SQLite way:
import the package and open the file in the Studio **server** process. The file
must live on the Studio server's filesystem. This provider is therefore
server-side only and must never be imported into a client bundle.

## 3. Dependency strategy

- Add `@libredb/libredb@^0.0.1` (published, ESM-only, exports `open`, `kv`,
  `doc`, `table`) as a normal dependency in `package.json`.
- **Lazy dynamic-import inside the provider**, mirroring how `sqlite.ts` loads
  `bun:sqlite`: a module-level loader caches the import and, on failure, throws a
  `DatabaseConfigError` ("LibreDB package is not available in this environment").
  Rationale:
  - keeps the package out of client bundles,
  - lets `tsup` / `build:lib` externalize it so `@libredb/studio` still builds,
  - degrades gracefully instead of crashing if the dependency is ever absent.
- The package API is **synchronous**; the provider wraps calls so they satisfy
  the async `DatabaseProvider` contract (they resolve immediately).

## 4. Connection shape

Reuse the existing `DatabaseConnection.database` field for the file path — exactly
like SQLite. No change to the `DatabaseConnection` interface.

```ts
const conn = { type: 'libredb', database: '/path/to/data.libredb' };
```

`'libredb'` is added to the `DatabaseType` union in `src/lib/types.ts`.

## 5. Provider design

New family: `src/lib/db/providers/embedded/libredb.ts`, exporting
`class LibreDBProvider extends BaseDatabaseProvider`. (Extends the NoSQL base, NOT
`SQLBaseProvider`.) Behaviour is driven through capabilities/labels; there are no
`=== 'libredb'` type-checks outside this provider class (per CLAUDE.md).

### 5.1 Lifecycle

- `validate()`: require `config.database` (the file path); else `DatabaseConfigError`.
- `connect()`: lazy-import `@libredb/libredb`, call `open({ path: database })`, hold
  the returned `Database` and a `kv(db)` lens; set connected.
- `disconnect()`: `db.close()` (idempotent), clear state.

### 5.2 `getSchema()` — prefix grouping

Scan the whole keyspace and group keys by their `:`-prefix into pseudo-tables,
the same convention the Redis provider uses:

- Read all entries via `kv.range('', '\u{10FFFF}')`: the empty-string start
  encodes to the lowest possible bytes, and `\u{10FFFF}` encodes above any
  UTF-8 text key the lenses produce, so the half-open interval covers the whole
  keyspace. Cap the scan at a sane maximum (e.g. 10k keys) and record if
  truncated. (`kv.prefix` cannot be used here — it rejects an empty prefix.)
- For `key` `"user:1"` the group is `"user:*"`; a key with no `:` is its own group.
- Emit one `TableSchema` per group: columns `key` (string, primary) and `value`
  (string), `rowCount` = keys in the group. Sort by `rowCount` desc.

### 5.3 `query()` — structured command form (not SQL)

`queryLanguage: 'json'`. Accept a small command grammar over the kv lens.
Whitespace-separated, values may be quoted (reuse the same tolerant parsing shape
as Redis's plain-command parser):

| Command | Effect | Result rows |
| --- | --- | --- |
| `get <key>` | `kv.get` | one `{ key, value }` row, or empty |
| `put <key> <value>` | `kv.set` | `{ changed }` |
| `delete <key>` | `kv.delete` | `{ changed }` |
| `prefix <p>` | `kv.prefix` | `{ key, value }` rows |
| `range <start> <end>` | `kv.range` | `{ key, value }` rows |

- Values that parse as JSON are pretty-printed in the `value` column; otherwise
  shown as-is.
- Writes are durable (the package fsyncs file-backed writes before returning).
- Unknown commands throw a `QueryError` with the supported-command list.

### 5.4 Capabilities and labels

- Capabilities: `queryLanguage: 'json'`, `supportsExplain: false`,
  `supportsExternalQueryLimiting: false`, `supportsCreateTable: false`,
  `supportsMaintenance: false`, `maintenanceOperations: []`,
  `supportsConnectionString: false`, `defaultPort: null`,
  `schemaRefreshPattern` matching `put`/`delete`.
- Labels: entity = "Key Prefix" / "Key Prefixes", row = "key"/"keys",
  select action = "Scan Keys", search placeholder = "Search keys...".

### 5.5 Monitoring methods

Return honest, minimal data — it is an embedded file, not a server:

- `getOverview()`: version from the package, `databaseSize`/`Bytes` from the
  file's size on disk, `tableCount` = prefix-group count, no connections.
- `getStorageStats()`: one entry with the file path and size.
- `getHealth()`, `getPerformanceMetrics()`: minimal/empty.
- `getSlowQueries()`, `getActiveSessions()`, `getTableStats()`,
  `getIndexStats()`: return `[]`.
- `runMaintenance()`: unsupported in v1 — throws a `QueryError`.

## 6. UI / config wiring

Add `libredb` everywhere a database type is enumerated, modelled on SQLite (a
file-path provider with no host/port/credentials):

- `src/lib/types.ts` — `DatabaseType` union.
- `src/lib/db/factory.ts` — `case 'libredb'` with dynamic import of the provider.
- Connection form/modal (`use-connection-form.ts`, `ConnectionModal.tsx`) — show a
  file-path input, hide host/port/user/password (same branch as SQLite).
- `src/lib/seed/types.ts` — allow seeding a `libredb` connection.
- `src/lib/connection-string-parser.ts` — guard so it is treated as file-based.
- `src/workspace/StudioWorkspace.tsx`, `src/components/Studio.tsx` — type lists /
  icons.

Exact sites are confirmed during planning; the rule is: wherever SQLite is
special-cased as a file provider, `libredb` joins it.

## 7. Tri-sync deliverables (CLAUDE.md provider invariant)

All three in the same PR, 1:1 for type-id `libredb`:

- **Code:** `src/lib/db/providers/embedded/libredb.ts`.
- **Docs:** `docs/providers/libredb.md` — mirrors the code, following the existing
  provider-doc template (connection fields, query format, capabilities, examples,
  limitations). This design spec is the precursor, not that doc.
- **Tests:** `tests/integration/db/libredb-provider.test.ts`.

## 8. Testing strategy (TDD)

Write the integration test first and watch it fail before implementing:

1. Open a temp `.libredb` file directly via `@libredb/libredb` and seed keys across
   several prefixes (`user:1`, `user:2`, `order:1`), including one JSON value.
2. Construct `LibreDBProvider` against that file, `connect()`.
3. Assert `getSchema()` groups keys into `user:*` / `order:*` with correct counts.
4. Assert `query('get user:1')`, `query('prefix user:')`, `query('range ...')`
   return the expected `{ key, value }` rows, JSON value pretty-printed.
5. Assert a write round-trip: `query('put k v')` reports `changed`, and a
   subsequent `get`/`getSchema()` reflects it durably.
6. Assert `validate()` rejects a missing path, and `disconnect()` is safe.

Honour the repo's test-isolation rules (`bun run test`, never bare `bun test`;
the provider module must not poison `mock.module()` consumers).

## 9. Later (depends on libredb-database)

When the database-side catalog (libredb-database `DESIGN.md` §6.3) ships, extend
this provider to read `catalog(db)` and present faithful per-kind views —
document collections, relational tables with columns/types, kv namespaces —
replacing the raw-prefix grouping. The provider interface, capabilities, and UI
wiring established here are the stable foundation for that evolution.

## 10. Verification gates

After implementation, run all mandatory gates locally (they match CI):
`bun run lint` · `bun run typecheck` · `bun run test` · `bun run build`, plus
`bun run build:lib` (this is a platform-facing change) to confirm `@libredb/studio`
still builds with `@libredb/libredb` externalized and the provider works in both
standalone and embedded modes.
