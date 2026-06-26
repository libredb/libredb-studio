# LibreDB Embedded Sample — Design Spec

> Status: approved design, ready for implementation planning.
> Adds a first-run, editable, dismissable **sample LibreDB database** so a freshly
> installed Studio opens with a working, explorable connection instead of an empty
> screen — and showcases the embedded `@libredb/libredb` engine (all three lenses).

## 1. Goal and non-goals

**Goal.** On first startup of the standalone Studio, automatically provide a
`libredb` connection named **"Sample (LibreDB)"** backed by a real `.libredb`
file pre-seeded with example data covering all three lenses (relational table,
document collection, raw key-value). It is a normal, **editable, deletable**
connection — not a locked/managed one. Gated by an env flag, **default on**.

**Why.** Removes the empty-first-run experience for a very new product, and
raises usage/visibility of the now-public `@libredb/libredb` engine (~4 kB, zero
deps — negligible footprint).

**Non-goals.**
- Not a locked/`managed` (read-only) connection — the user can edit and delete it.
- No behavior in **embedded/platform** mode (the `@libredb/studio` package): the
  sample must never appear there. This falls out of the design (see §4), not a
  special case.
- No re-seeding of an existing sample file (never clobber user edits).
- No new connection CRUD API — reuse the existing seed/managed path.

## 2. Naming (locked)

- Env flag: **`LIBREDB_EMBEDDED_SAMPLE`** — `true` (default) provisions the sample;
  `false` disables it. Server-side only (NOT `NEXT_PUBLIC_`).
- Optional path override: **`LIBREDB_EMBEDDED_SAMPLE_PATH`** — the `.libredb` file
  location. Default: `<dirname of STORAGE_SQLITE_PATH or ./data/libredb-storage.db>/sample.libredb`
  (i.e. `/app/data/sample.libredb` in Docker — the writable, non-root path verified
  in the 0.9.30 Docker validation).
- Connection display name: **"Sample (LibreDB)"**.
- Seed id: **`libredb-embedded-sample`** (wire id `seed:libredb-embedded-sample`).

## 3. Architecture

Two cooperating pieces plus one small, general enhancement. Both pieces hook into
places that **only execute in standalone mode**, which is what keeps the feature
out of platform.

### 3.1 File seeding at boot

- **`instrumentation.ts`** (new, project root): Next.js calls `register()` exactly
  once per worker at server boot, and only when *this* app boots its own Next.js
  server — never when `@libredb/studio` is imported by platform. `register()`
  invokes the seed module guarded by the enabled flag.
- **`src/lib/seed/libredb-sample.ts`** (new) holds all logic so `instrumentation.ts`
  stays a thin wire:
  - `isSampleEnabled(): boolean` — `process.env.LIBREDB_EMBEDDED_SAMPLE !== 'false'`
    (default on; only the literal `'false'` disables).
  - `resolveSamplePath(): string` — `LIBREDB_EMBEDDED_SAMPLE_PATH` else
    `path.join(path.dirname(STORAGE_SQLITE_PATH ?? './data/libredb-storage.db'), 'sample.libredb')`.
  - `seedSampleFile(filePath): Promise<void>` — if the file already exists, return
    (idempotent, never clobber). Otherwise create the parent dir, lazy-import
    `@libredb/libredb`, and seed the dataset (§5). The whole call is wrapped by the
    caller in `try/catch` that logs a warning and swallows — **a seed failure must
    never break server boot**.
  - `buildSampleConnection(): ManagedConnection` — the built-in connection
    descriptor (see §3.2).

### 3.2 Exposing the connection (extend the seed/managed path)

- **`src/lib/seed/index.ts`** — `getManagedConnections(roles)` additionally returns
  the built-in sample connection when `isSampleEnabled()` **and the sample file
  exists** (`fs.existsSync(resolveSamplePath())`). Gating on file existence means a
  failed/skipped seed never advertises a broken connection. Shape:
  ```ts
  {
    id: 'seed:libredb-embedded-sample',
    seedId: 'libredb-embedded-sample',
    name: 'Sample (LibreDB)',
    type: 'libredb',
    database: resolveSamplePath(),
    managed: false,            // editable + deletable
    roles: ['*'],
    createdAt: new Date(0),    // fixed/stable so the descriptor doesn't churn across boots
  }
  ```
  It is merged with any YAML-defined seed connections (the sample is additive). The
  existing client merge/dedup (`useConnectionManager`, `useAllConnections`, dedup by
  `seedId`/`id`) copies it into the user's storage on first encounter — no new client
  path for the happy case.

### 3.3 Dismissable — general "dismissed seed ids"

Today a `managed:false` seed re-appears after deletion (the managed route always
returns it; the client re-copies it because it is missing from storage). Fix it
generally:

