/**
 * JSON and NDJSON rows of the S3 preview. Browser-safe and pure. Values are
 * parsed with quoteUnsafeIntegers, so an integer past 2^53 keeps its digits; columns are the members of the shown
 * rows, first seen first, plus `value` for any other value, named apart by uniqueFieldNames. The union of member
 * names keeps at most `maxColumns` times 8 names, the bound the CSV rows put on a record's fields: names past that
 * are counted for N-COLUMNS but never named, so an object of a million members costs the work of 8,192 columns.
 */
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { buildRows } from "./preview-cells";
import type { RowsInput, RowsOutcome } from "./preview-csv";
import { previewSentence, spellName } from "./preview-render";

/** The member names the union keeps: eight per shown column, as the CSV rows keep fields. */
const NAMES_PER_COLUMN = 8;

const isMembers = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The union of the objects' own member names, first seen first, keeping only the first `maxNames`; `count` is the
 * number of distinct names in all, the ones past the bound included.
 */
function boundedMembers(
  objects: readonly Readonly<Record<string, unknown>>[],
  maxNames: number,
): { readonly names: readonly string[]; readonly count: number } {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const object of objects) {
    for (const name of Object.keys(object)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (names.length < maxNames) names.push(name);
    }
  }
  return { names, count: seen.size };
}

/** Rows of parsed values: an object gives its members, any other value goes to `value`. */
function rowsOfValues(
  values: readonly unknown[],
  input: RowsInput,
): { readonly built: ReturnType<typeof buildRows>; readonly valueName: string | undefined } {
  const shown = values.slice(0, input.maxRows);
  const members = boundedMembers(shown.filter(isMembers), input.limits.maxColumns * NAMES_PER_COLUMN);
  const hasValue = shown.some((value) => !isMembers(value));
  const declared = hasValue ? [...members.names, "value"] : members.names;
  const names = uniqueFieldNames(declared);
  const valueIndex = hasValue ? declared.length - 1 : -1;
  const built = buildRows(
    {
      names,
      typing: "json",
      rowCount: values.length,
      valueAt: (row, column) => {
        const value = values[row];
        if (column === valueIndex) return isMembers(value) ? null : value;
        const name = members.names[column];
        return isMembers(value) && Object.hasOwn(value, name) ? value[name] : null;
      },
      columnCount: members.count + (hasValue ? 1 : 0),
    },
    input.request.columns,
    input.maxRows,
    input.limits,
  );
  return { built, valueName: hasValue ? names[valueIndex] : undefined };
}

/** Rows of a whole, valid JSON document: an array gives one row per element, anything else one row. */
export function jsonDocumentRows(input: RowsInput): RowsOutcome {
  const parsed: unknown = JSON.parse(quoteUnsafeIntegers(input.text));
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const { built } = rowsOfValues(values, input);
  return { kind: "rows", rows: built.rows, notices: built.notices };
}

/**
 * NDJSON rows: lines split on LF with a CR before it removed, blank lines skipped; when the read was cut, everything
 * after the last LF is a partial line, dropped with N-LINE-CUT; a line that does not parse goes to `value` as text.
 * Only the first `maxRows + 1` lines are parsed. A read with no line to show answers text rows, with N-LINE-CUT only
 * when the read did not end.
 */
export function ndjsonRows(input: RowsInput): RowsOutcome {
  let text = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
  const lineCut = previewSentence("N-LINE-CUT", { n: input.readBytes });
  let cut = false;
  if (!input.ended) {
    const last = text.lastIndexOf("\n");
    if (last < 0) return { kind: "text", notices: [lineCut] };
    cut = last < text.length - 1;
    text = text.slice(0, last + 1);
  }
  const values: unknown[] = [];
  let bad = 0;
  for (const raw of text.split("\n")) {
    if (values.length > input.maxRows) break;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(quoteUnsafeIntegers(line)));
    } catch {
      values.push(line);
      if (values.length <= input.maxRows) bad += 1;
    }
  }
  if (values.length === 0) return { kind: "text", notices: cut ? [lineCut] : [] };
  const { built, valueName } = rowsOfValues(values, input);
  const notices: string[] = [];
  if (cut) notices.push(lineCut);
  if (bad > 0) notices.push(previewSentence("N-NDJSON-BAD", { k: bad, col: spellName(valueName ?? "value") }));
  return { kind: "rows", rows: built.rows, notices: [...notices, ...built.notices] };
}
