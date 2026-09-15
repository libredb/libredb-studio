# IBM Db2 for Linux, UNIX and Windows (Db2 LUW) Provider

> Db2 LUW support for LibreDB Studio, built on the [`ibm_db`](https://github.com/ibmdb/node-ibm_db)
> native driver. This is the prime reference for the `db2` type-id: the cross-cutting architecture
> and the step-by-step authoring guide live in [`../DATABASE_PROVIDERS.md`](../DATABASE_PROVIDERS.md)
> and [`../ADDING_A_PROVIDER.md`](../ADDING_A_PROVIDER.md).

> **Status: verified against a live server (gate-4 complete).** The live pass ran against Db2
> v11.5.9.0 and v11.5.x; items proven there are marked "measured". The
> pass also surfaced and fixed one bug — `query()` originally dropped its bound-parameter argument,
> which broke inline row edit (`CLI0100E Wrong number of parameters`); see §3.8 and §9. A few
> decisions (`supportsExplain`, the standalone-safe type names in the export layer) remain
> deliberately conservative and are called out as follow-ups rather than gaps.

---

## 1. Overview

Db2 LUW is a proprietary relational engine reached over the **DRDA binary protocol** over TCP. Unlike
the driver-free HTTP providers (ClickHouse, Druid, Trino, the search pair, Couchbase, libSQL), a
browser cannot talk to it and neither can `fetch`, so it carries a native driver. It maps onto the
`DatabaseProvider` interface like the other SQL providers, via the `ibm_db` package, and extends
[`SQLBaseProvider`](../../src/lib/db/providers/sql/sql-base.ts).

Its SQL is standard-shaped: double-quoted identifiers and `FETCH FIRST n ROWS ONLY` /
`OFFSET n ROWS FETCH NEXT n ROWS ONLY` pagination are both correct Db2, exactly as they are on
Oracle 12c+. So identifier escaping is **inherited unchanged** from `SQLBaseProvider`, and the only
dialect override is `prepareQuery()` — the same shape as the Oracle provider.

Type-id: `db2`. Default port: **50000** (the conventional DRDA listener port). Query language: `sql`.

### Why a driver, and why `ibm_db`

Db2 LUW does expose a first-class HTTP path — the **Db2 REST service**'s `/v1/services/execsql`
endpoint runs arbitrary SQL and returns JSON. It was weighed and rejected for v1 for two reasons: the
REST service is a **separately deployed container** that is not listening on a standard Db2 by
default, and `execsql` (arbitrary SQL) is the endpoint security-conscious sites most often disable.
An IDE that must reach any standard Db2 the way DBeaver or DataGrip do therefore uses the driver. The
REST transport remains a possible future addition behind the same provider (see §8).

`ibm_db` is a **native N-API addon** whose install step downloads or compiles the IBM CLI/ODBC
driver. This is the material cost of the provider and it is stated plainly rather than hidden — it is
the same category as DuckDB's `@duckdb/node-api` (see [`duckdb.md`](./duckdb.md)):

- **It grows every distribution channel.** The addon and its CLI driver land in the Docker image, the
  Snap/AppImage/Flatpak/deb/rpm channels, and the `@libredb/studio` npm package that
  libredb-platform consumes.
- **Its install can fail in an air-gapped or egress-restricted network**, because the postinstall
  fetches the CLI driver from IBM. `ibm_db` is listed in `package.json` `trustedDependencies` so its
  postinstall runs under Bun.
- **It is a compiled addon that needs Node, not Bun.** Measured with Bun 1.4.2 on 2026-09-15: the
  module loads, and the first `ibm_db.open()` panics the whole process with
  `unsupported uv function: uv_default_loop`. Every shipped entry point runs the server under Node
  (`next dev`/`next start`, the Docker image, and `bin/studio.js`, whose `#!/usr/bin/env node` shebang
  is load-bearing for the same reason it is for `better-sqlite3`), so only a caller who asks for
  `bunx --bun` reaches it. The mock-based suite runs under Bun and never loads the addon.

The trade the driver-free providers make — you own the pooling, failover and retry the driver would
otherwise write — applies here too, and this provider makes the editor's choice: it holds **one**
connection and serialises queries onto it, with no pool, failover or retry. Acceptable for an
interactive editor; not for a high-throughput application.

---

## 2. Architecture

Same Strategy-Pattern hierarchy as the other SQL providers:

```
BaseDatabaseProvider (abstract)
└── SQLBaseProvider (abstract)   ← identifier escaping, LIMIT helpers, read-only detection
    └── Db2Provider              ← src/lib/db/providers/sql/db2/index.ts
                                   (catalog statements and row mapping in db2/objects.ts)
```

The `ibm_db` surface the provider touches (`open` → a connection with `query`/`close`) is declared
**locally** in the provider file rather than imported, because the package's published typings do not
describe a promise API and are incomplete. The provider wraps each callback in a promise at that
boundary.

---

## 3. Design decisions

### 3.1 One connection, no pool

`ibm_db` has connection-pool helpers, but this provider holds a single connection and serialises onto
it, the same way the editor's other single-purpose reads work. A pool is future work if a Db2
workload ever needs it; the transport seam is the connection object, so adding one is contained.

### 3.2 `prepareQuery()` mirrors Oracle

Db2 spells a first page `FETCH FIRST n ROWS ONLY` and a later page
`OFFSET n ROWS FETCH NEXT n ROWS ONLY` — byte-identical to Oracle. The override therefore copies
Oracle's: it builds on the statement's own text via `readStatementEnd()` and **declines** (reports
`wasLimited: false`) when the tail cannot be safely cut, so a clause is never appended inside a
trailing comment (the #280 hazard). It only rewrites a `SELECT` that does not already carry a bound.

### 3.3 The object surface reads `SYSCAT.*` across every schema (#789)

The object browser is not confined to `CURRENT SCHEMA`.
See §6.1 for the containers, kinds and addresses, and for every catalog fact they rest on.

### 3.4 `columnTypes` is omitted, deliberately

`ibm_db`'s high-level `query()` surface hands back row objects keyed by column name and does **not**
expose a declared per-column type name. Rather than guess one, the provider derives `fields` from the
first row's keys and **omits** `QueryResult.columnTypes`. Absence is the signal the grid reads
(issue #273) — an omitted field is treated correctly, an empty object would not be. Reading declared
types through the driver's lower-level prepared-statement `describeColumns`/`getColumnMetadata`
surface is a verified follow-up, gated on a live pass.

### 3.5 REORG-pending is the one Db2-specific migration hazard

Db2 places a table in **REORG-pending** state after certain structural `ALTER`s. Verified against
IBM's documentation ("a table is placed in reorg pending mode if you alter its physical structure,
such as add or drop a column or change the column data type or nullability"), the triggers this
provider's migrations account for are:

- **DROP COLUMN** — a removed column;
- **ALTER COLUMN … SET DATA TYPE** — a modified column whose type changed;
- **SET / DROP NOT NULL** — a modified column whose nullability changed.

What does **not** trigger it, and is deliberately excluded so the advisory is not a false positive:
a plain **ADD COLUMN** (immediate on Db2 LUW — this is the z/OS-vs-LUW difference: some z/OS ADD forms
go AREOR, LUW's do not), a **DEFAULT-only change** (`SET`/`DROP DEFAULT` with no type or nullability
change is metadata-only), and **index/foreign-key** changes.

The table becomes read-restricted (`SQL0668N` reason code 7) until a `REORG TABLE` materializes the
change. No other engine here behaves this way; the rest apply these changes synchronously.

Two nuances from IBM's "Multiple ALTER TABLE operations within a single unit of work" page, both
operational rather than generatable, so the advisory does not try to model them and the DBA owns
them: (1) the state is **not immediate per statement** — Db2 LUW lets an unlimited number of these
ALTERs run across up to **~31 units of work** before a `REORG TABLE` is *forced*; (2) since
**10.5.0.5**, once a table is already reorg-pending a column's data type may be altered **only once**
before a REORG is required. And the block is partial, not total: in reorg-pending "**many types of
queries cannot be run**" until the table is reorganized, not that the table is entirely inaccessible.
Because a migration this generator writes is one file a DBA applies once, a single trailing REORG
advisory per table is the correct guidance regardless of either threshold.

The schema-diff **migration generator** ([`migration-generator.ts`](../../src/lib/schema-diff/migration-generator.ts))
handles this by emitting a **commented advisory** — not an executable statement — once per affected
table, after the ALTERs it refers to:

```sql
-- Db2: the ALTERs above may leave "orders" in REORG-pending, where many query types are blocked until it is reorganized.
-- Run this OUTSIDE the transaction above, and mind that it can be slow and lock-heavy on a large table:
--   CALL SYSPROC.ADMIN_CMD('REORG TABLE "orders"');
```

It is a comment rather than a live statement for two reasons, both load-bearing: a `REORG` can be
**very slow and lock-heavy** in proportion to table size, so a migration file must not run one
unattended; and a `REORG` **cannot run inside the `BEGIN;`/`COMMIT;` unit of work** the generator
wraps DDL in (`ADMIN_CMD` commits internally). This follows the generator's established pattern for
anything it cannot emit as both correct and safe to run blindly (compare `NO_PORTABLE_INDEX_DDL`'s
"write the index change by hand" and SQLite's "Requires table recreation"). A single `REORG` clears
any number of changes batched in one unit of work, so one advisory per table is emitted rather than
one per column.

Note the asymmetry with the **explicit maintenance action**: the admin Operations tab's "Reorganize
Table" runs a real `REORG` (§7), because that is a user clicking a button on one table they chose, not
a file applied unattended — the same posture SQL Server's "Rebuild Indexes" takes for its own
potentially-slow operation.

### 3.6 Capability honesty

`getCapabilities()` declares only what works, because a flag that is `true` but cannot work produces a
control that only emits invalid input (the defect class #194/#201 were about):

| Capability | Value | Why |
|---|---|---|
| `supportsExplain` | `false` | Db2 EXPLAIN populates the explain tables (`EXPLAIN_STATEMENT` et al.) rather than returning a plan from one statement, which the single-statement explain path cannot express — the same posture as Oracle and SQL Server (#126). Adding it later is additive: a new `ExplainFormat` union member, a strategy, and flipping this flag. |
| `supportsCreateTable` | `true` (inherited) | Db2 has full `CREATE TABLE`. |
| `supportsInlineRowEdit` | `true` | Db2 accepts the single-table `UPDATE <t> SET <col> = <val> WHERE <pk> = <val>` the results grid builds. |
| `supportsTransactions` | `false` | This provider holds no interactive-transaction session wired to `POST /api/db/transaction` yet, so the toolbar trio and SANDBOX stay hidden rather than offer a control the route would refuse. Db2 has transactions; this is a statement about the provider's surface, exactly as SQLite's `false` is. Future work. |
| `declaresForeignKeys` | `true` (inherited) | Db2 has referential constraints. |
| `maintenanceOperations` | `["analyze", "optimize"]` | `analyze` → `RUNSTATS`, `optimize` → `REORG TABLE`. `check`, a SQL-reachable `kill`, and index rebuild are left off the initial set rather than claimed unverified; widen after the live pass. |

### 3.7 Other Db2 table states that can block a query (provider context)

REORG-pending (§3.5) is the one state the **migration generator** must account for, because the DDL
it writes causes it. But Db2 LUW has a wider family of table/table-space states that make a table
partially or fully inaccessible, and the **provider** can meet any of them at query time — they are
caused by **utilities and constraints**, not by our DDL, so there is nothing to generate for them.
They are recorded here so the behaviour is understood rather than surprising:

- **Set Integrity Pending** (historically "Check Pending"): a table with constraints or a dependent
  materialized query table can enter this after a `LOAD`, or after `SET INTEGRITY … OFF`, until
  `SET INTEGRITY` re-validates it. Referential and check constraints are unchecked meanwhile.
- **Load Pending / Load in Progress**: a `LOAD` that is running, or that failed/was interrupted,
  leaves the table transiently or persistently unusable until the load is completed or terminated.
- **Restore Pending / Rollforward Pending**: recovery states after certain backup/restore or
  roll-forward sequences.
- **Table-space states** generally (`SYSIBMADM.ADMINTABINFO`, `LOAD QUERY`, or
  `db2 get snapshot`): backup-pending, restore-pending, and others.

The common thread for the provider is the **`SQL0668N`** family (SQLSTATE `57016` / `57007`), whose
reason code names the specific state (reason code 7 is REORG-pending). The provider does **not** try
to pre-empt these — it runs the user's statement and surfaces whatever the engine returns through
`mapDatabaseError(err, 'db2', sql)`, so a blocked table reads as an error with Db2's own message
rather than as an empty result. A Db2-specific error branch that decodes the `SQL0668N` reason code
into a plain-language hint ("run REORG TABLE", "run SET INTEGRITY") is a possible future refinement,
gated on seeing the exact driver error text on a live pass (§9); it is deliberately not guessed here.

### 3.8 Transaction and value semantics (autocommit, isolation, LOBs)

The runtime behaviours that most often surprise on a new SQL provider, and where this one stands:

- **Autocommit is ON.** `ibm_db` opens every connection in autocommit mode by default (IBM: "By
  default, the ibm_db API opens every connection in autocommit mode"), so each editor statement is
  its own complete transaction and nothing is left uncommitted between runs. This is the right
  default for an interactive editor and matches the posture the Oracle provider sets explicitly
  (`oracledb.autoCommit = true`). It is also consistent with `supportsTransactions: false` (§3.6):
  there is no held session, so there is no half-open transaction to worry about. If an
  interactive-transaction session is added later, it will turn autocommit off for that one held
  connection only.

- **Isolation level: Db2's default, Cursor Stability (CS).** Read-committed-like, which is the
  correct default for browsing and querying; the provider sets no override. A future transaction
  session could expose the level, but the editor's read path does not need to.

- **CLOB → string, measured.** Verified against Db2 v11.5.9.0 (`ibm_db` 4.0.1): `query()`
  materializes a CLOB into the row object as a string — it does not hand back the CLI LOB *locator* —
  so a CLOB serializes cleanly to the grid, CSV and SQL export with no special handling, unlike
  Oracle, whose driver returns a `Lob` stream this repo had to convert (see [`oracle.md`](./oracle.md)
  and `oracle.ts`'s `lobFetchTypeHandler`). No equivalent handler is needed for Db2 CLOBs. A very
  large CLOB could be bound to a file with the driver's `bindFileToCol` if the inline value ever
  proves impractical, but nothing in the editor path needs that.

- **BLOB → `Buffer`, measured — no normalization needed.** This was an open question (an older
  `ibm_db` issue, [#860](https://github.com/ibmdb/node-ibm_db/issues/860) from 2022, reported a BLOB
  coming back as a string). It is resolved in the pinned driver: verified against Db2 v11.5.9.0 with
  `ibm_db` 4.0.1, a `BLOB(X'0102DEADBEEF')` round-trips as a real Node `Buffer`
  (`{"type":"Buffer","data":[1,2,222,173,190,239]}`), which is exactly the shape the product's binary
  contract (`asBytes`/`binaryText` in `src/lib/export/binary.ts`) accepts — the same representation
  the `pg` driver produces for `bytea`. So a BLOB renders, previews and exports with no
  provider-boundary work. The JDBC driver's clean `java.sql.Blob` handling was never evidence for
  `ibm_db` either way; the driver itself was measured.

- **DECFLOAT / INTEGER → number, and BIGINT → string, measured.** Against Db2 v11.5.x with `ibm_db`
  4.0.1: `DECIMAL`, `DECFLOAT`, `REAL`, `DOUBLE` and `INTEGER` come back as JS numbers, exact. The
  integer caution the guide raises for every engine is **settled here rather than deferred**: a
  `BIGINT` of `9223372036854775807` (2^63−1, well past `Number.MAX_SAFE_INTEGER`) came back as the JS
  **string** `"9223372036854775807"` — so the driver preserves it losslessly the way `pg` returns
  `int8`, and no widening or precision fix is needed. (`SYSCAT.TABLES.CARD` likewise arrives as a
  string, which the listing reads through `Number(...)`.)

- **Db2-only types, measured.** `VARGRAPHIC` → string, `XML` → its serialized text
  (`<?xml …?><root>…`), and `DATE`/`TIME`/`TIMESTAMP` → strings — all render sanely in the grid and
  export. One expected quirk worth stating so it is not filed as a bug: a fixed-width **`CHAR(n)`
  comes back space-padded to its width** (`CHAR(5)` of `'abc'` → `"abc  "`). That is correct Db2/SQL
  semantics — the stored value *is* padded — and it matches how other SQL clients show `CHAR`; the
  provider does not trim it, because trimming would hide real data and break equality against a
  padded key.

---

## 4. Connection

### 4.1 Configuration

Field-based: `host`, `port` (default 50000), `user`, `password`, `database`. The provider builds the
DRDA connection string `ibm_db.open` expects — a semicolon-delimited `KEY=VALUE;` attribute list:

```
DATABASE=<db>;HOSTNAME=<host>;PORT=<port>;PROTOCOL=TCPIP;UID=<user>;PWD=<password>;
```

A **pasted connection string** (the modal's connection-string toggle is on) is passed to the driver
**unchanged**, so a user's own attributes (`SECURITY`, `Authentication`, …) decide — the same rule the
Oracle and SQL Server providers follow. The `db2://host:port/database` URI scheme parses into the
host/port/database fields (`connection-string-parser.ts`); it is the scheme common ORMs/tools emit,
since Db2's own canonical form is the attribute list rather than a URI.

`validate()` requires a `host` and a `database` unless a connection string is supplied.

**Delimiter guard.** The attribute list has no escaping for its `;` separator, and the CLI driver
honours no brace/quote form (measured: `UID={value}` is taken literally). A field value containing `;`
would therefore split into extra attributes — a password `pa;ss` misparses so auth fails on `pa`, and a
crafted value can INJECT an attribute (`PWD=x;SECURITY=NONE` was shown to connect). So `validate()`
refuses a `;` in any field it interpolates (`host`, `database`, `user`, `password`) and points the user
at the connection-string field, which they own end to end and which is passed through unchanged.

### 4.2 TLS

When the SSL mode is not `disable`, `SECURITY=SSL` is added to the attribute list — Db2's own switch
for TLS on the wire. This is the audited shape of the attribute list, **not** a verified TLS path: the
compose fixture (§9) speaks plaintext, so the TLS handshake is not exercised until a live pass against
a TLS-configured server. Kerberos and client-certificate auth are out of scope for v1.

---

## 5. Query format

Ordinary SQL in the `sql` field; the SQL editor and the shared query limiter apply. Positional
parameters are `?` (`positionalPlaceholder('db2', …)` → `?`), the same as MySQL/SQLite/Druid. String
literals use standard escaping (doubled single quote, backslash is data). The grammar reads under the
compatibility default (no `#` line comment, `"..."` identifiers rather than `[...]`, non-nesting block
comments, no `q'...'`) — see [`grammar.ts`](../../src/lib/sql/grammar.ts); confirm on the live pass.

**Bound `?` parameters are forwarded to the driver, measured.** `query(sql, params)` passes the values
array straight to `ibm_db`'s `conn.query(sql, params, cb)` so a `?`-marked statement binds
positionally; a call with no params uses the two-arg `conn.query(sql, cb)` form, because `ibm_db`
reads a function in the params slot as the callback and an empty array against a marker-less statement
can raise `CLI0100E Wrong number of parameters`. This is the path inline row edit relies on: the grid
sends `UPDATE t SET "col" = ? WHERE "id" = ?` with a separate values array (issue #290), verified
end-to-end against Db2 v11.5.9.0 — the edited value persists on re-query. (This corrects a first-cut
bug where `query()` ignored its params argument and every bound statement failed with `CLI0100E`.)

---

## 6. Schema and monitoring

The object surface is real (§6.1), and so is most of the monitoring set. Db2's live data lives in the
`MON_GET_*` table functions and `SYSIBMADM.*` administrative views. These are **permission-gated**
(they need SYSMON authority or an explicit grant), so every read is wrapped to return empty on refusal
rather than throw — a locked-down account degrades to blank panels while a monitoring-authorized
account (measured on Db2 v11.5.9.0) gets real figures:

- `getOverview()` reads the service level from `SYSPROC.ENV_GET_INST_INFO()` for the version, the live
  connection count from `MON_GET_CONNECTION`, the database-wide table/index counts from `SYSCAT.TABLES`
  and `SYSCAT.INDEXES`, uptime from the database activation time (`MON_GET_DATABASE.DB_CONN_TIME`), and
  the database size as the sum of used tablespace bytes (`MON_GET_TABLESPACE`, the same read the Storage
  panel uses). Each gated read is independent: a denied one leaves its own field neutral (`"Unknown"`
  version, `"N/A"` uptime/size, absent `activeConnections`) rather than failing the whole overview.
  `maxConnections` is the configured `maxappls` ceiling from `SYSIBMADM.DBCFG` (Db2's per-database
  concurrent-application limit; the DBM-level `max_connections` is often `-1`/automatic), left `0` when
  that config read is refused.
- `getPerformanceMetrics()` / `getHealth()` report a **cache hit ratio** and **deadlocks**. The hit
  ratio comes from `SYSIBMADM.BP_HITRATIO` (summed `(logical − physical) / logical` across buffer
  pools). That snapshot view is used rather than `MON_GET_BUFFERPOOL` on purpose: the `MON_GET_*` read
  counters only accumulate when the database's `mon_obj_metrics` config is on (measured `NONE` on a live
  catalog, where every counter read 0), whereas `BP_HITRATIO` reports real reads regardless. The ratio
  is still omitted (never zeroed) on a refused read or a database with no reads at all. Deadlocks come
  from `MON_GET_DATABASE.DEADLOCKS` and keep a measured `0` (a real fact), omitted only on refusal.
- Uptime (in `getOverview`) is computed **inside the database** as elapsed seconds from
  `MON_GET_DATABASE.DB_CONN_TIME` against `CURRENT_TIMESTAMP`, not by parsing the activation timestamp
  in Node: `DB_CONN_TIME` carries no timezone, so subtracting it from a JS `Date.now()` produced a
  negative uptime whenever the server and app clocks differed (a UTC server read as local time). A
  negative or unreadable value falls back to `"N/A"`.
- `getActiveSessions()` lists live connections from `MON_GET_CONNECTION` (handle, auth id, application
  name, client address). Db2 exposes no per-connection "current statement" or state column on this
  surface the way PostgreSQL's `pg_stat_activity` does, so `state` is reported as `"active"` (the row
  exists because the connection is live) and `query` is left empty rather than invented.
- `getSlowQueries()` returns the costliest statements from the package cache
  (`MON_GET_PKG_CACHE_STMT`): statement text, execution count, total activity time, and a per-row
  average. It is a cache snapshot, not an exhaustive history — a statement evicted from the cache is
  not listed. **Timings depend on the database's `mon_req_metrics`/`mon_act_metrics` config.** With
  metrics off (the default on many installs), Db2 records execution *counts* but not *times*, so every
  statement reports `NUM_EXEC_WITH_METRICS = 0` and a `0` time; the query filters those rows out, so the
  panel shows real slow queries when the server collects timings and its empty state — rather than a
  list of misleading `0.00 ms` rows — when it does not. Enabling metrics (`UPDATE DB CFG … USING
  mon_req_metrics BASE`) is a DBA action the app does not take.
- `getStorageStats()` returns per-tablespace sizing from `MON_GET_TABLESPACE` (used pages × page size
  for bytes, used/total for fill percentage). This is the real, cheap storage view and populates the
  Storage tab's tablespace list. The tab's separate "Storage Breakdown" (a Table-Data vs Indexes split)
  stays "N/A": Db2 tablespaces are typed `LARGE`/`ANY`/`*TEMP`, not data-vs-index, so the split cannot
  come from tablespaces, and the only per-object source, `SYSPROC.ADMIN_GET_TAB_INFO`, is a full scan
  (measured at tens of seconds on a large schema) — far too slow for a panel read. Per-object byte
  sizes are a documented limitation, not a quick win.
- `getTableStats()` returns per-table rows from `SYSCAT.TABLES`: a row count (`CARD`) and the timestamp
  of the RUNSTATS that produced it (`STATS_TIME`), so the admin Operations/Monitoring "Tables" panel
  lists every table with its count. Two caveats are carried rather than smoothed over:
  - **The count is only as current as the last RUNSTATS.** `CARD` is not live; it is whatever RUNSTATS
    last wrote, which can be very old. Measured on a real catalog, table counts in a single schema
    ranged over several years apart. `STATS_TIME` is surfaced as `TableStats.lastAnalyze` precisely so the age
    of the number is visible rather than implied to be current.
  - **A table that never had RUNSTATS reports `CARD = -1` and `STATS_TIME = NULL`** (a large fraction of
    tables in a real catalog had never been RUNSTATS'd). The provider maps that to `rowCount: 0` with
    **no** `lastAnalyze`, so it reads as "no stats yet" rather than surfacing a literal `-1`.
  - **Size is not read per table.** Db2's only per-table size is `SYSPROC.ADMIN_GET_TAB_INFO`, a table
    function called one table at a time; running it across a whole schema is too heavy for
    a panel read, so the required `totalSize`/`totalSizeBytes` carry the `"N/A"`/`0` placeholder and the
    byte fields are omitted (the same honest-absence contract the SQLite provider uses). Bulk per-table
    size is a follow-up.

- `getIndexStats()` returns per-index rows for the current schema from `SYSCAT.INDEXES` +
  `SYSCAT.INDEXCOLUSE` (name, table, key columns, unique/primary from `UNIQUERULE`, index type), with
  scan counts LEFT JOINed from `MON_GET_INDEX` — real where an index has been scanned since activation,
  `0` otherwise. Index size is not derived (`indexSize` carries the `"N/A"` placeholder, byte field
  omitted): `NLEAF` is leaf *pages* whose byte size depends on the index's tablespace page size, a
  per-object lookup too heavy for a panel read and meaningless before RUNSTATS.

Still neutral: `getHealth().databaseSize` stays `"N/A"` (the Overview card shows the real size from
`getOverview`; a single figure on `getHealth` would need `SYSPROC.GET_DBSIZE_INFO`, which returns
through OUT parameters rather than a result set — a follow-up). Every gated read that a restricted
account cannot run returns empty, never throws.

### 6.1 The object surface (#789)

One container level, the **schema**, read from `SYSCAT.SCHEMATA`.
Every read below binds the schema and the object name as `?` markers, so nothing a caller supplies is interpolated.
Measured against `icr.io/db2_community/db2:12.1.0.0` with [`docker/db2-init/01-object-fixture.sql`](../../docker/db2-init/01-object-fixture.sql) on 2026-09-15.

**Which schemas are listed.**
Every schema except `SYS%`, `NULLID` and `SQLJ`.
The rule is by name because the owner cannot separate them: the schema Db2 creates implicitly on a user's first unqualified `CREATE` is `OWNER SYSIBM`, `OWNERTYPE 'S'`, exactly like `SYSCAT`.
An upper-case `SYS` prefix is reserved (`CREATE SCHEMA SYSX` answers `SQL0553N`), while a delimited lower-case `"sysx"` is a legal user schema, and `LIKE` is case-sensitive, so that one stays listed.
`SCHEMANAME` comes back blank-padded to eight characters (`"APP     "`), so the read trims it; object names are not padded.
The schema equal to `CURRENT SCHEMA` is marked as the session default, and it is marked only when it exists: a fresh `db2inst1` connection has `CURRENT SCHEMA` `DB2INST1`, which is not a schema until something is created in it.

**Nine kinds.**

| Kind | Catalog | Address | Source |
|---|---|---|---|
| `table` | `SYSCAT.TABLES` `TYPE 'T'` | `[schema, name]` | Not supported |
| `view` | `TYPE 'V'` | `[schema, name]` | `SYSCAT.VIEWS.TEXT` |
| `materialized_query_table` | `TYPE 'S'` | `[schema, name]` | `SYSCAT.VIEWS.TEXT` |
| `alias` | `TYPE 'A'` | `[schema, name]` | Not supported |
| `sequence` | `SYSCAT.SEQUENCES` `SEQTYPE 'S'` | `[schema, name]` | Not supported |
| `module` | `SYSCAT.MODULES` `MODULETYPE 'M'` or `'P'` | `[schema, name]` | Not supported |
| `procedure` | `SYSCAT.ROUTINES` `ROUTINETYPE 'P'` | `[schema, specific name]` | `SYSCAT.ROUTINES.TEXT` |
| `function` | `ROUTINETYPE 'F'` | `[schema, specific name]` | `SYSCAT.ROUTINES.TEXT` |
| `trigger` | `SYSCAT.TRIGGERS` | `[schema, table, name]` or `[schema, name]` | `SYSCAT.TRIGGERS.TEXT` |

A routine is addressed by its `SPECIFICNAME` and labelled by its `ROUTINENAME`.
Db2 overloads a routine name by parameter types: the fixture's two `ORDER_TOTAL` functions carry one routine name and two specific names.
The specific name is Db2's own unique identifier and the one `DROP SPECIFIC FUNCTION` takes.
The cost is that a system-generated specific name (`SQL260915014426735`) changes when the routine is dropped and created again, so an address saved before that no longer resolves.

A routine is listed only when it is not in a module and its `ORIGIN` is one a person wrote: `E` external, `F` federated, `Q` SQL-bodied, `U` sourced.
A module's routines carry `ROUTINEMODULENAME` and belong to the module, which is a leaf node like an Oracle package: its members are declared through `childKinds` and not browsable.
A sequence is listed only with `SEQTYPE 'S'`, because `'I'` is the sequence behind an identity column.

A trigger nests under its table only when both are in the same schema.
Db2 lets a trigger's schema differ from its table's (the fixture's `REPORTING.ORDERS_AUDIT` fires on `APP.ORDERS`), and `[REPORTING, ORDERS, ORDERS_AUDIT]` would address a table that does not exist, so that trigger is `[REPORTING, ORDERS_AUDIT]`.
The source read binds the address it was given, so a trigger under the other shape is not found.

**Status.**
Only a state a reader acts on is published: `VALID 'N'` reads `INVALID` (measured: a view over a dropped table under `AUTO_REVAL DEFERRED`), `VALID 'X'` and `TABLES.STATUS 'X'` read `INOPERATIVE`, and `TABLES.STATUS 'C'` reads `SET INTEGRITY PENDING`.

**Row counts.**
`SYSCAT.TABLES.CARD` is published for a table and a materialized query table only when it is a measurement.
It is `-1` until `RUNSTATS` runs, and that absence publishes no `rowCount` at all rather than a 0; measured, `ORDERS` read no count before `RUNSTATS` and 2 after it.

**Detail.**
Columns come from `SYSCAT.COLUMNS`, with the primary key read from `KEYSEQ`, which is the column's position in the key and `NULL` outside it.
The type is spelled the way Db2 takes it back in DDL, because schema diff compares these strings and the migration generator writes one into `SET DATA TYPE`, where a bare `VARCHAR` is a syntax error.
Measured: `LENGTH` is the declared length for the character, graphic, binary and LOB types; `DECIMAL` carries precision in `LENGTH` and scale in `SCALE`; `TIMESTAMP` carries its fractional precision in `SCALE` (6 when declared bare); `DECFLOAT` reports 8 bytes for `DECFLOAT(16)` and 16 for `DECFLOAT(34)`; a character column with `CODEPAGE 0` is `FOR BIT DATA`.

Foreign keys join `SYSCAT.REFERENCES` to `SYSCAT.KEYCOLUSE` twice, and the referenced key is joined on its table as well as its schema and constraint name.
A constraint name is unique per table and not per schema: measured, two tables in `APP` both carried a primary key named `PK`, so a join without the table pairs one foreign key with every key of that name.
A reference into another schema is qualified (`APP.CUSTOMERS` from `REPORTING.DAILY`) and a reference inside the schema is bare.

Indexes are filtered by the table's schema, not the index's, because a system-generated key index lives in `INDSCHEMA SYSIBM` while its table is in the user's schema.

**Bulk detail.**
`describeObjects()` answers a whole relation kind in four round trips: the target listing, then columns, foreign keys and indexes restricted to that target through a CTE.
A caller's bound is sent as `FETCH FIRST ? ROWS ONLY` at one more than the bound, so a saturated read is told apart from an exact one, and the extra object is dropped.
Measured, the bulk answer is identical to the single read for every relation in both fixture schemas.
The target is ordered by `TABNAME` under the database collation (`IDENTITY` on the fixture's UTF-8 database), and the returned details are then sorted by path.

#### Object source (#789)

Source is declared on `view`, `materialized_query_table`, `procedure`, `function` and `trigger`, in `sql`.
Every text is `stored` and `complete`: a view created through `ibm_db` with irregular spacing and a trailing `--` comment read back from `SYSCAT.VIEWS.TEXT` byte-identical, and every text begins with its `CREATE`.
A table, an alias, a sequence and a module have no stored text, and Db2 offers no read-only way to generate one: `db2look` is a client tool, and `SYSPROC.DB2LK_GENERATE_DDL` writes its output into `SYSTOOLS` tables.

An external or sourced routine answers a refusal part, not an empty editor and not an error.
Measured, `SYSCAT.ROUTINES.TEXT` is `NULL` for `ORIGIN 'E'` (the fixture's `APP.EXT_FN`, a C function) and `ORIGIN 'U'`, and the part says which.
An object the read cannot find raises a `QueryError` naming it, and so does a view read under the `materialized_query_table` kind, because the read also binds the catalog type.

#### Object edit (#789)

This engine is DEFERRED rather than refused, and the measurements say which half of the ruling it passes.
The failure arm is safe: a `CREATE OR REPLACE PROCEDURE` and a `CREATE OR REPLACE TRIGGER` that do not compile answer `SQL0206N` and leave the previous object `VALID` with its previous text, measured on 12.1.
A successful replace keeps the object's privileges (an `EXECUTE` granted to `PUBLIC` survived it), but replacing a view leaves every view that reads it `VALID 'N'` until its next use, which is a consequence the preview would have to show before it could ship.
No kind here declares `acceptsSourceEdits`, and `tests/isolated/object-edit-declarations.test.ts` is what holds that absence and this section together.

---

## 7. Maintenance

Two operations, both routed through `CALL SYSPROC.ADMIN_CMD(...)` (Db2's SQL interface to its
command-line utilities), both taking a table name:

| Operation | Statement |
|---|---|
| `analyze` | `RUNSTATS ON TABLE "<t>" WITH DISTRIBUTION AND DETAILED INDEXES ALL` |
| `optimize` | `REORG TABLE "<t>"` |

`optimize` (`REORG`) can be slow and lock-heavy on a large table; it is offered as an explicit,
user-initiated action (§3.5 explains why that is appropriate where auto-emitting it into a migration
file is not). An operation called without a target is refused rather than sent.

The target is a bare table name, and Db2 resolves it against `CURRENT SCHEMA`.
Measured: `RUNSTATS` on `ORDERS` from a `db2inst1` session answered `SQL2306N The table or index "DB2INST1.ORDERS" does not exist`, and succeeded once the connection string carried `CurrentSchema=APP`.
That agrees with the Operations tab, whose table list is also read from `CURRENT SCHEMA`.

---

## 8. Known limitations

- **No EXPLAIN yet** (§3.6). The Explain button and tab are hidden.
- **No interactive-transaction toolbar yet** (§3.6). BEGIN/COMMIT/ROLLBACK and SANDBOX are hidden.
- **`columnTypes` not reported** (§3.4). The grid infers display from values; declared types are a
  follow-up.
- **Monitoring and maintenance follow `CURRENT SCHEMA`** (§6, §7). The object browser lists every schema, but the table and index panels and the maintenance targets are the session schema's.
- **Routine addresses are specific names** (§6.1). A system-generated one changes when the routine is created again.
- **Module members are not browsable** (§6.1). A module is a leaf node.
- **No object editing** (§6.1, Object edit).
- **Node only** (§1). `bunx --bun` crashes on the first connection.
- **Native driver, with an install-time download** (§1). Air-gapped installs must pre-provision the
  `ibm_db` CLI driver.
- **No pool, failover or retry** (§3.1).
- **REST/`execsql` transport is not implemented.** It is a possible future additive transport behind
  the same provider, gated on the operator having the Db2 REST service deployed with `execsql`
  enabled.

---

## 9. Testing

Mock-based unit/integration coverage lives in
[`tests/integration/db/db2-provider.test.ts`](../../tests/integration/db/db2-provider.test.ts):
validation, capability honesty, `prepareQuery` FETCH FIRST/OFFSET, connection-string building, the
`columnTypes` omission, positional-parameter binding (params forwarded to the driver; the no-params
two-arg call form), the object surface against a mirror of the fixture (including
`assertObjectSurface`), the neutral monitoring values, and the
`RUNSTATS`/`REORG` maintenance SQL. The migration-generator's Db2 branch (SET DATA TYPE, the REORG
advisory, the transaction wrapper) is pinned in
[`tests/unit/schema-diff/migration-generator.test.ts`](../../tests/unit/schema-diff/migration-generator.test.ts).

**Mock-based tests are not sufficient on their own.** This provider was driven through the running
application against a real Db2 LUW server (v11.5.9.0, via `ibm_db` 4.0.1);
a `db2` service is also provided in [`database-compose.yml`](../../database-compose.yml) (a privileged
container with `LICENSE=accept` and a slow first boot). Results of the gate-4 pass:

- full `INSERT` / `UPDATE` / `SELECT` / `DELETE`, including a `SELECT` immediately after a write
  (read-your-writes) — **VERIFIED** (see the autocommit line below);
- both error paths — **VERIFIED**: a missing object throws `SQL0204N` and a syntax error throws
  `SQL0104N` (both surface as errors, not "0 rows"); `mapDatabaseError(err, 'db2', sql)` wraps them;
- a query against a table left in a pending state — e.g. run a `SELECT`/`INSERT` against a table you
  put in REORG-pending, and capture the exact `SQL0668N` driver text (and its reason code) so a
  future error branch can decode it (§3.7) — **not yet exercised** (no REORG-pending table was
  induced on the live server); still a follow-up;
- the object surface — **VERIFIED** on 12.1 against the fixture (§6.1): every count, listing, detail,
  bulk read and source read, including the external routine, the cross-schema trigger and the
  truncated bulk read;
- **value fidelity — VERIFIED** on Db2 v11.5.x (`ibm_db` 4.0.1), via `probe-db2.mjs DB2_MATRIX=1`:
  CLOB→string, BLOB→`Buffer` (exact bytes), `BIGINT`→lossless string, DECIMAL/DECFLOAT/REAL/DOUBLE→
  number, VARGRAPHIC/XML/DATE/TIME/TIMESTAMP→strings, `CHAR(n)` space-padded (expected). No
  provider-boundary normalization needed for any of them (§3.8);
- **autocommit — VERIFIED**: an `UPDATE`/`DELETE` run on its own is durable and read-your-writes holds
  (UPDATE→new value on immediate SELECT; DELETE→count 0), so nothing is left uncommitted between runs;
- **pagination — VERIFIED**: an unbounded `SELECT` gets `FETCH FIRST n ROWS ONLY` (`wasLimited`),
  paging switches to `OFFSET n ROWS FETCH NEXT n ROWS ONLY` with contiguous rows, and an
  already-bounded statement is left untouched;
- **capability-gated UI — VERIFIED** (Playwright): the connection modal offers "Db2 LUW", defaults the
  port to 50000, and shows the connection-string toggle; once connected the Explain button and Explain
  tab are absent, no transaction toolbar/SANDBOX shows, Create Table is present, and the per-table
  context menu offers "Run Statistics" (RUNSTATS) and "Reorganize Table" (REORG);
- **inline row edit — VERIFIED** (Playwright, end-to-end): editing a grid cell issues
  `UPDATE t SET "col" = ? WHERE "id" = ?` with a bound values array and the change persists on
  re-query. This is what caught the param-binding bug now fixed and regression-tested (§5);
- each maintenance operation — **VERIFIED**: `RUNSTATS`/`REORG` succeed per table via
  `SYSPROC.ADMIN_CMD`; a global (no-target) request and an unsupported op are refused with a clear
  message;
- **`ibm_db` runs under Node, and not under Bun** — **MEASURED** on Bun 1.4.2: the first `open()`
  panics the process (§1);
- integer fidelity — **VERIFIED**: `BIGINT` `9223372036854775807` (past `Number.MAX_SAFE_INTEGER`)
  arrives as the exact JS string, no precision loss.

Remaining live follow-ups: the `SQL0668N`/REORG-pending error text (above), a TLS handshake against a
TLS-configured server (§4.2), and the richer monitoring/EXPLAIN/transaction surfaces called out as
future work.
