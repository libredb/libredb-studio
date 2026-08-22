# The agent, for the person using it

This is the page for someone who has the agent rail open and wants to know what the words in it
mean. It describes **what the application says**, in the application's own vocabulary, and it does
not invent a second one: every label, sentence and number quoted here is rendered by
`src/components/agent/AgentRail.tsx` or composed by `src/components/agent/timeline.ts`, and the
citation is given so you can check any of it.

It is a **separate page from [`docs/AGENT.md`](./AGENT.md) on purpose.** That document is the
behaviour reference — durability, the ledger, the policy, the module map, the deferrals — and it is
written for someone changing the runtime. Folding a user guide into it would bury the four questions
a user actually has (what is a run, what are the three workflows, what does *answered* mean, what
are the meter's numbers) inside eight hundred lines about resume semantics. Where a sentence here
needs the mechanism behind it, it links there instead of restating it.

- **What leaves your machine, and when:** [`docs/AGENT_DATA_FLOW.md`](./AGENT_DATA_FLOW.md).
- **How the runtime behaves and what it defers:** [`docs/AGENT.md`](./AGENT.md).

---

## Contents

- [Where the agent is](#where-the-agent-is)
- [What a run is](#what-a-run-is)
- [The four workflows](#the-four-workflows)
- [What you see while a run goes](#what-you-see-while-a-run-goes)
- [What "answered" means](#what-answered-means)
- [The budget meter's numbers](#the-budget-meters-numbers)
- [When the model is refused](#when-the-model-is-refused)
- [Running the agent on a local model (Ollama)](#running-the-agent-on-a-local-model-ollama)
- [What the agent does not do](#what-the-agent-does-not-do)

---

## Where the agent is

The rail is part of the **standalone application only** — the embedded `@libredb/studio` package
renders no agent surface at all (`src/workspace/StudioWorkspace.tsx`, and
`tests/unit/agent-package-boundary.test.ts` pins it). Above the `md` breakpoint it is a resizable
panel beside the editor; below it, the same rail opens as a sheet
(`AgentRail.tsx:2241-2264` chooses the presentation, and it is one component instance either way, so
an objective you are typing survives a window resize).

Three controls elsewhere in the shell open it **carrying the statement in your editor**:

| Control | Where | What it does |
| --- | --- | --- |
| "Ask the agent about this query" | Command palette (`src/components/CommandPalette.tsx:134-137`) | Fills the objective with the editor's statement, and names the *Investigate* workflow for it |
| "Ask about this query" | Mobile header (`src/components/studio/StudioMobileHeader.tsx:235-245`) | The same, and opens the sheet |
| "Agent" | Mobile nav (`src/components/Studio.tsx:857-863`) | Opens the rail and asks nothing |

**The two that name a workflow name it under Advanced, and open that panel to show you.** The
workflow axis is **Automatic** by default (below), so a shortcut that quietly set it would be
making a choice you could not see. It sets *Investigate* explicitly and unfolds the disclosure, so
the run it starts is one you named — no classification happens for it, and one click puts the axis
back to Automatic (`Studio.tsx:276-283`, applied by the rail at `AgentRail.tsx:776-814`).

**None of them starts a run.** The shortcut fills the box; pressing **Start**
is yours (`src/components/agent/use-agent-prefill.ts`, and the rail's own effect at
`AgentRail.tsx:776-814`). If you were already typing an objective, the shortcut does not overwrite
it — it offers the new one on a line reading `Suggested: …` with a **Replace** control beside it
(`AgentRail.tsx:1511-1528`). The statement is passed as you wrote it, minus surrounding whitespace;
nothing is composed around it on your behalf (`Studio.tsx:276-283`).

**If the rail is not there, the server is telling you something.** Visibility is derived rather than
flagged: the browser asks `GET /api/agent/config` once per mount
(`src/hooks/use-agent-capability.ts`), and the rail renders only for `{"enabled": true}`. The same
answer carries a `reason` naming which condition failed — no model configured, an unwritable ledger,
an operator off-switch — so `curl` on that route is the diagnosis. The conditions and the reason
codes are in [`docs/AGENT.md`](./AGENT.md#turning-it-on).

---

## What a run is

A run is **one objective, asked once, against one connection**, recorded as an append-only ledger.
There are three things it is decided by, and you only have to answer two of them: the mode is a
control in the rail's header, the objective is the box, and the **workflow is read off your
objective unless you say otherwise**.

**1. The mode — how the run executes** (`AgentRail.tsx:1464-1487`, labels at `AgentRail.tsx:149-152`):

| Button | What it means |
| --- | --- |
| **Plan** | The model writes **one statement** that answers your objective, for you to run yourself — in your engine's own language, so a MongoDB connection gets an aggregation rather than a SELECT. It has **no tools**: it runs no statement of yours, writes nothing, and applies nothing. The server reads your schema for it first, on every engine, so the statement names your real tables — see [What a Plan run knows about your database](#what-a-plan-run-knows-about-your-database). This is what a run opens in. |
| **Agent** | The model is given the read-only tools and investigates: it drafts statements, reads results, and finishes by composing a report whose claims cite what it read. |

**2. The workflow — what the run is for**, and it is **Automatic** unless you say otherwise. Under
**Advanced** (`AgentRail.tsx:1544-1601`, labels at `AgentRail.tsx:163-169`) the five are all there —
**Investigate**, **Optimize**, **Assess**, **Operate**, **Analyze** — offered in both modes, because
"how would you make this faster?" is an ordinary thing to ask a plan for.

**Automatic is what the rail opens on, and it means the server reads your objective.** Pressing
Start posts the objective to `POST /api/agent/classify`, which asks the model to name one of the
five; the rail says *"Reading your objective to choose a workflow."* while it waits, and opens the
run for whatever came back. The row used to sit above the objective box, asking you to classify a
question you had not written yet.

Three consequences worth knowing before you rely on it:

- **Naming one yourself skips the reading entirely.** No classification request is made, no model
  tokens are spent on it, and the run opens as the workflow you picked. If you know what you want,
  Advanced is both faster and cheaper.
- **A reading that fails does not block the run.** A model error, a timeout, or an answer naming
  nothing this build serves opens an *Investigate* run and says so — *"your objective could not be
  classified, so the run investigates rather than being told what it is for"* — rather than
  presenting the fallback as a decision somebody made.
- **A workflow you did not choose is stated, with a way out.** A run opened from a reading carries a
  line under the objective — *"Opened as Optimize, read from your objective."* — with a **change**
  control beside it while the run is live. Changing it **stops this run and opens a new one**: a
  run's workflow cannot be edited, and both consequences are written beside the control rather than
  discovered. If the stop is refused, nothing new is opened and the rail says the run is still
  going, because two runs on one connection is the outcome that must not happen quietly.
  (`AgentRail.tsx:1761-1826`.) Your objective is not lost: the new run re-asks the same question,
  read off the run that was open.

**What leaves your machine for the classification** — your objective, before any run exists — is
documented in [`docs/AGENT_DATA_FLOW.md`](./AGENT_DATA_FLOW.md#the-classification-before-any-run).

**Analyze** is the one that answers a question about the *data* rather than about the database:
"which region brought in the most revenue last quarter", "how many orders shipped but were never
invoiced", "did signups fall after the pricing change". It finishes by saying which result *is* the
answer and how it should be shown — as a chart when the result has a category and a number to plot,
and as a table when it is a single number, a single row, or has no numeric column at all. A table is
a complete answer there, not a lesser one. What it presents is always a result it *read*: a query
plan is the engine describing a statement rather than running it, and a table profile is a count
about a table, so neither can be nominated as the answer — the run can still cite either as evidence
in its report, and its report has to cite the result it presented, or the run is marked as not having
answered. It is also the only workflow that asks for the auto-execute
consent below, because handing a statement to your editor is part of presenting an answer and the
other four workflows have no answer to present.

**3. The objective** — what the run is asked, and what the reading above reads. The box is labelled
*"What should the run investigate?"*, placeholder *"Why is checkout slow?"*, and it is bounded to
4000 characters (`AGENT_MAX_OBJECTIVE_LENGTH` in
`src/lib/agent/execution-policy.ts:410`). It is **emptied once the server has opened the run**, so
the next question needs no deleting; the question itself is not lost, since the run's header carries
it and the timeline's first entry quotes it. A start that was *refused* leaves what you typed exactly
where it was, so retrying is one click rather than one retyping.

Both axes are **fixed when the run opens** and are read from the run's own record for the rest of
its life (`src/app/api/agent/runs/route.ts:35-56`), so nothing can widen a Plan run into an Agent
one afterwards. The record also carries **how** the workflow was decided and how that reading went,
which is what lets the rail say the same true sentence about a run after a reload as it said when
it opened it.

**The connection is the one the shell is on, and it has to be one the server can rebuild.** A run
stores a connection id and no credential, so a connection that exists only in your browser cannot be
investigated. The rail says so rather than offering a Start that must fail:

> *"… cannot be rebuilt on the server: its settings live in this browser. A run re-resolves its
> connection there after a restart, so it can only investigate a connection the server holds too."*
> (`AgentRail.tsx:1604-1610`)

### What a Plan run knows about your database

**A Plan run runs no statement of yours, writes nothing, and hands every statement it drafts to you
to run yourself.** That is the promise of the mode, and it is the one to hold it to.

What it is **not** is "a Plan run never touches your database". It used to be described that way, and
that stopped being true on 2026-08-15. Before the model's first turn, the server reads your schema
for it — the catalog, plus what the engine already estimates about its own tables — the same reading
the sidebar takes when you connect. Nothing the model writes goes anywhere: it holds no tool, and
once the run has been given that reading, nothing further is read for it.

You no longer have to run an Agent run first. That was the old arrangement, and it meant the safe
mode only worked for people who had already used the other one — and stopped working after every
restart. A Plan run now reads what it needs itself, from whichever of these is cheapest: what it
already recorded on an earlier drive of the same run, what this server read for another run on the
same connection, or a fresh reading.

What the Plan run is shown:

- **Your tables, columns, keys and relations**, so the statement names your real tables and the real
  joins between them.
- **The engine's estimated statistics** — roughly how many rows a table holds, how often a column is
  null, roughly how many distinct values it has. These come from what PostgreSQL and SQLite already
  keep (`pg_class`/`pg_stats`, `sqlite_stat1`); **nothing is counted and no value in any row is
  read**. They are what lets a plan choose which table to drive a join from.

Every one of those numbers is an **estimate**, and the run is told to treat it as one. They can be
badly out of date, and a table nobody has `ANALYZE`d has none at all — such a table is shown as
having **no statistics**, never as empty. On SQLite the statistics exist only after you have run
`ANALYZE`, there is no null fraction at all, and a table with no index gets no row estimate either.

**Every engine, read one of two ways.** On **PostgreSQL and SQLite** the server composes catalog
statements and reads them through the same audited, read-only path an Agent run uses. On every other
connection — MySQL, Oracle, SQL Server, MongoDB, Redis, ClickHouse, Couchbase, Druid,
Elasticsearch, OpenSearch, Trino, LibreDB — it
asks that connection's own provider to describe its schema, which is the reading the sidebar already
performs when it lists your tables, and composes no statement at all. Grounding is no longer decided
by the engine, and that changed in #414; what decides it now is whether the reading succeeds. A run
whose provider cannot describe its own schema, whose description overruns the time the run granted
it, or whose reading is refused says plainly that no inventory could be read for it, and is asked to
refuse rather than to invent table names. **That is the whole of the rule**, and it holds in every
workflow including **Operate**.

**Do not read that as "the agent runs everywhere now."** Two limits used to be one sentence and are
now two different sentences, and the difference is the whole of what changed:

- **Grounding — every engine.** What a Plan run is TOLD about your database. It needs no read-only
  statement path, because the provider reading sends no statement, so it reaches all fourteen engines.
- **Agent mode — PostgreSQL and SQLite.** What a run may DO by itself. Its tools execute statements
  and need a database-native read-only path, which only those two providers implement, so a
  schema-workflow Agent run on any other engine still ends *"The agent cannot run on this database
  engine: it offers no read-only execution profile."* — after grounding has succeeded, which is
  slightly odd to watch and entirely honest: the run knows your schema and still may not read a row.
  See [What the agent does not do](#what-the-agent-does-not-do).

Two things are worth knowing about the provider reading, because they are not true of the composed
one. It is **bounded** — MongoDB stops at 200 collections, Redis scans 1000 keys — so it is what the
inspection found and not proof that nothing else exists, and the plan is told so. And on the document
engines it works out a collection's fields from a **sample of your own documents**: no value from
them is kept, but the existence of a field there is derived from your data rather than read from a
catalog. The **estimated statistics** below are still PostgreSQL's and SQLite's alone; on the other
nine the plan is told that this engine holds none it knows how to read, which means it has an
inventory and no sizes — the ordinary case now rather than a rare one.

On an engine that speaks no SQL, a Plan run is asked for one statement or command **in that engine's
own language** — a MongoDB aggregation rather than a SELECT — still in a block tagged with the
engine's name, so **Apply to editor** still works. The two checks below behave differently there, and
the rail says which of them could not reach the draft; see *What is checked* further down. Operate used to be excluded on the reasoning that it asks the
engine about itself rather than about your tables; what the reasoning missed is that the engine's
answers are full of your table and index names — a lock is held on a table, an unused index is named,
a slow query names the tables it reads — so a run that has never seen the inventory reads all of them
as strings it cannot place. An Operate plan is therefore grounded wherever any other plan is,
though with **less** of the inventory than the others: the table names and the indexes on each, and
no columns and no relations, because those are not what an operational reading asks about. The
estimated statistics it gets beside them are reduced the same way — row counts, and nothing per
column. What an Operate plan hands back
is **prose** — the readings it would take, in what order, and what each would settle — and a grounded
one is asked to name the real tables and indexes each reading would be about instead of describing
readings in the abstract.

**Prose does not mean you leave empty-handed.** Where a reading it would take is itself a statement
your engine can run, the plan writes it out as a code block with **Apply to editor** and **Copy** on
it, like any other. On PostgreSQL that is the usual case — `pg_stat_activity`, `pg_locks` and
`pg_stat_user_indexes` are ordinary tables you select from — so an Operate plan on PostgreSQL
typically hands you a monitoring query you can run on the spot. This is not limited to SQL engines:
on Redis the same plan wrote `INFO memory`, `CLIENT LIST` and `SLOWLOG GET 10` into a block your
Redis editor runs, and on MongoDB it wrote `db.currentOp(...)`, `db.serverStatus()`, `db.stats()`
and a `db.system.profile.find(...)` — four blocks, on an engine that speaks no SQL at all and where
an Analyze plan correctly refuses to draft anything. Where a reading genuinely cannot be written down — a server-status call with no
form the editor accepts — the plan says it in that engine's own terms and gives you no block, which
is a complete answer rather than a shortfall. What it may put in a block is bounded to what the
engine reports about **itself**; an Operate plan does not draft queries over your own tables, and the
statement workflows are where those come from.

Two things that follow, and are worth knowing before you rely on one. The Operate plan's block gets
**none of the checks** the statement workflows' deliverable gets — no card, no read-only verdict, no
list of names your schema does not have — because it was welcomed rather than asked for; read it
before you run it. And the run still never executes anything: applying is your click, in your editor,
on your connection.

**An Operate plan is also told which engine it is planning against**, grounded or not, and it is
asked to name only readings that engine actually offers — where it is unsure, to say what it would
want to establish rather than name a mechanism that does not exist there. That rule is why a plan on
SQLite no longer offers to read `pg_stat_user_indexes`, and why a plan on Redis no longer offers to
inspect a lock table Redis has never had. Every other workflow already carried its engine: their
deliverable is a statement, and the code block it arrives in is tagged with the connection's engine.

**The statement it drafts, and what is checked.** The run finishes with one fenced statement and a
short rationale. The rail shows it on its own card with a **Copy** and an **Apply to editor** — the
run never runs it. Two things are checked first and both are shown to you:

- **Tables it names that your schema does not have.** They are listed beside the statement. Nothing
  checks its *columns*, so an unflagged statement is one where nothing recognised was missing, not
  one that is known to be correct.
- **Whether it only reads.** A statement that writes is not withheld — sometimes writing one is
  exactly what you asked for — but it is **marked**, on the card and in the button's own
  screen-reader label, so that Apply is never a quiet handover of a `DELETE`. Read the mark as what
  it says: the guard did not classify this as a bounded read, and its reason is shown. That check
  deliberately over-refuses — text two dialects would read differently is refused whole, and so are
  PostgreSQL's `#>`/`#>>` operators — so a marked statement is one nothing established to be a read,
  which is not the same as one established to write.

Both checks read SQL, and on an engine whose statements are not SQL neither can reach the draft.
Rather than judge it wrongly they decline, and the card says which one could not look: a correct
MongoDB aggregation used to be marked as one the guard had objected to, and every name in it reported
as found in your inventory, because a SQL reader finds no table keyword in a pipeline and answers
"none missing". So on those engines the card tells you that nothing examined this draft and nothing
checked its names — which is less than you get on PostgreSQL, and is what is actually true.

**A statement built from your real table names is still not a statement guaranteed to run.** The
inventory records what exists in the database, not what your role is permitted to read.

**On engines that hold no tables, the plan is told what it is looking at.** Studio records every
schema in one shape, and the word "table" is that shape's name rather than a claim about your
database — so the prompt uses whatever your engine's provider calls its objects: collections on
MongoDB, datasources on Druid, key patterns on Redis, key prefixes on LibreDB. On Redis and LibreDB
there is a further thing to say and the run is told it: the rows in that inventory are **groupings
Studio computed**, by scanning a bounded part of the keyspace and collecting your real key names
under their common prefix. `user:*` is not a key and no command can be given it. Without that
sentence a grounded Redis plan drafted `ZCARD user:*` — specific, confident, and against something
that does not exist.

**When it cannot answer**, the run says so instead of guessing: the rail shows a *No statement
drafted* card with what was missing and the one question that would unblock it. That is a successful
ending for this mode, not a failure. A Plan run that instead lectures — a numbered list of things it
would look at, with no statement and no refusal — is marked **unanswered**.

---

## The four workflows

Each workflow changes three things: what the model is told the run is FOR, which tools it is offered,
and the bar its verdict is judged against.

### Investigate

The default. The objective is a question about the database and the model answers it from what it
establishes (`WORKFLOW_OBJECTIVES.investigation` in `src/lib/agent/investigation.ts:505`). Tools:
`inspect_schema`, `run_read_query`, `inspect_plan`, `compose_report`
(`AGENT_MODE_TOOLS`, `src/lib/agent/tools.ts:601-606`).

**Answered when** the run composed at least one claim and the claims do not rest entirely on empty
results (`verifyInvestigationGoal`, `src/lib/agent/goal-verifier.ts:281-284`).

### Optimize

For a statement that is too slow. The model is told that what matters is *how the engine reaches its
rows* (`investigation.ts:506-507`), and it is offered two further tools: `compare_plans`, which
takes the ids of two plans the run already inspected, and `recommend_change`, which records one
index or rewrite (`tools.ts:630-634`).

Two things this workflow will not do, and it says so rather than implying otherwise:

- **Every plan is an estimate.** `EXPLAIN ANALYZE` executes the statement and is policy-denied, so
  the comparison entry carries a sentence the application wrote: *"Estimates only: these plans were
  described, not executed. EXPLAIN ANALYZE is policy-denied because it would run the statement."*
  (`PLAN_ESTIMATE_CAVEAT`, `timeline.ts:355-357`).
- **A recommendation is never applied.** Every recommendation entry carries *"Not applied: nothing
  here runs this statement."* (`NOT_APPLIED_CAVEAT`, `timeline.ts:359`), and the only thing offered
  is an **Apply to editor** button, which puts the text in your editor and runs nothing
  (`HydrationControls`, `AgentRail.tsx:401-447`).

**Answered when** the Investigate bar is met **and** the change it proposes rests on a plan it read:
a before/after comparison for a rewrite, or — for an index, whose "after" plan would need the index
to already exist — the recommendation citing the plan it diagnosed (`verifyQueryOptimizationGoal`,
`goal-verifier.ts`).

### Assess

For the state of the data itself — where it is incomplete, inconsistent or surprising
(`investigation.ts:508-509`). It adds one tool, `profile_table`, and the rule that matters is worth
reading before you point it at a table of personal data:

**A profile records counts, never values.** Row counts, present counts, distinct counts, and how
many values match a shape — computed inside the database with `count(CASE WHEN … LIKE …)`, so no
matching value leaves it. There is deliberately no `min`/`max`, because on a text column those
return real values (`src/lib/agent/table-profile.ts:1-27`). The findings — `high_null`, `constant`,
`low_cardinality`, `suspected_pii`, `fk_unindexed` — are the server's own mechanical predicates over
those counts, with stated thresholds; the model may interpret them and cannot invent one.

**Answered when** the Investigate bar is met **and** a table was actually profiled
(`verifyDatabaseAssessmentGoal`, `goal-verifier.ts:358`).

### Operate

For how the database is **running right now** — the slowest queries, who is connected and what is
blocked, the biggest tables, the unused indexes, storage pressure. It is the one workflow that
**sends no SQL at all**: the only tool that reaches the database is `inspect_operations`, and you
name a *reading* rather than a statement — `sessions`, `slow-queries`, `table-stats`, `index-stats`,
`storage` or `health`. The server calls the engine's own reporting interface and stores the answer
as an ordinary citable result.

Two consequences you will notice:

- **It runs on every engine.** The other workflows need a database-native read-only statement path,
  which only PostgreSQL and SQLite have; this one needs none, so a run opened on MySQL, Oracle, SQL
  Server, MongoDB or Redis works rather than ending `engine-unsupported`.
- **It has no free-form SQL, and its schema is a short list of names.** There is no `inspect_schema`
  and no `run_read_query` here, and the run is told so in its opening message rather than being left
  to discover it. What it is given instead is an inventory of your table names and the indexes on
  each, and nothing more: no columns, no types, no relations. That is there so the run can recognise
  what the engine names back at it, since a lock report, an index-stats row and a slow query all come
  back full of identifiers. It arrives on every engine since #414 — composed on PostgreSQL and
  SQLite, read from the provider everywhere else — and where the reading cannot be taken the run is
  told plainly that no inventory could be read for that connection and takes its readings anyway.

Two things this workflow will not do, and it says so rather than implying otherwise:

- **Every reading is a moment, not a history.** A session list is who was connected as the run
  looked. The timeline says so on the entry itself: *"A moment, not a history: this reading says what
  the engine reported as it was taken."* (`POINT_IN_TIME_CAVEAT`, `timeline.ts`), and the model is
  told the same before it starts, so a report cannot quietly imply a trend was measured.
- **It cannot propose an operational action.** `recommend_change` offers an index or a rewrite and
  nothing else, so "kill this session" or "vacuum this table" is stated as a claim in the report
  rather than filed as a recommendation you could apply with one click.

**Answered when** the run composed a report and at least one claim in it cites a reading it took
(`verifyOperationsGoal`, `goal-verifier.ts`). Every claim cites something the run actually established
— `compose_report` refuses a claim whose evidence names nothing this run produced — and since the run
also holds a citable schema inventory, the verdict asks for one citation of a READING on top of that:
a report about locks that rests only on the list of table names has answered from what a database like
yours usually looks like. Note what is deliberately **not** required: a reading that came back **empty** still counts. No blocked session and no slow query is
what a healthy server looks like, and treating that as an absence of evidence would mark an accurate
report as unanswered.

---

## What you see while a run goes

**Under the header, one line always says what reaches your database.** While a run is open that is
the *run's* reading, taken from its own record; before one, and once one has ended, it is what
pressing **Start** would do. It is five readings and not a mood, and the qualifier beside the pill is
part of the claim rather than a footnote:

| The pill says | Beside it | When |
| --- | --- | --- |
| *Executes nothing it drafts* | *one schema read grounds it, nothing else reaches the database* | **Plan** mode, on every engine — production included. The one reach is the schema capture that grounds the draft: metadata only, no data rows |
| *Reads only* | *200 rows and 10 s per statement, enforced by the engine* | **Agent** mode on an engine whose provider implements a database-native read-only statement path |
| *Reads only, and one statement in your editor* | *500 rows, no time limit, same read-only session* | The same, with **auto-execute** ticked for the run being opened — and it stays that reading while that run is going |
| *Cannot execute on `<engine>`* | *plan mode drafts here, and the operations workflow still runs* | **Agent** mode on any other engine. The run would end `engine-unsupported` before its first statement |
| *Cannot execute yet* | *no connection is resolved, so no engine has been established* | **Agent** mode with no connection resolved. Nothing has been read, so the panel does not claim to know which engine you are on |

Those two figures are the ones the server is enforcing, and they are the same on every workflow — the
strip is shown before a run has one, so it states the pair every workflow row shares rather than
guessing at a row. The **500** is the editor's own limit, which is what auto-execute widens to.

**While a run is open, both halves describe that run.** A run's mode is fixed when it opens and its
own header says which one, so switching the toggle beside a run that is going decides what the *next*
run will be and leaves this line where it is — it does not restate a running agent run as *Executes
nothing it drafts*. Auto-execute is frozen the same way, to the run that was opened with it. Once the
run has ended there is no run to describe, so the line answers what pressing **Start** would do again
— and it stops saying *one statement in your editor*, because the next run's tick starts unticked.

The ⓘ at the end of the row opens the whole claim behind whichever of those is showing, and that text
is readable to a screen reader whether or not the popover is open. On *Cannot execute on `<engine>`*
an amber card appears above **Start** with the same facts and a **Switch to Plan** button — **and
Start is not disabled**, because the refusal belongs to the provider factory and the **Operate**
workflow sends no statement at all, so it runs on those engines exactly as it does anywhere else. Any
other workflow started there anyway still ends `engine-unsupported` — after a model turn, and before
its first statement. The strip tells you first; it does not stand in the way.

**While a run is open the objective is a line rather than a box.** The question is settled — it is on
the run's own header, and every entry below was framed with it — so it reads as one line with the
run's own workflow and mode under it and an **Edit** control beside it. A screen reader announces that
line as *the objective this run was opened with*, which is the label the box carried. Edit puts that
same question back in the
box, which is where refining it starts; pressing **Start** then opens a *new* run with whatever you
made of it. When the run ends, the box comes back on its own.

**The run's outcome is the first thing in the scroll area, above the transcript.** It is a second
rendering of entries the timeline already holds, so there is nothing on it a run did not record: in
Plan mode the drafted statement with what the guard made of it, in Agent mode the model's own quoted
claim with the citations it rests on, while the run goes the step it is on and what it has spent, and
on the two endings that are not answers — a refusal, a failure — the run's own words for it. What the
run PRODUCED is what the block shows, not how the run ended: a run can reach its time or step limit
just after drafting a statement, and the statement, the guard's reading and the one **Apply to
editor** are all still there, with `Run failed` and the reason stated under them. It
scrolls away with everything else rather than being pinned, because a fixed block would take a third
of the panel from the transcript underneath it.

**What the answer rests on is stated on every engine.** Under a drafted statement, two of the chips
are the run's grounding rather than a verdict on the draft: how many rows the inventory held, in the
engine's own noun — *5 collections read* — and the first 8 characters of that snapshot's fingerprint,
the same pair the `Schema captured` entry carries. They come from the capture and so they are there
whatever the guard could make of the statement. That matters most where the guard could make nothing
of it: on an engine whose statements are not SQL the only other chip is the amber *not checked*, and
the inventory the statement was drafted against is then the only grounding claim left on the card.

**What a run cost is folded away; its answer is not.** `Run details` is the one fold between the Start
row and everything that scrolls, and it is shut unless a run is live — its summary still carries the
figures that move, so how far in a run is takes nothing to read. See
[The budget meter's numbers](#the-budget-meters-numbers) for what is inside it. The answer is the part
that is open, because it is what you asked for; the spend is what it took to get there.

The rail's timeline is a fold over the run's ledger, one line per recorded event
(`foldLedgerEntries`, `timeline.ts:1018-1189`). Before anything has happened it says *"No activity
yet. A run's steps appear here as they are recorded."*

**The three entries that only say a run began are folded** — `Run opened`, `Run started` and
`Schema captured` collapse into one dim *Run setup* line that expands to all three, rendered in full,
your quoted objective included. On a Plan run that is three of five lines, and the two that matter
were starting below the fold. That summary line counts entries, and a counter is not progress, so it
is excluded from what a screen reader is told as the run goes: the entries below it are announced as
they arrive, exactly as before.

| Headline | When |
| --- | --- |
| `Run opened in <mode> mode for <workflow>` | The run's own header. Your objective is shown quoted underneath. Folded under *Run setup* |
| `Schema captured` | The run read the catalog once: how many rows the inventory held, in the engine's own noun — tables, collections, key patterns, datasources — and the first 8 characters of the snapshot fingerprint. Folded under *Run setup* |
| `Statement drafted` | The model wrote SQL. The statement is shown quoted, with the model's stated reason |
| `Tool invoked` / `Result stored` | The call, then its outcome: rows, columns, elapsed ms, and the artifact id |
| `Refused by policy` | The operation layer denied it. Shown by deny code — there is no engine text, because a denial produced none |
| `Approval required` | The operation needs a human approval this run does not have |
| `The database refused the statement` | The engine's own message, quoted |
| `Plans compared` / `Index recommended` / `Rewrite recommended` | Optimize only |
| `Profiled <table>` | Assess only: counts and findings |
| `Result stored` … *"A moment, not a history"* | Operate only: an operational reading, with the caveat that it describes an instant already past |
| `Answer composed` | The run named one stored result as its answer and said how to show it — as a table, or as a chart of a named type. A chart's caption is the model's own prose and is shown quoted; the columns never appear in the application's own sentence, because they are engine text |
| `Report composed` | How many claims, each citing evidence |
| `Closing statement` | The model's closing prose. It cites nothing and claims nothing — a Plan run's whole output, an Agent run's aside. On a Plan run that drafted a statement, this prose is the text that statement was read out of, so the block holding it is not printed here a second time: the statement is in the answer above, once. Every other word of the prose is there, and **Copy all** carries the whole thing, fence included |
| `Statement drafted` / `Statement drafted — not classified as a read` / `Statement drafted — not examined by the statement guard` | Plan mode: the one statement the run wrote. **The statement itself, any name it uses that your schema does not have, and Apply to editor are in the answer at the top of the rail** — this entry keeps the headline, the timestamp and one line summarising what the guard made of it, and reprints neither the statement nor the guard's paragraph, so there is exactly one place the statement is offered to your editor and it is the one carrying the guard's marks. The second headline is a statement the guard did not classify as read-only, and its reason travels with it: that can mean the statement writes, and it can equally mean the guard could not settle the text. The third is a draft on an engine whose statements are not SQL, where the guard is not a reader of that language and examined nothing — no reason is shown, because there was no objection to show. Nothing runs under any of the three |
| `No statement drafted` | A Plan run that could not answer from your schema, with what was missing. A legitimate ending, not a failure |
| `Stop requested` | You pressed Stop; *"the run takes no further database step; work already in hand, such as a report, still finishes"* |

**Wording the application chose and text that came from elsewhere never share a line.** Headlines
and details are the application's words; anything from the model, the engine or you is rendered as a
quoted block, because database content is untrusted input (`timeline.ts:35-40`).

**The one exception is the closing statement, and it is a rendering rather than a mixing.** Models
write that block as markdown, so it is rendered as markdown — headings, bullets, bold and inline
code — inside a block of its own with a rule down its left edge, so you can still see where the
application stops speaking. Only those five forms are interpreted; links, tables and fenced blocks
stay the characters the model typed. Nothing on that path touches an HTML parser: it is built as
React nodes, so a model that writes `<img src=x onerror=…>` has written text and nothing else.

**The timeline stays at its newest entry while the run is going**, so a step does not arrive below the
fold. Scroll up to read an earlier one and it stops following — the next entry leaves you where you
are — until you scroll back down.

**When the run ends, the answer is what you are left looking at.** The newest entry at that point is
the run finishing, and the thing you waited for is at the top of the scroll area — so the rail brings
it into view instead of holding the bottom of the transcript. It happens once, when the run reaches
its ending, and not to a reader who had scrolled away: from there you are left where you are, in this
regime as in the other.

Two controls appear under an entry only when there is something to act on **and** the shell can act:

- **Apply to editor** — puts a drafted statement into the editor. Always your click, never automatic,
  unless the run was opened with **auto-execute** (below), which is the one thing that can put an
  answer's statement into your editor and run it there.
- **Show result** — hydrates the stored rows into the ordinary bottom-panel surface: the results
  grid, the explain view for a plan, or the charts view for an answer the run composed as a chart —
  drawn as the run said to draw it, and with the ordinary chart controls still yours to change. Which
  surface opens is what the run recorded, not a guess from the data: a result whose answer said table
  is shown as a table however chartable it looks. Every one of them carries a read-only
  provenance badge naming the run. It is offered only **while the run is live**: a run's stored rows
  are released when it ends, and the rail says so where the results are listed — *"A run's stored
  rows are released when the run ends, so a result can be shown only while its run is still
  going."* (`AgentRail.tsx:2186-2190`).

**The answer itself is shown without being asked for.** When an `Answer composed` entry arrives, the
rail opens that result immediately — as the chart the run composed, or as a table — because a run
that answers with a picture and shows you a sentence saying it drew one has not answered. It happens
once, at the moment the entry arrives, while the rows still exist; nothing is kept any longer than
before, and while the run is live the entry's own **Show result** still brings the answer back if you
dismiss the panel. This is not the rail acting on your behalf in the sense the rule above forbids:
nothing is executed, and the rows are ones the run already read on its own bounded read-only path.

**A report is read in the answer at the top, and nowhere else.** Each claim is the model's own quoted
prose; the chips under it name what it cites — the read's identifier at the length a chip can hold it,
the model's own pointer into that evidence, and what the run's own record says that read returned, so
a chip states its evidence rather than only naming it; and `Evidence` folds out each citation in full
— `Artifact <id>`, with the whole identifier this time, the row count and the statement that produced
it, or `Schema snapshot <fingerprint>` with the count in the engine's own noun. There is no second **Report**
section at the foot of the rail: it rendered the same claims and the same citations again, which is
how one statement came to be offered to your editor three times over. A citation the rail cannot
resolve in what it has read says so rather than looking checked — in words and not only in amber, on
the chip in the answer as well as in the evidence beneath it, because a gap in what a run established
is not a thing to say in a colour (`UNRESOLVED_DETAIL`, `timeline.ts:967`).

---

## Auto-execute: when the run runs the answer in your editor

An **Analyze** run in **Agent** mode can be opened with **auto-execute**. It changes one thing and it
is worth being exact about
which: the run's own answer is produced the same way either way — from a result it read on its own
bounded path, at 200 rows and a 10-second ceiling, with a ledger entry behind it. What the setting
adds is that the answer's statement is also placed in your editor **and run there**, on the
connection the run was opened on, at the editor's 500-row limit and with **no time limit**.

**It is the same read-only session either way.** The re-run is not an ordinary editor execution: it
is sent to the database inside the engine's own read-only transaction — the same one the run used to
produce the answer — so a write or a DDL statement is refused **by the database**, not by reading the
statement and judging it. That distinction is the whole of it: a `SELECT` can call a function that
writes, and no amount of reading the statement would tell you so.

**It is offered on Analyze alone, and only in Agent mode.** Auto-execute hands over *the answer*, and
Analyze is the only workflow that produces one — an Investigate, Optimize, Assess or Operate run
finishes with a report, not with a statement it is nominating as the answer, so there would be
nothing to hand over. (The API refuses `autoExecute: true` on the other workflows outright, rather
than accepting it and quietly doing nothing.)

**You are asked for it after Start, not before it** (`AgentRail.tsx:1655-1737`). Pressing Start on
an Analyze run in Agent mode — whether you named the workflow or the server read it — raises a
consent step in place of opening the run:

> *"This run will open as Analyze on **&lt;your connection&gt;**, which answers with a result."*
> — then the checkbox *"Also run the final answer in my editor"*, the terms, and **Open** and
> **Cancel**.

The terms under the checkbox are the words above: what the run keeps for its own read (200 rows, 10
seconds), what the editor keeps (the 500-row limit), what is given up (the time limit), and what
happens instead when the run declines to run it for you. On a SQLite connection one more line
appears, because there the missing time limit means something different: *"On SQLite a read is not
interrupted when it runs long: it blocks other writers and this application until it finishes."*

Three things about that step, and each of them is why it is there rather than above Start:

- **It exists exactly where the hand-over could happen.** There is no checkbox to find and no state
  to leave it stranded in: a run that cannot present an answer never raises the step, and a host
  with no editor to run a statement in is not offered it at all.
- **The connection it names is the connection the run opens on.** It is taken when you press Start,
  so selecting another database while the step is up changes neither — the run opens where you
  asked it to, and the SQLite line stays if that is where you asked.
- **Cancel opens nothing** and leaves your objective exactly where it was. Nothing has been sent.

It is decided by the request that opens the run and cannot be changed afterwards — it is recorded on
the run itself, and no later request can widen a run the server already holds. So changing your mind
means starting another run. (The same field is accepted by `POST /api/agent/runs` as `autoExecute`,
absent meaning off.)

**The re-run is at the editor's default 500 rows even if you had widened this tab.** "Show unlimited
rows" is a choice you made about a statement you wrote; a statement the run hands over does not
inherit it, and it is run at the default limit whatever the tab was last set to.

**A statement is only run for you when all three of these hold:**

1. This run executed that exact statement itself. A final statement wider than anything the run ran
   is never run for you — and one it only *explained* was never executed.
2. The engine's plan for it reads as cheap: on PostgreSQL an indexed access path and an estimated
   cost of at most 50 000; on SQLite every step a `SEARCH`. Anything unknown or unreadable counts as
   risky, and on SQLite that is deliberate — a read there is not interrupted when it runs long, it
   blocks other writers and this application until it finishes.
3. The run measured its own execution of it at 2 000 ms or less.

**When any of them fails the statement is put in your editor and left unrun, and the run says which
one failed** — *"Not run for you: … so this one is yours to run."* A statement sitting there unrun is
the feature working, not the feature failing.

**Nothing is added to the statement.** No `LIMIT` is injected: a chart of 200 of 4 000 regions would
look like a complete chart, and every number on it would be right, which is worse than an obvious
error.

**And it is only ever run on the connection you started the run on.** The statement itself cannot
reach anywhere else — the server runs it on the connection recorded on the run, not on whatever the
editor is pointed at. But if you switch the editor to a different connection while a run is going,
the statement is **not** run at all: the rows would have landed in a tab connected somewhere else and
been read as that database's answer. The timeline says so beside the answer — the run recorded that it
handed the statement over, and this is the app telling you it did not carry that out. The statement is
still there: take it with the control beside the entry and run it yourself, on whichever connection
you are on now.

**There is no ledger entry for the re-run.** The run may already have finished by the time it happens,
and a finished run's record does not take additions. The timeline records that the run handed the
statement over, and says that what happened next is visible in the editor.

---

## What "answered" means

**A run's ending and its verdict are two different facts, and the rail states them separately.**

The status word — `succeeded`, `failed`, `cancelled` — says how the run ended. It does **not** say
whether you got an answer: a run whose model stopped without composing a report ends `succeeded`,
and a run that ran out of turns ends `failed`, and neither answered anything. This was not a
hypothesis; both were observed on live runs, which is why the verdict is a separate field
(`timeline.ts:604-631`, and [`docs/AGENT.md`](./AGENT.md#whether-the-run-answered) for the mechanism).

So the last line of a run reads **"Run answered"** or **"Run did not answer"**
(`answeredHeadline`, `timeline.ts:626-627`). A ledger written before verdicts existed carries none,
and such a run keeps the status word it always had (`Run succeeded`) rather than being given a
judgement nobody made.

Under it, when the run fell short, is **one sentence naming what it did not produce**. These are the
whole vocabulary (`SHORTFALL_SENTENCES`, `timeline.ts:633-645`):

| The run did not answer because | The sentence you get |
| --- | --- |
| `no-report` | "The run finished without composing a cited report, so nothing it found was written down." |
| `empty-evidence` | "Every result the report cited came back empty, so the answer rests on nothing." |
| `no-plan` | "The run produced no plan at all." |
| `no-statement` | "The run described how it would approach the question and never wrote the statement, and it did not say what was missing either." |
| `no-plan-comparison` | "No before-and-after plan comparison was recorded, and no index was recommended: a query optimization rests on one or the other." |
| `no-plan-evidence` | "The index was recommended without citing a plan this run read, so nothing the engine said backs it." |
| `no-table-profile` | "No table was profiled, so the state of the data was never established." |
| `no-reading` | "The report rests only on this database's list of tables, and on no reading of what the engine is doing, so nothing it says was measured on this server." |
| `no-answer` | "The run reported what it found but never produced an answer to show, so there is nothing to put in front of you." |
| `answer-uncited` | "The run presented one result as the answer and its report rests on other evidence entirely, so the claims and the picture are not about the same thing." |
| `cancelled` | "The run was stopped before it could finish." |

A run **you** stopped reports `cancelled` rather than the output it was missing: a stop is not a
defect of the run (`goal-verifier.ts:273,283`).

If the run had no shortfall to report, the line under the verdict says how the loop ended instead
(`STOP_SENTENCES`, `timeline.ts:528-545`) — for example *"The run reached its step limit before it
finished. What it had gathered is above."*

**The shortfall wins over the ending in both modes** (`describeEnding`, `timeline.ts:604-624`), and
one ending is where that matters. When the model simply stops, an **Agent** run that composed no
claims also carries the `no-report` shortfall (`verifyInvestigationGoal`, `goal-verifier.ts:283`), so
the sentence you actually read is the shortfall one — *"The run finished without composing a cited
report, so nothing it found was written down."* The stop sentence for that ending, *"The model
stopped without composing a cited report."*, is what a run whose ledger carries **no verdict at all**
shows. In **Plan** mode the same ending is not a shortfall by itself — that mode has no report to
compose — so its own wording is what appears: *"The model finished its plan and stopped. Planning
mode has no tools, so it composed no report."*, which is how a good Plan run ends. It is not enough
to have spoken, though: `verifyPlanningGoal` asks for the mode's actual deliverable, so a run that
stopped after a lecture — no statement drafted and no `NO STATEMENT:` refusal — carries the
`no-statement` shortfall, and that sentence wins over the ending one exactly as above.

And when the run failed for a reason that is not about the answer at all, that sentence wins over
both, and also appears next to the Start button so you can fix it before starting another
(`FAILURE_SENTENCES`, `timeline.ts:335-345`; rendered at `AgentRail.tsx:1618-1622`): the model
provider not being configured or reachable, limiting this key's requests, rejecting the credentials,
an engine with no read-only execution profile, a connection that no longer resolves, or an internal
failure whose reason is in the server log.

---

## The budget meter's numbers

**The meter is folded away under `Run details`**, above the timeline, and it opens itself while a run
is live. Shut, its summary still carries the figures that move — how many steps the run has recorded,
and its statement and database-time spend — so nothing has to be opened to see how far in a run is.
Open, it shows **three gauges, and it shows only what the server actually enforces and the ledger
actually records** (gauges built in `timeline.ts`):

| Gauge | Reads | The limit, and where it comes from |
| --- | --- | --- |
| **Statements** | `used / 30` on an investigation | `maxStatementsPerRun`. Every statement the pipeline allowed and invoked — catalog reads, drafts and repairs alike |
| **Database time** | `used / 90.0 s` on an investigation | `maxTotalRunMs`. **Database time only** — the elapsed time completed reads reported, not the wall clock |
| **Repair attempts** | `used / 3` | `AGENT_MAX_REPAIR_ATTEMPTS`. Only statements that failed **at the database** consume one; a policy denial does not |

Under them, three ⓘ controls carry the claims that qualify those figures — **What is counted**,
**Ceilings** and **Report reserve** — each on the figure it is about, each opening the same sentence
it has always been, and each readable to a screen reader whether or not it is open. *Ceilings* is the
three the server enforces and nothing durable counts against, so they are given as ceilings rather
than as gauges: *"Each statement gets 10.0 s, each drive 7.5 min and at most 36 model turns."*

**Every number on the meter is the one the server is enforcing on THIS run**, because the ceilings
differ per workflow and both halves of the meter read the workflow off the run's own header. So the
meter changes with the run, not with the buttons: pick another workflow while a run is in flight and
the figures stay the run's.

| Workflow | Model turns | Statements | Each drive | Database time |
| --- | --- | --- | --- | --- |
| **Investigate** | 36 | 30 | 7.5 min | 90 s |
| **Optimize** | 36 | 30 | 7.5 min | 90 s |
| **Assess** | 48 | 45 | 10.5 min | 135 s |
| **Operations** | 20 | 18 | 6.0 min | 80 s |
| **Analyze** | 60 | 42 | 15.0 min | 180 s |

**These figures are approved and pending live measurement.** They are the starting point a
measurement confirms or corrects, not numbers read off measured runs. Operations is the small row on
purpose: it sends no SQL of its own, so it never spends a statement drafting one and never repairs
one, and its readings come from a closed set of six kinds — twelve of its eighteen statements are
every kind twice, once broad and once narrowed. The other six pay for the schema inventory the server
reads before the run's first turn, and they were added to the row rather than taken out of it, so
grounding costs the run no reading. Analyze is the large row for the opposite reason: it
iterates towards an aggregate rather than repeating a reading, and a `GROUP BY` over a fact table
costs far more database time than a catalog read.

**If you self-host behind a reverse proxy, Analyze needs a longer read timeout than the default.** A
15-minute drive holds one streaming response open for its whole life, and nginx's default
`proxy_read_timeout` is 60 seconds — so a long Analyze run has its stream cut and the rail loses it,
even though the run itself survives on the server. `docs/AGENT.md` ("Deployment") gives the setting
for nginx, ingress-nginx and the common PaaS routers.

Before any run is open there is no header to read, and what the meter says then depends on whether
the workflow is decided yet. Name one under **Advanced** and it states that workflow's own ceilings.
Leave it on **Automatic** and it states none of them — *"Every ceiling here is per workflow, and
Automatic decides the workflow from your objective when the run opens — so the figures are stated
once the run has one, and by the run's own record."* An Analyze run is bounded twice as long as an
Investigate one, so a figure shown before the workflow is known would be a number nothing is
enforcing. The gauges themselves wait for a run either way.

**There is no token gauge, and its absence is deliberate**: this build enforces no token budget, so
a figure would mean nothing (`docs/BACKLOG.md` B10).

**A run that ends early was asked to stop.** When a run comes within 2 model turns or 20 seconds of
either of those ceilings, the server tells it once — in its own words, not the database's — that this
is its last turn and that it should report what it has established now. So a run that finishes well
short of every figure on the meter is usually a run that took that offer, and its report is a
partial answer rather than a missing one. The bar does not move when it happens: a claim still has to
cite something the run read, so a forced report is a cited report or it is no report at all. Nothing
is asked of a **Plan** run, which has no report tool to call. The meter says this under the ceilings.

Then the caveat, which is the part worth reading twice — behind the **What is counted** ⓘ, beside the
gauges it is about:

- **Every ceiling is per drive.** A run resumed after a restart starts each of them again, so these
  totals can read past a single drive's ceiling.
- **Every figure is a floor, never a ceiling.** The ledger records less than the server charges: the
  schema capture's catalog reads are not itemized, a statement that failed at the database records
  no duration, and a completed read reports the engine's own elapsed time rather than the span the
  budget was charged (`docs/BACKLOG.md` B12, B13).
- **On SQLite a statement over its timeout is refused once it returns, not interrupted while it
  runs.** PostgreSQL preempts with `SET LOCAL statement_timeout`; SQLite does not, so there the
  timeout is a post-execution deadline.

---

## When the model is refused

Before an **Agent** run opens, the server asks the configured model to call one trivial tool and
watches what comes back (`src/lib/agent/capability-probe.ts`). If it establishes that the model
cannot do the job, the run is refused with `422` and the rail renders a state of its own rather than
a red error line (`AgentRail.tsx:1905-1948`):

- the heading *"This model cannot drive an agent run."*;
- **The probe could not establish:** one chip per capability, in this build's own labels — *tool
  calling*, *schema-valid tool arguments*, *streaming* (`src/lib/agent/capability-labels.ts`);
- the server's own sentence, which is the only place the model's name and the **endpoint's own
  words** appear;
- and what is still worth trying.

That last line has three registers, and which one you get is a fact about what the probe saw
(`refusalActionText`, `AgentRail.tsx:333-345`). Where nothing the probe observed rules it out, you
are offered **Switch to Plan mode** — because Plan mode is toolless and is never probed, so it is
reachable with exactly the model that was just refused. The copy says *"may still work"* and not
*does*: admission without probing is not proof of compatibility. Where the probe **watched** the
endpoint answer without streaming, the offer is withdrawn instead, because Plan mode reads the same
stream and would produce a run that reports success and contains nothing.

**A refusal that says nothing about the model is not routed here.** A bad key, a quota, or a 5xx
start the run and are reported by the drive as `model-unauthorized`, `model-rate-limited` or
`model-unavailable`, each with its own sentence.

---

## Running the agent on a local model (Ollama)

Ollama is a first-class path: `LLM_PROVIDER=ollama` with `LLM_API_URL=http://localhost:11434/v1`
reaches the OpenAI-compatible endpoint through the same adapter as the `openai` and `custom` kinds
(`src/lib/agent/provider-registry.ts:121-132,154-159`), and no key is required — the adapter sends a
placeholder rather than leaving `apiKey` undefined, so an ambient `OPENAI_API_KEY` cannot leak in
(`provider-registry.ts:86,107,110`).

**The model decides whether a local deployment can run the agent — not the endpoint.** This is
worth stating precisely, because it is the opposite of what the mechanism suggests. The capability
probe sends `toolChoice: "required"` (`capability-probe.ts:253`), which the OpenAI-compatible
provider serializes as `tool_choice` — and **Ollama documents `tool_choice` as an unsupported
field** on `/v1/chat/completions` (<https://docs.ollama.com/openai>), with forcing a tool call
listed under future improvements in its own tool-support announcement
(<https://ollama.com/blog/tool-support>). So on Ollama the probe's forcing mechanism does not apply,
and the verdict rests on the model **volunteering** the call.

### What was measured

Against a real Ollama at `http://localhost:11434/v1`, driven through this repository's own
`createAgentModel` + `probeAgentModel` — no mocks, no fixtures:

| Model | Verdict | Elapsed |
| --- | --- | --- |
| `qwen3.5:4b` | `supported: true` — tool calling, structured output and streaming all established | 51.5 s first probe with the weights cold on disk; 3.2 s immediately repeated (2026-08-13). Re-measured 2026-08-14: 4.7 s warm, 4.6 s after `ollama stop` with the weights still in the OS page cache |
| `gemma3:270m` | `supported: false`, `missing: [toolCalling, structuredOutput, streaming]`, `disproved: []`, detail *"The endpoint refused the tool request with HTTP 400: registry.ollama.ai/library/gemma3:270m does not support tools."* | 128 ms (2026-08-13); 121 ms (2026-08-14) |

The 2026-08-13 figures are from the probe recorded for #331 T6; the 2026-08-14 figures were measured
again for this page against the same endpoint. Both readings agree on the verdicts.

Three operator facts follow from that, and each is a reading of the numbers above rather than a
recommendation copied from a vendor page:

1. **A model with native tool support passes on Ollama today**, despite `tool_choice` being ignored.
   `qwen3.5:4b` volunteered the call. So pick from the families that advertise tool support, and
   confirm it with a probe — Ollama's own tag metadata lists `"tools"` among the model's
   capabilities, which is the cheapest thing to check first.
2. **A model without tool support is refused, and the refusal is cheap and correct.** 121 ms, and
   the endpoint's own words are what you are shown. That model can still be used for **Plan mode**,
   which the rail offers there — `disproved` is empty, so nothing was watched failing to stream.
3. **The first probe of a cold model pays the load.** 51.5 s against 3.2 s warm. A probe that looks
   hung on a fresh Ollama is usually a model being read from disk.

Reproduce either reading against your own endpoint before trusting it here — that is the whole point
of the probe existing.

---

## What the agent does not do

Stated plainly, because a surface that hides its edges is the one that surprises you:

- **It cannot write.** Every database reach the agent makes goes through the agent's own audited
  pipeline — the policy decision, the audit event and the budget accounting that
  `executeAuditedOperation` performs before the driver is touched
  (`src/lib/db/operations/execution.ts:129`, reached only from `src/lib/agent/tools.ts:1214`) — under
  a read-only execution profile whose boundary is database-native rather than a parser: a read-only
  transaction on PostgreSQL, `PRAGMA query_only` re-asserted per statement on SQLite. Writes and DDL
  are refused before the database is reached. See [`docs/SECURITY.md`](./SECURITY.md) row 3.4.
- **That pipeline is the agent's, not the application's.** It is worth saying plainly, because the
  wording used to imply otherwise: a statement you run yourself in the editor does not pass through
  it. `/api/db/query` calls the provider directly (`src/app/api/db/query/route.ts:44`), so an editor
  query is neither policy-checked nor written to the agent audit trail. The controls above describe
  what the agent is held to, not a guarantee the whole product enforces.
- **Agent mode runs on PostgreSQL and SQLite only.** The read-only profile has to be implemented by
  the provider, and only two do: `queryReadOnly` exists on `postgres.ts:870` and `sqlite.ts:397`.
  Acquiring a profiled provider for any other engine raises `PROFILE_UNSUPPORTED_BY_PROVIDER`
  (`src/lib/db/factory.ts:473`), which the runtime reports as `engine-unsupported`
  (`src/lib/agent/runtime.ts:242`) — the rail says so in as many words
  (`src/components/agent/timeline.ts:341`). So on MySQL, Oracle, SQL Server, MongoDB, Redis,
  ClickHouse, Druid, Trino and Couchbase an Agent-mode run cannot read anything. It also covers the bundled
  **LibreDB sample** connection, whose provider implements no `queryReadOnly`
  (`src/lib/db/providers/embedded/libredb.ts`) — the bundled **SQLite sample** is the seeded
  connection to try a run against (`src/lib/seed/sqlite-sample.ts:131`). **Plan** mode still opens on
  every connection — the model is toolless there, so no profile has to be acquired for it — and since
  #414 its **grounding** no longer takes this path at all on the other twelve: it asks the provider to
  describe its schema, which needs no read-only statement profile, so a Plan run on MongoDB or MySQL
  is ordinarily grounded while an Agent run on the same connection still cannot read anything. Where
  the reading does fail — a provider that cannot describe itself, a description that overran its
  time, a refusal — the Plan run starts, says no inventory could be read for it, and is asked to
  refuse rather than to invent table names.
- **It never executes a recommendation**, and never applies one to your editor by itself. The single
  exception anywhere in the rail is auto-execute, which is off unless the run was opened with it, and
  which covers only the answer's own statement under the three conditions above.
- **It cannot be paused or resumed from the rail.** There is a Stop control and nothing standing in
  for a capability this build does not have (`docs/BACKLOG.md` B11).
- **A stopped run stops at its next checkpoint**, not instantly: cancellation is enforced by the run
  loop's own persisted state, and the checkpoint sits in the step that reaches a database. A run that
  was already composing its report therefore finishes it and answers — twice on 2026-08-12 it did,
  2.4 seconds after the Stop. That is the contract rather than a defect, so what changed in #356 is
  that the ending now says it: *"A stop was requested before this ending: the run took no further
  database step, and finished what it already had in hand."*
- **A run's stored rows do not outlive it**, so a report can outlive the rows its citations point at
  (`docs/BACKLOG.md` B15). A result opens in the grid, the explain view or the charts view — whichever
  the run's own record names — and cannot be exported from any of them, because Export writes the
  tab's own rows (B34).
- **An interrupted run is resumable but is not resumed on its own** — nothing enqueues a drive yet
  (`docs/BACKLOG.md` B9).
- **It reads what your connection's role can read.** The declared-target allowlist, the statement
  guard and the role's own grants are the whole boundary on out-of-scope reads
  (`docs/BACKLOG.md`, "Agent M1 deferrals", A3).

What it sends to your model provider, and what it does not, is a page of its own:
[`docs/AGENT_DATA_FLOW.md`](./AGENT_DATA_FLOW.md).
