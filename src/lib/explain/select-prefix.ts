/**
 * What a statement has to look like before an EXPLAIN strategy will wrap it.
 *
 * Every strategy declines a statement it cannot explain by returning `null` from
 * `buildSql`, which hides the Explain button. That check used to be a bare
 * `/^\s*SELECT\b/i` copied into all six files, and it refused two statements every
 * dialect here explains perfectly well: a CTE, and a SELECT behind a comment. Both
 * were live-verified as accepted on PostgreSQL 18, MySQL 9, SQLite, Couchbase 8.0.2,
 * ClickHouse 26.7 and Apache Druid 37, each through the exact EXPLAIN prefix its
 * strategy emits.
 *
 * A CTE mattered for a second reason: the shared `analyzeQuery` in
 * `db/utils/query-limiter.ts` already classifies `WITH ... SELECT` as a SELECT and
 * injects a LIMIT into one, so six strategies refusing it disagreed with the rest of
 * the pipeline.
 *
 * The classification is shared but the POLICY is not - see `hasDataModifyingStatement`
 * for the one dialect that has to be stricter.
 *
 * The comment skipping itself is no longer done here: it moved to
 * `lib/sql/leading-keyword.ts` once the query limiter turned out to need the same
 * tolerance (#275), and the ReDoS reasoning that shapes the pattern moved with it.
 */

import { readLeadingKeyword } from "@/lib/sql/leading-keyword";

/**
 * Which keyword a statement leads with, ignoring whitespace and comments, or `null`
 * when it leads with neither.
 *
 * The two are distinguished rather than collapsed into a boolean because a `WITH` can
 * carry a statement that WRITES, and whether that matters depends on whether the
 * dialect's EXPLAIN executes what it explains.
 */
export type SelectPrefix = "select" | "with";

/**
 * Statements that write. Used only to keep a dialect whose EXPLAIN EXECUTES from
 * executing one - see `hasDataModifyingStatement`.
 *
 * These four and no others, because the list only has to cover what can ride inside a
 * `WITH`. Both halves of that were verified on PostgreSQL 18 rather than assumed:
 *
 * - `MERGE` belongs here. It is a real carrier, not a defensive guess:
 *   `EXPLAIN (ANALYZE, FORMAT JSON) WITH t AS (MERGE INTO probe ... RETURNING id)
 *   SELECT * FROM t` really inserted the row.
 * - `TRUNCATE` does NOT belong here, and its absence is deliberate. It cannot be a
 *   carrier at all - `WITH t AS (TRUNCATE probe) SELECT 1` is a *syntax* error - and a
 *   statement that leads with it is already refused by `classifySelectPrefix`, which
 *   only ever answers for `SELECT` or `WITH`. Same for `CREATE`, `DROP` and `ALTER`.
 *
 * Flat, with no nested quantifier, so it carries none of the backtracking risk that
 * the trivia pattern in `lib/sql/leading-keyword.ts` had to be shaped around.
 */
const DATA_MODIFYING = /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i;

/**
 * The keyword this statement leads with, or `null` if it leads with neither.
 *
 * `null` is the "not explainable" answer every strategy turns into a `null` from
 * `buildSql`. A comment on its own is `null`: a comment is not a statement. So is any
 * other leading keyword - `readLeadingKeyword` reports what it finds, and only these
 * two are explainable.
 */
export function classifySelectPrefix(sql: string): SelectPrefix | null {
  const leading = readLeadingKeyword(sql)?.keyword;

  if (leading === "SELECT") return "select";
  if (leading === "WITH") return "with";
  return null;
}

/**
 * Does this statement contain a writing keyword anywhere?
 *
 * For the one dialect whose EXPLAIN *executes* what it explains. PostgreSQL's
 * strategy emits `EXPLAIN (ANALYZE, ...)`, and a data-modifying CTE is a write
 * wearing a `WITH`, so explaining one performs it. Live-verified on 18:
 *
 *     EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
 *       WITH t AS (INSERT INTO probe(id) VALUES (42) RETURNING id) SELECT * FROM t
 *
 *     -> the row is really inserted. 0 rows before, 1 row after "only explaining".
 *
 * So a `WITH` is only explainable there when nothing in it writes. This errs toward
 * refusing: `WITH t AS (SELECT 'insert') SELECT ...` is declined even though it is
 * harmless, which costs an Explain button, while the other direction would perform a
 * write the user only asked to see. It cannot miss a real one, because a
 * data-modifying CTE is exactly an `INSERT`/`UPDATE`/`DELETE`/`MERGE` and PostgreSQL
 * refuses one anywhere but the top level ("WITH clause containing a data-modifying
 * statement must be at the top level", verified), so there is nowhere for such a
 * statement to hide behind a leading `SELECT`.
 *
 * That last point is why the guard is scoped to the `with` case in the caller rather
 * than applied to every statement: a statement leading with `SELECT` cannot carry one,
 * so screening those too would only strip the Explain button off queries that merely
 * mention a keyword - `SELECT 'insert'` explains fine today and must keep doing so.
 */
export function hasDataModifyingStatement(sql: string): boolean {
  return DATA_MODIFYING.test(sql);
}
