/**
 * An `influxdb3` answer to a result (InfluxDB spec 3.4, 5.2 step 9, I9): `/api/v3/query_sql` with `format=jsonl`
 * sends one JSON object per line, and this module reads them into the fields and rows the grid shows.
 *
 * Each line goes through `quoteUnsafeIntegers` before `JSON.parse`, so an int64 or uint64 beyond 2^53 arrives as its
 * exact digits; NaN and the infinities arrive as null (arrow-json writes them so) and a timestamp stays the engine's
 * text, nanoseconds and UTC with no zone suffix. A line omits the key of a null cell, so the columns are the ordered
 * union of the keys the lines name, in the order they name them: with `SELECT *` the engine's alphabetical order, an
 * explicit projection's own order, and a sparse table's late keys appended. That order is read from the line's text,
 * never from the parsed object, whose key order puts index-like keys (`"1"`) first. An all-null column and the
 * columns of an empty result cannot be known from JSON (the I9 known limit), and no column type is reported.
 *
 * The row cut and the cell budget (rows times columns) stop the read and set `cut`; a row the budget drops adds no
 * column. A line that is not a JSON object, or one nested deeper than `MAX_LINE_DEPTH` (R47), is an
 * `InfluxAnswerShapeError("not-json")`, worded by errors.ts. No pattern reads the server's text (R40): every pass over
 * it is one forward walk, and the body is walked line by line, never split whole, so at most `rowCut + 1` line
 * strings exist however short its lines are (R46).
 */
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { InfluxShapeLimits, ShapedResult } from "./connection-options";
import { InfluxAnswerShapeError } from "./errors";

/**
 * R47: the deepest nesting a line may have, the row's own object counted as level one. Far above anything 3.12.0
 * writes, and low enough that no later `JSON.stringify` of a row can overflow the stack.
 */
const MAX_LINE_DEPTH = 64;

/** Index just past the JSON string that opens at `start`; the text is already known to be valid JSON. */
function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
  return index + 1;
}

/**
 * The keys of a JSON object's text in the order the text names them, decoded, repeats included. One forward walk:
 * a string is stepped over whole, and only a string read where the top-level object expects a key is a key. A text
 * nested deeper than `MAX_LINE_DEPTH` is not a row (R47).
 */
function keysInTextOrder(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      const end = endOfString(text, index);
      if (depth === 1 && expectKey) {
        keys.push(JSON.parse(text.slice(index, end)) as string);
        expectKey = false;
      }
      index = end;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      if (depth > MAX_LINE_DEPTH) throw new InfluxAnswerShapeError("not-json");
      expectKey = depth === 1;
    } else if (ch === "}" || ch === "]") {
      depth--;
    } else if (ch === "," && depth === 1) {
      expectKey = true;
    }
    index++;
  }
  return keys;
}

/** One line as an object, its integers beyond 2^53 kept as exact digits; anything else is not a row. */
function parseLine(line: string): { readonly row: Readonly<Record<string, unknown>>; readonly text: string } {
  const text = quoteUnsafeIntegers(line);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InfluxAnswerShapeError("not-json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InfluxAnswerShapeError("not-json");
  }
  return { row: parsed as Readonly<Record<string, unknown>>, text };
}

/** A jsonl body as fields and rows: blank lines skipped, the ordered key union, the row cut and the cell budget. */
export function shapeJsonlBody(text: string, limits: InfluxShapeLimits): ShapedResult {
  const fields = new Map<string, true>();
  const parsedRows: Readonly<Record<string, unknown>>[] = [];
  let cut = false;

  let cursor = 0;
  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, end);
    cursor = end + 1;
    if (line.trim() === "") continue;
    if (parsedRows.length >= limits.rowCut) {
      cut = true;
      break;
    }
    const { row, text: lineText } = parseLine(line);
    const newKeys = keysInTextOrder(lineText).filter((key) => !fields.has(key));
    const columns = fields.size + new Set(newKeys).size;
    if ((parsedRows.length + 1) * columns > limits.cellBudget) {
      cut = true;
      break;
    }
    for (const key of newKeys) fields.set(key, true);
    parsedRows.push(row);
  }

  const names = [...fields.keys()];
  // `Object.fromEntries` defines each cell as an own property, so a column named `__proto__` is a cell like any other.
  const rows = parsedRows.map((row) =>
    Object.fromEntries(names.map((name) => [name, Object.hasOwn(row, name) ? row[name] : null])),
  );
  return { fields: names, rows, cut, warnings: [] };
}
