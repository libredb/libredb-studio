# Agent demo script

Twenty-five cases, ordered easy to hard, for showing LibreDB Studio's agent to someone who has
not seen it. Every case here was **driven live** against a real model and a real database before it
was written down, and each one records what actually came back — including the ones that refuse.
Nothing in this file is aspirational.

The refusals are not filler. Half of what makes an agent worth putting near a production database is
what it declines to do, and a demo that only shows the happy path sells the wrong product.

**Last re-driven end to end on 2026-08-17**, 26 runs through a browser against a production build.
Several cases got worse in that drive rather than better — case 6 no longer says which definition it
used, case 19 opens as the wrong workflow, case 20's ending is not the one this file used to quote,
and case 22 cannot be performed at all. They are written down as they are. A script that only
records the improvements is not a measurement.

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

**One correction to that reading, and it bites in case 19b.** Grounding is not only engine-dependent
— it is *workflow*-dependent. A plan-mode **Operate** run is ungrounded by design on every engine,
PostgreSQL included: an operations objective is not about the schema, so no catalog is read and the
run's own opening line says *"Because no schema was read, we cannot name specific tables or indexes
upfront"* on a database it could have read perfectly well. Nothing on screen distinguishes that from
the ungrounded-engine case (backlog B46), so a room that has just been told "PostgreSQL and SQLite
are grounded" will read it as a bug.

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

**You no longer pick a workflow, and this changes every case below.** There is no workflow tab row.
You type an objective and press **Start**; the rail says *"Reading your objective to choose a
workflow"*, the server reads it, and the run opens for the workflow that reading names. The run then
carries a banner saying which: *"Opened as Analyze, read from your objective."* Naming one yourself
still exists, under a collapsed **Advanced** disclosure whose default is **Automatic** — its own
helper text says what the trade is: *"Automatic reads your objective on the server and opens the run
for the workflow it names. Naming one yourself skips that reading entirely."*

**How a case is written below.** **Agent ·** or **Plan ·** — the one axis you still choose — then
the objective you type, then *(opens as X)*: the workflow the server read out of that objective on
2026-08-17. You do not type the workflow. Where the reading disagreed with what the case wanted,
the case says so and says what to do about it.

**The reading is right about four times in five.** Across the 21 objectives in this script it opened
the intended workflow **17 times — 81%**. Of the four it did not: case 3 opened as Analyze where the
script said Investigate and the substance held anyway; case 18 opened as Assess, which is arguably
the better reading of the objective; cases 19 and 19b opened as Operate where Optimize was wanted,
and that one is a genuine misread whose result is not demonstrable. Quote the rate rather than
hiding it — an 81% reading with two visible correction paths is a better story than a silent one.

**When the reading is wrong, there are two ways out and both are on screen.** Before you Start, open
**Advanced** and name the workflow — the banner then does not appear at all, because nothing was
read. While the run is still open, press **change** on the banner itself, which offers the five
workflows and states its own terms first: *"Changing it stops this run and opens a new one. Stopping
is observed between turns, so it is not instant: the run ends at its next checkpoint. The new run
gets a new id, and this one stays in the ledger with everything it recorded."* The control
disappears once the run ends. It is worth showing deliberately once — a misclassification the
presenter corrects live is a better demo than one that never happens.

**Agent mode needs a connection the server can rebuild** — which is not the same as "a connection in
the seed file". A run persists a connection id and no credential, so the server has to be able to
resolve it again from its own configuration. Seed connections
([`docs/SEED_CONNECTIONS.md`](./SEED_CONNECTIONS.md), pointed at by `SEED_CONFIG_PATH`) qualify, and
so do the two built-in samples — **Sample (Employees)** and **Sample (LibreDB)** — which appear in no
seed file and run fine. A connection you created in the UI does not, and the rail says so instead of
failing later: *"PG Superuser (test) cannot be rebuilt on the server: its settings live in this
browser. A run re-resolves its connection there after a restart, so it can only investigate a
connection the server holds too."* Start is disabled underneath it.

**PostgreSQL needs a least-privilege role.** The agent refuses a superuser outright — a read-only
transaction does not stop `COPY TO PROGRAM` or server-side file access, so the profile checks the
role itself. A role that works:

