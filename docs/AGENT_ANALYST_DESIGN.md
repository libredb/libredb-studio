# The data-analyst face — design and decisions

> ## Status: implemented
>
> **This was a proposal and is now built.** The `data-analysis` workflow shipped on branch
> `feat/agent-data-analysis` (stacked on `feat/agent-operations-workflow`), across the slices
> `de63e77` → `df0dbd0` and the review-fix commits after them. Sections 1 through 4 describe shipped
> behaviour; Section 5 and "What is deliberately not in this design" remain unbuilt by intent.
>
> **The document has been reconciled with what was actually built**, because a design document the
> code does not match is the defect class this repository keeps finding. Every place the
> implementation diverged from the proposal now states what exists, in a `> **Built:**` note beside
> the proposal it replaces. The divergences, in one list:
>
> | Proposed | Built | Why |
> | --- | --- | --- |
> | §3.2 `AgentChartSpec.series` — an optional series-split column | **No `series` field at all** | `DataCharts` has no series split; several series are several `y` columns there. The field was invited, validated, recorded and then discarded by the renderer — so it was removed from all four layers rather than implemented in one more. |
> | §3.3 validation includes `series` in the column check | The check covers `x` and every `y` | Follows from the above. |
> | §2.6 the checkbox, with no workflow scope stated | Offered on **`data-analysis` in agent mode only**, and `POST /api/agent/runs` refuses `autoExecute: true` anywhere else | Auto-execute hands over `present_answer`'s answer, and that tool is offered to this workflow alone. Rendering it elsewhere promised a hand-over four workflows cannot perform. |
> | §2.4.0 condition 2 joins the plan to the answer's statement | Joined on `fingerprintStatement`, the repair ledger's canonical form | Exact string equality between two independently drafted statements missed on whitespace, case or a trailing semicolon, which made the gate inert far more often than §2.4.0 implies. |
> | §2.4.0 condition 2 on SQLite reads `access === "index"` | **And no `uninterpretedStep`**: a plan the server could only PARTLY read is risky too | `summariseSqlite` recognises `SEARCH` and `SCAN`, so `SEARCH …` beside an uninterpreted step summarised as a flat `index` and passed the gate. `unknown` resolving to risky only held when NO step had been recognised. |
> | §2.6 the checkbox, scoped by workflow and mode | **And by the host**: no `onRunStatement`, no checkbox | The prop is optional, so an embedding host may have no runner. The rail used to offer the promise and fall back to applying the statement, which left the timeline saying it "ran on your connection" about something that did not happen. |
> | §2.1/§2.6 "run it there — on your connection", with the connection assumed fixed | **And only on the connection the run was opened on**: the rail declines the hand-over when the editor has moved elsewhere, and says so beside the entry | The host runs a statement against its ACTIVE connection. A user who switched databases mid-run got the statement run, unbounded, against a database whose plan was never inspected — and its rows shown as the answer. |
> | §2.3 one `answer-composed` event, with nothing said about a second | **A run answers once**: a second presentation is refused with `ANSWER_ALREADY_RECORDED` | `present_answer` is non-terminal, so a model could present twice. Two entries mean two statements handed to the editor and, with auto-execute on, two run there — under a checkbox that promised the final answer. |
> | §4.2 the rule: the baseline, **and** an `answer-composed` entry | **And at least one claim citing the presented artifact**, with the shortfall `answer-uncited` | Nothing linked the report to the answer, so a run could chart artifact A while every claim cited artifact B and still score `answered` — unrelated prose beside a picture. |
> | §3.3 the answer's artifact is checked the way a citation is | **And narrowed**: only a `sql.query.read` result may be PRESENTED, refused as `ANSWER_NOT_A_DATA_READ` | A citation may legitimately name a plan; an answer may not. A plan step carries a drafted statement, so a run could present the engine's description of a statement and meet the verdict without reading any data. |
> | §2.1/§2.5/§2.6 "run it there", assumed to mean the editor's ordinary execution | **A third execution profile, `agent-handover`, and a route of its own**: the replay runs through `provider.queryReadOnly` under the engine's read-only session at `DEFAULT_QUERY_LIMIT` rows and no statement timeout | The editor route is a read-WRITE session guarded only by `isDangerousQuery`, a syntactic check. A `SELECT` calling a VOLATILE function that performs an `INSERT` is refused inside `BEGIN READ ONLY` and succeeds there — so "writes and DDL are refused either way" was false of the half the checkbox buys, and no reading of the statement could have made it true. |
> | §2.4.0 condition 2 joins on `fingerprintStatement`, whose canonical form drops comments | **And a statement carrying an optimizer directive takes no part in the join, on either side** | Under `pg_hint_plan` a hint block is an instruction to the planner, not trivia. A cheap indexed plan taken for the unhinted text licensed an answer whose hint forces a sequential scan: condition 2 passed with a plan that is not the plan of the statement the editor runs. |
> | §1.6 budget figures | Shipped exactly as approved: 60 / 42 / 900 s / 180 s | No divergence — recorded here because these figures are **still pending the live measurement** the owner's decision made a condition of freezing them. |
>
> The `operations` assumption below was written when that workflow was an uncommitted local branch.
> It has since become a real branch and this work is stacked on it, which is why
> `AgentRunWorkflowType` carries both members and every total `Record` over it decides for both.

A design document, not an implementation plan. It proposes one new agent workflow (`data-analysis`),
the autonomy control the owner asked for, the chart contract, the verdict rule, and what the run
would need to understand a business question. Every claim is tied to the code that makes it true, in
`file:line` form, so any sentence here can be checked rather than believed. Where something is an
inference rather than a reading, it says so.

It assumes the DBA-face `operations` workflow lands and follows its patterns. It does not redesign
it. What that workflow was doing when this was written is a local branch with no commits beyond
`main`, so nothing here is written against its code — only against the three workflow-shaped seams
every workflow uses
(`WORKFLOW_TOOLS` in `src/lib/agent/tools.ts:443`, `WORKFLOW_OBJECTIVES` / `WORKFLOW_TOOL_RULES` in
`src/lib/agent/investigation.ts:207,219`, and `AGENT_WORKFLOW_GOALS` in
`src/lib/agent/goal-verifier.ts:281`).

## Contents

