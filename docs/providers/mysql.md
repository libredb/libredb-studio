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
injection, `?` placeholders, cloud SSL auto-detection) and layers MySQL-specific introspection and
monitoring on top of `mysql2`.

The most useful way to read this doc is **as a diff against the [PostgreSQL provider](./postgres.md)**,
which is the SQL reference implementation. The headline differences:

| Aspect | PostgreSQL | MySQL |
|--------|------------|-------|
| Schema introspection | One `MATERIALIZED`-CTE round-trip + two-phase (`getSchemaList`/`getSchemaRelations`) | Single `getSchema()`, **N+1** (1 + 3 queries per table), **no** two-phase split |
| Schema scope | All non-system schemas, cross-schema FKs | **Single database** (`TABLE_SCHEMA = <db>`), bare table names |
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
answer with a plain MySQL number and give nothing to key on.

**`performance_schema` is OFF by default on MariaDB.** Measured on `mariadb:12.3`
(`@@performance_schema` = 0): the `performance_schema` tables exist, so the metric queries do not
fail — they return a row of NULLs. Cache-hit ratio, queries/sec and buffer-pool usage are therefore
absent rather than zero, and the slow-query list is empty. `information_schema`, `PROCESSLIST`,
`EXPLAIN FORMAT=JSON`, schema introspection, sizes and row counts are unaffected. Start the server
with `performance_schema=ON` to get the monitoring figures.

The one metric that goes the other way is `deadlocks`: it comes from `SHOW STATUS LIKE
'Innodb_deadlocks'`, which MariaDB publishes and MySQL does not, so it is the single performance
figure a default MariaDB reports and a MySQL server does not.

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

Loaded on demand by the factory ([`factory.ts:67`](../../src/lib/db/factory.ts)):

