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
(`AgentRail.tsx:786-807` chooses the presentation, and it is one component instance either way, so
an objective you are typing survives a window resize).

Three controls elsewhere in the shell open it **carrying the statement in your editor**:

| Control | Where | What it does |
| --- | --- | --- |
| "Ask the agent about this query" | Command palette (`src/components/CommandPalette.tsx:134-137`) | Selects the *Investigate* workflow and fills the objective with the editor's statement |
| "Ask about this query" | Mobile header (`src/components/studio/StudioMobileHeader.tsx:232-242`) | The same, and opens the sheet |
| "Agent" | Mobile nav (`src/components/Studio.tsx:825`) | Opens the rail and asks nothing |

**None of them starts a run.** The shortcut selects a workflow and fills the box; pressing **Start**
is yours (`src/components/agent/use-agent-prefill.ts`, and the rail's own effect at
`AgentRail.tsx:268-302`). If you were already typing an objective, the shortcut does not overwrite
it — it offers the new one on a line reading `Suggested: …` with a **Replace** control beside it
(`AgentRail.tsx:473-490`). The statement is passed as you wrote it, minus surrounding whitespace;
nothing is composed around it on your behalf (`Studio.tsx:262-269`).

**If the rail is not there, the server is telling you something.** Visibility is derived rather than
flagged: the browser asks `GET /api/agent/config` once per mount
(`src/hooks/use-agent-capability.ts`), and the rail renders only for `{"enabled": true}`. The same
answer carries a `reason` naming which condition failed — no model configured, an unwritable ledger,
an operator off-switch — so `curl` on that route is the diagnosis. The conditions and the reason
codes are in [`docs/AGENT.md`](./AGENT.md#turning-it-on).

---

## What a run is

A run is **one objective, asked once, against one connection**, recorded as an append-only ledger.
You choose three things before pressing Start, and two of them are controls in the rail's header:

**1. The mode — how the run executes** (`AgentRail.tsx:405-420`, labels at `AgentRail.tsx:80-83`):

| Button | What it means |
| --- | --- |
| **Plan** | The model reasons about your objective and writes an approach. It has **no tools**, so it performs zero database operations. This is what a run opens in. |
| **Agent** | The model is given the read-only tools and investigates: it drafts statements, reads results, and finishes by composing a report whose claims cite what it read. |

**2. The workflow — what the run is for** (`AgentRail.tsx:433-448`, labels at `AgentRail.tsx:94-98`):
**Investigate**, **Optimize**, **Assess**. Offered in both modes, because "how would you make this
faster?" is an ordinary thing to ask a plan for.

**3. The objective** — the box labelled *"What should the run investigate?"*, placeholder *"Why is
checkout slow?"*, bounded to 4000 characters (`AGENT_MAX_OBJECTIVE_LENGTH` in
`src/lib/agent/execution-policy.ts:157`).

Both axes are **fixed when the run opens** and are read from the run's own record for the rest of
its life (`src/app/api/agent/runs/route.ts:79-88`), so nothing can widen a Plan run into an Agent
one afterwards.

**The connection is the one the shell is on, and it has to be one the server can rebuild.** A run
stores a connection id and no credential, so a connection that exists only in your browser cannot be
investigated. The rail says so rather than offering a Start that must fail:

> *"… cannot be rebuilt on the server: its settings live in this browser. A run re-resolves its
> connection there after a restart, so it can only investigate a connection the server holds too."*
> (`AgentRail.tsx:492-498`)

---

## The four workflows

Each workflow changes three things: what the model is told the run is FOR, which tools it is offered,
and the bar its verdict is judged against.

### Investigate

The default. The objective is a question about the database and the model answers it from what it
establishes (`WORKFLOW_OBJECTIVES.investigation` in `src/lib/agent/investigation.ts:203`). Tools:
`inspect_schema`, `run_read_query`, `inspect_plan`, `compose_report`
(`AGENT_MODE_TOOLS`, `src/lib/agent/tools.ts:402-407`).

**Answered when** the run composed at least one claim and the claims do not rest entirely on empty
results (`verifyInvestigationGoal`, `src/lib/agent/goal-verifier.ts:172-173`).

### Optimize

For a statement that is too slow. The model is told that what matters is *how the engine reaches its
rows* (`investigation.ts:204-205`), and it is offered two further tools: `compare_plans`, which
takes the ids of two plans the run already inspected, and `recommend_change`, which records one
index or rewrite (`tools.ts:384-394`).

Two things this workflow will not do, and it says so rather than implying otherwise:

