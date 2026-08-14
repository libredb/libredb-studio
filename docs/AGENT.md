# Agent Runtime — LibreDB Studio

The agent runtime drives one **read-only database investigation**: a user states an objective, a
model drafts SQL against the connected database, repairs statements that fail, and composes a report
whose claims cite the results they came from.

Three properties frame everything below, and each of them is load-bearing rather than aspirational:

- **It appears only where it can actually run.** Availability is *derived*, not read off a flag: the
  agent exists when a model is configured through the existing `LLM_*` settings **and** the durable
  ledger has a writable path. Configuring a model is the opt-in, so a deployment that never sets a key
  never sees an agent, and one that does is never offered a Start that must fail — the discovery probe
  reports which condition is missing instead. `LIBREDB_AGENT_ENABLED=false` remains the explicit
  off-switch. With the agent unavailable no rail renders, no agent route opens a run, and the browser
  makes no agent request beyond the one-line discovery probe. What is *not* claimed: the rail's own
  components, the two hydration modules imported beside them, and the frozen policy constants they read
  are statically imported, so they sit in the standalone bundle either way. No agent **runtime**
  module — the ledger, the run service, the tool layer, the model adapter — is reachable from a browser
  at all.
- **It is standalone-only.** The embedded `@libredb/studio` package carries no agent surface, no
  agent type and none of the runtime's dependencies. See
  [Package boundary](#package-boundary).
- **It can only read.** Every database reach goes through the agent's own audited operation pipeline
  (`executeAuditedOperation`, `src/lib/db/operations/execution.ts:129`), under a read-only execution
  profile and the agent's own frozen execution policy. The agent cannot exceed what that policy
  already allows, and it has no second path to a driver. The pipeline is **not** shared with the
  rest of the application: `src/lib/agent/tools.ts:844` is its only production call site, and the
  editor's `/api/db/query` reaches the provider directly (`src/app/api/db/query/route.ts:44`).
- **Agent mode requires PostgreSQL or SQLite.** They are the only providers implementing
  `queryReadOnly` (`postgres.ts:870`, `sqlite.ts:397`); any other engine fails profiled acquisition
  with `PROFILE_UNSUPPORTED_BY_PROVIDER` (`src/lib/db/factory.ts:437`) and the run ends
  `engine-unsupported` (`src/lib/agent/runtime.ts:199`). Plan mode is toolless and reaches no
  database, so no engine restriction applies to it.

This document describes what the runtime *does*. The security matrix rows that cover it are 3.4 and
3.5 in [`docs/SECURITY.md`](./SECURITY.md) — both marked **Partial**, with the reasons stated there;
everything the runtime does **not** do yet is listed under
[Known limitations](#known-limitations) with the backlog entry that owns it.

Two companion pages carry what this one deliberately does not:

- [`docs/AGENT_GUIDE.md`](./AGENT_GUIDE.md) — **the user guide.** What a run is, the three
  workflows, what "answered" means, what the budget meter's numbers are, and how to run the agent on
  a local Ollama model. It describes the surface in the application's own words; this document
  describes the machinery under it.
- [`docs/AGENT_DATA_FLOW.md`](./AGENT_DATA_FLOW.md) — **what leaves the machine**, written from call
  sites: which message carries what, to which provider, where the fence applies and where it does
  not.

## Table of Contents

- [Turning it on](#turning-it-on)
- [What a run is](#what-a-run-is)
- [Durability and resume](#durability-and-resume)
- [The tool set](#the-tool-set)
- [What bounds a run](#what-bounds-a-run)
- [The model side](#the-model-side)
- [Whether the run answered](#whether-the-run-answered)
- [What the removed AI panels did that a run does not](#what-the-removed-ai-panels-did-that-a-run-does-not)
- [HTTP surface](#http-surface)
- [The surface in the app](#the-surface-in-the-app)
- [Deployment](#deployment)
- [Package boundary](#package-boundary)
- [Module map](#module-map)
- [Known limitations](#known-limitations)

## Turning it on

**There is nothing to turn on.** Availability is derived from two conditions, both checkable at
request time, and `GET /api/agent/config` reports which one is missing:

1. **A model is configured** — `validateConfig(resolveConfig())` from `src/lib/llm` does not throw.
   With the defaults that reduces to `LLM_API_KEY` being set.
2. **The durable ledger has a writable path** — for the `local` backend, the directory
   `WORKFLOW_LOCAL_DATA_DIR` names can be created and written. **For the Postgres backend this
   condition is not checked at all** (B31): the only way to check it is to open a connection, and
   this answers on every page load, so the probe accepts the backend on the strength of the variable
   alone. That is a carve-out, and it is reported as one — the probe's answer carries
   `ledgerVerified: false` there, so nobody reads `{"enabled": true}` as "a database was reached".
   With an unreachable `WORKFLOW_POSTGRES_URL` the rail still appears and the first Start still
   fails (see [HTTP surface](#http-surface)).

The owner ratified this in
[#331](https://github.com/libredb/libredb-studio/issues/331#issuecomment-5277689616), and the reason
is the removal that came with it: once the NL2SQL and Autopilot panels were gone,
`LIBREDB_AGENT_ENABLED` unset no longer meant *the agent is off*, it meant *the product has no AI at
all*. A boolean default-on was rejected for the opposite failure — it renders a rail in deployments
with no model key, where the first Start fails.

**The upgrade risk, stated plainly:** an operator who already had `LLM_API_KEY` set for NL2SQL gets an
agent without asking for one. That is why this ships in the same release as the removal, and why
`LIBREDB_AGENT_ENABLED=false` is documented as the sentence that follows.

The two server-side variables that remain are documented with their accepted values in
[`.env.example`](../.env.example). Neither is `NEXT_PUBLIC_`: the browser discovers whether agents
run by asking `GET /api/agent/config`, the same way it discovers the storage mode.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBREDB_AGENT_ENABLED` | unset (derive) | The explicit **off**-switch. `false`/`off`/`0` mean no agent even with AI configured — the supported way to keep the AI configuration and decline the agent. `true`/`on`/`1` are still accepted and mean the default; they cannot conjure a model, because an override that renders a rail whose Start must fail is the outcome deriving exists to prevent. An unrecognized value warns and is ignored. |
| `WORKFLOW_TARGET_WORLD` | unset (`local`) | Durable backend for run state. Exactly two values are accepted: `local` (zero-config, on-disk, **single instance**) and `@workflow/world-postgres` (opt-in, multi-replica, needs `WORKFLOW_POSTGRES_URL`). Anything else is **refused**, not defaulted. |
| `WORKFLOW_LOCAL_DATA_DIR` | unset — but the packaged artifacts set it: `/app/data/workflow` from the Helm chart and (from an app version later than `0.11.0`) the container image, `~/.libredb-studio/workflow-data` under `npx`. The SDK's own fallback, which those replace, is `.workflow-data` relative to the working directory. | Where the `local` backend keeps run state, and therefore the second condition above. See [Deployment](#deployment) — the SDK's fallback is wrong in a container and wrong under `npx`, so no artifact leaves it in force. |

The refusal is not pedantry. The workflow runtime reads that variable itself and treats any value
other than its own keywords as a **module specifier to `require()`**, so the allowlist in
`src/lib/agent/config.ts` is what stops a stray value from loading arbitrary code into the server —
and it is also what keeps the running backend equal to one of the two ratified ones.

One further variable is read but never set by you: `VERCEL_DEPLOYMENT_ID`. If a hosting platform
sets it and `WORKFLOW_TARGET_WORLD` is absent, the runtime would silently pick that platform's own
hosted backend, so the agent refuses to start until the backend is stated explicitly.

**Model configuration is the existing one.** The agent resolves its model through `src/lib/llm`'s
own resolution (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_API_URL`) — the same keys that used
to power NL2SQL, and the same resolution `src/lib/agent/config.ts` asks whether a model is configured
at all, so there is one answer rather than two that can disagree. There is deliberately no second
settings surface
and no agent-specific provider variable, and the provider packages' own ambient fallbacks
(`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_BASE_URL`) are explicitly neutralised so
an ambient key cannot authenticate a run against a provider nobody configured.

**"Configured" is a network-free check, and it has one blind spot worth naming.** `validateConfig`
requires no key for `LLM_PROVIDER=ollama` and defaults the URL to `localhost:11434`, so that
configuration reports the agent as available whether or not an Ollama server is actually listening.
Fixing it would mean issuing a request from a visibility probe that runs on every page load; instead
the model is reached where a run starts, and the capability gate (see
[The model side](#the-model-side)) is what refuses a model that cannot do the job.

## What a run is

A run is opened with a **mode**, a **workflow type**, an **objective** and a **connection
id**. Mode and workflow type are two independent axes and are deliberately never merged into
one field: a planning run of a query optimization and an agent run of one differ in what they
may **do**, not in what they are **for**, and a single field would have to enumerate the
product of the two (#325).

The mode is HOW a run executes:

- **`planning`** — the model reasons about the objective and produces a plan. Its tool set is
  **empty**, so a planning run performs zero database operations. This is decided on the server from
  the run's persisted mode; a client-supplied tool list has no way in, because there is no parameter
  for one.
- **`agent`** — the model receives the read-class tools below and investigates.

The mode is fixed when the run is opened. A later request cannot widen a planning run, and the
tool-selection function is re-checked at the execution seam, so a caller holding a tool context
still cannot execute a tool the selector would never have offered.

The **workflow type** is WHAT the run is for — `investigation` (the default),
`query-optimization` or `database-assessment` — and it is fixed at start for the same reason and by
the same mechanism. Both `selectAgentTools` and `verifyRunGoal` are functions of the run's own
persisted value, so there is no parameter through which a workflow could arrive twice, and no other
route accepts one. It is **optional in the request body**: omitting it opens an investigation, which
is what every run written before the field was.

Two properties are worth stating, because both are easy to assume the other way round:

- **Mode decides before the workflow does, and the two are still independent.** Planning is toolless
  whatever the run is for, so a workflow type is never a way to give a toolless run a tool, and never
  a way to hold it to a bar requiring evidence. It does still decide what the run is ABOUT: the
  system prompt states the workflow's objective in **both** modes and its tool rules only where there
  are tools, so a planning run of a query optimization — "how would you make this faster?" — is an
  ordinary thing to ask for. The rail offers the workflow control in both modes for the same reason.
- **The field is required on the record and optional on the ledger header.** The fold always
  produces a workflow type, so every reader has one and none has to know which generation of writer
  produced its run. A header without one folds to `investigation`, and that is a READING rather than
  a fallback: an investigation is the only thing this runtime could do when those ledgers were
  written. `tests/unit/lib/agent/ledger-compatibility.test.ts` asserts it against a REAL pre-change
  ledger — a run driven in a browser on 2026-08-12, copied out of `.workflow-data` verbatim — rather
  than against a hand-written approximation of one.

Composing claims that rest on something the run actually read is the baseline **every** workflow has
to meet. A template adds to that baseline rather than replacing it — see
[The query-optimization template](#the-query-optimization-template).

A run's **actor** — the session and role that opened it — is written into the run's own record at
start, and every later authorization decision reads it from there. Not from the request that resumes
the run, and not from the drive credential. That is why an agent run requires a server-resolvable
connection: a connection that exists only in a browser cannot be rebuilt by a process resuming
somebody else's run, and no credential is ever persisted (only the connection id).

Which connections qualify is decided in the browser before a run is opened, by
`resolveAgentRunConnectionId` (`src/hooks/use-connection-payload.ts`):

- an **admin-managed** seed connection — the server's copy is authoritative and the UI is read-only,
  so `seed:<id>` means the same database on every resume;
- the **editable copy of a seed** — what a zero-config deployment ships — but only while the copy
  still matches the descriptor the browser last fetched from the server. Every field deciding which
  database is reached and as whom is compared, the optional agent credentials included;
  presentation-only edits (name, colour, group, environment) do not disqualify it. Note what that
  sentence does *not* say: the comparison is against a snapshot, so an operator who repoints a seed
  server-side is not seen until the browser fetches again (`docs/BACKLOG.md` B23);
- nothing else. A connection the user typed in reaches the rail as unresolvable, and so does a seed
  copy edited to point elsewhere; the rail says so rather than opening a run.

The middle case is why this is a comparison and not a bare "has a seed id". The server resolves
`seed:<id>` to its OWN descriptor, so a run started on a copy the user had since pointed at another
database would investigate the seed and report on it as though it were the one on screen.

A run emits a closed set of **semantic events**, and they are the whole of what the UI renders:
`run-started`, `context-captured`, `statement-drafted`, `tool-invoked`, `tool-completed`,
`tool-refused`, `report-composed`, `closing-statement`, `run-finished`.

**`closing-statement` is the model's closing prose, and it is deliberately not a report.** It carries
no citations and claims none, which is why it has its own kind rather than a lenient
`report-composed`: a claim without evidence is inexpressible by design, and planning mode — which has
no tools and so can never produce evidence — could therefore never say anything at all. Its whole
output is one of these. An agent run's is an aside, except when it is the only thing the run left
behind, which is exactly when it is worth seeing. It is written only when the prose is non-empty.

**`run-finished` carries how the loop ended**, as `stopReason`: `report-composed`, `model-stopped`,
`cancelled`, `deadline-exceeded`, `model-timeout` or `turn-limit`. This is what separates *succeeded*
from *answered* — a run that stopped because the model composed a cited report and one that stopped
because the model had nothing more to say are both `succeeded`, and only this says which. The rail
reads it and states the difference. The STATUS word is deliberately not the thing that carries it —
[Whether the run answered](#whether-the-run-answered) is the field that does, beside the status
rather than instead of it (B24).

`stopReason` sits beside `reason`, which says why a drive died before or outside the loop. They
answer different questions and are mutually exclusive in practice; when both are present, `reason`
is the one a user reads, because a dead drive is the more specific account of an ending.

**What a `stopReason` MEANS depends on the mode**, and `model-stopped` is where the two part company.
In agent mode it is a shortfall: the model had a report tool and did not use it. In planning mode it
is the successful ending — planning is toolless, `compose_report` does not exist there, and stopping
once the plan is written is the only way a good planning run can end. The rail therefore words that
one ending per mode (#350); every other ending is a shortfall in either mode, because a planning run
that ran out of time produced no plan either.

## Durability and resume

A run has **no mutable row anywhere**. It *is* an append-only ledger on the durable backend, and the
record you read is a fold over that ledger — status, history, which steps settled, and whether a
cancellation is pending are all derived from the same ordered entries. A restarted process therefore
reads back exactly what the previous one wrote.

Two rules make a resumed run safe to re-drive:

1. **A tool invocation is recorded before its effect.** The service writes `tool-invoked` and waits
   for that write, then performs the effect. A reader — including a restarted process — always sees
   the intent no later than the effect.
2. **A step's identity is its effect.** A step id is derived from the tool name plus the arguments
   that reach the database, not from the model's prose rationale for them or a per-call id, so the
   same call asked for twice is the same step. A settled step is replayed from the ledger; a step
   whose invocation is recorded with **no outcome** is reported `indeterminate` and is *not*
   retried — that is the process-death window, and re-running it would be the duplicate execution
   this design exists to prevent. A resumed run may draft a *new* step; it may not repeat that one.

Starting a run and resuming one are the same call (`runInvestigation`): every drive begins by reading
the ledger and re-deriving state from it, so a fresh run is just the case where the ledger is empty.
A separate resume path would be a second implementation of "what has already happened", and the two
would drift.

Two honest qualifiers: the ledger check is read-then-append with no compare-and-append fencing, so
two loops driving one run concurrently would both execute (B5); and nothing currently *asks* for a
resume, so an interrupted run is resumable but is not resumed on its own (B9).

### A drive that dies before the loop

`runInvestigation` ends a run it entered, so every stop reason the loop owns is already on the
ledger. Everything *before* it is not part of the loop: the run's connection is resolved, its
capabilities are read and its model is built first, and a failure there — an unconfigured model
provider is the common one — used to unwind past the ledger entirely. The run stayed `queued` with
an empty timeline, its cause readable only in the server log, and with no drive producer (B9)
nothing would come back to it.

A drive that fails anywhere now records `run-finished` with status `failed` and a **classified
reason**:

| Reason | What happened | What the user does next |
| --- | --- | --- |
| `model-unavailable` | No usable model: unconfigured, or the provider could not be reached | Check the `LLM_*` settings |
| `model-rate-limited` | The provider answered, and refused on volume | Wait — this one clears itself |
| `model-unauthorized` | The provider rejected the credentials | Fix the key; retrying will not help |
| `engine-unsupported` | The connection's engine has no database-native read-only profile | Investigate a different connection |
| `connection-unresolvable` | The run's persisted connection no longer resolves server-side | Restore the seed, or start on another connection |
| `internal` | Anything else | Read the server log |

The split is finer than it first was, and the correction is worth recording: the model failures were
one label on the reasoning that every one of them sends a user to the same settings screen. A live
run disproved it. A free-tier quota was exhausted and the rail reported that the provider "is not
configured or could not be reached" — of a provider that was configured and had answered seconds
earlier. A quota is the only model failure that fixes itself, and it was the one described as a
misconfiguration.

Three properties are deliberate:

- **The reason is chosen from the error's type, never from its message.** That text is written by a
  model provider, a driver or a connection resolver, and none of them promise to keep a credential,
  a host name or an internal path out of it. The message stays in the server log; only the label
  crosses to the browser, where the rail renders one sentence this repository wrote for it.
- **`internal` is the honest default.** An unrecognised failure is not dressed up as a specific one.
- **A run that does not exist is not given a ledger.** A drive asked for an unknown run still
  refuses without writing anything, because recording a failure would manufacture the very record
  whose absence it is reporting.

Recording the ending is best effort and never replaces the error the caller sees: if the run ended
between the throw and the recording, or still has an execution in flight, `finish` itself throws —
that is logged, and the original failure is what propagates.

## The tool set

Four tools, and `agent` mode receives exactly these. Three of them reach the database, each through
`executeAuditedOperation` against a provider acquired under the agent read-only execution profile —
never the shared writable connection cache.

| Tool | Operation | What the model supplies |
| --- | --- | --- |
| `inspect_schema` | `sql.query.read` | An optional schema/table selector. **The server composes the SQL.** |
| `run_read_query` | `sql.query.read` | The statement (a bounded read). |
| `inspect_plan` | `sql.explain.estimate` | The statement to explain. The *estimating* form only. |
| `compose_report` | — | Claims and the evidence references backing them. Reaches no database. |

**An evidence reference is one object, and the model is told which** — in the tool description, in
the rules the run is opened with, and again each time an id changes hands:
`{"source":"artifact","correlationId":"…"}` for a result the run read, or
`{"source":"context-snapshot","fingerprint":"…"}` for the inventory it captured. Saying only that a
claim must cite is not enough: live runs reached the point of reporting knowing they had to cite,
holding the correlation id they needed, and spent their remaining turns guessing at the shape — one
run's ledger records the model asking itself whether an evidence item is "an array of table row
objects or strings?" and sending a statement with nothing to learn in it while it worked that out
(#350). The same words are also what a REFUSAL says: a model that got the shape wrong is the one that
most needs to be shown it. A server-composed citation is never a suggestion the model has to decode —
`composeReportTool` verifies every reference against the run's own event log and refuses a claim it
cannot resolve.

Two consequences worth stating:

- **A schema read is a bounded read.** There is no fourth operation descriptor for catalog access:
  the canonical set is exactly three operations, and a catalog read *is* a bounded read whose
  statement the server writes per dialect. The dialect asymmetry is real and documented on the tool
  — PostgreSQL yields a structured column inventory, while SQLite's `pragma_table_info()` is refused
  by the statement guard, so SQLite yields each object's own DDL text from `sqlite_master` instead.
- **The executing form of `EXPLAIN` is never offered.** The analyzing variant requires approval
  because it runs the statement; the tool exposed to a model is the estimating variant, and nothing
  in the run loop may convert a require-approval outcome into an allow.

### The query-optimization template

A run opened as `query-optimization` is offered **two further tools**, and no other workflow is. An
investigation that calls one is told there is no such tool, because for that run there is not.

| Tool | What it does | Reaches |
| --- | --- | --- |
| `compare_plans` | Records a before/after comparison of two estimated plans the run already inspected. The model supplies **only two artifact ids**. | Nothing |
| `recommend_change` | Records one index or rewrite for the user to apply. | Nothing |

Three properties carry the template:

- **The model points; the server reads.** `compare_plans` takes two correlation ids and nothing
  else. Which statement each plan belongs to comes from the ledger — `tool-completed` says which
  artifact a step produced, `statement-drafted` says what that step asked — so a comparison cannot
  attribute a plan to a statement that never produced it. The summary is derived from the stored
  plan by `plan-summary.ts`, not described by the model about its own work.
- **The summary carries no engine text.** A plan names tables and indexes, and those names are
  written by whoever can write to the database. What is recorded is structural — how the engine
  reaches the rows (`full-scan` / `index` / `mixed` / `unknown`) plus the estimates the engine
  reported. **SQLite reports no cost and no row estimate at all, so the summary carries none;** a
  zero would read as "free" and a guess would read as a measurement.
- **Everything is an estimate, and the rail says so rather than the model.** `EXPLAIN ANALYZE`
  executes the statement, so it is default-denied and no tool reaches it. The comparison entry
  therefore renders a sentence this repository wrote — *"Estimates only: these plans were described,
  not executed"* — instead of depending on a model remembering to mention it.

A recommendation is **never executed**. It reaches no database, no tool in this layer maps onto a
write, and the rail offers the statement to the editor on an explicit user action. The two refusals
`compare_plans` can produce are deliberately distinct: `UNVERIFIABLE_PLAN` means the model cited
something that is not an estimating plan of this run, while `PLAN_RESULT_RELEASED` means the citation
was honest and the rows have expired — telling a model the first when the second happened would send
it looking for a mistake it did not make.

Its goal verifier is `agent-query-optimization.2`: the investigation baseline, **and** evidence that
the change it proposes rests on what the engine actually does. The baseline dominates, so a run that
never reported is told that rather than that it skipped a comparison.

**That evidence has two shapes, because the two changes are not equally checkable (#356).** A
rewrite is held to the plan comparison: both of its plans are readable without changing anything. An
index's second plan is not readable at all — it would require the index to exist, and the run is
read-only by contract. A live run on 2026-08-12 diagnosed the scan, recommended the right index,
attempted `CREATE INDEX ...; SELECT ...`, was refused as it should be, and was then scored
`unanswered` by a rule asking for the one artifact that answer cannot produce. So an index answers on
the plan it **diagnosed**, cited by the recommendation itself: `no-plan-evidence` is an index
recommendation that names no plan this run read. Not merely a plan somewhere on the ledger — the
citation is what ties the index to the access path it changes.

### The database-assessment template

A run opened as `database-assessment` is offered one further tool, `profile_table`, and no other
workflow is.

**A profile records counts, never values.** That is the rule the whole feature is built around, and
it is what makes profiling a table of personal data acceptable at all: every statistic is an
aggregate — how many rows, how many present, how many distinct, how many match a shape — so no name,
address or account number is written to the ledger, shown to the model, or rendered in the rail. A
`min`/`max` of a text column would return an actual value, which is why neither is composed even
though both are conventional in a profiler.

| Depth | Adds |
| --- | --- |
| `basic` | Row count, and how many rows have a value in each column |
| `distribution` | Distinct counts |
| `pattern` | A shape test for personal data, counted with `count(CASE WHEN … LIKE …)` **inside** the database, so no matching value leaves it |

The model names a **table**, never columns and never SQL. The columns come from the run's own
captured inventory, so a profile cannot be aimed at something the run never established exists, and
an unqualified name is resolved against a qualified inventory only when exactly one table matches —
two schemas holding the same table name is precisely when a guess would profile the wrong one. **The
composed statement targets what was RESOLVED**, not the model's spelling: composing from the
spelling left PostgreSQL's `search_path` to decide which relation was read while the ledger said a
qualified one had been profiled.

A profile **settles a step**, like every other database reach: its invocation is on the ledger before
its effect, so it inherits the cancellation checkpoint, the replay of an identical call, and the
indeterminate-step rule. That matters more than it looks — three separate consumers read
`tool-completed` and nothing else (a report's citation check, the artifact route's authorization, and
the rail's budget meter), so a profile that settled no step would be citable in a report whose "Show
result" answered 404, on a meter reading zero.

One profile covers a bounded number of columns, and says how many it did **not** cover. A wider table
is profiled in further calls with `fromColumn`; without that, columns past the bound could never be
assessed while the run still counted as having profiled the table.

A column whose declared type has no equality operator — `json`, `jsonb`, `xml`, the geometric
types — gets no distinct count. One such column would otherwise abort the whole aggregate
(`could not identify an equality operator for type json`) and take every other column's statistics
with it.

The findings are the **server's**, each a mechanical predicate over counts with a stated threshold:
`high_null`, `constant`, `low_cardinality`, `suspected_pii`, plus `fk_unindexed` derived from the
inventory rather than the numbers. A model may interpret them; it cannot invent one.

`suspected_pii` is a suspicion and says so — read from the column's **name**, and at `pattern` depth
from the **ratio** of values matching a shape. Neither establishes that a column holds personal data;
both establish that it is worth a human looking.

Its goal verifier is `agent-database-assessment.1`: the investigation baseline, **and** a table
actually profiled. An assessment written from the schema alone describes the shape of a database;
this workflow is about the state of its data.

**Profiling reaches the database through a fourth operation descriptor** (`sql.table.profile`, R1),
and that is a reversal of a product decision rather than an oversight: epic #325 pinned the canonical
set at three and #330 T3 reopened it. Its own id is what lets an operator see profiling in the audit
stream, and deny it, without denying every read the agent makes.

Four honest limits, each with a backlog entry: SQLite hides constraint-created indexes so
`fk_unindexed` can fire on a covered key (**B25**); only an email shape is tested, because `LIKE`
cannot express a digit run (**B26**); no monitor snapshot is produced, because engine health reaches
provider methods no descriptor covers (**B27**); and a profile that times out reports the failure
rather than falling back to catalog statistics (**B28**).

### What the fence is proved to hold against

`untrusted-content.ts` fences database content; `tests/evals/injection.test.ts` is what proves the
fence holds. Every vector there is text **an attacker can write** — a table name, a column name, a
row value, an engine error message — carrying the closing marker and an instruction, which is the
text-level version of SQL injection.

The property is asserted by counting rather than by sampling: **a transcript holds exactly as many
closing markers as the server opened**, whatever the database returned. Markers inside content are
neutralised and stay legible, because the content is evidence and a silently edited result would make
what the model reads disagree with the rows the artifact store holds.

The other half is that obeying the injected text changes nothing about what the run may do: a write
is refused by the statement guard before the database, a tool the run was never offered does not
exist for it, and a claim citing something the run never read cannot be composed. Each is asserted
against the deciding function in `tests/unit/agent-policy-gates.test.ts`, which states the four
policy gates by name — planning performs zero database operations, nothing above risk class 1 can
execute, a settled step is never executed twice, and every final finding carries a citation.

**One open risk, found by these fixtures and recorded as B29.** An identifier the model quotes back
into its own tool arguments reaches the transcript **unfenced**, because an assistant message is the
model's words rather than the server's — and an attacker who can name a table controls the whole
identifier, so they control the marker *and* arbitrary text after it. This is an open injection path,
not a bounded one; the surrounding JSON does not make that suffix safe.

What is true, and is a different claim: **the server never hands the model the raw marker.** Every
server-authored path neutralises it first, so a model reading a hostile inventory sees the defanged
spelling and has nothing to copy. For the raw marker to reach an assistant message the model has to
reconstruct it. Both halves are asserted — that the fenced inventory carries no raw marker, and that
the transport does not prevent one if the model produces it anyway.

**Database content is untrusted input.** A table name, a column comment, a row value and an engine
error message all come from whoever can write to the database, so everything crossing into a prompt
is fenced first: a header naming what the content is and where it came from, and a stated boundary
the content cannot forge. This is the same firewall the maintainer loop applies to public issue text.

**A notation the server writes needs more than a fence** (`er-diagram.ts`). The relations block turns
the inventory's foreign keys into a graph, and a fence around it says only where the server stopped
talking — it does nothing about a table literally named `orders -> secrets`, which would produce a
line reading as a relation nobody has. So every identifier in that notation is **quoted** and its
delimiter doubled as SQL does it, and every control character is escaped: without that, a name
carrying a newline became a second line, and "a relation is a line" is what the whole reading rests
on. It is a relation list rather than Mermaid for the same reason — `||--o{` is far easier to forge
than a quoted pair, and a diagram drawing a relation the database does not have is worse than none.
Two further rules follow from the same principle rather than from formatting: a pairing this
inventory cannot know is **not invented** (several edges between one pair of tables may be separate
keys or one composite key returned as a cross product, B8, so the group is one line that names the
columns and says the pairing is unknown), and the block is bounded in **characters**, because a
count of edges is not a bound on a prompt.

## What bounds a run

The frozen execution policy (`src/lib/agent/execution-policy.ts`, version `agent-read-only.1`) is
data the pipeline enforces, and the tool layer reads it directly rather than accepting one from a
caller — an injectable policy would be a seam through which a route or a resumed run could widen the
agent's privileges.

| Bound | Value | Counts |
| --- | --- | --- |
| `maxStatementsPerRun` | 20 | Every statement, including catalog reads and repairs. |
| `maxTotalRunMs` | 60 s | **Database time only.** |
| `statementTimeoutMs` | 10 s | Per statement, clamped further by the run deadline. |
| `maxResultRows` / `maxResultBytes` | 200 / 256 KiB | Compared after the driver has materialised the rows, so an oversized read is refused but still paid for at the database. |
| `maxConcurrentExecutions` | 1 | The loop is sequential; a run cannot fan out. |
| Run deadline | 300 s | **Wall clock**, including model latency. |
| One model call | 90 s | Whichever of this and the run's remaining time is smaller applies. |
| Repair attempts | 3 | Statements that failed **at the database**. |
| Model turns per drive | 16 | A backstop for a loop that never reaches the database. |

**The per-call ceiling exists because the run deadline used to be the only bound on a single
request.** A measured run ended at exactly 300.0 s with a two-event ledger: one call never answered
and spent a budget meant to cover a whole investigation, while the rail showed nothing moving for
five minutes. Turns on this workload land in seconds, so a call that reaches 90 s is not coming back.
The two bounds stay distinct in what they report — `model-timeout` says a request never returned and
starting again is reasonable; `deadline-exceeded` says the run used its time — and when less than the
ceiling remains, the run's own reason is the one given.

**The run deadline** is a monotonic per-run clock with an injected time source, and it answers two
questions before every call: may this call start (`INSUFFICIENT_TIME_REMAINING` if its minimum
viable duration no longer fits, `RUN_DEADLINE_EXCEEDED` if the run is simply over), and how long may
it run — `statementTimeoutMs` is clamped down to the time actually remaining, so the timeout handed
to the execution layer can never exceed what is left of the run.

What that clamp is worth depends on the engine, and this is the one caveat a budget meter must not
hide: **PostgreSQL preempts an overrunning statement (`SET LOCAL statement_timeout`); SQLite does
not.** There the timeout is a post-execution deadline, so an overrunning SQLite statement is
detected after it finishes rather than being stopped mid-flight, and because the drivers are
synchronous it blocks the runtime while it runs. The rail states this where the meter is shown.

**The repair loop is bounded twice, and the two bounds are different.** A statement that already
failed is never admitted again — keyed on a canonical fingerprint built from the shared SQL span
readers, so whitespace, comments, a trailing terminator and keyword case all normalise away while a
literal's exact spelling is preserved. Separately, at most three statements that failed *at the
database* may be repaired. **A policy denial does not consume a repair attempt**: nothing ran, a
boundary decision is not a defect in a statement, and a denial travels to the model as its own kind
of outcome — the refusal union has no readable engine-text field for the policy variant at all, so a
denial cannot be re-fed to the model as though the SQL were malformed.

## The model side

`src/lib/llm`'s provider contract is text streaming plus config validation — it has no tool-calling
surface — so the agent drives the ratified AI SDK provider packages instead, through one adapter that
turns the configuration resolved by `src/lib/llm` into an SDK model and maps SDK failures back onto
this repository's existing error classes.

The registry is a total `Record` over the settings surface's own provider union, so adding a provider
kind to `src/lib/llm` stops the agent compiling until its adapter exists. The kinds served today are
Gemini (the repository default), OpenAI, Ollama and OpenAI-compatible custom endpoints — the last two
through the OpenAI provider's configurable base URL. Anthropic is installed and ratified but not
offered, for a reason that is about the chat surface rather than the agent (B2).

A **capability probe** exists to establish, positively, that a configured model calls tools, honours
the schema its tool arguments are declared against, and streams. It reports only what it observed on
the wire — there is no capability table keyed on model names, because for `ollama` and `custom` kinds
the model is whatever the operator is serving — and a failure that says nothing about the model (a
bad key, a quota, a 5xx) reaches no verdict at all.

**The start path consults it before opening an agent run** (`capability-gate.ts`), and four decisions
shape what that costs:

- **Planning runs are not probed.** That mode is toolless by contract, so tool calling is not among
  the capabilities it needs.
- **Only an established incapability refuses**, with `422` and the probe's own sentence. Everything
  the probe merely failed on starts as before, so the start path gained no new way to fail — and since
  a drive now reports `model-rate-limited`, `model-unauthorized` or `model-unavailable`, those runs
  say what happened rather than sitting at `queued`.
- **Positive verdicts are cached for the life of the process; refusals are not.** A model that called
  a tool keeps calling tools, so that round trip is paid once. A refusal is re-probed because an
  operator can fix the server without changing the model id — an `ollama` endpoint serving something
  else under the same name — and re-probing costs a round trip only to someone whose runs are already
  failing.
- **The cache key is the model's identity**, so a configuration change misses it by construction:
  there is no invalidation hook to forget and no TTL to tune.

### What a refused model looks like in the app

The `422` carries the probe's sentence as `error`, the shortfall as `missing`, and what the probe
watched fail as `disproved` — all in the identifiers `toolCalling`, `structuredOutput`, `streaming`.
The rail reads the STATUS, not the words, to tell this apart from every other refused start, and
renders a state of its own rather than the generic error line: what the probe could not establish, in
this build's own labels; the server's sentence, which is the only place the model's name and the
endpoint's own words appear; and what is still worth trying. A name this build has no label for is
dropped rather than shown, because our field names are not the user's vocabulary — the labels live in
`capability-labels.ts` so the sentence the server writes and the list the browser renders cannot drift
apart, and so the rail can name a capability without importing the AI SDK into the page.

**`missing` and `disproved` are not the same fact.** `missing` is what this run needed and did not
get, which is all a refusal needs; `disproved` is the half the probe actually observed failing. They
come apart most sharply on streaming. An endpoint that refuses the tool request answers with a status
before any stream exists, so streaming is *unobserved* — on 2026-08-13 an `ollama` endpoint serving
`gemma3:270m` refused exactly that way and the same model then drove a planning run to `succeeded`. An
endpoint that ignores `stream: true` and returns one buffered body has been *watched* not streaming:
the SDK's SSE parser finds no frames in it, nothing the model did is readable, and a planning run over
it — driven through the real run loop — ends `succeeded` with empty text and writes no closing
statement. Both produce `missing: ["toolCalling", "structuredOutput", "streaming"]`. Only `disproved`
separates the model that can still plan from the endpoint that will answer nothing at all.

**A verdict is about one mode**, and the rail shows it only over that mode. The gate admits planning
on its first line, so a refusal is a statement about the agent run that was asked for and about
nothing else; a refusal raised for one mode left standing over the other would be the rail asserting
what the server never said. The mode travels with the verdict (`AgentModelRefusal.mode`) rather than
being assumed.

**#325's ratified fallback is superseded** (#331 T4). That epic decided a model failing the probe
"falls back explicitly to chat/NL2SQL"; T2 removed NL2SQL and T3 removed the in-editor chat, so
neither destination exists. What that reading missed — and what the rail wrongly told users for the
length of one review cycle, as "There is nothing toolless to fall back to" — is that a toolless
surface DID survive T2 and T3: this rail's own planning mode. It is never probed, so it is REACHABLE
with exactly the model that was just refused, one click away in the same panel — which is not the same
as it working, and the next paragraph is about the difference.

So the state is not a dead end and no longer claims to be. It says the model cannot drive an AGENT run
and which capabilities the probe could not establish; that plan mode needs no tools and **may** still
work, offering a control that SELECTS that mode and starts nothing; and that a different model is what
buys a run that reads the database. Offering is honest and deciding is not — the same rule T1's
shortcut follows, for the same reason: a click that spent model budget would be a different feature.
What plan mode cannot do is left plainly stated rather than implied, because a toolless run reaches no
database and a user pointed at it deserves to know that before they ask.

**The offer is an invitation, not a guarantee, and it is withdrawn where the probe contradicts it.**
Admission without probing is not proof of compatibility: the gate skips planning because planning
needs no tools, which says nothing about whether this endpoint would serve a toolless request. So the
copy says "may still work" and asks the user to try it — and where `disproved` names `streaming`, the
offer is not made at all. A planning turn consumes the same `streamText().fullStream` an agent turn
does (`investigation.ts`), so an endpoint watched answering without a stream would produce a run that
reports `succeeded` and contains nothing; pointing a refused user at that is a second, quieter
failure. The state says so instead, and names an endpoint that streams alongside a different model as
the way out. The alternative — teaching the loop to read a buffered body — was rejected: the SDK
discards it before the loop sees anything, so tolerating it means a second, non-streaming path through
the run loop for the sake of an endpoint that ignores the protocol it was asked to speak.

None of this is an argument from the code. On 2026-08-13 an `ollama` endpoint serving `gemma3:270m`
refused an agent start with exactly that `422`, and the same model then ran a planning run to
`succeeded` in the same rail, on the same connection and the same objective, one click later; and a
planning run driven over an endpoint that answers a streamed request with one buffered body produced
the empty `succeeded` run described above.

## Whether the run answered

Everything above describes a run that *ran*. Whether it **answered** is a different
question, and for one milestone nothing asked it: on 2026-08-12 nine consecutive runs
against a real model produced zero reports (#341) while every gate this repository owns
stayed green — the unit suites passed, line coverage was 100%, and the rail rendered a
timeline for each one. Nothing was broken. The code ran correctly, and no requirement
said a run has to answer, so nothing looked.

`stopReason` closed half of it. `verifyRunGoal` (`src/lib/agent/goal-verifier.ts`) closes
the other half: a **pure fold over the ledger** that returns an outcome, the id of the rule
that produced it, and what the run was required to produce and did not.

The rule is chosen by the run's mode first and its workflow type second, from total records —
`AGENT_WORKFLOW_VERIFIERS` names one rule per workflow, so a workflow added to the contract stops the
build until somebody decides what "answered" means for it.

| Mode | Rule (`agent-planning.1` / `agent-investigation.1`) | Unmet when it fails |
| --- | --- | --- |
| `planning` | The run left non-empty closing prose. That mode is toolless and can never cite evidence, so judging it by the investigation rule would fail every planning run that did its job. | `no-plan` |
| `agent` (investigation) | The run composed at least one claim, **and** the claims do not rest entirely on empty results. | `no-report`, `empty-evidence` |
| `agent` (query-optimization) | The baseline above, **and** either a plan comparison on the ledger or an index recommendation citing a plan this run read. `agent-query-optimization.2`. | the above, plus `no-plan-comparison`, `no-plan-evidence` |
| `agent` (database-assessment) | The baseline above, **and** a table profiled. `agent-database-assessment.1`. | the above, plus `no-table-profile` |

A run stopped by its user reports `cancelled` instead of the missing output: a stop is not
a defect of the run, and counting it as one would make every cancellation read as a model
that would not answer.

**The second rule is the one that needed building.** A run that reports `0 rows` as its
finding carries a valid `report-composed` entry, citations that verify against its own
ledger, and `stopReason: report-composed` — it is identical to a run that answered in
every field this ledger had. That equality is asserted directly in
`tests/evals/strategy-defects.test.ts`, so if the two ever start to differ somewhere else,
a test says so.

Two honest limits, both deliberate:

- **`empty-evidence` is mechanical, and has to be.** Whether a model "stated uncertainty"
  about an empty result is a judgement about prose, and a verifier that read the model's
  own words to decide whether the model answered would be grading the answer with the
  answer. What is checked is what the claims **rested on**, which is a fact about the run.
  A citation the ledger cannot resolve is skipped rather than assumed empty.
- **The verdict is on the ledger, beside the status rather than instead of it** (B24, ratified
  2026-08-13). `run-finished` carries an optional `goalVerdict`, written by
  `AgentRunService.finalize` — the one method every terminal path goes through, including the
  cancellation checkpoint that ends a run without returning to the loop. The status vocabulary is
  unchanged, because the two axes are independent: a run can end `succeeded` having answered
  nothing, `failed` having answered nothing, or `failed` with no verdict meaningful at all because
  the drive died before the loop. The first two were both observed on live runs. A ledger written
  before the field folds unchanged, and its absence means what is true of it: no verifier ran.
  That third shape writes the absence **deliberately**: a run still `queued` at its ending never
  entered the loop, and calling it "did not answer" would judge a run that was never given the
  chance to. Its failure reason speaks alone.

### The eval harness

`tests/evals/` is where model behaviour is exercised, because a requirement about model
behaviour can only be enforced by something that exercises model behaviour.

- **The model is the real ratified provider package over a scripted `fetch`**
  (`tests/isolated/fixtures/agent-scripted-model.ts`), shared with
  `tests/isolated/agent-investigation.test.ts` rather than duplicated. A stubbed model
  proves the loop calls what it calls; it cannot prove the transcript the loop builds is
  one an SDK will actually send — which is exactly what a resumed run rebuilds.
- **Scenarios assert against ledgers, not prose.** The one earlier test that touched this
  asserted the model's text was returned to the *caller*: a correct test of the wrong
  thing, because a user reads the ledger.
- **A "restart" is a genuinely second set of in-memory objects** over the same durable
  directory, so a resumed run can only know what the previous one wrote down.
- **The database is scripted**, on both reference engines. These scenarios measure model
  strategy; a real engine would make the same scenario answer differently on two machines.
  `tests/isolated/agent-investigation-e2e.test.ts` is where real engines are driven.
- **A scripted engine's answers must agree with the inventory that same run handed out, and
  with each other.** A world that contradicts itself measures the contradiction: three
  real-model cases answered every question with the same three department rows against an
  eight-table inventory, and all three spent every turn they had disbelieving it — 16 turns,
  no report, on 2026-08-14. A scripted model never notices, because it does not read the
  inventory; that is precisely why the rule has to be written down rather than discovered.
- **A case may add a bar the ledger cannot express, and then it says what that bar can see.**
  `empty-result` is the one: a COUNT of missing rows comes back as one row saying zero, which
  is what an engine returns, so `empty-evidence` — every cited result empty — cannot fire on
  a run that reports `0` as its finding. The case judges what its claims RESTED on: it passes
  only a report citing a statement that READ the target table without asking for the unnamed
  rows, and names the three ways that fails — `snapshot-not-population` (every claim rested on
  the captured inventory, which says the table exists and never how many rows are in it),
  `zero-as-finding` (the null-predicate read alone) and `probe-not-population` (`SELECT 1`,
  which a live model really did send). Every widening of what counts as evidence is a step
  back toward the escape hatch, so the bar states its blind spots where it is defined: like the
  verifier it reads no prose, and it cannot see which column a cited read touched or whether
  the model understood it. `tests/evals/empty-result-detection.test.ts` drives that case's own
  world with scripted models, so what it can catch is asserted without spending a model call.

The defect corpus in `tests/evals/strategy-defects.test.ts` is every strategy failure #341
observed, and each one was made to fail before it was made to pass — a harness that cannot
fail on a known defect is not measuring anything.

**Real-model evals are a scheduled or manual job, never PR CI**
(`.github/workflows/agent-eval.yml`, `bun run agent:eval`). Their verdict is not a function
of the code under review, a fork PR cannot see the credential, and the reference model's
free tier is 15 requests per minute — a morning of manual testing exhausted it. A rate
limit is reported as a rate limit rather than counted as a failed case.

## What the removed AI panels did that a run does not

M4 removed the NL2SQL panel, the AI Autopilot panel and the in-editor AI chat (#331 T2 and T3) on the
argument that the agent covers what they did. Half of that argument is now a measurement:
[`tests/evals/legacy-surface-coverage.test.ts`](../tests/evals/legacy-surface-coverage.test.ts) drives
both panels' happy paths through the run loop and asserts them against the ledger. A plain-English
question becomes a drafted statement with its reason recorded, one executed read, and a claim citing
the artifact that read produced; "tell me what is wrong with this database" becomes a
`database-assessment` run whose findings are the server's own — a null ratio counted inside the
database, and an unindexed foreign key read off the inventory the run captured.

The other half is this list, and it is here rather than in a pull request comment: an uncovered
scenario is the reason somebody kept a surface, so it is a finding rather than a footnote. Each row is
a capability a user had before M4 and does not have now.

**The first two rows are the largest losses, and they are the two that bound every row under them.**
Both facts are stated elsewhere in this document — the agent is standalone-only, and a model that
cannot call tools is refused — but a section whose stated purpose is to list what a user lost was
listing neither, and they are exactly the reasons somebody would have kept a surface. Where a row
below says what a run does instead, read it as what a run does instead **for a standalone user whose
model passed the capability probe**; for anybody else the answer is that there is no run.

| What the panel did | What a run does instead | Where that is established |
| --- | --- | --- |
| **Any AI at all, for an EMBEDDED user** — one working panel and one exported component, which is less than "both tabs worked". The embedded shell rendered both TABS regardless of `features.ai`, and only Autopilot was behind them: `AIAutopilotPanel` had no feature gate, so a libredb-platform user had a fully working Autopilot panel posting to `/api/db/monitoring` and `/api/ai/autopilot` on the HOST's origin. The NL2SQL tab rendered an EMPTY PANE under the default `features.ai: false` — the shell passed `isOpen={features.ai ? isNL2SQLOpen : false}` and the panel returns `null` when it is not open — so what an embedded host lost there is `NL2SQLPanel` itself, exported from `@libredb/studio/components` for a host to mount on its own, plus the tab for a host that had switched `features.ai` on. | Nothing. The rail lives in the standalone shell only; the package carries no agent surface, `WorkspaceFeatures` deliberately gained no agent field, and no package entry point transitively imports `src/lib/agent`. For an embedded user every "what a run does instead" cell below is false, because there is no run. | The removal itself (`5bbea51`, which deletes the export, both render arms and the flag), read against the code it deleted: `git show 5bbea51^:src/workspace/StudioWorkspace.tsx` (the two `features.ai ?` props), `git show 5bbea51^:src/components/NL2SQLPanel.tsx` (`if (!isOpen) return null`), `git show 5bbea51^:src/workspace/types.ts` (`DEFAULT_WORKSPACE_FEATURES.ai: false`); `tests/unit/agent-package-boundary.test.ts`; [The surface in the app](#the-surface-in-the-app). |
| **A TOOLLESS model drove both panels.** Each posted a prompt and rendered what came back, so any configured model produced an answer — including one that cannot call a tool, which is what a small local `ollama` model usually is. | An agent run is refused before it opens: the start path probes the model, and an established incapability is a `422` naming what could not be established. What such a model can still drive is planning mode, which is toolless by contract and therefore reaches no database at all. | `src/lib/agent/capability-gate.ts`; `tests/isolated/agent-capability-gate.test.ts`; [What a refused model looks like in the app](#what-a-refused-model-looks-like-in-the-app). |
| **One click that RAN the model's SQL.** NL2SQL's Run and Autopilot's Execute pushed model-authored SQL — including DDL — straight into the studio's execution path. | The rail hands a statement to the **editor** and never runs it: an explicit "Apply to editor" on a drafted statement or a recommendation. Nothing in the runtime executes a proposed statement. | `src/components/agent/timeline.ts` — the `statement-drafted` and `recommendation` entries carry `applySql`; `tests/evals/query-optimization.test.ts` — the recommendation is recorded and no `CREATE INDEX` reaches the database. |
| **Proposed a statement the run never sent.** NL2SQL's product was a statement, whatever the model wrote. | Only `recommend_change` proposes an unexecuted statement; it accepts `index` or `rewrite`, the statement must match the card it is filed under, and it belongs to the `query-optimization` workflow. An investigation — what a plain-English question opens — cannot propose anything. | `src/lib/agent/tools.ts` (`recommendationSchema`, `matchesCard`, `QUERY_OPTIMIZATION_TOOLS`); `tests/evals/legacy-surface-coverage.test.ts`. |
| **Read live monitoring.** Autopilot's whole input came from `/api/db/monitoring`: slow queries, index usage, table statistics, cache and connection metrics. | No tool reaches any of it. `AgentToolName` has seven members and the closest, `profile_table`, composes counts over one table. **B17**, **B27**. | `src/lib/agent/tools.ts`; `tests/evals/legacy-surface-coverage.test.ts` — the seven members and the three operations they may name are asserted as a set, so a monitoring tool under ANY name fails it; a model that asks for one anyway is told there is no such tool and sends no statement of its own. |
| **A free-form markdown report**, opening with a performance score out of 100 and closing with configuration advice. | A report is claims, each citing an artifact this run read or the snapshot it captured, verified against the run's own ledger before it is recorded. A number cited to nothing cannot be reported — the citation is what is checked, never the claim's text, so a fabricated score citing a real artifact would be accepted. | `src/lib/agent/tools.ts` (`composeReportTool`); `tests/evals/legacy-surface-coverage.test.ts` — an invented correlation id is refused and the run ends `unanswered (no-report)`. |
| **Maintenance tasks** — `VACUUM`, `ANALYZE`, reindexing — in the same report. | Nothing proposes them: the `change` card has two members and neither is maintenance. It stays where it was before the panels — the monitoring surface, and the user's own editor. | `src/lib/agent/tools.ts` (`recommendationSchema`). |
| **Multi-turn conversation.** NL2SQL replayed the whole exchange on every request, so "and how many in the second one?" was answerable. | A run's objective is fixed when it starts and no ledger event records a later question. A follow-up is a NEW run: it re-reads the catalog and knows nothing the first one established. | `src/app/api/agent/runs/route.ts`; `src/lib/agent/types.ts` (`AgentRunEvent`); `tests/evals/legacy-surface-coverage.test.ts`. |
| **MongoDB, MySQL and every other engine.** Both panels ran against whatever the connection was, and NL2SQL emitted Mongo query documents when the connection's query language was JSON. | The agent serves **two** dialects. `CATALOG_COMPOSERS` and `CATALOG_PLANS` carry `postgres` and `sqlite` only, and an unlisted dialect is refused rather than guessed at. Nothing refuses the run at its start, so a run opened on another engine begins, captures no schema, and is told no schema inventory can be read for that connection type. | `src/lib/agent/composed-sql.ts`, `src/lib/agent/context-snapshot.ts` (`captureContextSnapshot`); `tests/unit/lib/agent/context-snapshot.test.ts` — a `mysql` connection reaches no database; `tests/unit/lib/agent/composed-sql.test.ts` — `UNSUPPORTED_DIALECT`. |

Two of these are tracked as deferrals with what it would take to close them (B17, B27), and the first
row is Phase 1's own boundary rather than a defect (B21 is its one residual). The rest are consequences
of the removal rather than work in progress: they are what the product decided not to do, and that
decision is only honest while they are written down where a maintainer will find them.

## HTTP surface

Six paths under `src/app/api/agent/`, seven handlers — documented request-by-request in
[`docs/API_DOCS.md`](./API_DOCS.md#agent-api), in the shape every other route family there uses.
Each verifies authorization in its own handler
(middleware is an optimisation, not the authorization boundary) rather than trusting the request. The
five run-reaching handlers verify a **session** and answer **404** when the agent is unavailable —
after the session check, so an unauthenticated caller cannot learn whether an agent surface exists —
and are metered out of the same `ai` rate-limit bucket as the other model routes. The two exceptions
are deliberate: the config probe answers `200 {"enabled": false, …}` when the agent is unavailable,
because that *is* its answer, and the drive route verifies a machine credential instead of a session.

**The two halves of the availability answer are split across those handlers on purpose.**
`isAgentRuntimeEnabled()` is synchronous — five call sites read it inside request handling — so it
answers the off-switch and the model configuration, neither of which needs I/O. The ledger's writable
path is I/O, and only the config probe is already async and already forbidden from failing on a
misconfiguration, so that is where the whole answer is composed. The consequence is stated rather than
hidden: a server with a model but an unwritable ledger keeps its agent routes, and a run fails when
the world is built — which is where a filesystem error can be reported as itself. The rail still stays
absent, because the browser asks the probe.

**What green from the ledger probe promises, stated exactly.** The probe runs the same four steps as
`@workflow/world-local`'s own `ensureDataDir` — create, read-check, write a probe file, remove it —
so a green answer means *that* check will pass. It does **not** mean the world will build: the world
calls `initDataDir`, which runs a fifth step the probe does not, reading and parsing `version.txt` in
an existing ledger. A corrupt or incompatible one throws there, after the rail has already been
rendered, and the first Start is where the operator meets it (B30).

| Route | Purpose |
| --- | --- |
| `GET /api/agent/config` | Whether this server runs agents, and if not, which condition failed: `{"enabled": true, "ledgerVerified": …}` or `{"enabled": false, "reason": …, "detail": "…"}`. The reason is one code per operator action — `OPERATOR_DISABLED`, `NO_MODEL_CONFIGURED`, `LEDGER_UNAVAILABLE`, `UNSANCTIONED_WORLD_TARGET`, `IMPLICIT_HOSTED_WORLD`. The last two are backend refusals and keep their own codes deliberately: neither is a disk problem, and `IMPLICIT_HOSTED_WORLD` fires before anything is asked of a filesystem at all. `ledgerVerified` distinguishes the two kinds of yes: `true` after the writable-path probe passed, `false` for the Postgres carve-out, where the backend is accepted without being contacted (B31). Session-verified. `enabled` is a literal boolean because the rail compares `=== true`. `reason` goes to every session — it names an operator action and no path — while `detail` goes to **admin sessions only**, because `LEDGER_UNAVAILABLE`'s detail carries an absolute server path and an OS error string; every other session gets one stable sentence instead, and loses nothing, since the rail renders nothing when the answer is no. Never 500s, and never names a key's value. The ledger half of the answer is memoised for a few seconds, in-flight promise included — the route sits outside the `ai` rate-limit bucket on purpose, so the memo is what stops an authenticated caller turning a page-load probe into a write per request, including a burst that arrives while one probe is still running. |
| `POST /api/agent/runs` | Opens a run (mode, optional `workflowType`, objective, `connectionId`) and returns `202` with the run id and the PERSISTED mode and workflow type. An unrecognised `workflowType` is refused rather than defaulted. An inline connection in the body is refused. An agent run whose model was established as unable to call tools is refused `422` before any run is opened. |
| `GET /api/agent/runs/{runId}` | The run record, folded from its ledger. |
| `DELETE /api/agent/runs/{runId}` | Requests a stop. Cancellation is enforced by the run loop's own persisted state, not by a driver cancel propagating — so this is "asked to stop", not "has stopped". |
| `GET /api/agent/runs/{runId}/stream` | The ledger as NDJSON, one entry per line. |
| `GET /api/agent/runs/{runId}/artifacts/{correlationId}` | One stored result of that run, for hydration. |
| `POST /api/agent/drive` | The machine-facing resume seam. |

**`src/proxy.ts`'s public-path list is unchanged, and a test asserts that.** The drive route is the
only route reachable without a user session, and it is not exempt from the middleware: it carries a
short-lived, single-purpose credential this server minted, verified by the middleware and again by
the handler. That credential names one run and authorizes one thing — driving it. It is not a
session, carries no user and no role, and its signing key is *derived* from `JWT_SECRET` rather than
being it, so a drive token cannot be presented as a session cookie. A run driven through it still
acts as the actor its own ledger records.

Nothing produces a drive delivery yet (B9), so the route's callers today are its tests. The seam
exists now because it had to be designed with the boundary rather than bolted on afterwards.

## The surface in the app

The agent rail lives in the **standalone shell only** (`src/components/Studio.tsx`), inside the
existing horizontal panel group, resizable, and below `md` it opens as a sheet like the rest of the
mobile layout. Visibility is discovered at runtime from `GET /api/agent/config`: with the agent
unavailable nothing renders and no further agent request is made. The hook reads `body.enabled ===
true` and nothing else — a refusal, an unreachable server, a body of another shape and the richer
`{enabled: false, reason, detail}` body all resolve to absent. The rail is imported statically, like
every other component in this repository, so the six client modules under `src/components/agent/` and
`src/hooks/use-agent-capability.ts` — plus `execution-policy.ts`, whose ceilings the meter reads as
values — are in the standalone bundle either way; what availability governs is what renders and what
runs, not what was bundled.

The rail shows the run's semantic timeline, a stop control, evidence citations, and a budget meter.
What each of those says to a user, in the words it actually renders, is
[`docs/AGENT_GUIDE.md`](./AGENT_GUIDE.md). Two rules govern it:

- **A control the service cannot honour is not rendered at all.** There is no disabled-looking button
  standing in for a capability, which is why the rail stops a run but does not offer pause/resume
  (B11).
- **The meter reports only what is actually enforced** — statements, database time, the run deadline,
  repair attempts — and states the SQLite non-preemption caveat rather than implying that an
  overrunning statement is cut short. It reports no token budget because none is enforced (B10), and
  two of its figures are honest undercounts (B12, B13).

Results the agent stored **hydrate the existing surfaces**: the results grid and the explain view in
the bottom panel, carrying a read-only provenance badge that names the run. There is deliberately no
second editor and no second grid inside the rail, and applying a statement to the editor happens only
on an explicit user action. Chart and export hydration are not wired (B14), and a run's stored
results are released when the run ends, so a report can outlive the rows its citations point at
(B15).

## Deployment

**The zero-config backend is single-instance.** `local` keeps run state in a directory on local disk
and takes file locks, so more than one replica pointed at it is a misconfiguration. Running the agent
on more than one replica requires `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and its own
PostgreSQL database — its own, not one of the databases you connect Studio to. Set
`WORKFLOW_POSTGRES_URL` when you do: unset, that backend falls back to a development default
(`postgres://world:world@localhost:5432/world`) rather than refusing. **Check that URL yourself**: the
availability probe does not, and cannot cheaply (B31), so an unreachable one leaves the rail rendered
and the first Start failing — the one place this feature's central promise does not hold.

**Where run state lands matters, because it decides whether the agent exists at all — so the image
sets it rather than leaving it to the SDK.** The local backend's directory is
`WORKFLOW_LOCAL_DATA_DIR`, and the SDK's own default is `.workflow-data` resolved against the
process's working directory — `/app` in the container image, which is *not* the `/app/data` volume.
That default is wrong in every container, and an operator starting a container cannot supply a
default from outside it, so the runtime stage of the [`Dockerfile`](../Dockerfile) ships
`WORKFLOW_LOCAL_DATA_DIR=/app/data/workflow`: inside the directory the entrypoint chowns to the app
user, and inside the one an operator mounts a volume on. `docker-compose.yml` sets the same path
explicitly, which is now a restatement rather than the only source of it, and either can be
overridden per deployment.

What the image default does **not** do is make run state durable. `/app/data` with no volume on it is
still the container's writable layer, and an `emptyDir` is still lost with the pod: mount a volume, or
enable `persistence`, if runs should survive a recreate.

A correction to what this document used to say, checked on `main` on 2026-08-13 by rendering the chart:
`readOnlyRootFilesystem: true` does **not** prevent the local backend from working. `/app/data` is
mounted on every render — an `emptyDir` by default, the PVC when `persistence.enabled` — so the
backend can write there. What was missing was a **default pointing at it**: the chart wrote agent
environment only through `extraEnv`, so a default `helm install` left `WORKFLOW_LOCAL_DATA_DIR` unset
and the agent honestly reported itself absent.

The chart supplies that default itself, and it has to — the image cannot yet. `image.tag` defaults to
the chart's `appVersion`, and the Dockerfile's `WORKFLOW_LOCAL_DATA_DIR` landed **after** the `0.11.0`
tag that `appVersion` names, so the image a default install pulls today has no such ENV. Leaning on
the image would have left the ledger resolving to `.workflow-data` under `WORKDIR /app` — read-only —
and the probe answering `LEDGER_UNAVAILABLE` on an install the chart advertises as working. With the
chart writing it (verified by rendering `charts/libredb-studio` at its defaults), the agent appears as
soon as a model is configured, with an ephemeral ledger until `persistence.enabled`. Both places name
`/app/data/workflow`, so when an image carrying the ENV ships, the two agree.

**The chart now says the same thing** (chart `0.1.34`). It carries an `agent` block whose only field
is the off-switch, and the block's whole design is to write as little as possible:

- `agent.enabled` unset — the default — writes **no** `LIBREDB_AGENT_ENABLED` at all, so a Kubernetes
  install derives availability exactly as every other deployment does. A chart that hard-coded a
  value here would undo T5 for the one channel most operators use.
- `agent.enabled: false` writes `LIBREDB_AGENT_ENABLED=false`, quoted by the chart (which is what
  retired the `--set-string` trap the old `extraEnv` recipe had to explain). It is the documented way
  to upgrade a deployment that already has an `LLM_API_KEY` and does not want an agent.
- The chart sets `WORKFLOW_LOCAL_DATA_DIR=/app/data/workflow`, for the release-topology reason above,
  and writes it before `extraEnv` so an operator can still move the ledger. It is the one place the
  block writes more rather than less, and a test holds the chart's copy equal to the Dockerfile's.
- The chart **refuses to render** when an agent could run there and more than one replica is asked
  for, and its message names all three ways out — one replica, `agent.enabled=false`, or the Postgres
  world through `extraEnv` — while saying plainly that the third one does not work with the published
  image (B16). "Could run" counts an inline `llmApiKey` or a key-optional provider (`ollama`,
  `custom`). The guard reads these values only, so it cannot see a model configured through
  `secrets.existingSecret`, `extraEnvFrom` or `extraEnv`; all three blind spots are listed in the
  chart README rather than hidden.

The one thing the chart cannot fix is durability: with `persistence.enabled=false` the ledger is an
`emptyDir`, so run history goes with the pod. `values.yaml`, the chart README and the install notes
each say so.

Plain Docker used to fail quietly, and that is what the image default fixes: `/app` is writable in the
image, so nothing errored — the ledger simply sat in the container's writable layer and went with the
container, surviving a restart and disappearing on the next recreation or image upgrade. A bare
`docker run` carries no environment file to correct that, so the image now names `/app/data/workflow`
itself and a plain run needs only `-v libredb-data:/app/data`. **Without that volume the run history
still dies with the container** — the agent works, its ledger is written, and it is lost on the next
recreate. Passing `-e WORKFLOW_LOCAL_DATA_DIR=…` still overrides the default and is how you put the
ledger somewhere else.

`npx @libredb/studio` needs none of this. The launcher defaults the variable to
`~/.libredb-studio/workflow-data` (`resolveLedgerDir` in `bin/lib/launcher-utils.mjs`), beside the
per-version payload cache rather than inside it: the payload is spawned with `cwd` set to that cache,
so the SDK's cwd-relative default would litter a directory re-extraction does not preserve, and a run
started from another folder would silently look elsewhere for its history. An operator who sets the
variable keeps whatever they set.

Upstream positions the `local` backend as designed for development rather than production. That is a
consciously accepted risk of this phase, recorded here rather than buried.

## Package boundary

The runtime's dependencies are **not** dependencies of the published `@libredb/studio` package, and
this is enforced mechanically rather than by convention: a boundary test asserts the published
dependency set gains neither the runtime packages nor a vendor model-provider package, and a second
walk of the module graph asserts that no package entry point transitively imports `src/lib/agent`
(over both the value graph and the type graph, because code and types are reached differently). The
type walk reaches exactly one agent module — `src/components/agent/hydration.ts`, through
`BottomPanel`'s optional prop — and that is a pinned, enumerated exception rather than an unnoticed
one: no entry point exports `BottomPanel`, so no agent type is emitted into the published
declarations.

The embedded shell (`src/workspace/StudioWorkspace.tsx`) renders no agent surface under any feature
combination, and `WorkspaceFeatures` deliberately gains **no** agent capability field: a
declared-but-unread capability is the state this repository already decided to avoid, and Phase 1 is
standalone-only. The reason is a comment above the interface, where a reader would look.

One residual: the shared `BottomPanel` component ships in the package with its agent-provenance
branch present but inert — an optional prop the embedded shell never passes, on a component no entry
point exports (B21).

## Module map

```
src/lib/agent/
├── config.ts             # the flag and the backend allowlist (the only module reading process.env)
├── types.ts              # durable domain contracts: run, events, snapshot, artifact/evidence refs
├── state-guard.ts        # refuses to persist a function, a client, a credential or a result set
├── run-store.ts          # the append-only ledger over the durable backend
├── run-service.ts        # start / status / cancel / resume / stream, decided from the ledger
├── investigation.ts      # the one workflow; start and resume are the same call
├── runtime.ts            # composition root: the only place that assembles a tool context
├── tools.ts              # the four tools + server-side selection; the only database reach
├── composed-sql.ts       # the SQL the SERVER writes, per dialect
├── sqlite-ddl.ts         # reading SQLite's stored DDL back into an inventory
├── execution-policy.ts   # the frozen policy and the run-level ceilings
├── deadline.ts           # the wall-clock deadline and the timeout clamp
├── repair-ledger.ts      # the bounded repair loop and its statement fingerprint
├── context-snapshot.ts   # the schema snapshot and task-aware packing
├── model-adapter.ts      # resolved LLM config → an SDK model; SDK errors → our error classes
├── provider-registry.ts  # provider kind → adapter (total over the settings surface's union)
├── goal-verifier.ts      # did this run ANSWER? a pure fold over the ledger, per workflow
├── er-diagram.ts         # the schema's relations as text, quoted so a name cannot forge one
├── plan-summary.ts       # how an engine reaches its rows, read from an ESTIMATING plan
├── table-profile.ts      # composed per-table aggregates, and the findings derived from them
├── capability-probe.ts   # tool calling / structured output / streaming, established positively
├── capability-labels.ts  # what those three are called in front of a user; shared with the rail
├── drive-token.ts        # the single-purpose credential the resume seam verifies
└── untrusted-content.ts  # the prompt-side fence for database content

src/app/api/agent/        # the six route paths above
src/components/agent/     # AgentRail.tsx, timeline.ts (event fold), hydration.ts,
                          #   use-agent-run.ts, use-agent-artifact.ts
src/hooks/                # use-agent-capability.ts (the flag probe; the rail's own hooks
                          #   sit beside it above)
```

## Known limitations

Each of these is recorded in [`docs/BACKLOG.md`](./BACKLOG.md) with what it would take to close it.
They are listed here so the honest boundary is visible from the behaviour document rather than only
from the tracker.

**Inherited from the enforcement layer** — `docs/BACKLOG.md`, section "Agent M1 deferrals (#328)",
entries A1-A3 (that file carries a second, unrelated A-series under its security section). These bound
what any agent statement can be promised: a SQLite statement is not preempted, so its timeout is post-execution and
an overrunning statement blocks the runtime (A1); `VACUUM INTO` can create an empty file at a chosen
path (A2); out-of-scope **reads** have no database-native control on either provider — the
declared-target allowlist, the statement guard and the role's own grants are the whole boundary (A3).

**From this milestone:**

- **B1** — a credential classification map kept module-private would be invisible to the state guard.
- **B2** — the Anthropic kind is ratified and installed but not offered; serving it means giving the
  chat surface an Anthropic provider first.
- **B3** — a scope allowlist on a target dimension denies every tool that cannot declare it.
- **B4** — a mapped database error discards the text distinguishing a timeout cancel from an operator
  cancel.
- **B5** — the ledger assumes one writer per run and cannot enforce it.
- **B6** — every cost ceiling is per-drive, so N resumes can cost up to N times one drive's budget.
- **B7** — a PostgreSQL expression index is absent from the schema inventory.
- **B8** — the composed foreign-key read cannot pair a composite key's columns.
- **B9** — nothing enqueues a drive, so an interrupted run is resumable but never resumed.
- **B10** — no token budget is enforced, so the meter reports none.
- **B11** — the rail can stop a run but cannot pause or resume one.
- **B12** — a statement that failed at the database records no duration, so the meter's database time
  counts completed reads only.
- **B13** — three spends the ledger never records, so the meter reads low.
- **B14** — an artifact hydrates the grid and the explain view, but not the chart or export surfaces.
- **B15** — a run's stored results are released when it ends, so a report's citations can outlive its
  rows.
- **B16** — the opt-in `@workflow/world-postgres` backend is not present in the standalone payload,
  so it cannot load in the container image or the npx payload.
- **B17** — monitoring tools are deferred, so nothing reads slow queries, index usage or engine
  metrics; table profiling landed with #330 T3 and closed the other half of that entry.
- **B20** — a Gemini deployment behind a proxy is not configurable: `LLM_API_URL` is unread for that
  kind, in the chat surface as much as in the agent.
- **B21** — the published package's `BottomPanel` carries the agent-provenance branch as dormant
  markup.
- **B23** — seed eligibility is decided against the browser's last descriptor fetch, so a seed
  repointed server-side mid-session is not seen until the next fetch.
- **B29** — an identifier the model quotes back into its own tool arguments reaches the transcript
  unfenced; an open injection path, bounded only by the server never handing it the raw marker.
- **B30** — a green ledger probe promises `ensureDataDir` will pass, not that the world will build: a
  corrupt or incompatible `version.txt` throws a step later, after the rail has rendered.
- **B31** — the Postgres durable backend is reported available without being contacted, so an
  unreachable `WORKFLOW_POSTGRES_URL` still renders a rail whose first Start fails. Reported as a
  carve-out (`ledgerVerified: false`) rather than fixed; a real check is a connection attempt per page
  load.
- **B32** — the route family above is documented in [`docs/API_DOCS.md`](./API_DOCS.md) and guarded
  against drift, but that guard derives only the agent paths: every other family is still hand-kept,
  and even here only a path's presence is asserted, never that a documented shape still matches its
  handler.

## Related documentation

- [`docs/AGENT_GUIDE.md`](./AGENT_GUIDE.md) — the user guide: the rail's own vocabulary, the three
  workflows, what "answered" means, the meter's numbers, and the Ollama path.
- [`docs/AGENT_DATA_FLOW.md`](./AGENT_DATA_FLOW.md) — what leaves the machine, when, and to which
  provider, written from call sites.
- [`docs/API_DOCS.md`](./API_DOCS.md#agent-api) — the seven handlers as a documented route family.
- [`docs/SECURITY.md`](./SECURITY.md) — controls 3.4 and 3.5, and the reasons they read as they do.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — where this sits in the application.
- [`docs/BACKLOG.md`](./BACKLOG.md) — the deferrals above, in full.
- [`docs/providers/postgres.md`](./providers/postgres.md) and
  [`docs/providers/sqlite.md`](./providers/sqlite.md) — the agent execution profile per engine.
