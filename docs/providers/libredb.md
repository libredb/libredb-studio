# LibreDB Provider

> Embedded key-value store support for LibreDB Studio, built on the
> [`@libredb/libredb`](https://github.com/libredb/libredb-database) package.
> This document is the single reference point for the LibreDB provider: design, architecture,
> usage, and tests. If you are reading the code, extending LibreDB support, or authoring a new
> provider, start here.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `libredb` |
| **Family** | Embedded / Key-Value (`src/lib/db/providers/embedded/`) |
| **Driver** | `@libredb/libredb` `^0.2.2` (lazy dynamic import) |
| **Query language** | `json` (small command grammar — NOT SQL) |
| **Default port** | None (embedded in-process, no network) |
| **Connection pooling** | None — single in-process file handle |
| **Source** | [`src/lib/db/providers/embedded/libredb.ts`](../../src/lib/db/providers/embedded/libredb.ts) |
| **Tests** | [`tests/integration/db/libredb-provider.test.ts`](../../tests/integration/db/libredb-provider.test.ts) |

---

## 1. Overview

LibreDB is an embedded, ordered key-value store with no server and no wire protocol. A `.libredb`
file is raw ordered key-value bytes on disk; the `@libredb/libredb` package opens and operates on
that file in-process, synchronously. LibreDB Studio is a SQL-oriented IDE, so the central design
problem is the same one the Redis provider faced:

> **How do you present a key-value store through the same `DatabaseProvider` interface that
> PostgreSQL, MySQL, and the rest implement — without emulating SQL and without leaking
> database-specific concepts into the shared UI?**

The answer is **mapping by convention, not emulation**. The provider does not pretend LibreDB is
relational. Instead it maps LibreDB concepts onto the slots the interface already exposes, and
relabels the UI through the provider-metadata hooks (`getCapabilities()` / `getLabels()`) so the
generic components render LibreDB-appropriate wording.

### Concept mapping

| `DatabaseProvider` slot | LibreDB realisation | Mechanism |
|-------------------------|---------------------|-----------|
| "Table" (`TableSchema`) | A **cataloged namespace** (relational table / document collection) or, for uncataloged keys, a **key prefix** (e.g. `user:*`) | `catalog(db)` for cataloged kinds; `kv.range` scan + prefix grouping for raw kv |
| "Row" | A **key** | — |
| `query(input)` | A command (`get`/`put`/`delete`/`prefix`/`range`) | `kv` lens methods |
| `getHealth()` / `getOverview()` | File stats | `fs.statSync` + prefix count |
| `getStorageStats()` | File path and size on disk | `fs.statSync` |
| `getSlowQueries()` | Not applicable | returns `[]` |
| `getActiveSessions()` | Not applicable (single embedded process) | returns `[]` |
| `runMaintenance(type)` | Not supported (throws) | — |
| Indexes / table stats | Not applicable | returns `[]` |

---

## 2. Architecture

### 2.1 Where it sits

The database layer uses the **Strategy Pattern**. Every provider implements the
[`DatabaseProvider`](../../src/lib/db/types.ts) interface, and most shared mechanics live in the
abstract [`BaseDatabaseProvider`](../../src/lib/db/base-provider.ts). Providers are grouped by
family on disk:

```
src/lib/db/
├── base-provider.ts          # abstract base: state, helpers, default metadata, getMonitoringData()
├── types.ts                  # DatabaseProvider interface + all DTOs
├── errors.ts                 # DatabaseError hierarchy + mapDatabaseError()
├── factory.ts                # createDatabaseProvider() — dynamic import per type + provider cache
└── providers/
    ├── sql/                  # postgres, mysql, sqlite, oracle, mssql (extend SQLBaseProvider)
    ├── document/             # mongodb
    ├── keyvalue/             # redis
    └── embedded/
        └── libredb.ts        # <- LibreDBProvider (this document)
```

### 2.2 Class hierarchy

```
DatabaseProvider (interface, types.ts)
        ^
        | implements
BaseDatabaseProvider (abstract, base-provider.ts)
        ^
        | extends
LibreDBProvider (libredb.ts)
```

`LibreDBProvider` extends `BaseDatabaseProvider` directly (the same pattern as `RedisProvider`).
It overrides every abstract method plus the three metadata hooks (`getCapabilities`, `getLabels`,
`prepareQuery`). It inherits `getMonitoringData()`, which fans the individual monitoring methods
out in parallel.

### 2.3 What the base class gives you for free

`LibreDBProvider` reuses these inherited members rather than reimplementing them:

- **State machine** — `setConnected()`, `setError()`, `isConnected()`, `ensureConnected()`.
- **Instrumentation** — `trackQuery()` (active-query counter) and `measureExecution()` (wall-clock timing).
- **Helpers** — `formatDuration()`, `getSafeConfig()` (password-stripped logging), `logError()`.
- **Default `getMonitoringData()`** — orchestrates `getOverview` + `getPerformanceMetrics` +
  `getSlowQueries` + `getActiveSessions` (+ optional tables/indexes/storage) concurrently.

### 2.4 Registration & lifecycle

The factory wires LibreDB in via a dynamic import so the `@libredb/libredb` driver is only loaded
when a LibreDB connection is actually opened
([`factory.ts:100`](../../src/lib/db/factory.ts)):

```ts
case 'libredb': {
  const { LibreDBProvider } = await import('./providers/embedded/libredb');
  return new LibreDBProvider(connection, options);
}
```

The package is loaded lazily and the result is cached in a module-level variable — repeated
`connect()` calls do not re-import. API routes use `getOrCreateProvider()`, which caches the
connected provider per `connection.id` and evicts it after 30 minutes idle. `disconnect()` is
called on eviction and on graceful shutdown (`SIGTERM` / `SIGINT`).

---

## 3. Design decisions

These are the non-obvious choices. Read this section before changing the provider.

### 3.1 File path in `config.database`, not a custom field

The `DatabaseConnection` type already has a `database` field. Rather than introduce a custom
`path` field (which would require UI / API / type changes), the provider reuses `database` for the
file path — the same pattern used by the SQLite provider. A missing `database` is a
`DatabaseConfigError` at `validate()` time; there is no in-memory fallback.

### 3.2 No in-memory connections

`open()` without a path creates an ephemeral in-memory store that is discarded when the process
closes. This offers no durable value for a GUI tool, so the provider explicitly requires a file
path and throws rather than silently opening an in-memory database.

### 3.3 Catalog-aware schema, with key-prefix grouping as the raw-kv fallback

Since `@libredb/libredb` 0.0.2 a `.libredb` file carries a persisted **catalog**: the lenses
record, under a reserved key prefix, which lens (`document` / `relational`) each namespace belongs
to and — for a relational table — its declared column schema. `getSchema()` reads `catalog(db)`
and renders a faithful per-kind view:

- **Relational** namespace: the table's **real columns** and types from the catalog schema, with
  the `primaryKey` column marked `isPrimary`. The database `ColumnType`
  (`string | number | boolean | object`) maps straight onto the studio column descriptor's `type`
  string; v1 relational columns are all required, so `nullable` is `false`.
- **Document** namespace: generic `id` (string, primary) + `document` (object) columns —
  documents are schemaless, so there are no declared per-field columns.
- **Uncataloged** (raw kv) namespace: the historical `key` (string, primary) + `value` (string,
  nullable) columns.

Studio's `TableSchema` has no dedicated "kind" field, so the kind is signalled by the columns
themselves: real columns ⇒ relational, `id`/`document` ⇒ document, `key`/`value` ⇒ raw kv.

`groupName()` ([`libredb.ts`](../../src/lib/db/providers/embedded/libredb.ts)) still drives the raw
grouping: everything before the first `:` plus `:*`, so `user:1` and `user:2` both collapse into
the `user:*` group, and a key with no colon (e.g. `config`) becomes its own single-key group named
`config`. This is the same convention as the Redis provider.

**Reconciling catalog names with scanned key groups.** A catalog entry named `N` owns the keys
`N:...` (a relational table stores rows under `<table>:<pk>`; a document collection under
`<collection>:<id>`), which the scan groups as `N:*`. The provider therefore strips a trailing
`:*` from a scanned group name to recover the namespace and looks it up in the registry; a match
upgrades the group to its catalog-aware columns. Cataloged namespaces with no scanned rows yet
(an empty table/collection) are still emitted, with `rowCount: 0`.

`getSchema()` scans up to `MAX_SCAN = 10000` keys via `kv.range('', '\u{10FFFF}')` — a half-open
interval that covers the entire keyspace. The resulting `TableSchema` list is sorted by descending
row count so the largest groups appear first.

### 3.3.1 Reserved namespace is excluded from every user-facing view

The database stores internal metadata (the catalog, and any future internal sub-namespace) under a
reserved key prefix — `RESERVED_MARKER` (U+0000, the lowest byte). Because U+0000 sorts below all
user data, those keys fall inside the provider's full-keyspace scan. They are internal, so the
provider filters them out in **both** `getSchema()` grouping **and** the `range`/`prefix` query
result rendering (`toRows`). Without the filter, a file written via `doc()`/`table()` would leak a
junk `\x00libredb:*` pseudo-table and catalog rows into results.

The filter uses the package's pinned **`isReservedKey`** predicate (exported since
`@libredb/libredb` 0.0.3), accessed via the lazily-loaded module — not a hardcoded prefix.
`isReservedKey` tests the U+0000 **marker**, not the specific `catalog:` tail, so it hides the
*entire* reserved namespace, not just catalog entries. This is the robust boundary: the database
forbids user namespace names from starting with the marker (`assertUserName`), so the predicate can
never hide user data, and the database can evolve its internal key layout without Studio silently
leaking it.

