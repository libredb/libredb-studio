# Agent demo script

Twenty-five cases, ordered easy to hard, for showing LibreDB Studio's agent to someone who has
not seen it. Every case here was **driven live** against a real model and a real database before it
was written down, and each one records what actually came back — including the ones that refuse.
Nothing in this file is aspirational.

The refusals are not filler. Half of what makes an agent worth putting near a production database is
what it declines to do, and a demo that only shows the happy path sells the wrong product.

## What works on which engine

Driven live on 2026-08-15, one engine at a time, against real servers. **Verified** means a run of
that kind was started on that engine and its outcome read off the screen — nothing in this table is
inferred from the code.

| Engine | Plan mode | Operate | Investigate · Analyze · Optimize · Assess |
| --- | --- | --- | --- |
| **PostgreSQL** 18 | Verified, grounded | Verified | Verified |
| **SQLite** | Verified, grounded | Verified | Verified |
| **Redis** 7 | Verified | Verified | Refused |
| **MongoDB** 8 | Verified | Verified | Refused, verified |
| **SQL Server** 2022 | Verified | Verified | Refused |
| **ClickHouse** 26 | Verified | Verified | Refused |
| **LibreDB** (embedded) | Verified | Not established | Refused, verified |
| MySQL · Oracle · Couchbase · Druid | Expected to work | Expected to work | Refused |

**Read the table this way.** Plan mode opens on every engine — it runs no statement of yours on any
of them — but it is only *grounded* (case 18) on PostgreSQL and SQLite, because only those two
capture a schema inventory and the engine's own size estimates. Ungrounded, it has nothing to draft
a statement against and says so instead. Operate reads what the engine reports about itself, so it needs no SQL and reaches
everything. The other four workflows write SQL and need a database-native read-only statement path,
which today only PostgreSQL and SQLite provide; everywhere else the run ends with *"The agent cannot
run on this database engine: it offers no read-only execution profile."*

The last row is honest rather than modest: those four implement the same provider interface the six
above do, so the same rules should apply — but nobody has started a run on them, so they are not
claimed. "Refused" for their four SQL workflows is not a guess: it follows from the same
`queryReadOnly` requirement that refused MongoDB, and that one was watched.

**LibreDB's own embedded sample** is the one gap. Its four SQL workflows refuse like the others
(watched), but an Operate run against it could not be completed here: the sample file was held under
an exclusive lock by another process, so the run failed on the connection rather than on anything the
agent did. Worth knowing before you demo against it.

## Before you demo

