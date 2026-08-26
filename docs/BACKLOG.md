# Backlog — known defects and deferred work

Work that is known, understood, and not scheduled. Every entry was found while doing something
else — a sweep, a review, a live probe — and was verified against the code when it was written.
None of it is a GitHub issue.

**How this file is used**

- The issue tracker holds work that is filed, triaged, or in progress. This file holds the rest:
  unscheduled defects, deliberate deferrals, open questions.
- An entry says what is wrong, where, and what "done" looks like. Enough to pick it up cold.
- **Delete an entry when the work lands.** No strikethrough, no DONE marker. Git history is the record.
- Re-verify before acting. Line numbers and behaviour claims age.
- Promote an entry to an issue when it needs discussion, an outside reporter, or a release note.
- The reverse happens too. An issue that is understood, breaks nothing today and is not scheduled
  belongs here. Close it with a pointer to its entry. A defect a user can hit stays an issue.
- **Every ID is unique across the whole file.** Cross-references use the bare ID (`B47`), so no two
  entries may share one.

---

**Sections**

- [SQL statement reading](#sql-statement-reading) — S2–S7 · 5
- [Drivers and connections](#drivers-and-connections)
- [Value interpolation](#value-interpolation) — V1
- [Row editing](#row-editing) — R1
- [Studio UI and query execution](#studio-ui-and-query-execution) — X2–X14, U2–U21 · 10
- [Authentication and security headers](#authentication-and-security-headers) — AU3
- [Tests](#tests) — T1–T5 · 4
- [Dependencies](#dependencies) — P1–P5 · 5
- [Documentation](#documentation) — DOC1, DOC3 · 2
- [Release pipeline](#release-pipeline) — REL1–REL3 · 3
- [Chart configuration surface](#chart-configuration-surface) — N1, N3 · 2
- [Security Phase 1 deferrals](#security-phase-1-deferrals) — H1–H13 · 9
- [Security Phase 2 deferrals](#security-phase-2-deferrals) — C2–C10 · 9
- [Security Phase 3 deferrals](#security-phase-3-deferrals) — K2–K4 · 2
- [Agent M1 deferrals (#328)](#agent-m1-deferrals-328) — A1–A6 · 5
- [Agent M2 deferrals (#329)](#agent-m2-deferrals-329) — B1–B76 · 46

---

## SQL statement reading

The readers in `src/lib/sql/` decide where a statement starts, where it ends, and what it operates
on. `src/lib/sql/grammar.ts` gave them a dialect (#292). These are the gaps that channel leaves.

### S2. Backslash escaping is not a grammar fact

Whether `\` escapes inside a string literal differs by dialect, and in MySQL by session mode. Making
it a row in `SqlGrammar` would narrow the false confirmation prompts #297 introduced, and would
remove S4's MSSQL decline entirely.

Left out of maintainer-sweep-5 on purpose: it retypes every literal in every dialect. It also
destroys the premise of two fixtures that sweep required (the "end cannot be cut" case and the
"genuinely unresolvable text still has to ask" case). Those fixtures need replacing with shapes that
stay unresolvable once `\` is understood.

The single largest follow-up from that sweep.

### S3. Comment and escape forms no reader models

- **MySQL executable comments.** `/*!40000 DELETE FROM t */` is an ordinary comment to every reader
  here. MySQL executes it. Nothing asks first.
- **MySQL connection charset.** On a `latin1` connection a leading U+00A0 executes. `buildPoolConfig`
  passes the user's connection string straight to mysql2 as `uri`, so the charset is outside the
  readers' view.

### S4. MSSQL: a parameterised page is still unrecognised

`… OFFSET @skip ROWS` is not recognised as a page, so the statement collects a `TOP` and the server
refuses it. A limitation of the shared probes' literal-count reading as much as of the provider.
Verified by probe, documented in `docs/providers/mssql.md`.

The decline that keeps #293 safe keys on an unanchored `OFFSET`/`FETCH` mention wherever the cut was
refused. The precise alternative — walk forward to where the unresolvable region starts — only helps
for a mention *before* the bad span, and costs a new shared-reader API.

### S6. Grammar facts left undecided

`grammar.ts` records a fact as established only when a first-party source was found. Where none was,
it writes `DEFAULT_SQL_GRAMMAR.<fact>`. Three such sites remain, all on the same fact:

| Fact | Undecided for |
|---|---|
| `[…]` bracket reading | mysql, oracle, elasticsearch |

`#` and block-comment nesting are now established for every dialect that has a grammar row.
ClickHouse's three facts were established after this entry was first written.

**A different state, not an undecided fact:** couchbase, druid and libredb have no row in
`SQL_GRAMMARS` at all, so they fall to the whole default. Nobody has probed them.

Leaving a bracket row undecided costs nothing while the dialect does not use the syntax — `[` carries
no meaning in ordinary MySQL or Oracle SQL, and Elasticsearch refuses it outright. It costs something
when the dialect does use it. That is why PostgreSQL's row was established: at the name reading,
`ARRAY[[1,2],[3,4]]` and `j['a]b']` lost their bound and prompted on an ordinary read.

**Rows resting on documentation alone, worth re-checking against an artifact:** ClickHouse's `#` and
bracket rows (HTTP-only provider, no driver to read), MSSQL's block-comment nesting row (tedious
ships no tokenizer), PostgreSQL's bracket and block-comment rows (`pg` carries no SQL tokenizer), and
the `nq'…'` spelling of Oracle's alternate quoting.

**Closed 2026-08-25:** `SqlGrammar` now carries `doubleSlashComment`, established by live probe on
Apache Cassandra 5.0.9, ScyllaDB 2026.2.4 and ClickHouse 26.7.1 (a line comment on all three) and
refused on PostgreSQL 18, MySQL 26.7.0, SQLite, Oracle, SQL Server 2022 and Trino 476. It is undecided
for elasticsearch and opensearch, and absent with the whole row for couchbase, druid and libredb -
recorded in the table in `docs/editor/query-optimization.md`.

### S7. A confirmation refinement that was considered and rejected

Scanning an unreadable region for destructive vocabulary, and asking only when a write could
plausibly be in there. Sound on its face. It substitutes a cleverer reading for the honesty rule #297
pinned: the gate asks because it *cannot* read the text, not because it guessed what is in it.
Revisit only with an explicit product decision.

---

## Drivers and connections

### D1. Fatal `error` events on the non-pooled clients were never audited

#298 covered the pooled SQL drivers (`pg` in both layers, `mssql`). mysql2 and oracledb have no
pool-level `error` event, and each `connect()` now records that.

Whether the MongoDB, Redis, ClickHouse, Druid, Couchbase, Cassandra or Trino clients expose a fatal
`error` event that can reach `uncaughtException` is an open question, not a claim.

### U17. Four things the Cassandra provider declined to do

The provider shipped in #424 Phase 4 with four bounded absences. None is a defect — each is the
honest answer to something measured on Apache Cassandra 5.0.9. Each is also something a later change
could take further, and one of them is a shared-reader limitation rather than a provider decision.

**1. `SqlGrammar` expresses ONE of CQL's two comment rules since 2026-08-25.** The third
line-comment form, `//`, is now a grammar fact (`doubleSlashComment`) that every reader in
`src/lib/sql/` honours - which closed the S1 defect this absence was still producing on this engine:
`SELECT ... // note; DROP TABLE ...` was cut into a read and a runnable bare `DROP` out of text the
server reads as one statement. What remains is the SECOND fact: a line comment of either form must be
closed by a NEWLINE: `SELECT * FROM
probe.customers LIMIT 3 -- note` with nothing after it is `line 1:45 mismatched character '<EOF>'
expecting set null`, while the same text plus `\n` returns the rows.

So the shared limiter's insert-before-trailing-trivia rewrite (#280) turns a VALID statement into a
syntax error on this one engine, because `sql.trim()` drops the newline that closed the comment.
`CassandraProvider.prepareQuery` declines to rewrite any statement whose rewritten form would end
inside a line comment. Fail-safe: the statement runs unbounded and `wasLimited: false` says so. The
newline rule is a `spans.ts` question rather than a grammar one - that reader ends a line comment at
LF, and CQL also ends one at a bare CR (measured 2026-08-25: `-- note\r; DROP` is `line 1:51
mismatched input 'DROP'` on 5.0.9, so the engine sees two things where the reader sees one). It
under-splits, which is the safe direction, and the same divergence predates the `//` work. See S6.

**2. A statement whose last clause is `PER PARTITION LIMIT n` is left unbounded.** The shared reader
sees a trailing `LIMIT n` and reports the statement as already bounded, so nothing is injected. `...
PER PARTITION LIMIT 2 LIMIT 3` is valid CQL (measured), so a bound COULD be added — but only by
stripping the clause the reader matched, which would corrupt the statement. The reader has to
distinguish the two clauses first.

**3. TLS is wired and unverified.** `cassandraClientOptions` maps the connection's SSL mode onto the
driver's `sslOptions` (`require` → `rejectUnauthorized: false`, `verify-*` → `true`, plus a CA when
supplied), and the shape is pinned by unit tests. Neither probe instance speaks TLS, so no handshake
was ever performed. The alternative — ignoring the form's SSL panel — would send plaintext to a TLS
port silently, which is worse.

**4. Tracing is not exposed.** Cassandra's only substitute for EXPLAIN is `{traceQuery: true}` plus
`system_traces.sessions` / `system_traces.events`, which describes a statement that has ALREADY RUN.
It is a profile, not a plan, and `supportsExplain` is false. If it is ever surfaced it must not be
called EXPLAIN and must not be wired to `explainFormat`.

**ScyllaDB now has its gate-4 probe, and two of the three doubts held.** Probed 2026-08-21/22
against `scylladb/scylla:2026.2.4` and `scylladb/scylla:2025.1`, both through
`createDatabaseProvider({type:"cassandra"})` surface by surface, with `cassandra:5.0.9` in the same
pass. What held: there is no `system_views` keyspace at all, and the version string is not
`release_version`-shaped — `system.local.release_version` reads `3.0.8` and the real build lives in
`system.versions`, which this provider does not read. What was refuted: `gossip_generation` exists on
ScyllaDB and answers. It is registered as a `partial` relative in `src/lib/db/compatibility.ts`; the
six surfaces it loses are D9, which that change deliberately did not fix.

**And there is no `e2e/cassandra-provider.spec.ts`,** unlike Trino: the container takes about 206
seconds to reach `nodetool status` UN from cold, longer than any existing e2e fixture waits. The
ScyllaDB container is ready in well under a minute, so a ScyllaDB-only spec would not be blocked on
boot time — but the Cassandra spec this item asks for still is, and a spec that never starts the
Cassandra fixture does not close it.

**Done when:** each of the four has been taken further or judged settled, and
`e2e/cassandra-provider.spec.ts` exists or a written reason it cannot exist is recorded here.

---

### D14. Three providers lost the buffer-pool gauge, because it was the cache hit ratio wearing a second name

Removing the fabricated cache hit ratios exposed that `bufferPoolUsage` was not a second measurement.
In Oracle and SQL Server it was literally assigned the ratio itself - the old tests even said "mirrors
cacheHitRatio in Oracle impl" - so the Performance tab drew and rated one quantity as two independent
gauges. In PostgreSQL it was `blks_hit / (blks_hit + blks_read)` from `pg_stat_database`, which is also
a cache hit ratio and not pool occupancy, with a `: 100` fallback when both counters were 0. All three
now omit the field, which the tab renders as unavailable.

Real occupancy is reachable on each engine and none of the three is free: `pg_buffercache` is an
extension not installed by default, `V$BUFFER_POOL_STATISTICS` needs the privilege the ratio already
needs, and `sys.dm_os_buffer_descriptors` is a full descriptor scan on a large instance. So a gauge
that reads a real pool has a cost the panel has never paid.

**Done when:** each of the three either measures pool occupancy for real, at a cost written down next
to the query, or its omission is recorded as the answer. Dropping the field outright is no longer one
of the options: MySQL, MongoDB, Couchbase and ClickHouse all fill it with a real occupancy figure
(`mysql.ts`, `mongodb.ts`, `couchbase/index.ts`, `clickhouse/index.ts`), so removing it would delete
four working gauges to tidy away three absent ones.

---

### D18. Two engines hand back a number that has already lost digits

Measured 2026-08-24 against Oracle Free 23ai through the provider: `NUMBER(38,0)` holding
`12345678901234567890123456789012345678` arrives as a JS `number` and serializes as
`1.2345678901234568e+37`, and `NUMBER(20,4)` holding `1234567890123456.7891` arrives as
`1234567890123456.8`. The grid, the CSV, the SQL export and the agent's summary all read that, so the
digits are gone before any surface could show them - and nothing says so.

`docs/providers/mssql.md` records the same class for `BIGINT`, `DECIMAL`/`NUMERIC` and `MONEY` beyond
2^53. Postgres avoids it by returning `numeric` as a string, which is why the DDL export can only
guess integer/boolean/text from a value there - the precision is kept and the type is what is missing.
Trino and Cassandra keep theirs as strings too, deliberately (`docs/providers/cassandra.md` §3.8: a
`bigint` reaching `Number()` becomes 9223372036854776000).

So the fix has a precedent in this repo and it is not free: fetching Oracle `NUMBER` and SQL Server
`DECIMAL` as strings changes every numeric cell those engines produce - grid alignment, the charts'
axes, the agent's arithmetic, `ORDER BY` on a client-sorted column. It was deliberately left out of
the LOB fix for exactly that reason: a LOB was unreadable, a number is wrong, and the second needs its
own pass over every consumer.

**Done when:** a value one of these engines cannot represent as a JS number reaches the grid with its
digits intact, and every consumer of a numeric cell has been checked against the new shape.

---

### D25. Couchbase turns an RBAC denial into a zero, which the absence rule now forbids

Found 2026-08-25 by the audit D24 asked for. `degradeTo()`
(`src/lib/db/providers/document/couchbase/index.ts:196`) swallows a refused management read and
substitutes a fallback VALUE - `{}` for the pools and bucket payloads, and
`{ tableCount: 0, indexCount: 0 }` for the catalog counts. Its own comment says why the absences are
ordinary there: an RBAC role that may read documents may not read `/pools`. But the substitute is a
measurement the user cannot tell from a real one, so a role without the management grant reads a
bucket with **0 tables and 0 indexes** rather than "this role may not ask".

`MonitoringData.errors` (#477) is the mechanism the rest of the family now uses, and Cassandra, Trino
and LibreDB were converted to it in the same round this was found. Couchbase was left out for one
reason: no Couchbase cluster is running here, so the four refusal categories could not be measured,
and a refusal sentence that has never been seen from the server is exactly what D21 was fixed for.

**Done when:** a Couchbase panel a role may not read is absent with the cluster's own wording, and
the counts it feeds carry the same distinction - measured against a live cluster with a document-only
role, not inferred from the code.

### D27. On a single-writer file, whichever handle opens first locks the other one out

The reuse D3 and B49 landed runs one way only: `findOpenSingleWriterProvider` reads the **writable**
cache, so a caller that would open a second handle borrows the editor's. The reverse is still open. If
an agent run reaches a `libredb` connection nobody has browsed yet, `acquireExecutionProfileProvider`
opens the file and caches that handle under the PROFILED key — and the editor's own
`getOrCreateProvider` then fails on the lock, so browsing the connection in the sidebar is refused
until the profiled entry is evicted (30 minutes idle).

Deliberately left: closing it means letting an editor request be served a provider opened under an
execution profile, which is the isolation invariant `acquireExecutionProfileProvider` exists to keep.
On this engine that handle carries no actual privilege reduction — `createDatabaseProvider` passes no
execution context for `libredb` — so the reuse would be safe *for this engine* and wrong as a declared
rule. Not observed in the browser: the ordinary order is editor-first, because the connection has to be
selected before a run can be started on it.

**Done when:** either direction of the borrow is safe by construction — for instance a single-writer
file has ONE cache entry that both callers key off, with the profile deciding how it is used rather
than which handle it gets — or the agent-first order is refused with a sentence naming the lock.

### D30. `SHOW STATUS LIKE` costs two panels on an engine that answers `SHOW STATUS`

Measured 2026-08-26 against `apache/doris:all-in-one-4.1.3` (issue #424, Phase 0). `getOverview()`
and `getHealth()` in `src/lib/db/providers/sql/mysql.ts` read three statements of the form
`SHOW STATUS LIKE 'Uptime'`, `SHOW STATUS LIKE 'Threads_connected'` and
`SHOW VARIABLES LIKE 'max_connections'`. On Doris the third is accepted and the first two are a
**parse error** — `errCode = 2, detailMessage = mismatched input 'LIKE' expecting {<EOF>, ';'}
(line 1, pos 12)` — because the Doris grammar has no `LIKE` clause on `SHOW STATUS`. Both panels
therefore fail outright.

The engine is not missing the data by refusing the statement, and that is what makes this ours: a
bare `SHOW STATUS` **is** accepted there and answers zero rows. So the filter we add for our own
convenience is the whole difference between a panel that renders absence (`N/A`, "not published",
per the absence rule of #477) and a panel that renders an error the user cannot act on.

This is the D8 shape one layer up. D8 was a PROTOCOL choice that engines refused; this is a
STATEMENT-FORM choice that a grammar refuses, and the same reasoning applies: the narrowest fix is
to ask for what every MySQL-wire engine can answer and filter in the reader. `SHOW STATUS` on a
stock MySQL 8 returns roughly 500 rows, so the cost is one small result set per panel read, not a
new round trip.

Not fixed with the Doris registry entry on purpose: that PR publishes a measurement, and this
changes what two panels read on **every** MySQL-wire engine — MySQL, MariaDB, TiDB, Vitess,
OceanBase, SingleStore, StarRocks and Doris — so it needs its own probe pass rather than a
by-the-way edit inside a labelling change.

**Done when:** the overview and health reads ask for something Doris's grammar accepts, the two
panels on Doris show absence rather than an error, and the reading is unchanged on MySQL, MariaDB
and one analytics relative — each verified against the live container, not inferred from the
statement text.

### D31. A failed schema read leaves the previous connection's tables on screen as this one's

Measured 2026-08-26 in Chrome against the built app, with the network captured (issue #424, the
QuestDB probe). The sequence needs no unusual state - a fresh browser context reproduces it:

1. the workspace auto-selects the first connection and loads its schema
   (`200 POST /api/db/schema/list {"connectionId":"seed:doris-probe"}` -> `probe_customers`,
   `probe_orders`);
2. the user clicks a second connection whose schema read fails
   (`500 POST /api/db/schema/list {"connectionId":"seed:questdb-probe"}` -> `'(' expected`);
3. the header switches to the second connection and **the object browser keeps showing the first
   connection's tables, with its row counts** - measured: `probe_customers 3` and
   `probe_orders 2.0k` under a header reading *QuestDB 10.0.1 (probe)*, while QuestDB's own
   `questdb_only_marker` never appears and QuestDB has no `probe_customers` at all.

`fetchSchema` in `src/hooks/use-connection-manager.ts` toasts the error and `return`s without
touching `schema`, so the previous value survives the connection change. `Studio.tsx`'s
connection-change effect clears it only in the `else` branch, when the active connection becomes
null - never when the fetch for a new one fails. Storage is not involved: `/api/storage/config`
answers `serverMode: false`, `libredb_schema_snapshots` was empty, and the tree is React state.

**Reproduced a second time on a different engine, 2026-08-27.** Selecting the Databend connection
after an OrioleDB one showed OrioleDB's `probe_customers 3` / `probe_orders 2.0k` under Databend's
name, with `500 POST /api/db/schema/list :: Prepare is not support in Databend` in the network log -
same shape, different cause for the failing read, which is the point: any failing schema read does
this.

**Why this is worse than an empty tree, and why it is not a QuestDB problem.** An empty object
browser is the honest reading the absence rule (#477) asks for. This one attributes real objects,
with real row counts, to a database that does not contain them - and the tables are clickable, so
the next query is written against a schema the connection does not have. Every engine whose object
browser fails inherits it: CockroachDB (no `pg_total_relation_size()`), Materialize and RisingWave
(reserved `MATERIALIZED`), QuestDB (both), and any engine having a bad day.

Noticed in the same capture and not filed separately: one connection selection issues the same
`schema/list` read **two or three times** - two for the auto-selected connection, three for the
clicked one. Worth confirming while this is open, since the fix touches the same call.

**Done when:** selecting a connection whose schema read fails shows an empty object browser
carrying the engine's own error, never the previous connection's tables - verified in a browser
across two connections where the second one's read fails, not through the hook in isolation.

---

### D32. The MySQL health panel reports `performance_schema` unavailable on a server that has it

Measured 2026-08-26 while probing Percona Server for MySQL, and confirmed on the baseline in the
same pass, which is what makes it ours: `getHealth()` returns
`slowQueries: [{ query: "Performance schema not available", calls: 0, avgTime: "N/A" }]` on both
`percona/percona-server:8.4` and a stock **MySQL 26.7.0**, while on each of them
`@@performance_schema` is `1` and `getSlowQueries()` on the same connection returns real rows.

So the health reading states an engine capability as absent when it is present, and the panel
beside it disproves the statement. It is a fabricated absence rather than a missing number, which
is the class the absence rule (#477) exists to prevent - the honest reading is either the rows
`getSlowQueries()` can already produce, or no slow-query line at all.

Not Percona's, not new, and not caused by the wire-compatible work - it just took a drop-in build
to notice, because a caveat had to be written about a reading that turned out to be the baseline's.

**Done when:** the health panel's slow-query line either carries the rows the slow-query read
returns or is absent, and the "not available" wording appears only on a server where
`@@performance_schema` is actually 0 - both arms measured, one server of each kind.

---

### D33. Every parameterised read still prepares, so an engine without PREPARE loses all of them

Measured 2026-08-27 against `datafuselabs/databend:v1.2.925-patch-11` (issue #424, Phase 0).
Databend replies `Prepare is not support in Databend` to mysql2's prepared protocol, and that one
answer takes `getTables()`, `getSchema()`, `getActiveSessions()`, `getTableStats()`,
`getIndexStats()` and `getStorageStats()` - the whole object browser and every statistics panel -
while the editor keeps working.

**The catalogs are there.** Asked with literal SQL on the same connection,
`information_schema.tables` returns the true 3 and 2000 rows with `data_length` 124 and 49000, and
`information_schema.columns` answers in full. So the engine has the data and we cannot read it.

This is **D8 one step further in**, and the remaining step is the harder half. D8 moved every
*parameterless* statement onto MySQL's text protocol; these six reads carry placeholders
(`WHERE table_schema = ?`) and therefore still prepare. Moving them means either interpolating the
schema name into the statement - which is where a placeholder was the safe choice, so it needs an
identifier-quoting decision rather than a string concat - or asking mysql2 for the text protocol
with the parameters bound client-side. Neither is a one-line change, which is why this is filed
rather than done inside a labelling PR, and why Databend's registry row reads `query-only` today.

**A second, smaller defect surfaced on the same engine, and it is a crash rather than a failure.**
`runMaintenance('analyze')` throws `TypeError: rows.filter is not a function`: Databend answers
`ANALYZE TABLE` with an object where the reader expects an array of `Msg_type` rows. A provider
that cannot run a maintenance action should report that, not throw a type error out of the route -
and this is the same shape already recorded once, a mysql2 reply whose type depends on the
statement.

**Done when:** the six reads above answer on Databend, with the identifier path decided rather
than concatenated, and `runMaintenance` on an engine that answers `ANALYZE` with a non-array
reports a result instead of throwing - both verified against the container, and the reading
unchanged on MySQL, MariaDB and one analytics relative.

---

## Value interpolation

### V1. Query history records the placeholders, not the values that were bound

Since #290 the inline row editor sends `SET "name" = $1` with the value bound, and
`use-query-execution` writes that text to history. A truthful record of the statement the engine ran,
but no longer a record of what was written. Carrying the bound values as their own history field
would restore the audit trail without putting them back into the SQL. It touches the history entry
shape in `src/lib/storage`, so it is a schema change.

---

## Row editing

### R1. Row editing is offered only where a shared `UPDATE` happens to fit (was #279)

The results grid builds one statement shape for every engine — `UPDATE <table> SET <col> = <val>
WHERE <pk> = <val>` in `src/hooks/use-inline-editing.ts` — so an engine that spells a row mutation
differently cannot have the feature. #269 made that honest rather than broken: `supportsInlineRowEdit`
hides the control where the shape does not fit. True today for PostgreSQL, MySQL, SQLite, Oracle and
SQL Server; false everywhere else.

Making it work means moving statement generation into the provider, so each dialect owns its own
form. SQL providers keep the shape above. ClickHouse spells it `ALTER TABLE <t> UPDATE <col> = <val>
WHERE ...`. MongoDB has no statement at all and needs the document-update path. An append-only engine
keeps declaring the capability false. The provider triad applies, per provider.

Two constraints from #269 that do not go away:

- **One request per edited row.** Several engines reject a multi-statement request, so the old
  newline-joined payload cannot come back.
- **Primary-key detection is heuristic.** The hook picks a result column named `id` or ending in
  `_id`. Acceptable for a control gated on an opt-in capability; per-dialect editing on real tables
  should derive the key from the schema.

Whether row editing should be universal at all is a product decision. The published
`WorkspaceFeatures.inlineEditing` flag is deprecated against this entry (#288): it becomes real, or
goes away in a major, with this work.

---

## Studio UI and query execution

`U2` came out of the #384 review. The `X` entries came out of the #422 export review — each was
named, weighed and left out of that PR, so they are recorded rather than re-derived.

### X2. An export writes the page the grid holds, not the result the user asked for

Statements run under `DEFAULT_QUERY_LIMIT` (500) and paging fetches more only when asked, so every
export is bounded by what is on screen. #422 made that visible — the count is on the Export button and
the menu says when more rows are still on the server (`src/lib/export/scope.ts`). Honesty, not a fix.

The fix is a server-side export: a route that streams the statement's full result through the same
writers. `csv.ts` and `result-export.ts` are pure and hold no browser reference precisely so a route
can reuse them; `download.ts` is the only browser-bound module there. Worth costing against the
agent's own export gap (B33, B34), which wants the same route.

### X4. Four modals stay mounted while closed, so their code cannot be split

`DataProfiler`, `CodeGenerator`, `TestDataGenerator` and `DataImportModal` render `null` when closed
but are always mounted. Lazy-loading them buys nothing until the mount is gated, and gating the mount
changes their semantics (state resets on close). A behaviour change, not a bundling one.

### X5. `Studio.tsx` re-renders its whole tree on every keystroke

14 `useState`, no `useMemo`/`useCallback`, no memoized children, React Compiler off. #422's
code-splitting is not this fix and does not help it. It touches every prop in the shell, which is why
it was not mixed into a correctness PR.

`framer-motion` is also still in the first load: `Studio.tsx`, `ConnectionModal`, `SchemaExplorer`,
`ConnectionItem` and `TableItem` all import it statically and all mount on arrival.

### X6. 43 lists outside `SchemaDiff` are still keyed by index

`VisualExplain`, `DatabaseDocs` and the monitoring/admin tabs. `SchemaDiff` was fixed in #422 because
its rows are recomputed and reordered. The rest need reading one at a time, to tell the stable lists
(where an index key is fine) from the rest.

### X9. What `columnTypes` still cannot name, measured

The four string-returning drivers fill `QueryResult.columnTypes` since 2026-08-23. Four bounds were
measured while doing it, and each is a small residue rather than a defect:

- **A user-defined type has no name.** Postgres's built-in OIDs are a generated static table (they are
  compiled into the server and never reused), so an enum, a composite or an extension type falls
  outside it. Measured by walking every table and view in `dvdrental`: 128 result columns, 125 named,
  0 wrong, 3 absent - all three `mpaa_rating`. Resolving them needs a `pg_catalog.pg_type` round trip,
  which three of the four call sites cannot make: `query()` releases its pooled client before
  assembling the result, and `queryReadOnly()` promises EXACTLY ONE statement inside its
  `BEGIN READ ONLY`. A per-connection OID cache filled on first sight is the shape that would work.
- **MySQL cannot tell `POINT` from `GEOMETRY`.** Both arrive as code 255 with nothing else to separate
  them; 38 of the 39 other columns match `information_schema.DATA_TYPE` exactly.
- **`bit` is exported verbatim, and narrows.** `CREATE TABLE t (c bit)` is `bit(1)` on both Postgres
  and MySQL, so the DDL export should complete it like the other unbounded families - except `pg`
  hands a bit string back as the string `"1010"` while `mysql2` hands back a Buffer, so the same
  declared name needs the text family on one engine and the binary family on the other. One name, two
  answers, which is why it was left alone.
- **The mssql transaction path declares types for columns `fields` does not list.** `queryInTransaction`
  takes `fields` from `Object.keys(recordset[0])`, so a zero-row result has no fields while its
  `recordset.columns` (which does carry the declaration, even for zero rows - measured) fills
  `columnTypes`. Harmless today because all three consumers iterate `fields`; taking `fields` from
  `columns` too would be the right fix and is a behaviour change of its own.

**Done when:** each bound is closed or judged settled, with the enum case the only one a user is
likely to meet.

### X12. A declared type the export cannot map still reaches every target verbatim

`completeDeclaredType` re-spells a bare declared type the target dialect does not stand behind, and it
can only re-spell a name that is in `BARE_TYPE_FAMILY` - the four families whose parameters the wire
drops. Everything else goes through as the declaring engine wrote it, which is fine for a target that
happens to know the word and fatal for one that does not. Measured 2026-08-24, a Postgres result under
each target after the stands-alone work landed:

| Declared | ClickHouse | Trino | Cassandra |
| --- | --- | --- | --- |
| `jsonb` | `Code: 50 ... Unknown data type family: jsonb. Maybe you meant: ['JSON']` | `Unknown type 'jsonb'` | refused |
| `double precision` | resolves | resolves | `no viable alternative at input 'precision'` |
| MySQL `json` | resolves | resolves | `mismatched input ',' expecting '.'` |

So the DDL for an ordinary Postgres table with a `jsonb` column replays into neither ClickHouse nor
Trino. This is the "translation problem rather than this one" the module's own comment names: it needs a
type-translation table (declared name x target dialect), not another stands-alone row, and the table has
to answer what a target does when it has no equivalent at all - a JSON column into Cassandra is `text`,
and calling that lossless would be a lie.

**Done when:** a declared type the target cannot parse is either translated or refused with something a
reader can act on, proven by replaying a `jsonb` and a `json` result into ClickHouse, Trino and
Cassandra.

---

### X14. SingleStore's Explain panel needs a different STATEMENT, not a different protocol

D8 moved every parameterless statement onto MySQL's text protocol, and its own table claimed
`EXPLAIN FORMAT=JSON` was one of the statements that recovers on SingleStore. Re-measured
2026-08-24 on the same image (`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`), both protocols on
one connection: it is `ER_PARSE_ERROR` on BOTH. SingleStore's grammar is `EXPLAIN JSON <select>`,
which does show the protocol split (`ER_UNSUPPORTED_PS` prepared, succeeds as text), and plain
`EXPLAIN` splits the same way. So the panel's failure is a statement problem wearing a protocol
problem's error message, and the D8 row that said otherwise was wrong.

`src/lib/explain/mysql-json.ts` is one strategy per format (`registry` in
`src/lib/explain/index.ts`), and the type-id it serves is `mysql`. Reaching a second spelling means
either sniffing the engine inside the strategy - which this repo's provider rules forbid, no
`=== 'singlestore'` equivalent exists and none should - or a capability the connection carries, which
is the shape `ProviderCapabilities` already uses for exactly this kind of divergence.

The blast radius is one panel on one relative. StarRocks is a separate case again: its
`EXPLAIN FORMAT='json'` does not parse either, recorded in `docs/providers/README.md` as that
engine's own quirk.

**Done when:** either the Explain statement is a capability the connection declares rather than a
constant in one strategy, and SingleStore's panel renders a plan; or the panel is withheld on an
engine whose grammar the strategy cannot express, and the README rows say which engines those are.

---

### U2. The rule that catches an arity change on a JSX handler is configured but not aimed at components

`eslint.config.mjs` scopes the type-aware layer to `src/app/api/**`, `src/lib/db/**` and
`src/lib/storage/**`. `@typescript-eslint/no-misused-promises` is already `error` there, and its
`checksVoidReturn.attributes` default is exactly the check that catches a promise-returning function
handed to a JSX handler declaring `() => void`.

That is the defect #384's final commit fixed. `cancelQuery` gained a `tabId?: string` parameter, both
call sites in `Studio.tsx` still passed the function itself to a button's `onClick`, React filled the
slot with its MouseEvent, and Cancel silently stopped cancelling. TypeScript permits it — an optional
parameter still satisfies `() => void` — and the tests could not see it, because they called the
captured prop with no arguments.

Measured, not assumed: extending the layer's `files` to `src/components/Studio.tsx` and restoring the
defect makes ESLint flag both call sites. It also reports 21 further errors in the same file that are
not defects, mostly `onX={() => someAsyncThing()}` where nobody awaits and nobody needs to. Roughly
10:1 noise in one file, so this is not a scope widening that can be merged as-is.

The decision: accept the churn (a braced body or a `void` at each benign site, across the component
tree) for a mechanical gate on a defect class invisible to both the type checker and the tests, or
leave the layer narrow and rely on review. Cost it against all of `src/components/**` first — one
file's ratio is not the tree's.

**Done when:** the scope is widened with the benign sites made explicit, or the decision not to is
recorded here with the number that justified it.

### U18. The login hero has no vertical slack left, and the relatives line spends 56px it does not have

Measured on the built app (`next start`, Chromium), before and after the change that added the
wire-compatible relatives line:

| Viewport | Before | After | Sign-in card |
| --- | --- | --- | --- |
| 1440x900 | page 900px, no scroll | page 900px, no scroll | above the fold in both |
| 1280x800 | page 800px, no scroll | **page 856px, scrolls 56px** | above the fold in both |
| 1920x1080 | page 1080px, no scroll | page 1080px, no scroll | above the fold in both |
| 390x844 | page 991px (already scrolls) | page 1062px | above the fold in both |

The cause is not the line's height alone. At 1280x800 the hero column measured **exactly 800px before
the change** — the content block was 489px and the chrome took the rest — so the column had **zero
slack** and the `mt-auto` above it had nothing to absorb. Any block added anywhere in that column
scrolls the page at that height. One more row of engine pills would do it too.

**Re-measured with the nineteenth relative, and the figures did not move.** ScyllaDB joining
`WIRE_COMPATIBLE_ENGINES` adds a name to this same line, and at 1280x800 on the built app the page is
still 856px against an 800px viewport, still 56px of overflow, the line itself still 50px — the new
name fell inside the two-line box the eighteen already occupied rather than starting a third line. The
table above still holds; the next name is the one to re-measure.

Already spent to reduce it: folding the relatives line into the pills' own block instead of the hero's
32px rhythm (20px), `leading-snug` instead of `leading-relaxed` (12px), and a shorter lead sentence
(16px). 104px of overflow brought down to 56px.

Reaching zero means taking height out of a block that is not the relatives line — a decision about
what the hero says. The candidates are the `platform-line` ("Runs on Linux · macOS · Windows", 20px
plus its gap), the h1's two-line setting at 1280px, and the `connection-signature`'s `text-xl` at
that width.

The harm is bounded. The sign-in card is unaffected at every measured size. What falls below the fold
at 1280x800 is the bottom of the hero (the community row) plus the column's own top padding, which
collapses first. It is not the failure `login-form.tsx`'s comment records — a hero that measured
1294px in a 900px viewport and pushed the sign-in card itself down.

**Done when:** the hero fits at 1280x800 with the relatives line intact, or scrolling at that height
is accepted deliberately.

---

### U21. Two global maintenance cards exist for operations that have no card copy

MSSQL and MongoDB declare `check` as globally runnable and MySQL declares `optimize` the same way, but
`ProviderLabels` has only the `analyzeGlobal*` and `vacuumGlobal*` triads, so a global card can only be
rendered where the provider's `vacuumActionOperation` happens to redirect the vacuum slot to it. MySQL
gets an Optimize card that way; MSSQL's and MongoDB's `check` gets nothing.

Deliberately not fixed with U9 (2026-08-25): inventing card copy for five providers without measuring
what each statement actually does is the generic mapping #427 reverted. What is needed first is the
measurement, per provider, of what a whole-database `CHECK` costs on a real instance - `DBCC CHECKDB`
is not a free read.

**Done when:** an operation a provider declares globally runnable either has its own card copy or a
recorded reason it is withheld.

---

## Authentication and security headers

### AU3. The two headers that would protect a subresource are the two nobody has decided on

Closing AU2 delivered `X-Content-Type-Options` and `X-Frame-Options` to the paths `src/proxy.ts`'s
matcher skips, through `next.config.ts`'s `headers()`. Four of the six document headers were
deliberately left out of that path and the reasons are recorded beside the rule: a `next.config`
header set is baked at BUILD time while `src/lib/security/config.ts` reads its env per process, so a
copy of the CSP would strand the `CSP_REPORT_ONLY` escape hatch, and a copy of HSTS — which is
host-scoped, so the last value the browser receives wins — would let a request for `/logo.svg`
silently downgrade the policy the document just set. `Referrer-Policy` and `Permissions-Policy` act
on a document and are inert on an image or a script.

What that leaves is the pair that WOULD add real protection to a subresource and that neither the
Phase 1 set nor AU2 ever decided on: `Cross-Origin-Resource-Policy` and `Cross-Origin-Opener-Policy`.
Both are constant values, so the build-time objection above does not apply to them. Neither has been
measured against this app: CORP restricts who may embed our assets, and the app serves Monaco's
workers from its own origin, so a wrong value breaks the editor rather than failing quietly.

**Done when:** each of the two is either delivered, with the value measured against a running editor
and the Monaco worker path, or refused with the reason written next to the header rule.

## Tests

### T1. Two disjuncts are pinned by almost nothing

`isStatementText` (`src/lib/sql/statement-end.ts`) has a `dollar-string` disjunct pinned by exactly
one assertion. That is the same hole that, for the `subscript` disjunct, let a statement-corrupting
emission through the full gate, CI, 100% line coverage and five reviews — deleting the disjunct failed
zero tests. Line coverage cannot see a missing disjunct in a one-line predicate. Only a fixture where
the two readings *disagree* can pin it.

**Done when:** deleting any single disjunct of `isStatementText` fails a test.

### T3. `tests/security/image-proxy.test.ts` asserts a configuration invariant, not the threat

The design it protects: `/_next/image?url=http://169.254.169.254/` (or any attacker-chosen URL) must
be rejected, because `next/image`'s optimizer would otherwise perform an unauthenticated server-side
fetch of it.

What it asserts is narrower — `nextConfig.images` is `undefined`. That is sufficient today only
because nothing in `src/` imports `next/image` at all, so the control is closed and correctly verified
for the current codebase.

The gap: the assertion is a proxy for the threat. A future, strictly safer configuration would fail
it — `images: { unoptimized: true }` disables the optimizer's fetch entirely and would still trip
`toBeUndefined()`. The real assertion belongs with the Playwright work, which can make an actual HTTP
request against a running server. A unit test importing `next.config` cannot exercise the route.

---

### T4. Eight backlog ids cited in `src/` name entries that no longer exist

Measured 2026-08-26 by sweeping every `B*` id cited under `src/` against the entries in this file.
Dangling, with the number of source files citing each: **B7** (2), **B8** (2), **B17** (1), **B18**
(2), **B24** (3), **B27** (1), **B43** (8), **B47** (3). All of them predate this round -
`git show HEAD:src/lib/agent/table-profile.ts` carries the B7 and B8 citations already.

The mechanism is the asymmetry in the guard. `tests/unit/agent-documentation.test.ts` enforces the
two-way invariant between `docs/AGENT.md` and this file, so a `B`-id cited by that document must
exist and vice versa. Nothing checks a citation from a source comment. So the instruction this file
opens with - delete an entry when the work lands - leaves every code comment pointing at it silently
wrong, and those comments are not decoration: `table-profile.ts` cites B7 for "PostgreSQL expression
indexes are absent" and B8 for "the catalog read returns composite keys as the cross product of both
sides", which are behavioural limits a reader would act on.

Not fixed in the round that found it, on purpose. Each of the eight needs its claim re-verified
before it can be rewritten or restored, and the two possibilities are opposite: the entry may have
been deleted because the limitation was fixed (in which case the comment is false), or deleted by
mistake (in which case the entry should come back). Eight of those judgements is more than one round
can do honestly.

**Done when:** no id cited in `src/` is missing from this file, and the drift guard covers source
citations the way it already covers `docs/AGENT.md`.

### T5. The allowlist's provider-free check reads one level deep

`tests/security/route-auth.test.ts` now verifies that every route on `ROUTES_WITHOUT_A_PROVIDER` is
still provider-free, rather than merely naming a real route (this closed H10). It does that by
reading each allowlisted route's own source and matching the provider entry points: the `@/lib/db`
and `@/lib/llm` module specifiers by PREFIX, so a new factory export is covered the day it lands,
plus the one indirect helper that exists today - `@/lib/api/schema-route`, which is how
`db/schema/list` and `db/schema/relations` reach a provider without naming `@/lib/db` at all.

The residual is transitive reach. A future route that obtains a provider through a NEW indirect
helper module would still pass, because nothing follows the import graph. Measured at the time it was
written: zero allowlisted routes reach a provider, with or without comment stripping, so this is a
gap in the guard rather than a defect it is hiding.

**Done when:** the check resolves a route's imports transitively, or the set of indirect helpers is
itself pinned so a new one cannot appear unnoticed.

## Dependencies

### P1. The desktop shell's `glib` advisory has no reachable fix while Tauri v2 targets GTK 3

Dependabot alert 1 (GHSA-wrw7-89jp-8q8g, medium) reports unsoundness in the `Iterator` and
`DoubleEndedIterator` impls of `glib::VariantStrIter`, affecting `>= 0.15.0, < 0.20.0`.
`desktop/src-tauri/Cargo.lock` carries `glib 0.18.5` and it cannot move:

```
glib 0.18.5  <-  gtk 0.18.2 (requires glib ^0.18)  <-  tauri 2.11.5
```

`cargo update -p glib@0.18.5 --precise 0.20.0` fails on that requirement. Upgrading Tauri does not
help — 2.11.5 is the latest published version — and `gtk` cannot deliver the fix either: 0.18.2 is its
latest release and it is published as UNMAINTAINED, directing users to `gtk4`. The advisory closes
when Tauri's Linux backend moves off the GTK 3 bindings, which is upstream work.

Nothing in `desktop/src-tauri/` touches `glib`. Its direct dependencies are `tauri`, `serde_json` and
`libc`, and no source file references `glib` or `Variant`. The exposure is whatever Tauri and GTK do
with `VariantStrIter` internally, so the practical risk is low — but "we do not call it" is not proof
the path is unreachable.

**Done when:** Tauri's tree offers `glib >= 0.20` and the lock is updated, or the alert is dismissed
with this reasoning recorded on it. Re-check on each Tauri upgrade: `cargo tree -i glib` answers it.

### P2. TypeScript 7 is unreachable until it ships a programmatic API

`typescript@7.0.2` is on npm `latest` and is the native Go port. Its tarball contains no
`lib/typescript.js`: the exports map resolves `require("typescript")` to `lib/version.cjs`, which
returns `{version, versionMajorMinor}` and nothing else. `ts.createProgram` and `ts.Extension` are
`undefined`.

Two of the six mandatory gates call the compiler API directly, so both break at runtime while
`bun run typecheck` passes and reports nothing:

- `bun run lint` — `@typescript-eslint/typescript-estree` requires `typescript` in 19 files, and every
  published `typescript-eslint` caps the peer at `typescript: ">=4.8.4 <6.1.0"`. There is no v9 line.
- `bun run build:lib` — tsup's `dts: true` pipeline calls `ts.parseJsonConfigFileContent`.

`bun run build` additionally refuses unless `experimental.useTypeScriptCli` is set. Two smaller
blockers wait behind those: TS 7 removes `baseUrl`, which `tsconfig.lib.json` uses to resolve the
`@/*` alias for tsup's declaration bundler, and the `plugins: [{ "name": "next" }]` tsserver entry
has no host on 7.0. knip 6.x is unaffected — it is on oxc-parser with no TypeScript dependency.

Upstream, typescript-eslint's tracking issue
([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)) is labelled "blocked
by external API" and has a second, independent blocker: ESLint has no asynchronous-parser support,
which a tsgo backend needs. Microsoft promises the stable API in 7.1.

Worth knowing: `tsc --noEmit` under 7.0.2 already reports **zero errors** here, in **1.8s against
7.7s** for the 6.0.3 JavaScript compiler. So the compiler side is proven green and this is a
dependency bump plus a re-run of the gates whenever the API lands.

An interim option exists if that 4x is wanted sooner. Microsoft documents running
[6.0 and 7.0 side by side](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0):
keep `typescript@6` as the peer typescript-eslint resolves, add `typescript-7` as an npm alias, point
a second script at it. The cost is two compilers in the lockfile and two sources of truth about what
type-checks.

Do NOT reach for the `npm:@typescript/typescript6` alias workaround instead. It keeps TS 6 under the
name `typescript` for every gate that matters, so it buys a faster ad-hoc `tsc` and a package.json
that misreports its own compiler.

**Done when:** TS 7.1 ships that API **and** a `typescript-eslint` release admits `typescript: ^7`.
The whole check is one line: `npm view typescript-eslint peerDependencies.typescript`.

### P3. The ESLint 10 config carries a compat shim for eslint-config-next

`eslint.config.mjs` wraps `eslint-config-next`'s two configs in `@eslint/compat`'s
`fixupConfigRules`. ESLint 10 removed the deprecated rule-context methods; eslint-config-next 16.3.1
still depends on `eslint-plugin-react ^7.37.0`, whose newest release (7.37.5, April 2025) calls
`context.getFilename()` and declares `eslint: "... || ^9.7"`. Without the wrapper, loading any of its
rules throws `TypeError: contextOrFilename.getFilename is not a function` before a file is linted.
eslint-config-next's own peer range (`eslint: ">=9.0.0"`) does not express this.

**Done when:** eslint-config-next depends on an eslint-plugin-react that declares `eslint: ^10`, at
which point the two `fixupConfigRules(...)` calls become bare spreads and `@eslint/compat` leaves
`devDependencies`. Check with `npm view eslint-plugin-react peerDependencies.eslint`.

### P4. Two dependency majors deferred, and one decision that was skipped

Raised by Dependabot, closed unmerged. Recorded so the decisions survive whether or not the bot
re-raises them.

Still deferred:

- **`ioredis` 5 → 6.** The Redis provider maps `SCAN`/`INFO`/`SLOWLOG`/`CLIENT LIST` onto the
  SQL-oriented interface, so a client major needs the provider triad re-verified against a live
  server, not a type-check. RESP3 is the default in 6.
- **`oracledb` 6 → 7.** Thick/thin mode and the prebuilt binaries are what the Docker image and the
  AppImage build depend on. Check those before the API.

Taken since this entry was written: `@tanstack/react-table` 9, `framer-motion` 13, `eslint` 10.
`react-day-picker` was resolved by removal — its only importer was the vendored
`src/components/ui/calendar.tsx`, which nothing imported in turn. Both are gone. Re-add the dependency
only alongside a component that uses it.

**One thing to settle.** `@types/node` is now `^26.2.0` while `engines.node` still declares
`>=24.0.0`. This entry used to defer that bump for exactly this reason: typing against 26 lets code
compile that breaks on the floor the package advertises. The types moved and the floor did not.
Decide the floor, then keep the types matched to it.

`@zumer/snapdom` is pinned exactly (`2.15.0`, no caret) on purpose — see the ER-diagram export work —
and is not part of this list.

### P5. The rest of the unused shadcn primitives keep their dependencies alive

Dropping `react-day-picker` exposed the general case. `knip.json` lists
`src/components/ui/**/*.{ts,tsx}` as an *entry* glob, so every vendored shadcn file is a root. knip
never reports one as unused, and the package it imports therefore counts as used.

Roughly twenty primitives under `src/components/ui/` have no importer at all, and several are the sole
reason a package is installed: `carousel` → `embla-carousel-react`, `form` → `react-hook-form`,
`input-otp` → `input-otp`, plus `@radix-ui/react-accordion`, `-aspect-ratio`, `-avatar`,
`-collapsible`, `-hover-card`.

This is a decision, not a bump: either accept the vendored set as a deliberate on-hand library and say
so in `CLAUDE.md`, which today says nothing about it, or sweep the orphans and their packages the way
`calendar.tsx` went. Until then every Dependabot major on one of those packages costs a review for a
component nothing renders. Reproduce the list with a per-file importer count over `src/components/ui/`.

## Documentation

### DOC1. Provider-doc line references are stale across the board

`docs/providers/mssql.md` puts `getCapabilities()` at :57 and `getSchema()` at :369, where they are at
391 and 749. The drift predates any recent milestone and every provider doc uses the same
line-anchoring style, so the fix is a convention change — anchor on symbol names, not line numbers — as
much as a correction.

The same disease is in this file. Prefer symbol names here too.

### DOC3. Six channel listings carry corrected copy that nobody has resubmitted

The false strings are gone from the tree as of 2026-08-25. What is left is the part this repo cannot
do: each file is a submission to somebody else's marketplace, published from its own review cycle, so
editing it here changes nothing a user sees until the channel is re-submitted.

| File | What changed |
| --- | --- |
| `deploy/railway/TEMPLATE_OVERVIEW.md` | NL2SQL removed; the read-only agent and plan mode named; 13 engines to 14 |
| `deploy/railway/template.json` | 13 engines to 14; "AI-powered query assistance" to optional read-only AI |
| `deploy/digitalocean/assets/description-long.md` | NL2SQL bullet replaced by the agent and the plan-derived explanation |
| `deploy/rancher/CATALOG_LISTING.md` | same, plus an accuracy gate holding each claim to a cited file |
| `deploy/azure/listing/listing-fields.md` + `listing/description.html` | one Partner Center submission, both halves corrected |
| `deploy/caprover/libredb-studio.yml` | 13 engines to 14; the AI clause narrowed |

Two claims had to be narrowed rather than kept, both caught by review rather than by a gate: AI
explanation is **not** offered on every connection (it is derived from the engine's `EXPLAIN` plan, so
`BottomPanel.tsx` hides the tab wherever `capabilities.explainFormat` is absent - 7 of the 14
engines), and "never executes what it recommends" is the formulation #449 already rejected, because
the consented hand-over runs exactly the recommended statement
(`src/app/api/agent/runs/[runId]/handover/route.ts`). `tests/unit/marketplace-copy.test.ts` now binds
the submitted copy to both facts, so a future edit that re-widens either claim fails a gate rather
than a reviewer.

**Done when:** each listing has been resubmitted through its own channel. Six submissions, five
channels - the two Azure files travel together.

---

## Release pipeline

### REL1. No CI job installs the released chart artifact with a Helm 3 client

The CI Helm matrix pins six of its seven `azure/setup-helm` sites to Helm 4.1.3 and keeps
`helm-release.yml` → `lint-test` on Helm 3.16 on purpose, because our users install with Helm 3.
`tests/unit/helm-pin-matrix.test.ts` locks that split.

What the Helm 3 job proves is narrower than the marker at the site used to claim: `ct install --charts
charts/libredb-studio` installs the chart SOURCE directory. Never the `.tgz` that
`release-github-pages` packages with Helm 4, and never the OCI artifact `release-oci` pushes. So no
job anywhere performs `helm install` with a Helm 3 client against a released byte.

The gap is believed narrow. A Helm 4 package differs from a Helm 3 one only in preserved source
mtimes, and extracted trees, `tar` member lists, `helm3 lint --strict`, `helm3 show chart`,
`helm3 template` and a `helm3 pull` of the pushed OCI artifact were all verified equivalent by hand
before the pins were raised. But "verified once by hand" is not a gate, and nothing would catch a
future Helm 4 packaging change that a Helm 3 client rejects at install time.

**Done when:** `helm-index-check.yml` (which today only curls the index and compares sha256, running
no Helm client at all) also runs a pinned Helm 3.16 `helm repo add` + `helm pull` + `helm install` of
the published chart version against a kind cluster, or an equivalent post-publish smoke lands
elsewhere.

---

### REL2. The arm64 AppImage still carries a glibc 2.39 floor

`desktop-appimage` builds x64 on `ubuntu-22.04` (glibc 2.35) so the AppImage loads on the oldest
still-supported LTS, and `tests/unit/desktop-appimage-portability.test.ts` pins that. The arm64 leg
still runs on `ubuntu-24.04-arm`, so the arm64 AppImage requires GLIBC_2.38 in every bundled GTK and
WebKit library and GLIBC_2.39 in the Tauri binary - measured on 0.13.1 for x64, and the arm64 leg
builds from the same runner generation.

That excludes the arm64 targets the artifact mostly exists for: Raspberry Pi OS bookworm ships glibc
2.36, Debian 12 arm64 the same, Ubuntu 22.04 arm64 2.35. The failure is the loader refusing every
shared object, so there is nothing to diagnose from the user's side beyond "it does not start".

Not done with the x64 fix because the `ubuntu-22.04-arm` runner label was never exercised by this
repo, and `desktop-appimage` is a hard release gate: a bad label fails the whole release, and a
failed release costs a patch version. It wants one throwaway `workflow_dispatch` run to confirm the
label and that jammy-arm64 carries `libwebkit2gtk-4.1-dev`, not a blind flip on a release commit.

**Done when:** the arm64 matrix entry builds on `ubuntu-22.04-arm`, the resulting AppImage is
verified to load on a glibc 2.35 or 2.36 arm64 root filesystem, and the `not.toContain("latest")`
assertion in the portability test is joined by an explicit arm64 label assertion.

---

### REL3. The Chocolatey package is not trusted, so every release waits on a human moderator

The community repository human-reviews **every new version** before approval; only *trusted
packages* skip that step, and the moderation team's own published figure for the wait is "a few days
to a few weeks". Until a version is approved it stays unlisted, so a release can publish everywhere
else while `choco install libredb-studio` still serves the previous version. The drift table shows
this honestly — the pin reads the feed's approved version — and the release run degrades to a warning
rather than a failure, so nothing here is broken. It is latency, and it is the only channel that has
any.

Two routes to trusted status are documented, and LibreDB already qualifies on the first: *"You write
the underlying software that the package installs"*. But it is granted by hand — *"a manual change by
a moderator... does not happen immediately even if you are the software author"* — and in most cases
only *"after a few versions have been approved by moderators without any changes being required"*.
As of 0.9.59 (approved 2026-08-24 by `flcdrg`) there is exactly one such approval, and the two
guideline notes that submission raised were fixed in the templates by #208, so the next few should be
clean.

Not done now because asking after a single approval is asking early, and there is no form to submit:
the route is the Chocolatey Community Hub `#community-maintainers` channel, or the site-admin contact
form, identifying ourselves as the software vendor.

The lag also has a second-order cost worth watching: `push.chocolatey.org` answers `403` when a
package has *"too many existing versions in moderation"*, and the cap is not documented anywhere
public (the gallery is closed source). A release cadence faster than the queue drains will find it.
The push step tolerates that failure, but the affected version then needs a manual back-version push
once the queue clears.

**Done when:** the package carries trusted status — observable as a version reaching `Approved` in
the feed within minutes of a push, with no human reviewer recorded — or a decision is written down
that the moderation lag is accepted permanently and this entry is deleted.

---

## Chart configuration surface

Found while reviewing #362 (the Gateway API `HTTPRoute` template) and its follow-up #366. None is
caused by those changes. All share one failure shape: configuration the chart accepts that produces an
install which succeeds while the app stays unreachable.

### N1. The chart cannot expose the app on OpenShift, where `Route` is the native way in

`grep -rl 'route.openshift.io' charts/ operator/` returns nothing. The chart renders an `Ingress`
(`templates/ingress.yaml`) and, since #362, a Gateway API `HTTPRoute` (`templates/route.yaml`), but
never a `route.openshift.io/v1` `Route`.

Meanwhile the chart carries an OpenShift security-context adaptation and the repository publishes an
OpenShift operator to OperatorHub. So OpenShift is a first-class target everywhere except the one
object that makes the app reachable there.

The consequence is the symptom #362 was opened to fix, one platform over: `helm install` succeeds, the
pod runs, and the operator has to hand-write a `Route` outside the chart and keep it in sync across
upgrades. An `Ingress` is *sometimes* served on OpenShift by the router's ingress translation, but that
is a compatibility shim with its own annotation dialect, and it does not cover re-encrypt or
passthrough TLS.

Note the naming collision: `route.*` in `values.yaml` means Gateway API as of #362, so an OpenShift
`Route` cannot reuse that key. `openshiftRoute.*` is the obvious alternative.

**Done when:** an OpenShift cluster can be served by the chart alone, with TLS termination selectable,
and the README says which of the three exposure mechanisms belongs to which platform.

### N3. Subpath deployment is build-time only, which is why #369 is deferred rather than scheduled

[#369](https://github.com/libredb/libredb-studio/issues/369) asks to serve Studio under a path prefix
on a shared domain — `https://example.com/libredb` next to `https://example.com/grafana`.
`next.config.ts` sets no `basePath` and no `assetPrefix`, so there is zero support today.

The constraint, recorded so nobody rediscovers it: **Next.js `basePath` is baked at build, not read at
runtime.** Asset URLs (`/_next/static/...`) are emitted into the HTML and JS at build time and there
is no supported runtime override. So a `BASE_PATH` env var on the prebuilt image cannot work — the
feature has to be a build arg and a rebuilt image.

A reverse-proxy `StripPrefix` is not a workaround either. The browser asks for `/libredb/`, the proxy
strips it, the app answers with HTML referencing `/_next/static/...` at the root, and that follow-up
request no longer matches the `/libredb` router rule. Grafana can do this at runtime because it is a
Go server templating its own HTML; a statically built Next.js app is structurally different.

The surface a build-time implementation touches: roughly 40 `fetch('/api/...')` call sites, roughly 15
`router.push('/...')`, the cookie `path: "/"` in `src/lib/auth.ts` and the OIDC login route, OIDC
redirect URIs, the `src/proxy.ts` matcher, the Docker healthcheck, the chart's ingress and route
paths, the npm library surface, the E2E suite and the docs of roughly 27 distribution channels.
`next/link` and the app-router `router` prefix automatically; `fetch`, middleware redirects and cookie
paths do not.

Deferred rather than scheduled because the acquisition-relevant PaaS one-click listings hand out
subdomains, not subpaths, so no shipped channel needs it.

Related sharp edge, same silent-no-op class as #366: `values.yaml` already lets a user set
`ingress.hosts[].paths[].path` to `/libredb`, the install succeeds, and the app is unreachable.

**Done when:** a `BASE_PATH` build arg produces an image reachable under a path prefix — assets, API
calls, auth cookie and OIDC redirect included — verified against a real path-routing proxy, or the
chart refuses a non-root ingress path outright.

---

## Security Phase 1 deferrals

Each was decided during Phase 1, not overlooked.

### H1. A CSP nonce needs the app to stop being statically prerendered

`src/lib/security/headers.ts`'s `script-src` carries `'unsafe-inline'`, so the policy does not block an
inline event handler. A nonce is the only alternative, and it is blocked by a structural fact: every
document route is statically prerendered (verified — nonce-less `self.__next_f.push` scripts baked into
`.next/server/app/index.html` and siblings), and a per-request nonce cannot be applied to prerendered
HTML.

The plumbing exists on both sides. Next reads a nonce from the `script-src`/`default-src` directive of
a CSP header the app supplies, and Monaco's loader supports `loader.config({ cspNonce })`
(`public/monaco/vs/loader.js`).

The experiment, so nobody re-derives it: force dynamic rendering on the root layout, thread the nonce
into the Monaco loader config, then measure what the lost prerendering costs in cold-start time and in
the channels that serve Studio from a small box.

**Done when:** the measurement says the trade is worth it and the nonce ships, or the measurement is
recorded here as the reason it does not.

### H3. Audit events do not record a user agent

`AuditEvent` (`src/lib/audit.ts`) deliberately has no `userAgent` field. It is attacker-controlled free
text with marginal value for a single-operator product, and adding it means adding the redaction
question the closed `AuditReason` union exists to avoid.

**Done when:** a real investigation needs it, at which point it is added as a truncated, explicitly
allowlisted field.

### H4. The `@libredb/studio/security` usage note is not in the published README

An npm consumer reading `README.md` on npmjs.com sees nothing about `securityHeaders()`.

It used to live in `.claude/rules/platform-integration.md`, which was deleted with the
platform/studio decoupling, so there is no longer a second home for it at all.

It is out of `README.md` because `README_zh.md` and `README_ja.md` (`scripts/readme-check.mjs`'s
`LOCALIZED` pair) would then drift, and that script guards the pair structurally rather than by
heading.

**Done when:** the note lands in all three READMEs together.

### H5. No env var can turn HSTS off, and that is deliberate

`readSecurityHeaderOptions()` always sends `Strict-Transport-Security`. Unlike `CSP_REPORT_ONLY` there
is no `HSTS_DISABLE`, and one should not be added in the shape an operator would expect.

An escape hatch that merely *stops sending* the header is useless against the failure it would be
built for. A browser that already cached the HSTS pin keeps enforcing HTTPS-only for the remainder of
the 180-day `max-age`, whatever the server does next. And a server that has reverted to plain HTTP may
not be reachable by that browser at all, because HTTPS-only means the plain-HTTP origin is refused
before any response body is read.

The only hatch that works emits `Strict-Transport-Security: max-age=0` over a still-live HTTPS
listener, which is what tells a visiting browser to drop the pin.

**Done when:** a real report of a stuck pin needs this, at which point it is a `max-age=0` mode, never
a header omission.

### H6. A coverage phantom recurs wherever a rarely-covered function has a multi-line inline param type

`scripts/merge-lcov.mjs` picks one "authority" record per source file — whichever test run has the most
executed lines — to decide which lines are coverable (`docs/TOOLCHAIN.md`).

A function with a multi-line inline parameter type (`function f(opts: { a?: string; b?: string; … })`)
exercised by only one test file reads as fully covered, because that file wins the authority vote.
Adding a second test file that exercises a large *new* surface in the same source file — without ever
calling that function — can tip the vote. The new file's own run reports the old function as a coarse,
never-executed block whose zero-hit lines include the parameter type's continuation lines. It looks
like a coverage regression in code nobody touched.

`src/lib/audit.ts`'s `AuditRingBuffer.filter` hit this during Phase 1. Extracting the inline type to a
module-scope interface fixed it permanently, because module-scope type members are erased before any
function's coverage span exists.

**The general fix:** hoist a multi-line inline parameter or return type to a module-scope
`interface`/`type`. Do not chase it by adding a test that calls the under-covered function for
coverage's sake.

### H7. `sanitizeAuditInput` does not recurse, so a nested secret survives inside the coerced string

`sanitizeAuditInput` used to sanitize a value only when `typeof value === "string"`, silently skipping
everything else. That was corrected for I3 of the Phase 1 review: a top-level value that is neither a
string nor `duration`'s legitimate number is now coerced to a string (`JSON.stringify`, then the same
`sanitizeAuditField` a real string goes through).

That fix mattered more than the original entry claimed. It said the risk was "bounded to the ring
buffer, not stdout, because `toAuditLine`'s allowlist never re-serializes an unknown property". True
for `details` specifically, false as a general rule: `target`, `user`, `action`, `connectionName`, `ip`
and `bucket` are all allowlisted onto the stdout line, all string-typed, and all reachable with a
non-string runtime value the same way `POST /api/db/maintenance`'s `target` was.

The residual is narrower. Coercion is whole-value, not recursive per-key redaction.
`sanitizeAuditField`'s credential pattern only recognizes a URI-shaped `scheme://user:pass@host`
substring, so a nested secret under an arbitrary key name (`{"apiKey": "sk-live-…"}`) is bounded and no
longer breaks the shape contract, but is not specifically redacted. It survives, truncated, inside the
JSON-stringified value.

**Done when:** nested plain objects are walked key-by-key, at bounded depth, so a non-URI-shaped nested
secret gets the same by-key-name scrutiny a top-level one does. Note that no such scrutiny exists for
any field today, top-level or nested — this is a new capability, not a gap being closed.

### H8. Lowest-count eviction lets an attacker buy back a `login_account` guess

From `pruneIfAtCapacity`'s doc comment in `src/lib/api/rate-limit.ts`: an attacker can buy back one
guess against an established `login_account` target sitting at count N for roughly
`(MAX_ENTRIES_PER_BUCKET - 1) × N` decoy requests. Not a flat `MAX_ENTRIES_PER_BUCKET - 1`, because
each of the ~999 decoys must itself be raised from 0 to N before the tie-break can fire.

At the bucket's default (20), a target one guess from tripping sits at count 20 — `decide()` checks
`entry.count >= limit.max` before incrementing — so it costs on the order of 999 × 20, about twenty
thousand decoy requests. The tie-break favours evicting the earliest-inserted member of a tied group,
and the target, created before its decoys, always is.

A real linear cost multiplier, not a bypass. Unlike a tripped bucket it produces no
`rate_limit_exceeded` audit event, so an operator watching only the audit trail would not see it.

Accepted for Phase 1: the lowest-count policy is itself the fix for a worse bypass (an attacker
evicting a target's entry for free before it can accumulate any cost), and the two alternatives
considered each introduced a worse flaw.

**Done when:** a cheaper, audit-visible eviction policy is found that does not reopen the oldest-first
bypass.

### H11. `login_account`'s hard cap is an accepted denial-of-login handle on a known account

The `login_account` bucket is keyed on `hmacHex(submittedEmail)`, which makes it immune to
`X-Forwarded-For` spoofing. It throws before the credential comparison runs, and is cleared only by a
*successful* login — which cannot happen while it is tripped.

So anyone who knows or guesses a real address can lock that account out for the rest of the window with
the bucket's default (20 wrong guesses), and renew the lockout indefinitely at roughly one guess per
window. The published default `admin@libredb.org` when `ADMIN_EMAIL` is unset makes this free.

`login_client`, the address-keyed bucket, does not help: it is bypassed in any topology where an
attacker can set or rotate `X-Forwarded-For` — direct exposure, or a proxy that appends rather than
overwrites (Caddy and Traefik defaults, and the common nginx `proxy_add_x_forwarded_for` recipe).

This is inherent to a hard per-account cap. Bounding brute force against an operator-set password and
bounding this lockout are in direct tension, and no design removes one side without giving up the
other. `.env.example` documents `RATE_LIMIT_LOGIN_ACCOUNT_MAX=0` as the break-glass (verified:
`decide()` returns `allowed: true` unconditionally for `max === 0`, for both `peekRateLimit` and
`consumeRateLimit`, so the bucket is fully inert). Phase 1 narrowed the window from 900 to 300 seconds
to shrink the blast radius without loosening the guess ceiling.

**Done when:** a design keeps this bucket immune to header spoofing without also being a stranger's
denial-of-login switch. Unknown at the time of writing.

### H13. No rate-limit bucket is a global, unkeyed ceiling — on purpose

Every bucket in `src/lib/api/rate-limit.ts` is keyed on something the caller supplies:
`login_client`/`anon` on the derived client address (attacker-controlled in any topology without a
correctly configured `TRUSTED_PROXY_HOPS`), `login_account` on a hash of the submitted email (fully
attacker-chosen, see H11), `query`/`ai` on the session's username.

A global, unkeyed ceiling is the one shape that cannot be evaded by picking a favourable key, because
there is no key to pick. Phase 1 does not add one, deliberately: a global ceiling on `login_client` or
`anon` turns one attacker's flood into a lockout for every other concurrent user of the same bucket,
which is strictly worse than the keyed floods it would prevent. And getting the sizing right — loose
enough not to bite a legitimate multi-tenant deployment, tight enough to bound an attacker — is its own
design problem this wave did not scope.

**Done when:** a real, measured flood makes the keyed buckets' residual insufficient and a global
ceiling's sizing can be grounded in that data rather than guessed.

---

## Security Phase 2 deferrals

Each was decided during Phase 2, not overlooked. Lettered `C` (supply **C**hain) because the SQL
section already owns `S1`–`S8`.

### C2. A failing scheduled scan notifies nobody but the owner

`security-scan.yml`'s daily run fails when a critical fixable advisory lands, and GitHub emails the
repository owner for a failed scheduled run. That is the whole notification path.

`helm-index-check.yml` shows the alternative in this repository — a job with `issues: write` that
maintains a single rolling issue. It was not copied here because an auto-filed issue per advisory is
how a security label becomes noise.

**Done when:** a real missed advisory shows the email is insufficient, at which point the rolling-issue
pattern is the thing to copy.

### C3. The image SBOM is a 30-day workflow artifact, not a durable asset

It cannot be a release asset: `release-artifacts.yml` publishes the release before dispatching
`docker-build-push.yml`, and immutable releases (#154) freeze the asset set at publish time.

Nothing is lost that cannot be recovered — it is regenerable by anyone from an immutable public digest
with one Trivy command, documented in `SECURITY.md`. What is missing is convenience and an attestation.

The clean fix is a buildx SBOM attestation (`sbom: true` on `docker/build-push-action`), which attaches
it to the image manifest. Not taken in Phase 2 because it adds a step, and a failure mode, to the
release-path Docker build — the most fragile CI surface here.

**Done when:** the release chain has been quiet for a few releases and the change can be validated with
a `workflow_dispatch` backfill first.

### C4. No SBOM covers the operator image

`operator-release.yml` builds a controller image that wraps the chart. Phase 2 touched no release
workflow other than `release-artifacts.yml`, and the operator image has a different lifecycle and a
different consumer (OpenShift OperatorHub, which does its own scanning).

**Done when:** a certification requirement asks for one.

### C5. Dependabot raises version updates but cannot raise security ones

`.github/dependabot.yml` groups weekly version updates across Bun, GitHub Actions and both
Dockerfiles. Bun is its own `package-ecosystem`, not part of `npm` — the config shipped in #375 said
`npm`, whose updater cannot see `bun.lock`, so five bot PRs bumped `package.json` alone and died on
`--frozen-lockfile`.

What Dependabot still cannot do is the other half: its Bun support covers **version updates only**.
Security updates are not implemented upstream for this ecosystem. So an advisory against a package Bun
resolves reaches nobody automatically. Trivy and `bun audit` are the only things that see it, and
acting on one is a human step.

That is also why several dependencies are excluded from the bot, each with its reason in the config:
database driver majors (mocked in tests, so a wire-behaviour change goes green — ioredis 6's RESP3
default is the live case), the exact-pinned agent runtime (a bump fails
`tests/unit/agent-dependency-boundary.test.ts` by design), `@zumer/snapdom` (pinned for ER-diagram
export fidelity), and the `oven/bun` base image (its version lives in the Dockerfile tag and the
workflows' `bun-version` input, which Dependabot cannot see as one).

**Done when:** Bun security updates land upstream and the exclusion list can be re-read against what
they cover.

### C6. `bun audit` cannot answer "is there a fix"

It reports severity and vulnerable ranges and no fixed version, which is why Trivy owns the gate and
`bun audit` is a job-summary second opinion. If bun adds fixed-version data, the container dependency
in the local contributor workflow could be dropped entirely.

**Done when:** `bun audit --json` carries a fix field.

### C7. The release SBOM does not describe the bundled Node.js runtime

`packaging/linux/fetch-node.sh` and `packaging/windows/fetch-node.sh` download a pinned Node.js build
and bundle it into every packaged artefact except the npm package: the standalone tarballs, the Windows
zip, the `.deb` and `.rpm`, the snap, the AppImage and the desktop package.

That runtime is the largest single binary in most of them, it is fetched by a shell script rather than
resolved from a lockfile, and the CycloneDX SBOM Trivy generates from `bun.lock` never sees it. The
document's only `node`-named component is `pkg:npm/@types/node`, a type-declarations package.

`SECURITY.md` now says the SBOM covers "the dependency closure of" those artefacts rather than the
artefacts themselves, which is the honest claim. This entry is the gap behind it.

**Done when:** the bundled runtime's version and provenance appear in the SBOM or a sibling document —
a second Trivy pass over the `fetch-node.sh` pinned version, or a hand-maintained component entry.

### C8. No artefact root declares that part of the distribution is not MIT

`LICENSE` states the project's own MIT terms, and nothing at the root of any packaged artefact says
that not everything inside is under those terms. Two kinds of obligation sit behind that.

**Routine attribution.** A scan of the installed tree (1169 distinct packages) puts 1136 under MIT,
Apache-2.0, ISC or BSD, all of which want the copyright notice to travel with redistributed copies.
Two carry attribution as their whole purpose: `caniuse-lite` is CC-BY-4.0 and the `geist` font is
under the SIL Open Font License.

**Share-alike.** `seed-assets/sqlite/employee.db` is CC BY-SA 3.0. That was handled deliberately —
`seed-assets/sqlite/ATTRIBUTION.md` records the provenance, the license, the modifications made here
and the fact that the file is redistributed under the same terms. But the file ships in the image (the
runner stage copies `seed-assets` explicitly) and in the packaged tarballs, and nothing at the root of
those artefacts points at that nested ATTRIBUTION.md. A reader of the image sees an MIT `LICENSE` and
a CC BY-SA database with no note connecting them.

**Done when:** a generated `NOTICE` (or `THIRD_PARTY_LICENSES`) ships at the root of the image and the
tarballs, names the sample database's separate terms explicitly, and is regenerated from the lockfile
rather than hand-maintained.

### C9. `elkjs` is EPL-2.0 and a direct production dependency

Every other direct production dependency is permissive. `elkjs@^0.12.0` is EPL-2.0 — a file-level
reciprocal license with a patent-retaliation clause — and it is ours by choice rather than transitive:
the schema diagram's layout worker imports it at
`src/components/schema-diagram/elk.worker.ts`.

It is used unmodified, which is the case EPL-2.0 is comfortable with, so nothing is wrong today. But
the distributed bundle is MIT-plus-EPL rather than MIT, and that is a question an acquirer's counsel
asks rather than overlooks.

Recorded rather than acted on because the alternatives are worse: ELK is the only layout engine in the
ecosystem that produces the layered orthogonal routing the ER diagram depends on.

**Done when:** the mixed terms are stated openly (alongside C8, the natural place), or a permissive
layout engine proves it can match the output.

### C10. The last DOMPurify advisories are held open by Monaco's pin

`dompurify` via `monaco-editor` is the only advisory chain that reaches a user. Everything else
`bun audit` reports — `minimatch`, `brace-expansion`, `flatted`, `picomatch`, `esbuild`, `@babel/core`,
`undici` — arrives through `eslint`, `typescript-eslint`, `knip`, `tsup`, `workflow` and `@ai-sdk/*`,
and none of it is in the image. `undici` was checked specifically, because the agent runtime sits in
`devDependencies` by design yet reaches the standalone build: building with `DOCKER_BUILD=true` shows
no `undici` anywhere under `.next/standalone`, since `@ai-sdk/provider-utils` reaches it through a
`createRequire` call that output tracing cannot follow.

#374 moved the shipped copy from 3.2.7 to 3.4.8 by upgrading Monaco itself, clearing 14 of the 17.
**Four remain** on GitHub Advanced Security's count, and none can be closed here: they need 3.4.9,
3.4.11, 3.4.12 and 3.4.13. Monaco pins dompurify exactly, and 0.56.0 is its newest release.

**Do not "fix" these with a `package.json` override.** Monaco ships DOMPurify inlined in its prebuilt
`min/vs` bundle and nothing in `src/` imports the package. An override would change a lockfile entry no
shipped code reads, leave the bundle byte-identical, and turn `bun audit` and Trivy green at once. The
GHAS findings land on `bun.lock:<line>`, which is the tell: every one of those tools reads the
manifest, not the artefact.

Two related non-findings, so they are not re-derived. `dompurify` is dual-licensed (MPL-2.0 OR
Apache-2.0), so the copyleft half can simply not be chosen. And the LGPL-3.0 `@img/sharp-libvips-*`
binaries never reach the runtime image, because the runner stage copies `node_modules` selectively and
nothing in `src/` uses `next/image`.

**Done when:** Monaco ships a dompurify at or past 3.4.13. Re-check on each Monaco release, and verify
by grepping the staged bundle for the version literal rather than trusting the lockfile.

---

## Security Phase 3 deferrals

Each was decided during Phase 3, not overlooked.

### K2. A legacy plaintext password shaped exactly like an envelope is treated as corruption

`src/lib/storage/encryption.ts`'s `readSecret` treats a three-segment value whose first segment matches
`/^v\d+$/` as an envelope. A password stored before this feature existed that happens to be literally
`v1:<base64url>:<base64url>`, with a 12-byte first segment and a second of at least 16 bytes, is
classified `undecryptable` and omitted.

The compounded probability is negligible and the failure is recoverable: the connection survives and
the user retypes the password once. The alternative — passing an unrecognised value through — would hand
`v1:abc:def` to a driver as a password.

**Done when:** the envelope format is versioned forward for an unrelated reason, at which point a
longer, non-colliding prefix costs nothing.

### K4. Rotating the key back does not recover credentials once the app has written

`decryptConnections` omits an unreadable secret and keeps the record, which is correct: dropping the
record would be persisted as a deletion. But the omission is only recoverable until the next write.
`useStorageSync` is a write-through cache, so the first push of the `connections` collection after a
failed read overwrites the ciphertext with a record that has no password field at all.

The warning fires on READ, which is before any write, so an operator who reads their logs promptly has
a window.

Making the window unnecessary would mean reading the stored row before every write and preserving an
existing envelope when the incoming value is absent — which would also silently resurrect a password the
user deliberately cleared. A worse bug than the one it fixes.

**Done when:** a design distinguishes "the client never had this value" from "the client cleared this
value" without adding a field to the stored shape.

---

## Agent M1 deferrals (#328)

Each was decided while building the operation/policy layer, not overlooked.

### A1. A SQLite agent statement can block the runtime for its whole duration

`sqlite.ts`'s `queryReadOnly` enforces `statementTimeoutMs` as a post-execution deadline: the result of
an overrunning statement is refused, but the statement is never preempted. SQLite has no
transaction-local statement timeout, and neither `bun:sqlite` nor `node:sqlite` exposes
`sqlite3_interrupt` or a progress handler.

Because both drivers are synchronous, a hostile recursive CTE blocks the whole runtime while it runs.
Same property as the normal SQLite query path, but the input source differs in kind: there the SQL
comes from an authenticated operator, here from an agent.

**Done when:** either driver exposes an interrupt/progress hook, or agent SQLite execution moves to a
worker that can be killed on deadline.

### A2. `VACUUM INTO` can create an empty file at an agent-chosen path

The SQLite agent profile's read-only open governs the target database file only. `VACUUM INTO '<path>'`
writes to a *different* file and is refused by `PRAGMA query_only`, which the profile re-asserts and
verifies before every statement. But SQLite creates the destination file before the write is refused,
so a zero-byte file can appear at any path the server process can write to. No data reaches it —
asserted on both adapters by file size.

Closing this needs an authorizer callback, which `bun:sqlite` does not expose at all.

**Done when:** a control exists on both adapters, or agent SQLite targets are constrained to an
allowlisted directory. (The base-dir allowlist idea came from #125, now closed.)

### A3. Out-of-scope READS have no database-native control on either provider

Both agent profiles bound what a statement can WRITE with a database-native control. What it can READ
is bounded only by the policy layer's declared-target allowlist plus the input-stage statement guard,
and both of those read SQL — defense in depth, not a boundary:

- **SQLite:** `ATTACH` of an *existing* file succeeds on a read-only handle and its rows become
  readable. No authorizer exists on `bun:sqlite` (`docs/providers/sqlite.md` §12.3).
- **PostgreSQL:** the read-only role can read every table its grants allow, whatever catalog or schema
  the request declared. Per-table `SELECT` grants are the only real bound
  (`docs/providers/postgres.md` §12.3).

**Done when:** out-of-scope reads are refused by something that does not read SQL — a per-target grant
set generated for the agent role, an allowlisted directory for SQLite, or an authorizer both adapters
expose.

### A5. The PostgreSQL profile's regression tests model the server rather than run one

`tests/integration/db/postgres-provider.test.ts` proves the read-only profile against a stateful
hand-written engine mock. Every rule it models was verified against a live PostgreSQL 18 while the
profile was built — read-only transaction rejection by engine state, the extended-protocol refusal of
multi-command strings, `SET TRANSACTION READ WRITE` really relaxing the transaction, advisory locks
surviving rollback — and the mock encodes them faithfully enough that bypass attempts fail on real
modeled behaviour (a write actually landing) rather than on protocol metadata.

What it cannot catch is a regression on the other side of the seam: a driver change, a server version
that behaves differently, or a `pg` option that stops meaning what it meant. The assertions would stay
green because the mock, not the server, defines the semantics.

The integration suites are mock-based by convention and CI runs no database service. The only real
engine in the pipeline is the throwaway PostgreSQL container behind
`loop/scripts/functional-smoke.sh`.

**Done when:** a container-backed test proves, against a supported PostgreSQL, that a direct write and
a multi-command escape are rejected through the profile under the resolved role. Cheapest path is
extending the functional-smoke container, not adding a service to every CI test job.

### A6. Druid's hand-written bigint serializer predates the Node 24 floor

`druid/http-transport.ts` splices the parameters array into the query envelope by hand so a `bigint`
literal reaches Druid unquoted. The reason recorded in `docs/providers/druid.md` was that
`JSON.rawJSON` (ES2025, V8 12.4 / Node 22.2) could not be depended on while `engines.node` was
`">=20.9.0"`.

That constraint is gone: #326 raised the floor to `">=24.0.0"`. The hand-serializer is not wrong and is
fully covered, so it was left alone rather than rewritten inside a runtime-baseline change — swapping a
correctness-critical escaping path belongs in a change whose tests are about that path.

**Done when:** the splice is replaced by `JSON.rawJSON` with the existing bigint fixtures still green,
or this entry is deleted with a note that the hand-serializer is preferred.

> TypeScript 7 was the seventh entry here. It is the same finding as P2, which now carries it.

---

## Agent M2 deferrals (#329)

### B1. A module-private credential map would be invisible to the agent state guard

`src/lib/agent/state-guard.ts` derives its credential key names from `SECRET_FIELD_MAPS` in
`src/lib/storage/connection-secrets.ts`, so a field promoted to `secret` in one of the three
classification maps is covered without an edit. The aggregate itself is a hand-maintained array: each
individual map fails `bun run typecheck` when a field goes unclassified, but nothing makes a fourth MAP
appear in the array.

The direction that loses coverage silently is ADDING a map, not removing one — the storage layer would
seal the new field while the guard happily persisted it. `tests/unit/lib/agent/state-guard.test.ts`
closes that by reflection: it walks the storage module's exports, recognises a classification map
structurally, and fails when one is not registered. Verified to fire by temporarily exporting a fourth.

What remains is narrower. The check sees **exported** maps only. A map kept module-private and wired
straight into `walkConnection` is invisible to it. All three existing maps are exported for consumers,
so this is a convention rather than an enforced rule.

**Done when:** a new classification map cannot be added without the guard learning about it — most
directly by having `walkConnection` iterate a registry instead of three derived key lists. That
registry has to carry each map's nesting location (root, `ssl`, `sshTunnel`), so it is a change to a
security-critical encrypt/decrypt path with its own test obligations.

### B2. The Anthropic provider kind is ratified and installed, but not offered

`@ai-sdk/anthropic@4.0.37` is an owner-ratified dependency and is installed, and the agent's
`provider-registry.ts` could serve it in a few lines.

What blocks it is not the agent. The registry is keyed on `LLMProviderType`, the settings surface's own
union (`src/lib/llm/types.ts`), and that union is what `LLM_PROVIDER` resolves against. Adding
`anthropic` there makes `LLM_PROVIDER=anthropic` selectable for the whole application, and
`src/lib/llm/factory.ts` would then have to build a chat provider for it or throw — breaking every
surface that resolves a provider through the factory, for exactly the users who configured it.

Serving it properly means a `src/lib/llm/providers/anthropic.ts` that speaks Anthropic's Messages
streaming protocol. `createSSEParser`'s `extractContent` understands the OpenAI delta shape only, and
Anthropic requires `max_tokens` on every request while `LLMStreamOptions.maxTokens` is optional, which
needs a default nobody has chosen. That is a chat-surface feature with its own conventions, tests and
release note. The ratified package cannot be used for it either: `src/lib/llm` is reachable from the
published package while the AI SDK is deliberately not
(`tests/unit/agent-dependency-boundary.test.ts`).

Until then `@ai-sdk/anthropic` stays in `knip.json`'s `ignoreDependencies` as an installed-but-unwired
ratified package, which that test's allowed-ignore set names explicitly.

**Done when:** the chat surface gains an Anthropic provider under its own conventions and the registry
gains the matching adapter in the same change. The `Record<LLMProviderType, AgentProviderAdapter>` will
not compile until it does.

### B3. A scope allowlist on a target dimension denies every tool that cannot declare it

`withinAllowlist` (`src/lib/db/operations/policy.ts`) refuses a call that does not DECLARE a dimension
the scope constrains. That is the right direction — an undeclared target cannot be screened, so it fails
closed. The consequence is that a scope carrying an allowlist silently narrows the tool set to the
tools that happen to declare that dimension:

- **A `schema` allowlist** admits only a NARROWED `inspect_schema` call, one that was given a selector.
  The selector-less full inventory declares nothing and is denied (verified:
  `createTargetScope("c", { schemas: ["public"] })` plus `inspectSchemaTool(ctx, {})` answers
  `TARGET_OUT_OF_SCOPE`). That is the natural first call, and the one the run-start snapshot makes:
  `captureContextSnapshot` asks for each catalog kind with no selector, so under a schema allowlist
  every run's context capture is refused and the run proceeds with no snapshot at all. It fails closed
  and the model is told to inspect the schema itself, but a run scoped to one schema never gets an
  inventory. Narrowing the capture to the scope's own single-entry allowlist is the obvious repair.
  Every `run_read_query` and `inspect_plan` call is denied outright, because a raw statement cannot
  declare which schema it will touch without parsing it.
- **A `catalog` allowlist** denies EVERY call in the layer: no tool declares that dimension at all.

Nothing builds such a scope yet. `runtime.ts` calls `createTargetScope(connectionId)` with no
dimensions, so no allowlist is ever constrained in production. This is a property of the layer rather
than a live defect, and the tool layer records it at the `inspect_schema` target declaration.

It matters because the failure looks like a policy bug rather than a scoping choice: the model gets
`TARGET_OUT_OF_SCOPE` with advice to ask for an in-scope target, and for a raw read there is no way to
comply.

Two honest resolutions when a caller first needs scoping, and the choice is a product one: give
`run_read_query` an optional declared-schema argument and require it when the scope constrains that
dimension, or let the run service refuse to start a run whose scope constrains a dimension its tool set
cannot declare — louder, and needs no per-tool argument.

**Done when:** a scope with a schema or catalog allowlist produces a coherent outcome for every tool the
mode offers, with a test per dimension.

### B4. `mapDatabaseError` discards the text that distinguishes a timeout cancel from an operator cancel

`mapDatabaseError` matches `canceling statement` before its timeout branch and returns
`new QueryCancelledError("Query was cancelled", provider, query)`, replacing the engine's own wording.
PostgreSQL says `canceling statement due to statement timeout` for a `statement_timeout` and
`canceling statement due to user request` for `pg_cancel_backend`. After this mapping **no** consumer
can tell them apart. The discriminator is gone, not merely unexamined.

That is why the agent tool layer classifies a cancel as a repairable statement failure: the reachable
case on the agent path is the timeout this layer itself installs via `SET LOCAL statement_timeout`, and
narrowing the read is the repair that helps. The cost is stated there — an operator cancel arriving
mid-statement is also offered a repair, so a run cancellation has to be enforced by the run loop's own
persisted state between tool calls rather than by expecting the driver's cancel to propagate.

The fix is in shared code and has editor-visible consequences, which is why it is not in #329.
Reordering the timeout check ahead of the cancellation check, or preserving the original message on
`QueryCancelledError`, changes what the query panel shows when a statement is cancelled versus times
out. The reordering is the substantive one and needs the editor's cancel/timeout UX re-checked
(`postgres.ts` sets `queryTimeout` on the pool as well, so both paths exist).

**The same mapper has a wider imprecision, and the agent's repairable-versus-environment split inherits
it.** Classification is **substring** matching on the engine's message, so an identifier can decide the
class. Verified against the live mapper:

- `no such table: pooled_items` matches `pool` → `PoolExhaustedError`. A plainly repairable missing
  relation is treated as an environment fault and ends the run.
- `Connection terminated unexpectedly` matches nothing → base `DatabaseError`. A dead socket is offered
  to a model as a statement it could rewrite (bounded at three attempts).
- `relation "user_passwords" does not exist` matches `password` → `AuthenticationError`. Harmless on the
  agent path today only because a query-phase `AuthenticationError` is repairable there, which is a
  coincidence rather than a design.

Neither direction is a boundary failure: nothing runs that policy did not allow, and the statement and
repair budgets still bound the waste. What is wrong is the diagnosis, and it is wrong before any
consumer sees the error, so no consumer can correct it.

**Done when:** a statement timeout and a user cancellation are distinguishable by type or by preserved
message, with the editor's consumers updated and the agent's cancel classification revisited against
the new signal — and when classification no longer depends on a substring a table or column name can
satisfy. Driver error codes (PostgreSQL `SQLSTATE`, SQLite `errcode`) are the signal that does not
collide, and each provider already has access to its own.

### B5. The agent run ledger assumes one writer per run, and cannot enforce it

`run-store.ts` and `run-service.ts` are append-only over the durable world's stream primitives, which
offer no compare-and-append: a writer cannot say "append this only if the stream is still at index N".
Every operation is read-then-append. Two consequences follow that a single-writer run never meets:

- **Two concurrent opens on one caller-supplied run id write two headers.** The fold refuses a ledger
  with a second header (`MALFORMED_LEDGER`), permanently, for every later read. The race does not
  resolve in one side's favour — it bricks the run. Nothing minted internally can collide (UUIDv4, 122
  random bits), so reaching this needs a caller that supplies its own id, which is what the
  workflow-run-id path does.
- **Two loops driving one running run would both perform the same step.** `runStep` reads the ledger,
  sees the step neither settled nor invoked, and appends its invocation. Two readers of the same state
  both pass that check. The write-ahead ordering makes a step at-most-once *per loop*, not *per run*.
  The milestone's "no tool execution performed twice" criterion is about a restart, where the dead
  process is gone by construction, and that case is genuinely covered.

Not defended at the storage layer because every cross-process defence available is worse than the
constraint: a lock file is single-instance only (which the Postgres backend exists to escape), and a
lease in the ledger is a distributed-lock design with its own expiry semantics. Single ownership of a
running workflow belongs to the layer above.

How strong the guarantee is depends on the backend. On the zero-config local world it holds by
construction: the queue awaits each delivery before attempting the next, so retries are sequential. On
the opt-in Postgres backend a visibility-timeout redelivery can overlap a handler that is still alive,
which is where the second bullet would bite.

**Severity is a function of B9.** Nothing delivers an agent drive today: `mintAgentDriveToken` has no
production caller, there is no `"use workflow"` function and no queue producer, so a run is driven
exactly once, in the process that opened it. A second drive is not reachable through the product on
either backend. Producing one takes a caller that mints its own drive credential from `JWT_SECRET`,
which is how the fence below was exercised against a live run rather than only in a test. Closing B9 is
what makes this live — and in that order, because a producer without the fence is a redelivery that runs
the user's statement a second time.

The process-local half of the fence exists (2026-08). `claimDrive`/`releaseDrive` refuse a second
concurrent drive of one run inside a single process, and `AgentRunStore.append` refuses an append once
the run's stream has been closed (`RUN_ALREADY_CLOSED`), turning the silent-loss mode into a loud
refusal. The cross-process half is open: two replicas would still both pass the read-then-append check.

**Done when:** the ledger can append conditionally on the stream's tail index, or the single-ownership
guarantee the runtime provides is asserted by a test rather than assumed by prose. The process-local
claim is asserted in `tests/unit/lib/agent/run-service.test.ts`, the append-after-close guard in
`tests/unit/lib/agent/run-store.test.ts`.

### B6. Every agent cost ceiling is per-drive, so N resumes cost up to N times one drive's budget

The three things that bound what a run may spend — `ExecutionBudgetTracker` (`maxStatementsPerRun`,
`maxTotalRunMs`), `AgentRepairLedger` and `AgentRunDeadline` — are all constructed by the process that
drives a run and live only in its memory. `runInvestigation` takes them as injected resources, so a run
resumed after a process death is handed a fresh set and starts each ceiling again.

A run that dies and resumes ten times may perform ten times `maxStatementsPerRun` statements and spend
ten times its workflow's `runDeadlineMs`, even though each drive stayed honestly inside its bounds.

Nothing claims otherwise: `AGENT_WORKFLOW_BUDGETS`'s docblock states the per-drive scope explicitly. It
matters for two later tasks — a budget meter must not present a per-drive figure as a run total, and any
retry policy that resumes automatically would multiply the ceiling without a user asking.

The data needed is already persisted. `AgentRunRecord` carries `createdAtMs`, and the ledger holds
every settled step, so a drive could fold the run's own history into the ceilings it starts with: a
deadline measured from `createdAtMs`, a statement count folded from `tool-completed` entries.

**Done when:** the ceilings a drive enforces are derived from the run's ledger rather than from the
drive's own construction, with a test that resumes a run twice and shows the second drive inheriting
the first's spend.

### B9. Nothing enqueues an agent drive, so an interrupted run is resumable but never resumed

Opened by #329 T9. `POST /api/agent/drive` exists, authenticates a server-minted single-purpose
credential and resumes the run it names, and `src/lib/agent/runtime.ts` re-derives everything that run
needs from its own ledger. So a resume WORKS. What does not exist is anything that asks for one.

A run is driven exactly once, in the process that opened it. If that process dies mid-run the run stays
`running` in the ledger with nobody to pick it up: `mintAgentDriveToken` has no production caller, and
the workflow runtime is used only as the ledger's durable substrate — no `"use workflow"` function, no
queue producer, so the backend's own re-enqueue-on-start never sees an agent run.

Distinct from a drive that *fails*, which is recorded: a throw anywhere in `driveAgentRun` ends the run
as `failed` with a classified reason, so an unconfigured model no longer leaves a run at `queued`
forever. This entry is the case where the process is GONE — nothing threw, nothing can record.

**Adopting the SDK's Next.js integration was refused deliberately.** Its documented setup asks for
`/.well-known/workflow/*` to be excluded from the proxy matcher, and warns that a proxy on that path
detaches the request body, so the callback could not authenticate its way through the middleware
either. Worse than the requested edit: **this matcher already excludes it**, because the dot rule
(`.*\..*`) skips every path containing a dot and `.well-known` contains one (AU2 records the same
consequence). That route would sit outside `src/proxy.ts` entirely, unauthenticated, the moment it
existed — with no matcher edit to review. The pinned decision for this case says driving in-process
without a loopback hop is strictly better, which is what the start route does. The drive path is one
the matcher DOES route, guarded by a credential rather than a path rule, and `tests/api/proxy.test.ts`
pins both halves.

Two things have to land together whenever a producer arrives, and neither is safe alone:

- **A sweep that finds runs left `running`** and drives each one, at boot or on a timer, with the same
  credential the callback already verifies.
- **Single-flight per run.** Today no two drives of one run can overlap, because there is only ever one.
  A producer removes that accident, and the ledger is read-then-append with no fencing (B5), so two
  drives would both read "not invoked" for the same step and both perform it.

**Done when:** a run whose process died is picked up without a person asking, no step is performed
twice while that happens, and B6's per-drive ceilings are accounted for across the resumes it causes.

### B10. No token budget is enforced, so the rail's budget meter reports none

Opened by #329 T10b. The task's bar names tokens among the figures the meter should report, and the
meter deliberately does not show one: nothing here bounds an agent run's token spend.
`AGENT_WORKFLOW_BUDGETS` is statement-shaped, `maxModelTurns` bounds model TURNS rather than their
size, and the run loop never reads the SDK's `usage` at all — `investigation.ts` consumes `fullStream`
parts and the assistant messages, nothing else.

A token figure would be a number the server does not enforce, shown next to four that it does, which
is the one thing that bar forbids. So the meter states the turn ceiling instead and says nothing about
tokens.

Closing it is two changes that land together: reading `usage` off each turn and recording it in the
ledger (a new field on `run-finished`, or a new event kind — T2's union is closed, so this is a
deliberate widening), and a ceiling in `execution-policy.ts` that the loop refuses on.

**Done when:** a run that exceeds a configured token budget ends with a reason a user can read, and the
meter shows the same number the loop enforced.

### B11. The rail can stop a run but cannot pause or resume one

Opened by #329 T10b. `AgentRunService` has no pause: a run holds a provider and a budget while it is
running, and nothing in this milestone can put those down and pick them up again.

Resuming exists (`POST /api/agent/drive`, `driveAgentRun`) but is authenticated by a server-minted
single-purpose credential a browser never holds. It is the seam a machine producer will use (B9), not a
user control. The rail therefore offers stop and nothing else, and does not render a disabled pause or
resume, because a disabled control reads as a capability that is merely unavailable right now.

Resume becomes offerable the moment B9's producer exists — a user-visible "pick this run up" is then
just asking for a delivery. Pause is larger: it needs a run state between running and terminal that
releases the run's resources without ending it, and a resumed run would have to re-acquire them, which
is the path B6 already complicates.

**Done when:** either control exists in the service with its own ledger record, and the rail renders it
because the service can honour it.

### B12. A failed statement records no duration, so the meter counts completed reads only

Opened by #329 T10b. `ExecutionBudgetTracker` charges `maxTotalRunMs` from every execution's elapsed
time, on the failure path as well as the success one (`execution.ts` calls `endExecution` with
`statements: 1` in both).

The durable ledger is narrower. `tool-completed` carries the artifact's `summary.elapsedMs`, while
`tool-refused` carries an `AgentToolRefusal`, whose database-error variant records a fingerprint and
the engine's message and no duration at all. The rail folds its meter from the ledger, so its
database-time figure is the sum over completed reads and sits BELOW what the tracker enforced whenever
a statement failed.

The rail says so beside the meter rather than quietly rounding: under-reporting the time a bound has
already spent is the direction that misleads.

**Done when:** a run whose statement failed shows the same database time the tracker charged it, with a
test that fails on the current under-count. Recording the elapsed time of a failed execution means
putting it in the refusal, which is a T2 contract change.

### B13. Three spends the agent run ledger never records, so the budget meter reads low

Opened by #329 T10b, found by the task's own fresh-context review.

**The schema capture is the largest.** `captureContextSnapshot` calls `inspectSchemaTool` directly, once
per catalog kind — three reads on PostgreSQL, two on SQLite — and each goes through
`executeAuditedOperation` and is charged `statements: 1` plus its elapsed time against exactly the
budget the meter displays. What it does NOT go through is `runStep`, the only writer of
`tool-completed`. The capture records one summary `context-captured` entry instead.

So on an agent-mode drive with no reusable snapshot, a ledger-folded meter reads "0 / 20 statements"
when two or three are already spent, before the model's first turn. A capture that FAILS records no
entry at all while still having paid for its reads (see B54).

Two smaller mismatches belong with it:

- An acquisition failure is accounted as one executed statement although nothing ran. `tools.ts`
  acquires the provider inside the allowed callback deliberately, so a denied call never opens a pool,
  and the failure propagates out of the tool leaving the step with a `tool-invoked` entry and no
  settlement. The fold cannot see it.
- A `tool-completed` entry carries the provider's own `summary.elapsedMs`, while `maxTotalRunMs` is
  charged the span the execution layer measured around the whole call, which also covers acquisition.

All three run in the same direction — the meter under-reports — which is why the rail states its figures
as a floor, and why the caveat it shows is a list of what is known rather than a proof the list is
complete.

Either half closes the same way: give the capture path a durable per-read record, or read the meter
from the tracker's own accounting. The second is not a drop-in, because the tracker is process-local
and `releaseExecutionRun` drops a run's accounting when it ends, so a finished run would report zero.

**Done when:** a run that has captured its schema shows the catalog reads it paid for, with a test that
fails on the current under-count.

### B15. A run's stored results are gone once the run ends, so a report's citations can outlive its rows

Surfaced by #329 T11 rather than introduced by it. `ExecutionArtifactStore` holds results in process
memory and `releaseExecutionRun` drops everything a run produced at `finish` or `cancel` — the M1
decision that agent results never rest on disk.

The consequence: a report is composed as the run's LAST step and is usually read AFTER the run has
ended, so "Show result" on its citations answers `410` with `reason: "released"` rather than rows. Same
for any run driven by a different replica.

The route says which of the two happened instead of reporting a missing artifact, and the rail offers
"Show result" only while the run is live, with the report section stating the bound in words. So the
show affordance on report CITATIONS is mostly dormant; what is reachable in practice is showing a
result from a live run's timeline.

Closing it properly means deciding where agent results may rest — encryption, retention and tenancy are
exactly the questions #328 declined to answer. A product decision, not an implementation gap.

**Done when:** a finished run's cited rows are readable for a stated retention window, or the surface
states the window it has instead of offering a control that usually cannot be honoured.

### B16. The opt-in multi-replica backend cannot load in the container image or the npx payload

Found while landing #329 T1 and carried forward, because the commit that found it could not validate a
fix (nothing built a world yet).

`@workflow/core`'s runtime resolves any world other than its two built-ins with `require(targetWorld)`
off a `createRequire` rooted at `process.cwd()`. The specifier is a variable, so Next's
output-file-tracing cannot see it: `@workflow/world-postgres` is **absent from `.next/standalone`**, and
therefore from the container image and the standalone tarball the npx launcher downloads.

`WORKFLOW_TARGET_WORLD=@workflow/world-postgres` passes this repository's own allowlist
(`src/lib/agent/config.ts`) and then fails inside the runtime at the moment a world is built. So the
documented path to running agents on more than one replica does not work in the artifacts most
operators deploy. A `bun dev` checkout and a plain `node_modules` install are unaffected, which is why
it can go unnoticed.

Scoped by measurement: a `DOCKER_BUILD=true bun run build` on 2026-08-12 leaves
`.next/standalone/node_modules/@workflow` holding `world-local` and `utils`, with the rest of the
runtime (`workflow`, `@workflow/core`, `ai`, `@ai-sdk/*`) compiled INTO the server chunks — which is why
the default `local` backend does work in the image. Only the world reached through a variable specifier
is missing.

The remedy pattern already exists here: the explicit copies in `Dockerfile` and
`scripts/build-standalone-payload.sh`, both of which already hand-copy modules tracing cannot see.

**Done when:** the Postgres world is present in both payloads with a test asserting it
(`tests/unit/packaging-payload-prune.test.ts` is the nearest existing home), and `docs/AGENT.md`'s
deployment section loses the caveat that points here.

### B20. A Gemini deployment behind a proxy is not configurable, on either surface

`resolveApiUrl` (`src/lib/llm/utils/config.ts`) returns `LLM_API_URL` for every provider kind, so the
resolved configuration carries it — and both Gemini consumers ignore it. The chat provider constructs
`new GoogleGenerativeAI(apiKey)`, which has no base-URL option at all. The agent's adapter deliberately
passes no `baseURL`, because leaving it undefined is what keeps the SDK's own environment fallback
unreachable.

So an operator who must reach Gemini through an egress proxy or a regional endpoint can set the
variable, see no error, and be routed to Google directly.

Pre-existing behaviour the agent inherited; noticed in #329 T4. Fixing it means threading
`config.apiUrl` into both consumers and deciding what an explicitly-set `LLM_API_URL` means for a
provider whose SDK has no base-URL seam — a settings-surface change.

**Done when:** a proxied Gemini endpoint is reachable from the configuration the user already entered,
or the settings surface says plainly that the variable does not apply to that kind.

### B21. The published package carries the agent-provenance branch as dormant markup

`BottomPanel` is shared by both shells, and #329 T11 added its agent-provenance branch: an optional
`agentArtifact` prop, the provenance badge and its test ids. `bun run build:lib` therefore emits that
markup inside `dist/workspace.mjs`.

It is inert and the package boundary is intact. The prop is optional, the embedded shell never passes
it, no entry point exports `BottomPanel` (asserted through a transitive `export … from` closure in
`tests/unit/agent-package-boundary.test.ts`), and the package gains no agent module, no agent type and
none of the runtime packages.

What remains is dead bytes in a consumer's bundle, and a small honesty cost: a reader grepping the
published output finds strings suggesting an agent capability the embedded shell cannot reach.

**Done when:** the provenance branch lives in a standalone-only component and `BottomPanel` takes it as
children — or Phase 4's surface unification decides the embedded shell gets an agent surface after all,
at which point this stops being dormant rather than being removed.

### B23. Seed eligibility is decided against a browser snapshot, not the live descriptor

`resolveAgentRunConnectionId` (`src/hooks/use-connection-payload.ts`) decides whether an editable seed
copy may start a run by comparing it against the descriptors in `useConnectionManager`'s `servedSeeds` —
the response of the last `GET /api/connections/managed`. The run-start route then resolves `seed:<id>`
again, through `getSeedConnectionById`, whose config loader re-reads the seed file after its own TTL
(`SEED_CACHE_TTL_MS`, 60s by default).

So there is a window. An operator who repoints a seed at a different database while a session is open
leaves that session comparing against the OLD descriptor: the local copy still matches it, the rail
still offers Start, and the run resolves the NEW target. The same silent wrong-database outcome the
comparison exists to prevent, reached from the server side.

Two things bound it. It needs a server-side seed change mid-session, not a user action. And the same
staleness already applies to an admin-managed connection, which has always sent `seed:<id>` for every
query while the sidebar showed whatever the last fetch returned. So this is a property of resolving by
id at all — but the copy path is the one whose documentation promises a match, so it is the one that
overstates.

**Done when:** the run-start route validates the descriptor the browser believed it was starting
against — a fingerprint sent with the request and compared server-side, refusing with a distinct reason
when it has moved. Until then `docs/AGENT.md` says the comparison is against the last fetch.

### B26. A profile can test for an email shape and not for a digit run

`table-profile.ts` tests one value shape inside the database, `LIKE '%_@_%._%'`, and derives
`suspected_pii` from the ratio of matches. A run of digits — a phone number, a national id, a card
number — is the other shape worth suspecting, and `LIKE` cannot express it: `_` means "any character",
so a length test would match almost any text. PostgreSQL spells it `~ '[0-9]{9}'`; SQLite spells it
`GLOB '*[0-9][0-9][0-9]…*'`.

An earlier draft shipped `LIKE '%_________%'` as a "nine digits" test, which would have produced a
`suspected_pii` finding for essentially every text column. It was removed before it landed rather than
approximated.

**Done when:** the shape tests are per-dialect predicates rather than one shared `LIKE`, with the digit
run among them and each verified against that engine's grammar.

### B28. A profile that times out reports nothing rather than falling back to catalog statistics

#330 T3 asks for "a timeout fallback to catalog stats". A profile that exceeds `statementTimeoutMs`
currently surfaces as a repairable database error, so the model may narrow the profile or move on. But
nothing reads `pg_stats` / `sqlite_stat1` for the approximate answer the engine already holds.

The gap is honest rather than silent — the run is told the statement failed. The fallback is a second
composition path per dialect whose numbers are planner estimates, so a profile built from it would have
to say which figures were measured and which were estimated.

**Done when:** that distinction is carried in `AgentTableProfile` and the fallback is composed per
dialect.

### B29. An attacker-supplied identifier the model quotes back reaches a transcript unfenced

Found by the injection fixtures in `tests/evals/injection.test.ts` (#330 T4), which is what those
fixtures are for.

Every block the SERVER writes is fenced and its markers neutralised, and the suite asserts that by
counting: a transcript holds exactly as many closing markers as the server opened.

The path this does not cover is the model's own message. An attacker who can name a table can put the
closing marker in that name. The model reads it correctly fenced, then copies the identifier into its
own tool ARGUMENTS — which are the model's words, not the server's. The transcript sent back on the next
turn therefore carries an unfenced marker.

**This is an open injection path, not a bounded residual.** The first version of this entry said
otherwise, claiming "the text following the marker is the model's own JSON, not attacker content". That
is false: an attacker who can name a table controls the WHOLE identifier, so they control the marker
and arbitrary text after it, and JSON quoting does not make that suffix the model's.

What is true is narrower, and it is what makes this hard to reach rather than harmless: **the server
never hands the model the raw marker.** Every server-authored path neutralises it first, so a model
reading a hostile inventory sees the defanged spelling. For the raw marker to appear in an assistant
message the model has to reconstruct it. The fixtures assert both halves — that the fenced inventory
contains no raw marker, and that the transport does not prevent one if the model produces it anyway
(the scripted model supplies it directly, which is stronger than what the fenced paths give a real one).

The server's own blocks do stay balanced, which bounds what can be re-attributed to the SERVER, and
nothing more.

Fixing it means rewriting the messages the provider itself returned (`response.messages`), which is the
transcript that provider will accept back — the same reason `investigation.ts` filters those messages to
the assistant turn rather than rebuilding them.

**Done when:** a tool call's arguments are neutralised on the way into the transcript without
desynchronising the `tool_call_id` pairing the endpoint validates.

### B31. The Postgres durable backend is reported available without being contacted

Raised in review of #331 T5.

`resolveAgentAvailability` derives the agent's visibility from two conditions, and the second — the
durable ledger has a usable home — is only ever *tested* for the `local` backend, where testing it is a
`mkdir` and a file write.

With `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` the ledger is a database, and the check ends at
"the variable names a sanctioned backend". `WORKFLOW_POSTGRES_URL` is neither read nor reached, and
unset it does not even refuse: the world falls back to a development default
(`postgres://world:world@localhost:5432/world`).

So a multi-replica deployment pointed at an unreachable, misspelled or unset Postgres URL gets a rail
that renders, a Start that is offered, and a failure when a world is built.

It is a **documented carve-out rather than a silent one.** `AgentAvailability`'s green branch carries
`ledgerVerified`, `GET /api/agent/config` returns it, and this backend answers `false`. So no reader of
the code, the API or `AGENT.md` is told a database was reached when only a variable was read. What is
not claimed is that the rail is therefore correct — it still appears.

The fix has its own cost: the only real readiness check is a connection attempt, and this route answers
on every page load of a logged-in user, from outside the `ai` rate-limit bucket.

**Done when:** the Postgres backend's readiness is established by a bounded, cached connection attempt
under its own reason code — `LEDGER_UNREACHABLE`, distinct from `LEDGER_UNAVAILABLE`, which names a
directory — with a timeout short enough for a page load and a memo long enough that a page-load probe
cannot become a connection per request. B16 gates any of this being testable in a shipped artifact.

### B32. The route-documentation guard covers the agent family and nothing else

`docs/API_DOCS.md` documents `/api/agent/*` request-by-request, and
`tests/unit/agent-documentation.test.ts` derives the six agent paths from `src/app/api/agent/**` and
fails if one is missing from that file (#331 T6).

The guard is scoped to that one family, so **every other route family is still documented by hand with
nothing comparing it against the route tree.** A new `/api/db/*` or `/api/storage/*` route can ship
undocumented exactly as `/api/agent/*` did, and no gate notices.

The narrow scope was a choice. Widening the derivation to `src/app/api/**` turns up routes the reference
documents in prose rather than under a literal path heading — the schema family reaches two paths
through one shared handler, and several `/api/db/*` routes are described in a single table row — so the
assertion would fail on documentation that is not actually missing. Making it total means first deciding
what "documented" means for a route the reference covers collectively.

Worth noting what the guard does NOT check even for the agent: that a documented request or response
shape still matches the handler. Only presence is asserted.

**Done when:** the guard derives every family from `src/app/api/**` under one stated rule for what
counts as documented, and the reference is reshaped where that rule does not hold.

### B33. An agent run is observable only from its own ledger — nothing exports it

A run's whole record is the append-only ledger: lifecycle, tool invocations, refusals with their deny
class, budget counters and the goal verdict. The rail and the eval harness both read runs out of it, and
an operator debugging a run reads it directly.

What does not exist is a way to get that record into the observability stack a self-hosting team
already runs. No OpenTelemetry spans, no OTLP export, no metrics.

Designed in full and deliberately not built (#332, closed 2026-08-14): endpoint-gated activation on
`OTEL_EXPORTER_OTLP_ENDPOINT`, a dynamic import so no exporter module loads while it is unset,
metadata-only span attributes by default with a documented verbose delta, and no second global SDK
registration in the embedded build.

The reason it is deferred is dependency surface and timing rather than doubt about the design: it adds
`@ai-sdk/otel` plus an exporter to the published package, and the agent's event model is still gaining
kinds, so instrumenting it now means maintaining a span catalogue against a moving target. Nothing
depends on it and no user is waiting on it.

**Done when:** the event model has settled and somebody is running Studio beside a stack that wants
agent runs in it. #332 holds the full scope.

### B34. A hydrated agent result cannot be exported, because Export serializes the tab's own rows

A run's rows now reach the results grid, the explain view and the charts view, each with a provenance
badge naming the run. But `exportResults` in `src/components/Studio.tsx` serializes
`currentTab.result`, so offering the Export menu over a hydrated view would write the tab's rows to a
file while the user is looking at the run's.

The menu is therefore hidden while an artifact is shown, which is correct and is not the same thing as
being able to export what is on screen.

The pivot and dashboard views are unhydrated for a related reason and are not part of this: both are
configured against the columns of the result they were opened on.

**Done when:** the export path can take an explicitly hydrated result, with the file still attributable
to the run. An exported file that came from an agent run and is indistinguishable from one the user ran
is the thing to avoid.

### B35. A resumed run can evict its own still-cited results: the artifact cap is per drive

`AGENT_MAX_ARTIFACTS` (`src/lib/agent/runtime.ts`) is `45 × 4 = 180`: the largest per-workflow statement
ceiling times the four concurrent runs one agent process is sized for. Its justification used to be that
"a run cannot produce more artifacts than it is allowed statements", which is true of a DRIVE and not of
a run — every ceiling is per drive (B6), while a resumed run keeps its `runId` and its artifacts are
keyed by it. A run driven three times may hold up to three times its statement ceiling, and one
long-lived run can pass 180 with no concurrency at all.

`ExecutionArtifactStore.put` spends the cap run-fairly: a store at the cap evicts the oldest artifact of
the run that is STORING, which stops a busy run making "Show result" fail on a quieter one. Applied to a
run past the cap, the same rule means the run evicts its own earliest evidence — the results its first
drive read, which its report may still cite.

Nothing about the ledger is wrong afterwards: a claim and its citation are durable, and the artifact
route already answers "the rows are not here" for the run-ended and TTL-expired cases (B15). This is a
third way to reach that answer, and the only one that can happen while the run is still live and the
rail is still offering the control.

Not closed with an artifact-only bound, deliberately. A ceiling that holds ACROSS drives is exactly what
B6 describes as missing, and the run record already carries what it needs, so a second answer invented
for artifacts alone would have to be unpicked when B6 lands. Raising the number cannot close it either:
a run resumed often enough passes any constant.

**Done when:** a drive's artifact allowance is derived from the run's own history rather than from a
per-drive constant — most likely as part of B6 — with a test that drives one run twice past the cap and
shows the first drive's cited results still readable, or the surface stating that they are not.

### B38. A run is offered on an engine that cannot run it, and refuses only after a model turn

Driven live on 2026-08-15. Starting an agent run on the bundled `libredb` sample opens the run, drafts a
statement, invokes `run_read_query` and ends `failed` with `engine-unsupported`: "The agent cannot run on
this database engine: it offers no read-only execution profile."

The sentence is exact and the failure is honest. It is also entirely predictable before the run:
`queryReadOnly` is a property of the provider, known from the connection's type, and nothing about the
objective can change it.

Since #414 the run also captures a schema on that engine successfully. So it now spends a model turn AND
is grounded in a schema it will never be allowed to read a row of, which makes the offered-then-withdrawn
shape worse rather than better.

This repository follows the opposite rule everywhere else: `HydrationControls` renders no control the
host cannot serve, the stop button is absent rather than disabled, and `canHandOver` withholds the
auto-execute checkbox from a host with no runner.

**The telling half landed with the rail redesign (2026-08-21).** The safety strip reads *Cannot execute
on `<engine>`* before anything is started, an amber pre-start card (`agent-engine-unsupported-notice`)
carries the same facts with a **Switch to Plan** button, and both are pinned by tests.

**What did not land was refused rather than deferred: Start must stay live.** The `operations` workflow
sends no statement at all and runs on every engine (#411), so a disabled Start would withhold a workflow
over a claim that is not true of it. So a user who starts an analytical run there is now warned first,
and still spends a model turn and a run id to reach `engine-unsupported`.

**Done when:** a run whose workflow needs a read-only statement path is refused on such an engine at the
point the run is opened — from the connection's own type, with the sentence the rail already shows, and
without a run id or a drive turn being spent — while a workflow that sends no statement still opens
there. The workflow has to be known first, so under **Automatic** the refusal lands after the classify
call and before the open. Tests: the refusal itself, an operations run still opening on the same
connection, and no drive reaching the model.

### B39. An analysis run cannot say "this database cannot answer that" without fabricating a read

Driven live on 2026-08-15. Asked "what is our customer churn rate this quarter?" against an employees
database, the run answered honestly: the schema holds employee records, not customer records. To do so
it executed

```sql
SELECT 'The database contains employee records (employee, department, dept_emp, salary, title) ...'
```

— a string literal, run purely to produce the `sql.query.read` artifact that `present_answer` requires
and `agent-data-analysis.1` scores on. The run took 36 steps to get there.

The user-visible outcome is correct and readable, which is why this is recorded rather than fixed in
haste. The mechanism is not: the workflow's only route to `answered` is a reading of the data, so a
question the data cannot answer has no honest route at all, and the model games the rule instead of
reporting the finding.

This is the #356 family — a bar only one kind of correct answer can clear — and the remedy is the same
shape: a second arm. A run that establishes from the schema snapshot that the question is not about this
database has answered it, and should be able to say so without inventing a query.

**Done when:** a data-analysis run can conclude "not answerable here" and be scored `answered` for it,
with the rule stated in `WORKFLOW_TOOL_RULES` and an eval asserting no fabricated statement is sent.

### B48. The composed grounding path still loses a plan run to an environment failure

`captureFromProvider` (`src/lib/agent/context-snapshot.ts`) converts a `DatabaseError` or an
`ExecutionProfileError` raised before the reading leaves into an unavailable capture. So a plan run on
one of the nine provider-path engines survives an unreachable host, a wrong password or a
half-configured `agentUser`, and answers ungrounded with the capture's own diagnosis.

The composed path — PostgreSQL and SQLite — does not. The same failure propagates out of
`readCatalogForGrounding`, through `captureContextSnapshot` and `establishPlanningContext`, and ends the
run `internal`, or `engine-unsupported` on the profile error (see B47).

The asymmetry was deliberate at #414: those two engines have never reached the new line, and changing
their failure mode is a second decision about a path #414 did not touch. It is still an asymmetry a
reader will trip over.

**Done when:** both grounding paths answer an environment failure the same way.

### B51. The run loop nudges a model three times and records none of it

`runInvestigation` delivers three notices, each one-shot per DRIVE, each with its own boolean, guard set
and delivery mechanism:

| Notice | When | Delivered as |
| --- | --- | --- |
| `AGENT_REPORT_RESERVE_NOTICE` | within the turn or time reserve of a ceiling | a `user` message, riding the turn about to be taken |
| `AGENT_REPORT_REMINDER_NOTICE` | a prose turn after a tool this run holds was called | a `user` message, and the turn is taken again |
| `AGENT_PRESENT_BEFORE_REPORT_NOTICE` | a `compose_report` on an answering workflow with a presentable read and no presentation | a `tool` result, INSTEAD of running the call |

None of the three writes to the ledger. `service.recordEvent` is called for the schema capture, the
drafted statement, the closing prose, the recommendation, the answer and the report — and for nothing the
server said to the model. So a run's timeline shows a model that read, narrated and then reported, with
no entry saying it was told to report. And a `compose_report` the loop withheld leaves no record that a
call was made at all.

**"Once" means once per drive, and the missing entry is why.** All three booleans are `let`s inside
`runInvestigation`, and that function is what RESUMES an already-running run. A resumed drive starts with
every flag false and can deliver a notice the previous drive already delivered. Two of the three have a
partial durable guard by accident: the present-before-report notice reads `answer-composed` off the
ledger, so a run that presented is not told to again — but a run whose `present_answer` was REFUSED
writes no event, and is. Nothing bounds the report reminder or the reserve notice across a resume.

**That is a measurement problem before it is a design one.** `docs/llms/` is built by reading run
ledgers out of `.workflow-data`, and its whole claim is that each figure comes from an observed run.
After #416 and #417 a ledger can no longer answer "did this model do that by itself?" — the exact
question those pages exist to answer, and the question that decides whether a nudge is worth keeping.
`methodology.md` already warns that one run per cell is the weakest part of the method; an
unattributable rescue is weaker still, because re-running does not reveal it either.

**The second half is the shape.** Each notice's GUARDS are the load-bearing part, and the part that keeps
being got wrong. #416 arrived without the tool-set bound (a planning run, which holds no tools, was told
to call `compose_report`) and without the turn bound (a run narrating at the ceiling was turned from
`succeeded` / `model-stopped` into `failed` / `turn-limit`). #417 arrived with a condition that named "a
result this run can present" and read an operation id that `inspect_schema` shares. Both were caught in
review rather than by a gate, and a fourth notice will be written by someone reading the third.

**Done when:** a delivery is an entry on the ledger — one event kind, carrying which notice and what the
run had done when it arrived — read back at the head of a drive so a resumed run is not told twice, and
the three share one declared shape so a new one states its condition, scope and delivery in the same
place. Whether the rail SHOWS the entry is a separate question and probably a no: the notices exist to
be invisible to a user, and the timeline is not the same surface as the ledger.

### B52. The grounding capture's row cap is reached by what the image ships, not by a wide user schema

`composeCatalogRead` records a known limitation with a number: the PostgreSQL projection is one row per
COLUMN against `maxResultRows: 200`, so an unnarrowed call "overflows at roughly 25 tables of eight
columns". That estimate frames the cap as something a large user schema reaches. Three measurements say
otherwise.

**TimescaleDB — two user tables are enough.** Measured 2026-08-20 against
`timescale/timescaledb:latest-pg17` (2.29.2 on PostgreSQL 17.11). `information_schema.columns` outside
`pg_catalog` and `information_schema` answers **478 rows**, of which **473 belong to the extension** and
**5 are the user's**. The read is refused rather than truncated, by design, so the plan run answers
ungrounded with "This run was given no inventory of this database." The identical run against plain
PostgreSQL 18 captured "3 tables, fingerprint ctx_0d63" and named them. Granting the agent role USAGE
and SELECT on the internal schemas does not change the outcome, so this is the row cap and not a
privilege.

**Cloudberry — and it is not an extension.** Measured against `woblerr/cloudberry:2.1.0-incubating`
(PostgreSQL 14.4) with the same two user tables: `CATALOG_READ_REFUSED`, "289 rows > 200 allowed". **282
of those 289 belong to `gp_toolkit`.** The figure is per-role: the same read as `gpadmin` answers **481**
rows. Cloudberry is a PostgreSQL fork rather than a PostgreSQL carrying an extension, so what
generalises is narrower than the first measurement suggested — any PostgreSQL-wire server whose own
catalogs are wide before the user creates anything.

Cloudberry also fails one step earlier, which matters for anyone trying to work around this. Its usual
login is `gpadmin`, a superuser, and the agent's execution profile refuses that role as too broad. So
the row budget is only reached after a least-privilege `agentUser` has been created by hand — and it is
then reached anyway.

**AlloyDB Omni settles which fix is viable.** Measured against `google/alloydbomni:17.9.0` (PostgreSQL
17.9), same two user tables: `CATALOG_READ_REFUSED`, "536 rows > 200 allowed". Only **7 of the 536 are
the user's**. As the agent role sees it: `public` **348**, `google_ml` 144, `ai` 44 — and **341 of the
348 in `public` are the 49 extension views the image installs into `public` itself**.

That is what makes it decisive. On TimescaleDB and Cloudberry the overflow sits in a separate internal
schema, so the candidate fix "exclude the schemas the object browser already treats as internal" would
rescue both. Here it rescues nothing: narrowing to `schema=public` still refuses, at **348 rows against
200**. The only selector that fits is a single table (`schema=public table=orders` projects 4 rows),
which is not a schema capture at all.

**So of the two candidate fixes only one survives: aggregate columns per table so the projection is one
row per OBJECT, symmetric with the SQLite side. The schema-exclusion fix is refuted and should not be
attempted.**

Two controls keep the AlloyDB numbers attributable. Plain PostgreSQL 18.4, in the same pass, projects
**7 rows** and captures its 2 tables. And the `relations` capture kind projects 0 rows as the agent role
and 3 as a superuser on AlloyDB — but the plain PostgreSQL baseline behaves identically, so that is
PostgreSQL's own privilege rule (B44) and not an AlloyDB property.

AlloyDB Omni also fails the earlier step, for Cloudberry's reason: as the image's own `postgres`
superuser both profiles are refused with `PROFILE_PRIVILEGES_TOO_BROAD`. With a hand-made
least-privilege role both acquire and `queryReadOnly` is present, so the boundary works — and the capture
is refused anyway.

The consequence: the agent is unusable out of the box on TimescaleDB, Cloudberry and AlloyDB Omni, and
the same shape will appear on any PostgreSQL-wire server whose image ships wide catalogs or wide
extension views before the user creates anything.

**Done when:** a plan run against a stock TimescaleDB, one against a stock Cloudberry and one against a
stock AlloyDB Omni all report a captured schema naming the user's tables.

### B55. A LibreDB plan run drafts `GET users:*`, a command that answers zero rows rather than failing

Measured 2026-08-22 on the embedded LibreDB sample, plan mode, objective *"list every entry under the
users prefix and read one user by key"*. The run was grounded — `context-captured`, three prefixes
(`articles:*`, `config:*`, `users:*`) — and drafted:

```libredb
GET users:*
```

`dispatchCommand` gives `get` exactly one meaning: `kv.get(parts[1])`, an exact-key lookup with no glob
of any kind. The key `users:*` does not exist, so the command returns **zero rows and no error** — the
same silently-wrong class as the MongoDB `$shipping.region` case, and harder to notice because an empty
result on a key-value store reads as "nothing stored there". The runnable form is `prefix users:`, which
is what `generateTableQuery` already emits for the same row when a person clicks it.

The cause is the one Redis has too: the inventory's rows are named `users:*`, which reads as a glob the
grammar does not have. Redis's half was fixed by declaring `ProviderLabels.statementLanguage`
(`redis.ts`); LibreDB declares none, so the plan contract tells the model only "this engine speaks no
SQL" and leaves the five verbs — `get`, `put`, `delete`, `prefix`, `range` — to be guessed.

Deferred by the owner on 2026-08-22, explicitly: LibreDB's agent and plan-mode behaviour waits until the
other providers are done. Recorded here so the deferral is a decision rather than an omission.

**Done when:** `LibreDbProvider.getLabels()` declares a `statementLanguage` that names the five verbs and
says a key is exact (no glob, no wildcard), with a test pinning it the way `mongodb.ts` and `redis.ts` are
pinned — and a live plan run on the embedded sample drafts `prefix users:` for this objective.

### B56. Plan grounding is held for the process lifetime, so a schema change is invisible until a restart

`holdSnapshotForConnection` keeps one inventory per connection identity in a bounded map with **no
expiry**: newest reading wins, eviction is by use, and nothing re-reads. `heldSnapshotForConnection` is
one of the three places a planning run's grounding comes from, and it is consulted before any capture.

Measured 2026-08-22, twice in one session. MongoDB's schema inference was changed to expand subdocuments
into dotted paths; `POST /api/db/schema/list` returned `shipping.city` immediately, and the schema tree
showed it. Two plan runs afterwards still grouped by `$shipping.region`, and their ledgers carry **no**
`context-captured` event at all — the hold answered, from an inventory read before the change. Restarting
the process fixed it on the first run: `context-captured` appeared and the draft named `$shipping.city`.

The same shape hit Redis: keys seeded into an empty database were invisible to a plan run until a restart,
which is what "NO STATEMENT: the `session:*` key pattern is not present in the inventory" meant — a
correct refusal against a stale inventory.

Two properties make this hard to see rather than merely stale. The hold has no TTL, so on a long-lived
server the window is unbounded; and B54's gap means a run that used the hold records nothing about where
its inventory came from, so the ledger cannot distinguish "held, hours old" from "captured just now".

The design intent is real and documented (`context-snapshot.ts`: a run reasons over the inventory its
claims cite, and a mid-run re-read would leave those claims describing a schema the report no longer
shows). What is not intended is that a NEW run inherits it indefinitely.

**Done when:** a new run's grounding is either re-captured or explicitly recorded as reused with the age
of the reading it reused, so a user who just added a collection is not silently planned against the
database as it was.


### B57. A tuning document is refused whole, which is the wrong granularity for a catalog

`parseOperatorTuning` refuses a document that fails anywhere. The argument for that is real and is
about MERGING — half of one measurement beside half of another is a configuration nobody has run —
but it justifies whole-**entry** replacement, not whole-**document** rejection. A document holding
fifty models loses all fifty to a typo in the thirty-seventh.

That is tolerable while a document is a short overlay an operator wrote. It stops being tolerable if
these are ever published as a catalog: the failure lands on everyone who mounted it, for a fault in
one entry nobody using the other forty-nine cares about.

The rule that actually matters survives per-entry validation intact — an entry is still taken whole
or not at all — so the change is where the refusal is thrown, not what it protects.

**Done when:** a document with one bad entry applies the rest, and the skipped entries are reported
by id through `operatorTuningStatus()` the way `ignoredKeys` already is.

### B59. Per-model instructions have nowhere to go, and the mechanism that held them is gone

Wording is measured, not constant: this repository twice changed a shared sentence, won several
cells and lost others, and had to revert and hand back the wins. That is why per-model notices
existed. They are gone — the document refuses wording, and nothing else can populate the field — so a
sentence that helps one model can only be adopted by changing it for all ten.

The refusal is right for what exists today: a document is unsigned prompt text, and one that could
carry wording would let whoever wrote it decide what Studio says to a model mid-run. It is wrong as a
permanent rule, and the two objections behind it come apart. Drift is solvable — accept a template
over a closed placeholder vocabulary (`{{PLAN_NO_STATEMENT_MARKER}}`), refuse an unknown placeholder,
and a copy cannot drift from the marker the verifier reads. Authorship is a provenance question, and
provenance is a property of the SOURCE rather than of the field.

**Done when:** wording can arrive from a source whose authorship is established, and cannot arrive
from one whose authorship is not — with the trust tier stated as a decision rather than implied by
which loader happened to read the file.

### B62. `schemaVersion` has no migration path, and the first bump breaks every mounted document

`z.literal(TUNING_SCHEMA_VERSION)` on both schemas. An older Studio refusing a newer document is
correct and deliberate. A newer Studio refusing an OLDER one is not: the day this moves to 2, every
document in the field is refused whole and every model in it silently reverts to the defaults.

Deliberately not fixed here. With one version in existence, an accepted range has exactly one member,
and a migration written before anything needs migrating is a guess about a shape nobody has seen. The
tolerant operator schema removes the pressure — Studio can add settings without moving the version —
so this is a decision to take at the first real bump, not before.

**Done when:** the first `schemaVersion` change ships with a rule for reading documents written for
the version before it, and the release notes say what an operator has to do.


### B64. An unfenced plan statement with no terminator still carries prose into the SQL

`unfencedStatement` now makes two cuts: the blank line, then the SQL splitter. The splitter is
what closed the demonstrated case — `SELECT 1;` followed by "This query returns one row." on the
next line came back as one statement with the prose inside it, and `plan-statement-drafted` is
recorded on `kind === "statement"` alone while `verifyPlanningGoal` reads that event as the run
having ANSWERED. So a run was scored answered while its deliverable would not run.

With NO terminator the splitter has nothing to cut on and returns the whole candidate, so the
blank line is the only signal left. A model that writes `SELECT 1` without a semicolon and
explains itself on the next line still gets its prose through, and is still scored answered.

Narrower than the fixed case and not demonstrated on a real run, which is why it is pinned as it
behaves (`tests/unit/lib/agent/plan-statement.test.ts`) rather than guessed at. The wider fix is
not another line rule: it is gating the event on validation, which the reader's own header
already names as the thing it deliberately does not do. That is a change to plan mode's pass
bar — cells that pass today because a statement was drafted would have to be re-measured — so it
belongs to whoever owns the measurement rather than to a defect fix.

**Done when:** either the reader ends an unterminated statement without a blank line, or the
verifier stops treating a drafted statement as an answer on its own — with the cells that moves
re-measured either way.

### B65. `retryUnreadStop` subsumes `retryEmptyTurn`, so one entry's `false` decides nothing

The gate asks whether the run CALLED anything (`!anyToolCalled`) and never what it said, so an
empty completion reaches it as readily as the question it was measured on. A model carrying both
switches therefore spends two extra turns rather than one, and a model carrying only this one has
its `retryEmptyTurn: false` overridden by a switch that argues for something else.

Live on `nemotron3:33b`, whose entry records `retryEmptyTurn: false` and whose empty turns are
asked again anyway. Pinned as it behaves in `tests/isolated/agent-investigation.test.ts` rather
than repaired, because the repair — narrowing the gate to a turn with text in it — changes the
behaviour the five passing query-optimization runs were measured under, and this repository does
not move a measured cell without re-measuring it.

Free either way: `compose_report` is one of the tools `anyToolCalled` counts, so a run reaching
the gate has already earned `no-report`. What is wrong is the record, not the cost — a reader of
the entry cannot tell what the model is actually driven with.

**Done when:** the gate tests the stopping text and the affected cells are re-measured, or the
two switches become one setting whose name covers both stops.

### B66. `nemotron3:33b`'s marginal cell has one per-model lever nobody has swept

Its query-optimization cell reads 5/5, 5/5, 4/5, 4/5 across four sweeps with nothing in the entry
changing between them, and both losses share one signature: the report-composing turn ran 172.7 s
and 244.6 s against a 90-second turn, where every passing run composed in 24 to 93.

`turnTimeoutMs` is the per-model setting for exactly that shape — `qwen3.5:9b` carries 150000 and
the worked example in `docs/llms/model-tuning.example.json` argues the same bimodal case. Unlike
`reasoning_effort`, it changes no wording and reaches no other model, so it cannot re-open the
five surfaces this model already locks.

The entry records a different lever (`reasoning_effort: "none"`) as deliberately not taken, for a
sound reason — its other five cells were measured WITH reasoning. That reason does not apply here,
and this one has simply not been tried.

**Done when:** a sweep at a raised per-model turn limit either closes the cell or is recorded in
the entry as having failed to.

---

### B67. There is no run history across conversations

A run now belongs to a conversation, the rail names the one it continues and offers to leave it,
and the steps of THAT conversation are listed from the run's own header. What is left of B36's
"larger shape" is everything outside it: a user cannot see the conversations they had yesterday,
cannot return to one, and cannot open an earlier step's report.

The reason it is a separate entry rather than more of the same work is a measurement. Listing the
current conversation needs no new infrastructure — each run's header carries its own prefix, so the
chain is self-describing and `GET /api/agent/runs/{runId}` already serves any step. Listing ALL of a
user's runs has nothing behind it at all: `run-store.ts` has no enumeration, there is no list route,
and the two questions that follow immediately — pagination and retention — have not been asked. It
is a persistence surface, not a rail change.

**Done when:** a user can see their earlier conversations and open one, with the store's
enumeration, the route and the retention rule each decided rather than inherited.

### B69. A reload ends a conversation, and nothing says it will

A reload clears the browser's `runId`, so the next question starts a new thread. The rail is honest
about the RESULT — with no thread there is no strip, which is the correct signal — but it is silent
about the transition: a user mid-conversation who reloads is not told that what they were doing has
ended, and their next question is answered as a fresh one.

Accepted deliberately when the conversation model landed, because the alternative opens two
questions this work did not want to answer: where a thread id lives client-side (`localStorage`, the
same write-through cache every other preference uses), and what "resume this conversation?" should
do when the runs behind it may have been evicted. Worth doing; not worth bundling.

**Done when:** either a reload resumes the conversation it interrupted, or the rail says the
conversation ended before the next question is asked.

### B70. A run writes no summary for the step after it

The conversation a run is handed carries the previous step's report as its CLAIMS — what the model
actually asserted, verbatim — and truncates at a claim boundary when the budget runs out. The
alternative considered and declined was a `carryForward` sentence: one extra field on
`compose_report`, written by the run for its successor, so the chain would be N short summaries
rather than N full reports, bounded by construction rather than by truncation.

It is the AI SDK's own idiom for this (`toModelOutput`, in its subagent guidance: the user sees the
whole execution, the next context sees a summary), and it is cheap — no extra turn, one field on a
call that already happens.

Declined for a reason specific to this product rather than to the technique. Claims are EVIDENCE:
they are what the model asserted and what its citations are tied to. A summary is the model's own
lossy compression of that, and a compression can drop exactly the qualification that mattered — in a
product whose demo script says half of what makes an agent worth putting near a production database
is what it declines to do, a lossy model-written bridge between runs is the wrong default. Recorded
rather than forgotten because the trade may look different once thread budgets have been measured
against a small-context model.

**Done when:** either a measurement shows truncation costing more than compression would, and a
carried summary lands with the fallback stated; or this entry is deleted with the measurement that
settled it.

### B71. The workflow runtime's own durable agent is not used, and the reason is a deployment one

`@ai-sdk/workflow`'s `WorkflowAgent` offers durable, resumable agents with automatic state
persistence across restarts — which is what `run-store.ts`, `run-service.ts` and the resume rule in
`investigation.ts` implement by hand. Anybody reading those three modules will eventually ask why.

Because it requires the workflow runtime's programming model: `'use workflow'`, `'use step'`,
`getWritable()`. This product's positioning is that it deploys next to the data — Docker, Helm,
Kubernetes, air-gapped — so binding the agent's durability to a hosting runtime would cut the
deployment story the rest of the product is built on. The hand-written ledger is also what makes the
run auditable in this repository's own terms: append-only, one file per run, foldable by anything.

Recorded so the question is answered once rather than reopened. It is not a defect and there is
nothing to do; if the packaging ever separates the durability primitives from the hosting runtime,
this is the entry to revisit.

**Done when:** the packaging separates them, or this entry is deleted as permanently declined.

### B72. Three verifiers still judge a plan-only report by the emptiness census

B45 exempted plans from the emptiness clause for `query-optimization` only, and deliberately stopped
there. `agent-investigation.1`, `agent-database-assessment.1` and `agent-data-analysis.1` still call
`restsOnlyOnEmptyResults` with no exemption set, so a report of theirs whose only citation is a plan
artifact is scored `empty-evidence` for the same wrong reason: a plan arrives in one column, the
driver reports no row count for it, and that zero measures nothing.

Reachable rather than theoretical - `inspect_plan` is in `AGENT_MODE_TOOLS`, so every one of those
workflows is offered it. Left out of B45 because closing it means changing what three released
verifier ids mean, which by this file's own versioning rule (`goal-verifier.ts`: a rule that changes
its mind takes a new id) forces `agent-investigation.1` to `.2` plus the two ids composing on it,
and updates across the eval suites and the verifier table. The narrow fix was measured; this one has
not been.

Pinned today rather than left ambiguous: a test asserts that an investigation citing the same
plan-only ledger is still judged by the unexempted baseline, so the boundary is stated and a change
to it is deliberate.

**Done when:** a plan-only report is judged the same way whichever workflow composed it, with the id
bumps that implies.

### B73. The row-budget pair travels as prose and is recovered by regex

B54 records a refused capture's `reasonCode` and, for a row-budget refusal, the two numbers. The
reason code is structural. The numbers are not: they are formatted into a `QueryError` MESSAGE by the
provider (`postgres.ts`, `sqlite.ts` - both refuse rather than truncate) and read back out by
`rowBudgetIn` in `context-snapshot.ts`. `statementAdvice` (`tools.ts`) reads the same sentence with
the same anchor, so there are two prose consumers, not one.

Blast radius of doing it properly, measured while closing B54: a structured field on `QueryError`
(`src/lib/db/errors.ts`, the error type every provider throws, ~40 call sites), the two provider
formatters, a carrier on the `database-error` variant of `AgentToolRefusal` (pinned closed by the T2
tests) and a pass-through in `runAuditedAgentCall`. Five files across a shared error type, which is
why B54 kept the regex.

The failure mode is silence, which is what makes it worth an entry: a reword drops the numbers and
nothing goes wrong loudly. That is currently held off by a test that drives a REAL over-budget
`queryReadOnly` through `bun:sqlite` and asserts the parse against the error the provider itself
threw, plus a source-template assertion for PostgreSQL, which cannot be driven without a server. Both
go red on a reword.

**Done when:** the two numbers reach the ledger as fields rather than as a parsed sentence, and both
prose consumers are converted in the same pass.

### B74. A `COLLATE` unique constraint is reported as covering a foreign key it cannot serve

Found while closing B25. `UNIQUE (a COLLATE NOCASE)` creates a real index, and the capture now lists
it, but that index does not serve a BINARY equality lookup on `a` - so `fk_unindexed` will stay silent
about a key the engine would still scan for. The direction matters: this is a false negative, the
same class B25 fixed in the opposite direction.

Deliberately not modelled: `parseSqliteIndexDdl` drops `COLLATE` on user-written indexes too, so
honouring it for constraint-created ones only would make the inventory disagree with itself about the
same fact. Consistency was chosen over a distinction that would have to be introduced in both readers
at once.

**Done when:** collation is part of what an index column carries, in both readers, and coverage
accounts for it.

### B75. A connection repointed mid-flight is still carried by a resumed drive

A conversation's database is checked at the point a follow-up OPENS. A run
already open is not re-checked. The thread text is derived and frozen at open, so a **resumed** drive
can read the new database while carrying both a conversation and its own captured schema established
against the old one — the same defect the open-time check closes, displaced from the open to the resume.

The material is now in place to close it: each run records `connectionIdentity`, so `investigation.ts`
could compare it against `connectionIdentity(context.connection)` at drive start. It was left out of
the open-time check deliberately, because what a run should DO when its connection moves under it is a design question
with three plausible answers (drop the thread and continue, refuse the resume, or continue and say
so), and none of them has been measured.

**Done when:** a resume onto a repointed connection does one stated thing, and the run's own record
says which.

### B76. `declined: "unavailable"` collapses six causes into one sentence

The thread header records `declined: "unavailable"` for six different situations: the run does not
exist, is not this session's, is on another connection, was established against another database (new
the newest), has not ended, or names an id the ledger refuses. The rail therefore has one sentence for
all six, and adding the database check made that sentence wrong for one of them — the earlier step COULD be reached,
the database moved — which is why it now reads "could not be carried into this question" rather than
"could not be reached". True of all six, and specific about none.

The repoint case is the one with a genuinely different remedy: the others are transient or
session-scoped, while this one persists until the operator changes the connection back or accepts the
new conversation. A distinct code (`declined: "repointed"`) plus its own sentence is a type, route and
rail change — the rail already has the sentence shape for the client-side `connectionDropped` case.

**Done when:** a cause whose remedy differs from the others carries its own code, or the collapse is
recorded as deliberate with the reason.
