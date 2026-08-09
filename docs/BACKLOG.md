# Backlog — known defects and deferred work

Work that is known, understood, and not yet scheduled. Every entry here was found while doing
something else — a maintenance sweep, a review, a live probe — and was verified against the code at
the time it was written down, but none of it has been filed as a GitHub issue.

**How this file is used**

- The GitHub issue tracker holds work that is filed, triaged, or in progress. This file holds
  everything else: defects nobody has scheduled, deliberate deferrals, and open questions.
- An entry states what is wrong, where, and what "done" looks like — enough for someone to pick it
  up cold without re-deriving the finding.
- **Delete an entry when the work lands.** A fixed item leaves this file; it does not get a
  strikethrough or a DONE marker. Git history is the record of what was here.
- Re-verify before acting. Line references and behaviour claims age, and some entries name a
  reading of a database's grammar that ought to be checked against a first-party source again.
- Promote an entry to a GitHub issue whenever it needs discussion, an outside reporter, or a
  release note. This file is a holding area, not a competing tracker.
- The reverse happens too. An issue that is understood, breaks nothing today and is not scheduled
  belongs here rather than in a tracker where it only ages: it is closed with a pointer to its entry
  and reopened if a consumer asks for it. A defect a user can hit stays an issue — closing one of
  those hides a limitation instead of deferring it.

---

## SQL statement reading

The readers under `src/lib/sql/` decide where a statement starts, where it ends, and what operates
it. `src/lib/sql/grammar.ts` gave them a dialect (#292); these are what that channel does not yet
cover.

### S1. `statement-splitter.ts` is dialect-blind, and one shape yields a runnable bare `DROP`

`src/lib/sql/statement-splitter.ts` runs its own span walk instead of `spans.ts`, so it disagrees
with every other reader: a `;` inside a MySQL `#` comment, an Oracle `q'{a'b;c}'` body, a `[a;b]`
name, or a backtick-quoted subscript key each split one statement into fragments.

The sharp case: `/* a /* b */ ; DROP TABLE users; -- */ SELECT 1` splits into three fragments whose
second is a bare, valid `DROP TABLE users` that the multi-statement route would run — while
`isDangerousQuery` answers false, because the confirmation gate reads the whole editor text and
never the fragments. Same family as #300, wider blast radius.

Done when the splitter reads spans through the shared reader with the caller's dialect, and the
confirmation gate and the splitter agree about what is going to run.

### S2. Backslash escaping is not a grammar fact

Whether `\` escapes inside a string literal differs by dialect (and, in MySQL, by session mode).
Making it a row in `SqlGrammar` would narrow the false confirmation prompts introduced by #297 and
would remove the MSSQL blunt decline in S4 entirely.

Deliberately left out of maintainer-sweep-5: it retypes every literal in every dialect — a far wider
behaviour change than any bar in that milestone asked for — and it would destroy the premise of two
fixtures that milestone required (the "end cannot be cut because a literal is undeterminable" case
and the "genuinely unresolvable text still has to ask" case). Those fixtures need replacing with
shapes that stay unresolvable once `\` is understood.

The single largest follow-up from that sweep.

### S3. Comment and escape forms no reader models

- **MySQL executable comments.** `/*!40000 DELETE FROM t */` is an ordinary comment to every reader
  here, and MySQL executes it. Nothing asks before it runs.
- **ClickHouse `//`.** Accepted as a line comment (live-verified), modelled nowhere, so
  `// note\nDROP TABLE t` answers not-dangerous.
- **MySQL connection charset.** On a `latin1` connection a leading U+00A0 executes.
  `buildPoolConfig` passes a user's connection string straight to mysql2 as `uri`, so the charset is
  outside the readers' view entirely.

### S4. MSSQL: a parameterised page is still unrecognised

`… OFFSET @skip ROWS` is not recognised as a page, so the statement collects a `TOP` and the server
refuses it. This is a limitation of the shared probes' literal-count reading as much as of the
provider. Verified by probe and documented in `docs/providers/mssql.md`.

Related: the decline that keeps #293 safe keys on an unanchored `OFFSET`/`FETCH` mention wherever the
cut was refused. The precise alternative — walk forward to where the unresolvable region starts — is
only meaningful for a mention *before* the bad span, and costs a new shared-reader API.

### S5. The limiter's whole-body probes still read inside comments

`src/lib/db/utils/query-limiter.ts` runs its `ROWNUM` test, its `UNION` test and its subquery
`SELECT` count over the whole statement text, so a statement that merely *mentions* a bound in an
interior comment reads as already bounded. The statement's *type* stopped being fooled this way in
maintainer-sweep-4/5; these flags did not.

### S6. Grammar facts left undecided

`grammar.ts` records a fact as established only when a first-party source was found for it, and
writes `DEFAULT_SQL_GRAMMAR.<fact>` where it was not. Currently undecided:

| Fact | Undecided for |
|---|---|
| `[…]` bracket reading | mysql, oracle, couchbase, druid, libredb |
| `#` | couchbase, druid, libredb |
| block-comment nesting | couchbase, druid, libredb |

None of these currently costs everyday syntax anything — `[` carries no meaning in ordinary MySQL or
Oracle SQL, and the three HTTP/embedded dialects were never probed for the other two facts. The cost
of leaving one undecided is real when the dialect does use the syntax, which is why PostgreSQL's
bracket row was established rather than left here: at the name reading, `ARRAY[[1,2],[3,4]]` and
`j['a]b']` lost their bound and prompted for confirmation on an ordinary read.

**Rows resting on documentation alone, worth re-checking against an artifact:** ClickHouse's `#` and
bracket rows (HTTP-only provider, no driver package to read), MSSQL's block-comment nesting row
(tedious ships no tokenizer), PostgreSQL's bracket and block-comment rows (`pg` is a wire-protocol
driver and carries no SQL tokenizer, so both rest on the manual), and the `nq'…'` spelling of Oracle's
alternate quoting.