**Databases used here.** PostgreSQL 18 with the [Pagila / dvdrental sample](https://neon.com/postgresql/getting-started/sample-database)
(22 tables, 16 044 rentals, 14 596 payments) and the SQLite employees sample this repository ships
(1 000 employees, 9 488 salary rows). Both are public sample data — safe to project.

**Agent mode needs a seed connection.** A connection created in the UI cannot be investigated: a run
persists a connection id and no credential, so the server has to be able to rebuild it. Put the
connection in `seed-connections.yaml` and point `SEED_CONFIG_PATH` at it. See
[`docs/SEED_CONNECTIONS.md`](./SEED_CONNECTIONS.md).

**PostgreSQL needs a least-privilege role.** The agent refuses a superuser outright — a read-only
transaction does not stop `COPY TO PROGRAM` or server-side file access, so the profile checks the
role itself. This is a good thing to show, not a snag to hide (case 22). A role that works:

```sql
CREATE ROLE libredb_agent LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE dvdrental TO libredb_agent;
GRANT USAGE ON SCHEMA public TO libredb_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO libredb_agent;
GRANT pg_read_all_stats TO libredb_agent;   -- for the Operate workflow
```

**Run it from a production build** (`bun run build` then `bun run start`). In development React needs
`eval`, which the CSP does not allow, so the login page does not hydrate (`docs/BACKLOG.md` B40).

**Two axes, chosen independently.** Plan or Agent decides whether the run may touch the database;
Investigate / Optimize / Assess / Operate / Analyze decides what it is for. A planning run of a query
optimization is an ordinary thing to ask for.

---

## Act 1 — "it knows my database" (2 minutes)

Low risk, instant payoff. Use these to establish that the thing is real before asking anything hard.

### 1. What is in here?
**Agent · Investigate ·** `What tables are in this database and how do they relate to each other?`

Comes back with the table inventory and the relationships between them, each claim citing the schema
snapshot it read. On the employees database: six tables and two views, named correctly.

### 2. The join path nobody remembers
**Agent · Investigate ·** `How would I find which films a given customer has rented? Explain the join path.`

Answers `customer → rental → inventory → film`, naming the key on each hop. This is the moment a
developer in the room stops taking notes and starts watching: it is the three-hop join they would
have had to reconstruct from an ER diagram.

### 3. Write me the query
**Agent · Investigate ·** `Write me a query for the ten highest-paid employees with their department name.`

The statement appears in the timeline with an **Apply to editor** button. Click it — the SQL lands in
the editor, formatted, ready to run. Nothing ran on its own.

---

## Act 2 — "it answers business questions" (5 minutes)

This is the data-analyst face and the strongest part of the demo. Ask in plain language; never
mention a table name.

### 4. Plain question, exact answer
**Agent · Analyze ·** `Who are our top 10 customers by total revenue, and how much did each spend?`

Named customers with amounts to the cent: Eleanor Hunt $211.55, Karl Seal $208.58, Marion Snyder
$194.61. Verified against the database by hand — every figure matched.

### 5. Ask for a chart, get a chart
**Agent · Analyze ·** `Draw a bar chart of rental volume per month.`

The Charts tab opens by itself and the bars are drawn. The run reads the data on its own bounded,
read-only path, names which result **is** the answer, and the chart is shown without anyone clicking
anything. If the columns a chart names are not columns of that result, the chart is refused rather
than drawn wrong.

### 6. A question that spans the schema
**Agent · Analyze ·** `Which part of the company costs us the most in salary?`

Answers *Development*, with the total, and says which definition it used ("current salary") — which
matters, because the ranking is the same under either definition but the number is not.

### 7. Two periods, compared
**Agent · Analyze ·** `Compare the average salary of employees hired before 1990 with those hired after, as a chart.`

66 181.48 against 61 050.05. Both verified by hand, both exact.

### 8. Is the trend up or down?
**Agent · Analyze ·** `Is our headcount growing? Show hires per year as a chart.`

Fifteen years as bars, and a written conclusion that hiring is **not** growing — a peak of 118 in
1985 falling to 4 in 1999. Worth pausing on: it answered the question that was asked, not the
question the data flatters.

---

## Act 3 — "it thinks like a DBA" (5 minutes)

The Operate workflow answers from the engine's own statistics rather than by writing SQL. It works on
every provider, including the ones agent mode otherwise cannot reach.

### 9. What is happening right now?
**Agent · Operate ·** `Which sessions are active on this server, is anything blocked, and which queries are slowest?`

Real `pg_stat_activity`: session count, user, client address, state, and whether anything is blocked
or waiting on a lock. Every reading carries the caveat *"A moment, not a history"* — it is a point in
time and the product says so rather than letting the model imply a trend.

### 10. Which indexes are dead weight?
**Agent · Operate ·** `Which indexes are never used, and which tables are the largest?`

Index scan counts and table sizes straight from the catalog. On dvdrental: `rental` at 2 408 448
bytes, `payment` at 1 859 584 — byte-exact against a hand-written query.

### 11. Where is the storage going?
**Agent · Operate ·** `How is storage distributed across this database, and is anything unusually large?`

Main file, WAL, shared memory, and table-level distribution.

### 12. The honest empty answer
**Agent · Operate ·** `Which queries are slowest on this database right now?`

On an idle database the slow-query log is empty — and in one run the agent noticed that the health
reading claimed `slowQueryCount: 2` while the log itself returned zero rows, and **reported the
discrepancy** instead of picking whichever number made a better answer. If it happens during your
demo, stop and read it out.

### 12b. The same question, against Redis
**Agent · Operate ·** on a Redis connection: `How is this Redis instance doing? Memory, clients, and what keys are stored.`

Answers: memory used (2.30M, and what share of the limit that is), connected clients, whether anything
is blocked, and which commands those clients are running. Verified against `redis-cli INFO` — the
figures match.

**This is the case to show a sceptic.** Redis has no SQL at all, and agent mode's other workflows
cannot reach it: they need a database-native read-only statement path, which only PostgreSQL and
SQLite provide. Operate does not write SQL — it reads what the engine already reports about itself —
so it answers the same operational questions on every provider Studio supports. Run case 9 against
PostgreSQL and this one against Redis back to back, and the point makes itself.

---

## Act 4 — "it makes queries faster, and shows its work" (4 minutes)

### 13. Why is this slow?
**Agent · Optimize ·** paste a real query, e.g.
`This is slow: SELECT c.first_name, c.last_name, SUM(p.amount) FROM customer c JOIN payment p ON c.customer_id = p.customer_id WHERE p.amount > 5 GROUP BY c.customer_id, c.first_name, c.last_name. How would you make it faster?`

Two things land. **Plans compared** — with real PostgreSQL costs, e.g. *"a full scan (599 rows, cost
348.07) to a full scan (599 rows, cost 348.07)"* — and **Index recommended**, with the `CREATE INDEX`
statement and an Apply to editor button.