```sql
CREATE ROLE libredb_agent LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE dvdrental TO libredb_agent;
GRANT USAGE ON SCHEMA public TO libredb_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO libredb_agent;
GRANT pg_read_all_stats TO libredb_agent;   -- for the Operate workflow
```

**That role cannot see foreign keys, and case 1 will tell your room there are none.** Measured on
the seeded dvdrental as `libredb_agent` (`usesuper = f`): `information_schema.table_constraints`
returns **0** FOREIGN KEY rows, while `pg_constraint WHERE contype = 'f'` holds **18**. PostgreSQL
shows a constraint through the `information_schema` views only to a role that owns the table or
holds a privilege on it *other than* `SELECT`, and the agent's relations read goes through those
views (`composePostgresRelations`, `src/lib/agent/composed-sql.ts`). So under exactly the role
prescribed above the relations graph is empty — and the run does the worst available thing with an
empty read, answering *"There are no declared foreign key constraints between tables in the
database"*, confidently, citing a snapshot that genuinely contained nothing. It is false, and it is
the first thing you would show. Until backlog **B44** closes, do one of two things: demo cases 1 and
2 against the SQLite employees sample, which reads the DDL text and is unaffected, or grant the
agent role something more than `SELECT` on the tables so the views open up. Do not present an FK
claim made from a `SELECT`-only PostgreSQL role.

**Run it from a production build** (`bun run build` then `bun run start`). In development React needs
`eval`, which the CSP does not allow, so the login page does not hydrate (`docs/BACKLOG.md` B40).

**Two axes, and you now choose only one of them.** Plan or Agent decides whether the run may touch
the database, and that is still a button you press. What the run is *for* — Investigate / Analyze /
Optimize / Assess / Operate — is read off the objective. A planning run of a query optimization is
still an ordinary thing to ask for; you ask for it by asking for it.

**One workflow raises a consent step, and only one.** In agent mode an **Analyze** run stops after
classification and before it opens, to ask whether its answer may also run in your editor (case 15).
Investigate, Operate, Assess and Optimize start immediately, and plan mode never raises it. If you
are waiting for the checkbox on any other case, you are waiting for something that will not come.

---

## Act 1 — "it knows my database" (2 minutes)

Low risk, instant payoff. Use these to establish that the thing is real before asking anything hard.

### 1. What is in here?
**Agent ·** `What tables are in this database and how do they relate to each other?` *(opens as Investigate)*

Comes back with the table inventory and the relationships between them, each claim citing the schema
snapshot it read. On the employees database: six tables and two views, named correctly. The rail's
fingerprint counts them together and reports **8 tables** — views included — which is worth saying
before someone catches the mismatch; on dvdrental the same counter reads 22.

**Read the hazard note above before you run this against PostgreSQL.** With a `SELECT`-only role the
relations half of this answer is not merely thin, it is a confident negative: *"There are no
declared foreign key constraints between tables in the database."* dvdrental has 18. Show this case
on SQLite, or on a role that can see constraints.

### 2. The join path nobody remembers
**Agent ·** `How would I find which films a given customer has rented? Explain the join path.` *(opens as Investigate)*

Answers `customer → rental → inventory → film`, naming the key on each hop. This is the moment a
developer in the room stops taking notes and starts watching: it is the three-hop join they would
have had to reconstruct from an ER diagram.

Know why it worked, because it is not the reason it looks like. Under the documented role the
relations graph handed to this run was **empty** (case 1), and the model reconstructed the path from
column names alone. It got it right. It got it right *without* the evidence it was supposed to have,
which is a good demo and a bad guarantee — one more reason B44 matters.

### 3. Write me the query
**Agent ·** `Write me a query for the ten highest-paid employees with their department name.` *(opens as Analyze, not Investigate)*

The statement appears in the timeline with an **Apply to editor** button. Click it — the SQL lands in
the editor, formatted, ready to run.

Two things to say honestly here. First, the reading disagreed with the script: "write me a query"
reads as an analysis objective, and the run opened as Analyze. That is defensible and the substance
held — you get the statement you asked for. It is also the natural place to demonstrate **change**
on the banner if you would rather show it as Investigate.

Second, do not say "nothing ran on its own", because as Analyze that is false: the run took two
`run_read_query` steps on its own bounded, read-only path before it answered. The true and stronger
claim is the one about *your* database session — **nothing was sent to your editor and nothing was
applied.** Applying is your click.

