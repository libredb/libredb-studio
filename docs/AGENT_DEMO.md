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

### Conversations, driven 2026-08-26

Six runs through a browser against a production build, `gemini-3.5-flash-lite` and the seeded
dvdrental on PostgreSQL 18, read as the least-privilege `libredb_agent` role. Verified against the
run ledgers in `.workflow-data` rather than off the screen.

The shape driven is the one the design is weakest at — a **transformation step in the middle**, whose
own objective is a pronoun and whose report might carry nothing forward:

1. *"count my films by category"* — answered: 16 categories, Sports highest at 74, Music lowest at 51.
2. *"chart those"* — resolved, and re-ran the full `category`/`film_category` aggregate to chart it.
3. *"show the highest rental rate among those"* — **resolved to films.** It read the grouping too: it
   drafted `SELECT c.name AS category, MAX(f.rental_rate) … JOIN film_category …` before settling on
   the simpler `SELECT MAX(rental_rate) FROM film`, and answered 4.99.

**What this drive established, and what it did not.** It establishes that the conversation reached
step 3 and that the referent resolved: the header carried `Step 1: count my films by category`,
`Step 2: chart those`, step 2's answer statement and step 2's claim, and the run answered about films.

It does **not** establish that the spine was load-bearing, and the drive has to be read carefully to
see why. Step 2's report was rich rather than thin — its answer statement names `category` and
`film_category` outright, and its claim reads *"16 distinct film categories, Sports 74, Music 51"*. A
pairwise chain would therefore have handed step 3 that report, which resolves *"those"* to films on
its own. The shape this design exists for — a middle step whose report carries nothing forward — is
the shape this drive did not produce.

So the claim to hold is the narrower one: the transport works, and the conversation is robust to a
thin middle report *by construction* rather than *by measurement*. Driving a genuinely thin middle
step (one that charts without re-reading, or fails) is the measurement still owed.

Recorded as it happened rather than as it flatters, on the other axis too: step 3 resolved the
referent and read the category framing — it drafted the per-category maximum — and then presented the
ungrouped one. Which of two correct readings a model presents is a question about the model, not
about the transport.

**Control arm**, driven with that three-step conversation still attached: *"how many customers are
there in each country?"* — answered about customers and countries in one statement, with no film or
category framing anywhere in it and no refusal for a referent it did not need. Both confusion modes
the design worried about — contamination, and refusing an answerable question — were absent here.

**The two controls were exercised too.** Switching connection between runs produced the rail's own
sentence (*"Connection changed, so this question started a new conversation"*) rather than the
server's decline; and **new conversation** left the next run's header with no `thread` key at all —
the run wrote nothing, which is the same bytes a run written before conversations existed carries.

## What works on which engine

Driven live on 2026-08-15 and 2026-08-17, one engine at a time, against real servers. **Verified**
means a run of that kind was started on that engine and its outcome read off the screen — nothing in
the DRIVEN columns is inferred from the code.

The third column was driven on 2026-08-17 against the #414 build, **every engine, one at a time**, each
on a server seeded for it. What each cell records is the inventory that reached the run and the thing
the run then wrote, because those are the two facts that decide whether grounding is worth anything.
The last column is unchanged and was NOT re-driven: agent mode still needs a database-native read-only
statement path, which only two engines have.

| Engine | Plan mode, as driven 2026-08-15/17 | Plan grounding after #414, driven 2026-08-17 | Operate | Investigate · Analyze · Optimize · Assess |
| --- | --- | --- | --- | --- |
| **PostgreSQL** 18 | Verified, grounded | Unchanged, composed catalog read: 22 tables, correct three-way join | Verified | Verified |
| **SQLite** | Verified, grounded | Unchanged, composed catalog read: 8 tables, correct join | Verified | Verified |
| **MySQL** 9 | Expected to work | **Verified grounded**, provider inventory: 3 tables, correct join | Expected to work | Refused |
| **Oracle** XE 21 | Expected to work | **Verified grounded**, provider inventory: 3 tables, correct join | Expected to work | Refused |
| **SQL Server** 2022 | Verified, ungrounded | **Verified grounded**, provider inventory: 3 tables, correct `TOP 10` T-SQL | Verified | Refused |
| **MongoDB** 8 | Verified, ungrounded | **Verified grounded**, provider inventory: 5 collections then 6 with a view; `$group`/`$lookup` aggregation | Verified | Refused, verified |
| **ClickHouse** 26 | Verified, ungrounded | **Verified grounded**, provider inventory: 5 tables, correct join | Verified | Refused |
| **Couchbase** 8 | Expected to work | **Verified grounded**, provider inventory: 3 collections with their indexes, correct SQL++ | Expected to work | Refused |
| **Druid** 37 | Expected to work | **Verified grounded**, provider inventory: 2 datasources, correct Druid SQL | Expected to work | Refused |
| **Redis** 7 | Verified, ungrounded | **Verified grounded**, provider inventory: 17 real key prefixes — read the Redis note below before promising this one | Verified | Refused |
| **LibreDB** (embedded) | Verified, ungrounded | **Verified NOT grounded** — the file lock, see below | Not established | Refused, verified |

