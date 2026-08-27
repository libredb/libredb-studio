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
- **Agent mode requires PostgreSQL or SQLite — except the `operations` workflow, which runs
  anywhere.** They are the only providers implementing `queryReadOnly` (`postgres.ts:870`,
  `sqlite.ts:397`), so on any other engine an agent-mode run whose workflow sends a statement is
  **refused when it is started**: `POST /api/agent/runs` answers `400` with the posture's own
  paragraph before a run id exists or a model turn is spent (#512). The provider factory's gate sits
  behind that one and is what refuses a run reaching the drive some other way - profiled acquisition
  fails with `PROFILE_UNSUPPORTED_BY_PROVIDER` and the run ends `engine-unsupported`
  (`src/lib/agent/runtime.ts:199`), which is what a run opened by an earlier build still does. Both
  read the same fact, which is why the route can refuse without duplicating the decision. Surfaces that must *state* that reach — the login hero does,
  since #425 — read `AGENT_EXECUTION_ENGINES` (`src/lib/agent/engine-support.ts`), which mirrors the
  gate rather than replacing it: the factory keeps probing `typeof provider.queryReadOnly`, and
  `tests/unit/lib/agent/engine-support.test.ts` measures the provider prototypes so the constant
  cannot go stale against them in either direction. It is client-safe by construction (it imports
  only `DatabaseType`), and it deliberately says nothing about plan mode, which executes nothing
  anywhere, or about `operations`, which runs everywhere.
  The restriction is a property of the **execution profile**, not
  of the factory: `agent-read-only` sends model-authored statements and is served only where the
  engine can bound one, `agent-handover` sends the statement a run already answered with and takes
  the same gate for the same reason, while `agent-operations` sends no statement at all — it calls
  the curated reporting methods every provider implements — and its acquisition therefore does not
  require `queryReadOnly` (`src/lib/db/factory.ts`, `PROFILE_ACQUISITION`). Since #411 an operations
  run does take one acquisition before its first turn and never during it, for its schema capture,
  exactly as every other workflow does — and since #414 **which profile that capture acquires depends
  on which of its two readings it takes**: `agent-read-only` on the dialects `CATALOG_PLANS` serves,
  because it composes catalog statements, and `agent-operations` everywhere else, because asking a
  provider to describe its own schema sends nothing an engine has to plan. That is what lets grounding
  reach the twelve the read-only profile refuses, and it still cannot narrow any workflow's
  reach: the profile whose acquisition would be refused is never the profile that capture asks for. Everything else about
  the three acquisitions is identical: the same `readOnly: true` open, the same optional
  least-privilege `agentUser`, and the same profiled cache, so neither an operations run nor an
  editor replay is ever handed the editor's writable pool. **Plan mode grounds itself the same way**
  — the server reads the schema, and on PostgreSQL and SQLite the engine's estimated statistics
  beside it, before the model's first turn — so a plan run is now ordinarily grounded on every engine,
  including the nine where an agent run cannot read anything at all. What is left of the old engine
  rule is narrower and still worth stating: the engine no longer decides WHETHER a plan run is
  grounded, only whether it is grounded through a composed statement or through its provider, and
  whether it gets statistics. A run whose reading fails — a provider that cannot describe itself, a
  description that overran the time the run granted it, a refusal — begins anyway, is told which of
  those happened, and acquires nothing further. The model is
  toolless in either case, so nothing it writes reaches a database.

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
- [Supported models](#supported-models)
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
| `LIBREDB_AGENT_THREAD_CONTEXT` | unset (on) | Whether a run may be told about the **conversation** it belongs to. A follow-up asked on the same connection continues the previous run's thread: the earlier steps' objectives and the most recent step's report are derived server-side from those runs' own ledgers and handed to the model fenced. Set `false`/`off`/`0` where no question's context may reach another. Every run then opens on its own and the rail SAYS so — a user who asks a follow-up is told the conversation is switched off on this server, rather than being left to infer it from an answer that does not resolve. `GET /api/agent/config` reports the state to an **admin** session, beside `modelTuning` and for the same reason: an operator who switches something off must not hear silence, and `curl` is how they check. It is deliberately not sent to every session — the sentence a USER needs comes from the run's own `thread.declined` at the moment their follow-up was not read as one, which is where it means something. An unrecognized value warns and is ignored, the same two-sided rule `LIBREDB_AGENT_ENABLED` follows: a typo must neither take a working surface away nor turn one on. It is the operator's counterpart to the control the user already has — the rail names the run being continued and offers "new conversation" beside it. |
| `WORKFLOW_TARGET_WORLD` | unset (`local`) | Durable backend for run state. Exactly two values are accepted: `local` (zero-config, on-disk, **single instance**) and `@workflow/world-postgres` (opt-in, multi-replica, needs `WORKFLOW_POSTGRES_URL`). Anything else is **refused**, not defaulted. |
| `AGENT_MODEL_TURN_TIMEOUT_MS` | unset (`90000`) | How long **one** model call may take before the drive stops waiting for it. Raise it for a LOCAL model: the default was chosen against hosted APIs, where a turn lands in seconds and a 90-second wait only ever means a request that is not coming back. Measured across 25 Ollama models on six surfaces, **nine** runs ended `model-timeout` with the model still working — one of them a reasoning model in plan mode, which holds no tools at all, cut 92 s into its **first** turn with a zero-event ledger. Those runs are scored as having answered nothing, which is a fact about this ceiling and not about the model. A value that is not a positive whole number is **ignored** and the default stands; a value is capped just under half the smallest workflow deadline, because a run has to be able to take two turns to finish. |
| `AGENT_MODEL_TUNING_PATH` | unset | A JSON document of measured per-model settings, layered over the ones Studio ships with. Studio carries a document recording what specific models were measured under — turn limit, how many readings before it is asked to report, whether an empty turn is asked again — and a model not named in it is driven with the defaults, which is the honest treatment of a model nobody has measured. This is how a model Studio has never measured gets settings somebody else measured: mount a file in the same shape and restart, with no Studio release and no code change. Merged **per model and whole** — an entry here replaces the shipped entry for that model rather than contributing one field to it, because half of one measurement beside half of another is a configuration nobody has run. A file that is missing, unreadable or off-schema is **ignored** and the shipped measurements stand — which is the one setting here that fails **open**, so it is also the one that reports itself: `GET /api/agent/config` tells an **admin** session what became of the document (`{"modelTuning":{"state":"applied"\|"ignored"\|"unset",…}}`, with the path and the parser's reason), because an operator who mounts a file and is told nothing will believe it is in force. It carries numbers and switches only: the sentences the drive says to a model stay in Studio, so supplying this file cannot change what Studio tells a model. On Kubernetes the chart mounts it for you — see `agent.modelTuning.*` in [`charts/libredb-studio/README.md`](../charts/libredb-studio/README.md). The document's own contract — every setting, its bounds, what happens to a key this build does not implement, and the example to start from — is [`docs/llms/model-tuning.md`](llms/model-tuning.md). |
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

- **`planning`** — the model reasons about the objective and produces a statement the user runs
  themselves. Its tool set is **empty**, and that is decided on the server from the run's persisted
  mode; a client-supplied tool list has no way in, because there is no parameter for one. The
  server does read this connection's schema before the first turn — its catalog on the two dialects
  the composer serves, its provider's own inspection everywhere else, plus estimated statistics where
  the engine holds any — see [What a plan run knows](#what-a-plan-run-knows) — so the mode's property is not "it reaches
  no database" and never really was: **a planning run runs no statement of the user's, writes
  nothing, and hands every statement it drafts to the user to run themselves.**
- **`agent`** — the model receives the read-class tools below and investigates.

The mode is fixed when the run is opened. A later request cannot widen a planning run, and the
tool-selection function is re-checked at the execution seam, so a caller holding a tool context
still cannot execute a tool the selector would never have offered.

The **workflow type** is WHAT the run is for — `investigation` (the default),
`query-optimization`, `database-assessment`, `operations` or `data-analysis` — and it is fixed at start for the same reason and by
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
  What the workflow does decide in planning is the **deliverable**: `PLAN_DELIVERABLES` in
  `investigation.ts` is a total record over the workflow types, naming the statement each plan is
  asked for — the rewritten statement for a query optimization, the statement that measures the
  concern for an assessment — with `operations` the one member whose deliverable is prose, because no
  reading of that workflow can be REQUIRED to be a statement: it deliberately runs on engines where
  none is one. Two narrower reasons have been retired by live runs. "That workflow captures no
  schema" went with #411. "An operational reading is not a statement" went next: it is true of Redis
  and MongoDB and false of PostgreSQL, where `pg_stat_activity` and `pg_stat_user_indexes` are
  ordinary objects a user selects from — so a plan of this workflow now MAY fence a statement where
  the engine expresses the reading as one, while still being judged as prose and still exempt from
  the planning statement rule. See [What a plan run knows](#what-a-plan-run-knows).
  Being total is the point: adding a workflow
  stops the file compiling until someone decides what a plan of it should produce.
- **The field is required on the record and optional on the ledger header.** The fold always
  produces a workflow type, so every reader has one and none has to know which generation of writer
  produced its run. A header without one folds to `investigation`, and that is a READING rather than
  a fallback: an investigation is the only thing this runtime could do when those ledgers were
  written. `tests/unit/lib/agent/ledger-compatibility.test.ts` asserts it against a REAL pre-change
  ledger — a run driven in a browser on 2026-08-12, copied out of `.workflow-data` verbatim — rather
  than against a hand-written approximation of one.

Composing claims that rest on something the run actually read is the baseline **every** workflow has
to meet. A template adds to that baseline rather than replacing it — see
[The query-optimization template](#the-query-optimization-template) — with one stated exception:
`operations` drops the baseline's emptiness clause, because an empty operational reading is an
answer rather than an absence of one. See [The operations template](#the-operations-template).

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

### The conversation a run belongs to

**Every run belongs to a conversation**, and most belong to one of their own. A run opened on its own
is a thread of ONE named after itself; a follow-up question asked on the same connection CONTINUES
the thread the previous run belonged to. The rail sends that run's id, the route derives the context
server-side from its ledger, and the new run's header records the result as `thread`
([`src/lib/agent/thread-context.ts`](../src/lib/agent/thread-context.ts)).

**The thread is a linked list in which every node carries its own prefix.** A run's header holds the
whole chain before it, so following the tail yields the conversation entire and nothing has to
enumerate anything — which matters, because the store has no enumeration to offer. Two consequences
follow directly. The chain is **single-connection by induction**, since every link verified the
connection at its own open. And **threads fork harmlessly**: two tabs continuing the same run both
produce a thread whose prefix is that run, so the conversation becomes a tree in which each branch is
self-consistent, with no shared mutable state to conflict over.

**What a run is handed has two halves, drawn from different places.** The **spine** is every step's
objective, oldest first, and it comes off the header for free. The **evidence** is the most recent
step's report, and it comes off the record the route already loaded. Older steps' reports are
deliberately not carried: that would be one ledger read per step for the half the spine already
supplies — and the spine is the half a later step actually lacks, because a transformation step
("chart those", "export it") has an objective that is itself a pronoun, so the plain statement of
intent lives further back.

The block is fenced when the model reads it, so a pronoun or a demonstrative ("those groups", "it")
either resolves against the conversation or is refused for lack of a referent rather than answered as
if the question were new. The model is also told, outside the fence, that earlier steps list only what
was ASKED and not what was found — without that sentence this design would create its own false
impression, since a listed step reads as a step whose findings are in hand.

**Nothing is truncated silently.** `AGENT_THREAD_CONTEXT_MAX_CHARS` (4000) bounds the block, the spine
may take at most 75% of it so the newest report always has room, `AGENT_THREAD_MAX_STEPS` (20) bounds
the chain, and a carried objective is capped at `AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS` (200). Each of
those is stated in the text where it applies. The budget is additionally an optional per-model key in
`AGENT_MODEL_TUNING_PATH`, because the value that is right depends on the model's context window —
and **no measured value ships for it**, so the compiled default drives every model until an operator
measures their own.

**Continuing a conversation is an enhancement, never a precondition.** `previousRunId` is attached by
the rail on its own, so a predecessor that cannot be reached must not take down the question the user
did type: a shape error refuses, and every runtime condition DEGRADES — the run opens carrying no
conversation, and the header records `declined` as `"unavailable"` (the run does not exist, is not
this session's, is on another connection, was established against another database, has not ended, or
names an id the ledger refuses),
`"disabled"` (`LIBREDB_AGENT_THREAD_CONTEXT`) or `"error"` (an unreadable ledger). The value is
persisted rather than answered once, so a reload still has the notice to show, and the rail says which
happened rather than going quiet.

**A conversation is checked against the DATABASE, not the record.** Every link used to check
`connectionId` at its own open, which is an identity check on the RECORD: a saved connection edited to
address another server keeps its id, so a follow-up was handed the earlier steps' claims about the old
database while reading the new one — nothing refused, nothing wrong to look at. Each run therefore
records `connectionIdentity`, the same fingerprint the held context snapshot is filed under: engine,
host, port, database, service, instance, role and the SSH tunnel the database is reached through, and
deliberately not the password. A follow-up whose database does not match its predecessor's declines as
`"unavailable"` rather than carrying it. Rotating a credential or renaming a connection is the same
database and keeps the conversation, and a predecessor that recorded no identity at all is carried
rather than refused — no conversation in flight across a deploy is ended by a silence. What is left of
B67 is run history across threads.

A run emits a closed set of **semantic events**, and they are the whole of what the UI renders:
`run-started`, `driver-resolved`, `context-captured`, `context-unavailable`, `statement-drafted`,
`plan-statement-drafted`,
`tool-invoked`, `tool-completed`, `tool-refused`, `report-composed`, `closing-statement`,
`run-finished`, plus the four a single workflow's own tool writes — `plan-comparison`,
`recommendation`, `table-profiled` and `answer-composed`.

**`driver-resolved` says what drove the run**, and it exists because a finished run used to say
nothing about that: no event and no record field carried the model id, so "these settings were
measured" — the product's whole claim about a model — was not checkable from the run that used them.
It carries the model, its provider, and where the settings came from: `bundled`, `operator` with the
document's path and a digest of the bytes as read, or `operator-ignored` with the path when a
document was configured and could not be used. The last is its own case on purpose — a run driven by
the shipped settings because nobody configured a document, and one driven by them because the
operator's could not be read, behave identically and mean opposite things.

**`context-unavailable` says a capture was REFUSED**, and it is a separate kind rather than a
`context-captured` carrying an absence. A refused capture read nothing, so it has no fingerprint and
no table count - writing `tableCount: 0` would state that the database has no tables - and three
readers take `context-captured` as proof an inventory exists (`reusableSnapshot`, the grounding check
the tools layer applies to a citation, and the rail's own capture line). It carries the reason code,
the capture's own one-sentence diagnosis, and, where the row budget is what refused the read, both
numbers: rows projected against rows allowed. Before it, a plan run whose capture was refused left
nothing at all between the drive starting and the run ending, so the rule this document's setup guide
states about ledgers - that the ledger is the authority on what a run did - held only for captures
that succeeded, in exactly the case an operator has to diagnose. The reason code and the sentence
never depend on parsing anything; the two numbers are read back out of the provider's own refusal
message, which is pinned by a test that drives a real over-budget read rather than by a copy of the
sentence.

It is written **once per drive** rather than once per run, because a resume picks the model up from
the configuration as it stands then: a run resumed after an operator changed it carries one entry per
stretch, and two that disagree are the fact worth finding. The rail renders the model and not the
provenance — a mounted document's path is server topology, and it belongs to whoever reads
`GET /api/agent/config` rather than to whoever asked the question.

**`plan-statement-drafted` is planning mode's own**, and is deliberately not `statement-drafted`:
that kind promises a `stepId` tying a draft to the tool invocation that sent it, and a toolless run
has none. See [The statement a plan run drafts](#the-statement-a-plan-run-drafts).

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
rather than instead of it.

`stopReason` sits beside `reason`, which says why a drive died before or outside the loop. They
answer different questions and are mutually exclusive in practice; when both are present, `reason`
is the one a user reads, because a dead drive is the more specific account of an ending.

**What a `stopReason` MEANS depends on the mode**, and `model-stopped` is where the two part company.
In agent mode it is a shortfall: the model had a report tool and did not use it. In planning mode it
is the successful ending — planning is toolless, `compose_report` does not exist there, and stopping
once the plan is written is the only way a good planning run can end. The rail therefore words that
one ending per mode (#350); every other ending is a shortfall in either mode, because a planning run
that ran out of time produced no plan either.

### What a plan run knows

**A plan run grounds itself.** Before the model's first turn the server reads this connection's
schema, and on PostgreSQL and SQLite the engine's own estimated statistics too, through the same
audited, budgeted path an agent run's `inspect_schema` takes. The model is handed no tool and reads
nothing further.

**There are TWO readings, and which one runs is the dialect's decision** (#414). On the dialects
`CATALOG_PLANS` serves — PostgreSQL and SQLite — the server composes catalog statements and executes
them under `agent-read-only`. On every other dialect it invokes `db.schema.read`, a sixth operation
descriptor whose whole input is empty: it acquires `agent-operations`, calls the connection's own
`provider.getSchema()` — the inspection the sidebar performs when it lists your tables — and returns
the structure rather than rows to reassemble. Both go through `runAuditedAgentCall`, so both meet the
same mode check, deadline admission, budget clamp, audit and artifact; there is no second, unaudited
path to an engine. The two do NOT converge, and that asymmetry is structural: the composed path is
audited statement by statement, carries foreign keys the provider path cannot on an engine that
declares none, and SQLite's inventory is parsed out of stored DDL the provider does not expose the
same way.

**What the provider path costs, and what it cannot promise.** One statement of the run's budget, where
PostgreSQL costs three and SQLite two. `getSchema()` takes no budget on any provider, so the call is
raced against the timeout this call was granted — which bounds THE RUN and not the database: the driver
call is not cancelled, this run simply stops waiting, and the capture is then `unavailable` whole
rather than partial. And the reading is BOUNDED by the provider itself — MongoDB stops at 200
collections, Redis scans 1000 keys, LibreDB 10000 — so the preface says the inventory is what the
inspection found and not proof that nothing else exists. On MongoDB and Couchbase the field names are
inferred from a sample of the user's own documents: no value is kept, but the existence of a field
there is derived from data rather than read from a catalog, which is why `db.schema.read` is its own
operation id an operator can deny without denying any other agent read.

That is a deliberate change of the contract, made on 2026-08-15, and it retired a sentence this
document carried for two milestones: *"a plan run reaches no database."* That sentence was never the
property the mode sells. It was a **proxy** for it, and it stopped being true. The property itself is
unchanged and is what to hold this mode to:

> **A plan run runs no statement of the user's, writes nothing, and hands every statement it drafts
> to the user to run themselves.**

Reading a catalog is what the sidebar already does on every connect. What no plan run does — before
or after the change — is execute a statement anyone asked for, modify anything, or apply its own
output.

The change exists because the previous arrangement (#384) grounded a plan run only from
`heldSnapshotForConnection`, an in-process LRU that only a prior **agent** run on the same connection
in the same process could fill. So the safe mode was useful only to someone who had already used the
unsafe one, and was blind after any restart and on any second replica. Asked on 2026-08-15 how it
would assess a real six-table SQLite database before a release, a live run answered that it could not
reach the live environment and produced an inspection plan that would have read identically against
any database in the world.

What a grounded plan run is given, and where each part comes from:

- **The inventory and its relations**, from the cheapest of three sources, in this order: the run's
  **own ledger** (a resumed drive re-derives the `context-captured` inventory it already recorded and
  reads nothing); the **process hold** (`context-snapshot.ts`, keyed by `connectionIdentity` —
  the engine, host, port, database, service/instance and role, hashed, never the password — accepted
  only if it fingerprints as itself, newest reading wins by `capturedAtMs`, bounded to the 16 most
  recently used connections); or a **capture**, which takes whichever of the two readings this dialect gets and
  records `context-captured` on the plan run's own ledger — so the next drive of that run takes the first path. Both messages are
  fenced as `UNTRUSTED_CONTENT`, exactly as in agent mode.
- **A preface saying who read it AND how** — four sentences over two axes since #414, because both
  are facts a plan could describe falsely. Who: read by this run before its first turn, or read by an
  earlier run on this connection (`readVia` and `readBy` on the snapshot; `readVia` is absent on the
  composed path, so every ledger written before #414 stays byte-identical). How: through a catalog
  read the server composed, or through the engine's own schema inspection. The provider sentences
  claim neither a composed statement nor that nothing of the data was touched, and they carry the
  bound. All four then say the same true thing rather than the old "this run has read nothing" — no
  statement of the user's was run, nothing was written, and the model has no tools.
- **Estimated statistics** (`src/lib/agent/schema-stats.ts`), read on **every** grounded path
  including the two free ones. That is deliberate: what the model may conclude must not depend on
  which process happened to have read a catalog first. They are read from what the engine already
  holds — `pg_class.reltuples` and `pg_stats` on PostgreSQL, `sqlite_stat1` on SQLite — so no column
  is scanned and no value is read out of any row. `ESTIMATE_BUILDERS` serves those two dialects and
  nothing else, and #414 added no engine to it: on the other twelve `readSchemaStatistics` answers
  `DIALECT_HAS_NO_STATISTICS` — *"this engine does not hold statistics this run knows how to read"* —
  so **a known schema with no statistics is now the ORDINARY combination rather than a rare one**, and
  the two sentences the run is handed agree: the inventory is a record of what exists, and every
  table's size is unknown rather than small. `AgentColumnProfile`'s "counts only" rule is
  untouched. Statistics are **not** folded into the snapshot: an estimate is not schema, and the
  snapshot's fingerprint is its identity, so an `ANALYZE` would otherwise change the identity of a
  schema nobody changed.

**The statistics are estimates, and the text says so at every point it could be mistaken for a
measurement.** A number reaching the model is labelled the engine's own estimate; `pg_stats.n_distinct`
is a ratio when it is negative, and is converted only where there is a row estimate to convert it
against and then labelled derived; PostgreSQL's two spellings of "I do not know" (`reltuples` of `-1`,
never counted since PG14; `n_distinct` of `0`) become absence rather than a number. A table nobody has
`ANALYZE`d is **listed as having no statistics** rather than omitted, because a model shown silence
reads it as an empty table. SQLite has `sqlite_stat1` only after an explicit `ANALYZE`, offers no null
fraction at all, and writes no row for a table with no index — so on that engine even the row estimate
is available only for indexed tables, and the packed text states that limit once rather than implying
coverage it does not have.

**A plan run that cannot be grounded is told so**, in the CAPTURE's own voice and without naming a
tool it does not have, and its rules then steer it to the refusal path rather than to generic advice.
Since #414 that happens when a reading fails rather than because of the engine: a provider that
cannot describe its own schema, a description that overran the time the run granted it, or a reading
refused by policy or by the database. The diagnosis is forwarded verbatim rather than replaced by a
sentence naming the engine — which is what this note used to do, and which since #414 would report a
property of MongoDB on a build where MongoDB grounds perfectly well (the same substitution #411
caught on the operations path, for the same reason).

**An `operations` plan is grounded exactly where every other plan is**, and since #411 nothing about
grounding is workflow-dependent. Since #414 the engine does not decide it either — it decides only
which of the two readings is taken. That workflow used to be
excluded by decision — an operations objective is about what the engine reports about itself, so an
inventory looked like dead weight — and the exclusion was reversed on the finding that the argument
is true about the QUESTION and false about the evidence. The engine's own reports come back full of
schema identifiers: a lock is held on a relation, an index-stats row names an index, a slow query
names tables. A run that has never seen the inventory reads every one of those as an opaque string.

What stays workflow-specific is what is PACKED, not whether a capture happens. An operations plan is
shown table names and the indexes on each and **nothing else** — no columns, and no relations block
at all, because how its tables join is the one thing an operational reading never asks and the
relations graph is the most expensive part of the packing. It still gets the engine's estimated
statistics — **row estimates only**, with no per-column distinct counts or null fractions, since a run
told in the server's own voice that it has been shown no column must not be shown one in the block
beside that sentence — because it can read nothing further and those estimates are the only sizes it
will ever have. It remains the one workflow whose plan deliverable is prose, and its prose rule is what
grounding changed: a grounded operations plan must name the real tables and indexes each reading
would be about, rather than describing readings in the abstract.

**A prose plan may fence a statement, and on PostgreSQL it usually should.** Both prose paths used to
assert *"there is no statement to write here and no fenced block to produce"*, and a run driven in a
browser on 2026-08-17 disobeyed it in the open: an Automatic plan run classified to Operate on
dvdrental, grounded on 22 tables, closed with a fenced `pg_stat_user_indexes` read ordered by
`idx_scan`, and the rail offered **Apply to editor** on it. A rule live runs visibly disobey is this
repository's #350/#356 failure class, and here the rule was the part that was wrong: the premise —
an operational reading is not SQL — is engine-dependent, and the sentence was engine-blind.
`pg_stat_activity`, `pg_locks` and `pg_stat_user_indexes` are ordinary objects a user can select
from; a Redis `INFO`, a `SLOWLOG GET` or a MongoDB server status is not a statement at all. So
`planningProseStatementRule` states the CONDITION and lets the engine decide: where the reading is
expressible as a statement, write it in a fenced block tagged with the connection's type-id and the
plan is better for it; where it is not, say the reading in the engine's own terms and produce no
block, *"a plan with no block in it is a complete answer here"*. Three properties of that rule are
deliberate:

- **It is a permission, never a contract.** `PLAN_DELIVERABLES.operations` is still `{ kind: "prose" }`,
  the plan is still judged as prose, and the [planning statement rule](#whether-the-run-answered) still
  exempts it. There is no `noun`, no `NO STATEMENT:` marker and no ledger fact —
  `recordPlanStatement` still records nothing for this workflow, because what is welcome is not what
  was asked for and a `plan-statement-drafted` entry would file a deliverable the contract never
  named. The user still gets the block: #389's fence reading in the browser is what offers **Apply to
  editor**, and it is withheld only on a closing entry the server read a statement out of.
- **What it may fence is bounded to what the engine reports about ITSELF** — what is connected, what
  it is spending its time on, what is blocked, where its space and its indexes are going. A statement
  that reads the user's own tables is not an operational reading, and this is not a fifth statement
  workflow. The per-engine half is delegated to `planningProseEngineRule` rather than restated, since
  two wordings of one contract is how #350 happened.
- **The ungrounded path carries it too, and that is a decision.** What ungrounded withholds is this
  DATABASE and nothing about the ENGINE: that MySQL has `performance_schema` or SQL Server has
  `sys.dm_exec_requests` is knowable to a run that has seen no schema, and this path already spends
  that knowledge naming the readings it would take. Withholding the fence while permitting the same
  reading in prose would be a distinction with nothing behind it, and it would cost the editor
  hand-off on exactly the runs that have no other deliverable. Which runs those are narrowed in #414:
  MySQL, SQL Server and ClickHouse used to be this path as a matter of course and are now ordinarily
  grounded through their own providers, so what is left here is a run whose reading failed on any
  engine — a refusal, a provider that cannot describe itself, a description that overran its time.
  Fewer runs take it; nothing about what it may say has changed. The line it may not cross
  is said in the same breath: the engine's reporting objects are not this database's schema, so
  naming one invents nothing, while naming a table, an index or a column of the user's invents
  everything.

**A prose plan is also told which ENGINE it is planning against, on both paths.** The four workflows
that write a statement have carried theirs since #396 — the fence tag *is* the connection's type-id —
so the prose deliverable was the only one that never took a type, and `operations` is the only
workflow whose deliverable is prose. Grounding made that visible by making these plans specific
without making them right: driven in a browser after #411, a grounded plan on a **SQLite** connection
named the eight real tables of its inventory and then proposed reading `pg_stat_user_indexes` and
`pg_total_relation_size`, and an ungrounded plan on a **Redis** connection correctly said it could
name no object and then proposed wait event statistics, lock management views and a blocking chain
dependency tree. So `planningProseEngineRule` states the engine and binds the readings to it: every
reading the plan names must be one that engine actually offers, and where the model is unsure it is
to say what it would want to establish instead of naming a mechanism the engine does not have. Three
things it is deliberately not: it names **no tool**, because a plan run holds none (#350); it is a
rule about the readings rather than a mention of the engine, because naming the type alone was
already happening and was not enough — the ungrounded note then said "on this redis connection" and
that run still proposed a lock tree. (Since #414 that note names no engine at all: it forwards the
capture's own diagnosis, which names one only when the diagnosis genuinely is about the engine. Which
is why the rule, and not the note, is where the engine has to be stated — the observation this
paragraph records would have survived the note's rewording either way.) And it carries **no
per-engine catalog** of monitoring views, which would
be a second source of truth against the kinds `inspect_operations` serves.

**Agent mode needs none of this**, and that is a property of its tool rather than an omission. An
Operate agent run never authors a mechanism: it names a `kind` from a fixed, engine-neutral enum and
the server calls that engine's own reporting interface, a kind the engine does not serve comes back
refused in plain words, and its report must cite a reading it actually took. What it can say about
the engine is therefore bounded by what the engine answered.

Three consequences worth stating plainly, because each is easy to assume the other way round:

1. **A plan run costs statements now.** On PostgreSQL and SQLite grounding is catalog reads plus one
   statistics read (two on SQLite: the `sqlite_stat1` availability probe has to be its own statement,
   because SQLite resolves table names at prepare time). On the other twelve it is **one** — the
   single `db.schema.read` call, with no statistics read to add, since those dialects hold none this
   run knows how to read. They come out of the same per-run statement budget every other read does,
   and they are audited the same way. The ledger-reuse path saves the schema reading and deliberately
   does **not** save the statistics read.
2. **A plan run now writes `context-captured` to its own ledger**, which it never did before, and
   holds the reading in the process for the next run on that connection. Grounding therefore survives
   a restart. The deferral that recorded the opposite ("a plan run's grounding does not survive a
   restart, because the inventory is held in memory") is closed and deleted from `docs/BACKLOG.md`.
3. **The schema is never egressed anywhere it was not already going.** The same table and column
   names an agent run's prompt carries reach the same model, for a connection the same user can open
   an agent run on. The statistics add estimated row counts, null fractions and distinct counts to
   that set — engine estimates about the shape of the data, never a value out of it.

### What the inventory is an inventory OF

Grounding a plan on nine more engines exposed something the two-engine version could not: this
product records every schema in one shape, `TableSchema`, and the prompts had been using that shape's
name as a **noun**. A plan run on a seeded local Redis read 17 real key prefixes through the provider
— the grounding worked — and, under a block headed *"Schema inventory for this run — 17 table(s)"*,
drafted `KEYS user:*` in one run and `ZCARD user:*` in another. Neither names anything: `user:*` is a
grouping this server computed by SCANning a bounded slice of the keyspace and collapsing everything
before the first colon into one row. The model read the sentence it was given correctly.

Two things were wrong and each is fixed on its own axis, both driven by what the **provider** declares
rather than by the connection's type (`CLAUDE.md` forbids an engine check here, and these two are
exactly why: the engines that answer differently are not the ones a reader would guess).

- **The noun.** `ProviderLabels.entityName` has carried the right word since long before the agent
  existed — "Table" on every SQL engine, "Collection" on MongoDB and Couchbase, "Datasource" on Druid,
  "Key Pattern" on Redis, "Key Prefix" on LibreDB — and only the browser was being shown it. The
  fenced header, its omission notice, the relations block and the planning rules now take it
  (`inventoryNoun`, `src/lib/agent/inventory-noun.ts`), so a Redis run reads "17 key pattern(s)". A
  SQL engine's prompt is unchanged word for word: the base provider's label is the word that was
  hard-coded before.
- **What a derived grouping IS**, said once and only where it is true. A noun alone does not tell a
  model that a key pattern is not addressable, and no fact about Redis could — the grouping is this
  product's own. `ProviderCapabilities.tablesAreDerivedGroupings` is `true` on Redis and LibreDB
  alone, and where it is, the plan rules carry one sentence saying what the rows are (groupings this
  server derived from a bounded scan), what a statement may name instead (a whole key, or a pattern
  scan in whatever form the engine offers), and that the list is one reading's reach rather than the
  database's contents.

What that sentence deliberately does **not** contain is any command, any command name, or a
prohibition on one. A rule reading "never use `KEYS`" would be engine trivia in a prompt: it goes
stale, it teaches nothing about the next command, and a run that knows what the rows are can choose
for itself. A per-engine knowledge base was considered for this and deferred; this change stays on the
near side of it, because what it states is a fact about **this codebase's reading** and not about any
engine.

### The statement a plan run drafts

The deliverable is one runnable statement, not a lecture. The rules ask for it in a single fenced
block tagged with the connection's canonical type-id, rationale after the block, and no name that is
not in the inventory. Since #414 the WORDING varies with the engine's `queryLanguage` and the TAG does
not: on a `json` engine the run is asked for one statement or command in that engine's own language —
a MongoDB aggregation rather than a SELECT — and told that this engine speaks no SQL, while the tag
stays the canonical type-id in both arms. That is deliberate rather than an oversight: `isQueryFenceTag`
is a total record over `DatabaseType`, so all fourteen ids pass it, whereas a draft the model fenced as
```` ```javascript ```` passes nothing and records no `plan-statement-drafted` event at all — the run
would score as having drafted nothing while the user is looking at a statement. A run that cannot answer from the
inventory takes the other legitimate ending: a line beginning `NO STATEMENT:` saying exactly what is
missing and asking the one question that would unblock it. That marker is a convention in the
**output**, not a tool, which is what lets a toolless mode make its two outcomes mechanically
distinguishable.

The server reads that block out of the closing prose (`src/lib/agent/plan-statement.ts`) and records
it as a **`plan-statement-drafted`** event carrying the SQL, the connection's dialect, whether the
statement is read-only, and what the identifier check found. It is its own event kind rather than
`statement-drafted` because that kind promises a `stepId` tying a draft to a tool invocation, and a
toolless run has none. Recording it closed the deferral that had the rail reading a plan's SQL out of
a markdown fence rather than out of the ledger.

The server's reader and the browser's renderer have to agree about which block is a statement, and
both dimensions of that agreement are now enforced rather than asserted: the CommonMark fence rule
(no backtick in an info string) is spelled out in both, and which info strings name a query language
is one shared predicate, `isQueryFenceTag` in `src/lib/sql/fence-tags.ts`. Until 2026-08-15 only the
first half was shared, and the reader took the first fenced block whatever its tag — so a run that
opened with a ```text illustration recorded the illustration as its deliverable.

#389's fence reading stays as the fallback for code blocks in prose that are not the run's
deliverable — but it is **withheld on the closing entry a statement was read out of**. That prose
holds the statement, so leaving the per-block control there would put an unmarked "Apply to editor"
directly above the marked one: `renderProse` is handed text and knows nothing of the guard's verdict,
so it cannot label what it is applying. The card is the only hand-off; the block still copies.

**An `operations` plan is the case that fallback now carries on its own.** Its rules welcome a fenced
reading where the engine expresses one as a statement, and `recordPlanStatement` still skips this
workflow — so there is no card, no guard verdict and no identifier check on that block, and the
browser's fence reading is the whole of the hand-off. That is the deliberate consequence of keeping
the deliverable prose: the two checks below are attached to a statement the contract ASKED for, and
this one was welcomed rather than asked for.

Two checks run before it is offered anywhere, and neither is more than it says:

- **Identifiers.** Every table name the statement reads is compared against the captured inventory,
  and unknown names are recorded on the event. The reader is a reader, not a parser: it prefers a miss
  to a false alarm, so an empty unknown list means "nothing recognised was missing", never "the
  statement is sound". Nothing here checks **columns**. A run with no inventory records
  `no-inventory` rather than an empty list, because an empty list is a claim that every table exists.
- **Read-only classification**, through the existing statement guard (`inspectAgentStatement`). A
  statement that is not read-only is **not blocked** — the owner ruled on that — but it is marked, on
  the event and visibly in the rail, so that hand-off never quietly gives a user a `DELETE`.

**Both checks are SQL readers, and on an engine whose statements are not SQL they DECLINE rather than
judge** (#414). That was invisible until grounding reached those engines, and then both were wrong at
once on a correct draft. The guard reads every string as SQL: `db.orders.aggregate([…])` leads with the
word `DB`, `INFO memory` with `INFO`, `SCAN 0 MATCH …` with `SCAN`, and none is in its read allowlist,
so every correct MongoDB and Redis draft came back `NON_READ_STATEMENT` — structurally, since no
command of either engine can lead with SELECT, VALUES, TABLE or EXPLAIN. The identifier half is wrong
in the opposite direction: `readStatementTables` finds no table keyword in any of those, answers `[]`,
and the affirmative branch then reports that every table the statement names is in the inventory — a
vacuous claim about names nothing looked at. So `validatePlanStatement` takes the language, writes
`guardApplicable: false` with no `guardViolation` (there was no objection) and `readOnly: false` (a
guard that read nothing has vouched for nothing), and answers `identifiers: { kind: "not-applicable" }`
— its own variant, distinct from `no-inventory`, because an inventory usually WAS read on this path and
what is missing is a reader. `guardApplicable` is optional on the event and absent means `true`, which
is truthful for every ledger written before #414: plan mode was then grounded on two dialects and every
draft it recorded was SQL. The three surfaces that render it — the timeline's headline and detail, the
card, and the applying control's accessible name — read the not-applicable state FIRST and blame the
check's reach rather than the draft.

**A statement validated against the inventory is not a statement that will run.** The inventory
records what EXISTS in this database, not what the user's role is permitted to read, and the model is
told so in its own rules for the same reason it is stated here.

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

Four tools are the read class, and `agent` mode receives exactly these unless its workflow says
otherwise. Three of them reach the database, each through `executeAuditedOperation` against a
provider acquired under the agent read-only execution profile — never the shared writable connection
cache.

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

- **A schema read takes one of two descriptors, and which one is the DIALECT's decision.** This
  document said for two milestones that there is no descriptor for catalog access — the canonical set
  was three, then four, then five — and the truer statement is now about the split rather than about
  a number. On the dialects `CATALOG_COMPOSERS` serves, a catalog read still *is* a bounded read
  (`sql.query.read`) whose statement the server writes, and the asymmetry inside that is real and
  documented on the tool: PostgreSQL yields a structured column inventory, while SQLite's
  `pragma_table_info()` is refused by the statement guard, so SQLite yields each object's own DDL text
  from `sqlite_master` instead. On every other dialect the read is the **sixth** descriptor,
  `db.schema.read` (#414) — the canonical set is six — and it is a different kind of thing rather than
  a variant: it sends no statement for a read-only transaction to bound, so what bounds it is the
  SHAPE of the call — `z.strictObject({})`, no input at all, the server choosing the method, and no
  model-authored text reaching an engine. It is R0 for that reason and `resourceCost: "heavy"` for the
  opposite one, since a provider schema read is N+1 round trips on most engines and samples documents
  on two.

  **The split is deliberate and permanent, not a step towards one path.** Collapsing PostgreSQL and
  SQLite onto the provider descriptor would look like simplification and would cost three things the
  composed path has and the provider path cannot: reads audited statement by statement rather than as
  one opaque call; foreign keys, which no provider can report on an engine that declares none; and
  SQLite's inventory, which is parsed out of the DDL text the engine stored and which its provider
  does not expose in the same shape. Collapsing the other twelve onto the composed one is the thing
  #414 exists because nobody can do: a catalog statement has to be written per dialect and verified
  against a live server, and until it is, refusing the dialect was the honest answer and reading the
  provider is a better one.
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

Its goal verifier is `agent-query-optimization.3`: the investigation baseline, **and** evidence that
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

**A plan is exempt from the baseline's emptiness clause, which is the same lesson a third time.**
A plan is a description of a statement, it arrives in one column, and the driver reports no
row count for it - so the artifact is complete and its `rowCount: 0` measures nothing. Driven live on
2026-08-17, every Optimize run in the drive ended `empty-evidence`, including one that compared real
PostgreSQL costs, recommended the right index and offered it to the editor, because the plan was the
only thing those reports had to cite: the product contradicted its own good answer, in its own voice,
at the end of the run. The exemption is one artifact **kind** and nothing more - an empty bounded read
cited by an optimization report still ends the run `empty-evidence`, because zero rows from a read is
the answer that read gave - and it is this rule's alone: `agent-investigation.1` and the two verifiers
composing on it are untouched, so the id bump is `agent-query-optimization.2` -> `.3`.

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

Two honest limits, each with a backlog entry: only an email shape is tested, because `LIKE`
cannot express a digit run (**B26**); and a profile that times out reports the failure rather than
falling back to catalog statistics (**B28**). A third is closed: SQLite stores no DDL for the index
it builds to enforce a `UNIQUE` constraint, so the composed index read cannot see it - the capture
now reads those out of the table's own `CREATE TABLE` and lists them as `(unique constraint)`, plain
words rather than a name that could be mistaken for a user's `CREATE INDEX`. `fk_unindexed` remains a
prefix test: an index serves the column it LEADS on, so `UNIQUE (note, parent_id)` does not cover
`parent_id`.

### The operations template

A run opened as `operations` answers a DBA's questions about a **live** database — the slowest
queries, the active sessions and which of them are blocked, the biggest tables, the unused indexes,
storage pressure — and it is the one workflow that is **not** built on the read class.

| Offered | Not offered |
| --- | --- |
| `inspect_operations`, `recommend_change`, `compose_report` | `inspect_schema`, `run_read_query`, `inspect_plan`, `profile_table`, `compare_plans` |

**Everything it leaves out is left out for one reason: those tools send SQL.** All three read-class
tools reach the database through `provider.queryReadOnly`, which only PostgreSQL and SQLite
implement, so offering any of them here would reintroduce — tool by tool — the exact engine
restriction this workflow exists to escape. `compare_plans` is left out because it names two
`inspect_plan` artifacts this run cannot produce: a tool that could only ever refuse is worse than
no tool.

**It is grounded, and with a different inventory from every other workflow** (#411). Until then this
was the one workflow that captured no schema at all, on the reasoning that an operations objective is
about what the engine reports about ITSELF. That reasoning is right about the question and wrong
about the evidence: the engine's reports are full of schema identifiers — a lock is held on a
relation, an index-stats row names an index, a slow query names tables — and a run that has never
seen the inventory reads all of them as opaque strings. So the exclusion was deleted, and an
operations run now takes the same context path as every other workflow: its own ledger, the
process-held reading, or a fresh capture. The capture itself is unchanged and stays **whole**,
because `holdSnapshotForConnection` shares a reading between runs and an operations-shaped partial
capture would later be handed to an investigation run as if it were complete.

What differs is the **packing** (`packOperationsInventory`, `context-snapshot.ts`):

- **Names and indexes, and nothing else.** Per table, its name and the names of its indexes with
  `unique` where it applies — never a column, never an index's column list, and no relations block
  beside it (`packRelations` is not called for this workflow in either mode). Column types are not
  what an operational objective asks about, and the relations graph is the most expensive part of the
  packing and the least useful part of it here.
- **Not ranked against the objective.** `packContextForTask` orders tables by relevance to the words
  you typed; an operations objective rarely names a table at all — what it will be about is whatever
  the engine happens to report during the run — so this renderer keeps the snapshot's own order,
  which is at least stable between drives of the same run.
- **A table with no index says so.** `name: no indexes`, never a bare name, because a name with
  nothing after it reads as a table whose indexes were not captured.
- **Fenced, quoted, bounded, and honest about what it left out.** The block goes through
  `fenceUntrustedContent` like every other database-derived text and is bounded by the same 6000
  characters; tables past the bound are reported as *"N further table(s) exist in this database and
  are not named here"*, and that notice names **no tool** — an operations agent run has no
  `inspect_schema` and a plan run has no tools at all, so a way out named there would be a way out
  neither reader holds (#350). Every identifier is also QUOTED inside the fence
  (`quoteIdentifierForPrompt`, `untrusted-content.ts`), which matters more here than in the ordinary
  inventory: there a mangled name fails at the engine when the model drafts SQL with it, whereas here
  the identifier list *is* the payload and the run is told to match what the engine reports against
  it — so an unquoted table name carrying a newline, or an index named `a, b_unique`, would add an
  entry nobody created and the run could recommend action on it.
- **What it CALLS them is the provider's word, not `TableSchema`'s.** The header, the omission notice
  and the note above it take their noun from `ProviderLabels.entityName` (#414), so a Redis Operate
  run reads "key pattern(s)" rather than "table(s)" — and where those rows are groupings this server
  derived rather than objects the engine holds, the plan rules say so in one sentence. See
  [what the inventory is an inventory OF](#what-the-inventory-is-an-inventory-of).
- **The opening note claims no completeness, because the block is bounded.** It says the inventory is
  as much as fits and points at the block for the count. A server sentence promising every table while
  the fenced block says 33 were left out is a contradiction a model resolves in the server's favour,
  and the failure it produces is precise: a lock reported on a table the packing dropped reads as a
  relation this database does not have.

Grounding reaches this workflow exactly as it reaches every other, and since #414 that means every
engine: `CATALOG_PLANS` serves PostgreSQL and SQLite, and every other dialect asks its provider to
describe itself instead of being refused on the dialect. Where the reading fails the run continues
ungrounded. What it is TOLD then is the capture's own DIAGNOSIS under a sentence of this file's own,
because the capture's ADVICE would have sent it to `inspect_schema`: it is told why no inventory was
read, that not one table name and not one index is established for it, and that it should take its
readings anyway. The run's tool rules and its opening note are deliberately
different strings — the rules are the same for every run of the workflow and hedge accordingly
("where this engine can be read"), while the opening note is built from what THIS drive actually
established. A test pins that the two agree: a grounded run is never handed a sentence saying it has
no inventory, and an ungrounded one is never handed a sentence saying it has one.

`inspect_operations` takes a **kind** and nothing a model wrote:

| Kind | Provider method | What comes back |
| --- | --- | --- |
| `sessions` | `getActiveSessions` | Who is connected, what each is running, for how long, and whether it is blocked |
| `slow-queries` | `getSlowQueries` | The statements the engine reports as costly, with call counts and times |
| `table-stats` | `getTableStats` | Row counts and sizes, plus dead rows where the engine tracks them |
| `index-stats` | `getIndexStats` | Size and scan counts, so an unused index is visible |
| `storage` | `getStorageStats` | Space and its growth |
| `health` | `getHealth` | One row of connection, size and cache figures |

Four properties carry the template:

- **The reach is the point.** Every provider declares these six methods, so this workflow runs on
  MySQL, Oracle, SQL Server, MongoDB and Redis as well as the two Phase 1 engines. That is asserted
  against what a run actually did, not against its tool set:
  `tests/evals/operations.test.ts` drives the arc on a MySQL preset that carries no `queryReadOnly`
  at all — as the real provider does not — so it can answer **no statement whatsoever**, and the
  eval asserts the run sent none.
- **A reading is an ordinary artifact.** It settles a step through `runStep` like `profile_table`,
  produces a `QueryResult` (rows and declared fields, projected by the server from the typed provider
  result), and is stored under its own operation id — so citations, `verifiedAgainst`, the artifact
  route and the rail's "Show result" all work unchanged. The columns are **declared per kind**, not
  derived from the first row, so an empty reading still says what it would have contained.
- **A provider that cannot serve a kind is refused, not crashed.** Three shapes, all typed. A
  missing method and an over-large reading are `reading-refused` refusals carrying
  `KIND_UNSUPPORTED_BY_PROVIDER` and `READING_OVER_BUDGET` — refusals rather than run-loop outcomes
  because by then the pipeline has allowed the call, a statement of the run's budget is spent and an
  execution is on the audit stream, so a step that settled as "never attempted" would contradict the
  ledger. A method that **throws** becomes an ordinary repairable `database-error` refusal with the
  engine's own words fenced, and that holds for a driver-native error too: the curated methods do not
  map their errors uniformly the way `queryReadOnly` does (`mongodb.getTableStats` calls
  `listCollections().toArray()` outside any try/catch), so anything that is not already a
  `DatabaseError` is wrapped at the seam rather than allowed to propagate and end the run `internal`.
  An over-large reading is refused rather than truncated, because a partial operational reading is a
  misleading one.
- **`limit` and `schema` are applied by the server, not merely passed on.** Only
  `getActiveSessions` and `getSlowQueries` take a limit at all, and four of the curated methods take
  no options whatsoever (`oracle.getTableStats`, `mssql.getTableStats`, `mssql.getIndexStats`,
  `mongodb.getTableStats`), so a selector honoured only in the arguments would be silently dropped on
  those engines — and the over-budget refusal would be advising a retry with a smaller limit that
  does nothing. The projection therefore narrows by schema and then bounds by limit itself.
- **Every reading is a moment.** The tool description says so, the run's opening rules say so, and
  the timeline says so on the entry itself — *"A moment, not a history: this reading says what the
  engine reported as it was taken."* A session list is who was connected as the run looked, and
  nothing here measures a trend.

Its goal verifier is `agent-operations.2`: a composed report, resting on what the engine said about
itself. **It deliberately does not compose on the investigation baseline**, which is the #356 lesson
applied rather than repeated: the baseline ends a run `empty-evidence` when every cited result
returned zero rows, and for an operational reading that is backwards. "No session is blocked", "no
slow query is recorded", "no index is unused" are answers, and they are the answers a healthy server
gives. A run that composed nothing is `no-report`, and a cancelled one says so instead.

The citation half of the rule — *your report must cite a reading you took* — is told to the model in
`WORKFLOW_TOOL_RULES`, and until #411 it was enforced where it could actually fail rather than judged
afterwards: `composeReportTool` refuses any claim whose evidence does not name something this run
produced, and the only citable thing an operations run could produce WAS a reading (it is offered no
other tool that settles a step, and it captured no schema snapshot). A verifier arm for "cited no
reading" would have been a verdict advertised to users that no run could ever show, which is the same
dead-arm objection that kept the other templates honest.

**Grounding removed the second half of that argument, so the arm exists now.** An operations run
captures an inventory, `composeReportTool` accepts `{"source":"context-snapshot","fingerprint":…}` as
evidence, and the run is handed the citation form for it as the preface to its own inventory — so a
report resting on the inventory alone composed, verified and scored `answered` without a single
reading behind it, on the workflow whose entire subject is what the engine says about itself. At least
one claim must therefore cite an ARTIFACT, and a run whose report cites only the inventory is
`no-reading`. The emptiness exemption above is untouched: an empty reading is an artifact this run
produced, and citing it passes. The verifier id moved to `agent-operations.2` with the rule, because
two runs' verdicts sharing one id under two different rules is what a versioned id exists to prevent.

Two limits stated rather than glossed:

- **The statement timeout cannot be enforced on this path.** `budget.statementTimeoutMs` becomes
  PostgreSQL's `SET LOCAL statement_timeout` because a statement is what is being sent;
  `getSlowQueries(options?)` and its siblings take no budget at all, so the deadline's clamp is
  advisory here. What still binds is the rest: the run deadline decides whether the call is admitted,
  the statement budget counts it, and the row and byte caps are applied by the projection.
- **`recommend_change` offers an index or a rewrite, and nothing else.** Most operational actions —
  kill a blocking session, vacuum a bloated table, drop an unused index — are neither, and widening
  the durable `change` union is a separate decision. The run's rules therefore tell the model to
  state those as claims in the report rather than file them as recommendations.

**The curated read is a fifth operation descriptor** (`db.operations.read`, R0 `metadata-read`) — the
shape the backlog's monitor-snapshot deferral asked for, "a descriptor shape for non-SQL reads". R0 rather than R1 is a
claim about what bounds it: an R1 descriptor must NAME the database-native mechanism bounding it, and
a curated provider call has none, because there is no statement for a read-only transaction to bound.
What bounds it instead is the input contract, which carries a kind out of a closed enum and two
scalars — no `sql` key exists on it at all. The honest edge: `SlowQueryStats.query` and
`ActiveSessionDetails.query` are statements somebody wrote, and a statement can carry literal values;
`ActiveSessionDetails.user` is an identity. That is inherent to "which queries are slow" and cannot be
redacted without answering a different question, so it is declared here — and an operator who does not
want it can deny this one operation id in the audit stream without denying any other agent read.

### The data-analysis template

A run opened as `data-analysis` answers a **question about the data itself** — "which region brought
in the most revenue last quarter", "how many orders have shipped but never been invoiced", "did
signups fall after the pricing change" — rather than a question about the database's shape or its
health. It is the only workflow whose bar asks the run to say *which result is the answer*, and the
only one that can.

| Offered | Not offered |
| --- | --- |
| The read class (`inspect_schema`, `run_read_query`, `inspect_plan`, `compose_report`), plus `profile_table` and `present_answer` | `compare_plans`, `recommend_change`, `inspect_operations` |

**`present_answer` is the tool that makes it a workflow rather than an investigation with a different
name.** Its verdict, `agent-data-analysis.1`, is the investigation baseline, an `answer-composed`
entry, and a report that cites that same artifact in at least one claim; a run that reports its
findings and produces nothing to show for them has answered a question about the data with prose
alone, and a run whose report is about some other result has put prose beside a picture.

**`profile_table` is borrowed from the assessment template rather than duplicated,** and for a reason
specific to this workflow: the schema carries no row counts, so a 400 M-row fact table and a 12-row
lookup table are indistinguishable in the inventory, and a `shipped_at` that is 80% null next to a
`placed_at` that is fully populated says which date column the business actually fills. Basic depth
answers both, costs one statement per table, and reads no value out of any column — which is what
makes pointing it at a table of personal data acceptable at all.

**It gets `medium` ER detail** — the columns that join, not every key's indexes. Joining a fact table
to the dimension a question groups by is a question about *which* columns join, which is the
optimization's need; how each key is indexed is what an assessment asks and an analysis never does.

**It carries the largest budget row** (60 turns, 42 statements, 900 s, 180 s of database time) because
its shape is iterative rather than repetitive: a handful of exploratory reads to find the fact table,
several attempts at getting one aggregate right, then a comparison window or two. See
[What bounds a run](#what-bounds-a-run) for what each figure buys, and
[Deployment](#deployment) for the reverse-proxy timeout its 900 s deadline requires.

Auto-execute (below) is offered on this workflow alone.

### Presenting an answer

`present_answer` records the one thing a ledger otherwise cannot express: **which result IS the
answer, and how it should be shown.** The read itself is already on the ledger — `tool-invoked`
before it, `tool-completed` after — but "this result is the answer, and it should be drawn as a bar
chart of region against net_total" is a decision, and it gets its own event, `answer-composed`.

**One workflow is offered it: `data-analysis`.** `DATA_ANALYSIS_TOOLS` names it and no other
`WORKFLOW_TOOLS` set does, so an investigation or an assessment that calls it is told there is no
such tool. That is the axis made load-bearing rather than an omission: `data-analysis` is the only
workflow whose verdict (`agent-data-analysis.1`) requires an answer, so it is the only one that can
produce one, and offering the tool to a run whose bar never asks for it would only distract it.

The same record decides three other things, so they cannot disagree with the tool set:
`AGENT_WORKFLOW_PRESENTS_ANSWER` (`src/lib/agent/types.ts`) is what the rail reads to decide whether
to offer the auto-execute checkbox, what `POST /api/agent/runs` reads to decide whether to accept an
`autoExecute` field at all, and what `investigation.ts` reads to decide whether to state
`AUTO_EXECUTE_RULE` to the model. `tests/unit/lib/agent/tools.test.ts` asserts over every workflow
that `selectAgentTools` offers `present_answer` exactly when that record says true — because a
workflow with the flag and no tool would promise a hand-over it cannot perform, and one with the tool
and no flag would take the setting and silently never offer it.

**What may be PRESENTED is narrower than what may be CITED.** A claim may rest on a plan the run
read — `recommend_change` is built on exactly that — so the citation check asks only "did this run
produce it". An answer is a different act: it nominates one result as what the question asked for,
hands that result's statement to the rail, and is what the verdict counts. So only a `sql.query.read`
result may be presented. Without that, a run could name an `sql.explain.estimate` artifact — the
engine's *description* of a statement, with nothing executed and `QUERY PLAN` text for rows — and
satisfy `agent-data-analysis.1` without having read the data it was opened to analyse. A profile is
excluded on the same line and deliberately: it is a real reading, but it returns counts the server
composed about a table rather than rows the model asked for, its statement is the server's so there is
nothing of the model's to hand over, and its single aggregate row fails every chart check — so
admitting it would only change which refusal it gets. The check runs **before** the statement is
resolved, because a plan step does carry a drafted statement; a check after it would have accepted the
plan. One consequence, recorded rather than left to be found: the gate's first condition can no longer
fail from this layer, since a read's own statement is by construction among the statements the run
executed. It stays enforced in `auto-execute.ts`, which is pure and enumerated over every combination
in its own suite.

| Field | Where it comes from |
| --- | --- |
| `artifact` | The model names the artifact id. Checked against this run's own ledger the way a citation is, and then narrowed: only a data read may be the answer. |
| `sql` | **The ledger**, never the model: `tool-completed` says which step produced the result and `statement-drafted` says what that step asked. |
| `presentation` | The model: `{"kind":"table"}` or `{"kind":"chart","spec":{…}}`. |
| `handover` | The run, from its own record and the gate below: `none`, `applied` or `auto-executed`. |
| `handoverWarning` | The gate, when it declined. Present exactly when `handover` is `applied`. |

**A chart spec is a specification, never a picture**: a type from a closed list
(`bar`, `line`, `area`, `pie`, `scatter`, `stacked-bar`), an `x`, a non-empty `y`,
and a `caption` that is the model's own prose and is rendered quoted. No colours, no title,
no size, no aggregation — presentation belongs to the app, and an aggregation here would be a second
aggregation nothing recorded. `histogram` is deliberately absent although `DataCharts` offers it: it
bins raw values in the browser, so the picture would show something the artifact does not contain. A
bucketing wanted is a bucketing the SQL should do, and then it is a bar chart of an aggregate the run
can cite.

**There is no `series` field, and its absence has a history worth keeping.** One was invited by the
contract, accepted by `chartSpecSchema`, checked against the artifact's columns, written to the
durable ledger and narrated by the rail — and then discarded by `DataCharts`, which has no series
split and never had one (several series ARE several `y` columns there). So the picture on screen was
not the picture the ledger recorded, and nothing said so. The field is gone from all four layers
rather than implemented in the renderer, and the contract now redirects a model that wants several
series to name several `y` columns. Inviting only what the renderer can draw is the same rule as
never stating a rule a model's tool set cannot satisfy, one level down.

**Why the spec is validated rather than trusted:** `DataCharts` renders a value it cannot parse as
`Number(value) || 0`. A chart over the wrong column does not fail and does not render blank — it
renders a confident flat line of zeros, inside this application's own frame. So every spec is checked
before the event is written, and each check has its own refusal that restates the half of the contract
it enforces, because a refusal is read by a model that is demonstrably confused:

| Refusal | What it means |
| --- | --- |
| `ANSWER_ARTIFACT_UNKNOWN` | The answer names a result this run never produced. |
| `ANSWER_NOT_A_DATA_READ` | The result is this run's and is not a reading of the data — a plan, or a profile. It may still be cited as evidence. |
| `ANSWER_STATEMENT_UNKNOWN` | The result is this run's own data read and no statement the model drafted produced it (a catalog read), so there is no statement to hand over. |
| `ANSWER_RESULT_RELEASED` | The rows are no longer held, so a chart cannot be checked against them. |
| `CHART_COLUMN_NOT_IN_RESULT` | A column named is not a column of that result. The refusal **lists the real column names, fenced** — they are engine-supplied text like any other. |
| `CHART_COLUMN_NOT_NUMERIC` | A `y` column does not hold numbers, by the same >80 %-of-non-null rule `DataCharts` applies. |
| `CHART_TOO_FEW_ROWS` | Fewer than two rows; the component renders an empty state below two. |
| `CHART_SHAPE_MISMATCH` | A pie with more than one `y`, or a scatter whose `x` is not numeric. |

The numeric check reads the **live** artifact store, which is why it can read rows at all: that store
is process memory released when the run ends, and `answer-composed` is written during the run. One
instant later the rows are gone, and the honest answer then is `ANSWER_RESULT_RELEASED` rather than a
spec that passed because nothing was left to check it against.

**A run answers once, and the ledger is what says so.** `present_answer` is non-terminal — only
`compose_report` ends a drive — so nothing in the loop stops a model calling it a second time, and a
second successful presentation would write a second `answer-composed` entry. On an auto-execute run
the rail carries out every entry it is given, so that is two statements delivered to the editor and
two run there without a timeout, under a checkbox that promised the final answer. So the tool refuses
a second presentation with `ANSWER_ALREADY_RECORDED`, decided from the run's own events **before the
arguments are parsed** (an argument refusal would invite the model to correct them and call again) and
costing no repair attempt, because this tool reaches neither the repair ledger nor a database. The
entry is durable, so a resumed drive is told the same thing.

**A table is a first-class outcome, not a fallback.** A single scalar, a one-row result and a result
with no numeric column are all answers, and every one of them would render an empty chart. The
refusals say so in their own text, and a table answer is accepted with no chart validation at all.

**And a chart is never a substitute for a claim.** The presentation shows an artifact, the artifact is
the evidence, and the claim is the answer — a run that drew a picture and reported nothing has drawn a
picture. The tool's own reply says so and points at `compose_report`.

### Handing the answer to the editor (auto-execute)

**Auto-execute never produces the answer.** The answer is always an artifact the run already read,
under the read-only profile, inside the statement ceiling, counted against the run's budget and
written to its ledger. What the setting adds is one further thing: the same statement is also placed
in the user's editor **and run there**, at the editor's 500-row limit and with no statement timeout.

**The replay is served under the engine's own read-only boundary, on its own profile.** This is the
one thing about auto-execute that is a security property rather than a convenience, and the first
implementation did not have it: the replay went to `POST /api/db/query`, the editor's ordinary
read-WRITE route, whose only protection is `isDangerousQuery` — a check on the statement's TEXT. The
agent's own read is not merely called read-only, the database enforces it (`BEGIN READ ONLY` on
PostgreSQL, `PRAGMA query_only` on SQLite), and text is not where the difference lives: a `SELECT`
may invoke a VOLATILE function that performs an `INSERT`, which the agent's transaction refuses
(SQLSTATE 25006) and a read-write session performs. The identical statement was therefore harmless
where the run proved it and harmful where it was replayed, under a checkbox promising that writes and
DDL are refused either way.

It now goes to `POST /api/agent/runs/{runId}/handover`, which runs it through `provider.queryReadOnly`
under a **third execution profile**, `agent-handover`:

| | `agent-read-only` (the run's own read) | `agent-handover` (the editor replay) |
| --- | --- | --- |
| Opened with | `readOnly: true`, `agentUser` credential, profiled cache | identical |
| Requires a database-native read-only statement path | yes | yes |
| Rows | 200, refused not truncated | 500 (`DEFAULT_QUERY_LIMIT`), refused not truncated |
| Statement timeout | 10 s | none — spelled as 2 147 483 647 ms |
| Bytes | 256 KiB | 64 MiB |

The agent's own profile is unchanged: what a MODEL may spend on a run and what a USER's replay may
spend are different questions, and a shared row would have made a later change to one move the other.
"No timeout" is an explicit ceiling rather than an absent field because `assertReadOnlyBudget` requires
every field to be a positive integer — PostgreSQL interpolates the value into
`SET LOCAL statement_timeout = N`, which takes no bind parameter — so admitting `undefined` would
trade a real guard for a cosmetic one. 2 147 483 647 ms is PostgreSQL's own 32-bit limit for the
setting, a little over 24 days; nothing a user waits for reaches it, and the word that does not hold
is "no".

**The route will not run SQL it is handed.** The request carries no body at all: the statement is read
from the run's own `answer-composed` event, and the connection from the run's persisted
`connectionId`, resolved server-side under the run's persisted actor. So nothing a user types reaches
this profile, and the route is not a general "run this without a timeout" endpoint. It also honours
the gate rather than re-deciding it — only `handover: "auto-executed"` is replayed; `applied` and
`none` are refused with `409` and the gate's own warning. A run answers once, so "the answer" is
unambiguous and needs no id in the path.

It writes **no ledger event**, and cannot honestly: the run may already have finished, a finished
ledger does not accept appends, and the ledger's claim is that everything the RUN did is in it. The
replay is logged instead.

**The setting lives on the run record** (`AgentRunRecord.autoExecute`), beside `mode` and
`workflowType`, and for the same two reasons: a resumed drive must behave like the drive that died,
and no later request may widen a run once it is open. `POST /api/agent/runs` is the only place it is
decided — absent means `false`, and a value that is not a boolean is refused rather than coerced.

**It is offered on `data-analysis` in agent mode and nowhere else,** because the hand-over is
`present_answer`'s and that tool is offered to that workflow alone. The rail renders the checkbox
only there, the route **refuses** `autoExecute: true` on any other workflow or in planning mode
rather than normalising it to `false`, and `investigation.ts` states `AUTO_EXECUTE_RULE` to the model
only when the same record says the run can present an answer. All four read
`AGENT_WORKFLOW_PRESENTS_ANSWER`.

**And only to a host that can actually run a statement.** `onRunStatement` is an optional prop of
`AgentRail`, so an embedding host may have no runner at all; the rail then renders no checkbox and
sends `autoExecute: false` however the control was left. It used to offer the promise regardless and
fall back to `onApplyStatement`, which placed the statement unrun while the timeline entry told the
user it had run on their connection — a surface claiming an execution that did not happen. A
capability the host lacks is not offered, which is the rule the stop control and the hydration
affordances already follow.

This is worth stating because the first version got it wrong in an instructive way: the checkbox
rendered for every workflow in both modes. Ticking it on an Investigate run promised a user that the
final statement would be placed and run in their editor — a hand-over that workflow has no tool to
perform — while the system prompt told the model to "call `inspect_plan` on the statement that IS the
answer before you present it", a presentation it had no tool to make, and on `operations` a tool the
run is not even offered. That is the #350/#356 shape exactly: a rule stated to a model whose tool set
cannot satisfy it. A refusal rather than a silent downgrade is the second half of the fix — a caller
that asked for a hand-over and got a run that will not do it should be told, because a silent
downgrade is how a user comes to believe a feature ran.

**The gate is three conditions, all of which must hold** (`src/lib/agent/auto-execute.ts`, a pure
function enumerated over all eight combinations by its test):

1. **The run executed this exact statement itself.** A final statement wider than anything the run
   ran is never auto-executed. This is close to free and it excludes row explosion outright, because
   the agent path refuses rather than truncates: an artifact exists only for a statement that
   provably came back inside the row, byte and time ceilings. A statement the run only *explained* is
   not a statement it executed.
2. **The plan reads as safe**, per engine, with unknown resolving to risky. **PostgreSQL:** the
   access path is `index` or `mixed` — never `full-scan`, never `unknown` — and the reported
   `estimatedCost` is at most 50 000. **SQLite:** every step a `SEARCH`; any `SCAN`, a mixed plan or
   an unreadable one is risky. SQLite is stricter on purpose: `EXPLAIN QUERY PLAN` reports no cost
   and no row estimate to weigh, the engine does not preempt a read that overruns, and a runaway read
   blocks writers and this application until it finishes. Any other dialect is risky, the same
   fail-closed posture `summarisePlan` takes.

   **A plan the server could only PARTLY read is risky too**, which is the same rule one level down.
   `summariseSqlite` recognises `SEARCH` and `SCAN`, so a plan holding either of those beside a step
   it does not interpret — `USE TEMP B-TREE FOR ORDER BY`, or anything a later SQLite emits —
   summarised as a flat `index` and passed the gate: "said nothing about that step" read as "said it
   was cheap". The summary now carries `uninterpretedStep` beside `access`, and the gate refuses on
   it before either engine's rule. The flag sits beside `access` rather than collapsing it to
   `unknown`, because what the recognised steps said is still true and `compare_plans` still wants
   it — the comparison is described exactly as it was before the field existed. **PostgreSQL sets no
   such flag,** deliberately: a PG plan is mostly nodes this reading does not tally (`Sort`,
   `Hash Join`, `Aggregate`), none of them a relation access, and the engine both reports a whole-plan
   `Total Cost` this gate already weighs and preempts a statement that overruns. On SQLite the access
   reading is the gate's entire evidence, and a reading that skipped a step is not evidence.
3. **The measured elapsed time**, `artifact.summary.elapsedMs` for that very result, at most 2 000 ms.
   Already on the ledger, so it costs nothing to read.

The plan comes from an `inspect_plan` **this run performed** on the answer's own statement, joined to
it through the ledger the way `compare_plans` joins its two sides. Where the run holds none the gate
reads risky, so a run opened with the setting is told in its opening rules to inspect the plan of the
statement that IS the answer before presenting it — one statement out of the workflow's budget, which
is the price §2.4.0 names. The server does not take that plan on the run's behalf: a statement
executed there would carry no `tool-invoked` and no `tool-completed`, and the ledger invariant is that
everything a run did is in its ledger.

**The join is on `fingerprintStatement`, the repair ledger's canonical form** — the two statements are
drafted independently, one as `run_read_query`'s argument and one as `inspect_plan`'s, so exact string
equality made the gate resolve `plan-risky` whenever a model reformatted its own aggregate. Whitespace,
comments, unquoted case and a trailing terminator normalise away; literals and quoted names keep their
exact spelling, so a cheap plan of `WHERE id = 1` cannot license `WHERE id = 2`.

**Except for the one comment that is not trivia.** A statement carrying an optimizer directive — a
`+`-marked comment block, Oracle's `--+` line form, or MySQL's executable comment — takes no part in
this join, on either side (`hasOptimizerHint`, `src/lib/sql/optimizer-hints.ts`). Under `pg_hint_plan`
such a comment is an instruction to the planner, so the cheap indexed plan taken for the unhinted text
says nothing about a statement whose hint forces a sequential scan, and the canonical form normalises
the difference away — condition 2 would have passed with a plan that is not the plan of the statement
the editor runs. It fails closed rather than joining on the hint text, because joining would assert
that the plan the run holds IS the hinted plan, and `inspect_plan` obtains it by sending the statement
under an `EXPLAIN` prefix; whether `pg_hint_plan` still reads a hint from behind one is a property of
an extension this repository does not ship and cannot verify. A hinted answer is therefore placed in
the editor unrun with the gate's own warning, like every other statement the gate cannot weigh.

**`fingerprintStatement` itself is unchanged, deliberately.** It is the repair ledger's canonical
identity and is consulted before every statement, and there a comment being trivia is a bound rather
than a bug: a model re-sending a statement the ledger already refused, with a comment added, would
otherwise fingerprint differently and be admitted again. The distinction matters only at the plan
join, so it lives at the plan join.

**Both thresholds are approved and pending live measurement.** 2 000 ms and 50 000 were approved on
2026-08-14 as the starting point a measurement then confirms or corrects; no run has been measured
against either reference engine yet. The reasoning behind them: the run's own statement ceiling is
10 s, so a 2 s reading leaves roughly a 5x margin inside a ceiling the editor does not have; and
50 000 planner units at the default `seq_page_cost = 1.0` is roughly 400 MB of sequential reading,
seconds rather than minutes. Neither is a time — a planner cost is in arbitrary units calibrated by
`seq_page_cost` / `random_page_cost` and by how recently `ANALYZE` ran — which is exactly why it is
not the only condition.

**Any single condition failing records `handover: "applied"` with a warning naming it** — never a
silent skip. A user who ticked the box and finds the statement sitting unrun has to be told that was
the feature working, so the warning is in the timeline entry, in the run's own register: *"Not run for
you: … so this one is yours to run."*

**No `LIMIT` is ever injected.** The statement is handed over verbatim. The agent's caps refuse rather
than truncate, which is what lets a delivered result be trusted as complete; an injected `LIMIT` would
break that invisibly, because a bar chart of 200 of 4 000 regions looks like a complete bar chart and
no number on it is wrong. A model-written `ORDER BY … LIMIT 10` is honest, because the model can then
say "the top ten" in its claim.

**`auto-executed` records that the run handed the statement over, and nothing more.** The replay
produces no ledger event: the run may have ended before it happens, and a finished ledger takes no
appends. The timeline entry says so in as many words — what the editor did is visible in the editor.

**The browser carries the outcome out; it does not weigh the gate again.** The rail reads `handover`
off the ledger and delivers the statement once per entry: `auto-executed` goes to the runner and
nowhere else — a host without one delivers nothing rather than applying it silently, since the entry
says the statement ran — `applied` places it unrun beside the run's own reason, `none` hands over
nothing. The statement is never lost either way: every answer entry carries `applySql`, so the
control beside it still offers the statement as the user's own action.

**And it delivers only while the editor is still on the connection the run was opened on.** The
statement itself can no longer reach the wrong database — the route resolves the run's own persisted
connection server-side — but the RESULT would land in the editor tab, and the tab belongs to whatever
connection the user is on now, so another database's rows would be presented as this connection's
answer. `AgentRail` remembers the connection it opened the run on and declines when the two no longer
match, saying so beside the entry that claims the execution: that entry is folded from the ledger and
still says the statement ran, so the contradiction belongs where the sentence is. The narrowing is
about the hand-over that RUNS: an `applied` entry claims no execution, so a connection change does not
change what it means. It is enforced in the rail rather than in the host's callback, because that
callback is an optional public prop and a guard written in one host is one the next host does not
inherit.

The re-run goes through `useQueryExecution.executeHandedOverStatement`, which takes the RUN and not a
statement to execute: what it sends is the run id, and the statement it is also given is the text the
editor SHOWS while the answer arrives. The row limit is the server's, not a request option, which is
what keeps a tab a user widened for a statement they wrote from widening one the run handed over
(§2.1). The setting itself is offered as a checkbox in the rail that states those bounds, sent with
the start request and frozen for as long as the run is open, which is the browser side of the
server's own rule.

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
policy gates by name — the planning model is handed no tool in any workflow, nothing above risk class 1 can
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

**A binary cell reaches the model as hex, not as its wire JSON** (2026-08-24). A `bytea`, `BLOB` or
`blob` value used to be put in the prompt by a plain `JSON.stringify`, so the model was handed
`{"type":"Buffer","data":[1,2,171]}` — roughly four characters of context per byte of data, and a
shape it had to interpret — while every other surface in the product showed `\x0102ab`. `renderRows`
now reads the same `asBytes`/`binaryText` module the grid, the row detail sheet and the CSV read.
Measured on a 160-byte value: 556 characters before, 322 after. The model gets the FULL hex rather
than the grid's 32-byte compact-cell preview, because that cutoff exists for a one-line cell and a
model asked to compare two values needs the whole one. `state-guard.ts` is unaffected either way:
`RESULT_PAYLOAD_KEYS` refuses a raw result set wholesale, so no row value reaches run state.

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
single-column keys or the columns of one composite key: the composed read is one row per referencing
column and carries no constraint identity, so nothing downstream can group them — the group is one
line that names the columns and says the pairing is unknown), and the block is bounded in **characters**, because a
count of edges is not a bound on a prompt.

**An empty relations read is three facts, and the block says which one it has**
(`er-diagram.ts`). A zero-row read cannot tell a schema that declares no foreign key from a role that
cannot see the ones it declares, and a run that treats those as the same thing states a falsehood
with a citation attached: measured on the seeded dvdrental, the `SELECT`-only role
[`docs/AGENT_DEMO.md`](./AGENT_DEMO.md) prescribes read 0 rows where `pg_constraint` holds 18, and an
investigation answered "there are no declared foreign key constraints between tables in the
database" — cited, confident and wrong. The read is fixed at its source (`composePostgresRelations`
reads `pg_constraint`, which needs only `USAGE` on the schema), and that fix does not settle the
general case, since any role can be narrower than its database. So the block distinguishes three
cases: an engine with no such construct is told nothing could have been found (from
`ProviderCapabilities.declaresForeignKeys`, never from the connection's type); a read that returned
rows gets the rows; and a read that returned none on an engine that has them is told what was not
seen — the limit of the reading, plus an instruction not to report that this database has no foreign
keys and to treat any join the run relies on as inferred from names rather than declared. It is the
same rule the inventory's omission notice follows: what was not read is said, because silence gets
read as absence.

## What bounds a run

The frozen execution policies (`AGENT_WORKFLOW_BUDGETS` in `src/lib/agent/execution-policy.ts`) are
data the pipeline enforces. There is one row per workflow, and the tool layer picks the row for the
run's own persisted workflow rather than accepting a policy from a caller — an injectable policy
would be a seam through which a route or a resumed run could widen the agent's privileges, while a
workflow type is decided once when the run opens and read from the ledger thereafter.

**The four figures that differ per workflow:**

| Workflow | Model turns | Statements | Run deadline | Database time | Policy version |
| --- | --- | --- | --- | --- | --- |
| `investigation` | 36 | 30 | 450 s | 90 s | `agent-read-only.investigation.1` |
| `query-optimization` | 36 | 30 | 450 s | 90 s | `agent-read-only.query-optimization.1` |
| `database-assessment` | 48 | 45 | 630 s | 135 s | `agent-read-only.database-assessment.1` |
| `operations` | 20 | 18 | 360 s | 80 s | `agent-read-only.operations.2` |
| `data-analysis` | 60 | 42 | 900 s | 180 s | `agent-read-only.data-analysis.1` |

**These figures are approved and pending live measurement.** They were approved on 2026-08-14 as the
starting point a measurement then confirms or corrects; no run has been measured against them yet.
`operations` is lower than the analytical rows on purpose: the **model** sends no SQL, so it never
drafts a statement, never repairs one and never iterates towards an aggregate that came out wrong —
and its reads come from a closed set of six curated kinds, so twelve of its statements are every kind
twice, once broad and once narrowed to a schema.

**The other six pay for #411's grounding**, and they were ADDED rather than taken out of the readings
on purpose: a ceiling left at 12 would have paid for the inventory by silently costing the run a third
of the readings it exists to take. Grounding's own cost is smaller than six. A catalog capture is
three statements on PostgreSQL and two on SQLite, one on every other engine (#414: `db.schema.read`
takes no selector and makes one call), and the statistics read — plan mode only, and PostgreSQL and
SQLite only — adds one on PostgreSQL and two on SQLite (it probes `sqlite_stat1` before reading it), so
the worst case before the first turn is four in plan mode and three in agent mode, which is the mode
where the reading ceiling binds. `AGENT_WORKFLOW_BUDGETS` therefore did not move in #414: the path it
added is the cheapest of the three. The remainder is deliberate slack in a row nothing has been measured against yet, and
the wall clocks are the same slack in time: at a 10 s statement timeout, four catalog reads can be 40 s
of database time on their own. `maxModelTurns` does not move, because grounding is the server's work
before the first turn and costs no turn. The policy version moved with the figures, to `agent-read-only.operations.2`: a row whose
ceilings changed while its version did not would make a `STATEMENT_BUDGET_EXCEEDED` on a ledger
untraceable to the numbers that produced it.

`data-analysis` is the largest row, and every one of its four figures is bought rather than
inherited. An analytical run's shape is a handful of exploratory reads to find the fact table,
several attempts at getting one aggregate right — which is where the repair budget goes — and then
one or two comparison windows: it needs room to ITERATE where an assessment needs room to repeat.
Its database time is the ceiling most likely to bind first, because a `GROUP BY` over a fact table is
not a catalog read, and 900 s is what makes 60 turns reachable rather than decorative (900 s − 180 s
of database time is 720 s of model time, which is 60 turns at the slow end of this workload's
latency). **A 900 s run outlives the default idle timeout of most reverse proxies** — nginx's
`proxy_read_timeout` is 60 s — so a deployment in front of a container must raise its own timeout to
at least the longest deadline it wants to serve, and there is no re-attach path for a stream cut
mid-run (B9).

**What every row shares:**

| Bound | Value | Counts |
| --- | --- | --- |
| `statementTimeoutMs` | 10 s | Per statement, clamped further by the run deadline. |
| `maxResultRows` / `maxResultBytes` | 200 / 256 KiB | Compared after the driver has materialised the rows, so an oversized read is refused but still paid for at the database. |
| `maxConcurrentExecutions` | 1 | The loop is sequential; a run cannot fan out. |
| One model call | 90 s | Whichever of this and the run's remaining time is smaller applies. Not per workflow: how long one request may hang is a property of the transport, not of the question. |
| Repair attempts | 3 | Statements that failed **at the database**. |

The statement budget, the database time and the wall clock are enforced through the policy the run's
workflow names, and the version carries the workflow so a recorded deny code traces back to the
number that produced it. The turn ceiling is the backstop for a loop that never reaches the database
at all, and it moves with the wall clock rather than alone: at a deadline that cannot pay for the
turns, a larger turn ceiling only changes which word the ledger records.

**A run keeps its last turns back for its report.** Within `AGENT_REPORT_RESERVE_TURNS` (2) model
turns of its turn ceiling, or `AGENT_REPORT_RESERVE_MS` (20 s) of its run deadline — whichever it
reaches first — the loop pushes one server-authored user message before the next turn: this is your
last turn, call `compose_report` now with what you have established, and a claim still has to cite an
artifact this run read. Without it a run that reaches a ceiling ends `failed` / `turn-limit` with no
`report-composed` entry and a verdict of `unanswered`, and the whole spend buys nothing.

Four properties make that a message rather than a weakening, and each is asserted rather than
claimed: it **costs nothing to reach** (`compose_report` reaches no database, so the notice spends no
statement, takes no deadline admission and consumes no turn of its own — it rides on the turn that
was about to be taken); it **does not lower the bar**, because `composeReportTool` still checks every
citation against the run's own event log, so a forced report is a cited report or it is no report;
it **is not a rule change**, so it touches neither the policy version nor the goal verifier, and a
run that ignores it still ends `turn-limit` or `deadline-exceeded` exactly as before; and it is
**said once per drive**, in planning mode never — that mode has no `compose_report` to call, and
telling a model to use a tool it does not have is the #350 failure. The wording repeats the citation
sentence the run's own rules carry (`AGENT_CITATION_RULE`) rather than a second phrasing of it, for
the same reason. The rail states the reserve beside the ceilings, so a run that ends short of every
figure reads as one that was asked to stop rather than one that gave up.

**The per-call ceiling exists because the run deadline used to be the only bound on a single
request.** A measured run ended at exactly 300.0 s — the whole run deadline of the day — with a
two-event ledger: one call never answered
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

## Supported models

Twelve models run every agent surface. Each cleared all six — Investigate, Optimize, Assess, Operate,
Analyze and Plan — five consecutive times, at the turn limit the product ships, which is 30 of 30
runs.

**The table lives in [`docs/llms/README.md`](llms/README.md)**, with each model's page beside it,
and this page deliberately does not repeat it. There used to be a copy here, and its links pointed
at a `docs/models/` directory that does not exist.

Its numbers differed from the published ones in every row, and the reason is worth stating because
it is not the one first written here: they were a DIFFERENT SWEEP, not a drift. Running all 300
runs back to back takes about three and a half hours, and a machine under that load is slower —
one model scored 1/5 on a surface at 87 to 93 seconds a run and 5/5 an hour later at 36. The cells
that sweep lost were re-measured rested, and the rested figures are the published ones. So
`gemma4:26b` at 46 s/180 s and at 36 s/92 s are both real: the first is what it did during a
back-to-back sweep, the second what it does rested.

Two tables of the same thing is still the defect, because neither said which sweep it was and a
reader had no way to tell — while [`methodology.md`](llms/methodology.md) had said all along that
sustained load is part of the measurement. The condition was documented; it was simply not
attached to the numbers. One home, and that page is where the conditions belong.

Which model to run, what each needs that the others do not, and how to measure one these pages do
not cover, are all under [`docs/llms/`](llms/README.md).


Nothing prevents another model from being configured — the capability probe below decides what any
given endpoint can do, and there is no allow-list in the code. What the ten have is a measurement.

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
buys a run that investigates the database itself. Offering is honest and deciding is not — the same
rule T1's shortcut follows, for the same reason: a click that spent model budget would be a different
feature. What plan mode cannot do is left plainly stated rather than implied: the model there holds no
tool, so it cannot follow one reading with another, and what it drafts is a statement the user runs
themselves. A user pointed at that mode deserves to know it before they ask.

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
| `planning` | The run left non-empty closing prose, **and** that prose was its deliverable: a drafted statement on the ledger, or an explicit `NO STATEMENT:` refusal. That mode is toolless and can never cite evidence, so judging it by the investigation rule would fail every planning run that did its job — but prose alone was how a generic lecture scored `answered` for as long as it did. `operations` planning is exempt: its plan deliverable is prose by decision, and the exemption survives that workflow's rules welcoming a fenced reading — welcome is not required, and a run that produced no block may have answered its objective perfectly, so a bar asking for one would fail it. Which engines can express a reading as a statement is deliberately not the basis: a Redis Operate plan was observed writing `INFO memory` into a block its editor runs. | `no-plan`, `no-statement` |
| `agent` (investigation) | The run composed at least one claim, **and** the claims do not rest entirely on empty results. | `no-report`, `empty-evidence` |
| `agent` (query-optimization) | The baseline above with **plans exempt from its emptiness clause** (a plan's row count measures nothing), **and** either a plan comparison on the ledger or an index recommendation citing a plan this run read. `agent-query-optimization.3`. | the above, plus `no-plan-comparison`, `no-plan-evidence` |
| `agent` (database-assessment) | The baseline above, **and** a table profiled. `agent-database-assessment.1`. | the above, plus `no-table-profile` |
| `agent` (operations) | A composed report, **and** at least one claim in it citing an artifact this run read. `agent-operations.2`. **Not** composed on the baseline: an empty reading is an answer, so the emptiness clause is dropped — and an empty reading still satisfies the citation arm, because the artifact exists. The arm was added by #411: the run gained a citable schema inventory, so "cite a reading" stopped being enforced by composition alone. See [The operations template](#the-operations-template). | `no-report`, `no-reading`, `cancelled` |
| `agent` (data-analysis) | The baseline above, **and** an `answer-composed` entry: which result IS the answer, and how to show it — **and at least one claim citing that same artifact**, so the report is about the result it presented. `agent-data-analysis.1`. | the above, plus `no-answer`, `answer-uncited` |

**Why `agent-data-analysis.1` asks for an artifact rather than for a picture.** Every valid answer
this workflow can give produces an `answer-composed` entry: a chart of an aggregate, a table for a
one-row or non-numeric result, a single number as a one-row table, and a two-window comparison are
all one artifact presented one way. A rule that required a *chart* would have been stated in terms of
an artifact only some of the valid answers can produce — and an earlier draft made the verdict depend
on the editor hand-over instead, which would have scored a run `unanswered` for having a checkbox
switched off. Both are the #356 shape, and the rule was changed before any of it was written.
`tests/evals/data-analysis.test.ts` drives the one-row case and the auto-execute-off case directly,
because a requirement about what a run produces is enforced only by something that runs one.

**And why it also asks the report to be ABOUT that artifact.** A cited report and a presented result
were two unconnected facts, so a run could chart artifact A while every claim cited artifact B and
score `answered` — unrelated prose beside a picture, invisible to every other field on the ledger.
One claim citing the presented artifact is what links them, and `answer-uncited` is the shortfall
when nothing does. The arm was checked against both halves before it was written: it is **producible**
because the model holds that correlation id at the moment it needs it — it passed the id to
`present_answer` one turn earlier, the tool names it back, and the artifact is a `tool-completed`
result of this run, so `compose_report` accepts a citation of it; and the model is **told**, in the
workflow's opening rules, in `present_answer`'s description and in what that tool says back, where
the id itself can be named. One claim, not every claim: a report says more than the picture shows and
should. `tests/evals/data-analysis.test.ts` drives both directions — the ordinary read/present/report
arc still scores `answered` with nothing added, and a run that presents its second result while
reporting about its first scores `answer-uncited`.

The verdict id stayed `agent-data-analysis.1` through that change, which is the one case where
tightening a rule under its own id is defensible: an id is versioned because verdicts outlive the
rule, and this one had never left the branch that introduced it — no release carried it and no
fixture recorded a verdict under it, so there was no reader to protect and a `.2` would have put a
dead id in the union for a rule nothing was judged by. Once it is on `main` the rule is frozen and
the next change to it is `.2`, exactly as `agent-query-optimization.1` → `.2` was.

Its stated blind spot: a run that answers purely from the schema snapshot — "which table holds
sales?" — cites the snapshot, passes the baseline, has no artifact to present, and is scored
`unanswered`. That is deliberate. This workflow's objective is a question about the DATA, and an
analysis that read none is not an analysis; the remedy for a schema question is to route it to
`investigation`, not to widen what counts as evidence here.

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
- **The verdict is on the ledger, beside the status rather than instead of it** (ratified
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
| **A TOOLLESS model drove both panels.** Each posted a prompt and rendered what came back, so any configured model produced an answer — including one that cannot call a tool, which is what a small local `ollama` model usually is. | An agent run is refused before it opens: the start path probes the model, and an established incapability is a `422` naming what could not be established. What such a model can still drive is planning mode, which is toolless by contract: the model there is handed no tool, runs no statement of the user's, writes nothing, and drafts a statement for the user to run themselves. | `src/lib/agent/capability-gate.ts`; `tests/isolated/agent-capability-gate.test.ts`; [What a refused model looks like in the app](#what-a-refused-model-looks-like-in-the-app). |
| **One click that RAN the model's SQL.** NL2SQL's Run and Autopilot's Execute pushed model-authored SQL — including DDL — straight into the studio's execution path. | The rail hands a statement to the **editor** and never runs it: an explicit "Apply to editor" on a drafted statement, a recommendation, or a plan run's drafted statement. Nothing in the runtime executes a proposed statement. A plan run's statement is offered through the answer card rather than the shared control, because that card is also what marks a statement the guard did not classify as read-only and names what the inventory does not hold, in the engine's own noun — the marking and the offer have to arrive together, and since the 2026-08-21 redesign that offer exists in exactly one place. | `src/components/agent/timeline.ts` — the `statement-drafted` and `recommendation` entries carry `applySql`, and `plan-statement-drafted` deliberately does not; `src/components/agent/AnswerCard.tsx` — the marked hand-off, and `AgentRail.tsx` withholding every other one; `tests/evals/query-optimization.test.ts` — the recommendation is recorded and no `CREATE INDEX` reaches the database. |
| **Proposed a statement the run never sent.** NL2SQL's product was a statement, whatever the model wrote. | Only `recommend_change` proposes an unexecuted statement; it accepts `index` or `rewrite`, the statement must match the card it is filed under, and it belongs to the `query-optimization` workflow. An investigation — what a plain-English question opens — cannot propose anything. | `src/lib/agent/tools.ts` (`recommendationSchema`, `matchesCard`, `QUERY_OPTIMIZATION_TOOLS`); `tests/evals/legacy-surface-coverage.test.ts`. |
| **Read live monitoring.** Autopilot's whole input came from `/api/db/monitoring`: slow queries, index usage, table statistics, cache and connection metrics. | **Restored, and bounded.** `inspect_operations` reads the same provider methods under the `db.operations.read` descriptor, and it reaches ONE workflow: a run opened to Operate. An investigation or an assessment is still offered nothing that reads monitoring, so "the agent can read monitoring" is only true of that workflow. The two deferrals that tracked this — the monitoring half of the M2 tooling entry, and the assessment's missing monitor snapshot — are closed and removed from the backlog. | `src/lib/agent/tools.ts`; `tests/evals/legacy-surface-coverage.test.ts` — the members and the operations they may name are asserted as a set, so a monitoring member under ANY name has to land there; `tests/evals/operations.test.ts` — the arc, on an engine that answers no statement. |
| **A free-form markdown report**, opening with a performance score out of 100 and closing with configuration advice. | A report is claims, each citing an artifact this run read or the snapshot it captured, verified against the run's own ledger before it is recorded. A number cited to nothing cannot be reported — the citation is what is checked, never the claim's text, so a fabricated score citing a real artifact would be accepted. | `src/lib/agent/tools.ts` (`composeReportTool`); `tests/evals/legacy-surface-coverage.test.ts` — an invented correlation id is refused and the run ends `unanswered (no-report)`. |
| **Maintenance tasks** — `VACUUM`, `ANALYZE`, reindexing — in the same report. | Nothing proposes them: the `change` card has two members and neither is maintenance. It stays where it was before the panels — the monitoring surface, and the user's own editor. | `src/lib/agent/tools.ts` (`recommendationSchema`). |
| **Multi-turn conversation.** NL2SQL replayed the whole exchange on every request, so "and how many in the second one?" was answerable. | **Largely restored, and differently.** A follow-up is still a NEW run — a run's objective is fixed when it starts, and no ledger event records a later question — but it now belongs to a CONVERSATION and is told about it: every earlier step's objective, and the most recent step's report, derived server-side from those runs' own ledgers and fenced before the model reads it. What is not restored is the replay: NL2SQL re-sent the whole exchange verbatim, while a conversation carries a bounded account of it, and only the newest step's findings. Two other differences are deliberate — the run still re-reads the catalog, because its inventory is its own evidence; and `LIBREDB_AGENT_THREAD_CONTEXT=false` turns the whole thing off, which no panel offered. See [the conversation a run belongs to](#the-conversation-a-run-belongs-to). | `src/lib/agent/thread-context.ts`; `src/app/api/agent/runs/route.ts`; `tests/evals/thread-context.test.ts` — a three-step conversation, and the fence the block arrives inside. |
| **MongoDB, MySQL and every other engine.** Both panels ran against whatever the connection was, and NL2SQL emitted Mongo query documents when the connection's query language was JSON. | The agent composes SQL for **two** dialects. `CATALOG_COMPOSERS` and `CATALOG_PLANS` carry `postgres` and `sqlite` only, and an unlisted dialect is never guessed at — since #414 it is read a different way instead of being refused. **A run whose workflow sends statements is refused on another engine before it opens**: `POST /api/agent/runs` answers 400 with the posture's own sentence when the mode is agent and `AGENT_WORKFLOW_SENDS_STATEMENTS` holds for the requested workflow, so no run id and no model turn are spent on a refusal the connection's type already decided. What an engine that IS admitted can then do differs by MODE. **Agent mode is still the two dialects**: its read-class tools reach the database through `provider.queryReadOnly`, which is the same fact the refusal reads. **Plan mode is now every engine**: its grounding acquires `agent-operations` and calls `provider.getSchema()` (`db.schema.read`), so a plan run on MongoDB is ordinarily grounded and is asked for one statement or command **in that engine's own language**, in a block still tagged with the canonical type-id. What the engine decides is no longer whether a plan is grounded but HOW — a composed catalog statement or a provider inventory, and whether estimated statistics exist at all — and the four prefaces say which. Where the reading itself fails, the run is steered to the `NO STATEMENT:` refusal with the capture's own diagnosis. **The `operations` workflow reaches every engine in both modes**, because it composes no SQL at all, and since #411 it is grounded under the same rule as everything else. | `src/lib/agent/composed-sql.ts`, `src/lib/agent/context-snapshot.ts` (`captureContextSnapshot`, `captureFromProvider`, `packOperationsInventory`), `src/lib/db/operations/descriptors.ts` (`db.schema.read`); `tests/unit/lib/agent/context-snapshot.test.ts` — the provider path, its timeout and its refusals; `tests/unit/lib/agent/composed-sql.test.ts` — `UNSUPPORTED_DIALECT`; `tests/evals/plan-grounding.test.ts` — a plan run whose provider cannot describe itself runs no statement and says it is ungrounded; `tests/isolated/agent-investigation.test.ts` — a plan run grounded through the engine's own schema inspection. |

One of these has since been restored under its own workflow (the monitoring row, which closed both
deferrals that tracked it), and the first row is Phase 1's own boundary rather than a defect (B21 is
its one residual). The rest are consequences
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
and then the fifth step the world's `initDataDir` performs: it READS an existing `version.txt` and
parses it exactly the way upstream does. A file whose content upstream would refuse — truncated,
empty, or written by an incompatible release — is reported as `LEDGER_INCOMPATIBLE` before the rail
renders, rather than throwing a step later with the operator meeting it at the first Start.

Two properties bound that check, and both are load bearing. **It is read-only**: it never creates,
repairs or rewrites the file, because the only upstream entry point that answers this question is
`initDataDir`, which writes `version.txt` as a side effect — calling it would turn a page-load
visibility probe into something that initialises the ledger. And **an ABSENT `version.txt` stays
green**, because that is the case `initDataDir` itself initialises; a fresh install has no file, and
refusing one would make every first run report an unavailable agent. A version that parses but
differs from the running one is green too: upstream hands a mismatch to `upgradeVersion`, which logs
and returns, so such a ledger builds a world successfully.

The parse mirrors a contract that belongs to another package, which is the accepted cost — kept
payable by staying as narrow as an equality (no version comparison, no package-name check, no
repair), so a change upstream shows up as this probe refusing a ledger the world would have accepted,
naming the file it read, rather than as a silent divergence. Green still does not promise a run
SUCCEEDS: the ledger directory is shared, so it can be corrupted between this answer and the Start
that follows. What green rules out is a fault that was already on disk when the rail rendered.

| Route | Purpose |
| --- | --- |
| `GET /api/agent/config` | Whether this server runs agents, and if not, which condition failed: `{"enabled": true, "ledgerVerified": …}` or `{"enabled": false, "reason": …, "detail": "…"}`. The reason is one code per operator action — `OPERATOR_DISABLED`, `NO_MODEL_CONFIGURED`, `LEDGER_UNAVAILABLE`, `LEDGER_INCOMPATIBLE`, `UNSANCTIONED_WORLD_TARGET`, `IMPLICIT_HOSTED_WORLD`. `LEDGER_INCOMPATIBLE` is separate from `LEDGER_UNAVAILABLE` deliberately: the path is writable and the action is removing or replacing one `version.txt`, so an operator sent to a permission would find nothing wrong with the directory. The last two are backend refusals and keep their own codes deliberately: neither is a disk problem, and `IMPLICIT_HOSTED_WORLD` fires before anything is asked of a filesystem at all. `ledgerVerified` distinguishes the two kinds of yes: `true` after the writable-path probe passed, `false` for the Postgres carve-out, where the backend is accepted without being contacted (B31). Session-verified. `enabled` is a literal boolean because the rail compares `=== true`. `reason` goes to every session — it names an operator action and no path — while `detail` goes to **admin sessions only**, because the ledger details carry an absolute server path plus an OS error string or a quoted fragment of a file on that disk; every other session gets one stable sentence instead, and loses nothing, since the rail renders nothing when the answer is no. Never 500s, and never names a key's value. The ledger half of the answer is memoised for a few seconds, in-flight promise included — the route sits outside the `ai` rate-limit bucket on purpose, so the memo is what stops an authenticated caller turning a page-load probe into a write per request, including a burst that arrives while one probe is still running. |
| `POST /api/agent/runs` | Opens a run (mode, optional `workflowType`, objective, `connectionId`, and optional `previousRunId` to continue the conversation a run this session opened belongs to) and returns `202` with the run id, the PERSISTED mode and workflow type, and the `thread` the run actually belongs to. An unrecognised `workflowType` is refused rather than defaulted. An inline connection in the body is refused. A `previousRunId` that is not a non-empty string is refused `400`; one that cannot be reached does **not** refuse the start — the run opens with no conversation and `thread.declined` says so. An agent run whose workflow sends a statement is refused `400`, before any run is opened, when the connection's engine implements no read-only statement path - `operations` is admitted on every engine, and a planning run is never refused this way. An agent run whose model was established as unable to call tools is refused `422` before any run is opened. |
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
every other component in this repository, so every client module under `src/components/agent/` and
`src/hooks/use-agent-capability.ts` — plus `execution-policy.ts`, whose ceilings the meter reads as
values — are in the standalone bundle either way; what availability governs is what renders and what
runs, not what was bundled.

The rail shows, from the top down: a **safety strip** stating what the open run executes — or, before
one, what the selected mode would — the
objective, the start controls, a folded **Run details** holding the budget meter, and a scroll area
whose first block is the run's **answer** — the drafted statement or the report with its evidence
citations — and whose remainder is the semantic timeline. There is no second report section under the
transcript: the card is the answer. What each of those says to a user, in the words it actually
renders, is [`docs/AGENT_GUIDE.md`](./AGENT_GUIDE.md).

**The safety strip is one module's reading, in four levels** (`src/lib/agent/posture.ts`, rendered by
`src/components/agent/SafetyStrip.tsx`). Each level is a pill and a qualifier on one line, and both
halves are the posture's: the strip owns the palette and the popover and writes no sentence of its
own.

| Level | The pill says | The qualifier beside it | When |
| --- | --- | --- | --- |
| `safe` | *Executes nothing it drafts* | *one schema read grounds it, nothing else reaches the database* | Plan mode, on every engine, with or without the hand-over |
| `reads` | *Reads only* | the policy row's own per-statement row cap and timeout, *enforced by the engine* | Agent mode on an engine in `AGENT_EXECUTION_ENGINES`, hand-over not ticked |
| `widened` | *Reads only, and one statement in your editor* | `AGENT_HANDOVER_BUDGET`'s row cap, *no time limit, same read-only session* | The same, with the hand-over consented for the run being opened |
| `blocked` | *Cannot execute on `<engine>`* | *plan mode drafts here, and the operations workflow still runs* | Agent mode on any other engine |
| `blocked` | *Cannot execute yet* | *no connection is resolved, so no engine has been established* | Agent mode with no connection resolved |

Four levels and five readings: `blocked` covers both arms that execute nothing and have no bound to
state, and they stay separate arms because "has no read-only statement path" is a claim about an
engine, which a panel that has resolved no connection has not seen. Not one engine name and not one
figure is typed in the module — the names come from `AGENT_EXECUTION_ENGINES` through
`getDBConfig().label` and the figures from the policy rows, which is the rule `hero-proof.tsx`
follows and #425 is the record of what typing them costs. `blocked` also takes no hue of its own
(`fg-muted`): nothing executes and there is nothing to widen, so it is a dead end rather than a
hazard, and the amber pre-start card below — which renders for an unsupported engine and not for an
unresolved connection (`engineUnsupported`, `AgentRail.tsx`) — is where that reading is alerted.

**The qualifier is visible, and that is a claim rather than a layout choice.** A bare "executes
nothing" overclaims: on the dialects `CATALOG_PLANS` serves (`src/lib/agent/context-snapshot.ts`)
plan mode's grounding capture IS a catalog read, and `engine-support.ts` says in its own header that
copy compressing these facts overclaims. So both halves sit on the same line, the row wraps rather
than truncating — a qualifier cut off mid-clause is the same overclaim with an ellipsis on it — and
the ⓘ carries the whole claim rather than the missing half. That claim node is rendered whether or
not the popover is open (`sr-only` while shut, and the strip's `aria-describedby` target either way),
so the ⓘ is never the only route to it.

Both `blocked` readings are presentation of a refusal the provider factory already decides, and they
gate nothing — **Start** stays live, because the `operations` workflow sends no statement and runs on
every engine. What the strip does not do is decide anything: the refusal it describes is now the route's, which
answers 400 before a run id or a model turn is spent. **Start** stays live because `operations`
sends no statement and is admitted on the same connection the strip warns about.

**One module, two questions, because with a run open they stop having the same answer.** The strip
says what the OPEN run does, and both of its axes come off that run (`describedMode` and
`handoverConsented`, `AgentRail.tsx`): the mode from `AgentRunTimeline.mode`, which
`foldLedgerEntries` reads off the run's header or off `run-started`, and the hand-over from what the
open request carried (`openedWithHandover`). Neither may come from the control beside it, and each
fails differently if it does. The mode toggle is frozen only while a start is HELD — deliberately,
because it decides the next run — so it is live again the moment this one opens, and reading it there
let one click on **Plan** restate a running agent run as *Executes nothing it drafts*.
`openedWithHandover` is a record and is never cleared, so it is gated on the run still being open, or
the strip goes on promising *one statement in your editor* after the widened run has ended while the
next consent step defaults the tick to OFF. The same reading writes the workflow-and-mode line under
the objective, so the panel's two descriptions of one run cannot disagree.

The amber engine notice asks the other question — what pressing Start would do — and takes the
SELECTION (`selectionPosture`): the toggle's mode, and the hand-over tick only where a consent step is
actually standing. The notice renders *on* the selected mode and offers the way out of that selection,
so the run's reading there would put plan mode's body inside a card whose whole subject is the engine
agent mode cannot execute on. The two readings coincide whenever no run is open, which is most of the
panel's life; they differ in the one state where a box and a run both exist, an objective being edited
beside a run that is still going.

A muted line under **Start** used to ask that question in words, and it is gone: it printed the
strip's own headline and qualifier joined, about 200 pixels below the strip (L7, measured 2026-08-21),
so one 384-pixel panel carried the same sentence twice. The strip is permanent and states it for the
selected mode already. The login hero's claim — *plan mode drafts one statement, runs nothing* /
*agent mode runs read-only on \<engines\>* — was the considered alternative and was not taken: it
describes both modes at once, for a visitor who has selected neither.

The strip exists because the rail answered this question in six places at once — a mode description, a
consent paragraph, a budget note, a guard line, a refusal and a claim under the answer — and a user
comparing two of them could not tell which one bounded the run.

Three rules govern the layout, beyond the two below. The **answer card is a second rendering of
entries the ledger already holds** — no field on it is one a run did not record. It has one state per
ending the ledger can reach and no state that is not one of them: a plan run's drafted statement with
what the guard made of it (`agent-answer-plan`), an agent run's quoted claim with its citations
(`agent-answer-report`), the step a live run is on with its spend (`agent-answer-running`), a plan run
that drafted nothing (`agent-answer-refused`) and a run that failed having produced nothing
(`agent-answer-failed`). Which of them it is, is decided by the run's **product and not by its
status**, in the one exported reading `answerCardState` — a run can end `failed` holding a drafted
statement or a composed report, because `conclude()` records both before `service.finish()` and is
called with `failed` for a model timeout, an exhausted deadline and the turn ceiling. The ending is
then stated beside the product, so `agent-answer-failed` is the whole card only on a run that
produced nothing. The transcript withholds its copies from that same reading rather than from the
ledger: the rail asks the card what it is rendering, so a suppression cannot outlive what it
de-duplicates. The
**`Apply to editor` control for a run's own statement exists exactly once**, in that card, carrying the
accessible name `applyStatementName` builds; the transcript entry it duplicates keeps its headline,
its timestamp and a one-line guard summary and reprints neither the statement nor the guard's
paragraph, because an unmarked control against the statement is the silent hand-off the marking exists to
prevent.

**What that suppression covers was settled by driving the built rail, not by reading it** (the four
runs of 2026-08-21, against live PostgreSQL, live MongoDB and live Gemini). Four things it did not
cover, each measured:

- the whole report was rendered **twice** — the card and a surviving `agent-report` section at the
  foot of the scroll area — so the model's claim printed twice and the report path offered *three*
  `Apply to editor` controls for one statement, none of them named. That section is gone: its claims
  are the card's, and its citations are the card's `Evidence` fold, label, the ledger's own detail and
  the statement each rests on. Its `Show result` was itself a second offer of the artifact the
  `Result stored` entry offers under the same live-run rule;
- an agent run records **every statement it executes** (`statement-drafted`) and the answer's `sql` is
  the statement of the step whose artifact it presents — so the same text reached the ledger twice.
  The transcript therefore withholds a hand-off for the statement the card is handing over **by text**
  and not by entry id, which is what keeps it a de-duplication: a read the run took along the way
  whose statement is not the answer's keeps its own control;
- the closing prose **holds** the fenced statement, so every surface rendering that prose reprinted
  it — in the card's own `Why this statement` and again in the transcript entry. `renderProse`'s
  `cardedStatement` suppresses that one block where the statement is displayed beside it, the same
  shape as the per-block control's own suppression. Nothing is edited: every other fence renders, and
  `Copy all` takes the string the model wrote rather than this rendering of it;
- and the guard's reading was stated **three times** inside ~400px, twice at length. The entry whose
  statement the card holds now drops its `detail` paragraph and keeps the one-line summary; the full
  text is where it already was, in the card's ⓘ under its own test ids.

**Two more the same drive measured, neither of them a duplication.** The card's grounding chips —
`${n} ${noun.plural} read` and the schema fingerprint — are read off the run's **capture** and not off
the guard's reading, so they are stated on every engine. They had been a second prop beside the
timeline, and a claim a caller can forget to pass is a claim that disappears: on MongoDB the answer
carried the amber `not checked` chip **alone**, while the chrome fold two lines below it said *Schema
captured — 5 collections* (L4). That is backwards where it costs most — where nothing examined the
draft, the inventory it was drafted against is the only grounding claim left. And a citation chip
names its evidence at **chip length**: a correlation id is a UUID, so `Artifact
722b2a10-e3f2-4b9c-8177-367359a21500` filled a 384-pixel chip and left no room for what the ledger
knows about that read (L8). `AgentEvidenceCitation` therefore carries `shortLabel` beside `label` —
the identifier cut to the eight characters the schema-snapshot label was already written at, both
spelled by one author in `citationOf` — and the chip prints that plus the ledger's own `detail`, while
the whole identifier stays in the `Evidence` fold. `detail` is what states, in text and not in amber
alone (WCAG 1.4.1), whether the rail resolved the citation at all; the two readings keep separate test
ids, because a shared one would pass on either sentence.

**The answer is followed, not the newest entry.** The scroller follows the newest entry while the run
is live and brings the answer into view — once — when the run reaches a terminal status, because the
newest entry at that moment is `run-finished` while the thing the user waited for is at the top: both
paths were measured landing at their own scroll maximum with the card entirely above the fold. A
reader who scrolled away is left where they are in both regimes. The card stays inside the scroller
deliberately — lifted out, a long report would take a fixed share of a 384-pixel panel away from the
transcript. And the **budget meter is folded**: the gauges (`agent-budget`) and all three of its claims —
`agent-budget-limits`, `agent-budget-reserve`, `agent-budget-caveats` — live inside
`agent-run-details`, open by default only while the run is live, with each claim behind an ⓘ on the
figure it qualifies and still in the accessibility tree whether or not that popover is open.

Two further rules govern it:

- **A control the service cannot honour is not rendered at all.** There is no disabled-looking button
  standing in for a capability, which is why the rail stops a run but does not offer pause/resume
  (B11).
- **The meter reports only what is actually enforced** — statements, database time, the run deadline,
  repair attempts — and states the SQLite non-preemption caveat rather than implying that an
  overrunning statement is cut short. It reports no token budget because none is enforced (B10). A statement that
  failed at the database now carries the span the tracker charged for it, so the database-time figure
  no longer counts completed reads only; what is left uncounted is the catalog capture's own reads
  and the difference between an engine's elapsed time and the span measured around the call (B13),
  which is why the figure is still stated as a floor.

Results the agent stored **hydrate the existing surfaces**: the results grid, the explain view and the
charts view in the bottom panel, carrying a read-only provenance badge that names the run. There is
deliberately no second editor, no second grid and no second chart component inside the rail, and
applying a statement to the editor happens only on an explicit user action.

**Which surface a result opens in comes from what the run RECORDED, never from what its rows look
like.** A plan opens the explain view because `sql.explain.estimate` produced it; a chart opens the
charts view because the run composed its answer as a chart and said in `answer-composed` how to draw
it. A result whose answer said table is shown as a table however chartable its columns are. The
specification the model emitted is validated against the artifact's columns before it is recorded, and
validated again in the browser against the rows actually delivered — two guards, because
`DataCharts` turns a column it cannot read into `0` rather than into an error, and a chart of the
wrong column draws a confident flat line rather than failing. A specification that does not survive the
second check is dropped and the view's own inference draws the chart instead. Exporting a hydrated
result is not wired (B34), and a run's stored results are released when the run ends, so a report can
outlive the rows its citations point at (B15).

**Those results live in process memory, and the store that holds them is bounded.** It keeps 180
entries at once — the largest statement ceiling any workflow may be given (45) times the four
concurrent runs one agent process is sized for — and each entry is at most what the execution
profile's byte cap admitted. When the bound is reached, the run that is storing gives up **its own**
oldest artifact rather than the store's, so a run that executes a lot cannot make "Show result" fail
on a quieter run that is still live. The store is per process, which is consistent with the
zero-config backend below being single-instance.

**What that product bounds is four *drives*, not four runs.** Every ceiling in the decision table is
per drive (B6), while a resumed run keeps its `runId` and its artifacts are keyed by it — so a run
driven three times may hold up to three times its statement ceiling here, and a long-lived run can
pass 180 on its own. Run-fair eviction then takes that run's *own* earliest results, which its report
may still cite: a third way to reach the "the rows are not here" answer B15 describes, this time while
the run is still live. The ledger is unaffected — the claim and its citation are durable — and the
gap is recorded as **B35** rather than closed with an artifact-only bound, because a ceiling that
holds across drives is the mechanism B6 already names.

## Deployment

**An agent-capable deployment needs a reverse-proxy read timeout of at least 16 minutes, and the
chart does not set one for you.** The rail follows a run through a single long-lived streaming
response, so the run and the HTTP response have the same lifetime. The longest drive any workflow may
take today is `data-analysis`'s **900 s** wall clock — so a response can legitimately stay open far
longer than the 60 s that is nginx's
default `proxy_read_timeout`, and longer than the comparable defaults of the ingress controllers,
load balancers and PaaS routers Studio is deployed behind. Raise it to **960 s** where the traffic
enters (`proxy_read_timeout 960s;` for nginx, `nginx.ingress.kubernetes.io/proxy-read-timeout: "960"`
for the ingress-nginx annotation, the equivalent idle timeout elsewhere). Nothing in this repository
can do it for you: the timeout belongs to the proxy, not to the container.

The figure is 960 rather than 900 deliberately: a timeout set to exactly the longest deadline has no
headroom, and would cut the run at the very moment it was entitled to be finishing. This number is a
ceiling to survive, not a duration to wait for — a run that ends sooner closes its own stream, and
raising the timeout does not make any run longer. It was 900 s while `database-assessment`'s 630 s
was the longest drive; the `data-analysis` row moved the thing it is derived from, which is why it is
stated here as a function of the budget table rather than as a constant.

**A keep-alive would not be a substitute, and the reason is worth knowing.** The stream emits one
line per ledger event, so an active run keeps the socket warm by itself — but a run spends most of a
turn *inside one model call*, writing nothing, and one model call may take up to 90 s. A proxy whose
idle timeout is under that will cut a perfectly healthy run mid-turn, and what the user sees is the
rail losing its stream rather than a run that failed. The run itself survives — it is durable and
resumable — but nothing today re-attaches the rail to it (`docs/BACKLOG.md` B9), so in practice the
user watches a run disappear. Emitting a periodic keep-alive on the stream is the alternative fix and
is not implemented; the required timeout is documented instead.

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
├── tools.ts              # the four tools + server-side selection; the only database reach,
                          #   the model's tools and the server's own grounding reads alike
├── composed-sql.ts       # the SQL the SERVER writes, per dialect — two of the fourteen
├── sqlite-ddl.ts         # reading SQLite's stored DDL back into an inventory
├── execution-policy.ts   # the frozen policy and the run-level ceilings
├── deadline.ts           # the wall-clock deadline and the timeout clamp
├── repair-ledger.ts      # the bounded repair loop and its statement fingerprint
├── context-snapshot.ts   # the schema snapshot and task-aware packing; TWO readings, one
                          #   per composed dialect and one per provider (#414)
├── schema-stats.ts       # the engine's ESTIMATED statistics, and the text that says they are
├── plan-statement.ts     # a plan run's drafted statement: read from the prose, then checked
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
src/components/agent/     # AgentRail.tsx, SafetyStrip.tsx, AnswerCard.tsx,
                          #   ConsentCard.tsx, rail-parts.tsx (what the rail and the
                          #   answer card both render), timeline.ts (event fold),
                          #   hydration.ts, use-agent-run.ts, use-agent-artifact.ts
src/hooks/                # use-agent-capability.ts (the flag probe; the rail's own hooks
                          #   sit beside it above)
```

## Known limitations

Each of these is recorded in [`docs/BACKLOG.md`](./BACKLOG.md) with what it would take to close it.
They are listed here so the honest boundary is visible from the behaviour document rather than only
from the tracker.

**Inherited from the enforcement layer** — `docs/BACKLOG.md`, section "Agent M1 deferrals (#328)",
entries A1-A3. These bound what any agent statement can be promised: a SQLite statement is not
preempted, so its timeout is post-execution and an overrunning statement blocks the runtime (A1);
`VACUUM INTO` can create an empty file at a chosen path (A2); out-of-scope **reads** have no
database-native control on either provider — the declared-target allowlist, the statement guard and
the role's own grants are the whole boundary (A3).

**From this milestone:**

- **B1** — a credential classification map kept module-private would be invisible to the state guard.
- **B2** — the Anthropic kind is ratified and installed but not offered; serving it means giving the
  chat surface an Anthropic provider first.
- **B3** — a scope allowlist on a target dimension denies every tool that cannot declare it.
- **B4** — a mapped database error discards the text distinguishing a timeout cancel from an operator
  cancel.
- **B5** — the ledger assumes one writer per run and cannot enforce it.
- **B6** — every cost ceiling is per-drive, so N resumes can cost up to N times one drive's budget.
- **B9** — nothing enqueues a drive, so an interrupted run is resumable but never resumed.
- **B10** — no token budget is enforced, so the meter reports none.
- **B11** — the rail can stop a run but cannot pause or resume one.
- **B13** — three spends the ledger never records, so the meter reads low.
- **B77** — the curated health reading reports `slowQueryCount` off a capped list, so on MySQL it
  saturates at the limit and the rows behind it are Studio's own introspection traffic.
- **B78** — a failed statement's recorded span is a delta, and what makes the subtraction
  unambiguous is one frozen concurrency constant that no test guards.
- **B79** — the re-pointed decline has never been reached from the UI: in the default storage mode
  the only server-held connections are the seeds, and editing a seed makes it browser-local, which
  the rail refuses before any thread check.
- **B80** — the engine refusal shows the posture's whole paragraph in the error line while the
  pre-start card two elements above is showing the same one.
- **B15** — a run's stored results are released when it ends, so a report's citations can outlive its
  rows.
- **B16** — the opt-in `@workflow/world-postgres` backend is not present in the standalone payload,
  so it cannot load in the container image or the npx payload.
- **B20** — a Gemini deployment behind a proxy is not configurable: `LLM_API_URL` is unread for that
  kind, in the chat surface as much as in the agent.
- **B21** — the published package's `BottomPanel` carries the agent-provenance branch as dormant
  markup.
- **B23** — seed eligibility is decided against the browser's last descriptor fetch, so a seed
  repointed server-side mid-session is not seen until the next fetch.
- **B29** — an identifier the model quotes back into its own tool arguments reaches the transcript
  unfenced; an open injection path, bounded only by the server never handing it the raw marker.
- **B31** — the Postgres durable backend is reported available without being contacted, so an
  unreachable `WORKFLOW_POSTGRES_URL` still renders a rail whose first Start fails. Reported as a
  carve-out (`ledgerVerified: false`) rather than fixed; a real check is a connection attempt per page
  load.
- **B32** — the route family above is documented in [`docs/API_DOCS.md`](./API_DOCS.md) and guarded
  against drift, but that guard derives only the agent paths: every other family is still hand-kept,
  and even here only a path's presence is asserted, never that a documented shape still matches its
  handler.
- **B33** — a run is observable only from its own ledger. There is no OpenTelemetry export and no
  metrics: the record described above is complete, and getting it into a stack the operator already
  runs is designed (#332) and deliberately unbuilt.
- **B34** — a hydrated result cannot be exported: the Export menu serializes the tab's own rows, so it
  is hidden while a run's result is shown.

The entries below were found by driving the product against a live model in a browser, which is the
only way any of them could have been found: every one of them passes every gate. A few were found
later and by other routes, and are listed here because they are the same kind of thing — a defect no
gate in this repository objects to. Several came from repeating that exercise against the inference
surface (#407) — twenty-six runs over `docs/AGENT_DEMO.md`, which is also where the classifier's
real-world agreement rate was measured. The count is deliberately not stated: entries leave this list
as they are fixed, and a numeral here goes stale silently.

- **B67** — there is no run history across conversations. The rail names the conversation a run
  continues and lists its steps from the run's own header, but a user cannot see the conversations
  they had yesterday or return to one: the store has no enumeration, there is no list route, and
  pagination and retention have not been decided.
- **B75** — a conversation's database is checked when a follow-up OPENS; a run already open is not
  re-checked, so a resumed drive can read a repointed database while carrying a conversation and a
  captured schema established against the old one. The record now carries the identity needed to close
  it; what a run should DO when its connection moves under it is the undecided part.
- **B69** — a reload ends a conversation and the rail does not say so before the next question. The
  result is honest (no thread, no strip); the transition is silent.
- **B70** — a run writes no summary for the step after it. The conversation carries the previous
  step's claims verbatim and truncates at a claim boundary; a model-written `carryForward` sentence
  was considered and declined, because a claim is evidence and a summary is a lossy compression of
  it.
- **B71** — `@ai-sdk/workflow`'s `WorkflowAgent` offers the durability this repository implements by
  hand, and is not used: it requires the workflow runtime's programming model, which would bind the
  agent to a hosting runtime this product deliberately does not depend on.
- **B39** — a data-analysis run has no honest way to conclude that the question is not about this
  database. Its only route to `answered` is a reading of the data, so a run that establishes the
  question is unanswerable fabricates one — the #356 shape again, in a new place.
- **B48** — the two grounding paths fail differently. Since #414 a plan run on one of the nine
  provider-path engines survives an unreachable host, a wrong password or a half-configured
  `agentUser`: `captureFromProvider` converts a `DatabaseError` or an `ExecutionProfileError` raised
  before the reading leaves into an unavailable capture, and the run answers ungrounded with that
  diagnosis. The composed path — PostgreSQL and SQLite — still lets the same failure out, ending the
  run `internal` or, on the profile error, `agent-credential-unusable`. Deliberate at #414, which had
  no business changing how the two engines it did not touch fail, and an asymmetry a reader will
  trip over until it is resolved.
- **B72** — plans are exempt from the emptiness census for `query-optimization` only. The
  investigation, database-assessment and data-analysis verifiers still judge a plan-only report by a
  row count that measures nothing, and `inspect_plan` is offered to all three. Closing it changes what
  three released verifier ids mean, so it takes the id bumps that implies; the boundary is pinned by a
  test rather than left ambiguous.
- **B73** — a refused capture's reason code is structural, but its row-budget pair still travels as
  prose inside a `QueryError` message and is recovered by regex, with two prose consumers reading the
  same sentence. Doing it properly touches the error type every provider throws, so the change that
  recorded the refusal kept the regex and pinned it with a test that drives a real over-budget read.
- **B74** — `UNIQUE (a COLLATE NOCASE)` is listed as covering a foreign key on `a`, which it cannot
  serve for a binary equality lookup. A false negative in the direction opposite the constraint-index
  fix,
  left unmodelled because the user-index reader drops `COLLATE` too and honouring it in one reader
  only would make the inventory disagree with itself.
- **B51** — the loop delivers three notices to a model (the reserve warning, the report reminder of
  #416, the present-before-report notice of #417) and records none of them. `recordEvent` is called
  for what the RUN did and never for what the server said to it, so a rescued run and a run that never
  needed rescuing leave the same ledger — and a `compose_report` the loop withheld leaves no trace
  that a call was made. That is a measurement problem first: [`docs/llms/`](./llms/) is built by
  reading those ledgers, and its whole claim is that each figure comes from an observed run. Each
  notice is sent once per DRIVE and not once per run, and the missing entry is why: the three booleans
  live inside `runInvestigation`, which is also what resumes a run a dead process left running, so a
  resumed drive starts with all three false. The guards are the part that keeps being got wrong —
  both new notices shipped with a condition that named one thing and read another, and both were
  caught in review rather than by a gate.
- **B52** — the composed PostgreSQL grounding capture is refused by what the IMAGE ships rather
  than by a wide user schema, and it has now been measured on three different servers.
  `composeCatalogRead` projects one row per COLUMN against `maxResultRows: 200` and refuses rather
  than truncates, which its own comment estimates as "roughly 25 tables of eight columns". Measured on
  2026-08-20 against a stock TimescaleDB 2.29.2 (PostgreSQL 17.11) with TWO user tables:
  `information_schema.columns` answers 478 rows, of which 473 belong to the extension's own schemas
  and 5 to the user, so the capture is refused and the plan run answers ungrounded. Verified as
  server-caused, not path-caused: plain PostgreSQL 18 and YugabyteDB both captured their schemas under
  the same least-privilege role, and granting that role the internal schemas changed nothing.
  Reproduced the same day on Apache Cloudberry 2.1.0-incubating (PostgreSQL 14.4), which is a fork
  rather than an extension, so the shape is not one product's: with the same two user tables the read
  is refused as `CATALOG_READ_REFUSED` at **289 rows against the 200 allowed**, **282** of those rows
  belonging to Cloudberry's own `gp_toolkit` schema and 7 to the user's two tables. The total is
  per-role and only means something with the role named: the same read as `gpadmin` answers 481 rows,
  470 of them `gp_toolkit`, 7 `public` and 4 `pg_ext_aux`. Cloudberry also puts a second wall in front
  of the first, which a user hitting it needs to know about: `gpadmin` is the login the engine gives
  you and it is a superuser, so the execution profile refuses the role as unverified or too broad
  (`is_superuser`, `reads_server_files`, `writes_server_files`, `executes_programs`) and an agent run
  there needs a hand-made least-privilege `agentUser` before it can even reach the row budget - and
  then hits it. Measured a third time the same day on AlloyDB Omni 17.9.0 (PostgreSQL 17.9), which is
  the instance that decides the fix: the read is refused at **536 rows against the 200 allowed** with
  only **7** of them the user's, and the overflow is **not** in an internal schema - 341 of the 348
  rows attributed to `public` are the 49 extension views the image installs into `public` itself, with
  `google_ml` 144 and `ai` 44 behind them. Narrowing the capture to `schema=public` therefore still
  refuses, at 348 rows, so the candidate fix of excluding the schemas the object browser treats as
  internal - which would have rescued both TimescaleDB and Cloudberry - is refuted here, and the only
  surviving fix is to aggregate columns per table so the projection is one row per OBJECT. AlloyDB
  Omni is a superuser-login image too, so it hits Cloudberry's first wall as well. Two controls keep
  those numbers attributable: plain PostgreSQL 18.4 in the same pass projects 7 rows and captures its
  2 tables, and the 0-rows-as-agent-role result on the `relations` kind reproduces identically on that
  baseline, so it is PostgreSQL's privilege rule and not an AlloyDB property. The agent is therefore
  unusable out of the box on all three, and the same shape will appear on any PostgreSQL whose image
  ships wide catalogs or wide extension views before the user has created anything.
- **B55** — a grounded LibreDB plan run drafts `GET users:*`, and `get` is an exact-key lookup with no
  glob: the key does not exist, so the command answers zero rows and no error. The inventory's rows are
  NAMED `users:*`, which reads as a glob the grammar does not have, and LibreDB declares no
  `statementLanguage`, so the five verbs (`get`, `put`, `delete`, `prefix`, `range`) are left to be
  guessed. MongoDB and Redis were fixed the same way in 0.13.1 - each declares the sentence its
  statement form needs - and LibreDB's turn was deferred by the owner on 2026-08-22 until the other
  providers are done.
- **B56** — a planning run's grounding is HELD for the process lifetime, so a schema that changes is
  invisible to plan mode until a restart. `holdSnapshotForConnection` keeps one inventory per
  connection identity with no expiry, and it is consulted before any capture. Measured twice on
  2026-08-22: after MongoDB's inference began expanding subdocuments, `schema/list` returned
  `shipping.city` at once and the schema tree showed it, while two plan runs still grouped by
  `$shipping.region` and recorded no `context-captured` event at all; a restart fixed it on the first
  run. Redis showed the same shape, refusing an objective about keys that had just been seeded. The
  design intent - a run reasons over the inventory its claims cite - is not the problem; a NEW run
  inheriting it indefinitely is, and a reused snapshot writes no capture event of its own, so the
  ledger cannot tell "held, hours old" from "captured just now".
- **B57** — an operator's tuning document is refused WHOLE when any part of it fails. The argument
  behind that is about merging (half of one measurement beside half of another is a configuration
  nobody has run), and it justifies whole-**entry** replacement rather than whole-**document**
  rejection: fifty models would be lost to a typo in the thirty-seventh.
- **B59** — per-model WORDING has nowhere to go. A sentence is a measured value here (twice a shared
  change won cells and lost others, and had to be reverted whole), and the per-model override is
  gone: the document refuses wording and nothing else can populate it. Refusing unsigned prompt text
  is right; refusing it forever is a decision that has not been taken, and the two objections behind
  it — marker drift and authorship — come apart.
- **B62** — `schemaVersion` is a literal on both schemas, so the first bump to 2 refuses every
  document in the field and reverts every model in it to the defaults. Deliberately not fixed while
  only one version exists: an accepted range with one member is a knob nothing turns, and the
  tolerant operator schema removes the pressure by letting Studio add settings without moving it.

- **B64** — an unfenced plan statement with NO terminator still carries prose into the SQL. The
  splitter closed the demonstrated case (a statement, then its explanation on the next line, came
  back as one statement with the prose in it) but has nothing to cut on without a semicolon, so
  the blank line remains the only signal there. It matters because `plan-statement-drafted` is
  recorded on the reader's verdict alone and the goal verifier reads that event as ANSWERED, so
  the run is scored answered while its deliverable would not run.
- **B65** — `retryUnreadStop` subsumes `retryEmptyTurn`. The gate asks what a stopping turn CALLED
  and never what it said, so an empty completion reaches it too and a model's recorded
  `retryEmptyTurn: false` decides nothing. Pinned as it behaves rather than narrowed, because the
  narrowing would move behaviour five passing runs were measured under.
- **B66** — the one per-model lever `nemotron3:33b`'s marginal cell has never been swept at. Both
  its losses are a report turn of 172.7 s and 244.6 s against a 90-second limit, which is the shape
  `turnTimeoutMs` exists for, and unlike the lever the entry declines it reaches no other surface.

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
