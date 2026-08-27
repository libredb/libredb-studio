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
| Maintenance | vacuum / analyze / reindex / kill | `analyze` (DBMS_STATS) / `optimize` (rebuild one table's indexes, or the schema's) / `kill` |
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
may lack. Every monitoring sub-query is wrapped in its own try/catch and degrades rather than failing
the whole call — so the dashboard still renders for a low-privilege user, just with gaps. The default
it degrades to is `N/A` or `[]` where the shape has a place to say "not measured", and — in the
health reading, where a number would otherwise be invented — **nothing at all**:
`getHealth().activeConnections` is omitted rather than reported as `0`
([§7.2](#72-when-the-connection-count-is-not-measurable)).

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
| `verify-system` | `tcps://host:port/service` | `true` | yes, against the runtime's own roots |
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
>
> `verify-system` (D26) asks for that same match. What separates it from `verify-full` here is what it
> does NOT send: with no PEM pasted there is no `walletContent`, so `tls.connect` falls back to Node's
> bundled roots for the chain — which is exactly what the mode means. Audited in the installed driver:
> `oracledb/lib/thin/sqlnet/ntTcp.js` runs `tls.checkServerIdentity(hostName, cert)` when
> `sslServerDNMatch` is on and no `sslServerCertDN` is configured. Not exercised against a TLS
> listener (the probe instance speaks TCP), so this is the driver's audited shape and no claim about a
> verified handshake.

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
`createDatabaseProvider({type:"oracle"})` against Oracle AI Database 26ai Free, with an interleaved `SELECT`
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
**Oracle AI Database 26ai Free** with **oracledb 6.10.0 in Thin mode**, over a probe table holding one populated
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
| `TIMESTAMP WITH TIME ZONE` | `Date` | `"2026-08-24T07:11:12.345Z"` — offset folded to UTC, sub-ms dropped | the formatted date — [§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be) |
| `TIMESTAMP WITH LOCAL TIME ZONE` | `Date` | `"2026-08-24T07:11:12.345Z"` — same, normalized to the session time zone first | the formatted date — [§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be) |
| `INTERVAL YEAR TO MONTH` | `IntervalYM` | `"+03-07"` | its Oracle literal — [§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be) |
| `INTERVAL DAY TO SECOND` | `IntervalDS` | `"+05 06:07:08.9"` | its Oracle literal — [§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be) |
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
the LOB fix. `JSON` is lossless as an object and is left as it is; `XMLTYPE` needs nothing, it is
already a string. The two `INTERVAL` types were left alone by that change too and are handled now —
[§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be).

### 5.4 Declared column types

Oracle is the one engine of the four whose driver hands over a NAME rather than a wire code:
`result.metaData[].dbTypeName`. It is passed through into `QueryResult.columnTypes` verbatim
([column-types.ts](../../src/lib/db/providers/sql/column-types.ts)), keyed by the column name in
`fields`, by both `query()` and `queryInTransaction()`, and it is uppercase - the same spelling
`ALL_TAB_COLUMNS.DATA_TYPE` uses, so a declared type reads like the schema tree's entry.

Measured on Oracle AI Database 26ai Free over the probe table, verbatim from `oracledb`:

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

### 5.5 An interval is normalized to its Oracle literal; a time zone cannot be

Four Oracle types "lose or hide what they carry", and the answers are not the same for both pairs:
the two intervals are **normalized at the driver boundary**, the two time-zone timestamps **cannot
be** and this section says so plainly instead of implying otherwise. This is the decision
[`docs/providers/cassandra.md` §3.8](cassandra.md#38-values-are-normalized-once-at-the-driver-boundary)
already took for a CQL `duration`, applied to the one other engine here that has the same shape of
problem.

Measured 2026-08-24 against **Oracle AI Database 26ai Free** with **oracledb 6.10.0 in Thin mode**, through
`createDatabaseProvider({type:"oracle"})`:

| Oracle type | stored | before | after |
|---|---|---|---|
| `INTERVAL YEAR TO MONTH` | `INTERVAL '3-7' YEAR TO MONTH` | `{"months":7,"years":3}` | `"+03-07"` |
| `INTERVAL DAY TO SECOND` | `INTERVAL '5 6:7:8.9' DAY TO SECOND` | `{"fseconds":900000000,"seconds":8,"minutes":7,"hours":6,"days":5}` | `"+05 06:07:08.9"` |
| `TIMESTAMP WITH TIME ZONE` | `TIMESTAMP '2026-08-24 10:11:12.345678 +03:00'` | `"2026-08-24T07:11:12.345Z"` | unchanged — see below |
| `TIMESTAMP WITH LOCAL TIME ZONE` | the same value | `"2026-08-24T07:11:12.345Z"` | unchanged — see below |

#### The intervals

The old objects were lossless and unreadable: nothing in the product reconstructs either one, the
grid showed a JSON blob where a duration belongs, and the SQL export wrote that blob into an
`INTERVAL` column — which Oracle **refuses** (`ORA-01867: the interval is invalid`), so the row was
lost rather than silently wrong.

The literal is composed in the provider, not asked of the driver, because the driver refuses to
produce it: a `fetchTypeHandler` returning `{type: oracledb.STRING}` for either type fails the whole
statement with `NJS-119: conversion from type DB_TYPE_INTERVAL_YM to type DB_TYPE_VARCHAR is not
supported`, and the process-wide `oracledb.fetchAsString` rejects both identities up front with
`NJS-021: invalid type for conversion specified`.

The spelling is Oracle's own signed form rather than the `INTERVAL '3-7' YEAR TO MONTH` keyword form,
and that is a measured choice, not a preference. A cell reaches the SQL export as a **value**, so the
keyword form would be exported quoted — `'INTERVAL ''3-7'' YEAR TO MONTH'` — and Oracle answers
`ORA-01867`. The signed form is accepted as a plain string in exactly the position the export puts
it. Every form below was replayed against the live server:

```
ACCEPTED   INSERT INTO d19_cand (tag, iym) VALUES ('a', '+03-07')
ACCEPTED   INSERT INTO d19_cand (tag, iym) VALUES ('b', '-03-07')
ACCEPTED   INSERT INTO d19_cand (tag, iym) VALUES ('c', '+00-00')
ACCEPTED   INSERT INTO d19_cand (tag, ids) VALUES ('d', '+05 06:07:08.9')
ACCEPTED   INSERT INTO d19_cand (tag, ids) VALUES ('e', '+09 08:07:06')
ACCEPTED   INSERT INTO d19_cand (tag, ids9) VALUES ('h', '+123456789 23:59:59.123456789')
REFUSED    INSERT INTO d19_replay (tag, iym) VALUES ('ym-quoted-keyword', 'INTERVAL ''3-7'' YEAR TO MONTH')
           -> ORA-01867: the interval is invalid
```

Details that follow from the measurements:

- **One leading sign.** A negative interval arrives with *every* field negative
  (`INTERVAL '-3-7'` → `{"months":-7,"years":-3}`), so the sign is taken once and the fields are
  printed absolute: `-03-07`, not `-03--07`.
- **Two digits is a minimum, not a width.** `INTERVAL '123456789-11' YEAR(9) TO MONTH` arrives as
  `{"months":11,"years":123456789}` and is spelled `+123456789-11`, which Oracle takes back into the
  same column. The two-digit padding matches what `TO_CHAR` prints at Oracle's *default* leading
  precision; the declared precision is not in the value, so a `YEAR(4)` column reads `+03-07` here
  where the server's own `TO_CHAR` says `+0003-07`. Same value, different padding.
- **`fseconds` is nanoseconds**, so the fraction is nine digits with trailing zeros trimmed — exact
  for a `SECOND(9)` column, and no fractional part at all for a whole-second interval
  (`+09 08:07:06`).
- **A NULL interval stays `null`**, not a zero interval.

Verified end to end — read through the provider, exported, replayed into a fresh table, and compared
**by the server**, not by re-reading our own spelling:

```
PROVIDER ROWS  [{"K":1,"IYM":"+03-07","IDS":"+05 06:07:08.9"},{"K":2,"IYM":"-03-07","IDS":"+09 08:07:06"},{"K":3,"IYM":null,"IDS":null}]
EXPORT DDL     CREATE TABLE d19_replay ("K" NUMBER, "IYM" INTERVAL YEAR TO MONTH, "IDS" INTERVAL DAY TO SECOND);
EXPORT INSERT  INSERT INTO d19_replay ("K", "IYM", "IDS") VALUES (1, '+03-07', '+05 06:07:08.9');
               INSERT INTO d19_replay ("K", "IYM", "IDS") VALUES (2, '-03-07', '+09 08:07:06');
               INSERT INTO d19_replay ("K", "IYM", "IDS") VALUES (3, NULL, NULL);
REPLAYED       all four statements accepted; rows read back identical
SERVER SAYS    SELECT ... CASE WHEN s.iym = r.iym AND s.ids = r.ids THEN 'EQUAL' ...  ->  EQUAL, EQUAL, EQUAL
               (source TO_CHAR '+0003-07' / '+0005 06:07:08.900000' vs replayed '+03-07' /
                '+05 06:07:08.900000' — the difference is the declared leading precision of the
                exported column, not the value)
```

The columns are found once per result from `metaData[].dbType`, so a query with no interval column
does no per-cell work and keeps the driver's own rows array untouched.

#### The time zones, and why the offset is not recoverable

**A `TIMESTAMP WITH TIME ZONE` loses its stored offset, and this provider cannot keep it.** The
driver has already reduced the value to a UTC instant by the time any code here sees it: it hands
over a JS `Date`, which holds no zone and no sub-millisecond digits.

The obvious candidate was measured and is *worse* than the `Date`. Asking for the column as a string
(`fetchTypeHandler` → `{type: oracledb.STRING}`) is accepted, but what the driver returns is that
same `Date` put through `toString()` — in the **Node process's** time zone, with the milliseconds
gone. Three rows with three different stored offsets, read by a process running in `+03:00`:

```
SERVER TEXT  plus3  2026-08-24 10:11:12.345678 +03:00
             minus7 2026-08-24 10:11:12.345678 -07:00
             named  2026-08-24 10:11:12.345678 ASIA/TOKYO

DEFAULT      plus3  "2026-08-24T07:11:12.345Z"
             minus7 "2026-08-24T17:11:12.345Z"
             named  "2026-08-24T01:11:12.345Z"

AS STRING    plus3  "Mon Aug 24 2026 10:11:12 GMT+0300 (Türkiye Standard Time)"
             minus7 "Mon Aug 24 2026 20:11:12 GMT+0300 (Türkiye Standard Time)"
             named  "Mon Aug 24 2026 04:11:12 GMT+0300 (Türkiye Standard Time)"
```

Every row reports `GMT+0300` — the reader's zone, not the stored one — and `.345` is gone. That
would replace a correct instant with a wrong-looking local rendering, and would break the ordinary
`DATE`/`TIMESTAMP` path the grid formats, so it was rejected. `oracledb.fetchAsString` refuses both
identities outright (`NJS-021`), and the driver exposes no offset beside the `Date`
(`Object.keys(date)` is empty).

So the instant is right and the offset is gone. **A user who needs the stored zone must ask the
server for it**, which is the one place that still has it:

```sql
SELECT TO_CHAR(ttz, 'YYYY-MM-DD HH24:MI:SS.FF6 TZR') FROM t;   -- 2026-08-24 10:11:12.345678 -07:00
```

The same `TO_CHAR` recovers the sub-millisecond digits that a `Date` cannot hold — for a plain
`TIMESTAMP(6)` too, where `.345678` is likewise truncated to `.345`. A `TIMESTAMP WITH LOCAL TIME
ZONE` has no stored offset to lose (Oracle normalizes it on write and renders it in the *session's*
zone), so for that type only the sub-millisecond truncation applies.

#### The SQL export writes an Oracle date literal, not an ISO string

A `Date` cell used **not** to replay at all. The shared export wrote it as its ISO string, and every
one of the four types refuses that — measured 2026-08-25 against the Oracle Free image
(`Oracle AI Database 26ai Free Release 23.26.2.0.0`) by replaying the exported file:

```
D     REFUSED  ORA-01861: literal does not match format string
TS    REFUSED  ORA-01843: An invalid month was specified.
TTZ   REFUSED  ORA-01843: An invalid month was specified.
TLTZ  REFUSED  ORA-01843: An invalid month was specified.
        (all four from INSERT ... VALUES ('2026-08-24T07:11:12.345Z'))
```

So a DDL+INSERT export of any ordinary Oracle table with a date column was unreplayable. The fix is
in the shared export (`src/lib/export/result-export.ts`), not in this provider, and the conversion
function IS the literal — the way `HEXTORAW` already is for a `RAW`. Which function comes from the
**declared** type (`columnTypes`, [§5.4](#54-declared-column-types)), because the two shapes disagree
about which fields of the `Date` are the value:

| declared | written as |
|---|---|
| `DATE` | `TO_DATE('2026-08-24 10:11:12', 'YYYY-MM-DD HH24:MI:SS')` — the **local** fields |
| `TIMESTAMP` (and anything else, and no declared type) | `TO_TIMESTAMP('2026-08-24 10:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3')` — the **local** fields |
| `TIMESTAMP WITH TIME ZONE`, `TIMESTAMP WITH LOCAL TIME ZONE` | `FROM_TZ(TO_TIMESTAMP('2026-08-24 17:11:12.345', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC')` — the **UTC** instant |

- **Local fields for a naive column**, because that is the inverse of what the driver did: it built
  the `Date` by reading the stored wall clock in the *Node process's* zone. Measured above, a `DATE`
  holding `2026-08-24 10:11:12` arrives as `2026-08-24T07:11:12.000Z` from a process at `+03:00`, so
  writing the ISO text would move every naive value by the exporter's own offset — and it would parse,
  which is worse than being refused.
- **`FROM_TZ(..., 'UTC')` for a zoned column**, because the `Date` there is the true instant and the
  stored offset is already gone (above). No offset is invented; the instant is preserved *whatever
  zone the replaying session runs in*, which a plain `TO_TIMESTAMP` is not — it is read in the
  session's zone. Measured by replaying the same instant into a session at `-07:00` and letting the
  server compare it against the source row:

  ```
  fromtz              1999-01-01 18:04:05.006 UTC       EQUAL
  plain-utc-fields    1999-01-01 18:04:05.006 -07:00    DIFF
  plain-local-fields  1999-01-01 21:04:05.006 -07:00    DIFF
  ```

- **What a zoned column loses:** its original zone, and only its zone. A `TIMESTAMP WITH TIME ZONE`
  that read `2026-08-24 10:11:12.345 -07:00` on the source comes back as
  `2026-08-24 17:11:12.345 UTC` on the target — the same moment, rendered as UTC, because the offset
  was gone before the export saw the value. `TIMESTAMP WITH LOCAL TIME ZONE` loses nothing: it has no
  stored offset, and it renders in the reader's session zone on both sides. A user who needs the
  original zone must take it from the server with the `TO_CHAR ... TZR` above, in the same result.
- **Milliseconds are kept** (`FF3`), and a declared `DATE` gets `TO_DATE` because a `DATE` has no
  fractional second at all. Both were measured: a `TO_TIMESTAMP` literal inserted into a `DATE`
  column is accepted and silently truncated to the whole second, so the explicit function only says
  what the column already is.

Verified end to end — read through the provider, exported, replayed into a fresh table, compared **by
the server**:

```
PROVIDER ROWS  [{"K":1,"D":"2026-08-24T07:11:12.000Z","TS":"2026-08-24T07:11:12.345Z","TTZ":"2026-08-24T17:11:12.345Z","TLTZ":"2026-08-24T17:11:12.345Z"},
                {"K":2,"D":"1999-01-01T22:00:00.000Z","TS":"1999-01-02T01:04:05.006Z","TTZ":"1999-01-01T18:04:05.006Z","TLTZ":"1999-01-01T18:04:05.006Z"},
                {"K":3,"D":null,"TS":null,"TTZ":null,"TLTZ":null}]
COLUMN TYPES   {"K":"NUMBER","D":"DATE","TS":"TIMESTAMP","TTZ":"TIMESTAMP WITH TIME ZONE","TLTZ":"TIMESTAMP WITH LOCAL TIME ZONE"}
EXPORT DDL     CREATE TABLE d23_replay ("K" NUMBER, "D" DATE, "TS" TIMESTAMP,
                 "TTZ" TIMESTAMP WITH TIME ZONE, "TLTZ" TIMESTAMP WITH LOCAL TIME ZONE);
EXPORT INSERT  INSERT INTO d23_replay ("K", "D", "TS", "TTZ", "TLTZ") VALUES (2,
                 TO_DATE('1999-01-02 00:00:00', 'YYYY-MM-DD HH24:MI:SS'),
                 TO_TIMESTAMP('1999-01-02 03:04:05.006', 'YYYY-MM-DD HH24:MI:SS.FF3'),
                 FROM_TZ(TO_TIMESTAMP('1999-01-01 18:04:05.006', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC'),
                 FROM_TZ(TO_TIMESTAMP('1999-01-01 18:04:05.006', 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC'));
REPLAYED       CREATE TABLE and all three INSERTs accepted
SERVER SAYS    K=2  D_EQ EQUAL  TS_EQ EQUAL  TTZ_EQ EQUAL  TLTZ_EQ EQUAL
               K=3  (the all-NULL row)       EQUAL on all four
               K=1  DIFF on the three timestamps, by exactly 00:00:00.000678
```

That last row is the truncation this section is about, not an export defect: `K=1` was stored with
`.345678` and a `Date` holds milliseconds, so the server measures the difference as the 678
microseconds the driver dropped (`TO_CHAR(s."TS" - r."TS")` → `+000000000 00:00:00.000678`, and
`+000000000 00:00:00.000000` for the millisecond-exact row). **A sub-millisecond digit does not
survive an export, because it did not survive the driver.**

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
| `getHealth()` | `V$SESSION`, `USER_SEGMENTS`, `V$SYSSTAT`, `V$SQL` | each block guarded → absent/`N/A`/`[]` if no privilege; `activeConnections` is **omitted**, never `0` ([§7.2](#72-when-the-connection-count-is-not-measurable)); `cacheHitRatio` is `N/A`, never `0%` ([§7.1](#71-when-the-cache-hit-ratio-is-not-measurable)) |
| `getOverview()` | `V$VERSION`, `V$INSTANCE`, `V$SESSION`, `V$PARAMETER`, `USER_SEGMENTS`, `USER_TABLES`/`USER_INDEXES` | each guarded |
| `getPerformanceMetrics()` | `V$SYSSTAT` | **only** `cacheHitRatio`, and it is **omitted** when `V$SYSSTAT` cannot be read (no QPS/deadlocks/buffer-pool) — [§7.1](#71-when-the-cache-hit-ratio-is-not-measurable) |
| `getSlowQueries()` | `V$SQL` (top-N by `ELAPSED_TIME`) | `sharedBlksHit`=`BUFFER_GETS`, `sharedBlksRead`=`DISK_READS`; `[]` on failure |
| `getActiveSessions()` | `V$SESSION` ⋈ `V$SQL` | `pid` = `"SID,SERIAL#"`; wait class/event; `[]` on failure |
| `getTableStats()` | `ALL_TABLES` + `USER_SEGMENTS` | sizes + `lastAnalyze`; no live/dead tuples, no bloat; `[]` on failure |
| `getIndexStats()` | `ALL_INDEXES` + `USER_SEGMENTS` + `ALL_IND_COLUMNS` | **`scans` always `0`** (no usage counter exposed); `isPrimary` always `false`; `[]` on failure |
| `getStorageStats()` | `DBA_DATA_FILES` → fallback `USER_SEGMENTS` | per-tablespace size; DBA view falls back to user segments without privilege |

### 7.1 When the cache hit ratio is not measurable

Two states, both ordinary:

- **The connected user cannot read `V$SYSSTAT`.** Measured 2026-08-23 on Oracle AI Database 26ai Free against a
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

### 7.2 When the connection count is not measurable

The health connection count is `SELECT COUNT(*) FROM V$SESSION WHERE STATUS = 'ACTIVE'`, so it needs
the same `V_$` grant everything else here does. The refusal measured 2026-08-23 on Oracle AI Database
26ai Free, against a user granted only `CREATE SESSION`, was on the cache-ratio view
([§7.1](#71-when-the-cache-hit-ratio-is-not-measurable)) - `V_$SESSION` answers in the same shape:

```
ORA-00942: table or view "SYS"."V_$SYSSTAT" does not exist
```

`HealthInfo.activeConnections` is **optional** for this case, so the refused count is **omitted** from
`getHealth()` - the key is absent from the object and from the `POST /api/db/health` body, and the
admin fleet-health row drops its `N conn` figure rather than printing `0 conn`
([`src/components/admin/tabs/OverviewTab.tsx`](../../src/components/admin/tabs/OverviewTab.tsx)).
It used to be initialised to `0` and the guard left that `0` standing, which mattered most to the
agent: its curated `health` reading forwards this figure to the model, so `ORA-00942` arrived as a
*measured* "no active sessions" about an instance Oracle had said nothing about.

An instance that really has no ACTIVE session measures `0`, and that `0` is a reading: it is kept and
reported as `0`. The absence is spelled `measuredNumber(...)` plus a conditional spread, never
`|| undefined`.

---

## 9. Maintenance

`runMaintenance(type, target?)` ([oracle.ts:586](../../src/lib/db/providers/sql/oracle.ts)):

| Type | With target | Without target |
|------|-------------|----------------|
| `analyze` | `DBMS_STATS.GATHER_TABLE_STATS(USER, '<t>')` | `DBMS_STATS.GATHER_SCHEMA_STATS(USER)` |
| `optimize` | rebuild the indexes THAT TABLE owns: `SELECT INDEX_NAME FROM USER_INDEXES WHERE TABLE_NAME = :t AND INDEX_TYPE = 'NORMAL'`, then `ALTER INDEX "<i>" REBUILD` for each (own try/catch) | rebuild **every** normal user index (`USER_INDEXES`, each in its own try/catch) |
| `kill` | `ALTER SYSTEM KILL SESSION '<SID,SERIAL#>'` | throws (`SID,SERIAL#` required) |

`getCapabilities().maintenanceOperations = ['analyze', 'optimize', 'kill']`. Targets are
**inline-escaped** (single quotes doubled for the PL/SQL string literal; double quotes doubled for
the quoted index identifier) rather than routed through `escapeIdentifier()`, because they sit
inside `DBMS_STATS` arguments / `ALTER` identifiers that can't take bind parameters. The
`optimize` catalog read is the exception: `TABLE_NAME = :tableName` sits in a WHERE clause,
which does take a bind.

### Where each operation may be offered (`maintenanceOperationSpecs`)

Declaring that an operation EXISTS is not enough to put a button on it: two engines that
declare the same `MaintenanceType` take different kinds of target, so each provider also
declares what its own operations may be pointed at. The monitoring Tables tab renders a
per-row control only where `perEntity` is true, the admin Operations tab a whole-database
card only where `global` is true, and both take the wording from `label` (#U9).

`POST /api/db/maintenance` reads the same declaration since #U20, and it is the one reader that
REFUSES rather than hides: it takes the placement from whether the request carries a `target`
(absent or empty means whole-database) and answers `400` when this provider marks that
placement unavailable while the other one is available. On Oracle it never speaks: every
declaration above is either both placements or neither. `kill` declaring neither is not "takes
no target" - `SID,SERIAL#` comes from the Sessions panel, which this field says nothing about -
so those requests pass through.

| Operation | Control label | Per-row | Global | Why |
|-----------|---------------|---------|--------|-----|
| `analyze` | Gather Statistics | yes | yes | `GATHER_TABLE_STATS` / `GATHER_SCHEMA_STATS` |
| `optimize` | Rebuild Indexes | yes | yes | the target is a TABLE, and its own indexes are rebuilt - the shape SQL Server's identically worded `ALTER INDEX ALL ON [<t>] REBUILD` has |
| `kill` | Kill Session | no | no | the target is `SID,SERIAL#` from the Sessions panel |

`optimize` used to take an INDEX name, so the per-table button #427 wired up sent a table
and every click answered **ORA-01418: specified index does not exist** - reproduced against
`ldb-oracle-r5` on 2026-08-25 and re-run after the fix, which brought an `UNUSABLE` index
on the named table back to `VALID` both with a target and without one. That container's
`SELECT BANNER_FULL FROM V$VERSION` answers *"Oracle AI Database 26ai Free Release
23.26.2.0.0"*, which is the product name used throughout this document. `INDEX_TYPE =
'NORMAL'` excludes what `ALTER INDEX ... REBUILD` cannot take (the LOB index a CLOB column
creates was present in that probe) and keeps the B-tree indexes that back UNIQUE and PRIMARY
KEY constraints. A table with no rebuildable index succeeds having rebuilt nothing: "nothing
to do" is not a failure, and neither is a heap table.

**An empty index list has two causes, and they are not the same fact.** A target the schema
does not own answered `{"success": true}` in ~1 ms having done nothing at all - measured
through the provider on 2026-08-25 for `U9MISSING` (no such table) and for `u9real` (a real
table spelled in the wrong case, which Oracle stores folded to upper case). Where
`TABLE_NAME = :t` returns no index, `SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME = :t`
is asked as well, and a target that catalog does not know is reported as a failed operation:

| Target | Result |
|--------|--------|
| `U9REAL` (one index) | `success: true` · *"OPTIMIZE: rebuilt 1 of 1 indexes."* |
| `U9HEAP` (no index, real table) | `success: true` · *"OPTIMIZE: rebuilt 0 of 0 indexes."* |
| `u9real` (case mismatch) | `success: false` · *"this schema owns no TABLE named u9real …"* |
| `U9MISSING` (absent) | `success: false` · *"this schema owns no TABLE named U9MISSING …"* |
| a plain VIEW | `success: false` · the same sentence, which is why it names the view case too |
| no target (whole schema) | `success: true` · *"OPTIMIZE: rebuilt 27 of 30 indexes."* |
| every index of the table refused | `success: false` · *"rebuilt 0 of 2 indexes. ORA-01647 …"* |

The existence question is asked ONLY when the index list came back empty, so the ordinary
path stays at one catalog read. `USER_TABLES` is the catalog that answers it because it is
not narrower than `USER_INDEXES`: measured on the same container, a MATERIALIZED VIEW's
container appears there under the view's own name and its indexes are keyed to that name,
while a plain VIEW appears in neither - and a view owns no index for "Rebuild Indexes" to
have rebuilt. The count in the message is there because tolerating one failed index means
`success: true` alone cannot distinguish 2 of 2 from 1 of 2.

**None of them rebuilding is a third fact.** One index failing leaves the run completed - an
offline tablespace or an unusable partition stops that index alone - but a table where EVERY
rebuild is refused had nothing it was asked to do happen. Measured on 2026-08-25 with the
table's tablespace put READ ONLY, so every `ALTER INDEX ... REBUILD` answers ORA-01647: this
reported `{"success": true, "message": "OPTIMIZE: rebuilt 0 of 2 indexes."}` in 14 ms with the
ORA text discarded in an empty `catch`. It now reports `success: false` and carries the
engine's first refusal, because the count says how many and only the ORA text says why. A
table with no index at all keeps its success: nothing to do is still not a failure.

`vacuumAction` has said *"Rebuild Indexes"* since this provider shipped, and that is
`optimize`, not a `vacuum` Oracle has no statement for: `vacuumActionOperation: 'optimize'`
is what lets the Operations tab render those words and send an operation Oracle declares.

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
are pinned from live measurements ([§5.3](#53-what-each-oracle-type-arrives-as)). The same holds for
the two `INTERVAL` identities and the `IntervalYM`/`IntervalDS` field shapes
([§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be)) — and those
constants are typed as the driver's `DbType` from `src/types/db-drivers.d.ts`, which is what keeps
the mock and the provider reading the same declaration. That declaration is hand-written because
**`oracledb` publishes none** (verified on 6.10.0: no `types`/`typings` field, no `.d.ts` in the
package, and no `@types/oracledb` dependency here), so a driver upgrade that changes a shape is
caught by a live probe, not by `tsc`.

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
alone and that a `BLOB` reaches `asBytes` in both its live and its serialized shape), **the
`INTERVAL` literals** (both types, positive/negative/zero, a nine-digit year count, nanosecond
precision, `NULL`, both query paths, and that a result with no interval column keeps the driver's own
rows array), error mapping,
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
- **`TIMESTAMP WITH TIME ZONE` arrives as a `Date`**, so the stated offset is folded into UTC and
  sub-millisecond precision is dropped (`+03:00 10:11:12.345678` measured as
  `"2026-08-24T07:11:12.345Z"`). **Not fixable here:** the driver produces a `Date` and offers no
  string form that keeps the offset — measured, asking for one returns the reader process's own time
  zone for every row. `TO_CHAR(col, '… TZR')` is the way to see the stored zone
  ([§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be)).
- **A zoned timestamp replays as UTC, not in its original zone.** The SQL export writes a date cell
  through Oracle's own conversion functions, so the file does replay with the instant intact
  ([§5.5](#55-an-interval-is-normalized-to-its-oracle-literal-a-time-zone-cannot-be)) — but the
  stored offset is gone before the export sees the value, so a `TIMESTAMP WITH TIME ZONE` written
  `10:11:12.345 -07:00` comes back rendered `17:11:12.345 UTC`, and the sub-millisecond digits a
  `Date` cannot hold are not in the file either. Both are the driver's truncation, above, not the
  export's.
- **`oracledb` ships no TypeScript declarations, so the driver surface is hand-declared.** Verified
  on 6.10.0: no `types`/`typings` field in its `package.json` and no `.d.ts` anywhere in the package,
  and there is no `@types/oracledb` in this project's dependencies. `src/types/db-drivers.d.ts`
  declares the members this provider actually uses instead of the blanket `any` it used to; that
  declaration is checked against the driver only by the live probes and the integration mock, so a
  driver upgrade that changes a shape will not be caught by `tsc` alone.
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
  degrade to absent/`N/A`/`[]`).
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
- **Monitoring depends on `V$` privileges.** A low-privilege app user silently gets `N/A`/`[]` for the
  views it can't read, and no `activeConnections` at all in the health reading
  ([§7.2](#72-when-the-connection-count-is-not-measurable)). `getPerformanceMetrics()` reports only the cache-hit ratio (no QPS,
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