**Ten of eleven, and the eleventh is not a Pending.** LibreDB is the one engine where the provider
cannot be asked: `lib.open()` takes an exclusive file lock, and the grounding read builds a second
provider on a path the connection's ordinary provider already holds — so it fails from the moment
anyone browses that connection in the sidebar. That is measured, not expected, and it is why the cell
says NOT grounded rather than Pending. The run then does the right thing with it: it says it was given
no inventory and refuses to invent one.

**What "Verified grounded" is claiming, and what it is not.** It says an inventory of that database's
real objects reached the run and the run wrote something in that engine's own language that the editor
accepts. It does NOT say the draft is good, and on one engine it demonstrably is not — see Redis. It
says nothing at all about agent mode, which still ends `engine-unsupported` everywhere but PostgreSQL
and SQLite; that is pinned by a test rather than by this table, because a run that fails at its first
read is not a thing worth driving eleven times.

**Two runs that refused, and both refusals were right.** A Couchbase run asked "how many documents of
each type in this bucket" named the three real collections back and asked which one was meant. A Druid
run asked about countries answered that the inventory has no column of that kind — the column is
`region`. Neither invented an object, and re-driven against what the data actually holds both drafted
a working query. A grounded run that refuses a bad question is the mode working, not the mode failing.
**The three ways the expectation could have been wrong, and what the drive found.** Each was a way a
real server could contradict a passing test, which is why the drive was worth doing at all. *Is a
provider inventory USEFUL to a model or merely present?* Useful — eight engines drafted a working
statement against their own real objects. *Do MongoDB's sampled field names match what a person would
name?* Yes: `customerId`, `name` and `email` were inferred from documents and the aggregation joined on
them. *Is the drafted statement one the editor actually runs?* Yes on every engine driven, including
the two that speak no SQL. What #414 does **not** change: the four SQL workflows in the last column
still need `provider.queryReadOnly`, so their refusals stand as written.

**Read the table this way.** Plan mode opens on every engine and runs no statement of yours on any of
them. Since #414 it is also *grounded* on ten of the eleven — it is handed that database's real objects
before its first turn and asked to write against them — where before it was grounded on PostgreSQL and
SQLite alone and refused everywhere else. The refusal did not go away and should not: it is what an
ungrounded run still does, and LibreDB still is one.

**"Verified" in the driven Plan column does not mean "useful for the same things", and on an ungrounded
engine the workflow decides which.** Driven on MongoDB on 2026-08-17: *"Which customers placed the
most orders? Write me the query"* opened as Analyze and came back with **no statement at all** — the
`NO STATEMENT:` refusal, in its own words *"This run was given no inventory of this database. What
collection and field names should I use?"*, and zero **Apply to editor** controls. That is the mode
working correctly rather than failing: the collections are right there in the sidebar, but the
sidebar reads them through the provider while grounding read them through a composed catalog
statement, which existed for PostgreSQL and SQLite only. **That observation is what #414 was opened
about, and #414's answer is to have grounding take the sidebar's reading on those engines** — and
re-driven on that build on 2026-08-17, the same objective on the same connection was handed the five
real collections and drafted a `$group`/`$lookup` aggregation over `orders` and `customers` with a
working **Apply to editor**. The refusal quoted above is the BEFORE. The same connection asked *"what would you
check first if this server were slow"* opened as Operate and handed back four applicable blocks —
`db.currentOp(...)`, `db.serverStatus()`, `db.stats()`, `db.system.profile.find(...)`. **So on an
ungrounded engine, Operate is the workflow that still hands you something to run, and the schema
workflows are the ones that correctly refuse.** Do not promise a room that plan mode is a query
generator everywhere; it is a query generator where it is grounded, and an honest refusal where it
is not. That sentence is unchanged by #414 and is the reason it was written this way: what #414 moves
is where the condition holds, not the rule — and it now holds on ten engines rather than two, which is
a demo you can give rather than a caveat you have to make. Operate reads what the engine reports about itself, so it needs no SQL and reaches
everything. The other four workflows write SQL and need a database-native read-only statement path,
which today only PostgreSQL and SQLite provide; everywhere else the run ends with *"The agent cannot
run on this database engine: it offers no read-only execution profile."*