### S7. A confirmation refinement that was considered and rejected

Scanning an unreadable region for destructive vocabulary and asking only when a write could plausibly
be in there. Sound on its face, but it substitutes a cleverer reading for the honesty rule #297
pinned — the gate asks because it *cannot* read the text, not because it guessed what is in it. Only
revisit this with an explicit product decision.

---

### S8. The confirmation gate's destructive vocabulary is SQL-only

`isDangerousQuery` recognises SQL keywords, so it is close to inert for the two non-SQL types it is
nevertheless asked about: a Redis `FLUSHALL` or `DEL key`, and a MongoDB `{"operation":"drop"}`, are
destructive and match nothing. The span-based half of the gate no longer fires on their text at all
(it is not SQL, so a SQL reader's verdict about it means nothing), which makes the keyword half the
only thing left — and it does not speak their languages.

Done when a destructive MongoDB operation and a destructive Redis command each ask before running,
driven from the same single type-to-facts place rather than a type test in the component.

---

## Drivers and connections

### D1. Fatal `error` events on the non-pooled clients were never audited

#298 covered the pooled SQL drivers (`pg` in both the database and storage layers, `mssql`; mysql2
and oracledb have no pool-level `error` event, and each `connect()` now records that). Whether the
MongoDB, Redis, ClickHouse, Druid or Couchbase clients expose a fatal `error` event that can reach
`uncaughtException` is an open question, not a claim.

### D2. Oracle, MongoDB and Redis ignore the SSL/TLS panel the connection dialog shows them

`ConnectionModal.tsx` gates the SSL/TLS and SSH tunnel panels on `!isFileBased(type)`, so every
engine except the two file-based ones (`sqlite` and the embedded `libredb`, both of which declare
`connectionFields: ["database"]`) renders both. The defect is narrow and specific: **the visible
`config.ssl` selection is not enforced by three providers.** `grep -rln ssl src/lib/db/providers/`
hits postgres, mysql, mssql, couchbase, clickhouse and druid; `oracle.ts`, `mongodb.ts` and
`redis.ts` never read it. A user who sets the mode to `require` on those three gets no error and no
guarantee - the connection may still be encrypted, but only if the connection string says so
(`oracle.ts:266` passes a supplied `connectionString` through verbatim, and the MongoDB driver
honours `tls=true` in the URI). Silently accepting a security setting and dropping it is the
problem, not plaintext per se.

Two related scope facts worth keeping straight, both established while correcting an earlier
overstatement of this entry:

