/**
 * The one Markdown table writer in the studio.
 *
 * Same value contract as the CSV writer (`renderValue` in `csv.ts`): absent is empty,
 * a date is its ISO text, a binary value is the shared `\x…` hex and a structured value
 * is `jsonText`. On top of that contract a Markdown cell has its own grammar to respect:
 *
 * - `\` first, because it is Markdown's escape character. A cell holding a literal `\|`
 *   would otherwise look already-escaped to a renderer, so the backslash is doubled
 *   before the pipe is escaped.
 * - `|` next, because an unescaped pipe ends the cell and shifts every column after it.
 * - `\n`/`\r` last, one `<br>` per line break (`\r\n` counts as one), because a bare
 *   newline ends the table row mid-cell.
 *
 * The header is escaped with the same function as the cells: a header is a cell too,
 * and a column name with a pipe in it would otherwise split the table on the first line.
 */

import { cellOf, renderValue, resolveColumns } from "./csv";

/**
 * One Markdown cell — a data cell or a header cell — with the characters a table
 * renderer would otherwise read as structure escaped.
 */
export function markdownCell(value: unknown): string {
  return renderValue(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * `rows` as a Markdown table: a header row, a separator row, then one row per record.
 *
 * The separator row is always plain `---`; column alignment (`:---`, `---:`) is
 * intentionally not emitted.
 */
export function markdownTable(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string {
  const header = resolveColumns(rows, columns);
  // A table with no columns has no cells to escape and no separator to write; the empty
  // string is the same answer `toCsv` gives for this shape.
  if (header.length === 0) return "";
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  const lines = [line(header.map(markdownCell)), separator];
  for (const row of rows) {
    lines.push(line(header.map((column) => markdownCell(cellOf(row, column)))));
  }
  return lines.join("\n");
}
