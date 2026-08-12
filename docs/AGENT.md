# Agent Runtime — LibreDB Studio

The agent runtime drives one **read-only database investigation**: a user states an objective, a
model drafts SQL against the connected database, repairs statements that fail, and composes a report
whose claims cite the results they came from.

Three properties frame everything below, and each of them is load-bearing rather than aspirational:

- **It is off unless an operator turns it on.** `LIBREDB_AGENT_ENABLED` is absent by default, and
  with it absent no rail renders, no agent route opens a run, and the browser makes no agent request
  beyond the one-line discovery probe. What is *not* claimed: the rail's own components, the two
  hydration modules imported beside them, and the frozen policy constants they read are statically
  imported, so they sit in the standalone bundle whether or not the flag is on. No agent **runtime**
  module — the ledger, the run service, the tool layer, the model adapter — is reachable from a browser
  at all.
- **It is standalone-only.** The embedded `@libredb/studio` package carries no agent surface, no
  agent type and none of the runtime's dependencies. See
  [Package boundary](#package-boundary).
- **It can only read.** Every database reach goes through the same operation pipeline
  (`src/lib/db/operations/`) that the rest of the application uses, under a read-only execution
  profile, with the agent's own frozen execution policy. The agent cannot exceed what that policy
  already allows, and it has no second path to a driver.

This document describes what the runtime *does*. The security matrix rows that cover it are 3.4 and
3.5 in [`docs/SECURITY.md`](./SECURITY.md) — both marked **Partial**, with the reasons stated there;
everything the runtime does **not** do yet is listed under
[Known limitations](#known-limitations) with the backlog entry that owns it.

## Table of Contents

- [Turning it on](#turning-it-on)
- [What a run is](#what-a-run-is)
- [Durability and resume](#durability-and-resume)
- [The tool set](#the-tool-set)
- [What bounds a run](#what-bounds-a-run)
- [The model side](#the-model-side)
- [HTTP surface](#http-surface)
- [The surface in the app](#the-surface-in-the-app)
- [Deployment](#deployment)
- [Package boundary](#package-boundary)
- [Module map](#module-map)
- [Known limitations](#known-limitations)

## Turning it on

Two server-side variables, both documented with their accepted values in
[`.env.example`](../.env.example). Neither is `NEXT_PUBLIC_`: the browser discovers whether agents
run by asking `GET /api/agent/config`, the same way it discovers the storage mode.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBREDB_AGENT_ENABLED` | unset (off) | Turns the whole runtime on. Accepts `true`/`on`/`1` and `false`/`off`/`0`; an unrecognized value warns and stays **off**, so a typo never enables it. |
| `WORKFLOW_TARGET_WORLD` | unset (`local`) | Durable backend for run state. Exactly two values are accepted: `local` (zero-config, on-disk, **single instance**) and `@workflow/world-postgres` (opt-in, multi-replica, needs `WORKFLOW_POSTGRES_URL`). Anything else is **refused**, not defaulted. |

The refusal is not pedantry. The workflow runtime reads that variable itself and treats any value
other than its own keywords as a **module specifier to `require()`**, so the allowlist in
`src/lib/agent/config.ts` is what stops a stray value from loading arbitrary code into the server —
and it is also what keeps the running backend equal to one of the two ratified ones.

One further variable is read but never set by you: `VERCEL_DEPLOYMENT_ID`. If a hosting platform
sets it and `WORKFLOW_TARGET_WORLD` is absent, the runtime would silently pick that platform's own
hosted backend, so the agent refuses to start until the backend is stated explicitly.

**Model configuration is the existing one.** The agent resolves its model through `src/lib/llm`'s
own resolution (`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_API_URL`) — the same keys the AI
Assistant and the Natural Language Query panel use. There is deliberately no second settings surface
and no agent-specific provider variable, and the provider packages' own ambient fallbacks
(`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_BASE_URL`) are explicitly neutralised so
an ambient key cannot authenticate a run against a provider nobody configured.

## What a run is

A run is opened with a **mode**, an **objective** and a **connection id**:

- **`planning`** — the model reasons about the objective and produces a plan. Its tool set is
  **empty**, so a planning run performs zero database operations. This is decided on the server from
  the run's persisted mode; a client-supplied tool list has no way in, because there is no parameter
  for one.
- **`agent`** — the model receives the read-class tools below and investigates.

The mode is fixed when the run is opened. A later request cannot widen a planning run, and the
tool-selection function is re-checked at the execution seam, so a caller holding a tool context
still cannot execute a tool the selector would never have offered.

A run's **actor** — the session and role that opened it — is written into the run's own record at
start, and every later authorization decision reads it from there. Not from the request that resumes
the run, and not from the drive credential. That is why an agent run requires a server-resolvable
connection: a connection that exists only in a browser cannot be rebuilt by a process resuming
somebody else's run, and no credential is ever persisted (only the connection id).

A run emits a closed set of **semantic events**, and they are the whole of what the UI renders:
`run-started`, `context-captured`, `statement-drafted`, `tool-invoked`, `tool-completed`,
`tool-refused`, `report-composed`, `run-finished`.

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
reason**: `model-unavailable`, `connection-unresolvable`, or `internal`. Three properties are
deliberate:

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

Two consequences worth stating:

- **A schema read is a bounded read.** There is no fourth operation descriptor for catalog access:
  the canonical set is exactly three operations, and a catalog read *is* a bounded read whose
  statement the server writes per dialect. The dialect asymmetry is real and documented on the tool
  — PostgreSQL yields a structured column inventory, while SQLite's `pragma_table_info()` is refused
  by the statement guard, so SQLite yields each object's own DDL text from `sqlite_master` instead.
- **The executing form of `EXPLAIN` is never offered.** The analyzing variant requires approval
  because it runs the statement; the tool exposed to a model is the estimating variant, and nothing
  in the run loop may convert a require-approval outcome into an allow.

**Database content is untrusted input.** A table name, a column comment, a row value and an engine
error message all come from whoever can write to the database, so everything crossing into a prompt
is fenced first: a header naming what the content is and where it came from, and a stated boundary
the content cannot forge. This is the same firewall the maintainer loop applies to public issue text.

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
| Repair attempts | 3 | Statements that failed **at the database**. |
| Model turns per drive | 16 | A backstop for a loop that never reaches the database. |

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
bad key, a quota, a 5xx) reaches no verdict at all. It is not yet wired into the start path (B18).

## HTTP surface

Six paths under `src/app/api/agent/`, seven handlers. Each verifies authorization in its own handler
(middleware is an optimisation, not the authorization boundary) rather than trusting the request. The
five run-reaching handlers verify a **session** and answer **404** when the runtime is disabled —
after the session check, so an unauthenticated caller cannot learn whether an agent surface exists —
and are metered out of the same `ai` rate-limit bucket as the other model routes. The two exceptions
are deliberate: the config probe answers `200 {"enabled": false}` when the runtime is off, because
that *is* its answer, and the drive route verifies a machine credential instead of a session.

| Route | Purpose |
| --- | --- |
| `GET /api/agent/config` | Whether this server runs agents. Session-verified; answers the flag only, never the backend or the model. |
| `POST /api/agent/runs` | Opens a run (mode, objective, `connectionId`) and returns `202` with the run id. An inline connection in the body is refused. |
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
mobile layout. Visibility is discovered at runtime from `GET /api/agent/config`: with the flag off
nothing renders and no further agent request is made. The rail is imported statically, like every
other component in this repository, so the six client modules under `src/components/agent/` and
`src/hooks/use-agent-capability.ts` — plus `execution-policy.ts`, whose ceilings the meter reads as
values — are in the standalone bundle either way; what the flag governs is what renders and what runs,
not what was bundled.

The rail shows the run's semantic timeline, a stop control, evidence citations, and a budget meter.
Two rules govern it:

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
(`postgres://world:world@localhost:5432/world`) rather than refusing.

**Where run state lands matters, because it is not the app's data directory by default.** The local
backend's directory is `WORKFLOW_LOCAL_DATA_DIR`, and with that unset it is `.workflow-data` resolved
against the process's working directory — `/app` in the container image, which is *not* the
`/app/data` volume. Two consequences: a container with a read-only root filesystem (the Helm chart's
default) cannot create it at all, and an `emptyDir` deployment loses every ledger with the pod. So on
Kubernetes, point it inside the mounted volume (`WORKFLOW_LOCAL_DATA_DIR=/app/data/workflow`) and
enable persistence if runs should survive a restart.

The Helm chart says the same next to `replicaCount` and in
[`charts/libredb-studio/README.md`](../charts/libredb-studio/README.md), which carries the working
recipe; the agent has no dedicated values fields, so its variables are passed through `extraEnv`. Note
that the opt-in Postgres backend is not reachable in the container image or the npx payload today
(B16), so multi-replica agent runs need that fixed first.

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
├── capability-probe.ts   # tool calling / structured output / streaming, established positively
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
- **B17** — table profiling and monitoring tools are deferred; the M2 tool set is the four above.
- **B18** — nothing calls the capability probe, so a model that cannot call tools is discovered at its
  first tool call rather than refused at start.
- **B19** — the agent endpoints are described here but are absent from
  [`docs/API_DOCS.md`](./API_DOCS.md).
- **B20** — a Gemini deployment behind a proxy is not configurable: `LLM_API_URL` is unread for that
  kind, in the chat surface as much as in the agent.
- **B21** — the published package's `BottomPanel` carries the agent-provenance branch as dormant
  markup.

## Related documentation

- [`docs/SECURITY.md`](./SECURITY.md) — controls 3.4 and 3.5, and the reasons they read as they do.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — where this sits in the application.
- [`docs/BACKLOG.md`](./BACKLOG.md) — the deferrals above, in full.
- [`docs/providers/postgres.md`](./providers/postgres.md) and
  [`docs/providers/sqlite.md`](./providers/sqlite.md) — the agent execution profile per engine.
