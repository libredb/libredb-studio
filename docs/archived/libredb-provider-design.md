# LibreDB Studio Provider — Design Spec (Option A: embedded raw-KV browser)

> **SUPERSEDED.** This precursor sketch has been superseded by:
> - [`docs/superpowers/specs/2026-06-24-libredb-embedded-provider-design.md`](../superpowers/specs/2026-06-24-libredb-embedded-provider-design.md) — the approved design spec
> - [`docs/providers/libredb.md`](libredb.md) — the provider reference documentation (implementation is complete)
>
> Original status note: design spec for a future implementation session. NOT built yet.
> Lets LibreDB Studio connect to a local LibreDB database file (the embedded `libredb` package —
> the open-source database in the sibling `libredb-database` repo) by importing the package and
> opening the file IN the Studio server process — the same embedded pattern Studio uses for SQLite.
> `libredb-database` reference document path: /home/cevheri/projects/libredb/libredb-database/DESIGN.md, /home/cevheri/projects/libredb/libredb-database/README.md
## 1. Why embedded, not a connection

LibreDB has no server and no wire protocol — that is a deliberate, locked design decision (embedded-first). So Studio connects the SQLite way: import the `libredb` package and open the file in-process. The file must live on the Studio server's filesystem. There is no "remote LibreDB" to connect to. (If a networked LibreDB is ever wanted, it would be a separate optional server product — not this provider.)

## 2. The key constraint: what this provider can and cannot show

A LibreDB file is raw ordered key-value bytes. The lens (kv / document / relational) and any relational table schema live in application code, NOT on disk. So **Option A shows the file as a raw ordered-KV store** — keys grouped by prefix, values shown as-is. It does NOT reconstruct relational tables/schemas, because that information is not persisted.

Richer per-kind views (real collections, tables, schemas) are "Option B" and are **blocked on a database-side catalog** (see `libredb-database` DESIGN.md section 6.3). When that ships, this provider can read `catalog(db)` and present faithful views; until then, raw KV is the honest representation.

## 3. Shape: like the Redis/Mongo providers, not the SQL editor

LibreDB has no SQL, so this is a NoSQL-style provider:

- **Base class:** extends `BaseDatabaseProvider` (NOT `SQLBaseProvider`). Drive behaviour through capabilities/labels; no `=== 'libredb'` type-checks outside the provider class (per CLAUDE.md).
- **Connection:** `{ type: 'libredb', database: '/path/to/data.libredb' }` — file-based, reusing the `database` field like SQLite. Server-side only (touches the filesystem).
- **`getSchema()`:** open the file (`open({ path })`), scan the ordered KV via the package's range/prefix API, and group keys by their `:`-prefix into "tables" — the same convention the Redis provider uses for key prefixes. Each group lists its keys; values are rendered as-is and JSON pretty-printed when parseable.
- **Query model:** a structured / command form (NOT SQL) — `get`, `put`, `delete`, `range(start, end)`, `prefix(p)` — mapping onto the package's kv-level access. Reads return `{ key, value }` rows; writes go through the package (file-backed writes are durable / fsync'd).
- **Capabilities/labels:** declare no-SQL; "tables" = key prefixes; expose read + write. The kernel's multi-key `transact` may be surfaced as an advanced affordance later (see open forks).

## 4. Tri-sync deliverables (per CLAUDE.md provider invariant)

All three in the same PR, 1:1 for type-id `libredb`:

- **Code:** `src/lib/db/providers/<family>/libredb.ts` (a new family, or grouped with the embedded/file providers).
- **Docs:** `docs/providers/libredb.md` (mirrors the code; this design spec is the precursor, not that doc).
- **Tests:** `tests/integration/db/libredb-provider.test.ts` — open a temp file via the package, write a few keys across prefixes, assert `getSchema()` groups them and queries return them; test JSON-value rendering and a write round-trip.

## 5. Dependency & build notes

- Add `libredb` as a dependency. It is a TypeScript/ESM package; verify it works in Studio's Bun/Next server runtime **and** survives `build:lib` (tsup) so the embedded `@libredb/studio` npm package still builds.
- The provider is server-side only, like the SQLite and storage providers — it must not be imported into client bundles.
- LibreDB's API is synchronous; wrap its calls to satisfy the provider interface's async contract (they resolve immediately).

## 6. Open forks (ratify at build time)

- Provider "family" name: a new `embedded`/`file` family vs grouping under an existing one.
- Whether to expose the kernel `transact` (multi-key atomic writes) in the query UI now or defer.
- Read-only vs read-write in v1 — recommend read-write (the package supports it; matches other providers).
- In-memory connections (`open()` with no path) are ephemeral and empty per Studio session, so likely omit; the provider targets a persisted file.

## 7. Later (depends on libredb-database)

When the database-side catalog (libredb-database DESIGN.md 6.3) ships, extend this provider to read `catalog(db)` and present faithful per-kind views: document collections, relational tables with their columns/types, and kv namespaces — replacing the raw-prefix grouping with real schema-aware browsing.