---

## Act 2 — "it answers business questions" (5 minutes)

This is the data-analyst face and the strongest part of the demo. Ask in plain language; never
mention a table name. Every case in this act opens as Analyze, and every one of them raises the
consent step of case 15 before it starts — decide once whether you are ticking it, and say why.

### 4. Plain question, exact answer
**Agent ·** `Who are our top 10 customers by total revenue, and how much did each spend?` *(opens as Analyze)*

Named customers with amounts to the cent: Eleanor Hunt $211.55, Karl Seal $208.58, Marion Snyder
$194.61. Verified against the database by hand — every figure matched.

### 5. Ask for a chart, get a chart
**Agent ·** `Draw a bar chart of rental volume per month.` *(opens as Analyze)*

The Charts tab opens by itself and the bars are drawn. The run reads the data on its own bounded,
read-only path, names which result **is** the answer, and the chart is shown without anyone clicking
anything. If the columns a chart names are not columns of that result, the chart is refused rather
than drawn wrong.

### 6. A question that spans the schema
**Agent ·** `Which part of the company costs us the most in salary?` *(opens as Analyze)*

Answers **Development**, with a total — and this is the case that got worse under measurement. It
summed the *entire salary history* (165 467 285) and **named no definition at all**. The ranking is
the same under either definition and that part held; the number is not the number a finance person
means by "costs us the most", and the run did not say which one it computed.

Use it anyway, and use it for the honest point: ask the follow-up out loud — *"is that current
salary or every row ever?"* — and note that the product should have volunteered that and did not.
A room that watches you catch it trusts the next case more than one that watched a clean answer.

### 7. Two periods, compared
**Agent ·** `Compare the average salary of employees hired before 1990 with those hired after, as a chart.` *(opens as Analyze)*

66 181.48 against 61 050.05. Both verified by hand, both exact.

### 8. Is the trend up or down?
**Agent ·** `Is our headcount growing? Show hires per year as a chart.` *(opens as Analyze)*

Fifteen years as bars, and a written conclusion that hiring is **not** growing — a peak of 118 in
1985 falling to 4 in 1999. Worth pausing on: it answered the question that was asked, not the
question the data flatters.

---

## Act 3 — "it thinks like a DBA" (5 minutes)

The Operate workflow answers from the engine's own statistics rather than by writing SQL. It works on
every provider, including the ones agent mode otherwise cannot reach. The reading has no trouble
finding it: every objective in this act opened as Operate, and none of them raises a consent step.

### 9. What is happening right now?
**Agent ·** `Which sessions are active on this server, is anything blocked, and which queries are slowest?` *(opens as Operate)*

Real `pg_stat_activity`: session count, user, client address, state, and whether anything is blocked
or waiting on a lock. Every reading carries the caveat *"A moment, not a history"* — it is a point in
time and the product says so rather than letting the model imply a trend.

### 10. Which indexes are dead weight?
**Agent ·** `Which indexes are never used, and which tables are the largest?` *(opens as Operate)*

Index scan counts and table sizes straight from the catalog. On dvdrental: `rental` at 2 408 448
bytes, `payment` at 1 859 584 — byte-exact against a hand-written query.

### 11. Where is the storage going?
**Agent ·** `How is storage distributed across this database, and is anything unusually large?` *(opens as Operate)*

The tablespace and the write-ahead log, with a total, and then the table-level distribution: on
dvdrental, `pg_default` at 68 MB and WAL at 53 MB against a 121 MB total. It reports what the engine
accounts for on disk — not shared memory, which this reading does not cover.

### 12. The honest empty answer
**Agent ·** `Which queries are slowest on this database right now?` *(opens as Operate)*

On an idle database the slow-query log is empty — and the agent notices when the health reading's
slow-query *count* disagrees with the log returning zero rows, and **reports the discrepancy**
instead of picking whichever number makes a better answer. Reproduced exactly on 2026-08-17. Do not
promise a particular count out loud: the number the health reading claims varies run to run, and the
behaviour is the point, not the figure. If it happens during your demo, stop and read it out.