- **Every plan is an estimate.** `EXPLAIN ANALYZE` executes the statement and is policy-denied, so
  the comparison entry carries a sentence the application wrote: *"Estimates only: these plans were
  described, not executed. EXPLAIN ANALYZE is policy-denied because it would run the statement."*
  (`PLAN_ESTIMATE_CAVEAT`, `timeline.ts:209-210`).
- **A recommendation is never applied.** Every recommendation entry carries *"Not applied: nothing
  here runs this statement."* (`NOT_APPLIED_CAVEAT`, `timeline.ts:213`), and the only thing offered
  is an **Apply to editor** button, which puts the text in your editor and runs nothing
  (`HydrationControls`, `AgentRail.tsx:176-186`).

**Answered when** the Investigate bar is met **and** the change it proposes rests on a plan it read:
a before/after comparison for a rewrite, or — for an index, whose "after" plan would need the index
to already exist — the recommendation citing the plan it diagnosed (`verifyQueryOptimizationGoal`,
`goal-verifier.ts`).

### Assess

For the state of the data itself — where it is incomplete, inconsistent or surprising
(`investigation.ts:206-207`). It adds one tool, `profile_table`, and the rule that matters is worth
reading before you point it at a table of personal data:

**A profile records counts, never values.** Row counts, present counts, distinct counts, and how
many values match a shape — computed inside the database with `count(CASE WHEN … LIKE …)`, so no
matching value leaves it. There is deliberately no `min`/`max`, because on a text column those
return real values (`src/lib/agent/table-profile.ts:1-27`). The findings — `high_null`, `constant`,
`low_cardinality`, `suspected_pii`, `fk_unindexed` — are the server's own mechanical predicates over
those counts, with stated thresholds; the model may interpret them and cannot invent one.

**Answered when** the Investigate bar is met **and** a table was actually profiled
(`verifyDatabaseAssessmentGoal`, `goal-verifier.ts:211`).

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
- **It has no schema and no free-form SQL.** There is no `inspect_schema` and no `run_read_query`
  here, and the run is told so in its opening message rather than being left to discover it.

Two things this workflow will not do, and it says so rather than implying otherwise:

- **Every reading is a moment, not a history.** A session list is who was connected as the run
  looked. The timeline says so on the entry itself: *"A moment, not a history: this reading says what
  the engine reported as it was taken."* (`POINT_IN_TIME_CAVEAT`, `timeline.ts`), and the model is
  told the same before it starts, so a report cannot quietly imply a trend was measured.
- **It cannot propose an operational action.** `recommend_change` offers an index or a rewrite and
  nothing else, so "kill this session" or "vacuum this table" is stated as a claim in the report
  rather than filed as a recommendation you could apply with one click.

**Answered when** the run composed a report (`verifyOperationsGoal`, `goal-verifier.ts`). Every
claim in it already cites a reading the run took — `compose_report` refuses a claim whose evidence
names nothing this run produced, and a reading is the only thing this workflow can produce to cite —
so the citation is enforced as you write, not judged afterwards. Note what is deliberately **not**
required: a reading that came back **empty** still counts. No blocked session and no slow query is
what a healthy server looks like, and treating that as an absence of evidence would mark an accurate
report as unanswered.

---

## What you see while a run goes

The rail's timeline is a fold over the run's ledger, one line per recorded event
(`foldLedgerEntries`, `timeline.ts:603-675`). Before anything has happened it says *"No activity
yet. A run's steps appear here as they are recorded."*

| Headline | When |
| --- | --- |
| `Run opened in <mode> mode for <workflow>` | The run's own header. Your objective is shown quoted underneath. |
| `Schema captured` | The run read the catalog once: table count and the first 8 characters of the snapshot fingerprint |
| `Statement drafted` | The model wrote SQL. The statement is shown quoted, with the model's stated reason |
| `Tool invoked` / `Result stored` | The call, then its outcome: rows, columns, elapsed ms, and the artifact id |
| `Refused by policy` | The operation layer denied it. Shown by deny code — there is no engine text, because a denial produced none |
| `Approval required` | The operation needs a human approval this run does not have |
| `The database refused the statement` | The engine's own message, quoted |
| `Plans compared` / `Index recommended` / `Rewrite recommended` | Optimize only |
| `Profiled <table>` | Assess only: counts and findings |
| `Result stored` … *"A moment, not a history"* | Operate only: an operational reading, with the caveat that it describes an instant already past |
| `Report composed` | How many claims, each citing evidence |
| `Closing statement` | The model's closing prose. It cites nothing and claims nothing — a Plan run's whole output, an Agent run's aside |
| `Stop requested` | You pressed Stop; *"the run takes no further database step; work already in hand, such as a report, still finishes"* |

