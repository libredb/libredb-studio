/**
 * The agent programme's own execution policies and run-level bounds (#329, epic #325).
 *
 * The M1 enforcement layer takes an `ExecutionPolicy` as data and refuses a
 * malformed one (`policy.ts` denies with `MALFORMED_POLICY_CONTEXT` before any
 * stage runs), but M1 shipped no policy: nothing called the pipeline. This module
 * is that missing constant, and it is deliberately a first-class artifact rather
 * than an object literal at a call site — a policy inlined where it is used is a
 * policy nobody can review, diff, or test against the pipeline that enforces it.
 *
 * The constants are frozen all the way down, and the tool layer picks the row for
 * the RUN'S OWN PERSISTED WORKFLOW rather than accepting a policy from its caller.
 * That is the point: an injectable policy is a seam through which a route, a
 * workflow step or a resumed run could widen the agent's privileges, and a workflow
 * type is not such a seam — it is decided once when the run opens and read from the
 * ledger thereafter, the same way `selectAgentTools` and `verifyRunGoal` read it. A
 * test that needs a different policy tests `evaluateOperation`, which already takes
 * one.
 *
 * Two of the numbers below are choices worth stating rather than reading off:
 *
 * - **`allowedRoles` admits both roles**, because that is this product's own
 *   authorization model: `src/proxy.ts` gates `/admin` on the admin role and
 *   leaves every database route open to any authenticated session, so an agent
 *   restricted to admins would be more restrictive than the editor it reads for.
 *   Least privilege for the agent path is enforced where it belongs — the
 *   database-native read-only profile, and optionally a dedicated `agentUser`.
 * - **`maxResultRows` / `maxResultBytes` are model-sized, not editor-sized.** A
 *   read on this path is going to be rendered into a prompt, so the cap that
 *   matters is the one that keeps a result affordable in tokens; the editor's
 *   own paging limits are irrelevant here. The caps refuse rather than truncate
 *   (the providers throw on an over-budget result), which is what lets a caller
 *   trust that a delivered result is complete.
 */

import type { ExecutionProfile } from "@/lib/db/factory";
import type { ExecutionBudget } from "@/lib/db/operations/budgets";
import type { ExecutionPolicy } from "@/lib/db/operations/policy";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { AgentRunWorkflowType } from "./types";

/**
 * The only profile an agent execution may be served under. Named here so the
 * tool layer cannot be handed the shared writable path by a caller that supplies
 * its own profile string; `acquireExecutionProfileProvider` refuses anything else
 * anyway, and the type keeps the two in step at compile time.
 */
export const AGENT_EXECUTION_PROFILE: ExecutionProfile = "agent-read-only";

/**
 * The profile a CURATED operational read is served under.
 *
 * A second profile rather than a second acquirer, so the operations path keeps every
 * property the read-only one has — the profiled cache, the `agentUser` credential,
 * the `readOnly: true` open — and differs in exactly one thing: it does not require
 * the engine to offer a read-only statement path, because it sends no statement.
 * That single difference is what lets this workflow run on MySQL, Oracle, SQL Server,
 * MongoDB and Redis, and it is expressed once, in `factory.ts`'s profile table.
 */
export const AGENT_OPERATIONS_PROFILE: ExecutionProfile = "agent-operations";

/**
 * The profile the EDITOR HAND-OVER is served under (#373 review).
 *
 * The hand-over replays the answer's statement where the user works, and it used to
 * do that through the ordinary editor route — a plain read-write session whose only
 * protection was `isDangerousQuery`, a syntactic check. That is not the boundary the
 * checkbox promises. A `SELECT` may call a VOLATILE function that performs an
 * `INSERT`: inside the agent's own `BEGIN READ ONLY` the engine raises SQLSTATE
 * 25006, and in a read-write session it succeeds. So the same statement text was
 * harmless where the run proved it and harmful where it was replayed, and no
 * inspection of the text could tell the two apart.
 *
 * A THIRD profile rather than a widened first one. `AGENT_EXECUTION_PROFILE` keeps
 * its 10 s statement timeout and 200-row cap unchanged — those bound what a MODEL may
 * spend on a run, and the hand-over is not that. What the two share is the whole of
 * the boundary: `PROFILE_ACQUISITION` gives both the same `readOnly: true` open, the
 * same optional `agentUser` credential, the same profiled cache (never the editor's
 * writable pool), and the same demand that the provider expose a database-native
 * read-only statement path — which is what makes `BEGIN READ ONLY` and
 * `PRAGMA query_only` apply to a replayed statement exactly as they do to the run's
 * own. They differ in one thing, the budget below, and they are separate names so
 * that a later change to one cannot silently move the other.
 */