### 12b. The same question, against Redis
**Agent ·** on a Redis connection: `How is this Redis instance doing? Memory, clients, and what keys are stored.` *(opens as Operate)*

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
**Agent ·** paste a real query, e.g.
`This is slow: SELECT c.first_name, c.last_name, SUM(p.amount) FROM customer c JOIN payment p ON c.customer_id = p.customer_id WHERE p.amount > 5 GROUP BY c.customer_id, c.first_name, c.last_name. How would you make it faster?` *(opens as Optimize)*

Two things land. **Plans compared** — with real PostgreSQL costs, e.g. *"a full scan (599 rows, cost
348.07) to a full scan (599 rows, cost 348.07)"* — and **Index recommended**, with the `CREATE INDEX`
statement and an Apply to editor button.

Read the caveat aloud: *"Estimates only: these plans were described, not executed. EXPLAIN ANALYZE is
policy-denied because it would run the statement."* The agent will not run your slow query to find
out how slow it is.

**Get to the verdict before your audience does.** Every Optimize run in the 2026-08-17 drive ended
*"Run did not answer — Every result the report cited came back empty, so the answer rests on
nothing"*, including this one, which produced plans, costs and a correct `CREATE INDEX`. The verdict
is wrong, not the answer: a plan arrives in a single column and the artifact that records it counts
zero rows, so the emptiness rule fires on evidence that was never going to have rows (backlog
**B45**). Say it before you scroll to it. A demo that lets the room find a contradiction on its own
loses more than the contradiction costs.

### 14. It never applies anything
Point at the recommendation and note that nothing created the index. Every statement the model writes
is offered, never applied. The run has no way to change your database at all.

---

## Act 5 — "it can drive the editor, within limits" (4 minutes)

This is the part that gets the room's attention, and the part to demo carefully, because what makes
it defensible is the gate.

### 15. The consent step that names its bounds
Type any Act 2 objective and press **Start**. The run does not open. Classification returns, and a
panel appears asking for one decision before anything is opened — **read all of it out loud**, it is
the best-written thing in the product:

> This run will open as Analyze on DVD Rental (Postgres), which answers with a result.
>
> `[ ]` **Also run the final answer in my editor**
>
> The run always produces its answer on its own read-only path, bounded to 200 rows and 10 seconds.
> Tick this and it will also put that statement in your editor and run it there — on the connection
> the run was opened on, at the editor's 500-row limit and with no time limit. It is the same
> database-enforced read-only session either way, so writes and DDL are refused by the engine rather
> than by reading the statement. Statements whose plan reads as expensive, or which the run measured
> as slow, are put in the editor without being run.
>
> This is decided by the request that opens the run and stays what it was: a later request cannot
> widen a run the server already holds.
>
> [Open] [Cancel]

Four things about it are the demo, not the copy:

- It is raised **after** Start, once the workflow is known, so it names the workflow and the
  connection this run is actually opening on — not whatever the shell happens to be showing.
- It **resets to unticked for every run.** There is no setting to leave switched on by accident.
- It states what is given up (the time limit) and what is kept (the row limit), and that writes and
  DDL are refused **by the engine rather than by reading the statement**.
- On a SQLite connection one more sentence appears, because a long read there blocks other writers.
  It is absent on PostgreSQL. Open **Sample (Employees)** and start the same objective to show the
  panel changing with the engine.

And say the boundary: **Analyze in agent mode raises this and nothing else does.** The other four
workflows have no answer to hand over, so they are not asked, and plan mode never touches your
editor at all.

### 16. Gate open: the answer runs
**Agent ·** `What did customer 5 pay in total, and how many payments did they make?` *(opens as Analyze)* — tick the box on the consent step, press Open.

Three conditions all hold — the run executed that exact statement itself, the plan reads as cheap,
and the measured time is under the threshold — so the statement runs in the editor and the rows
appear: 134.65 across 35 payments. Verified by hand.

The replay does not go through the ordinary editor route. It goes to a run-scoped endpoint that takes
**no SQL at all**: the statement comes off that run's own ledger, and it executes inside the
database's own read-only session.

### 17. Gate closed: it says why
**Agent ·** `What is the total revenue per film category? Show it as a chart.` *(opens as Analyze)* — tick the box again.

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
**Plan ·** `How would you assess this database before a production release?` *(opens as Assess, not Investigate)*

