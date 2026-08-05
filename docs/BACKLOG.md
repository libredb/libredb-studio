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

---

## Value interpolation

### V1. Four call sites escape by doubling quotes only

`src/components/PivotTable.tsx`, `src/components/TestDataGenerator.tsx`, `src/components/Studio.tsx`
and `src/components/DataImportModal.tsx` each build SQL by doubling quotes in a value, which a
backslash-escaping dialect can still turn into SQL. The related inline-edit path
(`src/hooks/use-inline-editing.ts`, a non-numeric primary-key value interpolated into `WHERE` with no
escaping at all) is already covered by issue #290; these four are not.

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

---

## Documentation

### X1. Provider-doc line references are stale across the board

`docs/providers/mssql.md` puts `getCapabilities()` at :57 and `getSchema()` at :369 where they are at
391 and 749. The drift predates any recent milestone and the same line-anchoring style is used in
every provider doc, so the fix is a convention change (anchor on symbol names, not line numbers) as
much as a correction.