- The SSH tunnel is genuinely provider-independent - `factory.ts:229` opens it and rewrites
  host/port before `createDatabaseProvider` - but it is skipped when either is absent. Connection
  string mode (`showConnectionStringToggle`: mongodb, couchbase, clickhouse) clears both in
  `use-connection-form.ts:173-179`, so those connections are not tunnelled even though the panel is
  offered.
- "Every engine except SQLite" is wrong twice over; see the file-based pair above.

Found while reviewing #317, corrected after Copilot's review of #318. The READMEs now state the
real scope, which closes the documentation half; the UI half is still open. Either wire the three
providers (oracledb supports TLS through the connect string, `mongodb` through `tls` options,
`ioredis` through `tls`) or hide the panel where it cannot be honoured.

---

## Value interpolation

### V1. Query history records the placeholders, not the values that were bound

Since #290 the inline row editor sends `SET "name" = $1` with the value bound, and
`use-query-execution` writes that text to history — a truthful record of the statement the engine
ran, but no longer a record of what was written. Carrying the bound values as their own history
field would restore the audit trail without putting them back into the SQL. Touches the history
entry shape in `src/lib/storage`, so it is a schema change rather than a one-line fix.

---

## Row editing

### R1. Row editing is offered only where a shared `UPDATE` happens to fit (was #279)

The results grid builds one statement shape for every engine —
`UPDATE <table> SET <col> = <val> WHERE <pk> = <val>` in `src/hooks/use-inline-editing.ts` — so an
engine that spells a row mutation differently cannot have the feature. #269 made that honest rather
than broken: `supportsInlineRowEdit` hides the control wherever the shape does not fit, which is why
this is deferred work and not a defect. Today it is true for PostgreSQL, MySQL, SQLite, Oracle and
SQL Server, and false everywhere else.

Making it work means moving statement generation into the provider, so each dialect owns its own
form: the SQL providers keep the shape above, ClickHouse spells it `ALTER TABLE <t> UPDATE <col> =
<val> WHERE ...`, MongoDB has no statement at all and would need the document-update path, and an
append-only engine keeps declaring the capability false. The provider triad applies, so code,
`docs/providers/<type-id>.md` and the provider's integration test move together, per provider.

Two constraints come from #269 and do not go away:

- **One request per edited row.** Several engines reject a multi-statement request, so the old
  newline-joined payload cannot come back.
- **Primary-key detection is heuristic.** The hook picks the key by looking for a result column named
  `id` or ending in `_id`. That is acceptable for a control gated on an opt-in capability, but
  per-dialect editing on real tables should derive the key from the schema instead.