**Wording the application chose and text that came from elsewhere never share a line.** Headlines
and details are the application's words; anything from the model, the engine or you is rendered as a
quoted block, because database content is untrusted input (`timeline.ts:25-36`).

Two controls appear under an entry only when there is something to act on **and** the shell can act:

- **Apply to editor** — puts a drafted statement into the editor. Always your click, never automatic.
- **Show result** — hydrates the stored rows into the ordinary results grid, with a read-only
  provenance badge naming the run. It is offered only **while the run is live**: a run's stored rows
  are released when it ends, and the rail says so where the results are listed — *"A run's stored
  rows are released when the run ends, so a result can be shown only while its run is still
  going."* (`AgentRail.tsx:730-735`).

At the bottom, once a report exists, a **Report** section lists each claim as the model's own quoted
prose with its citations under it — `Artifact <id>` with the row count and the statement that
produced it, or `Schema snapshot <fingerprint>` with the table count. A citation the rail cannot
resolve in what it has read says so in amber rather than looking checked
(`UNRESOLVED_DETAIL`, `timeline.ts:556`).

---

## What "answered" means

**A run's ending and its verdict are two different facts, and the rail states them separately.**

The status word — `succeeded`, `failed`, `cancelled` — says how the run ended. It does **not** say
whether you got an answer: a run whose model stopped without composing a report ends `succeeded`,
and a run that ran out of turns ends `failed`, and neither answered anything. This was not a
hypothesis; both were observed on live runs, which is why the verdict is a separate field
(`timeline.ts:452-461`, and [`docs/AGENT.md`](./AGENT.md#whether-the-run-answered) for the mechanism).

So the last line of a run reads **"Run answered"** or **"Run did not answer"**
(`answeredHeadline`, `timeline.ts:328-329`). A ledger written before verdicts existed carries none,
and such a run keeps the status word it always had (`Run succeeded`) rather than being given a
judgement nobody made.

Under it, when the run fell short, is **one sentence naming what it did not produce**. These are the
whole vocabulary (`SHORTFALL_SENTENCES`, `timeline.ts:335-343`):

| The run did not answer because | The sentence you get |
| --- | --- |
| `no-report` | "The run finished without composing a cited report, so nothing it found was written down." |
| `empty-evidence` | "Every result the report cited came back empty, so the answer rests on nothing." |
| `no-plan` | "The run produced no plan at all." |
| `no-plan-comparison` | "No before-and-after plan comparison was recorded, and no index was recommended: a query optimization rests on one or the other." |
| `no-plan-evidence` | "The index was recommended without citing a plan this run read, so nothing the engine said backs it." |
| `no-table-profile` | "No table was profiled, so the state of the data was never established." |
| `cancelled` | "The run was stopped before it could finish." |

A run **you** stopped reports `cancelled` rather than the output it was missing: a stop is not a
defect of the run (`goal-verifier.ts:166,172`).

If the run had no shortfall to report, the line under the verdict says how the loop ended instead
(`STOP_SENTENCES`, `timeline.ts:267-282`) — for example *"The run reached its step limit before it
finished. What it had gathered is above."*

**The shortfall wins over the ending in both modes** (`describeEnding`, `timeline.ts:305-315`), and
one ending is where that matters. When the model simply stops, an **Agent** run that composed no
claims also carries the `no-report` shortfall (`verifyInvestigationGoal`, `goal-verifier.ts:172`), so
the sentence you actually read is the shortfall one — *"The run finished without composing a cited
report, so nothing it found was written down."* The stop sentence for that ending, *"The model
stopped without composing a cited report."*, is what a run whose ledger carries **no verdict at all**
shows. In **Plan** mode the same ending is not a shortfall at all — a plan run that spoke has met its
bar (`verifyPlanningGoal`, `goal-verifier.ts:163-166`) — so its own wording is what appears: *"The
model finished its plan and stopped. Planning mode has no tools, so it composed no report."*, which
is how a good Plan run ends.

And when the run failed for a reason that is not about the answer at all, that sentence wins over
both, and also appears next to the Start button so you can fix it before starting another
(`FAILURE_SENTENCES`, `timeline.ts:189-198`; rendered at `AgentRail.tsx:506-510`): the model
provider not being configured or reachable, limiting this key's requests, rejecting the credentials,
an engine with no read-only execution profile, a connection that no longer resolves, or an internal
failure whose reason is in the server log.

---

## The budget meter's numbers

The meter above the timeline shows **three gauges, and it shows only what the server actually
enforces and the ledger actually records** (`AgentRail.tsx:650-678`, gauges built in
`timeline.ts:668-672`):

| Gauge | Reads | The limit, and where it comes from |
| --- | --- | --- |
| **Statements** | `used / 20` | `maxStatementsPerRun`. Every statement the pipeline allowed and invoked — catalog reads, drafts and repairs alike (`execution-policy.ts:46-56`) |
| **Database time** | `used / 60.0 s` | `maxTotalRunMs`. **Database time only** — the elapsed time completed reads reported, not the wall clock |
| **Repair attempts** | `used / 3` | `AGENT_MAX_REPAIR_ATTEMPTS`. Only statements that failed **at the database** consume one; a policy denial does not |

Under them, one line states the three ceilings that nothing durable counts against, so they are
given as ceilings rather than as gauges: *"Each statement gets 10.0 s, each drive 5.0 min and at
most 16 model turns."* (`AgentRail.tsx:666-669`, values from `statementTimeoutMs`,
`AGENT_RUN_DEADLINE_MS` and `AGENT_MAX_MODEL_TURNS`).

**There is no token gauge, and its absence is deliberate**: this build enforces no token budget, so
a figure would mean nothing (`docs/BACKLOG.md` B10).

Then the caveat, which is the part worth reading twice (`AgentRail.tsx:670-677`):

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
a red error line (`AgentRail.tsx:589-628`):

- the heading *"This model cannot drive an agent run."*;
- **The probe could not establish:** one chip per capability, in this build's own labels — *tool
  calling*, *schema-valid tool arguments*, *streaming* (`src/lib/agent/capability-labels.ts`);
- the server's own sentence, which is the only place the model's name and the **endpoint's own
  words** appear;
- and what is still worth trying.

That last line has three registers, and which one you get is a fact about what the probe saw
(`refusalActionText`, `AgentRail.tsx:137-145`). Where nothing the probe observed rules it out, you
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
(`provider-registry.ts:86,105-111`).

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
  (`src/lib/db/operations/execution.ts:129`, reached only from `src/lib/agent/tools.ts:844`) — under
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
  (`src/lib/db/factory.ts:437`), which the runtime reports as `engine-unsupported`
  (`src/lib/agent/runtime.ts:199`) — the rail says so in as many words
  (`src/components/agent/timeline.ts:195`). So on MySQL, Oracle, SQL Server, MongoDB, Redis,
  ClickHouse, Druid and Couchbase an Agent-mode run cannot read anything. It also covers the bundled
  **LibreDB sample** connection, whose provider implements no `queryReadOnly`
  (`src/lib/db/providers/embedded/libredb.ts`) — the bundled **SQLite sample** is the seeded
  connection to try a run against (`src/lib/seed/sqlite-sample.ts:131`). **Plan** mode is unaffected:
  it is toolless and reaches no database, so it works on every connection.
- **It never executes a recommendation**, and never applies one to your editor by itself.
- **It cannot be paused or resumed from the rail.** There is a Stop control and nothing standing in
  for a capability this build does not have (`docs/BACKLOG.md` B11).
- **A stopped run stops at its next checkpoint**, not instantly: cancellation is enforced by the run
  loop's own persisted state, and the checkpoint sits in the step that reaches a database. A run that
  was already composing its report therefore finishes it and answers — twice on 2026-08-12 it did,
  2.4 seconds after the Stop. That is the contract rather than a defect, so what changed in #356 is
  that the ending now says it: *"A stop was requested before this ending: the run took no further
  database step, and finished what it already had in hand."*
- **A run's stored rows do not outlive it**, so a report can outlive the rows its citations point at
  (`docs/BACKLOG.md` B15). An artifact hydrates the grid and the explain view, not the chart or
  export surfaces (B14).
- **An interrupted run is resumable but is not resumed on its own** — nothing enqueues a drive yet
  (`docs/BACKLOG.md` B9).
- **It reads what your connection's role can read.** The declared-target allowlist, the statement
  guard and the role's own grants are the whole boundary on out-of-scope reads
  (`docs/BACKLOG.md`, "Agent M1 deferrals", A3).

What it sends to your model provider, and what it does not, is a page of its own:
[`docs/AGENT_DATA_FLOW.md`](./AGENT_DATA_FLOW.md).