**Grounding was engine-dependent and nothing else**, in every workflow — until #414, after which the
engine decides only HOW a run is grounded and not whether. That much was not true even when this
script was driven: a plan-mode **Operate** run was then ungrounded by design on every engine,
PostgreSQL included, and announced *"Because no schema was read, we cannot name specific tables or
indexes upfront"* on a database it could have read perfectly well — which a room that has just been
told "PostgreSQL and SQLite are grounded" reads as a bug. #411 removed the exception: Operate became
grounded on the same two engines as everything else — and since #414, wherever anything else is
grounded — with a deliberately smaller inventory — table
names and the indexes on each, no columns and no relations — because what an operational reading
needs from the schema is the ability to recognise the identifiers the engine hands back. Cases 19 and
19b were re-driven on 2026-08-17 against that build: the *"no schema was read"* line is gone on
PostgreSQL, both plans name real tables and indexes, and the Operate arm of 19b hands back a runnable
`pg_stat_user_indexes` query with **Apply to editor** on it — which the script had claimed it never
would.

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

**That role now sees foreign keys, and it did not before.** Measured on the seeded dvdrental as
`libredb_agent` (`usesuper = f`): `information_schema.table_constraints` returns **0** FOREIGN KEY
rows, while `pg_constraint WHERE contype = 'f'` holds **18** — PostgreSQL shows a constraint through
the `information_schema` views only to a role that owns the table or holds a privilege on it *other
than* `SELECT`. The relations read went through those views, so under exactly the role prescribed
above the graph was empty and case 1 answered *"There are no declared foreign key constraints between
tables in the database"*, citing a snapshot that genuinely contained nothing. `composePostgresRelations`
(`src/lib/agent/composed-sql.ts`) now reads `pg_constraint`, which asks only for `USAGE` on the schema,
and answers all 18 rows as this role. What is still true and cannot be fixed by any read: an EMPTY
relations read cannot tell "this database declares none" from "this role cannot see the ones it
declares". So the run is no longer allowed to choose — the relations block now states the limit of
what it read and tells the model not to report that the database has no foreign keys. A database that
really declares none is described the same way — as a graph this run cannot vouch for — which is the
price of not stating the negative, and the cheaper of the two errors.