- [The three questions this workflow is for](#the-three-questions-this-workflow-is-for)
- [1. Budgets](#1-budgets)
- [2. Auto-execute](#2-auto-execute)
- [3. Charts](#3-charts)
- [4. What "answered" means for an analytical run](#4-what-answered-means-for-an-analytical-run)
- [5. Semantic grounding](#5-semantic-grounding)
- [What is deliberately not in this design](#what-is-deliberately-not-in-this-design)
- [Open questions](#open-questions)

---

## The three questions this workflow is for

The owner's own examples, and what each one actually demands:

| The question | What it is | What it needs |
| --- | --- | --- |
| "Prepare a chart grouping today's sales by region." | A retrieval and a presentation | Find the fact table and the region dimension; one aggregate read; a chart spec |
| "Compare customer complaints between last month and this month as a chart." | Two retrievals and a comparison | The same, plus a date column that means the business event, plus two windows |
| "Why are our sales down this month?" | A causal question | All of the above, plus knowing which decomposition of "sales" is the business one, and the judgement to stop |

The first two are inside what this runtime can do today with a new workflow and a chart contract.
The third is not, and [Section 5](#5-semantic-grounding) says why and what the smallest honest step
toward it is. That difference should shape what the first version claims.

---

## 1. Budgets

The owner's question is whether `AGENT_MAX_MODEL_TURNS = 16`
(`src/lib/agent/execution-policy.ts:138`) and `maxStatementsPerRun = 20`
(`src/lib/agent/execution-policy.ts:50`) are far too low for analytical work, and whether something
like 100 is right. The short answer is that 16 is probably too low, 100 is not reachable, and the
turn ceiling is not the number that governs cost.

### 1.1 Message growth: the shape is quadratic, and the statement budget is what bounds it

The drive loop keeps one `messages` array per drive (`src/lib/agent/investigation.ts:704`). It is
appended to and never trimmed:

- the objective, once (`:704`);
- the prior-progress summary on a resume (`:706`);
- the packed schema inventory and the relations block (`:742-743`, `:759-760`);
- the SDK's own assistant messages, every turn (`:798`);
- one tool-result message per tool call, every turn (`:807`).

`takeTurn` sends the whole array on every call (`messages: [...messages]`,
`src/lib/agent/investigation.ts:583`). Nothing configures prompt caching anywhere under
`src/lib/agent/` — I grepped for `cacheControl`, `providerOptions` and the Gemini cached-content
fields and found none — so whatever implicit caching a provider does is not something this code
arranges, requests or measures. Treat every turn as paying for the whole transcript.

That makes the token cost of a run **quadratic in turns, not linear**. If `B` is the fixed base sent
every turn and turn *i* adds `r_i` tokens of tool result, the cost of the run is

```
Σ_{i=1..N} ( B + Σ_{j<i} r_j )   =   N·B  +  Σ_{j} r_j·(N − j)
```

which for roughly constant `r` is `N·B + r·N(N−1)/2`. Doubling the turns roughly quadruples the
spend on results.

The sizes, read off the code rather than guessed:

| Part of the transcript | Bound | Where |
| --- | --- | --- |
| System instructions | ~1.5 k chars, all constants | `investigation.ts:156-249` |
| Objective | 4 000 chars | `execution-policy.ts:157` |
| Packed schema inventory | 6 000 chars, fenced whole | `context-snapshot.ts:348` |
| Relations block | 2 000 chars | `er-diagram.ts` (`MAX_ER_CHARS`) |
| Tool declarations, resent each turn | ~3 k chars for 7 descriptions + schemas | `investigation.ts:557-566` |
| **One completed read** | **200 rows and 256 KiB, whichever binds first** | `execution-policy.ts:54-55`, enforced at `postgres.ts:917-931` and `sqlite.ts:429` |

So `B ≈ 16 k chars ≈ 4 k tokens` (at a conservative four characters per token; the ratio is the
model's tokeniser's, which this layer deliberately does not know — `context-snapshot.ts:340-347`
makes the same point about why its own bound is in characters).

A completed read's `modelText` is one `JSON.stringify` per row, newline separated
(`renderRows`, `src/lib/agent/tools.ts:620-624`), inside a fence. The row cap fires first for
ordinary data: 200 rows of a typical analytical result is 20-60 KB, so **`r ≈ 5-15 k tokens` per
read**, with a hard ceiling of 256 KiB ≈ 64 k tokens for very wide rows.

Now the part that answers the owner's question directly. **`maxStatementsPerRun` — not the turn
count — is what bounds how much of that ever enters the transcript.** After twenty statements every
further database reach is denied with `STATEMENT_BUDGET_EXCEEDED`
(`src/lib/db/operations/execution.ts:56`), which is classed `absolute`
(`src/lib/agent/tools.ts:551`) and answers with a two-sentence server string
(`denialText`, `tools.ts:568-574`) — a few hundred tokens, not a result set. So:

| | Turns | Statements | Final request | Whole run |
| --- | --- | --- | --- | --- |
| Today | 16 | 20 (rarely all spent) | ~4 k + 10 reads × 8 k ≈ **84 k tokens** | ≈ **0.5 M tokens** |
| Turns only → 50 | 50 | 20 | ~4 k + 20 × 8 k + 30 × 0.4 k ≈ **176 k** | ≈ **7 M** |
| Turns only → 100 | 100 | 20 | ≈ **196 k** | ≈ **17 M** |
| Both → 100 | 100 | 100 | ~4 k + 100 × 8 k ≈ **804 k** | ≈ **40 M** |

Two readings follow, and they are the load-bearing ones:

1. **Raising the turn ceiling alone is cheap in context and expensive in spend.** The context window
   stays bounded because the statement budget bounds it; the token bill rises quadratically for
   turns that cannot read anything new.
2. **Raising both to 100 puts the final request near or past every context window this repository
   serves** except Gemini's largest, and lands a 40 M-token bill on a single question. The
   pathological worst case — 100 reads at the 256 KiB ceiling — is 6.4 M tokens in one request,
   which no model accepts.

There is a third reading, less obvious and worth stating because it is the strongest argument
against a large turn ceiling by itself. Once the statement budget is spent, a turn can do exactly
three things: repeat a settled step (answered from the ledger without executing —
`run-service.ts:365-366`), send a statement that already failed (refused by the repair ledger —
`tools.ts:816-817`), or send a new statement that is denied on budget. **None of them reads
anything.** Those turns are a model re-reasoning over a transcript that has stopped changing, and
the docstring on `AGENT_MAX_MODEL_TURNS` says exactly what that constant is for
(`execution-policy.ts:121-129`): it is the backstop for "a model that keeps producing tool calls the
loop refuses without ever reaching the database, which spends no statements and no repair attempts."
Raising it to 100 makes that backstop six times weaker for the one pathology it exists to catch.

### 1.2 Artifact memory: 64 entries, process-wide, and eviction is not run-fair

Every allowed execution stores its `QueryResult` in a process-memory store keyed by correlation id
(`src/lib/db/operations/execution.ts:220-223`), released when the run ends
(`releaseExecutionRun`, `:236-239`). The store is built once per process
(`src/lib/agent/runtime.ts:62-73`) with:

- `AGENT_MAX_ARTIFACTS = 64` (`runtime.ts:56`) — **entries, process-wide, not per run**;
- `AGENT_ARTIFACT_TTL_MS = AGENT_RUN_DEADLINE_MS × 4` = 20 minutes (`runtime.ts:55`).

Eviction is oldest-first across the whole map (`artifacts.ts:98-101`), and the module says plainly
that it bounds the entry count, so the worst-case footprint is `maxArtifacts × maxResultBytes`
(`artifacts.ts:22-27`) — 64 × 256 KiB = **16 MiB of measured row bytes**, which as live JavaScript
objects will be several times that in heap. That is acceptable today and stays acceptable at the
numbers below, but two things break if `maxStatementsPerRun` rises far:

- **At 100 statements a single run evicts its own evidence.** Past 64 artifacts the store drops the
  oldest — which belongs to the same run. `compare_plans` already has a refusal for this
  (`PLAN_RESULT_RELEASED`, `tools.ts:492-493`), and `verifiedAgainst` checks the ledger rather than
  the store (`tools.ts:1447-1458`), so a report can still cite an evicted artifact. What breaks is
  the promise the rail makes to the user: "Show result" is offered *while the run is live*
  (`docs/AGENT_GUIDE.md`, and B15 for the after-the-run case), and an evicted artifact makes that
  button 404 mid-run.
- **Eviction is not run-fair.** With more than one run in flight, a busy run evicts a quiet run's
  results. Nothing today notices; nothing today needs to, because 20 statements per run means
  roughly three concurrent runs fit.

So: eviction is already there, and it is the wrong eviction for a larger statement budget.
Recommended, in order of importance:

1. Raise `AGENT_MAX_ARTIFACTS` to at least `(largest per-workflow statement ceiling) × (assumed
   concurrent runs)`. With the numbers in §1.5 that is 28 × 4 = 112; **recommend 128**.
2. Make eviction **per run**: when a run's own artifact count reaches its statement ceiling, evict
   that run's oldest rather than the store's oldest. It is a small change to `ExecutionArtifactStore`
   and it removes the cross-run interference entirely.

Deployment note: the agent's zero-config backend is single-instance by design
(`docs/AGENT.md`, "Deployment"), and the chart refuses to render an agent-capable release with more
than one replica. So "one process holds all of this" is the shipped topology, not a simplification.

### 1.3 The wall clock: which ceiling actually binds

Two independent bounds, checked between turns (`investigation.ts:823-828`):

- `remainingMs <= 0` → `deadline-exceeded` (`:826`), from `AGENT_RUN_DEADLINE_MS = 300_000`
  (`execution-policy.ts:82`), a monotonic per-run clock (`deadline.ts:119-165`);
- `turns >= maxTurns` → `turn-limit` (`:827`).

Plus `AGENT_MODEL_TURN_TIMEOUT_MS = 90_000` on one call (`execution-policy.ts:99`) and
`maxTotalRunMs = 60_000` of **database** time (`execution-policy.ts:52`).

Let `L` be the average wall time of one model turn. The measured anchors this repository has are the
capability probe against a local Ollama — 4.7 s warm for a trivial one-tool prompt
(`docs/AGENT_GUIDE.md`, "What was measured") — and the run loop's own note that "turns on this
workload land in seconds" (`execution-policy.ts:88-89`). A real turn carries a 50-200 k-token
transcript, and time-to-first-token grows with prompt length, so `L` grows over a run. Taking
`L ∈ [4 s, 12 s]` and reserving up to 60 s of database time:

| Turn ceiling | Turns the 300 s deadline permits | Which ceiling binds |
| --- | --- | --- |
| 16 | 20 – 60 | **turn-limit**, always |
| 50 | 20 – 60 | deadline at the slow end, turn-limit at the fast end |
| 100 | 20 – 60 | **deadline-exceeded**, always |

**So raising `AGENT_MAX_MODEL_TURNS` to 100 without touching `AGENT_RUN_DEADLINE_MS` changes the
word in the ledger and buys somewhere between 4 and 44 extra turns.** It does not deliver 100 turns
on any configuration; it delivers roughly 20-60 and then dies on the clock. That is the direct answer
to the owner's question: the turn ceiling and the wall clock have to move together or the larger one
is decoration.

One more bound worth naming because it is invisible from the constants: `maxTotalRunMs = 60_000` is
database time, and an analytical run spends it faster than an investigation does. A `GROUP BY` over
a fact table is not a catalog read. At 20 statements averaging 3 s the run exhausts its database
budget before its statement budget, and the denial is `TOTAL_RUN_BUDGET_EXCEEDED`
(`execution.ts:57`) — also `absolute`, also unrepairable. This is the ceiling most likely to bite
this workflow first, and it is not one the owner's question mentioned.

### 1.4 The ledger and the browser

Every event is appended to the durable ledger and streamed to the rail as NDJSON. The browser reads
it with a raw `ReadableStream` reader (`src/components/agent/use-agent-run.ts:179`), appends parsed
lines to a flat array (`:185`), and then:

```
timeline: foldLedgerEntries(entries)      // use-agent-run.ts:303 — no useMemo
```

`foldLedgerEntries` walks the entire accumulated array on every call
(`src/components/agent/timeline.ts:666-738`, the loop at `:693`), rebuilding the items, the status,
the three budget gauges, the artifact map and the statement map from scratch. Because it is not
memoised, it re-runs on every React render of the consumer, not merely on every new event. The rail
then renders every item with no virtualization (`AgentRail.tsx:681-715`; there is no `react-window`
or `react-virtual` import in the file, and the list is not sliced).

Cost today: a 16-turn run produces on the order of 60-100 ledger entries, so the fold is a
sub-millisecond walk of a small array and nothing has ever noticed. At 40 turns with 28 statements
the entry count roughly triples (~250-350), which is still small in absolute terms — the fold is
O(n) with a tiny constant — but it becomes O(n²) over the run's life, and it competes with the
stream reader on the same main thread. My reading is that this is **not a blocker at the numbers
recommended below, and is a blocker at 100 turns with 100 statements** (~1 200 entries, folded
~1 200 times, ~1.4 M item-visits, with no virtualization under it).

Recommended, and cheap: wrap the fold in `useMemo` keyed on `entries` — one line, removes the
re-render multiplier entirely and leaves the O(n²)-over-the-run behaviour, which is fine at these
sizes. Virtualization is not recommended yet: it is a real cost against a list nobody has measured
as slow, and the app's own rule is that a control the service cannot honour is not rendered
(`docs/AGENT.md`, "The surface in the app") — the same restraint applies to optimisations nobody has
measured a need for.

### 1.5 Failure shape: the worst outcome, made six times more expensive

A run that exhausts its turns ends `failed` / `turn-limit` (`investigation.ts:827`) with status
`failed`, no `report-composed` entry, and a goal verdict of `unanswered` with `no-report`
(`goal-verifier.ts:190`, written at `run-service.ts:453`). The whole spend is lost. The model's
closing prose survives if it happened to be non-empty (`investigation.ts:779`), but a
`closing-statement` cites nothing and claims nothing by contract (`types.ts:308-324`), so the rail
correctly reads "Run did not answer".

Multiplying the ceiling by six multiplies the cost of that outcome by six. **This is the change I
would make first, before any ceiling moves at all**, because it is worth having at 16 turns too:

> **Reserve the ending.** The loop already knows both distances to its ceilings. Add two constants —
> `AGENT_REPORT_RESERVE_TURNS = 2` and `AGENT_REPORT_RESERVE_MS = 20_000` — and when either
> reserve is crossed, push one server-authored user message before the next turn: *this is your last
> turn; call `compose_report` now with what you have established; a claim still has to cite an
> artifact this run read.*

Four properties make this safe rather than a weakening:

- **It costs nothing to reach.** `compose_report` reaches no database (`tools.ts:1460`, dispatched
  at `investigation.ts:850`), so it spends no statement, consults no deadline admission, and needs
  only one model turn.
- **It does not lower the bar.** `composeReportTool` still verifies every citation against the run's
  own event log and refuses an invented id (`tools.ts:1488-1489`). A forced report is a cited report
  or it is no report.
- **It is a message, not a rule change**, so it does not touch the policy version or the verifier.
- **It is the #350 lesson applied ahead of time.** A rule the model is not told is a rule live runs
  fail. "Finish by calling compose_report" is in `AGENT_RULES` today (`investigation.ts:178`), but
  nothing ever tells the model *when* it has run out of room.

The reserve should also be stated on the rail, so a user watching a run end early knows the run was
asked to stop rather than that it gave up.

### 1.6 Recommendation: per-workflow ceilings, as frozen constants

> **Decision (owner, 2026-08-14).** Per-workflow frozen constants are approved, as is measuring
> before the constants are finally frozen. The proposed figures are raised by 50 % across every
> dimension, and the raised figures are the starting point the measurement then confirms or corrects:
>
> | Workflow | Model turns | Statements | Run deadline | Database time |
> | --- | --- | --- | --- | --- |
> | `investigation` | 36 | 30 | 450 s | 90 s |
> | `query-optimization` | 36 | 30 | 450 s | 90 s |
> | `database-assessment` | 48 | 45 | 630 s | 135 s |
> | `data-analysis` (new) | 60 | 42 | 900 s | 180 s |
>
> Two consequences of the raise that the analysis below does not cover, because they only appear at
> these figures:
>
> - **Cost does not rise by 50 %.** By §1.1 the token cost of a run is quadratic in turns, so 40 → 60
>   turns is roughly 2.2× the tokens, not 1.5×, and the statement raise widens the per-turn payload
>   that quadratic multiplies. A `data-analysis` run at these ceilings is about twice the cost of one
>   at the proposed figures. That is a deliberate purchase, not an oversight.
> - **A 900 s run outlives common ingress timeouts.** The rail follows a run through a single
>   long-lived streaming response (`use-agent-run.ts:167`), and a 15-minute response is longer than
>   the default idle timeout of most reverse proxies in front of a container — nginx's
>   `proxy_read_timeout` is 60 s. The stream emits an entry per ledger event, so an active run keeps
>   the socket warm, but a run that spends four minutes inside one model turn writes nothing. Whoever
>   ships these ceilings must either document the required proxy timeout for the Helm chart and the
>   Docker deployment, or make the stream emit a keep-alive. This is not a reason to lower the
>   ceiling; it is work the ceiling creates.
>
> The figures below are the analysis basis the raise was applied to; the reasoning attached to each
> still holds, scaled.

**One global ceiling or per-workflow?** Per-workflow. The workflow axis already decides three things
in exactly this shape — the tool set (`tools.ts:443`), what the model is told
(`investigation.ts:207,219`) and the verdict rule (`goal-verifier.ts:281`) — each a total `Record`
over `AgentRunWorkflowType` so a new workflow stops the build until somebody decides. A fourth
record in the same shape is consistent, reviewable, and forces the same decision. And the workloads
genuinely differ: an optimization run needs two plans and a comparison (few statements, tiny
results); an assessment profiles many tables (many statements, tiny results); an analysis runs a
handful of aggregates (few statements, medium results) but needs room to iterate on getting the
aggregate right.

**Constants, environment configuration, or per-run user choice?** Frozen constants, and I would
refuse the other two:

- **Per-run user choice is the seam the policy exists to close.** `execution-policy.ts:10-16` states
  it directly: an injectable policy is "a seam through which a route, a workflow step or a resumed
  run could widen the agent's privileges". `maxStatementsPerRun` lives inside
  `AGENT_EXECUTION_POLICY.budgets` and is enforced as a policy deny code, and the policy carries a
  `version` whose whole job is to let a recorded decision be traced to the constant that produced it
  (`execution-policy.ts:60-64`). A request-chosen budget makes that version a lie.
- **Environment configuration has a second cost here.** `execution-policy.ts` is statically imported
  into the browser bundle — the rail reads its ceilings as values for the budget meter
  (`docs/AGENT.md`, "The surface in the app"; `AgentRail.tsx:666-669`). An env-configured ceiling
  would have to cross to the browser through a route, or the meter would state a number the server
  is not enforcing. That is real work for a knob nobody has asked to turn per deployment.

If a knob is wanted later, the right shape is a second named policy constant with its own `version`,
selected by workflow — not a variable.

**The numbers, and the reasoning attached to each:**

| Workflow | Model turns | Statements | Run deadline | Database time |
| --- | --- | --- | --- | --- |
| `investigation` | **24** | 20 | 300 s | 60 s |
| `query-optimization` | **24** | 20 | 300 s | 60 s |
| `database-assessment` | **32** | **30** | **420 s** | **90 s** |
| `data-analysis` (new) | **40** | **28** | **600 s** | **120 s** |

- **24 rather than 16 for the existing two.** 16 was chosen as a backstop "well above the number of
  turns a real investigation takes" (`execution-policy.ts:127-128`). A live run on 2026-08-14 spent
  all 16 and produced no report (`docs/AGENT.md`, the eval-harness section) — but the recorded cause
  was a *self-contradicting scripted world*, not a ceiling that was too low, so that measurement
  does not establish 16 is wrong. 24 is a modest widening that keeps the backstop's character and
  costs, by §1.1's shape, about 2.2× the tokens of 16. I would not go further without a measurement.
- **40 and 28 for analysis.** An analytical run's shape is: capture context (3 statements on
  PostgreSQL, 2 on SQLite — `context-snapshot.ts:97-102`), 2-4 exploratory reads to find the right
  table and understand a status column, 2-5 attempts at the aggregate (this is where the repair
  budget of 3 gets spent), 1-2 comparison windows, and the final answer. That is 10-16 statements in
  the good case and 20-25 when the first aggregate is wrong — which is exactly the case a bigger
  budget is for. 28 leaves room and stays under the 64-artifact store; 40 turns leaves roughly 1.5
  turns per statement plus the reserve.
- **600 s for analysis.** This is the number that makes 40 turns reachable: 600 − 120 (database) =
  480 s of model time, which is 40 turns at 12 s. Without it, 40 is decoration by §1.3.
- **120 s of database time for analysis.** Aggregates are not catalog reads. This is the ceiling most
  likely to bind first and the one the owner's question did not mention.

**What raising the wall clock costs, stated:** the artifact TTL is derived from the deadline
(`runtime.ts:55`), so it scales with it automatically and correctly. PostgreSQL opens and rolls back
its own read-only transaction *per statement* (`postgres.ts:889,903`), so a longer run does not hold
a longer transaction — the run's life and a transaction's life are unrelated on that engine. What a
longer deadline does cost is heap: the transcript and the artifacts stay resident for longer on a
single replica. At the numbers above that is tens of megabytes, not hundreds.

**And the multiplier nobody should forget:** every one of these ceilings is per *drive*, not per run
(`execution-policy.ts:130-136`, B6). N resumes cost up to N times a single drive's budget. Raising
the per-drive ceilings raises that multiplier by the same factor. Nothing currently enqueues a drive
(B9), so today N is 1 — but the seam exists, and whoever closes B9 inherits a bigger number than
they would have before.

---

## 2. Auto-execute

### 2.1 The premise, corrected

The owner's reasoning is that DDL and DML are already refused, so the only remaining risk is a heavy
query locking the database, and ticking the box moves that risk to the user. The first half is
right — the statement guard refuses writes, DDL and multi-statement text before any database is
reached (`src/lib/db/operations/statement-guard.ts:65-135`), and no tool in the agent layer maps
onto a write. The second half is four separate things, and only one of them is a lock.

**On PostgreSQL the risk is not a lock, it is the snapshot horizon.** A long-running read holds its
transaction snapshot, and while it is held, `VACUUM` cannot remove dead tuples newer than that
snapshot — anywhere in the database, not only in the tables the query touches. On a busy production
cluster that is bloat, and over a long enough read it is transaction-ID wraparound pressure. It is
not a lock; a writer is not blocked. It is slower, quieter and harder to attribute, which arguably
makes it worse. The agent's own path is safe from this by construction (each statement gets its own
`BEGIN READ ONLY` … `ROLLBACK`, bounded to 10 s, `postgres.ts:889-914`). The editor path is not.

**On SQLite the risk is worse than the owner said.** A long read genuinely does block writers, and
the driver is synchronous, so it also **blocks the studio process itself** — `deadline.ts:20-26` and
`docs/BACKLOG.md` A1 both record this, and the rail already states it in the budget-meter caveat.
And SQLite's `statementTimeoutMs` is checked *after* the statement returns, so there is no
preemption to fall back on. A runaway read on SQLite stalls every other user of the app.

**Ten million rows kills the browser, not the database.** The editor path applies
`DEFAULT_QUERY_LIMIT = 500` (`src/lib/db/utils/query-limiter.ts:38`) unless the tab has been put in
unlimited mode, where the ceiling is `MAX_UNLIMITED_ROWS = 100_000` (`:39`). So the ten-million-row
case is not reachable by default — but the `unlimited` flag is per-tab user state
(`use-query-execution.ts:137`), and an auto-executed statement would inherit whatever the tab
happens to be set to. **An auto-execute path must not inherit that flag**; it should force the
default limit regardless of tab state, and say so.

**A statement handed to the editor runs outside every budget the agent enforces.** This one is
categorical. `/api/db/query` calls `getOrCreateProvider` — the shared writable connection cache —
and then `provider.query` directly (`src/app/api/db/query/route.ts:33-44`). There is no read-only
execution profile, no policy evaluation, no audit event, no statement timeout anywhere on that path,
no statement count and no run deadline. `docs/AGENT_GUIDE.md` already says this in as many words:
"a statement you run yourself in the editor does not pass through it". The wiring is
`onApplyStatement` (`AgentRail.tsx:64`) → `tabMgr.updateCurrentTab({ query: sql })`
(`Studio.tsx:683`), which today only sets text.

### 2.2 The reframing that dissolves most of the risk

The owner's framing is that auto-execute is what *produces* the answer. It is not, and noticing that
changes the whole design.

**By the time a run can say "the answer is a chart of sales by region", it has already executed that
aggregate.** That is how the claim got its citation: `composeReportTool` refuses a claim whose
evidence does not resolve to something this run produced (`tools.ts:1488-1489`), so a run that
reports "sales by region" has an artifact holding exactly those rows, read under the read-only
profile, inside the 10 s timeout, capped at 200 rows and audited.

So there are two separate decisions, and conflating them is what makes the feature look risky:

**(a) Where the agent's own answer comes from.** From an artifact the run already read — always, in
both configurations of the checkbox. If the model wants a differently shaped final result, it drafts
one more `run_read_query`, which is an ordinary bounded read costing an ordinary statement. **No new
execution path is needed, and none is proposed.** Everything the answer needs already exists:
`hydrateAgentArtifact` turns a stored artifact into a `QueryResult` and picks a surface
(`src/components/agent/hydration.ts:49-72`), and the bottom panel already has a `charts` mode
rendering `<DataCharts result={…} />` (`BottomPanel.tsx:47,360`). Wiring the chart surface into that
`surface` union is B14, and it is most of the work.

**(b) What the checkbox adds.** After the run ends, the answer's statement is placed in the editor
*and executed there*, on the user's own connection, under the editor's own limits. This is the
unbounded path, and this is the only thing the checkbox controls.

With that split, the default (unticked) already gives the user a chart, from a result read under
every budget, with a ledger entry behind it. The checkbox buys one thing: a full-width result the
user can page, sort, export and edit — 500 rows instead of 200, and a live editor tab rather than a
read-only provenance badge. That is a real benefit, and it is worth exactly the risk described in
§2.1 and no more.

**Which path, and what the other choice costs.** The agent's own path for the answer; the editor for
the optional re-run. Running the answer *only* in the editor loses: the audit line, the policy
decision, the read-only profile, the ledger's `tool-completed` entry, the citation the report needs,
and the run's own budgets. `docs/AGENT.md` lists "it can only read … there is no second path" among
the three properties that frame the whole runtime; making the answer arrive through the editor would
create that second path for the one statement that matters most. That is a much larger change than
the checkbox looks.

### 2.3 The ledger invariant

The architecture's core claim is that everything a run did is in its ledger. Two things must be
recorded, and one of them is new.

**The execution is already covered.** The answer's read is an ordinary tool call, so it writes
`tool-invoked` before its effect and `tool-completed` after it (`run-service.ts:371-382`), with the
artifact reference carrying row count, column names and elapsed time (`types.ts:177-183`).

**The decision is not covered, and needs its own event.** "This artifact is the answer, and it should
be shown as a bar chart of `region` against `net_total`" is a fact about the run that nothing today
can express. Proposed, in the shape the existing narrative events use (`types.ts:325-383`):

```ts
| (AgentRunEventBase & {
    readonly kind: "answer-composed";
    /** The statement the answer rests on — what "Apply to editor" hands over. */
    readonly sql: string;
    /** The artifact this answer IS. Verified against this run's own ledger. */
    readonly artifact: AgentArtifactReference;
    /** How to render it. A chart spec is validated against the artifact's real columns. */
    readonly presentation:
      | { readonly kind: "table" }
      | { readonly kind: "chart"; readonly spec: AgentChartSpec };
    /** Whether the run also sent it to the editor to run, and under which gate. */
    readonly handover: "none" | "applied" | "auto-executed";
  })
```

Three notes on the shape:

- `artifact` is required, not optional. An answer that names no artifact is a claim, and claims
  belong in the report. This is also what makes the verdict rule in §4 producible.
- `handover` records the *outcome* of the checkbox, not the checkbox. A run whose gate refused
  auto-execution records `applied`, and a reader can see both that auto-execute was on and that the
  gate declined — which is exactly what someone debugging "why didn't it run" needs.
- The auto-execute **setting itself belongs on the run record**, decided at start like `mode` and
  `workflowType` (`types.ts:437-457`), for the same reason those are: a resumed drive must behave
  the same as the drive that died, and a later request must not be able to widen a run after it
  opens.

> **Built: and a run may write exactly one of these.** This section describes the event in the
> singular throughout and never says what a SECOND one would mean, which is how the first
> implementation came to allow it: `present_answer` is non-terminal — only `compose_report` ends a
> drive — so a model could present twice, and the second call succeeded exactly like the first. Two
> `answer-composed` entries are two statements the rail delivers to the editor and, on an auto-execute
> run, two it runs there with no timeout, under a checkbox that promised the final answer. The verdict
> in §4 is satisfied by one entry, so the second was never buying anything either.
>
> `presentAnswerTool` now refuses a second presentation with `ANSWER_ALREADY_RECORDED`, decided from
> the run's own events **before the arguments are parsed** — an argument refusal would invite the model
> to correct them and call again — and costing no repair attempt, because the tool reaches neither the
> repair ledger nor a database. The entry is durable, so a resumed drive is told the same thing rather
> than being allowed a second hand-over.

The editor re-run itself produces no ledger event and cannot, because it happens in the browser
against a route the agent does not own. `handover: "auto-executed"` is the run's record that it
*handed over*; what the editor then did is the editor's business and is visible in the editor. That
distinction should be stated in the timeline entry's own words rather than glossed.

### 2.4 The cost gate

> **Decision (owner, 2026-08-14): auto-execute ships in v1, and the plan gate is primary.** A
> statement is inspected with `EXPLAIN` before it is run; where the plan reads as risky the run does
> not execute it, states the warning, and offers "Apply to editor" alone. The analysis below argued
> for the ledger measurement over the estimate; that argument was heard and the estimate was chosen
> anyway, because the plan describes the statement the *editor* will run while the measurement
> describes a bounded execution. The settled rule uses both, and is stated in §2.4.0. Everything
> after it is the reasoning that produced it, kept because the gate's numbers are calibrations that
> will need revisiting.

#### 2.4.0 The settled rule

Three conditions, all of which must hold before a statement is run automatically. Any one failing
means warning plus "Apply to editor", never a silent skip.

1. **The run executed this exact statement itself.** A model may compose a final statement wider than
   anything it ran; that one is never auto-executed. This condition is close to free and it removes
   most of the risk class on its own, because the agent path *refuses rather than truncates*
   (`postgres.ts:917`, `sqlite.ts:421`): an artifact exists only for a statement that provably
   returned 200 rows or fewer inside the 10 s statement ceiling. Row explosion is therefore already
   excluded by the artifact's existence, not by any estimate.
2. **The plan gate the owner asked for**, read per engine, with unknown resolving to risky:
   - **PostgreSQL:** `access !== "full-scan"` and `estimatedCost` under the threshold.
   - **SQLite:** `EXPLAIN QUERY PLAN` yields no cost and no row estimate at all
     (`plan-summary.ts:139-147`) — the literal instruction cannot be followed here, and inventing a
     number would be worse than admitting it. What the plan does carry is the access path, so the
     gate reads that: every step a `SEARCH` passes; any `SCAN`, or an unreadable plan, is risky.
     Unknown must resolve to risky on this engine specifically, because SQLite does not preempt an
     overrunning read and blocks writers while it runs.
3. **The measured elapsed time** the run already recorded for that statement
   (`artifact.summary.elapsedMs`), under the threshold. Free, already on the ledger, and it costs no
   statement.

Using all three is strictly more conservative than any one of them, which is the right direction for
a control whose failure mode is a stalled production database. The cost is one statement out of the
run's budget for the `EXPLAIN`, which the per-workflow ceiling in §1.6 must account for.

> **Built: as stated, with the plan joined on the canonical statement rather than the exact one.**
> Condition 2 needs the plan the run holds *for this statement*, and the first implementation found it
> by comparing the two statements as strings. Those two statements are drafted **independently** —
> one as `run_read_query`'s argument, one as `inspect_plan`'s — so a model that formats its aggregate
> over four lines and then re-emits it on one has written the same statement twice and typed it
> differently. Exact equality missed those, and the gate resolved to `plan-risky`: fail-closed and
> therefore safe, but it made the shipped feature inert far more often than this section implies, and
> a user reads a working gate as a broken one.
>
> The join is on `fingerprintStatement` (`src/lib/agent/repair-ledger.ts`) — the repair ledger's own
> canonical form, reused rather than reinvented. Whitespace, comments, unquoted case and a trailing
> terminator normalise away; literals and quoted names keep their exact spelling, so a cheap plan of
> `WHERE id = 1` still cannot license the hand-over of `WHERE id = 2`. Condition 1 is unchanged and
> stays exact equality, correctly: both of its statements come from the same ledger, so there is no
> independent drafting to absorb.

> **Built: and one comment is not trivia.** "Comments normalise away" is right for the repair ledger
> and wrong for this join. Under `pg_hint_plan` a `+`-marked comment block is an optimizer DIRECTIVE
> — as are Oracle's `--+` line form and MySQL's executable comment — so a cheap indexed plan taken for
> the unhinted text licensed an answer statement whose hint forces a sequential scan. The two
> fingerprint alike, and condition 2 passed with a plan that is not the plan of the statement the
> editor will run, which is precisely the promise condition 2 makes.
>
> A statement carrying one now takes **no part in the join, on either side**
> (`hasOptimizerHint`, `src/lib/sql/optimizer-hints.ts`, which reads spans so a marker inside a
> literal is not one). It fails closed rather than joining on the hint text: joining would assert
> that the plan the run holds IS the hinted plan, and `inspect_plan` obtains it by sending the
> statement under an `EXPLAIN` prefix — whether `pg_hint_plan` still reads a hint from behind one is
> a property of an extension this repository does not ship, does not test against and cannot verify,
> and a gate whose failure mode is a stalled production database does not rest on that. A hinted
> answer is placed in the editor unrun with the gate's own warning, like every other statement the
> gate cannot weigh.
>
> **`fingerprintStatement` itself is unchanged, and that is the decision rather than an omission.**
> It is the repair ledger's canonical identity, consulted before every statement, and there a comment
> being trivia is a bound: a model re-sending a statement the ledger already refused, with a comment
> added, would otherwise fingerprint differently and be admitted again. Widening "the same statement"
> for repair accounting to fix a plan join would trade a bound for a bound. The distinction matters
> only at the join, so it lives at the join.

> **Built: and a plan the server could only PARTLY read is risky too.** This section's SQLite rule is
> `access === "index"`, and `access` is a reading of the steps the summary RECOGNISED —
> `summariseSqlite` matches `SEARCH` and `SCAN` and used to drop every other row on the floor. So a
> plan of `SEARCH t USING INDEX ix` beside `USE TEMP B-TREE FOR ORDER BY` reported a flat `index`,
> and the gate handed the statement to the editor to run with no timeout on the strength of a reading
> that had skipped a step. "Unknown resolves to risky" held only when NO step had been recognised,
> which is the narrower promise.
>
> The summary now carries `uninterpretedStep` beside `access` and the gate refuses on it before either
> engine's rule. It rides beside `access` rather than collapsing it to `unknown` because what the
> recognised steps said is still true, and `compare_plans` is described exactly as it was before.
> PostgreSQL sets no such flag: its plans are mostly nodes this reading does not tally, none of them a
> relation access, and the engine both reports a whole-plan `Total Cost` the gate already weighs and
> preempts a statement that overruns — the asymmetry §2.4.1 spends its length on, applied one level
> down.

#### 2.4.1 Why the analysis preferred the measurement

The question asked whether to gate on `inspect_plan`'s engine estimate. My answer is that the
estimate is the wrong instrument, and a better one is already on the ledger.

**Why the estimate loses.** `summarisePlan` reads `Plan Rows` and `Total Cost` from PostgreSQL's
JSON plan (`plan-summary.ts:107-108`) and **nothing at all from SQLite** — `EXPLAIN QUERY PLAN`
carries no cost and no row estimate, so the summary deliberately reports neither
(`plan-summary.ts:17-19,139-147`). Combine that with §2.1 and the asymmetry is exact:

> The engine where a cost gate is *least* needed — PostgreSQL, which preempts an overrunning
> statement — is the only engine that provides a number. The engine where it is *most* needed —
> SQLite, which does not preempt, and where a runaway read stalls the studio process — provides
> none.

On top of that, PostgreSQL's `Total Cost` is a planner cost in arbitrary units calibrated by
`seq_page_cost` / `random_page_cost` and by how recently `ANALYZE` ran. It is not a time, does not
convert to one, and is wrong in both directions on correlated predicates and stale statistics. And
obtaining it costs a statement out of the run's budget.

**What to gate on instead.** The run has already executed the answer's statement on its own bounded
path, and the ledger records what that cost: `artifact.summary.elapsedMs` and `rowCount`
(`types.ts:164-168`, filled at `tools.ts:911-916`). A measurement of *this statement* against *this
database* is strictly better evidence than an estimate of it, on both engines, and it is free.

The rule:

> **Auto-execute in the editor only a statement whose identical text already completed on the
> agent's bounded path in this run, and only when that execution reported `elapsedMs ≤ 2000`.**
> Otherwise, apply it to the editor without running it, and say why.

The threshold, defended: the agent's own statement ceiling is 10 s (`execution-policy.ts:53`). A
statement that took 8 s at 200 rows will take longer at 500, so a 2 s reading leaves roughly a 5×
margin inside a ceiling the editor does not have. It is a calibration, not a measurement — the
honest thing is to measure it against both reference engines before shipping, and until then to be
conservative.

Two honest caveats on the measurement itself, because they are real: the two executions are not
identical — the second one has a different row limit, a warm plan cache and warm buffers, and the
database may have acquired load in between — and on SQLite the first execution's elapsed time is a
post-hoc reading rather than a bounded one. So this is a strong signal, not a guarantee. It is still
a much better one than the estimate.

**The fallback, for the one case the measurement cannot cover.** A model may compose a final
statement wider than any it executed. Then, and only then:

- **PostgreSQL:** call `inspect_plan` (one statement), and auto-execute only when the summary reports
  `access !== "full-scan"` **and** `estimatedCost ≤ 50_000`. The number corresponds, at default
  `seq_page_cost = 1.0`, to roughly 50 000 pages ≈ 400 MB of sequential reading — seconds, not
  minutes. Also a calibration, also worth measuring.
- **SQLite:** auto-execute only when `access === "index"` — every step a `SEARCH`, no `SCAN`
  anywhere (`plan-summary.ts:136-146`). A `full-scan` or `unknown` plan is applied to the editor and
  not run, because there is no number to weigh and no preemption to fall back on.

**Where the gate declines, it must say so in the run's own words**, not silently do less than the
checkbox promised. Suggested timeline detail, in the register the app already uses:
*"Not run for you: the engine reported a full table read and gave no estimate, so this one is
yours to run."*

### 2.5 Row and time caps, and why no `LIMIT` is injected

The agent's own execution is already capped at 200 rows, 256 KiB and 10 s
(`execution-policy.ts:52-55`). The editor re-run should be forced to the editor's default 500-row
limit and must **not** inherit a tab's `unlimited` flag (§2.1). Beyond that, nothing new is needed.

> **Built: something else WAS needed, and it is the boundary rather than the caps.** This section
> treats the re-run as an ordinary editor execution with a forced row limit, and §2.6 then tells the
> user "writes and DDL are refused either way". Those two sentences cannot both be true of the
> implementation they describe. The editor's execution goes to `POST /api/db/query`, a plain
> read-WRITE session whose only protection is `isDangerousQuery` — a check on the statement's TEXT —
> while the agent's own read is enforced by the ENGINE (`BEGIN READ ONLY` at `postgres.ts:889`,
> `PRAGMA query_only` at `sqlite.ts:410`). Text is not where the difference lives: a `SELECT` may
> invoke a VOLATILE function that performs an `INSERT`, which the read-only transaction refuses
> (SQLSTATE 25006) and the read-write session performs. The same statement was therefore harmless
> where the run proved it and harmful where it was replayed — and this repository already treats
> database content as able to influence the model, so "the model would not write one" is not an
> argument available here.
>
> What shipped is a **third execution profile and a route of its own**:
>
> - `AGENT_HANDOVER_PROFILE` (`agent-handover`) in `factory.ts`'s `PROFILE_ACQUISITION` — the same
>   `readOnly: true` open, the same `agentUser` credential, the same profiled cache and the same
>   demand for a database-native read-only statement path as `agent-read-only`. The agent's own
>   profile is untouched: it keeps its 10 s timeout and 200-row cap, because what a MODEL may spend
>   and what a USER's replay may spend are different questions.
> - `AGENT_HANDOVER_BUDGET` — `DEFAULT_QUERY_LIMIT` rows, 64 MiB, and a statement timeout of
>   2 147 483 647 ms. "No timeout" has no representation the plumbing can carry: `assertReadOnlyBudget`
>   requires a positive integer because PostgreSQL interpolates the value into
>   `SET LOCAL statement_timeout = N`, which takes no bind parameter, so admitting `undefined` would
>   weaken a real guard to express a cosmetic one. The figure is PostgreSQL's own 32-bit ceiling for
>   the setting — a little over 24 days — so the promise holds in practice; the word that does not
>   hold is "no", and it is stated rather than implied. The byte cap is far above what 500 rows of a
>   rendered result weigh, because the editor route imposes none and a replay refusing where the
>   editor succeeds would be a bound the checkbox never mentioned.
> - `POST /api/agent/runs/{runId}/handover`, which **carries no SQL**. The statement is read from the
>   run's own `answer-composed` event and the connection from its persisted `connectionId`, resolved
>   under the run's persisted actor. So nothing a user types reaches this profile and the route is
>   not a general "run this without a timeout" endpoint; it also honours the gate rather than
>   re-deciding it (only `auto-executed` is replayed, `applied` and `none` are `409`).
>
> This section's own rule survives intact and is now enforced server-side: the row bound is the
> server's rather than a request option, so a tab widened to `unlimited` cannot reach it at all, and
> the bound **refuses** rather than truncating — which is the same argument the next paragraph makes
> about injecting a `LIMIT`, applied to the replay.

**No injected `LIMIT`, and the reasoning is about truth rather than cost.** The agent path already
refuses rather than truncates, and `execution-policy.ts:26-31` states why: "the caps refuse rather
than truncate … which is what lets a caller trust that a delivered result is complete." An injected
`LIMIT` breaks exactly that, and it breaks it invisibly:

- A bar chart of 200 of 4 000 regions looks like a complete bar chart. Nothing on the axis says
  otherwise. The user reads a ranking that is not a ranking.
- A `LIMIT` on an aggregate does not change any group's value, so no number is wrong — which is
  worse, because the error is undetectable by looking at the numbers.
- The current behaviour is correct and already handles the case: an aggregate with more than 200
  groups is refused, the model is told, and it narrows the question. A model-written
  `ORDER BY … LIMIT 10` is honest because the model can then *say* "the top ten regions" in its
  claim; a server-injected one is not, because nobody says anything.

### 2.6 What the checkbox must say

"Auto-mode" transfers no responsibility because it names no bound. Neither does "run-execute after
finish". Proposed copy, in the rail's own register:

> [ ] **Also run the final answer in my editor**
>
> The run always produces its answer on its own read-only path, bounded to 200 rows and 10 seconds.
> Tick this and it will also put that statement in your editor and run it there — on your
> connection, at the editor's 500-row limit and with **no time limit**. Statements whose plan reads
> as expensive, or which the run measured as slow, are put in the editor without being run. Writes
> and DDL are refused either way.

If the connection is SQLite, one more line below it, reusing the vocabulary the budget meter already
uses (`AgentRail.tsx:670-677`):

> On SQLite a read is not interrupted when it runs long — it blocks other writers and this
> application until it finishes.

Three properties of that copy are deliberate: it names the bound that is being given up (the time
limit), it names the bound that remains (500 rows), and it says what the run does *instead* when it
declines — so a user who sees the statement sitting unrun in their editor knows that was the
feature working.

> **Built: the copy as proposed, and a scope this section never stated.** The checkbox is offered on
> **`data-analysis` in agent mode only.** This section wrote the control's words without saying which
> runs it belongs to, and the first implementation rendered it for all five workflows in both modes —
> which is what that omission produces. Ticking it on an Investigate run promised a user the final
> statement would be placed and run in their editor, a hand-over that workflow has no tool to
> perform, while the system prompt told the model to call `inspect_plan` "on the statement that IS the
> answer before you present it", a presentation it had no tool to make.
>
> That is §4.3's own check applied to the control rather than to the verdict: auto-execute hands over
> `present_answer`'s answer, so it means something exactly where `present_answer` is offered. One
> record, `AGENT_WORKFLOW_PRESENTS_ANSWER` (`src/lib/agent/types.ts`), is read by all four layers that
> have an opinion — the rail's rendering, the route's validation, `investigation.ts`'s decision to
> state `AUTO_EXECUTE_RULE`, and the tool set — and `tools.test.ts` asserts over every workflow that
> the tool and the flag agree. `POST /api/agent/runs` **refuses** `autoExecute: true` elsewhere rather
> than normalising it to `false`, because a silent downgrade is how a user comes to believe a feature
> ran.
>
> **And a third condition this section could not have stated: the HOST has to be able to run one.**
> `onRunStatement` is an optional prop of `AgentRail`, so an embedding host may have no runner at all.
> The rail offered the checkbox regardless and fell back to `onApplyStatement`, so the statement was
> placed unrun while the timeline entry told the user it had run on their connection — the same silent
> downgrade one paragraph up, this time on the surface rather than at the route. The checkbox, the
> start request and the delivery effect now read one value, and an `auto-executed` entry goes to the
> runner or nowhere. The statement is never lost: every answer entry still offers it through
> `applySql`, as the user's own action.
>
> **And a fourth: it must be the same connection.** "On your connection" (§2.1, §2.6) reads as one
> connection because this document never contemplated the user changing it mid-run. They can. The host
> resolves every execution from its ACTIVE connection (`use-query-execution.ts`), while the run read
> its rows from the connection it was opened on and persisted; a user who switches databases while a
> run is going would have had the approved statement run — with no timeout, against an engine whose
> plan for it was never inspected and whose elapsed time was never measured — on a database this run
> never saw, and would have been shown that database's rows as the answer. `AgentRail` now remembers
> the connection it opened the run on and **declines** the hand-over when the two no longer match. It
> declines rather than redirecting: nothing on this surface can reach the run's own connection, and
> executing a statement against a database the user is not looking at is the defect, not the remedy.
> The refusal is said beside the entry that claims the execution, because that entry is folded from
> the ledger and still says the statement ran — the one place this surface contradicts the run, and it
> does so where the sentence a reader would otherwise believe is written. It is scoped to the
> hand-over that RUNS; an `applied` entry claims no execution, so a connection change does not change
> what it means. The check lives in the rail rather than in `Studio.tsx`'s callback because the
> callback is an optional public prop: a guard written in one host is a guard the next host does not
> inherit.
>
> **The reason narrowed once the replay moved onto its own route** (see §2.5's note). The statement
> can no longer reach the wrong database at all — the route resolves the run's own persisted
> connection server-side, so "it would have read a database this run never saw" stopped being true.
> What remains is about what the user is SHOWN: the result lands in the editor tab, the tab belongs
> to whatever connection the user is on now, and delivering another database's rows into it would
> present them as this connection's answer. The rail still declines, and the notice beside the entry
> now says that instead.

> **Built: and the copy's last sentence had to earn itself.** The proposed wording ends "Writes and
> DDL are refused either way", which was the strongest claim on the control and the one that was not
> true: the replay ran in the editor's read-write session, where a `SELECT` calling a VOLATILE
> function that writes succeeds. The shipped sentence says what refuses them and where — *"It is the
> same database-enforced read-only session either way, so writes and DDL are refused by the engine
> rather than by reading the statement"* — because the difference between those two mechanisms is
> exactly the difference the old wording papered over. The connection clause moved with it: *"on the
> connection the run was opened on"* rather than *"on your connection"*, since the server now
> resolves it from the run's own record. Both figures are still interpolated from the constants the
> enforcement reads, `AGENT_HANDOVER_BUDGET` now standing in for `DEFAULT_QUERY_LIMIT`.

---

## 3. Charts

### 3.1 What already exists

`DataCharts` (`src/components/DataCharts.tsx:329`) takes exactly one prop:

```ts
interface DataChartsProps { result: QueryResult | null }        // DataCharts.tsx:90-92
```

`QueryResult` is `{ rows, fields, rowCount, executionTime }` (`src/lib/types.ts:147-150`) — which is
precisely what an agent artifact holds and what `hydrateAgentArtifact` already produces
(`hydration.ts:36`). The component supports eight chart types
(`"bar" | "line" | "pie" | "area" | "scatter" | "histogram" | "stacked-bar" | "stacked-area"`,
`DataCharts.tsx:67`) over Recharts, and it infers everything itself: a column is numeric when more
than 80 % of its non-null values parse as numbers (`:103`), dates are matched by regex (`:106-113`),
and the suggested type and default axes are derived from those counts (`:129-199`, `:379-386`).

Four of its behaviours matter to this design:

- it refuses below two rows (*"Need at least 2 rows for visualization"*, `:142-152`);
- it refuses with no numeric field (`:166-176`);
- a pie chart silently truncates to the top ten with a footer note (`:951,960,983`);
- non-numeric values become zero: `Number(row[field]) || 0` (`:415`). **A chart drawn over the wrong
  column does not fail — it draws a flat line of zeros.**

That last one is the whole argument for validating a spec instead of trusting one.

### 3.2 The spec the model emits

A specification, never a picture. Proposed shape:

```ts
interface AgentChartSpec {
  readonly type: "bar" | "line" | "area" | "pie" | "scatter" | "stacked-bar";
  /** One column of the artifact, by the name the result actually carries. */
  readonly x: string;
  /** One or more columns of the artifact. Must be numeric in the delivered rows. */
  readonly y: readonly [string, ...string[]];
  /** Optional series split — one column, for the stacked and multi-line shapes. */
  readonly series?: string;
  /** The model's own words about what the chart shows. Rendered quoted, as model prose. */
  readonly caption: string;
}
```

> **Built: without `series`.** The shipped `AgentChartSpec` (`src/lib/types.ts`) is the shape above
> minus that field. The proposal did not check it against the renderer, and the renderer has no
> series split — in `DataCharts`, several series *are* several `y` columns. Implemented as proposed,
> the field was invited by `AGENT_ANSWER_CONTRACT`, accepted by `chartSpecSchema`, checked against the
> artifact's columns by `refuseChartSpec`, written to the durable ledger and narrated by the rail —
> and then dropped by `specApplies`, which returned false for any spec carrying it, so the inference
> drew a different chart. The picture on screen was not the picture the ledger recorded and nothing
> said so.
>
> It was removed from all four layers rather than implemented in the renderer, and the contract now
> redirects a model that wants several series to name several `y` columns. The rule that decides this
> is the same one §4.3 applies to the verdict, one level down: **invite only what the layer below can
> honour.** A field the contract offers and the renderer discards is the #356 shape in a spec instead
> of in a rule.

Decisions inside that shape:

- **The chart type is chosen by the model, not inferred.** `DataCharts.analyzeData` infers a type
  from the data's shape (`:180-190`), which is the right default for a user who ran a query, and the
  wrong one here: the model knows what was *asked*. "Compare complaints between two months" is a
  grouped bar chart even when the data shape suggests a line. The inference stays as the fallback
  for a spec that fails validation.
- **`histogram` is excluded.** It is a client-side binning of raw values (`:237-258`) rather than a
  rendering of what the SQL returned, so the picture would show something the ledger's artifact does
  not contain. If a histogram is wanted, the SQL should do the bucketing — and then it is a bar
  chart of an aggregate the run can cite.
- **No aggregation field.** `DataCharts` can aggregate (`aggregateData`, `:261-305`), and this spec
  deliberately does not use it. Aggregation belongs in the SQL, where it is on the ledger, cited,
  and checkable. A chart-level `sum` would be a second aggregation nobody recorded and nothing can
  verify.
- **No colours, no titles, no sizes.** Presentation belongs to the app. `caption` is the model's
  prose and is rendered as model prose — quoted, in the field the rail reserves for text that did
  not come from the application (`timeline.ts:25-36`).

### 3.3 Validation: the `verifiedAgainst` posture, applied to columns

`verifiedAgainst` refuses a citation naming an artifact this run never produced
(`tools.ts:1447-1458`). The same posture, one level down: **a chart spec is refused unless every
column it names is a column the artifact actually has.** Checked at record time, against the artifact
the answer names, before anything is written to the ledger.

> **Built: and the ARTIFACT is checked before its columns are.** This section borrows
> `verifiedAgainst`'s posture and, with it, `verifiedAgainst`'s question — "did this run produce
> that?" — which is right for a citation and too wide for an answer. An `inspect_plan` step settles
> like any other and carries a drafted statement, so a run could nominate the engine's *description*
> of a statement as the answer: nothing executed, no data read, `QUERY PLAN` text for rows, and
> `agent-data-analysis.1` satisfied by a run that never read the data it was opened to analyse. Only a
> `sql.query.read` result may be presented now, refused as `ANSWER_NOT_A_DATA_READ`.
>
> The citation path is deliberately NOT narrowed: a claim resting on a plan the run read is an honest
> claim, and `recommend_change` is built on exactly that. A profile is excluded from the answer path
> and that is a decision rather than a side effect — it is a real reading of data, but it returns
> counts the server composed about a table rather than rows the model asked for, its statement is the
> server's so there is nothing of the model's to hand to an editor, and its single aggregate row fails
> `CHART_TOO_FEW_ROWS` on every chart; admitting it would only change which refusal it gets. The check
> runs BEFORE the statement is resolved, because a plan step does carry one. The model is told in
> `WORKFLOW_TOOL_RULES["data-analysis"]` and in the tool description, not only by the refusal (#350).
>
> One consequence, recorded: §2.4.0's condition 1 can no longer FAIL from this layer, because the only
> presentable artifact is a read whose own statement is by construction among the statements the run
> executed — presenting a plan was the one way to reach it. It stays enforced in `auto-execute.ts`,
> which is pure and enumerated over every combination in its own suite: a gate guarding an unbounded
> execution path must not depend on which artifacts another layer admits.

Four checks, each with its own refusal so the model is told which one it failed:

| Check | Against | Refusal code |
| --- | --- | --- |
| `x` and every `y` appear in the result's columns (**built:** `series` is gone, per §3.2) | `artifact.summary.columnNames` (`types.ts:166`) | `CHART_COLUMN_NOT_IN_RESULT` |
| Every `y` is numeric in the delivered rows | the stored rows, using the same >80 % rule `DataCharts.tsx:103` uses | `CHART_COLUMN_NOT_NUMERIC` |
| The result has at least two rows | `artifact.summary.rowCount` | `CHART_TOO_FEW_ROWS` |
| Shape rule per type — `pie` takes exactly one `y`; `scatter` needs `x` numeric too | the spec and the rows | `CHART_SHAPE_MISMATCH` |

Two implementation notes that are easy to get wrong:

- **The numeric check needs the rows, so it must run while the run is live.** The artifact store is
  process memory released when the run ends (`artifacts.ts:112-123`), which is exactly when
  `answer-composed` is written — during the run, so the rows are there. This is fine, and it is
  worth pinning with a test, because B15 means it stops being true one instant later.
- **`summary.columnNames` is engine-supplied text and is not fenced.** `tools.ts:904-906` says so
  explicitly: "anything that later puts an artifact summary INTO a prompt owes it the same fence the
  rows get." The refusal message for `CHART_COLUMN_NOT_IN_RESULT` should list the real column names
  so the model can correct itself — and therefore must fence them.

**A chart that renders blank is worse than a refusal**, and `Number(x) || 0` is the reason: it does
not render blank, it renders a confident flat zero. A refused spec costs one turn and produces a
correct chart; an unvalidated one produces a wrong picture with the application's own frame around
it.

### 3.4 When the result is not chartable

Then the answer is a **table**, and that is a first-class outcome, not a fallback. The `presentation`
union has two arms for exactly this (§2.3). The cases:

- a single scalar (`SELECT sum(net_total) …` → one row, one column) — the finding is a sentence, and
  the sentence is a report claim citing the artifact;
- no numeric column at all — a list of names is a table;
- one row — `DataCharts` refuses below two anyway (`:142-152`), so recording a chart spec would
  record a chart that renders an empty state.

The model must be told this, in `WORKFLOW_TOOL_RULES`, in the same sentence that offers the chart:
present a table when the result is one row, has no numeric column, or is a single number, and say
the finding in the claim instead. This is the #350 half of the design — see §4.3.

**And a chart is never a substitute for a claim.** The report still has to compose claims citing the
artifact (`goal-verifier.ts:188-192` is unchanged). The chart is a *presentation of* an artifact; the
artifact is the evidence; the claim is the answer. A run that draws a chart and reports nothing has
drawn a picture, not answered a question.

---

## 4. What "answered" means for an analytical run

### 4.1 The constraint this whole section turns on

**A verifier rule must be producible by the tools the workflow actually offers, and the model must
be told the rule in its prompt.** Both halves have failed in this repository, in production, within
the last week, and each failure has a name.

**#356 is the first half.** `verifyQueryOptimizationGoal` required a `plan-comparison` event. A
`compare_plans` call needs a before *and* an after plan, and an index's "after" plan requires the
index to exist — which a read-only run cannot make. So a live run on 2026-08-12 diagnosed the scan,
recommended the right index, was correctly refused when it tried to create it, and was then told by
the verifier that it had not answered. The rule was never wrong about what it wanted; it was
**stated in terms of the one artifact only one of the two valid answers can produce**
(`goal-verifier.ts:226-237`). The fix added a second arm and a second shortfall,
`no-plan-evidence`, and bumped the id to `agent-query-optimization.2` — while keeping
`agent-query-optimization.1` in the union, because recorded verdicts outlive the rule that produced
them (`goal-verifier.ts:52-59`).

**#350 is the second half.** The evidence contract was a two-arm discriminated union that the model
was never shown. Two live runs found the right answer on their first query and spent five of seven
turns guessing at the shape of a citation object — one of them sending a `SELECT 1` to the database
purely to keep thinking — while holding the correlation id they needed
(`investigation.ts:164-171`, `tools.ts:294-298`). A rule the model is not told is a rule live runs
fail. The fix was instructional, not mechanical.

### 4.2 The proposed rule

Workflow id `data-analysis`; verifier id **`agent-data-analysis.1`**; new shortfall **`no-answer`**.

> **An analytical run answered when it met the investigation baseline — claims that rest on something
> it read, not all of them empty — and its ledger carries at least one `answer-composed` event.**

Composed, not replacing, exactly as the other two templates compose
(`goal-verifier.ts:239-241,265-269`): the baseline is checked first and its shortfall dominates, so a
run that never reported is told *that* rather than told it skipped an answer. Naming the smaller of
two problems is the mistake that composition avoids.

In the file's own shape:

```ts
function verifyDataAnalysisGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const baseline = verifyInvestigationGoal(run);
  if (baseline.length > 0) return baseline;
  return run.events.some((event) => event.kind === "answer-composed") ? [] : ["no-answer"];
}
```

and the registry entry beside the other three, in `AGENT_WORKFLOW_GOALS` (`goal-verifier.ts:281`),
where the rule and the id are one value so they cannot drift.

The user-facing sentence, in the vocabulary `SHORTFALL_SENTENCES` uses
(`timeline.ts:335-343`, quoted in `docs/AGENT_GUIDE.md`):

> `no-answer` — "The run reported what it found but never produced an answer to show, so there is
> nothing to put in front of you."

> **Built: with a third arm, because the two above are not connected.** The rule as proposed asks for
> a cited report and for a presented result and says nothing about their being the same result. So a
> run could chart artifact A while every claim cited artifact B and score `answered` — unrelated prose
> beside a picture, and no field on this ledger could tell it from a good run, which is the exact
> defect class §4 exists for. The shipped rule adds: **at least one claim must cite the artifact the
> run presented**, with the shortfall `answer-uncited`.
>
> Checked against §4.1's two halves before it was written, as this section requires of any rule.
> **Producible (#356):** the model holds the answer's correlation id at the moment it needs it — it
> passed that id to `present_answer` one turn earlier and the tool names it back in its reply — and the
> artifact is a `tool-completed` result of this run, so `composeReportTool` accepts a citation of it.
> The tool order the workflow's own rules ask for (read → present → report) is the order that makes it
> satisfiable, and no valid answer is excluded: a chart, a table, one row, one number, a two-window
> comparison and either setting of the checkbox all present an artifact a claim can cite. **Told
> (#350):** stated in `WORKFLOW_TOOL_RULES["data-analysis"]`, in `present_answer`'s description, and
> again in what that tool says back when it records the answer — which is where the id itself can be
> named rather than described. It asks for ONE claim, not for every claim: a report says more than the
> picture shows and should.
>
> **The id stayed `agent-data-analysis.1`.** A rule change normally mints a new id, because a verdict
> outlives the rule that produced it and a reader of an old ledger holds this type — which is why
> `agent-query-optimization.1` is still in the union. That is a fact about a released id, and `.1` here
> had never left the branch that introduced it: no release carried it and no fixture recorded a verdict
> under it, so there was no reader to protect and `.2` would have added a dead id standing for a rule
> nothing was ever judged by. Once this reaches `main` the rule is frozen and the next change is `.2`.

### 4.3 Checked against #356: is the rule producible?

The question is whether every *valid* answer this workflow can give produces an `answer-composed`
event. Working through them:

| A valid answer | Produces the event? |
| --- | --- |
| A chart of an aggregate | Yes — `presentation: {kind: "chart"}` |
| A table, because the result is one row or has no numeric column | Yes — `presentation: {kind: "table"}` (§3.4) |
| A single number ("sales are down 12 %") | Yes — a one-row artifact, presented as a table |
| A comparison of two windows | Yes — the answer is the artifact holding both windows |
| Auto-execute ticked | Yes — `handover: "auto-executed"` |
| **Auto-execute unticked** | **Yes** — `handover: "none"` or `"applied"` |

That last row is the one I nearly got wrong, and it is worth recording because it is #356's exact
shape. An earlier draft of this design had auto-execute be *what produced* the answer's artifact.
Under that design, a run with the checkbox unticked would have had no artifact to present, no
`answer-composed` event, and would have been scored `unanswered` for doing precisely what the user
configured it to do — **a rule stated in terms of an artifact that only one of two valid
configurations can produce.** The reframing in §2.2 (the run has already run the query; the checkbox
only adds the editor re-run) is what removes it. The check is the reason the design changed, which
is the point of running the check.

**The residual, stated rather than hidden.** A run that answers purely from the schema snapshot —
"which table holds sales?" — cites the snapshot, passes the baseline, and has no artifact to present.
It would be scored `unanswered`. I consider that correct and deliberate: this workflow's stated
objective is a question about the *data*, and an analysis that never read any data is not an
analysis. But it is a judgement, not a proof, and it belongs in the rule's own docstring the way
`empty-evidence`'s mechanical limit is stated at `goal-verifier.ts:34-38`. If it turns out that live
users routinely ask schema questions of this workflow, the answer is to route them to
`investigation`, not to widen this rule — every widening of what counts as evidence is a step back
toward the escape hatch, which is what `docs/AGENT.md` says about the eval harness's own bars.

### 4.4 Checked against #350: is the model told?

Not by default, and this is where the rule would fail live. `WORKFLOW_TOOL_RULES`
(`investigation.ts:219-233`) is where each workflow tells the model how to pursue its objective with
the tools, and it is the file's own record of the #356 fix having a model-facing half:

> "It also says what to do about an index INSTEAD of comparing plans, and that sentence is the
> model's half of #356. … a rule the model is not told about is a rule live runs fail, which is
> exactly how the evidence contract failed in #350." — `investigation.ts:200-204`

So the entry must say, in the model's terms, what the verdict will check. Proposed:

```
"data-analysis": [
  "Answer with data you have read, not with the schema: your claims must cite results.",
  "When you have the answer, call present_answer with the artifact id of the read that IS the answer.",
  "Choose table or chart. A chart names columns of THAT result: they are checked against the result's real column names and refused if they do not match.",
  "Present a table when the result is a single number, has one row, or has no numeric column — that is a complete answer, not a lesser one.",
  "Then call compose_report. The chart shows the result; the claims are what say what it means.",
].join(" ")
```

And the paired objective, in `WORKFLOW_OBJECTIVES` (`investigation.ts:207`, said in **both** modes
because a plan for an analysis is still about one):

```
"data-analysis":
  "Your objective is a question about the data in this database. Establish the answer from the data and produce something to show for it."
```

Two further places the rule has to be said, following the pattern #352 established — the model is
told at the moment it needs to know, not only once at the start:

- **the tool description** for `present_answer`, carrying the chart-spec contract the way
  `AGENT_EVIDENCE_CONTRACT` carries the citation contract (`tools.ts:312-316`), rendered from the
  same code that parses it so the example and the parser cannot disagree (`tools.ts:294-303`);
- **the refusals**, because a description is read by a model that is not yet confused and a refusal
  is read by one that demonstrably is (`tools.ts:598-603`). Each of the four chart refusals in §3.3
  should restate the relevant half of the contract, and `CHART_COLUMN_NOT_IN_RESULT` should list the
  actual column names, fenced.

**The eval that has to exist before this ships.** The repository's own rule is that a requirement
about model behaviour is enforced only by something that exercises model behaviour
(`docs/AGENT.md`, "The eval harness"), and that a harness that cannot fail on a known defect is not
measuring anything. So the `data-analysis` case needs at least: a run that composes a chart naming a
column the result does not have (must be refused, and must recover); a run whose result is one row
(must present a table and be scored `answered`); and a run with auto-execute unticked (must still be
scored `answered`) — that last one being the direct regression test for §4.3.

> **Built: `tests/evals/data-analysis.test.ts`**, one `describe` block per prerequisite above, plus
> two additions the writing of them suggested. The chart-refusal block asserts not only that the
> refusal is produced but that it **carries the result's real column names**, which is the half that
> makes it recoverable rather than merely correct; the one-row block asserts that a *chart* of that
> row is actively refused, so a run reaching for one is told why and has somewhere to go; and the
> auto-execute block drives the same arc twice, differing **only** in the setting, because one run
> scoring `answered` proves little where two identical runs reaching the same verdict prove the
> verdict does not read it. `EvalRunOptions.autoExecute` was added to the harness for that pair.
>
> One thing those six cases cannot establish, because they drive a scripted model: whether a **live**
> model can act on the refusal. A model that cannot re-sends a spec, is refused again, and spends the
> workflow's 60 turns on it. That belongs in `tests/evals/real-model.ts`, which is deliberately not a
> test file because its verdict is not a function of the code under review, and a `charted-answer`
> case was added there with a `chartRefusalShortfall` judge: more than two chart refusals in one run
> is recorded as `chart-refusal-loop`, and a run that was never refused and presented a table anyway
> for an objective that asked for a chart is recorded as `chart-asked-table-given`. **It has not been
> run against a live model in this change.**

---

## 5. Semantic grounding

### 5.1 What the run has today

- **The schema snapshot.** Table names, column names and types, nullability, primary keys, foreign
  keys, index names and their columns (`context-snapshot.ts:206-217`). Packed for the task: tables
  ranked by relevance, 12 columns and 4 indexes each, the whole fenced block bounded at 6 000
  characters, with what did not fit *named* as omitted rather than silently dropped
  (`packContextForTask`, `:463-505`).
- **The relations block.** The foreign keys as a quoted, escaped relation list, bounded at 2 000
  characters (`er-diagram.ts`), at a detail level chosen per workflow (`erDetailForWorkflow`).
- **`inspect_schema`**, to read any of it directly, narrowed.
- **`run_read_query`**, which can read up to 200 actual rows at a time.
- **`profile_table`** — but only in `database-assessment` (`tools.ts:438-441`), and it returns
  **counts only**, never a value (`tools.ts:377-383`).

### 5.2 What it lacks, specifically

Take "why are our sales down this month?" against an ordinary commerce schema.

1. **Which table is "sales".** Relevance is substring matching of the objective's words against table
   and column names (`relevance`, `context-snapshot.ts:405-414`): a name match scores 3, a column
   match scores 1. The word "sales" therefore finds a table named `sales` and finds *nothing* in a
   schema whose fact table is `orders`, `invoices`, `transactions`, or `fct_revenue`. On a
   warehouse-style schema with `dim_` / `fct_` prefixes the ranking is effectively random, and the
   6 000-character bound then decides which tables the model sees at all. This is the single largest
   gap, and it is a gap in the *packing*, not in the model.
2. **Which column is the business event time.** `created_at`, `updated_at`, `placed_at`,
   `shipped_at` are all `timestamp NOT NULL`. The schema cannot distinguish an audit column from the
   column "this month" means. Choosing wrong produces a confident, cited, wrong answer.
3. **What "sales" is numerically.** `amount`, `total`, `net_total`, `gross_total`, `amount_cents` —
   all numeric. Which is revenue, whether it is net of tax, and whether it is in minor units are all
   unstated. `amount_cents` misread as currency is a 100× error that nothing catches.
4. **Enum semantics.** `status varchar` says nothing about whether `'C'` means cancelled or
   completed — a difference that inverts the answer. The run *can* find out with one
   `SELECT DISTINCT status` and probably should, but nothing tells it to, and distinct values are
   values, which is the one thing `profile_table` was built not to return.
5. **Scale.** The snapshot carries no row counts, so the model cannot tell a 12-row lookup table from
   a 400 M-row fact table. That matters for choosing the fact table *and* for choosing a statement
   that finishes.

### 5.3 The honest assessment

**The schema alone is enough for the owner's first two questions and not for the third.** "Chart
today's sales by region" and "compare complaints between two months" are retrievals: on a schema with
ordinary English names, term matching finds the table, one `SELECT DISTINCT` resolves a status
column, and the model's SQL is checkable by the user reading it in the timeline. "Why are sales
down" is a causal question — it requires choosing which decomposition of a metric is the *business*
one, and there is no fact in the schema that decides that. A run will produce a plausible answer, and
its plausibility is the problem: every claim will be correctly cited to a real artifact, and the
decomposition it rests on will be a guess nobody was told about.

So: **ship the first version on the schema, and be precise in the rail about which kind of question
it is good at.** Then two additions, in this order.

### 5.4 First addition, and it needs no user input: give the run row counts

Offer `profile_table` at `basic` depth to `data-analysis` (`WORKFLOW_TOOLS`, `tools.ts:443`). At
basic depth it returns the row count and, per column, how many rows have a value
(`docs/AGENT.md`, the depth table). That answers gaps 1 and 5 directly and cheaply:

- a 400 M-row table and a 12-row table are no longer indistinguishable, so "which is the fact table"
  becomes a reading rather than a guess;
- a `shipped_at` that is 80 % null and a `placed_at` that is 100 % populated tell the model which
  date column the business actually fills.

It costs one statement per table, reuses a tool that already exists, is already documented, already
tested and already tri-synced with its docs, and it reads **no value out of any column** — which is
what makes it acceptable to point at a table of personal data at all
(`table-profile.ts:1-27`). This is the highest-value change in this section and it requires nothing
from the user.

### 5.5 Second addition: a per-connection business note

Where the schema genuinely cannot decide (gaps 2, 3, 4), user-supplied context is the only honest
source. The smallest version:

**One free-text note per connection**, bounded at ~2 000 characters, placed as a third fenced block
beside the inventory and the relations.

```
"sales" means orders.net_total where orders.status = 'paid'.
The event date is orders.placed_at, not created_at.
Amounts are in minor units (cents).
Regions come from customers.region_code.
```

Five properties, each with the reason attached:

- **Free text, not a structured metrics model.** A semantic layer with metric definitions,
  dimensions and time grains is a product in itself, has to be maintained against schema drift, and
  is the kind of thing that is built before anyone knows which fields it needs. A note is one field
  and one storage key, and models read prose well. If the note earns its keep, what people write in
  it is the specification for the structured version.
- **Fenced, as its own block.** It is user text, so it must not read as an instruction that can widen
  what the run may do. And it must be a *separate* block rather than appended to the inventory, for
  the reason `packRelations` is separate (`investigation.ts:277-284`): `packContextForTask` grows to
  its bound, so anything concatenated afterwards silently overruns it by exactly its own length.
- **It grants no capability.** Every claim still cites an artifact; every statement still passes the
  guard, the policy and the read-only profile. A note that names a table that does not exist
  produces a statement that fails at the database and a repair, which is the ordinary path.
- **It has to be server-resolvable.** A run re-resolves its connection on the server from a persisted
  id (`runtime.ts:128`), which is why a browser-only connection cannot be investigated at all
  (`docs/AGENT.md`, "What a run is"). A note that lived only in localStorage would be invisible to a
  resumed drive. **So it belongs on the seed connection descriptor**, server-side — which is
  consistent, since a seed is the only kind of connection an agent run accepts.
- **It is shared.** A seed's note is the same for every user of that seed. That is right for a
  business definition and wrong for a personal scratchpad, and the label should say "for everyone
  using this connection".

**What I would not do:** infer semantics by sampling distinct values of text columns. It reads values
out of columns — exactly what `table-profile.ts` exists to avoid — and would put personal data into a
prompt. The `SELECT DISTINCT status` a model writes itself is different: it is one bounded read the
user can see in the timeline, on a column the model chose and can defend, rather than a systematic
sweep the server performs on everyone's behalf.

---

## What is deliberately not in this design

Each of these is a real thing someone will ask about while reading this. None is here, and the reason
is stated rather than left as an omission.

- **The `operations` workflow.** The DBA face is being built now, on the curated provider monitoring
  methods, offering no free-form SQL, reaching every provider. This document assumes it lands and
  follows the seams it uses. Where the two meet — both will want a fourth `WORKFLOW_*` record and
  both touch B17/B27's unresolved question of what operation descriptor a non-SQL metadata read
  takes — that is a merge conversation, not a design one.
- **~~Giving plan mode database context.~~ Decided and built in #384, then decided the other way on
  2026-08-15 — this bullet is kept as the record of a superseded decision, not as current
  behaviour.** #384 answered the question this bullet left open — whether plan mode should READ the
  schema — with *no*, on the ground that not reading was the promise, and handed a plan run an
  inventory somebody else had already read: `context-snapshot.ts` held each connection's most recent
  inventory, in the process that captured it, filled only by a prior agent run. That made the safe
  mode useful only to someone who had already used the unsafe one, and blind after a restart or on a
  second replica. The plan-mode SQL-generator design of 2026-08-15 reversed it: a plan run now
  establishes its own context server-side before the model's first turn, so **"plan mode performs
  zero database operations" is retired**, and the property the mode is actually sold on is stated
  instead — it runs no statement of the user's, writes nothing, and hands every statement it drafts
  to the user to run themselves. `docs/AGENT.md` carries the current contract. The egress
  consequence this bullet anticipated is unchanged either way: the same table and column names an
  agent run's prompt carries, sent to the same model, for a connection the same user could open a
  run on.
- **Timeline autoscroll.** Real, and a UI decision that has nothing to do with any of the above.
- **Run history.** A run is observable only from its own ledger; nothing enqueues a drive (B9) and
  nothing lists past runs. Out of scope.
- **Result retention after a run ends.** B15: a run's stored rows are released when it ends, so a
  report's citations can outlive its rows, and "Show result" is offered only while the run is live.
  This design lives inside that constraint — the chart's validation happens while the run is live
  (§3.3) — and does not try to lift it.

---

## Open questions

Each is phrased as a decision the owner has to make, with my recommendation attached.

1. **Do the ceilings become per-workflow, or stay global?**
   *Recommendation: per-workflow*, as a fourth total `Record` over `AgentRunWorkflowType`, matching
   the three that already exist. It costs one record and forces the same decision a new workflow
   already forces three times.

2. **What are the numbers?**
   *Recommendation:* investigation and query-optimization 24 turns / 20 statements / 300 s / 60 s DB;
   database-assessment 32 / 30 / 420 s / 90 s; data-analysis 40 / 28 / 600 s / 120 s. **Not 100
   turns** — §1.3 shows the 300 s deadline caps the reachable count at roughly 20-60 whatever the
   ceiling says, and §1.1 shows the spend rises quadratically for turns that can no longer read
   anything.

3. **Constants, environment configuration, or a per-run user choice?**
   *Recommendation: frozen constants.* A per-run choice is the injectable-policy seam
   `execution-policy.ts:10-16` exists to close; an env var would additionally desynchronise the
   rail's budget meter, which reads these constants as values from the browser bundle.

4. **Do we build the reserve turn before raising anything?**
   *Recommendation: yes, and it is the first change.* A run that lands a partial cited answer instead
   of nothing is worth having at 16 turns; at 40 it is what stops a raised ceiling from making the
   worst outcome proportionally more expensive.

5. **Does auto-execute produce the answer, or only re-run it in the editor?**
   *Recommendation: only re-run it.* The run has already executed the answer's statement — that is
   where the citation came from. Reframing the checkbox as "also run it in my editor" keeps the
   answer inside every budget, keeps the ledger complete, and reduces the risk being transferred to
   exactly one thing: an unbounded re-run at 500 rows on the user's own connection.

6. **What is the cost gate?**
   *Recommendation: the run's own measurement, not the engine's estimate.* Auto-execute only a
   statement whose identical text already completed on the agent's bounded path with
   `elapsedMs ≤ 2000`. Fall back to `inspect_plan` only for a statement the run never executed —
   PostgreSQL: `access !== "full-scan"` and `estimatedCost ≤ 50_000`; SQLite: `access === "index"`
   only, because it reports no cost at all (`plan-summary.ts:139-147`) and does not preempt.
   **Both thresholds are calibrations and should be measured against the two reference engines
   before shipping.**

7. **Is an injected `LIMIT` ever acceptable?**
   *Recommendation: no.* The path refuses rather than truncates on purpose
   (`execution-policy.ts:26-31`), and a truncated aggregate is wrong in a way no number reveals. A
   model-written `ORDER BY … LIMIT 10` is fine, because the model can then say "the top ten".

8. **What does the checkbox say?**
   *Recommendation:* "Also run the final answer in my editor", with the sentence in §2.6 naming the
   bound being given up (no time limit), the bound that remains (500 rows), and what the run does
   instead when the gate declines. Plus the SQLite line on SQLite connections.

9. **Is `answer-composed` a new ledger event, or does the report carry the presentation?**
   *Recommendation: a new event.* Folding it into `report-composed` would make the report's shape
   depend on the workflow and would put a presentation decision inside the evidence contract. A
   separate narrative event is the pattern `plan-comparison`, `recommendation` and `table-profiled`
   already follow.

10. **Is the verdict rule `agent-data-analysis.1` as stated in §4.2?**
    *Recommendation: yes*, with its stated blind spot recorded in its own docstring: a run that
    answers purely from the schema snapshot is scored `unanswered`, deliberately, because an analysis
    that read no data is not an analysis.

11. **Does `profile_table` join this workflow's tool set?**
    *Recommendation: yes, at `basic` depth.* It gives row counts and per-column present counts, which
    is what tells a fact table from a lookup table and a business date column from an audit one — and
    it reads no value out of any column. This is the cheapest real improvement in §5 and needs
    nothing from the user.

12. **Do we add a per-connection business note now, or ship on the schema alone?**
    *Recommendation: ship on the schema alone, and be honest in the rail about which questions that
    covers.* Add the note when a real run demonstrably fails for want of it — and when it is added,
    make it server-side on the seed descriptor, fenced as its own bounded block, and labelled as
    shared with everyone using that connection.

13. **Do we memoise `foldLedgerEntries`?**
    *Recommendation: yes* — one `useMemo` at `use-agent-run.ts:303`, removing the re-render
    multiplier. Virtualization is not recommended: at the numbers in question 2 the list is a few
    hundred items, and nothing has measured it as slow.