export const AGENT_HANDOVER_PROFILE: ExecutionProfile = "agent-handover";

/**
 * The largest `statementTimeoutMs` the read-only path admits, which is how "no time
 * limit" is spelled.
 *
 * The checkbox promises a replay with no statement timeout, and the plumbing cannot
 * express an absent one: `assertReadOnlyBudget` requires every field to be a positive
 * integer, and it must, because PostgreSQL interpolates this value into
 * `SET LOCAL statement_timeout = N` (SET takes no bind parameters), so anything that
 * is not an integer would be text reaching a statement. Weakening that check to admit
 * `undefined` or `0` would trade a real guard for a cosmetic one.
 *
 * So the timeout is an explicit ceiling instead: 2 147 483 647 ms — PostgreSQL's own
 * 32-bit limit for the setting, and the same figure the check tops out at — which is
 * a little over 24 days. Nothing a user waits for reaches it, so the promise holds in
 * practice; what does not hold is the word "no", and that is stated here rather than
 * implied. On SQLite the field is a post-execution reading rather than a preemption
 * (`sqlite.ts` has no interrupt to call), so at this value it never refuses either.
 */
const HANDOVER_STATEMENT_TIMEOUT_MS = 2_147_483_647;

/**
 * What ONE replayed statement may spend.
 *
 * - **Rows: the editor's own default**, imported rather than restated, because the
 *   number the checkbox names and the number the server enforces have to be one
 *   value. It refuses rather than truncates, like every other read on this path
 *   (§2.5 of `docs/AGENT_ANALYST_DESIGN.md` argues at length against injecting a
 *   `LIMIT`, and a server-side truncation would be the same lie with a different
 *   author). Condition 1 of the gate has already established that this statement
 *   returned 200 rows or fewer on the agent's own path, so the headroom to 500 is
 *   real rather than nominal.
 * - **Time: no limit, spelled as the ceiling above.**
 * - **Bytes: 64 MiB.** The editor route imposes no byte cap at all, so a cap that
 *   bound anything a user would otherwise have seen would make the replay refuse
 *   where the editor succeeds — a bound the checkbox never mentioned. This one is far
 *   above what 500 rows of a rendered result weigh and still finite, so a single
 *   pathological value cannot be serialized into a JSON response unbounded.
 */
export const AGENT_HANDOVER_BUDGET: ReadOnlyStatementBudget = Object.freeze({
  statementTimeoutMs: HANDOVER_STATEMENT_TIMEOUT_MS,
  maxResultRows: DEFAULT_QUERY_LIMIT,
  maxResultBytes: 67_108_864,
});

/**
 * Everything one workflow's run is bounded by, in one reviewable row.
 *
 * The three fields are enforced in three different places — the policy by the
 * operation pipeline, `runDeadlineMs` by `AgentRunDeadline`, `maxModelTurns` by the
 * run loop — and they are held together here because they only make sense together:
 * §1.3 of `docs/AGENT_ANALYST_DESIGN.md` shows that a turn ceiling raised without the
 * wall clock that makes it reachable is decoration, and a wall clock raised without
 * the turns is room nothing can use.
 */
export interface AgentWorkflowBudget {
  /** The policy every tool call of a run of this workflow is evaluated against. */
  readonly policy: ExecutionPolicy;
  /**
   * The wall-clock budget handed to `AgentRunDeadline` when a drive starts.
   *
   * Larger than `maxTotalRunMs` on purpose: the two bound different things, and the
   * database-time budget is a subset of the run's life. Model latency, the repair
   * loop and time spent waiting on a caller are invisible to the database budget and
   * are exactly what this one counts.
   */
  readonly runDeadlineMs: number;
  /**
   * How many times ONE DRIVE of the run loop may ask the model for its next move.
   *
   * A backstop, not the primary bound: the statement budget, the repair ledger and
   * `runDeadlineMs` are what govern the cost of a drive, and each of them ends it for
   * a reason a user can read. This one exists for the case none of them catches — a
   * model that keeps producing tool calls the loop refuses without ever reaching the
   * database, which spends no statements and no repair attempts. Set above the turns
   * a run of this workflow is expected to need and below the number the wall clock
   * could pay for at the slow end of measured model latency, so hitting it is
   * evidence of a loop rather than of an ambitious question — and so that hitting it
   * is not merely a rename of `deadline-exceeded`.
   */
  readonly maxModelTurns: number;
}

