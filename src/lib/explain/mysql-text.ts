import { classifySelectPrefix } from "./select-prefix";
import { INDENT, buildTree, cellText, isRecord, withRoot, type PlanLine } from "./text-plan";
import type { ExplainPlanInput, ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * Plain `EXPLAIN <sql>` for the MySQL-wire relatives whose grammar refuses
 * `EXPLAIN FORMAT=JSON` (issue #574). Measured 2026-09-06 over mysql2 3.24.2 on the
 * text protocol: TiDB v8.5.1 answers errno 1105 "explain format 'json' is not
 * supported now", StarRocks 3.3.22 and SingleStore 0.2.82 answer errno 1064, Apache
 * Doris 4.1.3 answers errno 1105 "mismatched input '=' expecting {<EOF>, ';'}". All
 * four accept the bare `EXPLAIN`, and so do MySQL 26.7.0 and MariaDB 12.3.2, each
 * answering its own shape:
 *
 * - TiDB: five columns (`id, estRows, task, access object, operator info`), the tree
 *   carried in `id` as box glyphs plus two-space indents.
 * - StarRocks: one column `Explain String`, 13 rows for `SELECT 1`.
 * - Doris: one column `Explain String(Nereids Planner)`, 17 rows for `SELECT 1`. The
 *   parenthesised suffix is why nothing here keys on a column NAME: the first column
 *   is the plan text whatever the engine calls it.
 * - MariaDB: ten tabular columns (`id, select_type, table, type, ...`).
 *
 * So the renderer is shape-driven, not engine-driven: first column is the node text,
 * the rest are detail, indentation is the nesting.
 */

/** The one column carrying a number worth showing. TiDB spells it `estRows`. */
const EST_ROWS = "estrows";

/**
 * The figure, or nothing. A blank cell is an absent reading, not a zero: `Number("")`
 * is 0, so without the emptiness check a row whose estRows the engine left blank would
 * carry a "~0 rows" badge nobody measured, the fabrication the absence rule (#477)
 * exists to prevent.
 */
function readEstRows(entries: [string, unknown][]): number | undefined {
  const cell = entries.find(([column]) => column.toLowerCase() === EST_ROWS);
  if (cell === undefined) return undefined;
  const text = cellText(cell[1]).trim();
  if (text === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * One row to one line, or null when the row carries no text at all: StarRocks and
 * Doris both pad their plans with empty rows (2 of 13 and 6 of 17 on 2026-09-06), and
 * a blank node would be an empty box in the tree and an empty line in the raw tab.
 */
function toPlanLine(row: Record<string, unknown>): PlanLine | null {
  const entries = Object.entries(row);
  const first = cellText(entries[0]?.[1]);
  // A `*` run anchored at the start always matches, so the prefix is simply what
  // stripping it removes: no null arm to guard.
  const label = first.replace(INDENT, "");
  const indent = first.length - label.length;
  if (label.trim() === "") return null;

  const node: ExplainTreeNode = { label, children: [] };
  const detail = entries
    .slice(1)
    .filter(([, value]) => cellText(value) !== "")
    .map(([column, value]) => `${column}: ${cellText(value)}`)
    .join(", ");
  if (detail !== "") node.detail = detail;
  const estRows = readEstRows(entries);
  if (estRows !== undefined) node.metrics = { estRows };

  // The raw tab shows the plan as the engine printed it, so the line keeps every
  // column verbatim, indentation included, two spaces apart.
  return { indent, text: entries.map(([, value]) => cellText(value)).join("  "), node };
}

export const mysqlTextStrategy: ExplainStrategy = {
  format: "mysql-text",
  // Plain EXPLAIN describes without running on every engine measured, so a CTE is
  // safe to explain and both modes build the same statement (as mysql-json does).
  buildSql(sql) {
    if (classifySelectPrefix(sql) === null) return null;
    return `EXPLAIN ${sql}`;
  },
  // No parsing here: the rows ARE the plan, and their column names differ per engine.
  extractPlan(result) {
    return result.rows ?? [];
  },
  toRenderModel(raw): ExplainPlanInput | null {
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isRecord)) return null;
    const lines = raw.map(toPlanLine).filter((line): line is PlanLine => line !== null);
    if (lines.length === 0) return null;
    return {
      kind: "tree",
      root: withRoot(buildTree(lines)),
      raw: lines.map((line) => line.text).join("\n"),
    };
  },
};