- Storage: add a `dismissedSeeds: string[]` collection to `StorageData` (and the
  storage types). Persisted through the same write-through path as other collections.
- `useConnectionManager` / `useAllConnections`: when copying `managed:false` seeds
  into storage, **skip any `seedId` present in `dismissedSeeds`**. When the user
  deletes a connection that carries a `seedId`, **add that `seedId` to
  `dismissedSeeds`**. So a deleted sample (or any future editable seed) stays gone.

## 4. Why platform/embedded is safe by construction

- `instrumentation.ts` `register()` runs only when this app boots its own Next.js
  server. Platform has its own Next.js instance and imports `@libredb/studio` as a
  component library; our `instrumentation.ts` never executes there → no sample file
  is seeded into platform.
- Platform renders `StudioWorkspace` and passes connections in as props; it does not
  call `GET /api/connections/managed` → the built-in sample connection is never
  surfaced there.
No `LIBREDB_STANDALONE`-style flag is needed.

## 5. Sample dataset (all three lenses + catalog)

Seeded once into the file via the package lenses:

- **Relational** — `table(db, 'users', { primaryKey: 'id', columns: { id: 'string',
  name: 'string', age: 'number', active: 'boolean' } })` with ~3 rows (e.g. Ada,
  Grace, Edsger). Renders in Studio with real typed columns (catalog-aware).
- **Document** — `doc(db, 'articles')` with ~2 JSON docs (e.g. `{ title, body,
  tags }`). Renders as an `id` + `document` collection.
- **Key-value** — `kv(db)` raw keys under a prefix, e.g. `config:theme = dark`,
  `config:locale = en`. Renders as the `config:*` prefix group.

This shows the relational, document, and raw-kv views and the catalog reconciliation
in one connection.

## 6. Storage-mode behavior

- `local` (default): connections live in browser storage. The managed route returns
  the sample post-login; `useConnectionManager` copies it to localStorage (subject
  to `dismissedSeeds`). The file lives server-side at the resolved path.
- `sqlite` / `postgres`: identical flow; the copy lands in server storage
  (`user_storage`) instead of localStorage.
In all modes the `.libredb` file itself is server-side.

## 7. Error handling

- Seed failure (unwritable path, `@libredb/libredb` unavailable, etc.): the boot hook
  logs a warning and continues; no file is created; `getManagedConnections` therefore
  omits the sample → Studio opens empty exactly as today. No crash, no broken
  connection.
- Opening a sample whose file was later removed: the provider already errors
  gracefully (it validates/opens the path; a missing file simply yields no data or a
  clear error).

## 8. Testing strategy (TDD)

Logic lives in testable modules; `instrumentation.ts` is a thin wire (not unit-tested
directly).

- `seedSampleFile`: on a temp path, creates and seeds the file; re-opening via
  `@libredb/libredb` shows catalog `users` = relational (with the declared columns),
  `articles` = document, and the `config:*` kv keys. **Idempotent**: a second call on
  an existing file does not modify it.
- `isSampleEnabled` / `resolveSamplePath`: default-on; `'false'` disables; path
  override and the data-dir-derived default.
- `getManagedConnections`: includes the sample (`managed:false`, correct `seedId`,
  `database` = resolved path) when enabled **and** file exists; excludes it when
  disabled or when the file is absent; still merges YAML seeds.
- Dismissed-seed logic: copying skips dismissed `seedId`s; deleting a seeded
  connection records its `seedId` in `dismissedSeeds` (hook or extracted-helper test).
- Respect repo test rules (`bun run test`, never bare `bun test`).

## 9. File structure

- Create: `instrumentation.ts` (root) — `register()` → seed-on-boot wire.
- Create: `src/lib/seed/libredb-sample.ts` — enabled/path/seed/connection logic.
- Modify: `src/lib/seed/index.ts` — include the sample in `getManagedConnections`.
- Modify: `src/hooks/use-connection-manager.ts` and `src/hooks/use-all-connections.ts`
  — dismissed-seed skip + record.
- Modify: `src/lib/storage/types.ts` (+ providers as needed) — `dismissedSeeds`
  collection.
- Modify: `.env.example` — document `LIBREDB_EMBEDDED_SAMPLE` and
  `LIBREDB_EMBEDDED_SAMPLE_PATH`.
- Docs: note the feature where provider/onboarding docs live.
- Tests: unit/hook tests per §8.

## 10. Verification gates

All mandatory local gates (match CI): `bun run lint` · `bun run typecheck` ·
`bun run test` · `bun run build` · `bun run knip`, plus `bun run build:lib` (this
touches hooks/storage consumed by the package). Confirm the sample appears on a
fresh standalone run and is absent in embedded mode.
