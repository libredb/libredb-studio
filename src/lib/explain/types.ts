import type { ExplainFormat } from "@/lib/db/types";

export type ExplainMode = "estimate" | "analyze";

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
}