/**
 * Builds one workflow's row. A helper rather than four literals so that the fields
 * nobody varies per workflow are written once, and so that each row gets its OWN
 * frozen budgets object: two rows sharing one would read as a decision and be an
 * accident, and the day one ceiling moved the other would move with it.
 */
function workflowBudget(input: {
  readonly workflowType: AgentRunWorkflowType;
  /**
   * Which revision of this workflow's row the version names. Defaults to the first.
   *
   * A parameter rather than a literal `1` because the version's whole job is to tie a
   * recorded decision to the numbers that produced it: a row whose ceilings moved
   * while its version did not would make a `STATEMENT_BUDGET_EXCEEDED` on a ledger
   * untraceable, and would make two different budgets share one name. `operations`
   * moved to `.2` when #411 gave it a catalog capture to pay for.
   */
  readonly policyRevision?: number;
  readonly maxModelTurns: number;
  readonly maxStatementsPerRun: number;
  readonly runDeadlineMs: number;
  readonly maxTotalRunMs: number;
}): AgentWorkflowBudget {
  const budgets: ExecutionBudget = Object.freeze({
    /** The run loop is sequential: one statement in flight, so a run cannot fan out. */
    maxConcurrentExecutions: 1,
    /** A whole drive — catalog reads, drafts, repairs, plan inspections, curated readings. */
    maxStatementsPerRun: input.maxStatementsPerRun,
    /** DATABASE time only. The wall clock is `runDeadlineMs`. */
    maxTotalRunMs: input.maxTotalRunMs,
    statementTimeoutMs: 10_000,
    maxResultRows: 200,
    maxResultBytes: 262_144,
  });

  return Object.freeze({
    policy: Object.freeze({
      /*
        What reaches a policy decision and, through it, an operator's view of a run.
        The workflow is IN the version because the ceilings now differ per workflow:
        without it, a recorded `STATEMENT_BUDGET_EXCEEDED` could not be traced back to
        the number that produced it, which is the whole job of the field. Bump the
        trailing number whenever a row's fields change. The `agent-read-only` prefix
        names the POSTURE every one of these policies expresses — risk class 1, agent
        mode, no write — and not the execution profile a call is served under; the
        `operations` workflow is served under `AGENT_OPERATIONS_PROFILE` and carries
        exactly the same posture.
      */
      version: `agent-read-only.${input.workflowType}.${input.policyRevision ?? 1}`,
      /** A bounded data read is risk class 1; nothing above it is registrable at all. */
      maxRiskClass: 1,
      allowedRoles: Object.freeze(["admin", "user"] as const),
      allowedModes: Object.freeze(["agent"] as const),
      budgets,
    }),
    runDeadlineMs: input.runDeadlineMs,
    maxModelTurns: input.maxModelTurns,
  });
}

