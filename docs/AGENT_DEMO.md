# Agent demo script

Twenty-three cases, ordered easy to hard, for showing LibreDB Studio's agent to someone who has
not seen it. Every case here was **driven live** against a real model and a real database before it
was written down, and each one records what actually came back — including the ones that refuse.
Nothing in this file is aspirational.

The refusals are not filler. Half of what makes an agent worth putting near a production database is
what it declines to do, and a demo that only shows the happy path sells the wrong product.

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

The plan reads as a full table read, so the gate declines. The statement is placed in the editor
**unrun**, with the reason in plain words — and the chart is still drawn, because the run had already
read the answer on its own bounded path. Nothing on screen claims an execution that did not happen.

This is the case to dwell on. A demo that only shows case 16 is showing a party trick; showing 16 and
17 together is showing a control.

---

## Act 6 — "it is safe to point at production" (4 minutes)

### 18. Plan mode: it never touches the database
Switch to **Plan** and ask anything: `How would you assess this database before a production release?`

A structured plan comes back — phases, what to inspect, what each step would establish — rendered as
headings and bullets. Zero statements were sent. This is the mode to hand someone who wants the
reasoning without the risk.

*Known limitation, and say it rather than let someone find it:* a plan run reasons from the objective
alone, so today it gives a sound general method rather than a plan naming your tables. The written
plan is honest about what it did not inspect.

### 19. Both axes are independent
**Plan · Optimize ·** `What would you check first if this database were slow in production?`

Still a plan, still zero statements — but framed by the optimization workflow, so it is about access
paths rather than generic health. Plan/Agent and the workflow are two separate choices.

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
Open any report and look at a claim. Each one cites an artifact this run actually read, with its
correlation id and row count, and the statement behind it. A claim citing evidence the run never
produced is refused when the report is composed — the model cannot assert something and leave you to
trust it.

---

## What to say when someone asks the hard question

**"Can it damage my database?"** Writes and DDL are refused by the engine, not by parsing the SQL.
The run's own path is a database-enforced read-only session with a statement timeout, a row cap and a
byte cap, and it refuses rather than truncating. The editor replay in cases 15-17 uses the same
read-only session; what it gives up is the timeout, and the checkbox says so.

**"What if the model hallucinates?"** It can, and the product is built on the assumption that it
will. A claim must cite something the run read or it is refused. A chart must name columns that exist
in that result or it is refused. An answer must be a result of a query the run actually ran — a plan
or a profile cannot be presented as one. The verdict at the end of a run is computed from the run's
ledger, not from the model's opinion of its own work.

**"Which databases?"** Analyze, Optimize, Assess and Investigate need a database-native read-only
path, which today means **PostgreSQL and SQLite**. Operate reads the engine's own statistics instead
and works on every provider. Plan mode has no limit at all.

**"What does it cost per question?"** Each workflow has a frozen ceiling on model turns, statements,
wall clock and database time, and the rail shows the meter live. The figures are the starting point
for a measurement that has not been taken yet — treat them as bounds, not as a price list.

---

## Cases that are not ready to demo

Say these plainly if asked; do not build a demo around them.

- **Follow-up questions.** Each run starts fresh. Asking "and how many of those?" after another
  question gets a confident answer to a different question, because nothing carries the referent.
  (`docs/BACKLOG.md` B36.)
- **A plan that names your tables.** See case 18.
- **Causal questions** — "why are sales down?" — need business context the schema does not carry.
