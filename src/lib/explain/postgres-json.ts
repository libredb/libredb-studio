import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { classifySelectPrefix, hasDataModifyingStatement } from "./select-prefix";
import type { ExplainPlanResult, ExplainStrategy } from "./types";

/**
 * This strategy's dialect, resolved once.
 *
 * The module IS the PostgreSQL strategy - it is reached only through
 * `explainFormat: "postgres-json"`, which only `providers/sql/postgres.ts` declares -
 * so naming the type here is the same shape as a provider passing `this.type`, not the
 * type-switching this project bans. Nothing below the resolver sees a type id.
 */
const POSTGRES_GRAMMAR = resolveSqlGrammar("postgres");

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
 *
 * The classification is read under PostgreSQL's own grammar, and that is load-bearing
 * rather than tidiness: block comments NEST here, so read flat,
 * `/* a /* b *\/ SELECT 1 *\/ DELETE FROM users` leads with `SELECT` - the `DELETE`
 * hides behind text a flat reader thinks is code - and this path has no other screen,
 * because a `SELECT` prefix skips `hasDataModifyingStatement` by the paragraph above
 * and an explain run skips the confirmation dialog entirely
 * (`use-query-execution.ts`, `!isExplain`). Live-verified on PostgreSQL 18:
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` over that statement against a three-row
 * table left zero rows. Under this dialect's grammar the comment is read whole, the
 * statement leads with `DELETE`, and nothing is built (#300).
 */
function isExplainable(sql: string): boolean {
  const prefix = classifySelectPrefix(sql, POSTGRES_GRAMMAR);
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
