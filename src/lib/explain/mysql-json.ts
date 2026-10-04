import { classifySelectPrefix } from "./select-prefix";
import { cellText, isRecord } from "./text-plan";
import { mysqlTextStrategy } from "./mysql-text";
import type { ExplainPlanInput, ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * `EXPLAIN FORMAT=JSON` on the servers whose connect probe accepts it (issue #1389).
 *
 * Until this the strategy cast the rows to the PostgreSQL render model, which found nothing it
 * knew in them: the panel drew an empty tree, "Operations 0", and the green "Query looks good".
 * The servers that answer this format answer three shapes, measured 2026-10-04 on a join with
 * GROUP BY:
 *
 * - MySQL 26.7.0 (`mysql:latest`): JSON format version 2. A root `query_plan` whose nodes each
 *   carry an `operation` sentence ("Nested loop inner join", "Index lookup on o using idx_c"),
 *   `estimated_rows`, `estimated_total_cost`, and their children in `inputs`.
 * - MariaDB 13.0.2, and MySQL 8.x and Percona Server 8.4 by default: the classic `query_block`.
 *   Nesting is by key (`nested_loop`, `grouping_operation`, `filesort`, `table`, ...), a table
 *   names itself in `table_name`, and the figures are `rows` and `cost` on MariaDB and
 *   `rows_examined_per_scan` and a `cost_info` object of numeric strings on MySQL.
 * - OceanBase 4.4.2.1: no JSON at all, a text plan in a `Query Plan` column.
 *
 * The plan is the first column's cell, as text or, where the driver parsed the column's JSON type,
 * already as an object. Both JSON shapes are read by one walk keyed on the shape, never on the
 * engine; anything that does not parse as either is shown as text the way `mysql-text` shows a
 * text plan, so no shape ever reaches the panel as an empty plan.
 */

/** How deep the walk may go. Far past any optimizer's nesting; it only stops a payload that never ends. */
const MAX_PLAN_DEPTH = 64;

/** What the tree says where MAX_PLAN_DEPTH stopped it, so truncation is visible rather than silent. */
const TRUNCATED_LABEL = "plan truncated: nesting limit reached";

/** The keys that are a node's row estimate: format 2, classic MySQL, classic MariaDB. */
const ROW_KEYS = ["estimated_rows", "rows_examined_per_scan", "rows"] as const;

/** The keys that are a node's cost: format 2, then classic MySQL's `cost_info`, then MariaDB. */
const COST_KEYS = ["estimated_total_cost", "prefix_cost", "query_cost", "cost"] as const;

/**
 * Keys never shown as detail: the ones a node's label or metrics already say, the statement text
 * format 2 repeats at its root, and the children, which are nodes of their own.
 */
const NOT_DETAIL = new Set<string>(["operation", "inputs", "query", ...ROW_KEYS, ...COST_KEYS]);

/** Keys the label carries when the node has no `operation` sentence of its own (see `labelOf`). */
const LABEL_KEYS = new Set<string>(["table_name", "select_id"]);

/** A figure the server sent as a number or a numeric string, or nothing. A blank is an absent reading, not a zero. */
function figure(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The first of `keys` that `record` carries a figure under. */
function firstFigure(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = figure(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** A scalar, or an array of scalars, as one detail value; null for anything structured. */
function scalarText(value: unknown): string | null {
  if (Array.isArray(value)) {
    return value.every((item) => !isRecord(item) && !Array.isArray(item)) ? value.map(cellText).join(", ") : null;
  }
  return isRecord(value) ? null : cellText(value);
}

/**
 * The node's name: the operation format 2 spells out, else the key it sits under, with the table
 * it reads when it names one (`table c`), and the select number of a classic query block.
 */
function labelOf(key: string, record: Record<string, unknown>): string {
  if (typeof record.operation === "string") return record.operation;
  const name = key.replaceAll("_", " ");
  if (typeof record.table_name === "string") return `${name} ${record.table_name}`;
  if (record.select_id !== undefined) return `${name} #${cellText(record.select_id)}`;
  return name;
}

/**
 * One JSON object to one tree node.
 *
 * Scalars become the detail line. An object becomes a child, except MySQL's `cost_info`, whose
 * figures are this node's own. An array of objects becomes one child per element, and an element
 * that only wraps one object (`nested_loop: [{ table: {...} }]`) is that object under its own key.
 */
function toNode(key: string, record: Record<string, unknown>, depth: number): ExplainTreeNode {
  if (depth >= MAX_PLAN_DEPTH) return { label: TRUNCATED_LABEL, children: [] };
  const costInfo = isRecord(record.cost_info) ? record.cost_info : {};
  const node: ExplainTreeNode = { label: labelOf(key, record), children: [] };

  const estRows = firstFigure(record, ROW_KEYS);
  const estCost = firstFigure({ ...costInfo, ...record }, COST_KEYS);
  if (estRows !== undefined || estCost !== undefined) {
    node.metrics = {
      ...(estRows !== undefined && { estRows }),
      ...(estCost !== undefined && { estCost }),
    };
  }

  const detail: string[] = [];
  const labelled = typeof record.operation !== "string";
  for (const [childKey, value] of Object.entries(record)) {
    if (NOT_DETAIL.has(childKey) || childKey === "cost_info" || (labelled && LABEL_KEYS.has(childKey))) continue;
    if (isRecord(value)) {
      node.children.push(toNode(childKey, value, depth + 1));
      continue;
    }
    if (Array.isArray(value) && value.some(isRecord)) {
      for (const element of value.filter(isRecord)) {
        const entries = Object.entries(element);
        const [onlyKey, onlyValue] = entries[0] ?? [];
        const wrapped = entries.length === 1 && isRecord(onlyValue);
        node.children.push(
          wrapped ? toNode(onlyKey as string, onlyValue, depth + 1) : toNode(childKey, element, depth + 1),
        );
      }
      continue;
    }
    const text = scalarText(value);
    if (text !== null && text !== "") detail.push(`${childKey}: ${text}`);
  }
  // Format 2 nests a node's inputs under `inputs`: they are its children, in order, after any
  // other structure it carries.
  if (Array.isArray(record.inputs)) {
    for (const input of record.inputs.filter(isRecord)) node.children.push(toNode("input", input, depth + 1));
  }
  if (detail.length > 0) node.detail = detail.join(", ");
  return node;
}

/** The plan document of the first cell: an object already, or JSON text of one. */
function planDocument(raw: unknown): Record<string, unknown> | null {
  if (!Array.isArray(raw) || raw.length === 0 || !isRecord(raw[0])) return null;
  const cell = Object.values(raw[0])[0];
  if (isRecord(cell)) return cell;
  if (typeof cell !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(cell);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A plan that is not JSON, as text: one line per row, and a cell that holds several lines split
 * into them, so a plan printed into one cell still reads as lines. Drawn by `mysql-text`, which
 * reads exactly this shape for the servers that print a text plan.
 */
function asText(raw: unknown): ExplainPlanInput | null {
  if (!Array.isArray(raw) || !raw.every(isRecord)) return null;
  const lines = raw.flatMap((row) =>
    cellText(Object.values(row)[0])
      .split(/\r?\n/)
      .map((line) => ({ plan: line })),
  );
  return mysqlTextStrategy.toRenderModel(lines);
}

export const mysqlJsonStrategy: ExplainStrategy = {
  format: "mysql-json",
  buildSql(sql) {
    // MySQL's `EXPLAIN FORMAT=JSON` describes without running, so a CTE is safe to explain.
    if (classifySelectPrefix(sql) === null) return null;
    return `EXPLAIN FORMAT=JSON ${sql}`;
  },
  // The rows ARE the plan: the JSON is the first column's cell, which `toRenderModel` reads, and
  // the raw tab shows the rows as the server sent them.
  extractPlan(result) {
    return result.rows ?? [];
  },
  toRenderModel(raw): ExplainPlanInput | null {
    const document = planDocument(raw);
    const rootKey =
      document === null ? undefined : ["query_plan", "query_block"].find((key) => isRecord(document[key]));
    if (document === null || rootKey === undefined) return asText(raw);
    return { kind: "tree", root: toNode(rootKey, document[rootKey] as Record<string, unknown>, 0), raw: document };
  },
};
