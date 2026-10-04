# MySQL Provider

> MySQL support for LibreDB Studio, built on the [`mysql2`](https://github.com/sidorares/node-mysql2) driver.
> This document is the single reference point for the MySQL provider: design, architecture, usage,
> and tests. MySQL is a SQL-family provider; it shares `SQLBaseProvider` with PostgreSQL — read the
> [PostgreSQL doc](./postgres.md) first if you want the canonical SQL walkthrough, then this doc for
> the MySQL-specific deltas.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `mysql` |
| **Family** | SQL (relational) |
| **Driver** | `mysql2/promise` |
| **Query language** | `sql` |
| **Default port** | `3306` |
| **Connection pooling** | Yes — `mysql2` pool (`connectionLimit` = pool `max`, default 10) |
| **Connection string** | Supported (`mysql://`, via the pool `uri` option) |
| **Transactions** | Yes — explicit begin/commit/rollback with auto-rollback timeout |
| **Query cancellation** | Yes — thread-id tracking + `KILL QUERY` |
| **Source** | [`src/lib/db/providers/sql/mysql.ts`](../../src/lib/db/providers/sql/mysql.ts) |
| **Base** | [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) |
| **Tests** | [`tests/integration/db/mysql-provider.test.ts`](../../tests/integration/db/mysql-provider.test.ts) |

---

## 1. Overview

MySQL is a relational database and maps onto the `DatabaseProvider` interface much like PostgreSQL.
It extends the shared `SQLBaseProvider` (identifier quoting with backticks, automatic `LIMIT`
injection, cloud SSL auto-detection) and layers MySQL-specific introspection and
monitoring on top of `mysql2`.

The most useful way to read this doc is **as a diff against the [PostgreSQL provider](./postgres.md)**,
which is the SQL reference implementation. The headline differences:

| Aspect | PostgreSQL | MySQL |
|--------|------------|-------|
| Schema introspection | One set of shared `MATERIALIZED` CTEs behind the object surface | `information_schema` behind the object surface; the bulk column read is four statements per folder ([§7.1](#71-the-object-surface-789)) |
| Schema scope | All non-system schemas, cross-schema FKs | **Single database** (`TABLE_SCHEMA = <db>`), bare table names, lifted by the object surface ([§7.1](#71-the-object-surface-789)) |
| Maintenance ops | `vacuum`, `analyze`, `reindex`, `kill` | `analyze`, `optimize`, `check`, `kill` |
| Query timeout | `statement_timeout` from `queryTimeout` | **Not wired** — no server-side query timeout |
| Pool config honored | `min`/`max`/`idleTimeout`/`acquireTimeout` | **`max` only** (`connectionLimit`) |
| Queries-per-second metric | `undefined` (needs sampling) | Reported (`Queries`/`Uptime`) |
| BLOB/binary values | driver-native | driver-native ([§3.3](#33-blob--binary-values-reach-every-surface-as-bytes)) |

### 1.1 MariaDB and the other MySQL-protocol engines

This provider is what a MariaDB connection uses: there is no `mariadb` type id, and choosing MySQL in
the connection dialog is the documented way to reach it. `mysql2` speaks the protocol both servers
share, and the connection dialog's `WireCompatibilityHint` names the engines this driver has been
measured against. The full per-engine table is in [`README.md`](./README.md#wire-compatible-engines);
two behaviours belong here because they are this provider's code, not the engine's.

**The overview does not rename the server.** `VERSION()` is the only thing that says which engine
answered. MySQL returns a bare number (`8.0.35`), so `labelServerVersion()` supplies the vendor;
MariaDB, TiDB, Vitess and OceanBase return a build string that already names themselves
(`12.3.2-MariaDB-ubu2404`), and that string is passed through unchanged. Prefixing it would assert a
vendor the server never claimed. StarRocks and SingleStore are deliberately not in that list: both
answer with a plain MySQL number and give nothing to key on. Apache Doris is the same on `VERSION()`
(a fixed `5.7.99`), but it does put its real build in `@@version_comment`
(`doris version doris-4.1.3-rc02-7126cf65d96`), which the same query now reads alongside `VERSION()`,
so `labelServerVersion()` shows `Apache Doris 4.1.3-rc02-7126cf65d96` there instead of the fictitious
number.

**`performance_schema` is OFF by default on MariaDB.** Measured on `mariadb:12.3`
(`@@performance_schema` = 0, build `12.3.2-MariaDB-ubu2404`): the `performance_schema` tables exist,
so the metric queries do not fail — they return a row of NULLs. Cache-hit ratio, queries/sec and
buffer-pool usage are therefore absent rather than zero. The digest table behaves the same way: it is
selectable and answers **0 rows**, so the slow-query list is empty rather than an error — re-measured
2026-08-27, and true of the health line only since the fix below, which is what made the OFF state
distinguishable from a broken read at all. `information_schema`, `PROCESSLIST`, `EXPLAIN
FORMAT=JSON`, schema introspection, sizes and row counts are unaffected. Start the server with
`performance_schema=ON` to get the monitoring figures.

**MariaDB declares two object kinds MySQL does not have.** `package` and `sequence` are declared by
`objectKinds`, which on this provider is resolved from the `VERSION()` string rather than being a
constant, see [§7.1](#71-the-object-surface-789). That is the third of the three behaviours on this
page that are this provider's code and not the engine's.

Those two folders are **not drawn in the standalone tree today**, and this sentence used to say they
reach the object browser, which was wrong. `POST /api/db/provider-meta` reads capabilities off a
provider it never connects (#457), so the client's copy of the declaration is the MySQL six and the
version-resolved pair never arrives. The declaration itself is correct about the engine and is
therefore kept, source read included (#789): a connected provider answers both kinds, and the API
route reaches them. The gap is the client's copy of the declaration, it is filed in
[`docs/BACKLOG.md`](../BACKLOG.md), and it is a Phase 1 seam rather than anything about definition
text.

The one metric that goes the other way is `deadlocks`: it comes from the `Innodb_deadlocks` row of
`SHOW STATUS`, which MariaDB publishes and MySQL does not, so it is the single performance figure a
default MariaDB reports and a MySQL server does not.

---

---

## 2. Architecture

Same Strategy-Pattern hierarchy as the other SQL providers:

```
DatabaseProvider (interface) → BaseDatabaseProvider → SQLBaseProvider → MySQLProvider
```

`MySQLProvider` inherits the shared SQL helpers from
[`sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) — see the
[PostgreSQL doc §2.2](./postgres.md#22-what-sqlbaseprovider-provides) for the full table. The two
that matter most here:

- **`escapeIdentifier()`** quotes MySQL identifiers with **backticks** (`` `ident` ``), doubling any
  embedded backtick.
- **`prepareQuery()`** injects `LIMIT` into bare `SELECT`s; the underlying `analyzeQuery()` also
  understands MySQL's `LIMIT offset, count` syntax (see [§5.2](#52-automatic-limit-injection)).

### Registration

Loaded on demand by `createDatabaseProvider()` ([`factory.ts`](../../src/lib/db/factory.ts)):

```ts
case 'mysql': {
  const { MySQLProvider } = await import('./providers/sql/mysql');
  return new MySQLProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 No MATERIALIZED CTEs

Unlike PostgreSQL, this provider composes no `MATERIALIZED` CTEs: MySQL has no such hint, and
`information_schema` is a set of views over the data dictionary rather than the materialised copies it
was through 5.7. The object surface's bulk column read is four statements per folder
([§7.1](#71-the-object-surface-789)) whatever the folder holds.

### 3.2 Single-database scope, and how the object surface lifts it

The deleted flat reading parameterized every query with `TABLE_SCHEMA = ?` bound to `config.database`. MySQL
"schemas" *are* databases, so that surface only ever sees the connected database, and table display
names are bare (no `schema.table` prefixing). There is no cross-schema FK resolution to worry about.

This is a property of the FLAT surface and not of the engine: MySQL resolves a qualified name across
databases on one connection, so the object surface's `listContainers()` is bound to nothing and every
database the server holds is browsable from one session ([§7.1](#71-the-object-surface-789)). Both
surfaces are live through Phase 1 of #789.

### 3.3 BLOB / binary values reach every surface AS BYTES

**The spelling changed on 2026-08-24.** A `BLOB`/`BINARY` value used to reach the grid as the text
`0x0102ab`; it now reads `\x0102ab` on every surface (the cell, the row detail sheet, the CSV and,
since #1381, the JSON export), and that is the whole point of the change: one value must not be
spelled two ways depending on which engine it came from.

`sanitizeRow()` walked every result row and turned each `Buffer` into a `0x<hex>` string (an empty
one into `''`). Its reason was real when it was written — the JSON a `Buffer` serializes to,
`{"type":"Buffer","data":[…]}`, is unreadable — and it expired when `src/lib/export/binary.ts`
(#469) started reading that exact shape. From then on the string was the only thing standing between
a MySQL BLOB and the treatment a Postgres `bytea` already got: the binary cell renderer, the detail
sheet, the CSV, and the per-dialect binary literal the SQL export writes. So the driver's rows are
now handed on unchanged, `Buffer` values included, on both `query()` and `queryInTransaction()`.

Measured on MySQL 26.7.0 (2026-08-24), replaying this export's own `INSERT` for the three bytes
`0102AB` in `r5.types.b` back into a `BLOB` column and reading `HEX()`:

| | grid / CSV | exported INSERT | replayed, `HEX(b)` / `LENGTH(b)` |
|---|---|---|---|
| before | `0x0102ab` | `VALUES (1, '0x0102ab')` | `3078303130326162` / 8 — the ASCII of `0x0102ab` |
| after | `\x0102ab` | `VALUES (1, X'0102ab')` | `0102AB` / 3 |

The before row is the defect: it stored eight characters of text where three bytes belonged, and it
stored them *successfully*. An empty `BLOB` reads `\x` rather than the empty string it used to
report — an empty byte string and a zero-length `VARCHAR` are different values and were spelled the
same — and it exports as `X''`, which replays to `LENGTH(b)` 0. A `NULL` stays `NULL` and exports as
`NULL`.

One consequence worth stating: the JSON response now carries about four characters per byte instead
of two, exactly as Postgres's does, so a very large single cell is no cheaper here than it is there.

### 3.4 Which wire protocol a statement takes

mysql2 speaks two protocols and this provider uses both. Every statement it issues goes through one
module-local helper, `runStatement(queryable, sql, params?)`
([mysql.ts](../../src/lib/db/providers/sql/mysql.ts)), which picks by a single fact:

| Statement | Method | Protocol |
|-----------|--------|----------|
| carries parameters | `conn.execute(sql, params)` | binary, server-side prepared |
| carries none (or an empty array) | `conn.query(sql)` | text |

Parameterised statements are unchanged: the placeholders are what the prepared protocol is for, and
binding is what keeps a value out of the SQL text. So every `information_schema` read that names the
database stays prepared, while `SHOW STATUS`, `SHOW VARIABLES`, `SELECT VERSION()`,
`SHOW BINARY LOGS`, the maintenance statement, `KILL`, and a parameterless statement from the editor —
`EXPLAIN FORMAT=JSON …` among them — go over the text protocol.

**Why.** Everything used to call `execute`, parameterless statements included, and three engines
refuse whole statement classes on the prepared protocol with `This command is not supported in the
prepared statement protocol yet`. Measured 2026-08-20 against a live SingleStore 9.1.1
(`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`), both ways over one connection:

| Statement | `conn.execute` | `conn.query` |
|---|---|---|
| `SHOW STATUS LIKE 'Uptime'` | `ER_UNSUPPORTED_PS` | succeeds |
| `SHOW VARIABLES LIKE 'max_connections'` | `ER_UNSUPPORTED_PS` | succeeds |
| `EXPLAIN <select>` | `ER_UNSUPPORTED_PS` | succeeds |
| `EXPLAIN JSON <select>` | `ER_UNSUPPORTED_PS` | succeeds |
| `EXPLAIN FORMAT=JSON <select>` | `ER_PARSE_ERROR` | `ER_PARSE_ERROR` |
| `OPTIMIZE TABLE customers` | `ER_UNSUPPORTED_PS` | succeeds |
| `CHECK TABLE customers` | `ER_UNSUPPORTED_PS` | succeeds |
| `ANALYZE TABLE customers` | succeeds | succeeds |
| `SELECT VERSION()` | succeeds | succeeds |

That cost SingleStore its Test Connection, health, overview, monitoring dashboard and two of its three
maintenance actions; the registered StarRocks 3.3 row in [README.md](./README.md) records the same
failure for its overview. It is not only those two: **MySQL 26.7.0 itself refuses `CHECK TABLE` on the
prepared protocol** — measured 2026-08-24 on `mysql:latest`, `ER_UNSUPPORTED_PS` on `execute` and OK on
`query`, while the other statements above worked either way. So one of this provider's own three
maintenance actions was unavailable on the engine it is named for.

**The Explain panel was NOT one of the recovered surfaces, and the row above is why.** `EXPLAIN
FORMAT=JSON` is a parse error on SingleStore on BOTH protocols — re-measured 2026-08-24 on the same
image — because SingleStore's grammar is `EXPLAIN JSON <select>`. The protocol was never what stopped
it there. (An earlier note recorded `EXPLAIN FORMAT=JSON` as succeeding on the text protocol; the
statement that succeeds is plain `EXPLAIN`.) Reaching a plan on that engine needs a different
STATEMENT, not a different protocol, and that is what
[§5.5](#55-the-explain-grammar-is-measured-at-connect) now sends: the provider measures which EXPLAIN
grammar the server accepts when it connects, and an engine that refuses `EXPLAIN FORMAT=JSON` gets the
plain `EXPLAIN` of [`mysql-text.ts`](../../src/lib/explain/mysql-text.ts) instead of a failing panel.
The probe statement carries no parameters, so it takes the text protocol like every other statement of
that shape.

**The read path is safe to move because the two protocols decode to the same JS shapes.** mysql2
decodes text and binary rows on different code paths, so this was measured rather than assumed:
2026-08-24 on MySQL 26.7.0, the same `SELECT *` over one connection both ways, across a probe table
covering `TINYINT(1)`, `INT`, `BIGINT` past 2^53, `BIGINT UNSIGNED`, `DECIMAL(20,4)`, `FLOAT`,
`DOUBLE`, `DATE`, `DATETIME`, `TIMESTAMP`, `TIME`, `YEAR`, `CHAR`, `VARCHAR`, `TEXT`, `BLOB`,
`BIT(1)`, `BIT(8)`, `JSON`, `ENUM`, `SET` and NULLs:

- every value identical by `typeof` and by `JSON.stringify` — including the `Buffer` for `BLOB` and
  both `BIT` widths ([§3.3](#33-blob--binary-values-reach-every-surface-as-bytes)), the `Date` for the
  three temporal types, the string for `DECIMAL` and `TIME`, the parsed object for `JSON`, and the
  same `"9007199254740993"` for a `BIGINT` written as `9007199254740993` — a STRING on both
  protocols, because the pool asks mysql2 not to round it ([§3.7](#37-a-bigint-past-253-arrives-as-a-string));
- every `FieldPacket` identical in `columnType`, `flags`, `characterSet`, `columnLength` and
  `decimals`, so `columnTypes` ([§5.4](#54-declared-column-types)) names the same types either way;
- a statement with no result set answers the same `ResultSetHeader` object, which is what the envelope
  below reads.

**Measured after the change, through this provider.** 2026-08-24, `MySQLProvider` driven directly
against three live servers:

| Surface | MySQL 26.7.0 | SingleStore 9.1.1 | StarRocks 3.3 |
|---|---|---|---|
| `getHealth` (Test Connection, header badge) | ok | **recovered** | still fails — `Unknown table 'information_schema.PROCESSLIST'`, the engine's own gap, not the protocol |
| `getOverview` | ok | **recovered** (reads MySQL 5.7.32, the wire version) | **recovered** (reads MySQL 5.1.0, the fictitious `version()`) |
| `getPerformanceMetrics` | ok | answers `{}` — nothing measured rather than a fabricated number | answers `{}` |
| `getStorageStats` | ok | **recovered** | **recovered** |
| object reads, table/index stats, editor query, transactions | ok | ok | ok |
| maintenance `analyze` / `optimize` / `check` | all three ok (`check` **recovered**) | all three ok (`optimize`, `check` **recovered**) | n/a |
| Explain | ok, `EXPLAIN FORMAT=JSON` (the connect probe measures `mysql-json`) | **Explain tab renders the text plan, browser, 2026-09-06**: the probe measures `mysql-text`, the panel sends plain `EXPLAIN`, and one row came back for a constant `SELECT` ([§5.5](#55-the-explain-grammar-is-measured-at-connect)) | **Explain tab renders the text plan, browser, 2026-09-06**: the same probe and statement, 14 rows drawn as a 13-node tree |

One behaviour does differ, and only for a connection that opted into `multipleStatements=true` in its
connection string: a `;`-separated statement is rejected by the prepared protocol and accepted by the
text one, which then answers an array of result sets. That is the shape `CALL <procedure>()` already
answers today on both protocols, so nothing new reaches the envelope; the app splits multi-statement
input itself (`POST /api/db/multi-query`) and issues one statement per call.

`rowCount` is `rows.length` **only when the driver returns a row array** (i.e. `SELECT`); for a
non-`SELECT` statement mysql2 returns a `ResultSetHeader` rather than an array, and the provider
reports its `affectedRows` — see [§5.1](#51-execution) for the full envelope.

This section used to say affected-rows was not surfaced and `rowCount` was reported as 0. That
described the intent of one line; the line beside it called `.map` on the same header and threw, so
what the user actually got for every DDL and DML statement was an error for work the server had
already done.

### 3.5 No server-side query timeout

The pool config, built by `buildPoolConfig()` ([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)), intentionally sets only
mysql2-specific options and **does not** translate `ProviderOptions.queryTimeout` into a server-side
timeout (MySQL has no direct `statement_timeout` pool option like Postgres). A runaway query is not
auto-killed by the provider; cancellation is explicit via [`cancelQuery()`](#53-query-cancellation).

### 3.6 Maintenance over all tables when no target

`analyze`/`optimize`/`check` without a target run against **all base tables** in the database
(`getAllTablesForMaintenance()`, capped at **50** tables, [`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)),
each name quoted via `escapeIdentifier()`. With a target, the single quoted table is used.

### 3.7 A `BIGINT` past 2^53 arrives as a string

The pool asks mysql2 for **`supportBigNumbers: true`** (`buildPoolConfig()`,
[`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)). Without it the driver hands every integer back
as a JavaScript `number`, and a `number` cannot hold a 64-bit id: **two rows whose ids differ only in
the last digit reach the browser as the same number**. The grid's inline editor then asks its key
guard about the number it was shown, is told one row matches, `UPDATE`s the NEIGHBOURING row and
reports success.

Measured 2026-09-18 against a live MySQL 8.4.11 through `mysql2` 3.24.4 — the same `SELECT` over one
server with the option off and on, printed with `typeof` beside each value:

| Column / expression | Stored | Option off | Option on |
|---|---|---|---|
| `BIGINT` | `9007199254740992` | `9007199254740992` (number) | `"9007199254740992"` |
| `BIGINT` | `9007199254740993` | `9007199254740992` (number) — **the row beside it** | `"9007199254740993"` |
| `BIGINT UNSIGNED` | `18446744073709551615` | `18446744073709552000` (number) | `"18446744073709551615"` |
| `BIGINT` | `42` | `42` (number) | `42` (number) |
| `BIGINT AUTO_INCREMENT` | `1` | `1` (number) | `1` (number) |
| `INT` | `7` | `7` (number) | `7` (number) |
| `DECIMAL(20,4)` | `19.99` | `"19.9900"` | `"19.9900"` |
| `COUNT(*)` | — | `3` (number) | `3` (number) |
| `SUM(<INT column>)` | — | `"24"` | `"24"` |
| `CAST(9007199254740991 AS SIGNED)` | — | `9007199254740991` (number) | `9007199254740991` (number) |

**Only what a `number` cannot hold changes type.** mysql2's threshold sits ABOVE
`Number.MAX_SAFE_INTEGER`, so 2^53 - 1 is still a number and **2^53 exactly is already a string** even
though that value survives a `number` intact — the boundary is the widest exact integer, not the
widest correct one. Everything narrower is untouched, which is what the lower half of the table is
for: a small `INT`, a `BIGINT` holding a small value, an `AUTO_INCREMENT` id and `COUNT(*)` are all
still numbers. `DECIMAL` and `SUM` over an `INT` column were strings before the change and are strings
after it — MySQL answers `SUM` as `DECIMAL`, and mysql2 has always spelled `DECIMAL` as a string to
keep its precision ([§5.4](#54-declared-column-types)).

**One shape was not merely rounded, it was impossible.** `BIGINT UNSIGNED` at the top of its range
read back as `18446744073709552000`, which is larger than the column's own maximum — no row could
hold it, so it could never match one either.

**`bigNumberStrings` is deliberately NOT set.** It is mysql2's other big-number flag, and it turns
EVERY integer into a string — `SELECT 5` becomes `"5"`, `COUNT(*)` becomes `"3"` — changing types that
were never wrong.

**The option is the FIRST entry in `baseConfig`, which is what makes it cover both connection forms.**
The connection-string branch returns `{ ...baseConfig, timezone, uri }` and takes the discrete-fields branch not
at all ([§4.2](#42-connection-pooling)), so an option added beside the SSL config would
apply to a host/port connection and silently not to a pasted URI.

**Both wire protocols answer the same shape.** Re-measured in the same pass with the option on: the
text protocol (`conn.query`) and the prepared protocol (`conn.execute`) each return
`"9007199254740993"` and `"18446744073709551614"` for the same row, so
[§3.4](#34-which-wire-protocol-a-statement-takes)'s equivalence holds unchanged.

The declared type is unaffected — `columnTypes` still names the column `bigint`
([§5.4](#54-declared-column-types)) — so the SQL-DDL export writes `BIGINT` for a column whose values
now arrive as strings, rather than the `TEXT` a value-shaped guess would produce.

### 3.8 On a server that sends UTF-8 under a utf8mb3 label, utf8mb3 columns are read as UTF-8

mysql2 picks a column's decoder from the collation id in its metadata and ships the whole utf8mb3
family (33 `utf8mb3_general_ci`, 76 `utf8mb3_tolower_ci`, 83 `utf8mb3_bin`, 192-215, 223 and
MariaDB's utf8mb3 ids) as **`cesu8`**. Databend, StarRocks and Apache Doris label **every** text
column 33 whatever the session asked for, while the bytes they send are plain UTF-8. CESU-8 has no
4-byte form, so every character outside the BMP came back as four U+FFFD, in the grid, the row
detail, `/api/db/query` and every export. Two-byte and three-byte characters (Turkish letters, CJK)
were unaffected, which is what hid it.

Measured 2026-10-04 on Databend 1.2.881, StarRocks 4.1.6 and Doris 4.1.3: `hex()` of a stored value
holds `f09f9880` for U+1F600, so the wire is right and the decoder is not. Asking for utf8mb4 does not
help: mysql2 already asks for `UTF8MB4_UNICODE_CI` (224), and `UTF8MB4_GENERAL_CI`,
`UTF8MB4_0900_AI_CI` or a `SET NAMES utf8mb4` left the column at 33 on all three.

**Measured at connect, not keyed on the type id.** `probeUtf8UnderUtf8mb3()`
([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)) sends `SELECT '<U+1F600>' AS probe` and flags
the server when the column comes back labelled utf8mb3 and the value decodes to U+FFFD, that is when
the server sent 4-byte UTF-8 under a utf8mb3 label. MySQL 26.7.0, MariaDB 13.0.2 and TiDB v7.5.1
answer the probe with a utf8mb4 label and the character itself, so they are not flagged and decode
exactly as mysql2 decides. A refused probe is a "no".

**Scoped to the statement, not the process.** For a flagged pool, every acquired connection is marked,
and `runStatement` sends its statements through mysql2's callback API, where the command object is
visible. The command emits `fields` once the column definitions are read and before the row parser is
built, and both the text and the binary parser read `field.encoding` when a row arrives, so
`readUtf8mb3AsUtf8()` relabels that statement's `cesu8` columns to `utf8` and the values decode right.
mysql2's shared `CharsetToEncoding` table is never written, so another provider's pool, or a host
application's own mysql2 when this runs as the npm package, keeps its decoding. A `typeCast` could not
do this: mysql2 3.24 hands it the type and column name but not the collation, so it cannot tell a
utf8mb3 `VARCHAR` from a latin1 one or from a `VARBINARY`.

Only `cesu8` columns move: latin1, binary (63) and utf8mb4 columns keep their decoder, so `BLOB`,
`VARBINARY` and `BINARY` still arrive as bytes ([§3.3](#33-blob--binary-values-reach-every-surface-as-bytes)).
A statement that answers an OK packet (`INSERT`, `UPDATE`, `DELETE`, DDL, `SET`, `COMMIT`) makes
mysql2 emit `fields` with nothing, and the listener lets it through: a throw inside it would be fatal
to the connection after the server had already run the statement. An error is the driver's own error
object with the same message, `code`, `errno` and `sqlState` the promise path rejects with; only its
stack differs, because the promise wrapper rewrites the stack to its caller's.

> **A column NAME outside the BMP still reads as U+FFFD on these servers.** mysql2 decodes the name
> while it parses the definition, before `fields` fires, so `SELECT 1 AS "<U+1F600>"` comes back with
> a four-U+FFFD key. Values are repaired; aliases are not.

---

## 4. Connection

### 4.1 Configuration

Two forms (`validate()`, [`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)). `validate()`
requires `host` **and** `database` only when no `connectionString` is given — it does not reject
supplying both; if both are present the connection string is used (passed to the pool as `uri`).

```ts
// Discrete fields (host + database required when no connection string)
const a = { id: 'my-1', name: 'App DB', type: 'mysql',
  host: 'localhost', port: 3306, database: 'app',
  user: 'root', password: 'secret', createdAt: new Date() };

// Connection string
const b = { id: 'my-1', name: 'App DB', type: 'mysql',
  connectionString: 'mysql://root:secret@localhost:3306/app', createdAt: new Date() };
```

### 4.2 Connection pooling

`connect()` builds a `mysql2` pool and validates it by acquiring/releasing one connection. The pool
options set by `buildPoolConfig()` ([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)):

| mysql2 option | Value | Source |
|---------------|-------|--------|
| `supportBigNumbers` | `true` | fixed — the first entry, so it survives the `connectionString` branch ([§3.7](#37-a-bigint-past-253-arrives-as-a-string)) |
| `connectionLimit` | pool `max` (default 10) | `ProviderOptions.pool.max` |
| `waitForConnections` | `true` | fixed |
| `queueLimit` | `0` (unbounded queue) | fixed |
| `enableKeepAlive` | `true` | fixed |
| `keepAliveInitialDelay` | `10000` ms | fixed |
| `timezone` | `'Z'` | `ProviderOptions.timezone ?? 'Z'`, both forms; a connection string's own `?timezone=` wins (see below) |

> ⚠️ Only `max` from `DEFAULT_POOL_CONFIG` is honored. `min`, `idleTimeout`, and `acquireTimeout`
> are **not** mapped (the mysql2 pool model differs from `pg`), and `queryTimeout` is **not** applied
> (see [§3.5](#35-no-server-side-query-timeout)).
>
> ⚠️ When a **`connectionString`** is supplied, `buildPoolConfig()` returns `{ ...baseConfig, timezone, uri }`
> and takes the discrete-fields branch **not at all**, so `ssl`/`connection.ssl` and
> cloud SSL auto-detect are **ignored**; those settings must be encoded in the URI itself.
>
> `timezone` is the exception, and applies to the connection string too.
> mysql2 lets an option beat the same key in the `uri` (its `ConnectionConfig` skips every uri key the options already set), so the default is left out when the string carries its own `?timezone=`, and that value wins.
> Without a zone mysql2 reads `DATE` and `DATETIME` in the Node process's local zone.
> Measured 2026-09-27 on `mysql:8.4` under `TZ=Europe/Istanbul`, before the fix: the structured form read `DATE '2026-09-01'` as `2026-09-01T00:00:00.000Z` and a pasted connection string read it as `2026-08-31T21:00:00.000Z`, the previous day, with `TIMESTAMP '2026-09-01 10:30:00'` at `07:30`.
> After it, both forms answer `2026-09-01T00:00:00.000Z` and `2026-09-01T10:30:00.000Z`, and a string with `?timezone=%2B03:00` read under `TZ=UTC` answers `2026-08-31T21:00:00.000Z`, the zone it asked for.

`connect()` is idempotent. Unlike the PostgreSQL provider, MySQL exposes **no** `getPoolStats()`.

### 4.3 SSL

`buildSSLConfig()` ([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)) — applied **only in the
discrete-fields form** (the `connectionString` path bypasses it entirely). Note `disable` returns
`undefined` (mysql2's "off"), not `false`:

1. **Explicit `connection.ssl`** (`SSLConfig`): `disable` → `undefined`; `require` →
   `rejectUnauthorized: false` (the one mode that encrypts without verifying);
   `verify-system`/`verify-ca`/`verify-full` → `rejectUnauthorized: true`;
   `caCert`/`clientCert`/`clientKey` → `ca`/`cert`/`key`. `verify-system` passes **no** `ca`, so
   mysql2 hands `tls.connect` Node's own trust store — that mode exists precisely so a managed
   endpoint can be verified with no PEM to paste. mysql2 exposes no separate host-name check, so
   `verify-ca` and `verify-full` build the same object.
2. **`options.ssl === true` or cloud auto-detect** — `shouldEnableSSL()` (`options.ssl === true` *or*
   a known managed host) enables `{ rejectUnauthorized: false }`.
3. Otherwise `undefined`.

#### `ssl-mode` in a pasted URL

The paste box ([`connection-string-parser.ts`](../../src/lib/connection-string-parser.ts)) reads the
query string, so `mysql://host/db?ssl-mode=REQUIRED` arrives with SSL Mode already set. The values are
matched case-insensitively (MySQL writes them upper-case) and `sslmode` is accepted as an alias:
`DISABLED` → `disable`, `REQUIRED` → `require`, `VERIFY_CA` → `verify-ca`, `VERIFY_IDENTITY` →
`verify-full` (it checks the hostname as well as the chain).

The boolean spellings are read too, and mapped at both ends because a boolean has no opportunistic
value: `?ssl=true`, `?ssl=1`, `?useSSL=true` → **`verify-system`**; `?ssl=false`, `?ssl=0`,
`?useSSL=false` → `disable`. An explicit `ssl-mode` wins when a string carries both.

The rule (D26, stated in `readBooleanTLS`) is that a boolean maps onto the mode matching what the
engine's own driver does with it, never onto a weaker one — and the driver this provider uses is
mysql2, which defaults `rejectUnauthorized` to `true` for any `ssl` object it is handed
(`node_modules/mysql2/lib/connection_config.js:171`). `verify-system` is that behaviour exactly:
verified, with no CA certificate to find. The mapping was `require` until `verify-system` existed —
`rejectUnauthorized: false` ([mysql.ts](../../src/lib/db/providers/sql/mysql.ts)), encrypted with the
chain unchecked — because the only verifying modes on the form were the two that demand a PEM.

One spelling is now mapped **stronger** than its writer meant: Connector/J's `useSSL=true` leaves
`verifyServerCertificate` off unless `sslMode` is `VERIFY_CA`/`VERIFY_IDENTITY`. That direction is the
deliberate one — a connection refused for an unverifiable certificate says so on screen, while a
silent downgrade to unverified TLS says nothing at all, and the SSL / TLS panel is one click away for
a server presenting a self-signed certificate. mysql2's
object form (`?ssl={"rejectUnauthorized":true}`) is not a boolean and is reported in the banner rather
than guessed at.

`PREFERRED` is **not** mapped, and neither is any spelling the map does not know. It means "encrypt if
the server offers it", and mapping it onto `disable` would downgrade a connection that was in fact
encrypted: measured over TCP against MySQL with its default self-signed certificate,
`--ssl-mode=PREFERRED` negotiated `TLS_AES_128_GCM_SHA256` while `--ssl-mode=DISABLED` left
`Ssl_cipher` empty. Mapping it onto `require` is the mirror-image guess. So the mode the form already
holds is left alone and the paste banner names the parameter it declined to act on; choose SSL Mode
yourself in the SSL / TLS panel.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)) acquires a
pooled connection, optionally records its `threadId` for cancellation, runs the statement over the
protocol its parameters imply ([§3.4](#34-which-wire-protocol-a-statement-takes)), and returns the
standard envelope with the driver's own values
([§3.3](#33-blob--binary-values-reach-every-surface-as-bytes)):

```ts
{ rows, fields: string[], rowCount: rows.length, executionTime, columnTypes? }
```

Native `mysql2` errors are normalised via `mapDatabaseError()` into the shared
[`errors.ts`](../../src/lib/db/errors.ts) classes.

**A statement that returns no result set** — every DDL statement, and `INSERT`/`UPDATE`/`DELETE` —
answers a different envelope, because `mysql2` hands back a different thing. The driver's first return
value is an array of rows only when the statement produced a result set; otherwise it is a
`ResultSetHeader` OBJECT and the field packets arrive as `undefined` — the same both ways, measured on
either protocol ([§3.4](#34-which-wire-protocol-a-statement-takes)). Printed verbatim out of mysql2
against mysql 26.7.0 for `INSERT INTO r5_hdr (note) VALUES ('a'),('b')`:

```js
{ fieldCount: 0, affectedRows: 2, insertId: 1,
  info: "Records: 2  Duplicates: 0  Warnings: 0",
  serverStatus: 2, warningStatus: 0, changedRows: 0 }
```

So the answer is no rows, no fields, no `columnTypes`, and the affected-row count in `rowCount`:

```ts
{ rows: [], fields: [], rowCount: header.affectedRows, executionTime }
```

That matches what the other SQL providers here already report for the same statements — SQL Server
uses `rowsAffected[0]`, SQLite `changes`, PostgreSQL `pg`'s own `rowCount` — and `rowCount` is the
number the results footer renders. `insertId`, `changedRows` and `warningStatus` are dropped:
`QueryResult` models none of them. `affectedRows` is the **matched** count, so a no-op
`UPDATE … SET note = note` reports 1 while `changedRows` is 0 — the same way SQL Server's
`rowsAffected` counts.

Until this was fixed, both this path and `queryInTransaction()` called `.map` on that header and threw
`result.rows.map is not a function` — **after** the server had already applied the statement. Measured
through `createDatabaseProvider({type:"mysql"})` on 2026-08-23: `DROP TABLE`, `CREATE TABLE`, `INSERT`,
`UPDATE` and `DELETE` each failed, and a following `SELECT` returned the row the failed `INSERT` had
written. Reporting a failure for work that landed is the answer that makes a user retry and
double-apply it.

### 5.2 Automatic `LIMIT` injection

Inherited from `SQLBaseProvider.prepareQuery()` (see [PostgreSQL doc §5.2](./postgres.md#52-automatic-limit-injection)).
The shared `analyzeQuery()` recognises both standard `LIMIT n [OFFSET m]` and MySQL's
`LIMIT offset, count` form, so an already-limited MySQL query is respected rather than double-limited.
Default page size `DEFAULT_QUERY_LIMIT = 500`; unlimited caps at `MAX_UNLIMITED_ROWS = 100000`.

MySQL's `#` line comment is skipped when the statement type is read, alongside `--` and `/* … */`
([`leading-keyword.ts`](../../src/lib/sql/leading-keyword.ts)). This is the dialect that marker exists
for: a `# note`-led `SELECT` used to classify as an unknown statement type and reach the server with
no `LIMIT` at all (#275).

Every `#` is a comment marker here, and this provider now says so: `prepareQuery()` passes its own
`type` to the shared readers, which resolve `#` under MySQL's grammar instead of the dialect-less
compromise they used to apply to everyone (see
[Which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading)).
Three readings change on this provider, and each was wrong in a way only MySQL sees:

| Statement | Before | Now |
|-----------|--------|-----|
| `SELECT … # note` | not bounded at all — the bound has to go before the comment, and the reader could not rule out `#tmp`/`ID#`/XOR | bounded, with the clause before the comment |
| `SELECT * FROM t # LIMIT 10` | the commented-out bound read as a real one, so the statement ran unbounded | the comment is a comment; a real bound is added before it |
| `WITH t AS (` + `#- drop the ) SELECT here` + `…) DELETE FROM users` | the `#-` read as a PostgreSQL jsonb operator, so the `)` inside the comment closed the CTE body, the statement typed `SELECT` and a `LIMIT` was appended to a `DELETE` — which MySQL 8 accepts and commits | typed `DELETE`, not bounded |

The third row is the one that cost more than rows: a bound on a `DELETE` commits part of it while the
UI reports a truncated result set. A trailing `-- note` was always bounded normally and is unchanged.

### 5.3 Query cancellation

A query issued with a `queryId` records its connection `threadId`. `cancelQuery(queryId)`
([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)) issues `KILL QUERY <threadId>` and returns
`true` on success (it does not verify the target was actually mid-query). The killed query surfaces
to its caller as a `QueryCancelledError` (MySQL emits *"Query execution was interrupted"*, which
`mapDatabaseError()` classifies as cancellation). Exposed via `POST /api/db/cancel`.

### 5.4 Declared column types

`mysql2` reports a column's type as a protocol type CODE plus flags, a charset number and a length -
never a name. The codes are not one type each, so `QueryResult.columnTypes`
([column-types.ts](../../src/lib/db/providers/sql/column-types.ts)) resolves them from all four
pieces. Measured on MySQL 26.7.0 over a 40-column probe table, printed straight out of the driver:

| declared | code | length | charset | flags | reported as |
|---|---|---|---|---|---|
| `BIGINT` | 8 | 20 | 63 | 0 | `bigint` |
| `DECIMAL(10,2)` | 246 | 12 | 63 | 0 | `decimal` |
| `TINYINT` / `TINYINT(1)` / `BOOLEAN` | 1 | 4 / 1 / 1 | 63 | 0 | `tinyint` |
| `VARCHAR(40)` | 253 | 160 | 224 | 0 | `varchar` |
| `VARBINARY(9)` | 253 | 9 | 63 | 128 | `varbinary` |
| `CHAR(10)` / `BINARY(8)` | 254 | 40 / 8 | 224 / 63 | 0 / 128 | `char` / `binary` |
| `ENUM('a','b')` / `SET('x','y')` | 254 | 4 / 12 | 224 | 256 / 2048 | `enum` / `set` |
| `TEXT` / `BLOB` | 252 | 262140 / 65535 | 224 / 63 | 16 / 144 | `text` / `blob` |
| `TINYTEXT` … `LONGTEXT` | 252 | 1020 / 262140 / 67108860 / 4294967295 | 224 | 16 | `tinytext` … `longtext` |
| `JSON` | 245 | 4294967295 | 63 | 144 | `json` |
| `GEOMETRY` / `POINT` | 255 | 4294967295 | 63 | 144 | `geometry` (both) |

Two things that table settles, neither of which is guessable from the code alone:

- **Charset 63 (`binary`) separates a character type from a byte type.** The BLOB flag is set for
  `TEXT` as well as for `BLOB` and cannot do it.
- **All four text tiers and all four blob tiers arrive as one code, 252.** Only the length tells them
  apart, so the tier is read from its ceiling (a tier's byte capacity times the charset's maximum
  bytes per character - 4 for utf8mb4 - and the tiers are 256x apart, so the ranges never overlap).

What the names deliberately leave out: the length, precision or display width (`decimal`, not
`decimal(10,2)`), the `unsigned` suffix, and the `point` subtype the protocol does not carry.
Checked column by column against `information_schema.COLUMNS.DATA_TYPE` for the same 40-column
table - the family, which the schema tree now carries as `baseType` beside the declared type
([§7.1](#71-the-object-surface-789)) - **38 of 39 match exactly**; the one difference is
`POINT`, which arrives as code 255 with nothing to distinguish it from `GEOMETRY`.

`columnTypes` is filled by `query()` and `queryInTransaction()`, and is **absent entirely** when no
column declared a type. Its consumers are the results grid's column labels, the SQL-DDL export
(which prefers a declared type over its own value-shaped guess) and the agent's state summary. This
matters most for the types whose values arrive as strings: a `DECIMAL` reaches the browser as
`"19.99"` and a `BIGINT` past 2^53 as `"9007199254740993"`
([§3.7](#37-a-bigint-past-253-arrives-as-a-string)), so before this the DDL export wrote them as
`TEXT`.

### 5.5 The EXPLAIN grammar is measured at connect

`EXPLAIN FORMAT=JSON` is MySQL's own grammar, and this provider serves every MySQL-wire relative.
Several of them reject it, so the provider asks the server rather than assuming. On `connect()`, on
the connection the pool check already holds, `probeExplainFormat()`
([mysql.ts](../../src/lib/db/providers/sql/mysql.ts)) runs `EXPLAIN FORMAT=JSON SELECT 1`, and only if
that is refused, `EXPLAIN SELECT 1`. The first statement that succeeds names the format
`getCapabilities()` then declares.

Measured 2026-09-06 through `mysql2` 3.24.2 over the text protocol, one connection per engine:

| Engine (image) | `EXPLAIN FORMAT=JSON SELECT 1` | plain `EXPLAIN SELECT 1` | resulting `explainFormat` |
|---|---|---|---|
| MySQL 26.7.0 (`mysql:latest`) | ok, one column `EXPLAIN` carrying the JSON plan | ok | `mysql-json` |
| MariaDB 12.3.2 (`mariadb:latest`) | ok, one column `EXPLAIN` | ok, 10 tabular columns | `mysql-json` |
| TiDB 8.5.1 (`pingcap/tidb:v8.5.1`) | errno 1105 `explain format 'json' is not supported now` | ok, columns `id, estRows, task, access object, operator info` | `mysql-text` |
| StarRocks 3.3.22 (`starrocks/allin1-ubuntu:3.3.22`) | errno 1064, syntax error at column 8 | ok, one column `Explain String` | `mysql-text` |
| SingleStore (`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`) | errno 1064 | ok, one column `EXPLAIN` | `mysql-text` |
| Apache Doris 4.1.3 (`apache/doris:all-in-one-4.1.3`) | errno 1105 `mismatched input '=' expecting {<EOF>, ';'}(line 1, pos 14)` | ok, one column `Explain String(Nereids Planner)` | `mysql-text` |
| Vitess 24.0.2 (`vitess/vttestserver:v24.0.2-mysql80`) | ok, one column `EXPLAIN` (the QUOTED `EXPLAIN FORMAT='json'` is errno 1105 there; the unquoted form the probe sends is accepted) | ok, 12 tabular columns | `mysql-json` |
| Vitess 24.0.4 (`vitess/vttestserver:v24.0.4-mysql84`), re-measured 2026-10-04 | ok | ok | `mysql-json` |
| Vitess 25.0.0-SNAPSHOT (`vitess/vttestserver:mysql84`, the floating tag, built 2026-10-02), measured 2026-10-04 | errno 1105 `VT03031: EXPLAIN is only supported for single keyspace`, because `SELECT 1` names no table; `EXPLAIN FORMAT=JSON SELECT * FROM customers` is answered | the same `VT03031` | none, so the Explain panel is unavailable on that build (an open defect in the probe's statement, not fixed here) |
| OceanBase CE 4.4.2 (`oceanbase/oceanbase-ce:4.4.2-lts`, tenant `test`) | ok, 8 rows in one column `Query Plan`, an ASCII plan | ok, 9 rows in the same column | `mysql-json` |
| Databend 1.2.925 (`datafuselabs/databend:v1.2.925-patch-11`) | errno 1105, SyntaxException | ok, one column `explain`, 5 rows | `mysql-text` |

**The probe reads success or failure, never the error code.** The family shares no errno for a grammar
refusal: Doris and TiDB answer 1105 where StarRocks and SingleStore answer 1064, as the table shows. A
code list would have to enumerate engines, and nothing in `src/lib/db` branches on which product
answered. Asking the server what its grammar accepts gives the same answer without the enumeration.
For the same reason a refusal is never a connection failure: it is a fact about the Explain panel, so
`connect()` resolves normally and the capability carries the result.

**The statement is built on the server, not in the browser.** `POST /api/db/provider-meta` never
connects: it constructs the provider and reads `getCapabilities()` off it, by design (#457, no socket,
no SSH tunnel, no SQLite lock contention). A capability that is only knowable once connected therefore
cannot reach the client that way, so `POST /api/db/query` builds the EXPLAIN statement from the
CONNECTED provider's `explainFormat` and names that format in its response
([API_DOCS.md](../API_DOCS.md)). Before `connect()` the provider still answers the static
`mysql-json`, which is exactly what it answered before the probe existed, so the client's pre-flight
refusal for a non-SELECT statement is unchanged.

### 5.6 What the SQL-DDL export writes for dates and BIT

The DDL writes the bare `datetime`, `timestamp` and `time` ([§5.4](#54-declared-column-types)) as `datetime(6)`, `timestamp(6)` and `time(6)`, since precision 0 rounds a replayed `.999` up to the next second (measured on MySQL 26.7.0: `'2024-12-31 23:59:59.999'` into a bare `datetime` reads back as `2025-01-01 00:00:00`), and a bare `bit` as `bit(64)`, which takes every width `mysql2` hands back as bytes where `bit(1)` refuses them (#1386).

The SQL INSERT export still writes a `DATETIME`, `TIMESTAMP` or `DATE` cell as the ISO text the row carries, `'2024-12-31T23:59:59.999Z'`, which MySQL refuses with `ERROR 1292 Incorrect datetime value`.
Rewriting that text would mean assuming the connection read it with `timezone: "Z"`, which a `ProviderOptions.timezone` or a `?timezone=` in the connection string overrides, and a wrong guess replays a different day without an error.
The fix belongs at the source: once the provider returns the server's own date text (#1388), the export writes it as it is.

A `bigint unsigned` past the signed range still fails the DDL form, because the declared type is `bigint` ([§5.4](#54-declared-column-types) says why `unsigned` is not part of it).

---

## 6. Transactions

Identical lifecycle to PostgreSQL, on a **dedicated connection checked out from the pool and held
for the transaction's duration** (so every statement runs on the same connection; it is not returned
to the pool until commit/rollback). Surfaced via `POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction(options?)` | `pool.getConnection()` + `BEGIN` (`START TRANSACTION` if `BEGIN` is refused as a parse error), arms a **5-minute auto-rollback** timer (`TX_TIMEOUT_MS`, [`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)). Throws if one is active, refuses a `BEGIN` the server reports as having opened nothing, and answers `{ stateReported }`; with `requireReportedState` (SANDBOX) it also refuses a server that reports no state at all ([§6.0](#60-what-the-server-says-about-the-transaction)). |
| `queryInTransaction(sql, params?)` | Runs on the transaction's connection (with the same non-SELECT envelope as §5.1). Throws if none active. Ends the session when the server says the statement ended the transaction ([§6.0](#60-what-the-server-says-about-the-transaction)). |
| `commitTransaction()` / `rollbackTransaction()` | Ends it, clears the timer, releases the connection. Throws if none active. |
| `expireTransaction()` | Timeout callback — auto-`rollback()` to prevent leaked locks. |
| `isInTransaction()` | Current state. |

### 6.0 What the server says about the transaction

MySQL commits the open transaction implicitly before a DDL statement and a list of others (the
manual's "Statements That Cause an Implicit Commit"), and the `ROLLBACK` that follows answers
success and undoes nothing, neither the statement nor anything run before it in the same
transaction. Measured 2026-10-04 on MySQL 26.7.0 through mysql2: `START TRANSACTION`, an `INSERT`,
`CREATE TABLE t2`, `ROLLBACK` left both the table and the row. SANDBOX had said "Changes auto-rolled
back. No data was modified." over the same sequence.

The OK packet says so: the status flags read `16387` after `START TRANSACTION`, `3` after the
`INSERT` and `16386` after the `CREATE`, and bit 0 (`SERVER_STATUS_IN_TRANS`) is the transaction.
`mysql2` exposes those flags only as `ResultSetHeader.serverStatus` ([§6.1](#61-endopenquerytransaction-is-not-implemented-here-because-the-driver-cannot-be-asked)),
so the provider reads them where a header exists, and three things follow:

- **`implicitCommitStatements`** names the leading keywords of those statements, and SANDBOX
  refuses a text containing one before anything is sent
  ([`sandbox-refusal.ts`](../../src/lib/editor/sandbox-refusal.ts)). `SET` and `LOAD` are left out:
  only `SET autocommit = 1`, `SET PASSWORD` and `LOAD DATA` on NDB commit, and refusing every `SET`
  would refuse the session variables a SANDBOX run needs. **`implicitCommitExceptions`** lets
  through what a listed keyword would catch and that does not commit: `CREATE TEMPORARY` and `DROP
  TEMPORARY` (the manual's own exception, and measured: the flag stays set after `CREATE TEMPORARY
  TABLE` on every server below; the temporary table outlives the rollback on the pooled connection,
  which is session state rather than data), and MariaDB's `ANALYZE SELECT` / `ANALYZE FORMAT`, a
  read. MariaDB's `BEGIN NOT ATOMIC` compound block stays refused under `BEGIN`: it can run DDL.
- **`queryInTransaction()` ends the session when a header reports bit 0 cleared** (on a server that
  reported its state at BEGIN, see [§6.0.1](#601-servers-that-report-no-transaction-state)), which catches what
  the list does not name (`SET autocommit = 1`, a typed `COMMIT`, a `CALL` whose procedure runs DDL,
  judged by the call's own header, the last element of its answer). A best-effort `ROLLBACK` is sent
  first (answered with a plain OK where the transaction is really gone), so a server that cleared
  the flag with a transaction still open could not hand that transaction to the pool. The
  connection is released and `POST /api/db/transaction` answers `inTransaction: false`, which the
  editor reports as "Not Rolled Back" (SANDBOX) or "Transaction Ended", without claiming whether
  the work was kept: a typed `ROLLBACK` clears the flag exactly as a commit does. A read answers
  rows and no header, so it is never judged, and a read never ends a transaction.
- **`beginTransaction()` refuses a `BEGIN` whose header reports bit 1 (`SERVER_STATUS_AUTOCOMMIT`)
  without bit 0**: the server reports its state, and the state is "no transaction", the MySQL-wire
  twin of what RisingWave does over the PostgreSQL wire (see the PostgreSQL provider's §8.0). It
  sends the statement directly rather than through the driver's own `beginTransaction()`, because
  that method resolves to nothing and the header is the evidence. A header with neither bit, or no
  header at all, is a server that reports no transaction state, which is a different answer
  ([§6.0.1](#601-servers-that-report-no-transaction-state)).

Which servers this reading was measured on, 2026-10-04 through mysql2, one connection each:
`START TRANSACTION`, `INSERT`, `CREATE TABLE`, `INSERT`, `ROLLBACK`, then a count.

| Server | after START | after INSERT | after CREATE | after the next INSERT | rows after ROLLBACK |
|---|---|---|---|---|---|
| MySQL 26.7.0 (`mysql:latest`) | 16387 (set) | 3 (set) | 16386 (cleared) | 2 (autocommit) | 2 |
| Percona Server 8.4.11-11 | 16387 (set) | 3 (set) | 16386 (cleared) | 2 (autocommit) | 2 |
| MariaDB 13.0.2 (`mariadb:latest`) | 3 (set) | 3 (set) | 2 (cleared) | 2 (autocommit) | 2 |
| TiDB v7.5.1 (`pingcap/tidb:latest`) | 3 (set) | 3 (set) | 2 (cleared) | 2 (autocommit) | 2 |

Every one of them commits the DDL and everything before it, and every one reports it in the flag.
**Not measured:** SingleStore, OceanBase and Vitess. On those the list above still refuses DDL in
SANDBOX, and a `BEGIN` they answer with bit 1 alone is refused; one that sets bit 0 without a real
transaction would not be caught.

#### 6.0.1 Servers that report no transaction state

Databend, StarRocks and Apache Doris answer **every** OK packet with status `0`: neither bit 0 nor
bit 1, before a transaction, inside one and after it. MySQL never does that, because one of the two
bits is always set. So status `0` is not "closed", it is "not said". The first reading of the flag
([#1324](https://github.com/libredb/libredb-studio/pull/1324)) took it as "closed" and refused BEGIN
and SANDBOX on all three, although all three run transactions.

Measured 2026-10-04 through mysql2, one connection running the statements and a second one
counting the rows:

| Server | `START TRANSACTION`, `INSERT`, `ROLLBACK` | `BEGIN`, `INSERT`, `ROLLBACK` | Other places that might report it |
|---|---|---|---|
| Databend 1.2.881 (`datafuselabs/databend:latest`) | the row is visible to the second session at once and survives the ROLLBACK: nothing was opened | the row is invisible to the second session and the ROLLBACK discards it | `@@in_transaction` answers `"0"` inside a BEGIN too, and `@@autocommit` answers `"0"` while the server autocommits; no `information_schema.innodb_trx` |
| StarRocks 4.1.6-6862092 (`starrocks/allin1-ubuntu:latest`) | discarded | discarded | no `@@in_transaction` (1193); the OK packet's `info` text reads `'status':'PREPARE'` inside and `'ABORTED'` after the ROLLBACK |
| Apache Doris 4.1.3-rc02 (`apache/doris:all-in-one-4.1.3`) | the INSERT's `info` reads `'status':'VISIBLE'` and the row survives the ROLLBACK: nothing was opened | discarded (`PREPARE`, then `ABORTED`) | no `@@in_transaction` (1105) |

The `info` text is each vendor's own message, not a field of the protocol, so nothing reads it.
Inside a transaction StarRocks refuses DDL (5305, "Explicit transaction only support
begin/commit/rollback/insert/update/delete/set/select/show statements") and a read of a table the
transaction already wrote (5307); Doris accepts only `INSERT`, `UPDATE`, `DELETE`, `COMMIT` and
`ROLLBACK` ("This is in a transaction, only insert, update, delete, commit, rollback is
acceptable."). Those refusals are the engines' own and reach the editor as they are.

That is why the provider opens with **`BEGIN`**: the MySQL manual makes it an alias of `START
TRANSACTION`, and MySQL 26.7.0 and MariaDB 13.0.2 answer both with the same status (16387 and 3,
measured the same day), while on Databend and Doris it is the only one of the two that opens
anything. A server that refuses a bare `BEGIN` as a parse error gets `START TRANSACTION` instead:
MariaDB 13.0.2 under `sql_mode=ORACLE` reads `BEGIN` as the start of a block and answers 1064, and
opens the transaction with `START TRANSACTION` (status 32771). Only errno 1064
(`ER_PARSE_ERROR`) on a live connection falls back, unlike the EXPLAIN probe (§5.5), which reads
only success or failure: on Databend and Doris `START TRANSACTION` opens nothing, so a `BEGIN`
that failed for another reason (a lost connection, a permission, a transaction already open)
would become a session that only looks open. Any other error, and a fallback that fails too,
raise the `BEGIN`'s own error.

What follows from status `0` at BEGIN:

- **A manual transaction is opened**, and `beginTransaction()` answers `{ stateReported: false }`.
  `POST /api/db/transaction` passes that on, and the editor says Studio cannot verify the
  transaction on this server; a ROLLBACK is reported as "Rollback Sent", not as "All changes have
  been discarded", and a COMMIT as "Commit Sent", not as "All changes have been saved".
- **No statement in that session is judged by its status.** StarRocks and Doris answer an `INSERT`
  inside the transaction with a header whose status is `0`; reading that as "closed" would end the
  session and roll the INSERT back. The cost is that a statement that does end the transaction
  there is not noticed either.
- **SANDBOX is refused.** It asks with `requireReportedState`, and on such a server the provider
  rolls back what the BEGIN opened, releases the connection and throws `TRANSACTION_STATE_UNREPORTED`
  ([`errors.ts`](../../src/lib/db/errors.ts)); the route answers 400 with that sentence and the
  editor shows "Sandbox Unavailable ... Nothing was run.". SANDBOX promises a rollback, and nothing
  the server answers there could show one happened.

### 6.1 `endOpenQueryTransaction()` is NOT implemented here, because the driver cannot be asked

A `BEGIN` sent through `query()` is a different thing from the lifecycle above.
It opens a transaction on the pooled connection that one call borrowed, and `query()` releases that connection without ending it: the pool is built with `resetOnRelease` left at its `mysql2` default of `false` ([`pool_config.js`](https://github.com/sidorares/node-mysql2/blob/master/lib/pool_config.js)), so the connection goes back into the free list with its transaction, and its locks, intact.
The provider itself is cached per `connection.id` for the whole process, so whoever borrows that connection next inherits it.

The providers that answer this implement `endOpenQueryTransaction()` ([`types.ts`](../../src/lib/db/types.ts)), and that set is read from the type rather than listed here: a list repeated across provider docs goes stale the moment it grows.
This provider does not implement it, and the reason is the driver: **the driver cannot be asked**.
MySQL does publish the state — the OK packet carries `SERVER_STATUS_IN_TRANS` — but `mysql2` 3.24.4 keeps no transaction flag on `Connection` or `PoolConnection`, and surfaces the byte only as `ResultSetHeader.serverStatus`, on results that carry an OK packet.
A statement that FAILED, which is the case the whole surface exists for, answers an error packet and carries no status at all.
Retaining the connection the way `postgres.ts` retains its client would therefore buy nothing, and the reason is NOT that the session becomes unreachable once it is released: `cancelQuery()` already addresses a handed-back session by name, running `KILL QUERY <threadId>` from a different connection ([§5.3](#53-query-cancellation)).
It is that there is nothing on a `mysql2` connection to read.
That rules out the shape `postgres.ts` uses, where the answer is read off the client the statement ran on, and it rules out the shape `duckdb/index.ts` uses, where the engine's refusal of a `ROLLBACK` is the answer: MySQL accepts `ROLLBACK` with no transaction open, so an unconditional one would report `"rolled-back"` for every script that ended cleanly.

**The server can be asked, which is a different question from the driver, and it was measured.** MySQL 8.0.46, `mysql2` 3.24.4, statements run on a pooled connection and the question asked afterwards from a connection outside that pool, keyed on the released session's `threadId`:

| Ask | `BEGIN` alone | `BEGIN` + failing statement | `BEGIN` + `INSERT` + failing statement | no `BEGIN` (control) |
|---|---|---|---|---|
| `information_schema.innodb_trx` on `trx_mysql_thread_id` | no row | no row | `RUNNING` | no row |
| `performance_schema.events_transactions_current` joined to `performance_schema.threads` on `processlist_id` | `ACTIVE` | `ACTIVE` | `ACTIVE` | `ROLLED BACK` |

Every reading above is taken AFTER `release()`, so the table is also the measurement that the leak is real rather than inferred from `resetOnRelease`.
`information_schema.innodb_trx` is not the ask it looks like: InnoDB registers a transaction only once that transaction does InnoDB work, so it answers "no transaction" for precisely the script this surface exists for, a `BEGIN` followed by a statement that failed before it reached a table.
`performance_schema.events_transactions_current` does answer, and `ACTIVE` is distinguishable there from the terminal state a transaction that already ended leaves behind.

So the absence is the driver's and not the engine's, and implementing the surface on the `performance_schema` ask is open rather than shut.
It is not done here for a reason peculiar to this type-id: `mysql` also serves MariaDB ([§1.1](#11-mariadb-and-the-other-mysql-protocol-engines)), where `performance_schema` is OFF by default and its tables answer NULL instead of failing, so the same query would report no open transaction on a default MariaDB while one is open, and rolling nothing back is the one outcome worse than reporting nothing.
Doing it needs a per-server capability probe of the kind `objectKinds` and the EXPLAIN grammar already use here, which is a change of its own and is filed as D90 rather than smuggled into a doc note.

Not implementing it is therefore a declared boundary rather than an oversight, and it is declared in the type: `endOpenQueryTransaction` is optional on `DatabaseProvider` with no default, and `POST /api/db/multi-query` shape-checks for it.
The cost while it stands: an abandoned transaction keeps its InnoDB row locks until the connection is reused by a caller that ends it, or the pool closes.

---

## 7. Schema introspection

Every reading of this engine's objects goes through the object surface. The flat reading that came
before it was one query for the table list plus three per table, and on MySQL it was also a cage:
every one of its reads bound `TABLE_SCHEMA = config.database` ([§3.2](#32-single-database-scope-and-how-the-object-surface-lifts-it)),
so the app showed exactly one database with no way to reach another. It is deleted.

### 7.1 The object surface (#789)

Five container-aware methods (`listContainers`, `countObjects`, `listObjects`, `describeObject`,
`describeObjects`) declared in [`types.ts`](../../src/lib/db/types.ts) and implemented in
[`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts).

`information_schema` answers for every kind here, which is the OPPOSITE of
[PostgreSQL's](./postgres.md) "read the native catalog" reasoning and is deliberate: MySQL 8's data
dictionary made `information_schema` a set of views over the dictionary tables rather than the
materialised copies it was through 5.7, so there is no cheaper native catalog to prefer, and the
SQL-standard names are the portable ones across the wire-compatible family.

#### `objectKinds` is a function of the SERVER, and this is the only provider where it is

Six kinds on MySQL and eight on MariaDB. There is no `mariadb` type id and choosing MySQL in the
connection dialog is the documented way to reach a MariaDB server ([§1.1](#11-mariadb-and-the-other-mysql-protocol-engines)),
so the declaration is resolved from the server's own `VERSION()` string, measured once per
`connect()` beside the EXPLAIN grammar probe ([§5.5](#55-the-explain-grammar-is-measured-at-connect)).
The type id could not answer this question even if `src/lib/db` were allowed to ask it.

| Kind | `role` | Catalog | Type column value | Note |
|---|---|---|---|---|
| `table` | `relation` | `information_schema.TABLES` | `BASE TABLE`, `SYSTEM VERSIONED` | `acceptsRowWrites: true`; two spellings, see below |
| `view` | `relation` | `information_schema.TABLES` | `VIEW` | not a row-write target |
| `procedure` | `routine` | `information_schema.ROUTINES` | `PROCEDURE` | |
| `function` | `routine` | `information_schema.ROUTINES` | `FUNCTION` | |
| `trigger` | `attached` | `information_schema.TRIGGERS` | n/a | `attachedTo: 'table'` |
| `event` | `config` | `information_schema.EVENTS` | n/a | |
| `package` | `group` | `information_schema.ROUTINES` | `PACKAGE` | **MariaDB only**, `childKinds: ['procedure', 'function']` |
| `sequence` | `config` | `information_schema.TABLES` | `SEQUENCE` | **MariaDB only** |

An unconnected provider declares the MySQL six, which is a real surface rather than internal state:
`POST /api/db/provider-meta` reads capabilities off a provider it never connects (#457). The MySQL
set is the safe default of the two, because declaring a kind the server does not have draws a folder
that can never fill, while missing one costs two folders a MariaDB user regains the moment the
connection is live.

`containerLevels` is one level, `schema`, labelled **Database**: on MySQL the two words name the same
object. No `catalog` level is declared, because MySQL has exactly one and
`information_schema.SCHEMATA` is what a catalog would contain.

**No `index` kind**, on the same line PostgreSQL and Oracle are read against. MySQL's own dictionary
models an index as an attribute of the table it is on: `information_schema.STATISTICS` is keyed by
`TABLE_SCHEMA` and `TABLE_NAME`, and an index cannot exist without them, so an index stays in
`describeObject()`'s output beside that object's columns rather than becoming a container-level
folder.

**A MariaDB package's members are declared but not browsable yet.** `childKinds` is a true statement
about the engine and Phase 2 renders it, but Phase 1's provider surface is container-scoped end to
end, so a Procedures folder under a package would render, never badge, and expand to nothing.

#### The `TABLE_TYPE` vocabulary enumerates the ENGINE, not the fixture

Worth stating explicitly, because the first version of this provider got it wrong and the defect was
invisible. The vocabulary came from `SELECT DISTINCT TABLE_TYPE` run against the seeded fixture,
which enumerates the fixture; a type neither the `CASE` arms nor the listing bind names falls out of
BOTH the count and the listing, so the two still agree and the object is simply absent from the tree
with every gate passing.

Enumerated by building a table for each case rather than by reading a fixture. Measured 2026-09-11
on MySQL 26.7.0 and MariaDB 12.3.2:

| `TABLE_TYPE` | MySQL | MariaDB | Mapped to |
|---|---|---|---|
| `BASE TABLE` | yes | yes | `table` |
| `VIEW` | yes | yes | `view` |
| `SYSTEM VIEW` | yes | yes | nothing, deliberately |
| `SEQUENCE` | no | yes | `sequence` |
| `SYSTEM VERSIONED` | no | yes | `table` |
| `TEMPORARY` | no | yes | nothing, deliberately |

A PARTITIONED table is `BASE TABLE` on both, so partitioning adds no spelling. `ROUTINE_TYPE` is
`PROCEDURE` and `FUNCTION` on MySQL plus `PACKAGE` and `PACKAGE BODY` on MariaDB, and MariaDB's
grammar has no other routine form.

`SYSTEM VERSIONED` is a **`table`** and not a kind of its own. MariaDB's system versioning is a
property of a table you still `SELECT` from, `INSERT` into and address by name, so giving it a folder
would split one concept across two. Because `table` therefore has two spellings, the listing binds
`TABLE_TYPE IN (?, ?)` with the placeholder count sized from the same vocabulary table the `CASE`
arms are built from, so the two cannot disagree about how many spellings a kind has.

The two exclusions are each wrong in a different way if reversed:

- **`SYSTEM VIEW`** is what `information_schema`'s own tables are, and that schema is not a container
  here.
- **`TEMPORARY`** is SESSION-SCOPED, which a pooled provider cannot address at all. Measured on
  MariaDB 12.3.2: a `CREATE TEMPORARY TABLE` is listed in `information_schema.TABLES` by the session
  that created it and by no other (session A saw `tmp_cross`, session B saw none). This provider
  hands out a different pooled connection per method call, so a Temporary folder would badge whatever
  the connection that answered `countObjects` happened to hold, list whatever a different connection
  held, and hand out addresses that resolve on one connection and not the next.

#### A live guard, because "the vocabulary enumerates the engine" is a claim that decays

The table above is right today and a future MariaDB release can add to it, and the failure mode is
SILENCE: a spelling no `CASE` arm names is dropped from the count and from the listing alike, so the
two agree, every gate passes, and the object is absent from the tree. That is exactly how
`SYSTEM VERSIONED` hid here. Prose and an absence from a table do not detect anything.

So the rules are a value, `CATALOG_TYPE_RULES` in
[`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts): the modelled half is derived from
`MYSQL_OBJECT_TYPES` so it cannot drift, and the excluded half is a MAP of spelling to reason, so an
exclusion cannot be added without saying why. `tests/live/mysql-object-vocabulary.ts` then asks a
real server for its own `SELECT DISTINCT TABLE_TYPE` and `SELECT DISTINCT ROUTINE_TYPE` and exits
non-zero NAMING any value outside modelled-plus-excluded.

**Where it runs.** It is a live check, so it is not in `bun run test`: the runner collects every
`*.test.ts` / `*.test.tsx` file under `tests/` except the ones in `tests/live/`, which it excludes by
name (`EXCLUDED` in `tests/runner/discover.ts`). This file is outside that set twice over, by its
directory and by its name, the same arrangement `tests/live/schema-diff-dialects.ts` has. It runs
by hand against a disposable server, and belongs permanently in #789's live acceptance run:

```bash
LIBREDB_LIVE_MYSQL_URLS="mysql://root:root@127.0.0.1:3306/app,mysql://root:root@127.0.0.1:3307/app" \
  bun tests/live/mysql-object-vocabulary.ts
```

Point it at a MySQL **and** a MariaDB; a run against one server is half a measurement.

**What it cannot see, stated so the guard can be calibrated.** `SELECT DISTINCT` reports the
spellings a server's DATA exhibits, not the spellings its grammar can produce, so both fixtures hold
one object of every spelling this provider knows about, `WITH SYSTEM VERSIONING` included. The one
spelling a fixture can never carry is `TEMPORARY`, since a temporary table dies with the session that
made it; it stays recognised through its entry in `CATALOG_TYPE_RULES.tables.excluded`.

The subset assertion has two ways to be vacuous and neither is visible from a live run, so both are
pinned in the unit suite instead: that neither half of the rules is empty, that no spelling is in
both halves, and that every exclusion carries a reason.

#### A table and a stored routine can share a name, and this is measured

#789 reasoned that they could and named MySQL as the engine that proves it. Measured 2026-09-11 on
**MySQL 26.7.0** and **MariaDB 12.3.2**, in one database, each statement run after the one above it:

| Statement | Answer |
|---|---|
| `CREATE TABLE app.foo (id INT PRIMARY KEY)` | accepted |
| `CREATE PROCEDURE app.foo() SELECT 1` | accepted |
| `CREATE FUNCTION app.foo() RETURNS INT DETERMINISTIC RETURN 1` | accepted |
| `CREATE TRIGGER app.foo BEFORE INSERT ON app.foo FOR EACH ROW ...` | accepted |
| `CREATE EVENT app.foo ON SCHEDULE EVERY 1 DAY DO SELECT 1` | accepted |
| `CREATE VIEW app.foo AS SELECT 1 AS n` | **ERROR 1050 (42S01) `Table 'foo' already exists`** |
| `CREATE SEQUENCE app.foo START WITH 1` (MariaDB) | **ERROR 1050 (42S01) `Table 'foo' already exists`** |

So a table, a procedure, a function, a trigger and an event of one name coexist in one database, and
the ONE namespace that is shared is the table/view/sequence one, and a MariaDB sequence is a table
underneath, which is why it collides. A path is therefore unique WITHIN a kind and deliberately not
across kinds, which is what `assertObjectSurface` in
[`tests/helpers/object-surface-conformance.ts`](../../tests/helpers/object-surface-conformance.ts)
asserts and what makes the tree's row identity path PLUS kind id. The fixture ships the pair as
`app.order_archive`, a table and a stored procedure, so the answer cannot quietly stop being true.

Two consequences follow for `describeObject()`. It takes the KIND as its second argument, and it has
to: the detail reads key the last path segment against `TABLE_NAME`, so a name-driven describe would
have handed `app.order_archive` the procedure its namesake table's five columns. And a path segment
needs no disambiguator, unlike PostgreSQL's: MySQL does not overload routines, measured: a second
`CREATE PROCEDURE app.foo(a INT)` over an existing `app.foo()` answers `ER_SP_ALREADY_EXISTS`.

A trigger nests as `[database, table, trigger]` because `attachedTo: 'table'` says it hangs off its
table, NOT because the name needs the table to be unique: measured, a trigger name is unique per
DATABASE and not per table, and a second `CREATE TRIGGER app.foo` on a different table answers
`ER_TRG_ALREADY_EXISTS`.

#### `listContainers()` reads `SHOW DATABASES`, bound to nothing

That is what ends the single-database confinement. MySQL resolves a qualified name across databases
on one connection, unlike PostgreSQL where a `pg` pool is pinned to one database, so every
database the server holds is genuinely browsable from one session.

Four schemas are hidden: `information_schema`, `mysql`, `performance_schema`, `sys`. It is a
hand-written name list, unlike Oracle's `ORACLE_MAINTAINED` and PostgreSQL's `pg_depend` ownership
test, because neither server publishes the fact: nothing in `SCHEMATA` says whether a schema is the
server's own. What makes the list safe is that all four names are RESERVED, so hiding them can never
hide a database a person created; measured 2026-09-11, `SCHEMATA` holds exactly these four plus the
user's own on both servers. They are hidden from the BROWSER and stay fully reachable from the SQL
editor, the same treatment `pg_catalog` gets on PostgreSQL, and this provider itself reads two of
them.

**`SHOW DATABASES` and not `information_schema.SCHEMATA`, because of Vitess.** Through vtgate the two
disagree, and only `SHOW DATABASES` names something a statement can address. Measured 2026-10-04 on
Vitess 24.0.4 (`vitess/vttestserver:v24.0.4-mysql84`, keyspace `e2e`, one shard):

| Read through vtgate | Answer |
|---|---|
| `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA` | `mysql`, `information_schema`, `performance_schema`, `sys`, `_vt`, `vt_e2e_0` |
| `SHOW DATABASES` | `e2e`, `information_schema`, `mysql`, `sys`, `performance_schema` |
| `SELECT DATABASE()` | `e2e` |

The 25.0.0-SNAPSHOT the floating `vitess/vttestserver:mysql84` tag pointed at the same day answers all
three identically.

While the containers came from `SCHEMATA`, the tree drew the sidecar `_vt` and the physical shard
`vt_e2e_0` instead of the keyspace, and vtgate refuses the shard name in a statement
(`VT05003: unknown database 'vt_e2e_0' in vschema`).

Off Vitess, the engines below were measured on 2026-10-04 and nothing else is claimed. On each,
`SHOW DATABASES` answers the same set as `SCHEMATA`, and on the ones marked "compared" the provider's
containers, counts and listings were read before and after the change and are identical:

| Engine | First column of `SHOW DATABASES` | Containers before and after |
|---|---|---|
| MySQL 26.7.0 (`mysql:latest`) | `Database` | compared, identical |
| MariaDB 13.0.2 (`mariadb:latest`) | `Database` | compared, identical |
| Percona Server 8.4.11-11 | `Database` | compared, identical |
| TiDB 8.5.8 (`pingcap/tidb:v8.5.8`) | `Database` | compared, identical |
| Apache Doris 4.1.3 (`apache/doris:all-in-one-4.1.3`) | `Database` | compared, identical |
| StarRocks (`starrocks/allin1-ubuntu:latest`) | `Database` | same set, not compared through the provider |
| Databend 1.2.925 (`datafuselabs/databend:v1.2.925-patch-13`) | **`databases_in_default`** | compared, identical (`default`, `system`) |

OceanBase was not measured: the `oceanbase-ce:latest` container did not boot on the test host.

Because Databend labels the column `databases_in_default`, the name is read from the FIRST column by
position rather than by the label `Database`.

**`--skip-show-database` falls back to `SCHEMATA`.** A server started with that option answers
`SHOW DATABASES` only to a holder of the global `SHOW DATABASES` privilege, and refuses anyone else
with errno 1227 (`ER_SPECIFIC_ACCESS_DENIED_ERROR`), while `information_schema.SCHEMATA` still lists
the databases the caller holds a grant on. Measured 2026-10-04 on MySQL 26.7.0 and MariaDB 13.0.2, both
started with `--skip-show-database`, as a user granted only `e2e.*`: `SHOW DATABASES` was refused and
`SCHEMATA` listed `e2e` (plus `information_schema`, and `performance_schema` on MySQL, both hidden). On
errno 1227, and only on it, `listContainers()` reads `SCHEMATA` instead, so that user's tree shows `e2e`
exactly as it did before. Any other failure is raised as it is.

Three consequences of reading a `SHOW` statement. The reserved four are dropped by the provider after
the read rather than by a `WHERE`, because vtgate ignores a `WHERE` on `SHOW DATABASES` and answers all
five rows anyway; the comparison is by exact name, which is what the former `NOT IN (...)` did on
MySQL (`utf8mb3_bin`) and TiDB (`utf8mb4_bin`), so TiDB's upper-case `INFORMATION_SCHEMA`,
`METRICS_SCHEMA` and `PERFORMANCE_SCHEMA` are listed exactly as before. On MariaDB, whose `SCHEMATA`
collates `utf8mb3_general_ci`, the former clause compared without regard to case, so a user database
named `SYS` or `Mysql` (possible with `lower_case_table_names=0`) was hidden before and is listed now.
And the order is the provider's code-point order over the path, the rule `listObjects` already uses,
because vtgate answers unsorted; on MariaDB that differs from the former SQL order only for database
names that differ in case.

`Container.isSessionDefault` comes from `SELECT DATABASE()`, the server's own answer for which
database the session is in, rather than from `config.database`, because the configured value is what a
person typed into a form. It is SQL NULL when no database was selected, which matches no container.

#### `countObjects()` is one statement over four views

One UNION ALL arm per view, one `GROUP BY`, one round trip for a whole folder row, and it reads no
column of any table. The SAME statement text goes to both servers and nothing in it branches on the
flavour: MySQL holds no `SEQUENCE` row and no `PACKAGE` row, so those `CASE` arms never fire there.
The data decides, which is one fewer place the two branches can disagree.

A NULL kind is what the `CASE` has no name for, and it is dropped rather than counted under a folder
that does not exist. Two things fall out that way:

- **`SYSTEM VIEW`**, which is what `information_schema`'s own tables are on both servers.
- **`PACKAGE BODY`**, which is a second `ROUTINES` row for one tree node exactly as on Oracle, so
  counting it would double the Packages badge. The body cannot exist alone: measured,
  `CREATE PACKAGE BODY` with no specification answers `ERROR 1305 PACKAGE app.orphan_pkg does not
  exist`, so the `PACKAGE` row is present for every package and counting that row alone is complete.

**The NULL group is dropped after the read, not by a `WHERE kind IS NOT NULL`.** vtgate cannot plan
that filter: measured 2026-10-04 on Vitess 24.0.4 and on the 25.0.0-SNAPSHOT, the four-arm statement with the outer `WHERE` is
refused with `VT13001: [BUG] could not find the column 'TABLE_TYPE' on the UNION`, which put that
sentence on every folder of the tree. Without it vtgate answers the counts MySQL does (`table 3`,
`view 2` for the probe keyspace). The same `WHERE` over two arms is answered, so it is the filter
pushed through three or more arms that the planner cannot resolve. The NULL group comes back as one
more row and is skipped exactly like an undeclared kind, below.

**A catalog row cannot create a folder.** A kind that was not declared is skipped rather than
answered for, and on this provider that is a live case rather than defensive programming: a MariaDB
server whose version probe came back empty answers `sequence` and `package` rows against a MySQL
declaration. The DECLARATION decides which folders exist.

**A refused read is `{ unavailable }`, never 0**, carrying the server's own sentence unmapped, and
every declared kind is seeded at `{ count: 0 }` before the read so a folder the database holds none
of renders a zero rather than disappearing. There is no partial outcome to report and no retry that
could produce one, because the four views are one statement. Worth knowing when reading a small
number: `information_schema` FILTERS by privilege rather than refusing, so a role that can see only
part of a database gets a real count of the part it can see.

#### `describeObject()` reads three narrow statements, and only for the `TABLES` kinds

Columns, foreign keys and indexes, each bound to ONE database and ONE object. Only the kinds
`information_schema.TABLES` resolves have any of the three, so a procedure, a function, a trigger, an
event and a MariaDB package answer three empty arrays without a round trip, which is a true fact about those
kinds rather than a failed read.

A **MariaDB sequence DOES describe**, and that is why the rule is keyed on the CATALOG rather than on
`role === 'relation'`: measured on 12.3.2, `information_schema.COLUMNS` answers eight real columns for
one (`next_not_cached_value`, `minimum_value`, `maximum_value`, `start_value`, `increment`,
`cache_size`, `cycle_option`, `cycle_count`), because a sequence is a table underneath. Its role is
`config` rather than `relation` because nobody selects rows from it.

**`hasColumns` is declared on `table`, `view` and MariaDB's `sequence`, and on no other kind (#789).**
That declaration is the client gate the object tree draws a column twisty from, and it is derived at each kind from the same catalog predicate these two reads are keyed on, so the gate and the reads cannot drift apart.
`procedure`, `function`, `trigger`, `event` and MariaDB's `package` declare nothing and answer `columns: []`, which is the three-empty-array answer above.
An object dropped between the listing and the describe reaches the caller the same way: this surface has no zero-row check, so it answers three empty arrays and no error, unlike PostgreSQL, which raises.

Three differences from the deleted flat reads over the same views, all deliberate:

- **No `LIMIT`.** The flat column read stopped at 100 columns, which a flat tree could live with and a
  detail panel cannot: nothing downstream can tell a cap from a count, so a 140-column table would
  report 100 columns as a fact.
- **No `GROUP_CONCAT` for the index columns.** `group_concat_max_len` is 1024 by default on both
  servers (measured) and the function truncates silently at it, so a wide composite index would report
  a column list short by an unknowable amount. The object read takes one row per column and groups
  them in code, which has no cap at all.
- **`REFERENCED_TABLE_SCHEMA` is read.** InnoDB accepts a foreign key into another database, and the
  object browser is no longer confined to one, so a reference that leaves the container is qualified;
  a bare name there addresses a table in the wrong database.

A `VIEW` carries neither a row count nor a size: measured, `information_schema.TABLES` answers NULL in
`TABLE_ROWS`, `DATA_LENGTH` and `INDEX_LENGTH` for one, and 0 rows of 0 bytes would be a measurement
nobody took. `TABLE_ROWS` on a base table is the engine's own estimate, the same nature as
PostgreSQL's `reltuples`.

**A column's type is the type AS DECLARED, and the family rides beside it (#1033).**
`information_schema.COLUMNS` carries two type columns and they are not interchangeable.
`DATA_TYPE` is the FAMILY: it drops the length, the precision and scale, the value list of an `ENUM` or a `SET`, and the `unsigned` and `zerofill` attributes.
`COLUMN_TYPE` is the declaration and drops none of them.
Measured 2026-09-22 on MySQL 26.7.0 and MariaDB 13.0.2, over the `app.column_types` both fixtures create:

| DDL | `DATA_TYPE` | `COLUMN_TYPE`, MySQL | `COLUMN_TYPE`, MariaDB |
| --- | --- | --- | --- |
| `VARCHAR(20)` | `varchar` | `varchar(20)` | `varchar(20)` |
| `DECIMAL(12,2)` | `decimal` | `decimal(12,2)` | `decimal(12,2)` |
| `CHAR(2)` | `char` | `char(2)` | `char(2)` |
| `ENUM('x','y')` | `enum` | `enum('x','y')` | `enum('x','y')` |
| `SET('a','b')` | `set` | `set('a','b')` | `set('a','b')` |
| `INT UNSIGNED` | `int` | `int unsigned` | `int(10) unsigned` |
| `TEXT` | `text` | `text` | `text` |

`ColumnSchema.type` takes `COLUMN_TYPE` and `ColumnSchema.baseType` takes `DATA_TYPE`, and `baseType` is OMITTED where the two agree, which is the rule the SQL Server provider already follows for its alias types.
An absent `baseType` therefore says the server draws no distinction for this column, never that nobody looked.

Both fields are load-bearing, in opposite directions.
`type` is what a reader SEES and what a reader emitting DDL WRITES: the schema-diff migration generator interpolates it into `CREATE TABLE` and `ADD COLUMN` verbatim, and `varchar` with no length is not a type on either server - `CREATE TABLE t (note varchar)` is error 1064 - so a migration built from the family alone was rejected in full.
`baseType` is what a reader DECIDING matches against, because a declaration is not a family name: `int unsigned` equals no spelling a `===` knows, and `enum('int','text')` answers a substring test for `int` while being neither an integer nor a number.
The two are carried side by side rather than one being parsed back out of the other, because that parse is not available: one declaration is spelled more than one way across the fleet, and only the server knows which.
MySQL deprecated the integer display width in 8.0.17 and stopped printing it in 8.0.19, in `SHOW CREATE`, `DESCRIBE` and `information_schema` alike, with two exceptions it still prints: `TINYINT(1)`, which connectors read as a boolean, and any column with `ZEROFILL`.
Measured on MySQL 26.7.0: `INT` is `int`, `BIGINT(20)` is `bigint`, `TINYINT(1)` is `tinyint(1)` and `INT ZEROFILL` is `int(10) unsigned zerofill`; MariaDB 13.0.2 still prints every width, so its `INT` is `int(11)`.
Per the 8.0.19 release notes, a table created on an earlier 8.0 keeps its width in `information_schema`, because the data dictionary is not rewritten, so `int(11)` is reachable on a current MySQL too.

`tests/live/mysql-column-type.ts` ([§12.4](#124-optional-verifying-against-a-live-mysql-and-a-live-mariadb)) holds that claim against real servers: it replays the generated `CREATE TABLE` at the server that supplied its columns and requires an accept, and replays the family-only definition it replaces and requires a REFUSAL.

Two consequences for the schema diff, measured and accepted rather than repaired.
`diffColumns()` compares `type`, and a snapshot taken before this change stored the family, so the same unchanged column now reads as its declaration: every column with a length, a precision and scale, a value list, or `unsigned` reports one spurious `Type changed: varchar → varchar(20)` and one `MODIFY COLUMN` that changes nothing.
A column whose declaration is its family, such as `text`, `date` or a MySQL `int`, compares equal and reports nothing, and a new snapshot clears the rest.
The second is not stale data at all: diffing a MariaDB schema against a MySQL 8.0.19+ one reports `Type changed: int(11) → int` for every integer column the two created from the same DDL, except `TINYINT(1)` and `ZEROFILL` columns, which both servers print in full.
Comparing `baseType` instead would silence both, and would also silence a real `varchar(20)` → `varchar(40)`, which is the change this section exists to carry.

**MariaDB and MySQL do not report a column default the same way, and this surface reads both (#795).**
MySQL reports the VALUE: a column with no default is SQL NULL, and `DEFAULT 'abc'` reads back as `abc`.
MariaDB reports the DEFAULT EXPRESSION AS WRITTEN, so a nullable column with no default reads back as the four-character keyword `NULL` and `DEFAULT 'abc'` reads back as `'abc'`, quotes included.
Measured 2026-09-20 on MariaDB 12.3.2 and MySQL 26.7.0, `HEX(COLUMN_DEFAULT)` read beside the text:

| DDL | the value the column defaults to | MySQL | MariaDB |
| --- | --- | --- | --- |
| `INT NULL` | none | SQL NULL | `NULL`, four characters |
| `INT NOT NULL` | none | SQL NULL | SQL NULL |
| `DEFAULT 'NULL'` | `NULL` | `NULL` | `'NULL'` |
| `DEFAULT 'abc'` | `abc` | `abc` | `'abc'` |
| `DEFAULT 'it''s'` | `it's` | `it's` | `'it''s'` |
| `DEFAULT 'a\\b'` | `a\b` | `a\b` | `'a\\b'` |
| `DEFAULT 42` | `42` | `42` | `42` |
| `DEFAULT CURRENT_TIMESTAMP` | the expression | `CURRENT_TIMESTAMP` | `current_timestamp()` |
| `AS (1+1) STORED` | none | SQL NULL | `NULL`, four characters |

`CATALOG_DEFAULT_READING` holds that difference as a per-flavour record, resolved once from the flavour measured at connect, and `catalogDefault()` reads the record.
SQL NULL is absence on both.
A generated column is absence on both, recognised by `EXTRA` being exactly `STORED GENERATED` or `VIRTUAL GENERATED`: the match is on the whole value because MySQL also writes `DEFAULT_GENERATED` for an ordinary expression default, where MariaDB writes nothing.
On MariaDB the remaining text is decoded by `unquoteLiteral()` (`src/lib/sql/values.ts`), the inverse of the `quoteLiteral()` this repo already uses for this family, so the doubled quote and the escaping backslash are both undone; text that is not exactly one literal, such as `current_timestamp()` or `concat('x','y')`, passes through as written.

**Each column carries both readings, and only where they were measured.**
`defaultValue` is the value the column defaults to, which is what the object browser shows, and this family decodes it, as SQLite, libSQL and DuckDB do for the same reason (#1029).
Most other providers leave the engine's catalog text in that field; ClickHouse is the exception either way, because it builds a clause-naming string such as `MATERIALIZED a + b` that is neither (issue #1032).
`defaultExpression` is the SQL text that produces it, which is what a reader emitting DDL, the schema-diff migration generator above all, must write after the word `DEFAULT`, and a provider carries it exactly where it decoded the value out of it.
On MariaDB both are set: the catalog text is always valid SQL there, every form in the table above included, so the expression is the raw text unchanged.
On MySQL the catalog row sets only `defaultValue`, and that is deliberate: `abc` is a value and is not valid after `DEFAULT`, while `b'1'` and `0x616263` are SQL, and all three arrive with an EMPTY `EXTRA`, so nothing in the row tells them apart.
The SQL text comes from the engine instead, `SHOW CREATE TABLE`, for a caller that asks for it: see [Default SQL from `SHOW CREATE TABLE`](#default-sql-from-show-create-table-1031) below.
An absent `defaultExpression` says the provider did not decode, never "there is no expression", so a reader falls back to `defaultValue` as the text; on a MySQL read that did not ask, that fallback keeps the pre-existing unquoted `DEFAULT abc` rather than inventing a quoting rule the catalog cannot justify.

One consequence for a stored snapshot, measured and accepted rather than repaired.
A snapshot taken before this change stored MariaDB's catalog text in `defaultValue`, and the comparison reads the SQL text first, so `'abc'` against today's `'abc'` compares equal and reports nothing.
A column with NO default is the exception: the old reading stored the four-character keyword `NULL` there and the current one stores neither field, so such a snapshot reports one spurious default change per no-default column, with a `MODIFY COLUMN` that changes nothing.
Reading that keyword as absence would put back the ambiguity this section exists to remove, since `NULL` is also a value a column can really default to.

A second one, for a MySQL snapshot taken before SchemaDiff read the DDL (#1031), accepted the same way.
Such a snapshot holds only the catalog's value, and today's reading carries the SQL text as well, so the comparison is `abc` against `'abc'`.
It reports `Default changed: abc → 'abc'` for every default the server spells with quotes or as an expression: string, date and time, enum, binary and expression defaults.
A bare numeric default is the same text on both sides and reports nothing.
The stored value cannot be told apart from SQL, which is the defect the DDL read exists to fix, so the comparison has nothing to reconcile them with; taking a new snapshot clears it.

MySQL's own parenthesised expression defaults read back from the catalog charset-introduced and backslash-escaped, `concat(_latin1\'x\',_latin1\'y\')`, which is not what the user wrote and is `ER_PARSE_ERROR` after `DEFAULT`.
`defaultValue` carries it as reported.
The DDL read below carries `(concat(_latin1'x',_latin1'y'))` as `defaultExpression`, which the server accepts back.
MariaDB's equivalent reads back as `concat('x','y')`, so the two servers still show the same column differently, and that is the engines' shape rather than a gap here.

#### Default SQL from `SHOW CREATE TABLE` (#1031)

`describeObjects(container, kind, limit, { defaultSql: true })` fills `defaultExpression` on MySQL from `SHOW CREATE TABLE`, the server's own rendering of every default as SQL it accepts back.
SchemaDiff asks, through `includeDefaultSql` on `POST /api/db/objects/inventory`, because a migration pastes that text and a snapshot must capture it when it is taken.
Nothing else asks.
MariaDB never reads it, because its catalog text is already SQL (`CATALOG_DEFAULT_READING.defaultSql`).
Measured 2026-09-23 and 2026-09-24 on MySQL 26.7.0 and MariaDB 13.0.2, through `mysql2`.

**It costs one round trip per table, so it is opt-in.**
Only a table with at least one catalog default is read, and only a described one, so the caller's `limit` bounds it.
A view is never read: its columns report the defaults of the columns they select, and `SHOW CREATE TABLE` answers a view with no column list to read them from.
5000 tables, one connection, local Docker:

| read | time |
| --- | --- |
| the four-statement bulk read, whole schema | 64 ms |
| `SHOW CREATE TABLE` × 500 | 208 ms |
| `SHOW CREATE TABLE` × 5000 | 2351 ms |
| `SELECT 1` × 1000, the round-trip floor | 246 ms |

About 0.47 ms per table here, which is the round trip: at a 20 ms round trip, 5000 tables with defaults cost about 100 s.
A snapshot is a read the user starts, so SchemaDiff pays that. The agent's inventory never does.

**The catalog truncates a binary default at its first zero byte.**

| DDL | `COLUMN_DEFAULT` | `SHOW CREATE TABLE` | bytes after pasting `SHOW CREATE` back |
| --- | --- | --- | --- |
| `binary(4) DEFAULT 0x00FF0A27` | `0x` | `0x00FF0A27` | `00FF0A27` |
| `varbinary(8) DEFAULT 0x0027005C0D` | `0x` | `'\0''\0\\\r'` | `0027005C0D` |
| `binary(3) DEFAULT 0x000000` | `0x` | `'\0\0\0'` | `000000` |
| `binary(2) DEFAULT 0xFF80` | `0xFF80` | `0xFF80` | `FF80` |
| `binary(2) DEFAULT 0xC3A9` | `0xC3A9` | `'é'` | `C3A9` |
| `binary(3) DEFAULT 'abc'` | `0x616263` | `'abc'` | `616263` |

`DEFAULT 0x` is `ERROR 1064`, so before this read every binary default holding a `00` byte produced a migration the server refused.
`defaultValue` still carries the catalog's `0x`; `defaultExpression` carries all four bytes.

**Two rewrites, and everything else exactly as the server wrote it** (`portableDefaultSql()` in `src/lib/db/providers/sql/mysql-show-create.ts`):

1. *A quoted number on a numeric type loses its quotes.* MySQL writes every numeric default quoted and MariaDB's catalog writes none of them quoted, so without this an unchanged default compares as changed between the two:

   | `DATA_TYPE` | MySQL `SHOW CREATE` | MariaDB `COLUMN_DEFAULT`, and what MySQL's becomes |
   | --- | --- | --- |
   | `int` | `'42'`, `'-5'` | `42`, `-5` |
   | `bigint` unsigned | `'18446744073709551615'` | `18446744073709551615` |
   | `tinyint` | `'1'` | `1` |
   | `decimal` | `'1.50'` | `1.50` |
   | `float` | `'1500'` | `1500` |
   | `double` | `'0.1'` | `0.1` |
   | `year` | `'2020'` | `2020` |

   The gate is the declared type, so a varchar `'42'` keeps its quotes, which are the value's. A numeric type missing from the gate stays quoted, which is still valid DDL, and `DEFAULT '42'` and `DEFAULT 42` are one default on these types.
2. *A string literal holding a backslash escape becomes hex.* `SHOW CREATE TABLE` writes backslash escapes even for a session running `NO_BACKSLASH_ESCAPES`, and a server in that mode ACCEPTS them and stores other bytes: `varchar(10) DEFAULT 'a\\b'` stores `615C5C62` where `615C62` was meant, and `varbinary(16) DEFAULT '\0''\0\\\r'` stores `5C30275C305C5C5C72` where `0027005C0D` was meant. Hex has one meaning in both modes. A binary column takes the bytes bare. Any other column takes the `_utf8mb4` introducer, because a bare hex literal is read in the COLUMN's charset: latin1 `DEFAULT 0x5CC3A9` stores `5CC3A9`, where `DEFAULT _utf8mb4 0x5CC3A9` stores the intended `5CE9`. Measured under both modes, each of these stores the intended bytes: latin1, utf8mb4 and cp1251 `varchar`, an `enum`, and `varbinary`. Only a whole literal is rewritten; an expression default stays as written, escapes included, because an introducer inside it would change what it means.

**When the text is not used.** The table keeps today's catalog reading, no `defaultExpression`, and the read carries on:

- A refusal or an absence, classified exactly as the Source tab classifies them (`readSourcePart`). A column-level `GRANT SELECT (id, note)` reads both columns from the catalog and gets `ERROR 1142 SHOW command denied` from `SHOW CREATE TABLE`; a table dropped between the two reads answers 1146. Any other failure still raises.
- DDL the reader cannot read to the end, or DDL that lacks a `DEFAULT` for a column the catalog says has one. The whole table falls back, never half of it, so one diff never compares two readings of one table.

**Reading the column out of the DDL** (`showCreateColumnDefaults()`, same module) is a tokenizer rather than a search, because `DEFAULT` also appears inside a string (`COMMENT 'has DEFAULT'`, an `enum('x DEFAULT y')` member), inside a parenthesis (a `CHECK`, `GENERATED ALWAYS AS ((default(inv) + 1))`) and in the table options (`DEFAULT CHARSET=`).
It reads the ONE primary after the top-level `DEFAULT`, which stops it at `ON UPDATE`, `COMMENT` and a versioned comment such as `/*!80023 INVISIBLE */`.
Identifiers are read in all three quotings the server uses: backticks, the double quote under `ANSI_QUOTES`, and bare under `sql_quote_show_create=0`.
It does not use `src/lib/sql/spans.ts`, which declines a quote behind a backslash because in text a user wrote the escaping depends on the session; this text is the server's, which always escapes with a backslash.

It answers nothing for the whole table when a default is followed directly by anything but a space, a comment or the end of the column, or holds U+FFFD, the driver's mark for a byte it could not decode.
Both come from SingleStore 9.1.1, measured 2026-10-04, which this provider also serves:

| DDL | SingleStore `SHOW CREATE TABLE` | read as one primary | now |
| --- | --- | --- | --- |
| `decimal(6,2) DEFAULT 1.50` | `DEFAULT 1.50` | `1` | falls back |
| `double DEFAULT 0.1` | `DEFAULT 0.1` | `0` | falls back |
| `int DEFAULT 42` | `DEFAULT 42` | `42` | read |
| `binary(4) DEFAULT 0x00FF0A27` | a string with the 0xFF byte raw | `0x00EFBFBD0A27` after the hex rewrite | falls back |

MySQL quotes every numeric default and writes a binary default that is not valid text as hex, so neither shape occurs there.

Not measured: the other wire-compatible engines this provider serves (TiDB, StarRocks, Doris and the rest). They take the same path, and DDL the reader cannot use falls back as above.

#### `describeObjects()` describes a whole folder in four statements (#789)

`describeObjects(container, kind, limit?)` answers columns, indexes and foreign keys for EVERY object of
one kind in one database, in FOUR round trips whatever the folder holds.
The one exception is opt-in: `{ defaultSql: true }` adds a `SHOW CREATE TABLE` per table with a default, described [above](#default-sql-from-show-create-table-1031).
The single read is three statements per object, so a folder of 200 tables cost 600.
Measured on MySQL 26.7.0 against a 200-table database built by the commands below: **13 ms for one
`describeObjects()` against 118 ms for 200 `describeObject()` calls**, the same 600 columns and 400 indexes.

The five decisions this engine had to make for itself, each measured rather than reasoned:

**Which catalog.**
The same three `information_schema` views `describeObject()` reads, and that is a real answer rather than an
assumption carried over: PostgreSQL had to leave `information_schema.columns` because it holds no row at all
for a materialized view or a sequence, and on this family it holds a row for every kind that has columns,
a MariaDB `SEQUENCE` included.
What the bulk read does NOT take from that view is the MEMBERSHIP of its answer.
The target set is read from `information_schema.TABLES`, the same view `listObjects` reads, because a view
whose base table has been dropped keeps its `TABLES` row and has NO `COLUMNS` row at all.
Measured on both servers: `CREATE VIEW broken AS SELECT id FROM base; DROP TABLE base;` leaves one `TABLES`
row and zero `COLUMNS` rows.
A target derived from the column read would therefore drop an object the folder lists, which is the class of
absence standing ruling 5a is about.
It is also what lets an object the three detail reads answered nothing for come back with three empty lists
rather than missing.

**Which kinds have no columns.**
The kinds read from `information_schema.ROUTINES`, plus `trigger` and `event`: a procedure, a function, a
MariaDB package, a trigger and an event answer `{ details: [] }` with no round trip at all.
A MariaDB `sequence` is NOT one of them, for the reason the single read gives above, and the rule is the one
function `hasColumns()` so the two reads cannot disagree about it.

**What bounds the read on the wire.**
`LIMIT ?` inside the target subquery, the placeholder BOUND rather than interpolated: measured on MySQL
26.7.0 and MariaDB 12.3.2 through the binary prepared protocol, a placeholder in a derived table's `LIMIT`
is accepted.
The provider binds `limit + 1`, so a saturated read is told from an exact one with no second count, drops the
extra object, and reports the CALLER's limit in `truncated`.
An unbounded call runs a statement with no `LIMIT` clause and can never report truncation.
Neither the columns nor the indexes are capped: the deleted flat reading's `LIMIT 100` was an
unreported bound and is the defect `truncated` exists to prevent.

**What orders the cut, and under whose collation.**
`ORDER BY TABLE_NAME` in the target statement, which runs under the SERVER's collation, and **the two servers
in this family do not use the same one.**
Measured: `information_schema.TABLES.TABLE_NAME` collates `utf8mb3_bin` on MySQL 26.7.0 and
`utf8mb3_general_ci` on MariaDB 12.3.2, and the fixture makes the difference visible rather than theoretical.
The `table` rows of `app` come back as `customers, order_archive, orders` on MySQL and as
`customers, orders, order_archive, order_audit` on MariaDB, because `general_ci` folds `s` to the weight of
`S` (0x53), which sorts below `_` (0x5F).
The two lists differ in length as well as in order: `order_audit` is the `WITH SYSTEM VERSIONING` table, which
only the MariaDB fixture creates because MySQL has no system versioning, so MySQL holds three `table` rows and
MariaDB holds four (re-measured live on MySQL 26.7.0 and MariaDB 12.3.2 for #789 Task 27).
So `describeObjects(["app"], "table", 2)` keeps `customers, order_archive` on one server and
`customers, orders` on the other.
That order decides WHICH objects a bound keeps and nothing else: the answer is re-sorted by path in code,
which is one rule on every server, and a caller joins the two answers on path rather than on position.
A bounded read's membership is therefore the server's, and it is not promised to be the same on two servers
of this family.

**The bound is written into the statement, not bound to it.**
`LIMIT 2`, never `LIMIT ?`, and that is a relative's constraint rather than a style choice.
Measured 2026-09-22 through `mysql2` with the same statement four ways, against each server in turn:
`execute()` with no bound answers everywhere, `execute()` with a literal `LIMIT` answers everywhere, and
`execute()` with `LIMIT ?` answers on MySQL 8 and fails on **Apache Doris 4.1.3-rc02** with
*mismatched input 'LIMIT' expecting {&lt;EOF&gt;, ';'}* and on **StarRocks 3.3.22-753696f** with
*using parameter(?) as limit or offset not supported*.
The text protocol (`query()`) takes `LIMIT ?` on all three, so this is the binary prepared protocol's
placeholder in the LIMIT position specifically, not the LIMIT grammar and not prepared statements at large.
Before the bound was written in, a Doris or StarRocks user got a 500 from the object browser the moment a
folder was read, because the bulk read is the only caller that bounds.
What is spelled in is the caller's `limit + 1`, which `describeObjects()` has already rejected unless it is a
positive whole number, so the rendered statement can carry nothing but digits.

**Mixed path depth (ruling 5f).**
Not in this engine's relation set.
The kinds that have columns are all addressed `[database, name]`; `trigger` is the one kind here with a
second possible depth, and it has no columns, so the target set is one shape.

The three detail reads repeat the target subquery rather than joining a temporary of it, and that is safe for
one measured reason: a table name is unique within a database, so `ORDER BY TABLE_NAME` is a TOTAL order and
all four statements cut the same set.
Rows for the extra `limit + 1` object are dropped in code, since the target list is what says which objects
the answer is about.
One statement for all four is not reachable here: mysql2 sends one statement per call, and `JSON_ARRAYAGG`
has no ordering guarantee at all, so the column order a person reads would become the order the optimizer
happened to produce.

An empty container costs ONE round trip rather than four.

Rebuilding the 200-table database the timing above was measured on, so the number is re-runnable rather than
asserted:

```sql
DROP DATABASE IF EXISTS bulk26a1; CREATE DATABASE bulk26a1;
DELIMITER //
CREATE PROCEDURE bulk26a1.seed()
BEGIN
  DECLARE i INT DEFAULT 0;
  WHILE i < 200 DO
    SET @s = CONCAT('CREATE TABLE bulk26a1.t', LPAD(i,3,'0'),
                    ' (id INT PRIMARY KEY, a VARCHAR(20), b DECIMAL(10,2), KEY ix_a (a))');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
    SET i = i + 1;
  END WHILE;
END //
DELIMITER ;
CALL bulk26a1.seed();
```

#### Object source (#789)

`readObjectSource(path, kind, limit?)` answers one object's definition text as a document of named
parts. **Every kind either server declares can answer**, which makes this the one provider in the
fleet with no kind that declares nothing: MySQL's six and MariaDB's eight each have a `SHOW CREATE`
form. The Monaco language id is `mysql` on all eight; `mysql` is an id the installed monaco-editor
0.57.0 bundle really registers, unlike `plsql`, `tsql` and `cql`.

Measured 2026-09-13 on **MySQL 26.7.0** and **MariaDB 12.3.2** against the two committed fixtures.

| Kind | Statement | Reply column | `form` | `origin` |
|---|---|---|---|---|
| `table` | `SHOW CREATE TABLE` | `Create Table` | `complete` | `regenerated` |
| `view` | `SHOW CREATE VIEW` | `Create View` | `complete` | `regenerated` |
| `procedure` | `SHOW CREATE PROCEDURE` | `Create Procedure` | `complete` | `stored` |
| `function` | `SHOW CREATE FUNCTION` | `Create Function` | `complete` | `stored` |
| `trigger` | `SHOW CREATE TRIGGER` | `SQL Original Statement` | `complete` | `stored` |
| `event` | `SHOW CREATE EVENT` | `Create Event` | `complete` | `stored` |
| `sequence` (MariaDB) | `SHOW CREATE SEQUENCE` | **`Create Table`** | `complete` | `regenerated` |
| `package` (MariaDB) | `SHOW CREATE PACKAGE` **and** `SHOW CREATE PACKAGE BODY`, two parts | `Create Package`, `Create Package Body` | `complete` | `stored` |

**The reply column is per statement, never per position.** The four routine forms disagree with each
other and with the table forms, and the sequence's is the one a reader would get wrong: it answers
`Table` and `Create Table`, NOT `Sequence` and `Create Sequence`, because a MariaDB sequence is a
table underneath. That is the same fact that puts it in `information_schema.TABLES` with
`TABLE_TYPE = 'SEQUENCE'`. A provider reading the guessable column finds `undefined` and emits a
refusal over a definition the server really returned, which is why every column above is pinned by a
test asserting the READ TEXT rather than only the statement.

**`origin` is split and it is a measurement.** A procedure, a function, a trigger, an event and a
MariaDB package come back as the author's own bytes, indentation included, so they are `stored`. A
table, a view and a MariaDB sequence are rebuilt from the dictionary: the fixture's
`CREATE TABLE customers (id INT NOT NULL, ...)` comes back as ``CREATE TABLE `customers` (`id` int
NOT NULL, ...) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4``, with backquoting and an `ENGINE=` clause
nobody typed, and `CREATE SEQUENCE invoice_number_seq START WITH 1` comes back carrying `minvalue`,
`maxvalue`, `cache` and `nocycle`. They are `regenerated`, and a reader must never be shown a
reconstruction as an original.

**A MariaDB package needs no `sql_mode=ORACLE`, and this provider does not set one.** MEASURED on
12.3.2: `SHOW CREATE PACKAGE` and `SHOW CREATE PACKAGE BODY` returned the full text under the image's
default `sql_mode`
(`STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION`),
byte-identical to the same statements after `SET SESSION sql_mode='ORACLE'`. This is written down
because the belief that ORACLE mode is needed is easy to re-derive from the reply itself: the row's
own `sql_mode` COLUMN carries
`PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ORACLE,...`, which is the mode the package was CREATED
under, a property of the stored object rather than a requirement on its reader. `SET sql_mode =
'ORACLE'` IS still required to `CREATE` a package, which is why the fixture sets it.

**A package is two statements and one node, specification first.** The order is the engine's own
asymmetry: a body cannot exist without a specification (`CREATE PACKAGE BODY` with no spec answers
`ERROR 1305`), and a specification can exist without a body. So reading the spec FIRST is what tells
a missing body apart from a missing package. A spec that is absent raises; a body that is absent
drops its part and the document carries one. `app.spec_only_pkg` in the MariaDB fixture is that
object. The two part ids and labels are the ones the Oracle provider uses, `spec` /
"Package specification" and `body` / "Package body", so a reader moving between the two engines reads
one vocabulary.

##### The refusals, and which words are whose

A caller holding `GRANT EXECUTE ON app.*` and nothing else is the measured refusal case, and it
splits in two. The fixtures create that user as `src_probe`, and it is **not reachable from the
primary connection**: the integration suite drives it by answering the measured errors from the
fixture rather than by connecting as `root`, and a live check needs a second connection as
`src_probe` / `src_probe`.

| Statement | What that caller gets |
|---|---|
| `SHOW CREATE PROCEDURE` / `FUNCTION` / `PACKAGE` / `PACKAGE BODY` | a ROW whose body column is **NULL** |
| `SHOW CREATE TABLE` | `ERROR 1142 SHOW command denied to user 'src_probe'@'localhost' for table 'orders'` |
| `SHOW CREATE VIEW` | `ERROR 1142 SELECT command denied to user 'src_probe'@'localhost' for table 'order_summary'` (this is the `SHOW VIEW` plus `SELECT` requirement in the server's own words) |
| `SHOW CREATE TRIGGER` | `ERROR 1227 Access denied; you need (at least one of) the TRIGGER privilege(s) for this operation` |
| `SHOW CREATE EVENT` | `ERROR 1044 Access denied for user 'src_probe'@'%' to database 'app'` |
| `SHOW CREATE SEQUENCE` | `ERROR 1142 SHOW command denied ...` |

Each raised sentence is carried into the part VERBATIM and unprefixed, never through
`mapDatabaseError`, and the reason to keep it verbatim rather than rebuild it is in the table:
MariaDB 12.3.2 qualifies the table name in 1142 and MySQL 26.7.0 does not.

**The NULL is the one refusal on this engine whose words are OURS**, because the server utters none.
The part says that the row's body column is NULL, that this is how the server reports a definition
the connected user may not read, and that the server supplied no sentence of its own. An empty or
whitespace-only text takes the same arm: an empty definition is not a definition, and it must never
reach an editor buffer as a blank document. This case is the direct refutation of the Phase 1 sketch's
claim that MySQL and MariaDB have "no unreadable case".

**A caller holding nothing at all never reaches this read.** MEASURED: that caller is told
`ERROR 1305 (42000) PROCEDURE order_archive does not exist`, which is byte-identical to what a
genuinely absent object answers, and it sees no row for the routine in `information_schema.ROUTINES`
either, so the tree never lists the object. It is deliberately not modelled as a refusal.

##### Absence RAISES, and the sentence is ours

| Statement, against a name nothing holds | errno and the server's sentence |
|---|---|
| `SHOW CREATE TABLE` / `VIEW` / `SEQUENCE` | 1146 `Table 'app.no_such_table' doesn't exist` |
| `SHOW CREATE PROCEDURE` / `FUNCTION` / `PACKAGE` / `PACKAGE BODY` | 1305 `PROCEDURE no_such_procedure does not exist` |
| `SHOW CREATE TRIGGER` | 1360 `Trigger does not exist` |
| `SHOW CREATE EVENT` | 1539 `Unknown event 'no_such_event'` |
| `SHOW CREATE VIEW app.orders` (a name of another kind) | 1347 `'app.orders' is not VIEW` (MySQL) / `is not of type 'VIEW'` (MariaDB) |
| `SHOW CREATE SEQUENCE app.orders` | 4089 `'app.orders' is not a SEQUENCE` |

A `QueryError` naming the object and its database is raised, never a document and never a refusal
part. The sentence is OURS here and 1360 is why: `Trigger does not exist` names neither the object
nor the database, so a message that named nothing could not tell a reader which read failed. The
1347 and 4089 rows are a live case rather than a defensive one, because a name really can address
objects of two kinds in one database on this engine (see the namespace measurement above).

Anything that is neither classified errno RAISES through `mapDatabaseError`, and the narrowness is
the point: a transport failure is nobody answering at all, and rendering "Lost connection to MySQL
server" in the Source pane as this object's own refusal would present a symptom as a fact about the
object.

##### The escaper, and why a bind is not available

`SHOW CREATE ...` has NO parameterised form, so this is one of the three engines in the fleet where a
caller-supplied name reaches statement TEXT. The address is built with
`SQLBaseProvider.escapeIdentifier`
([`sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)), which doubles the backtick, and
doubling alone is SUFFICIENT here rather than assumed to be. Measured on MariaDB 12.3.2:

```sql
CREATE TABLE app.`bs_one\` (id INT);
SELECT TABLE_NAME, LENGTH(TABLE_NAME) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = 'app' AND TABLE_NAME LIKE 'bs%';   -- bs_one\   7
SHOW CREATE TABLE app.`bs_one\`;                          -- answers the table
CREATE TABLE app.`tick``y` (id INT);
SHOW CREATE TABLE app.`tick``y`;                          -- round-trips as `tick``y`
```

The backslash is a LITERAL character inside a backtick-quoted identifier and the closing backtick
still closed the identifier, which is the direct contrast with ClickHouse, where a backslash IS an
escape in both quoting forms and the shared escaper is unsafe. Those two objects are NOT in the
mounted fixture, deliberately: adding a table would move the `table` count and the MariaDB
collation-ordering measurement recorded under `describeObjects()` above, neither of which this work
re-measured. The escaper is pinned in the suite by a statement-text assertion instead, and the two
statements above reproduce the engine measurement in a scratch database.

##### The trigger's parent segment is an address, not a bind

A trigger's path is `[database, table, trigger]`, and `SHOW CREATE TRIGGER` addresses
`<database>.<trigger>`. The parent is not in the statement because a trigger name is unique per
DATABASE on this engine (measured, `ER_TRG_ALREADY_EXISTS` above), so it is part of the address the
tree draws rather than part of the read.

##### MariaDB's `package` and `sequence` declare source and are not reachable from the tree

Both kinds declare `hasSource`, and neither folder is drawn in the standalone tree today, for the
`provider-meta` reason in [§1.1](#11-mariadb-and-the-other-mysql-protocol-engines). The declaration
is kept because it is true about the ENGINE: a connected provider answers both kinds and the source
route reaches them. Withholding it would be a second wrong declaration rather than a safer one.

#### Object edit (#789)

This engine is a REFUSAL, and the reason is that no non-destructive strategy exists for its routines.
`CREATE OR REPLACE` is three separate `ERROR 1064` here, on `procedure`, on `function` and on `trigger`, and `ALTER PROCEDURE` and `ALTER FUNCTION` take characteristics only, so nothing on this engine can replace a routine body in place.
Two kinds are DEFERRED rather than refused and both are safe: `CREATE OR REPLACE VIEW` works, and `ALTER EVENT ... DO` preserves the materialised `STARTS` timestamp instead of restarting the schedule.
Every routine is additionally refused while the DEFINER question is open: keeping the definer needs `SET_ANY_DEFINER` on MySQL and `SET USER` on MariaDB, the same errno 1227 under two different privilege names, neither is enough for a `SYSTEM_USER` definer, and stripping it silently transfers the object's security principal to the pooled Studio credential.
MariaDB carries one PERMANENT refusal of its own on top of those: `CREATE OR REPLACE PACKAGE` against a package SPECIFICATION destroys the PACKAGE BODY, on byte-identical spec text, and reports success, and no strategy re-creates the body in the same call.
No kind here declares `acceptsSourceEdits`, and `tests/isolated/object-edit-declarations.test.ts` is what holds that absence and this section together: it drives the MariaDB branch separately, because an unconnected provider answers the MySQL six and would never reach `package` at all.

#### The fixture, and running it

[`docker/mysql-init/01-object-fixture.sql`](../../docker/mysql-init/01-object-fixture.sql) and
[`docker/mariadb-init/01-object-fixture.sql`](../../docker/mariadb-init/01-object-fixture.sql) are
mounted at `/docker-entrypoint-initdb.d` by the `mysql` and `mariadb` services in
[`database-compose.yml`](../../database-compose.yml). Each image runs its file once, on a FRESH data
directory only, so an already-initialized container has to be recreated before an edit takes effect.
They build one object of every kind the respective server declares, in a database called `app`, plus a
second database `reporting` so the container list has something to show that the connection did not
open against, and a cross-database foreign key from `app.orders` into `reporting.regions`.

`DELIMITER` in those files is a CLIENT command and is correct there because the `mysql` client is
what runs them. It must never be sent through mysql2, which takes one statement per call and has no
notion of it. `SET sql_mode = 'ORACLE'` is REQUIRED for `CREATE PACKAGE` and rewrites the grammar of
everything after it, which is why it is the last thing in the MariaDB file. Reading a package needs
no such mode; see the object source section above.

Both files also create `src_probe`, a user holding `GRANT EXECUTE ON app.*` and nothing else, which
is the source read's measured refusal case, and the MariaDB file adds `app.spec_only_pkg`, a package
specification with no body, which is the one-part shape of the source document. Neither is reachable
from the primary connection: connect as `src_probe` / `src_probe` to see the refusals.

---

## 8. Monitoring & health

All monitoring reads from `SHOW STATUS`/`SHOW VARIABLES`, `information_schema`, and
`performance_schema`. `getMonitoringData()` (inherited) fans these out in parallel.

| Method | Primary source | Notes |
|--------|----------------|-------|
| `getHealth()` | one bare `SHOW STATUS` (`Threads_connected` picked client-side), `information_schema.TABLES`/`PROCESSLIST`, `performance_schema` | connections, size (MB), InnoDB buffer hit %, top-5 slow queries, 10 sessions |
| `getOverview()` | `VERSION()`, one bare `SHOW STATUS` (`Uptime` and `Threads_connected` out of the same result), `SHOW VARIABLES LIKE 'max_connections'`, `information_schema` | version, uptime, conns, max_conns, size, table/index counts |
| `getPerformanceMetrics()` | `performance_schema.global_status`, one bare `SHOW STATUS` (`Innodb_deadlocks` picked client-side) | cache-hit %, **queries/sec** (`Queries`/`Uptime`), buffer-pool %, deadlocks. Every field optional — see the degradation note below |
| `getSlowQueries()` | `performance_schema.events_statements_summary_by_digest` | per-digest stats |
| `getActiveSessions()` | `information_schema.PROCESSLIST` | pid, user, db, host, command, duration |
| `getTableStats()` | `information_schema.TABLES` | sizes; bloat **estimated from `DATA_FREE`** (no live/dead tuples, no last-vacuum/analyze) |
| `getIndexStats()` | `information_schema.STATISTICS` + `mysql.innodb_index_stats` | columns, unique/primary; **`scans` = `CARDINALITY`** (a proxy, not a real scan counter); per-index size, or **absent** — see the index-size note below |
| `getStorageStats()` | `information_schema.TABLES`, `SHOW BINARY LOGS` | Data size, Binary Logs (if enabled), InnoDB data file (size `N/A`) |

**No monitoring read sends `SHOW STATUS LIKE '…'`, and that is a portability fix, not a style
choice.** The whole list is read once per method and the wanted variables are picked out of it by
`Variable_name`, matched case-insensitively, which is how the server-side `LIKE` matched. Measured
2026-09-06 over mysql2 3.24.2's text protocol against `apache/doris:all-in-one-4.1.3`: `SHOW STATUS
LIKE 'Uptime'` answers `errno=1105 code=ER_UNKNOWN_ERROR sqlState=HY000`, *mismatched input 'LIKE'
expecting {&lt;EOF&gt;, ';'}(line 1, pos 12)*, because the Doris grammar has no `LIKE` clause on this
statement, while a bare `SHOW STATUS` is accepted there. So the Overview and Health panels failed
outright on Doris for a filter the statement does not need ([#573](https://github.com/libredb/libredb-studio/issues/573)).
`SHOW VARIABLES LIKE 'max_connections'` **stays**: Doris rejects the clause on `SHOW STATUS` only,
and the narrowest fix changes only what a grammar refuses. `getOverview()` also costs one round trip
fewer than before, reading uptime and connections out of the same result set.

**Database size is absent, never zeroed, when it is not measured.** `getOverview()` sizes the
database with `SUM(DATA_LENGTH + INDEX_LENGTH)` over `information_schema.tables`. A missing result
row, or a row without the `size_bytes` column, is no measurement at all: `databaseSizeBytes` is
omitted and `databaseSize` stays `"N/A"`. Only a returned SQL `NULL` — an empty database — is a
measured zero, and that reading is published as `0`/`"0 B"`.

**Graceful degradation — note the *different* failure modes:**
- `getHealth()` slow-queries: the digest rows, or **an empty list** — never a placeholder row, and
  on this path **the reason is dropped**. It used to answer a single fabricated row
  (*"Performance schema not available"*, `calls: 0`) whenever its statement threw, and its statement
  threw on every server: see
  [the slow-query line asked for a column the digest table does not have](#the-slow-query-line-asked-for-a-column-the-digest-table-does-not-have)
  below. `HealthInfo.slowQueries` is a `SlowQuery[]` with no error field and no sibling carrying one,
  so an unreadable source is indistinguishable here from a source that measured nothing. Empty is
  the least-wrong shape, not a shape that carries the reason — the operator gets the reason from the
  `getSlowQueries()` path below, which does have a channel for it.
- `getHealth()` cache-hit ratio: `formatCacheHitRatio()` → `"N/A"` when nothing was measured, and
  `"N/A"` again — rather than a failed health read — when the ratio query THROWS. A tenant can be
  missing the `performance_schema` *database* instead of merely having the schema off, and then the
  query does not answer NULLs: measured 2026-08-20 on a live OceanBase Community Edition 4.4.2.1
  tenant through this provider, and reproduced on `mysql:latest` as `ERROR 1049 (42000): Unknown
  database '...'`. That one throw used to abort the whole of `getHealth()`, so the panel showed
  nothing where one unavailable metric was the honest answer.
- `getSlowQueries()`: **the digests, or the server's refusal — this one does not swallow.** It used
  to `return []` on any throw, which made a source that cannot be read look like a source that
  measured nothing. What throws here is never the `performance_schema`-is-off path — an off server
  answers 0 rows without raising — it is the source being *unreadable*: no `performance_schema`
  database (`ERROR 1049`), or the grant denied on it (`ERROR 1142`). Letting that reject is what
  puts the reason on screen: `getMonitoringData()`
  ([`base-provider.ts`](../../src/lib/db/base-provider.ts)) reads every panel with
  `Promise.allSettled` and records a rejected one under `errors.slowQueries`, and `QueriesTab`
  renders that through `PanelUnavailable` carrying the server's own sentence. One refused panel
  costs only itself; that method throws only when all four core reads reject.
- `getPerformanceMetrics()`: **every field is omitted rather than defaulted.** A server with
  `performance_schema` OFF answers the `global_status` sub-selects with NULL instead of failing, so
  each reading is taken through `measuredNumber()` and a field with nothing behind it is left out of
  the object entirely. `deadlocks` comes from `SHOW STATUS`, which answers either way, so a `0` there
  is a real measurement and is reported *where the server publishes one*. If the
  `performance_schema` database is absent outright — the OceanBase case above, where every one of
  these queries raises `ERROR 1049` — the whole method returns `{}` rather than the `cacheHitRatio:
  99` it once did. This is the rule #448 and #452 settled: ABSENCE and
  ZERO are different inputs, and only the first is invisible to the panels.
- `deadlocks` reads the `Innodb_deadlocks` row of `SHOW STATUS`, which is **MariaDB's** status
  variable. MySQL does not publish it: re-measured 2026-09-06, MySQL 26.7.0's 528 status rows carry
  no such name where MariaDB 12.3.2's 571 do, so the field is absent on MySQL and present on
  MariaDB. It is the one metric that survives `performance_schema` being off.
- **An unpublished status variable is an ABSENT reading, never a zero.** A bare `SHOW STATUS` is
  accepted on every MySQL-wire engine measured 2026-09-06 but the lists differ wildly: MySQL 26.7.0
  528 rows, MariaDB 12.3.2 571, SingleStore 9.1.1 75, TiDB 8.5.1 13, StarRocks 3.3.22 0 and Apache
  Doris 4.1.3 0. TiDB publishes `Uptime` and not `Threads_connected`; StarRocks and Doris publish
  neither. So `activeConnections` is **omitted** from both `HealthInfo` and `DatabaseOverview` when
  the row is missing, and `startTime` is omitted with `uptime: "N/A"` when `Uptime` is. The panels
  render *N/A / not published* rather than a confident `0`, which is what they showed before (#477
  and the docblocks in [`types.ts`](../../src/lib/db/types.ts)). `maxConnections` is the documented
  exception and stays a required number: `0` there **means** "no limit published", so absence and
  zero are the same fact. Its old `|| "151"` default reported MySQL's compiled-in ceiling for every
  server that published none, including StarRocks and Doris, whose `SHOW VARIABLES LIKE
  'max_connections'` answers 0 rows, while TiDB publishes a real `0`.

### The slow-query line asked for a column the digest table does not have

`getHealth()`'s slow-query line had its own statement, `LEFT(sql_text, 100)` over
`performance_schema.events_statements_summary_by_digest`, wrapped in a bare try/catch that reported
`[{ query: "Performance schema not available", calls: 0, avgTime: "N/A" }]`. **That table has no
`sql_text` column.** `SQL_TEXT` belongs to `events_statements_current`/`_history`; the digest table
carries the normalised `DIGEST_TEXT` — [MySQL 9.4 manual, Statement Summary
Tables](https://dev.mysql.com/doc/refman/9.4/en/performance-schema-statement-summary-tables.html),
and each server's own `information_schema.columns` confirms it. So the statement never returned a
row on any server, and the catch reported an engine capability as absent while the panel beside it
listed real statements from the same table.

Measured 2026-08-27 through this provider, one container per arm (`--innodb-use-native-aio=0`;
readiness gated on a real `SELECT 1`, not `mysqladmin ping`). The raw statement's answer on all four:

```
errno=1054 code=ER_BAD_FIELD_ERROR sqlState=42S22 Unknown column 'sql_text' in 'field list'
```

(MariaDB words the same error `Unknown column 'sql_text' in 'SELECT'`.)

| Server | `@@performance_schema` | `getHealth().slowQueries` before | after | `getSlowQueries()` |
|--------|------------------------|----------------------------------|-------|--------------------|
| MySQL 26.7.0 (`mysql:latest`) | 1 | *"Performance schema not available"* | 5 real digests — ``SELECT COUNT ( * ) FROM `t` `` at `calls: 4`, `1.09ms` | 5 rows |
| Percona Server 8.4.11-11 | 1 | *"Performance schema not available"* | 5 real digests | 5 rows |
| MySQL 26.7.0, `--performance-schema=OFF` | 0 | *"Performance schema not available"* | `[]` | `[]` |
| MariaDB 12.3.2 (ships it off) | 0 | *"Performance schema not available"* | `[]` | `[]` |

Three decisions came out of those measurements, and one property of the reading that none of them
changes.

**One statement, not two.** The health line and `getSlowQueries()` now share
`SLOW_QUERIES_BODY_SQL`, differing only in the interpolated `LIMIT` (5 for the health line, the
caller's for the panel), and both map the row through the same `toSlowQueryStats()`. Two statements
for one fact is what drifted, and the copy the health panel used was the one no test ever put in
front of a server — the mysql2 mock invented a `query` column for any statement over this table, so
a broken read looked like a working one for as long as it was only mocked. The mysql2 mock in
`mysql-provider.test.ts` now refuses `sql_text` the way a server does, one test asserts the provider
never asks for it, and a construction in the mock's single call funnel records any fixture that
answers such a statement instead of refusing it ([§12.1](#121-how-the-tests-work)).

**An empty list, not an "unavailable" marker, and the reason is that OFF does not raise.** A server
with `@@performance_schema` = 0 keeps the digest table selectable and answers **0 rows** — measured
on both arms above, and it is why MariaDB's default has always shown an empty Queries panel rather
than an error. There is therefore no exception that means "the capability is off", and a marker
keyed on the throw would be emitted for something other than what it says: the same defect one level
up. What does reach the catch is the source being *unreadable* — no `performance_schema` database at
all (`ERROR 1049`, the OceanBase tenant above) or the grant denied on it: measured on MySQL 26.7.0
with a user granted only `SELECT ON d32.*` plus `PROCESS`,

```
errno=1142 code=ER_TABLEACCESS_DENIED_ERROR sqlState=42000
SELECT command denied to user 'nops'@'172.17.0.1' for table 'events_statements_summary_by_digest'
```

and on that connection `getHealth()` still answered in full (`activeConnections: 1`, `databaseSize:
"0.02 MB"`, `cacheHitRatio: "94.3"`, one active session) with `slowQueries: []`.

**Why the refusal is not carried in this field: on the health path it is dropped.** A refusal must stay
representable as a refusal (#477), and a row is the one shape it must not take: `calls: 0` is a
figure nobody took, and the list was *counted* — the agent's curated health reading then forwarded
`health.slowQueries.length` as `slowQueryCount`
([`src/lib/agent/tools.ts`](../../src/lib/agent/tools.ts)), so the invented row told the model
"1 slow query" about every MySQL-family server. That projection no longer carries any length, so a
row invented here would now be silent rather than counted — which is a reason to keep it out, not a
reason it could come back.

Dropped is the honest word for it, and this paragraph says so rather than naming a carrier the
reading does not have. `HealthInfo.slowQueries` is a `SlowQuery[]`: no error field, no sibling that carries one, so a
refusal cannot be represented in this reading at all. Nothing renders it either — no component reads
`HealthInfo.slowQueries` (the monitoring Queries and Overview tabs read `MonitoringData.slowQueries`,
a different reading), and the one caller of `POST /api/db/health`, the 60s connection pulse in
[`use-connection-manager.ts`](../../src/hooks/use-connection-manager.ts), reads `res.ok` and
discards the body. `ProviderLabels.slowQueriesEmptyState` is **not** a carrier for it: `QueriesTab`
renders that one fixed sentence for every empty list whatever produced it, which is why the sentence
had to stop naming a cause (it used to end *"enable the Performance Schema to see them"* — the one
cause that never reaches the failure path).

The operator is not left without the reason, because the *panel* path has a channel:
`getSlowQueries()` lets the refusal reject (it used to `return []`), `getMonitoringData()`
([`base-provider.ts`](../../src/lib/db/base-provider.ts)) records it under `errors.slowQueries`, and
`QueriesTab` renders it through `PanelUnavailable` with the server's own sentence. The
grant-denied and `ERROR 1049` fixtures in `mysql-provider.test.ts` assert exactly that division: the
health line empties, `getSlowQueries()` rejects, and `errors.slowQueries` names the table.

**One property of the reading the repair does not change: the list is a cap, not a count.**
`SLOW_QUERIES_BODY_SQL` has no slowness predicate anywhere — its only `WHERE` term is the connected
schema, "slow" is the *ordering* (`SUM_TIMER_WAIT DESC`), and the health line's `LIMIT` is 5. So on
any server with five or more digests for the schema, `health.slowQueries.length` is 5 permanently,
and any consumer counting it reads the limit rather than a number of slow statements. Measured 2026-08-27
on MySQL 26.7.0 (`libredb-mysql`): the digest table held **59 rows** for one connected schema, and
the five this statement returns for it were **all Studio's own introspection statements** — the
slow-query read itself first (`avg 79.11ms`, `calls 3`), then the database-size read, `SHOW STATUS
LIKE ?` and two `PREPARE`s, between 1.15 ms and 7.78 ms. Nothing in that list is slow and none of it
is the user's workload. Raising the limit would move the saturation point without making the figure a
count; only a slowness threshold, or a differently named projection, would. The agent's curated
health reading has since stopped projecting the length at all — it declares
`activeConnections`, `databaseSize` and `cacheHitRatio` only, and the slow-query facts travel on the
`slow-queries` reading, where the rows are visible
([`src/lib/agent/tools.ts`](../../src/lib/agent/tools.ts)) — so this provider's part is that the cap
and the missing threshold are stated at
[`HEALTH_SLOW_QUERY_LIMIT`](../../src/lib/db/providers/sql/mysql.ts) and pinned by a test that reads
the statement the health call actually issued.

**Sibling engines.** All nine MySQL-protocol engines in
[`compatibility.ts`](../../src/lib/db/compatibility.ts) — MariaDB, Percona Server for MySQL, TiDB,
StarRocks, Apache Doris, Databend, Vitess, OceanBase, SingleStore — reach this exact code, so every
one of them showed the sentence and none of them shows it now. MariaDB and Percona are the two
measured above; on the other seven the health line now carries whatever their own
`performance_schema.events_statements_summary_by_digest` publishes for the connected schema, and an
empty list where it publishes nothing or the table cannot be read. OceanBase is the one whose reading
changes shape without changing meaning: its tenants have no `performance_schema` database at all
(`ERROR 1049`, measured 2026-08-20), so its health line goes from the fabricated row to `[]` — and
its Queries panel, which took the same `[]` before, now shows the tenant's own `ERROR 1049` through
`PanelUnavailable`, because `getSlowQueries()` no longer swallows it.

**Index sizes: `mysql.innodb_index_stats`, and `indexSizeBytes` may be absent.** The per-index byte
figure is `stat_value * @@innodb_page_size` for the `stat_name = 'size'` row of the InnoDB
persistent-statistics table, matched to the `information_schema.STATISTICS` row on
database/table/index name. Three consequences, all measured on 2026-08-23:

- **No `INNODB_*` view publishes it.** The former statement summed
  `information_schema.INNODB_TABLESPACES.INDEX_SIZE`, a column that exists on neither MySQL 26.7.0
  nor the MySQL 8.0 inside Vitess 24.0.2 (`ER_BAD_FIELD_ERROR` on both), so *every* index reported
  `0 B` on every server. It also grouped by `(t.NAME, i.NAME)` while selecting a tablespace total,
  which made the figure per-table even when the query worked.
- **The schema is the one the server reports, not the one you connected to.** Vitess answers
  `information_schema.STATISTICS` with the physical shard database — `vt_probe_0`, not the keyspace
  `probe` — so the size lookup uses the `TABLE_SCHEMA` value just returned. With that, a per-index
  size on Vitess reads the same 16 KB as the MySQL control; the old `LIKE 'probe/%'` matched nothing.
- **A missing row means unavailable, not empty.** Reading `mysql.innodb_index_stats` needs `SELECT`
  on the `mysql` schema (`ER_TABLEACCESS_DENIED_ERROR` for a user granted only its own database), and
  MyISAM tables have no row there at all. In both cases `indexSizeBytes` is **omitted** and
  `indexSize` is `"N/A"`, rather than a `0 B` the server never reported.

**The storage panel's index total is the per-TABLE figure, not the sum of those per-index rows.**
InnoDB has no separate primary-key index: the clustered index IS the table, so
`mysql.innodb_index_stats` reports the `PRIMARY` row's size as the row data and summing every index
row counts that data twice. Measured on MySQL 26.7.0 against a 144 KB database, the sum read
147,456 B — 49,152 of data plus 98,304 of indexes — which drew *Indexes* as 100% of the database and
a remainder of `-49152 B`. `getTableStats()` carries `INDEX_LENGTH` as `indexSizeBytes` (it computed
that number and dropped it before 2026-08-23, which is why the panel had nothing to add up), and
that is what MySQL itself calls index bytes.

---

## 9. Maintenance

`runMaintenance(type, target?, container?)` ([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)); targets
are backtick-quoted via `escapeIdentifier()`. A `container` is the DATABASE the row carries as
`schemaName` (#772), and it qualifies the target only when it names a database OTHER than the
connected one: a MySQL statement already resolves a bare table inside the connected database, so
the same name as a prefix adds nothing.

`getTableStats()` and `getIndexStats()` report as `schemaName` the `TABLE_SCHEMA` the server echoes
only when it is the database the read was FILTERED on, compared without regard to case, and the filter
otherwise. The case rule is for `lower_case_table_names=1`: a connection configured as `App` reads rows
named `app`, which is the spelling the tree's containers carry and the Operations tab matches against.
On Vitess the echo is the physical shard (`vt_e2e_0` for the keyspace `e2e`, measured 2026-10-04 on 24.0.4), and while it was
reported, Analyze Table from Monitoring > Tables sent `ANALYZE TABLE vt_e2e_0.customers`, which vtgate
refuses with `VT05003: unknown database 'vt_e2e_0' in vschema`. The shard name is still what the
per-index size lookup reads (section 8), because that is how InnoDB names the table there.

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `ANALYZE TABLE <t>` | `ANALYZE TABLE <all base tables, ≤50>` |
| `optimize` | `OPTIMIZE TABLE <t>` | `OPTIMIZE TABLE <all base tables, ≤50>` |
| `check` | `CHECK TABLE <t>` | `CHECK TABLE <all base tables, ≤50>` |
| `kill` | `KILL <connection-id>` | throws (id required) |

`getCapabilities().maintenanceOperations = ['analyze', 'optimize', 'check', 'kill']`. `kill`
validates that the target parses as an integer connection id.

### The verdict is in the result set, not in the absence of an exception

On MySQL, `ANALYZE`, `OPTIMIZE` and `CHECK TABLE` answer a **result set**, one row per (table, message)
with `Table` / `Op` / `Msg_type` / `Msg_text`, and a statement the server refuses resolves
normally. Measured through the driver against MySQL 26.7.0 (`libredb-mysql`) on 2026-08-25:

| Statement | Rows MySQL answers |
|-----------|--------------------|
| `OPTIMIZE TABLE \`real1\`` | `note` *"Table does not support optimize, doing recreate + analyze instead"*, then `status` *"OK"* |
| `OPTIMIZE TABLE \`missing\`` | `Error` *"Table 'u9t.missing' doesn't exist"*, then `status` *"Operation failed"* |
| `CHECK TABLE \`real1\`` | `status` *"OK"* |

So `await runStatement(conn, sql); return { success: true }` reported a completed operation for
a statement the server had rejected — `optimize u9t` answered
`{"success":true,"message":"OPTIMIZE completed successfully"}` while the server's own answer was
Error / *"Table 'u9t.missing' doesn't exist"* / *"Operation failed"* — and it discarded the
`Msg_text` that is the entire point of `CHECK TABLE`, whose OK-or-corruption-report is the only
thing the user asked for. `readMaintenanceReport()` reads those rows:

- **any row with `Msg_type` = `error`** (matched case-insensitively; the server sends `Error`,
  the manual documents the set in lower case) → `success: false`, and the message quotes those
  rows **with their table names**, because the whole-database form names every table in one
  statement and a per-table Error row is the only place the failure appears;
- **otherwise** → `success: true`, and the message quotes the engine's own texts, deduplicated:
  over forty tables the OK and InnoDB's *"doing recreate + analyze instead"* note repeat once
  per table and say the same thing forty times.

After the fix, through the provider: `check real1` → *"CHECK: OK"*, `optimize missing` →
`success: false` *"OPTIMIZE failed: u9t.missing: Table 'u9t.missing' doesn't exist"*. This is the
same read SQLite's `check` already did with `PRAGMA integrity_check`.

**Some relatives answer with an OK packet, not a report.** Measured through mysql2 3.24.2 on
2026-10-04, a table named `big`:

| Server | `ANALYZE TABLE big` | `OPTIMIZE TABLE big` | `CHECK TABLE big` | a missing table |
|--------|---------------------|----------------------|-------------------|-----------------|
| MySQL 26.7.0 (`mysql:latest`) | rows, `status` *"OK"* | rows, `note` + `status` *"OK"* | rows, `status` *"OK"* | `Error` row, as above |
| TiDB v8.5.8 (`pingcap/tidb:v8.5.8`) | OK packet, `warningStatus` 1 (a sample-rate Note) | throws 8200 *"OPTIMIZE TABLE is not supported"* | throws 1064 (syntax) | throws 1146 |
| OceanBase CE 4.4.2.1 (`oceanbase/oceanbase-ce:latest`) | OK packet | OK packet | rows, `status` *"OK"* | throws 1146 |
| Databend v1.2.925 (`datafuselabs/databend:v1.2.925-patch-13`) | OK packet | throws 1105 (syntax: wants `ALL`, `PURGE` or `COMPACT`) | throws 1105 (syntax) | throws 1105 *"Unknown table"* |

On an OK packet mysql2 hands back a `ResultSetHeader` object, not an array, and the reader called
`.filter` on it, so Analyze on TiDB, OceanBase and Databend, and Optimize on OceanBase, failed the
route with 500 *"rows.filter is not a function"*. These servers refuse a table by throwing, so a
header carries no failure to read: `readMaintenanceReport()` answers `success: true` with
*"ANALYZE completed; the server returned no report"*, and says the same for a result set with no
row. When the OK packet counts warnings the message names them, *"(1 warning, see SHOW
WARNINGS)"* on TiDB, whose sample-rate Note is only there; this read does not send `SHOW WARNINGS`
itself. A refusal that throws reaches the caller as the engine's own error, unchanged. The TiDB and Databend rows that throw are
actions offered on an engine that does not run them; that is a separate defect.

**A database with no tables runs no statement.** `OPTIMIZE TABLE ${getAllTablesForMaintenance()}`
string-joined an empty list, and MySQL answered *"You have an error in your SQL syntax … near
''"* — measured through the provider against an empty database on 2026-08-25. Nothing to do is
not a failure and it is not a syntax error either, so the whole-database form now answers
`success: true` with *"OPTIMIZE: no tables in u9empty to run it on."* without sending anything.

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#496).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available. On MySQL it never speaks: every
declaration above is either both placements or neither, so no request can name a placement this
provider offers in one place only.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `analyze` | Analyze Table | yes | yes | `ANALYZE TABLE <t>`, or every table via `getAllTablesForMaintenance()` |
| `optimize` | Optimize Table | yes | yes | `OPTIMIZE TABLE <t>`, same loop without a target |
| `check` | Check Table | yes | yes | `CHECK TABLE <t>`, same loop without a target |
| `kill` | Kill Connection | no | no | the target is a connection id from the Sessions panel |

MySQL has no `VACUUM`, and the base labels put *"Vacuum Table"* in the explorer's row menu
and *"Run Vacuum" / "Reclaim Space"* on the Operations tab anyway. The labels now say
*"Optimize Table"* / *"Run Optimize" / "Optimize Tables"*, and `vacuumActionOperation:
'optimize'` is what makes the surfaces send `optimize` for them - the global card used to be
gated on the literal `vacuum`, so MySQL's own wording was written and never shown (#496).

---

## 10. Capabilities & labels

### `getCapabilities()` ([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` unless the server refuses both EXPLAIN grammars, measured at connect ([§5.5](#55-the-explain-grammar-is-measured-at-connect)) |
| `explainFormat` | `mysql-json` before `connect()` and on a server that accepts `EXPLAIN FORMAT=JSON`; `mysql-text` on one that accepts only plain `EXPLAIN` (TiDB, StarRocks, SingleStore, Doris); the key is ABSENT when both are refused, and `supportsExplain` is then `false` |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core MySQL DML |
| `supportsResultPagination` | `true` — `LIMIT n OFFSET m` from the shared limiter (#816) |
| `supportsTransactions` | `true`: the transaction runs on one held connection opened with `BEGIN` ([§6.0.1](#601-servers-that-report-no-transaction-state)), so the trio and the SANDBOX toggle are offered (#464) |
| `implicitCommitStatements` | `ALTER`, `ANALYZE`, `BEGIN`, `CACHE`, `CHANGE`, `CHECK`, `CREATE`, `DROP`, `FLUSH`, `GRANT`, `INSTALL`, `LOCK`, `OPTIMIZE`, `RENAME`, `REPAIR`, `RESET`, `REVOKE`, `START`, `STOP`, `TRUNCATE`, `UNINSTALL`, `UNLOCK`: the statements MySQL commits implicitly, which SANDBOX refuses before sending ([§6.0](#60-what-the-server-says-about-the-transaction)) |
| `implicitCommitExceptions` | `CREATE TEMPORARY`, `DROP TEMPORARY`, `ANALYZE SELECT`, `ANALYZE FORMAT`: matched by the list above and committing nothing ([§6.0](#60-what-the-server-says-about-the-transaction)) |
| `declaresForeignKeys` | `true` — inherited from the base capabilities; InnoDB declares them, so an empty list means this schema (or this role) has none, not the engine |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'optimize', 'check', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `3306` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |
| `containerLevels` | one level, `{ id: 'schema', label: 'Database', labelPlural: 'Databases' }` ([§7.1](#71-the-object-surface-789)) |
| `containerPathShapes` | `exact`: only `[database]` addresses a container, so a shorter or a longer path is refused, by the object routes over HTTP and by this provider for a caller that reaches it directly (#1147) |
| `objectKinds` | six on MySQL, eight on MariaDB, resolved from the server's own `VERSION()` string at connect and never from the type id ([§7.1](#71-the-object-surface-789)) |

### Labels

MySQL keeps the default SQL `getLabels()` from `BaseDatabaseProvider` (entity → *Table*, *Select Top
50*, etc.) for everything a person clicks. `analyzeAction` is one of them and is correct: MySQL runs
`ANALYZE TABLE`. The vacuum slot is not, and is overridden.

**The vacuum slot** ([mysql.ts](../../src/lib/db/providers/sql/mysql.ts)): `vacuumAction` →
*"Optimize Table"*, `vacuumGlobalLabel` → *"Run Optimize"*, `vacuumGlobalTitle` → *"Optimize
Tables"*, `vacuumGlobalDesc` → the OPTIMIZE TABLE sentence, and `vacuumActionOperation` →
`optimize`. MySQL has no `VACUUM`, so the base default put *"Vacuum Table"* in the explorer's row
menu and *"Run Vacuum" / "Reclaim Space"* on the admin Operations tab for an engine whose operations
are analyze/optimize/check/kill — and because that card was gated on the literal `vacuum`, no
wording MySQL could have declared would have been shown (#U9,
[§9](#where-each-operation-may-be-offered-maintenanceoperationspecs)).

**And one monitoring field**, `slowQueriesEmptyState`, returned by `getLabels()` ([`mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)):
`slowQueriesEmptyState` → *"Query stats come from
performance_schema.events_statements_summary_by_digest for this database. An empty list means it
recorded nothing - the Performance Schema is off, or nothing has run against this database yet."*
The monitoring Queries panel's empty state was hardcoded to PostgreSQL's `pg_stat_statements` advice
on every engine (#463) — an extension MySQL does not have under any name, while the
digest table this provider actually reads ([§8](#8-monitoring--health)) is a server switch a DBA can
act on.

---

## 11. Error handling

Native `mysql2` errors are mapped by the shared `mapDatabaseError()`
([errors.ts](../../src/lib/db/errors.ts)). What reliably maps for MySQL:

| Situation | Error |
|-----------|-------|
| Missing `host`/`database` (no connection string) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` (carries host/port) |
| Access denied (`ER_ACCESS_DENIED`, message contains *access denied*) | `AuthenticationError` |
| Connection refused / DNS (`ECONNREFUSED`, `getaddrinfo`) | `ConnectionError` |
| Killed query (*"Query execution was interrupted"*) | `QueryCancelledError` |
| Driver message contains *timeout* / *timed out* (e.g. `Lock wait timeout exceeded`, connection-acquire timeout) | `TimeoutError` |
| Other server errors (most `ER_*` codes) | `QueryError` / `DatabaseError` carrying the original message |

> The mapper is **text-heuristic**, so MySQL `ER_*` codes that don't match a known phrase fall
> through to a generic `QueryError`/`DatabaseError` with the driver's message preserved. Note the
> nuance on timeouts: a driver error whose message contains *timeout*/*timed out* **does** map to
> `TimeoutError` (the mapping is provider-agnostic). What MySQL lacks is a **server-side query
> timeout derived from `queryTimeout`** — the provider never configures one
> ([§3.5](#35-no-server-side-query-timeout)), so it won't auto-kill a long-running query on its own.

---

## 12. Testing

### 12.1 How the tests work

Integration tests live in
[`tests/integration/db/mysql-provider.test.ts`](../../tests/integration/db/mysql-provider.test.ts).
The `mysql2/promise` module is replaced with an in-process mock via `mock.module('mysql2/promise', …)`
**before** the provider is imported — there is no live MySQL in the suite. The mock's pool/connection
returns canned `[rows, fields]` tuples, exercising the same provider code paths as a real server.

Three mock shapes are load-bearing. A non-SELECT must be mocked as a **`ResultSetHeader` object with
`undefined` fields**, not as an array. An array-shaped mock is exactly what hid the
`result.rows.map is not a function` defect described in [§5.1](#51-execution) — the whole suite was
green while every DDL and DML statement failed against a real server.

A mock must also refuse what a server refuses, and **every** fixture must, not just the one written
for the defect. The default mock used to answer ANY statement over
`performance_schema.events_statements_summary_by_digest` with an invented `query`/`calls`/`avgTime`
row, which is how the broken health statement in
[§8](#the-slow-query-line-asked-for-a-column-the-digest-table-does-not-have) stayed green for as long
as it existed: it asked for a column no MySQL-family server has, and only the mock ever answered it.
About a hundred of the tests in the file run against that fixture, so the unfaithfulness was the
default condition of the suite rather than a gap in one test.

`sqlTextRefusal()` is the corrective, and all three digest fixtures answer with it —
`defaultMockExecute`, `perfSchemaDisabledMockExecute` and `digestTableMockExecute` — rejecting any
statement that names `sql_text` with the real `ER_BAD_FIELD_ERROR` (1054, `42S22`, re-verified
2026-08-27 against `libredb-mysql`) and otherwise returning the digest columns a server returns. The
OFF fixture is the one that shows why it has to be all three: while it answered `[[], []]` to the
broken statement too, *both* readings produced `[]`, so "the health line is empty on a server whose
Performance Schema is off" passed with the fix reverted — it modelled a server that does not exist.
On top of that, one test asserts independently of any fixture's kindness that no `getHealth()` read
names `sql_text` at all, and one reads the statement the health call issued to pin its `LIMIT 5` and
the absence of a slowness predicate.

That corrective was still unpinned, though, and said so: reverting `defaultMockExecute` to its
unfaithful shape left the suite at 111 pass / 0 fail, because every test that needs the refusal
installs a dedicated fixture. So the rule now lives where no fixture can opt out of it.
`UNANSWERABLE_STATEMENTS` is a list of statements no MySQL-family server accepts — one entry today,
the `sql_text` digest read, and each entry has to be a *measured* refusal, because a rule that
refuses what a server answers is the same defect with its sign flipped. It is evaluated in
`recordCall`, the one funnel every fixture in the file goes through (named, delegating and inline
alike). The match is a co-occurrence over the whole statement, which is wider than the measurement:
a join of the digest table against `events_statements_current` — which *does* have `SQL_TEXT` —
would trip it too. Nothing `mysql.ts` emits has that shape, so the over-match is recorded next to
the rule rather than paid for; the day a statement does, the rule narrows rather than gaining an
exception. A fixture that *answers* a listed statement is **recorded** rather than thrown at: a
throw from there would arrive inside `getHealth()`'s per-panel catch as a panel error the test under
way might legitimately be asserting, which is exactly where the original unfaithfulness did its
damage. A file-scope `afterEach`, file scope because the file has eight top-level `describe`s and a
hook inside one would leave seven unguarded, drains the recorded violations and fails the single
test that produced one.

Because `mysql.ts` no longer emits any statement naming `sql_text`, nothing else in the suite can
make that rule fire, so a `describe` at the end of the file drives it directly: one test installs an
unfaithful fixture and asserts the violation is recorded, and one installs the shared fixture and
asserts it *rejects* — which pins `defaultMockExecute`'s fidelity (deleting its refusal branch now
fails that test by name **and** the file-scope hook) and simultaneously proves the guard's `.then`
wrapper leaves a rejection a rejection.

Its reach is exactly the rules it carries, and only over statements a test actually sends. Deleting
`perfSchemaDisabledMockExecute`'s refusal branch, for instance, is **not** caught today: no test
installs that fixture *and* sends a `sql_text` statement, so nothing asks it the question. The guard
closes the door on a fixture that lies when asked; it does not interrogate fixtures nobody asks.
The list stays in this file rather than in `tests/helpers/` until a second engine has a measured
refusal of its own. The other sixteen provider test files would receive an empty rule list, which
proves nothing about their fixtures and reads as coverage. That condition is recorded in the list's
own docblock, where a second engine's implementer will meet it.

And the mock connection answers **both `query` and `execute`**, recording which one each statement
went through. A mock that only answered `execute` could not tell a statement routed to the text
protocol from one left on the prepared protocol, which is what
[§3.4](#34-which-wire-protocol-a-statement-takes) turns on: the `MySQLProvider wire protocol` block
pins the method for `getHealth`, `getOverview`, `getPerformanceMetrics`, the object reads,
`getStorageStats`, each maintenance statement, `cancelQuery`, the editor's own path (with and without
parameters), the Explain statement `mysqlJsonStrategy` builds, and the transaction path.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide, so files mocking different drivers
> would cross-contaminate if they shared one. They never do: `bun run test` gives every test file its
> own bun process, so a single file is safe and so is the whole suite, which is the same command CI
> runs. `bun run test:coverage` is that runner with coverage on. See [`CLAUDE.md`](../../CLAUDE.md).

### 12.2 Coverage

20+ describe blocks cover: validation (incl. connection-string bypass), connect/disconnect,
capabilities, the object surface (columns/FKs/indexes, primary-key detection), health, maintenance (all
types + kill validation), the full transaction lifecycle, `queryInTransaction`, query cancellation,
overview, performance metrics, slow queries, active sessions, table/index/storage stats, every SSL
branch, `prepareQuery`, error mapping (`ER_ACCESS_DENIED`, `ECONNREFUSED`), the non-SELECT envelope
(DDL, `INSERT`, `UPDATE`, `DELETE`, and the transaction path) driven from real `ResultSetHeader`
literals, the wire protocol each statement takes, and wide integers (the pool option on both
connection forms, and two ids differing only past 2^53 staying two values through `query()` and
through the JSON the API response is made of).

utf8mb3 decoding ([§3.8](#38-on-a-server-that-sends-utf-8-under-a-utf8mb3-label-utf8mb3-columns-are-read-as-utf-8))
is pinned in its own file,
[`tests/integration/db/mysql-wire-decoding.test.ts`](../../tests/integration/db/mysql-wire-decoding.test.ts),
because the mock above never runs mysql2's parsers. Nothing is mocked there: the real provider and the
real mysql2 pool talk to mysql2's own `createServer()`, run once as a server that labels UTF-8 text 33
and once as an honest one. It pins a value outside the BMP decoding right over the text and the
prepared protocol, a binary column staying bytes, a refusal failing exactly as on mysql2's own path
(`code`, `errno`, `sqlState` included), an unflagged pool decoding a 33 column as mysql2 alone does
while a flagged one is connected beside it, and mysql2's `CharsetToEncoding` table left as it ships
after every test. A second block runs every OK-packet shape on both servers and compares the driver's
header (`affectedRows`, `insertId`) and `rowCount`: `INSERT` over the text and the prepared protocol,
`UPDATE`, `DELETE`, `CREATE TABLE`, an `INSERT` inside `beginTransaction()`/`queryInTransaction()`
followed by a commit, and an answer that chains an OK packet, a result set and a closing OK packet;
after each, the same pool must still answer.

It also covers **the object surface** ([§7.1](#71-the-object-surface-789)) in two blocks. `object
surface` holds the seven conformance tests: the declared kinds and roles on each server, the
pre-connect declaration, the container list, and `assertObjectSurface` against the fixture's counts
on MySQL and again on MariaDB. `MySQL object listing and detail` holds the rest: the catalog read
behind each kind derived from the declaration, the counting statement's arms and exclusions, the
seeded zeros, a refused count as `{ unavailable }`, trigger nesting at both depths, the path sort,
the detail rows, the path-shape refusals, the three version-probe outcomes, and the namespace pair
that settles whether one path can carry two kinds.

**The MariaDB branch is driven by a MariaDB fixture and not by a flag.** `objectSurfaceFixture({
mariadb: true })` changes the string `VERSION()` answers and adds the two MariaDB-only row sets, and
nothing else, so a declaration that ignored the version string cannot produce two answers. Both
declarations were then re-measured end to end against live containers, `mysql:latest` on 33106 and
`mariadb:latest` on 33107, through the real `mysql2` driver.

### 12.3 Run it

```bash
bun test tests/integration/db/mysql-provider.test.ts   # just this file (single process — safe)
bun run test                                            # the whole suite, one process per file, what CI runs
bun run test:coverage                                   # CI coverage workflow: the same runner, with coverage
```

### 12.4 Optional: verifying against a live MySQL, and a live MariaDB

The compose services carry the object-browser fixture ([§7.1](#71-the-object-surface-789)), so this
is the way to get a server with one object of every declared kind on it:

```bash
docker compose -f database-compose.yml up -d mysql                     # localhost:3306, db=app, user=root
docker compose -f database-compose.yml --profile compat up -d mariadb  # localhost:3307, db=app, user=root
```

Point a connection at either one with type MySQL. MariaDB is the branch worth checking by hand,
because it is the one that declares Packages and Sequences. Either image runs its fixture once, on a
fresh data directory only, so a container that already exists has to be recreated first.

With both up, run the catalog-vocabulary guard against them
([§7.1](#71-the-object-surface-789)), which is the check that a future server has not grown a
`TABLE_TYPE` this provider silently drops:

```bash
LIBREDB_LIVE_MYSQL_URLS="mysql://root:root@127.0.0.1:3306/app,mysql://root:root@127.0.0.1:3307/app" \
  bun tests/live/mysql-object-vocabulary.ts
```

Two more live guards read the same fixture, and both exist for the same reason: their subject is what
an ENGINE emits, which a mock cannot settle. `mysql-column-type.ts` checks the `DATA_TYPE` /
`COLUMN_TYPE` split ([§7.1](#71-the-object-surface-789)) by replaying the generated `CREATE TABLE` at
the server that supplied its columns; `mysql-column-defaults.ts` checks the per-flavour default
reading, and on MariaDB replays each reported `COLUMN_DEFAULT` after the word `DEFAULT`. Both CREATE
and DROP throwaway tables in the database the URL names, so point them at a disposable server:

```bash
LIBREDB_LIVE_MYSQL_URLS="mysql://root:root@127.0.0.1:3306/app,mysql://root:root@127.0.0.1:3307/app" \
  bun tests/live/mysql-column-type.ts
LIBREDB_LIVE_MYSQL_URLS="mysql://root:root@127.0.0.1:3306/app,mysql://root:root@127.0.0.1:3307/app" \
  bun tests/live/mysql-column-defaults.ts
```

---

## 13. Usage examples

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'my1', name: 'App', type: 'mysql',
  host: 'localhost', port: 3306, database: 'app',
  user: 'root', password: 'secret', createdAt: new Date(),
});

await provider.connect();
const res = await provider.query('SELECT id, email FROM users WHERE active = ?', [1]);
const tables = await provider.listObjects(['app'], 'table');
const { details } = await provider.describeObjects(['app'], 'table');   // 4 statements
await provider.disconnect();
```

Over the API: `POST /api/db/query`, `POST /api/db/transaction`, `POST /api/db/cancel`,
`POST /api/db/maintenance` (admin), and `POST /api/db/objects/inventory`.

---

## 14. Known limitations & future work

- **No server-side query timeout.** The pool ignores `queryTimeout`; a runaway query is not
  auto-killed (only explicit `cancelQuery()`/`KILL QUERY`). *Future:* derive a per-statement
  `MAX_EXECUTION_TIME` (the SELECT execution limit) from `queryTimeout`. (Note `wait_timeout` is
  unrelated — it bounds idle connections, not query execution.)
- **Pool tuning is limited** to `max` (`connectionLimit`); `min`/`idleTimeout`/`acquireTimeout` are
  ignored.
- **Index `scans` is `CARDINALITY`**, an estimate of distinct values — not a real index-usage/scan
  counter (MySQL has no `pg_stat_user_indexes.idx_scan` equivalent).
- **Row counts (`TABLE_ROWS`) are engine estimates** for InnoDB, not exact counts.
- **Table bloat is estimated from `DATA_FREE`** (free space), an approximation.
- **`getPerformanceMetrics()` reports nothing when `performance_schema` is off.** The panels show
  the metrics as unmeasured rather than inventing values for them, which is correct but means a
  MariaDB server (see below) has no cache-hit, QPS or buffer-pool reading until it is started with
  `performance_schema=ON`.
- **`cancelQuery()` returns `true` on `KILL QUERY` success** without confirming the target was
  actually executing.
- **Cloud SSL auto-detect uses `rejectUnauthorized: false`** — encrypted but **not** authenticated
  (MITM-exposed). For verified TLS, set an explicit `connection.ssl` with mode `verify-system` (nothing
  to paste) or `verify-ca`/`verify-full`
  and a `caCert`.

---

## 15. References

- Driver: [`mysql2`](https://github.com/sidorares/node-mysql2)
- Source: [`src/lib/db/providers/sql/mysql.ts`](../../src/lib/db/providers/sql/mysql.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors: [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/mysql-provider.test.ts`](../../tests/integration/db/mysql-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [Trino](./trino.md) · [Redis](./redis.md)