### 3.4 Synchronous package, async provider contract

The `@libredb/libredb` API is synchronous. All calls are wrapped in `async` methods that resolve
immediately, satisfying the `DatabaseProvider` async contract without any overhead. `trackQuery`
and `measureExecution` still record wall-clock time accurately even for synchronous operations.

### 3.5 Command grammar, not SQL

The provider defines a small five-verb command language over the kv lens. Tokenization is
quote-aware: single and double quotes are honored, an unmatched quote is rejected with a
`QueryError`, and consecutive whitespace outside quotes is collapsed to a single token boundary.
The tokenizer is `private tokenize()` in the provider class.

### 3.6 JSON pretty-printing for values

`renderValue()` attempts `JSON.parse` on every value string. If it succeeds, the value is
re-serialized with `JSON.stringify(parsed, null, 2)` for readability in the grid. Non-JSON
strings are returned as-is. This mirrors how the Redis provider handles structured values.

### 3.7 Monitoring is file-stat-based

Unlike Redis (`INFO`) or PostgreSQL (system catalogs), LibreDB has no server introspection API.
Overview and storage stats derive entirely from `fs.statSync` (file size in bytes) and a schema
scan (prefix group count). There are no sessions, slow queries, or index statistics — those
methods return empty arrays — and no cache statistics either, so there is no cache hit ratio to
report ([§7.1](#71-there-is-no-cache-hit-ratio-and-there-never-will-be)).

---

## 4. Connection

### 4.1 Configuration fields

LibreDB uses the `database` field of `DatabaseConnection` for the file path. All other network
fields are ignored.

| Field | Required | Notes |
|-------|----------|-------|
| `database` | Yes | Absolute path to the `.libredb` file on the Studio server's filesystem. Throws `DatabaseConfigError` if absent. |

No `host`, `port`, `user`, `password`, or `connectionString` fields are used. The `supportsConnectionString`
capability is `false`.

```ts
const connection = {
  id: 'libredb-1',
  name: 'App Data',
  type: 'libredb',
  database: '/data/app.libredb',
  createdAt: new Date(),
};
```

### 4.2 File must exist on the Studio server

The `.libredb` file must be accessible on the filesystem of the machine running the Studio server.
Remote LibreDB is not possible — the database has no server or wire protocol by design. If the
file does not exist at `connect()` time, the `@libredb/libredb` package will create it (an empty
ordered-KV store). If the path is missing entirely, `connect()` throws `DatabaseConfigError`
before attempting to open anything.

### 4.2.1 On-disk format, locking, and version compatibility (0.2.x)

Since `@libredb/libredb` 0.2.0 the driver hardens the file boundary; the provider surfaces each
condition as a clear `ConnectionError` (see [§10](#10-error-handling)):

- **`LRDB` header.** New databases begin with an 8-byte magic/version header. Files written by
  0.1.x (headerless) keep opening through a legacy read path — upgrading Studio does not require
  migrating existing files.
- **Foreign files are refused untouched.** Opening a file that is not a LibreDB database throws
  `NOT_A_DATABASE` and leaves the file byte-for-byte intact (0.1.x silently truncated it to zero).
  A file written by a newer format version is refused as `UNSUPPORTED_VERSION`, also untouched.
- **Exclusive per-file lock.** `open()` takes an exclusive `<path>.lock` sidecar (pid/host/nonce).
  A second writer — another Studio connection to the same file, an external process, or the
  `libredb` CLI — fails loudly with `LOCKED` instead of silently diverging. The lock is released
  on `disconnect()`; locks from verifiably dead holders are reclaimed automatically. To *read* a
  file a live writer holds, external tooling can use the package's `readonlyFileSystem` (no lock,
  no writes).
- **Provider cache interaction.** Studio caches a connected provider per connection id and evicts
  it after 30 minutes idle — the lock is held that whole time. To edit the same file with external
  tooling, disconnect the Studio connection first (or wait for eviction); otherwise the external
  writer gets `LOCKED`.

> **DOWNGRADE WARNING:** a file written by `@libredb/libredb` 0.2.x must never be opened by 0.1.3
> or older. The old recovery cannot parse the header, classifies the whole file as a torn tail,
> and silently truncates it to zero bytes. Back up before any downgrade.

### 4.3 Sample connection (standalone mode)

On the first startup of a **standalone** Studio instance (i.e. not embedded inside
libredb-platform), Studio automatically creates a connection named **"Sample (LibreDB)"** seeded
with example data covering each lens (relational table, document collection, raw kv). This gives
new users a working LibreDB file to explore immediately.

The sample connection is fully editable and deletable. Once deleted it stays gone — Studio tracks
dismissed seeds and will not recreate it. It is never injected when Studio runs as an embedded
package inside libredb-platform.

**Env vars:**

| Variable | Default | Notes |
|----------|---------|-------|
| `LIBREDB_EMBEDDED_SAMPLE` | `true` | Set to `"false"` to disable the sample connection entirely. |
| `LIBREDB_EMBEDDED_SAMPLE_PATH` | `<data dir>/sample.libredb` | Optional override for the path of the generated sample file. |

---

## 5. Query interface

### 5.1 Command grammar

The query input is a plain text command, not SQL. The supported verbs are:

```
get <key>
put <key> <value>
delete <key>
prefix <prefix>
range <start> <end>
```

Rules:

- Verb matching is case-insensitive (`GET`, `get`, and `Get` all work).
- Arguments are split on whitespace. Single and double quotes preserve whitespace within a token
  (`put k "hello  world"` stores the value `hello  world` with two spaces).
- An unmatched quote is rejected immediately with a `QueryError`.
- Consecutive whitespace outside quotes is collapsed — `put key hello  world` stores
  `hello world` (one space), not `hello  world`.
- `range` is half-open: `[start, end)` — the start key is included, the end key is excluded.
- An empty command or an unknown verb raises `QueryError` listing the supported verbs.
- **Comments and multi-line input:** blank lines and lines beginning with `#` (after trimming) are
  skipped, and the **first** remaining line is executed. This makes the "Generate Command" cheatsheet
  (a commented, multi-line template) directly runnable: selecting one command line runs it, and
  running the whole buffer runs its first real command. A line is a comment only when it *starts*
  with `#`, so `#` inside a key or value is never mistaken for one. Input that is only comments or
  blank lines raises `QueryError`.

### 5.2 Result shaping

| Command | `fields` | Example row |
|---------|----------|-------------|
| `get` (found) | `key`, `value` | `{ key: 'user:1', value: 'Ada' }` |
| `get` (missing) | `key`, `value` | (zero rows) |
| `put` | `changed` | `{ changed: 1 }` |
| `delete` | `changed` | `{ changed: 1 }` (or `0` if the key did not exist) |
| `prefix` | `key`, `value` | one row per matching key |
| `range` | `key`, `value` | one row per key in `[start, end)` |

JSON values in the `value` column are pretty-printed with two-space indentation when they parse
successfully. Non-JSON strings are left as-is.

The command grammar is **unchanged** by the catalog work — only the schema *view* (`getSchema()`)
became catalog-aware. `get`/`put`/`delete`/`prefix`/`range` still operate on the raw kv keyspace
exactly as before. The one behavioural refinement: `prefix` and `range` results filter out any key in the reserved
namespace (via the package's `isReservedKey` predicate), so a full-keyspace `range` no longer leaks
internal metadata.

### 5.3 Schema-explorer menu actions

Right-clicking a node in the schema tree (or its `⋮` menu) offers commands generated for that
node, so you do not have to type the grammar from memory. The generation is driven by the
`queryDialect: 'libredb'` capability, which routes the shared client-side query generators
(`src/lib/query-generators.ts`) to LibreDB output instead of the MongoDB-JSON that
`queryLanguage: 'json'` otherwise implies. Redis took the same route in #427 with
`queryDialect: 'redis'`; MongoDB is now the only provider that reaches the JSON branch:

- **Scan Keys** runs `prefix <group>:` for a `:`-prefix group (e.g. `users:*` → `prefix users:`), or
  `get <name>` for a bare single-key node — except for a name carrying CR or LF, where it emits the
  same `#` note and no command as the cheatsheet does (see below).
- **Generate Command** inserts an explanatory cheatsheet — a use-case comment above each command —
  where every command line is a **concrete, directly-runnable example** (no `<placeholder>` tokens),
  so "Run Selected" on any line works as-is. The example `put` value is shaped by the group's
  columns: a JSON object built from a relational table's declared columns, a small JSON object for a
  document collection, or a plain string for raw kv. For a `users:*` relational group:

  ```text
  # LibreDB commands for "users:*" — select a line and Run Selected.

  # List every key under this prefix
  prefix users:

  # Read one entry by key
  get users:1

  # Create or update an entry
  put users:1 '{"id":"example","name":"example","age":1,"active":true}'

  # Delete an entry
  delete users:1
  ```

Because the provider skips `#` comment and blank lines (see 5.1), selecting a single line runs just
that command, and running the whole buffer runs the first real command (the prefix scan).

The node name in the header comment is **JSON-quoted**, not interpolated raw: a key name is
arbitrary text, and a name containing a newline used to end that comment and turn its own remainder
into the buffer's first runnable line. For an ordinary name the rendering is unchanged. The Redis
cheatsheet shares the helper and the defect (see `docs/providers/redis.md` §5.3) — that is where it
was found (#427).

The command lines themselves interpolate the node name **raw** — LibreDB's grammar has no quoting
and no lossless JSON command form to fall back to the way Redis's does. Since every LibreDB command
is line-oriented, a name containing CR or LF cannot be addressed by a generated line at all: a key
named `x\ndelete billing:2024` would render `delete billing:2024` as a line of its own that
**Run Selected** would execute. For such a name the cheatsheet emits the header plus a single `#`
note saying no generated line can address the key, and **no command line** (#427). The note stops
there rather than pointing at a hand-written command: `firstCommandLine()` splits the buffer on LF
before tokenizing, so an LF-bearing name cannot be reached from this editor at all. A CR survives
inside quotes and could be typed by hand, but one note covers both characters and advice that fails
for half of them is worse than none.

`Scan Keys` gives the same answer — the note on its own, no command — through the same code path, so
the two cannot drift. It matters more there than in the cheatsheet: `Scan Keys` auto-executes on a
node click, and it used to emit `get x\ndelete billing:2024`, whose second line sat in the editor as
a plausible, runnable `delete billing:2024` one **Run Selected** away (only `get x` ever ran, because
`firstCommandLine()` takes the first line). Auto-executing the note alone runs nothing and reports
*No command to run (only comments or blank lines)* (U11).

Two menu actions are **not offered** on this provider. `Profile Table` and `Generate Test Data`
address an object and insert rows into it; a `users:*` row is a prefix grouping this server derived
from one bounded scan (`tablesAreDerivedGroupings`, see 9), not an object any command can be given,
so both are hidden rather than left to answer HTTP 400 (#427). The per-row `Analyze` and `Vacuum`
items are hidden for the same reason — they call `onOpenMaintenance("tables", <row>)` and there is no
such row to name; the row menu reads no maintenance capability of its own. `Generate Code`
stays: it names the row, it does not address it, and it sanitises the name into an identifier that
is legal in every target language (`users:*` -> `User`), keeping Unicode letters intact.

---

## 6. Schema introspection

`getSchema()` returns one `TableSchema` per namespace, made catalog-aware:

```
1. registry = catalog(db)                  <- which namespaces are relational / document, + schemas
2. Iterate kv.range('', '\u{10FFFF}')      <- covers the entire keyspace
3. For each key:
     if isReservedKey(key) -> skip (the whole reserved internal namespace)
     prefix = substring before first ':'   -> append ':*'  (or the key itself if no colon)
     increment prefix.count
   Stop after 10 000 keys (MAX_SCAN)
4. For each scanned group:
     reconcile its name with the catalog (strip a trailing ':*' to get the namespace)
     relational  -> real columns + types from the catalog schema (primary key marked)
     document    -> generic id (primary) + document columns
     uncataloged -> key (primary) + value columns
5. Also emit any cataloged relational/document namespace with no scanned rows (rowCount 0)
6. Sort by rowCount desc
```

Column shape per kind:

| Kind | Columns | `indexes` |
|------|---------|-----------|
| Relational (cataloged) | the table's declared columns; `type` is the database `ColumnType` (`string`/`number`/`boolean`/`object`); `primaryKey` column has `isPrimary: true`; `nullable: false` (v1 columns are required) | `[]` |
| Document (cataloged) | `id` (string, primary) + `document` (object, nullable) | `[]` |
| Raw kv (uncataloged) | `key` (string, primary, not null) + `value` (string, nullable) | `[]` |

`rowCount` is the number of keys observed in that namespace's `:*` group (up to the scan cap); a
cataloged-but-empty namespace reports `0`.

The catalog lets the provider show faithful per-kind views without emulating SQL. Namespaces that
were written through the raw `kv` lens are never cataloged, so they keep the honest raw-KV
`key`/`value` view. The reserved-namespace keys are excluded from the schema (see
[§3.3.1](#331-reserved-namespace-is-excluded-from-every-user-facing-view)).

---

## 7. Monitoring & health

All monitoring derives from `fs.statSync` (file size) and a schema scan (prefix group count).
There is no embedded stats API.

| Method | Source | Returns |
|--------|--------|---------|
| `getHealth()` | `fs.statSync` | `activeConnections: 1`, file size as `databaseSize`, `cacheHitRatio: "N/A"` |
| `getOverview()` | `fs.statSync` + schema scan | `version`, file size, prefix-group count as `tableCount`, `indexCount: 0` |
| `getPerformanceMetrics()` | — | `{}` — nothing is measurable here |
| `getSlowQueries()` | — | `[]` (N/A) |
| `getActiveSessions()` | — | `[]` (N/A — single embedded process) |
| `getStorageStats()` | `fs.statSync` | one entry: file path + size |
| `getTableStats()` | — | `[]` (N/A) |
| `getIndexStats()` | — | `[]` (N/A) |

`getOverview().tableCount` calls `getSchema()` internally — it is a full scan, so it honors the
10 000-key cap and may undercount for very large files.

The `[]` and the absent metrics above now reach the panels as absence rather than as zero. The
**Tables** tab reads the empty `getTableStats()` against `tableCount` — prefix groups the store does
know about, with statistics for none of them — so its *Tables* and *Size* cards read `N/A` and the
list says *No table statistics available.* instead of summing `0` and `0 B`; the **Queries** tab's
three cards read `N/A` for the same reason, an average over no statements not being `0.00ms`; and
because `getPerformanceMetrics()` returns an empty object, every card on the Overview and Performance
tabs — *Cache Hit*, *Buffer*, *Deadlocks* — reads `N/A` beside *Not measured* rather than a
percentage or a `0` badged healthy.

### 7.1 There is no cache hit ratio, and there never will be

`getPerformanceMetrics()` used to report `cacheHitRatio: 100` and `getHealth()` `"100.0"`. Neither
was a reading. The embedded kernel's entire public surface is `open` / `kv` / `doc` / `table` /
`catalog` (`@libredb/libredb` 0.2.2) with no statistics call of any kind, and the store the provider
reads from is this process's own memory rather than a buffer pool with hits and misses — so there is
no counter to read and nothing a ratio would be a ratio *of*. A number this provider invents is worse
than a gap, because the panel cannot tell it apart from a measurement (the rule
[#424](https://github.com/libredb/libredb-studio/issues/424) exists to enforce). Both sites now omit
it, permanently: the *Cache Hit* card reads `N/A` / *Not measured*, and the agent's health tool
reports the string `"N/A"`.

---

## 8. Maintenance

No maintenance operations are supported. `runMaintenance(type)` always throws:

```
QueryError: Maintenance operation "<type>" is not supported for LibreDB
```

This is reflected in `getCapabilities().supportsMaintenance = false` and
`maintenanceOperations = []`. Both tabs that offer maintenance now hide it for this provider: the
monitoring **Tables** tab renders no per-row control when a provider declares maintenance
unsupported (issue #272) — and, on the same reading, its *Vacuum* summary card now reads `N/A` over
*Not supported* rather than the `0` over green **OK** that a bloat count over no rows produced, which
was a clean bill of health for an operation this provider does not offer — and the admin
**Operations** tab hides its whole Global Operations group and its per-table buttons (issue #282). Neither offers a control that could only
answer HTTP 400. The schema explorer's own per-row `Analyze`/`Vacuum` items are hidden here too, but
for a different reason — the rows are derived groupings, see 5.3.

---

## 9. Capabilities & labels

### `getCapabilities()`

| Capability | Value |
|------------|-------|
| `queryLanguage` | `json` |
| `queryDialect` | `libredb` (routes the client query generators to LibreDB command output; see 5.3) |
| `supportsExplain` | `false` |
| `supportsExternalQueryLimiting` | `false` |
| `supportsCreateTable` | `false` |
| `supportsInlineRowEdit` | `false` — the command grammar (`get`/`put`/`delete`/`prefix`/`range`) has no `UPDATE ... SET` for the results grid's inline editor to emit |
| `supportsTransactions` | `false` — the command grammar has no transaction verb at all, so the trio and SANDBOX are not offered (#U13) |
| `declaresForeignKeys` | `false` — the catalog declares namespaces and columns and nothing that references another namespace, so there is no foreign key to read |
| `tablesAreDerivedGroupings` | `true` — the namespaces come from a bounded `kv.range` over 10000 keys, grouped by prefix, so they are this server's summary of what one scan reached rather than objects the engine declares. The agent layer states this to a plan run in one sentence |
| `supportsMaintenance` | `false` |
| `maintenanceOperations` | `[]` |
| `supportsConnectionString` | `false` |
| `defaultPort` | `null` |
| `schemaRefreshPattern` | `\\b(put\|delete)\\b` |

`schemaRefreshPattern` tells the UI which executed commands should trigger a schema (key-pattern)
refresh — `put` and `delete` both add or remove keys.

### `getLabels()`

The label map relabels the generic schema-explorer UI for key-value semantics: entity ->
"Key Prefix", row -> "key", select -> "Scan Keys", generate -> "Generate Command",
analyze -> "Key Info", search placeholder -> "Search keys...", etc.

One label is about the monitoring tab instead: `slowQueriesEmptyState` -> *"LibreDB keeps no
statistics about finished statements in this version."* `getSlowQueries()` answers `[]`
unconditionally ([§7](#7-monitoring--health)), so the Queries panel is always empty here, and its
sentence was hardcoded to PostgreSQL's `pg_stat_statements` advice (`docs/BACKLOG.md` U12).

---

## 10. Error handling

The provider raises the shared error classes from
[`src/lib/db/errors.ts`](../../src/lib/db/errors.ts):

| Situation | Error |
|-----------|-------|
| Missing `database` path at construction | `DatabaseConfigError` |
| `@libredb/libredb` package not installed | `DatabaseConfigError` — install instructions in message |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails to open the file | `ConnectionError` |
| Empty command | `QueryError` — *"Empty command"* |
| Unknown verb | `QueryError` — lists supported verbs |
| Wrong argument count for a verb | `QueryError` — usage hint (e.g. *"Usage: get <key>"*) |
| Unmatched quote | `QueryError` — *"Unmatched quote in command"* |
| `runMaintenance(type)` | `QueryError` — *"Maintenance operation ... is not supported for LibreDB"* |

All `QueryError`s carry the `QUERY_ERROR` API code and surface to the client as `400 Bad Request`.

### 10.1 Kernel error codes (`LibreDbError.code`)

Since 0.2.0, every failure the `@libredb/libredb` kernel throws is a `LibreDbError` carrying a
stable `code` — the part a caller may branch on (messages are free to change between releases).
The provider maps the open-time codes to user-actionable `ConnectionError` messages in
`describeOpenError()`:

| Kernel code | When | Studio surfaces it as |
|-------------|------|----------------------|
| `LOCKED` | Another writer holds the file's exclusive lock | `ConnectionError` — *"already open by another process ... close the other writer"* |
| `NOT_A_DATABASE` | The file at the path is not a LibreDB database | `ConnectionError` — *"not a LibreDB database ... left untouched"* |
| `UNSUPPORTED_VERSION` | The file was written by a newer format version | `ConnectionError` — *"written by a newer version of LibreDB ... upgrade @libredb/libredb"* |
| `CORRUPT_WAL` | Mid-log corruption; the kernel refuses to destroy data | `ConnectionError` — *"write-ahead log is corrupt mid-file"* + kernel detail |
| `INVALID_ARGUMENT` (query-time) | Bad user input the lenses reject — e.g. a lone-surrogate (malformed UTF-16) key or value | `QueryError` with the kernel message (→ `400 Bad Request`) |
| any other code (`CLOSED`, `FAILED`, ...) | Storage/durability conditions | Rethrown untouched so the meaning survives to the caller |

The mapping branches on `error.code` via `instanceof lib.LibreDbError` — never on message text.

---

## 11. Testing

### 11.1 How the tests work

Integration tests live in
[`tests/integration/db/libredb-provider.test.ts`](../../tests/integration/db/libredb-provider.test.ts).
Unlike the Redis tests, these use the **real `@libredb/libredb` package** against a temporary
file — there is no `mock.module()`. Each test suite creates a fresh temp file via
`os.tmpdir()`, seeds it with a few keys across three prefix groups (`user:*`, `order:*`,
`config`), and deletes it in `afterEach`.

Because there is no `mock.module()`, this suite is exempt from the mock-isolation hazard
described in `CLAUDE.md`. It can be run alongside other tests in the same process without
cross-contamination.

### 11.2 Coverage

The suite covers: validation (missing path), connect/disconnect (real file + idempotent
disconnect), capabilities, labels, `getSchema` (prefix grouping, column definition, sort order),
all five query commands (`get` found, `get` missing, `prefix`, `range`, `put`, `delete`),
multi-word values, error paths (unknown verb, unmatched quote), and monitoring (`getOverview` file
size + group count, `getStorageStats` path + size, `runMaintenance` unsupported).

A dedicated **catalog-aware schema** suite seeds a file with a relational table (`table()`) and a
document collection (`doc()`) alongside the raw kv keys, then asserts: (a) `getSchema()` and
`range`/`prefix` queries never surface the reserved catalog prefix; (b) the relational table shows
its real declared columns with the primary key marked (the relational signal); (c) the document
collection shows the generic `id`/`document` columns (the document signal); and (d) raw kv
namespaces still group as `key`/`value` pseudo-tables.

A **0.2.x error mapping & locking** suite covers the hardened file boundary: a second open of a
live-locked file is a clear `ConnectionError` (`LOCKED`); `connect()` takes the exclusive
`<path>.lock` and `disconnect()` releases it; a non-LibreDB file is refused (`NOT_A_DATABASE`)
and left byte-for-byte untouched with no lock held; a newer-format file is refused
(`UNSUPPORTED_VERSION`); and a malformed UTF-16 (lone surrogate) `put` value surfaces as a
`QueryError` without poisoning the open handle. Test temp-file cleanup removes the `.lock`
sidecars alongside the database files.

### 11.3 Run it

```bash
# Just this file
bun run test tests/integration/db/libredb-provider.test.ts

# Full isolated suite (CI-equivalent)
bun run test
```

---

## 12. Usage examples

### 12.1 Connection object

```ts
const connection = {
  id: 'libredb-1',
  name: 'App Data',
  type: 'libredb',
  database: '/data/app.libredb',
  createdAt: new Date(),
};
```

### 12.2 Programmatic (via the factory)

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'ldb1', name: 'App Data', type: 'libredb',
  database: '/data/app.libredb', createdAt: new Date(),
});

await provider.connect();

// Read a single key
await provider.query('get user:1');
// -> { rows: [{ key: 'user:1', value: 'Ada' }], rowCount: 1, fields: ['key', 'value'] }

// Read all keys under a prefix
await provider.query('prefix user:');
// -> { rows: [{ key: 'user:1', value: '...' }, { key: 'user:2', value: '...' }], ... }

// Range scan (half-open: [start, end))
await provider.query('range user:1 user:2');
// -> { rows: [{ key: 'user:1', value: 'Ada' }], rowCount: 1, ... }

// Write a key
await provider.query('put session:abc token123');
// -> { rows: [{ changed: 1 }], rowCount: 1, fields: ['changed'] }

// Write a value with spaces (use quotes)
await provider.query('put note "hello world"');
// -> { rows: [{ changed: 1 }], ... }

// Write a JSON value — wrap it in single quotes. The tokenizer treats bare
// double quotes as token quoting (Redis-style) and would strip them, storing
// invalid JSON; the single-quote wrapper preserves them verbatim.
await provider.query('put user:3 \'{"name":"Grace","age":45}\'');
// get user:3 -> value: '{\n  "name": "Grace",\n  "age": 45\n}'

// Delete a key
await provider.query('delete session:abc');
// -> { rows: [{ changed: 1 }], rowCount: 1, fields: ['changed'] }

// Browse the schema (prefix groups as tables)
const schema = await provider.getSchema();
// -> [{ name: 'user:*', rowCount: 3, columns: [{name:'key',...},{name:'value',...}] }, ...]

await provider.disconnect();
```

### 12.3 Over the API

`POST /api/db/query` with the command in the `sql` field — see
[`docs/API_DOCS.md`](../API_DOCS.md) for the full request/response contract.

---

## 13. Known limitations & future work

- **No multi-key transactions in the query UI.** The `@libredb/libredb` kernel exposes a
  `transact()` method for atomic multi-key writes, but it is not surfaced through the provider's
  command grammar in v1. Deferred to a future release.
- **No in-memory connections.** A missing `database` path throws rather than silently opening an
  ephemeral in-memory store, which would be discarded on disconnect and offer no durable value.
- **Catalog-aware views are now live (since `@libredb/libredb` 0.0.2).** `getSchema()` reads
  `catalog(db)` and presents real relational tables (with their declared columns) and document
  collections; only namespaces written through the raw `kv` lens fall back to the prefix-grouped
  `key`/`value` view. Studio's `TableSchema` has no dedicated "kind" field, so the kind is
  signalled by the columns rather than a label. The reserved catalog namespace is excluded from
  all user-facing views (schema and query results).
- **Schema scan capped at 10 000 keys.** Prefix groups that only appear beyond the cap won't show
  as "tables". This is a deliberate bound, not a bug.
- **File must be on the Studio server's filesystem.** There is no remote LibreDB connection model.
  The database has no server or wire protocol; embedded-in-process is the only supported mode.
- **No column modification in a generated migration.** Since
  [#269](https://github.com/libredb/libredb-studio/issues/269) the schema-diff migration generator
  answers a modified column per dialect; this engine speaks a JSON command grammar rather than SQL DDL,
  so it emits `-- LibreDB: Cannot alter column "<name>". ...` where it previously emitted PostgreSQL
  `ALTER TABLE ... ALTER COLUMN` DDL the command parser would reject.

---

## 14. References

- Driver: [`@libredb/libredb`](https://github.com/libredb/libredb-database)
- Source: [`src/lib/db/providers/embedded/libredb.ts`](../../src/lib/db/providers/embedded/libredb.ts)
- Base class: [`src/lib/db/base-provider.ts`](../../src/lib/db/base-provider.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/libredb-provider.test.ts`](../../tests/integration/db/libredb-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
