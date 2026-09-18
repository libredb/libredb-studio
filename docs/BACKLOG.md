# Backlog — known defects and deferred work

Work that is known, understood, and not scheduled. Every entry was found while doing something
else — a sweep, a review, a live probe — and was verified against the code when it was written.
None of it is a GitHub issue.

**How this file is used**

- The issue tracker holds work that is filed, triaged, or in progress. This file holds the rest:
  unscheduled defects, deliberate deferrals, open questions.
- An entry says what is wrong, where, and what "done" looks like. Enough to pick it up cold.
- **Delete an entry when the work lands.** No strikethrough, no DONE marker. Git history is the record.
- **A limitation documented where it bites does not need an entry here.** An entry is a claim that
  something should CHANGE. A limitation is a claim about how the product behaves, and its home is the
  place a reader meets it: the docblock beside the code, the provider doc, `docs/AGENT.md`'s "Known
  limitations". Recording one here as well made the two roles indistinguishable and the file
  unshrinkable - a limit could not be settled without deleting the only record of it. So state it
  where it bites, then delete the entry. Ten were settled that way on 2026-08-28.
- Re-verify before acting. Line numbers and behaviour claims age.
- Promote an entry to an issue when it needs discussion, an outside reporter, or a release note.
- The reverse happens too. An issue that is understood, breaks nothing today and is not scheduled
  belongs here. Close it with a pointer to its entry. A defect a user can hit stays an issue.
- **Every ID is unique across the whole file.** Cross-references use the bare ID (`B47`), so no two
  entries may share one.

---

**Sections**