Switch the mode to **Plan** and type the objective. The reading opens it as **Assess** — which is a
better reading of the question than the one this script used to prescribe, and worth saying so.

What to say while it runs is the property the mode is sold on: **a plan run executes no statement of
yours, writes nothing, and hands every statement it drafts to you to run yourself.** The reading it
does take is a catalog read — the same one the sidebar takes on every connect — through the same
read-only, audited, budgeted path an Agent run's `inspect_schema` uses, taken server-side before the
model's first turn. The model itself is handed no tools.

Then look at the two things on screen that make the claim checkable:

- **The meter reads `0 / 45` statements and `0.0 / 135.0 s` of database time** at the end. Not
  "small". Zero. Those are the Assess ceilings, and the run spent none of them.
- **The closing card says the same thing in words**: *"The run executed nothing."*

The deliverable is **one runnable statement**, in a `Closing statement` card with **Copy** and
**Copy all**, followed by a `Statement drafted` card carrying the guard's verdict:

> The statement guard read this as a bounded read and had no objection, which is not a promise about
> what it does. Every table it names is in the inventory this run read — which records what exists,
> not what your role is permitted to read.

That second sentence is the one to read out. It is the product declining to launder a schema
inventory into a permission claim.

The grounding is real: against dvdrental the plan names `public.film` and `public.inventory` by
name. It has never seen a row — the grounding reads the catalog and the engine's own estimates,
never a value out of a column.

*Bounds, worth stating before someone finds them:* grounding serves **PostgreSQL and SQLite only**,
because those are the dialects the catalog composer serves — **and only the four schema workflows.**
A plan-mode Operate run is ungrounded on every engine by design, PostgreSQL included, because an
operations objective is not about the schema. On any other engine, or in Operate, a plan run is
ungrounded and its rules steer it to say so rather than to invent tables. Case 19 is exactly that,
and it is why the two cases sit next to each other.

### 19. When the reading is wrong, and what you do about it
**Plan ·** `What would you check first if this database were slow in production?` *(opens as Operate — the script wanted Optimize)*

This is the misread, and it is a good case *because* it is one. "Slow in production" reads as an
operations question, so the run opens as plan-mode Operate — which is ungrounded and prose-only by
design. You get the readings it would take, in order, and what each would settle. You do not get a
statement, and on a PostgreSQL connection the run says out loud that no schema was read, which looks
like a defect and is a design decision nothing on screen explains (backlog B46).

So correct it on stage, which is the whole point of the case. Either press **change → Optimize** on
the banner, or open **Advanced** and name Optimize before you Start. Named as Optimize, this
objective takes the deliberate-refusal path rather than inventing something:

> This run drafted no statement… The objective is a conceptual question rather than a specific data
> retrieval… Would you like a specific slow query analyzed using EXPLAIN against one of the core
> tables like payment, rental, or film?

Read that as the feature it is. Asked a conceptual question, a mode whose contract is *one runnable
statement* refuses to produce one and asks the question that would let it. The old script claimed
this case came back as "a plan about access paths"; it does not, on either arm, and the refusal is
the better artifact.

### 19b. A plan you can actually take with you
**Plan · Optimize** *(named under Advanced — see below)* · `Which indexes would you check first, and what statement would show me their usage?`

Under **Automatic** this classifies to Operate like case 19, and there is nothing to take with you:
zero **Apply to editor** buttons, prose only, and the run opening with *"Because no schema was read,
we cannot name specific tables or indexes upfront"* — on dvdrental. Name **Optimize** under Advanced
and drive it again. That run is the case:

**One** grounded statement — a `pg_stat_user_indexes` read ordered by `idx_scan`, exactly the
statement the objective deserves — arriving as a code block with three controls. **Apply to editor**
puts it in the editor unrun, **Copy** puts it on the clipboard, and **Copy all** at the foot of the
plan takes the whole thing as the markdown the model wrote, the version that pastes into a ticket
with its headings intact. Click Apply and it lands with its indentation intact, ready to run. It
cites real index names off this database.

Then read the mark, because it is the subtle part:

> 1 name(s) it uses are not in the inventory this run read, so it may not run as written —
> `pg_stat_user_indexes`

