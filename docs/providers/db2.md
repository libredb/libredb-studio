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
- **It is a compiled addon**, so there is an N-API/Bun-runtime compatibility question that the live
  pass (§9) must settle: confirm the provider loads and runs under Bun, not only Node.

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
    └── Db2Provider              ← src/lib/db/providers/sql/db2.ts
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

### 3.3 Schema from `SYSCAT.*`, scoped to `CURRENT SCHEMA`

`getSchema()` reads the standard read-only catalog views — `SYSCAT.TABLES`, `SYSCAT.COLUMNS`,
`SYSCAT.KEYCOLUSE`/`SYSCAT.TABCONST`, `SYSCAT.REFERENCES`, `SYSCAT.INDEXES`/`SYSCAT.INDEXCOLUSE` —
filtered by `TABSCHEMA = CURRENT SCHEMA`. `CURRENT SCHEMA` is Db2's session default schema (the
connecting user's schema unless `SET SCHEMA` changed it), which is the namespace a bare table name
resolves against, so it is the right filter for "this connection's tables". A Db2 **schema** is the
namespace level, read the way Oracle reads its owner. Column type names are lowercased to match the
spelling convention the schema tree uses for the other SQL engines.

`SYSCAT.TABLES.CARD` is reported as `rowCount` only when it is a real measurement: it is `-1` until
`RUNSTATS` has run, and the provider omits `rowCount` in that case rather than reporting `-1` as a
count.

**Which schema the browser shows follows `CURRENT SCHEMA` (measured).** There is no per-connection
schema field in the connect form: the explorer lists the tables of whatever `CURRENT SCHEMA` resolves
to. On a fresh connection that is the connecting user's own schema (verified: the connecting user's id
becomes `CURRENT SCHEMA`). The provider holds one connection handle for the session, so a
`SET CURRENT SCHEMA other_schema` run in the query editor persists and the next schema refresh browses
that schema — the same session-state model as Oracle's current-schema. To browse a schema you do not
own, run `SET CURRENT SCHEMA name` and refresh.

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
  string, which `getSchema` reads through `Number(...)`.)

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

`getSchema()` is real (§3.3). The monitoring set is **honestly minimal for v1**: Db2's rich
performance data lives in the `MON_GET_*` table functions and `SYSIBMADM.*` administrative views, both
permission-gated. Rather than claim figures unverified against a live server, the provider returns
neutral values:

- `getOverview()` reads the Db2 service level from `SYSPROC.ENV_GET_INST_INFO()` for the version, and
  returns zeroed/`"N/A"` fields otherwise (a denied read leaves the neutral default rather than
  failing the overview).
- `getHealth()` returns the `CACHE_HIT_RATIO_UNAVAILABLE` sentinel and empty lists.
- `getPerformanceMetrics()` returns `{}`. This is load-bearing: `DEFAULT_THRESHOLDS` scores
  `cacheHitRatio` with `direction: "below"`, so an absent ratio reads as healthy while a fabricated
  `0` would paint a critical cache fault on every healthy database.
- `getSlowQueries()`, `getActiveSessions()`, `getTableStats()`, `getIndexStats()`,
  `getStorageStats()` return `[]`.

Filling these from `MON_GET_*`/`SYSIBMADM.*` is verified follow-up work; a permission-gated source
must return empty, never throw, when the connected user cannot read it.

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

---

## 8. Known limitations

- **No EXPLAIN yet** (§3.6). The Explain button and tab are hidden.
- **No interactive-transaction toolbar yet** (§3.6). BEGIN/COMMIT/ROLLBACK and SANDBOX are hidden.
- **`columnTypes` not reported** (§3.4). The grid infers display from values; declared types are a
  follow-up.
- **Monitoring is mostly empty** (§6). Real `MON_GET_*`/`SYSIBMADM.*` reads are follow-up work.
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
two-arg call form), `getSchema` catalog mapping, the neutral monitoring values, and the
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
- schema introspection — **VERIFIED**: columns, PK/nullable flags, foreign keys, and indexes map from
  `SYSCAT.*` with untrimmed names; the explorer follows `CURRENT SCHEMA` (§3.3);
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
- **`ibm_db` loads and runs under both Bun and Node** — **VERIFIED** (the native-addon risk);
- integer fidelity — **VERIFIED**: `BIGINT` `9223372036854775807` (past `Number.MAX_SAFE_INTEGER`)
  arrives as the exact JS string, no precision loss.

Remaining live follow-ups: the `SQL0668N`/REORG-pending error text (above), a TLS handshake against a
TLS-configured server (§4.2), and the richer monitoring/EXPLAIN/transaction surfaces called out as
future work.
