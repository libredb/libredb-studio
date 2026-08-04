import { classifySelectPrefix, hasDataModifyingStatement } from "./select-prefix";
import type { ExplainPlanResult, ExplainStrategy } from "./types";

/**
 * The one strategy that cannot simply take the shared classification, because it is
 * the one whose EXPLAIN **executes** what it explains.
 *
 * `EXPLAIN (ANALYZE, ...)` runs the statement to report actual rows and timings, and a
 * data-modifying CTE is a write wearing a `WITH`. Live-verified on PostgreSQL 18:
 *
 *     EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
 *       WITH t AS (INSERT INTO probe(id) VALUES (42) RETURNING id) SELECT * FROM t
 *
 *     -> 0 rows in the table before, 1 row (42) after. Explaining performed the insert.
 *
 * So a `WITH` is explainable here only when nothing in it writes. A statement leading
 * with `SELECT` needs no such screen and deliberately does not get one: PostgreSQL
 * refuses a data-modifying CTE anywhere but the top level ("WITH clause containing a
 * data-modifying statement must be at the top level", verified), so one cannot hide
 * behind a leading `SELECT` - and screening those too would strip the Explain button
 * off queries that merely mention a keyword, such as `SELECT 'insert'`, which explains
 * fine today.
 *
 * The narrower question of ANALYZE executing an ordinary SELECT twice - once for the
 * user, once for the background pre-warm - is issue #194's remaining work, not this.
 */
function isExplainable(sql: string): boolean {
  const prefix = classifySelectPrefix(sql);
  if (prefix === null) return false;

  return prefix === "select" || !hasDataModifyingStatement(sql);
}

export const postgresJsonStrategy: ExplainStrategy = {
  format: "postgres-json",
  buildSql(sql) {
    if (!isExplainable(sql)) return null;
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