/**
 * What each workflow may spend, frozen per workflow (the data-analyst design, §1.6).
 *
 * A total `Record` over `AgentRunWorkflowType`, which is the fourth of exactly this
 * shape: the workflow axis already decides the tool set (`WORKFLOW_TOOLS`), what the
 * model is told (`WORKFLOW_OBJECTIVES` / `WORKFLOW_TOOL_RULES`) and the verdict rule
 * (`AGENT_WORKFLOW_GOALS`). A new workflow therefore stops the build until somebody
 * decides what it may spend, rather than inheriting a ceiling meant for another
 * workload.
 *
 * **The figures are approved and pending live measurement.** The owner approved them
 * on 2026-08-14 as the starting point a measurement then confirms or corrects; no run
 * has yet been measured against them. What is NOT provisional is the shape: a
 * per-workflow record whose values are frozen constants, because the alternatives were
 * refused for reasons that do not expire. A per-run choice would make `version` a lie —
 * a request-chosen ceiling cannot be traced to a constant. And an environment-configured
 * ceiling would have to cross to the browser through a route or the rail's meter would
 * state a number the server is not enforcing, since this module is statically imported
 * into the browser bundle. If a knob is wanted later, the right shape is another named
 * row with its own `version`, not a variable.
 *
 * The reasoning behind each row, in the order the rows are written:
 *
 * - **`investigation` and `query-optimization`, 36 turns / 30 statements / 450 s /
 *   90 s.** These two were 16 / 20 / 300 s / 60 s, chosen when 16 was a backstop "well
 *   above the number of turns a real investigation takes". §1.3 of the design shows
 *   why the pair had to move together: at 300 s the turn ceiling bound every run
 *   whatever it was set to, so a wider turn ceiling alone would only have changed the
 *   word in the ledger. 450 s − 90 s of database time is 360 s of model time, which is
 *   36 turns at the slow end of the latency this workload has been seen at.
 * - **`database-assessment`, 48 / 45 / 630 s / 135 s.** It profiles many tables, so it
 *   spends many statements on small results; the statement ceiling is what binds it and
 *   the wall clock follows from the turns those statements need.
 * - **`operations`, 20 / 18 / 360 s / 80 s** — the row the decision table does not
 *   cover, because this workflow landed after the design was written. It does NOT
 *   inherit an analytical budget, and the reason is what it does: the MODEL sends no
 *   SQL at all, so it never drafts a statement, never repairs one, and never iterates
 *   towards an aggregate that came out wrong — which is precisely what the raised
 *   analytical ceilings buy. Its reads are curated readings from a closed set of six
 *   kinds (`sessions`, `slow-queries`, `table-stats`, `index-stats`, `storage`,
 *   `health`), and twelve of the statements are every kind twice — once broad and once
 *   narrowed to a schema — which is what the row was sized for before #411.
 *
 *   The six the row GAINED pay for the grounding this workflow did not use to get, and
 *   they were added rather than taken out of the readings on purpose: a ceiling that
 *   stayed at 12 would have paid for the inventory by silently costing the run a third
 *   of the readings it exists to take.
 *
 *   What grounding actually costs, counted rather than rounded, because this record is
 *   what a `STATEMENT_BUDGET_EXCEEDED` is traced back to. A catalog capture is three
 *   statements on PostgreSQL and two on SQLite; `readSchemaStatistics` adds one on
 *   PostgreSQL and two on SQLite (it probes `sqlite_stat1` before reading it) and runs
 *   in PLAN mode only. So the worst case before the first turn is FOUR on either engine
 *   in plan mode, and three in agent mode — which is the mode where the reading ceiling
 *   is what binds, so 18 − 3 leaves more than the twelve readings the row was sized for.
 *   Six rather than four is deliberate slack in a row nothing has yet been measured
 *   against: this is the workflow whose statements come from a closed set, so an
 *   unexpected extra catalog read is the one cost that could otherwise silence a
 *   reading. The wall clocks are the same slack in time — at `statementTimeoutMs` of
 *   10 s, four catalog reads can be 40 s of database time on their own, which is why
 *   the database ceiling moved at all rather than by a figure derived from the four.
 *   `maxModelTurns` does not move: grounding is the server's work before the first turn,
 *   and it costs no turn.
 * - **`data-analysis`, 60 / 42 / 900 s / 180 s** — the largest row, and every one of
 *   its four figures is bought rather than inherited. An analytical run's shape is a
 *   handful of exploratory reads to find the fact table, several attempts at getting
 *   one aggregate right — which is where the repair budget goes — and then one or two
 *   comparison windows, so it needs room to ITERATE where an assessment needs room to
 *   repeat. Its database time is the ceiling most likely to bind first, because a
 *   `GROUP BY` over a fact table is not a catalog read: 180 s is what keeps
 *   `TOTAL_RUN_BUDGET_EXCEEDED` from arriving before the statement budget does. And
 *   900 s is what makes 60 turns REACHABLE rather than decorative — 900 s − 180 s of
 *   database time is 720 s of model time, which is 60 turns at the slow end of this
 *   workload's latency. Two consequences are deliberate purchases and are stated
 *   rather than discovered: by the quadratic shape above this row costs several times
 *   an investigation, not 1.7× it; and a 900 s run outlives the default idle timeout
 *   of most reverse proxies (nginx's `proxy_read_timeout` is 60 s), so a deployment
 *   in front of a container needs its own timeout raised — stated in `docs/AGENT.md`
 *   under "Deployment" rather than silently assumed.
 *
 * Every one of these ceilings is per DRIVE, not per run. The budget tracker, the repair
 * ledger and the deadline all live in the process that drives a run, so a run resumed
 * after a process death starts each of them again: N resumes cost up to N times a single
 * drive's ceiling. Nothing here is a lie about a run's total cost because nothing here
 * claims to bound one — bounding a run ACROSS resumes needs a ceiling folded from its own
 * ledger (the record carries `createdAtMs`, so the data exists), and that is recorded in
 * `docs/BACKLOG.md` rather than implied here.
 */
