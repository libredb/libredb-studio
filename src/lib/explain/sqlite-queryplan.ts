import { classifySelectPrefix } from "./select-prefix";
import { type AccessTally, type AgentPlanSummary, accessOf } from "./plan-access";
import type { ExplainAgentReading, ExplainStrategy, ExplainTreeNode } from "./types";

interface QueryPlanRow {
  id: number;
  parent: number;
  detail: string;
}

function isQueryPlanRow(row: unknown): row is QueryPlanRow {
  return (
    typeof row === "object" &&
    row !== null &&
    typeof (row as QueryPlanRow).id === "number" &&
    typeof (row as QueryPlanRow).parent === "number" &&
    typeof (row as QueryPlanRow).detail === "string"
  );
}

// ─── the agent's reading ────────────────────────────────────────────────────

/**
 * `EXPLAIN QUERY PLAN` answers one row per step, and everything it says is in the
 * free-text `detail` column: `SCAN employee`, `SEARCH t USING INDEX ix (a=?)`,
 * `USE TEMP B-TREE FOR ORDER BY`. There is no cost and no row estimate anywhere in
 * it, which is why this returns neither.
 */
/**
 * `SEARCH` versus `SCAN` is the distinction, and matching on the word `INDEX` was
 * the wrong one — found by review on #344.
 *
 * SQLite reports several indexed seeks that never say "USING INDEX": a rowid lookup
 * (`SEARCH t USING INTEGER PRIMARY KEY`), a WITHOUT ROWID table's key
 * (`USING PRIMARY KEY`), and the transient index it builds for itself
 * (`USING AUTOMATIC COVERING INDEX`). Reading only `USING [COVERING] INDEX` filed
 * every one of them as `unknown` — the summary saying it could not tell, about a
 * plan that had said so plainly. `SEARCH` means a subset of rows was sought;
 * `SCAN` means a table was read whole. That is the engine's own vocabulary.
 */
const INDEX_STEP = /^SEARCH\b/;
const SCAN_STEP = /^SCAN\b/;

/**
 * Every step is either read or COUNTED AS UNREAD — found by review on #373.
 *
 * `EXPLAIN QUERY PLAN` answers one row per step and this reading recognises two of
 * them, so a plan of `SEARCH t USING INDEX ix` plus `USE TEMP B-TREE FOR ORDER BY`
 * used to summarise as a flat `index`: a claim that every relation is reached through
 * an index, made about a plan half of which had not been looked at. The auto-execute
 * gate takes that word as its entire condition 2 on this engine, so the unread step was
 * handed to a user's editor to run without a timeout on the strength of it.
 *
 * The flag rides beside `access` rather than collapsing it to `unknown`, because what
 * the recognised steps said is still true and a comparison still wants it.
 */
function summarise(rows: readonly Record<string, unknown>[]): AgentPlanSummary {
  const tally: AccessTally = { scanned: false, indexed: false, uninterpreted: false };
  for (const row of rows) {
    const detail = typeof row.detail === "string" ? row.detail.trim() : "";
    if (INDEX_STEP.test(detail)) tally.indexed = true;
    else if (SCAN_STEP.test(detail)) tally.scanned = true;
    // Anything else, INCLUDING a row carrying no readable detail at all: a step this
    // build has never seen and a row that is not a query-plan row are the same thing
    // to a gate — something happened here that nobody weighed.
    else tally.uninterpreted = true;
  }
  return { access: accessOf(tally), ...(tally.uninterpreted ? { uninterpretedStep: true } : {}) };
}

/**
 * Uncosted: SQLite reports no cost and no row estimate, does not preempt, and a read that runs long blocks writers, so
 * the access reading is the gate's whole evidence.
 */
const AGENT_READING: ExplainAgentReading = Object.freeze({ costed: false, summarise });

export const sqliteQueryplanStrategy: ExplainStrategy = {
  format: "sqlite-queryplan",
  // EXPLAIN QUERY PLAN (not bare EXPLAIN, which dumps VDBE opcodes) and it
  // never executes the statement, so estimate and analyze are identical.
  buildSql(sql) {
    // `EXPLAIN QUERY PLAN` describes without running, so a CTE is safe to explain.
    if (classifySelectPrefix(sql) === null) return null;
    return `EXPLAIN QUERY PLAN ${sql}`;
  },
  extractPlan(result) {
    return result.rows;
  },
  toRenderModel(raw) {
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isQueryPlanRow)) return null;
    const nodes = new Map<number, ExplainTreeNode>();
    for (const row of raw) {
      nodes.set(row.id, { label: row.detail, children: [] });
    }
    const root: ExplainTreeNode = { label: "Query Plan", children: [] };
    const attached = new Set<number>();
    for (const row of raw) {
      const node = nodes.get(row.id);
      if (!node || attached.has(row.id)) continue;
      const parent = row.parent !== row.id ? nodes.get(row.parent) : undefined;
      // Cycle/orphan guard: anything without a resolvable acyclic parent hangs off the root.
      if (parent && !isAncestor(node, parent)) {
        parent.children.push(node);
      } else {
        root.children.push(node);
      }
      attached.add(row.id);
    }
    return { kind: "tree", root, raw };
  },
  agentReading: AGENT_READING,
};

function isAncestor(candidate: ExplainTreeNode, of: ExplainTreeNode): boolean {
  if (candidate === of) return true;
  return candidate.children.some((child) => isAncestor(child, of));
}