Whether row editing should be a universal feature at all is a product decision, not a mechanical one,
which is the other half of why it is here. The published `WorkspaceFeatures.inlineEditing` flag is
deprecated against this entry (#288): it becomes real, or goes away in a major, with this work.

---

## Authentication and security headers

### A1. Three copies of the 401 response, with two different shapes

`src/lib/api/require-session.ts:24` builds `{ error: "Authentication required" }` with status 401 —
the shared guard the security/phase-0-hotfix branch added for routes that reach a database or an
LLM provider. `src/lib/api/schema-route.ts:31-34` and `src/app/api/db/health/route.ts:28-31` build
the identical response inline, and both predate that branch: they were not converted to call the
new guard.

Separately, the storage routes (`src/app/api/storage/route.ts:21`,
`src/app/api/storage/[collection]/route.ts:22`, `src/app/api/storage/migrate/route.ts:23`) answer
`{ error: "Unauthorized" }` instead, so a client cannot rely on one error shape for "not logged in"
across the whole API.

Done when there is exactly one 401 response for this condition, built in one place, and every route
that needs it (including the storage routes) calls it. Deferred to Phase 1 rather than folded into
the hotfix: none of the three is wrong today, and consolidating them is a refactor, not a fix.

### A2. Paths containing a dot bypass the security middleware entirely

`src/proxy.ts:85`'s matcher excludes any path matching `.*\..*` so that static assets skip the auth
redirect — `/((?!api/auth|api/db/health|api/storage/config|_next/static|_next/image|.*\..*).*)`.
The exclusion is by design for auth (nothing under `public/` or `/monaco/vs/*.js` needs a login
redirect), but it means `proxy()` never runs for those paths at all, not just skips the redirect.
Phase 1's plan to add security headers (CSP and friends) inside `proxy()` would then miss every
dot-containing path — `public/**` and the Monaco AMD bundle under `/monaco/vs/*.js` chief among
them — leaving them without the new headers while every extensionless route gets them.

Done when Phase 1's header work accounts for this gap: either give static assets their headers
through a different mechanism (e.g. `next.config`'s `headers()`), or narrow the matcher exclusion
so it still skips the auth redirect without skipping header injection.

---

## Tests

### T1. Two disjuncts are pinned by almost nothing

`isStatementText` (`src/lib/sql/statement-end.ts`) has a `dollar-string` disjunct pinned by exactly
one assertion. That is the same
hole that, for the `subscript` disjunct, let a statement-corrupting emission through the full gate,
CI, 100% line coverage and five reviews — deleting the disjunct failed zero tests. Line coverage
cannot see a missing disjunct in a one-line predicate; only a fixture where the two readings
*disagree* can pin it.

Done when deleting any single disjunct of `isStatementText` fails a test.

### T2. `tests/unit/db/factory.test.ts` shares a `pg` mock with the storage provider

The test mocks `pg` with a shared inert pool while the storage provider caches `Pool` in a
module-level variable, so in a shared process the first initialize decides which mock every later one
gets. Related to the `mock.module()` isolation rules in `docs/TOOLCHAIN.md`.

### T3. `tests/security/image-proxy.test.ts` asserts a configuration invariant, not the threat

The design this test protects is: `/_next/image?url=http://169.254.169.254/` (or any other
attacker-chosen URL) must be rejected, because `next/image`'s optimizer would otherwise perform an
unauthenticated server-side fetch of it. What the test actually asserts is narrower —
`nextConfig.images` is `undefined` — which is sufficient today only because nothing in `src/`
imports `next/image` at all (verified: `next.config`'s `images` key is never set, and no component
imports `next/image`), so the control is closed and correctly verified for the current codebase.

The gap is that the assertion is a proxy for the threat, not the threat itself, and a future,
strictly safer configuration would fail it: setting `images: { unoptimized: true }` (which disables
the optimizer's fetch behaviour entirely, closing the same threat a different way) would still trip
`toBeUndefined()`. The real assertion — that `GET /_next/image?url=<attacker URL>` is rejected —
belongs with the Phase 1 Playwright work, which can make an actual HTTP request against a running
server; a unit test importing `next.config` has no way to exercise the route itself.

---

## Dependencies

### P1. The desktop shell's `glib` advisory has no reachable fix while Tauri v2 targets GTK 3

Dependabot alert 1 (GHSA-wrw7-89jp-8q8g, medium) reports unsoundness in the `Iterator` and
`DoubleEndedIterator` impls of `glib::VariantStrIter`, affecting `>= 0.15.0, < 0.20.0`.
`desktop/src-tauri/Cargo.lock` carries `glib 0.18.5`, and it cannot move:

```
glib 0.18.5  <-  gtk 0.18.2 (requires glib ^0.18)  <-  tauri 2.11.5
```

`cargo update -p glib@0.18.5 --precise 0.20.0` fails on that requirement. Upgrading Tauri does not
help — 2.11.5 is the latest published version — and the `gtk` crate cannot deliver the fix either:
0.18.2 is its latest release and it is published as UNMAINTAINED, directing users to `gtk4`. So the
advisory closes only when Tauri's Linux backend moves off the GTK 3 bindings, which is upstream work
on their side.

Nothing in `desktop/src-tauri/` touches `glib`: the shell's direct dependencies are `tauri`,
`serde_json` and `libc`, and no source file references `glib` or `Variant`. The exposure is whatever
Tauri and GTK do with `VariantStrIter` internally, so the practical risk is low, but "we do not call
it" is not the same as proving the code path is unreachable.

Done when Tauri's dependency tree offers `glib >= 0.20` and the lock is updated, or when the alert is
dismissed with this reasoning recorded on it. Re-check on each Tauri upgrade — a one-line
`cargo tree -i glib` in `desktop/src-tauri/` answers it.

---

## Documentation

### X1. Provider-doc line references are stale across the board

`docs/providers/mssql.md` puts `getCapabilities()` at :57 and `getSchema()` at :369 where they are at
391 and 749. The drift predates any recent milestone and the same line-anchoring style is used in
every provider doc, so the fix is a convention change (anchor on symbol names, not line numbers) as
much as a correction.
