import type { ExplainTreeNode } from "./types";

/**
 * What every engine that answers EXPLAIN as text has in common: indentation is the
 * nesting, and the tree glyphs drawn in front of a line are decoration on top of it.
 *
 * Shared by `mysql-text.ts` (one row per plan line, the extra columns carrying detail)
 * and `postgres-text.ts` (one row per line on CockroachDB, the whole plan in a single
 * cell on Materialize). Neither of them knows which engine it is talking to; both read
 * the shape of what came back, which is what keeps one file per dialect from becoming
 * one branch per engine.
 */

/**
 * The leading run that means "deeper", not "content": whitespace and the box glyphs
 * these engines draw their trees with. Measured on TiDB v8.5.1 (`└─`, `├─`, `│`) and
 * CockroachDB v26.2.5 (`└──`, `├──`, `│`), which is why the class covers both widths -
 * its length is the indent, and what follows it is the label, so `└──•scan` reads as
 * `•scan` at indent 4.
 */
export const INDENT = /^[\s│├└─]*/u;

export interface PlanLine {
  readonly indent: number;
  readonly text: string;
  readonly node: ExplainTreeNode;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent and null cells render as nothing rather than as the words "null"/"undefined". */
export function cellText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * Indentation is the only nesting these engines publish, so a stack turns it into a
 * tree: a line is a child of the nearest line above it that is less indented.
 */
export function buildTree(lines: readonly PlanLine[]): ExplainTreeNode[] {
  const roots: ExplainTreeNode[] = [];
  const stack: PlanLine[] = [];
  for (const line of lines) {
    while (stack.length > 0 && stack[stack.length - 1].indent >= line.indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(line.node);
    else parent.node.children.push(line.node);
    stack.push(line);
  }
  return roots;
}

/**
 * One tree to render.
 *
 * Several engines print more than one fragment at indent 0 and none of them is the
 * parent of the others - StarRocks and Doris print plan fragments, CockroachDB prints
 * `distribution: local` above the plan, Materialize prints its `Source` and
 * `Target cluster` sections below it - so a synthetic root is the only honest way to
 * show all of them.
 */
export function withRoot(roots: readonly ExplainTreeNode[]): ExplainTreeNode {
  return roots.length === 1 ? roots[0] : { label: "EXPLAIN", children: [...roots] };
}
