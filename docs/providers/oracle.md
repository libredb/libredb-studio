# Oracle Provider

> Oracle Database support for LibreDB Studio, built on the [`oracledb`](https://github.com/oracle/node-oracledb)
> driver in **Thin mode** (pure JavaScript — no Oracle Instant Client required).
> This document is the single reference point for the Oracle provider: design, architecture, usage,
> and tests. Oracle is a SQL-family provider sharing `SQLBaseProvider`; read the
> [PostgreSQL doc](./postgres.md) first for the canonical SQL walkthrough, then this doc for the
> Oracle-specific deltas.

| | |
|---|---|
| **Status** | ✅ Implemented & shipped |
| **Database type id** | `oracle` |
| **Family** | SQL (relational) |
| **Driver** | `oracledb` — **Thin mode** (no Instant Client) |
| **Query language** | `sql` |
| **Default port** | `1521` |
| **Connection pooling** | Yes — `oracledb` pool (`poolMin`/`poolMax`/`poolTimeout`) |
| **Connection string** | Supported — EZConnect `host:port/service` or a TNS string (passed straight to the driver's `connectString`) |
| **Transactions** | Yes — explicit begin/commit/rollback (**no** auto-rollback timeout) |
| **Query cancellation** | Yes — tracked connection + `connection.break()` |
| **SSL** | Yes — `connection.ssl` selects TCPS, the DN match and the wallet ([§4.3](#43-ssl--tls)) |
| **Source** | [`src/lib/db/providers/sql/oracle.ts`](../../src/lib/db/providers/sql/oracle.ts) |
| **Base** | [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) |
| **Tests** | [`tests/integration/db/oracle-provider.test.ts`](../../tests/integration/db/oracle-provider.test.ts) |

---

## 1. Overview

Oracle is a relational database that maps onto the `DatabaseProvider` interface like the other SQL
providers, with several Oracle-isms that are worth knowing before reading the code. Read this as a
**diff against the [PostgreSQL provider](./postgres.md)** (the SQL reference implementation):

| Aspect | PostgreSQL | Oracle |
|--------|------------|--------|
| Driver mode | `pg` | `oracledb` **Thin** by default (Thick opt-in via `ORACLE_CLIENT_LIB_DIR`) |
| Pagination | `LIMIT … OFFSET` | `FETCH FIRST n ROWS ONLY` / `OFFSET m ROWS FETCH NEXT n` |
| Schema scope | all non-system schemas | the connecting **user's** schema (`OWNER = USER`) |
| Schema queries | 1 `MATERIALIZED`-CTE round-trip | **5 bulk** `ALL_*` queries grouped in memory |
| Maintenance | vacuum / analyze / reindex / kill | `analyze` (DBMS_STATS) / `optimize` (index rebuild) / `kill` |
| Transaction timeout | 5-minute auto-rollback | **none** |
| Cancellation | `pg_cancel_backend(pid)` | `connection.break()` (tracked connection) |
| SSL | `buildSSLConfig()` + cloud auto-detect | `tcps://` + `sslServerDNMatch` + `walletContent` (no cloud auto-detect) |
| Monitoring source | `pg_stat_*` | `V$` views (privilege-gated, each guarded) |
| UI labels | default SQL | **overridden** (Gather Statistics / Rebuild Indexes) |

### Thin mode

The constructor ([oracle.ts:186](../../src/lib/db/providers/sql/oracle.ts)) uses pure-JS Thin mode by
default, sets `outFormat = OUT_FORMAT_OBJECT` (rows as objects), and `autoCommit = true` globally.
Thin mode means **no native Oracle client** has to be installed in the container — a real deployment
win.

> ⚠️ **Thin mode only supports Oracle Database 12.1 and later.** Connecting to an older server (11.2
> and earlier) fails with the driver's `NJS-138` error. For those servers, opt into Thick mode via
> `ORACLE_CLIENT_LIB_DIR` — see [§4.4](#44-thick-mode-opt-in-oracle_client_lib_dir).

---

## 2. Architecture

Same Strategy-Pattern hierarchy as the other SQL providers:

```
DatabaseProvider (interface) → BaseDatabaseProvider → SQLBaseProvider → OracleProvider
```

`OracleProvider` inherits the shared SQL helpers from
[`sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts) — see the
[PostgreSQL doc §2.2](./postgres.md#22-what-sqlbaseprovider-provides). It **overrides** three of
them: `getCapabilities()`, `getLabels()`, and `prepareQuery()` (Oracle pagination). Note
`escapeIdentifier()` from the base produces `"ident"` quoting, but Oracle maintenance largely uses
**inline-escaped** literals instead (see [§9](#9-maintenance)).

### Registration

Loaded on demand by the factory ([`factory.ts:77`](../../src/lib/db/factory.ts)):

```ts
case 'oracle': {
  const { OracleProvider } = await import('./providers/sql/oracle');
  return new OracleProvider(connection, options);
}
```

---

## 3. Design decisions

### 3.1 EZConnect connect string (service name, not database)

Oracle connects to a **service**, not a database name. `getConnectString()`
([oracle.ts:103](../../src/lib/db/providers/sql/oracle.ts)) returns the raw `connectionString` if
given, otherwise builds `host:port/serviceName` where `serviceName = config.serviceName ??
config.database ?? 'ORCL'`. Accordingly, `validate()` requires only `host` (not `database`) when no
connection string is present.

### 3.2 `FETCH FIRST` instead of `LIMIT`

Oracle has no `LIMIT`, so `prepareQuery()` ([oracle.ts:225](../../src/lib/db/providers/sql/oracle.ts))
overrides the base and appends `FETCH FIRST n ROWS ONLY` (or `OFFSET m ROWS FETCH NEXT n ROWS ONLY`
when an offset is set) to bare `SELECT`s that don't already have a limit. Default page size
`DEFAULT_QUERY_LIMIT = 500`; unlimited caps at `MAX_UNLIMITED_ROWS = 100000`.

Both branches append at the **end of the statement**, which `src/lib/sql/statement-end.ts` delimits —
before any trailing comment and before the terminating `;`, both of which are then re-attached
verbatim. Appending after them instead put the clause inside a trailing `-- note` while this method
still reported `wasLimited: true`, so the statement reached Oracle unbounded and the UI called the
result capped. A statement with no trailing comment is emitted exactly as it was before. The same
reading answers whether the statement already carries a `FETCH FIRST`, so
`SELECT … FETCH FIRST 10 ROWS ONLY -- deliberate` is still honoured and never gets a second clause.
A statement whose end may not be **cut** is returned untouched with `wasLimited: false` rather than
bounded on a guess. One shape reaches that on Oracle: a literal Oracle and MySQL would close in
different places (a quote behind an odd backslash run). It is a **deliberate loss of a bound** —
appending after the whole text, as this method used to, happened to be valid Oracle there, and is
what puts the clause inside a trailing comment everywhere else — so that statement returns every row
rather than being bounded on a guess. Since #297 the same unresolvable run also costs that statement a
confirmation prompt, because the safety gate cannot read it either; the general rule and its accepted
costs are in
[query-optimization.md](../editor/query-optimization.md#text-the-reading-cannot-resolve-asks-and-says-so).

`#` inside an identifier (`ID#`, common in legacy schemas) used to reach the same refusal and no
longer does. `prepareQuery()` passes its own `type` to the shared readers (#292), and Oracle's grammar
says `#` opens no comment: node-oracledb's own SQL tokenizer
(`node_modules/oracledb/lib/thin/statement.js`) accepts `#` as an identifier character and starts
comments on `--` and `/* … */` only. `SELECT * FROM EMP WHERE ID# = 1` is therefore bounded, emitted
as `… ID# = 1 FETCH FIRST 500 ROWS ONLY`. See
[Which dialect the readers are reading](../editor/query-optimization.md#which-dialect-the-readers-are-reading).

**Alternate quoting (`q'{it's}'`) is read as the literal it is** — the second half of the same fix, and
Oracle is the only dialect that has the form. The delimiter after the tag opens the body and its
partner followed by `'` closes it (`[ ] { } ( ) < >` pair up, any other character closes with itself,
`q` or `Q`, and `nq'…'` / `NQ'…'` is the same form for `NCHAR`/`NVARCHAR2`), so the body carries
apostrophes with nothing escaped. That is precisely what made reading it as code costly, and it cost
two different things:

- An apostrophe in the body opened a string, so everything after it was read one construct out of
  step: a `)` inside the literal closed a CTE body early and the statement was typed by a keyword
  written *inside* the literal. `WITH T AS (SELECT q'{it's}' AS S FROM DUAL) SELECT * FROM T` lost its
  bound entirely.
- A `--` in the body made the rest of the literal look like a trailing comment, and the
  insert-before-trivia rule above then placed the clause **inside** the literal:
  `SELECT q'[it's a -- note )]' AS S FROM DUAL` was emitted as
  `SELECT q'[it's a FETCH FIRST 500 ROWS ONLY -- note )]' AS S FROM DUAL` with `wasLimited: true` —
  a statement Oracle rejects, reported as capped.

Both are gone for either spelling of the tag; the clause now lands after the literal. A body whose
closing delimiter never arrives is undeterminable, so that statement is returned untouched rather than
bounded on a guess. The tag must also **start** a word: in `SELECT FREQ'{it's}' …` the reader takes
`FREQ` for a name and the apostrophe after it for an ordinary string, so that statement reaches the
same refusal rather than a bound placed inside something that may not be a literal at all. That is
deliberately stricter than node-oracledb's tokenizer, which opens a q-string at any `'` preceded by
`q`/`Q` whatever comes before it; the strict side is the one whose mistake costs a bound — and, since
#297, a confirmation prompt on that statement — rather than a misplaced clause.

### 3.3 Owner-scoped, five-query schema introspection

`getSchema()` ([oracle.ts:323](../../src/lib/db/providers/sql/oracle.ts)) runs **five bulk queries**
over the `ALL_*` data-dictionary views — tables, columns, primary keys, foreign keys, indexes —
all filtered by `OWNER = :1` (the connecting user, upper-cased) and then **grouped in memory** by
table. This is neither the Postgres single-CTE approach nor MySQL's per-table N+1: it is a fixed
5 round-trips regardless of table count. There is no `getSchemaList()`/`getSchemaRelations()`
(no two-phase split), and the returned `TableSchema` has **no `size` field** (only `rowCount` from
`NUM_ROWS`, an optimizer estimate that can be stale/`NULL`).

### 3.4 No transaction auto-rollback timeout

Unlike the Postgres and MySQL providers (which arm a 5-minute auto-rollback timer),
`beginTransaction()` ([oracle.ts:258](../../src/lib/db/providers/sql/oracle.ts)) simply checks out a
connection and marks the transaction active — **there is no timeout**. An abandoned transaction
holds its connection (and locks) until explicitly committed/rolled back or the connection is
reclaimed by the pool.

### 3.5 SSL through the connect string, not a `buildSSLConfig()`

The Oracle provider has no `buildSSLConfig()` and no cloud auto-detect: TLS is not an option object
here but a **protocol in the connect string**. The Thin driver calls `tls.connect` only when the
resolved address protocol is TCPS (audited in `oracledb/lib/thin/sqlnet/ntTcp.js`), so honouring
`connection.ssl` means composing `tcps://host:port/service` — see [§4.3](#43-ssl--tls) for the full
mapping, and for the two Oracle-specific consequences: the chain is **always** verified (there is no
`rejectUnauthorized` to turn off), and the CA and client certificates travel as one `walletContent`
PEM rather than three options.

### 3.6 Privilege-resilient monitoring

Oracle monitoring reads `V$` dynamic-performance views, which require privileges a typical app user
may lack. Every monitoring sub-query is wrapped in its own try/catch and degrades to a default
(`N/A`, `0`, or `[]`) rather than failing the whole call — so the dashboard still renders for a
low-privilege user, just with gaps.

---

## 4. Connection

### 4.1 Configuration

```ts
// Discrete fields — host required; service comes from serviceName ?? database ?? 'ORCL'
const a = { id: 'or-1', name: 'XE', type: 'oracle',
  host: 'localhost', port: 1521, serviceName: 'XEPDB1',
  user: 'app', password: 'secret', createdAt: new Date() };

// Connection string — EZConnect host:port/service (or a TNS string); passed
// straight to oracledb's connectString. (An `oracle://…` URL is NOT a valid
// driver connect string — it's only decomposed into discrete fields by the UI
// paste-parser before it ever reaches the provider.)
const b = { id: 'or-1', name: 'XE', type: 'oracle',
  connectionString: 'localhost:1521/XEPDB1',
  user: 'app', password: 'secret', createdAt: new Date() };
```

`validate()` ([oracle.ts:89](../../src/lib/db/providers/sql/oracle.ts)) requires `host` only when no
`connectionString` is given; `database` is **not** required (Oracle uses the service name).

### 4.2 Connection pooling

`connect()` builds an `oracledb` pool ([oracle.ts:121](../../src/lib/db/providers/sql/oracle.ts)):

| `oracledb` pool option | Value | Source |
|------------------------|-------|--------|
| `poolMin` | 2 | `ProviderOptions.pool.min` |
| `poolMax` | 10 | `ProviderOptions.pool.max` |
| `poolTimeout` | 30 (s) | `ProviderOptions.pool.idleTimeout` ÷ 1000 |

> ⚠️ `acquireTimeout` (from `DEFAULT_POOL_CONFIG`) and `queryTimeout` (a **separate**
> `ProviderOptions` option, defaulting to `DEFAULT_QUERY_TIMEOUT`) are **not** mapped — there is no
> provider-driven server-side query timeout (cancellation is explicit, [§5.2](#52-query-cancellation)).

`connect()` is idempotent; `getPoolStats()` ([oracle.ts:651](../../src/lib/db/providers/sql/oracle.ts))
exposes `{ total: connectionsOpen, idle, active: connectionsInUse, waiting: 0 }`.

### 4.3 SSL / TLS

`getConnectString()` and `buildTLSAttributes()`
([oracle.ts:271](../../src/lib/db/providers/sql/oracle.ts)) map `connection.ssl` onto the three
things the driver understands:

| `ssl.mode` | Connect string | `sslServerDNMatch` | Chain verified |
|------------|----------------|--------------------|----------------|
| absent / `disable` | `host:port/service` | not set | — (plaintext) |
| `require` | `tcps://host:port/service` | `false` | **yes** (unavoidable) |
| `verify-ca` | `tcps://host:port/service` | `false` | yes |
| `verify-full` | `tcps://host:port/service` | `true` | yes |

`caCert`, `clientCert` and `clientKey` are concatenated, in that order and newline-separated, into a
single `walletContent` attribute. That is the driver's own shape, not a convenience: Thin mode hands
the same string to `tls.createSecureContext()` as `cert`, `key` **and** `ca`.

> **Note: `require` is not "encrypt without verifying" on Oracle.** Thin mode calls `tls.connect` with
> `rejectUnauthorized: true` unconditionally, so every TCPS connection checks the chain and
> `ssl.rejectUnauthorized: false` has nothing to map to. A server with a self-signed certificate is
> reachable only by supplying its CA in `caCert`. `require` and `verify-ca` therefore differ from
> `verify-full` only in the **DN/hostname** match, which is the one check Oracle does expose.

> Note: a pasted `connectionString` is returned **verbatim**, so its own protocol (or full TNS
> descriptor) decides whether the transport is encrypted — a `require` selected alongside a `tcp`
> connect string cannot upgrade it. `sslServerDNMatch` and `walletContent` are separate pool
> attributes and still apply.

### 4.4 Thick-mode opt-in (`ORACLE_CLIENT_LIB_DIR`)

| Env var | Required | Effect |
|---------|----------|--------|
| `ORACLE_CLIENT_LIB_DIR` | No (default: unset, Thin mode) | Absolute path to an installed Oracle Instant Client `lib` directory. When set, the constructor calls `oracledb.initOracleClient({ libDir })` and the driver runs in Thick mode instead of Thin. |

```bash
# Only needed against a pre-12.1 Oracle server (see the Thin-mode caveat above).
# The version matters: use Instant Client 19c for an Oracle 11.2 server (see below).
ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient_19_28
```

node-oracledb's Thin/Thick choice is a **process-wide singleton** — `initOracleClient()` throws if
called more than once, or after any connection/pool already exists. This is why the setting is a
process-level env var rather than a per-connection config field: every `OracleProvider` in the
process shares one driver mode. The constructor guards the call with a module-level flag so it runs
at most once regardless of how many `OracleProvider` instances (i.e. connections) are created. The
Oracle Instant Client itself must already be installed at the given path — this provider does not
download or bundle it. If the path is wrong (no client library there), the constructor fails fast
with a `DatabaseConfigError` naming `ORACLE_CLIENT_LIB_DIR`, not a cryptic driver error.

#### Pick the right Instant Client version

Thick mode delegates to Oracle's native client, whose ability to reach an *older* server is bounded
by [Oracle client/server interoperability](https://docs.oracle.com/en/database/oracle/oracle-database/19/mxcli/oracle-database-client-and-oracle-database-interoperability.html)
(My Oracle Support Doc ID 207303.1). For the common "connect to Oracle 11g" case:

| Target server | Instant Client to install |
|---------------|---------------------------|
| **Oracle 11.2** (11g) | **19c** — the newest client that still reaches 11.2 (11.2.0.3 / 11.2.0.4). **21c and 23ai cannot connect to 11.2.** |
| Oracle 12.1+ | Any current Instant Client (19c / 21c / 23ai). Thin mode already covers these, so Thick is rarely needed. |

#### Connecting to a pre-12.1 server (build your own image)

The published image (`ghcr.io/libredb/libredb-studio`) ships **Thin only** — it does not bundle the
Oracle Instant Client, because the native client is ~100 MB and only a minority of deployments need
it. To reach an 11g server, build a derived image that layers Instant Client 19c on top and sets the
env var. The runtime base is Debian 13 (`node:*-trixie-slim`), so install `libaio1t64` (trixie's
renamed `libaio1`) and unpack the Basic package:

```dockerfile
FROM ghcr.io/libredb/libredb-studio:latest

USER root
# Instant Client 19c — reaches Oracle 11.2; 21c/23ai do not. Pin to a specific
# 19.x build; check https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html
# for the current file name and update the version folder in ORACLE_CLIENT_LIB_DIR to match.
RUN apt-get update && apt-get install -y --no-install-recommends libaio1t64 unzip curl \
    && mkdir -p /opt/oracle && cd /opt/oracle \
    && curl -fsSLO https://download.oracle.com/otn_software/linux/instantclient/1928000/instantclient-basic-linux.x64-19.28.0.0.0dbru.zip \
    && unzip -q instantclient-basic-linux.x64-*.zip \
    && rm instantclient-basic-linux.x64-*.zip \
    && rm -rf /var/lib/apt/lists/*
ENV ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient_19_28
USER nextjs
```

Instead of rebuilding, you can also mount an Instant Client directory from the host into the stock
image and point `ORACLE_CLIENT_LIB_DIR` at the mount — whichever your deployment prefers. A
first-class, separately-published Thick-mode image variant is a possible future addition; until then
the derived image above is the supported path.

---

## 5. Query interface

### 5.1 Execution

`query(sql, params?, queryId?)` ([oracle.ts:162](../../src/lib/db/providers/sql/oracle.ts)) checks
out a pooled connection, optionally stores the **connection object** under `queryId` for
cancellation, runs `conn.execute(sql, binds, { outFormat: OUT_FORMAT_OBJECT, autoCommit: true, fetchTypeHandler })`
([§5.3](#53-what-each-oracle-type-arrives-as) says what the handler is for),
and returns:

```ts
{ rows, fields: metaData.map(m => m.name), rowCount: rows.length, executionTime, columnTypes? }
```

A `SELECT` answers with a `rows` array and `rowCount` is `rows.length`. A non-`SELECT`
(INSERT/UPDATE/DELETE/DDL/PL/SQL) carries **no `rows` array at all**, and that absence is what
selects the other branch of `buildQueryResult()`: the grid is empty (`rows: []`, `fields: []`, no
`columnTypes`, because there is no metadata to state them from) and **`rowCount` is the driver's own
`result.rowsAffected`**, `0` when the driver states none. Same shape as the MySQL provider's
`buildQueryResult()` (#469).

Until 2026-08-24 the count was `rows.length` on both branches, so every statement that wrote
something reported `0` for work it had done. Measured 2026-08-24 through
`createDatabaseProvider({type:"oracle"})` against Oracle Free 23ai, with an interleaved `SELECT`
proving each statement had landed:

| statement | `rowsAffected` on the wire | `rowCount` before | after |
|---|---|---|---|
| `CREATE TABLE d13_probe (…)` | `0` | 0 | 0 |
| `INSERT INTO d13_probe VALUES (1, 'a')` | `1` | **0** | 1 |
| `INSERT INTO d13_probe SELECT … ROWNUM <= 3` | `3` | **0** | 3 |
| `UPDATE d13_probe SET note = 'z'` (4 rows) | `4` | **0** | 4 |
| `DELETE FROM d13_probe WHERE id = 9` (3 rows) | `3` | **0** | 3 |
| `DELETE FROM d13_probe WHERE id = 4242` | `0` | 0 | 0 |
| `BEGIN NULL; END;` | *unset* | 0 | 0 |
| `TRUNCATE TABLE d13_probe` | `0` | 0 | 0 |

`autoCommit: true` on the call is load-bearing, not decoration: `oracledb.autoCommit` defaults to
`false`, and measured without it the `INSERT` still reported `rowsAffected: 1` while a second
session saw `COUNT(*) = 0`, and the row was gone for good once the writing connection went back to
the pool. Bind parameters use Oracle's `:1`-style placeholders (`getPlaceholder()` from the base).
Native errors are normalised through `mapDatabaseError()` (see [§11](#11-error-handling)).

### 5.2 Query cancellation

A query issued with a `queryId` stores its connection in a `Map`. `cancelQuery(queryId)`
([oracle.ts:208](../../src/lib/db/providers/sql/oracle.ts)) calls `connection.break()` on it —
interrupting the in-flight OCI call — and returns `true` on success (it does not verify a query was
actually running). Exposed via `POST /api/db/cancel`.

### 5.3 What each Oracle type arrives as

Every row below was measured on 2026-08-24 through `createDatabaseProvider({type:"oracle"})` against
**Oracle Free 23ai** with **oracledb 6.10.0 in Thin mode**, over a probe table holding one populated
row and one all-`NULL` row. The `JSON.stringify` column is what `POST /api/db/query` puts on the wire,
and therefore what the grid, the row detail sheet, the CSV, the SQL export and the agent's result
summary all read.

| Oracle type | Arrives as | `JSON.stringify` gives | Reported as |
|---|---|---|---|
| `CLOB` / `NCLOB` | `string` (see below) | `"the quick brown fox"` | the text |
| `BLOB` | `Buffer` (see below) | `{"type":"Buffer","data":[222,173,190,239,1,2]}` | `\xdeadbeef0102` |
| `RAW` | `Buffer` | `{"type":"Buffer","data":[10,11,12]}` | `\x0a0b0c` |
| `NUMBER` | `number` | `1.2345678901234568e+37` — **digits lost** | the double, see below |
| `BINARY_DOUBLE` | `number` | `3.5` | the number |
| `TIMESTAMP` / `DATE` | `Date` | `"2026-08-23T17:46:46.422Z"` | the formatted date |
| `TIMESTAMP WITH TIME ZONE` | `Date` | `"2026-08-24T07:11:12.345Z"` — offset folded to UTC, sub-ms dropped | the formatted date |
| `TIMESTAMP WITH LOCAL TIME ZONE` | `Date` | `"2026-08-24T10:11:12.345Z"` | the formatted date |
| `INTERVAL YEAR TO MONTH` | `IntervalYM` | `{"months":7,"years":3}` | that object, as JSON |
| `INTERVAL DAY TO SECOND` | `IntervalDS` | `{"fseconds":900000000,"seconds":8,"minutes":7,"hours":6,"days":5}` | that object, as JSON |
| `XMLTYPE` | `string` | `"<r>\n  <a>1</a>\n</r>\n"` | the serialized document |
| `JSON` | plain object | `{"k":[1,2]}` | that object, as JSON |
| any of the above, `NULL` | `null` | `null` | empty |

#### A LOB used to fail the whole query, not just the cell

`query()` and `queryInTransaction()` pass a per-call **`fetchTypeHandler`**
([oracle.ts](../../src/lib/db/providers/sql/oracle.ts)) that maps `CLOB` and `NCLOB` to
`oracledb.STRING` and `BLOB` to `oracledb.BUFFER`. Every other column keeps the driver's own default:
`RAW` is already a `Buffer` and `VARCHAR2` already a string, and restating them would put this
provider in charge of types it has no reason to touch.

Without it oracledb answers a LOB with a **`Lob` stream object**, and the row cannot be serialized at
all. Measured over four LOB columns, each arriving with `constructor.name === "Lob"`:

```
TypeError: Converting circular structure to JSON
    --> starting at object with constructor 'NVPair'
    |     property 'list' -> object with constructor 'Array'
    |     index 0 -> object with constructor 'NVPair'
    --- property 'parent' closes the circle          (Node 24.14.0)

TypeError: JSON.stringify cannot serialize cyclic structures   (Bun 1.3.14)
```

`POST /api/db/query` builds its answer with `NextResponse.json`, so **the whole SELECT failed** —
no grid, no CSV, no export, nothing for the agent to summarize. The in-process path
(`StudioWorkspace`, the agent's tools) got further and was worse: the cell classified as JSON and the
export wrote the stream's internals, measured verbatim as

```
INSERT INTO r6_lob ("ID", "C", "B") VALUES (1, '{"_events":{"finish":[null]},"_readableState":{...
```

A `BLOB` as a `Buffer` needs nothing further: `asBytes` in
[`src/lib/export/binary.ts`](../../src/lib/export/binary.ts) accepts both a live `Uint8Array` and the
`{"type":"Buffer","data":[…]}` JSON it serializes to, which is the same contract a Postgres `bytea`
and a MySQL `BLOB` already reach the binary cell renderer, the row detail sheet, the CSV and the SQL
export's binary literal through. Verified by exporting a row and replaying it into Oracle itself:

```
SOURCE   {"ID":1,"C":"the quick brown fox","NC":"ncl-value-unicode-café","B":{"type":"Buffer","data":[222,173,190,239,1,2]}}
EXPORT   INSERT INTO r6_replay ("ID", "C", "NC", "B") VALUES (1, 'the quick brown fox', 'ncl-value-unicode-café', HEXTORAW('deadbeef0102'));
REPLAYED {"ID":1,"C":"the quick brown fox","NC":"ncl-value-unicode-café","B":{"type":"Buffer","data":[222,173,190,239,1,2]}}
```

**A LOB is fetched whole, with no length cap.** That is the same contract every other provider here
already has for a large value — a Postgres `text`/`bytea` and a MySQL `BLOB` arrive whole too, and
`DEFAULT_QUERY_LIMIT` bounds the row count, not the cell. A cap was considered and rejected: a
truncated `CLOB` looks exactly like a complete one in the grid, and the SQL export would write the
truncation into the target as though it were the value. The cost is linear and measured — a
16,384,000-character `CLOB` fetched as a string took **66 ms** and serialized to **16.4 MB** of JSON
in **18 ms** — and the ceiling is the runtime's own and fails loudly: a string past V8's
536,870,888-character maximum throws `RangeError: Invalid string length`, which reaches the user as a
failed query rather than as a value that has quietly lost its tail.

The handler is deliberately **per-call**, not the process-wide `oracledb.fetchAsString` /
`fetchAsBuffer` globals: those would also change every schema and monitoring read (`getSchema` reads
`ALL_TAB_COLUMNS.DATA_DEFAULT`, a `LONG`), and they outlive the provider — the embeddable library
surface runs inside a host application that may have its own oracledb consumers.

#### `NUMBER` still loses digits, and that is a separate defect

`NUMBER` arrives as a JS double and the loss is silent: measured,
`12345678901234567890123456789012345678` (a `NUMBER(38,0)`) came back as `1.2345678901234568e+37`,
and `NUMBER(20,4)` `1234567890123456.7891` as `1234567890123456.8`. Fetching `NUMBER` as a string
would keep the digits — the way `docs/providers/cassandra.md` §3.8 keeps a `bigint`'s — but it is
**not** part of that change: it changes every numeric cell Oracle produces, including the ones the grid
right-aligns and the agent arithmetics over, so it is tracked separately rather than smuggled in with
the LOB fix. The two `INTERVAL` types and `JSON` are lossless as objects and are also left as they
are; `XMLTYPE` needs nothing, it is already a string.

### 5.4 Declared column types

Oracle is the one engine of the four whose driver hands over a NAME rather than a wire code:
`result.metaData[].dbTypeName`. It is passed through into `QueryResult.columnTypes` verbatim
([column-types.ts](../../src/lib/db/providers/sql/column-types.ts)), keyed by the column name in
`fields`, by both `query()` and `queryInTransaction()`, and it is uppercase - the same spelling
`ALL_TAB_COLUMNS.DATA_TYPE` uses, so a declared type reads like the schema tree's entry.

Measured on Oracle Free 23ai over the probe table, verbatim from `oracledb`:

| declared | `dbTypeName` | also reported |
|---|---|---|
| `NUMBER(19)` | `NUMBER` | `precision: 19, scale: 0` |
| `NUMBER(10,2)` | `NUMBER` | `precision: 10, scale: 2` |
| `BINARY_DOUBLE` | `BINARY_DOUBLE` | |
| `VARCHAR2(40)` | `VARCHAR2` | `byteSize: 40` |
| `CLOB` / `BLOB` | `CLOB` / `BLOB` | |
| `TIMESTAMP` / `DATE` | `TIMESTAMP` / `DATE` | `precision: 6` on the timestamp |
| `SYSTIMESTAMP` (computed) | `TIMESTAMP WITH TIME ZONE` | `precision: 6` |
| `COUNT(*)` (computed) | `NUMBER` | `precision: 0, scale: 0` |
| `1/3` (computed) | `NUMBER` | `precision: 0, scale: -127` |

The precision and scale sit right beside the name and are deliberately **not** spelled into it. The
last two rows are why: a computed column reports precision 0 or scale -127, and a `NUMBER(p,s)`
built from those would claim something Oracle did not. `DATA_TYPE` is the type; the declaration
channel carries the type.

This is the only source of a type for a computed column or an ad-hoc projection - the schema tree has
no catalog entry to answer with - and it is what stops the SQL-DDL export from guessing. Measured
before this existed, the probe table's `NUMBER(10,2)` column exported as `BINARY_DOUBLE` and its
`BLOB` as `VARCHAR2(4000)`, both inferred from a value.

---

## 6. Transactions

Explicit lifecycle on a dedicated connection checked out from the pool ([oracle.ts:258](../../src/lib/db/providers/sql/oracle.ts)).
Oracle starts a transaction implicitly on the first DML, so `beginTransaction()` just holds the
connection. **No auto-rollback timeout** (see [§3.4](#34-no-transaction-auto-rollback-timeout)).
Surfaced via `POST /api/db/transaction`.

| Method | Behaviour |
|--------|-----------|
| `beginTransaction()` | Checks out a connection, marks active. Throws if one is active. |
| `queryInTransaction(sql, params?)` | Runs on that connection with `autoCommit: false`, through the same `buildQueryResult()` — so a DML statement reports its own `rowsAffected` here too. Throws if none active. |
| `commitTransaction()` / `rollbackTransaction()` | `commit()`/`rollback()`, then closes the connection. Throws if none active. |
| `isInTransaction()` | Current state. |

---

## 7. Schema introspection

`getSchema()` returns one `TableSchema` per table owned by the connecting user. Five `ALL_*` queries
(`OWNER = :user`), grouped client-side:

| Data | Source view(s) |
|------|----------------|
| Tables + row estimate | `ALL_TABLES` (`NUM_ROWS`) |
| Columns | `ALL_TAB_COLUMNS` (`isPrimary` derived from PK set; `nullable` = `NULLABLE = 'Y'`) |
| Primary keys | `ALL_CONSTRAINTS` + `ALL_CONS_COLUMNS` (`CONSTRAINT_TYPE = 'P'`) |
| Foreign keys | `ALL_CONSTRAINTS` (type `'R'`) joined to the referenced constraint's columns |
| Indexes | `ALL_INDEXES` + `ALL_IND_COLUMNS` (`unique` = `UNIQUENESS = 'UNIQUE'`) |

No `getSchemaList()`/`getSchemaRelations()`; no `size` on the returned tables (see [§3.3](#33-owner-scoped-five-query-schema-introspection)).

---

## 8. Monitoring & health

All from `V$`/`USER_*` views; `getMonitoringData()` (inherited) fans them out in parallel. Each
sub-query is independently privilege-guarded ([§3.6](#36-privilege-resilient-monitoring)).

| Method | Primary source | Notes / degradation |
|--------|----------------|---------------------|
| `getHealth()` | `V$SESSION`, `USER_SEGMENTS`, `V$SYSSTAT`, `V$SQL` | each block guarded → `N/A`/`0`/`[]` if no privilege; `cacheHitRatio` is `N/A`, never `0%` ([§7.1](#71-when-the-cache-hit-ratio-is-not-measurable)) |
| `getOverview()` | `V$VERSION`, `V$INSTANCE`, `V$SESSION`, `V$PARAMETER`, `USER_SEGMENTS`, `USER_TABLES`/`USER_INDEXES` | each guarded |
| `getPerformanceMetrics()` | `V$SYSSTAT` | **only** `cacheHitRatio`, and it is **omitted** when `V$SYSSTAT` cannot be read (no QPS/deadlocks/buffer-pool) — [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable) |
| `getSlowQueries()` | `V$SQL` (top-N by `ELAPSED_TIME`) | `sharedBlksHit`=`BUFFER_GETS`, `sharedBlksRead`=`DISK_READS`; `[]` on failure |
| `getActiveSessions()` | `V$SESSION` ⋈ `V$SQL` | `pid` = `"SID,SERIAL#"`; wait class/event; `[]` on failure |
| `getTableStats()` | `ALL_TABLES` + `USER_SEGMENTS` | sizes + `lastAnalyze`; no live/dead tuples, no bloat; `[]` on failure |
| `getIndexStats()` | `ALL_INDEXES` + `USER_SEGMENTS` + `ALL_IND_COLUMNS` | **`scans` always `0`** (no usage counter exposed); `isPrimary` always `false`; `[]` on failure |
| `getStorageStats()` | `DBA_DATA_FILES` → fallback `USER_SEGMENTS` | per-tablespace size; DBA view falls back to user segments without privilege |

### 7.1 When the cache hit ratio is not measurable

Two states, both ordinary:

- **The connected user cannot read `V$SYSSTAT`.** Measured 2026-08-23 on Oracle Free 23ai against a
  user granted only `CREATE SESSION`:

  ```
  ORA-00942: table or view "SYS"."V_$SYSSTAT" does not exist
  ```

- **The counter denominator is zero.** `NULLIF(..., 0)` guards the division, so the statement returns
  one row whose single column is `NULL`. Measured 2026-08-23 on the same instance:

  ```
   HIT_RATIO
  ----------
  <NULL>
  ```

In both cases **`getHealth().cacheHitRatio` is `"N/A"` and `getPerformanceMetrics()` omits
`cacheHitRatio`** (returning `{}` when nothing else was read), and the Overview and Performance tabs
render "Not measured". A ratio measured as `0` is kept and shown as `0.0%`.

`getHealth()` previously published `"0%"` for an unreadable ratio and `getPerformanceMetrics()`
defaulted to `100`. The `0%` was worse than the `100`: the Overview card rates a low ratio "Needs
tuning", so a least-privilege application user saw a cache fault Oracle never reported.

`bufferPoolUsage` is **no longer reported**. It was assigned `cacheHitRatio` itself — the same number
under a second name, which the Performance tab drew and rated as an independent gauge. Oracle does
publish pool occupancy, in `V$BUFFER_POOL_STATISTICS`/`V$SGASTAT`, but this method does not query
them.

---

## 9. Maintenance

`runMaintenance(type, target?)` ([oracle.ts:586](../../src/lib/db/providers/sql/oracle.ts)):

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `DBMS_STATS.GATHER_TABLE_STATS(USER, '<t>')` | `DBMS_STATS.GATHER_SCHEMA_STATS(USER)` |
| `optimize` | `ALTER INDEX "<t>" REBUILD` | rebuild **every** normal user index (`USER_INDEXES`, each in its own try/catch) |
| `kill` | `ALTER SYSTEM KILL SESSION '<SID,SERIAL#>'` | throws (`SID,SERIAL#` required) |

`getCapabilities().maintenanceOperations = ['analyze', 'optimize', 'kill']`. Targets are
**inline-escaped** (single quotes doubled for the PL/SQL string literal; double quotes doubled for
the quoted index identifier) rather than routed through `escapeIdentifier()`, because they sit
inside `DBMS_STATS` arguments / `ALTER` identifiers that can't take bind parameters.

---

## 10. Capabilities & labels

### `getCapabilities()` ([oracle.ts:61](../../src/lib/db/providers/sql/oracle.ts))

| Capability | Value |
|------------|-------|
| `queryLanguage` | `sql` |
| `supportsExplain` | **`false`** (intentionally disabled — see [Known limitations](#14-known-limitations--future-work)) |
| `supportsExternalQueryLimiting` | `true` (from base) |
| `supportsCreateTable` | `true` (from base) |
| `supportsInlineRowEdit` | `true` — `UPDATE t SET c = v WHERE pk = v` is core Oracle DML |
| `supportsTransactions` | `true` — Oracle is always in a transaction and the held connection commits or rolls back, so the trio and the SANDBOX toggle are offered (#U13) |
| `declaresForeignKeys` | `true` — inherited from the base capabilities; read from `ALL_CONSTRAINTS`, so an empty list is about the schema or the owner, not the engine |
| `supportsMaintenance` | `true` |
| `maintenanceOperations` | `['analyze', 'optimize', 'kill']` |
| `supportsConnectionString` | `true` |
| `defaultPort` | `1521` |
| `schemaRefreshPattern` | `(CREATE\|DROP\|ALTER\|TRUNCATE)\b` (from base) |

### Labels — overridden ([oracle.ts:71](../../src/lib/db/providers/sql/oracle.ts))

Oracle **overrides** the default SQL labels so the UI uses Oracle vocabulary:
`analyzeAction` → *"Gather Statistics"*, `vacuumAction` → *"Rebuild Indexes"*, and the matching
global labels (*"Gather Stats"*, *"Rebuild All Indexes"*).

`slowQueriesEmptyState` → *"Query stats come from V$SQL, which this user needs SELECT on to read."*
The monitoring Queries panel's empty state was hardcoded to PostgreSQL's `pg_stat_statements` advice
on every engine (`docs/BACKLOG.md` U12); `getSlowQueries()` here reads `V$SQL`
([§8](#8-monitoring--health)) and returns `[]` when that read is refused, so the grant is the thing a
DBA can act on.

---

## 11. Error handling

`mapDatabaseError()` ([errors.ts](../../src/lib/db/errors.ts)) has **Oracle-specific** branches:

| Situation | Error |
|-----------|-------|
| Missing `host` (no connection string) | `DatabaseConfigError` |
| Operation before `connect()` | `DatabaseConfigError` (via `ensureConnected()`) |
| `connect()` fails | `ConnectionError` (carries host/port) |
| `ORA-01017` / *invalid username/password* | `AuthenticationError` |
| `ORA-12541` / `ORA-12154` / `TNS:` | `ConnectionError` |
| `ORA-00942` (table or view does not exist) | `QueryError` |
| `NJS-138` (server predates Oracle 12.1, Thin-mode incompatible) | `DatabaseConfigError`, **not retryable** — see [§4.4](#44-thick-mode-opt-in-oracle_client_lib_dir) |
| Driver message contains *timeout* / *timed out* | `TimeoutError` |
| `connection.break()`-interrupted query | maps via the generic path (the driver's `ORA-01013` / "user requested cancel"); other `ORA-*` codes fall through to `QueryError`/`DatabaseError` with the original message |

There is **no** provider-driven server-side query timeout (no `queryTimeout` wiring), so a
`TimeoutError` only arises from a driver-level timeout message.

---

## 12. Testing

### 12.1 How the tests work

Integration tests live in
[`tests/integration/db/oracle-provider.test.ts`](../../tests/integration/db/oracle-provider.test.ts).
The `oracledb` module is replaced with an in-process mock via `mock.module('oracledb', …)` **before**
the provider is imported — there is no live Oracle in the suite. The mock pool/connection returns
canned `{ rows, metaData }` results, exercising the same code paths as the real driver.

**The mock is why this went unnoticed for as long as it did.** It answered every column with a plain
JS value, so no test could produce the `Lob` stream object oracledb really returns for a `CLOB`, an
`NCLOB` or a `BLOB` — a defect that made the whole query fail against a real Oracle was invisible to
a suite that never saw the driver's own value shape. The mock now carries the `DB_TYPE_*` / `STRING`
/ `BUFFER` identities a fetch type handler is written against, and records the options each
`execute()` received, so the handler itself is asserted over each type; the value shapes it produces
are pinned from live measurements ([§5.3](#53-what-each-oracle-type-arrives-as)).

> ⚠️ **Mock isolation:** `bun`'s `mock.module()` is process-wide; files mocking different drivers
> cross-contaminate in a shared process. A **single file** is safe (one file = one process). The
> full `bun run test` script runs the core group in **one** process and is load-order flaky, so
> **CI does not use it** — the deterministic runner is **`bun run test:ci`** (per-file isolation via
> `tests/run-core.sh`); the coverage workflow uses `bun run test:coverage`. See [`CLAUDE.md`](../../CLAUDE.md).

### 12.2 Coverage

The suite covers: validation, connect/disconnect, query, capabilities, **labels override**,
**`prepareQuery` FETCH FIRST / OFFSET-FETCH**, `getSchema` (columns/PKs/FKs/indexes grouping),
health, maintenance (analyze/optimize/kill), pool stats, the transaction lifecycle, query
cancellation (`break()`), overview, performance metrics, slow queries, active sessions,
table/index/storage stats, **the LOB fetch type handler** (per type, plus that `getSchema` is left
alone and that a `BLOB` reaches `asBytes` in both its live and its serialized shape), error mapping,
and **every `ssl.mode` branch** (the TCPS switch, the
DN-match flag, the concatenated `walletContent`, and a pasted connect string keeping its own
protocol) asserted against the attributes `createPool` received.

### 12.3 Run it

```bash
bun test tests/integration/db/oracle-provider.test.ts   # just this file (single process — safe)
bun run test:ci                                          # CI publish gate — per-file isolation (tests/run-core.sh)
bun run test:coverage                                    # CI coverage workflow — per-file core + components
```

### 12.4 Optional: verifying against a live Oracle

```bash
docker run --rm -e ORACLE_PASSWORD=secret -p 1521:1521 gvenzl/oracle-free:slim
# then connect to localhost:1521 / FREEPDB1 (user system, password secret) in the Studio UI
```

---

## 13. Usage examples

```ts
import { createDatabaseProvider } from '@/lib/db/factory';

const provider = await createDatabaseProvider({
  id: 'or1', name: 'XE', type: 'oracle',
  host: 'localhost', port: 1521, serviceName: 'XEPDB1',
  user: 'app', password: 'secret', createdAt: new Date(),
});

await provider.connect();
const res = await provider.query('SELECT id, email FROM users WHERE active = :1', [1]);
const schema = await provider.getSchema();   // 5 ALL_* queries, grouped in memory
await provider.disconnect();
```

Over the API: `POST /api/db/query`, `POST /api/db/transaction`, `POST /api/db/cancel`,
`POST /api/db/maintenance` (admin), `POST /api/db/schema/list` (falls back to `getSchema()`).

---

## 14. Known limitations & future work

- **A LOB is fetched whole.** `CLOB`/`NCLOB`/`BLOB` are read into a string or a `Buffer` in one
  piece rather than streamed, so a single very large cell is held in memory and then in the JSON
  response. Measured: 16 MB of `CLOB` costs 66 ms and 16.4 MB of JSON; V8 refuses a string past
  536,870,888 characters with `RangeError: Invalid string length`. Bounding it was rejected on
  purpose — a truncated value looks complete in the grid and would be written into the target by the
  SQL export ([§5.3](#53-what-each-oracle-type-arrives-as)). *Future:* if a real workload hits
  the ceiling, stream the cell to the download rather than truncating it in the row.
- **Large `NUMBER` loses digits, silently.** Returned as a JS double: a `NUMBER(38,0)` measured as
  `1.2345678901234568e+37` and a `NUMBER(20,4)` as `1234567890123456.8`. Fetching `NUMBER` as a
  string would keep them exact, at the cost of changing every numeric cell Oracle produces — which
  is why it was left out of the LOB change rather than bundled with it ([§5.3](#53-what-each-oracle-type-arrives-as)).
- **`INTERVAL YEAR TO MONTH` and `INTERVAL DAY TO SECOND` show as JSON objects**
  (`{"months":7,"years":3}`), not as their Oracle literals. Lossless, but not what an Oracle user
  reads. *Future:* normalize to the literal the way the Cassandra provider does for `duration`.
- **`TIMESTAMP WITH TIME ZONE` arrives as a `Date`**, so the stated offset is folded into UTC and
  sub-millisecond precision is dropped (`+03:00 10:11:12.345678` measured as
  `"2026-08-24T07:11:12.345Z"`).
- **`NJS-138` (pre-12.1 server) is a non-retryable configuration error, not a transient one.**
  `mapDatabaseError()` maps it to `DatabaseConfigError` instead of the generic retryable
  `ConnectionError` every other `connect()` failure produces — see [§4.4](#44-thick-mode-opt-in-oracle_client_lib_dir)
  and [§11](#11-error-handling). The error message points the operator at `ORACLE_CLIENT_LIB_DIR`.
- **`EXPLAIN` is intentionally disabled for Oracle until a dialect wrapper exists.**
  `getCapabilities().supportsExplain` is `false`, so the UI hides the *Explain* action. The UI's
  EXPLAIN builder only handles Postgres/MySQL; before the flag was flipped, the *Explain* action
  silently ran the **unmodified** query instead of producing a plan. *Future:* build
  `EXPLAIN PLAN FOR …` followed by `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY())`, then re-enable the
  capability.
- **No server-side query timeout.** `queryTimeout` is not wired into the pool; runaway queries must
  be cancelled explicitly via `cancelQuery()` (`connection.break()`). *Future:* set
  `connection.callTimeout` (node-oracledb's per-round-trip timeout) from `queryTimeout`.
- **`kill` and full monitoring require elevated privileges.** `ALTER SYSTEM KILL SESSION` needs the
  `ALTER SYSTEM` privilege; the `V$` monitoring views need `SELECT` on the `V_$` views. A
  least-privilege application user can neither kill sessions nor read most monitoring (the queries
  degrade to `N/A`/`0`/`[]`).
- **Module-global driver settings.** The constructor sets `oracledb.outFormat`/`autoCommit` on the
  shared `oracledb` module singleton (not per-pool/connection) — fine for a single embedding, but a
  process-wide side effect to be aware of if Oracle is ever used alongside another `oracledb` consumer.
- **TLS cannot be encryption-only, and cannot be forced onto a pasted connect string.** Thin mode
  always verifies the chain, so `ssl.mode: require` needs the server's CA in `caCert` when the
  certificate is self-signed, and `ssl.rejectUnauthorized: false` has no Oracle equivalent
  ([§4.3](#43-ssl--tls)). A `connectionString` is passed through verbatim, so the protocol it names
  is the one used. *Future:* surface the mismatch in the dialog rather than leaving the connect
  string to decide silently.
- **No transaction auto-rollback timeout** (unlike Postgres/MySQL) — an abandoned transaction holds
  its connection/locks until committed, rolled back, or pool-reclaimed.
- **Schema is owner-scoped** to the connecting user (`OWNER = USER`); objects in other schemas the
  user can see are not listed, and tables carry no size field.
- **`getIndexStats().scans` is always `0`** and `isPrimary` always `false` — Oracle index usage
  counters aren't read here.
- **Row counts (`NUM_ROWS`) are optimizer estimates** populated by `DBMS_STATS`; they can be stale
  or `NULL` until stats are gathered.
- **Monitoring depends on `V$` privileges.** A low-privilege app user silently gets `N/A`/`0`/`[]`
  for the views it can't read. `getPerformanceMetrics()` reports only the cache-hit ratio (no QPS,
  deadlocks, or buffer-pool usage), and **omits even that** when `V$SYSSTAT` is unreadable rather
  than substituting a figure — [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable).
- **No two-phase schema loading** — `/api/db/schema/list` falls back to the full `getSchema()`.

---

## 15. References

- Driver: [`node-oracledb`](https://github.com/oracle/node-oracledb) (Thin mode)
- Source: [`src/lib/db/providers/sql/oracle.ts`](../../src/lib/db/providers/sql/oracle.ts)
- SQL base: [`src/lib/db/providers/sql/sql-base.ts`](../../src/lib/db/providers/sql/sql-base.ts)
- Query limiter: [`src/lib/db/utils/query-limiter.ts`](../../src/lib/db/utils/query-limiter.ts)
- Interface & DTOs: [`src/lib/db/types.ts`](../../src/lib/db/types.ts)
- Errors (incl. `ORA-*` mapping): [`src/lib/db/errors.ts`](../../src/lib/db/errors.ts)
- Tests: [`tests/integration/db/oracle-provider.test.ts`](../../tests/integration/db/oracle-provider.test.ts)
- API contract: [`docs/API_DOCS.md`](../API_DOCS.md)
- Sibling provider docs: [PostgreSQL](./postgres.md) · [MySQL](./mysql.md) · [Apache Trino](./trino.md) · [Redis](./redis.md)
