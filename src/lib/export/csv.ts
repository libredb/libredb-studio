/**
 * The one CSV writer in the studio.
 *
 * Every export used to build its own, and each of the three built it by wrapping
 * the value in quotes and nothing else: `"${val}"`. A single cell holding a quote,
 * a comma or a newline — ordinary contents for a `text` column — ended the field
 * early and shifted every column after it for the rest of the file. The damage is
 * silent, because the file still opens; it is the columns that are wrong.
 *
 * Same threat model as `quoteLiteral` in `src/lib/sql/values.ts` (#290): what
 * leaves here is read by another tool later, usually unattended, and every byte in
 * it is data the database held. The difference is only which grammar has to be
 * respected — RFC 4180 here, the engine's literal grammar there.
 *
 * Fields are separated by `,` and records by a single `\n`. RFC 4180 spells the
 * record separator `CRLF`; every reader that matters accepts a bare LF, and a field
 * that CONTAINS either is quoted, which is the part a reader cannot recover from.
 *
 * NOT done here: neutralising a leading `=`, `+`, `-` or `@`, which a spreadsheet
 * reads as a formula (`docs/BACKLOG.md` X1). That is a real hazard and a separate
 * decision, because the fix mutates the user's values on the way out; this file's
 * job is to write the value it was given, exactly and unambiguously.
 */

import { jsonText } from "./json";

/**
 * The characters RFC 4180 says force a field to be quoted. A field is left bare
 * otherwise, so a numeric column stays numeric to a spreadsheet.
 */
const NEEDS_QUOTING = /["\r\n,]/;

/**
 * A value as its CSV text, before quoting.
 *
 * Absent is empty, which is how a reader spells NULL. It used to be the literal
 * text `null`/`undefined`, which reads back as a four- or nine-character string
 * and is indistinguishable from a column that genuinely holds that word.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  // A JSON column, a Postgres array, a Mongo sub-document: `String(...)` answers
  // `[object Object]` for all of them, which loses the cell entirely. Through
  // `jsonText`, because a bare `JSON.stringify` throws on a bigint or a cycle and
  // would take the whole export with it.
  if (typeof value === "object") return jsonText(value);
  return String(value);
}

function csvField(value: unknown): string {
  const text = renderValue(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV record, escaped field by field. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvField).join(",");
}

/**
 * The columns an export writes: what the caller declared, or — when it has nothing
 * to declare — every key any row carries, in the order the rows first mention them.
 *
 * The union rather than the first row's keys, because a document store hands back
 * rows that do not share a shape. A field absent from row 1 would otherwise be
 * dropped from the header and, since rows used to be written from `Object.values`,
 * would also push every later value of that row one column to the left.
 */
export function resolveColumns(
  rows: readonly Record<string, unknown>[],
  declared?: readonly string[],
): readonly string[] {
  if (declared && declared.length > 0) return declared;

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

/**
 * One row's value for `column`.
 *
 * `Object.hasOwn` first, because `row[column]` walks the prototype chain: a header
 * naming a field this row has no own entry for — ordinary in a document store, which
 * hands back rows that do not share a shape — resolved to an INHERITED member when
 * the name happened to be one. A column called `constructor` wrote
 * "function Object() { [native code] }" into every row that lacked the field. Same
 * guard, and the same reason, as `declaredTypeOf` in `src/components/ResultsGrid.tsx`.
 */
export function cellOf(row: Record<string, unknown>, column: string): unknown {
  return Object.hasOwn(row, column) ? row[column] : undefined;
}

/**
 * `rows` as CSV text, with a header row.
 *
 * Pass `columns` — a result's own `fields` — wherever they are known: they are what
 * the engine declared for this result, and they fix both the order and the set. Each
 * row is then read BY NAME, so a row whose keys arrive in another order, or which is
 * missing one, lands in the right columns instead of shifting the rest.
 */
export function toCsv(rows: readonly Record<string, unknown>[], columns?: readonly string[]): string {
  const header = resolveColumns(rows, columns);
  const lines = [csvRow(header)];
  for (const row of rows) {
    lines.push(csvRow(header.map((column) => cellOf(row, column))));
  }
  return lines.join("\n");
}
