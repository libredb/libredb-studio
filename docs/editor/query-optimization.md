# Query Optimization & Performance Features

LibreDB Studio includes enterprise-grade query optimization features to prevent system freezes and provide performance insights for DBAs, data engineers, and developers.

## Table of Contents

- [Query Pagination System](#query-pagination-system)
- [Silent Auto-Limiting](#silent-auto-limiting)
- [Destructive-Statement Confirmation](#destructive-statement-confirmation)
- [Load More Functionality](#load-more-functionality)
- [Result-Level Signals](#result-level-signals)
- [Query EXPLAIN Integration](#query-explain-integration)
- [Performance Insights](#performance-insights)
- [Architecture](#architecture)

---

## Query Pagination System

### Overview

All SELECT queries are automatically paginated to prevent browser freezes when dealing with large datasets. This is handled transparently without interrupting the user workflow.

### Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_QUERY_LIMIT` | 500 | Default rows per page |
| `MAX_UNLIMITED_ROWS` | 100,000 | Maximum rows for "Load All" |

### How It Works

1. User executes a SELECT query
2. System automatically adds `LIMIT 500` if no LIMIT exists (an `OFFSET` clause is only appended when the offset is greater than 0). The clause is inserted at the end of the statement itself, before any trailing comment or `;` — see [Where the bound is placed](#where-the-bound-is-placed)
3. If user already specified a LIMIT, it's preserved (no override)
4. Results display with pagination metadata

---

## Silent Auto-Limiting

### Philosophy

Instead of showing warning popups for large datasets, LibreDB Studio silently limits results to 500 rows. This provides:

- **Uninterrupted workflow** - No confirmation dialogs
- **Safe defaults** - System never freezes
- **User control** - Load More when needed

### Visual Indicators

When auto-limiting is applied:

```
┌─────────────────────────────────────────────────────┐
│ Results   500 rows  │  AUTO-LIMITED  │  Load More  │
└─────────────────────────────────────────────────────┘
```

- **AUTO-LIMITED badge** - Shows when the system added a LIMIT
- **Row count** - Displays actual returned rows
- **Load More button** - Appears when more data is available

### Query Limiter Utility

Location: `src/lib/db/utils/query-limiter.ts`

```typescript
import { analyzeQuery, applyQueryLimit } from '@/lib/db/utils/query-limiter';

// Analyze a query
const info = analyzeQuery('SELECT * FROM users WHERE active = true');
// Returns: { type: 'SELECT', hasLimit: false, hasOffset: false, ... }

// Apply limit to query
const result = applyQueryLimit('SELECT * FROM users', 500, 0);
// Returns: { sql: 'SELECT * FROM users LIMIT 500', wasLimited: true, ... }
// (OFFSET is only appended when offset > 0, e.g. applyQueryLimit(sql, 500, 500) -> '... LIMIT 500 OFFSET 500')
```

### Supported Query Types

| Query Type | Auto-Limit Applied |
|------------|-------------------|
| SELECT | Yes |
| SELECT behind a leading comment | Yes |
| SELECT ending in a comment | Yes (the bound is placed before the comment), except a `#` comment — see below |
| SELECT with LIMIT | No (preserved) |
| SELECT with UNION | Yes (LIMIT appended after the last statement) |
| Read-only CTE (`WITH … SELECT`) | Yes |
| Data-modifying CTE (`WITH … INSERT`/`UPDATE`/`DELETE`/`MERGE`) | No — the bound would apply to the rows the statement writes, committing only part of it |
| INSERT/UPDATE/DELETE | No |
| DDL (CREATE, ALTER) | No |

The statement's type is read from its first keyword that is neither whitespace nor a comment
(`src/lib/sql/leading-keyword.ts`), so `-- note`, `/* note */` and MySQL's `# note` before a `SELECT`
are skipped and the limit is still applied. Before this, an annotated `SELECT` was classified as an
unknown statement type and returned **every** row while the badge reported it as not limited.
An already-bounded annotated statement (`LIMIT n`, `FETCH FIRST n ROWS ONLY`, `SELECT TOP n`) is
still recognised as bounded and is not limited twice.

A statement leading with `WITH` is typed by the keyword its CTE list **operates** — the first one
after the list, read by walking the list's grammar in `src/lib/sql/operative-keyword.ts`. A list
element is read in either of the two shapes the supported dialects use: the standard
`name [(cols)] AS [[NOT] MATERIALIZED] (body)`, and ClickHouse's `<expr> AS <alias>`
(`WITH now() AS ts SELECT …`, `WITH 1 AS one SELECT …`) — an element the walker cannot cross ends the
reading, and the statement then loses its bound, which is what happened to ClickHouse's own CTE idiom
between the two fixes. The shapes are told apart by whether the element's head reads as a name and by
what follows its `AS`: a body or one of PostgreSQL's inlining hints can only be the standard shape,
anything else is an alias. Asking
instead whether the text contained `SELECT` let the `INSERT INTO … SELECT` idiom answer for its own
statement: a data-modifying CTE was typed `SELECT`, received a `LIMIT`, and in PostgreSQL that bound
applies to the rows the statement **writes** — it committed at most 500 of them while the badge
reported a truncated result set. Where the reader cannot cross the CTE list, the statement is not
treated as a `SELECT` and is not bounded: an over-large read can be re-run, a partly committed write
cannot be undone.

That covers most malformed input (an unclosed body, a missing `AS`, an unterminated comment or
literal) and, deliberately, two **well-formed** forms the reader does not walk — so they lose their
bound and return every row:

| Form | Why it is not read | Effect |
|------|--------------------|--------|
| PostgreSQL's `SEARCH` / `CYCLE` clause after a recursive CTE list | sits between the list and the operative keyword; the reader stops at the first word after the list | rare |
| An expression element aliased with an inlining hint (`WITH col AS materialized SELECT …`) | the hint commits the element to the standard shape, which then expects a body | rare, and the alternative reading would let `WITH t AS NOT LAZY (…)` report `LAZY` as the operative keyword |

Both are reads, so the cost is an unbounded result set rather than a partial write, and both are
pinned by tests in `tests/unit/sql/operative-keyword.test.ts` so the gap stays a decision.

The reverse also has a narrow case, pinned in the same file: reading an expression element means
knowing where it ends only by its `AS`, so any element the standard shape **declines** — a head that is
not a name, or an `AS` with no body after it — is re-read as an expression that ends at the first
`AS <name>` at depth 0, however far away. `WITH 2 INSERT INTO users AS u SELECT 1` and
`WITH x AS DELETE, foo AS (SELECT 1) SELECT 1` therefore answer `SELECT` and receive a bound. No
supported dialect accepts such text, so what the server receives is a rejected statement either way
rather than a partly limited write.

### Which dialect the readers are reading

Every reader above answers from characters alone, and a few characters mean different things in
different engines. Where they do, a reader with no dialect has to take one engine's side, and the
wrong side moves where a construct ends — a `)` that closes a CTE body, a comment that hides a bound,
the keyword that types the statement.

The dialect was always available at the callers: every provider knows its own `type`, the
multi-statement route resolves its provider before it asks, and both client-side execution paths hold
the active connection. It is now passed down (`src/lib/sql/grammar.ts`), and **exactly one place**
maps a database type to grammar facts — the readers receive the resolved record and never see a type
id, so no reader can grow a dialect test of its own.

| Character | Established reading | Dialects |
|-----------|--------------------|----------|
| `#` | opens a line comment | MySQL, MariaDB, ClickHouse (which also has `#!`) |
| `#` | ordinary code — a jsonb/geometric operator, an identifier character, a temp-table name, a bind-variable prefix | PostgreSQL, Oracle, SQL Server, SQLite |
| `q'…'` | a string literal (alternate quoting): the delimiter after the tag opens the body and its partner followed by `'` closes it, so the body carries apostrophes unescaped — `[ ] { } ( ) < >` pair up, any other character closes with itself, either letter case of the tag, and `nq'…'` is the same form for the national character set | Oracle only |
| `q'…'` | not a form at all — a name followed by an ordinary string, which is what those characters are there | everything else, including the default |
| `[…]` | a quoted **name**: everything between the brackets is the identifier (`SELECT [a--b] FROM t` selects a column called `a--b`) and the run does not nest. The doubled `]` this reading honours is SQL Server's escape — SQLite stops at the first `]` and has none, so `[a]]b]` reads as one name where SQLite reads `[a]` and then junk, which it rejects either way | SQL Server, SQLite |
| `[…]` | an **array literal or subscript**: it nests (`[[1,2],[3,4]]`), nothing inside it is escaped, and a literal inside it is a literal (`m['a]b']`) | ClickHouse, PostgreSQL |
| `/* … /* … */ … */` | one **nesting** comment: a `/*` inside a comment opens another and the run continues until the depth returns to zero, so a region that already contains comments can be commented out. A run short of a closer is undeterminable rather than closed early | PostgreSQL, SQL Server, ClickHouse |
| `/* … /* … */ … */` | a **flat** comment: the first `*/` ends it, and everything after that is the statement's own code | MySQL, MariaDB, SQLite, Oracle, and the default |

Each row was established from an authoritative source: the engine's own documentation, or its
driver's own tokenizer under `node_modules` (node-oracledb accepts `#` inside an identifier; the
SQLite amalgamation classifies `#` as a bind-variable prefix and `[` as a "`[...]` style quoted id").
A rule that could **not** be established is not guessed from a neighbouring dialect — the dialect stays
at the compatibility default below, and it is listed here rather than left implicit. The default is per
**fact**, not per dialect: a dialect whose `#` rule is known can still be undecided about its brackets.

The two non-SQL types, **MongoDB and Redis, have no SQL grammar at all** and are left out of the rows
below: their providers never reach these readers on the query path, and the confirmation gate — which
reads whatever is in the editor — asks `readsSqlText()` before applying any span-based rule to their
text, so a JSON document or a Redis command is not judged by a SQL reader that cannot parse it. The
gate's keyword tests still run on that text.

| Fact | Undecided, so left at the default | Established, and it happens to equal the default |
|------|-----------------------------------|--------------------------------------------------|
| `#` | Couchbase, Druid, the embedded LibreDB provider | — |
| `q'…'` | nobody | everything except Oracle: the form is Oracle's alone, so "not a literal" is the correct reading for the rest |
| `[…]` | MySQL, Oracle, Couchbase, Druid, LibreDB | SQL Server and SQLite, whose rule the default already applied |
| `/* … */` nesting | Couchbase, Druid, LibreDB | MySQL, SQLite and Oracle, whose flat rule the default already applied — each established from its own source rather than assumed to agree |

The distinction is visible in `src/lib/sql/grammar.ts` too: an established fact is written out in that
dialect's row, an undecided one is written `DEFAULT_SQL_GRAMMAR.<fact>`.

The bracket row is the one where a default costs something, and PostgreSQL is why it is worth
establishing rather than accepting: left at the name reading, a nested array or a subscript key
containing a `]` lost its bound there — and, since #297, also asked for confirmation, because the same
undeterminable run is text the safety gate cannot read. A prompt on everyday syntax teaches operators
to click the gate away, which costs more than the missed bound, so the rule was established from the
manual (4.2.3 Subscripts, 4.2.12 Array Constructors). MySQL and Oracle stay undecided: `[` is not a
name quote in either, but neither has a subscript rule to read it under instead, and reading one
engine's rule off another's is what this channel exists to stop. The direction there is safe — a run
the name reading cannot close is reported as undeterminable, an undeterminable end is never cut, so
the cost is an unbounded read and never a misplaced clause — and those two dialects do not write
bracket runs in everyday SQL. See
[Text the reading cannot resolve asks, and says so](#text-the-reading-cannot-resolve-asks-and-says-so).

**A call that names no dialect keeps today's reading**, and that is a decision with its own tests, not
an accident: `#` opens a comment unless the next character makes a PostgreSQL operator (`#>`, `#>>`,
`#-`, `##`) — neither of the honest readings, but what this folder did for every engine before the
channel existed, kept so that the fixtures written for #275, #280, #287, #291 and #294 keep asserting
the behaviour they were written for. Block comments do not nest under the default for the same reason.
The default has no alternate-quoting form either, which is the
same reading every non-Oracle dialect gets and the correct one for all of them.

One reading is deliberately **not** the dialect's, and it is the only such override in this folder:
`#` in a statement's **leading** trivia is skipped as a comment on every dialect
(`src/lib/sql/leading-keyword.ts`). No dialect here can *open* a statement with `#` — `#tmp`, `#>` and
`ID#` are all mid-statement forms — so skipping the run only ever changes which syntax error the
server reports, while reading it as code would take the bound back off a `# note`-led SELECT on
PostgreSQL and SQL Server. Every other fact that reader consults, including where a block comment
ends, is the dialect's own.

The alternate-quote tag has to **start** a word: Oracle's lexer reads a name greedily, so `freq'x'` is
a name followed by an ordinary string there, and this reader answers the same. That makes the tag the
one span in `src/lib/sql/spans.ts` whose reading depends on the character *before* it, so callers pass
a whole statement (or a prefix of one), never a suffix.

What changes for a caller that does name one:

| Statement | Dialect | Before | Now |
|-----------|---------|--------|-----|
| `WITH t AS (` + `#- note )` + `SELECT 1) DELETE FROM users` | MySQL | typed `SELECT`, bound appended to a `DELETE` | typed `DELETE`, not bounded |
| `SELECT * FROM t # LIMIT 10` | MySQL | the commented-out bound read as real, statement unbounded | bound added before the comment |
| `SELECT * FROM #tmp` | SQL Server | end not cuttable, appending branch declines | `#tmp` is the statement's own text, the statement is bounded |
| `SELECT * FROM EMP WHERE ID# = 1` | Oracle | not bounded | bounded |
| `WITH t AS (SELECT q'{it's}' …) SELECT * FROM t` | Oracle | the apostrophe inside the literal opened a string, the CTE list could not be read, not bounded | the literal is a literal, statement typed `SELECT`, bounded |
| `SELECT q'[it's a -- note )]' FROM dual` | Oracle | the `--` inside the literal read as a trailing comment, so the bound was inserted **inside** the literal and the statement was reported limited | the whole literal is the statement's text, bound appended after it |
| `SELECT * FROM users # daily` | ClickHouse | not bounded | bound added before the comment |
| `SELECT meta #> '{a}' FROM docs` | PostgreSQL | bounded (the default already read this correctly) | unchanged |
| `WITH m['a]b'] AS v SELECT v` | ClickHouse | the `]` inside the key ended the bracketed run, the CTE element could not be crossed, not bounded | the subscript is one run, statement typed `SELECT`, bounded |
| `SELECT [[1,2],[3,4]] AS a FROM t` | ClickHouse | the closing `]]` read as an escape, so the run never closed and the end was not cuttable, not bounded | the arrays nest, bound appended after them |
| `SELECT [it's] FROM users` | SQL Server, SQLite | bounded (the name reading is these dialects' own) | unchanged, and now pinned as the dialect's answer rather than a shared default |
| `WITH t AS (` + `/* a /* b */ ) SELECT 1 */` + `… ) INSERT INTO …` | PostgreSQL, ClickHouse | the comment closed at the inner `*/`, so the `)` after it ended the CTE body and the statement typed `SELECT` — a bound appended to an INSERT | the whole comment is a comment, the statement is typed `INSERT`, not bounded |
| `/* a /* b */ x */ SELECT id FROM logs` | PostgreSQL, SQL Server, ClickHouse | the word after the inner `*/` typed the statement, so it was not bounded | typed `SELECT`, bounded, comment emitted intact |
| `SELECT /* a /* b */ DISTINCT */ name FROM t` | SQL Server | `TOP` spliced after a `DISTINCT` that is inside the comment — i.e. inside the comment, so the statement ran unbounded while reporting a limit | `TOP` spliced before the comment |
| `/* a /* b */ SELECT id FROM logs` | PostgreSQL, SQL Server, ClickHouse | the comment closed at its only `*/` and the statement read as an ordinary SELECT | the comment never closes, so the text is undeterminable: not bounded, and the safety gate asks |

### Where the bound is placed

The clause is inserted **between the statement and its trailing trivia** — whitespace, comments and
the terminating `;` — and the trivia is re-attached verbatim. A statement carrying no trailing trivia
is emitted exactly as it was before this rule existed.

| Statement | Emitted SQL |
|-----------|-------------|
| `SELECT * FROM t` | `SELECT * FROM t LIMIT 500` |
| `SELECT * FROM t;` | `SELECT * FROM t LIMIT 500;` |
| `SELECT * FROM t -- note` | `SELECT * FROM t LIMIT 500 -- note` |
| `SELECT * FROM t; -- note` | `SELECT * FROM t LIMIT 500; -- note` |
| `SELECT * FROM t /* note */` | `SELECT * FROM t LIMIT 500 /* note */` |

Appending after the trivia instead put the bound **inside** a trailing line comment: the engine ran
the statement unbounded while the badge reported it as capped, and the re-appended `;` ended up
inside the comment as well.

The same reading of the end answers "is this statement already bounded". The `LIMIT n`,
`FETCH FIRST n ROWS ONLY` and `OFFSET n` probes are anchored at the end of the **statement**
(`src/lib/sql/statement-end.ts`), so:

- a bound written inside a trailing comment (`SELECT … -- LIMIT 10`) is not mistaken for a real one,
  and the statement is bounded;
- a real bound followed by a comment (`SELECT … LIMIT 10 -- deliberate`) is still detected, honoured
  and never doubled — a second bound is a syntax error, not extra rows.

Reading where a statement ends and **cutting** it there are separate answers, because they are not
equally risky: a probe that stops early merely finds no bound, while a clause inserted early lands in
the middle of the statement and the server rejects it outright. Three shapes are therefore read but not
cut, and a statement carrying one is **returned untouched with `wasLimited: false`** — the second
branch of "never `true` alongside a bound the engine cannot see":

| Shape | Why the cut is refused |
|-------|------------------------|
| An unterminated comment or literal, or a quote behind an odd backslash run (`… WHERE name = 'O\'Brien'`) | MySQL escapes with backslashes and PostgreSQL does not, so the two close the literal in different places; inserting on a guess puts the bound after the statement's own `;` |
| On a dialect that **nests** block comments, a comment carrying one opener too many (`/* a /* b */ SELECT 1`) | the run never returns to depth zero, so it is an unterminated comment there — the same refusal as the row above, reached by a rule that is the dialect's own (#300) |
| A `#` run at the end of the statement (`SELECT * FROM #tmp`, `… WHERE ID# = 1`, `SELECT flags # 5`), **when no dialect was named** | `#` is a comment marker in MySQL and ClickHouse and ordinary code elsewhere — a T-SQL temp table, an Oracle identifier, a PostgreSQL XOR — and nothing in the *text* tells them apart (`#note` and `#tmp` are the same characters) |
| A bracketed run that never closes — an unterminated name (`SELECT [abc`) or, under the subscript reading, an array short of a bracket (`SELECT [[1,2] AS a`) or one holding an unresolvable literal | a run cannot be more certain than what it contains; guessing where it ends puts the bound inside a name or a literal, which is the corrupted-statement shape rather than a missed bound |

Each is a **deliberate loss of a bound**: appending after everything, as the limiter used to, was
valid SQL for the dialect in which those characters are code, and is exactly what put the clause
inside a trailing comment for the dialect in which they are not. Not bounding costs an over-large
read the user can re-run, which is the trade every reader in `src/lib/sql/` makes.

Rows one and three cost one thing more since #297, because a run that never closes is also text the
safety gate cannot read: such a statement asks for confirmation before it runs (see
[Text the reading cannot resolve asks, and says so](#text-the-reading-cannot-resolve-asks-and-says-so)).
The `#` row is the exception — a `#` line comment closed by the end of the input is terminated, so
that shape loses its bound silently, as it always did.

The `#` row applies to the **dialect-less** reading only. A caller that names its dialect has told
the two apart, so the refusal is lifted in whichever direction that dialect requires: MySQL and
ClickHouse cut before the comment, PostgreSQL, Oracle, SQL Server and SQLite read the run as the
statement's own text and cut after it. Every caller in this project names one, so the row describes
the compatibility default rather than everyday behaviour.

A `#` comment with code after it on a later line is unaffected. Where the cut is refused, the
statement's *text* is still read to its very end (trailing whitespace and `;` aside), so a bound
written after a `#` is still found and never doubled — which is also why MSSQL's `TOP` splice, writing
into the head, keeps bounding `SELECT * FROM #tmp` even without a dialect. Under the dialect-less
reading that is not airtight — trailing trivia written *after* an existing bound hides it from the
end-anchored probe, so a `TOP` is spliced alongside an `OFFSET … FETCH` that SQL Server rejects — and
naming the dialect is what closes it *for a hash*: `#` is never a comment in T-SQL, so the probe sees
the bound that is there. Every other route to a refused cut reached that provider the same way, and
what closes those is the rule in the next paragraph. Likewise the one shape that stays wrong without a
dialect, a bound commented out with `#` (`… # LIMIT 10`), is read correctly under MySQL's grammar: the
commented-out clause is not a clause, and a real bound is added before it.

A refused cut costs more than the bound, and this is the part that is easy to miss: it also makes every
**already-bounded probe** unreliable. Those probes read the statement's own text, and where the cut is
refused that text is the terminator strip — trailing whitespace and `;` removed and nothing else — so a
real bound written *before* a trailing comment sits away from the end anchor and reads as absent. For a
caller that responds to "not bounded" by leaving the statement alone, that is harmless. For a caller
that responds by ADDING a clause, it is not: the clause lands beside a bound the probe could not see,
and engines reject the pair outright rather than returning too many rows. So a provider that adds its
own clause has to treat those probes as non-authoritative wherever the cut was refused. MSSQL is the
one that adds a clause the refusal does not otherwise stop — `TOP n` goes into the head, which no
trailing comment can reach — and it now declines whenever such a statement mentions an `OFFSET` or a
`FETCH` at all, blunt on purpose, since a page cannot be ruled out from text nothing can read (#293).

Providers that append a clause of their own follow the same rule: Oracle's `FETCH FIRST` and
`OFFSET … FETCH NEXT`, and MSSQL's `OFFSET … FETCH NEXT` pagination branch. MSSQL's `SELECT TOP n`
splices into the head, which no trailing comment can reach, so it keeps bounding a statement whose end
may not be cut — with the one exception above. MSSQL also recognises a page form of its own that the
shared probes above do not, `OFFSET n ROWS` with no `FETCH` tail; it is read in that provider, because
the form is T-SQL's alone and no other dialect's probes should move for it. ClickHouse's refusal to
rewrite a statement ending in `FORMAT`/`SETTINGS`, and Druid's refusal to rewrite one ending in an
`OFFSET`, both read the same end — otherwise a trailing comment would hide the clause from them and
the bound placed before that comment would turn a working statement into a server-side syntax error.

### Multi-statement runs

In standalone studio, a script holding several statements is split
(`src/lib/sql/statement-splitter.ts`) and sent to `POST /api/db/multi-query`, which bounds the **last**
statement only, and only when it is a `SELECT`. Embedded in a host application the query goes to the
host's own executor and none of this route applies.

Whether that last statement *is* a `SELECT` is the shared reading described above (`isSelectQuery`),
not a pattern belonging to the route. It used to be `/^\s*SELECT\b/i`, which tolerates whitespace but
not a comment — and the splitter keeps each statement's leading comments — so a final `SELECT` behind a
`-- note` was not recognised and reached the engine unbounded, the one place the comment-tolerant
classifier had not been adopted (#281). The CTE typing applies here too: a final read-only CTE is
bounded, a final data-modifying one is not. The route resolves its connection before it asks, so the
reading is done under **that connection's dialect** and this route and the provider that runs the
statement cannot disagree about what the statement is.

The splitter itself is a separate, still dialect-blind scan: it inlines its own span walk and reads
`#` as ordinary code, so a MySQL hash comment carrying a `;` still splits a statement there. Changing
that moves statement boundaries, which is its own change with its own tests — recorded here rather
than folded in.

Last-only is that route's own policy, and it leaves a hole this section does not close: a non-final
`SELECT` runs exactly as written, and its **entire** result set travels back in `statements[i].rows`.
That is also what the grid displays whenever the final statement returns no rows of its own
(`SELECT * FROM huge; INSERT INTO t VALUES (1)`), since the response picks the last result that *has*
rows. Noted here rather than claimed closed.

Two indicators do not follow the bound onto this route, because it returns no pagination metadata at
all: the **AUTO-LIMITED badge does not appear** for a multi-statement run, and **Load More is not
offered** even when rows were capped. The bound itself is real and applied — re-run the final statement
on its own to page through it.

---

## Destructive-Statement Confirmation

Before a destructive statement runs, studio opens a confirmation dialog carrying an AI risk
analysis (`src/components/QuerySafetyDialog.tsx`). Which statements reach it is decided by the
same reading the auto-limiter uses, so the two cannot disagree about where a statement begins.

| Statement | Confirmation |
|-----------|--------------|
| `DELETE` / `DROP` / `TRUNCATE` / `ALTER` / `GRANT` / `REVOKE` / `UPDATE` | Yes |
| Any of those behind a comment (`-- note`, `/* note */`, MySQL's `# note`, several stacked) | Yes |
| A `WITH` whose CTE list precedes one (`WITH x AS (…) DELETE FROM …`) | Yes |
| A `WITH` whose CTE list *contains* an `UPDATE … SET` (PostgreSQL's data-modifying CTE) | Yes |
| A statement carrying a run the reader cannot resolve (`SELECT '\';` and anything after it, an unterminated comment, literal, name or array) | Yes, and the dialog says why |
| Any of those behind a **nested** comment (`/* a /* b */ c */ DROP TABLE users`), on a dialect that nests — PostgreSQL, SQL Server, ClickHouse | Yes: the comment is read whole, so the statement's own keyword is the one that answers |
| The same text on a dialect that does **not** nest — MySQL, MariaDB, SQLite, Oracle | No, because there the comment closed at the first `*/` and what follows it is text the engine rejects outright |
| `SELECT`, including one naming a destructive keyword in a string or a comment | No |

The reading is done under the **active connection's dialect** on both execution paths, because what
counts as a comment decides what the statement says. On MySQL, a `#` comment inside a CTE list used to
hide the `)` that closes it, so the reader answered with the `SELECT` inside the comment's reach and
the `DELETE` after the list ran with no confirmation at all; under MySQL's grammar the comment is a
comment and the `DELETE` is seen. The other direction matters as much: `SELECT 1 # UPDATE t SET x = 1`
is a commented-out note on MySQL — prompting there would be a false alarm — and is the statement's own
code on PostgreSQL, where those characters are an operator.

The statement's own keyword is read with `src/lib/sql/operative-keyword.ts` and tested against a
keyword set. It used to be re-derived here as six anchored patterns (`/^\s*DROP\b/i`, …), which
tolerate whitespace but not a comment — so `-- cleanup` above a `DROP TABLE` skipped the dialog
and the statement executed unconfirmed, on both the standalone and the embedded execution path.
Writing a note above a destructive statement is ordinary, and it is exactly where a confirmation
matters most.

One probe stays deliberately unanchored: a statement whose code contains `UPDATE` followed by
`SET` asks for confirmation whatever its own keyword is. PostgreSQL's data-modifying CTE is
*operated* by its `SELECT` — which is the honest answer, and the one the limiter needs so it does
not bound the rows a write commits — so anchoring this probe too would take the last check away
from a statement that really does write. It reads the statement's **code** rather than its text
(`src/lib/sql/words.ts`), so unlike the pattern before it, a read that merely quotes
`'UPDATE t SET x = 1'` or mentions it in a comment no longer prompts.

### Text the reading cannot resolve asks, and says so

Every other reader in `src/lib/sql/` errs toward **not acting** on text it cannot resolve, because
its mistake would be a row bound appended to a write — a partial commit (#287). This gate's costs
run the other way: a false prompt costs one click, silence costs an unconfirmed destructive
statement. So a statement carrying a run that never closes prompts (#297), and the dialog leads with
a distinct notice — *"Part of this statement could not be read"* — explaining that a quoted, commented
or bracketed run never closes, that nothing after that point could be checked, and that this is why it
is asking. The notice stays visible beside the AI risk verdict, including a verdict of *Safe*: that
analysis was produced from text whose reading stopped early, so it may not describe what the
statement does.

`SELECT '\';` followed by a write is the shape the issue was filed about — `'\'` closes the string
under PostgreSQL's `standard_conforming_strings` and continues it under MySQL's default, so
`src/lib/sql/spans.ts` reports it as undeterminable rather than guessing, and everything after it
was invisible to the reading. It now asks instead of executing.

The accepted cost, pinned by tests rather than left to be discovered, in two classes:

- **A closing quote behind an odd backslash run** is reported undeterminable whatever the dialect, and
  this is the most frequent prompt the rule buys: it covers a literal ending in a backslash (a Windows
  path) *and* `\'` as an escaped apostrophe — which is MySQL's own escape, so an everyday MySQL read
  such as `… WHERE name = 'O\'Brien'` asks on every execute. Naming the dialect does not narrow this
  one, because whether `\` escapes is deliberately not a fact the grammar record carries yet (fixtures
  across this milestone rest on the undeterminable reading). What does *not* happen is a prompt
  for a statement that merely contains a backslash — `SELECT 'a\nb' FROM t`, `… LIKE 'a\_b'` and
  `'C:\\Users\\me'` all resolve and run without one.
- **A bracketed run a dialect at the default bracket reading cannot close.** `[…]` is read as SQL
  Server's quoted name for the dialects with no established subscript rule (MySQL, Oracle, Couchbase,
  Druid, LibreDB), so a nested run or a key carrying a `]` written there is unresolvable and asks.
  ClickHouse and PostgreSQL read those as subscripts and do not — the PostgreSQL row was established
  precisely because everyday syntax there (`ARRAY[[1,2],[3,4]]`, `j['a]b']`) was paying this prompt.
  Ordinary `a[1]` and `ARRAY[1,2]` resolve under every reading.

**Not a cost this rule pays: non-SQL query text.** Both execution paths ask about whatever is in the
editor, so this predicate is handed MongoDB documents and Redis commands as well. A SQL span reader's
verdict about text that is not SQL is not evidence of anything — the escaped quote in
`{"filter":{"msg":"say \"hi\""}}` or in `SET k "a\"b"` closes perfectly in the grammar the text is
actually written in — so the unresolvable-run rule is applied only where `readsSqlText()` says the
dialect writes SQL. Saying *"could not be read"* about text that reads fine is the false alarm this
notice exists to avoid, and a gate operators learn to click through protects nothing. The keyword
tests still run on that text; only the span-based rule is narrowed.

A fourth class arrives with the nesting fact (#300), and it is the reverse of the ones above — a prompt
the dialect *adds* rather than one it narrows: on PostgreSQL, SQL Server and ClickHouse a block comment
carrying one opener too many (`/* a /* b */ SELECT 1`) never closes, so an ordinary read written that
way asks before it runs. That is the fail-safe direction on those engines, where the same text is
either an unterminated comment (so the server rejects it) or a comment hiding a statement nobody can
see; the flat reading of it — comment closed, `SELECT 1` executed — is what a dialect-less caller and
the flat dialects still get.

Naming the dialect narrows the second class — ClickHouse's `[[1,2],[3,4]]` is a closed run under its
own grammar (#295) and unresolvable only to a reader without it — and it lifts a form the default
cannot read at all: Oracle's `q'{it's}'` (#292). It does nothing for the first class, per that
bullet.

Three gaps are known and pinned by tests rather than claimed closed:

- **Only `UPDATE … SET` is looked for inside a read.** A write hidden in a CTE *body* under any
  other keyword (`WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone`) does not prompt.
  Widening the probe to `DELETE`/`INSERT`/`MERGE` would also make every read whose code names one
  of them prompt, so the asymmetry is inherited from the vocabulary above rather than chosen here.
- **A statement whose shape cannot be TYPED** — an unclosed CTE list such as
  `WITH t AS (DELETE FROM x` — does not prompt. This is the boundary of the rule above rather than
  an exception to it: every character was read, and what they spell is an incomplete statement
  rather than a run hiding what is written inside it. No dialect accepts the text, so the server
  rejects it; and the keyword inside the unclosed list is a CTE-body write, which the gap above
  already does not prompt for even when the list closes. Pinned by
  `tests/components/QuerySafetyDialog.test.tsx` ("does not prompt when the statement's shape cannot
  be typed") so the boundary stays a decision — the shipped rule keys on unresolvable *runs*, and
  widening it to every statement the reader cannot type would prompt for an empty editor.
- **A multi-statement script is read as one statement.** `SELECT 1; DROP TABLE users` does not
  prompt (its first keyword is the `SELECT`), while `SELECT 1; UPDATE t SET x = 1` does, because
  the unanchored probe finds it. Executing the destructive statement on its own prompts, as long
  as that statement's own shape can be typed — the gap above is the exception.

Four runs bypass the gate on purpose, all on the standalone path
(`src/hooks/use-query-execution.ts`): an EXPLAIN run (see below), a Load-More page of a result the
user already has, a playground run (rolled back rather than committed), and anything carrying
`skipSafety` — which is the dialog's own "Execute Anyway" button and the inline row editor, whose
`UPDATE` comes from a grid edit the user has already confirmed. The embedded adapter
(`src/workspace/hooks/use-query-adapter.ts`) has only the force-execute bypass, so every other
query a host application runs through it reaches the gate.

---

## Load More Functionality

### User Flow

1. Execute query → 500 rows displayed
2. Click "Load More" → Next 500 rows appended
3. Repeat until all data loaded or satisfied

### API Request

```typescript
// Initial query
POST /api/db/query
{
  "connection": {...},
  "sql": "SELECT * FROM orders",
  "options": { "limit": 500, "offset": 0 }
}

// Load More
POST /api/db/query
{
  "connection": {...},
  "sql": "SELECT * FROM orders",
  "options": { "limit": 500, "offset": 500 }
}
```

### Response Format

```typescript
{
  "rows": [...],
  "fields": ["id", "name", ...],
  "rowCount": 500,
  "executionTime": 45,
  "pagination": {
    "limit": 500,
    "offset": 0,
    "hasMore": true,        // More rows available
    "totalReturned": 500,
    "wasLimited": true      // System added LIMIT
  }
}
```

### Load All Option

For advanced users, a "Load All" button triggers an unlimited query (max 100K rows) with a confirmation dialog:

```
┌──────────────────────────────────────┐
│  Load all results?                   │
│                                      │
│  This may slow down your browser.    │
│  Max 100K rows will be loaded.       │
│                                      │
│  [Cancel]          [Load All]        │
└──────────────────────────────────────┘
```

---

## Result-Level Signals

Two things a result can say about itself, both optional and both filled by the provider that ran
the statement (issue #273). Neither has anything to do with auto-limiting.

### Engine Warnings

`QueryResult.warnings` carries the notices an engine attached to a run it **completed** — a
Couchbase query-service advisory, or a Druid answer admitting that some segments of the queried
data were unavailable while still answering 200. The field is **absent** when the engine reported
none, so its presence alone decides whether anything renders.

- With rows: an amber **WARNINGS badge** sits beside the AUTO-LIMITED badge in the stats bar. The
  messages are in its tooltip and are also read out by assistive technology.
- With no rows: the messages are listed outright under "Query returned no data". A result that is
  empty *because* the data was unreachable must not read as a result that is empty because the data
  is not there.

This is not the plan analysis in [Automatic Warning Detection](#automatic-warning-detection): those
are derived by the client from EXPLAIN output, these are the engine's own words about the run.

### Declared Column Types

`QueryResult.columnTypes` carries the type the wire format declared for each column of *this*
result, keyed by its name in `fields` and spelled the way the engine spells it
(`Nullable(String)`, `BIGINT`). For a computed column or an ad-hoc projection it is the only
source of a type at all — the schema tree has no catalog entry to answer with.

The type is shown beside the column name in the desktop table's header, and is part of that
header's accessible name. The compact table shown below the `md` breakpoint carries it as a
tooltip only: that table sizes its header and body cells from their own content, so visible text
in the header alone would push it out of step with the rows. A column the engine declared no type
for renders exactly as it did before.

---

## Query EXPLAIN Integration

### Automatic EXPLAIN

Every SELECT query automatically runs EXPLAIN in the background (parallel execution). This provides instant performance insights without user action.

### Supported Databases

| Database | EXPLAIN Format |
|----------|---------------|
| PostgreSQL | `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` |
| MySQL | `EXPLAIN FORMAT=JSON` |
| SQLite | `EXPLAIN QUERY PLAN` (tree, no cost/timing metrics) |

### Non-SELECT Statements

EXPLAIN is built for SELECT statements only. Clicking **Explain** with anything else
(`UPDATE`, `INSERT`, DDL, …) executes nothing and reports "Only SELECT statements can
be explained" — an explain run never falls back to running the original statement,
because it deliberately bypasses the dangerous-query confirmation dialog.

Because it bypasses that dialog, the classification is the *only* screen on this path, and on
PostgreSQL the wrapper is `EXPLAIN (ANALYZE, …)` — which **runs** what it explains. So the PostgreSQL
and ClickHouse strategies read the statement under their own dialect's grammar rather than the shared
default (#300): block comments nest in both, and a flat reading of
`/* a /* b */ SELECT 1 */ DELETE FROM users` reports `SELECT` as the leading keyword while PostgreSQL
reads the whole run as one comment and executes the `DELETE`. Verified on PostgreSQL 18: explaining
that statement against a three-row table left zero rows. Under PostgreSQL's grammar the statement
leads with `DELETE`, so nothing is built and the button reports that it cannot be explained. The other
four strategies stay dialect-blind: their engines' comment rules are the flat one the default already
applies (MySQL, SQLite) or were never established (Druid, Couchbase), and their EXPLAIN describes
without running, so the worst a misread comment costs there is a refused button.

### How It Works

```
User executes: SELECT * FROM orders WHERE status = 'pending'

┌─────────────────────────────────────────────────────────────┐
│                    Parallel Execution                        │
│                                                              │
│  ┌──────────────────┐      ┌──────────────────────────────┐ │
│  │   Main Query     │      │   Background EXPLAIN          │ │
│  │   (with LIMIT)   │      │   (no LIMIT, ANALYZE)         │ │
│  └────────┬─────────┘      └────────────┬─────────────────┘ │
│           │                              │                   │
│           ▼                              ▼                   │
│     Results Tab                    Explain Tab               │
└─────────────────────────────────────────────────────────────┘
```

### Accessing EXPLAIN Data

Click the "Explain" tab in the results panel to view:
- Performance Insights
- Execution Plan Tree
- Raw JSON

---

## Performance Insights

### VisualExplain Component

Location: `src/components/VisualExplain.tsx`

The VisualExplain component analyzes execution plans and provides actionable insights.

### Automatic Warning Detection

| Warning | Trigger | Severity |
|---------|---------|----------|
| Sequential Scan | Seq Scan on >10K rows | Warning |
| Estimate Mismatch | Actual/Planned ratio >10x or <0.1x | Info |
| Expensive Sort | Sort operation >100ms | Warning |
| High Loop Count | Nested Loop >1000 iterations | Critical |

### Warning Examples

**Sequential Scan Warning:**
```
⚠️ Sequential Scan
Full table scan on "orders" (15.2K rows). Consider adding an index.
```

**N+1 Problem Detection:**
```
🔴 High Loop Count
Nested loop executed 5.2K times. This could indicate an N+1 problem.
```

**Estimate Mismatch:**
```
ℹ️ Estimate Mismatch
Expected 100 rows, got 15.2K. Statistics may be outdated.
```

### Metrics Grid

| Metric | Description |
|--------|-------------|
| Cache Hit Rate | Buffer cache efficiency (>95% is good) |
| Operations | Number of plan nodes |
| Execution | Total query time |

### Plan Tree View

Interactive, collapsible execution plan with:
- Node type icons (Seq Scan, Index Scan, Join, Sort, etc.)
- Time bars showing relative cost
- Row counts and costs
- Filter conditions
- Index usage

```
▼ Limit (0.12ms, 500 rows)
  └─▼ Sort (45.2ms, 500 rows)
      └─▼ Seq Scan on orders (120.5ms, 15.2K rows)
          Filter: status = 'pending'
```

---

## Architecture

### File Structure

```
src/
├── lib/db/utils/
│   └── query-limiter.ts      # Query parsing and LIMIT injection
├── app/api/db/
│   └── query/route.ts        # Query API with pagination
├── components/
│   ├── Studio.tsx            # Query execution orchestration
│   ├── ResultsGrid.tsx       # Results display with Load More
│   └── VisualExplain.tsx     # EXPLAIN visualization
└── lib/types.ts              # QueryPagination interface
```

### Data Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Dashboard  │────▶│  /api/db/query   │────▶│  DB Provider    │
│             │     │                  │     │                 │
│ executeQuery│     │ - Parse query    │     │ - Execute SQL   │
│             │     │ - Apply LIMIT    │     │ - Return rows   │
└─────────────┘     │ - Add pagination │     └─────────────────┘
       │            └──────────────────┘
       │
       ▼
┌─────────────┐     ┌──────────────────┐
│ ResultsGrid │     │  VisualExplain   │
│             │     │                  │
│ - Show rows │     │ - Parse plan     │
│ - Load More │     │ - Show warnings  │
│ - Stats bar │     │ - Render tree    │
└─────────────┘     └──────────────────┘
```

### Key Interfaces

```typescript
// Query pagination metadata
interface QueryPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  totalReturned: number;
  wasLimited: boolean;
}

// Query result with pagination
interface QueryResult {
  rows: any[];
  fields: string[];
  rowCount: number;
  executionTime: number;
  explainPlan?: any;
  pagination?: QueryPagination;
  warnings?: QueryWarning[];             // notices the engine attached; absent when it reported none
  columnTypes?: Record<string, string>;  // declared type per column, keyed by its name in `fields`
}

// Query tab state
interface QueryTab {
  id: string;
  name: string;
  query: string;
  result: QueryResult | null;
  explainPlan?: any;
  currentOffset?: number;
  isLoadingMore?: boolean;
  allRows?: any[];
}
```

---

## Best Practices

### For Users

1. **Use WHERE clauses** - Filter data at the database level
2. **Add LIMIT when known** - If you only need 10 rows, add `LIMIT 10`
3. **Check Explain tab** - Review performance before running in production
4. **Use indexes** - Add indexes for frequently filtered columns

### For Developers

1. **Never bypass the limiter** - Always use the query API
2. **Handle pagination** - Support `hasMore` in custom implementations
3. **Parse EXPLAIN** - Use the analyzePlan function for custom analysis

---

## Configuration

Currently, limits are hardcoded. Future versions may support configuration:

```typescript
// Future: .env configuration
QUERY_DEFAULT_LIMIT=500
QUERY_MAX_UNLIMITED=100000
EXPLAIN_AUTO_RUN=true
```

---

## Changelog

| Version | Changes |
|---------|---------|
| 0.7.0 | Initial query optimization system |
| 0.7.1 | Removed Large Dataset popup (silent limiting) |
| 0.7.1 | Added automatic background EXPLAIN |
| 0.7.1 | Added VisualExplain with Performance Insights |
