import type { ExplainStrategy, ExplainTreeNode } from "./types";

const SELECT_ONLY = /^\s*SELECT\b/i;

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

export const sqliteQueryplanStrategy: ExplainStrategy = {
  format: "sqlite-queryplan",
  // EXPLAIN QUERY PLAN (not bare EXPLAIN, which dumps VDBE opcodes) and it
  // never executes the statement, so estimate and analyze are identical.
  buildSql(sql) {
    if (!SELECT_ONLY.test(sql.trim())) return null;
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
};

function isAncestor(candidate: ExplainTreeNode, of: ExplainTreeNode): boolean {
  if (candidate === of) return true;
  return candidate.children.some((child) => isAncestor(child, of));
}
