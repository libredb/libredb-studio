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
- [Drivers and connections](#drivers-and-connections) — D1-D125, U17 · 70
- [Value interpolation](#value-interpolation) — V1
- [Row editing](#row-editing) — R1–R3 · 3
- [Studio UI and query execution](#studio-ui-and-query-execution) — X2-X19, U2-U52 · 40
- [Dependencies](#dependencies) — P1–P5 · 5
- [Documentation](#documentation) — DOC3–DOC7 · 4
- [Release pipeline](#release-pipeline) — REL1–REL4 · 4
- [Chart configuration surface](#chart-configuration-surface) — N1 · 1
- [Security Phase 1 deferrals](#security-phase-1-deferrals) — H1–H12 · 3
- [Security Phase 2 deferrals](#security-phase-2-deferrals) — C3–C11 · 7
- [Security Phase 3 deferrals](#security-phase-3-deferrals) — K4
- [Security scanner triage](#security-scanner-triage) — SCAN1 · 1
- [Agent M1 deferrals (#328)](#agent-m1-deferrals-328) — A1–A8 · 7
- [Agent M2 deferrals (#329)](#agent-m2-deferrals-329) — B2-B89 · 30

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

### D98. What the other five drivers hand back for a 64-bit integer, measured

D18 names two engines that lose digits and three that keep them as strings. Which side the rest of
the family falls on was never measured, and the gap read as the same defect, unrecorded, on five
more engines. Measured 2026-09-19, each through the seam the product itself uses - the ClickHouse
HTTP transport, the Cassandra driver transport, `openDuckDBClient`, `mssql` under the options
`buildConfig` sets, and `oracledb` with the only settings `oracle.ts` applies
(`OUT_FORMAT_OBJECT`, and no `fetchAsString` for a NUMBER) - over a table holding 9007199254740993
beside its neighbour 9007199254740992:

| Engine | Declared | What the driver hands over for 9007199254740993 |
| --- | --- | --- |
| Oracle AI Database 26ai Free 23.26.3.0.0, oracledb 6.10.0 | `NUMBER(19,0)` | `9007199254740992`, a JS number - the NEIGHBOURING row's key |
| SQL Server 2022 CU27 (16.0.4295.3), mssql 12.7.2 | `bigint` | `"9007199254740993"`, a string |
| the same | `numeric(38,0)` | `1.2345678901234568e+37`, a JS number |
| DuckDB v1.5.5, @duckdb/node-api 1.5.5-r.4 | `BIGINT` | `"9007199254740993"`, a string |
| ClickHouse 26.8.6.5 | `Int64` / `UInt64` | `"9007199254740993"` / `"18446744073709551615"`, strings |
| Apache Cassandra 5.0.9, cassandra-driver 4.9.0 | `bigint` / `varint` | `"9007199254740993"`, strings |

Three of the five hand every 64-bit integer back as its digits, and each by a deliberate setting
rather than by luck: the ClickHouse transport sends `output_format_json_quote_64bit_integers=1` and
its comment says what happens without it, DuckDB is read with `getRowObjectsJson()`, which prints
BIGINT, HUGEINT and DECIMAL as decimal strings, and the Cassandra adapter stringifies `Long`,
`Integer` and `BigDecimal` for fidelity. SQL Server loses nothing on `bigint` either - tedious hands
one over as text of its own accord - and rounds only its decimal family. Oracle's `NUMBER` is the one integer key of the
five that reaches the grid already wrong, and that is D18, not a sixth thing. What the rounding
costs the row editor is now one case rather than two: a FRACTIONAL key out of a column declared
`NUMBER`, `decimal`, `numeric` or `money` is refused before the engine is asked, because the
declaration says the driver rounded it - `describeFraction` and `EXACT_DECIMAL_TYPE_NAMES` in
`src/hooks/use-inline-editing.ts`, measured 2026-09-19 on Oracle 26ai Free and SQL Server 2022 CU27.
The key whose digits round to a WHOLE number is still open, and that is R3.

**What is new is that one sentence in the tree is false.** `docs/providers/mssql.md` §5.3 says
`BIGINT`, `DECIMAL`/`NUMERIC` and `MONEY` "are surfaced as JavaScript `number`s and can **lose
precision** beyond 2^53". §5.4 of the same document says the opposite about the first of them -
"`BIGINT` and `DECIMAL` reach the browser as strings" - and the measurement agrees with §5.4 for
`bigint` and with §5.3 for `numeric`. D18 repeats §5.3's reading in its own second paragraph. One
driver described two ways in one document is how a defect SQL Server does not have came to be
expected of it.

**Done when:** `docs/providers/mssql.md` states what tedious really hands over for each of those
four types, D18's `BIGINT` mention is corrected to match, and the three string-returning drivers are
recorded where a reader meets them rather than re-derived by the next sweep.

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
Amended 2026-09-23: the fix now exists twice, and the second copy is deliberate.
Amended 2026-09-25: the mapping now exists three times, the third in the Kafka provider (#1088), deliberate for the same reason.

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
behaviour the providers above need.

**A second implementation exists, by maintainer decision.**
The Prometheus provider (#1085, section 3.4) carries its own mapping and request path in `src/lib/db/providers/timeseries/prometheus/request.ts` (`tlsMaterialFor` and `createSendRequest`), with the same `rejectUnauthorized` rule, because that PR was decided to touch no other provider.
It is not a copy of the Couchbase helper: it adds what that helper lacks, an `AbortSignal` and timeout on every request, a streaming byte cap, and IPv6 literals passed through `url.urlToHttpOptions` (the Couchbase path fails on them, D104).
Neither follows a redirect: Prometheus refuses one on both paths through the shared `rejectRedirect` of `src/lib/db/http/endpoint.ts`, and Couchbase does on its `fetch` path since #1086, while its `node:https` path reports a 3xx as an HTTP failure (`docs/providers/couchbase.md` section 4.4).
So the consolidation this entry asks for now has two sources to reconcile rather than one pattern to copy, and the shared helper should start from the Prometheus shape, which is the superset, and adopt `rejectRedirect` on its TLS path as that shape does.

**A third mapping exists, by the same decision.**
The Kafka provider (#1088, section 3.5) maps the TLS panel in `tlsOptions` of `src/lib/db/providers/stream/kafka/connection-options.ts`, `ca`, `cert` and `key` from the panel and the same `rejectUnauthorized` rule, because that PR too was decided to touch no other provider.
It is a mapping only: the TLS connection is the Kafka client's own, over `node:tls`, so there is no request path to share, and it adds the server-name rule a Kafka client needs (SNI for a DNS host, none for an IP literal).

Not a defect in what any of them measures - it is a field the form offers and the transport
discards, which is the kind of silence a security setting must not have.

**Done when:** the TLS material mapping and the TLS request path exist once, outside any provider directory.
Couchbase and Prometheus both route through it and keep their own copies no longer, and Kafka takes its material mapping from it.
Every `fetch` transport that reads `ssl.mode` today (ClickHouse, Druid, Elasticsearch/OpenSearch, Trino, libSQL) routes TLS through it.
One test per transport pins that a supplied CA and a `verify-*` mode reach the request options, plus one that a `require` mode does not verify.

---

### D39. A slow-query source nobody could read is still a row, and on the other path it is silence

Found 2026-08-27 by the audit that closed the curated health projection's cap-as-count defect. #512
removed MySQL's fabricated "Performance schema not available" row; three providers still ship the
same shape, in the same field:

- `src/lib/db/providers/sql/postgres.ts:1241` - a database without `pg_stat_statements` answers
  `[{ query: "pg_stat_statements extension not enabled", calls: 0, avgTime: "N/A" }]`.
- `src/lib/db/providers/document/mongodb.ts:785` - a database whose profiler is off answers
  `[{ query: "Profiler not enabled. Run db.setProfilingLevel(1) to enable." }]`, and the outer catch
  at `:830` answers `[{ query: "Error fetching health info" }]` for a read that failed entirely.
- `src/lib/db/providers/sql/sqlite.ts:707-717` - EVERY SQLite database answers two synthetic rows,
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
reading the agent actually uses, `src/lib/db/providers/keyvalue/redis.ts:622-624` and
`src/lib/db/providers/document/mongodb.ts:1041-1043` `return []` from their catch where MySQL now
rejects. So a denied grant reaches the model as an empty reading, and the run prompt tells it
`"A reading that comes back EMPTY is an answer, not a failure - no blocked session, no slow query,
no unused index is what a healthy server looks like"` (`src/lib/agent/investigation.ts:1485`). It
also costs the operator the reason: `getMonitoringData` records `errors.slowQueries` from a REJECTION
(`src/lib/db/base-provider.ts:147`), and a resolved `[]` records nothing, so the panel says "no slow
queries" where the truth is that the profiler is off.

**Done when:** a slow-query source that could not be read is absent-with-a-reason on both paths - no
provider answers a sentence as a row, and no provider answers `[]` for a read that failed - and the
count of type-ids the type change touched is stated in the PR rather than discovered during it.

### D44. `databaseSizeBytes` is fabricated as 0 wherever the size is unknown, in 11 of 18 type-ids

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
  `sql/oracle.ts:1154`, `sql/sqlite.ts:794`.
- Coerced by a helper that returns 0 for an absent row: `sql/druid/introspect.ts:578` and
  `sql/clickhouse/index.ts:833` through their local `asNumber`.
- Coerced inline: `sql/postgres.ts:1360` and `sql/mysql.ts:1158` (`parseInt(... || "0")`),
  `sql/libsql/introspect.ts:399` and `document/couchbase/index.ts:606` (`?? 0`),
  `keyvalue/redis.ts:590`, and `embedded/libredb.ts:709`, whose `fileSizeBytes()` returns 0 when the
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
Prometheus, the eighteenth type-id (#1085), leaves the key absent too (`overviewFrom` in `src/lib/db/providers/timeseries/prometheus/monitoring.ts`), so the eleven that fabricate are eleven of eighteen.

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
`postgres.ts:1287` returns `"public." + escapeIdentifier(target)`, and
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

`src/app/api/db/profile/route.ts:132-133` casts every column with `${safeCol}::text` to take
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

Sixteen of the eighteen shipped type-ids read object source, fifteen since #789 and `prometheus` since #1085,
measured by the census in `tests/isolated/object-source-declarations.test.ts`; druid and libredb are
the two that read none.
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
re-read: an unconditional re-read costs a round trip on every engine and changes the
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

One sentence in the tree contradicts this entry, and it is the reason the entry is easy to lose.
`flavourFor`'s docblock (`src/lib/db/providers/sql/mysql.ts:1189`) says that defaulting to MySQL
"costs two folders a MariaDB user regains the moment the connection is live". Nothing re-reads
capabilities once a connection opens, which is this entry's whole subject, so a reader who meets that
sentence first concludes the gap closes itself and stops looking. It is on `origin/main` and
untouched by the object-tree work, and it is corrected here rather than in an entry of its own
because the sentence and the defect have one repair.

**Done when:** a MariaDB connection draws its Packages and Sequences folders in both shells, or the
provider doc says which surface cannot have them and why, and `flavourFor`'s docblock no longer says
the two folders come back when the connection is live.

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
guards, holds for ten of eighteen type-ids only, `prometheus` the tenth since #1085.

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
| `postgres.ts:917` (`queryReadOnly`) | `docs/AGENT_GUIDE.md:925` | 2396 |
| `postgres.ts:891` (`BEGIN READ ONLY`) | `docs/AGENT_ANALYST_DESIGN.md:400`, `:718` (file later deleted) | 2415 |
| `postgres.ts:894` (`SET LOCAL statement_timeout`) | `src/lib/agent/tools.ts:1552` | 2418 |
| `postgres.ts:2070-2074` (`{ ...baseConfig, connectionString }`) | `src/lib/db/connection-fingerprint.ts:67`, `tests/api/db/objects/edit-apply.test.ts:91`, `tests/unit/lib/db/connection-fingerprint.test.ts` x3 | 2256-2262 |
| `postgres.ts:1241` (`pg_stat_statements extension not enabled`) | `docs/BACKLOG.md:326` | 4001 |
| `postgres.ts:1287` (`"public." + escapeIdentifier`) | `docs/BACKLOG.md:467` | 4048 |
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

`grep -rl 'mock.module("@/lib/auth"' tests/` returns exactly 39 hits, re-measured 2026-09-23. Seven of
them spread the real module and replace one function (`{ ...realAuth, getSession: mockGetSession }`,
the agent routes' pattern). Thirty write out the same five-key object - `getSession`, `signJWT`,
`verifyJWT`, `login`, `logout` - down to the same `mock(async () => "mock-token")` for a token
nothing reads, and one of those thirty is `tests/helpers/object-edit-route-harness.ts`, a shared
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

### D99. The MariaDB flavour write is hand-copied into four declaration suites

`MySQLProvider` resolves its object kinds from a private `measuredFlavour` that `connect()` writes
from a server-version probe, so a suite that wants the MariaDB branch without a server writes the
private field through a cast.
Four files in `tests/isolated/` now carry the same `MARIADB_FLAVOUR` constant and the same
`(provider as unknown as { measuredFlavour: "mysql" | "mariadb" }).measuredFlavour = MARIADB_FLAVOUR`
line: `monaco-language-ids.test.ts`, `object-source-declarations.test.ts`,
`object-edit-declarations.test.ts` and `object-column-declarations.test.ts`.

Each of the first three disclosed the copy in its docblock rather than hoisting it, citing the
standing ruling that a second copy is disclosed and a helper is earned; the fourth followed suit
during the #789 column census and said so.
Four is past that point.
The cast is the part that matters: it names a private field's type in four places, so a rename of
`measuredFlavour` or a third flavour compiles everywhere and silently stops driving the MariaDB
branch in all four suites at once, and the census guards there would then be measuring MySQL while
their names say MariaDB.

Repro: rename `measuredFlavour` in `src/lib/db/providers/sql/mysql.ts` and run `bun run typecheck`.
The four casts still compile, because a cast through `unknown` asserts a shape rather than checking
one.

**Done when:** one helper beside `tests/helpers/census-connection.ts` owns the constant and the
write, the four suites call it, and the helper's own test fails when the private field it writes no
longer exists on the provider.

### D100. Five dead fixture arms in the SQL Server suite model a method that was removed

`tests/integration/db/mssql-provider.test.ts` dispatches its double on statement text, and five arms
answer for a `getSchema()` shape that no longer exists: `flat-tables`, `flat-columns`, `flat-pk`,
`flat-fks` and `flat-indexes`.
`src/lib/db/base-provider.ts` records that removal.

They were not merely dead, they were live and wrong.
During the #789 column census the single-object index statement fell into the `flat-indexes` arm,
which answers a canned `app_orders_total_ix` row for any object, and the suite fabricated an index on
`app.order_summary` the moment that object gained column rows.
The arm's guard was narrowed with `T.NAME AS TABLE_NAME`, the same fragment the neighbouring
`flat-pk` arm already uses, so the defect is fixed and all five arms are now unreachable.

Repro: delete the five `case` bodies and their five `if` guards and run
`bun tests/run-tests.ts tests/integration/db/mssql-provider.test.ts`.
If the suite is green, nothing reached them.

**Done when:** the five arms are gone, or the one that is still reachable is named with the statement
that reaches it, and the suite is green either way.

### D101. A `columnlessSamples` reason is not held to the bar `emptyKinds` sets

`tests/helpers/object-surface-conformance.ts` takes two exemption maps whose values are reasons a
person reads.
`emptyKinds` holds its reasons to a bar: a blank sentence is refused, and the verdicts in
`NOT_A_REASON` ("not applicable", "n/a", "none", "todo") are refused with a sentence saying to write
what is absent and why.
`columnlessSamples`, added by the #789 census so a provider may declare a kind has columns while a
fixture's sampled object has none, is checked only for having excused something.
So `columnlessSamples: { collection: "" }` and `columnlessSamples: { collection: "n/a" }` both buy the
exemption, and the invariant that a declared twisty never opens on nothing is then waived by a string
that states no fact.

Repro: in any provider suite whose expectation carries a `columnlessSamples` entry, replace the reason
with `"n/a"` and run that suite. It stays green.

**Done when:** a `columnlessSamples` reason passes the same blank and `NOT_A_REASON` checks
`emptyKinds` reasons pass, with the two negative cases asserted, and the two maps share one reason
checker rather than two copies of it.

### D102. PostgreSQL reports no primary key and no foreign key to a least-privilege role

`CTE_PK_INFO` and `CTE_FK_INFO` in `src/lib/db/providers/sql/postgres.ts` read
`information_schema.table_constraints`, which PostgreSQL defines as showing only constraints on
tables a currently enabled role owns.
A connection made as an ordinary `SELECT`-only role therefore sees every column and every index and
NO key at all, and the answer is a claim rather than an absence: `describeObject` returns
`isPrimary: false` on every column and `foreignKeys: []`.

That role is not a corner case, it is what this product recommends and what its own seed fixture
uses.
The blind spot predates the object tree and is not confined to it: both CTEs feed `OBJECT_DETAIL_SQL`
and the bulk statement beside it, so the ER diagram, the mobile schema explorer and the inventory's
`includeColumns` answer have carried it too.
What the object tree changed is that the key mark is now on screen, where an absent key reads as a
table without one.

Measured 2026-09-22 against PostgreSQL 18 holding `dvdrental`, `public.film`, tables owned by
`postgres`, probed through `POST /api/db/objects/describe`:

| Connected as | Columns | Primary key | Foreign keys |
|---|---|---|---|
| `postgres`, the owner | 13 | `film_id` | 1 |
| `libredb_agent`, `SELECT` only | 13 | none | none |

And at the catalog, as `libredb_agent`: `information_schema.table_constraints` answers 0 rows for
`constraint_type = 'PRIMARY KEY'` in `public` while `pg_constraint` answers 15, and
`information_schema.referential_constraints` answers 0 while `pg_constraint` answers 18 foreign keys.
`information_schema.columns` answers 128 and `pg_indexes` answers 32 to the same role, which is why
only the keys go missing.

The repair is `pg_catalog`, which `CTE_INDEX_INFO` beside them already reads, and it is not a local
edit: both statements run against every PostgreSQL wire-compatible engine this repo measures, and one
of them, Materialize, already needs the documented `constraint_column_usage` fallback that
`tests/integration/db/postgres-provider.test.ts` pins. So the change owes a live measurement on
Materialize, CockroachDB, YugabyteDB and RisingWave before it lands, which is why it is filed rather
than folded into #789's column work.

Repro: connect Studio to any PostgreSQL as a role that owns nothing and holds only `SELECT`, expand a
table in the object tree, and read the column rows. No key mark appears. Connect as the owner and it
does.

**Done when:** a `SELECT`-only role sees the same keys the owner sees, on PostgreSQL and on every
wire-compatible engine whose fallback behaviour was measured for the change, with a test that drives
the provider as a non-owner role rather than asserting the statement text.

### D103. `noAbstainingKinds` is enforced over the expectation's kinds, not the provider's declarations

`assertColumnDeclarations` builds `abstained` by walking `listings`
(`tests/helpers/object-surface-conformance.ts:595-603`), and `listings` holds only the kinds the
expectation gave a non-zero `want` (`:307-335`). The field's own docblock (`:195-200`) defines it
over something else: "This provider declares `hasColumns` on EVERY kind it has". A provider that
declares one kind without `hasColumns` and whose fixture happens to hold none of that kind is
therefore indistinguishable, to the guard, from a provider that has no abstaining kind at all, and
the refusal at `:643` tells the author to set a flag whose stated meaning that provider's own
declarations contradict.

It is worse than one wrong direction, and the control that shows it is the one worth keeping.
Omitting the declared abstainer from the expectation is refused too. A fake provider declaring
`table` (with columns, answering columns) and `trigger` (abstaining) throws the same
"listed no kind that abstains from hasColumns" whether `trigger` is listed with a `want` of 0 or left
out of `expected.kinds` entirely, and the only way to green it is to set `noAbstainingKinds`. So the
expectation has no form in which it can state the truth about that provider, and the guard's advice
is to record a falsehood.

No shipped engine trips it today, re-checked across all seventeen expectations: druid, mongodb and
libredb set the flag correctly, and Trino's only zero-counted kind, `materialized_view`, declares
`hasColumns` and so is not an abstainer. This is a guard that refuses a legal provider, not a live
red.
The eighteenth expectation, Prometheus's (#1085), does not trip it either: it lists all six kinds with a count, the five that declare no `hasColumns` among them.

Repro: take any expectation, add a kind the provider declares without `hasColumns` with a `want` of
0, run it, then delete that kind from `expected.kinds` and run it again. Both throw the same message.

Splitting the flag into two variables, the declaration fact and the fixture fact, is necessary and
not sufficient. After the split a declared-but-unlisted abstainer still runs the negative probe zero
times, which is the vacuity the flag was added against, so the complete repair needs a third state:
the probe ran, or the expectation says why it could not.

**Done when:** `abstained` is derived from the provider's own `objectKinds()` rather than from
`listings`, an expectation that omits a declared abstaining kind is refused by name instead of by the
flag's message, a flag set against declarations that contradict it is refused, and the negative
direction of invariant 8 reports whether it ran rather than only whether it could have.

### D104. A Couchbase connection over TLS cannot reach an IPv6 literal host

The TLS path of the Couchbase transport is `nodeRequestJson` in `src/lib/db/providers/document/couchbase/http-transport.ts`, and it is the only path once `buildTlsMaterial` returns material.
It builds the request options from `new URL(url)`, whose `hostname` keeps the brackets of an IPv6 host; since #1086 every Couchbase URL is built by `endpointUrl(httpOrigin(...))` of `src/lib/db/http/endpoint.ts`, which writes an IPv6 host bracketed as a URL requires, so `hostname` reaches `node:https` as `[::1]`.
`node:https` does not strip the brackets and resolves the whole string as a name, which no resolver knows.
A Couchbase node addressed by an IPv6 literal is therefore unreachable over TLS, while the same node over plaintext works, because plaintext goes through `fetch`, which reads the URL itself.
#1086 accepts an IPv6 host (`docs/providers/couchbase.md` section 4.4) and did not change this path, so such a host now passes validation and then fails here.

Found 2026-09-23 while designing the Prometheus transport (#1085, section 3.4), whose `request.ts` passes IPv6 literals through `url.urlToHttpOptions` for this reason.
Not fixed there: the maintainer's decision for that PR is that it touches no other provider.

Reproduced on node v24.14.0 and bun 1.4.2, from the repository root, with nothing listening on port 59999:

    bun -e 'import { nodeRequestJson } from "./src/lib/db/providers/document/couchbase/http-transport.ts"; for (const url of ["https://[::1]:59999/pools", "https://127.0.0.1:59999/pools"]) await nodeRequestJson(url, { method: "GET", headers: {} }, { rejectUnauthorized: false }).then((r) => console.log(url, r.httpCode), (e) => console.log(url, e.message));'

The IPv6 URL answers `Couchbase request failed: getaddrinfo ENOTFOUND [::1]`.
The IPv4 URL is the control: `connect ECONNREFUSED 127.0.0.1:59999`, so the request reached the network and only the name failed.
The engine fact underneath is the same on both runtimes: `https.request({ hostname: "[::1]", port: 59999 })` answers `ENOTFOUND` and `https.request({ hostname: "::1", port: 59999 })` answers `ECONNREFUSED`.

D37's consolidation removes this if the shared TLS path is built on the Prometheus shape, which already handles it; until then it is a defect of its own.

**Done when:** a Couchbase connection with TLS reaches a node addressed by an IPv6 literal, and a test drives `nodeRequestJson` against a local `node:https` server listening on `::1`, with the IPv4 case as its control.

### D105. `StorageStats.sizeBytes` and `TableStats.totalSizeBytes` are required, so an engine that measures no size publishes a zero

`StorageStats` in `src/lib/db/types.ts` declares `sizeBytes: number`, so a storage row carries a number even where the engine publishes no byte count for what the row names.
Trino writes `size: "N/A"` with `sizeBytes: 0` (`src/lib/db/providers/sql/trino/introspect.ts:877-878`), and since #1085 the Prometheus head-block row does the same, because neither its TSDB status nor its runtime information publishes a stored byte count.
The agent's `storage` reading forwards the field unchanged (`sizeBytes: store.sizeBytes` in `CURATED_READINGS`, `src/lib/agent/tools.ts`), so a model is handed a zero-byte store that nobody measured.
The search provider takes the other route and emits no storage row for a size it was not given (`toStorageStats` in `src/lib/db/providers/sql/search/index.ts`).
D44 is the same fabrication on `DatabaseOverview.databaseSizeBytes`, where the type already allows absence; here the type itself forbids it.

`TableStats` makes the same demand of a table row: `totalSize` and `totalSizeBytes` are required, while `tableSize` and `tableSizeBytes` are optional, so a table whose bytes nobody measured carries `totalSize: "N/A"` beside a `totalSizeBytes` of 0.
Six writers do that: `tableStatsFrom` in `src/lib/db/providers/timeseries/prometheus/monitoring.ts` on every row since #1085, and before it `buildTableStats` in `src/lib/db/providers/sql/sqlite.ts` without `dbstat`, `readTableStats` in `src/lib/db/providers/sql/libsql/introspect.ts` for a table `dbstat` did not size, the table stats in `src/lib/db/providers/sql/duckdb/introspect.ts` for a table whose blocks `pragma_storage_info` could not size, `src/lib/db/providers/embedded/libredb.ts` on every row, and `toTableStats` in `src/lib/db/providers/sql/search/index.ts` for a closed index, which writes `"0 B"` beside it.
The Tables and Storage tabs gate on the absent `tableSizeBytes` and draw "N/A", but the agent's `table-stats` reading does not: it forwards `totalSizeBytes: table.totalSizeBytes`, never projects `totalSize`, and passes `tableSize` and `tableSizeBytes` through as `undefined`, which its JSON rendering drops, so a model reads `"totalSizeBytes":0` beside `"indexSizeBytes":null`, the null the same reading writes for an index size nobody published.
So the premise `docs/providers/sqlite.md` states for that shape, that every consumer gates on the absent `tableSizeBytes`, is false for this reader.

Found 2026-09-23 while mapping the Prometheus storage row (#1085, section 6.2); the table half was found by the #1085 review the same day, through `inspectOperationsTool` over the real provider against the compose Prometheus, where all 50 rows reached the model as `"totalSizeBytes":0`.
Not fixed in #1085: making either field optional changes a type every provider writes, and the agent's two readings have to learn to carry an absence; neither is that PR's to change.
The table half has a remedy that needs no type change: the `table-stats` reading can forward `null` for `totalSizeBytes` wherever `tableSizeBytes` is absent, the gate the two tabs already apply, because every writer of a measured `totalSizeBytes` also sets `tableSizeBytes` today and every writer above leaves it out.

**Done when:** no provider writes 0 for a storage or table size it did not measure, `sizeBytes` can be absent, and the agent's `storage` and `table-stats` readings forward an absence as an absence, with a test on each reading beside "an index the engine published no size for reaches the model as null, not as zero" in `tests/unit/lib/agent/tools.test.ts`, and on each provider that stops writing 0.

### D106. The `node:https` request paths are tested under Bun only, while production runs them under Node

Production starts the server with `node server.js` (the `CMD` of `Dockerfile`), while `bun run test` runs every test file as a `bun test` process of its own (`tests/run-tests.ts`).
So the two `node:https` request paths, `request.ts` in `src/lib/db/providers/timeseries/prometheus/` and `nodeRequestJson` in `src/lib/db/providers/document/couchbase/http-transport.ts`, have their handshakes, refusals and error codes pinned against Bun's own implementation of `node:https` only.
The two runtimes differ at exactly that surface: measured 2026-09-23 through the Prometheus request path, a server that demands a client certificate and receives none surfaces as `ECONNRESET` under bun 1.4.2, which that path classifies as a network failure, and as `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` under node v24.14.0, a TLS failure.
The request test asserts only the refusal in that case, for that reason ("a client certificate reaches a server that asks for one" in `tests/unit/db/prometheus/request.test.ts`).
#1085 ran its TLS path under Node once, by hand, before merge; nothing keeps that true afterwards.

Found 2026-09-23 while writing the Prometheus TLS path (#1085, section 3.4).
Not fixed in #1085: running part of the suite under Node is a runner and CI change for every provider with a TLS path.

**Done when:** CI runs the `node:https` request tests of every provider that has one under Node as well as under Bun, and a test that depends on a runtime-specific error code says which runtime it expects.

### D107. A listed Prometheus metric can be left out of the bulk column read, and nothing says so

`describeObjects` in `src/lib/db/providers/timeseries/prometheus/objects.ts` describes the metrics one `/api/v1/series` read over the last hour returns, while `listObjects` names them from `/api/v1/label/__name__/values` over the same hour and `describeObject` reads one metric's columns from `/api/v1/labels`.
On Prometheus 3.13.3 the head block answers both label reads with no per-series time filter: `headIndexReader.LabelValues` and `LabelNames` in `tsdb/head_read.go` check only that the window overlaps the head as a whole.
The series read does filter, because `blockBaseSeriesSet.Next` in `tsdb/querier.go` skips a series with no chunk in the window.
So a metric whose series all stopped sampling before the hour, while the head block still holds them, is listed and `describeObject` answers its columns, yet the bulk read leaves it out and reports no `truncated`.
Both inventories then hold a listed metric with no columns and are not told why: `POST /api/db/objects/inventory`, whose details the app's schema read joins by path and fills with `columns: []` where one is missing (`detailedObjects` in `src/lib/db/detailed-object.ts`), and the agent's grounding walk, which does the same (`walkObjectInventory` in `src/lib/agent/tools.ts`).
`assertObjectSurface` in `tests/helpers/object-surface-conformance.ts` refuses exactly this shape, an untruncated batch that leaves out an object `listObjects` named, and no test reaches it, because every series of the compose server is live.

Found 2026-09-23 while writing the Prometheus object surface (#1085, section 4.2), from the upstream source at tag `v3.13.3`.
Not fixed in #1085: each remedy costs the inventory's read, which every connection select sends, a second request or a heavier one, and the compose server cannot hold a series that has been quiet for an hour inside a test run, so no remedy could be measured there.

**Done when:** over a head that holds a metric whose series stopped sampling before the window, the bulk read either describes that metric or marks the batch `truncated` with a sentence that says why, and a test holds that shape to `assertObjectSurface`.

### D108. One redirected listing fails the whole Elasticsearch or OpenSearch object count

`countObjects` in `src/lib/db/providers/sql/search/index.ts` reads the five kinds together and turns a failed listing into that kind's `unavailable` answer, but only for the transport's own error: anything that is not a `SearchTransportError` is rethrown (`:1189`).
Since #1086 the transport refuses a 3xx through the shared `rejectRedirect` of `src/lib/db/http/endpoint.ts` (`src/lib/db/providers/sql/search/http-transport.ts:1531`), and that throws a `ConnectionError`, outside the class the count catches.
So one listing a proxy redirects rejects the whole count with the redirect's message, where a refusal of the same listing marks only that kind and still counts the other four.

Reproduced 2026-09-23 through the provider's own `countObjects`, with `fetch` replaced and the pipeline listing answering a 302 and then, as the control, a 403, from the repository root:

    bun -e '
    import { ElasticsearchProvider } from "./src/lib/db/providers/sql/search/index.ts";
    const answer = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    const bodies = { "/_sql": { columns: [{ name: "1", type: "integer" }], rows: [[1]] }, "/_cat/indices": [], "/_alias": {}, "/_data_stream": { data_streams: [] }, "/_index_template": { index_templates: [] } };
    for (const pass of ["redirect", "refusal"]) {
      globalThis.fetch = async (url) => {
        const { pathname } = new URL(url);
        if (pathname in bodies) return answer(200, bodies[pathname]);
        if (pathname !== "/_ingest/pipeline") throw new Error(`unexpected request ${pathname}`);
        return pass === "redirect"
          ? answer(302, {}, { location: "https://sso.example.test/login?next=%2F_ingest" })
          : answer(403, { error: { type: "security_exception", reason: "no permissions" }, status: 403 });
      };
      const provider = new ElasticsearchProvider({ id: "es", name: "es", type: "elasticsearch", host: "127.0.0.1", port: 9200 });
      await provider.connect();
      await provider.countObjects([]).then((counts) => console.log(pass, JSON.stringify(counts)), (e) => console.log(pass, e.name, e.message));
    }
    '

The first pass prints `redirect ConnectionError The server answered HTTP 302, a redirect to https://sso.example.test, and redirects are not followed`.
The second prints `refusal` and the five counts, with the pipeline kind `unavailable` and the other four counted.

Found 2026-09-23 while writing the Prometheus object surface (#1085, section 4.3), whose count reports a redirect refusal on the kind whose listing met it.
Not fixed in #1085: the maintainer's decision for that PR is that it touches no other provider.

**Done when:** a redirected listing marks only its own kind `unavailable`, with the redirect's sentence, while the other kinds still count, and a test drives `countObjects` over a 302 on one listing with a 403 on the same listing as its control.

### D109. A Couchbase answer whose body cannot be read escapes the transport's error mapping, a refused redirect included

`fetchJson` in `src/lib/db/providers/document/couchbase/http-transport.ts`, the plaintext path, maps a failure of `fetch` itself to a `CouchbaseError` ("Couchbase request failed: ..."), but reads the body with `const text = await response.text()` after that `try`, and only then asks `rejectRedirect` about the status.
So a body that cannot be read, because the connection was reset after the status line, rejects with the runtime's own error, which is neither a `CouchbaseError` nor, for a 3xx, the redirect refusal.
96207f17 (#1086) moved that read ahead of `rejectRedirect` to drain a refused redirect's body, which is how a redirect whose body fails came to lose its refusal; a 200 whose body fails escaped the same way before it.
The provider then holds an unclassified `TypeError`: `mapDatabaseError` in `src/lib/db/errors.ts` answers a bare `DatabaseError` carrying the runtime's message, and through `connect()` it becomes a `ConnectionError` without the redirect sentence.
`hrana-transport.ts` in `src/lib/db/providers/sql/libsql/` has the same shape by reading, `const text = await response.text()` after the `try` that maps a `fetch` failure to a `LibSQLTransportError`; not measured.
The Prometheus request path reads its body inside a mapping of its own and releases a refused redirect's body unread (`sendPlain` in `src/lib/db/providers/timeseries/prometheus/request.ts`).

Measured 2026-09-23 on bun 1.4.2 against a loopback server that answers `302` with a `Content-Length` it never sends and then resets the connection: 200 of 200 requests through `CouchbaseHttpTransport.manage` rejected with `TypeError: The socket connection was closed unexpectedly.`, Bun's sentence for the reset.
The controls are the same server answering the 302 whole, which gives the redirect refusal (`ConnectionError: The server answered HTTP 302, a redirect to https://sso.example.test, and redirects are not followed`), and one resetting before any answer, which gives `CouchbaseError: Couchbase request failed: ...`.
From the repository root, one request per case:

    bun -e '
    import { createServer } from "node:net";
    import { CouchbaseHttpTransport } from "./src/lib/db/providers/document/couchbase/http-transport.ts";
    for (const mode of ["302 then reset", "302 whole", "reset first"]) {
      const server = createServer((socket) => socket.once("data", () => {
        if (mode === "reset first") return void socket.destroy();
        const head = `HTTP/1.1 302 Found\r\nLocation: https://sso.example.test/login\r\nContent-Length: ${mode === "302 whole" ? 2 : 4096}\r\n\r\n`;
        socket.write(head, () => (mode === "302 whole" ? socket.end("{}") : socket.destroy()));
      }));
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const transport = new CouchbaseHttpTransport({ id: "c", name: "c", type: "couchbase", host: "127.0.0.1", port: server.address().port, user: "u", password: "p" });
      await transport.manage("/pools").then(() => console.log(mode, "answered"), (e) => console.log(`${mode}: ${e.constructor.name}: ${e.message}`));
      server.close();
    }
    '

Found 2026-09-23 while writing the Prometheus request path (#1085, section 3.4), whose release of a refused redirect's body lost the refusal to the same reset, as a raw `TypeError`, until that release stopped rethrowing the runtime's error.
Not fixed in #1085: the maintainer's decision for that PR is that it touches no other provider.

**Done when:** a Couchbase or libSQL answer whose body cannot be read fails as that transport's own error, a 3xx is refused by `rejectRedirect` whether or not its body arrives, and a test drives each transport against a local server that answers a 302 and resets, with the whole 302 and a reset before any answer as its controls.

### D110. The response byte cap is not sized against the heap the image ships with

`RESPONSE_BYTE_CAP` in `src/lib/db/providers/timeseries/prometheus/http-transport.ts` bounds a Prometheus response at 32 MiB, and M12 confirmed it because it holds the largest representative answer four times over (1,930,719 decoded bytes, `tests/fixtures/prometheus/README.md`); it was never measured against the process that parses the body.
The image runs that process with `--max-old-space-size=384` (`NODE_OPTIONS` in the `Dockerfile`), and the chart's default memory limit is `512Mi` (`charts/libredb-studio/values.yaml`).
A body under the cap can exhaust that heap inside `JSON.parse`, before the transport decodes the envelope or the shaper applies any bound: measured 2026-09-23 on node v24.14.0, a 24,000,004-byte array of empty JSON objects aborted `node --max-old-space-size=384` inside `JSON.parse` with `Reached heap limit` and exit code 134.
`RESULT_BYTE_BUDGET` in `src/lib/db/providers/timeseries/prometheus/results.ts` bounds what a parsed answer shapes into, and nothing bounds the parse itself.

Found 2026-09-23 while measuring the result byte budget for #1085 (section 5.4).
Not fixed in #1085: re-deciding M12, or parsing under a bound on what the parse may allocate, is a transport change of its own, and the one process every user shares is the one the parse runs in.

**Done when:** the cap is re-measured against the 384 MiB heap and the chart's `512Mi` limit with the most expensive body shape under it, or the body is parsed under a bound on what the parse may allocate, and a test holds that bound.

### D111. MySQL's table statistics are the 100 largest tables of the schema, and no reader is told

`TABLE_STATS_SQL` in `src/lib/db/providers/sql/mysql.ts` ends `ORDER BY DATA_LENGTH + COALESCE(INDEX_LENGTH, 0) DESC LIMIT 100`, and `getTableStats` runs it for the connected schema, while `OVERVIEW_TABLE_COUNT_SQL` counts every base table of the same schema.
The provider declares no `tableStatsCaption`, the declaration `ProviderLabels` in `src/lib/db/types.ts` gives a ranked subset since #1085, so every reader counts the cut as the schema:
- the monitoring Tables tab (`src/components/monitoring/tabs/TablesTab.tsx`) titles the 100 rows "Tables", sums their rows and sizes as the "Total", and answers "No tables found." to a search for a table outside them;
- the Storage tab (`src/components/monitoring/tabs/StorageTab.tsx`) adds the 100 rows' table and index sizes as shares of the whole database size;
- the admin Operations tab (`src/components/admin/tabs/OperationsTab.tsx`) lists them as "Tables (100)" and answers "No tables found." the same way;
- the agent's table-stats reading in `src/lib/agent/tools.ts` hands a model "table statistics, 100 row(s)", under a row budget that never refuses 100.
So a schema of 150 base tables reads 150 on the Overview beside 100 on the Tables tab.
The PostgreSQL, SQL Server and Oracle table statistics sort without a cap, and `docs/providers/mysql.md` names no bound in its `getTableStats` row.
Read from the code on 2026-09-23, and rendered through the real Tables tab with MySQL's own labels and capabilities over 100 rows beside an overview count of 150: no caption and "Tables 100", with a declared caption rendering as the control; not measured against a live schema of more than 100 tables.

Found 2026-09-23 by the #1085 review.
Not fixed in #1085: a new provider changes no other provider's behaviour, and this is MySQL's.

**Done when:** MySQL's `getTableStats` returns every base table of the schema, or MySQL declares a `tableStatsCaption` that the Tables tab, the Storage tab, the admin Operations list and the agent reading each honour; `docs/providers/mysql.md` says which in its `getTableStats` row; and tests pin it, `tests/integration/db/mysql-provider.test.ts` at 101 base tables with 100 as the control and, on the caption route, a captioned MySQL-shaped cut in the Tables tab, Operations tab and agent reading tests.

### D112. The result byte budget bounds one Prometheus response, and nothing bounds how many wait to be sent

`RESULT_BYTE_BUDGET` in `src/lib/db/providers/timeseries/prometheus/results.ts` holds the rows and fields of one vector or matrix result to 16 MiB of JSON, and M14 confirmed it: in the image's runtime, `node:26.9.0-trixie-slim` with `--max-old-space-size=384`, under the chart's `512Mi` limit with no swap, one request at the budget completed while the rest of the process held 288 of the 384 MiB heap live (`tests/fixtures/prometheus/README.md`, M14).
`POST /api/db/query` answers with `NextResponse.json`, which builds its body with `Response.json`: the response holds the JSON text's UTF-8 bytes until the client's socket takes them, and nothing in the process bounds how many responses wait.
`QUERY_CONCURRENCY_LIMIT` does not: it is per connection, and its slot is released before the answer is shaped.
So a few slow readers of large results, on one connection or several, add a body of up to 16 MiB each to whatever the next request needs, and lowering the budget changes the size of each body, not their number.

Measured in M14 on 2026-09-23 with five answers shaped against the budget, from a vector whose series carry label names of their own to M3's subquery over the compose server's label sets: with 288 MiB held live, one more request completed beside 0 to 3 waiting responses of its own answer, 0 for that vector, and with nothing else live beside 8 to 13.
Each time, the run with one more waiting ended the process, killed at the memory limit or, for that vector with 288 MiB held live, out of heap, and in the product that process is the one every user shares.
An earlier full run the same hour differed from the recorded one by one response either way near those limits.

D110 is the same process's other unbounded cost, the parse of a body under the response byte cap.

Found 2026-09-23 by the #1085 review, while recording the result byte budget as a measurement.
Not fixed in #1085: bounding the bytes of responses in flight is a change to the query route, or to the server, for every provider, and the budget cannot bound it.

**Done when:** the process bounds the bytes of query responses waiting to be sent, or the budget is re-decided against such a bound, a test holds that bound, and M14 measures the waiting responses against it.

### D113. The notice naming a Prometheus series kept under `value` is outside the result byte budget, and grows with the whole answer's label names

When the matrix byte budget keeps one series under `value`, because the name that tells it from every series of the answer, written in every row, would not fit, one notice names it once (`namedOnce` in `src/lib/db/providers/timeseries/prometheus/results.ts`, `docs/providers/prometheus.md` section 5.2).
That name writes every label of the answer the series lacks as `name=""`, so its length grows with the label names of the series the bounds cut, and `RESULT_BYTE_BUDGET` counts only the rows and the fields, not the notices.
The shaper builds the same name to price the lone column whether or not it keeps it, so the notice adds its bytes to the response body rather than a new string to the heap, and the answer's own label bytes bound it, and through them `RESPONSE_BYTE_CAP`.

Measured 2026-09-23 through `shapeQueryResult` at the provider's own limits, over two raw series of 172,800 samples, 30 days at a 15 s scrape, that the cell budget cuts to one, followed by 100 one-sample series each carrying label names of its own.
At 300 names each, 6,978,238 bytes on the wire, the notice is 376,222 bytes as the route writes it, `{"message":...}`; at 3,000 names each, 10,931,238 bytes on the wire, it is 4,059,222 bytes; the rows and fields are 9,158,422 bytes in both.

Found 2026-09-23 by the #1085 review, while fixing the lone column under the byte budget.
Not fixed in #1085: the fix that added the notice fixed its text as well, and naming the series differently changes what the result reports.

**Done when:** the notice is counted in `RESULT_BYTE_BUDGET`, or bounded on its own, for example by naming the series with the labels it carries rather than every label it lacks, and a test in `tests/unit/db/prometheus/results.test.ts` holds it at a label union that would take the notice past that bound.

### D114. Through an SSH tunnel, a verifying TLS mode checks the certificate against `127.0.0.1`

`tunnelledConnection` in `src/lib/db/factory.ts` rewrites a tunnelled connection's host and port to the tunnel's local end, `127.0.0.1` and a local port, and keeps the real server under `TUNNEL_FAR_END` (`:260`).
No provider hands the far end's name to its TLS layer: nothing in `src/` sets `servername`, `serverName` or `checkServerIdentity`, and the only reader of `TUNNEL_FAR_END` is `src/lib/db/connection-fingerprint.ts`.
So `verify-system`, `verify-ca` and `verify-full` check the server's certificate against `127.0.0.1`, and a certificate issued to the server's own name fails with `ERR_TLS_CERT_ALTNAME_INVALID`.
Measured 2026-09-24 through the real tunnel client, factory and providers, against an in-process SSH bastion and a certificate whose only SAN was the server's DNS name: Prometheus, PostgreSQL (the `pg` driver against a TLS endpoint), ClickHouse (`verify-system`, under Bun's `fetch`) and the Couchbase REST helper all failed that way.
MSSQL, MongoDB, Redis, Cassandra and Oracle were read, not measured; MySQL and Oracle pass `verify-ca`, because that mode does not check the name there.
It fails closed, so no identity check is skipped, but it leaves a tunnel user who needs a working connection with `require`, which encrypts without verifying.
Over a tunnel the HTTP providers also send no SNI and a `Host` of `127.0.0.1:<local port>`, so a reverse proxy that routes by either can send the request elsewhere; that was observed as the headers sent, not measured against a proxy.

Found 2026-09-24 while checking the Prometheus provider's TLS path after #1104.
Not fixed there: the rewrite and every driver's TLS options are shared by all engines.

**Done when:** a tunnelled connection's TLS identity is checked against `TUNNEL_FAR_END`, as the server name when it is a DNS name and through `checkServerIdentity` when it is an address, on every driver that verifies, and a test through a tunnel with `verify-full` holds it for one wire driver and one HTTP provider.

### D115. A request naming a different query timeout rebuilds a cached provider, and disconnecting the old one ends work still running on it

`getOrCreateProvider` in `src/lib/db/factory.ts` disconnects a cached provider whose `queryTimeout` differs from the request's and builds a new one (`:552`), and the execution-profile cache does the same (`:722`); `src/lib/db/provider-cache-key.ts` records why the timeout is not in the key.
The old provider's `disconnect()` runs while another request may still be using it.
On Prometheus it aborts every query running or queued on it (`disconnect` in `src/lib/db/providers/timeseries/prometheus/index.ts`), so that query fails as a cancellation nobody asked for.
Measured 2026-09-24 against the compose Prometheus: a query that takes about 3.5 s, started on a provider opened with 60000 ms, failed after 301 ms with `QueryCancelledError` when the same connection was requested with 30000 ms; with 60000 ms both times it completed.
On PostgreSQL the running query completes, because `pool.end()` drains, but a request that reaches the old provider during the drain fails with `Cannot use a pool after calling end`, measured over a 2709 ms drain.
Trino, ClickHouse and Druid hold nothing a running query needs when they close; that was read, not measured.
The timeout travels in the connection object a browser sends for a connection the user created, so the trigger is one user's two tabs or browsers holding different Query Timeout values for the same connection; a tab keeps the value it loaded, which was read, not driven in a browser.
A seed is sent by id and carries no timeout, so seeded connections do not trigger it.

Found 2026-09-24 while checking the Prometheus provider's cancellation after #1104.
Not fixed there: the teardown is shared by every engine.

**Done when:** a timeout change reaches the next query without ending work in flight, by passing the timeout per query or by retiring the old provider without disconnecting it until its running work ends, and a test runs a slow query, requests the same connection with another timeout, and asserts the first query completes.

### D116. Two connection digests a caller receives hash the connection string with plain SHA-256, so a password inside it can be guessed offline

`connectionFingerprint` in `src/lib/db/connection-fingerprint.ts` and `connectionIdentity` in `src/lib/agent/context-snapshot.ts` both hash `connectionString` among the fields they frame, with unsalted SHA-256, and a connection string can carry the password (`scheme://user:pass@host`).
The first reaches the browser inside the plan `POST /api/db/objects/edit-plan` returns, and the second inside the run record `GET /api/agent/runs/<id>` returns to the run's owner; both exposures were read, not driven through a live server.
A managed seed defined by a connection string no longer sends that string to the browser, but a user whose role reaches the seed learns every other framed field by using the connection, so either digest checks a password guess offline.
Measured 2026-09-24 as arithmetic over the framing both functions use: a four-word guess list recovered the password of a seeded connection string from each digest.

Found 2026-09-24 by the review of the fix that withholds a managed seed's secrets from the browser.
Not fixed there: both digests are compared server-side exactly as they are, so changing what they hash changes every stored plan and every run's recorded identity.

**Done when:** neither digest can be recomputed from what a caller can learn, by keying both with a server secret or by hashing the connection string with its credentials masked, or the fingerprint no longer reaches the client, and a test holds that a digest differs from the plain SHA-256 of its own framing.

### D117. The provider cache key reads neither half of the Elasticsearch API key pair

`credentialDigest` in `src/lib/db/provider-cache-key.ts` frames the password, the agent pair, the TLS material and the tunnel's secrets, and neither `apiKeyId` nor `apiKeySecret`; `connectionFingerprint` frames neither either.
So two Elasticsearch connections that differ only in the pair share one cache entry, and `getOrCreateProvider` in `src/lib/db/factory.ts` returns the provider built with the first pair.
A key rotated behind a `${vault:...}` reference, which `docs/SEED_CONNECTIONS.md` says becomes visible within 120 seconds, keeps the old provider until the 30-minute idle sweep, and steady use keeps it from ever idling, so a revoked key answers 401 until the process restarts.
Measured 2026-09-24: `providerCacheKey` returned the same key for two Elasticsearch connections differing only in the pair, and for one with a pair and one without; changing only the password changed it.
A caller cannot use it to reach another user's pool: a claimed `seed:` id is re-resolved in `src/lib/seed/resolve-connection.ts`, and a browser connection's id is random.

Found 2026-09-24 by the review of the fix that withholds a managed seed's secrets from the browser.
Not fixed there: the cache key is shared by every engine.

**Done when:** `credentialDigest` frames the API key pair, and a test holds that two connections differing only in either half get different keys.

### D118. MongoDB maintenance and monitoring read only the connected database, so a deep link from another one lands on the wrong collection

Found 2026-09-24 in the browser while verifying #843 (PR #1106), on a connection opened with `appdata` whose tree also lists `analytics`.
Both hold a collection called `events`.
The tree's **Validate Collection** on `analytics > events` opens `/admin/operations?path=analytics&path=events`, and that page lists the connected database's collections, `appdata . events` among them: `getTableStats()`, `getIndexStats()` and `runMaintenance()` in `src/lib/db/providers/document/mongodb.ts` all read `this.db`, the connected database, and `runMaintenance(type, target)` takes a bare collection name.
So the row a person presses for the collection they chose is the connected database's same-named collection, which is the shape #843 removed from the query path.

Not fixed in #1106, which is scoped to the statement grammar.
The target is a bare string in `runMaintenance(type, target)`'s contract for every provider, so passing a path is the D49 change, and the monitoring tabs are session-scoped on every engine.

**Done when:** a MongoDB maintenance target names its database, the deep link either opens the collection's own database or refuses a path outside the connected one, and a test pins that `Validate` on `analytics.events` reaches `analytics`.

### D119. On RisingWave every column reads nullable, a `NOT NULL` column and a primary key included

Found 2026-09-24 while measuring #1075, which made RisingWave's column reads answer at all.
`CTE_OBJECT_COLUMNS` and `bulkDetailSql()` in `src/lib/db/providers/sql/postgres.ts` read nullability as `NOT a.attnotnull`, and RisingWave 3.0.4's `pg_attribute` answers `attnotnull = false` for every column.
Measured on `CREATE TABLE probe.customers (zeta_id int PRIMARY KEY, name varchar NOT NULL, ...)`: both `zeta_id` and `name` read nullable.
The engine does know one of the two facts: `information_schema.columns.is_nullable` answers `NO` for `name`, though `YES` for `zeta_id`, the key.
The limitation is recorded in the RisingWave caveat in `src/lib/db/compatibility.ts` and its row in `docs/providers/README.md`, which cite this entry.

Not fixed in #1075, which is scoped to making the reads answer.
Changing the nullability source changes the column read on every PostgreSQL wire-compatible engine, so it owes the same live before-and-after run #1075 made on PostgreSQL and every relative in the registry.
A primary key column is not nullable by definition, so that half needs no catalog at all.

**Done when:** on RisingWave a `NOT NULL` column and a primary key column both read as not nullable, every other engine reads the same nullability as before, measured live, and a test pins both halves.

### D120. Kafka connections take no OAUTHBEARER, so Azure Event Hubs and Confluent OAuth are out of reach

`saslMechanism` on `DatabaseConnection` (`src/lib/types.ts`) and `SeedConnectionSchema` (`src/lib/seed/types.ts`) take `PLAIN`, `SCRAM-SHA-256` and `SCRAM-SHA-512` only, and `saslOptions` in `src/lib/db/providers/stream/kafka/connection-options.ts` refuses anything else.
The client does implement OAUTHBEARER: `@platformatic/kafka` 2.11.0 ships `dist/protocol/sasl/oauth-bearer.js`, and its connection takes a `token` or an `authenticate` callback (`dist/network/connection.js`).
Azure Event Hubs' Kafka endpoint and Confluent Cloud's OAuth sign in only that way, so neither can be browsed today.
A token pasted into the password box would expire within hours, and this product has no refresh flow, which is why v1 left the mechanism out (#1088, section 2); GSSAPI and AWS MSK IAM are out for the same reason and a native dependency or SigV4 signing each.

Found 2026-09-23 while designing the Kafka provider (#1088).

**Done when:** a Kafka connection can authenticate with OAUTHBEARER through a token source that refreshes before expiry, the credential is classified secret where the token lives, and a test drives an expiring token through a refresh.

### D121. Kafka values in Avro, Protobuf or JSON Schema show their schema id, not their fields

`decode.ts` in `src/lib/db/providers/stream/kafka/` labels a value that starts with the Confluent wire format (magic byte 0, then a 4-byte schema id) as `schema id <N>, not decoded`, encoding `confluent`, and reads no Schema Registry, so a topic written with a registry serializer shows no field of any record.
The client ships a registry reader (`dist/registries/confluent-schema-registry.js`), but decoding needs the registry's address and credentials as connection fields, and each of the three formats its own decoder.
The labelling rule also has a stated false positive, a text value that happens to start with `0x00` (`docs/providers/kafka.md` section 5.3), which a registry lookup would settle.

Found 2026-09-23 while designing the Kafka provider (#1088, section 2).

**Done when:** a Kafka connection can name a Schema Registry, a framed value is decoded against the schema its id names, a value the registry does not know keeps the `confluent` label, and a test pins each format over a captured payload.

### D122. Requests to `platformatic/kafka`, drafted for the maintainer and not filed

The Kafka provider (#1088) works around, or states, twelve behaviours of `@platformatic/kafka` 2.11.0, each measured while it was built.
Each is drafted below as an upstream issue, for the maintainer to approve, reword or drop; none has been posted anywhere.

1. **An Admin method for ConsumerGroupDescribe (API 69).**
   `Admin.describeGroups` reports a KIP-848 group as `Dead` while the broker says `Empty`, so describing a `consumer`-protocol group needs API 69, which the Admin does not offer; the provider sends it through the exported `consumerGroupDescribeV0` on a one-off `Connection`.
   Draft: "Please add an Admin method for ConsumerGroupDescribe (KIP-848), so a consumer-protocol group can be described without the raw protocol module."
2. **A cap on decompressed size.**
   `dist/protocol/compression.js` and `dist/protocol/records.js` decompress every batch of a fetch answer whole, synchronously and with no output cap, and the broker bounds only the compressed batch, so one answer can grow by the codec's ratio, measured at about 1,029 to 1 for gzip and 32,692 to 1 for zstd.
   Draft: "Please add an option that bounds the decompressed bytes of a fetch answer and fails the fetch past it."
   Wrapping the exported `compressionsAlgorithms` table in the meantime is left to the maintainer's decision.
3. **Group decoding that trusts the member metadata.**
   `describeGroups` decodes each member's metadata as a consumer subscription whatever the group's protocol type, and a member's assignment without checking its length, and a parse error there, thrown in a response callback, escapes the call's promise: for a Kafka Connect or Schema Registry group, or a malformed assignment, the call never settles where uncaught exceptions are handled and a Node process that installs no handler exits.
   Draft: "describeGroups should decode member metadata only for protocol type `consumer` or empty, check lengths, and reject its promise on a parse error."
4. **Internal topics in the metadata cache.**
   The metadata cache answers an internal topic's name with `undefined` (`dist/clients/base/base.js`), and `listOffsets` dereferences it inside the socket handler, with the same unsettled call.
   Draft: "listOffsets on an internal topic should reject with an error rather than throw inside the socket handler."
5. **`tlsServerName` and IP literals.**
   With `tlsServerName: true` the client sends the connection's host as the server name even when it is an IP literal, which Node 26 and Bun refuse with `ERR_INVALID_ARG_VALUE` and Node 24 warns on (DEP0123); the provider rebuilds its clients without the option when a broker is advertised by IP.
   Draft: "Skip SNI for a host that is an IP literal, as RFC 6066 requires."
6. **A fetch session epoch left behind.**
   A fetch answered with a partition error leaves the client's fetch session epoch behind the broker's, so the next fetch to that broker meets INVALID_FETCH_SESSION_EPOCH; the provider's own fetches open no session.
   Draft: "After a fetch that answers a partition error, the session epoch should follow the broker's, or the session be reset."
7. **`isolationLevel` typed as a string.**
   `Consumer.listOffsets` declares `isolationLevel` a string while its allowed values are numbers, so the client's strict mode refuses every isolation level; the provider runs the default mode, which validates no option.
   Draft: "The listOffsets option schema should accept the numeric isolation levels it documents."
8. **The READ_COMMITTED filter throws in the socket handler.**
   `#filterUncommittedMessages` in `dist/clients/consumer/consumer.js` reads `batch.records[0].key` and `abortedRanges.get(producerId)[1]` unguarded, in the response callback the socket data handler calls outside any try, so an empty control batch, which Kafka's log cleaner keeps of a transactions V2 producer's last marker, or an ABORT marker of a producer the answer does not list, beside a listed aborted transaction, throws a TypeError out of the handler after the request left the client's timers; that fetch never settles in a process that handles uncaught exceptions, and a Node process that installs none exits.
   Measured on 2026-09-25 on a cleaned Kafka 4.3.1 log and against a local broker under Node 24.14.0 and Bun 1.4.2; the provider sends its own Fetch v13 instead.
   Draft: "Guard the control-batch and aborted-range reads of the READ_COMMITTED filter, and reject the fetch rather than throw from the socket handler."
9. **The socket's error dropped on close.**
   A request in flight on a connection whose socket failed rejects with a bare "Connection closed" (`#onError` and `#onClose` in `dist/network/connection.js`), and the pool's error listener only drops the connection, so the socket's error, such as the TLS alert of a broker that refuses the client's certificate under TLS 1.3, reaches no caller; the provider can only report a lost connection.
   Draft: "Carry the socket's error as the cause of the request's rejection."
10. **No upper bound on the SCRAM iteration count.**
    `performAuthentication` in `dist/protocol/sasl/scram-sha.js` checks the server-first message's iteration count against a minimum only (4,096) and runs PBKDF2 over the password with whatever count the broker asks, on the runtime's thread pool, where it goes on after the connect has timed out and the client is closed, while Apache Kafka 4.3.1 stores no SCRAM credential above 16,384 iterations (`ScramMechanism`); the provider states it (`docs/providers/kafka.md` section 4.2), since the client's only hooks either replace the whole mechanism or run after the PBKDF2.
    Measured on 2026-09-26: 4,000,000 SHA-512 iterations took 1,367 ms under Node 24.14.0 and 1,233 ms under Bun 1.4.2, a connect asked for them twice, and with four such exchanges running under Node a file read took 4,490 ms.
    Draft: "Please bound the iteration count a SCRAM server-first message may ask for, with an option that defaults to a sane maximum such as Apache Kafka's own 16,384, and fail the authentication past it before PBKDF2 runs."
11. **No floor on the SASL session lifetime.**
    `#onSaslAuthenticationValidation` in `dist/network/connection.js` arms `reauthenticate()` at 80% of whatever session lifetime a SaslAuthenticate answer carries (KIP-368), and each re-authentication arms it again, for as long as the connection is open, with no floor; the provider states it (`docs/providers/kafka.md` section 4.2), since `authBytesValidator` never sees the lifetime.
    Measured on 2026-09-26 on one connection over five idle seconds with a lifetime of 1 ms: 3,926 re-authentications under Node 24.14.0 and 3,005 under Bun 1.4.2 with PLAIN, and 1,559 and 1,609 with SCRAM-SHA-512 at about 60% of a core, where a lifetime of 0 or of one hour made none; closing the connection stops the loop.
    Draft: "Please apply a floor to the session lifetime a SaslAuthenticate answer sets, with an option, and fail or clamp a lifetime below it, so a broker cannot drive a connection's re-authentication in a loop."
12. **`ajv-draft-04` loaded at import time.**
   The entry re-exports the schema registries, whose module imports `ajv-draft-04` at module scope, so every import of the client loads it, and `ajv-draft-04` requires `ajv/dist/core` from where it is installed.
   bun hoists it beside an `ajv` 6 at the top of a host's `node_modules` (oven-sh/bun#17297, open), and the whole client then fails to load, schema registry or not; the provider refuses such a connect with a `DatabaseConfigError` naming the module, and a comment for the bun issue is drafted beside this one.
   Measured on 2026-09-26 on packed installs of the package with bun 1.4.2, under Node 24.14.0 and Bun 1.4.2, while npm 11.9.0 nests it beside `ajv` 8 (plan Task 21, finding r2-contract-1).
   Draft: "Load ajv-draft-04 when a draft-04 JSON Schema is first compiled, so a client that uses no schema registry does not depend on where the package manager puts it."

Found 2026-09-23 to 2026-09-26 while building the Kafka provider (#1088, sections 3.6 and 12).
Not filed: an outward report makes claims about another project's code, so each goes out only with the maintainer's approval.

**Done when:** each draft is filed upstream, reworded or dropped by the maintainer's decision, and the item records the issue link or the reason; a fix that ships upstream is followed by removing the provider's workaround where it has one.

### D123. A Kafka read the budget stops answers older rows than the newest that would fit

`readMessages` in `src/lib/db/providers/stream/kafka/read.ts` reads a topic's partitions one after another, each forward from its start, and the result byte budget stops the whole read.
So a `"latest"` read whose early partitions hold large records can stop before it reads a partition whose newer rows alone would fit, and answers older rows than an unbounded read would; its warning names where it stopped and the partitions it did not read (`docs/providers/kafka.md` section 5.4).
Reproduced by the displaced-rows case of `tests/unit/db/kafka/read.test.ts`, "a latest read can be stopped although the rows an unbounded read answers would fit": five 200-byte records of partition 0 and five 10-byte newer records of partition 1, under a 650-byte budget, answer partition 0's offsets 0 to 2, where the unbounded read answers partition 1's five rows, 50 bytes.
The alternative is to hold, in place of stopping, the rows of the answer's near end that fit, which answers the rows an unbounded read answers whenever they fit, whatever the partition order.
Its cost is reading every partition's window, up to `limit` records each, whatever the record size, where the stop bounds the fetched work too (K5).

Found 2026-09-25 while building the Kafka provider (#1088, section 5.4).
Not fixed there: the trade between bounded work and a complete window is a design decision, not a defect of either rule.

**Done when:** a ruling chooses between the stop and the held window, and either the displaced-rows case answers partition 1's rows, or the stop stays with the reason recorded beside the rule in `read.ts`.

### D124. Cassandra and Couchbase also reach addresses the server advertises, which an SSH tunnel does not carry

The Kafka provider refuses an SSH tunnel because a Kafka client reaches every broker at the address the broker advertises (#1088, section 6.1); two other providers discover addresses the same way and take a tunnel anyway.
`cassandraClientOptions` in `src/lib/db/providers/sql/cassandra/driver-transport.ts` gives the driver the configured host as its one contact point, and the driver discovers the rest of the ring from the node's peers table, whose addresses a tunnel to one host does not forward.
`pickQueryEndpoint` in `src/lib/db/providers/document/couchbase/http-transport.ts` takes the query service's address from the cluster's node map, so behind a tunnel the management port goes through it and the query service is asked for at the node's own name; D52 records the same discovery handing back an address a port mapping does not reach.
Read from the code, not measured through a tunnel.

Found 2026-09-24 while designing the Kafka provider's tunnel refusal (#1088, section 6.1).
Not fixed there: that PR changes no other provider.

**Done when:** each of the two either routes its discovered addresses through the tunnel, or refuses a tunnel with a sentence that says why, as Kafka does, and a test pins the choice for each.

### D125. A Kafka broker with a failed log directory fails the three monitoring panels

`logDirs` in `src/lib/db/providers/stream/kafka/platformatic-client.ts` asks every broker for its log directories, and the client throws on a directory the broker answers with an error.
A broker whose second log directory has failed answers that directory with `KAFKA_STORAGE_ERROR`, so `getOverview`, `getHealth` and `getStorageStats` in `src/lib/db/providers/stream/kafka/index.ts` all fail with "The request to the broker failed (KAFKA_STORAGE_ERROR)", while the topic listing shows the affected topic `offline` and every other surface answers.
Reproduced live on 2026-09-25 by `tests/live/kafka-read-only.ts --bootstrap localhost:9095` against a throwaway `apache/kafka:4.3.1` node with two log directories, the second made unreadable (`docs/providers/kafka.md` section 11.4).
The panels could instead sum the directories that answered and name the failed one, the way the adapter already reads a metadata answer that carries a leaderless partition.

Found 2026-09-25 by the Kafka provider's live read-only check (#1088, KM8).
Not fixed there: the change is to the adapter's log-dir read, whose error table and seam guard the PR had already settled, and a failed directory is rarer than the offline partition it causes.

**Done when:** a broker with one failed log directory answers the overview, health and storage panels with the directories that answered, the failed directory is named, and a test over a captured `KAFKA_STORAGE_ERROR` answer pins it.

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

### R3. A whole-LOOKING key out of a scaled decimal column writes the neighbouring row

#969 closed the fractional half of this: a number read out of a column the engine declares `NUMBER`,
`decimal`, `numeric` or `money` is refused before the engine is asked, because the declaration says
the driver rounded it - `describeFraction` and `EXACT_DECIMAL_TYPE_NAMES` in
`src/hooks/use-inline-editing.ts`. Measured 2026-09-19 on Oracle AI Database 26ai Free 23.26.3.0.0
and SQL Server 2022 CU27: the `NUMBER(20,4)` pair that used to write to `the-neighbour` is refused
with nothing asked of the engine, while `BINARY_DOUBLE`, a whole `NUMBER(10)` key, a SQLite
`DECIMAL` (that engine has no exact decimal - it stores a double) and the STRING a `numeric` takes
over `pg`, mysql2 and DuckDB all still write.

**What is left is the value that arrives WHOLE.** A decimal whose digits round to an exact integer
double reaches `describeUncarriableKey` as a safe integer and is let through - which is right for
every ordinary Oracle key and wrong for this one. MEASURED 2026-09-19 through this hook, after the
fix above: Oracle `zz969_intx(id NUMBER(38,20) PRIMARY KEY)` holding 5.00000000000000000001 and 5
hands BOTH rows over as 5; with only the first row edited, the check asked about 5, Oracle answered
ONE group holding ONE row, and `UPDATE ... WHERE "ID" = :2` wrote to the row holding exactly 5 -
the row nobody edited - reported as "Changes Applied". SQL Server `decimal(38,20)` over the same
pair does the same thing, the parameter bound as an integer this time rather than a float.

It could not be closed where the fractional half was. The only thing that separates `NUMBER(38,20)`
from the `NUMBER(10)` that is every second Oracle primary key is the SCALE, and the declared type
this hook reads carries the word alone: `oracleColumnTypes` and `mssqlColumnTypes` in
`src/lib/db/providers/sql/column-types.ts` drop precision and scale deliberately, because a computed
column reports precision 0 (`COUNT(*)`) or scale -127 (`1/3`). Refusing every whole number out of a
decimal column instead would refuse every Oracle key there is - measured, `NUMBER(10)` holding 42
writes correctly and must keep doing so.

**Done when:** the type that reaches this hook says whether the column can hold digits under the
point on the engines whose drivers round - the scale beside the word, or a second field that says
it - a whole key is refused only where it can, and a test carries the Oracle and SQL Server pairs
above beside the fractional ones #969 added.

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

`objectActions` in `row-actions.ts` gates Profile on `capabilities.tablesAreDerivedGroupings !== true`, a PROVIDER fact about what a row is, while everything else that function asks about what a row is comes from a per-kind declaration.
The language gate #1085 added to the same item is engine-wide as well, and rightly so: it says what the profile route can run, not what the row is.
The flag says "the rows
this engine shows are prefix groupings this server derived from a bounded scan", and on Redis that
is true of every row it has. On LibreDB it is true of one kind out of three: `keyspace` is derived,
while `table` and `collection` are entries the persisted catalog NAMES, created by `table()` and
`doc()` and addressed by the name their author chose (#789, Task 23). Those two are refused Profile
purely because the gate never got a per-kind half.

Nothing regresses today and that is measured, not assumed: `POST /api/db/profile` profiles SQL and a MongoDB `aggregate` document only, and since #1085 it refuses JSON in a dialect of its own before sending anything, so a profile of a LibreDB table answers a 400 that names the language.
Both row menus ask that refusal's own gate, `offersColumnProfiling`, so today Profile is withheld from all three kinds by the language as well as by the flag, and the flag becomes the only refusal on the day the route grows an arm for this grammar.
The pipeline the route sent before that refusal existed is what the grammar answers with `Unknown command ... Supported: get, put, delete, prefix, range`, and a test in `tests/integration/db/libredb-provider.test.ts` still pins that at the provider.
Profile cannot work on ANY kind here, so withholding it from all three is the honest menu rather than a cost.

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

---

`U24` to `U31` came out of the #789 design that put columns back under an object row. Each was named
and left out of that PR on purpose, so the reason is recorded here rather than re-derived. They are
about the desktop object tree unless the entry says otherwise.

### U24. The tree fetches an object's indexes and foreign keys and draws neither

`POST /api/db/objects/describe` answers an `ObjectDetail`, which is `columns`, `indexes` and
`foreignKeys`.
The tree issues one of those per expanded object row and renders the first array only, so two thirds
of every answer it already paid for is discarded.

Repro: connect to PostgreSQL in the desktop sidebar with the network panel open, expand a table that
has a primary key and a foreign key.
One `describe` request goes out, its response body carries all three arrays, and the rows drawn under
the table are the columns alone.

Left out of #789 for two reasons, both still standing.
A heterogeneous sibling list where an index row and a column row are one 28px line with no way to
tell them apart is worse than not drawing them, so this needs a visual distinction decided first, not
a second `map`.
And a set of providers never answers an index at all, measured per provider for the #789 design:
trino, druid, elasticsearch and opensearch (one module, two type-ids), mongodb, redis and libredb.
So whatever shape holds an index has to be absent on those engines rather than empty.

**Done when:** an index and a foreign key are reachable from an open object row, told apart from a
column row by something other than their text, with no extra round trip, and an engine that answers
neither draws no empty affordance for them.

### U25. The object tree has no filter, over object names or column names

`docs/FEATURES.md` promises "Real-time, high-performance filtering across both table names and column
names".
That sentence is true of `SchemaExplorer`, which filters on `table.name` and on `col.name` and is
what the mobile schema tab renders; it is false of the desktop sidebar, which has no filter box at
all.
This PR scoped the sentence to the schema tab rather than deleting it, which makes the desktop gap
explicit instead of covered.

Repro: open the desktop sidebar on a schema with 200 tables and look for a filter.
Open the same connection at a mobile width, switch to the schema tab, and there is one.

The tree's filter is not the flat list's, and that is the work.
The flat list holds every table and every column in memory, so its filter is an array filter over
data that is already there.
The tree reads lazily: a filter over column names can only match a row whose `describe` has happened,
and a filter over object names can only match a folder whose objects have been listed.
What an unread subtree does under a filter has to be decided before anything is written, and the
three answers are hide it, show it unfiltered, or read it, where the third is the eager
whole-database read #789 removed.

**Done when:** the tree has a filter over object and column names, its behaviour on an unread subtree
is stated in the component's docblock and asserted by a test, and no keystroke in the box can trigger
a whole-database read.

### U26. The tree row menu is two items shorter than the flat explorer's

`src/components/schema-explorer/TableItem.tsx` offers "Select Top 50" (the label is
`labels.selectAction` where a provider sets one), "Generate Query" and "Copy Name".
`rowActions` in `src/components/object-tree/row-actions.ts` offers `generate-select` and neither of
the other two, so a desktop reader lost both when the sidebar stopped rendering the flat explorer.

Repro: right-click a table row in the desktop sidebar, then open the same table's menu on the mobile
schema tab and compare.

"Copy Name" has a constraint that has to be decided before it is added, and it is the reason this is
an entry rather than two lines.
It writes the clipboard and reports through a toast, and the embedded shell mounts no `<Toaster />`,
for the reason `StudioWorkspace` records; the standalone shell mounts one in `src/app/layout.tsx`.
So the action either gets a report the embedded shell can make, or it is declared standalone-only the
way the seam already declares other host-dependent actions, and silently copying with no feedback is
neither.

**Done when:** both items are offered from a tree object row wherever the shell can carry their side
effect, and a shell that cannot carry one declares it rather than being quietly short.

### U27. Every column the desktop shows is read twice, and the second read is not the fixable one

On connect, `src/hooks/use-connection-manager.ts` posts `/api/db/objects/inventory` with
`includeColumns: true`, which reads columns for the whole database before any row is expanded.
The desktop sidebar then posts `/api/db/objects/describe` once per object row the reader opens, for
columns the first read already has.

Repro: open a connection on a desktop viewport with the network panel open.
One inventory request carries every column of every table with no gesture behind it.
Expand one table: a `describe` request fetches that table's columns again.

The design filed this as "the fix is moving the mobile schema tab onto the tree and dropping
`includeColumns`", and that remedy is wrong as stated.
Measured in `src/components/Studio.tsx`, the inventory's answer (`conn.schema`) has more readers than
the schema tab: `SchemaDiagram`, `BottomPanel`, `DataImportModal`, `CommandPalette`, the
`objectAtPath(conn.schema, ...)` lookups behind the profiler, the code generator and the test-data
generator, and `conn.schemaContext`.
The inventory route's own docblock names the same population.
So moving the mobile tab onto the tree removes one reader of seven and drops nothing.

**Done when:** each reader of `conn.schema` either has a source that is not a whole-database eager
column read or is named here with the reason it needs one, and a connection whose readers all moved
costs no column read until a row is opened.

### U28. The single-object describe answer is unbounded, on the route and on the embedded seam

`describeObjects` answers an `ObjectDetailBatch`, which carries `truncated` and takes a `limit`, so
the vocabulary for a bounded answer exists.
`describeObject` has neither: `POST /api/db/objects/describe` hands the provider's answer straight
back, and `WorkspaceObjectReader.describeObject` in `src/workspace/types.ts` lets a host answer
whatever it likes.
The tree renders one row per column of whatever arrives.

Repro: implement `describeObject` in an embedded host so it answers 50,000 columns for one table and
open that row.
Nothing between the host and the flattened row list refuses, truncates or says a word about the size.

Not fixed in #789 because the bound is not this seam's to invent: `listObjects` has the same open
question, `INVENTORY_PAIR_LIMIT` bounds the pair fan-out and not the per-object answer, and two
different bounds decided in two PRs is how a reader ends up with a truncated list and an untruncated
detail of the same object.

**Done when:** the single-object answer carries the same bound and the same truncation signal as the
batch one, on the route and on the seam, the bound is the same decision as `list`'s, and the tree
says so on a row where it was hit.

### U30. A search alias or stream over more than one index is described by the first index's mapping

`src/lib/db/providers/sql/search/` declares `index`, `alias` and `stream` as kinds that have columns,
and the mapping read in `http-transport.ts` takes `Object.values(payload)[0]`, the first entry of the
`_mapping` response.
An alias or a data stream that spans several backing indices is therefore described by one of them,
and which one is whatever the cluster serialised first.

Where the backing indices share a mapping the answer is correct, which is the common case and the
reason this ships rather than being blocked.
Where they do not, a field present only on a later index is missing from the tree's column rows and
from the agent's column grounding, which has read the same transport answer since #789.
So this is an existing provider answer that the tree makes visible; the tree did not create it.

Repro: on Elasticsearch, create `logs-000001` and `logs-000002` with different mappings, point an
alias at both, and expand the alias in the object tree.
Only the first index's fields are drawn.

**Done when:** `describeObject` for an alias or a stream answers the union of every `_mapping` entry
in the response, a field two backing indices type differently is reported rather than resolved
silently to one side, and both products have a fixture for the disagreeing case.

### U31. No per-folder column prefetch, and the break-even that decides one is unmeasured per engine

The tree reads one object's columns at a time, on the gesture that opens the row.
`describeObjects` reads a whole folder in one round trip and is cheaper per object once enough rows
in that folder are opened.
Where that crossover sits differs by more than an order of magnitude across the fleet, from the A/B
tables the provider docs already carry:

| Engine | One `describeObjects` over a folder | Per object, single read |
|---|---|---|
| Trino | 165 ms / 200 objects | 25.8 ms |
| Druid | 23 ms / 4 objects | 22.5 ms |
| PostgreSQL | 33 ms / 200 objects | 20.7 ms |
| Couchbase | 293 ms / 40 collections | 11.6 ms |
| DuckDB | 26 ms / 200 objects | 6.5 ms |
| Elasticsearch | 9 ms / 261 indices | 5.3 ms |
| SQL Server | 161 ms / 200 objects | 2.2 ms |
| MongoDB | 108 ms / 200 collections | 2.1 ms |
| Redis | 2 ms / 4 groupings | 1.5 ms |

Roughly six opened rows on Trino, two on PostgreSQL and seventy on SQL Server, which is why a
constant trigger is not available.
Each figure is one engine's own doc, on one version, against one fixture, so they are a starting
point for a measurement rather than the measurement.

The prefetch was left out because a folder read pays its whole cost on the gesture that is today the
primary way to browse, for columns nobody asked to see: 293 ms on Couchbase and 165 ms on Trino for a
reader who opens Tables and expands nothing.
It also needs a second cache shape, since `ObjectDetailBatch` is bounded and the rows past the bound
still need the single read.

**Done when:** the numbers above have been re-measured on the versions in `docker-compose` at the
time, the prefetch triggers on a per-engine threshold derived from those numbers rather than a
constant, and a bounded batch and a single read land in one cache shape rather than two.

### U32. A catalog change that lands during an in-flight read is dropped, and the pre-DDL answer stays

`run` refuses a read whose key is already in flight
(`src/components/object-tree/use-tree-nodes.ts:517`) and `refresh` issues its reads without waiting
for anything (`:696`), so a `refreshToken` bump that arrives while a read is still open issues
nothing for that slot.
The answer that lands is the one asked for before the DDL statement ran, `store` writes it as the
row's current state, and nothing re-issues until the next bump.
A column added by that statement is therefore missing behind the twisty, and the row asserts a
column list the engine no longer has, for as long as the reader runs no further DDL.

Pre-existing, and measured as such rather than assumed. The guard and `refresh` both predate the
column rows, and the same gesture on a folder's `list` read, with a capability set that declares no
`hasColumns` so nothing in the column path is exercised, loses the same way: the bump issues
`containers` and `counts` and no second `list`, and a table the statement created is absent until
the next bump. So this is a standing property of `refresh` and not something the column rows created.
The column rows do make it easier to reach, because a describe is slower than a listing and there is
one per open object.

Repro: PostgreSQL, standalone shell. Hold `POST /api/db/objects/describe` for `orders` open, expand
`orders`, and while the describe is still open run `ALTER TABLE orders ADD COLUMN note text` in the
editor. Release the held describe with the pre-DDL answer. The row draws the pre-DDL columns, no
second describe is issued for it, and `note` appears only after the next DDL statement.

A plain second `run` call is NOT the fix, and that is the trap this entry exists to record. Two
describes for one row would then be in flight with no ordering between them, and the older can land
last and overwrite the newer, which is a worse failure than a stale answer the next bump corrects.
The fix records that a key was refused while in flight and re-issues it once the first settles, and
it has to do that for all four slot kinds rather than for `details` alone: teaching one read kind to
survive this race and leaving the other three behind is a harder inconsistency to reason about than
the race itself.

**Done when:** a bump that arrives while a read is in flight causes exactly one re-read of that slot
after the first settles, for every slot kind, with never two reads of one slot in flight at once, and
a test holds a read open across a bump and asserts the second answer is the one on screen.

### U33. Three tree spans miss 4.5:1 on a selected row, and the docblock measured one background

Three spans in `src/components/object-tree/TreeRow.tsx` are `text-muted-foreground` at 10px:
`tree-row-column-type`, `tree-row-count` and `tree-row-badge`. Cited by test id rather than by line,
because the line numbers in that file moved twice while this entry was being written. Measured
against the repository's own compiled stylesheet, with the token values read off the live page rather
than the file:

| row background | light | dark |
|---|---|---|
| plain | 4.74 | 7.76 |
| hover | 4.50 | 6.70 |
| selected (`bg-muted`) | 4.35 | 5.81 |

WCAG 1.4.3 asks 4.5:1 for text below 18.66px, so the light theme fails on the selected row and sits
exactly on the line on hover. The failing background is not an edge case: clicking a row is the
primary gesture on the tree, and a clicked row carries `aria-selected="true"` and `bg-muted`, so it
is the reader's own row that fails.

The correctness note above the type slot, the paragraph beginning "NO `/70`", reaches its conclusion
from one background. It records `#737373` on `#ffffff` (4.7:1) and `#a1a1aa` on `#09090b` (7.7:1) and
names neither the hover nor the selected ground, so the `/70` opacity it correctly refuses is refused
for a reason narrower than the slot's real range, and the note reads as a clearance it has not
established.

The count and the badge have carried the same ratio since before the column rows existed, so the
type slot joins a defect rather than introducing one. Repairing the three together, rather than
recolouring one span in the change that added it, is why this is an entry.

Repro: open the object tree, click any row so it carries `bg-muted`, and measure
`tree-row-column-type`, `tree-row-count` or the badge text against the row's own background in the
light theme.

**Done when:** all three spans clear 4.5:1 on the plain, hover and selected backgrounds in both
themes, the docblock states the measurement per background instead of one, and the ratios are
asserted in `tests/unit/theme-accent-contrast.test.ts` through `tests/helpers/contrast.ts` rather
than written down as prose.

### U34. A refresh that drops the focused row sends focus to the document body

`ObjectTree` keeps exactly one tabbable row,
`rows.find((row) => row.id === activeId)?.id ?? rows[0]?.id`
(`src/components/object-tree/ObjectTree.tsx:174`), and the focus effect below it moves focus only on
an explicit `focusRequest`. When a catalog refresh removes the focused row from the model, the
focused element unmounts, the browser hands focus to `document.body`, and the tab stop falls back to
the first row. Arrow keys then do nothing, because the key handler is on the row, and the reader has
to press Tab to re-enter the tree at the top, several screens from where they were.

Pre-existing, and the tempting reading that `DROP COLUMN` makes it newly reachable is refuted by its
own control: the same gesture against an OBJECT row, which `DROP TABLE` reaches and which predates
any column work, loses focus identically, focus on `BODY` and the tab stop back on the first row.
`git diff origin/main...HEAD -- src/components/object-tree/ObjectTree.tsx` reaches neither the
fallback nor the focus effect. Column rows add one more way in, not the fault.

Repro: PostgreSQL, standalone shell. Focus a column row of `orders` with the keyboard, then run
`ALTER TABLE orders DROP COLUMN note` for that column in the editor. After the refresh,
`document.activeElement` is `BODY`, the tab stop is the first row, and ArrowDown does nothing. Repeat
with a table row and `DROP TABLE` to see the pre-existing half.

**Done when:** a refresh that removes the focused row moves focus to the nearest surviving row, the
parent for a dropped child and the next sibling otherwise, keyboard navigation continues from there
with no Tab, and both the object-row case and the column-row case are tested.

### U35. The type slot shows the wrapper and not the type on engines whose types nest

The `aria-hidden` half of the `tree-row-column-type` span in `src/components/object-tree/TreeRow.tsx`
renders `row.column.type.split("(")[0]`. That rule is right where the parenthesis opens a parameter
list, which is why `VARCHAR(255)` reads `VARCHAR`, and wrong where it opens the type itself. Driven
through the component with the spellings
`docs/providers/clickhouse.md` records as what that provider returns:

| the provider's answer | on screen |
|---|---|
| `Int32` | `INT32` |
| `Nullable(String)` | `NULLABLE` |
| `Array(UInt8)` | `ARRAY` |
| `Map(String,String)` | `MAP` |
| `Enum8('x'=1,'y'=2)` | `ENUM8` |
| `LowCardinality(String)` | `LOWCARDINALITY` |
| `Decimal(10,3)` | `DECIMAL` |

So for every nullable or low-cardinality ClickHouse column the visible slot says only that the column
is wrapped and never what it holds, and a reader scanning a table's types learns nothing from the
column that needed the annotation most. Degraded rather than lost: the full spelling stays in the
`title` and in the `sr-only` twin, so the tooltip and the accessible name are correct.

Not the tree's invention. `src/components/schema-explorer/ColumnList.tsx:36` does the identical
split, so the tree restores behaviour the flat explorer already had on the same engines, which is
why this is an entry covering both readers rather than a line in the change that added the second.
There is no second field to fall back to either: the ClickHouse provider publishes the wrapped
spelling and no base type beside it.

Repro: connect ClickHouse, create a table with a `Nullable(String)` column, and expand it in the
object tree. The right-hand slot reads `NULLABLE`.

**Done when:** a nested type shows the reader the inner type rather than the wrapper, the choice is
driven off what the provider publishes rather than off the shape of the string and without branching
on a database type id in a component, and the tree slot and the flat explorer's column list take the
same answer from one place.

### U36. The connection dialog picks field labels by testing the type id, beside a declaration that does the same job

`src/components/ConnectionModal.tsx` tests the type id in five booleans.
Four of them (`isCouchbase`, `isTrino`, `isCassandra`, `isLibSQL`) choose `passwordFieldLabel`, `databaseFieldLabel`, `databaseFieldPlaceholder`, `connectionUriPlaceholder` and four hint paragraphs; `isMongoDB` and `isCassandra` also gate the `authSource` and `localDataCenter` field blocks, which `takesConnectionField` could decide because `connectionFields` in `src/lib/db-ui-config.ts` declares both.
Since the Prometheus provider (#1085, section 3.3), `DatabaseUIConfig` carries optional `fieldLabels` and `fieldHints`, read through `connectionFieldLabel` and `connectionFieldHint` before those fallbacks, and only the `prometheus` entry declares them.
So the same fact now has two mechanisms, and a sixth engine that follows the older one extends a chain the component should not own.

Found 2026-09-23 while adding the declaration for #1085.
Not fixed in #1085, on purpose: moving the older engines onto the declaration changes what five dialogs render, and each has its own E2E or component assertions that would move with it.

**Done when:** no label, placeholder or hint in the dialog is chosen by a type-id boolean, each comes from `DatabaseUIConfig`, and the existing assertions for Couchbase, Trino, Cassandra, MongoDB and libSQL pass unchanged.

### U37. Monaco's bundled `redis` language shadows the Redis tokenizer this repository registers

`registerRedisLanguage` in `src/lib/editor/redis-language.ts` returns before it registers anything when `monaco.languages.getLanguages()` already lists the `redis` id, which is how it stays idempotent across editor mounts.
The installed Monaco bundle registers that id itself at load time: `node_modules/monaco-editor/min/vs/basic-languages/monaco.contribution.js` registers `id:"redis"`, and `tests/isolated/monaco-language-ids.test.ts` asserts `redis` among the bundle's basic language ids.
So in the browser the early return always fires, and a Redis tab is tokenized by Monaco's bundled Redis grammar, never by `REDIS_KEYWORDS` and the rules that file and its tests describe.
Read from the bundle, not yet seen in a browser.

Found 2026-09-23 while writing `registerPromqlLanguage` on the `redis-language.ts` template for #1085 (section 3.2); the template works for PromQL only because the bundle ships no `promql` id.
Not fixed in #1085: registering Redis differently changes how every Redis tab is highlighted, which is not that PR's to change.

`grep -rn 'getLanguages().some' src/lib/editor/redis-language.ts` returns exactly one hit, that early return, and the bundle's own registration of the id is what `tests/isolated/monaco-language-ids.test.ts` asserts.

**Done when:** a Redis tab in the browser is tokenized by this repository's rules, through an id the bundle does not ship or by replacing the bundled tokenizer on purpose, with a test that fails while the bundled `redis` registration wins.

### U38. The mobile header offers Import Data on every connection

`src/components/studio/StudioMobileHeader.tsx` renders the Import Data item with `onClick={onImport}`, disabled only while no connection is active, and `src/components/Studio.tsx` hands it `onImport` unconditionally.
The desktop toolbar withholds the same action off SQL: `src/components/studio/QueryToolbar.tsx` draws its Import control only when `metadata?.capabilities.queryLanguage === "sql"`.
`src/components/DataImportModal.tsx` writes `CREATE TABLE` and `INSERT INTO` text and hands it to its `onImport`, which `src/components/Studio.tsx` wires to `executeQuery`, so on a phone a MongoDB, Redis, LibreDB, Prometheus or Apache Kafka connection can open the dialog and send SQL text to an engine that speaks none.
Read from the code, not measured on a device: the engine is expected to answer with a parse error and write nothing.

Found 2026-09-23 while classifying the shared surfaces for the Prometheus provider (#1085, section 3.2).
Not fixed in #1085: the mobile gate is shared by every engine, and aligning it changes a menu every connection renders.

**Done when:** the mobile header offers Import Data exactly where the desktop toolbar does, both read one capability rule, and a component test pins it for a SQL and a non-SQL connection.

### U39. The tab manager writes SQL for a row whose engine it does not know yet

`handleTableClick` and `handleGenerateSelect` in `src/hooks/use-tab-manager.ts` generate the statement through `generateTableQuery` and `generateSelectQuery` once the provider metadata has arrived, and otherwise write `SELECT * FROM <path>;` and a `SELECT ... LIMIT 100;` draft.
A statement written without capabilities cannot know the engine's language, so that fallback is SQL on every engine, MongoDB, Redis, LibreDB and Prometheus included.
The tree's click path, `onObjectClick` in `src/components/Studio.tsx`, returns while the metadata is null, but `onTableClick`, which the mobile explorer calls, has no such guard.
Reachability is unmeasured: the schema read fetches `/api/db/provider-meta` for itself before it lists anything (`src/hooks/use-connection-manager.ts`), so whether a phone can tap a row while the tab manager's metadata is still null was not measured; if it can, a non-SQL engine is sent SQL text.

Found 2026-09-23 while classifying the shared surfaces for #1085 (section 3.2).
Not fixed in #1085: the remedy is a guard or a refusal the whole shell shares, not a Prometheus arm.

**Done when:** no path writes a statement for a connection whose capabilities are unknown, the click waiting for them or refusing without them, with a test on the mobile path that taps a row before the metadata resolves.

### U40. Generate Test Data is withheld on MongoDB, whose insertMany output the generator writes and the provider runs

Both row menus offer Generate Test Data only where the row's kind declares `acceptsRowWrites` and the engine declares `supportsInlineRowEdit`: the desktop tree in `src/components/object-tree/row-actions.ts`, and since #1085 (decision D-M) the mobile menu in `src/components/schema-explorer/TableItem.tsx` by the same rule.
MongoDB's `collection` kind declares `acceptsRowWrites: true` while the engine declares `supportsInlineRowEdit: false`, so neither menu offers the item there.
Yet `src/components/TestDataGenerator.tsx` builds an `insertMany` command for a JSON connection, and the MongoDB provider runs `insertMany`, so the generator works where the gate withholds it.
`README.md` and its five translations promise "INSERT statements or MongoDB insertMany JSON" in the Test Data Generator bullet, output no menu now reaches.
Probably the same on ClickHouse and Trino, not measured: the generator writes one multi-row `INSERT ... VALUES`, `docs/providers/clickhouse.md` records a successful `INSERT`, and both engines declare `supportsInlineRowEdit: false`.

Found 2026-09-23 while aligning the mobile gate with the desktop one for #1085 (section 3.2).
Not fixed in #1085: the maintainer kept the desktop rule as it is for that PR (2026-09-23), and widening it is a product decision of its own.

**Done when:** either Generate Test Data is offered wherever the row's kind accepts row writes and the generator's output runs, through a gate that says so rather than through `supportsInlineRowEdit`, which describes the grid editor, with a MongoDB test on both menus, or the README bullets stop promising insertMany output.

### U41. The LibreDB provider's comment on `tablesAreDerivedGroupings` names one reader of the flag where there are six

The comment beside `tablesAreDerivedGroupings: true` in `src/lib/db/providers/embedded/libredb.ts` makes two claims the code no longer bears out.
It calls the Profile item in `src/components/object-tree/row-actions.ts` the flag's "only remaining reader", while six places read it: `src/components/admin/tabs/OperationsTab.tsx`, `src/components/object-tree/row-actions.ts`, `src/components/schema-explorer/TableItem.tsx`, `src/lib/agent/context-snapshot.ts`, `src/lib/agent/investigation.ts` and `src/lib/agent/tools.ts`.
It says `/api/db/profile` branches on `queryLanguage === "sql"` for this provider, while since #1085 the route refuses a JSON language with a dialect of its own before that branch, through `offersColumnProfiling`.
Its conclusion stays true: Profile cannot work on any kind of this provider.

Found 2026-09-23 while gating Profile for #1085 (section 3.2), whose isolation rule keeps that PR from editing any provider file but its own.
X13 already names this site in its **Done when**, so the change that settles X13 rewrites the comment too.

**Done when:** the comment names the flag's readers as the code has them, or names none, and says how the profile route refuses this provider today.

### U42. The export menu says it writes every row of a result a provider cut at its own bound

`describeExportScope` in `src/lib/export/scope.ts` words the export menu's summary from one condition: the grid can fetch a next page (the `pageOfferFor` answer `src/components/studio/BottomPanel.tsx` passes in) and the route's `pagination.hasMore` is true.
Only then does it say "Writes the N rows loaded here." with its shortfall sentence; otherwise it says "Writes all N rows.", and it never reads `pagination.wasLimited`.
A result a provider cut at its own bound meets neither half: since #1085 (section 5.4) `POST /api/db/query` keeps the Prometheus provider's `wasLimited: true` for a vector cut at the series cap, with `hasMore` false, and the engine cannot page, so no page is offered.
So the stats strip shows "limited", whose sentence says the result was bounded and that anything beyond the bound is not in it, while the export menu over the same result says every row is in the file.

Measured 2026-09-23 end to end: the Prometheus provider's own `query`, over an injected `send` answering 501 series, returned 500 rows with its series notice; the route's rule gave `pagination` `{ hasMore: false, wasLimited: true }` and `pageOfferFor` no offer, and `describeExportScope` answered "Writes all 500 rows." with no shortfall.
The control, 500 series with nothing cut, answers the same sentence, so the menu cannot tell a cut result from a whole one.
The two shapes alone, from the repository root:

    bun -e 'import { describeExportScope } from "./src/lib/export/scope"; const rows = Array.from({ length: 500 }, () => ({})); console.log(describeExportScope({ rows, pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 500, wasLimited: true } }, false).summary); console.log(describeExportScope({ rows }, false).summary);'

Both lines print `Writes all 500 rows.`.
The same sentence is written for an engine that cannot page over a preview that filled its bound: "an engine that cannot page is not asked to load more first" in `tests/unit/lib/export/scope.test.ts` expects "Writes all 50 rows." for a preview whose `hasMore` is true, where that test's subject is the shortfall's instruction to load more, which rightly stays absent there.
X2 is the other half of the same problem, an export that writes the whole result rather than the page the grid holds.

Found 2026-09-23 while making the query route keep a provider-reported `wasLimited` for #1085 (section 5.4).
Not fixed in #1085: the export dialog is shared by every engine, and that PR changes only how the route reports the bound.

**Done when:** the summary says "all" only for a result nothing cut, a result whose `pagination.wasLimited` is true reads as the rows loaded here without an instruction to load more where no page can be fetched, and tests pin a result a provider cut, a bounded preview on an engine that cannot page, and a complete result.

### U43. The gate's SQL keyword test prompts on a Redis read whose arguments include `update` and then `set`

`isDangerousQuery` in `src/components/QuerySafetyDialog.tsx` runs its SQL keyword test in front of the Redis row of `NON_SQL_DESTRUCTIVE_VOCABULARY`, and that test's unanchored `UPDATE ... SET` probe finds the two words anywhere in the buffer.
So a legal read whose arguments include `update` and then `set` opens the Query Safety Check dialog, and posts the command for AI analysis, on both execution paths: `MGET update set`, `HMGET h update set` and `EXISTS update set` each ask, while the Redis row alone answers no for each (measured against the two functions on 2026-09-23, with `DEL k` asking under both as the control).
What the keyword test adds for Redis is a prompt on a buffer that leads with a SQL write keyword, and Redis has no command by any of those names, so that text errors without it.

Found 2026-09-23 while giving PromQL its own row in that table for #1085 (section 2), the row that answers alone.
Not fixed in #1085: a new provider changes no other provider's behaviour, and this is Redis's.

**Done when:** the Redis row declares `decidesAlone: true`, as the Prometheus row does, and `still prompts for a destructive keyword under redis` in `tests/components/QuerySafetyDialog.test.tsx` becomes rows pinning that `MGET update set` does not ask while `DEL k` still does.

### U44. The chart tab draws a missing value, and a `NaN` or `Inf` among numbers, at 0

`chartData` in `src/components/DataCharts.tsx` maps each y cell through `typeof value === "number" ? value : Number(value) || 0`, so a `null` is drawn at 0, and so are the strings `"NaN"`, `"+Inf"` and `"-Inf"`, whose `Number` is `NaN`.
`aggregateData`, which the aggregation and date-grouping controls reach, and the histogram and scatter mappings coerce the same way, and no `Line` or `Area` sets `connectNulls`.
`analyzeField` counts only the filled cells and types a column numeric when more than 80% of them are numbers, so a sparse column is still drawn as a line and a non-finite cell among numbers is drawn at 0.
A column whose `NaN` or `Inf` strings are 20% or more of its filled cells is not numeric and is not offered as a series; it is typed categorical only while it holds at most 50 distinct values, each number and each of the strings counted once, and only then does the first categorical column in field order replace a date column as the default x axis, while past 50 it is typed unknown and the date column stays the default.
Since #1085 the Prometheus wide matrix meets this on an ordinary answer: its rows are the union of every series' instants, and a series with no sample at one holds `null` there (`shapeMatrix` in `src/lib/db/providers/timeseries/prometheus/results.ts`), so a raw range over targets scraped at their own offsets holds few of its series' samples on each row.
Measured 2026-09-23 through the provider's shaper and the chart's own mapping: `up[5m]` from the compose server (`tests/fixtures/prometheus/v3.13.3/query-matrix-raw-all.json`) shaped into 29 rows of 4 series with 87 of its 116 cells `null`, and each was plotted at 0, which for `up` reads as a target that was down; `analyzeField("v", [1, 2, 3, 4, 5, "NaN"])` types its column numeric, so that `"NaN"` is plotted at 0 as well.
A stepped subquery gives aligned rows and charts correctly while every series has a sample at every step, which is the only chart the manual pass of #1085 (section 9, gate 5) draws.
Filtering the non-finite values in PromQL (`x > -Inf < +Inf`) takes them out of the answer, which in a matrix of several series leaves a `null` that is plotted at 0 too.
The same mapping draws every engine's SQL `NULL` at 0.

Found 2026-09-23 by the #1085 review.
Not fixed in #1085: the wide matrix was chosen so that the chart needed no change (#1085, section 5.3), and drawing a `null` as a gap changes how every engine's `NULL` charts, a decision for the chart rather than for one provider.

**Done when:** no mapping plots a `null` or a non-finite y cell at 0, a line over a date x axis joins the samples its series has (`connectNulls`), and `tests/components/DataCharts.test.tsx` pins a two-series raw range with interleaved instants and a numeric column holding `"NaN"`, each asserting that no 0 reaches the chart for a cell that held no number.

### U45. The connection status badges read a refused connection as slow, timed out or online

Three surfaces report whether a connection works, and none of them says it was refused.
- `checkHealth` in `src/hooks/use-connection-manager.ts` sets the pulse to `"degraded"` for any answer of `POST /api/db/health` that is not OK, and `src/components/studio/StudioDesktopHeader.tsx` renders `"degraded"` as "Slow", so a server that refused the credentials reads "Slow" in the desktop header.
- The fleet list of `src/components/admin/tabs/OverviewTab.tsx` renders every item whose `status` is `"error"` as "timeout", beside the message that says what the error was.
- `src/components/studio/StudioMobileHeader.tsx` renders the label "Online" for every active connection without reading the health check, and the pulse dot beside it draws `"degraded"` in the warning tint under the title "Connection: degraded".
Seen 2026-09-23 in the #1085 browser pass on a Prometheus connection with a wrong password: `/api/v1/status/buildinfo` answered HTTP 401, and the desktop header read "Slow", the admin fleet "timeout" and the mobile header "Online", while the object panel showed the refusal itself.
None of it is engine-specific: the three lines predate #1085 and none of them reads the connection's type, so every engine takes the same paths.

Found 2026-09-23 by the #1085 browser pass.
Not fixed in #1085: the three components serve every engine, and that PR changes no shared surface's behaviour for the engines it does not add.

**Done when:** a failed health check reads as an error on the desktop header, the mobile header and the admin fleet, "Slow" and "timeout" appear only for an answer that was slow or timed out, and a component test pins each state on each of the three surfaces.

### U46. The functional smoke's RUN locator also matches the agent rail's Run history button

`e2e/functional-smoke.spec.ts` clicks `page.getByRole("button", { name: "RUN" })`, which Playwright matches case-insensitively as a substring, so it also matches the agent rail's `Run history` toggle (`data-testid="agent-history-toggle"`, `src/components/agent/AgentRail.tsx`).
The rail renders only where an LLM is configured, which CI never is, so the required check passes while the same spec fails with a strict-mode violation on any machine whose `.env` configures one.
Measured 2026-09-23 on the #1085 branch: the spec failed with `strict mode violation: getByRole('button', { name: 'RUN' }) resolved to 2 elements` under the local `.env`, and passed with `LLM_PROVIDER`, `LLM_API_KEY` and `LLM_MODEL` set empty.

Found 2026-09-23 while running the #1085 local gates.
Not fixed in #1085: the spec and the rail predate it.

**Done when:** the spec's locator names the editor's RUN button alone (`exact: true`, or a test id of its own), and the spec passes with an LLM configured.

### U47. In the embedded `StudioWorkspace`, Cmd/Ctrl+Enter, "Run Query" and "Run Sel" run nothing, and the toolbar Run sends the whole buffer

`handleExecute` in `src/components/QueryEditor.tsx` syncs the buffer, flashes the range it will run and dispatches a window `execute-query` event whose `detail.query` is the selection, or else the statement at the caret; the Cmd/Ctrl+Enter command, the "Run Query" context-menu entry and the editor's "Run Sel" button all end there.
The only listener is in `src/hooks/use-query-execution.ts`, which only the standalone `src/components/Studio.tsx` uses.
The embedded `StudioWorkspace` (`src/workspace/StudioWorkspace.tsx`, the npm package's shell) runs queries through `useQueryAdapter`, which registers none, so in the published shell those three controls never reach the host's `onQueryExecute`.
The one control that runs there is the toolbar Run, and `executeQuery` in `src/workspace/hooks/use-query-adapter.ts` sends `overrideQuery || tabToExec.query`, the whole buffer: it never asks the editor for `getEffectiveQuery`, as `use-query-execution.ts` does, so neither a selection nor the statement at the caret can be run in that shell.
On a PromQL tab that is a refusal: a buffer holding `up` and `rate(prometheus_http_requests_total[5m])` on two lines is sent whole, and the server answers `bad_data` with `2:1: parse error: unexpected identifier "rate"`, while `up` alone answers.
The editor shows its Cmd/Ctrl+Enter hint in both shells, and the shortcut list in `docs/FEATURES.md`, generated from `src/lib/keyboard-shortcuts.ts`, offers it without naming a shell.
Reproduced 2026-09-23 by mounting the real `StudioWorkspace` and the real `QueryEditor` with only Monaco doubled: on a PostgreSQL host with the buffer `SELECT 1;` and `SELECT 2` on two lines and `SELECT 2` selected, Cmd+Enter, "Run Query" and "Run Sel" each dispatched `execute-query` with `SELECT 2` and `onQueryExecute` received nothing, and the toolbar Run then sent both statements.
`git log -S'execute-query' -- src/workspace` is empty, so the embedded shell never listened, and `tests/components/StudioWorkspace.test.tsx` mocks `QueryEditor`, so no test reaches the embedded run shortcut.

Found 2026-09-23 by the #1085 review.
Not fixed in #1085: the defect predates it, and a window listener in `StudioWorkspace` is not the remedy, because the event is global to the page: two mounted workspaces would both run one keystroke, and a host that also mounts the exported `QueryEditor` would have that editor's text run against the workspace's connection.

**Done when:** the editor's run request reaches only the shell that mounted it, for example through an optional `onExecute(query)` prop that `handleExecute` calls in place of the window event and that `StudioWorkspace` passes as its own run; the embedded toolbar Run reads the editor's effective query as the standalone one does; and a `StudioWorkspace` test that mounts the real `QueryEditor` over a Monaco double fires the captured Cmd+Enter command over a selection and asserts that `onQueryExecute` receives only the selected text, with two mounted workspaces as the control, where only the workspace whose editor ran it runs.

### U48. A result header whose name holds wide characters opens narrower than its name

`getHeaderFitColumnSize` in `src/components/results-grid/column-sizing.ts` sizes a desktop result header as `field.length` times 7.2px, the Geist Mono advance at the header's 12px.
A Chinese, Japanese or Korean character renders at about the full 12px, so a name written in one of them gets about 60 percent of the width it needs.
Measured 2026-09-24 in Chromium on the Sample (Employees) connection: the alias `顧客登録番号` needed 72px of text and was given 51px, so its name was cut at every width from 768px to 2560px; the fixed 150px column before #1113 cut it too.

Found 2026-09-24 by the #1113 review.
Not fixed in #1113: the issue asked for a header fit, and a rule for wide characters needs its own measurement.

**Done when:** a name made of wide characters opens at a width that shows it whole, below the 500px cap, and `tests/unit/components/results-grid-column-sizing.test.ts` pins one.

### U49. The result header width is computed in pixels while the header is sized in rem

The desktop result header is `text-xs`, `px-4` and `gap-1` with `w-3` icons, all rem based, but `getHeaderFitColumnSize` in `src/components/results-grid/column-sizing.ts` adds fixed pixel constants.
A reader whose browser sets a larger default font gets a larger header inside a column sized for a 16px root.
Measured 2026-09-24 in Chromium at 1280px with the root font size set to 20px: all 13 headers of a 13 column result were cut, against 12 of 13 with the fixed 150px column before #1113, and a one letter column at the 80px minimum had no room left for its name.

Found 2026-09-24 by the #1113 review.
Not fixed in #1113: the fixed width before it was cut at that setting too, so this is not a regression of that change.

**Done when:** the header width follows the root font size, either by scaling the result or by stating the constants in rem, and a test at a 20px root pins a name that is shown whole.

### U50. The connection dialog carries the SSH tunnel of one connection into the next

`useConnectionForm` in `src/hooks/use-connection-form.ts` loads the SSH state on an edit only when the edited connection has a tunnel (`if (editConnection.sshTunnel?.enabled)`), and its reset on close clears none of the SSH state, so the switch, the bastion's host, port and user, and its password, private key and passphrase stay in the hook from one dialog to the next.
Reproduced 2026-09-25 with a scratch hook test, not committed: after editing a PostgreSQL connection with a tunnel and closing the dialog, `sshEnabled` was still `true` and `sshPassword` still the bastion's password, and editing a PostgreSQL connection without a tunnel then showed `sshEnabled` `true` and the first connection's `sshHost`.
`buildConnection` writes `sshTunnel` whenever `sshEnabled` is set and the type offers the panel, so saving that second connection gives it the first one's tunnel, credentials included.
A Kafka connection is kept out by the `offersSshTunnel` gate of `buildConnection`, and a file-based engine, whose panel `isFileBased` hides, stores the leftover tunnel inertly, because no tunnel opens for a connection without a host and port.

Found 2026-09-24 while adding the Kafka connection's tunnel gate (#1088, section 6.1).
Not fixed there: the reset is shared by every engine's dialog.

**Done when:** loading an edit target sets every SSH field from it, the reset on close clears them, and a hook test edits a tunnelled connection, closes the dialog, edits one without a tunnel and finds the switch off and every SSH field empty.

### U51. The admin Operations list says "No tables found." beside an overview that counts tables

`OperationsTab.tsx` in `src/components/admin/tabs/` answers an empty table list with "No tables found." whenever no `tableStatsCaption` scopes it, while the monitoring Tables tab, `TablesTab.tsx` in `src/components/monitoring/tabs/`, answers the same empty list beside an overview whose `tableCount` is above 0 with "No table statistics available." (`statsAbsent`), because the statistics are absent rather than the tables.
Redis shows it today, and Apache Kafka does too, whose `getTableStats` answers `[]` because a topic has no honest message count while its overview counts every topic (#1088, section 7.1).
Reproduced by the committed tests: "an empty list keeps its empty-state copy under a caption, and one beside a counted overview carries none" in `tests/components/admin/OperationsTab.test.tsx` pins "No tables found." beside `tableCount: 344`, and `tests/components/monitoring/TablesTab.test.tsx` pins "No table statistics available." for the same shape.
D111, MySQL's capped list, is a different defect of the same list: there the list holds rows, and a search outside them answers "No tables found.".

Found 2026-09-24 while classifying #1104's diff for the Kafka provider (#1088).
Not fixed there: the list and its copy are shared by every engine.

**Done when:** the Operations list answers an empty list beside a counted overview as the Tables tab does, and the Operations test pins it.

### U52. A Kafka read request gets no completion or validation in the editor

A Kafka tab renders in Monaco's built-in `json` mode with no schema, and `QueryEditor.tsx` in `src/components/` registers the MongoDB completion provider only where no JSON dialect is declared, so a read request gets bracket matching and JSON syntax errors and nothing about its own keys.
An unknown key, a misplaced `offset`, or a timestamp without a zone is found only when the request runs and the provider refuses it (`docs/providers/kafka.md` section 5.1).
`monaco.languages.json.jsonDefaults.setDiagnosticsOptions` takes a JSON schema per model, which could carry the request's schema of `parseReadRequest` in `src/lib/db/providers/stream/kafka/request.ts`; nothing in `src/` calls it today.

Found 2026-09-23 while designing the Kafka provider (#1088, section 3.3).

**Done when:** a Kafka tab offers the request's keys and `from` forms as completions and marks an unknown key or a wrong type before the run, from one schema a test holds equal to what `parseReadRequest` accepts, and no other `json` tab takes that schema.

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

### DOC6. Comments and doc sentences about other providers still count the fleet as it stood before #1085

Four comments inside provider directories, one test comment beside them and eight sentences of other providers' docs count the providers as they stood before #1085 made the shipped type-ids eighteen, served by seventeen provider implementations because `elasticsearch` and `opensearch` share one.
Four of the eight doc sentences mirror the comments; the other four have no code twin.
- `src/lib/db/providers/document/mongodb.ts`, the `describeObjects` docblock: "this method is the ONE place in the seventeen providers where a per-object read survives", mirrored in `docs/providers/mongodb.md` under "What `describeObjects` answers, and the one half this engine cannot bulk-read".
  Still true of eighteen, because the Prometheus bulk read is one series read; the count is what is stale.
- `src/lib/db/providers/sql/druid/objects.ts`, point 4 of the header: "the guard the other sixteen providers write is absent here", mirrored in `docs/providers/druid.md` under "`describeObjects()` describes a whole folder in ONE statement (#789)", point 2.
  Prometheus writes that guard too, answering a kind with no columns with `{ details: [] }` and no read, so the others are seventeen.
- `src/lib/db/providers/sql/libsql/objects.ts` and `src/lib/db/providers/sql/sqlite.ts`, on why no synthetic `main` container is invented "to make the shape match the other sixteen engines", with the same words in `tests/integration/db/sqlite-provider.test.ts` and in the zero-container sections of `docs/providers/libsql.md` and `docs/providers/sqlite.md`.
  No number makes that true: libSQL, SQLite, Elasticsearch, OpenSearch and Prometheus all declare `containerLevels: []`, so the other engines are not a set that has a container level.
- `docs/providers/mongodb.md`, twice more on "17 type-ids": the closing parenthetical of section 7.2, on `HealthInfo.slowQueries` becoming optional, and the section 13 bullet "A failed overview read still reports `tableCount: 0` and `indexCount: 0`", on `DatabaseOverview.tableCount` and `indexCount` becoming optional.
  The second breaks its line between "across all" and "17 type-ids", so a search for the longer phrase finds only the first.
- `docs/providers/mysql.md`, section 12.1, on what "the other sixteen provider test files would receive", where there are eighteen provider test files.
- `docs/providers/postgres.md`, section 3.1.4, "this is the line the fifteen other providers are read against", written when the implementations were sixteen.
  Each of these four counts one short now.

Amended 2026-09-25: the Kafka provider (#1088) made the shipped type-ids nineteen, served by eighteen implementations, and each count above is now one further behind.
It edits none of these files, and it leaves as they were these fleet counts in comments that the list above did not hold, found by the numeral grep over `src`, `tests` and `e2e`:
- `src/lib/api/object-route.ts`, the source-bound slicer's docblock: "all sixteen providers cut through `applySourceBound`".
- `src/lib/db/types.ts`: "Sixteen engines answer `listObjects` from a stored definition", in the key-scan docblock #1095 wrote, and "fourteen of the seventeen type ids on day one", in the `buildObjectEdit` docblock.
- `src/components/sidebar/Sidebar.tsx`, #1095's key-tab docblock: "the other sixteen shipped type ids are untouched by it".
- `src/lib/agent/schema-stats.ts`, the no-statistics docblock: "on the twelve type-ids whose inventory comes from their own provider", which are seventeen now.
- `tests/unit/db/duckdb/seam-guard.test.ts`, the header: "the fourteen engines that are not DuckDB".
- `e2e/login.spec.ts` and `tests/components/LoginPage.test.tsx`: "forty named products" and the "twenty-six" relatives, written for the gap each test closes and true of the registry then.

Found 2026-09-23 by the #1085 review.
Not fixed in #1085: that PR edits another provider's doc only where a shared surface it changed alters what the doc describes, and no count here is about such a surface; the four comments sit in other providers' directories, which it does not edit, so their mirrors stay with them to change together.

**Done when:** each names the set it counts instead of a number, or the number its set has, and the doc sentences that mirror the comments say the same, as do the four doc sentences without a code twin.

### DOC7. Four translated READMEs still say the SSL/TLS panel takes effect on nine engines

The transport paragraph of `README_es.md`, `README_ja.md`, `README_hi.md` and `README_ur.md` carries wording `README.md` replaced in #466: it names the engines the SSL/TLS panel takes effect on, PostgreSQL to Trino, and says that Oracle, MongoDB and Redis ignore the option.
`README.md` says instead that the panel is honoured by every engine that shows it, which is every engine but SQLite, DuckDB and the embedded LibreDB, and the three named as ignoring it read `config.ssl` (`src/lib/db/providers/document/mongodb.ts`, `src/lib/db/providers/keyvalue/redis.ts`, `src/lib/db/providers/sql/oracle.ts`), while libSQL and Cassandra, which honour it, are not in the list, and libSQL is not in the connection-string list beside it either.
#1085 added Prometheus to that list in all four files, because each file's new Prometheus row tells the reader to enable TLS, and changed nothing else there.
`README_zh.md` already carries the English wording.
Each file's translation-lag banner names `README.md` as the one that wins, and `bun run readme:check` reads no prose, so nothing flags the paragraph.

Found 2026-09-23 by the #1085 review.
Not fixed in #1085: rewriting one paragraph in four languages is the per-language follow-up #1055 leaves to a speaker of each.

**Done when:** each of the four paragraphs says what `README.md` says about the panel, Oracle's certificate caveat and the libSQL connection string included.

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

### REL4. Two tests scan gitignored files, so a local draft fails a gate CI cannot

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

`tests/unit/published-credentials.test.ts` is the same defect in a second test, measured while
cutting 0.16.1. It walks the working tree for published passwords, and `deploy/rancher/results/` -
gitignored at `.gitignore:162`, written by the Rancher E2E run skill - holds the per-scenario
`secrets.txt` files that run generates. Six offenders in `assigns no admin or user password
anywhere` and one in `hands no working password to a login example`, all from paths CI never checks
out. Its floor assertion needs the same treatment as the citation scan's.

**Done when:** both scans enumerate tracked files, for example by driving the glob through
`git ls-files` and intersecting, so a working tree with local drafts under `docs/` or `deploy/`
gives the same verdict as a clean checkout. Each scan's own floor assertion stays, so a broken
enumeration still fails loudly rather than passing vacuously.

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

### H12. A `jwtVerify` failure in the proxy leaves a log line and no audit event

The proxy refuses a request on three grounds and audits two of them. `src/proxy.ts` emits
`origin_mismatch` at `:65` and `insufficient_role` at `:156`, both through `emitAuditEvent`. The third
is the trailing `catch` at `:173-176`: a token that fails `jwtVerify` because it is forged, tampered,
expired or truncated falls into `logger.warn("JWT verification failed, redirecting to login")` and
redirects. Nothing reaches the audit channel.

An operator reading `GET /api/admin/audit` sees origin and role refusals and no forged-token attempts
at all, which is the direction the blind spot matters: those are the probes a deployment most wants
counted. The stdout line still exists and still lands in the aggregator, so the evidence is not lost,
only off the surface an operator is pointed at.

Recorded here rather than fixed with the note, because closing it is a behaviour change rather than a
wording one: the catch has to distinguish a verification failure from a missing token, since
`/login` redirects with no cookie are ordinary logged-out traffic and the note already excludes them.
Whatever emits needs its own test in `tests/security/auth-audit.test.ts`, and the emit is metered
through the anon bucket like every other `permission_denied` line.

**Done when:** the verification-failure arm of that catch emits an audit event naming the route and
the reason, distinct from a missing token, with the row 1.4 residual in `docs/SECURITY.md` deleted.

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

## Security scanner triage

A scanner finding that is open, is not failing a required check, and needs a written ruling before it can be dismissed or fixed.
CodeQL alerts anchor to a source location, so moving the code re-reports them and a dismissal made against the wrong location does not hold.

### SCAN1. CodeQL alert 536, polynomial ReDoS in the MCP error redactor, needs a ruling

`js/polynomial-redos`, security severity high, open against `refs/pull/1070/merge` at `src/lib/mcp/serializer.ts:94`.
CodeQL's text: "This regular expression that depends on a user-provided value may run slow on strings starting with 'A' and with many repetitions of 'A'."

The rule redacts credentials out of driver error messages before they reach an MCP client:

```js
out = out.replace(/\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)[^/\s]+@/g, "$1[REDACTED]@")
```

The input is a driver error message, so a caller who can get a chosen string into one (a long nonexistent table name, for instance) feeds the regex.
That is the uncontrolled-data path CodeQL names.

Measured on bun 1.4.2 on 2026-09-24: the shipped rule is linear, 0.09 ms on a scheme plus 50 KB and 0.40 ms on a scheme plus 240 KB.
`[^/\s]+` excludes `/` and whitespace, which is narrower than the shape analysis sees, so it reads as a false positive.
That measurement is one runtime and is not a ruling.

Two things keep it open rather than settled.
The CodeQL check reports SUCCESS because alerts do not fail the job, so a green rollup hides this.
And the code does not exist on `main`: it arrives only if #1070 merges, and a dismissal must be made against the merged location.

Related and separate: the test that claims to cover this (`tests/unit/mcp/serializer.test.ts:104`) cannot fail for the flagged branch, because its payload has no `://` and so never reaches the `[^/\s]+@` quantifier.
A catastrophic variant of the same rule measured 0.06 ms on that payload, inside its 100 ms budget, and 653 ms on `"http://"` plus 37 characters.
That one is the contributor's to fix and was raised on #1070.

**Done when:** alert 536 carries a written ruling, either dismissed as a false positive with the reason recorded, or the expression narrowed so the alert closes on its own.

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

### B5. The agent run ledger cannot fence two writers, so single ownership has to be asserted above it

`run-store.ts` and `run-service.ts` are append-only over the durable world's stream primitives, which
offer no compare-and-append: a writer cannot say "append this only if the stream is still at index N".
Two consequences follow, and only the process-local half of the second is closed:

- **Two concurrent opens on one caller-supplied run id write two headers.** The fold refuses a ledger
  with a second header (`MALFORMED_LEDGER`), permanently, for every later read. The race does not
  resolve in one side's favour — it bricks the run. Run creation still has to be serialized by its
  caller.
- **Two loops driving one running run would both perform the same step.** The drive claim is now a
  DURABLE ledger record — `drive-claimed`/`drive-released` — rather than a memory-only set, and
  `tryClaimDrive` serializes check-then-append per store instance (#998, pinned by a fifty-claim
  concurrency test). The cross-process half is open: two replicas would still both pass the
  read-then-append check, because the durable world offers no tail-index conditional append (B16).

**Done when:** the ledger can append conditionally on the stream's tail index, or the single-ownership
guarantee is asserted for every backend a deployment can reach. The process-local durable claim is
asserted in `tests/unit/lib/agent/run-store.test.ts`.

### B6. The repair ledger is per-drive, so a resumed run's repair attempts start over

`ExecutionBudgetTracker` (`maxStatementsPerRun`, `maxTotalRunMs`), `AgentRunDeadline` and the artifact
allowance were all constructed by the process that drives a run and lived only in its memory, so a run
resumed after a process death was handed a fresh set. Those are now derived from the run's own ledger
(#999): the deadline from `createdAtMs`, the statement and elapsed-time spend folded from
`tool-completed` entries, and the artifact allowance from the workflow ceiling. A run that dies and
resumes ten times no longer multiplies those tenfold.

`AgentRepairLedger` is the remaining per-drive piece: `runtime.ts` rebuilds it fresh for every drive,
so a resumed run starts its repair attempts over. Ten resumes can therefore still spend ten repair
budgets, even though each drive stayed honestly inside its bounds.

**Done when:** a drive's repair attempts are derived from the run's own history — or the per-drive
rebuild is asserted by a test rather than assumed — with a test that resumes a run twice and shows the
second drive inheriting the first's repair spend.

### B9. The resume sweep is local-only, and a resumed run is not driven back into the rail

The local sweep (#1000) now finds runs a dead process left `running` and drives each one again, with
the drive's own claim as the single-flight and B6's cross-drive ceilings accounted for. What remains:

- **The sweep is local-only.** It lists the `local` world's ledger streams; the multi-replica Postgres
  world is absent from the shipped artifacts (B16), so no cross-replica sweep exists.
- **A user-visible resume does not re-attach the rail.** `resumeRun` sets the run back to `running`, but
  `driveAgentRun`'s only callers are the start route and the drive route — neither on the resume path —
  so a run resumed from the rail is picked up by the sweep, eventually, rather than by the rail's own
  stream.

**Done when:** a resumed run is driven on every backend a deployment can reach, and the rail re-attaches
to the resumed run's stream instead of waiting for the sweep.

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

### B82. The resume sweep keeps re-driving a run that dies again at the same point

The sweep that #1000 added finds a run a dead process left `running` and drives it again, once per
interval. A run whose process dies WITHOUT recording a failure — a hard crash, `kill -9`, a host
reboot — stays `running`, so after its claim expires the sweep picks it up again. If it dies again at
the same point, the sweep repeats this at every interval, forever.

`driveAgentRun` turns a THROW into a terminal `failed` run, so an ordinary failure does not loop; this
entry is only the case where the process is gone before it can write anything. There is no attempt
counter, no max-retry and no dead-letter, because the sweep cannot tell "crashed again" from "never
attempted": neither writes a record.

**Done when:** the sweep stops re-driving a run after a bounded number of consecutive unrecorded
deaths and says so — in the run's ledger or in the operator log.

### B83. A paused run holds its budget, artifacts and ledger stream until it is unpaused or cancelled

Pause (#1001) added `paused` as a non-terminal state, but the state does not release the run's
resources: `releaseExecutionRun` and the ledger `close` run only inside `finalize`, so a run paused
for a long time keeps its budget registration, its stored artifacts and an open ledger stream.
Cancelling a paused run releases them (cancel finalizes it immediately), and unpausing drives it
again — but a run left paused holds them for as long as it stays paused.

This is the half of the old B11 that closing it did not build. B11 asked for "a run state between
running and terminal that releases the run's resources without ending it, and a resumed run would
have to re-acquire them". The state exists; the release-and-re-acquire half does not.

**Done when:** a paused run releases its budget and artifacts (and closes its stream) while it stays
paused, and a resumed run re-acquires them — or the decision is recorded that pause deliberately
retains them, with the resource bound that makes that safe.

### B84. On a large Prometheus server, plan mode grounds metrics and nothing else

The grounding walk, `walkObjectInventory` in `src/lib/agent/tools.ts`, describes each folder with `describeObjects(container, spec.id, listed.length)` (`:2581`), keeps the batch's `truncated` (`:2586`), and ends the whole walk at the first truncated batch (`:2610`, `:2612`).
The Prometheus provider (#1085) declares its six kinds with metrics first, the order the tree draws its folders in, and its metric batch is truncated on any server with more than `METRIC_LIST_CAP` metric names, because its one series read then names more metrics than the capped listing holds, or with more than `DESCRIBE_SERIES_CAP` series in the hour (`src/lib/db/providers/timeseries/prometheus/objects.ts`).
So on such a server a plan run's inventory holds metrics and no rule group, rule, scrape pool or target, and a question about alerts or scrape health is drafted over an inventory that lacks what it asks about.
The inventory's `truncated` does tell the run that the reading is incomplete; what the run cannot reach is the rest.
The compose `prometheus` service, a self-scrape far below both caps, cannot show it, so this is filed from the code rather than from a live run.

Not fixed in #1085: each remedy moves something else, because a per-kind share of the object budget changes every engine that grounds through its provider, declaring metrics last changes the tree's folder order, and a batch that hid its bound would present a partial column list as complete (#1085, section 4.2).

**Done when:** a plan run against a Prometheus server past either cap holds its rule groups, rules, scrape pools and targets, with a test that drives the grounding walk over a provider whose first kind's batch is truncated and asserts that the later kinds are still read.

### B85. The least-privilege `agentUser` never reaches an agent run

`docs/AGENT.md` says every agent acquisition opens with "the same optional least-privilege `agentUser`", and `acquireExecutionProfileProvider` in `src/lib/db/factory.ts` opens a profile as `agentUser` whenever a connection carries it with `agentPassword` (#328).
No run's connection can carry the pair.
A run opens on a `seed:` id only: `POST /api/agent/runs` refuses an inline connection (`src/app/api/agent/runs/route.ts:283`), and the run route, the drive in `src/lib/agent/runtime.ts` and the hand-over route `src/app/api/agent/runs/[runId]/handover/route.ts` resolve the id through `resolveConnection` in `src/lib/seed/resolve-connection.ts`, which refuses an id outside that namespace.
`SeedConnectionSchema` in `src/lib/seed/types.ts` declares neither field, and zod strips an unknown key without an error, so a seed file that sets both parses and loses them.
A browser copy of the seed that carries its own pair no longer resolves to the seed, because `src/hooks/use-connection-payload.ts` classifies both fields as `resolution`, so that copy is browser-only and no run starts on it.
So an agent runs as a least-privileged role only where the seed's own `user` is that role, which is the only way the dvdrental run of `docs/AGENT_DEMO.md` can read as `libredb_agent`.

Found 2026-09-23 while classifying the agent surfaces the Prometheus provider reaches (#1085, section 3.2).
Not fixed in #1085: a seed field for the pair changes the operator's seed contract for every engine, and its password needs the `${vault:...}` resolution `password` has (`RESOLVABLE_FIELDS` in `src/lib/seed/credential-resolver.ts`), neither of which that PR touches.

**Done when:** a seed can declare `agentUser` and `agentPassword`, the password resolves as `password` does, a run on that seed opens its execution profiles as `agentUser`, and a test drives a run's acquisition from such a seed.

### B86. A block tagged `cql` is read as the plan deliverable on every engine, not only Cassandra

`cql` is in `QUERY_FENCE_ALIASES` and not in `ALIAS_ENGINES` (`src/lib/sql/fence-tags.ts`), so `fenceTagEngine("cql")` is `null`, and `fencedBlock` in `src/lib/agent/plan-draft.ts` reads a tag that names no engine as one that cannot contradict the connection.
So on a PostgreSQL plan run a CQL block written before the `postgres` block is recorded as `plan-statement-drafted`, stamped `postgres` and judged by the SQL guard, and a closing whose only block is tagged `cql` is read as the run's statement, so the run is not asked for one.
The reason the comment at the `cassandra` entry of `ENGINE_FENCE_TAGS` gives, that ScyllaDB speaks CQL too, does not hold for this record: an entry names the type-id a block's text runs on, and ScyllaDB connects through `cassandra` (`src/lib/db/compatibility.ts`).
`promql` had the same flaw, and #1085 fixed it by naming `prometheus`.
Reproduced 2026-09-23 on `main` and on the #1085 branch: `readPlanStatement` over a `cql` block then a `postgres` block, on dialect `postgres`, returns the CQL, and over a `cql` block alone returns it as the statement.

Found 2026-09-23 in the #1085 review.
Not fixed in #1085: the alias predates it, and that PR changes no existing arm's behaviour (#1085, section 3.5).

**Done when:** `fenceTagEngine("cql")` is `"cassandra"`, a `cql` block before a `postgres` block on a PostgreSQL plan run records the PostgreSQL statement, a `cql`-only closing there records none and is asked for one, a `cql` block on a Cassandra run is still the deliverable, and the `cql` test in `tests/unit/lib/sql/fence-tags.test.ts` and the comment at the `cassandra` entry state the type-id rule.

### B87. A run's inventory count names every kind with the engine's own noun

`captureContextSnapshot` counts every object the inventory read, whatever its kind, and both places that show the count name it with the engine's entity noun, which `inventoryNoun` in `src/lib/agent/inventory-noun.ts` takes from `ProviderLabels.entityName`: the answer card in `src/components/agent/AnswerCard.tsx` ("`N` tables read") and the inventory header `src/lib/agent/context-snapshot.ts` writes into the prompt ("`N` table(s) read").
So a SQLite run over six tables and two views reads "8 tables read", and a Prometheus run over 344 metrics and 22 rule groups, rules, scrape pools and targets reads "366 metrics read".
Each inventory row carries its own kind, so the model is not misled about any one object; the number is what names the wrong thing.
Measured 2026-09-23 in the #1085 browser pass: `context-captured` recorded `tableCount` 366 with the noun `metric` on the compose Prometheus, and a SQLite plan run over the sample employees database showed "8 tables read".

Found 2026-09-23 by the #1085 browser pass.
Not fixed in #1085: the count and its noun predate it and serve every engine.

**Done when:** the answer card and the inventory header name what the count counts, the objects or each kind by its own label, and a test pins a capture of two kinds on each.

### B88. A kind whose listing is refused ends the grounding walk, so plan mode on VictoriaMetrics reads nothing

`walkObjectInventory` in `src/lib/agent/tools.ts` skips only a kind counted zero (`:2558`) and lists a kind whose count was refused as well, calling `listObjects` with no catch of its own (`:2566`).
VictoriaMetrics answers `/api/v1/scrape_pools` with HTTP 400, so the Prometheus provider counts scrape pools as unavailable and then throws a `ConnectionError` when the walk lists them.
The capture is all-or-nothing by design (the module docblock of `src/lib/agent/context-snapshot.ts`), so the run gets no inventory and the refusal `This run could not reach this prometheus database to ask it for its schema, so nothing was read for this run.`, although the server answered three of the four listings.
Measured 2026-09-24 against VictoriaMetrics v1.152.0, single node: `captureContextSnapshot` and `readObjectInventoryForGrounding` both refused, and the 329 metrics and 5 targets already read were dropped; the same calls against Prometheus 3.13.3 captured.
Only a seeded connection is affected, because a run opens on a `seed:` id only (B85).
On a VictoriaMetrics server past `METRIC_LIST_CAP`, the walk stops at the truncated metric batch first (B84) and grounds metrics only.
A Redis-wire relative that refuses `FUNCTION LIST` (KeyDB, DragonflyDB, Garnet) may end the walk the same way; that was read, not measured.

Found 2026-09-24 while checking the VictoriaMetrics relative after #1104.
Not fixed there: both rules of the walk are documented decisions (the `walkObjectInventory` docblock), so changing either is a ruling rather than a fix.

**Done when:** a ruling chooses between recording a refused kind in the inventory, with the engine's sentence, while keeping the kinds that were read, and keeping the whole-capture refusal with a message that names the refused kind rather than an unreachable server; and a test drives the walk over a provider whose one kind's listing throws.

### B89. On a Kafka cluster past the topic cap, plan mode grounds topics and nothing else

The grounding walk, `walkObjectInventory` in `src/lib/agent/tools.ts`, ends at the first truncated `describeObjects` batch, as B84 records for Prometheus, and stops at its object budget, `INVENTORY_LIMIT` (5,000) in `src/lib/db/inventory-bounds.ts`.
The Kafka provider (#1088) declares its kinds as topics, consumer groups, brokers, the order the tree draws its folders in, and its topic listing is capped at `KAFKA_TOPIC_LIST_CAP` (2,000) in `src/lib/db/providers/stream/kafka/objects.ts`, below the object budget, with its topic batch marked truncated past the cap.
So on a cluster with more than 2,000 topics a plan run's inventory holds 2,000 topics and no consumer group or broker, and on a smaller cluster with more consumer groups than the budget leaves after its topics it holds no broker.
The inventory's `truncated` tells the run that the reading is incomplete; what it cannot reach is the groups' lag and the brokers a question about consumers or the cluster needs.
Pinned through the real walk over the Kafka module's own object functions by the KM1 cases of `tests/unit/lib/agent/context-snapshot.test.ts`, since no live fixture reaches 2,000 topics.

Found 2026-09-24 while designing the Kafka provider (#1088, section 11, KM1).
Not fixed there: reordering the kinds would reorder the tree, and a per-kind share of the object budget changes every engine that grounds through its provider, the trade B84 already records, so a fix of the walk closes both.

**Done when:** a plan run against a Kafka cluster past the topic cap holds its consumer groups and brokers, with a test that drives the grounding walk over a provider whose first kind's batch is truncated and asserts that the later kinds are still read.
