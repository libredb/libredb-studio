import type { ExplainFormat } from "@/lib/db/types";
import type { AgentPlanSummary } from "./plan-access";

export type ExplainMode = "estimate" | "analyze";

export type ExplainPlanNode = {
  Plan?: ExplainPlanNode;
  "Node Type"?: string;
  Strategy?: string;
  "Actual Rows"?: number;
  "Plan Rows"?: number;
  "Actual Total Time"?: number;
  "Total Cost"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Relation Name"?: string;
  "Actual Loops"?: number;
  Filter?: string;
  "Index Name"?: string;
  Plans?: ExplainPlanNode[];
};

export type ExplainPlanResult = {
  Plan?: ExplainPlanNode;
  "Execution Time"?: number;
  "Planning Time"?: number;
};

export interface ExplainTreeNode {
  label: string;
  detail?: string;
  metrics?: { estRows?: number; estCost?: number; actualRows?: number; actualTimeMs?: number };
  children: ExplainTreeNode[];
}

export type ExplainPlanInput =
  | { kind: "postgres-json"; plan: ExplainPlanResult[] }
  | { kind: "tree"; root: ExplainTreeNode; raw: unknown };

export interface StoredExplainPlan {
  format: ExplainFormat;
  raw: unknown;
}

/**
 * How the agent reads this format's estimating plan: the structural summary it compares and the auto-execute gate
 * weighs (`summarisePlan` in `src/lib/agent/plan-summary.ts`, `evaluateAutoExecute` in `src/lib/agent/auto-execute.ts`).
 *
 * A strategy carries one only once its reader has been verified against the engine's own grammar. Without one the
 * agent's summary is `unknown` and the gate refuses as an unverified dialect, which is the fail-closed answer: reading
 * a plan by another format's rule would be a claim about a plan nobody has looked at.
 */
export interface ExplainAgentReading {
  /**
   * Whether the summary carries a numeric cost for the WHOLE plan that the gate weighs against its ceiling, from an
   * engine that also preempts a statement that overruns. `true`: a plan reaching its rows through an index on at least
   * one side (`index` or `mixed`) passes when its cost is inside the ceiling, and a plan with no cost is refused.
   * `false`: the engine reports no cost, so `access` is the whole reading and only a wholly indexed plan passes.
   */
  readonly costed: boolean;
  /** Reads the rows the estimating plan answered into the summary. Never throws: the rows are an unchecked cast. */
  summarise(rows: readonly Record<string, unknown>[]): AgentPlanSummary;
}

/**
 * One strategy per ExplainFormat (registered in ./index.ts). Strategies are
 * pure and per-dialect-isolated: a change for one dialect must never touch
 * another dialect's file.
 */
export interface ExplainStrategy {
  readonly format: ExplainFormat;
  /**
   * `false` where the editor sends no plan beside an ordinary run, because the engine bills every plan request. Absent
   * means the editor asks for an estimate plan in the background beside every run of a statement the strategy explains.
   */
  readonly backgroundPlan?: false;
  /**
   * `true` where the plan request is a free dry run that prices the statement without running or billing it, so the
   * editor asks for it while the person types and shows what the statement would process. Absent means the plan is
   * asked for only on demand.
   */
  readonly liveEstimate?: true;
  /** Dialect EXPLAIN SQL for a SELECT statement, or null when not explainable. */
  buildSql(sql: string, mode: ExplainMode): string | null;
  /**
   * Why `buildSql` declines this statement in this mode, as the sentence a person reads, or null when it does not
   * decline it, or declines it only for not being a SELECT, which the caller says in its own words.
   *
   * Optional: a strategy that declines by the statement's kind alone has nothing to add, and the caller's sentence
   * stands. One that declines a SELECT-shaped statement too implements it, or the person is told that a SELECT is not
   * one.
   */
  declineReason?(sql: string, mode: ExplainMode): string | null;
  /** Maps a raw /api/db/query result to the value stored on QueryTab.explainPlan. Never throws. */
  extractPlan(result: { rows?: Array<Record<string, unknown>> }): unknown;
  /** Maps the stored raw value to the VisualExplain render model. Never throws; null on foreign shapes. */
  toRenderModel(raw: unknown): ExplainPlanInput | null;
  /** The agent's reading of this format's estimating plan, once verified; absent reads as unverified. */
  readonly agentReading?: ExplainAgentReading;
}