export const AGENT_WORKFLOW_BUDGETS: Readonly<Record<AgentRunWorkflowType, AgentWorkflowBudget>> = Object.freeze({
  investigation: workflowBudget({
    workflowType: "investigation",
    maxModelTurns: 36,
    maxStatementsPerRun: 30,
    runDeadlineMs: 450_000,
    maxTotalRunMs: 90_000,
  }),
  "query-optimization": workflowBudget({
    workflowType: "query-optimization",
    maxModelTurns: 36,
    maxStatementsPerRun: 30,
    runDeadlineMs: 450_000,
    maxTotalRunMs: 90_000,
  }),
  "database-assessment": workflowBudget({
    workflowType: "database-assessment",
    maxModelTurns: 48,
    maxStatementsPerRun: 45,
    runDeadlineMs: 630_000,
    maxTotalRunMs: 135_000,
  }),
  operations: workflowBudget({
    workflowType: "operations",
    policyRevision: 2,
    maxModelTurns: 20,
    maxStatementsPerRun: 18,
    runDeadlineMs: 360_000,
    maxTotalRunMs: 80_000,
  }),
  "data-analysis": workflowBudget({
    workflowType: "data-analysis",
    maxModelTurns: 60,
    maxStatementsPerRun: 42,
    runDeadlineMs: 900_000,
    maxTotalRunMs: 180_000,
  }),
} satisfies Record<AgentRunWorkflowType, AgentWorkflowBudget>);

/**
 * The longest ONE model call may take before the loop stops waiting for it.
 *
 * The run deadline used to be the only bound on a single request, and a measured run
 * showed what that costs: an unanswered call ended a run at exactly 300.0s — the whole
 * investigation deadline of the day — with a two-event ledger, having spent a budget
 * meant to cover a whole investigation, and a user watched it do so with no feedback.
 * Most turns on this workload land in seconds, and this ceiling was written on the assumption
 * that anything reaching it was a call that would never come back. A local model falsifies that:
 * measured on `qwen3.6:35b`, query-optimization, nine losses were cut near 100s of a 450s deadline
 * with 34 of 36 turns unspent, while the same cell's longest PASSING run took 183s. So the ceiling
 * is a bound on ONE CALL and the drive treats it as one — a cut turn is asked again rather than
 * ending the run — which is what makes the sentence below true rather than aspirational. It is
 * deliberately NOT per workflow: the
 * decision table varies what a RUN may spend, and how long one request may hang before
 * it is written off is a property of the transport, not of the question being asked.
 *
 * It bounds ONE call, never the run: the deadline is still the authority the loop
 * reads between turns, and whichever is smaller applies. A run with less time left
 * than this gets the run's own reason, because "this request never returned" and
 * "this run used its time" are different things to tell a user.
 */
export const AGENT_MODEL_TURN_TIMEOUT_MS = 90_000;

/**
 * The least time a single call could plausibly need. Below this, the deadline
 * refuses to start the call rather than beginning one it cannot finish. Kept well
 * under `statementTimeoutMs`, which `AgentRunDeadline.admit` requires: a minimum
 * above the ceiling is a miswired call site and throws there.
 */
export const AGENT_MINIMUM_CALL_MS = 250;

