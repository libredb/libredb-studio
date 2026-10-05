/**
 * The one HTML table writer in the studio.
 *
 * Same value contract as `renderValue` in `csv.ts`, then the cell is escaped for HTML
 * text content: `&`, `<`, `>`, `"` and `'` all become entities, in the data cells and in
 * the header cells alike. Escaping only `& < >` would be enough for a `<td>`'s text, but
 * the `"` and `'` are escaped too so a future move of the value into an attribute cannot
 * smuggle a quote, and a header is a cell like any other.
 *
 * The output is a complete standalone document, not a fragment: it can be saved and
 * opened directly, and the embedded stylesheet keeps table borders, the bold header and
 * pre-formatted whitespace (so a cell's newlines survive where a Markdown export would
 * turn them into `<br>`).
 */

import { cellOf, renderValue, resolveColumns } from "./csv";

// The `&` is kept in a constant and spliced in rather than written as a literal entity,
// so no tooling decodes the entity back into the bare character before it reaches the file.
const ENTITY_MARK = "&";
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": `${ENTITY_MARK}amp;`,
  "<": `${ENTITY_MARK}lt;`,
  ">": `${ENTITY_MARK}gt;`,
  '"': `${ENTITY_MARK}quot;`,
  "'": `${ENTITY_MARK}#39;`,
};

/** One HTML cell — a data cell or a header cell — with the characters a parser would read as markup escaped. */
export function htmlCell(value: unknown): string {
  return renderValue(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** `rows` as a complete standalone HTML document holding one table. */
export function htmlTable(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string {
  const header = resolveColumns(rows, columns);
  if (header.length === 0) return "";
  const head = header.map((column) => `<th>${htmlCell(column)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${header.map((column) => `<td>${htmlCell(cellOf(row, column))}</td>`).join("")}</tr>`)
    .join("");
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Query results</title>\n<style>\ntable { border-collapse: collapse; }\nth, td { border: 1px solid #999; padding: 4px 8px; text-align: left; vertical-align: top; white-space: pre-wrap; }\nth { font-weight: 600; }\n</style>\n</head>\n<body>\n<table>\n<thead>\n<tr>${head}</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>\n</body>\n</html>\n`;
}
