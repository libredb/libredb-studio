/**
 * SQL's client facet (#1821): its copy, its workflow variants, its plan operation and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaves `workflow-tool-sets.ts` and `execution-policy.ts`.
 */
import type { AgentVariantRequirement, AgentWorkflowVariant } from "../../agent-manifest";
import { AGENT_HANDOVER_BUDGET } from "../../execution-policy";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import type { AgentRunWorkflowType } from "../../types";
import { OPERATIONS_VARIANT, READ_CLASS_TOOLS } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/** The SQL consent sentence: the database's own read-only session bounds both paths. */
function sqlHandoverTerms(budgets: StatementBudgets): string {
  return `The run always produces its answer on its own read-only path, bounded to ${budgets.maxResultRows} rows and ${budgets.statementTimeoutMs / 1000} seconds. Tick this and it will also put that statement in your editor and run it there — on the connection the run was opened on, at the editor's ${AGENT_HANDOVER_BUDGET.maxResultRows}-row limit and with no time limit. It is the same database-enforced read-only session either way, so writes and DDL are refused by the engine rather than by reading the statement. Statements whose plan reads as expensive, or which the run measured as slow, are put in the editor without being run.`;
}

/** Agent mode on a SQL engine: the database's read-only session is the boundary. */
function sqlReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per statement, enforced by the engine`,
    title: "Agent mode reads, under a boundary the engine enforces",
    body: `Agent mode runs statements it wrote itself, in a read-only session the database enforces, bounded to ${rows} rows and ${seconds} seconds each. Writes and DDL are refused by the engine rather than by reading the statement. Nothing reaches your editor unless you tick the hand-over when the run opens.`,
  };
}

/*
  What each statement workflow requires of an engine's dialect is what its verdict cites, not everything it offers.
  Only the optimization verdict rests on an estimating plan (a plan comparison, or an index recommendation citing a
  plan), so only that variant requires `sql-composers`. The other three require `sql-catalog`: the `inspect_plan` and
  `profile_table` they are offered too each refuse with `UNSUPPORTED_DIALECT` on a dialect that composes neither, and
  a run that cannot estimate a plan never auto-executes, because a missing plan reads as a risky one.
*/
export const SQL_CLIENT_PACK = Object.freeze({
  copy: Object.freeze({
    subject: "a database",
    noun: "statement",
    argument: "sql",
    writes: "writes and DDL",
    reached: "the database",
    defect: "your SQL",
    adviceKeys: Object.freeze([]),
  }),
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze([...READ_CLASS_TOOLS]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the database that is answered from what the run establishes",
      objective: "Your objective is a question about this database. Answer it from what you establish.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the statement that answers the question" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-catalog"]),
      verifier: "agent-investigation.1",
    }),
    /**
     * The optimization template's own two tools on top of the read-class four, offered to this workflow alone, which
     * is what makes the axis load-bearing: an investigation that calls `compare_plans` is told there is no such
     * tool, because for that run there is not.
     */
    "query-optimization": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "compare_plans", "recommend_change"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["compare_plans", "recommend_change"]),
      classifierDescription: "a specific statement that is too slow, and how the engine reaches its rows",
      objective:
        "Your objective is a statement that is too slow. What matters is HOW the engine reaches its rows, and what change would make it reach them differently.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the rewritten statement" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-composers"]),
      verifier: "agent-query-optimization.3",
    }),
    /** The assessment template's own tool, on top of the read-class four. */
    "database-assessment": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "profile_table"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["profile_table"]),
      classifierDescription: "the state of the data itself: where it is incomplete, inconsistent or surprising",
      objective:
        "Your objective is the state of this database itself: where its data is incomplete, inconsistent or surprising.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the statement that measures the quality concern" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-catalog"]),
      verifier: "agent-database-assessment.1",
    }),
    operations: OPERATIONS_VARIANT,
    /**
     * The analysis template's two tools on top of the read-class four.
     *
     * `present_answer` is the one this workflow's verdict requires, and it is offered HERE and nowhere else for
     * exactly that reason: a tool a run's bar never asks for is a tool that can only distract it. A narrowed run
     * keeps it because the verdict scores the answer separately from the report.
     *
     * `profile_table` is borrowed from the assessment template at basic depth. The schema carries no row counts, so
     * a 400 M-row fact table and a 12-row lookup table are indistinguishable in the inventory, and a `shipped_at`
     * that is 80% null beside a fully populated `placed_at` says which date column the business actually fills.
     * Basic depth answers both, costs one statement per table, and reads no value out of any column, which is what
     * makes pointing it at a table of personal data acceptable at all.
     */
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "profile_table", "present_answer"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the data whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about the data in this database. Establish the answer from the data and produce something to show for it.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the statement that produces the answer" }),
      canAutoExecute: true,
      requires: Object.freeze<AgentVariantRequirement[]>(["sql-catalog"]),
      verifier: "agent-data-analysis.1",
    }),
  } satisfies Record<AgentRunWorkflowType, AgentWorkflowVariant>),
  planEstimateOperation: "sql.explain.estimate",
  evidenceEvents: Object.freeze({}),
  shortfallSentences: Object.freeze({}),
  readingRefusalHeadlines: Object.freeze({}),
  requirements: Object.freeze({}),
  posture: Object.freeze({
    reads: sqlReadsPosture,
    widened: (bounds: StatementBudgets): AgentPosture => ({
      tone: "widened",
      headline: "Reads only, and one statement in your editor",
      qualifier: `${AGENT_HANDOVER_BUDGET.maxResultRows} rows, no time limit, same read-only session`,
      title: "Reads only, and one statement lands in your editor",
      body: sqlHandoverTerms(bounds),
    }),
    handoverTerms: sqlHandoverTerms,
  }),
} satisfies AgentLanguageClientPack);