**Run it from a production build** (`bun run build` then `bun run start`). In development React needs
`eval`, which the CSP does not allow, so the login page does not hydrate (#459).

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
which is a good demo and a bad guarantee: the run is now told to treat exactly this kind of join as
inferred from names rather than declared.

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

**One thing changed under this act since it was driven (#411), and it is worth a sentence on stage.**
An Operate run on PostgreSQL or SQLite is now handed a schema inventory before its first turn — the
table names and the indexes on each, and nothing else. It exists so the run can place what the engine
names back at it: `pg_stat_activity` reports a lock on a relation, an index-stats row names an index,
a slow query names the tables it reads, and before this those were strings the model could only echo.
It costs the run nothing — the statement budget was raised to pay for the capture rather than the
readings being squeezed — and on Redis, MongoDB and the rest it simply does not happen, so case 12b
below is unaffected. The run still sends no SQL of its own; the inventory is the server's read, taken
before the model is given a turn.

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

*Bounds, worth stating before someone finds them:* on the build this was driven against, grounding
served **PostgreSQL and SQLite only**, because those are the dialects the catalog composer serves.
That bound is the one #414 removed — a dialect the composer does not serve now reads its schema
through its own provider — and the table at the top of this file records that being driven on
2026-08-17: ten of the eleven engines grounded, LibreDB the exception and for a reason that has
nothing to do with dialects. When
this script was driven there was a second one: Operate was ungrounded on every engine by design, so
grounding depended on the workflow as well. #411 removed it. Re-driven on 2026-08-17, an Operate plan
on PostgreSQL is grounded like the rest — on a reduced inventory of table names and indexes — and
names the real objects its readings are about: `public.rental`, `public.payment`, `public.inventory`,
`idx_title`, `film_fulltext_idx`, with the engine's row estimates quoted beside them and the views
flagged as carrying no statistics. On SQLite it captured 8 tables and concluded there was no index to
be unused. On any engine outside those two a plan run of any workflow was then ungrounded and its rules steered
it to say so rather than to invent tables — on Redis the Operate plan said it could name no object and
proposed `CLIENT LIST`, `INFO` and `SLOWLOG GET`. After #414 the Redis plan IS given its key-prefix
inventory and does name real prefixes — driven, not expected — and the readings it proposes did not
change, since those were already bound to the engine rather than to the schema. What being grounded
did not settle is what it drafts with the inventory: read the note below before showing it.

*And one thing to watch for on Redis specifically — the one engine where the new build HAS been
driven.* The first grounded Redis drives read 17 real key prefixes and then drafted `KEYS user:*` and
`ZCARD user:*` — a grouping named as though it were a key. The blocks a run reads now carry the
provider's own noun ("17 key pattern(s)", never "17 table(s)"), and a Redis or LibreDB plan is told in
one sentence that its rows are groupings Studio derived from a bounded scan and that a statement must
name a whole key or scan by pattern instead. What that sentence does not do is name or forbid a
command, so a plan choosing a different command is not a regression; a plan naming `user:*` as a key
is.

Re-driven on 2026-08-17 against the fixed build, on the same seeded keyspace, with mixed results that
are worth knowing before you show this:

- *"Which key prefix holds the most keys, and how would I list them?"* → **NO STATEMENT**, and the
  right one: the inventory carries no key counts, so the run says the question cannot be answered from
  what it was given. The same objective used to produce `KEYS user:*` as though it were an answer.
  This is the demo to show.
- *"How many users are stored, and how do I look one up?"* → drafted **`KEYS user:*`**, and explained
  the lookup as `HGETALL user:<id>` — a whole key, which is the new rule working. `KEYS` is not: it is
  the blocking O(N) command Studio's own provider refuses to use, and the product is offering it with
  an Apply-to-editor button. Nothing runs unless the user applies and runs it, and whether the
  planning rules should speak about operational cost at all was **ruled on and declined** on
  2026-08-22 (#459): a rule naming one command is engine trivia that goes stale, teaches nothing about
  the next command, and buys nothing plan mode does not already have - plan mode holds no tools, so
  reaching the hazard takes the user applying the draft and running it on their own connection. The
  reasoning is recorded at `planningDerivedGroupingsRule` in `src/lib/agent/investigation.ts` so the
  question is not reopened. Show this one only alongside that ruling, and do not claim the Redis
  drafts are safe to run unread.

*One thing to watch for on stage, because it was there when this script was driven and is not now:*
a plan-mode Operate run used to name the **wrong engine's** readings with complete confidence — a
plan on a SQLite connection offering `pg_stat_user_indexes` and `pg_total_relation_size`, a plan on
a Redis connection offering wait event statistics and a blocking chain dependency tree. Its rules now
name the engine and bind the readings to it, on the grounded and the ungrounded path alike, so a plan
that is unsure says what it would want to establish instead of naming a view that does not exist
there. Nothing changed in Agent mode: an Operate agent run names a reading *kind* and the server
calls the engine's own interface, so it never had this to get wrong.

### 19. When the reading is wrong, and what you do about it
**Plan ·** `What would you check first if this database were slow in production?` *(opens as Operate — the script wanted Optimize)*

This is the misread, and it is a good case *because* it is one. "Slow in production" reads as an
operations question, so the run opens as plan-mode Operate, whose deliverable is prose: the readings
it would take, in order, and what each would settle.

Re-driven on 2026-08-17, and both of the hedges this case used to carry are settled. On the
PostgreSQL connection the plan is grounded and names real objects — `public.rental`, `public.payment`
and `public.inventory`, the indexes `idx_title`, `film_fulltext_idx` and
`idx_unq_rental_rental_date_inventory_id_customer_id` — and it quotes the engine's own row estimates
beside them (payment ≈ 14 596, rental ≈ 16 044, film_actor ≈ 5 462) while separately flagging the
**views**, which carry no statistics at all. The *"no schema was read"* line it used to open with is
gone. On a SQLite connection the same plan captured 8 tables, named them, and concluded correctly
that there is no index there to be unused. On Redis it says plainly that it can name no object and
proposes `CLIENT LIST`, `INFO` and `SLOWLOG GET`.

What stays is the point of the case: an Operate plan answers the operations question it was opened
for, and that was not the question the room wanted answered.

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

Under **Automatic** this classifies to Operate like case 19 — and the Operate arm is now worth driving
on stage rather than skipping. Re-driven on dvdrental: the run opens as **Operate**, is grounded
(*"Schema captured, 22 tables"*), and its prose names real indexes off this database — `actor_pkey`,
`address_pkey`, `film_pkey`, `idx_actor_last_name`, `idx_fk_city_id`. It also closes with a fenced
statement carrying **Apply to editor**, two of them in that drive:

```sql
SELECT schemaname, relname AS table_name, indexrelname AS index_name,
       idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes ORDER BY idx_scan ASC;
```

This script said until 2026-08-17 that the Operate arm left you with *"nothing to take with you: zero
Apply to editor buttons, prose only"*. That was false when it was written down and is false on
screen, and the code has been corrected to match rather than the other way round: an Operate plan's
deliverable is prose, but where a reading it would take is itself a statement your engine can run —
and on PostgreSQL a monitoring reading usually is one — writing it out is welcome.

**Do not promise the room that non-SQL engines hand back nothing.** The same objective on Redis was
driven on 2026-08-17 and the plan opened by saying plainly that it can name no key, then wrote
`INFO memory`, `CLIENT LIST`, `SLOWLOG GET 10` and `MEMORY USAGE <key>` into a block tagged `redis`
— which that connection's editor runs, so **Apply to editor** appeared there too. What is engine-
dependent is whether a reading can be written down at all, not whether the engine speaks SQL. Where
it cannot be, the plan says the reading in that engine's own terms and produces no block, and that
is a complete answer rather than a shortfall.

**The case still works, and the contrast is now the sharper one.** Name **Optimize** under Advanced
and drive the same objective again:

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

**That mark is the whole difference between the two arms, and it is the line to say out loud.** Both
runs hand you a statement now. Only the named-Optimize one hands you a statement the run was ASKED
for: it arrives on its own `Statement drafted` card, with the guard's read-only verdict and the
identifier check attached, recorded on the run's ledger as its deliverable. The Operate arm's block
was *welcomed*, not asked for — nothing checked it, nothing marked it, and the ledger records no
statement for that run at all. Naming the workflow is therefore still worth doing for this objective:
the difference is no longer something against nothing, it is a checked deliverable against an
unchecked convenience.

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
read is honestly cited and would support a false negative, which is why the relations block refuses to
state one.

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
incomplete — so where the incompleteness is known in advance, as with an empty relations read, the
grounding says so in words.

**"Which databases?"** See the table at the top, and its #414 note. The short version: Operate works
everywhere and was driven live on six engines including Redis, which has no SQL at all; the four SQL
workflows need PostgreSQL or SQLite, and that has not changed; plan mode has no engine limit and since
#414 no grounding limit either — it composes catalog statements on those two and asks every other
engine's own provider to describe itself, in every workflow, Operate included since #411 on a reduced
inventory of table and index names.

**"What does it cost per question?"** Each workflow has a frozen ceiling on model turns, statements,
wall clock and database time, and the rail shows the meter live. The figures are the starting point
for a measurement that has not been taken yet — treat them as bounds, not as a price list.

---

## Not yet — and what each one is waiting on

Say these plainly if asked. Everything here is recorded in `docs/BACKLOG.md` with the design that
would close it, so "not yet" means deferred with a reason, not overlooked.

| Not yet | What happens today | Waiting on |
| --- | --- | --- |
| **A verdict that fits an optimization run** | Every Optimize run ends `unanswered`, however good its plans and index recommendation were | B45 — a plan artifact is not an empty result, the same exemption the Operate template already has |
| **Returning to an earlier conversation** | A follow-up asked on the same connection continues the previous run's conversation, and the rail names the steps it is continuing — but only for the conversation you are in. Yesterday's conversations cannot be listed or reopened, and a page reload starts a new one without saying so | B67 — run history across conversations needs store enumeration, a list route and a retention rule, none of which exist. B69 for the reload |
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