Read the caveat aloud: *"Estimates only: these plans were described, not executed. EXPLAIN ANALYZE is
policy-denied because it would run the statement."* The agent will not run your slow query to find
out how slow it is.

### 14. It never applies anything
Point at the recommendation and note that nothing created the index. Every statement the model writes
is offered, never applied. The run has no way to change your database at all.

---

## Act 5 — "it can drive the editor, within limits" (4 minutes)

This is the part that gets the room's attention, and the part to demo carefully, because what makes
it defensible is the gate.

### 15. The checkbox that names its bounds
**Agent · Analyze ·** tick **"Also run the final answer in my editor"** and read the copy under it out
loud. It states what is given up (the time limit) and what is kept (the row limit), and that writes
and DDL are refused **by the engine rather than by reading the statement**. On SQLite it adds that a
long read blocks other writers.

### 16. Gate open: the answer runs
**Agent · Analyze ·** `What did customer 5 pay in total, and how many payments did they make?`

Three conditions all hold — the run executed that exact statement itself, the plan reads as cheap,
and the measured time is under the threshold — so the statement runs in the editor and the rows
appear: 134.65 across 35 payments. Verified by hand.

The replay does not go through the ordinary editor route. It goes to a run-scoped endpoint that takes
**no SQL at all**: the statement comes off that run's own ledger, and it executes inside the
database's own read-only session.

### 17. Gate closed: it says why
**Agent · Analyze ·** `What is the total revenue per film category? Show it as a chart.`

The gate declines and names the reading that declined it:

> Not run for you: **the plan reads the whole table rather than reaching its rows through an index**,
> so this one is yours to run.

The statement is placed in the editor **unrun**, and the chart is still drawn, because the run had
already read the answer on its own bounded path. Nothing on screen claims an execution that did not
happen.

Read the sentence out. It names one reading, not a list of the readings that might have applied —
and there are seven it could have named: no plan held for that exact statement, a plan in a dialect
this server has no rule for, a step it could not interpret, an access path it could not determine, a
whole-table read, a plan with no cost in it, or a cost over the ceiling.

Two of those distinctions are finer than they look and worth keeping straight if someone asks: "the
plan reads the whole table" and "this server could not tell how the statement reaches its rows" are
different facts, and so are "no plan is held" and "a plan is held that this server cannot weigh". The
gate refuses in all four, and says which.

The cost case arrives with both numbers in it — *"the engine estimates 4320000, against a ceiling of
50000"* — which is the version someone can argue with.

This is the case to dwell on. A demo that only shows case 16 is showing a party trick; showing 16 and
17 together is showing a control.

---

## Act 6 — "it is safe to point at production" (4 minutes)

### 18. Plan mode: it knows your schema and runs nothing of yours

> **This case was measured before 2026-08-15 and its script is no longer accurate.** The plan-mode
> SQL-generator design of that date changed what the mode does: a plan run now reads this
> connection's catalog and the engine's estimated statistics **itself**, server-side, before the
> model's first turn, and its deliverable is one runnable statement rather than a plan in prose. The
> claims below that the mode "never touches the database" and that the meter reads `0 / 30` are the
> retired contract, and the numbers in the paragraphs that follow were observed under it. **Re-drive
> this case and rewrite it from what you see** rather than reading it as written; `docs/AGENT.md`
> ("What a plan run knows") carries the current contract in the meantime.