**That marking came from the identifier check, not from the guard.** The guard read the statement as
a bounded read and had no objection; the identifier check separately noticed that a catalog view is
not in the schema inventory the run captured, and said so. Two different mechanisms, two different
questions — *is this a read?* and *does this run know this name exists?* — and the product answers
both rather than collapsing them. Keeping them apart is what lets the statement be offered at all
instead of blocked.

Worth saying out loud if a DBA in the room asks how a toolless mode produced a statement: the model
had no tools and the run executed nothing of yours. Applying is your click, in your editor, on your
connection.

*Where the editor button is withheld:* a block the model tagged as something other than a query
language — `bash`, `json` — is copyable and is not offered to the SQL editor, because the model said
what it is.

### 20. Stop means stop — and stop means unanswered
Start a long run — **Agent ·** `Profile every table at pattern depth and grade completeness, uniqueness, consistency and validity for each one` *(opens as Assess)* — and press **Stop**.

**Press it within a few seconds.** This run is now fast enough that a 35-second wait let it finish
all 22 tables, and a demo of Stop that ends in a completed run demonstrates nothing.

What you get is a stop, not a salvage. The rail says *"Stop requested — the run takes no further
database step; work already in hand, such as a report, still finishes"*, the run ends **cancelled**,
and the ending reads:

> **Run did not answer** — The run was stopped before it could finish.

No report was composed and no partial answer appeared. Say that plainly rather than promising a
partial answer with its evidence: the guarantee this case demonstrates is that a stop takes effect
on the *database*, immediately and without negotiation, and that the run's verdict tells the truth
about having answered nothing. A run that claimed a partial answer it did not have would be the
worse product.

### 21. It will not invent an answer
**Agent ·** `What is our customer churn rate this quarter?` against the employees database *(opens as Analyze)*

It does not produce a churn number. It reports that the schema holds employee records rather than
customer records, and says the question is not answerable here — and it now gets there in **5** tool
invocations rather than the long walk it used to take.

### 22. It refuses a superuser — but you cannot show it here
This case is in the script because the behaviour is real and worth describing: pointed at PostgreSQL
as `postgres`, a run refuses, because a read-only transaction does not stop `COPY TO PROGRAM` or
server-side file reads, so the profile requires a least-privilege role rather than trusting the
transaction.

**It could not be performed in the 2026-08-17 drive, and it cannot be performed on this setup.** The
seeded dvdrental connection already uses the least-privilege role, and the only way to reach a
superuser from the UI is to create a connection there — which agent mode refuses first, for the
unrelated and correct reason that the server cannot rebuild it. The two refusals cannot both be
demonstrated on one connection. Demonstrating this one needs a **seed entry that points at a
superuser**, added on purpose. Add it before the demo if the room is a security audience; otherwise
describe it and move on rather than improvising.

*(The message a user sees today names the engine rather than the role; the server log carries the
exact reason. Recorded in `docs/BACKLOG.md`.)*

### 23. Every claim is checkable
Open any report and look at a claim. Each one cites something **this run** produced, and the citation
is shown rather than described: a result it read, with the correlation id, the row count and the
statement behind it — or the schema inventory it captured, named by its `ctx_…` fingerprint, for a
claim that rests on structure rather than on rows (case 1 is full of those).

A claim citing evidence the run never produced is refused when the report is composed. The model
cannot assert something and leave you to trust it.

And say the limit of that guarantee, because case 1 is standing right there: a citation proves the
claim rests on something the run *read*. It does not prove the read was complete. An empty relations
read is honestly cited and still supports a false negative (B44).

---

## What to say when someone asks the hard question

**"Can it damage my database?"** Writes and DDL are refused twice over, and the second refusal is the
one that matters. Before a provider is even acquired, the statement is inspected and anything that is
not a single read is rejected. Then the read runs inside a **database-enforced** read-only session
with a statement timeout, a row cap and a byte cap, refusing rather than truncating.

Lead with the second one when you answer. A parser can be fooled — a `SELECT` may call a function
that writes, and no amount of reading the text reveals that — which is exactly why the boundary is
the engine's own read-only transaction rather than the guard in front of it. The editor replay in
cases 15-17 runs in that same session; what it gives up is the timeout, and the consent step says so.

