import type { ExplainFormat } from "@/lib/db/types";

export type ExplainMode = "estimate" | "analyze";

export type ExplainPlanNode = {
  Plan?: ExplainPlanNode;
  "Node Type"?: string;
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
 * One strategy per ExplainFormat (registered in ./index.ts). Strategies are
 * pure and per-dialect-isolated: a change for one dialect must never touch
 * another dialect's file.
 */
export interface ExplainStrategy {
  readonly format: ExplainFormat;
  /** Dialect EXPLAIN SQL for a SELECT statement, or null when not explainable. */
  buildSql(sql: string, mode: ExplainMode): string | null;
  /** Maps a raw /api/db/query result to the value stored on QueryTab.explainPlan. Never throws. */
  extractPlan(result: { rows?: Array<Record<string, unknown>> }): unknown;
  /** Maps the stored raw value to the VisualExplain render model. Never throws; null on foreign shapes. */
  toRenderModel(raw: unknown): ExplainPlanInput | null;
}