Switch to **Plan**, select **Investigate**, and ask: `How would you assess this database before a production release?`

What to say while it runs is the property the mode is actually sold on, and that one is unchanged:
**a plan run executes no statement of yours, writes nothing, and hands every statement it drafts to
you to run yourself.** The reading it does take is a catalog read — the same one the sidebar takes on
every connect — through the same read-only, audited, budgeted path an Agent run's `inspect_schema`
uses. The model itself is still handed no tools.

Then look at what the plan names. Against dvdrental it works through `public.staff`, `public.rental`,
`public.payment`, `public.inventory`, `public.film_actor`, the reporting views — and in one run it
singled out `public.staff` for a credentials check, naming the `username`, `password` and `email`
columns. It has never seen a row: the grounding reads the catalog and the engines' own estimates,
never a value out of a column.

*Bounds, worth stating before someone finds them:* the grounding serves **PostgreSQL and SQLite
only**, because those are the dialects the catalog composer serves. On any other engine a plan run is
ungrounded, and its rules steer it to say so rather than to invent tables.

### 19. Both axes are independent
**Plan · Optimize ·** `What would you check first if this database were slow in production?`

Still a plan, and still nothing of yours executed — but framed by the optimization workflow, so it is
about access paths rather than generic health. Plan/Agent and the workflow are two separate choices.

### 19b. A plan you can actually take with you
Ask the same Plan run for something concrete — **Plan · Optimize ·** `Which indexes would you check first, and what statement would show me their usage?` — and look at what comes back.

The SQL arrives as a code block, not as a paragraph, and it carries two controls: **Apply to editor**
puts the statement in the editor unrun, and **Copy** puts it on the clipboard. **Copy all** at the
foot of the plan takes the whole thing as the markdown the model wrote — the version that pastes into
a ticket with its headings intact.

Driven live against dvdrental **before 2026-08-15**, the plan came back with two blocks — a
`pg_stat_user_indexes` read ordered by `idx_scan`, and the `sys.dm_db_index_usage_stats` equivalent
it offered for SQL Server — each with its own pair of controls. Click Apply on the first and it lands
in the editor with its indentation intact, ready to run.

Since that date the run's statement is a **ledger fact**, not text the browser found: the server
reads it out of the closing prose, records it as `plan-statement-drafted` with the guard's read-only
verdict and what the identifier check found, and the rail shows it in a card of its own. A statement
the guard did not read as a bounded read is **marked** there — amber, with the guard's own reason —
and the marked control is the only "Apply to editor" offered for it. Re-drive this case: what the
model produces, and how many blocks it writes, was observed under the old contract.

Worth saying out loud if a DBA in the room asks how a toolless mode produced a statement: the model
had no tools and the run executed nothing of yours. Applying is your click, in your editor, on your
connection.

*Where the editor button is withheld:* a block the model tagged as something other than a query
language — `bash`, `json` — is copyable and is not offered to the SQL editor, because the model said
what it is.

### 20. Stop means stop
Start a long run — **Agent · Assess ·** `Profile every table at pattern depth and grade completeness, uniqueness, consistency and validity for each one` — and press **Stop** while it is working.

The run takes no further database step and finishes the report from what it already had. The ending
says so: *"A stop was requested before this ending: the run took no further database step, and
finished what it already had in hand."* You get a partial answer with its evidence, not a discarded
run.

### 21. It will not invent an answer
**Agent · Analyze ·** `What is our customer churn rate this quarter?` against the employees database.

It does not produce a churn number. It reports that the schema holds employee records rather than
customer records, and says the question is not answerable here.

### 22. It refuses a superuser
Point it at PostgreSQL as `postgres` and start a run. It refuses, because a read-only transaction
does not stop `COPY TO PROGRAM` or server-side file reads — so the profile requires a least-privilege
role rather than trusting the transaction. *(The message a user sees today names the engine rather
than the role; the server log carries the exact reason. Recorded in `docs/BACKLOG.md`.)*

### 23. Every claim is checkable
Open any report and look at a claim. Each one cites something **this run** produced, and the citation
is shown rather than described: a result it read, with the correlation id, the row count and the
statement behind it — or the schema inventory it captured, named by its `ctx_…` fingerprint, for a
claim that rests on structure rather than on rows (case 1 is full of those).

