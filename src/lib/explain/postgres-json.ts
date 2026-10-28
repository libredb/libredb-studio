import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { classifySelectPrefix, hasDataModifyingStatement } from "./select-prefix";
import { isRecord } from "@/lib/is-record";
import { type AccessTally, type AgentPlanSummary, accessOf, reportedNumber } from "./plan-access";
import type { ExplainAgentReading, ExplainPlanResult, ExplainStrategy } from "./types";

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
 * The screen holds for both modes even though only `analyze` executes: the estimate
 * and the Explain button must refuse the same statements, or the background plan would
 * appear for a statement the button then refuses.
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
export function isExplainableUnderPostgresGrammar(sql: string): boolean {
  const prefix = classifySelectPrefix(sql, POSTGRES_GRAMMAR);
  if (prefix === null) return false;

  return prefix === "select" || !hasDataModifyingStatement(sql);
}

// ─── the agent's reading ────────────────────────────────────────────────────

/**
 * `EXPLAIN (FORMAT JSON)` answers one row, one column named `QUERY PLAN`, holding
 * an array whose first element carries the root `Plan`. The driver parses the JSON
 * itself, so this reads values rather than text.
 */
function planRoot(rows: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  const column = rows[0]?.["QUERY PLAN"];
  if (!Array.isArray(column)) return null;
  const first = column[0];
  if (!isRecord(first)) return null;
  const plan = first.Plan;
  return isRecord(plan) ? plan : null;
}

/** Node types that reach rows through an index, and the one that reads a relation whole. */
const INDEX_NODE = /Index (Only )?Scan|Bitmap Index Scan/;
const SCAN_NODE = /^(Seq Scan|Parallel Seq Scan)$/;

function tallyNode(node: Record<string, unknown>, tally: AccessTally): void {
  const nodeType = typeof node["Node Type"] === "string" ? node["Node Type"] : "";
  if (INDEX_NODE.test(nodeType)) tally.indexed = true;
  else if (SCAN_NODE.test(nodeType)) tally.scanned = true;
  const children = node.Plans;
  if (!Array.isArray(children)) return;
  for (const child of children) if (isRecord(child)) tallyNode(child, tally);
}

/**
 * PostgreSQL sets NO `uninterpretedStep`, and the omission is a decision (#373 review).
 *
 * A PG plan is mostly nodes this reading does not tally — `Sort`, `Hash Join`,
 * `Aggregate`, `Gather`, `Materialize` — and none of them is a relation access, so
 * flagging them would mean flagging nearly every plan the engine can produce. What
 * makes that trade different from SQLite's is that the two engines give the gate
 * different things to hold on to: PostgreSQL reports a numeric `Total Cost` for the
 * WHOLE plan, which the gate already weighs against a ceiling, and it preempts a
 * statement that overruns `statement_timeout`. So an unrecognised node there is
 * covered by a bound that is already enforced. SQLite reports no cost at all, does not
 * preempt, and blocks writers while a read runs, which leaves the access reading as
 * the gate's entire evidence — and a reading that skipped a step is not evidence.
 */
function summarise(rows: readonly Record<string, unknown>[]): AgentPlanSummary {
  const root = planRoot(rows);
  if (root === null) return { access: "unknown" };
  const tally: AccessTally = { scanned: false, indexed: false, uninterpreted: false };
  tallyNode(root, tally);
  // The ROOT's estimates: they describe the whole plan, and a child's would describe
  // one step of it while reading as though it were the answer.
  const estimatedRows = reportedNumber(root["Plan Rows"]);
  const estimatedCost = reportedNumber(root["Total Cost"]);
  return {
    access: accessOf(tally),
    ...(estimatedRows === undefined ? {} : { estimatedRows }),
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
  };
}

/** Costed: the root's `Total Cost` covers the whole plan, and the engine preempts an overrun. */
const AGENT_READING: ExplainAgentReading = Object.freeze({ costed: true, summarise });

export const postgresJsonStrategy: ExplainStrategy = {
  format: "postgres-json",
  /**
   * The mode decides whether the statement RUNS. `estimate` is what the editor sends in
   * the background beside every run of a SELECT, so it must only plan: without
   * `ANALYZE`, PostgreSQL plans and executes nothing. It used to build the ANALYZE form
   * for both modes, and every SELECT ran twice. Measured on PostgreSQL 18.6, one RUN of
   * `SELECT nextval('my_seq')` left `last_value` at 2; on Citus 14.2 and TimescaleDB
   * 2.30 the hidden request ran `create_distributed_table` / `create_hypertable` before
   * the user's own call, which then failed as "already distributed" (#1311).
   *
   * `BUFFERS` goes with `ANALYZE`: a plan that ran nothing has no buffer counts.
   */
  buildSql(sql, mode) {
    if (!isExplainableUnderPostgresGrammar(sql)) return null;
    return mode === "analyze" ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}` : `EXPLAIN (FORMAT JSON) ${sql}`;
  },
  extractPlan(result) {
    return result.rows?.[0]?.["QUERY PLAN"] || result.rows;
  },
  toRenderModel(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return { kind: "postgres-json", plan: raw as ExplainPlanResult[] };
  },
  agentReading: AGENT_READING,
};
