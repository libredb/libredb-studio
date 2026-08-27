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

- [SQL statement reading](#sql-statement-reading) — S2–S6 · 4
- [Drivers and connections](#drivers-and-connections) — D1–D51, U17 · 14
- [Value interpolation](#value-interpolation) — V1
- [Row editing](#row-editing) — R1
- [Studio UI and query execution](#studio-ui-and-query-execution) — X2–X14, U2–U26 · 9
- [Authentication and security headers](#authentication-and-security-headers) — AU4
- [Tests](#tests) — T4
- [Dependencies](#dependencies) — P1–P5 · 5
- [Documentation](#documentation) — DOC3, DOC4 · 2
- [Release pipeline](#release-pipeline) — REL1–REL3 · 3
- [Chart configuration surface](#chart-configuration-surface) — N1, N3 · 2
- [Security Phase 1 deferrals](#security-phase-1-deferrals) — H1–H8 · 3
- [Security Phase 2 deferrals](#security-phase-2-deferrals) — C3–C10 · 8
- [Security Phase 3 deferrals](#security-phase-3-deferrals) — K4
- [Agent M1 deferrals (#328)](#agent-m1-deferrals-328) — A1–A5 · 4
- [Agent M2 deferrals (#329)](#agent-m2-deferrals-329) — B2–B79 · 30

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

### D34. A pinned SSH host key has no way to be set, so the protection resets on restart

Giving the tunnel a `hostVerifier` created two sources for the expected fingerprint: a durable
`sshTunnel.hostKeyFingerprint` on the connection, which wins, and otherwise a first-contact memory
keyed by the bastion's `host:port`. Only the second one is reachable today, and it lives in the server
process. Measured 2026-08-26 when the verifier landed: **nothing writes `hostKeyFingerprint`.** There is no
input for it (`ConnectionModal` renders from `use-connection-form`, which does not carry the field),
seed configs do not model `sshTunnel` at all, and there is no server-to-client write-back for a
fingerprint the tunnel just accepted.

So the shipped behaviour is: a key that changes WITHIN a server's lifetime is refused, naming both
fingerprints; a restart re-enters first contact and accepts whatever answers. That is strictly better
than the previous behaviour, which verified nothing ever, and it is not the durable pin the code is
already able to honour.

There is also a latent drop waiting for whoever adds the writer: `use-connection-form.ts` rebuilds
`SSHTunnelConfig` from form state on every save and does not spread `hostKeyFingerprint` through, so
editing and re-saving a connection would silently clear its pin. Inert today — the field has no writer
— and a one-line spread when it gets one.

**Done when:** an accepted fingerprint can be persisted onto the connection it belongs to, surviving a
restart and a round trip through the connection dialog, and the accept/reject decision for a key that
legitimately changed has an answer in the product rather than only in a doc.

Filed as D32 when the verifier landed in #509 - an id this file has since reused for an unrelated
entry, which is why citing it is no longer safe - and lost the same day: #510 branched before that
merge and its copy of this file overwrote both entries, which is also why they are renumbered.
Restored 2026-08-27 from `35294140`.

### D37. Five HTTP providers read the SSL mode and drop the rest of the TLS panel

Found 2026-08-27 in the #511 review (issue #424, Phase 5). Not libSQL's - libSQL is the
fifth of five instances of one gap, and the fix already exists in the codebase.

`ssl.caCert`, `ssl.clientCert`, `ssl.clientKey` and `ssl.rejectUnauthorized` reach the
driver on every provider that uses one. On the providers that speak HTTP through global
`fetch` they reach nothing: ClickHouse, Druid, Elasticsearch/OpenSearch, Trino and libSQL
each read `ssl.mode` only, to decide `http:` against `https:`, and Node's `fetch` cannot carry
a custom CA or relax verification without an undici `Agent` as `dispatcher` - and undici
must not become a dependency. So a self-hosted server with a private CA is reachable only
by trusting it at the OS level, and the form's own TLS fields silently do nothing.

**Couchbase already solved this and is the pattern**: `providers/document/couchbase/http-transport.ts`
sends plaintext through `fetch` and TLS through `node:https`, a built-in that takes
`ca`/`cert`/`key`/`rejectUnauthorized` directly (D26). Its `CouchbaseTlsMaterial` mapping,
including `rejectUnauthorized: ssl.rejectUnauthorized ?? ssl.mode !== "require"`, is the
behaviour the other five need.

Not a defect in what any of them measures - it is a field the form offers and the transport
discards, which is the kind of silence a security setting must not have.

**Done when:** the TLS material mapping is shared rather than copied, the five `fetch`
transports route TLS through it, and one test per transport pins that a supplied CA and a
`verify-*` mode reach the request options - plus one that a `require` mode does not verify.

---

### D39. A slow-query source nobody could read is still a row, and on the other path it is silence

Found 2026-08-27 by the audit that closed the curated health projection's cap-as-count defect. #512
removed MySQL's fabricated "Performance schema not available" row; three providers still ship the
same shape, in the same field:

- `src/lib/db/providers/sql/postgres.ts:1239` - a database without `pg_stat_statements` answers
  `[{ query: "pg_stat_statements extension not enabled", calls: 0, avgTime: "N/A" }]`.
- `src/lib/db/providers/document/mongodb.ts:791` - a database whose profiler is off answers
  `[{ query: "Profiler not enabled. Run db.setProfilingLevel(1) to enable." }]`, and the outer catch
  at `:830` answers `[{ query: "Error fetching health info" }]` for a read that failed entirely.
- `src/lib/db/providers/sql/sqlite.ts:721-731` - EVERY SQLite database answers two synthetic rows,
  `Integrity: OK|FAILED` and `Journal Mode: <mode>`, about statements that were never executed.

A sentence wearing a row's clothes is the fabrication the absence rule (#477) forbids, and here it is
worse than a zero: a caller counting the list gets 1, 1 and 2 rather than 0. Nothing counts it in the
app any more - the agent's curated reading stopped, and `HealthInfo.slowQueries` now has no
production consumer at all - but `POST /api/db/health` serialises the whole `HealthInfo`
(`docs/API_DOCS.md`), so anyone embedding `@libredb/studio` and reading that body inherits all three.

**The fix is a type change with a 15-type-id blast radius, which is why it is here and not in #512's
PR.** `HealthInfo.slowQueries` is a required `SlowQuery[]` (`src/lib/db/types.ts`) with no field a
reason could travel in, so "nobody could look" has no representation. Making it optional the way
`activeConnections` already is touches every provider, every provider doc and every provider test
file, and falsifies `src/lib/db/compatibility.ts:267`, `docs/providers/postgres.md:164`,
`tests/integration/db/postgres-provider.test.ts:1325`, `tests/integration/db/sqlite-provider.test.ts`
and `tests/helpers/sqlite-node-harness.ts:104`, all of which pin the current sentences.

**The other path swallows instead of fabricating, and that is not better.** On the `slow-queries`
reading the agent actually uses, `src/lib/db/providers/keyvalue/redis.ts:635-637` and
`src/lib/db/providers/document/mongodb.ts:1047-1049` `return []` from their catch where MySQL now
rejects. So a denied grant reaches the model as an empty reading, and the run prompt tells it
`"A reading that comes back EMPTY is an answer, not a failure - no blocked session, no slow query,
no unused index is what a healthy server looks like"` (`src/lib/agent/investigation.ts:1485`). It
also costs the operator the reason: `getMonitoringData` records `errors.slowQueries` from a REJECTION
(`src/lib/db/base-provider.ts:147`), and a resolved `[]` records nothing, so the panel says "no slow
queries" where the truth is that the profiler is off.

**Done when:** a slow-query source that could not be read is absent-with-a-reason on both paths - no
provider answers a sentence as a row, and no provider answers `[]` for a read that failed - and the
count of type-ids the type change touched is stated in the PR rather than discovered during it.

### D44. `databaseSizeBytes` is fabricated as 0 wherever the size is unknown, in 11 of 17 type-ids

Found 2026-08-27 by the sweep that closed the overview connection count's fabricated zero (D40, PR
round 17). `DatabaseOverview.activeConnections` and `DatabaseOverview.databaseSizeBytes` are optional
for the SAME stated reason (`src/lib/db/types.ts`, the D17 docblock): absence and zero are different
facts. The round closed the first field on three providers. The second is unclosed almost everywhere.

**Two providers get it right, and one of them wrote the argument down.**
`src/lib/db/providers/sql/cassandra/introspect.ts:582` omits the key with the comment "a zero is a
measurement, and the Storage tab read `?? 0` and rendered '0 B' with a 0.0% breakdown from it", and
MongoDB's `getOverview()` catch now omits it too.

**The rest fabricate.** Measured by reading every `databaseSizeBytes` assignment under
`src/lib/db/providers/`:
- Self-contradicting within one object, and the clearest cases, because the sibling string field
  already says the figure is unavailable: `sql/trino/introspect.ts:621` pairs a literal `0` with
  `databaseSize: TRINO_UNAVAILABLE_TEXT`, and `sql/search/index.ts:849` pairs `sizeBytes ?? 0` with
  `databaseSize: SEARCH_UNKNOWN_TEXT` for both `elasticsearch` and `opensearch`.
- Swallowed into an initialiser the way D40's connection counts were: `sql/mssql.ts:1111`,
  `sql/oracle.ts:1178`, `sql/sqlite.ts:808`.
- Coerced by a helper that returns 0 for an absent row: `sql/druid/introspect.ts:578` and
  `sql/clickhouse/index.ts:833` through their local `asNumber`.
- Coerced inline: `sql/postgres.ts:1397` and `sql/mysql.ts:1156` (`parseInt(... || "0")`),
  `sql/libsql/introspect.ts:399` and `document/couchbase/index.ts:606` (`?? 0`),
  `keyvalue/redis.ts:603`, and `embedded/libredb.ts:709`, whose `fileSizeBytes()` returns 0 when the
  `statSync` throws.

**The consumer makes it visible.** `src/components/monitoring/tabs/StorageTab.tsx` keys its entire
breakdown off `overview?.databaseSizeBytes !== undefined`: present, and the card renders percentages
against the total; absent, and it draws its own "No storage size information available." So a fabricated
0 does not hide a number, it replaces an honest refusal with a breakdown over a zero-byte database.

**Three of the fourteen are closed (#517, round 18)** - the ones that contradicted themselves inside a
single object. `trino/introspect.ts` no longer writes the key beside
`databaseSize: TRINO_UNAVAILABLE_TEXT`, and `search/index.ts` spreads it conditionally instead of
`?? 0` beside `SEARCH_UNKNOWN_TEXT`, which is two type-ids (`elasticsearch` and `opensearch`) from one
file. That round also measured a mechanism this entry had missed: Couchbase does not merely coerce, it
wraps the read in `degradeTo(..., {})`, so a REFUSED bucket read reaches `basicStats?.diskUsed ?? 0` and
publishes a measured-looking zero - see D51, which is the same shape on the field beside this one.

**The counts moved for a second reason.** DuckDB arrived as a seventeenth type-id in #516 and gets this
right without being asked: `duckdb/introspect.ts` spreads the key conditionally and spells the string
`"N/A"` when the database is in-memory. So it is a fourth correct provider rather than a fifteenth
fabricating one, and it independently reached the same encoding this entry prescribes.

**Done when:** an unknown size is absent rather than 0 on the remaining eleven type-ids, a real zero
still reads as zero, each provider's doc records it, and each provider's test pins both arms - the same
shape D40 used, applied to the field beside it. Remaining: `sql/postgres.ts`, `sql/mysql.ts`,
`sql/sqlite.ts`, `sql/mssql.ts`, `sql/oracle.ts`, `sql/libsql/introspect.ts`, `sql/druid/introspect.ts`,
`sql/clickhouse/index.ts`, `document/couchbase/index.ts`, `keyvalue/redis.ts` and `embedded/libredb.ts`.
MongoDB is NOT on that list: its catch and its success path both spread conditionally already.

Doing it per family, one PR each, is the cheap ordering, and #517 is the pattern to copy - including the
second test file the triad brief does not name: Trino's own `tests/unit/db/trino/introspect.test.ts`
asserted the 0, no gate but a test run found it, and the triad invariant names only the integration
file.
### D45. On SQL Server 2019 and earlier the connection count is under-reported, not refused

Found 2026-08-27 while making the overview connection count absent instead of 0 (D40, PR round 17).
That fix is right for what it covers and covers less than the field's failure modes.

`OVERVIEW_CONNECTIONS_SQL` (`src/lib/db/providers/sql/mssql.ts`) reads two objects in one statement:

```sql
SELECT COUNT(*) AS active_connections,
       (SELECT CAST(value_in_use AS INT) FROM sys.configurations WHERE name = 'user connections') AS max_connections
FROM sys.dm_exec_sessions
WHERE is_user_process = 1
```

Microsoft Learn, fetched 2026-08-27:
- `sys.dm_exec_sessions`, Permissions: "Everyone can see their own session information. In SQL Server
  2019 (15.x) and earlier versions, requires `VIEW SERVER STATE` to see all sessions on the server. In
  SQL Server 2022 (16.x) and later versions, requires `VIEW SERVER PERFORMANCE STATE` permission on the
  server." So the DMV is **row-filtered, never refused**.
- `sys.configurations`, Permissions: "Requires membership in the **public** role", and separately
  "Permissions for SQL Server 2022 and later: Requires VIEW SERVER PERFORMANCE STATE permission on the
  server."

So the statement's behaviour splits on the server version, and only one half is an absence:
- **2022 and later** - `sys.configurations` throws for an ungranted login, the whole statement fails,
  and the count is now correctly absent. This is the case the round's fixture reproduces.
- **2019 and earlier** - `sys.configurations` needs only `public` and the DMV filters rows instead of
  refusing, so the statement SUCCEEDS and returns the caller's own sessions, about 1. A busy server
  publishes "1 connection" as a measurement. Nothing in the provider can tell that from a real 1.

Azure SQL Database is a third shape: the DMV needs `VIEW DATABASE STATE` to see all connections to the
current database, and that permission cannot be granted in `master`.

**Done when:** the provider can distinguish a filtered read from a complete one - the cheapest signal is
`HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE')` alongside the count, with the version taken from
`SERVERPROPERTY('ProductMajorVersion')` to pick the permission name - and an incomplete count is absent
rather than published. Measured on a real instance with a login that has neither grant, because the
whole entry rests on a permission boundary no fixture can prove.

### D49. Per-table maintenance drops the schema, so every table outside the default one refuses

Found 2026-08-27 in the BROWSER while registering `duckdb` (issue #424). Not DuckDB's defect - the
provider is the half that behaves - and no gate could have caught it: the six local gates, 100%
line coverage and a four-lens adversarial review all passed over it, because the two halves are
correct in isolation and only the running product puts them together.

`TablesTab.tsx:390` calls `handleMaintenance(type, table.tableName)` - the BARE table name - from a
row whose very next line (`:350`) renders `table.schemaName` beside it. Every provider's
`qualifyMaintenanceTarget` then supplies a default schema for an unqualified target:
`postgres.ts:1285` returns `"public." + escapeIdentifier(target)`, and
`duckdb/index.ts:712` returns `"main"."<target>"`. So the statement names a table that is not there.

Measured on DuckDB v1.5.5, clicking **Analyze Table** on the `analytics.events` row:

```
Catalog Error: Table with name events does not exist! Did you mean "analytics.events"?
LINE 1: ANALYZE "main"."events"
```

`POST /api/db/maintenance` answers 400 and the panel prints the engine's message, so it is visible
rather than silent - but the button cannot succeed on any table outside the default schema, on any
engine. It went unnoticed because the fixtures the other engines are exercised with keep their
tables in the default schema; DuckDB is simply the first whose fixture carries a second one.

This is #U9 one layer up. #U9 was an operation DECLARED in the wrong placement (Oracle offered
`optimize` per table, and the target it sent was rejected); this is the right placement sending an
under-qualified target.

Deliberately not fixed in the provider PR that found it. The one-line repair - passing
`` `${table.schemaName}.${table.tableName}` `` - changes the target string reaching all TWELVE
providers that implement `runMaintenance` (postgres, mysql, mssql, oracle, sqlite, libsql, duckdb,
clickhouse, cassandra, druid, trino, search), and each has its own qualification and its own
statement grammar: SQLite has no user schemas, MySQL's `OPTIMIZE TABLE` takes `db.table`, and the
HTTP engines build their own paths. That is a twelve-engine live verification, not a provider
change.

**Done when:** the row passes the qualified name, every one of the twelve providers has been
measured against a table outside its default schema (or recorded as having no such concept), and a
component test pins the target the row sends so it cannot silently revert to the bare name.

### D51. Four providers degrade a refused monitoring read to no rows, then read the absent row as 0

Found 2026-08-27 in the #517 review, which asked whether the search provider really held the last
fabricated `activeConnections` zero. It held the last *unconditional literal* one. It did not hold the
last zero: four providers reach the same encoding by a longer route, and the route is what hides it.

Each one swallows an unavailable monitoring surface into an empty result, and then a helper maps the
absent row to zero. Measured, all four:
- `sql/trino/introspect.ts` - `readOptionalRows` returns `[]` for every category in
  `UNAVAILABLE_CATEGORIES`, `readOptionalRow` turns that into `null`, and
  `nonNegative(readNumber(active?.activeQueries))` returns 0. A refused `jmx` surface publishes "0
  active connections".
- `sql/druid/introspect.ts` - `readRows` catches `isMonitoringUnavailable()` and returns `[]`, and
  `asNumber(undefined)` is 0. The SQL's own docblock says the empty answer is expected when nothing is
  running, which is true and is exactly why the refusal is invisible: the two produce the same rows.
- `sql/clickhouse/index.ts` - `monitoringRows` catches `isMonitoringUnavailable()`, and `asNumber` maps
  absence to 0 for `activeConnections`, `maxConnections`, `databaseSizeBytes`, `tableCount`,
  `indexCount` and the uptime. A single refused read therefore publishes a fully-zeroed overview that
  reads as measured. `startTime` is the one field that already declines (`identity === null ?
  undefined`), so the correct shape is present in the same object.
- `document/couchbase/index.ts` - `degradeTo(..., {})` around the pools and bucket reads, then
  `lastSample(samples, "curr_connections") ?? 0` and `basicStats?.diskUsed ?? 0`.

**Why this is one entry and not four.** The mechanism is identical and so is the fix's shape: the
degrade step already knows the difference between "answered with no rows" and "declined", and it throws
that distinction away before the mapper can act on it. Whatever carries it - a sentinel, a tuple, or
the `errors` channel `getMonitoringData()` already has - is one decision applied four times.
`sql/druid/introspect.ts`'s `startTime` and `clickhouse`'s show a provider can already tell them apart
where someone thought to.

Not measured, and deliberately not claimed: `keyvalue/redis.ts` and `sql/postgres.ts` write
`parseInt(x || "0")` for the same field, but there the read either answers or throws, so a missing
FIELD inside a successful response is a different question and needs its own measurement.

**Done when:** a refused monitoring read is distinguishable from an empty one in all four providers, the
optional fields are absent rather than 0 on the refusal, each provider's doc and test move with it, and
`maxConnections` keeps its 0 - for that field the type says 0 and absence are one fact.

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

### X5. `Studio.tsx` re-renders its whole tree on every keystroke

14 `useState`, no `useMemo`/`useCallback`, no memoized children, React Compiler off. #422's
code-splitting is not this fix and does not help it. It touches every prop in the shell, which is why
it was not mixed into a correctness PR.

`framer-motion` is also still in the first load: `Studio.tsx`, `ConnectionModal`, `SchemaExplorer`,
`ConnectionItem` and `TableItem` all import it statically and all mount on arrival.

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

### U26. The fleet total sums display strings, so a terabyte counts as one byte

Found 2026-08-27 in the #517 review. `totalDBSize` in `src/components/admin/tabs/OverviewTab.tsx`
builds the admin dashboard's total by RE-PARSING each connection's formatted size:

```ts
const s = item.databaseSize.toLowerCase();
const num = parseFloat(s);
if (isNaN(num)) continue;
if (s.includes("gb")) totalBytes += num * 1024 * 1024 * 1024;
else if (s.includes("mb")) totalBytes += num * 1024 * 1024;
else if (s.includes("kb")) totalBytes += num * 1024;
else totalBytes += num;
```

`tb` is not a branch, so a `"1 TB"` database falls to `else` and contributes **1 byte** to the fleet
total - and #517 added `PB` and `EB` to the shared formatter's ladder, so two more spellings now reach
this parser and land in the same arm. The `else` arm is right for a bare `"512"` and cannot tell it from
a truncated unit, which is the whole problem with parsing a string that was built for a human.

The `"N/A"` handling is correct by accident and worth keeping: `parseFloat("n/a")` is `NaN`, so a
refusal is skipped rather than counted as zero.

**The real defect is that there is no numeric channel to sum.** `FleetHealthItem`
(`src/app/api/admin/fleet-health/route.ts`) carries `databaseSize?: string` and nothing else, because
`HealthInfo.databaseSize` is a required string. So the fix is not a `tb` branch - it is carrying the
bytes the providers already have, which is also what makes an honest absence expressible here.

**Done when:** `FleetHealthItem` carries an optional byte count beside the string, the route projects it
from the provider (absent when the provider published none), the total sums those numbers and shows how
many connections it could not include rather than silently undercounting, and a test pins a TB-scale
connection plus one with no byte figure at all.

---

## Authentication and security headers

### AU4. A sibling subdomain can time an authenticated endpoint, and the fix has nowhere to land

Left open by the cross-origin header work in #512, which answered both headers it was filed for:
`Cross-Origin-Opener-Policy: same-origin` is delivered from `securityHeaders()` and classified
document-only in `next.config.ts`, and `Cross-Origin-Resource-Policy` is refused with the reason
recorded beside the header rule. This entry is what the refusal gives up.

`auth-token` is `SameSite=Lax` (`src/lib/auth.ts`), which withholds it from a cross-*site* no-cors
subresource request but sends it to a same-*site*, cross-*origin* one. So a page on any host under
the deployment's own registrable domain - an XSS on a sibling, a dangling subdomain - can load a
Studio URL as an `<img>`, a `<script>` or a no-cors `fetch` and read the load-versus-error and
coarse-timing signal against an authenticated response. `nosniff` stops execution, the Origin check
stops state change, `X-Frame-Options` and `frame-ancestors` stop framing; none of them stops the
oracle. Recorded in `docs/SECURITY.md` under Known limits.

`Cross-Origin-Resource-Policy: same-origin` is the control, and #512 refused it for a structural
reason rather than a doubt about the value: CORP acts only on subresources, `src/proxy.ts`'s matcher
skips subresources, and the one path that does reach them - `next.config.ts`'s `headers()` - is baked
at BUILD time. The correct value is the one header in the set that depends on deployment topology
rather than on the application: `same-origin` blocks a second origin's document from reading this
origin's subresources, cross-origin `importScripts` included, and `NEXT_PUBLIC_MONACO_VS_PATH`
documents a topology where a host page loads Monaco from a Studio deployment. So a value an operator
must be able to change cannot be delivered where it would act. Closing this starts with the delivery
architecture, not with the header.

**Done when:** a runtime-configurable header reaches `/monaco/vs/*` and `public/*` - which means
admitting the header-only paths to `src/proxy.ts`'s matcher, returning before any auth decision -
or the exposure is accepted in writing with the sibling-subdomain trust assumption stated.

## Tests

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

### DOC4. 62 line citations in the provider docs are stale, and every checkable one is

Found 2026-08-27 while re-anchoring `docs/providers/mssql.md` and `docs/providers/trino.md` to method
names (PR round 17). The round established the policy - cite code by NAME, not by line - and pinned it
with `tests/unit/provider-docs-monitoring-citations.test.ts`, whose scope statement says outright which
files are not measured yet. This entry is that remainder.

**Measured across `docs/providers/*.md`.** 291 `` `file.ts:N` `` citations before the round, 271 after.
Of those, 69 were machine-checkable - a `` `method()` `` name paired with a line link, so the cited line
can be compared with the real declaration - and **68 of the 69 were stale**, the single exception being
Trino's `getCapabilities()`. After the round's 18 fixes, 62 checkable citations remain and **all 62 are
stale**, spread over 12 docs. The other 209 point at expressions, comments, table rows and SQL fragments
rather than a named declaration, so no heuristic can judge them and they were not checked by hand; given
62 of 62, an inference is available but no figure is claimed for them.

**Why they rot invisibly.** Two mechanisms, both measured:
- **Stale at birth.** The eight seam rows in both search docs entered in one commit (`25712e68`, #429)
  as 751/811/831/844/860/873/884/898 while the declarations in that same commit sat at
  808/868/888/901/917/930/941/955 - a uniform +57. Being wrong by a constant is what hid it: the rows
  stayed in ascending order and read as a consistent, plausible list. Today the offset is +65.
- **A correction does not hold.** `docs/providers/redis.md` cited `base-provider.ts:102` (#89, true then),
  was corrected to `:99` (#122, true then), and has rotted a second time since.

**Done when:** each remaining doc cites declarations by name and is added to `NAMED_CITATIONS` in the
guard, which is what makes the change stick - the guard bans the FORM, so a correct line number fails it
too. Cheapest per doc, in descending count: `oracle.md` 16, `mongodb.md` 14, then the nine others. Both
of those two were rewritten in round 17 and are the natural first pair; the round left them out because
they were another lane's live files at the time, not because they are correct.

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

---

## Security Phase 2 deferrals

Each was decided during Phase 2, not overlooked. Lettered `C` (supply **C**hain) because the SQL
section already owns `S1`–`S8`.

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

---

## Agent M2 deferrals (#329)

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

### B79. The re-pointed decline cannot be reached from the UI in the default storage mode

Measured 2026-08-27, driving the built app in Chrome. `declined: "repointed"` fires when a follow-up
names a predecessor whose `connectionIdentity` differs from the connection's current one, and the
server is the one that compares - so the connection has to be one the SERVER holds. In the default
`STORAGE_PROVIDER=local` deployment the only server-held connections are the seeds, and the seeds are
not editable: opening a seed in the connection dialog and saving it writes a browser-local copy under
the same id. The rail then refuses the run before any thread check, with the eligibility sentence
"`<name>` cannot be rebuilt on the server: its settings live in this browser."

So the drive that produces the decline is: a seed run, an edit of that seed's target ON THE SERVER
between two questions, and a second question with the rail mounted throughout. That is a server-side
config change, not something a user does in the product. The decline is real - `tests/api/agent/runs.test.ts`
drives it end to end, including that it lasts exactly one question - and the sentence the rail shows
for it is pinned by a component test. What has never been observed is a person reaching it.

Two readings, and they need deciding rather than guessing: either this is a deployment-shaped path
that only `STORAGE_PROVIDER=sqlite|postgres` installations can hit, in which case the rail's sentence
should say so; or a seed edit ought to stay server-held, which is a storage decision and not this
entry's to make.

**Done when:** the decline is observed from the UI in some supported configuration, or the rail's
sentence names the configuration it belongs to.