A claim citing evidence the run never produced is refused when the report is composed. The model
cannot assert something and leave you to trust it.

---

## What to say when someone asks the hard question

**"Can it damage my database?"** Writes and DDL are refused twice over, and the second refusal is the
one that matters. Before a provider is even acquired, the statement is inspected and anything that is
not a single read is rejected. Then the read runs inside a **database-enforced** read-only session
with a statement timeout, a row cap and a byte cap, refusing rather than truncating.

Lead with the second one when you answer. A parser can be fooled — a `SELECT` may call a function
that writes, and no amount of reading the text reveals that — which is exactly why the boundary is
the engine's own read-only transaction rather than the guard in front of it. The editor replay in
cases 15-17 runs in that same session; what it gives up is the timeout, and the checkbox says so.

**"What if the model hallucinates?"** It can, and the product is built on the assumption that it
will. A claim must cite something the run read or it is refused. A chart must name columns that exist
in that result or it is refused. An answer must be a result of a query the run actually ran — a plan
or a profile cannot be presented as one. The verdict at the end of a run is computed from the run's
ledger, not from the model's opinion of its own work.

**"Which databases?"** See the table at the top. The short version: Operate works everywhere and was
driven live on six engines including Redis, which has no SQL at all; the four SQL workflows need
PostgreSQL or SQLite today; plan mode has no engine limit and is grounded on those same two.

**"What does it cost per question?"** Each workflow has a frozen ceiling on model turns, statements,
wall clock and database time, and the rail shows the meter live. The figures are the starting point
for a measurement that has not been taken yet — treat them as bounds, not as a price list.

---

## Not yet — and what each one is waiting on

Say these plainly if asked. Everything here is recorded in `docs/BACKLOG.md` with the design that
would close it, so "not yet" means deferred with a reason, not overlooked.

| Not yet | What happens today | Waiting on |
| --- | --- | --- |
| **Follow-up questions** | Each run starts fresh, and neither the surface nor the model says so — ask "and how many of those?" and you get a confident answer to a different question | B36 — either carrying the previous run's objective and report into the next as fenced context, or run history |
| **A plan on a cold server** | The inventory lives in the server process, so after a restart a plan run is ungrounded and says so | B42 — a durable inventory, which needs a timeline that does not claim a plan run captured a schema |
| **Causal questions** — "why are sales down?" | Answered from the schema alone, which cannot know which decomposition of a metric is the business one | A per-connection business note, held server-side; sketched in `docs/AGENT_ANALYST_DESIGN.md` §5 |
| **"This database cannot answer that"** | It does say so, but has to run a throwaway query to be scored as having answered — the run above spent 36 steps to report that an employees database holds no customer data | B39 — a second arm on the verdict, so a schema-only conclusion counts |
| **Agent mode on MySQL, Oracle, MongoDB, Redis…** | Only Operate. The other four workflows refuse, correctly and clearly | A database-native read-only statement path per engine — the same `queryReadOnly` PostgreSQL and SQLite implement |
| **A run you can watch from your own stack** | Everything is in the run's ledger and on the rail; nothing is exported | B33 — OpenTelemetry spans, designed in #332 and deliberately not built while the event model is still moving |
| **Resuming a run after a restart** | A drive that dies leaves a durable ledger, but nothing picks it up | B9 — a queue and a re-attach path for the stream |
| **A budget you can trust to the minute** | The ceilings are real and enforced; the *numbers* are a starting point nobody has measured | One instrumented long run per workflow |
| **Connections you created in the UI** | Agent mode is offered only on seed connections, because a run has to be rebuildable server-side | A server-held credential for user connections — not designed |

Two smaller ones worth knowing before they surprise you on stage:

- **A refused PostgreSQL role reads as a refused engine.** Point the agent at a superuser and the
  message says the engine offers no read-only profile. The engine does; the role is too broad, and
  only the server log says so (case 22).
- **A connection error can arrive as "the reason is in the server log".** An Operate run against a
  locked LibreDB file failed with a perfectly actionable message — *"already open by another process
  (exclusive lock)"* — that the rail did not show.