- [SQL statement reading](#sql-statement-reading) — S2–S6 · 4
- [Drivers and connections](#drivers-and-connections) — D1–D97, U17 · 43
- [Value interpolation](#value-interpolation) — V1
- [Row editing](#row-editing) — R1–R2 · 2
- [Studio UI and query execution](#studio-ui-and-query-execution) — X2–X19, U2–U21 · 12
- [Dependencies](#dependencies) — P1–P5 · 5
- [Documentation](#documentation) — DOC3–DOC4 · 2
- [Release pipeline](#release-pipeline) — REL1–REL4 · 4
- [Chart configuration surface](#chart-configuration-surface) — N1 · 1
- [Security Phase 1 deferrals](#security-phase-1-deferrals) — H1–H8 · 2
- [Security Phase 2 deferrals](#security-phase-2-deferrals) — C3–C11 · 7
- [Security Phase 3 deferrals](#security-phase-3-deferrals) — K4
- [Agent M1 deferrals (#328)](#agent-m1-deferrals-328) — A1–A8 · 7
- [Agent M2 deferrals (#329)](#agent-m2-deferrals-329) — B2–B81 · 24

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

### D33. Every parameterised read still prepares, so an engine without PREPARE loses all of them

Measured 2026-08-27 against `datafuselabs/databend:v1.2.925-patch-11` (issue #424, Phase 0).
Databend replies `Prepare is not support in Databend` to mysql2's prepared protocol, and that one
answer takes the object reads, `getActiveSessions()`, `getTableStats()`, `getIndexStats()` and
`getStorageStats()` - the whole object browser and every statistics panel - while the editor keeps
working.

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

### D52. A Couchbase node behind a port mapping is unreachable

`http-transport.ts` resolves the query service from the cluster's own node map, which is right for a
plain deployment and wrong behind a port mapping. A node advertises its INTERNAL ports there, so a
container published on other host ports hands back an address only the container can reach, and the
`DEFAULT_QUERY_PORT = 8093` fallback at `http-transport.ts:484` is unreachable for the same reason.
The connection's own port is read for management (`:367`) and never for the query service.

Measured on Couchbase CE 8.0.2 during the object-model epic's live acceptance: a node published on
38091/38093 failed while the same node on 8091/8093 worked.

Reproduced on a second port pair on 2026-09-13, against Couchbase Server 8.0.2 Community published on
host ports 18091/18093 (#789). `connect()` succeeds over the management port, and the first
query-service call fails with `Couchbase request failed: Unable to connect. Is the computer able to
access the url?`, because the node map advertises 8093 and nothing listens there on the host.
Publishing 8091/8093 makes the same provider work unchanged, which is the control.

Couchbase's own answer to this is `alternateAddresses.external`, which the transport already prefers
when the cluster publishes it (`:473-477`), so an operator-configured cluster is fine today. What is
not handled is the ordinary developer case of a stock image published on other ports, where nothing
configures the external address and the user has already told us the port.

Not fixed inside #789 because it is a transport defect with no object-model component, and that PR
is a major already carrying seventeen providers.

**Done when:** a Couchbase connection reaches the query service on a node published behind a port
mapping, with the precedence between the node map, the external addresses and the user's own port
stated where a reader meets it.

### D54. The data profiler can only profile columns on PostgreSQL-family engines

`src/app/api/db/profile/route.ts:115-116` casts every column with `${safeCol}::text` to take
its `MIN` and `MAX`. That is PostgreSQL's cast syntax, and it is written once for every engine:
SQL Server, Oracle, MySQL, ClickHouse and the rest reject it, so each column comes back as
"Could not profile this column" while the row count and the column list beside it are correct.
The failure is per column and the panel still renders, which is why it reads as a data problem
rather than a dialect one.

Measured in a browser during #789's review, on SQL Server 2022 against `shop.dbo.customers`:
three columns, three refusals, two rows counted correctly.

Pre-existing and not caused by #789: `git show main:src/app/api/db/profile/route.ts` carries the
identical two lines. It became visible because the object tree's row menu now offers Profile on
every relation of every engine, where the flat explorer offered it on the tables it listed.

Closing it is a per-dialect text cast measured on each engine rather than a one-line change:
Oracle has `TO_CHAR`, SQL Server `CAST(x AS NVARCHAR(MAX))`, MySQL `CAST(x AS CHAR)`, ClickHouse
`toString`, and `MIN`/`MAX` over a cast do not order the same way everywhere, so what the two
numbers MEAN needs stating per engine rather than assuming a lexicographic answer is wanted.

**Done when:** a column profiles on every engine whose provider offers the action, or the action
is not offered where it cannot answer, with the engine's own sentence rather than a generic one.

### D55. The admin Operations table list does not print a row's schema

Two tables with the same label in different schemas render as identical rows, so an operator
choosing between them has only the deep link's own marking to tell them apart. Found while moving
the maintenance deep link onto the object path in #789, which now carries the full address; the
list it lands on still shows a bare name.

**Done when:** a row in that list is identifiable without relying on what marked it.

### D56. A Druid lookup's JSON definition is unreachable from the one URL a connection carries

Fifteen of the seventeen shipped type-ids read object source under #789, measured by the census in
`tests/isolated/object-source-declarations.test.ts`; druid and libredb are the two that read none.
Two of Druid's three kinds have nothing to read: a datasource and a system table were never written
down as a statement, measured from the parser's own refusal, which enumerates every statement it
expected and includes no form of `CREATE`. The third is different. A `lookup` IS authored, as a JSON
spec, and `GET /druid/coordinator/v1/lookups/config/{tier}/{id}` answers that spec back. Nothing in
this product can ask for it.

What SQL answers instead is the lookup's key and value PAIRS (`SELECT * FROM lookup.<name>`, columns
`k` and `v`, measured on Apache Druid 37.0.0). Those are its content. The spec's type (`map` versus
`cachedNamespace`), its polling period and the namespace it extracts from appear nowhere in SQL, so
rendering the pairs under a caption that says "definition" would show a user something that is not
the definition.

Three things make this a transport change rather than a source read:

- `src/lib/db/providers/sql/druid/transport.ts` publishes exactly two members, `query(sql, opts)`
  and `close()`. `query` takes a SQL string, so no member can address any other path on the cluster.
- `tests/unit/db/druid/seam-guard.test.ts` parses every file in the provider directory and fails the
  build when a bare `fetch` or an endpoint path appears outside `http-transport.ts`, so provider
  logic cannot reach around the seam either.
- A connection carries ONE host and ONE port. A Broker-only deployment serves the SQL endpoint and no
  Coordinator API at all, and a Router serves it only when `druid.router.managementProxy.enabled` is
  set, which `database-compose.yml` sets for this repository's own cluster and a production
  deployment need not. So the read has to be able to come back empty-handed for a reason about the
  DEPLOYMENT rather than about the object, which needs a refusal sentence this provider does not
  have.

Two further things anyone taking this on has to settle before writing code, both open:

- The endpoint above is DOCUMENTED against the Druid 37.0.0 API reference and was NOT measured
  against a cluster here, so measuring it is step one.
- Which tier to ask for. The path takes a tier, `__default` being the usual one, and a Router-only
  deployment gives no list of tiers to a caller who has not already reached the Coordinator. Whether
  to enumerate tiers first, or to ask `__default` and refuse by name, is the design question.
- Writing back is not symmetrical with reading. Posting a lookup spec requires its `version` field to
  be BUMPED, so #778's edit half cannot round-trip a read spec unchanged, and the version handling is
  part of the work rather than a detail after it.

**Done when:** a Druid lookup shows its own JSON spec, or the object surface says in the engine's own
terms why this deployment cannot reach it.

### D57. MariaDB's `package` and `sequence` folders are never drawn in the standalone tree

`POST /api/db/provider-meta` reads `getCapabilities()` off a provider it never connects
(`src/app/api/db/provider-meta/route.ts:44`, #457), and `MySQLProvider.objectKinds` is the one
declaration in the fleet resolved from the server's own `VERSION()` string, so an unconnected
provider answers the MySQL six and the client's copy of the declaration never gains MariaDB's two.
The tree draws its folders from that copy (`src/components/object-tree/flatten.ts`), so the two kinds
have no folder and their source cannot be reached from the tree.

Both kinds are fully implemented behind the API: a connected provider counts, lists, describes and,
since #789, reads the source of both. Only the client's copy is stale.

The smallest correct fix reads the connected provider out of the factory cache and re-reads
`provider-meta` once the connection is warm, about ten lines. A `peekConnectedProvider(connectionId)`
on `factory.ts` that returns the already-connected instance opens no socket and keeps
`tests/unit/db-tunnel-discipline.test.ts` green, measured. The design question inside it is WHEN to
re-read: an unconditional re-read costs a round trip on all seventeen engines and changes the
capabilities object identity, invalidating every memo keyed on it.

Two limits measured while writing this. It is NOT fleet-wide: `ProviderCapabilities` has exactly
three connection-resolved values, `objectKinds`, `supportsExplain` and `explainFormat`, so a correct
fix also changes when the EXPLAIN affordance is offered on PostgreSQL and the four MySQL-wire
relatives, and that is a behaviour change rather than a repair. And the embedded half cannot be
closed the same way, because a host declares its own capabilities to `StudioWorkspace`, so closing it
there is a published-surface change.

Measured end to end 2026-09-13 against MariaDB `12.3.2-MariaDB-ubu2404` in a browser, while grounding
#778 Phase 3: the tree drew Tables, Views, Stored Procedures, Functions, Triggers and Events and no
Packages folder; `POST /api/db/provider-meta` answered those same six kinds; and at the same moment, for
the same connection, `POST /api/db/objects/source` answered the package's specification and body in full.
So the CONNECTED provider declares and serves `package`, and the declaration the CLIENT holds does not
carry it. The object was reachable only by hand-writing a restored tab.

This is load-bearing for the editing phase rather than cosmetic: any client-side predicate built on
`provider-meta`'s answer is, on MariaDB, built on the wrong server's declaration.

**Done when:** a MariaDB connection draws its Packages and Sequences folders in both shells, or the
provider doc says which surface cannot have them and why.

### D58. A ClickHouse function with a non-SQL origin has never been read live

The source read's refusal arm for `ExecutableUserDefined` and `WasmUserDefined` is driven in the
suite by a server answering an empty `create_query`, and killed by mutation, but no such function has
ever existed on the fixture. Creating one needs a `*_function.xml` in the server configuration
directory beside the script it runs, and `database-compose.yml` mounts neither directory.

What is owed once the compose file is free to change: add a `*_function.xml` mount and a script
directory to the clickhouse service, create one executable function in `docker/clickhouse-init/`, and
read it back through the real provider to confirm the server answers an empty `create_query` and an
`origin` of `ExecutableUserDefined`, which is what the refusal sentence claims.

Cost if wrong: the sentence names an origin the server does not report that way, and a reader is told
a body is an external program on a server that spells the absence differently. The Enum8 vocabulary
is measured (`Enum8('System' = 0, 'SQLUserDefined' = 1, 'ExecutableUserDefined' = 2, 'WasmUserDefined'
= 3)`), so only the empty-`create_query` half is unmeasured.

**Done when:** one executable function exists in the fixture and its refusal is read back from a
running server rather than from a double.

### D59. A Trino materialized view has no fixture here, and the cheap route is measured shut

`docker/trino-init/01-object-fixture.sql` seeds no materialized view, so the one object kind whose
source read this repository cannot reproduce is `trino.materialized_view`. The read IS implemented
and IS tested, against a payload captured from a live cluster, but the cluster that produced it is
not one `database-compose.yml` can start.

THE CHEAP ROUTE WAS PROBED AND REFUSED, and the measurement is the point of this entry, so the next
attempt starts from a fact rather than from the same hope. Measured 2026-09-13 on trinodb/trino:476
with an Iceberg JDBC catalog on PostgreSQL 18:

- The JDBC catalog WORKS. `CREATE SCHEMA` answered `CREATE SCHEMA`, `CREATE TABLE
  iceberg.warehouse.orders (id bigint, total double)` answered `CREATE TABLE`, and `INSERT INTO
  iceberg.warehouse.orders VALUES (1, 10.0), (2, 20.0)` answered `INSERT: 2 rows`.
- `CREATE MATERIALIZED VIEW iceberg.warehouse.order_totals AS SELECT id, total FROM
  iceberg.warehouse.orders` answered `createMaterializedView is not supported for Iceberg JDBC
  catalogs`.
- Two traps on the way: Trino 476 never creates the JDBC catalog's own `iceberg_tables`, so every
  statement fails `Cannot check and eventually update SQL schema` until the two Iceberg V1 tables are
  created by hand; and a `file://` warehouse needs `fs.hadoop.enabled=true`, where
  `fs.native-local.enabled` plus `local.location` refuses to START the coordinator with `Invalid
  configuration property local.location: file does not exist: file:/data/warehouse` for a directory
  that exists and is writable inside the container.
- The materialized view WAS then created on an `apache/hive:4.0.1` standalone metastore, which is
  what produced the measured `Create Materialized View` reply column.

So the remaining price is a metastore service and a warehouse volume in `database-compose.yml`, and
the decision to pay it is a compose-file decision rather than an object-surface one.
`docs/providers/trino.md` carries the full command set meanwhile.

**Done when:** `database-compose.yml` starts a cluster on which the shipped fixture creates a
materialized view, or the provider doc is accepted as the permanent home of those commands.

### D60. `countObjects` reports a MongoDB transport failure as the engine's own refusal

`src/lib/db/providers/document/mongodb.ts` `countObjects` catches every `listCollections` rejection
and answers `{ unavailable: <the error message> }` for every declared kind.

Measured against mongodb 7.6.0 and MongoDB 8.2.12: only a `MongoServerError` is the server's own
error reply. A `MongoServerSelectionError` ("connect ECONNREFUSED ...") or a `MongoNotConnectedError`
("Client must be connected before running operations") is a transport failure the server never
answered, and the tree then badges a folder with a socket message as though MongoDB had refused the
read.

#789 fixed this for `readObjectSource` only (`isServerErrorReply` in the same file), because
`KindCount`'s `unavailable` arm is a contract shared by the whole fleet and one provider moving alone
would make the fleet inconsistent.

The decision to take is whether `KindCount.unavailable` means "the engine refused" fleet-wide, in
which case every provider's count catch needs the same discrimination and a transport failure should
raise.

**Done when:** a test per provider drives a transport-shaped rejection through `countObjects` and
asserts it raises rather than badging, and the same for `listObjects`.

### D61. Elasticsearch and OpenSearch object source re-serialises the cluster's JSON, so three values are re-spelled

`readObjectSource` renders a pipeline's or a template's definition with `JSON.parse` followed by
`JSON.stringify`, because the definition is a sub-document of the endpoint's answer and there is no
extended-JSON writer for a REST payload.

Measured on Elasticsearch 9.1.4 and OpenSearch 3.8.0 on 2026-09-13 against `probe_json_edges` in
`docker/search-init/01-object-fixture.sh`: the cluster answers `9223372036854775807` and the pane
shows `9223372036854776000`, `1.0E30` becomes `1e+30`, and a map keyed `zz, 10, 2, aa` is rendered
`2, 10, zz, aa`.

Nothing is dropped, so `form: "complete"` is true, and both provider docs record all three under
"Object source (#789)". A faithful rendering would need the sub-document sliced out of the response
TEXT rather than re-serialised, which is a small JSON scanner nobody owns today.

It matters for #778 Phase 3: a definition holding a long past 2^53 must not be edited and PUT back
from the pane.

**Done when:** either the pane shows the cluster's own bytes, or the edit half is refused on a
definition whose re-serialisation is not byte-identical to what was read.

### D62. Two PostgreSQL source refusals are unverified on CockroachDB and Materialize

`PostgresProvider.readObjectSource` reports exactly two SQLSTATEs as a refusal part, 42883 (`pg_get_*`
absent) and 42703 (`pg_proc.prokind` absent), and both arms exist because this type id also serves
CockroachDB and Materialize.

The sentences in `tests/integration/db/postgres-provider.test.ts` are the SHAPE PostgreSQL 18.4
answers for a missing function and a missing column, measured; neither fork was brought up. The
provider carries no string of its own, so a wording difference cannot break it, and what is
unverified is only the claim that those two SQLSTATEs are what a fork answers there.

**Done when:** each fork is brought up, a view's and a routine's source is asked for through the
shipped statements, and the SQLSTATE and the sentence are recorded in `docs/providers/postgres.md`.
If either answers a third code, that arm is a code change and not a doc change.

### D63. `postgres.ts`'s `describeObject` still binds `[path[0], path[1]]`

Standing ruling 5g's second spelling, in `describeObject` in
`src/lib/db/providers/sql/postgres.ts`. It is behaviour-identical at depth 1 and silently wrong at
depth 2, and the source read does not use it. The object-model epic assigned it to a final sweep
rather than to the task that found it, so it is recorded here rather than left in a work file.

**Done when:** the name is `path[path.length - 1]` and the container is
`path.slice(0, containerDepth(capabilities))`, plus the two-level `spyOn` test driven all the way to
the binds, the way `readObjectSource` is already pinned.

### D64. The PostgreSQL trigger LISTING join is unpinned, so the tree could list no trigger at all

`LIST_TRIGGERS_SQL` in `src/lib/db/providers/sql/postgres.ts` joins
`pg_catalog.pg_class c ON c.oid = t.tgrelid`, which is what makes a trigger's row name its base table.
Mutating that one column to `tgconstrrelid` leaves the whole suite green.

Measured 2026-09-13: with the mutation applied, `bun test tests/integration/db/postgres-provider.test.ts`
is 205 pass 0 fail, identical to the unmutated control. `tgconstrrelid` is 0 for every ordinary
trigger, so a real server would join nothing and the Triggers folder would list nothing, while the
count beside it kept counting. Nothing in the tree would say so.

The SOURCE statement added by #789 IS pinned as text at
`tests/integration/db/postgres-provider.test.ts:4393`; this is the Phase 1 LISTING statement beside
it, which is not.

**Done when:** the listing statement is pinned as text the way the source statement is, and the
mutation above fails by name.

### D65. A provider suite whose double dispatches on the statement the test builds cannot see the statement change

Five mutants of one class survived the PostgreSQL suite until its first fix round: three predicate
deletions, one relkind swap and one pretty flag. All of them are edits to statement TEXT that leave
the binds untouched, and all are invisible to a double that routes by the `pg_get_*` function name
the test itself constructed.

#789 closed this for the SOURCE statements: each provider task pinned its own source statement as
text and reported its mutation numbers. The Phase 1 listing and counting statements across the fleet
were not swept the same way, and D64 is the one instance that has been measured.

**Done when:** every provider's listing and counting statements are pinned as text, one assertion per
statement, with the mutation numbers recorded rather than a sample of them.

### D66. The SQLite kind-vocabulary guard scrapes source text, so a kind can be declared and unmapped

The guard in `tests/unit/lib/agent/context-snapshot.test.ts` scrapes `SQLITE_OBJECT_KINDS` with a
`{ id: "..."` regex that only matches a SINGLE-LINE entry, so a kind written across two lines drops
out of the population the guard compares.

Measured 2026-09-13, both directions. Exploding an EXISTING entry past 120 columns is a LOUD red: two
declared ids against the agent side's four, 1 fail, "Expected - 0 / Received + 2", with `table` and
`trigger` unmatched. So that half is safe. But adding a FIFTH kind as a multi-line entry drops it from
the guard's population AND it is absent from `COMPOSED_KIND_WORDS`, both sides shrink together, and
the guard passes at 1 pass 0 fail, while the same kind written on one line fails.

So the defect is a kind that is declared and unmapped, not a formatter. The provider keeps its entries
on one line so they stay scrapable and says so in a comment.

**Done when:** the guard reads the declaration through
`createDatabaseProvider("sqlite").getCapabilities()` instead of scraping source text, and a
multi-line entry for an unmapped kind fails it.

### D67. `assertObjectPathShape` is written out eight times, and four more shapes twice or three times

Measured in the tree on 2026-09-13: `assertObjectPathShape` is DEFINED, not imported, in eight
provider files (`postgres.ts`, `mysql.ts`, `oracle.ts`, `sqlite.ts`, `libsql/objects.ts`,
`clickhouse/objects.ts`, `cassandra/objects.ts`, `document/mongodb.ts`). It belongs beside
`containerDepth` in `src/lib/db/object-kinds.ts`, which is where `comparePaths` already went: that
one was written four times, was hoisted to `src/lib/db/object-path.ts`, and is now imported by every
caller, so the pattern is settled and only this helper is left behind.

Four more shapes are duplicated verbatim by the source reads:

- `OBJECT_SOURCE_SQL` and `SOURCE_CATALOG_TYPES`, twice, in `sqlite.ts` and `libsql/objects.ts`.
- `blankDefinitionShape` and `blankDefinitionReason`, three times, in those two plus
  `duckdb/objects.ts`. The last two carry three sentences each, so there are copies of six sentences
  that must not drift, and only the duckdb pair is exported.

libSQL IS SQLite and the two source reads are the same statement against two transports, which is why
that pair is worth taking first.

None was hoisted when it was found because concurrent implementers held the checkout and a hoist
collides with every one of them.

**Done when:** one definition of each replaces the copies, with the sqlite and libsql source read
sharing its statement.

### D69. Six type-ids still open `readObjectSource` with their own entry guard, and one of its sentences is less true

`requireSourceKind` in `src/lib/db/object-kinds.ts` is the one entry guard for `readObjectSource`:
it raises separately for a kind the engine never declared, for a declared kind that publishes no
definition text, and for a source-bearing kind carrying no `sourceLanguage`. Measured on 2026-09-13,
nine providers call it (sqlite, libsql, duckdb, clickhouse, cassandra, postgres, mssql, mysql,
trino) and six type-ids do not: couchbase, mongodb, redis, elasticsearch and opensearch (one shared
module) and oracle.

All five of those modules COLLAPSE the first two facts into one throw. They test
`spec?.hasSource !== true` and answer `<Engine> declares no readable source for the kind "X"`, so a
kind the engine has never heard of and a declared kind with no definition text arrive as the same
sentence. That sentence is not merely shorter, it is less true: it tells the caller the kind exists
and has no source. Three of them (couchbase, mongodb, search) also spell the third arm differently,
"declares source for the kind X and no sourceLanguage, so its text has no language to render in"
rather than "declares readable source for the kind X and no sourceLanguage to render it with".

A fourth spelling of the same refusal lives at the route layer: `src/lib/api/object-route.ts` raises
`<type> declares no readable source for kind "X"` as an `ObjectRouteError` with a 400, before any
provider is consulted. It guards a different fact and answers a different error type, so it is not
simply a call site, but it is a fourth wording of one refusal.

None of the six was converted when the guard was hoisted (#789), because converting them rewords
between one and two throws each, five provider suites assert on the exact wording, and a reworded
throw is a behaviour change that does not belong folded inside a refactor. The cost of leaving them
is that the hoist's second-order gain, that a new provider cannot silently forget one of the three
guards, holds for nine of seventeen type-ids only.

**Done when:** the six call `requireSourceKind`, with the five provider suites' assertions moved onto
the guard's three sentences in the same commit, and the route layer either reuses one of those
sentences or its docblock says why a 400 raised before the provider is a different fact.

### D70. The DuckDB multi-statement sentence is an inference in a measurement's voice, and the tail does run

`docs/providers/duckdb.md` section 3.11 says a multi-statement string runs the first statement only, that the rest is
silently discarded, and that there is no error and no second result.
`src/lib/db/providers/sql/duckdb/index.ts:699-703` says `client.run()` executes only the FIRST statement and that the
method guarantees the tail is never executed.

Measured 2026-09-13 on DuckDB v1.5.5 through `@duckdb/node-api` 1.5.5-r.4, while grounding #778 Phase 3.
`CREATE TABLE probe_c(i INTEGER); CREATE TABLE probe_c(i INTEGER)` answers
`Catalog Error: Table with name "probe_c" already exists!`, which is the SECOND statement's error, and `duckdb_tables()`
then holds `probe_c`.
`DROP VIEW probe_v; CREATE VIEW probe_v AS SELECT * FROM no_such_table_here` raises the second statement's error and
leaves the view dropped.
So the tail runs, the failure rolls nothing back, and the discard is neither silent nor a discard.

The measurement quoted in section 3.11 is real and it is about the RESULT: `runAndReadAll` returns the first statement's
rows and not the second's.
The sentence built on it is about EXECUTION, which nobody ran, and the two are different claims.
This is the same class as the entries this file already carries about inferences written in a measurement's voice.

The security consequence is bounded rather than open, and the bound should be stated rather than assumed: the guard
beside the docblock reads the whole string before the call, so a forbidden form hiding in the tail is still refused, and
`access_mode` is fixed read-only on that path.
What is wrong is the stated reason, which is the load-bearing half of a security docblock.

**Done when:** the code docblock and all three places in the provider doc say what was measured, which is that the first
statement's rows are returned and the tail still runs, or the claim is re-measured on a version where it holds and that
version is named.

### D73. Session state written by one HTTP request is read by every later request, across Studio users

The provider cache is one entry per `connection.id` process-wide, so a `SET` that survives the statement
survives the request and reaches the next borrower whoever they are.

Measured 2026-09-13 on PostgreSQL 18.4 through the product: a `SET` issued by a `user`-role session was
read back by an `admin` session on the same backend pid, was not visible on a different connection id,
and was not visible to a fresh psql session.
Concurrent requests were served by different backends, so the leak is the cached provider rather than any
serialisation.

The same class is already measured on two other engines by this epic's Phase 3 grounding: `resetOnRelease`
is false on the MySQL pool, and a `USE` persists on the SQL Server pool through both of node-mssql's send
paths.

It is not only cosmetic state. `search_path`, `sql_mode`, `USE` and `SET ROLE` all change what a later
statement MEANS, and none of them is reset.

**Done when:** either the pool resets a connection on release, or every route that mutates session state
restores it in a `finally`, and the choice is written down where the next writer of a route will read it.

### D88. A multi-statement text sent to the single-statement query route answers HTTP 500

`POST /api/db/query` is the single-statement route and nothing stops a caller sending two. PostgreSQL
runs both, `pg` answers an ARRAY of results for a multi-statement simple query, and
`PostgresProvider.query()` reads `result.rows` off that array, which is `undefined`. The route then
reads `result.rows.length` and throws, so the caller gets a 500 with no sentence about what was wrong
with their request, after both statements have already run.

MEASURED 2026-09-15 on PostgreSQL 18.4 through `pg` 8.23: a simple query of two statements answers
`[Result, Result]` with the engine's own command tags, and `Array.prototype.rows` does not exist.
Read in the tree at the same commit: `src/lib/db/providers/sql/postgres.ts` returns `rows: result.rows`
from `query()`, and `src/app/api/db/query/route.ts` reads `result.rows.length`.

Found while probing D74. Not caused by it and not fixed by it.

**Done when:** the route either refuses a text carrying more than one statement with a sentence, or the
provider names which result of an array it answers with. The first is the smaller change and is what
the route's own name claims; D76's single-statement check on the object-edit path is the precedent for
asking the engine rather than splitting the text.

### D89. A count mismatch is reported on the `interrupted` arm, whose documented meaning says the engine never answered

`applyObjectEdit` on `postgres` counts the results the round trip answered and reports
`{ outcome: "interrupted", committed: "unknown" }` when that count is not the four statements the
emitted unit is made of (D76).

`src/lib/db/types.ts` documents that arm as "the statement was SENT and the engine's answer never
arrived: a timeout, a cancellation, a dropped socket, or any throw out of `applyObjectEdit`". For a
count mismatch the answer DID arrive and the engine DID speak, so the arm is used outside its own
contract, and the UI copy is written against the contract rather than against the member:
`src/components/object-source/ApplyPreviewDialog.tsx` renders "This apply's outcome is unknown" and
"**Whether it reached the server is unknown.** Read the definition again before you edit it." above
the provider's true sentence. The second line of `OutcomeRegion`, which X20 narrowed to "Whether it
was applied is unknown: LibreDB has no answer that says whether it landed", IS true of this member.

The provider side was weighed and left as it is, with the reason written into
`src/lib/db/providers/sql/postgres.ts` and `docs/providers/postgres.md`: no other arm in the union
fits better, and an arm added on the provider side ALONE falls into `applyFrame`'s `applied` tail,
which has no exhaustiveness check, so the reader would be shown "This apply is done. The new
definition is on the server." That is strictly worse than today.

**Done when:** either a seventh outcome arm exists with its wire shape in `src/lib/db/types.ts`, its
own arm in `ApplyPreviewDialog.applyFrame` and `OutcomeRegion`, and tests for both; or the
`interrupted` docblock in `src/lib/db/types.ts` and the `applyFrame` disposition line are narrowed to
what is true of every member, and a test pins that the dialog's first line makes no transport claim.

### D90. Three type-ids declare a `endOpenQueryTransaction()` absence that is not final

D75 asked every type-id that does not implement the surface to say WHICH absence it is, and all
fourteen now do. Three of those answers are explicitly provisional, and each provider doc says so
where it bites. They are collected here because a doc that says "this is filed as its own change"
needs the change to exist.

**`mysql` and `mssql`: the DRIVER cannot be asked, and the SERVER can.** Both were measured live.
On MySQL 8.0.46 through `mysql2` 3.24.4, with the question asked from outside the pool on the
released session's `threadId`, `performance_schema.events_transactions_current` answers `ACTIVE`
for a bare `BEGIN` and for a `BEGIN` followed by a failing statement, and `ROLLED BACK` for the
control. On SQL Server 2022 through `mssql` 12.7.2, `sys.dm_exec_sessions.open_transaction_count`
on the released session's `@@SPID` answers 1 and 1 against a control of 0. Both readings are taken
AFTER the connection went back to the pool, so they also measure that the leak is real rather than
inferred. `docs/providers/mysql.md` section 6.1 and `docs/providers/mssql.md` section 6.1 carry the
full tables.

Neither was implemented on that ask, for one reason each and both written down. On `mysql` the
provider also serves MariaDB, where `performance_schema` is OFF by default and its tables answer
NULL rather than failing, so the same query would report no open transaction while one is open, and
rolling nothing back is the one outcome worse than reporting nothing. That needs a per-server
capability probe of the kind `objectKinds` and the EXPLAIN grammar already use on this provider.
On `mssql` the state is readable on `tedious`'s `Connection`, which `mssql.Request` never hands out.

**`trino`: nobody has measured it yet.** The code side is settled and `docs/providers/trino.md`
section 3.14 states it: the coordinator carries a transaction on `X-Trino-Transaction-Id`, the
transport writes and reads neither, so this provider holds nothing between statements that the
surface could name. What is unmeasured is the other end, what a live coordinator does with a
transaction whose id was dropped, how long it survives the idle timeout, and whether it holds
anything a later user of the same cluster notices.

**Done when:** each of the three either implements the surface or its doc records the measurement
that closes the question. For `mysql` that is a per-server `performance_schema` capability probe
plus the implementation behind it. For `mssql` it is whether a pinned `ConnectionPool.acquire()`
connection can carry a statement at all. For `trino` it is one run against a live coordinator.

### D91. The embedded shell's apply refusal cannot be placed, styled or suppressed by the host

`src/workspace/StudioWorkspace.tsx` renders the D82 refusal itself, as an `output` portaled to
`document.body` at `fixed bottom-4 right-4 z-[60]`. That is the only viewport-fixed element the
package's own shell paints, and it lands in the HOST's chrome: the adopter cannot move it, restyle
it, route it into their own notification surface or turn it off. MEASURED and written into the
docblock: a body child also falls outside `STUDIO_SCOPED_CSS`, so it renders in the host page's font
at `letter-spacing: normal` while the workspace box renders at `-0.011em`. The colour tokens are on
`:root` and survive. The portal itself is not the negotiable part, it is what makes the live region
reachable at all (`hideOthers` marks the box and installs no observer).

Second, smaller, and in the same surface: `onApplyInFlightChange` on
`src/components/object-source/ObjectSourceView.tsx` is optional, and the `undefined` arm now has no
shipped caller. The pane has exactly two mounts in `src` (`Studio.tsx:1127`,
`StudioWorkspace.tsx:833`) and both pass it; `src/exports/` re-exports the pane from nowhere and
`dist/*.d.ts` carries no `ObjectSourceView`, so no adopter can mount it without the prop. The arm
exists for the 14 mounts in `tests/components/object-source/ObjectSourceView.test.tsx` and for
nothing else.

**Done when:** the host has a documented way to receive or place this refusal instead of having it
painted into their chrome, with a test for the default (still shown) and for the host-handled path;
AND `onApplyInFlightChange` is either made required, with the pane's test mounts updated, or its
optionality is justified in the props docblock by a caller that actually exists.

### D92. A multi-statement script is not guaranteed one pooled backend, so its BEGIN and its COMMIT can land apart

`POST /api/db/multi-query` runs a script by calling `provider.query()` once per statement, and each
call does its own `pool.connect()`. Nothing holds one backend for the script's lifetime. Under
concurrent traffic on the same connection id, a script's `BEGIN` and its `COMMIT` can therefore be
served by different backends, which commits nothing and leaves the first backend's transaction to
D87's scope-bound ender.

NOT REPRODUCED, and said in that voice. `pg`'s idle list is LIFO and a script's statements run back
to back, so the same client comes back nearly always: measured 2026-09-15 on PostgreSQL 18.4, six
concurrent script runs answered identical backend pids throughout. What is missing is a construction
that forces the interleave, not an argument that it cannot happen.

Found while reviewing D87. It is independent of D87 and was not introduced by it: D87 bound the
ENDER to the caller's own scope, which is what makes the first backend's transaction reachable at
all, and this entry is about the script's own statements being spread across backends in the first
place.

**Done when:** either a probe forces the interleave and the result is recorded, or the route holds
one client for the script's scope. The second changes pool semantics for every caller of `query()`
and is the larger change, which is why this is filed rather than folded into D87.

### D93. One connection id can hold unboundedly many live SSH forwards, and only whole-connection teardown reaps them

D86 was closed by KEYING the tunnel pool on the forward - `(connectionId, remoteHost, remotePort,
tunnelRoute(sshConfig))` in `poolKey`, `src/lib/ssh/tunnel.ts` - rather than by refusing a mismatch.
That was the trade D86 itself allowed, and refusing is still the wrong answer: nothing on the
edit path closes a stale forward, so a refusal would leave the connection unusable, and every second
provider on a live tunnel legitimately reuses it. The cost is that the pool now holds one live
forward per distinct (route, far end) asked for under an id, where before it held exactly one.

MEASURED at the unit level, real pool, `ssh2` and `net` faked so the handles are countable
(`scratchpad/probes/d86-unbounded-route.test.ts`): 50 requests under ONE connection id, 25 far ends
across two bastions, gave

```
distinct loopback listeners open under one connection id: 50
live net servers: 50 live ssh clients: 50
after closeSSHTunnel, live net servers: 0 live ssh clients: 0
```

Each entry is an open SSH client plus a listening loopback socket. Nothing in the map reaps a
superseded one: the provider cache miss that opens the next forward disconnects the PROVIDER
(`factory.ts`, the query-timeout arm) and leaves the forward pooled. What takes them is the
connection's own teardown - `removeProvider` and the 30-minute idle sweep, both of which close BY
CONNECTION ID and take every forward with them - so the count is what one id accumulates inside one
idle window. It is caller-driven, on the same reachability D86 already established:
`src/lib/seed/resolve-connection.ts:21-23` returns a posted inline connection verbatim, id included,
so the host, the port and the bastion of each request are the caller's to vary.

It is disclosed where a writer will read it (the `activeTunnels` docblock states the count, the
measurement and what reaps it) and it is NOT disclosed to an operator anywhere: no metric, no log
line counts forwards per connection, and `docs/SECURITY.md` says nothing about it.

**Done when:** the number of simultaneously live forwards under one connection id is bounded, by a
cap that refuses or by closing a forward once nothing can still be using it, and the choice is
written down where the next writer of the pool will read it. A test drives N distinct forwards under
one id and asserts the bound holds, with a control that the honest population is untouched: a second
provider on the same id, route and far end still gets the one forward and opens no second one.

### D94. On a single-connection provider the transaction ender cannot tell whose transaction it is ending

`endOpenQueryTransaction(scope)` takes the caller's call scope so that a POOLED provider can name the
client its own statements ran on (D87). The three providers that hold ONE connection, `sqlite`,
`duckdb` and `redis`, take no argument at all, and their docblocks said the parameter was irrelevant
there because there is "no other client to name and no request whose transaction this could be". The
first half is true. The second is false, and one shared connection is what makes another request's
transaction REACHABLE rather than what puts it out of reach: `getOrCreateProvider` caches one
provider per `connection.id` for the whole process, so every concurrent request on a stored
connection shares the one handle. Wave 6 corrected all three docblocks and `docs/providers/redis.md`;
the defect itself is this entry.

**Redis is the measurable case and the worst one.** A `MULTI` is state of the CONNECTION. Measured
2026-09-15 on redis 7.4.11 through ioredis 5.11.1 and recorded in `docs/providers/redis.md` section
5.2a: after a bare `MULTI`, every later command on that connection answers the string `QUEUED` and
does nothing, `SET`, `GET` and `CLIENT INFO` alike, while a second connection is untouched. Since
D74, `POST /api/db/query` awaits the ender in its `finally` on every request, and the ender PINGs and
then `DISCARD`s whatever `MULTI` that PING found. Neither command can say who opened it. So a plain
`GET` typed by one user drops a `MULTI` another user had just queued commands into, and that user is
told nothing: their next command answers `QUEUED` from no transaction, and their queue is gone. The
`DISCARD` catch in `src/lib/db/providers/keyvalue/redis.ts` already reads the same collision from the
other side, "another caller on this shared connection ended it in between".

`sqlite` and `duckdb` carry the same shape and were checked rather than assumed. Both hold one handle
for every concurrent request. `sqlite` reads `inTransaction`, which reports the handle's state and
not who opened it; `duckdb` publishes no transaction reading at all on v1.5.5, so its act IS the ask,
an unconditional `ROLLBACK` whose refusal is the answer, and a refusal cannot name an owner either.
NOT SEPARATELY MEASURED on those two: the sharing is measured (2026-09-13, recorded in both
docblocks, where the NEXT user's write joined an abandoned transaction), and the ender's reach over
it is read off the code.

The fix is not a parameter. It is transaction OWNERSHIP on a single connection: the provider would
have to record which scope opened the transaction it later observes, and a transaction opened before
any scope was recorded, by an interactive session or by a caller that passed no scope, still has no
owner. Refusing to end an unowned transaction reinstates the leak D71 and D74 exist to close, so the
two have to be weighed together rather than one at a time.

**Done when:** each of the three either names the scope that opened the transaction it ends, with a
test that a second scope's ender leaves it alone and a control that its own scope still reaches it,
or its provider doc records why ending an unowned transaction is the right trade on that engine and a
test pins the behaviour that was chosen.

---

# D94 (proposed): hand-copied source coordinates across this repository are stale by thousands of lines

**Status:** proposed, wave 6 slot B fix round.

Found while re-deriving the two `postgres.ts` citations that this round's two added import lines
moved. `src/lib/api/object-route.ts` is the ONLY file whose citations are guarded, by
`tests/unit/lib/api/object-route-edit.test.ts`, which resolves each anchor and compares the number.
Every other `file.ts:NNNN` in the repository is hand-copied prose, and a sample of nine measured at
`64ee0e3f^` was wrong before this round touched anything:

| Citation | Cited in | Anchor actually at |
|---|---|---|
| `postgres.ts:915` (`queryReadOnly`) | `docs/AGENT_GUIDE.md:925` | 2396 |
| `postgres.ts:889` (`BEGIN READ ONLY`) | `docs/AGENT_ANALYST_DESIGN.md:400`, `:718` | 2415 |
| `postgres.ts:892` (`SET LOCAL statement_timeout`) | `src/lib/agent/tools.ts:1552` | 2418 |
| `postgres.ts:2095-2099` (`{ ...baseConfig, connectionString }`) | `src/lib/db/connection-fingerprint.ts:67`, `tests/api/db/objects/edit-apply.test.ts:91`, `tests/unit/lib/db/connection-fingerprint.test.ts` x3 | 2256-2262 |
| `postgres.ts:1239` (`pg_stat_statements extension not enabled`) | `docs/BACKLOG.md:326` | 4001 |
| `postgres.ts:1285` (`"public." + escapeIdentifier`) | `docs/BACKLOG.md:467` | 4048 |
| `source-applier.ts:155` (the silent-status sentence) | `tests/components/object-source/ApplyPreviewDialog.test.tsx:1092` | `whenSilent`, elsewhere |
| `StudioWorkspace.tsx:494` (`<main className="flex-1 overflow-hidden relative">`) | `docs/BACKLOG.md:1360` | 823 |
| `StudioWorkspace.tsx:833` (the `ObjectSourceView` mount) | `docs/BACKLOG.md:1145` | 919 |

Nine of nine wrong, none of them by this round: the smallest miss is over 500 lines. A reader who
follows one lands on an unrelated line and cannot tell a moved anchor from a deleted one, and an
agent that re-derives its own citations after an edit, which this epic has now asked for three
times, is paying a per-commit tax on coordinates that were never right.

Two halves, and the second is what stops it recurring:

1. Re-derive, or drop, every `file.ts:NNNN` outside `object-route.ts`. Dropping is often the better
   answer: an anchor quoted as text (`queryReadOnly`, `BEGIN READ ONLY`) is grep-able for ever, while
   a number is correct only until the next commit.
2. Generalise the guard. `tests/unit/lib/api/object-route-edit.test.ts` already holds the whole
   mechanism: a table of `{ as, file, anchor }` and a check that the rendered `as:line` appears in
   the citing source. Lift it to a repository-wide test that scans for the `file.ts:NNNN` shape,
   resolves each, and fails on a miss, so a coordinate cannot go stale silently again.

**Done when:** a test fails on a stale `file.ts:NNNN` anywhere under `src/`, `docs/` and `tests/`,
and the citations present at that commit all resolve. The test needs one case per shape it must
accept, a single line, a range and a comma pair, and one negative that fails when an anchor moves.

### D85. The `@/lib/auth` mock is hand-copied across a layer, untyped, and already misses two exports

`grep -rl 'mock.module("@/lib/auth"' tests/` returns exactly 37 hits, measured 2026-09-15. Six of
them spread the real module and replace one function (`{ ...realAuth, getSession: mockGetSession }`,
the agent routes' pattern). Twenty-nine write out the same five-key object - `getSession`, `signJWT`,
`verifyJWT`, `login`, `logout` - down to the same `mock(async () => "mock-token")` for a token
nothing reads, and one of those twenty-nine is `tests/helpers/object-edit-route-harness.ts`, a shared
harness that could have been the factory and copied the stub instead. The remaining two write a
shorter stub of their own, one with two keys and one with a single `getSession`.

`src/lib/auth.ts` exports seven names. The two no hand-written stub carries are
`shouldMarkCookieSecure` and `resetCookieSecurityWarning`:
`grep -rn 'shouldMarkCookieSecure' tests/` returns exactly one hit, and it is a sentence in a comment
rather than a stub key, while `resetCookieSecurityWarning` appears only in
`tests/unit/lib/auth.test.ts`, which imports the real module.
`src/app/api/auth/oidc/login/route.ts` imports `shouldMarkCookieSecure` and awaits it to decide the
auth cookie's `secure` flag, so every one of those stubs is already an export short of the module it
replaces. Nothing has hit that yet only because `tests/api/auth/oidc-login.test.ts` is one of the
route tests that does NOT mock `@/lib/auth`.

Nothing can catch it either. `mock.module` is declared `module(id: string, factory: () => any)` in
`node_modules/bun-types/test.d.ts`, so a stub that has drifted from the module it stands in for is
invisible to `bun run typecheck`, and the drift can only show up as a `TypeError` in whichever route
reaches the missing export first.

Per-file process isolation does nothing about this and was never meant to. The runner gives each
file its own process, so a stub can no longer reach a sibling that wants the real module. What a
process boundary cannot do is make the stub the right SHAPE.

**Done when:** one factory in `tests/helpers/`, typed `(): typeof import("@/lib/auth")`, replaces the
hand-written stubs, so adding an export to `src/lib/auth.ts` fails `typecheck` in every file that
mocks it instead of at run time in one of them. The same shape then covers the other layer-wide
mocks, `@/lib/db` in fifteen files and `@/lib/audit` in four.

### D86. `bun test --isolate` has not been re-probed, and the runner pays a process per test file

`tests/run-tests.ts` spawns one bun process per test file, 549 of them on 2026-09-15, because
`mock.module()` is process-wide with no undo and whole-module mocks are a whole layer's standard
pattern. That is what it costs, measured on Linux with 20 cores and bun 1.4.2 earlier the same day,
over the 538 files the tree held then: 211 seconds one file at a time, 61 seconds 4 at a time, 36
seconds 20 at a time, and about 60 seconds at 8 with coverage on. `README.md` carries the same three
timings against the same 538 files.

bun 1.4.2 has `--isolate`, which resets the module registry per file inside ONE process and does
contain `mock.module`. If it were reliable here, the runner could start a handful of processes
rather than one per file. It is not adopted because of oven-sh/bun#41655, a NAPI finalizer SIGSEGV
that reproduces serially on 1.4.2, and this suite loads three NAPI addons: `better-sqlite3`,
`oracledb` and `@duckdb/node-api`. `docs/TOOLCHAIN.md` records the same refusal, beside the one for
`--parallel`.

**Done when:** #41655 is closed and a probe has run the whole suite under `--isolate` twenty
consecutive times on each of Linux, macOS and Windows with no crash, no leaked subprocess and the
same per-file pass counts as the process-per-file runner, after which the runner may take it - or
the probe reproduced a failure and this entry is replaced by what it reproduced. A mode that is
flaky at this size is worse than a slow one, because its failures arrive wearing the tests' own
clothes.

### D87. Two packaging tests cannot run on Windows because the scripts they drive shell out

Measured 2026-09-15, while making `bun run test` green on all three platforms. Two tests now declare
a platform or tool requirement and say so in their own title, and in both cases the requirement comes
from the script under test rather than from the test:

- `scripts/build-azure-package.mjs:273` builds the marketplace archive with `execFileSync("zip", ...)`.
  A stock Windows 11 machine has neither `zip` nor `unzip`, so `tests/unit/build-azure-package.test.ts`
  gates its build cases on both binaries. Writing the two-file archive with a pure JavaScript zip
  writer would make the Azure package reproducible everywhere and let the test read the archive back
  in process, which is what it already does for the standalone zip since this change.
- `scripts/ci-install.sh` is the bun install retry policy used by every workflow, and
  `tests/unit/ci-install.test.ts` drives it with a fixture PATH holding two `chmod 0755` stubs.
  Windows has no exec bit and no shebang dispatch, so the whole file is skipped there. The policy is
  twenty lines of arithmetic and `bun install`; as `scripts/ci-install.mjs` it would run under the
  same `shell: bash` steps and be testable on every platform.

Neither is a correctness defect today: CI runs both on Linux, and the skips are declared rather than
silent. What they cost is that a Windows contributor cannot verify a change to either script.

**Done when:** the Azure package is written without an external archiver, `ci-install` is a script bun
or node can run, and both test files run unconditionally on all three platforms.

### D95. The runner's default concurrency reads the CPUs and never the memory limit

Measured 2026-09-15 on Linux x64 with 20 cores and bun 1.4.2, while reviewing #837.
`tests/run-tests.ts` passes `availableParallelism()` to `parseRunnerArgs`, which makes the default one job per available CPU.
That much already behaves: `availableParallelism()` in bun 1.4.2 follows CPU affinity and a cgroup v2 CPU quota, measured as 2 under `taskset -c 0-1` and 2 under `systemd-run --property=CPUQuota=200%`, so a container with a CPU limit is sized by it.
A container with a MEMORY limit and no CPU limit on a many-core host is not, and that is the case that fails: `docker run --memory=2g` on a 64-core host starts 64 jobs.

What a job costs, measured over a 32-file sample run one at a time under `/usr/bin/time`, in peak RSS: minimum 58 MiB, median 100 MiB, p90 199 MiB, maximum 341 MiB.
Under real concurrency the files do not peak together, so the marginal cost is lower: the runner over `tests/components` peaked at 599 MB with 4 jobs, 998 MB with 8 and 1599 MB with 16, a slope of about 80 to 90 MiB per extra job over a fixed 300 MB.
The largest run actually made was 16 jobs, so 64 jobs is 5 to 6 GiB extrapolated from that slope rather than measured, and 12.4 GiB if every file peaked at the p90 bound at once, against a 2 GiB limit.
Under Kubernetes or systemd the whole run is then killed rather than one file: measured before this branch handled SIGTERM, a run stopped by systemd's default `OOMPolicy` ended at exit 143 with no summary and its scratch directory left behind, and it now ends at the same 143 with `Interrupted (SIGTERM).`; under Kubernetes's `memory.oom.group` the kernel SIGKILLs the runner too, so nothing is printed at all (reasoned, not measured).
Neither shape names the file that ran the container out of memory, which is what a memory-aware default would prevent rather than explain.

Which API can carry the limit was measured too, and only one of the three can.
`process.constrainedMemory()` follows a cgroup v2 `memory.max` (2147483648 under `MemoryMax=2G`) and equals `os.totalmem()` when there is no limit, which makes it usable with no fallback branch.
`process.availableMemory()` does NOT: inside the same 2 GiB scope it returned the host's 34 GB, unlike node 24, which follows the cgroup there.
`os.freemem()` is not a budget at all, since it moves with unrelated load and leaves out reclaimable page cache.
Not measured: what `constrainedMemory()` returns on macOS and on Windows, where there is no cgroup for bun to read; reasoned, it should be total RAM, and that is what the entry rests on.

A fixed cap is the wrong shape and was rejected: `Math.min(cpuCount, 16)` still needs 1.6 to 3.1 GiB inside a 1 GiB container, and it caps a workstation on a constant nobody measured against memory.
What this PR did instead is make the failure readable: a file killed by SIGKILL from outside the runner now names the OOM killer and `--jobs=N` in its reason, `CONTRIBUTING.md` says when to pass it, and `docs/TOOLCHAIN.md` carries these numbers.

The shape it would take: `parseRunnerArgs`'s injected context grows from `{ cpuCount }` to `{ cpuCount, memoryBytes }`, `tests/run-tests.ts` passes `process.constrainedMemory()`, and the default becomes
`Math.max(1, Math.min(cpuCount, Math.floor(memoryBytes / JOB_MEMORY_BUDGET_BYTES)))`.
A budget of 256 MiB is the one this measurement supports: above the p90 per-file peak of 199 MiB and about three times the concurrent slope.
A 2 GiB limit would then give 8 jobs, where 8 measured 940 MiB of anonymous memory, and the measured host, whose `constrainedMemory()` is 67,118,133,248 bytes (64 GB, 62.5 GiB), would give 250, so the CPUs stay the binding constraint everywhere else.
An explicit `--jobs=N` must still win over it, and the budget is a constant that drifts as the suite grows, so its docblock has to carry the basis above.

**Done when:** `parseRunnerArgs` takes a memory budget beside the CPU count, `tests/unit/test-runner-options.test.ts` pins the four cases (64 CPUs with 2 GiB gives 8, 8 CPUs with 64 GiB gives 8, 4 CPUs with 100 MiB gives 1 and never 0, and an explicit `--jobs=32` wins over all of it), and a CI run on macos-latest and windows-latest has printed `process.constrainedMemory()` against `os.totalmem()` so the unmeasured half of the premise is measured rather than reasoned.

### D96. bun 1.4.2 drops part of a child's own console output when the child exits under load

Measured 2026-09-15 on Linux x64 with 20 cores and bun 1.4.2, while reviewing #837.
A test file that prints a megabyte and then fails does not always get that megabyte to whoever is reading the run: the bytes are lost by the child `bun test` process at its own exit, before anything the runner can drain.
A fixture printing 1024 lines of 1023 bytes, run 20 times with the machine deliberately loaded, lost output in 15 of the 20 runs and delivered as few as 182 of the 1024 lines; unloaded, 10 of 10 runs were whole.
The loss is not the runner's pipe: with the runner's own stdout redirected to a FILE, 3 of 10 loaded runs still lost 15 to 40 per cent of the file's output, and with no runner in the picture at all, `bun test ./fixture.test.ts 2>/dev/null | cat > out` under load delivered 126 of 1024 lines in 1 of 10 runs.

What the runner does guarantee is its own last lines: the summary, the `Failed files:` block and the re-run hint are written through a drain that waits for the bytes to leave the process, and those survived every one of those runs.
So the cost is a contributor reading a red CI log from a busy machine and getting a truncated failure diff under an accurate verdict, not a wrong verdict.
`tests/unit/test-runner-cli.test.ts` states this where it would otherwise be tempting to assert the whole output back: its megabyte case asserts the verdict, the summary and that the file's output reached stdout at all, and says in a comment why it cannot assert the line count.

There is nothing to fix inside this repository: the queue that is dropped belongs to the child process.
What can be done is to re-probe, and to stop the claim drifting back to "whole output" in the meantime.

**Done when:** the focused repro has been run against a bun newer than 1.4.2 under the same load, and either it is whole 10 times out of 10 and this entry closes, or the entry names the newest version it still reproduces on and is reported upstream.

### D97. A committed `.only` makes a file report PASS with the rest of its tests never run

Measured 2026-09-15 on bun 1.4.2, while reviewing #837.
bun honours `.only` by default, and nothing in the runner, the lint configuration or the required checks refuses one that reaches `main`.
A fixture holding `it.only`, a failing `it`, a `describe.todo` and a `describe.concurrent` with two more tests wrote a junit report of `tests="1" failures="0"`, exited 0, and the runner printed `PASS 0.0s tests/unit/only.test.ts 1 pass`; the same file without the `.only` registers five tests.
So four registered tests, one of them failing, are absent from the report, from the run's totals and from CI's verdict, and the run is green.

The runner cannot close this from the report it reads, which is why `toOutcome`'s docblock now names `.only` as the shape the report cannot see.
bun's report is honest about the one test it ran; the file that should have been refused is the one on disk.
It has to be refused before the run, and there are two cheap shapes: an `eslint-plugin-no-only-tests` rule (or oxlint's `jest/no-focused-tests`) scoped to `tests/**` and `e2e/**`, or a grep over the same paths inside the required `Lint, Typecheck and Build` check, which costs one command and no new dependency.
The coverage gate is not a reliable second line of defence either: whether it goes red depends on which lines the unrun tests were the only cover for, which is a property of the file rather than of the `.only` (reasoned, not measured).

**Done when:** a file carrying `it.only`, `test.only` or `describe.only` under `tests/` or `e2e/` fails a required check, and a test pins that gate by driving it over a fixture that carries one, with a control fixture that does not and passes.


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

### R2. A MySQL index hint refuses an inline edit that the tab title used to write

`resolveUpdateTarget` (`src/lib/sql/update-target.ts`) reads the FROM reference as a name, an
optional `AS`, and an optional alias, and refuses everything longer through its trailing catch-all.
A MySQL index hint is longer: measured, `resolveUpdateTarget("SELECT * FROM users USE INDEX (idx)
WHERE id = 1", "mysql")` answers "This query describes its table in a way this editor cannot read".
The same applies to `FORCE INDEX` and `IGNORE INDEX`.

It reads exactly one table, and the tab-title reader #881 replaced wrote it correctly, so inline
editing on such a tab goes from working to refused. It is a refusal rather than a wrong write, which
is the direction that module chooses everywhere, so it is recorded rather than rushed.

Done looks like: the hint is read and dropped, the table resolves, and a hint naming a second table
(there is no such form on MySQL, which is what makes this safe) stays refused. Tests belong beside
the LIMIT case in `tests/unit/sql/update-target.test.ts`, with the engine each shape was measured on.

---

## Studio UI and query execution

`U2` came out of the #384 review. `X2` to `X13` came out of the #422 export review: each was
named, weighed and left out of that PR, so they are recorded rather than re-derived. `X14` and `X15`
came out of the #789 object-source design's own measurement passes: both are pre-existing, neither
is in the seam that epic touches, and both were re-measured against the tree before being written
here.

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

The four string-returning drivers fill `QueryResult.columnTypes` since 2026-08-23, and
SQLite joined them on 2026-09-18 by reading its own declarations through the driver bridge. Four bounds were
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

### X13. Profile is withheld from two engines by an engine-wide flag, and LibreDB has named objects behind it

`row-actions.ts:146` gates Profile on `capabilities.tablesAreDerivedGroupings !== true`, which is a
PROVIDER fact, while every other gate beside it is a per-kind declaration. The flag says "the rows
this engine shows are prefix groupings this server derived from a bounded scan", and on Redis that
is true of every row it has. On LibreDB it is true of one kind out of three: `keyspace` is derived,
while `table` and `collection` are entries the persisted catalog NAMES, created by `table()` and
`doc()` and addressed by the name their author chose (#789, Task 23). Those two are refused Profile
purely because the gate never got a per-kind half.

Nothing regresses today and that is measured, not assumed: `POST /api/db/profile` branches on
`queryLanguage === "sql"` and this provider declares `json`, so a profile of a LibreDB table is sent
as a MongoDB aggregate pipeline and the grammar answers
`Unknown command ... Supported: get, put, delete, prefix, range`. Profile cannot work on ANY kind
here, so withholding it from all three is the honest menu rather than a cost. That is pinned by a
test in `tests/integration/db/libredb-provider.test.ts`.

The condition that makes it bite is a separate fact changing: the day the profile route grows an arm
for this engine's grammar, two named-object kinds stay silently refused with no declaration
recording why, and the reason will read as a Redis decision rather than a LibreDB one. The same
would happen to any future engine that sets the flag while holding cataloged objects.

**Done when:** the per-kind half exists - a kind-level declaration saying whether a kind's rows are
derived groupings, read beside the engine-wide flag the way `kindAcceptsRowWrites` is read beside
`supportsInlineRowEdit` - or the engine-wide gate is deliberately kept with that decision written at
`libredb.ts`'s `tablesAreDerivedGroupings` site and in `docs/providers/libredb.md`. Either way
LibreDB's `table` and `collection` stop being refused by a flag that was never about them.

### X14. The workspace write that persists every tab has no quota guard

`src/hooks/use-tab-manager.ts:213` writes the whole workspace with
`storage.setItem(workspaceKey, JSON.stringify(serialized))` inside a 500 ms `setTimeout`, with no
`try`/`catch` anywhere between the timer callback and the call. Every other localStorage writer in
this application already has one: `src/lib/storage/local-storage.ts:64` and `:82` both wrap their
`setItem`, log `Failed to write to localStorage` and answer `false`, so the guard is a pattern this
writer skipped rather than a pattern nobody has.

The quota it writes against is shared. `STORAGE_COLLECTIONS` (`src/lib/storage/types.ts:28-38`) is
ten collections, connections and history and the audit log among them, and all of them plus this
record live inside one origin quota of about 5 MiB. The record itself is unbounded from the shell's
point of view because `PersistedTabState.query` copies each tab's editor text verbatim.

The symptom is not a lost tab. A `QuotaExceededError` thrown inside a timer callback is not caught
by React and not caught here, so it reaches the window's error handler, tab persistence stops for
the WHOLE workspace, and nothing tells the user; the next tab change schedules the same timer and
throws again. Found while designing #789 and not fixed there, because Phase 2 touches this record
only to add one address-only field: a Source tab persists its `path` and `kind` and never one
character of the definition it read, for exactly this reason, which narrows the exposure and closes
nothing. The reasoning is in the `PersistedTabState` docblock at `use-tab-manager.ts:40-60`.

**Done when:** the write is guarded the way `local-storage.ts` guards its own, and the failure is
observable rather than swallowed - a user whose workspace has stopped persisting is told, since a
silent `false` here means the tabs on screen are no longer the tabs that will come back.

### X15. The studio tab bar is half the WAI-ARIA tabs pattern

`StudioTabBar.tsx` has the tab half and none of the panel half. Measured 2026-09-13: `:98` is
`role="tablist"` with `aria-label="Editor tabs"`, `:150-153` gives every tab `role="tab"`,
`aria-selected` and a roving `tabIndex`, and `:72-79` implements Arrow, Home and End activation. No
tab carries `aria-controls`, and no element in either shell carries `role="tabpanel"`: the region
the tabs actually govern is the bare `<main className="flex-1 overflow-hidden relative">` at
`src/components/Studio.tsx:777` and at `src/workspace/StudioWorkspace.tsx:494`.

So a screen reader announces the tab and its selected state and can never say which region the tab
governs, and there is no way to move from a tab to its content.

The basis for the "nowhere in `src/`" form of this claim has moved and the entry says so rather than
repeating it: `grep -rn 'tabpanel' src/` now returns exactly one hit,
`src/components/object-source/ObjectSourceView.tsx:347`, which is the Source view's own part
switcher added by #789. The pattern is bare on purpose: that role is written as an object property,
`{ role: "tabpanel", ... }`, and never as a JSX attribute, so grepping the attribute form matches
nothing, which would read as an absence that is not there. The switcher is the complete pattern,
including the rule the studio bar will need: only the SELECTED tab may carry `aria-controls`,
because only the active panel is in the tree and a reference to an absent element is an
`aria-valid-attr-value` violation of its own.

It is not a one-line fix, which is why it is here. The panel is ONE element shared by every tab, so
its `id` has to key on `activeTabId`, and the same element is the mount point for the schema diagram
overlay, which is not the tab's content at all. Both shells render the bar, so the fix lands twice
and is verified twice.

**Done when:** the editor region carries `role="tabpanel"`, an id derived from `activeTabId` and
`aria-labelledby` naming the selected tab, the selected tab alone carries the matching
`aria-controls`, and both shells are checked, since a UI change verified in one is not verified in
the other.

### X16. Opened at `127.0.0.1`, the dev server serves a page that never becomes interactive

MEASURED on 2026-09-13 against Next.js 16.3.4 with Turbopack, in two independent browsers
(Playwright's Chromium and Chrome over CDP), while doing the browser QA for #789.

`bun dev` prints `http://localhost:<port>`. Open the SAME server at `http://127.0.0.1:<port>`
instead and the page renders its server HTML and then does nothing at all: no button responds, the
login form submits natively to `/login?` and clears itself, and `POST /api/auth/login` is never
made. `Object.keys(document.querySelector('#email'))` carries no `__react*` key, so React never
hydrated. The only console output is one repeated
`WebSocket connection to 'ws://127.0.0.1:<port>/_next/hmr' failed: Error during WebSocket
handshake: net::ERR_INVALID_HTTP_RESPONSE`.

THE CAUSE IS THE DEV SERVER'S OWN ORIGIN CHECK ON THAT SOCKET, isolated with a control rather than
inferred. The same upgrade request, differing only in one header, run from the shell:

| Request to `/_next/hmr` | Answer |
| --- | --- |
| no `Origin` header | `HTTP/1.1 101 Switching Protocols` |
| `Origin: http://localhost:<port>` | `HTTP/1.1 101 Switching Protocols` |
| `Origin: http://127.0.0.1:<port>` | the connection is closed with no HTTP response at all |
| `Origin: http://192.168.1.66:<port>` | the connection is closed with no HTTP response at all |

That empty answer is what the browser reports as `ERR_INVALID_HTTP_RESPONSE`, and the dev client's
bootstrap does not survive it. The chain closes both ways: served by the same process at the same
moment, `http://localhost:<port>/login` hydrates and `http://127.0.0.1:<port>/login` does not.

Next 16 has a configuration key for exactly this and this repository sets none:
`grep -rn 'allowedDevOrigins' src/ next.config.ts` returns nothing. The production path is
unaffected, measured: `bun run build` plus `bun run start` hydrates at `127.0.0.1` and every part of
#789's browser pass ran there.

It is filed rather than fixed because the value is a decision rather than a typo. The key names the
origins a developer's browser may drive the dev server from, so widening it widens a control Next
added deliberately, and `127.0.0.1` and a LAN address are not the same call. The cost of leaving it
is a developer who types the loopback address, or opens the LAN URL `bun dev` also prints, meeting a
dead page with one obscure console line.

**Done when:** `bun dev` opened at `127.0.0.1` and at the LAN address the banner prints is
interactive, either by configuring `allowedDevOrigins` or by not printing a URL that does not work,
and a note in `docs/TOOLCHAIN.md` records which and why.

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

### X18. The add-connection button has no accessible name

MEASURED 2026-09-13 in a browser: the icon-only button beside `Show ERD Diagram` carries no `title`, no
`aria-label` and no text content, while its neighbour carries one.

`jsx-a11y` is a hard oxlint gate in this repo and this survived it, so the finding is two things: the
button, and the fact that the rule in force does not cover an icon-only button with an SVG child. Fixing
only the first leaves the next one to be found by hand.

**Done when:** the button has an accessible name, and the lint rule that should have caught it either
covers this shape or is recorded as not covering it.

### X19. A body the framework truncated is reported as an empty body on five routes and as a parser error on a sixth

Next 16.3.4 CLONES every request body for middleware, and this repository has middleware (`src/proxy.ts`),
so `DEFAULT_BODY_CLONE_SIZE_LIMIT` in `node_modules/next/dist/server/body-streams.js` applies to every
route. It TRUNCATES at exactly 10,485,760 bytes rather than refusing, and `next.config.ts` sets no
`middlewareClientMaxBodySize`.

MEASURED and bisected on 2026-09-14 against `POST /api/db/query`:

```
body 10485760 bytes -> HTTP 200, the statement ran
body 10485761 bytes -> HTTP 500 {"error":"Expected ',' or '}' after property value in JSON at position 10485760 ...","code":"INTERNAL_ERROR"}
body 10485900 bytes -> HTTP 500 {"error":"Unterminated string in JSON at position 10485760 ...","code":"INTERNAL_ERROR"}
```

The server log names it in Next's own words: `Request body exceeded 10MB for /api/db/query. Only the
first 10MB will be available unless configured.`

So one condition gets two wrong answers. The five existing object routes that go through
`handleObjectRequest`'s body-parse arm answer HTTP 400 `{ "error": "Empty request body" }` for a body that
was neither empty nor malformed, and `POST /api/db/query` answers HTTP 500 with a JSON parser's sentence.
Neither tells the caller their request was too large.

The two routes added by #789 Phase 3 do NOT inherit this: `readBoundedJson` reads `content-length` and
answers 413 above `EDIT_BODY_BYTE_LIMIT` (8,388,608), which sits below the framework's wall, so an
oversized edit body meets a sentence that names the size. They do not fix it anywhere else, and that is
stated in `readDefaultBody`'s own docblock.

**Done when:** a body above the framework's clone limit gets one answer that names the size, on every
route, rather than an empty-body claim on five and a parser error on one.


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
`BottomPanel.tsx` hides the tab wherever `capabilities.explainFormat` is absent - 7 of the 16
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

---

### REL4. `backlog-structure.test.ts` scans gitignored files, so a local draft fails a gate CI cannot

The citation scan globs `docs/**/*.md` and reads whatever is on disk. `.gitignore:133` excludes
`docs/superpowers/`, where plans, specs and run reports are written during a working session, and
those drafts cite backlog ids freely. So `bun run test` goes red on a maintainer's machine over
files that are not in the repository, while CI, which checks out only tracked files, is green on the
same commit.

Measured while cutting 0.16.0: six citations across four untracked report files failed
`every cited entry exists`, and the whole suite had to be re-run with `docs/superpowers/` moved
aside to get a coverage number. The failure names the untracked path, so it is diagnosable, but it
costs a full run to discover and it trains the reader to treat a red suite as noise, which is the
real damage.

`tests/unit/agent-documentation.test.ts` asks the same question of `docs/AGENT.md` alone and does
not have the problem, because it names one file rather than a glob.

**Done when:** the scan enumerates tracked files, for example by driving the glob through
`git ls-files` and intersecting, so a working tree with local drafts under `docs/` gives the same
verdict as a clean checkout. The scan's own floor assertion (`scanned.length > 200`) stays, so a
broken enumeration still fails loudly rather than passing vacuously.

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

### C11. The published SBOM carries no component for the bundled Node.js runtime

#584 gave `SECURITY.md` a hand-maintained **Bundled Node.js runtime** table: the pinned version, the
dist URL, the three artefact filenames, both fetch scripts, the sha256 digests pinned in-repo, the
licence, and which artefacts ship it and which do not. That closed C7, whose Done-when accepted "a
sibling document" or "a hand-maintained component entry", and a person reading the policy now finds
the runtime.

A machine still does not. The `sbom` job in `.github/workflows/release-artifacts.yml` runs
`trivy fs --scanners license` over the repository, and its own verify step names the three ecosystems
it expects to find: `bun.lock`, `packaging/windows/launcher/go.mod` and
`desktop/src-tauri/Cargo.lock`. A shell script that curls a tarball is not a lockfile and appears in
none of them. So anything that consumes the document rather than the prose - a downstream policy
gate, a procurement questionnaire, a customer's own Dependency-Track - still sees a distribution
whose largest single binary is absent. `SECURITY.md` scopes its claim honestly, to "the dependency
closure of" those artefacts, so this is missing coverage rather than a false statement.

Two seams already exist, which is why this is small. The version and the digests are machine-readable
in one place per platform, `NODE_VERSION` and `NODE_SHA256_*` in `packaging/linux/fetch-node.sh` and
`packaging/windows/fetch-node.sh`, and #584's drift guard
`tests/unit/bundled-node-runtime-docs.test.ts` already reads them, so a generator needs no new source
of truth. The job also already rewrites the generated document with Node, in "Name and version the
SBOM's root component", and then asserts properties of it in "Verify the SBOM describes something" -
so both the injection point and the place a guard belongs are written.

One shape question is open rather than settled: whether the runtime becomes a `library` component
with a `pkg:generic` purl and a sha256 `hash`, or a nested component under the root. Decide it
against what a consumer keys on, because the root-component patch above exists for exactly that
reason - it was written because Dependency-Track keys a project by name plus version, and an
unversioned root collapsed every release into one project.

**Done when:** the published SBOM carries the bundled runtime as a component with its version and
sha256, read from the `fetch-node.sh` pins rather than typed a third time, and the release job fails
when those scripts move and the document does not.

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

### A6. SQL Server's agent plan cannot be weighed, because the editor has no strategy to key it to

The SQL Server agent profile asks the optimizer for an estimating plan as a session MODE - `SET
SHOWPLAN_ALL ON`, which must be the only statement in its batch and must be turned off again on the
same connection - and `ReadOnlyStatementMode`'s `"estimate-plan"` exists to carry exactly that.
`src/lib/explain` cannot express it: every strategy there builds a single-statement PREFIX
(`select-prefix.ts`), so `MSSQLProvider.getCapabilities` still answers `supportsExplain: false` (#126)
and the editor's Explain button stays hidden on this engine.

Two agent-side consequences follow from the same missing half, and both are the honest reading rather
than a defect. `ExplainFormat` has no SQL Server member, so the plan the run holds travels with
`format: undefined`; `summarisePlan` finds no `PLAN_READINGS` arm and answers `{ access: "unknown" }`;
and `planRefusal` in `auto-execute.ts` falls through to `unverified-dialect`. So `inspect_plan`
answers, the model reads the plan and recommends against it - measured, it recommended a nonclustered
index off a Clustered Index Scan - and auto-execute never hands a result over on the plan's strength.
DuckDB already ships in that state for the other reason: `duckdb-json` IS an `ExplainFormat` and has
no reading either.

**Done when:** a SQL Server EXPLAIN strategy exists that a session mode can be expressed through
(#126's dialect wrapper), and `plan-summary.ts` gains a reading verified against a real
`SET SHOWPLAN_ALL` result set, in the same change. Either half alone is worse than neither: a button
with no reading gives the editor a plan the agent still cannot weigh, and a reading with no
`ExplainFormat` member has nothing to key on.

### A7. The agent's byte budget TOTAL is measured after the result exists, on every engine that has one

SQL Server is the engine that makes this visible, because it is the first whose result budget is the
SERVER's.
`queryReadOnly` issues `SET ROWCOUNT <maxResultRows + 1>` before the statement, so the result arrives
already bounded in rows, and `SET TEXTSIZE <maxResultBytes + 1>` beside it, so no single VALUE arrives
whole either.
In both the `+ 1` is what keeps a cut detectable rather than silent, and the value half is checked in
the server's own unit by `assertNoValueWasCut`, because `SET TEXTSIZE` counts wire bytes while the
budget counts UTF-8, which `docs/providers/mssql.md` §12.5 carries the measurement for.
The other three do neither: PostgreSQL, SQLite and DuckDB compare `rows.length` and then
`measureResultBytes(rows)` against the budget after the driver has materialised everything.

What is left is the TOTAL, and it is post-hoc on all four.
`resultBytes > budget.maxResultBytes` is measured on a result that already exists, and a row budget
bounds row COUNT while a value ceiling bounds one VALUE, so rows times values can exceed
`maxResultBytes` before the sum is taken: many rows of moderate `varbinary(max)` or `nvarchar(max)`
values are materialised in the Node process before the cap can refuse them.
On the other three engines that same check is also all there is for a SINGLE large value, so both
halves are post-hoc there.

Measured while building the SQL Server profile, and the reason the row half was worth doing at all:
without `SET ROWCOUNT` one 20-million-row cross join took the Node process down with an
out-of-memory crash before any result-side cap looked at it, and `requestTimeout` did not prevent it,
because tedious stops the request timer on the first data packet.
With `SET ROWCOUNT 1001` the same statement returned 1001 rows in 6 ms.

Still not a SQL Server entry, and the per-value fix is the reason rather than a counter-example to it.
That fix went in per provider because SQL Server is the only one of the four with a server-side lever
for a value, and it closed the single-value half on one engine without touching the total on any.
The total is a property of how a result is READ rather than of any one value, none of the four offers
a lever for it, the ceiling is one number in one policy (`ExecutionBudget`), and the shape is
identical in all four `queryReadOnly` implementations - so spelling what remains four different ways
would be four truncations of one rule.

**Done when:** the byte ceiling is enforced while the result is read rather than after it is held -
a streaming read that stops at the ceiling - in every provider that implements `queryReadOnly`, so
that the budget bounds memory rather than reporting on it.
On SQL Server that is the total alone, since `SET TEXTSIZE` already bounds each value; on PostgreSQL,
SQLite and DuckDB it is both.

### A8. SQL Server's admitted SELECT reaches server-level metadata, which is A3 on a third engine

A3 records that neither agent profile bounds what an admitted statement may READ with a
database-native control. SQL Server joins it, and is the first where the surface left open is the
SERVER rather than the database.

The least-privilege principal this profile requires - `db_datareader` plus `VIEW DEFINITION`,
`VIEW DATABASE STATE` and `SHOWPLAN`, which `docker/mssql-init/02-agent-principal.sql` creates -
cannot reach another user database and cannot reach the file system. Measured on SQL Server 2022
(16.0.4265.3): a read of a second user database answers "The server principal is not able to access
the database under the current security context", and `OPENROWSET(BULK …)` is refused outright. What
it can still read is what `public` can, and every principal is a member of `public`: from the
connected database, a three-part name reached `master.sys.databases` (9 rows, every database on the
instance, the same 9 `sa` sees), `master.sys.server_principals` (21 of the 33 rows `sa` sees) and
`master.dbo.spt_values` (2574 rows). The admission step sees an ordinary one-statement `SELECT` in
each case, because that is what it is, and the policy layer's declared-target allowlist reads SQL -
defense in depth, which is A3's own distinction.

Not closable by narrowing the grants in that fixture. `public`'s read of `master` is the instance's
default rather than something this profile hands out, so the lever is a `DENY` on those views for the
agent login, and that is an instance-level change belonging to an operator's deployment rather than
to a provider.

**Done when:** A3's answer covers SQL Server as well - out-of-scope reads refused by something that
does not read SQL. The per-target grant set A3 proposes is the nearest fit here, generated for the
agent principal and paired with the `DENY` above, and `docs/providers/mssql.md` is where an operator
has to meet it.

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

### B65. `retryUnreadStop` subsumes `retryEmptyTurn`, so one entry's `false` decides nothing

The gate asks whether the run CALLED anything (`!anyToolCalled`) and never what it said, so an
empty completion reaches it as readily as the question it was measured on. A model carrying both
switches therefore spends two extra turns rather than one, and a model carrying only this one has
its `retryEmptyTurn: false` overridden by a switch that argues for something else.

Live on `nemotron3:33b`, whose entry records `retryEmptyTurn: false` and whose empty turns are
asked again anyway — and, since the gate began reading `answersUnreadStop` rather than
`retriesUnreadStop`, on every model with no entry at all, which is the same subsumption over a
wider set. Pinned as it behaves in `tests/isolated/agent-investigation.test.ts` rather
than repaired, because the repair — narrowing the gate to a turn with text in it — changes the
behaviour the five passing query-optimization runs were measured under, and this repository does
not move a measured cell without re-measuring it.

Free either way: `compose_report` is one of the tools `anyToolCalled` counts, so a run reaching
the gate has already earned `no-report`. What is wrong is the record, not the cost — a reader of
the entry cannot tell what the model is actually driven with.

**Done when:** the gate tests the stopping text and the affected cells are re-measured, or the
two switches become one setting whose name covers both stops.

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

### B78. Generated Redis and LibreDB command text carries em dashes

House style forbids em and en dashes in anything that lands in the repo or in front of a user.
`src/lib/query-generators.ts` emits five of them into text a user reads in the editor, reproduced in
the browser on a live Redis 8 during task 28b by pressing Generate Command on a key-prefix row:

    # Redis commands for "bulk:*" — select a line and Run Selected.
    # List keys under this prefix — ONE scan iteration, not the whole set.
    # Create or update it — this overwrites an existing value

plus `:229` for the hash variant and `:411` for the LibreDB header. Eleven more sit in that file's
doc comments. Pre-existing rather than #789's, and named here because task 27 found it and it would
otherwise disappear: it is not one edit but a small sweep, and
`tests/unit/lib/query-generators.test.ts` pins the exact strings.

**Done when:** no emitted line in that file carries an em or en dash, and its tests assert the new
wording.

### B80. The inventory's two bounds do not reach the container enumeration

`POST /api/db/objects/inventory` bounds the listings it issues (`INVENTORY_PAIR_LIMIT`) and the
objects it returns (`INVENTORY_LIMIT`), and its own docblock says so. Neither reaches the walk that
produces the containers in the first place. `enumerateContainers`
(`src/lib/db/container-walk.ts`) calls `listContainers()` once at the top level and then once per
parent at every level below, with no cap: a two-level engine holding 5,000 catalogs issues 5,001
round trips before the first pair exists, and only then meets a limit. The pair limit truncates the
SCAN, never the walk.

Not invented here, because `container-walk.ts` has a second reader: the agent's grounding inventory
(`src/lib/agent/tools.ts`) performs the same walk from its run context. A cap belongs to both or to
neither, and it needs the `truncated` shape the route already publishes, so it is one decision
rather than a number chosen at one call site. The route's docblock states the gap where it bites.

**Done when:** the walk reports a bound the same way a saturated scan does, both readers carry it,
and a test drives an engine whose top level exceeds the cap.

### B79. A connection switch reads the new connection with the old engine's container depth

Reproducible in a browser in one click. Select a depth-0 connection (SQLite), then a depth-2 one
(DuckDB): the first request the tree issues is `POST /api/db/objects/counts` with
`{"connectionId":"seed:t28b-duckdb","container":[]}`, which answers HTTP 400 "A DuckDB container
path is [database] or [database, schema], received []". The tree then re-reads correctly and the
final paint is right, so nothing is visible to the user; the 400 is in the server log on every such
switch.

The cause is a one-commit prop skew rather than anything in the tree: `Sidebar` renders `ObjectTree`
with `activeConnection` and `metadata`, `useProviderMetadata` clears its metadata in an EFFECT, and a
child's effects run before its parent's - so the tree's reconciler fires once with the new connection
and the previous engine's `capabilities`. `Sidebar`'s own comment reasons about metadata being
ABSENT ("Nothing is drawn while the declaration is missing") and not about it being STALE.

Pre-existing in shape and newly consequential: while the sidebar only listed tables, a stale
capability object cost nothing, and now the request SHAPE is derived from it.

**Done when:** no read is issued for a connection whose declaration has not arrived, proven by a test
that switches between two engines of different depth and asserts what was posted.

### B81. A failure nobody attributed leaves the browser asserting that the server serves no seeds

B37 landed and left this file; its id survives in the comments on `src/hooks/use-connection-payload.ts`
and `src/hooks/use-connection-manager.ts`, which is where the reasoning below can be read against the
code. It gave `ServedSeeds` a way to say "I do not have the seed list", and then gave the state an
initial value of `{loaded: true, seeds: []}` under the name `NO_SERVED_SEEDS`, commented as
"loaded, and genuinely empty". Before the first answer arrives nothing has been measured, so that
value is a claim the browser is not entitled to, and it is the claim B37 was filed about.

Measured on 2026-09-15 by driving the whole path with a gateway error page, the shape
`tests/hooks/use-connection-manager.test.ts` already pins as intended:
`GET /api/connections/managed` answers 502 with `text/html`, no `reason` is read from the body, so
`setServedSeeds` is never called and the state is still the module constant by identity.
`initializeConnections` then falls back to `storage.getConnections()`, the user's editable seed copy
renders, and `resolveAgentRunConnectionId` answers `{id: null, reason: "browser-only"}`. The rail
says, of a connection this application seeds itself:

> Sample (Employees) cannot be rebuilt on the server: its settings live in this browser.

That is B37's sentence, false in both halves, reached through a proxy instead of a malformed
`seed-connections.yaml`. The hook's own comment says such a failure "says nothing" about the seed
configuration; leaving the state at `{loaded: true, seeds: []}` is not saying nothing, it is saying
the list is empty.

The 404 arm is right by accident rather than by design: where the route does not exist at all, as in
the platform embed, there is no seed service and no seeds, so "loaded, empty" is the true answer.
Only a third state can hold both that and "asked, and the answer told me nothing".

Two tests on the same subject cannot see this, and one of them is the reason it reads as deliberate.
`tests/hooks/use-connection-manager.test.ts` waits on `connections` reaching `[]` and then asserts
`servedSeeds` equals `{loaded: true, seeds: []}`, for the 404 arm and for the 502 arm. Both are the
initial values, and with an empty `localStorage` neither moves on either path, so both tests pass
against a hook that never issues the request. They pin the initial state under the name of a
measured one. There is no honest barrier to wait on there while the settled value and the unasked
value are the same object shape, which is the same defect one level up.

**Done when:** an unasked seed list is distinguishable from a measured empty one, a non-OK the
server did not attribute leaves the browser in the unasked state rather than the empty one, and the
two tests above wait on a fact that a hook which never fetched cannot satisfy.