```ts
case 'mysql': {
  const { MySQLProvider } = await import('./providers/sql/mysql');
  return new MySQLProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 N+1 schema introspection (no MATERIALIZED CTEs, no two-phase split)

Unlike PostgreSQL, `getSchema()` ([mysql.ts:326](../../src/lib/db/providers/sql/mysql.ts)) runs one
query for the table list and then **three queries per table** (columns, foreign keys, indexes) —
the classic `1 + N*3` pattern. MySQL also does **not** implement `getSchemaList()` /
`getSchemaRelations()`, so the two-phase fast-tree loading that PostgreSQL uses is unavailable; the
`/api/db/schema/list` route falls back to the single `getSchema()`. On a very large schema this is
more round-trips than the Postgres approach — see [Known limitations](#14-known-limitations--future-work).

### 3.2 Single-database scope

Every introspection query is parameterized with `TABLE_SCHEMA = ?` bound to `config.database`. MySQL
"schemas" *are* databases, so the provider only ever sees the connected database, and table display
names are bare (no `schema.table` prefixing). There is no cross-schema FK resolution to worry about.

### 3.3 BLOB / binary values reach every surface AS BYTES

**The spelling changed on 2026-08-24.** A `BLOB`/`BINARY` value used to reach the grid as the text
`0x0102ab`; it now reads `\x0102ab`, on every surface — the cell, the row detail sheet and the CSV —
and that is the whole point of the change: one value must not be spelled two ways depending on which
engine it came from.

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
binding is what keeps a value out of the SQL text. So `getSchema()` and every `information_schema`
read that names the database stay prepared, while `SHOW STATUS`, `SHOW VARIABLES`, `SELECT VERSION()`,
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

**The Explain panel is NOT one of the recovered surfaces, and the row above is why.** `EXPLAIN
FORMAT=JSON` is a parse error on SingleStore on BOTH protocols — re-measured 2026-08-24 on the same
image — because SingleStore's grammar is `EXPLAIN JSON <select>`. The protocol was never what stopped
it there. (An earlier note recorded `EXPLAIN FORMAT=JSON` as succeeding on the text protocol; the
statement that succeeds is plain `EXPLAIN`.) Reaching a JSON plan on that engine needs a different
statement, not a different protocol, and [`mysql-json.ts`](../../src/lib/explain/mysql-json.ts) builds
one statement for every engine on this type id.

**The read path is safe to move because the two protocols decode to the same JS shapes.** mysql2
decodes text and binary rows on different code paths, so this was measured rather than assumed:
2026-08-24 on MySQL 26.7.0, the same `SELECT *` over one connection both ways, across a probe table
covering `TINYINT(1)`, `INT`, `BIGINT` past 2^53, `BIGINT UNSIGNED`, `DECIMAL(20,4)`, `FLOAT`,
`DOUBLE`, `DATE`, `DATETIME`, `TIMESTAMP`, `TIME`, `YEAR`, `CHAR`, `VARCHAR`, `TEXT`, `BLOB`,
`BIT(1)`, `BIT(8)`, `JSON`, `ENUM`, `SET` and NULLs:

- every value identical by `typeof` and by `JSON.stringify` — including the `Buffer` for `BLOB` and
  both `BIT` widths ([§3.3](#33-blob--binary-values-reach-every-surface-as-bytes)), the `Date` for the
  three temporal types, the string for `DECIMAL` and `TIME`, the parsed object for `JSON`, and the
  same `9007199254740992` for a `BIGINT` written as `9007199254740993`;
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
| `getSchema`, table/index stats, editor query, transactions | ok | ok | ok |
| maintenance `analyze` / `optimize` / `check` | all three ok (`check` **recovered**) | all three ok (`optimize`, `check` **recovered**) | n/a |
| Explain (`EXPLAIN FORMAT=JSON`) | ok | still fails — `ER_PARSE_ERROR`, see above | not re-probed |

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

The pool config ([mysql.ts:114](../../src/lib/db/providers/sql/mysql.ts)) intentionally sets only
mysql2-specific options and **does not** translate `ProviderOptions.queryTimeout` into a server-side
timeout (MySQL has no direct `statement_timeout` pool option like Postgres). A runaway query is not
auto-killed by the provider; cancellation is explicit via [`cancelQuery()`](#53-query-cancellation).

### 3.6 Maintenance over all tables when no target

`analyze`/`optimize`/`check` without a target run against **all base tables** in the database
(`getAllTablesForMaintenance()`, capped at **50** tables, [mysql.ts:577](../../src/lib/db/providers/sql/mysql.ts)),
each name quoted via `escapeIdentifier()`. With a target, the single quoted table is used.

---

## 4. Connection

### 4.1 Configuration

Two forms (`validate()`, [mysql.ts:66](../../src/lib/db/providers/sql/mysql.ts)). `validate()`
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
options ([mysql.ts:114](../../src/lib/db/providers/sql/mysql.ts)):

| mysql2 option | Value | Source |
|---------------|-------|--------|
| `connectionLimit` | pool `max` (default 10) | `ProviderOptions.pool.max` |
| `waitForConnections` | `true` | fixed |
| `queueLimit` | `0` (unbounded queue) | fixed |
| `enableKeepAlive` | `true` | fixed |
| `keepAliveInitialDelay` | `10000` ms | fixed |
| `timezone` | `'Z'` | `ProviderOptions.timezone ?? 'Z'` (discrete form only — see below) |

> ⚠️ Only `max` from `DEFAULT_POOL_CONFIG` is honored. `min`, `idleTimeout`, and `acquireTimeout`
> are **not** mapped (the mysql2 pool model differs from `pg`), and `queryTimeout` is **not** applied
> (see [§3.5](#35-no-server-side-query-timeout)).
>
> ⚠️ When a **`connectionString`** is supplied, `buildPoolConfig()` returns `{ ...baseConfig, uri }`
> and takes the discrete-fields branch **not at all** — so `timezone`, `ssl`/`connection.ssl`, and
> cloud SSL auto-detect are **ignored**; those settings must be encoded in the URI itself.

`connect()` is idempotent. Unlike the PostgreSQL provider, MySQL exposes **no** `getPoolStats()`.

### 4.3 SSL

`buildSSLConfig()` ([mysql.ts:142](../../src/lib/db/providers/sql/mysql.ts)) — applied **only in the
discrete-fields form** (the `connectionString` path bypasses it entirely). Note `disable` returns
`undefined` (mysql2's "off"), not `false`:

1. **Explicit `connection.ssl`** (`SSLConfig`): `disable` → `undefined`; `verify-ca`/`verify-full` →
   `rejectUnauthorized: true` (otherwise `false`); `caCert`/`clientCert`/`clientKey` → `ca`/`cert`/`key`.
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
value: `?ssl=true`, `?ssl=1`, `?useSSL=true` → `require`; `?ssl=false`, `?ssl=0`, `?useSSL=false` →
`disable`. An explicit `ssl-mode` wins when a string carries both. As on Postgres, `require` here
means `rejectUnauthorized: false` ([mysql.ts:505](../../src/lib/db/providers/sql/mysql.ts)) —
encrypted, chain unchecked — which is weaker than the driver this provider actually uses: mysql2
defaults `rejectUnauthorized` to `true` for any `ssl` object it is handed
(`node_modules/mysql2/lib/connection_config.js:171`). It is **not** weaker than what `useSSL=true`
means to Connector/J, whose `verifyServerCertificate` is off unless `sslMode` is `VERIFY_CA` /
`VERIFY_IDENTITY` — so for that spelling the mapping is faithful. The reason it is mapped this way
regardless of which tool wrote the string is in
[postgres.md](./postgres.md#sslmode-in-a-pasted-url). mysql2's
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

`query(sql, params?, queryId?)` ([mysql.ts:185](../../src/lib/db/providers/sql/mysql.ts)) acquires a
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
([mysql.ts:215](../../src/lib/db/providers/sql/mysql.ts)) issues `KILL QUERY <threadId>` and returns
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
table - the same source the schema tree shows - **38 of 39 match exactly**; the one difference is
`POINT`, which arrives as code 255 with nothing to distinguish it from `GEOMETRY`.

`columnTypes` is filled by `query()` and `queryInTransaction()`, and is **absent entirely** when no
column declared a type. Its consumers are the results grid's column labels, the SQL-DDL export
(which prefers a declared type over its own value-shaped guess) and the agent's state summary. This
matters most for the types whose values arrive as strings: a `DECIMAL` reaches the browser as
`"19.99"`, so before this the DDL export wrote it as `TEXT`.

---

## 6. Transactions

Identical lifecycle to PostgreSQL, on a **dedicated connection checked out from the pool and held
for the transaction's duration** (so every statement runs on the same connection; it is not returned
to the pool until commit/rollback). Surfaced via `POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction()` | `pool.getConnection()` + `beginTransaction()`, arms a **5-minute auto-rollback** timer ([mysql.ts:41](../../src/lib/db/providers/sql/mysql.ts)). Throws if one is active. |
| `queryInTransaction(sql, params?)` | Runs on the transaction's connection (with the same non-SELECT envelope as §5.1). Throws if none active. |
| `commitTransaction()` / `rollbackTransaction()` | Ends it, clears the timer, releases the connection. Throws if none active. |
| `expireTransaction()` | Timeout callback — auto-`rollback()` to prevent leaked locks. |
| `isInTransaction()` | Current state. |

---

## 7. Schema introspection

`getSchema()` returns one `TableSchema` per `BASE TABLE` in the connected database. Per table it
issues three follow-up queries:

| Data | Source | Notes |
|------|--------|-------|
| Tables | `information_schema.TABLES` | `TABLE_ROWS` (engine estimate), `DATA_LENGTH + INDEX_LENGTH` |
| Columns | `information_schema.COLUMNS` | first 100 (`LIMIT 100`); `isPrimary` = `COLUMN_KEY = 'PRI'` |
| Foreign keys | `information_schema.KEY_COLUMN_USAGE` | rows where `REFERENCED_TABLE_NAME IS NOT NULL` |
| Indexes | `information_schema.STATISTICS` | `GROUP_CONCAT` columns by `SEQ_IN_INDEX`; `unique` = `NOT NON_UNIQUE` |

There is no `getSchemaList()`/`getSchemaRelations()` — see [§3.1](#31-n1-schema-introspection-no-materialized-ctes-no-two-phase-split).

---

## 8. Monitoring & health

All monitoring reads from `SHOW STATUS`/`SHOW VARIABLES`, `information_schema`, and
`performance_schema`. `getMonitoringData()` (inherited) fans these out in parallel.

| Method | Primary source | Notes |
|--------|----------------|-------|
| `getHealth()` | `SHOW STATUS`, `information_schema.TABLES`/`PROCESSLIST`, `performance_schema` | connections, size (MB), InnoDB buffer hit %, top-5 slow queries, 10 sessions |
| `getOverview()` | `VERSION()`, `SHOW STATUS/VARIABLES`, `information_schema` | version, uptime, conns, max_conns, size, table/index counts |
| `getPerformanceMetrics()` | `performance_schema.global_status`, `SHOW STATUS` | cache-hit %, **queries/sec** (`Queries`/`Uptime`), buffer-pool %, deadlocks. Every field optional — see the degradation note below |
| `getSlowQueries()` | `performance_schema.events_statements_summary_by_digest` | per-digest stats |
| `getActiveSessions()` | `information_schema.PROCESSLIST` | pid, user, db, host, command, duration |
| `getTableStats()` | `information_schema.TABLES` | sizes; bloat **estimated from `DATA_FREE`** (no live/dead tuples, no last-vacuum/analyze) |
| `getIndexStats()` | `information_schema.STATISTICS` + `mysql.innodb_index_stats` | columns, unique/primary; **`scans` = `CARDINALITY`** (a proxy, not a real scan counter); per-index size, or **absent** — see the index-size note below |
| `getStorageStats()` | `information_schema.TABLES`, `SHOW BINARY LOGS` | Data size, Binary Logs (if enabled), InnoDB data file (size `N/A`) |

**Graceful degradation — note the *different* failure modes:**
- `getHealth()` slow-queries: try/catch → a single placeholder row (*"Performance schema not available"*).
- `getHealth()` cache-hit ratio: `formatCacheHitRatio()` → `"N/A"` when nothing was measured, and
  `"N/A"` again — rather than a failed health read — when the ratio query THROWS. A tenant can be
  missing the `performance_schema` *database* instead of merely having the schema off, and then the
  query does not answer NULLs: measured 2026-08-20 on a live OceanBase Community Edition 4.4.2.1
  tenant through this provider, and reproduced on `mysql:latest` as `ERROR 1049 (42000): Unknown
  database '...'`. That one throw used to abort the whole of `getHealth()`, so the panel showed
  nothing where one unavailable metric was the honest answer.
- `getSlowQueries()`: try/catch → **empty array** `[]`.
- `getPerformanceMetrics()`: **every field is omitted rather than defaulted.** A server with
  `performance_schema` OFF answers the `global_status` sub-selects with NULL instead of failing, so
  each reading is taken through `measuredNumber()` and a field with nothing behind it is left out of
  the object entirely. `deadlocks` comes from `SHOW STATUS`, which answers either way, so a `0` there
  is a real measurement and is reported *where the server publishes one*. If the
  `performance_schema` database is absent outright — the OceanBase case above, where every one of
  these queries raises `ERROR 1049` — the whole method returns `{}` rather than the `cacheHitRatio:
  99` it once did. This is the rule #448 and #452 settled: ABSENCE and
  ZERO are different inputs, and only the first is invisible to the panels.
- `deadlocks` reads `Innodb_deadlocks`, which is **MariaDB's** status variable. MySQL does not publish
  it — measured as an empty `SHOW STATUS` result on both 8.0.46 and 26.7.0 — so the field is absent on
  MySQL and present on MariaDB. It is the one metric that survives `performance_schema` being off.

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

`runMaintenance(type, target?)` ([mysql.ts:525](../../src/lib/db/providers/sql/mysql.ts)); targets
are backtick-quoted via `escapeIdentifier()`:

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `ANALYZE TABLE <t>` | `ANALYZE TABLE <all base tables, ≤50>` |
| `optimize` | `OPTIMIZE TABLE <t>` | `OPTIMIZE TABLE <all base tables, ≤50>` |
| `check` | `CHECK TABLE <t>` | `CHECK TABLE <all base tables, ≤50>` |
| `kill` | `KILL <connection-id>` | throws (id required) |

`getCapabilities().maintenanceOperations = ['analyze', 'optimize', 'check', 'kill']`. `kill`
validates that the target parses as an integer connection id.

### The verdict is in the result set, not in the absence of an exception

`ANALYZE`, `OPTIMIZE` and `CHECK TABLE` answer a **result set** — one row per (table, message)
with `Table` / `Op` / `Msg_type` / `Msg_text` — and a statement the server refuses resolves
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
card only where `global` is true, and both take the wording from `label` (#U9).

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
gated on the literal `vacuum`, so MySQL's own wording was written and never shown (#U9).

---

## 10. Capabilities & labels

### `getCapabilities()` ([mysql.ts:52](../../src/lib/db/providers/sql/mysql.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | `true` |
| `explainFormat` | `mysql-json` |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core MySQL DML |
| `supportsTransactions` | `true` — the transaction runs on one held connection through the driver's own `beginTransaction()`, so the trio and the SANDBOX toggle are offered (#U13) |
| `declaresForeignKeys` | `true` — inherited from the base capabilities; InnoDB declares them, so an empty list means this schema (or this role) has none, not the engine |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'optimize', 'check', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `3306` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

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

**And one monitoring field** ([mysql.ts:346](../../src/lib/db/providers/sql/mysql.ts)):
`slowQueriesEmptyState` → *"Query stats come from
performance_schema.events_statements_summary_by_digest - enable the Performance Schema to see them."*
The monitoring Queries panel's empty state was hardcoded to PostgreSQL's `pg_stat_statements` advice
on every engine (`docs/BACKLOG.md` U12) — an extension MySQL does not have under any name, while the
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

Two mock shapes are load-bearing. A non-SELECT must be mocked as a **`ResultSetHeader` object with
`undefined` fields**, not as an array. An array-shaped mock is exactly what hid the
`result.rows.map is not a function` defect described in [§5.1](#51-execution) — the whole suite was
green while every DDL and DML statement failed against a real server.

And the mock connection answers **both `query` and `execute`**, recording which one each statement
went through. A mock that only answered `execute` could not tell a statement routed to the text
protocol from one left on the prepared protocol, which is what
[§3.4](#34-which-wire-protocol-a-statement-takes) turns on: the `MySQLProvider wire protocol` block
pins the method for `getHealth`, `getOverview`, `getPerformanceMetrics`, `getSchema`,
`getStorageStats`, each maintenance statement, `cancelQuery`, the editor's own path (with and without
parameters), the Explain statement `mysqlJsonStrategy` builds, and the transaction path.

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide, so files mocking different drivers
> cross-contaminate when they share a process. A **single file** is safe (one file = one process).
> The full `bun run test` script runs the core group in **one** process and is load-order flaky, so
> **CI does not use it** — the deterministic runner is **`bun run test:ci`** (per-file isolation via
> `tests/run-core.sh`); the coverage workflow uses `bun run test:coverage`. See [`CLAUDE.md`](../../CLAUDE.md).

### 12.2 Coverage

20+ describe blocks cover: validation (incl. connection-string bypass), connect/disconnect,
capabilities, `getSchema()` (columns/FKs/indexes, primary-key detection), health, maintenance (all
types + kill validation), the full transaction lifecycle, `queryInTransaction`, query cancellation,
overview, performance metrics, slow queries, active sessions, table/index/storage stats, every SSL
branch, `prepareQuery`, error mapping (`ER_ACCESS_DENIED`, `ECONNREFUSED`), the non-SELECT envelope
(DDL, `INSERT`, `UPDATE`, `DELETE`, and the transaction path) driven from real `ResultSetHeader`
literals, and the wire protocol each statement takes.

### 12.3 Run it

```bash
bun test tests/integration/db/mysql-provider.test.ts   # just this file (single process — safe)
bun run test:ci                                         # CI publish gate — per-file isolation (tests/run-core.sh)
bun run test:coverage                                   # CI coverage workflow — per-file core + components
```

### 12.4 Optional: verifying against a live MySQL

```bash
docker run --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=app -p 3306:3306 mysql:8
# then point a connection at localhost:3306 (db=app, user=root) in the Studio UI
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
const schema = await provider.getSchema();   // single call (no two-phase split)
await provider.disconnect();
```

Over the API: `POST /api/db/query`, `POST /api/db/transaction`, `POST /api/db/cancel`,
`POST /api/db/maintenance` (admin), and `POST /api/db/schema/list` (falls back to `getSchema()`).

---

## 14. Known limitations & future work

- **No server-side query timeout.** The pool ignores `queryTimeout`; a runaway query is not
  auto-killed (only explicit `cancelQuery()`/`KILL QUERY`). *Future:* derive a per-statement
  `MAX_EXECUTION_TIME` (the SELECT execution limit) from `queryTimeout`. (Note `wait_timeout` is
  unrelated — it bounds idle connections, not query execution.)
- **N+1 schema introspection, no two-phase loading.** `getSchema()` issues `1 + 3×tables` queries
  and there is no `getSchemaList()`/`getSchemaRelations()`, so large schemas are slower than the
  Postgres MATERIALIZED-CTE path and the tree cannot stream relationships in.
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
  (MITM-exposed). For verified TLS, set an explicit `connection.ssl` with mode `verify-ca`/`verify-full`
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
- Sibling provider docs: [PostgreSQL](./postgres.md) · [Apache Trino](./trino.md) · [Redis](./redis.md)
