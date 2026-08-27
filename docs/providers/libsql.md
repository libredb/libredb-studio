# libSQL Provider

> libSQL support for LibreDB Studio, built on the Hrana HTTP protocol (`POST /v2/pipeline`) with
> **no driver dependency of any kind**: a statement is JSON in the body of a POST and the answer
> comes back through the runtime's own `fetch`. One type-id reaches two deployments — a self-hosted
> **libSQL server (`sqld`)** and **Turso Cloud** — because they speak the same protocol and embed the
> same SQLite. This document is the single reference point for the libSQL provider: design,
> architecture, usage, and tests.

| | |
|---|---|
| **Status** | Implemented & shipped |
| **Database type id** | `libsql` |
| **Family** | SQL (`src/lib/db/providers/sql/libsql/`) |
| **Driver** | None — HTTP only (`fetch`, a runtime built-in) |
| **Query language** | `sql` (SQLite's dialect, 3.47.0 on both deployments measured) |
| **Default port** | `8080` (sqld's own). `443` when TLS is on, which is how Turso Cloud serves every database |
| **Connection pooling** | None — each statement is one stateless HTTP request |
| **Connection string** | Supported (`libsql://<database>-<org>.turso.io?authToken=<jwt>`) |
| **Credential** | An auth TOKEN, not a password. libSQL has no user names, so the form labels the field "Auth Token" |
| **EXPLAIN** | `sqlite-queryplan` — the same `EXPLAIN QUERY PLAN` shape SQLite answers |
| **Transactions** | Not exposed (the provider closes its Hrana stream with each statement, so it holds no session for one) |
| **Maintenance** | `reindex` and `check` only — `VACUUM`, `ANALYZE`, `PRAGMA optimize` and `PRAGMA wal_checkpoint` are refused by the server on both deployments |
| **Source** | [`src/lib/db/providers/sql/libsql/`](../../src/lib/db/providers/sql/libsql/) |
| **Tests** | [`tests/integration/db/libsql-provider.test.ts`](../../tests/integration/db/libsql-provider.test.ts) + [`tests/unit/db/libsql/`](../../tests/unit/db/libsql/) |
| **Tracking issue** | [#424 — the database coverage map](https://github.com/libredb/libredb-studio/issues/424) |
| **Probed against** | `ghcr.io/tursodatabase/libsql-server` reporting `sqld 0.24.33 (f8fb14f3 2026-08-11)`, and a Turso Cloud database in `aws-eu-west-1`, both on 2026-08-27 |
| **Reproducible with** | `ghcr.io/tursodatabase/libsql-server:v0.24.33`, the tag `database-compose.yml` pins. It is a DIFFERENT build of the same version - `sqld 0.24.33 (40a151bd 2025-12-19)`, because `:latest` is a rolling rebuild - and it was re-probed surface by surface on 2026-08-27: the same 17 of 19, the same four refusals with byte-identical wording, and the same `"notnull"` behaviour. Every measurement below therefore holds on the pinned tag as well as on the build it was taken from. |

---

## 1. Overview

libSQL is a fork of SQLite that keeps the file format and the dialect and adds a **server**. What a
client talks to is `sqld`, and what `sqld` speaks is Hrana: a list of requests posted as JSON, one
result per request, values encoded as `{ type, value }` with integers carried as decimal strings.
Turso Cloud is that same server, managed and reached over TLS on a hostname that identifies the
database.

That is the whole reason this is a separate type-id from `sqlite` rather than a relative of it, and
the reason it is ONE id rather than two:

- **Not `sqlite`.** The SQLite provider holds a FILE handle through a synchronous driver
  (`bun:sqlite` / `node:sqlite`), reads sizes with `fs.statSync`, and enforces the agent read-only
  profile with `PRAGMA query_only`. None of those three exist here: there is no file on this
  machine, no handle to hold, and `PRAGMA query_only = true` is refused by the server. The dialect is
  shared; the execution layer has nothing in common.
- **Not two ids.** A self-hosted `sqld` and a Turso Cloud database differ in host, TLS and token.
  Every statement, every catalog and every refusal measured the same on both. Two ids would mean two
  docs and two tests describing one set of measurements.

**Turso Database — the Rust rewrite — is deliberately absent.** It is a different engine (written
from scratch, SQLite-compatible, concurrent writes and vector search) rather than a deployment of
this one, and on 2026-08-27 it published **no server image**: `tursodatabase/turso`,
`tursodatabase/tursodb` and `ghcr.io/tursodatabase/turso-server` were all unpullable, and the engine
ships as an in-process npm package (`@tursodatabase/database`). #424 publishes a name only after
connecting to it, so it earns no row here or in the compatibility registry.

### Concept mapping

| libSQL | This product | Note |
|---|---|---|
| A database (a hostname on Turso Cloud, a namespace on `sqld`) | The connection | There is no `database` field: the database IS the host |
| `main` schema | The single schema | SQLite has one, and the provider reports `schemaName: "main"` throughout |
| Table | Table | `sqlite_master` |
| Index | Index | `pragma_index_list`, minus SQLite's own `sqlite_autoindex_*` |
| Auth token (JWT) | The `password` field | Labelled "Auth Token" in the connection dialog |
| `dbstat` pages | Table and index bytes | Available on BOTH deployments, unlike `bun:sqlite` |

---

## 2. Architecture

```
src/lib/db/providers/sql/libsql/
├── index.ts             LibSQLProvider — the 13 provider methods, capabilities, labels
├── introspect.ts        every read expressed as SQL (sqlite_master, pragma_*, dbstat)
├── transport.ts         the NEUTRAL seam: what a caller needs, not how Hrana spells it
└── hrana-transport.ts   the only file that knows /v2/pipeline, the baton and the value codec
```

`tests/unit/db/libsql/seam-guard.test.ts` parses every file in that directory and fails the build if
Hrana vocabulary (`baton`, `base_url`, `affected_row_count`, `query_duration_ms`,
`replication_index`, `decltype`, `rows_read`, `rows_written`, the endpoint path) appears outside
`hrana-transport.ts`. `last_insert_rowid` is checked only as a payload READ, because it is also a
real SQLite function that any implementation may legitimately call.

The seam is not ceremony: Hrana also runs over WebSocket, `@tursodatabase/database` embeds the engine
in-process, and `@libsql/client` speaks both. Any of them would answer the same questions — none of
them with a `baton`.

---

## 3. Design decisions

### 3.1 No driver, and the reason is the protocol's size

`@libsql/client` is a dependency to speak a protocol that is three JSON shapes wide: a request list,
a result list, and a typed value. The whole transport is ~330 lines including the comments that
record the wire. The same judgement as Couchbase (#263), ClickHouse (#264), Druid (#265) and Trino
(#438).

### 3.2 A failed statement answers HTTP 200

Measured on both deployments:

```
POST /v2/pipeline   {"requests":[{"type":"execute","stmt":{"sql":"SELECT * FROM no_such_table"}},{"type":"close"}]}
HTTP/1.1 200 OK
{"baton":null,"base_url":null,"results":[
  {"type":"error","error":{"message":"SQLite error: no such table: no_such_table","code":"SQLITE_UNKNOWN"}},
  {"type":"ok","response":{"type":"close"}}]}
```

So `response.ok` says the pipeline was accepted, never that the statement ran. Every failure is read
out of `results[]`. This is the trap Trino's provider documents in the same words, and it is why the
transport carries `status: 200` on a statement error deliberately: the transport succeeded.

### 3.3 An auth failure uses a different envelope, and a bad token is a 400

| Situation | Status | Body |
|---|---|---|
| No token to a private database | `401` | `{"error":"Unauthorized: \`unauthorized access attempt on database: empty JWT token\`"}` |
| Malformed token | `400` | `{"error":"JWT error: InvalidToken"}` |
| Statement rejected | `200` | `{"results":[{"type":"error","error":{"message":…,"code":…}}]}` |

The auth envelope's `error` is a bare STRING rather than the `{ message, code }` object the statement
path uses, so the error reader handles both. 400 is in the provider's authentication set alongside
401 and 403 for that reason: keying only on 401 would report a malformed token as a connection
failure.

### 3.4 Integers arrive as decimal strings, and they stay exact

Hrana quotes every integer — `{"type":"integer","value":"2000"}` — which is the protocol protecting
64-bit values from a double. `decodeInteger` returns a `number` when the value is exactly
representable and the **decimal string verbatim** when it is not. `Number("9007199254740993")` is
9007199254740992, and a rounded rowid is a corruption nothing downstream can detect (#460 is the
Trino version of the same lesson).

The one place a wide integer IS parsed to a double is `readNumber` in `introspect.ts`, and only for
display statistics: a row count above 2^53 is 9 quadrillion rows. Result CELLS never pass through it.

### 3.5 The server refuses four statements, so four controls are withheld

Measured on both deployments, with the wording differing and the code identical:

| Statement | sqld 0.24.33 | Turso Cloud |
|---|---|---|
| `VACUUM` | `unsupported statement: VACUUM` | `SQL not allowed statement: VACUUM` |
| `ANALYZE` | `unsupported statement: ANALYZE` | `SQL not allowed statement: ANALYZE` |
| `PRAGMA optimize` | `unsupported statement: PRAGMA optimize` | `SQL not allowed statement: PRAGMA optimize` |
| `PRAGMA wal_checkpoint(TRUNCATE)` | `unsupported statement` | `SQL statement is not allowed` |
| `PRAGMA query_only = true` | `unsupported statement` | `SQL not allowed statement` |
| `REINDEX` | accepted | accepted |
| `PRAGMA integrity_check` | accepted | accepted |

`maintenanceOperations` is therefore `["reindex", "check"]`. A Vacuum control that fails every time
is the Cloud Spanner shape #424 refuses rows for, and `runMaintenance` refuses the other types HERE
rather than sending them, so the message names the reason instead of relaying a server error for a
statement the user never typed.

**Nothing keys on the wording.** The two deployments word the identical refusal differently under one
`SQL_PARSE_ERROR`, so a provider that matched on text would have been wrong on one of them from the
first day.

### 3.6 `PRAGMA query_only` is refused, so there is no agent read-only profile

`sqlite.ts` implements `queryReadOnly` by setting `query_only` and verifying the readback, per
statement — that is what refuses `VACUUM INTO '<path>'` from a read-only handle. libSQL has no such
lever: the pragma is refused on both deployments. So this provider implements **no** `queryReadOnly`,
and the agent read-only profile stays PostgreSQL + SQLite.

That is a gap with an engine-side answer when it is wanted: Turso mints **read-only tokens**
(`turso db tokens create --read-only`) and the API can `block_writes` on a database. Both are
credentials the user creates, not statements this provider can issue, which is why the profile is
absent rather than faked.

### 3.7 `notnull` must be quoted, and only a live server says so

```sql
SELECT cid, name, type, notnull, dflt_value, pk FROM pragma_table_info('probe_customers')
-- SQL string could not be parsed: near NOTNULL, "None": syntax error at (1, 32)
```

`notnull` is a SQLite keyword — the postfix `x NOTNULL` operator — so projecting it bare is a parse
error. The cost is narrow and quiet: it fails the COLUMN read of every table and leaves the rest of
the tree intact, so the object browser lists the tables and shows each as having no columns. No unit
test could catch it (a fake transport does not parse SQL), and the gate-4 live probe did.
`tests/unit/db/libsql/introspect.test.ts` now pins the statement text.

### 3.8 A batch is one round trip, and each statement keeps its own outcome

A libSQL server is normally across a network, and SQLite introspection is per-table: a row count, a
`pragma_table_info`, a `pragma_index_list` and a `pragma_foreign_key_list` for each. One request per
statement is four round trips per table. Hrana takes a LIST of requests, so `executeBatch` sends them
all at once — a whole schema read is three round trips regardless of table count, plus one for sizes.

Measured, and the reason the batch hands failures back individually rather than throwing:

```
requests: [SELECT 1 AS a] [SELECT * FROM nope] [SELECT 3 AS c]
results:  ok               error                ok
```

A failing statement does NOT abort the pipeline. Collapsing that onto one rejection is how a single
refused read costs a whole dashboard (#477, BACKLOG D22), so `LibSQLBatchOutcome` is a discriminated
per-statement result and the provider decides, per reading, what an absent one means.

### 3.9 `dbstat` answers here, so the sizes are real

`bun:sqlite` has no `dbstat` at all, which is why the SQLite provider's Storage tab is often empty.
Both libSQL deployments answer it, so table and index bytes here are MEASURED — 4096 bytes of table
and 4096 of index for a 3-row table, 53248 for a 2000-row one. When `dbstat` is absent the byte
fields are OMITTED rather than zeroed: 0 B reads as an empty table, which is a claim.

### 3.10 The version panel names what the deployment publishes

`GET /version` is a sqld route that Turso Cloud does not have (`{"error":"route not found:
[\"version\"]"}`). So `serverVersion()` answers `null` there rather than throwing, and the panel
reads:

- self-hosted: `sqld 0.24.33 (f8fb14f3 2026-08-11) (SQLite 3.47.0)`
- Turso Cloud: `SQLite 3.47.0`

Neither is "Unknown", because in both cases the engine answered something.

### 3.11 No sessions, no uptime, no connection ceiling

Hrana is stateless: a statement is a request. There is no session object anywhere, so
`getActiveSessions()` answers `[]` and `HealthInfo.activeSessions` is empty — a row for the request in
flight would be the provider describing itself. `maxConnections` is `0`, this codebase's encoding for
"no limit published" (the same as Trino, Druid and MSSQL), and `uptime` is `"N/A"` because no route
or catalog publishes one.

`getSlowQueries()` answers `[]` for a reason of the engine's: libSQL keeps no statistics about
finished statements. The empty state says exactly that instead of naming a PostgreSQL extension.

### 3.12 The dialect facts were re-measured, not inherited

The grammar registry maps `libsql` to the SAME `SQLITE_GRAMMAR` object, and every one of its four
facts was re-measured over Hrana rather than assumed:

| Fact | Measured on sqld 0.24.33 |
|---|---|
| `#` starts a comment | **No** — `SELECT 1 # x` is "bad variable name" |
| `[…]` quotes an identifier | **Yes** — `SELECT [id] FROM probe_customers` parses |
| Block comments nest | **No** — `/* outer /* inner */ SELECT 1` runs |
| `q'…'` is a literal | **No** — syntax error |
| `''` escapes a quote | **Yes** — `SELECT 'it''s'` answers `it's` |
| `hex(X'0102deadbeef')` | `0102DEADBEEF`; `typeof(X'')` is `blob`, `length(X'')` is 0 |

---

## 4. Connection

### 4.1 Configuration fields

| Field | Required | Meaning |
|---|---|---|
| `host` | yes (or a URL) | `libredb-probe.turso.io`, or the host running `sqld` |
| `port` | no | Defaults to `8080` plaintext, `443` under TLS |
| `password` | when the server requires one | The auth TOKEN, sent as `Authorization: Bearer` |
| `ssl` | no | Any mode other than `disable` selects HTTPS |
| `connectionString` | no | A `libsql://` URL, resolved into the fields above |

There is no `user` (libSQL has no user names) and no `database` (the database is the host), and the
connection form renders no input for either: it gates its Username and Database boxes on this same
list, so a box appears exactly where a value is written. It used to draw both regardless, and the save
discarded whatever was typed into them.

### 4.2 Connection strings

```
libsql://<database>-<org>.turso.io?authToken=<jwt>
```

That is the URL `turso db show --url` and the dashboard print. `libsql://` implies TLS and 443, and
there is no plaintext form of the scheme: a self-hosted server on plain HTTP is reached through the
host/port fields with TLS off, because `http://` already resolves to ClickHouse in
`src/lib/connection-string-parser.ts` and two engines cannot own one scheme.

### 4.3 Getting a token

```bash
turso db tokens create <database>              # full access
turso db tokens create <database> --read-only  # read-only, the engine-side answer to §3.6
```

A self-hosted `sqld` started without authentication takes no token at all, and sending an empty one
is a 400 rather than an anonymous connection — so a connection with no token sends no header.

---

## 5. Query interface

`query(sql, params)` sends one statement and returns `{ rows, fields, rowCount, executionTime,
columnTypes? }`.

- **Parameters are positional** (`?`), encoded per type: an integer as a decimal string, a
  non-integral number as a float, a boolean as SQLite's own 1/0, `Uint8Array` as base64, a `Date` as
  an ISO string. Passing none sends no `args` member at all.
- **`rowCount`** is the row count for a read and the engine's `affected_row_count` for a write.
- **`columnTypes`** carries SQLite's declared types verbatim (`INTEGER`, `TEXT`) and is OMITTED when
  the engine declared none — which it does for every computed column and every PRAGMA, so an absent
  map is the common case rather than a failure.
- **`executionTime`** is the engine's own measurement when it rounds to at least a millisecond, and
  the wall-clock one otherwise.

### EXPLAIN

`EXPLAIN QUERY PLAN` answers the four-column `id/parent/notused/detail` shape, read by the shared
`sqlite-queryplan` strategy. Measured against the probe fixture:

```
SEARCH probe_customers USING INDEX idx_customers_country (country=?)
```

---

## 6. Schema introspection

| Surface | Statement |
|---|---|
| Tables | `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'` |
| Row count | `SELECT COUNT(*) AS row_count FROM "<table>"` |
| Columns | `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('<table>')` |
| Indexes | `SELECT seq, name, "unique", origin FROM pragma_index_list('<table>')` |
| Index columns | `SELECT seqno, cid, name FROM pragma_index_info('<index>')` |
| Foreign keys | `SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list('<table>')` |
| Bytes | `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name` |

`sqlite_autoindex_*` entries are dropped: no user declared them and no user can drop them, so listing
them reports objects the schema does not contain.

Degradation is per reading, not per tree:

| What failed | What the user sees |
|---|---|
| The table list | The read fails — there is nothing to degrade to |
| One table's columns | That table listed with no columns; every other table intact |
| One table's row count | No count for it; the others keep theirs |
| `dbstat` | No sizes anywhere; every row count still real |

---

## 7. Monitoring & health

Measured through the provider against both deployments (fixture: 2 tables, 3 and 2000 rows, 1 index):

| Panel | Reading |
|---|---|
| Version | `sqld 0.24.33 (f8fb14f3 2026-08-11) (SQLite 3.47.0)` / `SQLite 3.47.0` on Turso Cloud |
| Database size | `64 KB` (65536 bytes), from `page_count × page_size` |
| Tables / indexes | 2 / 1 |
| Uptime | `N/A` — libSQL publishes none |
| Max connections | `0` — no limit published |
| Active connections | absent — Hrana is stateless |
| Cache hit ratio | `N/A` — SQLite's counters are behind the C API, and no statement reaches them |
| Health rows | `Integrity: OK`, `Journal Mode: wal` |
| Slow queries | Empty, permanently: libSQL keeps no statement statistics |
| Active sessions | Empty: no session exists to report |
| Deadlocks | `0`, and it is a fact rather than a gap — SQLite serializes writers behind one write lock and refuses a second with `SQLITE_BUSY` |
| Table stats | `probe_customers` 3 rows, 4096 B table + 4096 B index; `probe_orders` 2000 rows, 53248 B |
| Index stats | `idx_customers_country`, columns `[country]`, 4096 B, `scans: 0` (no per-index counter exists) |
| Storage | One entry, `main`, 65536 B. No WAL size: no statement reports it |

---

## 8. Maintenance

| Operation | Offered | Statement |
|---|---|---|
| `reindex` | per table and globally | `REINDEX` / `REINDEX "<table>"` |
| `check` | globally | `PRAGMA integrity_check`, and the ANSWER is read — a corrupt database reports damage in its row while the statement itself succeeds |
| `vacuum`, `analyze`, `optimize`, `kill` | withheld | Refused by the server (§3.5); a direct API call is refused by the provider with the reason |

---

## 9. Testing

```bash
# Just this provider
bun test tests/unit/db/libsql tests/integration/db/libsql-provider.test.ts

# The live server the tests were written against
docker compose -f database-compose.yml up -d libsql   # sqld on localhost:18080
```

`globalThis.fetch` is replaced per test and restored afterwards; `mock.module()` is refused, being
process-wide in bun. Every payload in the tests was captured from the two live deployments.

### Verifying against a live server

```bash
docker compose -f database-compose.yml up -d libsql
# then point a Studio connection at 127.0.0.1:18080 with TLS off and no token
```

For Turso Cloud, create a database and a token with the `turso` CLI and paste the
`libsql://…?authToken=…` URL into the connection dialog.

---

## 10. Known limitations

| Limitation | Cause | Owner |
|---|---|---|
| No transaction controls | The provider closes its Hrana stream with each statement, so it holds no session | Ours. Hrana's `baton` is exactly the feature that would carry one |
| No agent read-only profile | `PRAGMA query_only` is refused by the server | The engine's; a read-only Turso token is its answer |
| No Vacuum, Analyze or Optimize | Refused by the server's statement allowlist | The engine's |
| No slow queries, no sessions, no uptime, no cache ratio | libSQL publishes none of them | The engine's |
| No WAL size on the Storage tab | No statement reports it, and `PRAGMA wal_checkpoint` is refused | The engine's |
| Turso Database (the Rust engine) is not reachable | It publishes no server image and ships in-process | Revisit when a server image exists |

---

## 11. References

- Turso documentation — <https://docs.turso.tech/introduction>
- libSQL — <https://github.com/tursodatabase/libsql>
- Turso Database (the Rust engine) — <https://github.com/tursodatabase/turso>
- Hrana protocol specification — <https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md>
- [`docs/ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md) — the registration checklist this provider followed
- [`docs/providers/sqlite.md`](sqlite.md) — the same dialect against a file