**"How does it know which workflow I want?"** A server-side reading of your objective, before the run
opens, recorded on the run itself: the rail says "read from your objective" because the run's own
record says the workflow was inferred and how the reading went, not because the browser remembers
sending it. It agreed with this script on 17 of 21 objectives. When it is wrong, name the workflow
under Advanced — the reading is then skipped entirely and no banner appears — or press **change** on
an open run, which stops it at its next checkpoint and opens a new one, leaving the first in the
ledger with everything it recorded.

**"What if the model hallucinates?"** It can, and the product is built on the assumption that it
will. A claim must cite something the run read or it is refused. A chart must name columns that exist
in that result or it is refused. An answer must be a result of a query the run actually ran — a plan
or a profile cannot be presented as one. The verdict at the end of a run is computed from the run's
ledger, not from the model's opinion of its own work. The counter-example is honest and worth
volunteering: a citation binds a claim to what the run read, and cannot tell it that what it read was
incomplete (B44).

**"Which databases?"** See the table at the top. The short version: Operate works everywhere and was
driven live on six engines including Redis, which has no SQL at all; the four SQL workflows need
PostgreSQL or SQLite today; plan mode has no engine limit and is grounded on those same two — for
every workflow except Operate.

**"What does it cost per question?"** Each workflow has a frozen ceiling on model turns, statements,
wall clock and database time, and the rail shows the meter live. The figures are the starting point
for a measurement that has not been taken yet — treat them as bounds, not as a price list.

---

## Not yet — and what each one is waiting on

Say these plainly if asked. Everything here is recorded in `docs/BACKLOG.md` with the design that
would close it, so "not yet" means deferred with a reason, not overlooked.

| Not yet | What happens today | Waiting on |
| --- | --- | --- |
| **Foreign keys under a least-privilege role** | The relations read comes back empty and the run reports that no foreign keys exist — a false negative it cannot tell apart from a true one | B44 — reading `pg_constraint` instead of the `information_schema` views, and declining to assert the negative from an empty read |
| **A verdict that fits an optimization run** | Every Optimize run ends `unanswered`, however good its plans and index recommendation were | B45 — a plan artifact is not an empty result, the same exemption the Operate template already has |
| **Saying why a plan run is ungrounded** | A plan-mode Operate run on PostgreSQL announces that no schema was read, and nothing distinguishes that from an engine that cannot be read | B46 — one sentence that names the workflow as the reason |
| **Follow-up questions** | Each run starts fresh, and neither the surface nor the model says so — ask "and how many of those?" and you get a confident answer to a different question | B36 — either carrying the previous run's objective and report into the next as fenced context, or run history |
| **Causal questions** — "why are sales down?" | Answered from the schema alone, which cannot know which decomposition of a metric is the business one | A per-connection business note, held server-side; sketched in `docs/AGENT_ANALYST_DESIGN.md` §5 |
| **"This database cannot answer that"** | It does say so, but has to run a throwaway query to be scored as having answered — case 21 spends 5 tool invocations to report that an employees database holds no customer data | B39 — a second arm on the verdict, so a schema-only conclusion counts |
| **Agent mode on MySQL, Oracle, MongoDB, Redis…** | Only Operate. The other four workflows refuse, correctly and clearly | A database-native read-only statement path per engine — the same `queryReadOnly` PostgreSQL and SQLite implement |
| **A run you can watch from your own stack** | Everything is in the run's ledger and on the rail; nothing is exported | B33 — OpenTelemetry spans, designed in #332 and deliberately not built while the event model is still moving |
| **Resuming a run after a restart** | A drive that dies leaves a durable ledger, but nothing picks it up | B9 — a queue and a re-attach path for the stream |
| **A budget you can trust to the minute** | The ceilings are real and enforced; the *numbers* are a starting point nobody has measured | One instrumented long run per workflow |
| **Connections you created in the UI** | Agent mode is offered only where the server can rebuild the connection, and says so on the rail rather than failing later | A server-held credential for user connections — not designed |

Two smaller ones worth knowing before they surprise you on stage:

- **A refused PostgreSQL role reads as a refused engine.** Point the agent at a superuser and the
  message says the engine offers no read-only profile. The engine does; the role is too broad, and
  only the server log says so (case 22).
- **A connection error can arrive as "the reason is in the server log".** An Operate run against a
  locked LibreDB file failed with a perfectly actionable message — *"already open by another process
  (exclusive lock)"* — that the rail did not show.