/**
 * How close to a ceiling a run may come before it is told to write its report.
 *
 * A run that reaches a ceiling ends `failed` with no `report-composed` entry and a
 * goal verdict of `unanswered`: the whole spend buys nothing, and raising the
 * ceilings multiplies the cost of that outcome rather than reducing its chance. So
 * the loop, which already knows both distances, spends the reserve on one message —
 * *this is your last turn, call `compose_report` now with what you have established*
 * (`AGENT_REPORT_RESERVE_NOTICE` in `investigation.ts`, which is what actually says
 * it).
 *
 * Two constants and not one because the two ceilings are reached by different runs:
 * a run that spends its turns on refused tool calls never approaches the clock, and a
 * run that spends four minutes inside one model call never approaches the turns.
 * Whichever is crossed first fires the same single message.
 *
 * Both figures are sized for what the reserved turn DOES rather than for the ceiling
 * they sit under, which is why neither is a fraction of a budget row: `compose_report`
 * reaches no database, spends no statement and takes no deadline admission, so what a
 * report costs is one model call. Two turns, because the notice is delivered at the
 * START of a turn and a model that answers with prose rather than a tool call has then
 * spent it; twenty seconds, because that is a comfortable multiple of a measured turn
 * on this workload and still under a tenth of the shortest run deadline.
 */
export const AGENT_REPORT_RESERVE_TURNS = 2;

/** @see AGENT_REPORT_RESERVE_TURNS — the same reserve, against the wall clock. */
export const AGENT_REPORT_RESERVE_MS = 20_000;

/**
 * How many times one turn may be re-asked when its STREAM broke, rather than the model.
 *
 * Two, matching the chat surface: `base-provider.ts` retries a retryable `LLMStreamError` three
 * times against these same endpoints, and an agent turn is far more expensive than a chat one, so
 * this is the same judgement spent more carefully.
 *
 * It bounds a fault in the connection, never one in the model. `isRetryableError` refuses auth,
 * safety and config errors, so a misconfigured server still fails on its first turn; what this
 * covers is the broken frame measured on `gpt-oss:20b`, where runs died a median of 17 seconds
 * into a 630-second budget having already called four tools.
 */
export const AGENT_TRANSPORT_TURN_RETRIES = 2;

/**
 * How many statements that FAILED AT THE DATABASE a run may try to repair.
 *
 * Policy denials and approval requirements deliberately do not consume one — they
 * are boundary decisions, not defects in a statement, and nothing ran. What bounds
 * a model that keeps producing distinct denied statements is the run deadline and
 * the statement budget, not this counter.
 */
export const AGENT_MAX_REPAIR_ATTEMPTS = 3;

/**
 * The longest objective a run may be started on.
 *
 * Here rather than at either end of the wire, because it used to be written twice —
 * once in the start route and once in the rail, kept in step by a COMMENT saying one
 * mirrored the other. That held only while the box a user types into was the sole way
 * an objective could be set. #331 T1 added a second way, a shortcut that fills the
 * rail programmatically, and review found what two constants and a comment cannot
 * catch: a prefill longer than this bypassed the textarea's `maxLength`, so the rail
 * accepted a state its own UI forbids and the route then refused the run the user
 * pressed Start on. The statement an editor shortcut prefills is exactly the kind of
 * text that reaches this length.
 *
 * One constant, imported by both, so the two cannot disagree at all. The bound is the
 * SERVER's — the route refuses anything longer whatever a client believes — and the
 * client's job is to never construct what the server will refuse.
 */
export const AGENT_MAX_OBJECTIVE_LENGTH = 4000;

/**
 * The whole budget for the conversation block a run is handed.
 *
 * It bounds two things at once, which is why it is one number: what continuing a
 * conversation costs a run in context, and how large a ledger header may grow,
 * since the derived block is persisted on it.
 *
 * The same order of magnitude as one objective, deliberately: the account of every
 * step before this run should not outweigh the question this run was asked.
 *
 * An operator who has MEASURED their model may size it per model through
 * `AGENT_MODEL_TUNING_PATH`. Nothing measured ships for it — no entry in
 * `measured-profiles.json` names it, because nobody has measured one — so this
 * compiled default drives every model until somebody does.
 */
export const AGENT_THREAD_CONTEXT_MAX_CHARS = 4000;

/**
 * One carried objective, as the conversation's spine records it.
 *
 * Capped because the spine is copied onto every header after it, while the full
 * text stays on the run that owns it and is one read away.
 */
export const AGENT_THREAD_STEP_OBJECTIVE_MAX_CHARS = 200;

/**
 * How many steps a conversation carries before the OLDEST are dropped.
 *
 * Oldest rather than newest because a pronoun reaches for recent ground; and the
 * drop is stated in the derived text rather than performed silently, since a model
 * that half-read a conversation must not be confident about the half it has.
 */
export const AGENT_THREAD_MAX_STEPS = 20;
