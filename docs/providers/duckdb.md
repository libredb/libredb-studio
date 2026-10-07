# DuckDB Provider

> DuckDB support for LibreDB Studio, built on the official native binding `@duckdb/node-api`. DuckDB
> is an **embedded, file-based analytical engine**: there is no server, no port and no credential —
> a connection is a path to a database file on Studio's own filesystem, or `:memory:`. This document
> is the single reference point for the DuckDB provider: design, architecture, usage, and tests.
> Everything below was **measured against a live engine**, statement by statement; nothing here is
> quoted from duckdb.org.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `duckdb` |
| **Family** | SQL (`src/lib/db/providers/sql/duckdb/`) — embedded / file-based, like `sqlite` |
| **Driver** | `@duckdb/node-api` 1.5.5-r.4 — a **native N-API binding**, not a pure-JS client. Four packages, ~70 MB of shared library per platform (§11) |
| **Query language** | `sql` (DuckDB's own PostgreSQL-flavoured dialect; `version()` answered `v1.5.5`) |
| **Default port** | `null` — there is no network listener |
| **Connection** | A **server-local file path** (or `:memory:`) — **not** a network endpoint |
| **Connection string** | `false` (capability). DuckDB has no URI scheme, and inventing one would put a scheme on a field that only ever holds a path (§4.2) |
| **Credential** | None. DuckDB has no users and no passwords — the filesystem is the access control |
| **Connection pooling** | None — one instance, one connection, held for the life of the connection |
| **EXPLAIN** | `duckdb-json` — `EXPLAIN (FORMAT JSON)`. The **ANALYZE variant is never emitted, permanently**: measured, `EXPLAIN (ANALYZE, FORMAT JSON) <statement>` **EXECUTES the statement** (§5) |
| **Transactions** | Not exposed (`supportsTransactions: false`) — the provider holds no explicit begin/commit/rollback API |
| **Result pagination** | `supportsResultPagination: true` — `prepareQuery` applies a positive offset as `LIMIT n OFFSET m` through the shared limiter, so the results grid offers Load More (#816) |
| **Query cancellation** | Yes — `DuckDBConnection.prototype.interrupt()` exists in 1.5.5-r.4 and is what `cancelQuery` calls (§3.9) |
| **Agent read-only profile** | Yes — a separate handle opened `access_mode: 'READ_ONLY'` **and** `enable_external_access: 'false'`, because the read-only flag alone is not a filesystem sandbox. The SQL denylist remains only as defence in depth (§3.10, §14)|
| **Non-admin file access** | **Closed at statement level**: the editor handle opens `enable_external_access: 'false'`, read-write, for every non-admin role and for every role on a seed a non-admin role can use, so no statement reaches the network or a file other than the database's own and the handle's private temp directory, while that database stays editable and its path is still the connection's choice; an admin keeps full reach on an inline connection and on an admin-only seed, and the posture is server-derived from the session and the resolved connection, never the request body (§3.16, §14.3) |
| **Maintenance** | `vacuum` and `analyze` (per table **and** global), `optimize` mapped onto `CHECKPOINT` (global only). `reindex`, `check` and `kill` are withheld — measured unsupported (§8) |
| **Concurrency** | `singleWriterFile: true` — a **second process is refused even read-only** (§3.8) |
| **Extensions** | Never installed or loaded implicitly: every handle opens with `autoinstall_known_extensions`, `autoload_known_extensions` and `allow_community_extensions` off, and a file that is not a DuckDB database is refused before the engine opens it; only DuckDB's signed extensions can load, `INSTALL` and `LOAD` in the admin editor are the way in, the denied posture refuses `INSTALL` and the `LOAD` of any extension that is not bundled (§3.14, §3.16), and the admin editor's remaining network reach is in §14.4 |
| **Unwritable file** | Opened `READ_ONLY` in the editor, so reads work and the engine refuses writes (§3.15) |
| **Source** | [`src/lib/db/providers/sql/duckdb/`](../../src/lib/db/providers/sql/duckdb/) |
| **Tests** | [`tests/integration/db/duckdb-provider.test.ts`](../../tests/integration/db/duckdb-provider.test.ts) |
| **Tracking issue** | [#424 — the database coverage map](https://github.com/libredb/libredb-studio/issues/424) |
| **Probed against** | DuckDB **v1.5.5** embedded through `@duckdb/node-api` **1.5.5-r.4**, under **Node 24.14.0** and **Bun 1.3.14**, on **2026-08-27** |
| **Reproducible with** | `bun add @duckdb/node-api@1.5.5-r.4` — the engine ships inside the package, so there is no image to pull and no service in `database-compose.yml` (§11). Every statement quoted below was run against a two-schema fixture built from scratch; the integration test builds the same fixture in a temp directory |

---

## 1. Overview

DuckDB is to analytics what SQLite is to OLTP: a whole database engine linked into the host process,
reading and writing a single file. There is no daemon to start, no port to open and no user to
create. That makes it the second **embedded** engine in this product after `sqlite`, and it inherits
the same deployment constraint — see §1.1 — but almost nothing else: the dialect is
PostgreSQL-flavoured rather than SQLite's, the catalog is a set of `duckdb_*` table functions rather
than `sqlite_master`, values arrive as JSON rather than through a synchronous C API, and the driver
is a native N-API addon carrying a 70 MB shared library rather than a runtime built-in.

It is a separate type-id from `sqlite`, not a relative of it, for the same reason libSQL is: the
execution layer has nothing in common. `bun:sqlite` is synchronous and returns JavaScript values;
`@duckdb/node-api` is asynchronous, returns a reader, and can only be serialised through its
JSON readers (§3.2). Every catalog statement differs. Every maintenance statement differs.
Sharing an id would mean one document describing two sets of measurements.

### 1.1 Deployment constraint

⚠️ The database file **must live on the server's filesystem** — the machine Studio runs on. A remote
user of a hosted deployment cannot point Studio at a DuckDB file on their own laptop, because there
is nothing to connect to over a network. This is the same constraint the
[SQLite provider](./sqlite.md) carries, and it positions DuckDB the same way: self-hosted, Docker,
local development, edge, and zero-config trials — **not** a multi-tenant SaaS target.

One consequence is sharper than SQLite's, and it is measured rather than inherited: a DuckDB file
open by a writer **cannot be opened by a second process at all, not even read-only** (§3.8). Two
Studio replicas pointed at one file is not a degraded configuration, it is a broken one.

**Not in the `-alpine-slim` image.** The driver is four packages ending in a ~70 MB `libduckdb.so`,
which makes it the largest removable item in that variant, so it is left out on purpose (issue #840,
[DISTRIBUTION.md](../DISTRIBUTION.md)). Every other engine is unaffected, because `openDuckDBClient`
reaches the driver through `await import(...)` and nothing else in the process touches it. Opening a
DuckDB connection there fails with a `ConnectionError` naming the tags that do ship the driver —
`describeDriverAbsence` in [client.ts](../../src/lib/db/providers/sql/duckdb/client.ts) — rather
than a raw module-resolution stack. The default and `-alpine` tags ship it, and so does every
non-Docker channel.

### 1.2 Concept mapping

| DuckDB | This product | Note |
|---|---|---|
| A database file, or `:memory:` | The connection | The `database` field holds a **path**, not a host |
| Catalog — the **file stem** | The database name | `warehouse.duckdb` is the catalog `warehouse`; `current_database()` answers it |
| Schema (`main`, `analytics`, …) | Schema | The default is `main`, and it is flagged `internal` (§3.3) |
| Table | Table | `duckdb_tables()` |
| View | View | `duckdb_views()` |
| Index | Index | `duckdb_indexes()`; an attribute of a table here, not an object kind |
| Macro (`CREATE MACRO`) | Routine | `duckdb_functions()` filtered on `function_type`; both the scalar and the table form |
| Sequence | Sequence | `duckdb_sequences()` |
| Secret | (none) | Outside the catalog hierarchy; not in the object tree (§6) |
| — | Credential | None exists. The file's permissions are the only access control |
| — | Session, slow-query log | Neither exists (§3.7) |

---

## 2. Architecture

```
src/lib/db/providers/sql/duckdb/
├── index.ts        DuckDBProvider — the provider methods, capabilities, labels, the read-only guard
├── client.ts       the driver seam — the only file that knows @duckdb/node-api exists
├── introspect.ts   every read expressed as SQL (the duckdb_* catalog functions, pragma_database_size)
└── values.ts       result mapping (the synthetic Count column) and size parsing ("2.0 MiB" → bytes)
```

The driver seam is narrow by construction: `DuckDBInstance` / `DuckDBConnection` and the reader API
(`runAndReadAll`, `getRowsJson`, `columnNames`, `columnTypes`, `rowsChanged`, `interrupt`) are
vocabulary of `@duckdb/node-api` and stay inside **`client.ts`** — `duckdb-seam-guard.test.ts` fails
the build when any of it appears in a sibling. The import of the driver is dynamic and lives inside
the open function, never at module scope, so the ~70 MB `libduckdb.so` is not loaded into a process
that merely touches the provider registry. Nothing outside this directory may branch on
`type === "duckdb"`; behaviour reaches the rest of the app through capabilities and labels, per the
repo rule in [`CLAUDE.md`](../../CLAUDE.md).

---

## 3. Design decisions

Each subsection records one measured finding and what the provider does about it.

### 3.1 The catalog name is the file stem, and it can collide with a schema

A file named `analytics.duckdb` makes the catalog `analytics`. If that database also contains a
schema named `analytics`, every unqualified reference to it fails:

```
Binder Error: Ambiguous reference to catalog or schema "analytics" - use a fully qualified path
```

Real, reproducible, and not a provider bug. Every catalog statement the provider issues is therefore
scoped with `database_name = current_database()` rather than by name, and object-browser navigation
qualifies `schema.table`. A user who hits the binder error in the editor is being told about their
own file name, and the doc says so here rather than leaving it to be rediscovered.

### 3.2 `getRowObjects()` is banned; rows come from `getRowsJson()`

`getRowObjects()` throws the moment a result is serialised:

```
Do not know how to serialize a BigInt        (Node 24.14.0)
JSON.stringify cannot serialize BigInt       (Bun 1.3.14)
```

Wide integers arrive as JavaScript `BigInt` values in that shape, so a table with a `BIGINT` primary
key would break the whole API response rather than one cell. The JSON readers hand back values that
are already JSON-safe, and `getRowsJson()`, which answers each row as an array, is the only reader
used ([Result column names](#result-column-names) says why the array form and not `getRowObjectsJson()`).

For

```sql
SELECT 42 a, version() v, [1,2,3] lst, {'x':1} st, 9223372036854775807::HUGEINT big,
       INTERVAL 1 DAY iv, uuid() u
```

it answered

```json
[{"a":42,"v":"v1.5.5","lst":[1,2,3],"st":{"x":1},"big":"9223372036854775807",
  "iv":{"months":0,"days":1,"micros":"0"},"u":"52d52618-4f68-48a0-966d-6f09444d9a5c"}]
```

| DuckDB type | Arrives as | Measured |
|---|---|---|
| `INTEGER` | `number` | `42` |
| `BIGINT`, `HUGEINT`, `DECIMAL` | **string** | `"9223372036854775807"`, `{"id":"1001","total":"120.50"}` |
| `VARCHAR` | string | `"v1.5.5"` |
| `LIST` | array | `[1,2,3]` |
| `STRUCT` | object | `{"x":1}` |
| `INTERVAL` | object | `{"months":0,"days":1,"micros":"0"}` |
| `UUID` | string | `"52d52618-4f68-48a0-966d-6f09444d9a5c"` |
| `TIMESTAMP` | string, **space-separated** | `"2026-01-04 09:59:00"` — not ISO-8601 `T` |

Wide integers staying as strings is the engine protecting exactness, and the provider does not
"repair" it: `Number("9223372036854775807")` is a different number, and a rounded key is a
corruption nothing downstream can detect. The grid renders the string as measured.

**Columns come from `columnNames()`, never from the rows.** `getRowsJson()` returns `[]` for an
empty result set and carries no column information, while `columnNames()` and `columnTypes()` answer
regardless. `columnTypes().map(String)` gives DuckDB's own type text — `INTEGER`, `VARCHAR`,
`INTEGER[]`, `STRUCT("x" INTEGER)`, `HUGEINT`, `INTERVAL`, `UUID` — which is what populates
`QueryResult.columnTypes`.

### 3.3 `duckdb_schemas().internal` is TRUE for `main`

This is the trap of the catalog, and it is silent:

```sql
SELECT schema_name FROM duckdb_schemas() WHERE NOT internal;   -- DROPS main
```

`internal` is `TRUE` for `main` **even in a user database**, so the obvious filter deletes the
default schema — the one nearly every table lives in — from the object browser, with no error
anywhere. The provider filters on the database instead:

```sql
SELECT schema_name FROM duckdb_schemas() WHERE database_name = current_database() ORDER BY 1;
-- -> analytics, main
```

`NOT internal` remains correct on `duckdb_tables()`, `duckdb_views()` and `duckdb_columns()`, where
it removes the system catalog rather than the user's default schema, and each of those is
additionally scoped by `database_name = current_database()`.

### 3.4 A DML result is a synthetic `Count` column, so `rowCount` comes from `rowsChanged`

`runAndReadAll()` on DML returns a one-row result whose only column is `Count`:

| statement | `rowsChanged` | rows |
|---|---|---|
| `INSERT … VALUES` (2 rows) | `2` | `[{"Count":"2"}]` |
| `UPDATE … WHERE id = 1` | `1` | `[{"Count":"1"}]` |
| `DELETE … WHERE id = 99` | `0` | `[{"Count":"0"}]` |
| `CREATE TABLE …` | `0` | `[]`, columns `["Count"]` |

So a write reports `rowCount` from `result.rowsChanged` and **must not** surface `Count` as a result
grid: a user who deletes a row should see "1 row affected", not a one-cell table containing the
string `"1"`.

### 3.5 `estimated_size` is a row count, and every size in `pragma_database_size()` is a string

Two separate ways to accidentally publish a wrong number, both measured:

- `duckdb_tables().estimated_size` answered `5`, `7`, `2` against a fixture of 5, 7 and 2 rows. It is
  a **row count**, not a byte size. Labelling it "size" would put three-byte tables on the storage
  panel. It is also an **estimate**, so it is not published as the row count either: after
  `DELETE FROM big WHERE id < 19000000` on a 20,000,000-row table it answered **1,076,480** where
  `count(*)` answered **1,000,000**, and a `CHECKPOINT` left it there. The object tree counts (§6).
- `pragma_database_size()` returns **human-formatted strings** for every column except `block_size`:

  ```json
  {"database_size":"2.0 MiB","block_size":"262144","total_blocks":"8","used_blocks":"8",
   "free_blocks":"0","wal_size":"0 bytes","memory_usage":"2.0 MiB","memory_limit":"50.0 GiB"}
  ```

  A byte figure has to be parsed out of `"2.0 MiB"`, or the panel prints the engine's own string.
  `memory_limit` is 80% of host RAM and therefore differs per machine — **no test asserts it**.

The one place a real per-table byte figure exists is `PRAGMA storage_info('<table>')`, which answers
per-column segment rows (`row_group_id, column_name, segment_type, count, compression, stats,
block_id, block_offset, persistent, has_updates`). `duckdb_memory()` does report true bytes as
numeric strings: `[{"tag":"BASE_TABLE","memory_usage_bytes":"2097152"}]`.

### 3.6 The JSON EXPLAIN is a string inside a row

`EXPLAIN (FORMAT JSON) SELECT …` returns **one row with two columns**:

```
explain_key   = "physical_plan"
explain_value = a JSON *string* whose parse is an ARRAY of nodes
```

A node has exactly three keys — `name`, `children`, `extra_info` — and two properties of
`extra_info` are easy to get wrong, both measured on
`EXPLAIN (FORMAT JSON) SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id
WHERE o.total > 10 ORDER BY o.total LIMIT 3` against the fixture:

- **A value is a string OR an array of strings.** One `SEQ_SCAN` answered
  `{"Table":"warehouse.main.customers","Type":"Sequential Scan","Projections":["id","name"],
  "Estimated Cardinality":"5"}` — `Table` a string and `Projections` an array, in the same object. A
  reader that assumes strings drops the projection list, so the strategy renders an array as its
  joined members rather than as `[object Object]`.
- **A node need not carry `Estimated Cardinality` at all.** In that same plan the root `TOP_N`
  carried only `{"Top":"3","Order By":"o.total ASC"}`. An absent cardinality is absent, not zero.

Keys seen across the statements probed: `Table`, `Type`, `Table Index`, `Projections`, `Filters`,
`Expression`, `Conditions`, `Join Type`, `Groups`, `Aggregates`, `Order By`, `Top`, `CTE Name`,
`CTE Index`, `Estimated Cardinality`. The array is always **one root** (measured over six statements,
maximum depth 9), and `EXPLAIN (FORMAT JSON)` on an unresolvable statement **throws** rather than
answering a payload (`Catalog Error: Table with name nope_missing does not exist!`).

**The ANALYZE variant is never emitted, and the reason is that it runs the statement.**
`EXPLAIN (ANALYZE, FORMAT JSON) INSERT INTO probe VALUES (42)` was issued three times against a
fresh table and took its row count from 0 to 1 to 2 to 3 — every call really performed the insert,
and an `UPDATE` behind it really changed the row. Plain `EXPLAIN (FORMAT JSON)` on the same `INSERT`
returned an INSERT plan and left the count where it was. The `{"result": "error"}` payload does
occur — it was what all three of those executing calls answered — but it is an intermittent payload,
not the reason: on other runs the same form answers `explain_key = "analyzed_plan"` with a real
profile object (`latency`, `cpu_time`, `operator_timing`, `operator_cardinality`, `rows_returned`,
a nested `children`) — an OBJECT, not the array `physical_plan` publishes.

So the provider offers the JSON **physical plan** and never the analyze form. There is no timing
data to show and none is faked. This is not a version to wait out: a later DuckDB that emits valid
analyze JSON makes the hazard **worse**, because the plan would then look usable while still
executing whatever the user asked only to see (§15).

### 3.7 No slow-query log and no session list — the empties are the engine's

Both table functions simply do not exist:

```
SELECT * FROM duckdb_queries();      -- Catalog Error: Table Function with name duckdb_queries does not exist!
SELECT * FROM duckdb_connections();  -- Catalog Error: Table Function with name duckdb_connections does not exist!
```

Both therefore answer `[]`, and neither fabricates a zero. **Both empties are DuckDB's own words on
screen**, through the two `ProviderLabels` fields the provider declares:

- `getSlowQueries()` returns `[]` and the provider declares `slowQueriesEmptyState`, so the Queries
  panel prints *"DuckDB keeps no store of finished statements — it publishes no `duckdb_queries()`
  table function — so there is nothing to enable."* Without it that panel tells every engine to
  install `pg_stat_statements`, which for DuckDB is nonsense (#463).
- `getActiveSessions()` returns `[]` and the provider declares `sessionsEmptyState`, so `SessionsTab`
  and `OperationsTab` print *"DuckDB publishes no session list — there is no `duckdb_connections()`
  table function — so this panel can never show a row."* in place of the generic **"No active
  sessions found."** they used for every provider until D48. That generic sentence reads as "nothing
  is running right now", which is a different claim from "this panel can never show a row". A
  provider that declares neither label keeps the generic wording. (The `sessionsUnavailable` path
  beside it is a third fact again: it renders a reason only when the reading *failed*.)

`sqlite.ts` answers this panel with a row describing its own handle. That row would be true here
too, but it would be the only row the panel could ever show, and "the engine reports one session"
is a different claim from "the engine reports nothing". The count that *is* measurable travels as
`activeConnections` on the overview, where it is a number rather than a fabricated session record.

`duckdb_temporary_files()` does exist and answered `[]` on an idle database, which is a real reading
rather than a gap.

### 3.8 One writer, and a second **process** is refused even read-only

| Scenario | Measured |
|---|---|
| Second read-write `DuckDBInstance.create` on the same file, **same process** | ALLOWED on Linux and macOS, REFUSED on Windows (see below) |
| `DuckDBInstance.fromCache` on the same file, same process | ALLOWED |
| Second `access_mode: 'READ_ONLY'` instance, same process, while a writer is open | ALLOWED on Linux and macOS, and genuinely read-only: `current_setting('access_mode')` is `read_only`, `duckdb_databases().readonly` is true, `INSERT` is refused |
| Second read-write **process** while a writer holds the file | `IO Error: Could not set lock on file …: Conflicting lock is held in … (PID nnn)` |
| Second **READ_ONLY process** while a writer holds the file | **ALSO refused**, with the same lock error |
| `READ_ONLY` open of a file that does not exist | `IO Error: Cannot open database … in read-only mode: database does not exist` — the engine does not create it |

The fifth row is the one to read twice. A read-only reader in a *separate process* is refused, which
is stricter than the usual one-writer-many-readers summary, so `singleWriterFile: true` is not a
conservative default here — it is the measurement. Two Studio replicas sharing a file is not a
supported deployment.

The same-process rows are why the agent's read-only handle can sit beside an editor handle at all:
it is a second handle **in the same process** as the writer.

**That allowance is POSIX's, not the engine's.** Measured on windows-latest (2026-09, the same
DuckDB v1.5.5 / `@duckdb/node-api` 1.5.5-r.4): a second handle on a file this process already holds
is refused at the operating system, `IO Error: Cannot open file "…": The process cannot access the
file because it is being used by another process`, with DuckDB naming this very process as the
holder. Windows arbitrates the share mode per HANDLE, so "the lock is per process" simply does not
apply there. `tests/integration/db/duckdb-provider.test.ts` asserts both answers, each positively,
rather than the POSIX one twice.

The consequence for the product is bounded but real, and it is not fixed here.
Browsing serves one connection record from one cached handle, and the connection dialog's Test Connection borrows the handle already holding the file (`findOpenSingleWriterProvider`), so neither opens a second one.
Two different connection records naming one file do get two handles, because `getOrCreateProvider` never borrows: on Linux and macOS each keeps its own catalog and whichever closes last checkpoints over the other's committed rows, and on Windows the second open is refused (BACKLOG D240).
The one path that really does want two handles at once is an agent run reaching a connection the editor already has open: `acquireExecutionProfileProvider` opens the file under the profiled key while the writable handle is live.
On Windows that open is refused, and the run fails with the engine's sentence instead of reading.
Not yet measured against a running Studio on Windows, only against the engine.

The file-access posture (§3.16) adds one more case.
A handle is lent only to a caller of its own posture, and every role that can resolve one seed shares one posture, so the case is two connection records of different postures on one file: an admin's own connection and a standard user's, or an admin-only seed and a user's connection naming its file.
Test Connection beside such a writer opens its test handle `READ_ONLY` with external access off rather than a second read-write handle: on Linux and macOS it reads beside the writer and leaves its file and `.wal` alone, and on Windows it is refused like any second handle.
An `agent-operations` acquisition borrows only a handle of its requester's own editor posture, and otherwise opens its own read-only handle, which reads the file as it was when it opened.

### 3.9 `interrupt()` exists, so `cancelQuery` is real

`DuckDBConnection.prototype.interrupt` is on the prototype in 1.5.5-r.4, alongside `progress`,
`stream*`, `prepare`, `extractStatements` and `runUntilLast`. Cancellation is therefore implemented
rather than declared unsupported: a long analytical scan is exactly the workload a user needs to be
able to stop, and this engine has no session to `KILL` from a second connection.

### 3.10 `access_mode: 'READ_ONLY'` is not a filesystem sandbox — `enable_external_access` is

Measured, with database writes genuinely refused at the same time: `COPY … TO`, `EXPORT DATABASE`,
`INSTALL`, `read_text('/etc/hostname')` and `glob('/etc/*')` all **succeed** under `READ_ONLY`. The
flag bounds the *database*, not the *process* — the same class of escape as SQLite's `VACUUM INTO`
and PostgreSQL's `COPY TO PROGRAM`, both already fixed in this repo.

What closes it is a **second engine option on the same handle**: `enable_external_access: 'false'`,
passed beside `access_mode` when the read-only client is opened (`client.ts`). Under it every one of
those forms answers

```
Permission Error: Cannot access file "/etc/hostname" - file system operations are disabled by configuration
```

and it cannot be undone from inside a session: both `SET` and `SET GLOBAL enable_external_access =
true` answer `Invalid Input Error: Cannot enable external access while database is running`. That
last measurement is what makes the option a boundary rather than a default — `SET memory_limit` IS
accepted on a read-only handle, so "the engine refuses to be reconfigured" was not a given.

The read-only handle also opens with a private temp directory, as every handle with external access off does: `openDuckDBClient` makes one under the operating system's temp directory and removes it when the handle closes.
Its spill files land there rather than in `<file>.tmp` beside the database, and the engine allow-lists that directory in place of its default; §3.16 records what that leaves reachable.

The SQL denylist stays, as **defence in depth** rather than as the boundary: it names the construct
and says why, which the engine's sentence does not, and it costs nothing to run first. §14 records
the three bypasses that proved a text guard cannot be the boundary here.

### 3.11 A multi-statement string runs the first statement only

```
runAndReadAll("SELECT 1 AS a; SELECT 2 AS b")   -->  [{"a":1}]
```

The rest is silently discarded — no error, no second result. A user pasting a script would be told
their first statement succeeded and never learn the others did not run. `extractStatements()` and
`runUntilLast()` exist for real multi-statement handling; the read-only path in particular executes
exactly one statement and never a multi-statement string.

### 3.12 The dialect facts were measured, statement by statement

DuckDB reads like PostgreSQL in most of the places that matter to an editor, and unlike SQLite in one
that bites:

| Construct | Verdict |
|---|---|
| `"quoted identifier"` | Works — double quotes, hence `identifierQuoting: "double"` |
| `[1,2][1]` | A **list literal with a 1-based index**. `[` is **not** an identifier quote here, unlike SQLite and SQL Server |
| `-- line comment` | Works |
| `/* nested /* inner */ still */` | Nested block comments work — unlike SQLite, where they do not |
| `# comment` | `Parser Error` — `#` does **not** start a comment |
| `$tag$hello$tag$` | Dollar-quoting works, Postgres-shaped |
| `'it''s'` | A doubled single quote escapes |
| `?` and `$1` placeholders | Both parse (both reported "Expected 1 parameters", not a syntax error) |
| `LIMIT n OFFSET m` | Works. There is no `SELECT TOP` |
| Reserved words | `at` is reserved; `duckdb_keywords()` also lists `notnull` |

`ALTER TABLE` accepted `ADD COLUMN`, `ALTER COLUMN … SET DATA TYPE`, `ALTER COLUMN … SET NOT NULL`,
`RENAME COLUMN` and `DROP COLUMN` — all measured, which is what the inline row editor and the schema
tooling depend on (`supportsInlineRowEdit: true`).

### 3.13 There is no auto-increment keyword — a sequence is the only route

`supportsCreateTable` is `true`, so [`CreateTableModal`](../../src/components/CreateTableModal.tsx)
renders for this engine and its default column has to be a generated key. **Every keyword the other
seven engines use for one is refused here.** Measured statement by statement on 1.5.5, the
`@duckdb/node-api` version this repo pins:

| Construct | Verdict on 1.5.5 |
|---|---|
| `id SERIAL PRIMARY KEY` | `Catalog Error: Type with name SERIAL does not exist!` |
| `id BIGSERIAL` | `Catalog Error: Type with name BIGSERIAL does not exist!` |
| `id INTEGER GENERATED BY DEFAULT AS IDENTITY` | `Not implemented Error: Constraint not implemented!` |
| `id INTEGER GENERATED ALWAYS AS IDENTITY` | `Not implemented Error: Constraint not implemented!` |
| `id INTEGER PRIMARY KEY AUTOINCREMENT` | `Parser Error: syntax error at or near "AUTOINCREMENT"` |
| `id INTEGER AUTO_INCREMENT` | `Parser Error: syntax error at or near "AUTO_INCREMENT"` |
| `a JSONB` | `Catalog Error: Type with name JSONB does not exist!` — the type is spelled `JSON` |

The identity rows are the sharp ones: `GENERATED … AS IDENTITY` **parses** and is refused at
execution, so this is a missing feature rather than a missing word, and a future DuckDB could
implement it without any syntax changing.

What works is a sequence the column defaults from, which is why the create-table form emits **two**
statements for this engine and nothing else:

```sql
CREATE SEQUENCE IF NOT EXISTS widgets_id_seq;
CREATE TABLE widgets (
  id INTEGER PRIMARY KEY DEFAULT nextval('widgets_id_seq'),
  name VARCHAR(255)
);
```

Measured end to end: two inserts that omit `id` store 1 and 2, an insert that supplies `id = 99`
is accepted (the default is a default, not an override), and a second `id = 99` is
`Constraint Error: Duplicate key "id: 99" violates primary key constraint.`

Three facts decide the exact text above, and each one breaks the form if ignored:

1. **Order.** The sequence has to exist first — `CREATE TABLE t (id INTEGER DEFAULT nextval('nope'))`
   is `Catalog Error: Sequence with name nope does not exist!`, so this is not a formatting choice.
2. **`IF NOT EXISTS`.** A sequence **outlives** the table that defaults from it: after
   `DROP TABLE widgets`, `SELECT nextval('widgets_id_seq')` still answers (with 3), and a bare
   `CREATE SEQUENCE widgets_id_seq` is then
   `Catalog Error: Sequence with name "widgets_id_seq" already exists!`. Without the guard, creating a
   table, dropping it and creating it again through the form fails the second time. The surviving
   sequence resumes its count, which costs a few ids and nothing else. `duckdb_sequences()` lists
   what is left behind.
3. **Two statements reach the engine as two.** §3.11 is the reason this needs saying: the driver's
   `runAndReadAll` would run only the first. It does not apply here, because
   `use-query-execution.ts` reads the buffer with `isMultiStatement` under this dialect's grammar and
   routes it to `/api/db/multi-query`, which splits on that same grammar and hands the provider one
   statement at a time.

### 3.14 No extension is installed or loaded on its own, and a file that is not DuckDB's is refused (#1404)

With every option at its default, DuckDB installs and loads a "known" extension the moment a
statement or a file needs one. Measured on v1.5.5 before this was changed: a connection pointed at a
**SQLite** file made the engine download `sqlite_scanner` (34,778,566 bytes, from
`http://extensions.duckdb.org/...`) into `~/.duckdb/extensions/v1.5.5/<platform>/`, attach the file,
checkpoint its `-wal` into it, and Studio answered "Connected successfully". So a Test Connection
click made the server fetch native code from the internet, rewrote a file another connection held
open, and on an air-gapped host hung until the download timed out.

Three things close it, all in `client.ts`, on **every** handle (the editor's and the agent read-only
profile's):

1. **`autoinstall_known_extensions: 'false'` and `autoload_known_extensions: 'false'`** are passed at
   open. Nothing is fetched or loaded behind the user's back. A statement that needs an extension
   that is not loaded is refused by the engine, and its message names both ways forward:

   ```
   Catalog Error: Table Function with name "sqlite_scan" is not in the catalog, but it exists in the sqlite_scanner extension.

   Please try installing and loading the sqlite_scanner extension by running:
   INSTALL sqlite_scanner;
   LOAD sqlite_scanner;

   Alternatively, consider enabling auto-install and auto-load by running:
   SET autoinstall_known_extensions=1;
   SET autoload_known_extensions=1;
   ```

   **Opting in** is therefore per session and explicit, in the admin editor (the denied posture refuses `INSTALL` and the `LOAD` of any extension that is not bundled, §3.16): run `INSTALL <name>; LOAD <name>;` (measured working with both options off), or `SET` the two options back on for that session (measured accepted).
   There is no server-wide switch: an extension is native code the server runs, and installing one is a decision to make in the open.
   On an air-gapped host, `INSTALL` needs the extension file already under the server user's extension directory.
   Extensions statically linked into `@duckdb/node-api` 1.5.5-r.4 are loaded anyway and unaffected: `core_functions`, `icu`, `json`, `parquet` and `autocomplete`.
2. **The file's header is read before the engine opens it** (`assertDuckDBFile`). Every DuckDB file,
   an encrypted one included, carries `DUCK` at byte 8 (measured); a SQLite file starts with
   `SQLite format 3\0`. A file that is not a DuckDB database is refused without being opened, so it
   and its `-wal` are left byte for byte as they were. This is needed beside step 1, not instead of
   it: measured, with both options off, an extension **already installed** on the host is still
   loaded to attach a file it recognises, so the options alone would still have checkpointed the
   SQLite file on any machine that had `sqlite_scanner` installed. A path whose header cannot be
   read (missing, unreadable, a directory) is left to the engine, which creates a missing file or
   names the failure in its own words.
3. **`allow_community_extensions: 'false'`** is passed at open. A community extension is third-party
   native code DuckDB does not vet, and with this off `INSTALL <name> FROM community` is refused:
   `IO Error: Attempting to install an extension file that doesn't have a valid signature`
   (measured, nothing is written to the extension directory). Unlike the two options in step 1, it
   cannot be turned back on inside a session: `SET` and `SET GLOBAL allow_community_extensions =
   true` both answer `Invalid Input Error: Cannot change allow_community_extensions setting while
   database is running` (measured). `allow_unsigned_extensions` is off by default and fixed at open
   the same way, so **only DuckDB's own signed extensions can be loaded on any handle**.

What this does **not** close is the admin editor's own reach, which is the admin editor's by design and is recorded in §14.4 (the denied posture closes it, §3.16).

### 3.15 A file this process cannot write opens read-only in the editor

A DuckDB file with mode 0444, on a `:ro` Docker mount or owned by another user cannot be opened
read-write at all: measured on v1.5.5, the open answers `IO Error: Cannot open file "<path>":
Permission denied`, so nothing in it can even be read. The editor now asks first whether the
process can write the file and its directory (`isUnwritableExistingFile`, shared with the SQLite
provider), and when it cannot, opens with `access_mode: 'READ_ONLY'`, logs
`[DuckDB] Opened <path> read-only: this process cannot write the file or its directory`, and reads
normally. A write is then refused by the engine, and the editor puts the reason in front of the
engine's sentence (#1405), as the SQLite provider does:
`DuckDB database <path> is open read-only because this process cannot write the file or its
directory: Invalid Input Error: Cannot execute statement of type "INSERT" on database "<name>" which is
attached in read-only mode!`. The reason is added only to that sentence as the engine words it,
matched from its start, and only when the database it names is the editor's own file (its catalog
name, read with `current_database()` at open): a write on another database `ATTACH`ed read-only, or
the same words echoed inside a different error, keeps the engine's message alone. A file this
process cannot even read still fails to open, with the
engine's `Permission denied` in the ordinary `Failed to open DuckDB database <path>: ...` sentence.

For an admin editor on an unwritable file, only `access_mode` is added, so `enable_external_access` stays on and the filesystem around the file is still reachable.
Where the posture denies file access (§3.16), `enable_external_access: 'false'` joins it, so the file opens read-only and statement-level file reach is closed as §3.16 describes; the read-only-reason wrapping above is unchanged, because it keys on the catalog name, not on the external-access option.
The directory counts because DuckDB writes its `<file>.wal` beside the database; measured, a writable file in a 0555 directory opens read-write and then fails its first commit on the `.wal`.

### 3.16 The editor's file and network access is decided by the requester and the connection (non-admin DuckDB file access)

`access_mode: 'READ_ONLY'` is one of the engine's two file-related options; `enable_external_access` is the other, and the two are **independent**.
Measured on v1.5.5-r.5: a **writable** handle opened with `enable_external_access: 'false'` refuses every statement that reaches the network or a file outside its own database and its temp directory, while `CREATE`, `INSERT`, `UPDATE`, `DELETE`, `CHECKPOINT` and `ATTACH ':memory:'` on that database all still succeed.
That is the denied posture: the database stays editable, and statement-level file and network reach is closed.

**Who gets which posture.**
`editorExecutionContext` (`src/lib/api/execution-context.ts`) decides it, server-side, from the verified session and the resolved connection:

| Connection | Admin | Every other role |
|---|---|---|
| An inline connection, the requester's own | Full reach | Denied |
| A seed only admins can use (`roles: [admin]`) | Full reach | Cannot resolve it |
| A seed a non-admin role can use (`roles` holds `user` or `*`) | **Denied** | Denied |

The last row is the price of DuckDB's single writer.
Every role a seed is offered to resolves the same record, and one record is one cached handle, because DuckDB serves one file through one read-write handle per process.
A second read-write handle on the same file opens on Linux and macOS, keeps its own copy of the catalog, and whichever closes last checkpoints over the other's committed rows; Windows refuses it (§3.8).
Two postures on one record would be two cache keys and so two handles, so the record keeps one posture, the narrower one: **on a DuckDB seed a non-admin role can use, admins get no file access on that connection either.**
Where admins need file access on a seed's database, the operator offers that seed to admins only.
Changing a seed's roles across that line while Studio runs changes the posture its handle opens under, so the first request after the seed file is re-read closes the connection's open handle and opens a new one ([`SEED_CONNECTIONS.md`](../SEED_CONNECTIONS.md#hot-reload)).
A statement still running on the old handle does not complete, and the old handle's session state, its temporary tables, `SET` values and variables, is lost; it happens once per such edit.

A refusal under the denied posture names the policy in front of the engine's own sentence (§10):

```
File and network access is off on this DuckDB connection: the handle was opened with external access denied, which Studio does for every role but admin and for any connection a non-admin role can use, and which an embedder overrides by passing { allowExternalFileAccess: true }: Permission Error: Cannot access file "/etc/hostname" - file system operations are disabled by configuration
```

**What it closes, and what it does not.**
Every form in §14.1's left column is refused under the denied posture, the quoted-name, bare-path and string-literal bypasses §14.2 records included, because the boundary is the engine option and not a statement guard: the SQL denylist is **not** added to this editor path, and stays the agent profile's defence in depth.
The option is self-locked once the database runs: `SET enable_external_access = true` and its `SET GLOBAL` form both answer `Invalid Input Error: Cannot enable external access while database is running` (§3.10).
It closes statement-level reach only.
The database path is still the connection's own choice, which this change deliberately leaves alone: a denied handle still opens, reads and writes any DuckDB-format file the Studio process can access, and creates a missing one, because the main database is not external to the engine (§14.3).
A file that is not a DuckDB database is refused before the engine opens it (§3.14), so a JSON or CSV file cannot be read by naming it as the database either.

**What the denied posture keeps and loses.**
It keeps creating, reading and writing the connection's own database and `:memory:`, browsing the catalog, running queries, and `ATTACH ':memory:'`.
It loses every file outside the two places the next paragraph names: importing from CSV, Parquet or JSON files, `COPY` to or from such a file, `EXPORT`/`IMPORT DATABASE`, attaching other database files, `read_duckdb`, installing or loading extensions, and `httpfs`, which also removes the DuckDB server-side request-forgery surface.
This is the intended security change, and it closes the CapRover discovery-export exposure for the standard login: it can no longer read `/app/discovery/services.json` through DuckDB, and that export is JSON, so it cannot be opened as a database either.

**What a denied handle opens with, and what it still reaches.**
Every handle with external access off, the denied editor and the agent read-only handle alike, opens with a private temp directory: `openDuckDBClient` makes it under the operating system's temp directory (`TMPDIR` on Linux and macOS, `TEMP` on Windows) as `libredb-duckdb-XXXXXX`, mode 0700, and removes it when the handle closes or its open fails.
The handle's spill files land there rather than in the engine's default, which is `<file>.tmp` beside a file-backed database and the shared `<cwd>/.tmp` for every `:memory:` database in the process.
The private directory keeps a denied `:memory:` handle out of other sessions' spill files: DuckDB allow-lists a handle's own temp directory even with external access off, and with the shared default a denied handle could list, read and write those files (measured).
What the engine allow-lists is what the handle still reaches, measured on v1.5.5-r.5:

- its private temp directory, where `COPY ... TO`, `read_csv` and `ATTACH` of a new database file all succeed, inside a directory no other handle uses and that goes when the handle closes;
- its database's own file names, the database file and its `.wal`, `.wal.checkpoint` and `.wal.recovery` siblings, which for `:memory:` are four fixed names in the Studio process's working directory (`<cwd>/:memory:` and its three siblings), so a denied `:memory:` handle can write and read files with exactly those names there.

Any other file, one beside the database included, answers the engine's `Permission Error`.
When the operating system's temp directory cannot be used, a denied open is refused with a sentence that names it (§10) rather than given the shared default, and a full-reach editor, which makes no private directory, still opens.

**How the posture reaches the engine.**
It is carried on `ProviderExecutionContext.allowExternalFileAccess`, which only DuckDB reads; absent means deny (fail closed).
It never travels on the connection or on `ProviderOptions`, both caller-supplied, so a request body cannot forge the admin posture.
`getOrCreateProvider` keys the writable handle cache by it, and the single-writer borrow lends a handle only to a caller of the same posture, so nobody is handed a handle wider than their own.
Test Connection beside a writer of the other posture opens its test handle read-only with external access off rather than a second read-write handle, and an `agent-operations` acquisition borrows only a handle of its requester's own editor posture (§3.8).
The agent read-only profile (§3.10) is unchanged: it already opens `enable_external_access: 'false'` through `readOnly`, which keeps precedence.

**For an embedder of `@libredb/studio/providers`.**
The fail-closed default applies to the published factories too: `createDatabaseProvider` and `getOrCreateProvider` called without an execution context open a DuckDB handle with file access denied, which is a behaviour change for code written before the posture existed.
Pass `{ allowExternalFileAccess: true }` as the third argument for the full reach; `ProviderExecutionContext` and `EditorExecutionContext` are exported from `@libredb/studio/types`, and [`docs/DATABASE_PROVIDERS.md`](../DATABASE_PROVIDERS.md) shows the call.

---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Meaning |
|---|---|---|
| `database` | yes | A **server-local path** to a `.duckdb` file, or `:memory:` |
| `host`, `port`, `user`, `password`, `ssl` | never | Not used. There is no listener, no user and no password |

`defaultPort` is `null`, so the connection dialog offers no port for DuckDB.

`:memory:` opens a database that exists for the life of the connection and is discarded on
disconnect. It is the zero-configuration way to try the editor, and it is what most of the
integration tests use.

### 4.2 There is no connection string

`supportsConnectionString` is `false`. DuckDB publishes no URI scheme: its own tooling takes a path
argument, and this repo's parser
([`src/lib/connection-string-parser.ts`](../../src/lib/connection-string-parser.ts)) deliberately
lists a scheme only for engines that actually have one — the same reason `sqlite://` and `druid://`
are absent. Inventing `duckdb://` would put a scheme on a field that can only ever hold a filesystem
path.

### 4.3 Out of scope for v1

Explicitly **not** supported, so that a reader does not go looking:

- **MotherDuck** and the `md:` prefix — a hosted service with its own authentication, not this file
  path.
- **Quack** and **DuckLake** — separate products layered on the engine.
- **`ATTACH`-ed catalogs in the object browser.** Every catalog statement is scoped
  `database_name = current_database()` (§3.1, §3.3), so a database attached inside a session is
  queryable but is not enumerated in the tree.

---

## 5. Query interface

`query(sql, params)` runs one statement and returns `{ rows, fields, rowCount, executionTime,
columnTypes? }`.

- **Rows** come from `getRowsJson()`, keyed by position under `fields`; `getRowObjects()` is never called (§3.2).
- **`fields`** come from `columnNames()`, so an empty result still names its columns, and a repeated name is numbered ([Result column names](#result-column-names)).
- **`columnTypes`** carries `columnTypes().map(String)` — DuckDB's own type text — and the key is
  **omitted entirely** when there is nothing to publish, never emitted as `{}`.
- **`rowCount`** is the row count for a read and `result.rowsChanged` for a write; the synthetic
  `Count` column is not surfaced (§3.4).
- **Cancellation** calls `interrupt()` on the connection (§3.9).

### Result column names

Every result column comes back under a name that is non-empty and that no other column of the result has, with its own value.
`client.ts` reads the rows as arrays (`getRowsJson()`) and keys them by position under `uniqueFieldNames(columnNames())` ([`result-fields.ts`](../../src/lib/db/utils/result-fields.ts)), and `columnTypes` is keyed by the same names.
Measured 2026-10-07 in-process on @duckdb/node-api 1.5.5-r.4, pinned in `tests/integration/db/duckdb-provider.test.ts`:

| Statement | `fields` | Row |
|---|---|---|
| `SELECT 1 AS a, 'x' AS a` | `a`, `a (2)` | `{ a: 1, "a (2)": "x" }`, typed `INTEGER` and `VARCHAR` |
| `SELECT 2 AS "a:1", 3 AS a, 4 AS a, 4 + 5` | `a:1`, `a`, `a (2)`, `(4 + 5)` | every value under its own name |
| `SELECT 1 AS ""` | none | the parser refuses it: *zero-length delimited identifier* |

DuckDB names an unaliased expression by its text (`(4 + 5)`) and refuses an empty alias, so it never declares a column with no name.
A repeated name was the defect: the driver's `getRowObjectsJson()` keys a repeat `a:1` while `columnNames()` lists `a` twice, so both grid headers showed the first value, and a column the statement itself named `a:1` was overwritten by the repeat.
`queryReadOnly()` reads through the same client call.

### A transaction a statement left open

A `BEGIN` sent through `query()` opens a transaction on the ONE connection this provider holds
(§3.8), and the provider is cached per `connection.id` for the whole process, so nothing in the
request cycle closed it and it belonged to whoever borrowed the handle next.
Measured 2026-09-13 through `POST /api/db/multi-query` on v1.5.5, the loss was silent: after
`BEGIN; INSERT INTO t VALUES (1); SELECT * FROM <missing>`, the next user's `INSERT` answered
HTTP 200 and read its own row back, and a later `ROLLBACK` through the app discarded it with no
error at any point.

`endOpenQueryTransaction()` ends it and reports `"none"` or `"rolled-back"`.

**The ask and the act are one call, because on this engine they cannot be separated.** DuckDB v1.5.5
publishes no transaction-state reading: `current_transaction_id()` answers in both states (a fresh id
per implicit transaction outside one, the transaction's own id inside), `transaction_timestamp()` is
an alias of `get_current_timestamp()`, and the client context object carries only a connection id.
`duckdb_functions()` lists no other candidate. So the engine's own refusal of a `ROLLBACK` —
"TransactionContext Error: cannot rollback - no transaction is active" — is the answer, and it costs
the session nothing: measured, the very next statement runs normally. Any OTHER rollback failure is
raised rather than read as an answer.

Both query routes call this in a `finally` and report the outcome, `POST /api/db/multi-query` and
`POST /api/db/query`, each under a call scope of its own (D74, D87).

**WHAT IS NOT CLOSED: the ender cannot tell whose transaction it is ending.** The `scope` parameter
is declared on the interface and ignored here, because this provider holds ONE connection and there
is no other client to name, and that is not the same as the transaction being the caller's own.
`getOrCreateProvider` caches the provider per `connection.id` for the whole process, so one
connection is shared by every concurrent request on that stored connection: the sharing measured
above is what makes another request's transaction REACHABLE here, not what puts it out of reach.
The act is an unconditional `ROLLBACK` whose refusal is the reading, and a refusal cannot say WHOSE
transaction it found, so a request whose own statements left nothing open still discards a
concurrent request's, and that request is told nothing. That is the D87 shape on a single
connection and it is NOT closed: closing it needs the transaction owned by a call scope rather than
by a client, which is a design change and not a parameter, so it is recorded here rather than
worked around. `sqlite.md` §3.5 and `redis.md` §5.2a carry the same residual for the same reason,
and the three were checked rather than inferred from one another.

### EXPLAIN

`explainFormat` is `duckdb-json`. The provider sends `EXPLAIN (FORMAT JSON) <query>`, reads
`explain_value` out of the single row, and parses that **string** into the array of plan nodes
described in §3.6.

**There is no analyze/timing variant, and there will not be one.** `EXPLAIN (ANALYZE, FORMAT JSON)`
does not merely fail to produce usable JSON — it **executes the statement it was asked to explain**
(measured: three calls on an `INSERT` took a table from 0 rows to 3). "Explain this" must never run
it, so the direct Explain action turns the feature off for DuckDB rather than emitting the analyze
form; the strategy publishes no timings and fabricates none. See §3.6 for the full measurement and
§15 for why a later engine version does not change this.

---

### What the SQL INSERT and DDL exports write

`@duckdb/node-api` answers an INTERVAL as `{months, days, micros}`, a MAP as a list of `{key, value}` entries and a STRUCT as an object.
Written as JSON, the INTERVAL and the MAP were `Conversion Error` on replay, so the SQL INSERT export reads the declared type (#1386, [`typed-literals.ts`](../../src/lib/export/typed-literals.ts)) and writes `INTERVAL '14 months 3 days 14706000001 microseconds'`, `MAP {'k': 1}` (`MAP {}` when empty), `{'a': 7, 'b': ['p']}` and `[1, 2, 3]`, recursing through the element types, with a number inside a container written bare.
A quoted scalar (`'170141183460469231731687303715884105727'` into a `HUGEINT`) is left as it was, since DuckDB reads it back.
The DDL keeps `STRUCT("a" INTEGER, "b" VARCHAR[])`, `INTEGER[3]`, `INTEGER[][]` and `MAP(INTEGER, VARCHAR[])` instead of writing `TEXT`.
A composite that does not have its declared shape is skipped with a `-- Row N skipped` comment naming the column.

Measured 2026-10-04 on DuckDB 1.5.5: a table of `INTERVAL`, `MAP(VARCHAR, INTEGER)`, `MAP(INTEGER, VARCHAR[])`, `INTEGER[]`, `VARCHAR[]` holding a quote and a comma, `STRUCT`, `HUGEINT`, `UBIGINT`, `DECIMAL(18,3)`, `TIMESTAMPTZ`, `TIMESTAMP_NS`, `UUID`, `BLOB`, an `ENUM`, `BIT`, `INTEGER[3]` and `INTEGER[][]` was exported through the provider and replayed into `CREATE TABLE copy AS SELECT * FROM src WHERE false` and into the exported DDL's own table, and `EXCEPT` both ways answered no row.

## 6. Schema introspection

Every reading of this engine's objects goes through the object surface below. The flat reading that
came before it issued five catalog statements over `duckdb_tables()`, `duckdb_views()`,
`duckdb_columns()`, `duckdb_constraints()` and `duckdb_indexes()` plus one counting statement, all
filtered `NOT internal AND database_name = current_database()`. It is deleted, and the filter is why
that matters: scoped to `current_database()`, it could not see an `ATTACH`ed catalog at all.

Four shapes to know, all of which the object surface inherits:

- `duckdb_constraints()` is filtered by `constraint_type` rather than by `NOT internal`, because it
  publishes every NOT NULL and UNIQUE constraint as its own row too. On a `PRIMARY KEY` row
  `referenced_table` is NULL and `referenced_column_names` is `[]`.
- `constraint_column_names` and `referenced_column_names` are **`VARCHAR[]`** — `["id"]`, not a
  comma-joined string — so a composite key needs no parsing. A composite foreign key is one
  constraint row over several columns, and the provider zips the two lists into the product's
  per-column `ForeignKeySchema`.
- `duckdb_indexes().expressions` is declared `VARCHAR` and prints as `"[a, b]"`. The `::VARCHAR[]`
  cast makes the engine produce the real list (measured: `'[customer_id]'` → `["customer_id"]`).
- `duckdb_tables().estimated_size` is a row count rather than a byte size, but it is an **estimate**
  and is never published as the row count (§3.5). DuckDB answers `count(*)` out of row-group
  metadata, so counting is affordable here where it is not on the other engines. A table that cannot
  be counted — dropped between two reads, for instance — is absent from the map rather than
  published as `0`.

### The object surface (#789)

The lazy, container-aware object surface: `listContainers()`, `countObjects()`, `listObjects()`,
`describeObject(path, kind)` and `describeObjects(container, kind, limit?)`, in
[`objects.ts`](../../src/lib/db/providers/sql/duckdb/objects.ts) and
[`index.ts`](../../src/lib/db/providers/sql/duckdb/index.ts). It reaches every `ATTACH`ed catalog,
which the deleted flat reading could not.

#### Two container levels, and both are real

```ts
containerLevels: [
  { id: "catalog", label: "Database", labelPlural: "Databases" },
  { id: "schema",  label: "Schema",   labelPlural: "Schemas" },
]
```

DuckDB is the second two-level engine in #789, after SQL Server. The outer level is not the
connection's own file restated: `ATTACH '<file>' AS warehouse` puts another whole catalog in the same
session and a three-part name reaches into it, so one connection genuinely holds databases holding
schemas holding objects. `ATTACH ':memory:' AS name` works too, which is what the tests use.

A database alone is therefore a real address as well as a database and a schema, and the declaration states it as `containerPathShapes: "prefixes"`: a database-level read answers for every schema in that database.

#### Four kinds, and one `duckdb_*` function behind each

| Kind | Role | Catalog function | Note |
|---|---|---|---|
| `table` | relation | `duckdb_tables()` | `acceptsRowWrites: true` |
| `view` | relation | `duckdb_views()` | No row writes: measured, `INSERT INTO <view>` answers `Catalog Error: <view> is not an table` |
| `macro` | routine | `duckdb_functions()` filtered on `function_type` | One kind for BOTH macro forms |
| `sequence` | config | `duckdb_sequences()` | |

**No trigger and no stored procedure**: DuckDB has neither, and `CREATE TRIGGER` / `CREATE PROCEDURE`
are parser errors on 1.5.5. A declared kind draws a folder, and a folder for something the engine
cannot have is a lie its zero badge makes look like a fact.

**No `index` kind**: `duckdb_indexes()` is keyed by `table_oid` and an index cannot exist without a
table, so an index belongs in `describeObject`'s output, where it is.

**No `secret` kind, and this is the omission worth stating rather than leaving implicit.**
`duckdb_secrets()` is real and answers `name, type, provider, persistent, storage, scope,
secret_string`. A secret has no `database_name` and no `schema_name`: it lives outside the catalog
hierarchy entirely, so there is no container in this model it could hang under. Out of Phase 1's
scope.

There is **no `duckdb_macros()`**, despite what the naming of the other functions suggests, and
`information_schema` is partial here: it has no `.views` and no `.routines`. `duckdb_functions()`
filtered on `function_type` is the only route to a macro.

#### The macro vocabulary is the ENGINE's, and it is guarded against a live read

`function_type` is the whole discriminator between a macro and a built-in, and between the two macro
forms. The vocabulary is derived from **DuckDB's documented macro forms** (`CREATE MACRO f(x) AS
<expression>` is a scalar macro and `CREATE MACRO f(x) AS TABLE <select>` is a table macro), and the
fixture is built to hold **one of each**, rather than from a `SELECT DISTINCT` over whatever the
fixture happened to contain.

`FUNCTION_TYPE_RULES` in `objects.ts` carries both halves: the two macro spellings, and every other
`function_type` with the reason it is excluded. The engine is embedded, so the guard needs no
separate live script the way MySQL's does: `duckdb-provider.test.ts` asks the running engine for its
own `SELECT DISTINCT function_type` (2951 built-in rows plus the fixture's two user macros) and fails
NAMING anything the record does not account for.

| `function_type` | Decision |
|---|---|
| `macro` | A scalar macro, written with `CREATE MACRO … AS <expression>` |
| `table_macro` | A table macro, written with `CREATE MACRO … AS TABLE <select>` |
| `scalar`, `aggregate`, `table`, `pragma` | Built into the engine; nobody wrote them in this database |

Measured and load-bearing: **every built-in function lives in the `system` catalog** (`system.main`
and `system.pg_catalog`), so the `database_name = $1` filter already excludes all 2949 of them. DuckDB
has no `CREATE FUNCTION`, so a macro is the only user-defined function there is, and the
`function_type` predicate therefore changes no count this engine can produce. It is kept because it
is the vocabulary: it is what would keep a future non-macro user function out of the Macros folder,
and what makes the two macro forms explicit. It is asserted on the STATEMENT rather than on a
row count, because no fixture on this engine can distinguish it.

#### The statements

Every container is a bound STRING, never an interpolated identifier: each `duckdb_*` function
publishes its container as a COLUMN. That removes the whole class of quoting defect a three-part name
brings, and it is why this provider needs no `escapeIdentifier` anywhere in the object surface. The
placeholders are NUMBERED (`$1`, `$2`) rather than positional, so one catalog is bound once across a
`UNION ALL` of any number of arms.

```sql
-- CATALOGS_SQL: listContainers()
SELECT database_name, database_name = current_database() AS is_session_default
FROM duckdb_databases()
WHERE NOT internal
ORDER BY database_name;

-- SCHEMAS_SQL: listContainers([catalog])
SELECT schema_name,
       database_name = current_database() AND schema_name = current_schema() AS is_session_default
FROM duckdb_schemas()
WHERE database_name = $1
ORDER BY schema_name;

-- countObjects(): one UNION ALL arm per DECLARED kind, built from the same table as the listings
SELECT 'table' AS kind, COUNT(*) AS n FROM duckdb_tables() WHERE database_name = $1 [AND schema_name = $2]
UNION ALL SELECT 'view', COUNT(*) FROM duckdb_views() WHERE …
UNION ALL SELECT 'macro', COUNT(*) FROM duckdb_functions() WHERE … AND function_type IN ('macro', 'table_macro')
UNION ALL SELECT 'sequence', COUNT(*) FROM duckdb_sequences() WHERE …;

-- listObjects(container, kind)
SELECT schema_name, <name column> AS name FROM <catalog function> WHERE <the same filter>;

-- describeObject(path, kind), for a relation only
SELECT column_name, data_type, is_nullable, column_default FROM duckdb_columns()
  WHERE database_name = $1 AND schema_name = $2 AND table_name = $3 ORDER BY column_index;
SELECT constraint_column_names FROM duckdb_constraints()
  WHERE … AND constraint_type = 'PRIMARY KEY';
SELECT constraint_column_names, referenced_table, referenced_column_names FROM duckdb_constraints()
  WHERE … AND constraint_type = 'FOREIGN KEY';
SELECT index_name, is_unique, expressions::VARCHAR[] AS index_columns FROM duckdb_indexes()
  WHERE … ORDER BY index_name;
```

The count and the listing for one kind are built from ONE record, `DUCKDB_OBJECT_SOURCES`, so the
listing holds exactly what the count counted by construction rather than by care. That is the rule
two other providers in #789 broke on their first pass.

#### Four measured shapes behind those statements

- **`duckdb_schemas().internal` is TRUE for `main` in a USER database** (§3.3). `NOT internal` on the
  schema listing would drop the default schema and with it most of the objects in the tree. The
  catalog filter is what keeps `system` and `temp` out instead, and there `internal` means what a
  reader expects.
- **A DuckDB PRIMARY KEY writes NO `duckdb_indexes()` row.** The index listing needs no exclusion,
  unlike SQL Server's.
- **A foreign key never crosses a schema**: `Binder Error: Creating foreign keys across different
  schemas or catalogs is not supported`. So `referencedTable` is always in the reading object's own
  schema, and it is spelled bare in `main` and qualified anywhere else, because `ForeignKeySchema`
  carries one string.
- **A relation with no column row is a relation that is not there.** `CREATE TABLE t ()` is
  `Parser Error: Table must have at least one column!`, and a view over an empty selection list is a
  parser error too, so zero column rows raises rather than rendering a dropped table as a table with
  no columns.

`hasColumns: true` is declared on `table` and `view` and on nothing else, because `describeObject`
gates the four reads above on `role: "relation"`: a `macro` and a `sequence` answer three empty
arrays without a round trip, so both declare nothing and their rows are leaves in the object tree
rather than twisties that open on nothing.

#### `describeObject` takes the KIND, and on this engine that is not theoretical

Measured on v1.5.5, in ONE schema: `CREATE SEQUENCE overlap` and `CREATE MACRO overlap(x)` both
succeed while the table `overlap` exists, and only `CREATE VIEW overlap` is refused
(`Catalog Error: Table with name "overlap" already exists!`). So the relation namespace is shared
between a table and a view, while a sequence and a macro each have their own, and a table, a sequence
and a macro really can share one name. A detail read keyed on the name alone would hand the sequence
the table's columns.

The same measurement is why `tests/helpers/object-surface-conformance.ts` keeps its uniqueness
invariant inside a kind: a cross-kind assertion would report this correct provider as broken.

**Macros are NOT overloaded on this engine.** `CREATE MACRO f(x, y)` after `CREATE MACRO f(x)`
answers `Catalog Error: Macro Function with name "f" already exists!`, measured, so a macro's own
name is its unique identifier within its schema and the path segment needs no disambiguated form of
the kind a PostgreSQL routine needs.

#### `describeObjects()` describes a whole folder in five statements (#789)

`describeObjects(container, kind, limit?)` answers columns, indexes and foreign keys for EVERY object
of one kind in one container, in FIVE round trips whatever the folder holds: the target read plus the
four detail reads. The single read is four statements PER OBJECT, so a folder of 200 tables cost 800.
Measured on DuckDB v1.5.5 against a 200-table schema, each table carrying three columns, a primary key
and an index: **26 ms for one `describeObjects()` against 1,300 ms for 200 `describeObject()` calls**,
the same 600 columns and 200 indexes.

Each of the four detail statements is its `describeObject()` counterpart with the
`schema_name = $2 AND table_name = $3` pair replaced by a join against the target set, and nothing else
changed: the same catalog function, the same predicates, the same `::VARCHAR[]` cast. They are built by
one function rather than hand-copied four times, because a rewritten statement is the one thing this
file could get wrong that no fixture shows.

The five decisions this engine had to make for itself, each measured rather than reasoned:

**Which catalog.** The same `duckdb_columns()`, `duckdb_constraints()` and `duckdb_indexes()` the single
read uses, and the target from the same `duckdb_tables()` / `duckdb_views()` the listing uses, through
the same `objectSource()` and `kindFilter()`. It is NOT the deleted flat reading: that one filtered
`NOT internal AND database_name = current_database()`, so it could not see an ATTACHed catalog at all,
while the object surface binds the catalog the CALLER asked for. MEMBERSHIP comes from the target read
and never from the column read, so an object the four detail reads answer nothing for comes back with
three empty lists rather than missing.

**Which kinds have no columns.** `macro` and `sequence`, which answer `{ details: [] }` with NO round
trip at all. Measured on v1.5.5: `duckdb_columns()` holds rows for `customers`, `orders`, `t` and
`v_orders` in a database that also holds `app.seq_a` and `app.m_a`, and none at all for the sequence or
the macro. That is the same fact `describeObject()` answers as three empty arrays, and it is keyed on
`role !== "relation"` here because on this engine the two coincide - which is NOT the general rule, as
a PostgreSQL sequence has three columns and a MariaDB one has eight.

**What bounds the read on the wire.** `LIMIT $n` inside the target, the placeholder BOUND rather than
interpolated and carrying `limit + 1`, so a saturated read is told from an exact one with no second
count. Measured accepted inside a CTE on v1.5.5. The placeholder NUMBER is derived from the container
depth rather than written, because the container filter is `$1` alone at catalog level and `$1, $2` at
schema level; DuckDB reuses a numbered parameter, which is what lets the same bind array serve the
target and all four detail statements. The extra object is dropped in code and `truncated` carries the
CALLER's limit. Nothing here caps the columns of an object.

**What orders the cut, and under whose collation.** `ORDER BY schema_name, name` in the target.
`schema_name` leads because a CATALOG-level container spans every schema under it, so `(schema, name)`
is what is unique there. Two things about it were measured rather than assumed. First, no data this
engine can hold separates the ordered statement from the unordered one: five tables created as
`main.zz, main.aa, analytics.mm, analytics.bb, main.cc` come back from a bare
`SELECT ... FROM duckdb_tables()` already sorted, because DuckDB walks its catalog's sorted maps. That
fixture was built specifically to disprove the pin (standing ruling 5a) and did not, so the `ORDER BY`
is pinned by statement TEXT and kept, since the natural order is an implementation detail of the
catalog rather than a promise. Second, that sort runs under the UTF-8 BYTE order, which is NOT the order
`comparePaths` produces: measured, a schema holding `U+E000` and `U+1F600` comes back from DuckDB as
`U+E000, U+1F600` and from a JavaScript sort as `U+1F600, U+E000`, because JavaScript compares UTF-16
code units. So the MEMBERSHIP of a bounded cut is the engine's and the ORDER of the answer is ours.

**Mixed path depth (ruling 5f).** Not in this engine's relation set. Every DuckDB object of every
declared kind sits in a schema, `objectShapes()` refuses a kind declaring `attachedTo`, and there are
no triggers at all, so `table` and `view` are both `[catalog, schema, name]` at either container depth.

The join is on BOTH `schema_name` and the name, never on the name alone, and the outer read keeps
`database_name = $1` as well: the fixture holds `customers` in two schemas of one catalog with
different columns AND in two catalogs with the same schema name, so a join on the name alone answers
one table with another's columns rather than an error anybody would notice.

#### Column defaults: the value, with the catalog text kept alongside (#1029)

DuckDB reports a column default as the expression AS WRITTEN, through `information_schema.columns.column_default`. A string
default therefore arrives quoted, with SQL standard quote doubling, while a number and an
expression arrive bare. Measured 2026-09-21 on DuckDB v1.5.5 through `@duckdb/node-api`:

| DDL | the value the column defaults to | catalog text |
| --- | --- | --- |
| `DEFAULT 'NULL'` | `NULL` | `'NULL'` |
| `DEFAULT 'abc'` | `abc` | `'abc'` |
| `DEFAULT ''` | the empty string | `''` |
| `DEFAULT 'it''s'` | `it's` | `'it''s'` |
| `DEFAULT 'a\b'` | `a\b` | `'a\b'` |
| `DEFAULT 42` | `42` | `42` |
| `DEFAULT CURRENT_TIMESTAMP` | the expression | `CURRENT_TIMESTAMP` |
| `GENERATED ALWAYS AS (id * 2) VIRTUAL` | the expression | `CAST((id * 2) AS INTEGER)` |
| no default | none | SQL NULL |

Each column carries both readings. `defaultValue` is the value, decoded by `unquoteLiteral()`
(`src/lib/sql/values.ts`) with this dialect's `"standard"` escaping, so `'it''s'` reads as
`it's` and a backslash stays ordinary data. Text that is not exactly one complete literal,
a number or an expression such as a generated column's `CAST((id * 2) AS INTEGER)`, passes through unchanged. `defaultExpression` is the
catalog text itself, which is always valid SQL here and is what the schema-diff migration
generator writes after the word `DEFAULT`; without it, a decoded `abc` would be emitted as
`DEFAULT abc`. The empty string default stays the empty string, never `undefined`, and a
column with no default carries neither field. `readCatalogDefault()` is local to this
provider, the way per-provider normalization is everywhere else in this tree; the escape
knowledge it relies on is the shared part.

#### No row count on a listed object, deliberately

`estimated_size` is the only per-table cardinality DuckDB publishes and it is an ESTIMATE (§3.5), so
publishing it as `rowCount` would put a wrong number on a folder row. The honest alternative, a
`count(*)` per object, is the N+1 the inventory route already had `includeColumns` removed for. So a
listed DuckDB object carries no `rowCount` at all.

#### What is not carried

- The `temp` catalog, and therefore TEMP tables. `duckdb_databases()` marks `temp` `internal = true`
  alongside `system`, and both are excluded together. A session-scoped table is invisible in the
  tree.
- Secrets, for the reason above.
- A macro's parameters. `duckdb_functions().parameters` is a `VARCHAR[]` of names, and a routine has
  no columns, so `describeObject` answers three empty arrays for a macro and a sequence without a
  round trip.

`information_schema.tables` / `information_schema.columns` also answer, Postgres-shaped, with
`table_type` of `BASE TABLE` or `VIEW`. They are **not** used: they carry no `internal` flag, so they
cannot separate the user's objects from the system catalog, which is the one distinction the tree
needs. `CALL pragma_table_info('<table>')` additionally answers the SQLite-shaped
`cid, name, type, notnull, dflt_value, pk` — and `notnull` projects fine here because it is `CALL`ed
rather than selected bare, unlike the libSQL case recorded in [libsql.md](./libsql.md) §3.7.

---

### Object source (#789)

Every declared kind publishes a definition text, so **all four declare `hasSource`, all four with
`sourceLanguage: "sql"`, and no kind declares nothing.** `readObjectSource(path, kind, limit?)` reads
one object and answers a document of exactly one part.

`sql` is the honest Monaco id rather than a compromise. DuckDB's dialect is PostgreSQL-shaped, the
installed monaco-editor 0.57.0 registers no DuckDB id, and the text the engine publishes is ordinary
SQL. This is unlike Oracle, SQL Server and Cassandra, where `plsql`, `tsql` and `cql` are not
registrable ids in that bundle and `sql` really is a compromise those provider docs record.

| kind | statement | what the text IS | `form` | `origin` |
|---|---|---|---|---|
| `table` | `SELECT sql AS definition FROM duckdb_tables() WHERE database_name = $1 AND schema_name = $2 AND table_name = $3` | a `CREATE TABLE` statement ending in `;`, rebuilt from the catalog | `complete` | `regenerated` |
| `view` | `SELECT sql AS definition FROM duckdb_views() WHERE database_name = $1 AND schema_name = $2 AND view_name = $3` | a `CREATE VIEW` statement ending in `;` | `complete` | `regenerated` |
| `sequence` | `SELECT sql AS definition FROM duckdb_sequences() WHERE database_name = $1 AND schema_name = $2 AND sequence_name = $3` | a `CREATE SEQUENCE` statement with every option spelled out | `complete` | `regenerated` |
| `macro` | `SELECT macro_definition AS definition FROM duckdb_functions() WHERE database_name = $1 AND schema_name = $2 AND function_type IN ('macro', 'table_macro') AND function_name = $3` | the macro **body**, never a statement | **`partial`** | `regenerated` |

#### The macro is `partial`, deliberately

`duckdb_functions().macro_definition` is a BODY. Measured on v1.5.5 against
`docker/duckdb-init/01-object-fixture.sql`: `CREATE MACRO main.add_one(x) AS x + 1` publishes
`(x + 1)`, and `CREATE MACRO analytics.recent_events(n) AS TABLE SELECT * FROM analytics.events
LIMIT n` publishes `SELECT * FROM analytics.events LIMIT n`. DuckDB publishes no `CREATE MACRO`
statement anywhere: there is no `duckdb_macros()`, and `information_schema` has no `.routines` on this
engine.

The alternative was assembling a statement out of `duckdb_functions().parameters`. It is declined.
Assembling would show a user a statement the engine never published, which they might copy and run,
and the Source pane says `form: partial` with a caption that tells them the text is the body only.
A less pretty pane that is more true. Phase 3 assembles, per the rule that the provider builds the
statement and core never does.

#### `origin` is `regenerated` on all four, and that is measured

The three `sql` columns are **not** the author's bytes. Measured on v1.5.5:

```
CREATE TABLE main.customers (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, note VARCHAR DEFAULT 'none')
  -> CREATE TABLE customers(id INTEGER PRIMARY KEY, "name" VARCHAR NOT NULL, note VARCHAR DEFAULT('none'));
CREATE TABLE main.orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES main.customers(id), total DECIMAL(12,2))
  -> CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, total DECIMAL(12,2), FOREIGN KEY (customer_id) REFERENCES customers(id));
CREATE SEQUENCE main.customer_seq START 1
  -> CREATE SEQUENCE customer_seq INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START 1 NO CYCLE;
```

The schema qualification is dropped, `name` is quoted, the default is parenthesised, an inline
`REFERENCES` becomes a table-level `FOREIGN KEY` clause, and every sequence option is spelled out
whether the author wrote it or not. SQLite is the engine in this fleet where `origin: "stored"` has a
producer; claiming it here would make the Source caption's distinction decoration.

Both `form` and `origin` are declared **per kind, beside the statement that reads the text**, in the
same record the count and the listing are built from. They are one shape of fact, so a kind added
later whose text really is stored bytes has one place to say so and cannot inherit an origin from a
literal somewhere else.

The `partial` form is this engine's only one, not the fleet's: PostgreSQL `view` and
`materialized_view` and Couchbase `function` produce the same arm, each for its own reason.

#### The refusals: NONE, stated as a CANNOT

**This engine has no privilege model and no refusal for a source read.** DuckDB has no users, no
roles and no passwords (§14), so there is nothing a read can be denied for.

Nor does it answer a row carrying nothing. Measured on v1.5.5 over a fresh instance holding the
fixture: zero `duckdb_tables()` rows, zero of 47 `duckdb_views()` rows, zero `duckdb_sequences()`
rows and zero of 136 macros carry a NULL or whitespace-only text. Even a macro written to have no
body publishes something: `CREATE MACRO no_body() AS NULL` answers the four characters `NULL`.

The provider still carries a blank arm, because an empty definition must never reach an editor as a
definition, and it says **which of four shapes** produced it: the reply carried no definition column
at all, the driver handed the column back as something other than a text, the column was NULL, or the
column held no non-whitespace character. The first two are facts about the READ and the last two are
facts about the ROW, and they are kept apart because a refusal stating a cause that is false for the
shape in front of it is worse than one stating none. The non-text shape is not hypothetical:
`@duckdb/node-api` 1.5.5-r.4 already hands a BIGINT `COUNT(*)` back as a decimal **string**, so this
driver's JavaScript mapping is per column type rather than fixed, and the sentence for that shape
names the type the driver answered with. Those four sentences are **ours**, not the engine's, which is
this engine's one exception to the "the engine's own sentence, unprefixed" guarantee: from DuckDB's
point of view the read SUCCEEDED and answered a row, so there is nothing to carry verbatim.

#### A missing name is ABSENCE and raises

A name nothing carries answers **zero rows**, not a row carrying nothing, so the read raises a
`QueryError` naming the object and its container (`No DuckDB macro named no_such_macro in
memory.main`). The container is in the message because on a two-level engine the same name in the
neighbouring catalog is a real object, and a caller needs to be told which one was looked for.

#### The kind is a required argument, and this engine is one of the three reasons

Measured on v1.5.5, and held by `docker/duckdb-init/01-object-fixture.sql`: a table, a sequence and a
macro can all be called `overlap` in one schema, and they answer three different definitions.

```
table    -> CREATE TABLE overlap(id INTEGER);
sequence -> CREATE SEQUENCE overlap INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START 1 NO CYCLE;
macro    -> x
```

A source read keyed on the path alone answers one of the three at random. The kind picks the catalog
function; the three binds pick the row. MySQL, MariaDB and DuckDB are the three engines that made
`kind` a required argument of `readObjectSource`.

#### No escaper, and there is no identifier position to escape

Every bind is a parameter. Each `duckdb_*` table function publishes its container as a COLUMN, so a
catalog and a schema are bound STRINGS rather than parts of a three-part name, and the object's name
is bound too. That removes the whole class of quoting defect ClickHouse and SQL Server need an
identifier escaper for. The same statement builder that the count, the listing and the four detail
reads use builds this one, so a change to the container filter or to the macro `function_type`
predicate moves the source read with it.

#### A macro's overloads

There are none to disambiguate. Measured on v1.5.5: `CREATE MACRO main.pair(a) AS a` followed by
`CREATE MACRO main.pair(a, b) AS a + b` is refused with
`Catalog Error: Macro Function with name "pair" already exists!`, so a macro name is unique within its
schema and the last path segment is the whole identity. This is unlike PostgreSQL, where the routine
segment carries an argument type list.

---

### Object edit (#789)

No kind here is editable on day one, and the four kinds get there two ways: `view` is DEFERRED, and the other three are REFUSED for two different reasons.
`view` is the one DEFERRED case and is the cheapest second producer for the collateral machinery: a single `CREATE OR REPLACE` is atomic on failure, and the price is that a byte-identical replace DISCARDS the view's COMMENT.
`macro` is refused while a Phase 2 defect stands: `CREATE OR REPLACE MACRO` replaces the NAME and deletes every other overload, and the macro read in [`index.ts`](../../src/lib/db/providers/sql/duckdb/index.ts) takes `rows[0]`, so the pane shows one overload and calls it the definition.
`table` and `sequence` are refused because a SUCCESS would destroy what the user was never shown: `CREATE OR REPLACE TABLE` with the table's own published DDL deletes every row, and a sequence's published `START` is the reached value plus one, so the pane shows a clause the author never typed and which moves on every use.
Shipping even the `view` case would make this provider the first producer of `revision.scope: "connection"`, which needs an identity for the PROVIDER INSTANCE that `getOrCreateProvider()` does not mint.
No kind here declares `acceptsSourceEdits`, and `tests/isolated/object-edit-declarations.test.ts` is what holds that absence and this section together.

## 7. Monitoring & health

Measured through a fixture of `main.customers` (5 rows), `main.orders` (7 rows),
`main.customer_totals` (a view), `analytics.events` (2 rows, with `VARCHAR[]` and `STRUCT` columns)
and one index.

| Panel | Reading |
|---|---|
| Version | `v1.5.5`, from `version()` |
| Database size | `2.0 MiB` — a **string** from `pragma_database_size()`, parsed to bytes for the gauge (§3.5) |
| Blocks | `block_size` 262144, `total_blocks` 8, `used_blocks` 8, `free_blocks` 0 |
| WAL size | `0 bytes` on a checkpointed database — again a string |
| Memory usage | `2.0 MiB`; `duckdb_memory()` breaks it down in real bytes: `BASE_TABLE` 2097152 |
| Memory limit | `50.0 GiB` on the probe machine — 80% of host RAM, so **never asserted in a test** |
| Temporary files | Empty, from `duckdb_temporary_files()` — a real reading, not a gap |
| Settings | `access_mode`, `memory_limit`, `threads`, from `duckdb_settings()` |
| Slow queries | **Empty, permanently** — `duckdb_queries()` does not exist, and the panel says so in DuckDB's own words through `slowQueriesEmptyState` (§3.7) |
| Active sessions | **Empty, permanently** — `duckdb_connections()` does not exist, and the panel says so in DuckDB's own words through `sessionsEmptyState` (§3.7) |
| Table bytes | Only via `PRAGMA storage_info('<table>')`, per column segment |

Where a reading is absent it is reported as absent with the reason, never as `0`: a zero on a size
panel reads as an empty database, which is a claim about the user's data.

---

## 8. Maintenance

Nine members exist in the closed `MaintenanceOperation` union, the six of `MaintenanceType` and etcd's three.
DuckDB can honestly offer three.

| Operation | Offered | Statement / reason |
|---|---|---|
| `vacuum` | per table **and** globally | `VACUUM` / `VACUUM <table>`; `VACUUM ANALYZE` also accepted |
| `analyze` | per table **and** globally | `ANALYZE` / `ANALYZE <table>` / `ANALYZE main.customers` |
| `optimize` | **globally only** | Mapped onto `CHECKPOINT` (`FORCE CHECKPOINT` also accepted). There is no per-table form |
| `reindex` | withheld | `Parser Error: syntax error at or near "REINDEX"` — the statement does not exist |
| `check` | withheld | `PRAGMA integrity_check` → `Catalog Error: Pragma Function with name integrity_check does not exist!` |
| `kill` | withheld | There is no session to kill (§3.7) |
| `compact` | withheld | etcd's history compaction; DuckDB has no revision history |
| `defragment` | withheld | etcd's member defragmentation; `CHECKPOINT` is `optimize` above |
| `disarm` | withheld | etcd's alarms; DuckDB raises none |

`PRAGMA optimize` was probed too and does **not** exist
(`Catalog Error: Pragma Function with name optimize does not exist!`) — which is why `optimize` maps
onto `CHECKPOINT` rather than onto a same-named pragma.

Every declared operation carries a `maintenanceOperationSpecs` entry, so the UI knows that `vacuum`
and `analyze` accept a target and `optimize` does not; a global-only operation offered with a
per-entity control would fail at the point the user clicked it. `runMaintenance` refuses the three
withheld types **here**, naming the reason, rather than sending a statement the engine will reject
with wording about a keyword the user never typed.

`runMaintenance(type, target?, container?)` takes a `container` as the SCHEMA the row carries as
`schemaName` (#772), the same reading PostgreSQL uses: the schema is quoted whole and prefixed to
the quoted table name, and never recovered by splitting the target - a schema is allowed to contain
a dot. Without one the old readings stand: `schema.table` is quoted part by part and a bare name
falls back to `main`.

---

## 9. Capabilities & labels

### 9.1  `getCapabilities()` ([`index.ts`](../../src/lib/db/providers/sql/duckdb/index.ts))

| Capability | Value | UI effect |
|---|---|---|
| `defaultPort` | `null` | No port field is needed; DuckDB has no network listener. |
| `supportsConnectionString` | `false` | The connection form takes a database file path rather than a URI (§4.2). |
| `supportsExplain` | `true` | Enables the Explain action. |
| `explainFormat` | `duckdb-json` | The Explain view consumes DuckDB's JSON physical plan (§5). |
| `supportsInlineRowEdit` | `true` | Enables inline row editing for writable table objects. |
| `supportsTestDataGeneration` | `true` | The row menus offer Generate Test Data on writable table objects; it writes one multi-row `INSERT INTO ... VALUES`. |
| `supportsResultPagination` | `true` | Enables Load More; the shared limiter emits `LIMIT n OFFSET m`. |
| `supportsTransactions` | `false` | Hides the transaction controls; the provider exposes no transaction API. |
| `singleWriterFile` | `true` | Lets callers treat an already-open DuckDB file as a single-writer resource (§3.8). |
| `readsFileAccessPosture` | `true` | The editor handle opens under the file-access posture of `ProviderExecutionContext.allowExternalFileAccess`, so the handle cache and the single-writer borrow split DuckDB handles by posture through `READS_FILE_ACCESS_POSTURE` (§3.16). |
| `identifierQuoting` | `double` | Generated SQL quotes identifiers with double quotes. |
| `maintenanceOperations` | `vacuum`, `analyze`, `optimize` | Offers only the maintenance operations implemented in §8. |
| `containerLevels` | `Database`, `Schema` | The object browser nests schemas under databases (§6). |
| `containerPathShapes` | `prefixes` | `[database]` and `[database, schema]` both address a container, because an attached database alone is a real address; the empty path and a longer path are both refused, by the object routes over HTTP and by this provider directly (§6, #1147). |
| `objectKinds` | `table`, `view`, `macro`, `sequence` | These are the object folders exposed in the browser (§6). |

The maintenance specs make `vacuum` and `analyze` available both per table and globally.
`optimize` is global only and is labelled **Checkpoint Database** because it runs `CHECKPOINT`.
See §8 for the statements and placement rules.

### 9.2  `getLabels()` ([`index.ts`](../../src/lib/db/providers/sql/duckdb/index.ts))

| Label | UI effect |
|---|---|
| `slowQueriesEmptyState` | Explains that DuckDB publishes no `duckdb_queries()` table function, so the Queries panel has no finished-statement store to show. |
| `sessionsEmptyState` | Explains that DuckDB publishes no `duckdb_connections()` table function, so the Sessions panel cannot show rows. |
| `vacuumGlobalDesc` | Describes the global `VACUUM` control and its checkpoint behaviour. |

The first two replace generic empty-state copy with the engine-specific absence already measured
in §3.7. The maintenance label does not add another operation; it only describes the global
`vacuum` control declared above.



---




## 10. Error handling

DuckDB errors are classified by `mapDuckDBError()` before falling back to the shared database
error mapper. The provider reads DuckDB's error-class prefix first so that words inside an engine
message do not accidentally select an unrelated shared classification.

| Condition | Provider error | What the user sees |
|---|---|---|
| `INTERRUPT Error` | `QueryCancelledError` | `Query was cancelled` |
| Conflicting file lock | `ConnectionError` | `DuckDB file <path> is locked by <process>. DuckDB admits one operating-system process per database file, in read-only mode too, so the other process has to release it first. Engine message: <engine message>` |
| A write in the editor on a file opened read-only because this process cannot write it (§3.15) | `QueryError` | `DuckDB database <path> is open read-only because this process cannot write the file or its directory: <engine message>` |
| A `Permission Error` on an editor handle opened with file access denied (§3.16) | `QueryError` | `File and network access is off on this DuckDB connection: the handle was opened with external access denied, which Studio does for every role but admin and for any connection a non-admin role can use, and which an embedder overrides by passing { allowExternalFileAccess: true }: <engine message>` |
| `Parser Error`, `Binder Error`, `Catalog Error`, `Conversion Error`, `Invalid Input Error`, `Constraint Error`, `Out of Range Error`, `Not implemented Error`, `Permission Error`, `Serialization Error`, `TransactionContext Error` | `QueryError` | The engine message, with the query attached when one is available |
| Anything else | shared database error | `mapDatabaseError()` classifies the error using the common provider rules |

A lock conflict uses the same `describeOpenFailure()` path whether it happens while opening the
file or later in a session. When DuckDB includes the holder PID, the sentence names
`process <pid>`; otherwise it says `another process`.

Open-time failures have five additional provider-specific diagnoses:

| Condition | Provider error | What the user sees |
|---|---|---|
| `@duckdb/node-api` is not installed | `ConnectionError` | `DuckDB is not available in this deployment: the @duckdb/node-api driver is not installed. The libredb-studio -alpine-slim image leaves it out to stay small; the default and -alpine tags ship it. Use one of those tags, or install the driver, to open DuckDB connections.` |
| Read-only open of a missing file | `ConnectionError` | `DuckDB database <path> does not exist and a read-only handle will not create one. Engine message: <engine message>` |
| A SQLite file, refused before the engine opens it (§3.14) | `ConnectionError` | `<path> is a SQLite database file, not a DuckDB database file. Open it with a SQLite connection. DuckDB did not open it, so it is unchanged.` |
| Any other file without DuckDB's header, an empty one included (§3.14) | `ConnectionError` | `<path> is not a DuckDB database file: a DuckDB file carries "DUCK" at byte 8, and this one does not. DuckDB did not open it, so it is unchanged.` |
| A handle with file and network access off cannot make its private temp directory (§3.16) | `ConnectionError` | `Could not open DuckDB database <path>: a handle with file and network access off keeps its temporary files in a private directory, and creating one under <temp directory> failed: <system message>. Make that directory writable for the Studio process, or point TMPDIR (TEMP on Windows) at one that is.` |
| Other open failure | `ConnectionError` | `Failed to open DuckDB database <path>: <engine message>` |

The lock and missing-file sentences above are the provider's wrapped messages, not the raw engine
messages measured in §3.8. Driver absence is diagnosed only when module resolution fails and the
failure names `@duckdb/node-api`; other import failures are re-raised unchanged.


---

## 11. Packaging

DuckDB is the first new **native** dependency in this repo since `better-sqlite3`, and it is not
shaped like it. `bun add @duckdb/node-api@1.5.5-r.4` installed four packages:

| Package | Size | Role |
|---|---|---|
| `@duckdb/node-api` | 1.6M | The JavaScript API |
| `@duckdb/node-bindings` | 108K | The loader that picks a platform package |
| `@duckdb/node-bindings-linux-x64` | 68M | `duckdb.node` + the glibc `libduckdb.so` |
| `@duckdb/node-bindings-linux-x64-musl` | 71M | The musl sibling |

**Both are installed on a glibc Linux box**, so the tree carries ~140 MB of shared library where only
68 MB can ever load. The **AppImage build must prune `@duckdb/node-bindings-*-musl` before linuxdeploy
runs**, or the payload doubles for nothing.

Both runtimes load the addon — measured, not assumed: `SELECT 42` answered under **Bun 1.3.14** and
under **Node 24.14.0**. That matters because Studio's packaged channels run the built app under Node
while local development runs it under Bun, the same split the SQLite provider documents.

Bundled extensions are present without network access: `autocomplete`, `core_functions`, `icu`, `json`
and `parquet` were loaded, and `httpfs` was installed but not loaded.

---

## 12. Testing

```bash
# Just this provider
bun test tests/integration/db/duckdb-provider.test.ts
```

**There is no service to start.** `database-compose.yml` gains nothing for DuckDB — the engine is
inside the npm package, so unlike every networked provider in this directory there is no container,
no port and no health wait. The tests follow the SQLite pattern rather than the libSQL one: **no
mocks at all**, the real driver against `:memory:` and against real files in a `mkdtemp` directory
that is removed afterwards. `mock.module()` is refused, being process-wide in bun and able to poison
sibling test files.

Two things the tests deliberately do **not** assert, both from §3.5 and §7: `memory_limit` (80% of
host RAM, machine-dependent) and any absolute byte figure parsed from a formatted size string.

The object-surface and object-source tests (§6) are the same shape and it matters more there:
because the engine is in-process, every claim about `duckdb_databases()`, `duckdb_schemas()`,
`function_type` and every definition text in this document is re-measured against a REAL DuckDB on
every test run, and the fixture `ATTACH`es a second catalog so the two container levels are exercised
live.

**The fixture is a committed file**, `docker/duckdb-init/01-object-fixture.sql`, replayed by the
suite through `docker/duckdb-init/build-fixture.ts`. The same reader builds a database FILE anybody
can point Studio at:

```bash
bun docker/duckdb-init/build-fixture.ts                    # ./.duckdb-fixture/object-fixture.duckdb
bun docker/duckdb-init/build-fixture.ts /tmp/demo.duckdb   # anywhere else
```

The fixture's second catalog is a placeholder the reader substitutes: the suite attaches `:memory:`
and a file build attaches a sibling file, because DuckDB does **not** persist an attachment inside a
database file. So opening the built file shows one catalog, and the builder prints the `ATTACH`
statement that reaches the other. Two facts are asserted on the
STATEMENT rather than on rows, because no fixture on this engine can distinguish them: the macro
`function_type` predicate, and `ORDER BY column_index` on the column read.

A refused count is driven with `SET max_expression_depth=1`, which is pure configuration and so
always takes effect. `SET memory_limit='1KB'` was the obvious alternative and is not usable: measured,
the SET itself starts failing with *could not free up enough memory for the new limit* once the
fixture holds enough, so the refusal would come and go with the fixture's size. The control for it
has to be a second handle, because once the depth is 1 even `SET max_expression_depth=1000` and
`RESET` are refused by the same limit.

### 12.1 Verifying by hand

Create a directory and point a connection at a file inside it:

```bash
mkdir -p /tmp/libredb-duckdb
# then add a DuckDB connection in Studio with database = /tmp/libredb-duckdb/warehouse.duckdb
```

Remember §3.8: close any other process holding that file first, including a `duckdb` CLI session — a
second process is refused even for reading.

---





## 13. Usage examples

These examples assume a DuckDB file connection already configured as described in §4.
DuckDB has no connection string or network endpoint; SQL runs against the file named by the
connection's `database` field.

Create a table and insert rows:

```sql
CREATE TABLE events (
  id INTEGER,
  name VARCHAR
);

INSERT INTO events VALUES
  (1, 'created'),
  (2, 'updated');
```

Read rows from the file:

```sql
SELECT id, name
FROM events
ORDER BY id;
```

Pagination is supported, so ordinary DuckDB `LIMIT` and `OFFSET` queries can also be run directly:

```sql
SELECT id, name
FROM events
ORDER BY id
LIMIT 25 OFFSET 0;
```

For the provider's maintenance operations, use the controls described in §8 rather than repeating
their setup here.

---

## 14. Security

DuckDB has no users, no roles and no passwords: **the filesystem is the access control**, and Studio
runs the engine in its own process with its own privileges. Two consequences drive the provider's
security posture.

### 14.1 `access_mode` alone does not bound the process — the escapes that proved it

With `access_mode: 'READ_ONLY'` genuinely in force — `INSERT` refused with *Cannot execute statement
of type "INSERT" on database "w" which is attached in read-only mode!* in the same session — the
following all **succeeded**. This table is the reason the second option below exists; it is not the
current behaviour of the agent handle.

| Statement | Outcome under `READ_ONLY` alone | Under `enable_external_access: 'false'` |
|---|---|---|
| `INSERT INTO users …` | refused | refused |
| `COPY (SELECT 1) TO '/path/leak.csv' (FORMAT CSV)` | **ALLOWED — file written** | `Permission Error` |
| `COPY users TO '/path/leak.parquet' (FORMAT PARQUET)` | **ALLOWED — file written** | `Permission Error` |
| `EXPORT DATABASE '/path/exp'` | **ALLOWED — directory written** | `Permission Error` |
| `INSTALL httpfs` | **ALLOWED** — reaches the network | `Permission Error` on the extension directory |
| `read_csv_auto('/path/x.csv')` | **ALLOWED** — arbitrary local file read | `Permission Error` |
| `read_text('/etc/hostname')` | **ALLOWED — file contents returned** | `Permission Error` |
| `read_blob('/etc/hostname')` | **ALLOWED — file bytes returned** | `Permission Error` |
| `glob('/etc/*')` | **ALLOWED — directory listing** | `Permission Error` |
| `sniff_csv('/etc/hostname')` | **ALLOWED** | `Permission Error` |
| `ATTACH '/path/new.duckdb' AS side` | refused — the file must already exist | `Permission Error` |
| `CREATE TEMP TABLE` + `INSERT` into it | ALLOWED — the temp catalog is writable | ALLOWED |
| `SET memory_limit='1GB'` | ALLOWED | ALLOWED |
| `LOAD json` | ALLOWED | ALLOWED — the bundled extension needs no file |
| Ordinary reads, `duckdb_*()`, `pragma_database_size()`, `pragma_storage_info()` | ALLOWED | ALLOWED — untouched |

Read the first column as: the engine flag protects the *database file*, and nothing else. An agent
given only that handle could write CSV anywhere the Studio process can write, read any file the
process can read, and pull an extension over the network.

The right column's `Permission Error` rows are also the editor's denied posture (§3.16): a non-admin, and every role on a seed a non-admin role can use, opens a WRITABLE handle with `enable_external_access: 'false'`, so every file or network form this table marks `Permission Error` is refused there too.
It differs from this table in one way: the denied editor keeps the database writable, unlike the read-only agent handle measured here, so `INSERT`, `CREATE TEMP TABLE`, `SET`, `LOAD json` and ordinary reads all succeed on it.
Only an admin editor on an inline connection or an admin-only seed keeps the left-column reach.

### 14.2 The boundary is in the engine, and the denylist is defence in depth

`queryReadOnly` opens its handle with **`access_mode: 'READ_ONLY'` and
`enable_external_access: 'false'`**, both fixed at open. The second is what makes the profile a
sandbox: the engine itself refuses every filesystem reach with

```
Permission Error: Cannot access file "…" - file system operations are disabled by configuration
```

and a session cannot climb back out: `SET enable_external_access = true` and its `SET GLOBAL` form both answer `Invalid Input Error: Cannot enable external access while database is running` (measured; `SET memory_limit` in the same session is accepted, so this refusal is a property of the option rather than of read-only mode).
The **admin's full-reach editor connection passes neither option** (the denied posture passes `enable_external_access: 'false'`, §3.16): there `COPY … TO` and `read_csv_auto('…')` are features, and they were measured unaffected.

The SQL denylist in `index.ts` still runs first, and it is **defence in depth, not the boundary**: a
refusal naming the construct and the reason is worth more to a reader than the engine's sentence, it
costs nothing before the engine, and it keeps a future change to the open options from being a
silent single point of failure.

**Three measured bypasses are why it cannot be the boundary.** All three executed when the denylist
was the only control, and all three are refused by the engine option today:

| Bypass | Why the text guard misses it |
|---|---|
| `SELECT * FROM "read_text"('/etc/hostname')` | `findCodeWord` skips quoted-identifier spans by design — correct for a keyword, wrong for a function name, and DuckDB resolves `"read_text"(…)` and `main."read_text"(…)` exactly like the bare spelling. All three spellings returned `/etc/hostname` |
| `SELECT * FROM '/tmp/x.csv'` | DuckDB's replacement scan turns a bare path in `FROM` into a `read_csv_auto`. There is no forbidden word anywhere in the statement to find |
| `json_execute_serialized_sql(json_serialize_sql('SELECT * FROM read_text(''/etc/hostname'')'))` | The whole second statement travels inside a string literal, which the scanner correctly refuses to read as code. The outer function is denied **by name**, but the class is not closable by reading text |

The same measurement pass found one thing the option does **not** stop: `read_duckdb('<this
connection's own file>')` still answers, because it reaches nothing the profile had not already
granted.

The same `enable_external_access: 'false'` boundary, on a **writable** handle, is the editor's denied posture (§3.16): the three bypasses above are refused there too, which is why the editor path relies on the engine option rather than on the statement denylist.

### 14.3 The file path is a trust boundary for every role, and statement reach is the admin's

Anyone who can create a DuckDB connection chooses a path on the server's filesystem, and the handle opens whatever DuckDB database that path names, read-write, creating it when it is missing.
That holds for every role, because the main database is not external to the engine (§3.16).
Where the posture allows file access, the engine will also happily read a CSV, Parquet or JSON file next to it, so on a shared deployment an admin DuckDB connection is closer to a shell on the Studio host than to a database login: grant admin accordingly.

Under the denied posture (§3.16), which is every non-admin's handle and every handle on a seed a non-admin role can use, `read_text`, `read_csv`, `COPY`, `ATTACH` of a file, `INSTALL`, `httpfs` and every other statement-level file or network route answer the engine's `Permission Error`, except inside the handle's own private temp directory and on its database's own file names, while the connection's own database stays read-write.
So the "closer to a shell" caution is the admin's, but a standard user with a DuckDB connection still reaches any DuckDB-format file whose path they name: the path is not sandboxed for any role, the position [`sqlite.md`](./sqlite.md) section 14 records for SQLite (issue #125).

### 14.4 Opening a connection reaches no network

A path is the only thing a DuckDB connection carries, and before #1404 a path was enough to make the
server download and load native code: the engine auto-installed the extension that could read
whatever file the path named (§3.14). Every handle now opens with extension autoinstall and autoload
off, community extensions refused and a file without DuckDB's header refused before the engine opens
it, so opening a connection, Test Connection included, makes no network request and writes nothing to
a file that is not a DuckDB database. Only DuckDB's own signed extensions can load on any handle.

**The editor itself still reaches the network, and that is deliberate, not closed.** Measured on
v1.5.5, from an editor session:

- `SET custom_extension_repository = 'http://<any host>/...'` followed by `INSTALL <name>` makes the
  Studio server send an HTTP request to that host. What it downloads still has to carry DuckDB's
  signature to be installed, but the request is made.
- `INSTALL httpfs; LOAD httpfs;` and then `read_csv('http://<any host>/...')` makes the server
  request any URL a user names, internal addresses included: a server-side request forgery
  surface, with the server's own network position.

Both were open before this change as well, with a lower bar (an implicit autoinstall needed no `INSTALL` at all).
They are the admin editor's features, the same way `COPY ... TO` and local `read_csv` are, and they are why §14.3 says an admin DuckDB connection is **closer to a shell on the Studio host than to a database login**: grant admin only to people you would trust with outbound network access from the server.
`enable_external_access` and `lock_configuration` are not set on the admin's full-reach editor handle because they would also break those documented reads and writes, and the per-session opt-in in §3.14.
Restricting that handle further is an operator policy decision that this provider does not make on its own; the denied posture already sets `enable_external_access: 'false'` for every non-admin role and for every role on a seed a non-admin role can use (§3.16).

The agent read-only profile has none of this reach: `enable_external_access` is off there and its denylist refuses `INSTALL` and `LOAD` (§3.10).
The editor's denied posture has none of it either, for the same reason: `enable_external_access` is off on its handle (§3.16), so the `custom_extension_repository` + `INSTALL` and the `httpfs` + `read_csv('http://...')` routes above both answer `Permission Error`.
The reach described in this section is an admin editor's on an inline connection or an admin-only seed.

---

## 15. Known limitations

| Limitation | Cause | Owner |
|---|---|---|
| Under the denied posture, which is a non-admin role and every role on a seed a non-admin role can use, a statement cannot reach the network or a file other than the database's own and the handle's private temp directory, so it cannot import CSV/Parquet/JSON, `COPY` to or from such a file, `ATTACH` one or install extensions, while the database path itself is still any DuckDB file the process can access | `enable_external_access: 'false'` on that editor handle, and one handle per seed record because DuckDB serves one file through one read-write handle per process | **Ours, and intended**: the security change, while an admin keeps full reach on an inline connection and an admin-only seed (§3.16, §14.3) |
| The file must live on Studio's filesystem | Embedded engine, no network protocol | The engine's (§1.1) |
| A second process cannot open the file, even read-only | Measured lock behaviour | The engine's (§3.8) |
| No transaction controls | Not exposed by this provider | Ours — `supportsTransactions: false` |
| No slow queries, no session list | `duckdb_queries()` and `duckdb_connections()` do not exist | The engine's (§3.7) |
| No `REINDEX`, no integrity check | Neither statement exists on 1.5.5 | The engine's (§8) |
| No analyze/timing plan, ever | `EXPLAIN (ANALYZE, FORMAT JSON)` **executes the statement** — measured, an `INSERT` explained three times inserted three rows | **Ours, and permanent.** A later DuckDB emitting valid analyze JSON makes this worse, not better: the plan would look usable while still running what the user asked only to see (§3.6) |
| Sizes arrive as formatted strings | `pragma_database_size()` publishes no raw bytes | The engine's (§3.5) |
| Wide integers render as strings | `getRowsJson()` quotes them to stay exact | The engine's, and deliberate (§3.2) |
| A multi-statement string runs only its first statement | The driver's `runAndReadAll` behaviour | The driver's (§3.11) |
| No `SERIAL`, no `IDENTITY`, no `AUTOINCREMENT` | None of the three exists; `GENERATED … AS IDENTITY` parses and is refused at execution | The engine's — the create-table form defaults from a sequence instead (§3.13) |
|  ~140 MB of bindings on a Linux tree | glibc and musl packages both install | Ours to prune in the AppImage build (§11) |
| MotherDuck / `md:` / Quack / DuckLake unsupported | Different products, different authentication | Ours — out of scope for v1 (§4.3) |
| TEMP tables are absent from the object tree | `duckdb_databases()` marks `temp` `internal`, alongside `system` | Ours, §6 |
| Secrets are not an object kind | A secret has no catalog and no schema, so nothing in the model can hold it | Ours, out of Phase 1's scope (§6) |
| A listed object carries no row count | `estimated_size` is an estimate, and `count(*)` per object is an N+1 | Ours, §6 and §3.5 |
| A macro's Source pane shows a BODY, not a `CREATE MACRO` statement | `duckdb_functions().macro_definition` is the only text the engine publishes, and there is no `duckdb_macros()` | The engine's; ours to assemble in a later phase, and the pane says `form: partial` meanwhile (§6, Object source) |
| Every definition text is a regeneration, never the author's bytes | The catalog stores a parsed object, not the submitted statement | The engine's (§6, Object source) |

---

## 16. References

- DuckDB — <https://duckdb.org>
- `@duckdb/node-api` — <https://www.npmjs.com/package/@duckdb/node-api>
- [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) — the registration checklist this provider followed
- [`docs/providers/sqlite.md`](sqlite.md) — the other embedded, file-based engine, and the same deployment constraint
- [`docs/providers/postgres.md`](postgres.md) — the canonical SQL-family walkthrough


Connection targets reserve Studio's storage database, its WAL/SHM files and bootstrap
credentials (including backups and temporary files). This applies to every role.
Checks normalize paths, resolve symbolic links and compare existing file identities
so hard links cannot alias reserved files. Other user database files beside them remain usable.
