import { classifySelectPrefix } from "./select-prefix";
import type { ExplainPlanResult, ExplainStrategy } from "./types";

export const mysqlJsonStrategy: ExplainStrategy = {
  format: "mysql-json",
  buildSql(sql) {
    // MySQL's `EXPLAIN FORMAT=JSON` describes without running, so a CTE is safe to explain.
    if (classifySelectPrefix(sql) === null) return null;
    return `EXPLAIN FORMAT=JSON ${sql}`;
  },
  // Legacy extraction preserved on purpose (bug B4): MySQL output has an
  // "EXPLAIN" column, not "QUERY PLAN"; the real parser lands in #194 PR-4.
  extractPlan(result) {
    return result.rows?.[0]?.["QUERY PLAN"] || result.rows;
  },
  // B4 passthrough: renders exactly like today's cast until the real query_block parser lands in #194 PR-4.
  toRenderModel(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return { kind: "postgres-json", plan: raw as ExplainPlanResult[] };
  },
};
