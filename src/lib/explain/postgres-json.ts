import type { ExplainPlanResult, ExplainStrategy } from "./types";

const SELECT_ONLY = /^\s*SELECT\b/i;

export const postgresJsonStrategy: ExplainStrategy = {
  format: "postgres-json",
  buildSql(sql) {
    if (!SELECT_ONLY.test(sql.trim())) return null;
    return `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
  },
  extractPlan(result) {
    return result.rows?.[0]?.["QUERY PLAN"] || result.rows;
  },
  toRenderModel(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return { kind: "postgres-json", plan: raw as ExplainPlanResult[] };
  },
};
